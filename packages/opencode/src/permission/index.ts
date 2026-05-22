import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PermissionAuto } from "./auto"
import { PermissionReviewer } from "./reviewer/service"
import { PermissionSessionCache } from "./cache/session-cache"
import { PermissionCircuitBreaker } from "./reviewer/circuit-breaker"
import * as Option from "effect/Option"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false
      // #199：needsAuto 与 needsAsk 是两个独立门控。混合请求中 auto 可独立拒绝
      // #199：关键载荷，但 reviewer allow 不能撤销另一个 pattern 仍需的用户审批，
      // #199：因此两个门控必须同时保留到流程末尾再决定是否提前返回。
      let needsAuto = false
      const autoPatterns: string[] = []

      // #199：逐 pattern 评估规则。静态 deny 立即 fail-closed；auto 收集后统一交由
      // #199：precheck+reviewer 决定；ask 累积到 needsAsk 等待用户审批。三者优先级
      // #199：由 evaluate 的 last-match-wins 决定，此处只分流不复核规则语义。
      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        if (rule.action === "auto") {
          needsAuto = true
          autoPatterns.push(pattern)
          continue
        }
        needsAsk = true
      }

      // #199：auto 分支只在有 pattern 命中 auto 规则时进入。所有协作者通过
      // #199：serviceOption 可选注入，使旧测试和小运行时缺少 reviewer 时仍能
      // #199：退回正常 ask 路径而非崩溃。
      if (needsAuto) {
        const reviewer = Option.getOrUndefined(yield* Effect.serviceOption(PermissionReviewer.Service))
        // #199：会话级缓存避免对同一 auto 请求重复调用 reviewer，但缓存键包含
        // #199：command/cwd/shell/filepath/diff 上下文，上下文变化即失效。
        const cache = Option.getOrUndefined(yield* Effect.serviceOption(PermissionSessionCache.Service))
        // #199：熔断器跟踪连续拒绝密度；触发后该 session 的 auto 审批永久中断，
        // #199：但当前调用的 deny 结果不依赖熔断状态，熔断仅作为咨询性信号。
        const circuit = Option.getOrUndefined(yield* Effect.serviceOption(PermissionCircuitBreaker.Service))
        const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
        // #199：strict 模式禁用 precheck fast-path allow，强制所有 auto 请求经过
        // #199：reviewer；但 deny 仍由 precheck 保留，防止危险操作因 reviewer 缺失而放行。
        const strict = config ? (yield* config.get()).permission?.auto_review?.strict === true : false
        // #199：autoRequest 只包含 auto 控制的 pattern。若缓存 ask 控制的 pattern，
        // #199：用户回复前规则变更会使原本被拒绝的混合请求变成静默 allow。
        const autoRequest = { ...request, patterns: autoPatterns }
        if (cache && (yield* cache.has(autoRequest))) {
          // #199：缓存命中只满足 auto 部分。若另一个 pattern 仍需 ask，不能提前
          // #199：返回；但缓存命中是 auto 非拒绝，需像全新 allow 一样重置熔断连续计数。
          if (circuit) yield* circuit.recordNonDenial(request.sessionID)
          if (!needsAsk) return
        } else {
          // #199：PermissionAuto.evaluate 按 precheck → fast-path allow → deny →
          // #199：reviewer → fail-closed 顺序裁决；strict 模式禁用 fast-path 但保留 deny。
          const decision = yield* PermissionAuto.evaluate({ ...autoRequest, strict }, reviewer)
          yield* Effect.logInfo("auto evaluated", { permission: request.permission, action: decision.action, reason: decision.reason })
          if (decision.action === "allow") {
            if (circuit) yield* circuit.recordNonDenial(request.sessionID)
            // #199：只有 reviewer allow 才缓存和发布事件——precheck fast-path allow 是
            // #199：确定性的只读裁决，无需审计追溯，也不应污染会话缓存。
            if (decision.source === "reviewer") {
              const reviewID = "reviewID" in decision ? decision.reviewID : undefined
              if (reviewID) {
                // #199：reviewer allow 可审计且可缓存，但不是用户审批。在快速返回前
                // #199：发布事件，使纯 auto 路径与混合 auto+ask 有相同的审计行为。
                yield* events.publish(Event.ReviewCompleted, {
                  sessionID: request.sessionID,
                  reviewID,
                  outcome: "allow",
                  rationale: decision.reason,
                })
              }
              if (cache) yield* cache.put(autoRequest, "allow")
            }
            if (!needsAsk) return
          }
          if (decision.action === "deny") {
            // #199：熔断器只跟踪 reviewer deny——precheck deny 是确定性的静态规则，
            // #199：反复触发不应累积为熔断信号，否则正常危险操作会误触发中断。
            if (decision.source === "reviewer" && circuit) {
              const reviewID = "reviewID" in decision ? decision.reviewID : undefined
              if (reviewID) {
                // #199：reviewer deny 同样发布 ReviewCompleted 供审计；缺失 reviewID
                // #199：说明 reviewer 未正常返回，改发 ReviewFailed 记录失败原因。
                yield* events.publish(Event.ReviewCompleted, {
                  sessionID: request.sessionID,
                  reviewID,
                  outcome: "deny",
                  rationale: decision.reason,
                })
              } else {
                yield* events.publish(Event.ReviewFailed, {
                  sessionID: request.sessionID,
                  reviewID: "unknown",
                  reason: decision.reason,
                })
              }
              const action = yield* circuit.recordDenial(request.sessionID)
              if (action.kind === "interrupt") {
                // #199：熔断触发是咨询性的：CircuitBroken 给 UI 中断或解释重复拒绝
                // #199：的机会，但不改变本次调用的 fail-closed deny 结果。
                yield* events.publish(Event.CircuitBroken, {
                  sessionID: request.sessionID,
                  consecutive: action.consecutive,
                  recent: action.recent,
                })
              }
            }
            // #199：auto 拒绝是确定性的：抛出 AutoDeniedError 而非转入 ask，防止
            // #199：agent 通过用户审批旁路 precheck/reviewer 已拒绝的危险操作。
            return yield* new PermissionV1.AutoDeniedError({ reason: decision.reason })
          }
          // #199：reviewer 不可用或返回 ask 时回退到用户审批，保持 fail-open 语义
          // #199：而非 fail-closed——未配置 reviewer 不应阻断正常工作流。
          if (decision.action === "ask") needsAsk = true
        }
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  // #199：permission config 历史上接受 home-relative pattern。将此扩展保持在
  // #199：config-to-rules 转换本地，使运行时 command pattern 在用户已批准后不被重写。
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      // #196：approvals_reviewer 等控制串不是权限 action，仅四值进入 ruleset
      if (value !== "allow" && value !== "deny" && value !== "ask" && value !== "auto") continue
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    // #196：auto_review 审批控制对象（值含 number/boolean）不是 pattern 映射
    if (key === "auto_review") continue
    ruleset.push(
      // #196：模式映射的值经谓词收窄为四值，auto_review 控制值不进 ruleset
      // #196：value 是多形态 config union，entries 需按宽 record 取重载
      ...Object.entries(value as Record<string, unknown>).flatMap(([pattern, action]) =>
        isPermissionAction(action) ? [{ permission: key, pattern: expand(pattern), action }] : [],
      ),
    )
  }
  return ruleset
}

// #196：config 层合法的控制串/控制值（auto_review 等）在 ruleset 层不合法，谓词统一收窄
function isPermissionAction(value: unknown): value is PermissionV1.Action {
  return value === "allow" || value === "deny" || value === "ask" || value === "auto"
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function compact(ruleset: PermissionV1.Ruleset): PermissionV1.Rule[] {
  const seen = new Set<string>()
  // 只删除同名同模式的旧规则，保留 last-match-wins 与交错规则的顺序。
  return ruleset
    .toReversed()
    .filter((rule) => {
      const key = `${rule.permission}\0${rule.pattern}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .toReversed()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

// #199：Permission.node 声明对 session cache 和 circuit breaker 的依赖，使
// #199：builder 在构建 Permission 层时自动提供这些服务。reviewer 不在此声明——
// #199：它是可选协作者，通过 serviceOption 访问，缺失时退回 ask 路径。
export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, PermissionSessionCache.node, PermissionCircuitBreaker.node] })

export * as Permission from "."

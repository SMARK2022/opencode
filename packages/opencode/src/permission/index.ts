import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Deferred, Effect, Layer, Context, Semaphore } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PermissionAuto } from "./auto"
import { PermissionPrecheck } from "./precheck"
import { PermissionReviewer } from "./reviewer/service"
import { PermissionSessionCache } from "./cache/session-cache"
import { PermissionCircuitBreaker } from "./reviewer/circuit-breaker"
import * as Option from "effect/Option"
import { Shell } from "@opencode-ai/core/shell"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly beginExecute: (input: {
    sessionID: PermissionV1.AskInput["sessionID"]
    tool: { messageID: string; callID: string }
    code: string
    calls: readonly PermissionPrecheck.ExecuteCall[]
    ruleset: PermissionV1.Ruleset
    agent: string
    stop(reason: Error): void
  }) => Effect.Effect<ExecuteReview, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

export type ExecuteReview = {
  ready(): Effect.Effect<void>
  ask(request: PermissionV1.AskInput): Effect.Effect<void, PermissionV1.Error>
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
    const config = yield* Config.Service
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

    const matchRequest = Effect.fn("Permission.matchRequest")(function* (input: PermissionV1.AskInput) {
      const { approved } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false
      // #199：needsAuto 与 needsAsk 是两个独立门控。混合请求中 auto 可独立拒绝
      // #199：关键载荷，但 reviewer allow 不能撤销另一个 pattern 仍需的用户审批，
      // #199：因此两个门控必须同时保留到流程末尾再决定是否提前返回。
      let needsAuto = false
      const autoPatterns: string[] = []

      // #285：raw_patterns 是 shell 解析的原始拒绝证据，绕过 canonical pattern 评估
      for (const pattern of rawDenyPatterns(request.metadata)) {
        const denied = rawDenyRule(request.permission, pattern, ruleset)
        yield* Effect.logInfo("evaluated raw deny evidence", { permission: request.permission, pattern, denied: Boolean(denied) })
        if (denied) {
        // #285：命中 deny 立即 fail-closed，不给后续 ask 规则截获的机会；
        // ruleset 过滤只保留本 permission 相关规则，错误对象不含无关规则
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
      }

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

      return { needsAsk, needsAuto, autoPatterns }
    })

    // 普通请求与组合请求共享事件、reviewer 和失败策略，只区分批准的缓存寿命。
    const reviewAuto = Effect.fn("Permission.reviewAuto")(function* (
      request: Omit<PermissionV1.AskInput, "ruleset">,
      prechecked?: PermissionPrecheck.Decision,
      useCache = true,
    ) {
        // #203：协作者在 ask 时从运行时上下文解析——AppNodeBuilder 下 Permission.node 仅声明
        // #203：cache/circuit 依赖，reviewer 与 config 作为可选协作者经 serviceOption 获取
        const reviewer = Option.getOrUndefined(yield* Effect.serviceOption(PermissionReviewer.Service))
        // #199：会话级缓存避免对同一 auto 请求重复调用 reviewer，但缓存键包含
        // #199：command/cwd/shell/filepath/diff 上下文，上下文变化即失效。
        const cache = useCache ? Option.getOrUndefined(yield* Effect.serviceOption(PermissionSessionCache.Service)) : undefined
        // #199：熔断器跟踪连续拒绝密度；触发后该 session 的 auto 审批永久中断，
        // #199：但当前调用的 deny 结果不依赖熔断状态，熔断仅作为咨询性信号。
        const circuit = Option.getOrUndefined(yield* Effect.serviceOption(PermissionCircuitBreaker.Service))
        const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
        const permissionConfig = config ? (yield* config.get()).permission : undefined
        // #199：strict 模式禁用 precheck fast-path allow，强制所有 auto 请求经过
        // #199：reviewer；但 deny 仍由 precheck 保留，防止危险操作因 reviewer 缺失而放行。
        const strict = permissionConfig?.auto_review?.strict === true
        const reviewerDisabled = permissionConfig?.approvals_reviewer === "user"
        // #264：reviewer 旁路与失败 fallback 是两个独立维度——前者不调用 reviewer，后者只决定重试耗尽后的路由
        // #264：reviewer 重试仍由 PermissionReviewer/SessionRetry 管理。此 flag 只决定重试耗尽后的行为：
        // 默认回到人工 ask，fallback=deny 保留 fail-closed
        const reviewerFailureFallback = reviewerDisabled ? "user" : (permissionConfig?.auto_review?.fallback ?? "user")
        // #199：autoRequest 只包含 auto 控制的 pattern。若缓存 ask 控制的 pattern，
        // #199：用户回复前规则变更会使原本被拒绝的混合请求变成静默 allow。
        const autoRequest = request
        if (cache && (yield* cache.has(autoRequest))) {
          // #199：缓存命中只满足 auto 部分。若另一个 pattern 仍需 ask，不能提前
          // #199：返回；但缓存命中是 auto 非拒绝，需像全新 allow 一样重置熔断连续计数。
          if (circuit) yield* circuit.recordNonDenial(request.sessionID)
          return false
        } else {
          // #199：PermissionAuto.evaluate 按 precheck → fast-path allow → deny →
          // #199：reviewer → fail-closed 顺序裁决；strict 模式禁用 fast-path 但保留 deny。
          const decision = yield* PermissionAuto.evaluate(
            { ...autoRequest, strict, reviewerFailureFallback },
            // #264：reviewerDisabled 时不传 reviewer，避免无效调用
            reviewerDisabled ? undefined : reviewer,
            // #208：onReviewStart 发布 ReviewStarted 事件——确定性 precheck 到模型审查的可见边界
            // #208：events.publish 而非 bus.publish——复用 EventV2Bridge 统一事件发布路径
            // #208：事件仅携带 auto patterns 和 precheck rationale——不泄露隐藏 reviewer prompt
            (review) =>
              events.publish(Event.ReviewStarted, {
                sessionID: request.sessionID,
                reviewID: review.reviewID,
                permission: autoRequest.permission,
                patterns: [...autoRequest.patterns],
                precheck: review.precheck,
              }),
            prechecked,
          )
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
              // dangerous批准逐次重审；事件照常发布，cautious仍可写原有会话缓存。
              if (cache && decision.precheckLevel !== "dangerous") yield* cache.put(autoRequest, "allow")
            }
            return false
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
            // [local-smark] #627：终局性由 decision.source 唯一承载（auto.ts forbidden
            // 是唯一的 precheck deny 路径；reviewer 拒绝保留"用户确认后重试"路径）
            return yield* new PermissionV1.AutoDeniedError({ reason: decision.reason, terminal: decision.source === "precheck" })
          }
          // #199：reviewer 不可用或返回 ask 时回退到用户审批，保持 fail-open 语义
          // #199：而非 fail-closed——未配置 reviewer 不应阻断正常工作流。
          return decision.action === "ask"
        }
    })

    const requestUser = Effect.fn("Permission.requestUser")(function* (input: PermissionV1.AskInput) {
      const { pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
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

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const matched = yield* matchRequest(input)
      const autoAsk = matched.needsAuto
        ? yield* reviewAuto({ ...input, patterns: matched.autoPatterns })
        : false
      if (matched.needsAsk || autoAsk) yield* requestUser(input)
    })

    const beginExecute: Interface["beginExecute"] = Effect.fn("Permission.beginExecute")(function* (input) {
      const cfg = yield* config.get()
      const cwd = yield* InstanceState.directory
      const shell = Shell.acceptable(cfg.shell)
      // 本次脚本只持有风险上界和一次批准；Session 的普通审批缓存保持原职责。
      // approvedOnce 区分 general 起点与真实初次授权，让 strict 的首轮仍到 reviewer。
      let approvedLevel: PermissionPrecheck.Level = "general"
      let approvedOnce = false
      // reason 集合只在允许后累积；拒绝路径不得把未批准证据带入后续调用。
      const approvedReasons = new Set<string>()
      let stopped = false
      const gate = Semaphore.makeUnsafe(1)
      // 所有升阶共用一把锁；并发叶子进入锁后再决定是否复用已完成的审批。
      const parent = (request?: PermissionV1.AskInput): PermissionV1.AskInput => ({
        sessionID: input.sessionID, tool: input.tool, ruleset: input.ruleset,
        permission: "execute", patterns: ["*"], always: [],
        // 审查保留整段代码；真实升阶请求只携带普通动作证据，不回嵌宿主规则。
        // actual 固定为普通动作三件套，预跑原始参数仍由 probe 承载。
        metadata: { agent: input.agent, action_kind: "execute", code: input.code, cwd, shell,
          probe: input.calls,
          ...(request ? { actual: { permission: request.permission, patterns: request.patterns, metadata: request.metadata } } : {}) },
      })
      const terminal = (cause: Cause.Cause<unknown>) => {
        // 先封住后续接纳再取消现有任务，已结束子调用的记录由 processor 原样保留。
        stopped = true
        const error = Cause.squash(cause)
        input.stop(error instanceof Error ? error : new Error(String(error)))
        // 取消整个解释器而非抛普通工具错误，JS catch 才无法继续后续副作用。
        return Effect.interrupt
      }
      const check = (request: PermissionV1.AskInput) => gate.withPermits(1)(Effect.gen(function* () {
        if (stopped) return yield* Effect.interrupt
        // 每次仍用原分类器分析真实请求；复用的只是本次批准上界，而非旧参数的分类结果。
        const decision = yield* Effect.promise(() => PermissionPrecheck.evaluate({ ...request,
          ...(request.permission === "execute" ? { calls: input.calls } : {}),
        }))
        // forbidden 在等级复用前终止，先前获批的 dangerous 也不能覆盖它。
        if (decision.level === "forbidden") return yield* new PermissionV1.AutoDeniedError({ reason: decision.reason, terminal: true })
        // 同级新 reason 也是新证据；已覆盖 reason 才复用本次批准。
        const reasons = decision.reason.split("\n")
        if (approvedOnce && reasons.every((reason) => approvedReasons.has(reason))) return false
        const review = request.permission === "execute" ? request : parent(request)
        // 新风险 reason 送审时合并历史证据；safe/general 仍沿原 AUTO 路由。
        const reviewDecision = decision.level === "cautious" || decision.level === "dangerous"
          ? {
              level: PermissionPrecheck.LEVELS[Math.max(PermissionPrecheck.LEVELS.indexOf(approvedLevel), PermissionPrecheck.LEVELS.indexOf(decision.level))],
              reason: [...new Set([...approvedReasons, ...reasons])].join("\n"),
            }
          : decision
        // 复用原 AUTO 事件和失败策略，同时关闭宽泛 Session cache 的读写。
        const asked = yield* reviewAuto(review, reviewDecision, false)
        if (asked) yield* requestUser(review)
        // 新低风险 reason 不得降低已批准上界；后续送审仍携带完整历史证据。
        approvedLevel = PermissionPrecheck.LEVELS.indexOf(reviewDecision.level) > PermissionPrecheck.LEVELS.indexOf(approvedLevel) ? reviewDecision.level : approvedLevel
        // 只有允许后才累积原因，后续相同证据才能共享本次批准。
        for (const reason of reasons) approvedReasons.add(reason)
        approvedOnce = true
        // 返回本次是否取得人工批准，让父显式 ask 消费同一申请的结果，而非再弹一次。
        return asked
      }).pipe(Effect.catchCause(terminal)))
      const request = parent()
      const matched = yield* matchRequest(request).pipe(Effect.catchCause(terminal))
      // execute 自身的显式 ask 仍然有效，整体 AUTO 与人工匹配各自满足自己的门禁。
      const asked = yield* check(request)
      if (matched.needsAsk && !asked) yield* requestUser(request).pipe(Effect.catchCause(terminal))
      return {
        // 复用已有锁形成暂停边界；不为扩展构造一个参数缺失的替代权限请求。
        // 锁只覆盖审查边界；离开ready后仍由原执行器并行运行工具，而非串行化整段脚本。
        ready: () => gate.withPermits(1)(Effect.suspend(() => stopped ? Effect.interrupt : Effect.void)),
        ask: (request) => Effect.gen(function* () {
          // 实际 request 使用宿主读取的最新 ruleset，父批准只满足 AUTO 的风险门槛。
          const matched = yield* matchRequest(request)
          yield* check(request)
          // 叶子 ask 使用最终参数和 child 身份，父 AUTO 批准不代替用户明确要求的询问。
          if (matched.needsAsk) yield* requestUser(request)
        }).pipe(Effect.catchCause(terminal)),
      }
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

    return Service.of({ ask, beginExecute, reply, list })
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

function rawDenyPatterns(metadata: Readonly<Record<string, unknown>>) {
  const patterns = metadata.raw_patterns
  if (!Array.isArray(patterns)) return []
  // #285：raw_patterns 由 shell 解析产出，用于原始命令证据的拒绝检查。
  // 它是 deny-only：敏感 env 赋值规则保持硬停止，不赋予原始文本 allow/auto/ask 权限。
  return patterns.filter((pattern): pattern is string => typeof pattern === "string")
  // #285：filter 型守卫保持下游类型收窄，调用方无需再断言
}

function rawDenyRule(permission: string, pattern: string, ruleset: PermissionV1.Ruleset) {
  // #285：不使用 last-match-wins 评估器或已批准规则。原始证据对 canonical
  // pattern 不可见，因此 GITHUB_TOKEN=* 的 deny 必须保持终端性，即使后续 bash:* allow。
  return ruleset.find(
    (rule) =>
      rule.action === "deny" &&
      rule.pattern !== "*" &&
      Wildcard.match(permission, rule.permission) &&
      Wildcard.match(pattern, rule.pattern),
      // #285：rule.pattern !== "*" 防止通配兜底规则吞掉原始证据检查；
      // 只有显式命名 pattern 的 deny 才能命中 raw_patterns
  )
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
export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, PermissionSessionCache.node, PermissionCircuitBreaker.node, Config.node] })

export * as Permission from "."

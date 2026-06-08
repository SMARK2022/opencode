export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { PermissionSaved } from "./permission/saved"
import { Config } from "./config"
import { ConfigAutoReview } from "./config/auto-review"
import { PermissionAuto } from "./permission/auto"
import { PermissionReviewer } from "./permission/reviewer"
import { PermissionV1 } from "./v1/permission"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "./session/message"

export { Effect, Rule, Ruleset } from "@opencode-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() { return this.reason ?? "This tool call was blocked by configured permissions." }
}

// 只交付自动审查的明确理由；静态拒绝仍保留各工具既有的错误契约。
export function autoDeniedMessage(error: unknown) {
  return error instanceof BlockedError && error.reason !== undefined ? error.message : undefined
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()
    const config = yield* Config.Service
    const reviewer = yield* PermissionReviewer.Service
    const cache = new Map<string, Set<string>>()
    const circuits = new Map<string, { consecutive: number; recent: boolean[]; triggered: boolean }>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      // 子会话限制位于代理规则之后；审批和实际执行不能只看代理默认allow。
      return merge(agent?.permissions ?? missingAgentPermissions, yield* sessions.permissions(sessionID))
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      // 原始差异只作具体deny证据，不让宽allow、已保存审批或always释放覆盖它。
      const raw = input.action === "bash" ? input.metadata?.raw_patterns : undefined
      return patterns(input).some((resource) => evaluate(input.action, resource, rules).effect === "deny") ||
        Array.isArray(raw) && raw.some((resource) => typeof resource === "string" && rules.some((rule) =>
          rule.effect === "deny" && rule.resource !== "*" && Wildcard.match(input.action, rule.action) && Wildcard.match(resource, rule.resource),
        ))
    }

    function patterns(input: AssertInput) {
      const value = input.action === "bash" ? input.metadata?.canonical_patterns : undefined
      const canonical = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
      return canonical.length ? canonical : input.resources
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const remembered = yield* savedRules()
      const all = [...rules, ...remembered]
      const canonical = patterns(input)
      // 既有持久审批保存的是原命令；只有配置deny通过后才可复用该明确批准。
      const approved = canonical !== input.resources && input.resources.every((resource) => evaluate(input.action, resource, remembered).effect === "allow")
      const effects = canonical.map((resource) => approved ? "allow" : evaluate(input.action, resource, all).effect)
      const resources = canonical.filter((_, index) => effects[index] === "auto")
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      if (effect === "deny" || resources.length === 0) return { effect, rules: all }
      const entries = yield* config.entries()
      const options = entries.flatMap((entry) => entry.type === "document" && entry.info.auto_review ? [entry.info.auto_review] : [])
        .reduce<NonNullable<ConstructorParameters<typeof ConfigAutoReview.Info>[0]>>((value, next) => ({ ...value, ...next }), {})
      const recorded = input.source?.type === "tool" ? yield* sessions.message(SessionMessage.ID.make(input.source.messageID)) : undefined
      const tool = recorded?.sessionID === input.sessionID && recorded.message.type === "assistant"
        ? recorded.message.content.find((part) => part.type === "tool" && part.id === input.source?.callID) : undefined
      // 审查读取已经记录的工具输入，不提前读取尚未获准访问的目标文件。
      const selected = input.agent ?? (yield* sessions.get(input.sessionID))?.agent
      const agent = yield* agents.resolve(selected)
      // 身份来自实际权限owner选择，不依赖模型自行声称使用Auto。
      const metadata = { ...(tool?.type === "tool" ? { tool: tool.name, input: tool.state.input } : {}), ...input.metadata, agent: agent?.id }
      // 工具外部路径门禁需逐次审查操作负载，不能复用自动审批缓存。
      const toolExternal = input.action === "external_directory" && input.metadata?.action_kind === "tool"
      const key = JSON.stringify([input.action, resources, metadata, input.agent, all, options, Config.latest(entries, "approvals_reviewer")])
      const known = cache.get(input.sessionID) ?? new Set<string>()
      cache.set(input.sessionID, known)
      const state = circuits.get(input.sessionID) ?? { consecutive: 0, recent: [], triggered: false }
      circuits.set(input.sessionID, state)
      const record = (denied: boolean) => {
        state.consecutive = denied ? state.consecutive + 1 : 0
        state.recent.push(denied)
        if (state.recent.length > Math.max(1, Math.floor(options.recent_denial_window ?? 50))) state.recent.shift()
      }
      if (!toolExternal && known.has(key)) {
        record(false)
        return { effect, rules: all }
      }
      // 显式人工模式不调用reviewer；其余基础设施失败按同一fallback配置处理。
      const reviewerDisabled = Config.latest(entries, "approvals_reviewer") === "user"
      const decision = yield* PermissionAuto.evaluate({ permission: input.action, patterns: resources, metadata, tool: input.source, strict: options.strict, reviewerFailureFallback: reviewerDisabled ? "user" : options.fallback ?? "user" }, reviewerDisabled ? undefined : {
        review: (request) => reviewer.review({ ...request, sessionID: input.sessionID }),
      }, (review) => events.publish(PermissionV1.Event.ReviewStarted, {
        sessionID: input.sessionID,
        reviewID: review.reviewID,
        permission: input.action,
        patterns: [...resources],
        precheck: review.precheck,
      }))
      const sessionID = SessionID.make(input.sessionID)
      // 使用既有兼容事件记录审查，不能冒充用户的 once/always 批准。
      if (decision.source === "reviewer") {
        const reviewID = "reviewID" in decision ? decision.reviewID : undefined
        if (reviewID) yield* events.publish(PermissionV1.Event.ReviewCompleted, {
          sessionID, reviewID, outcome: decision.action, rationale: decision.reason,
        })
        else yield* events.publish(PermissionV1.Event.ReviewFailed, { sessionID, reviewID: "unknown", reason: decision.reason })
      }
      if (decision.action === "deny") {
        if (decision.source === "reviewer") {
          record(true)
          const recent = state.recent.filter(Boolean).length
          if (!state.triggered && (state.consecutive >= Math.max(1, options.max_consecutive_denials ?? 3) || recent >= Math.max(1, options.max_recent_denials ?? 10))) {
            state.triggered = true
            yield* events.publish(PermissionV1.Event.CircuitBroken, { sessionID, consecutive: state.consecutive, recent })
          }
        }
        return { effect: "deny" as const, rules: all, reason: new PermissionV1.AutoDeniedError({ reason: decision.reason }).message }
      }
      if (decision.action === "ask") return { effect: "ask" as const, rules: all }
      record(false)
      if (decision.source === "reviewer" && !toolExternal) known.add(key)
      // 自动批准不覆盖请求中另一个仍为 ask 的资源。
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* restore(evaluateInput(input))
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
              reason: "reason" in result ? result.reason : undefined,
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node, Config.node, PermissionReviewer.node],
})

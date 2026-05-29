import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"
import { PermissionAuto } from "./auto"
import { PermissionPrecheck } from "./precheck"
import { PermissionReviewer } from "./reviewer/service"
import { PermissionSessionCache } from "./cache/session-cache"
import { PermissionCircuitBreaker } from "./reviewer/circuit-breaker"
import * as Option from "effect/Option"

const log = Log.create({ service: "permission" })

export const Action = Schema.Literals(["allow", "deny", "ask", "auto"]).annotate({ identifier: "PermissionAction" })
export type Action = Schema.Schema.Type<typeof Action>

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}).annotate({ identifier: "PermissionRule" })
export type Rule = Schema.Schema.Type<typeof Rule>

export const Ruleset = Schema.mutable(Schema.Array(Rule)).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {}

export const Reply = Schema.Literals(["once", "always", "reject"])
export type Reply = Schema.Schema.Type<typeof Reply>

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

export const ReplyBody = Schema.Struct(reply).annotate({ identifier: "PermissionReplyBody" })
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    Schema.Struct({
      sessionID: SessionID,
      requestID: PermissionID,
      reply: Reply,
    }),
  ),
  // Review events are observational only. Permission decisions still resolve via
  // `ask`/errors below so existing callers do not need to subscribe to these new
  // event types to preserve behavior.
  ReviewCompleted: BusEvent.define(
    "permission.review.completed",
    Schema.Struct({
      sessionID: SessionID,
      reviewID: Schema.String,
      outcome: Schema.Literals(["allow", "deny"]),
      rationale: Schema.String,
    }),
  ),
  ReviewStarted: BusEvent.define(
    "permission.review.started",
    Schema.Struct({
      sessionID: SessionID,
      reviewID: Schema.String,
      permission: Schema.String,
      patterns: Schema.Array(Schema.String),
      precheck: Schema.Struct({
        level: Schema.Literals(PermissionPrecheck.LEVELS),
        reason: Schema.String,
      }),
    }),
  ),
  ReviewFailed: BusEvent.define(
    "permission.review.failed",
    Schema.Struct({ sessionID: SessionID, reviewID: Schema.String, reason: Schema.String }),
  ),
  CircuitBroken: BusEvent.define(
    "permission.review.circuit_broken",
    Schema.Struct({ sessionID: SessionID, consecutive: Schema.Number, recent: Schema.Number }),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class AutoDeniedError extends Schema.TaggedErrorClass<AutoDeniedError>()("PermissionAutoDeniedError", {
  reason: Schema.String,
}) {
  override get message() {
    // Keep denial feedback non-actionable from a bypass perspective. The agent
    // may choose a safer implementation or ask the user for explicit approval,
    // but the message must not encourage shell wrappers, generated scripts, MCP
    // detours, or alternate tools for the same rejected outcome.
    return `Auto permission preflight rejected this tool call: ${this.reason}. Do not retry the same outcome through shell indirection, generated scripts, alternative tools, MCP tools, or other policy workarounds. Use a materially safer approach, or ask the user for explicit confirmation before attempting a risky operation.`
  }
}

export type Error = DeniedError | AutoDeniedError | RejectedError | CorrectedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
}).annotate({ identifier: "PermissionAskInput" })
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
}).annotate({ identifier: "PermissionReplyInput" })
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return evalRule(permission, pattern, ...rulesets)
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    // Capture optional collaborators when Permission.Service is constructed.
    // Tool execution later re-enters Effect through EffectBridge with a captured
    // context; resolving these services inside `ask` can miss reviewer layers
    // that were privately provided to Permission.defaultLayer.
    const reviewer = Option.getOrUndefined(yield* Effect.serviceOption(PermissionReviewer.Service))
    const cache = Option.getOrUndefined(yield* Effect.serviceOption(PermissionSessionCache.Service))
    const circuit = Option.getOrUndefined(yield* Effect.serviceOption(PermissionCircuitBreaker.Service))
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: row?.data ?? [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false
      let needsAuto = false
      const autoPatterns: string[] = []

      // Evaluate every requested pattern before taking action. Static deny keeps
      // highest precedence, while mixed auto/ask requests preserve both gates:
      // auto can reject critical payloads, but reviewer allow cannot bypass a
      // separate user approval requirement.
      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new DeniedError({
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

      if (needsAuto) {
        // All auto-review collaborators are optional at this layer. That keeps
        // older tests/runtimes using Permission.layer working; missing reviewer
        // or explicit fallback returns to the normal pending permission path.
        const permissionConfig = config ? (yield* config.get()).permission : undefined
        const strict = permissionConfig?.auto_review?.strict === true
        const reviewerDisabled = permissionConfig?.approvals_reviewer === "user"
        // Reviewer retry remains owned by PermissionReviewer/SessionRetry. This
        // flag only decides what happens after retry is exhausted or the reviewer
        // is unavailable: default back to the existing human ask boundary, while
        // explicit fallback=deny keeps the legacy fail-closed behavior.
        const reviewerFailureFallback = reviewerDisabled ? "user" : (permissionConfig?.auto_review?.fallback ?? "user")
        // Auto review/cache must operate only on the patterns that matched an
        // `auto` rule. The original request may also contain ask-controlled
        // patterns; caching those before the user replies would turn a rejected
        // mixed request into a future silent allow if rules change later.
        const autoRequest = { ...request, patterns: autoPatterns }
        if (cache && (yield* cache.has(autoRequest))) {
          // Session cache only satisfies the auto-controlled portion. If another
          // pattern still needs ask, continue into the user prompt below instead
          // of returning early. A cache hit is still an auto non-denial, so reset
          // the advisory denial circuit just like a fresh precheck/reviewer allow.
          if (circuit) yield* circuit.recordNonDenial(request.sessionID)
          if (!needsAsk) return
        } else {
          const decision = yield* PermissionAuto.evaluate(
            { ...autoRequest, strict, reviewerFailureFallback },
            reviewerDisabled ? undefined : reviewer,
            (review) =>
              // This event is the user's visible boundary between deterministic
              // precheck and model review. It intentionally carries only the
              // matched auto patterns and precheck rationale, not raw hidden
              // prompt text, so UIs can show progress without leaking synthetic
              // reviewer context or duplicating the pending tool arguments.
              bus.publish(Event.ReviewStarted, {
                sessionID: request.sessionID,
                reviewID: review.reviewID,
                permission: autoRequest.permission,
                patterns: [...autoRequest.patterns],
                precheck: review.precheck,
              }),
          )
          log.info("auto evaluated", { permission: request.permission, action: decision.action, reason: decision.reason })
          if (decision.action === "allow") {
            if (circuit) yield* circuit.recordNonDenial(request.sessionID)
            if (decision.source === "reviewer") {
              const reviewID = "reviewID" in decision ? decision.reviewID : undefined
              if (reviewID) {
                // Reviewer allow is auditable and cacheable, but it is not a user
                // approval. Record it before any fast return so the pure-auto path
                // has the same cache/circuit/audit behavior as mixed auto+ask.
                yield* bus.publish(Event.ReviewCompleted, {
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
            if (decision.source === "reviewer" && circuit) {
              const reviewID = "reviewID" in decision ? decision.reviewID : undefined
              if (reviewID) {
                yield* bus.publish(Event.ReviewCompleted, {
                  sessionID: request.sessionID,
                  reviewID,
                  outcome: "deny",
                  rationale: decision.reason,
                })
              } else {
                yield* bus.publish(Event.ReviewFailed, {
                  sessionID: request.sessionID,
                  reviewID: "unknown",
                  reason: decision.reason,
                })
              }
              const action = yield* circuit.recordDenial(request.sessionID)
              if (action.kind === "interrupt") {
                // Circuit state is advisory for now: the event gives the UI a
                // chance to interrupt or explain repeated denials without
                // changing this call's fail-closed outcome.
                yield* bus.publish(Event.CircuitBroken, {
                  sessionID: request.sessionID,
                  consecutive: action.consecutive,
                  recent: action.recent,
                })
              }
            }
            return yield* new AutoDeniedError({ reason: decision.reason })
          }
          if (decision.action === "ask") needsAsk = true
        }
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return

      pending.delete(input.requestID)
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
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
        yield* bus.publish(Event.Replied, {
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
  // Permission config historically accepts home-relative patterns. Keep this
  // expansion local to config-to-rules conversion so runtime command patterns
  // are not rewritten after the user has already approved them.
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Ruleset = []
  for (const [key, value] of Object.entries(permission)) {
    // `approvals_reviewer` and `auto_review` are controls for the auto pipeline,
    // not permission names. Treating them as rules would leak config metadata
    // into the evaluator and could accidentally authorize a tool named after a
    // config key.
    if (key === "approvals_reviewer" || key === "auto_review") continue
    if (isAction(value)) {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    if (!isPermissionObject(value)) continue
    ruleset.push(
      ...Object.entries(value).flatMap(([pattern, action]) =>
        isAction(action) ? [{ permission: key, pattern: expand(pattern), action }] : [],
      ),
    )
  }
  return ruleset
}

function isAction(input: unknown): input is Action {
  // Guard dynamically parsed config before flattening. The schema is permissive
  // enough to hold auto-review control objects, so runtime conversion must only
  // emit actual permission actions.
  return input === "ask" || input === "allow" || input === "deny" || input === "auto"
}

function isPermissionObject(input: unknown): input is Record<string, Action> {
  // Arrays and auto_review objects are not permission pattern maps. Each nested
  // value is checked by isAction before a rule is emitted.
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

export function compact(ruleset: Ruleset): Ruleset {
  const seen = new Set<string>()
  // Permission evaluation is last-match-wins. Keep that behavior while pruning
  // older exact duplicates so repeated UI toggles do not grow session state.
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

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  // Permission.Service captures optional auto-review collaborators at layer
  // construction time. Keep the production default fully wired here so nested
  // session/runtime layers cannot accidentally construct a reviewer-less
  // permission service and downgrade Auto shell decisions to plain ask.
  Layer.provide(Config.defaultLayer),
  Layer.provide(PermissionReviewer.defaultLayerWithSession),
  Layer.provide(PermissionSessionCache.defaultLayer),
  Layer.provide(PermissionCircuitBreaker.defaultLayer),
)

export * as Permission from "."

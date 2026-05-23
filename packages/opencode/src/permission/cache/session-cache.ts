import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Context, Effect, Layer } from "effect"

type Value = "allow" | "deny"
type Key = string

export interface RequestLike {
  readonly sessionID: SessionID
  readonly permission: string
  readonly patterns: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface Interface {
  readonly has: (request: RequestLike) => Effect.Effect<boolean>
  readonly put: (request: RequestLike, value: Value) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionSessionCache") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<Map<SessionID, Map<Key, Value>>>(
      Effect.fn("PermissionSessionCache.state")(function* () {
        return new Map<SessionID, Map<Key, Value>>()
      }),
    )

    const has = Effect.fn("PermissionSessionCache.has")(function* (request: RequestLike) {
      // Tool-origin external directory prompts carry operation/payload evidence
      // rather than a final diff; do not reuse a path allow for a later write or
      // patch with different content in the same external directory.
      if (isToolExternalDirectory(request)) return false
      // Cache hits require every pattern in the current request to have been
      // approved for this same session. A partial hit must still run review/user
      // approval for the remaining pattern instead of widening the approval.
      const session = (yield* InstanceState.get(state)).get(request.sessionID)
      if (!session) return false
      return request.patterns.every((pattern) => session.get(canonicalKey(request, pattern)) === "allow")
    })

    const put = Effect.fn("PermissionSessionCache.put")(function* (request: RequestLike, value: Value) {
      if (isToolExternalDirectory(request)) return
      const all = yield* InstanceState.get(state)
      const session = all.get(request.sessionID) ?? new Map<Key, Value>()
      all.set(request.sessionID, session)
      for (const pattern of request.patterns) session.set(canonicalKey(request, pattern), value)
    })

    return Service.of({ has, put })
  }),
)

function canonicalKey(request: RequestLike, pattern: string) {
  // Include the action context that the reviewer saw. The same permission rule
  // and pattern can describe different shell commands, working directories, or
  // shells, and the same edit path can carry a different diff. Reusing approval
  // without those fields would widen review scope across materially different
  // tool calls in the same session.
  return JSON.stringify([
    request.permission,
    pattern.replace(/\s+/g, " ").trim(),
    contextValue(request.metadata.command),
    contextValue(request.metadata.cwd),
    contextValue(request.metadata.shell),
    contextValue(request.metadata.filepath),
    contextValue(request.metadata.diff),
  ])
}

function contextValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function isToolExternalDirectory(request: RequestLike) {
  return request.permission === "external_directory" && request.metadata.action_kind === "tool"
}

export const defaultLayer = layer

export * as PermissionSessionCache from "./session-cache"

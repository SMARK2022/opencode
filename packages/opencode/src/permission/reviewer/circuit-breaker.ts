import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import * as Option from "effect/Option"

const DEFAULT_MAX_CONSECUTIVE = 3
const DEFAULT_MAX_RECENT_DENIALS = 10
const DEFAULT_WINDOW = 50

export interface Action {
  readonly kind: "continue" | "interrupt"
  readonly consecutive: number
  readonly recent: number
}

interface TurnState {
  consecutive: number
  recent: boolean[]
  triggered: boolean
}

export interface Interface {
  readonly recordDenial: (sessionID: SessionID) => Effect.Effect<Action>
  readonly recordNonDenial: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionCircuitBreaker") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<Map<SessionID, TurnState>>(
      Effect.fn("PermissionCircuitBreaker.state")(function* () {
        return new Map<SessionID, TurnState>()
      }),
    )

    const recordDenial = Effect.fn("PermissionCircuitBreaker.recordDenial")(function* (sessionID: SessionID) {
      // Limits are read at decision time so project config reloads can tighten or
      // relax the circuit without recreating the service. The state remains per
      // instance/session through InstanceState.
      const limit = yield* limits()
      const current = pick(yield* InstanceState.get(state), sessionID)
      current.consecutive++
      pushWindow(current.recent, true, limit.window)
      const recent = current.recent.filter(Boolean).length
      if (
        !current.triggered &&
        (current.consecutive >= limit.maxConsecutive || recent >= limit.maxRecent)
      ) {
        current.triggered = true
        return { kind: "interrupt", consecutive: current.consecutive, recent } as const
      }
      return { kind: "continue", consecutive: current.consecutive, recent } as const
    })

    const recordNonDenial = Effect.fn("PermissionCircuitBreaker.recordNonDenial")(function* (sessionID: SessionID) {
      const limit = yield* limits()
      const current = pick(yield* InstanceState.get(state), sessionID)
      current.consecutive = 0
      pushWindow(current.recent, false, limit.window)
    })

    return Service.of({ recordDenial, recordNonDenial })
  }),
)

function pick(map: Map<SessionID, TurnState>, sessionID: SessionID) {
  // Store circuit state by session so repeated denials in one conversation do
  // not punish unrelated sessions in the same project instance.
  const existing = map.get(sessionID)
  if (existing) return existing
  const created = { consecutive: 0, recent: [], triggered: false }
  map.set(sessionID, created)
  return created
}

function pushWindow(window: boolean[], value: boolean, limit: number) {
  window.push(value)
  if (window.length > limit) window.shift()
}

function limits() {
  return Effect.gen(function* () {
    // Config is optional so unit tests can use the bare circuit layer. Missing or
    // invalid numeric values fall back to defaults via positiveInt below.
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const auto = config ? (yield* config.get()).permission?.auto_review : undefined
    return {
      maxConsecutive: positiveInt(auto?.max_consecutive_denials) ?? DEFAULT_MAX_CONSECUTIVE,
      maxRecent: positiveInt(auto?.max_recent_denials) ?? DEFAULT_MAX_RECENT_DENIALS,
      window: positiveInt(auto?.recent_denial_window) ?? DEFAULT_WINDOW,
    }
  })
}

function positiveInt(value: number | undefined) {
  // Non-positive or non-finite thresholds are ignored rather than treated as 0;
  // a zero threshold would interrupt every session immediately and surprise
  // users after a config typo.
  if (value === undefined || !Number.isFinite(value) || value < 1) return
  return Math.floor(value)
}

export const defaultLayer = layer

export * as PermissionCircuitBreaker from "./circuit-breaker"

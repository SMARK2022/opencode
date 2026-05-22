import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import * as Option from "effect/Option"

// #198：连续拒绝阈值默认 3——3 次连续 deny 触发熔断，防止 reviewer 持续误判后继续消耗配额
const DEFAULT_MAX_CONSECUTIVE = 3
// #198：滑动窗口内拒绝阈值默认 10——50 次审查中 10 次 deny 触发熔断，捕获长期拒绝密度
const DEFAULT_MAX_RECENT_DENIALS = 10
// #198：滑动窗口大小默认 50——决定密度计算的样本量，足够大以避免偶发拒绝误触发
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
      const limit = yield* limits()
      const current = pick(yield* InstanceState.get(state), sessionID)
      // #198：连续拒绝计数器递增——追踪当前连拒绝序列长度
      current.consecutive++
      pushWindow(current.recent, true, limit.window)
      const recent = current.recent.filter(Boolean).length
      // #198：连续拒绝超阈值或滑动窗口内拒绝超阈值时触发熔断——triggered 一旦置位则永久中断该 session 的 auto 审批
      // #198：连续计数器捕获突发拒绝——短时间内多次 deny 可能表示 reviewer 与用户意图严重偏离
      // #198：滑动窗口捕获长期拒绝密度——窗口内高 deny 比率可能表示 session 环境不稳定
      if (
        !current.triggered &&
        (current.consecutive >= limit.maxConsecutive || recent >= limit.maxRecent)
      ) {
        // #198：triggered 是粘性标志——一旦熔断不自动恢复，需 session 重启或显式重置
        current.triggered = true
        return { kind: "interrupt", consecutive: current.consecutive, recent } as const
      }
      // #198：未触发熔断时返回 continue——调用方继续 auto 审批流程
      return { kind: "continue", consecutive: current.consecutive, recent } as const
    })

    // #198：非拒绝重置连续计数器但不重置滑动窗口——窗口保留历史拒绝密度，连续计数仅追踪当前连拒绝序列
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
  const existing = map.get(sessionID)
  // #198：已存在的 session 状态直接复用——保留连续计数和滑动窗口历史
  if (existing) return existing
  // #198：新 session 初始化为全零状态——无历史拒绝记录，consecutive=0、recent=[]、triggered=false
  const created = { consecutive: 0, recent: [], triggered: false }
  map.set(sessionID, created)
  return created
}

// #198：滑动窗口——push 后超限则 shift 最旧记录，保持窗口大小不超过 limit
function pushWindow(window: boolean[], value: boolean, limit: number) {
  window.push(value)
  if (window.length > limit) window.shift()
}

// #198：从 config 读取熔断阈值——Config 为 optional service，缺失时使用默认值
function limits() {
  return Effect.gen(function* () {
    // #198：Config 为 optional service——无 config 时使用默认阈值，不因配置缺失而中断熔断保护
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const auto = config ? (yield* config.get()).permission?.auto_review : undefined
    return {
      // #198：max_consecutive_denials 默认 3——3 次连续 deny 触发熔断
      maxConsecutive: positiveInt(auto?.max_consecutive_denials) ?? DEFAULT_MAX_CONSECUTIVE,
      // #198：max_recent_denials 默认 10——滑动窗口内 10 次 deny 触发熔断
      maxRecent: positiveInt(auto?.max_recent_denials) ?? DEFAULT_MAX_RECENT_DENIALS,
      // #198：recent_denial_window 默认 50——窗口大小决定密度计算的样本量
      window: positiveInt(auto?.recent_denial_window) ?? DEFAULT_WINDOW,
    }
  })
}

// #198：正整数校验——过滤 undefined、NaN、零和负数，防止配置错误导致熔断器永远不触发或立即触发
function positiveInt(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 1) return
  return Math.floor(value)
}

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as PermissionCircuitBreaker from "./circuit-breaker"

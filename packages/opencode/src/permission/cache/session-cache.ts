import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
      // #198：缓存命中要求当前请求的每个 pattern 都已被同一 session 放行——部分命中仍需 review/审批剩余 pattern，不得扩大授权范围
      const session = (yield* InstanceState.get(state)).get(request.sessionID)
      // #198：无 session 记录时缓存未命中——首次请求或 session 重启后无历史授权
      if (!session) return false
      // #198：every 而非 some——所有 pattern 都需已放行，任一未放行则整体回退到 review/审批
      return request.patterns.every((pattern) => session.get(canonicalKey(request, pattern)) === "allow")
    })

    const put = Effect.fn("PermissionSessionCache.put")(function* (request: RequestLike, value: Value) {
      const all = yield* InstanceState.get(state)
      // #198：按 sessionID 分组存储——不同 session 的授权互不干扰
      const session = all.get(request.sessionID) ?? new Map<Key, Value>()
      all.set(request.sessionID, session)
      // #198：每个 pattern 独立存储——has() 逐个检查，部分缓存命中不会误判为全部命中
      for (const pattern of request.patterns) session.set(canonicalKey(request, pattern), value)
    })

    return Service.of({ has, put })
  }),
)

// #198：规范化缓存键——包含 permission、pattern、command、cwd、shell、filepath、diff，防止不同上下文的相同 pattern 误命中缓存
function canonicalKey(request: RequestLike, pattern: string) {
  // #198：JSON.stringify 生成稳定键——数组顺序固定，确保相同输入始终命中同一缓存槽
  return JSON.stringify([
    request.permission,
    // #198：pattern 规范化空白——多空格/前后空格不影响缓存命中
    pattern.replace(/\s+/g, " ").trim(),
    // #198：command/cwd/shell/filepath/diff 纳入键——相同 pattern 在不同命令/目录/shell 下是不同请求
    contextValue(request.metadata.command),
    contextValue(request.metadata.cwd),
    contextValue(request.metadata.shell),
    contextValue(request.metadata.filepath),
    contextValue(request.metadata.diff),
  ])
}

// #198：仅字符串值纳入键——非字符串 metadata 字段不影响缓存身份
function contextValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export const defaultLayer = layer

// #198：node 无 deps——InstanceState 基于 scope 而非 node 依赖，session-cache 不依赖 Config/Provider/Session
export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as PermissionSessionCache from "./session-cache"

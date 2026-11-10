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
      // #210：tool-origin external_directory 请求携带 operation/payload 证据而非最终 diff，
      // #210：不复用同一外部目录的路径放行去授权后续不同内容的 write/patch
      if (isToolExternalDirectory(request)) return false
      // 结构化 metadata 不参与未知对象序列化，也不允许一次放行复用到不同失败载荷。
      if (hasNonStringMetadata(request)) return false
      // #198：缓存命中要求当前请求的每个 pattern 都已被同一 session 放行——部分命中仍需 review/审批剩余 pattern，不得扩大授权范围
      const session = (yield* InstanceState.get(state)).get(request.sessionID)
      // #198：无 session 记录时缓存未命中——首次请求或 session 重启后无历史授权
      if (!session) return false
      // #198：every 而非 some——所有 pattern 都需已放行，任一未放行则整体回退到 review/审批
      return request.patterns.every((pattern) => session.get(canonicalKey(request, pattern)) === "allow")
    })

    const put = Effect.fn("PermissionSessionCache.put")(function* (request: RequestLike, value: Value) {
      // #210：tool-origin 请求不写入缓存——放行不可跨内容复用，避免路径命中授权不同写操作
      if (isToolExternalDirectory(request)) return
      // put 同步跳过结构化载荷，避免写入无法安全区分的缓存槽。
      if (hasNonStringMetadata(request)) return
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

// #198：规范化缓存键——包含 permission、pattern、既有上下文和按 key 排序的字符串 metadata
// #210：tool-origin 与结构化 metadata 在 has/put 入口短路，canonicalKey 无需序列化未知对象
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
    ...Object.entries(request.metadata)
      .map(([key, value]) => [key, contextValue(value)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  ])
}

// #198：仅字符串值纳入键——非字符串 metadata 字段不影响缓存身份
function contextValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// undefined 表示字段缺省；其余非字符串载荷都不可复用，避免把不同对象压成同一身份。
function hasNonStringMetadata(request: RequestLike) {
  return Object.values(request.metadata).some((value) => value !== undefined && typeof value !== "string")
}

// #210：识别 tool-origin external_directory 请求——action_kind=tool 标记来自读写工具的项目外路径门禁
function isToolExternalDirectory(request: RequestLike) {
  return request.permission === "external_directory" && request.metadata.action_kind === "tool"
}

export const defaultLayer = layer

// #198：node 无 deps——InstanceState 基于 scope 而非 node 依赖，session-cache 不依赖 Config/Provider/Session
export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as PermissionSessionCache from "./session-cache"

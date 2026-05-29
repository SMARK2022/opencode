import { NetworkProxy } from "@opencode-ai/core/network-proxy"

// TUI 每次查询只声明“这个 provider origin 仍在被看见”。daemon 在最近
// 10s 内持续维护这些 origin，超窗后丢弃，避免无人使用的 sidebar 状态长期
// 发起后台 HEAD 请求。
const ACTIVE_WINDOW = 10_000
// 保持与原 sidebar 每秒刷新一次的显示语义一致；多个 TUI 共享同一个 daemon
// cache，所以这里是一秒最多一次 daemon 侧探测，而不是每个 TUI 各探测一次。
const REFRESH_INTERVAL = 1_000
// sidebar 延迟只是辅助信号，不能因为 provider 或 proxy 卡住而拖垮 TUI；3s
// 沿用原 TUI 侧探测超时，保证失败路径显示 offline 而不是无限等待。
const PROBE_TIMEOUT = 3_000

type EndpointState = "ok" | "down"

export type EndpointStatus = {
  url: string
  status: EndpointState
  latency: number | null
  route: { type: "direct" | "proxy"; reason: string }
  checkedAt: number
}

type Entry = {
  status?: EndpointStatus
  lastSeen: number
  // 同一 origin 的并发 TUI 请求必须共享一个 HEAD probe。这个 Promise 是
  // transient 的，不进入 wire schema，完成后立即清空，避免把实现状态泄漏给
  // TUI 或插件侧。
  inFlight?: Promise<EndpointStatus>
}

const entries = new Map<string, Entry>()
let timer: ReturnType<typeof setTimeout> | undefined

export function normalizeEndpoint(input: string) {
  try {
    const url = new URL(input)
    // provider endpoint 只允许 HTTP(S)。file:、data: 等 scheme 不代表真实
    // provider 网络 origin，提前拒绝可避免 daemon 把本地资源或无意义 URL 当作
    // 可探测端点。
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin
  } catch {
    return
  }
}

export async function getEndpointStatus(input: string) {
  const url = normalizeEndpoint(input)
  if (!url) return

  const entry = entries.get(url) ?? createEntry(url)
  entry.lastSeen = Date.now()
  entries.set(url, entry)
  ensureTimer()

  if (shouldRefresh(entry)) return refresh(url, entry)
  return entry.status
}

function createEntry(url: string): Entry {
  // 首次创建时不写 wire status：handler 会等待首个 probe 完成后再响应，
  // 因此外部永远只看到 ok/down，TUI 本地的 init 仍表示“请求尚未返回”。
  return {
    lastSeen: Date.now(),
  }
}

function shouldRefresh(entry: Entry) {
  if (entry.inFlight) return true
  if (!entry.status) return true
  return Date.now() - entry.status.checkedAt >= REFRESH_INTERVAL
}

function ensureTimer() {
  if (timer) return
  // daemon 是所有 TUI 的统一观测源。这个 unref timer 只服务最近 10s 被
  // TUI 查询过的 provider origin，既保持显示新鲜，又不会为了 UI 辅助信息
  // 阻止 daemon 在空闲时退出。
  timer = setTimeout(tick, REFRESH_INTERVAL)
  timer.unref?.()
}

function tick() {
  timer = undefined
  const now = Date.now()
  for (const [url, entry] of entries) {
    if (now - entry.lastSeen > ACTIVE_WINDOW) {
      entries.delete(url)
      continue
    }
    if (shouldRefresh(entry)) void refresh(url, entry)
  }
  if (entries.size > 0) ensureTimer()
}

function refresh(url: string, entry: Entry) {
  if (entry.inFlight) return entry.inFlight

  entry.inFlight = probe(url)
    .then((status) => {
      entry.status = status
      return status
    })
    .finally(() => {
      entry.inFlight = undefined
    })
  return entry.inFlight
}

async function probe(url: string): Promise<EndpointStatus> {
  const started = Date.now()
  const route = await NetworkProxy.resolveProxyRoute(url, "provider")
  try {
    const response = await NetworkProxy.routedFetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      purpose: "provider",
    } as RequestInit)
    const latency = Date.now() - started
    return {
      url,
      status: response.status === 502 || response.status === 503 || response.status === 504 ? "down" : "ok",
      latency,
      route: route.type === "proxy" ? { type: "proxy", reason: route.reason } : { type: "direct", reason: route.reason },
      checkedAt: Date.now(),
    }
  } catch {
    return {
      url,
      status: "down",
      latency: null,
      route: route.type === "proxy" ? { type: "proxy", reason: route.reason } : { type: "direct", reason: route.reason },
      checkedAt: Date.now(),
    }
  }
}

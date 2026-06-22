export * as NetworkProxy from "./network-proxy"

import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export type Purpose = "local" | "provider" | "infrastructure" | "npm" | "plugin" | "unknown"

export type Route = { type: "direct"; reason: string } | { type: "proxy"; proxy: string; reason: string }

/** Proxy resolution TTL: re-check system proxy settings every 10s */
const PROXY_TTL = 10_000
/** Hostnames that should never be routed through a proxy */
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"])

let cache: { expires: number; value: Promise<SystemProxy | undefined> } | undefined
let globalFetchInstalled = false
/**
 * Pre-bound native fetch reference.
 * Captured once at module load before global fetch may be overridden by installGlobalFetch().
 */
const nativeFetch = globalThis.fetch.bind(globalThis) as FetchFn

type SystemProxy = {
  http?: string
  https?: string
  socks?: string
  bypass: string[]
}

type RoutedInit = RequestInit & { purpose?: Purpose }
type FetchInput = Request | string | URL
type FetchFn = (input: FetchInput, init?: any) => Promise<Response>

export function noProxyString(extra: string[] = []) {
  return Array.from(new Set([...LOCAL, ...extra])).join(",")
}

function normalizeHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

function isLocal(url: URL) {
  return LOCAL.has(normalizeHost(url.hostname))
}

/**
 * Normalize a proxy string into a valid URL.
 * Converts "localhost" hostnames to 127.0.0.1 for consistent resolution.
 * Falls back to the raw value if URL parsing fails.
 */
function normalizeProxy(value: string | undefined) {
  if (!value) return
  const next = value.trim()
  if (!next) return
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(next) ? next : `http://${next}`
  try {
    const url = new URL(normalized)
    if (normalizeHost(url.hostname) === "localhost") url.hostname = "127.0.0.1"
    return url.toString()
  } catch {
    return normalized
  }
}

/**
 * Check whether the given hostname matches any entry in the bypass list.
 * Supports exact match, wildcard prefix (*.example.com), and glob patterns.
 */
function bypass(url: URL, list: string[]) {
  const host = normalizeHost(url.hostname)
  for (const raw of list) {
    const item = raw.trim().toLowerCase()
    if (!item) continue
    if (item === "<local>" && !host.includes(".")) return true
    if (item === host) return true
    if (item.startsWith("*.") && host.endsWith(item.slice(1))) return true
    if (item.includes("*")) {
      const escaped = item.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
      if (new RegExp(`^${escaped}$`).test(host)) return true
    }
  }
  return false
}

/**
 * Read proxy configuration from environment variables.
 * Respects HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and NO_PROXY bypass rules.
 */
function envProxy(url: URL): SystemProxy | undefined {
  const proxy =
    url.protocol === "https:"
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy
  const all = process.env.ALL_PROXY || process.env.all_proxy
  const picked = normalizeProxy(proxy || all)
  if (!picked) return
  return { http: picked, https: picked, bypass: (process.env.NO_PROXY || process.env.no_proxy || "").split(",") }
}

/** Execute a shell command and return its stdout text */
async function execText(command: string, args: string[], timeout = 1500) {
  // Windows 系统代理读取会定期调用 reg.exe；必须隐藏 helper 控制台，否则 daemon 每次刷新代理都会弹出 conhost。
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore", windowsHide: process.platform === "win32" })
  const timer = setTimeout(() => proc.kill(), timeout)
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (code !== 0) return ""
    return stdout
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse a Windows proxy server string which may use protocol=host;port format.
 * Falls back to normalizing the raw value if no = delimiters are present.
 */
function parseWindowsProxyServer(value: string, protocol: string) {
  if (!value.includes("=")) return normalizeProxy(value)
  const entries = Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((part): part is [string, string] => part.length === 2 && !!part[0] && !!part[1])
      .map(([key, val]) => [key.toLowerCase(), val]),
  )
  return normalizeProxy(entries[protocol.replace(":", "")] || entries.http || entries.https || entries.socks)
}

async function windowsProxy(): Promise<SystemProxy | undefined> {
  const text = await execText("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"])
  if (!text) return
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+REG_\S+\s+(.+)$/)
    if (match) values.set(match[1], match[2].trim())
  }
  const enabled = values.get("ProxyEnable") === "0x1"
  const server = values.get("ProxyServer")
  const bypassList = (values.get("ProxyOverride") || "").split(";")
  const proxy = enabled && server ? parseWindowsProxyServer(server, "https:") : undefined
  return { http: proxy, https: proxy, bypass: bypassList }
}

async function macProxy(): Promise<SystemProxy | undefined> {
  const text = await execText("scutil", ["--proxy"])
  if (!text) return
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+)\s*:\s*(.+)$/)
    if (match) values.set(match[1].trim(), match[2].trim())
  }
  const https = values.get("HTTPSEnable") === "1" ? normalizeProxy(`${values.get("HTTPSProxy")}:${values.get("HTTPSPort")}`) : undefined
  const http = values.get("HTTPEnable") === "1" ? normalizeProxy(`${values.get("HTTPProxy")}:${values.get("HTTPPort")}`) : undefined
  const socks = values.get("SOCKSEnable") === "1" ? normalizeProxy(`socks5://${values.get("SOCKSProxy")}:${values.get("SOCKSPort")}`) : undefined
  return { http, https, socks, bypass: [] }
}

/** Retrieve system proxy settings with caching (TTL = 10s) */
async function currentSystemProxy(refresh = false) {
  if (process.platform !== "win32" && process.platform !== "darwin") return undefined
  if (refresh) cache = undefined
  if (!cache || cache.expires < Date.now()) {
    cache = {
      expires: Date.now() + PROXY_TTL,
      value: (process.platform === "win32" ? windowsProxy() : macProxy()).catch(() => undefined),
    }
  }
  return cache.value
}

/**
 * Determine the effective proxy for a URL.
 * On Windows/macOS reads system proxy settings; on Linux falls back to env vars.
 * Respects the bypass/no-proxy list from the same source.
 */
async function configuredProxy(url: URL, refresh = false) {
  if (process.platform === "win32" || process.platform === "darwin") {
    const sys = await currentSystemProxy(refresh)
    if (!sys || bypass(url, sys.bypass)) return
    return url.protocol === "https:" ? sys.https || sys.http || sys.socks : sys.http || sys.https || sys.socks
  }
  const env = envProxy(url)
  if (!env || bypass(url, env.bypass)) return
  return url.protocol === "https:" ? env.https || env.http || env.socks : env.http || env.https || env.socks
}

/**
 * Resolve the proxy route for a given URL.
 * Returns either a `proxy` route (with the proxy URL) or a `direct` route.
 * Local addresses and `local`-purpose calls always return `direct`.
 */
export async function resolveProxyRoute(input: string | URL, purpose: Purpose = "unknown", refresh = false): Promise<Route> {
  const url = input instanceof URL ? input : new URL(input)
  if (purpose === "local" || isLocal(url)) return { type: "direct", reason: "local" }
  const proxy = await configuredProxy(url, refresh)
  if (proxy) return { type: "proxy", proxy, reason: refresh ? "system-refresh" : "system" }
  return { type: "direct", reason: refresh ? "refresh-no-proxy" : "no-proxy" }
}

/** Compatibility alias — delegates to the unified fetch() entry point */
export async function routedFetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  return fetch(input, init)
}

export const infrastructureHttpClientLayer = HttpClient.layerMergedContext(
  // 这个层是 Effect 世界和 NetworkProxy 世界之间唯一新增的桥：调用方继续依赖
  // HttpClient.HttpClient 以保留测试、录制回放和重试包装能力；真实传输仍必须回到本文件的
  // fetch()。名称中的 infrastructure 固定了预定义 purpose 字符串含义：仅用于 models.dev
  // 这类基础设施元数据请求，避免 provider/npm/plugin 流量误用同一个分类。
  Effect.succeed(
    HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request, { signal }).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
          ),
        )
        return yield* Effect.tryPromise({
          try: () => fetch(web, { purpose: "infrastructure", signal }),
          catch: (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)))
      }),
    ),
  ),
)

/**
 * Primary network fetch entry point.
 *
 * Resolves the proxy route for the given URL, then dispatches to either
 * a direct connection or a proxy-backed connection via Bun's native `proxy:`.
 * The explicit `proxy` parameter ensures Bun routes through the correct proxy
 * regardless of cached environment variables at process startup.
 */
export async function fetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const {
    purpose = "unknown",
    signal,
    proxy: _incomingProxy,
    dispatcher: _incomingDispatcher,
    timeout: _incomingTimeout,
    ...rest
  } = (init ?? {}) as RoutedInit & { proxy?: string; dispatcher?: unknown; timeout?: unknown }
  const route = await resolveProxyRoute(url, purpose, false)

  if (route.type === "direct")
    return directFetch(input, { ...rest, signal })

  return proxyFetch(input, { ...rest, signal }, route.proxy)
}

/**
 * Dispatch a custom fetch function (auth adapter / URL-rewriting wrapper).
 *
 * Provider SDKs may supply their own `fetch` implementation that injects
 * auth headers, rewrites URLs, or transforms request bodies before the
 * actual network request.  The custom fetcher is responsible for calling
 * `NetworkProxy.fetch()` internally for the real outbound hop.
 */
export async function fetchWithRoute(fetchFn: FetchFn, input: FetchInput, init?: RoutedInit): Promise<Response> {
  const {
    purpose = "unknown",
    signal,
    proxy: _incomingProxy,
    dispatcher: _incomingDispatcher,
    timeout: _incomingTimeout,
    ...rest
  } = (init ?? {}) as RoutedInit & { proxy?: string; dispatcher?: unknown; timeout?: unknown }
  return fetchFn(input, { ...rest, signal })
}

/**
 * Send a fetch request through an explicit HTTP/SOCKS proxy.
 * Uses Bun's built-in proxy support via the `proxy` option.
 */
async function proxyFetch(input: FetchInput, init: RequestInit, proxy: string) {
  return nativeFetch(input, { ...init, proxy } as RequestInit & { proxy: string })
}

/**
 * Direct network request without proxy interception.
 * Uses the pre-bound native fetch to avoid recursion when global fetch is overridden.
 */
async function directFetch(input: FetchInput, init: RequestInit) {
  return nativeFetch(input, init)
}

/**
 * Install a routed fetch as the global `fetch` implementation.
 * All subsequent `fetch()` calls in the process will be routed through
 * proxy resolution automatically.
 *
 * Idempotent — subsequent calls are no-ops.
 */
export function installGlobalFetch(defaultPurpose: Purpose = "unknown") {
  if (globalFetchInstalled) return
  globalThis.fetch = ((input: FetchInput, init?: RoutedInit) =>
    fetch(input, { ...init, purpose: init?.purpose ?? defaultPurpose })) as typeof globalThis.fetch
  globalFetchInstalled = true
}

/** Return npm-compatible proxy options for the given registry URL */
export async function npmProxyOptions(registry: string) {
  const route = await resolveProxyRoute(registry, "npm", true)
  if (route.type === "direct") return {}
  return {
    proxy: route.proxy,
    httpsProxy: route.proxy,
    "https-proxy": route.proxy,
  }
}

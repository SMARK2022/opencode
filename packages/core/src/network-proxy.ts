export * as NetworkProxy from "./network-proxy"

export type Purpose = "local" | "provider" | "infrastructure" | "npm" | "plugin" | "unknown"

export type Route = { type: "direct"; reason: string } | { type: "proxy"; proxy: string; reason: string }

const PROXY_TTL = 10_000
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"])

let cache: { expires: number; value: Promise<SystemProxy | undefined> } | undefined
let globalFetchInstalled = false
let savedOriginal: FetchFn | undefined

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

function normalizeProxy(value: string | undefined) {
  if (!value) return
  const next = value.trim()
  if (!next) return
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(next)) return next
  return `http://${next}`
}

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

async function execText(command: string, args: string[], timeout = 1500) {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" })
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

export async function resolveProxyRoute(input: string | URL, purpose: Purpose = "unknown", refresh = false): Promise<Route> {
  const url = input instanceof URL ? input : new URL(input)
  if (purpose === "local" || isLocal(url)) return { type: "direct", reason: "local" }
  const proxy = await configuredProxy(url, refresh)
  if (proxy) return { type: "proxy", proxy, reason: refresh ? "system-refresh" : "system" }
  return { type: "direct", reason: refresh ? "refresh-no-proxy" : "no-proxy" }
}

export async function routedFetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  return fetchWithRoute(fetch, input, init)
}

export async function fetchWithRoute(fetchFn: FetchFn, input: FetchInput, init?: RoutedInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const { purpose = "unknown", signal, proxy: _incomingProxy, ...rest } = (init ?? {}) as RoutedInit & { proxy?: string }
  const route = await resolveProxyRoute(url, purpose, false)
  
  // Bun caches proxy env at startup — explicit `proxy` param overrides it,
  // but plain fetch still honours the cached env.  Setting NO_PROXY=* once
  // disables that cached env so plain fetch goes direct.  The proxy() helper
  // passes an explicit `proxy` param which Bun always respects regardless of
  // NO_PROXY, so this is safe.
  if (!process.env.__OPENCODE_NO_PROXY_SET) {
    process.env.NO_PROXY = "*"
    process.env.__OPENCODE_NO_PROXY_SET = "1"
  }
  
  const fetchDirect = (overrideSignal?: AbortSignal) => 
    fetchFn(input, { ...rest, signal: overrideSignal ?? signal })
  
  const proxy = (value: string) => fetchFn(input, { ...rest, signal, proxy: value })

  if (route.type === "direct") {
    try {
      return await fetchDirect()
    } catch (error) {
      if (signal?.aborted) throw error
      const refreshed = await resolveProxyRoute(url, purpose, true)
      if (refreshed.type === "proxy") return proxy(refreshed.proxy).catch(() => { throw error })
      throw error
    }
  }

  try {
    return await proxy(route.proxy)
  } catch (error) {
    const refreshed = signal?.aborted ? undefined : await resolveProxyRoute(url, purpose, true)
    if (refreshed?.type === "proxy" && refreshed.proxy !== route.proxy) {
      return proxy(refreshed.proxy).catch(() => { throw error })
    }
    if (signal?.aborted)
      return fetchDirect(AbortSignal.timeout(10_000)).catch(() => { throw error })
    return fetchDirect().catch(() => { throw error })
  }
}

export function installGlobalFetch(defaultPurpose: Purpose = "unknown") {
  if (globalFetchInstalled) return
  const original = globalThis.fetch.bind(globalThis) as FetchFn
  savedOriginal = original
  globalThis.fetch = ((input: FetchInput, init?: RoutedInit) =>
    fetchWithRoute(original, input, { ...init, purpose: init?.purpose ?? defaultPurpose })) as typeof fetch
  globalFetchInstalled = true
}

export function originalFetch() {
  return savedOriginal ?? globalThis.fetch.bind(globalThis) as FetchFn
}

export async function npmProxyOptions(registry: string) {
  const route = await resolveProxyRoute(registry, "npm", true)
  if (route.type === "direct") return {}
  return {
    proxy: route.proxy,
    httpsProxy: route.proxy,
    "https-proxy": route.proxy,
  }
}

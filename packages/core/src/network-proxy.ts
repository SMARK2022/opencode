export * as NetworkProxy from "./network-proxy"

// 本地 RPC 与远程 provider/安装请求必须分流，避免代理拦截 daemon 自己的健康通道。
export type Purpose = "local" | "provider" | "infrastructure" | "npm" | "plugin" | "unknown"

export type Route = { type: "direct"; reason: string } | { type: "proxy"; proxy: string; reason: string }

const TTL = 120_000
// URL 会将 mapped IPv4 规范为十六进制 IPv6，两种表示都必须保持回环直连。
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])

// 共享探测 Promise 防止并发请求各自拉起 reg/scutil 子进程。
let cache: { expires: number; value: Promise<SystemProxy | undefined> } | undefined

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
  // 合并而非覆盖用户 bypass，默认回环仍始终保留。
  return Array.from(new Set([...LOCAL, ...extra])).join(",")
}

// URL 的 IPv6 hostname 带方括号，匹配前去掉括号以复用同一回环集合。
function normalizeHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

// 只按显式回环名称判断，代理选择不触发 DNS 或把私网主机误当 daemon。
function isLocal(url: URL) {
  return LOCAL.has(normalizeHost(url.hostname))
}

// 裸 host:port 补 HTTP；已有协议包括 SOCKS 必须保留，不能改变用户代理类型。
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
    // 系统 <local> 表示无点主机名，与项目的回环直连规则不同。
    if (item === "<local>" && !host.includes(".")) return true
    if (item === host) return true
    if (item.startsWith("*.") && host.endsWith(item.slice(1))) return true
    if (item.includes("*")) {
      // bypass 中只有星号是通配符，其余正则字符按主机文字匹配，且匹配整个 hostname。
      const escaped = item.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
      if (new RegExp(`^${escaped}$`).test(host)) return true
    }
  }
  return false
}

function envProxy(url: URL): SystemProxy | undefined {
  // HTTPS 可继承 HTTP，ALL_PROXY 只在该协议没有显式配置时参与选择。
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
  // 系统代理探测有独立短期限，系统命令卡住不能占满每次 HTTP 请求的预算。
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => proc.kill(), timeout)
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    // 非零退出的部分输出不能被当成可信系统配置。
    if (code !== 0) return ""
    return stdout
  } catch {
    return ""
  } finally {
    // 成功和失败都撤销 kill timer，避免探测已结束后仍由定时器保持进程存活。
    clearTimeout(timer)
  }
}

function parseWindowsProxyServer(value: string, protocol: string) {
  // 注册表既支持单代理也支持分协议列表，不能把列表原文直接交给 fetch。
  if (!value.includes("=")) return normalizeProxy(value)
  const entries = Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((part): part is [string, string] => part.length === 2 && !!part[0] && !!part[1])
      .map(([key, val]) => [key.toLowerCase(), val]),
  )
  // 当前协议优先，其余条目维持源实现的候选次序。
  return normalizeProxy(entries[protocol.replace(":", "")] || entries.http || entries.https || entries.socks)
}

async function windowsProxy(): Promise<SystemProxy | undefined> {
  // 读取当前用户的 Internet Settings，而非全机 WinHTTP 配置，跟随桌面代理工具的切换。
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
  // ProxyServer 留存旧值很常见，只有启用位为真时才参与路由。
  const http = enabled && server ? parseWindowsProxyServer(server, "http:") : undefined
  // 分协议条目分别保存，不能把 HTTPS 代理端口当作 HTTP 的系统配置。
  const https = enabled && server ? parseWindowsProxyServer(server, "https:") : undefined
  return { http, https, bypass: bypassList }
}

async function macProxy(): Promise<SystemProxy | undefined> {
  // scutil 暴露当前生效网络服务的代理，避免从 shell env 推断桌面系统设置。
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
  // 分协议启用位各自生效；缺 HTTPS 代理仍可由后续路由选择 HTTP 或 SOCKS。
  return { http, https, socks, bypass: [] }
}

async function currentSystemProxy() {
  // Linux 的代理来源是 env，不能为它执行 Windows/macOS 系统探测。
  if (process.platform !== "win32" && process.platform !== "darwin") return undefined
  if (!cache || cache.expires < Date.now()) {
    // 探测失败也缓存本轮结果，避免短时系统错误让每个请求重复 spawn。
    cache = {
      expires: Date.now() + TTL,
      value: (process.platform === "win32" ? windowsProxy() : macProxy()).catch(() => undefined),
    }
  }
  return cache.value
}

async function configuredProxy(url: URL) {
  // 桌面平台以系统设置为准，shell 的旧代理不应覆盖代理工具当前的开关。
  if (process.platform === "win32" || process.platform === "darwin") {
    const sys = await currentSystemProxy()
    // 系统 bypass 与代理必须来自同一次快照，防止混用切换前后的规则。
    if (!sys || bypass(url, sys.bypass)) return
    return url.protocol === "https:" ? sys.https || sys.http || sys.socks : sys.http || sys.https || sys.socks
  }
  const env = envProxy(url)
  if (!env || bypass(url, env.bypass)) return
  return url.protocol === "https:" ? env.https || env.http || env.socks : env.http || env.https || env.socks
}

// 回环在系统探测之前直连，健康检查不承担探测耗时或受外部 bypass 配置影响。
export async function resolveProxyRoute(input: string | URL, purpose: Purpose = "unknown"): Promise<Route> {
  const url = input instanceof URL ? input : new URL(input)
  if (purpose === "local" || isLocal(url)) return { type: "direct", reason: "local" }
  const proxy = await configuredProxy(url)
  if (proxy) return { type: "proxy", proxy, reason: "system" }
  return { type: "direct", reason: "no-proxy" }
}

// 明确 routed 入口可用于 CLI/测试，不能要求调用方先安装全局 fetch 才能应用代理。
export async function routedFetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  return fetchWithRoute(fetch, input, init)
}

// provider 的自定义 fetch 可能负责鉴权，必须在原 transport 上加路由而非换成裸 fetch。
export async function fetchWithRoute(fetchFn: FetchFn, input: FetchInput, init?: RoutedInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const { purpose = "unknown", ...rest } = (init ?? {}) as RoutedInit
  const route = await resolveProxyRoute(url, purpose)
  // 无代理时保持一次原请求，不为普通直连失败引入第二次 provider 调用。
  if (route.type === "direct") return fetchFn(input, rest)
  try {
    return await fetchFn(input, { ...rest, proxy: route.proxy })
  } catch (error) {
    // 代理不可用可尝试原直连，但两路都失败时保留最初代理错误以便诊断。
    return fetchFn(input, rest).catch(() => {
      throw error
    })
  }
}

export async function npmProxyOptions(registry: string) {
  // registry 与安装请求共用用途，避免 ping 走代理而 Arborist 下载仍走旧 shell 路径。
  const route = await resolveProxyRoute(registry, "npm")
  if (route.type === "direct") return {}
  return {
    // npm config 的扁平与连字符字段都需运输，不能只给原生 fetch 的 proxy 键。
    proxy: route.proxy,
    httpsProxy: route.proxy,
    "https-proxy": route.proxy,
  }
}

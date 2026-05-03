export * as NetworkProxy from "./network-proxy"

// 本地 RPC 与远程 provider/安装请求必须分流，避免代理拦截 daemon 自己的健康通道。
export type Purpose = "local" | "provider" | "infrastructure" | "npm" | "plugin" | "unknown"

export type Route = { type: "direct"; reason: string } | { type: "proxy"; proxy: string; reason: string }

// 系统代理缓存缩至十五秒，代理应用重启后不长期沿用失效端口。
const TTL = 15_000
// URL 会将 mapped IPv4 规范为十六进制 IPv6，两种表示都必须保持回环直连。
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])

// 共享探测 Promise 防止并发请求各自拉起 reg/scutil 子进程。
let cache: { expires: number; value: Promise<SystemProxy | undefined> } | undefined
// 记录本模块包装函数的身份，后来替换的全局自定义 fetch 不能被误解包。
let globalFetchInstalled: FetchFn | undefined
// 显式路由复用安装前的运输函数，不能再次进入全局代理包装。
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

// 失败后的刷新必须绕过缓存，否则会再次选择同一失效代理。
async function currentSystemProxy(refresh = false) {
  // Linux 的代理来源是 env，不能为它执行 Windows/macOS 系统探测。
  if (process.platform !== "win32" && process.platform !== "darwin") return undefined
  if (refresh) cache = undefined
  if (!cache || cache.expires < Date.now()) {
    // 探测失败也缓存本轮结果，避免短时系统错误让每个请求重复 spawn。
    cache = {
      expires: Date.now() + TTL,
      value: (process.platform === "win32" ? windowsProxy() : macProxy()).catch(() => undefined),
    }
  }
  return cache.value
}

async function configuredProxy(url: URL, refresh = false) {
  // 桌面平台以系统设置为准，shell 的旧代理不应覆盖代理工具当前的开关。
  if (process.platform === "win32" || process.platform === "darwin") {
    const sys = await currentSystemProxy(refresh)
    // 系统代理与其 bypass 保持同一快照，叠加用户 NO_PROXY 以对齐实际运输。
    if (!sys || bypass(url, [...sys.bypass, ...(process.env.NO_PROXY || process.env.no_proxy || "").split(",")])) return
    return url.protocol === "https:" ? sys.https || sys.http || sys.socks : sys.http || sys.https || sys.socks
  }
  const env = envProxy(url)
  if (!env || bypass(url, env.bypass)) return
  return url.protocol === "https:" ? env.https || env.http || env.socks : env.http || env.https || env.socks
}

// 回环在系统探测之前直连，健康检查不承担探测耗时或受外部 bypass 配置影响。
export async function resolveProxyRoute(input: string | URL, purpose: Purpose = "unknown", refresh = false): Promise<Route> {
  const url = input instanceof URL ? input : new URL(input)
  if (purpose === "local" || isLocal(url)) return { type: "direct", reason: "local" }
  const proxy = await configuredProxy(url, refresh)
  if (proxy) return { type: "proxy", proxy, reason: refresh ? "system-refresh" : "system" }
  return { type: "direct", reason: refresh ? "refresh-no-proxy" : "no-proxy" }
}

// 明确 routed 入口可用于 CLI/测试，不能要求调用方先安装全局 fetch 才能应用代理。
export async function routedFetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  return fetchWithRoute(fetch, input, init)
}

// provider 的自定义 fetch 可能负责鉴权，必须在原 transport 上加路由而非换成裸 fetch。
export async function fetchWithRoute(fetchFn: FetchFn, input: FetchInput, init?: RoutedInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  // 只解开本模块安装的全局入口；调用方传入的自定义 fetch 保持原运输职责。
  const original = savedOriginal && fetchFn === globalFetchInstalled ? savedOriginal : fetchFn
  // Request 自带取消信号也须参与失败判断，显式 init.signal 仍优先。
  const { purpose = "unknown", signal = input instanceof Request ? input.signal : undefined, ...rest } = (init ?? {}) as RoutedInit
  // 提供者与安装请求首次刷新，避免仍在 TTL 内的旧代理拖延交互。
  const route = await resolveProxyRoute(url, purpose, purpose === "provider" || purpose === "npm")
  // 路由探测期间也可能取消；开始网络运输前须结算同一个信号。
  signal?.throwIfAborted()
  // 恢复运输仍沿原取消信号，不能通过改写用户代理环境制造直连。
  const direct = () => original(input, { ...rest, signal })
  const proxy = (value: string) => original(input, { ...rest, signal, proxy: value })

  // 无代理失败只允许重新发现新代理，不能再次发送相同直连请求。
  if (route.type === "direct") {
    try {
      return await direct()
    } catch (error) {
      // 取消是请求终点，保留首次错误对象，不能转成代理重发。
      if (signal?.aborted) throw error
      const refreshed = await resolveProxyRoute(url, purpose, true)
      // 刷新等待期间的取消同样禁止第二次运输。
      if (signal?.aborted) throw error
      if (refreshed.type === "proxy") return proxy(refreshed.proxy).catch(() => { throw error })
      throw error
    }
  }

  try {
    return await proxy(route.proxy)
  } catch (error) {
    // 代理不可用可尝试原直连，但两路都失败时保留最初代理错误以便诊断。
    // provider 的组合信号包含调用方取消与超时，不能去掉信号或换一个窗口。
    if (signal?.aborted) throw error
    const refreshed = await resolveProxyRoute(url, purpose, true)
    // 取消可能发生在系统代理探测中，继续回退前须再次检查。
    if (signal?.aborted) throw error
    if (refreshed.type === "proxy" && refreshed.proxy !== route.proxy) {
      return proxy(refreshed.proxy).catch(() => { throw error })
    }
    // 环境代理仍未变化时，裸 fetch 会重进同一代理；终止恢复并保留首次错误。
    if (process.platform !== "win32" && process.platform !== "darwin" && refreshed.type === "proxy") throw error
    return direct().catch(() => { throw error })
  }
}

// 插件直接使用全局 fetch 时也共享路由；显式用途不得被默认用途覆盖。
export function installGlobalFetch(defaultPurpose: Purpose = "unknown") {
  if (globalFetchInstalled) return
  const original = globalThis.fetch.bind(globalThis) as FetchFn
  savedOriginal = original
  globalFetchInstalled = (input: FetchInput, init?: RoutedInit) =>
    fetchWithRoute(original, input, { ...init, purpose: init?.purpose ?? defaultPurpose })
  // 局部 Fetch 适配复用 Bun 的 preconnect，安装全局包装不能丢掉这个运输成员。
  globalThis.fetch = Object.assign(globalFetchInstalled, { preconnect: globalThis.fetch.preconnect })
}

export async function npmProxyOptions(registry: string) {
  // registry 与安装请求共用用途，避免 ping 走代理而 Arborist 下载仍走旧 shell 路径。
  // npm 子进程不共享 fetch 包装，每次安装前须读取当前代理设置。
  const route = await resolveProxyRoute(registry, "npm", true)
  if (route.type === "direct") return {}
  return {
    // npm config 的扁平与连字符字段都需运输，不能只给原生 fetch 的 proxy 键。
    proxy: route.proxy,
    httpsProxy: route.proxy,
    "https-proxy": route.proxy,
  }
}

export * as NetworkProxy from "./network-proxy"

import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

// 本地 RPC 与远程 provider/安装请求必须分流，避免代理拦截 daemon 自己的健康通道。
export type Purpose = "local" | "provider" | "infrastructure" | "npm" | "plugin" | "unknown"

export type Route = { type: "direct"; reason: string } | { type: "proxy"; proxy: string; reason: string }

// 十秒只控制代理探测缓存的新鲜度，不能当作取消后重开请求的期限。
const PROXY_TTL = 10_000
// URL 会将 mapped IPv4 规范为十六进制 IPv6，两种表示都必须保持回环直连。
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])

// 共享探测 Promise 防止并发请求各自拉起 reg/scutil 子进程。
let cache: { expires: number; value: Promise<SystemProxy | undefined> } | undefined
// 全局包装只安装一次，重复调用保持同一入口。
let globalFetchInstalled: FetchFn | undefined
// 模块加载时绑定原生 fetch，统一入口不能再次进入全局代理包装。
const nativeFetch = globalThis.fetch.bind(globalThis) as FetchFn

type SystemProxy = {
  http?: string
  https?: string
  socks?: string
  bypass: string[]
}

// timeout属于调用方运输合同；路由选择不应剥离显式false或数字上限。
type RoutedInit = RequestInit & { purpose?: Purpose; timeout?: false | number }
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
  // localhost 代理归一到 IPv4，避免解析到不同的回环地址。
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(next) ? next : `http://${next}`
  try {
    const url = new URL(normalized)
    if (normalizeHost(url.hostname) === "localhost") url.hostname = "127.0.0.1"
    return url.toString()
  } catch {
    return normalized
  }
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
  // Windows 系统代理读取会定期调用 reg.exe；必须隐藏 helper 控制台，否则 daemon 每次刷新代理都会弹出 conhost。
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: process.platform === "win32",
  })
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
  const https =
    values.get("HTTPSEnable") === "1"
      ? normalizeProxy(`${values.get("HTTPSProxy")}:${values.get("HTTPSPort")}`)
      : undefined
  const http =
    values.get("HTTPEnable") === "1"
      ? normalizeProxy(`${values.get("HTTPProxy")}:${values.get("HTTPPort")}`)
      : undefined
  const socks =
    values.get("SOCKSEnable") === "1"
      ? normalizeProxy(`socks5://${values.get("SOCKSProxy")}:${values.get("SOCKSPort")}`)
      : undefined
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
      expires: Date.now() + PROXY_TTL,
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
export async function resolveProxyRoute(
  input: string | URL,
  purpose: Purpose = "unknown",
  refresh = false,
): Promise<Route> {
  const url = input instanceof URL ? input : new URL(input)
  if (purpose === "local" || isLocal(url)) return { type: "direct", reason: "local" }
  const proxy = await configuredProxy(url, refresh)
  if (proxy) return { type: "proxy", proxy, reason: refresh ? "system-refresh" : "system" }
  return { type: "direct", reason: refresh ? "refresh-no-proxy" : "no-proxy" }
}

// 明确 routed 入口可用于 CLI/测试，不能要求调用方先安装全局 fetch 才能应用代理。
export async function routedFetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  return fetch(input, init)
}

// #268：Effect HttpClient 与 NetworkProxy 之间的桥——调用方依赖 HttpClient，真实传输回到 NetworkProxy fetch
// #268：infrastructure 固定 purpose，仅用于 models.dev 等基础设施元数据请求
export const infrastructureHttpClientLayer = HttpClient.layerMergedContext(
  Effect.succeed(
    HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request, { signal }).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
                // #268：错误统一映射 TransportError——消费方拿到的是 Effect HttpClient 错误契约而非裸 fetch 异常
              }),
          ),
        )
        return yield* Effect.tryPromise({
          try: () => fetch(web, { purpose: "infrastructure", signal }),
          // #268：signal 由 HttpClient 调用方传入——外层超时的中断经此传播到传输层
          catch: (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)))
      }),
    ),
  ),
)

// 统一入口在当前路由上发送一次，请求失败直接交给调用方处理。
export async function fetch(input: FetchInput, init?: RoutedInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  // Request 自带取消信号继续参与运输，显式 init.signal 仍优先。
  // 路由独占代理选择，调用方的显式代理不能泄漏到直连请求。
  const {
    purpose = "unknown",
    signal = input instanceof Request ? input.signal : undefined,
    proxy: _incomingProxy,
    dispatcher: _incomingDispatcher,
    ...rest
  } = (init ?? {}) as RoutedInit & { proxy?: BunFetchRequestInit["proxy"]; dispatcher?: unknown }
  const route = await resolveProxyRoute(url, purpose, false)
  // 路由探测期间也可能取消；开始网络运输前须结算同一个信号。
  signal?.throwIfAborted()
  return nativeFetch(input, route.type === "proxy" ? { ...rest, signal, proxy: route.proxy } : { ...rest, signal })
}

// 鉴权和 URL 改写由自定义适配器保留，实际出站由适配器调用统一入口。
export async function fetchWithRoute(fetchFn: FetchFn, input: FetchInput, init?: RoutedInit): Promise<Response> {
  const {
    purpose = "unknown",
    signal = input instanceof Request ? input.signal : undefined,
    proxy: _incomingProxy,
    dispatcher: _incomingDispatcher,
    ...rest
  } = (init ?? {}) as RoutedInit & { proxy?: BunFetchRequestInit["proxy"]; dispatcher?: unknown }
  signal?.throwIfAborted()
  return fetchFn(input, { ...rest, signal })
}

// 插件直接使用全局 fetch 时也共享路由；显式用途不得被默认用途覆盖。
export function installGlobalFetch(defaultPurpose: Purpose = "unknown") {
  if (globalFetchInstalled) return
  globalFetchInstalled = (input: FetchInput, init?: RoutedInit) =>
    fetch(input, { ...init, purpose: init?.purpose ?? defaultPurpose })
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

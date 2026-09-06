import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { ConfigParse } from "@/config/parse"
import { isRecord } from "@/util/record"
import { Process } from "@/util/process"
// type-only：voice-auth 需要 direct 变体形状，但不引入 prompt-voice-input 的运行时依赖，避免循环。
import type { VoiceTranscriberDirect } from "../prompt-voice-input"

export type VoiceAuthCookies = Record<string, { value: string; expires: number }>

// auth 节点与 opencode.json 中的 JSON 形状一一对应（snake_case），避免内存态与落盘态出现两套字段名。
export type VoiceAuth = {
  access_token: string
  token_expires_at: number
  fetched_at: string
  cookies: VoiceAuthCookies
}

// token margin 6h：EchoPaper 生产实证值；cookie margin 48h：用户"还有一两天即收割"语义。
export const VOICE_TOKEN_MARGIN_S = 6 * 3_600
export const VOICE_COOKIE_HARVEST_MARGIN_S = 48 * 3_600
// 收割预算必须覆盖 daemon 冷启动+登录等待（CHATGPT_DAEMON_START_TIMEOUT 派生）；刷新/直连是纯 HTTP 短路径。
export const VOICE_HARVEST_TIMEOUT_MS = 240_000
export const VOICE_REFRESH_TIMEOUT_MS = 60_000
export const VOICE_DIRECT_TIMEOUT_MS = 30_000

export const VOICE_SESSION_URL = "https://chatgpt.com/api/auth/session"
// 与 agent 页面路径同一私有端点（chatgpt-dom.js:796）；请求形态变化时两处必须同源更新。
export const VOICE_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe"
// 刷新授权链只由 NextAuth 会话令牌族承载；其它 cookie（如 __cf_bm）无授权语义，不参与状态机门控。
const SESSION_COOKIE_PREFIX = "__Secure-next-auth.session-token"

// jsonc modify 的格式化选项只作用于新生成的 auth 节点；文件其余部分的缩进由 applyEdits 原样保留。
const formatting: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

export async function readVoiceAuth(config: string, key: string): Promise<VoiceAuth | undefined> {
  let text: string
  try {
    text = await fs.readFile(config, "utf8")
  } catch {
    return undefined
  }
  let data: unknown
  try {
    data = ConfigParse.jsonc(text, config)
  } catch {
    // 用户配置解析失败已由 TuiConfig 负责告警；凭据读取侧只需降级为"无凭据"，不阻断语音主路径。
    return undefined
  }
  if (!isRecord(data) || !isRecord(data.mcp) || !isRecord(data.mcp[key])) return undefined
  return parseVoiceAuth(data.mcp[key].auth)
}

function parseVoiceAuth(input: unknown): VoiceAuth | undefined {
  if (!isRecord(input) || typeof input.access_token !== "string" || !input.access_token) return undefined
  if (typeof input.token_expires_at !== "number" || typeof input.fetched_at !== "string") return undefined
  if (!isRecord(input.cookies)) return undefined
  const cookies: VoiceAuthCookies = {}
  for (const [name, cookie] of Object.entries(input.cookies)) {
    // 半写或手改过的 cookie 条目直接丢弃整个节点：状态机宁可重新收割也不消费残缺凭据。
    if (!isRecord(cookie) || typeof cookie.value !== "string" || typeof cookie.expires !== "number") return undefined
    cookies[name] = { value: cookie.value, expires: cookie.expires }
  }
  return { access_token: input.access_token, token_expires_at: input.token_expires_at, fetched_at: input.fetched_at, cookies }
}

export async function writeVoiceAuth(config: string, key: string, auth: VoiceAuth): Promise<void> {
  const text = await fs.readFile(config, "utf8")
  // 定点替换 mcp.<key>.auth：与 `opencode mcp add` 写 mcp.<name> 相同的注释保真机制；
  // 注意 mcp add 会整体替换 mcp.<name> 并移除 auth 子节点，那是用户主动重注册语义，这里不做防御。
  const edits = modify(text, ["mcp", key, "auth"], auth, { formattingOptions: formatting })
  const next = applyEdits(text, edits)
  // 临时文件名含 PID+时间戳：两个 opencode 实例同时收割不会写同一个 tmp 互相覆盖。
  const temp = `${config}.tmp-${process.pid}-${Date.now()}`
  await Bun.write(temp, next)
  try {
    await fs.rename(temp, config)
  } catch (error) {
    // rename 冲突（AV/索引器锁，EPERM 族）时不删除用户配置：另一 opencode 实例可能已并发完成同 token 写入，
    // 目标 auth 节点等价则视为成功（prompt-voice-recorder sameFileContent 的同款复用语义）；
    // 其余冲突原样上抛，由 persistCredential 降级为内存态 + 一次性提示。
    const current = await readVoiceAuth(config, key).catch(() => undefined)
    if (current && current.access_token === auth.access_token) return
    throw error
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

export * as VoiceAuth from "./voice-auth"

export type VoiceAuthRuntime = {
  // GET /api/auth/session：成功返回更新后的凭据；失败返回 undefined（状态机继续收割）。
  fetchSession: (auth: VoiceAuth, signal: AbortSignal) => Promise<VoiceAuth | undefined>
  // spawn [interpreter, script, "auth-export", "--json"]：agent CLI 自带 daemon 冷启动与重试。
  harvest: (direct: VoiceTranscriberDirect, signal: AbortSignal) => Promise<VoiceAuth>
  // 直连 POST /backend-api/transcribe；401 由 transcribeDirect 的编排重试消费。
  directFetch: (file: string, auth: VoiceAuth, signal: AbortSignal) => Promise<Response>
  now: () => number
}

// JWT exp 本地解析只为调度刷新；签名真伪仍由服务端裁决（与 EchoPaper 同源实践）。
export function jwtExpiresAt(token: string): number {
  const payload = token.split(".")[1]
  if (!payload) return 0
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return isRecord(decoded) && typeof decoded.exp === "number" ? decoded.exp : 0
  } catch {
    return 0
  }
}

// 会话刷新可能轮换 cookie；只合并响应显式下发的条目，无 Expires 属性视为会话 cookie（expires=0）。
export function mergeSetCookieCookies(cookies: VoiceAuthCookies, setCookies: string[]): VoiceAuthCookies {
  const merged: VoiceAuthCookies = { ...cookies }
  for (const raw of setCookies) {
    const [pair, ...attributes] = raw.split(";")
    const separator = pair.indexOf("=")
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const expiresAttribute = attributes.find((attribute) => attribute.trim().toLowerCase().startsWith("expires="))
    const expiresAt = expiresAttribute ? Date.parse(expiresAttribute.split("=").slice(1).join("=").trim()) : NaN
    merged[name] = { value: pair.slice(separator + 1).trim(), expires: Number.isNaN(expiresAt) ? 0 : expiresAt / 1000 }
  }
  return merged
}

// agent auth-export 的 stdout JSON → auth 节点；CDP 会话 cookie expires=-1 归一为 0。
export function authFromHarvest(payload: unknown): VoiceAuth {
  // 先绑局部再判定：tsgo 不会从复合 throw 守卫中收窄索引属性。
  const accessToken = isRecord(payload) && typeof payload.accessToken === "string" ? payload.accessToken : undefined
  const authStatus = isRecord(payload) && payload.authStatus === "logged_in" ? payload.authStatus : undefined
  const fetchedAt = isRecord(payload) && typeof payload.fetchedAt === "string" ? payload.fetchedAt : undefined
  if (!accessToken || authStatus !== "logged_in") {
    throw new Error("ChatGPT auth export did not return a logged-in session")
  }
  const cookies: VoiceAuthCookies = {}
  // cookies 字段缺失/非数组时保留空 jar：授权链只由 token+会话凭据后续收割补齐，不因形状拒绝可用导出。
  if (isRecord(payload) && Array.isArray(payload.cookies)) {
    for (const cookie of payload.cookies) {
      if (!isRecord(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string") continue
      const expires = typeof cookie.expires === "number" && cookie.expires > 0 ? cookie.expires : 0
      cookies[cookie.name] = { value: cookie.value, expires }
    }
  }
  return {
    access_token: accessToken,
    token_expires_at: jwtExpiresAt(accessToken),
    fetched_at: fetchedAt ?? new Date().toISOString(),
    cookies,
  }
}

export function buildSessionRequest(auth: VoiceAuth): { input: string; init: RequestInit & { purpose: "provider" } } {
  return {
    input: VOICE_SESSION_URL,
    init: {
      method: "GET",
      headers: {
        accept: "*/*",
        // 刷新只依赖 cookie 头（EchoPaper 同形态）；Bearer 对 session 端点无意义。
        cookie: Object.entries(auth.cookies)
          .map(([name, cookie]) => `${name}=${cookie.value}`)
          .join("; "),
        referer: "https://chatgpt.com/",
      },
      purpose: "provider",
    },
  }
}

export function buildDirectTranscribeRequest(input: { file: string; bytes: BlobPart; auth: VoiceAuth }): { input: string; init: RequestInit & { purpose: "provider" } } {
  // 直连请求形态是页面路径与 EchoPaper 双证源的合成：multipart 仅 file 字段 + Bearer + oai-device-id + oai-language。
  const form = new FormData()
  form.append("file", new File([input.bytes], path.basename(input.file), { type: "audio/wav" }))
  const deviceId = input.auth.cookies["oai-did"]?.value
  return {
    input: VOICE_TRANSCRIBE_URL,
    init: {
      method: "POST",
      body: form,
      headers: {
        authorization: `Bearer ${input.auth.access_token}`,
        ...(deviceId ? { "oai-device-id": deviceId } : {}),
        "oai-language": "en-US",
      },
      purpose: "provider",
    },
  }
}

async function defaultFetchSession(auth: VoiceAuth, signal: AbortSignal): Promise<VoiceAuth | undefined> {
  const request = buildSessionRequest(auth)
  const response = await NetworkProxy.fetch(request.input, {
    ...request.init,
    // 外部取消与刷新预算合成同一 signal：用户取消立即中断刷新，不等 60s 超时自然到期。
    signal: AbortSignal.any([signal, AbortSignal.timeout(VOICE_REFRESH_TIMEOUT_MS)]),
  })
  if (!response.ok) return undefined
  // 只提取 accessToken 字符串本身，避免把 unknown 结构带进凭据对象。
  const accessToken = await response.json().then((value) => { if (isRecord(value) && typeof value.accessToken === "string") return value.accessToken; return undefined }).catch(() => undefined)
  if (!accessToken) return undefined
  return {
    ...auth,
    access_token: accessToken,
    token_expires_at: jwtExpiresAt(accessToken),
    fetched_at: new Date().toISOString(),
    cookies: mergeSetCookieCookies(auth.cookies, response.headers.getSetCookie()),
  }
}

async function defaultHarvest(direct: VoiceTranscriberDirect, signal: AbortSignal): Promise<VoiceAuth> {
  // argv 只有 --json，凭据只经 stdout 返回；killTree:false 保持 daemon/browser 独立生命周期（同 transcribe-file 约定）。
  // timeout:1_000 是 abort 后的 SIGKILL 升级延迟；总预算由 240s AbortSignal 承担。
  const result = await Process.run([direct.interpreter, direct.script, "auth-export", "--json"], {
    abort: AbortSignal.any([signal, AbortSignal.timeout(VOICE_HARVEST_TIMEOUT_MS)]),
    killTree: false,
    nothrow: true,
    timeout: 1_000,
  })
  if (result.code !== 0) throw new Error(result.stderr.toString().trim() || `auth-export exited with code ${result.code}`)
  // stdout 非合法 JSON 时给出确定性错误：SyntaxError 的 message 会携带 stdout 片段，不得进入用户可见 toast（INV-05）。
  let payload: unknown
  try {
    payload = JSON.parse(result.stdout.toString())
  } catch {
    throw new Error("auth-export did not return JSON")
  }
  return authFromHarvest(payload)
}

const defaultRuntime: VoiceAuthRuntime = {
  fetchSession: defaultFetchSession,
  harvest: defaultHarvest,
  directFetch: async (file, auth, signal) => {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    const request = buildDirectTranscribeRequest({ file, bytes, auth })
    return NetworkProxy.fetch(request.input, {
      ...request.init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(VOICE_DIRECT_TIMEOUT_MS)]),
    })
  },
  now: () => Date.now(),
}

// project 来源凭据与写回失败降级凭据的进程内存驻留；键与 in-flight 共用，保证同键并发去重。
const memoryAuth = new Map<string, VoiceAuth>()
const ensureInflight = new Map<string, Promise<VoiceAuth>>()
const authNotices = new Set<string>()

export function takeVoiceAuthNotice(): string | undefined {
  const first = [...authNotices][0]
  if (first !== undefined) authNotices.delete(first)
  return first
}

const PROJECT_SCOPE_NOTICE = "语音凭据仅写入用户级配置（auth 节点不落 project 配置以避免随 git 泄漏）；如需持久化请把 ChatGPT MCP 条目移至全局 opencode.json"
const WRITE_FAILURE_NOTICE = "语音凭据写回失败，已在本进程内继续使用；下次启动会重新收割"

async function persistCredential(direct: VoiceTranscriberDirect, auth: VoiceAuth, cacheKey: string) {
  if (direct.scope === "project") {
    // project 配置受版本管理：凭据只驻内存，本进程后续请求零收割，重启后重新收割。
    authNotices.add(PROJECT_SCOPE_NOTICE)
    memoryAuth.set(cacheKey, auth)
    return
  }
  try {
    await writeVoiceAuth(direct.config, direct.key, auth)
  } catch {
    authNotices.add(WRITE_FAILURE_NOTICE)
    memoryAuth.set(cacheKey, auth)
  }
}

function tokenAlive(auth: VoiceAuth, now: number) {
  // margin 内的 token 视为已死：避免"刚好有效"的凭据在请求途中过期，把可预测的刷新变成 401 回退。
  return auth.access_token !== "" && auth.token_expires_at - VOICE_TOKEN_MARGIN_S > now / 1000
}

function sessionCredentialUsable(auth: VoiceAuth, now: number) {
  // 谓词只看会话凭据族：缺失视为已死（刷新必然 401，fail-safe 走收割）。
  // 分块变体（.0/.1）各有自己的 expires：族内取最早过期作为会话凭据的整体寿命。
  let earliest: number | undefined
  for (const [name, cookie] of Object.entries(auth.cookies)) {
    if (!name.startsWith(SESSION_COOKIE_PREFIX)) continue
    if (cookie.expires <= 0) return true
    earliest = earliest === undefined ? cookie.expires : Math.min(earliest, cookie.expires)
  }
  // 死亡或临近死亡（48h）都不可刷新——临期会话凭据撑不起新 token 的完整生命周期。
  return earliest !== undefined && earliest > now / 1000 + VOICE_COOKIE_HARVEST_MARGIN_S
}

export async function ensureVoiceCredential(
  direct: VoiceTranscriberDirect,
  options: { forceRefresh?: boolean; runtime?: Partial<VoiceAuthRuntime>; signal?: AbortSignal } = {},
): Promise<VoiceAuth> {
  const runtime: VoiceAuthRuntime = { ...defaultRuntime, ...options.runtime }
  const signal = options.signal ?? new AbortController().signal
  const cacheKey = `${direct.config}|${direct.key}`
  // 同键并发 ensure 合并到同一 in-flight：三个 Prompt 实例同时按 Alt+V 只允许一次收割 spawn。
  const existing = ensureInflight.get(cacheKey)
  if (existing) return existing
  const operation = (async () => {
    const now = runtime.now()
    // user 来源以磁盘为准（其它 opencode 实例可能已写回更新）；project 来源只看内存。
    const cached = direct.scope === "project" ? memoryAuth.get(cacheKey) : ((await readVoiceAuth(direct.config, direct.key)) ?? memoryAuth.get(cacheKey))
    if (!options.forceRefresh && cached && tokenAlive(cached, now)) return cached
    if (cached && sessionCredentialUsable(cached, now)) {
      const refreshed = await runtime.fetchSession(cached, signal)
      if (refreshed) {
        await persistCredential(direct, refreshed, cacheKey)
        return refreshed
      }
    }
    const harvested = await runtime.harvest(direct, signal)
    await persistCredential(direct, harvested, cacheKey)
    return harvested
  })()
  ensureInflight.set(cacheKey, operation)
  try {
    return await operation
  } finally {
    ensureInflight.delete(cacheKey)
  }
}

export async function transcribeDirect(
  file: string,
  direct: VoiceTranscriberDirect,
  options: { runtime?: Partial<VoiceAuthRuntime>; signal?: AbortSignal } = {},
): Promise<string> {
  const runtime: VoiceAuthRuntime = { ...defaultRuntime, ...options.runtime }
  const signal = options.signal ?? new AbortController().signal
  let auth = await ensureVoiceCredential(direct, { runtime, signal })
  let response = await runtime.directFetch(file, auth, signal)
  if (response.status === 401) {
    // 401 表示 token 失效：强制跳过缓存判定重走刷新/收割后重试一次；两次失败交给上层 argv 回退。
    auth = await ensureVoiceCredential(direct, { forceRefresh: true, runtime, signal })
    response = await runtime.directFetch(file, auth, signal)
  }
  if (!response.ok) throw new Error(`ChatGPT direct transcribe returned HTTP ${response.status}`)
  // 只提取 text 字符串本身；200+空串是端点对静音的合法结果（页面路径同合同），由 controller 的 trim 分支自然吞空。
  const text = await response
    .json()
    .then((value) => { if (isRecord(value) && typeof value.text === "string") return value.text; return undefined })
    .catch(() => undefined)
  if (text === undefined) throw new Error("ChatGPT direct transcribe returned invalid response")
  return text
}

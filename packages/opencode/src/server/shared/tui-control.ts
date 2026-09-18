import { AsyncQueue } from "@/util/queue"
import { Schema } from "effect"
import { Flock } from "@opencode-ai/core/util/flock"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser"
import { ConfigParse } from "@/config/parse"
import { isRecord } from "@/util/record"
import { Process } from "@/util/process"
import { ConfigVariable } from "@/config/variable"
import { ConfigPaths } from "@/config/paths"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { which } from "@/util/which"

// 目标连同配置来源与运行环境一起传递，Cookie 写回与 profile 读取始终对应同一个 MCP。
export type VoiceTarget = { config: string; key: string; interpreter: string; script: string; environment: Record<string, string> }
export type VoiceAuthCookies = Record<string, { value: string; expires: number }>
export type VoiceAuth = { cookies: VoiceAuthCookies; fetched_at: string; access_token?: string }
export const VOICE_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe"

// jsonc modify 的格式化选项只作用于新生成的 auth 节点；文件其余部分的缩进由 applyEdits 原样保留。
const formatting: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

export const TuiRequest = Schema.Struct({
  path: Schema.String,
  body: Schema.Unknown,
})

export type TuiRequest = Schema.Schema.Type<typeof TuiRequest>

const request = new AsyncQueue<TuiRequest>()
const response = new AsyncQueue<unknown>()

export function nextTuiRequest() {
  return request.next()
}

export function submitTuiRequest(body: TuiRequest) {
  request.push(body)
}

export function submitTuiResponse(body: unknown) {
  response.push(body)
}

export function nextTuiResponse() {
  return response.next()
}

export async function resolveVoiceTarget(sources = [
  ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
  ...(Flag.OPENCODE_CONFIG ? [Flag.OPENCODE_CONFIG] : []),
  ...(Flag.OPENCODE_CONFIG_DIR ? ConfigPaths.fileInDirectory(Flag.OPENCODE_CONFIG_DIR, "opencode") : []),
]): Promise<VoiceTarget> {
  // 只选择用户级文件，来源与 auth 同时固定；项目 MCP 继续由原 MCP 配置链处理。
  const entries = new Map<string, { config: string; server: unknown }>()
  for (const file of sources) {
    if (!(await Bun.file(file).exists())) continue
    // 变量展开沿用配置入口，尤其保留 MCP 自有 profile 的环境路径语义。
    const text = await ConfigVariable.substitute({ text: await Bun.file(file).text(), type: "path", path: file, missing: "empty" })
    const data = ConfigParse.jsonc(text, file)
    if (!isRecord(data) || !isRecord(data.mcp)) continue
    // disabled 也写入覆盖结果，随后统一选择，保持显式禁用的语义。
    for (const [key, server] of Object.entries(data.mcp)) entries.set(key, { config: path.resolve(file), server })
  }
  for (const [key, entry] of entries) {
    const server = entry.server
    // 名称与 local 类型共同识别已有 ChatGPT MCP，其他条目继续使用普通 MCP 调用链。
    if (!key.toLowerCase().includes("chatgpt") || !isRecord(server) || server.enabled === false) continue
    if (server.type !== undefined && server.type !== "local") continue
    if (!Array.isArray(server.command)) continue
    // command 是 MCP 启动 argv；这里只读取字面量数组，不解析 shell，也不执行任何命令。
    const command = server.command.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    const mcpServer = command.find((item) => path.basename(item).toLowerCase() === "mcp-server.js")
    if (!mcpServer || !command[0]) continue
    // 多 TUI 共享配置目录作为相对路径基准，避免项目 cwd 改变同一条目的解释。
    const resolved = path.resolve(path.dirname(entry.config), mcpServer)
    // 直接执行 mcp-server.js 时没有显式解释器；沿用 shebang 依赖的 node 运行同目录 chatgpt.js。
    const interpreter = path.basename(command[0]).toLowerCase() === "mcp-server.js" ? "node" : command[0]
    const script = path.join(path.dirname(resolved), "chatgpt.js")
    // 后端在接收录音后报告配置错误；TUI 的录音器不再承担解释器探测。
    if (!await commandExists(interpreter) || !await Bun.file(script).exists()) throw new Error("Voice MCP executable is unavailable")
    const environment = isRecord(server.environment)
      ? Object.fromEntries(Object.entries(server.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {}
    return { config: entry.config, key, interpreter, script, environment }
  }
  throw new Error("Voice input requires a user-configured ChatGPT MCP")
}

async function commandExists(command: string) {
  return (
    Boolean(which(command)) ||
    ((path.isAbsolute(command) || command.includes("/") || command.includes("\\")) && (await Bun.file(command).exists()))
  )
}

export async function transcribeVoiceFile(file: string, target: VoiceTarget, signal: AbortSignal): Promise<string> {
  // 配置文件是共享事务的键；每个等待者取得锁后重新读取，使用前一次完成的快照。
  return Flock.withLock(path.resolve(target.config), async () => {
    signal.throwIfAborted()
    const auth = await readVoiceAuth(target.config, target.key)
    let profile = auth === undefined
    if (auth) {
      try {
        const result = await transcribeDirect(file, auth, AbortSignal.any([signal, AbortSignal.timeout(40_000)]))
        if ("text" in result) return result.text
        // 只有凭据拒绝才重新读取 profile；限流和服务错误直接进入用户指定的浏览器步骤。
        profile = result.status === 401 || result.status === 403
      } catch { signal.throwIfAborted() }
    }
    // 新快照随成功文字一起提交；失败尝试的 Cookie 不覆盖磁盘中上一份快照。
    let result: { text: string; auth: VoiceAuth } | undefined
    if (profile) {
      try {
        signal.throwIfAborted()
        // profile 读取和其 POST 共用本次40秒；下一步骤只由服务端结果或本次错误推进。
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(40_000)])
        const auth = authFromHarvest(await voiceCommand(target, ["auth-export", "--json"], attempt, true))
        const response = await transcribeDirect(file, auth, attempt)
        if ("text" in response) result = { text: response.text, auth }
      } catch { signal.throwIfAborted() }
    }
    if (!result) {
      signal.throwIfAborted()
      // 浏览器是末级尝试，同次响应提供 text 与 Cookie；此处错误直接结束整轮。
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(40_000)])
      const body = await voiceCommand(target, ["transcribe-file", "--file", file, "--json"], attempt, false)
      if (!isRecord(body) || typeof body.text !== "string") throw new Error("Voice response must contain text")
      result = { text: body.text, auth: authFromHarvest(body.auth) }
    }
    // 写回属于成功结果提交；其错误直接交给调用者，整轮取消也在此结束文字交付。
    signal.throwIfAborted()
    await writeVoiceAuth(target.config, target.key, result.auth, signal)
    return result.text
  }, { signal, timeoutMs: 120_000 })
}

export async function readVoiceAuth(config: string, key: string): Promise<VoiceAuth | undefined> {
  // 配置文件错误保留原错误语义；只有合法文件中的缺席快照才触发 profile 读取。
  const text = await fs.readFile(config, "utf8")
  const data = ConfigParse.jsonc(text, config)
  if (!isRecord(data) || !isRecord(data.mcp) || !isRecord(data.mcp[key])) return
  const auth = data.mcp[key].auth
  if (!isRecord(auth) || !isRecord(auth.cookies) || typeof auth.fetched_at !== "string") return
  const cookies: VoiceAuthCookies = {}
  for (const [name, cookie] of Object.entries(auth.cookies)) {
    // 磁盘内容属于运行时输入，残缺条目使整份快照退出消费，避免混用部分凭据。
    if (!isRecord(cookie) || typeof cookie.value !== "string" || typeof cookie.expires !== "number") return
    cookies[name] = { value: cookie.value, expires: cookie.expires }
  }
  // 只消费浏览器留下的现成Bearer；有效性由转录响应裁决，OpenCode始终不刷新会话。
  return { cookies, fetched_at: auth.fetched_at, ...(typeof auth.access_token === "string" && auth.access_token ? { access_token: auth.access_token } : {}) }
}

export async function writeVoiceAuth(config: string, key: string, auth: VoiceAuth, signal: AbortSignal) {
  signal.throwIfAborted()
  const text = await fs.readFile(config, "utf8")
  // 定点替换 mcp.<key>.auth：与 `opencode mcp add` 写 mcp.<name> 相同的注释保真机制；
  // 注意 mcp add 会整体替换 mcp.<name> 并移除 auth 子节点，那是用户主动重注册语义，这里不做防御。
  const edits = modify(text, ["mcp", key, "auth"], auth, { formattingOptions: formatting })
  const next = applyEdits(text, edits)
  // 临时文件名含 PID+时间戳：两个 opencode 实例同时收割不会写同一个 tmp 互相覆盖。
  const temp = `${config}.tmp-${process.pid}-${Date.now()}`
  try {
    await Bun.write(temp, next)
    // rename 是提交点：之前取消只清理临时文件，之后取消保留已提交快照。
    signal.throwIfAborted()
    await fs.rename(temp, config)
  } finally { await fs.rm(temp, { force: true }) }
  signal.throwIfAborted()
}

export function authFromHarvest(payload: unknown): VoiceAuth {
  // profile 与浏览器统一使用导出数组，在此一次转换成持久化字典。
  if (!isRecord(payload) || !Array.isArray(payload.cookies) || typeof payload.fetchedAt !== "string") throw new Error("Invalid voice Cookie export")
  const cookies: VoiceAuthCookies = {}
  for (const cookie of payload.cookies) {
    if (!isRecord(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string" || typeof cookie.expires !== "number") throw new Error("Invalid voice Cookie entry")
    // CDP 的 -1 表示会话 Cookie；持久化统一为0，时间判断仅过滤已过期的发送条目。
    cookies[cookie.name] = { value: cookie.value, expires: Math.max(0, cookie.expires) }
  }
  // profile只有Cookie，浏览器成功结果另含本次实际使用的Bearer；两者统一原子保存。
  return { cookies, fetched_at: payload.fetchedAt, ...(typeof payload.accessToken === "string" && payload.accessToken ? { access_token: payload.accessToken } : {}) }
}

export function buildDirectTranscribeRequest(input: { file: string; bytes: BlobPart; auth: VoiceAuth }) {
  // multipart 的 file 保留音频二进制与文件名，boundary 由 FormData 生成。
  const form = new FormData()
  form.append("file", new File([input.bytes], path.basename(input.file), { type: "audio/wav" }))
  return { input: VOICE_TRANSCRIBE_URL, init: {
    method: "POST", body: form, purpose: "provider" as const,
    headers: {
      // 与网页SendIfAvailable一致：已有Bearer承载账户身份，Cookie-only使用匿名额度。
      ...(input.auth.access_token ? { authorization: `Bearer ${input.auth.access_token}` } : {}),
      cookie: Object.entries(input.auth.cookies).filter(([, c]) => c.expires <= 0 || c.expires > Date.now() / 1000).map(([name, c]) => `${name}=${c.value}`).join("; "),
      referer: "https://chatgpt.com/", "oai-language": "en-US",
      ...(input.auth.cookies["oai-did"] ? { "oai-device-id": input.auth.cookies["oai-did"].value } : {}),
    },
  } }
}

async function transcribeDirect(file: string, auth: VoiceAuth, signal: AbortSignal): Promise<{ status: number } | { text: string }> {
  // 调用者传入整次尝试的信号；文件读取、请求和正文消费共用同一个完成期限。
  signal.throwIfAborted()
  const request = buildDirectTranscribeRequest({ file, bytes: await Bun.file(file).arrayBuffer(), auth })
  const response = await NetworkProxy.fetch(request.input, { ...request.init, signal })
  if (!response.ok) {
    // 错误正文不参与认证决策；先释放响应资源，再把状态交给唯一编排入口。
    await response.body?.cancel()
    signal.throwIfAborted()
    return { status: response.status }
  }
  // 正文读取仍在同一次40秒内，避免仅收到响应头就被误认作完成。
  const body: unknown = await response.json()
  signal.throwIfAborted()
  if (!isRecord(body) || typeof body.text !== "string") throw new Error("Voice response must contain text")
  return { status: response.status, text: body.text }
}

async function voiceCommand(target: VoiceTarget, args: string[], signal: AbortSignal, killTree: boolean): Promise<unknown> {
  // profile 子进程随请求回收；浏览器 CLI 的独立 daemon 生命周期由 MCP 自身维护。
  const result = await Process.run([target.interpreter, target.script, ...args], {
    abort: signal, env: target.environment, killTree, nothrow: true, timeout: 1_000,
  })
  signal.throwIfAborted()
  if (result.code !== 0) throw new Error(result.stderr.toString().trim() || `Voice command exited with code ${result.code}`)
  // stdout 只作为协议解析；解析错误用固定消息，凭据片段留在本次内存中。
  try { return JSON.parse(result.stdout.toString()) }
  catch { throw new Error("Voice command did not return JSON") }
}

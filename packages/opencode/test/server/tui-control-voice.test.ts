import { describe, expect, spyOn, test } from "bun:test"
import Http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import * as TuiControl from "../../src/server/shared/tui-control"
import {
  authFromHarvest,
  buildDirectTranscribeRequest,
  readVoiceAuth,
  resolveVoiceTarget,
  transcribeVoiceFile,
  VOICE_TRANSCRIBE_URL,
  writeVoiceAuth,
  type VoiceAuth,
  type VoiceTarget,
} from "../../src/server/shared/tui-control"
import { ConfigParse } from "../../src/config/parse"
import { Process } from "../../src/util/process"
import { withTimeout } from "../../src/util/timeout"
import { tmpdir } from "../fixture/fixture"

// 后端 CLI 固定接收 transcribe-file/--file；测试只提供真实可执行脚本，不重建已退役的 argv 配置。
// 空配置让 profile 步骤明确失败后进入浏览器协议 fixture，不向真实 ChatGPT 发送测试凭据。
async function browserFixture(directory: string, source: string): Promise<VoiceTarget> {
  const script = path.join(directory, "chatgpt.cjs")
  const config = path.join(directory, "opencode.json")
  await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local" } } }))
  await Bun.write(script, `if (process.argv[2] === 'auth-export') process.exit(1);\n${source}`)
  return { config, key: "chatgpt", interpreter: process.execPath, script, environment: {} }
}

const voiceE2E = process.env.CHATGPT_VOICE_E2E === "1" ? test : test.skip
const defaultProfileE2E = process.env.CHATGPT_VOICE_E2E === "1" && process.env.CHATGPT_VOICE_DEFAULT_PROFILE_E2E === "1" ? test : test.skip

// 旧TUI argv回归迁到共享后端，Windows解释器shim仍必须原样接收带元字符的文件参数。
test.skipIf(process.platform !== "win32")("backend transcriber accepts a Windows command shim", async () => {
  await using tmp = await tmpdir()
  const target = await browserFixture(tmp.path, `console.log(JSON.stringify({text:process.argv[4],auth:{cookies:[],fetchedAt:'fixture'}}))`)
  const command = path.join(tmp.path, "voice transcriber.cmd")
  const file = path.join(tmp.path, "voice & literal.wav")
  await Bun.write(file, "RIFF....WAVE")
  await Bun.write(command, `@echo off\r\n"${process.execPath}" %*\r\n`)
  expect(await transcribeVoiceFile(file, { ...target, interpreter: command }, new AbortController().signal)).toBe(file)
})

// cmd入口同样不能连带终止独立后代；有界CLI自退保证夹具不制造遗留父进程。
test.skipIf(process.platform !== "win32" || !Bun.which("node"))("cancels a Windows transcriber without killing its lifecycle child", async () => {
  await using tmp = await tmpdir()
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the Windows fixture")
  const pidFile = path.join(tmp.path, "child.pid")
  const command = path.join(tmp.path, "transcriber.cmd")
  const abort = new AbortController()
  let pid = 0
  const target = await browserFixture(tmp.path, `const {spawn}=require("child_process"); const fs=require("fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); child.unref(); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setTimeout(()=>{},500)`)
  await Bun.write(command, `@echo off\r\n"${node}" %*\r\n`)
  const pending = transcribeVoiceFile("voice.wav", { ...target, interpreter: command }, abort.signal).catch((error: unknown) => error)
  try {
    const ready = Date.now() + 5_000
    while (!(await Bun.file(pidFile).exists()) && Date.now() < ready) await Bun.sleep(20)
    pid = Number(await Bun.file(pidFile).text())
    expect(pid).toBeGreaterThan(0)
    abort.abort()
    expect(await pending).toBeInstanceOf(Error)
    const running = () => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    expect(running()).toBe(true)
  } finally {
    abort.abort()
    await pending
    // 只清理本用例创建并记录的PID，失败也不能留下无限计时的子进程。
    if (pid > 0) await Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { windowsHide: true, stdout: "ignore", stderr: "ignore" }).exited
  }
}, 15_000)

async function writeLateMarkerWav(source: string, target: string, seconds: number) {
  const input = Buffer.from(await Bun.file(source).arrayBuffer())
  // RIFF允许fmt、LIST等可变长度chunk，data位置不能从常见的44字节PCM头反推。
  // 每个chunk按偶数字节对齐；漏掉padding会把后续四字节标识读到错误边界。
  // 只接受真实RIFF/WAVE和可达data chunk，损坏fixture必须在调用ChatGPT前本地失败。
  let chunk = 12
  while (chunk + 8 <= input.length && input.toString("ascii", chunk, chunk + 4) !== "data") {
    const size = input.readUInt32LE(chunk + 4)
    chunk += 8 + size + (size % 2)
  }
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE" || chunk + 8 > input.length) {
    throw new Error("voice E2E source is not a supported RIFF/WAVE file")
  }
  const blockAlign = input.readUInt16LE(32)
  // WAV的fmt chunk不保证固定16字节；按真实data chunk扩展，避免44字节头假设破坏合法PCM容器。
  // 使用header byteRate保持源采样格式，按blockAlign取整保证最后一个sample frame完整。
  const dataBytes = Math.floor((seconds * input.readUInt32LE(28)) / blockAlign) * blockAlign
  const dataStart = chunk + 8
  const sourceBytes = Math.floor(Math.min(input.readUInt32LE(chunk + 4), input.length - dataStart) / blockAlign) * blockAlign
  if (sourceBytes === 0 || sourceBytes > dataBytes) throw new Error("voice E2E marker has no usable PCM frames")
  const output = Buffer.alloc(dataStart + dataBytes)
  input.copy(output, 0, 0, dataStart)
  // marker只放在容器末端；若传输或转写只处理开头，两个独立expected都会缺失并确定性报红。
  input.copy(output, dataStart + dataBytes - sourceBytes, dataStart, dataStart + sourceBytes)
  output.writeUInt32LE(output.length - 8, 4)
  output.writeUInt32LE(dataBytes, chunk + 4)
  await Bun.write(target, output)
}

const auth: VoiceAuth = {
  fetched_at: "2026-09-06T00:00:00Z",
  cookies: { "oai-did": { value: "did-1", expires: 0 } },
}

// 手写配置含注释、trailing comma 与 auth 之外的兄弟字段，是注释保真写入的真实输入域。
const handwritten = `{
  // 用户手写注释必须原样保留
  "model": "test/model",
  "mcp": {
    "chatgpt": {
      "type": "local",
      "command": ["node", "mcp-server.js"],
      "enabled": true,
    },
  },
}
`

// 两代共用真实锁、Cookie决策和写回，只替换网络/CLI边界，不启动HTTP或浏览器。
test.each(["cache", "profile", "browser", "cancel"] as const)("shared voice transaction without external processes: %s", async (stage) => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "opencode.json")
  const file = path.join(tmp.path, "voice.wav")
  await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { auth: { ...auth, access_token: "cached-token" } } } }))
  await Bun.write(file, new Uint8Array([1, 2, 3, 4]))
  const initial = await Bun.file(config).text()
  const controller = new AbortController()
  const reason = new Error("cancel shared voice operation")
  const commands: string[] = []
  const exported = { cookies: [{ name: "oai-did", value: stage, expires: -1 }], fetchedAt: "2026-09-18T00:00:00Z", accessToken: "new-token" }
  const command = spyOn(Process, "run").mockImplementation(async (args, options) => {
    commands.push(args[2]!)
    // profile允许清进程树，浏览器CLI必须保留独立daemon的生命周期。
    expect(options?.killTree).toBe(args[2] === "auth-export")
    expect(options?.timeout).toBe(1_000)
    expect(options?.env).toEqual({ FIXTURE_VOICE: "shared" })
    expect(options?.abort).toBeInstanceOf(AbortSignal)
    return { code: 0, stdout: Buffer.from(JSON.stringify(args[2] === "auth-export" ? exported : { text: "browser transcript", auth: exported })), stderr: Buffer.alloc(0) }
  })
  const transport = spyOn(NetworkProxy, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(VOICE_TRANSCRIBE_URL)
    expect(init?.method).toBe("POST")
    if (!(init?.body instanceof FormData)) throw new Error("Expected real multipart voice body")
    const uploaded = init.body.get("file")
    if (!(uploaded instanceof File)) throw new Error("Expected uploaded WAV")
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    const headers = new Headers(init.headers)
    if (stage === "cancel") { controller.abort(reason); throw reason }
    // 只有401/403进入profile；429直接进入source约定的浏览器阶段。
    if (stage === "browser") return Response.json({}, { status: 429 })
    if (stage === "profile" && headers.get("cookie") === "oai-did=did-1") return Response.json({}, { status: 401 })
    expect(headers.get("authorization")).toBe(stage === "cache" ? "Bearer cached-token" : "Bearer new-token")
    expect(headers.get("cookie")).toBe(`oai-did=${stage === "cache" ? "did-1" : stage}`)
    return Response.json({ text: `${stage} transcript` })
  })
  try {
    const operation = transcribeVoiceFile(file, { config, key: "chatgpt", interpreter: "fixture", script: "fixture.js", environment: { FIXTURE_VOICE: "shared" } }, controller.signal)
    if (stage === "cancel") await expect(operation).rejects.toBe(reason)
    if (stage !== "cancel") expect(await operation).toBe(`${stage} transcript`)
    expect(commands).toEqual(stage === "profile" ? ["auth-export"] : stage === "browser" ? ["transcribe-file"] : [])
    expect(transport).toHaveBeenCalledTimes(stage === "profile" ? 2 : 1)
    // 命中缓存不刷新文件，取消不提交；恢复成功则一次写回完整的新账户快照。
    if (stage === "cache" || stage === "cancel") expect(await Bun.file(config).text()).toBe(initial)
    if (stage === "profile" || stage === "browser") expect(await readVoiceAuth(config, "chatgpt")).toEqual(authFromHarvest(exported))
  } finally {
    transport.mockRestore()
    command.mockRestore()
  }
})

describe("voice auth node", () => {
  // 写入方唯一合同：只替换 mcp.<key>.auth 节点，注释、缩进与兄弟字段逐字保留。
  // 手写内容含 trailing comma 与嵌套缩进，是注释保真写入的最严输入域。
  test("writes only the auth node and preserves comments and sibling fields", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, handwritten)

    await writeVoiceAuth(config, "chatgpt", auth, new AbortController().signal)

    const after = await Bun.file(config).text()
    // JSON 语义相同不足以保护用户文件，这些原始片段会识别整文件重序列化的退化。
    expect(after).toContain("// 用户手写注释必须原样保留")
    expect(after).toContain('"model": "test/model"')
    expect(after).toContain('"command": ["node", "mcp-server.js"]')
    expect(await readVoiceAuth(config, "chatgpt")).toEqual(auth)
  })

  // 读取保留已有Bearer，成功的新快照整体替换旧值；退休的JWT期限元数据退出消费。
  test("replaces a stale auth node in place without duplicating keys", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.jsonc")
    await Bun.write(config, handwritten)

    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { auth: { ...auth, access_token: "retired-token", token_expires_at: 1 } } } }))
    expect(await readVoiceAuth(config, "chatgpt")).toEqual({ ...auth, access_token: "retired-token" })
    const refreshed: VoiceAuth = { ...auth, cookies: { fresh: { value: "cookie-2", expires: 0 } } }
    await writeVoiceAuth(config, "chatgpt", refreshed, new AbortController().signal)

    const after = await Bun.file(config).text()
    // 字典必须整体替换，不能把已废弃 Cookie 或认证方式与新快照拼接。
    expect((after.match(/"auth"/g) ?? []).length).toBe(1)
    expect(after).not.toContain("access_token")
    expect(after).not.toContain("token_expires_at")
    expect(await readVoiceAuth(config, "chatgpt")).toEqual(refreshed)
  })

  // 缺快照允许读取 profile；损坏的配置文件仍属于配置错误，不能伪装成认证缺失。
  test("distinguishes missing auth from invalid or missing config", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, handwritten)

    const broken = path.join(tmp.path, "broken.json")
    await Bun.write(broken, "{ not json")
    // 文件错误保持拒绝语义，避免后续认证写回覆盖用户尚未修好的配置。
    await expect(readVoiceAuth(broken, "chatgpt")).rejects.toThrow()

    await expect(readVoiceAuth(path.join(tmp.path, "absent.json"), "chatgpt")).rejects.toThrow()
  })

  // 磁盘输入没有 TypeScript 保护；一个坏 Cookie 也不能留下部分可用的快照。
  test.each([{ access_token: 42 }, { cookies: {} }, { ...auth, cookies: { broken: { value: 42, expires: 0 } } }, { ...auth, cookies: { broken: { value: "x", expires: "0" } } }])("rejects malformed auth nodes %j", async (invalid) => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "x"], auth: invalid } } }))
    expect(await readVoiceAuth(config, "chatgpt")).toBeUndefined()
  })
})

describe("voice auth helpers", () => {
  // 导出数组转换为持久化字典，CDP 的 -1 是会话 Cookie，不是已过期时间。
  test("maps the agent export payload onto the auth node shape", () => {
    const auth = authFromHarvest({
      cookies: [
        { name: "a", value: "1", expires: -1 },
        { name: "b", value: "2", expires: 1_900_000 },
      ],
      fetchedAt: "2026-09-06T02:00:00Z",
    })
    expect(auth).toEqual({
      fetched_at: "2026-09-06T02:00:00Z",
      cookies: { a: { value: "1", expires: 0 }, b: { value: "2", expires: 1_900_000 } },
    })
  })

  // INV-08：auth 节点是 mcp 条目的未知嵌套字段，不得破坏 opencode 的 MCP schema 解码
  //（Effect decode 剥离未知嵌套字段，顶层未知键检查不受影响）。这是凭据内嵌配置文件的前提。
  test("keeps the auth node invisible to the mcp config schema", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "mcp-server.js"] } } }))
    await writeVoiceAuth(config, "chatgpt", auth, new AbortController().signal)
    const data = ConfigParse.jsonc(await Bun.file(config).text(), config)
    const server = (data as { mcp: { chatgpt: unknown } }).mcp.chatgpt
    const decoded = ConfigParse.schema(ConfigMCPV1.Info, server, config)
    // 普通 MCP 消费者继续使用同一 schema，语音快照不能变成启动参数或影响注册。
    expect(decoded.type).toBe("local")
    expect("auth" in decoded).toBe(false)
  })

  // 私有 CLI 输出仍是不可信协议输入；缺时间或坏条目不能产生可写回快照。
  test.each([null, { cookies: [] }, { fetchedAt: "now", cookies: [null] }, { fetchedAt: "now", cookies: [{ name: "a", value: 1, expires: 0 }] }])("rejects invalid Cookie exports %j", (payload) => {
    expect(() => authFromHarvest(payload)).toThrow(/Invalid voice Cookie/)
  })
})

// 只替换网络目的地址；正文解析、请求取消和 CLI 生命周期全部由生产入口负责。
async function backendFixture(dir: string, handler: (request: Request) => Response | Promise<Response>, command = "console.log(JSON.stringify(stage === 'auth-export' ? exported : {text:'browser transcript',auth:exported}))") {
  const config = path.join(dir, "opencode.json")
  const file = path.join(dir, "voice.wav")
  const script = path.join(dir, "agent.cjs")
  const log = path.join(dir, "commands")
  await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { auth } } }))
  await Bun.write(file, new Uint8Array([1, 2, 3, 4]))
  await Bun.write(log, "")
  // 子进程自己写调用日志，区别真正执行过的命令与仅被构造的 argv。
  await Bun.write(script, `const stage = process.argv[2]; require('fs').appendFileSync(${JSON.stringify(log)}, stage+'\\n');
const exported = {cookies:[{name:'oai-did',value:stage === 'auth-export' ? 'profile' : 'browser',expires:-1}],fetchedAt:'2026-09-18T00:00:00Z'};
(async () => { ${command} })().catch(error => { console.error(error.message); process.exitCode = 1 });`)
  // 原生 Request 的 signal 只在请求正文完成后仍能观察响应读取取消，避免把 body EOF 误当成连接结束。
  // fixture 统一先消费上传字节，再把响应生命周期交给标准 fetch；handler 不再接触 Node 专属事件。
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      await request.arrayBuffer()
      return handler(request)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const headers = Promise.withResolvers<void>()
  const requests: { url: string; cookie: string | null; signal: AbortSignal | null | undefined }[] = []
  // 记录原始 URL，额外 session 刷新或绕路请求不能被重定向偷偷掩盖。
  // fetch 返回只表示响应头可用，正文是否结束仍由生产解析阶段决定。
  const fetch = spyOn(NetworkProxy, "fetch").mockImplementation(async (input, init) => {
    requests.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie"), signal: init?.signal })
    const response = await globalThis.fetch(url, init)
    // 只发布响应头就绪，不预读正文，否则会把生产解析阶段的超时缺陷藏到 fixture 里。
    headers.resolve()
    return response
  })
  const target = { config, key: "chatgpt", interpreter: process.execPath, script, environment: { FIXTURE_URL: url } }
  return {
    config, file, target, requests, headers: headers.promise,
    run: (signal = new AbortController().signal) => TuiControl.transcribeVoiceFile(file, target, signal),
    commands: () => Bun.file(log).text(),
    async [Symbol.asyncDispose]() {
      fetch.mockRestore()
      // 取消测试会刻意留下未结束的正文；先关闭连接再释放端口，防止残留响应污染下个用例。
      // 强制停止只属于 fixture 收尾，不能改变被测请求的取消结果。
      await server.stop(true)
    },
  }
}

describe("backend Cookie attempts", () => {
  // Cookie-only 429属于匿名额度，成功浏览器返回的实际Bearer必须在下一轮直接复用。
  test("reuses the browser account snapshot after anonymous dictation is rejected", async () => {
    await using tmp = await tmpdir()
    const seen: (string | undefined)[] = []
    await using fixture = await backendFixture(tmp.path, async (request) => {
      const authorization = request.headers.get("authorization") ?? undefined
      const cookie = request.headers.get("cookie")
      seen.push(authorization)
      // 只认独立已知的账户值，避免Cookie单独成功掩盖授权字段在持久化中丢失。
      // 标准 Headers 读取保持与线上请求相同的大小写无关语义。
      const account = authorization === "Bearer browser-token" && cookie === "oai-did=browser"
      return new Response(JSON.stringify({ text: "authenticated transcript" }), { status: account ? 200 : 429 })
    }, "console.log(JSON.stringify({text:'browser transcript',auth:{...exported,accessToken:'browser-token'}}))")
    expect(await fixture.run()).toBe("browser transcript")
    // 第二轮从文件读取，经真实HTTP发送；仅检查转换helper不足以覆盖完整消费链。
    expect(await fixture.run()).toBe("authenticated transcript")
    expect(seen).toEqual([undefined, "Bearer browser-token"])
    expect(await fixture.commands()).toBe("transcribe-file\n")
    expect(await readVoiceAuth(fixture.config, "chatgpt")).toMatchObject({ access_token: "browser-token" })
  })

  // 401 与 403 都是凭据恢复入口，其余 HTTP 失败跳过 profile，直接进入完整浏览器转录。
  test.each([401, 403, 400, 429, 500])("routes HTTP %i to the contracted next step", async (status) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async (request) => {
      return new Response(JSON.stringify({ text: "profile transcript" }), { status: request.headers.get("cookie") === "oai-did=profile" ? 200 : status })
    })
    expect(await fixture.run()).toBe(status === 401 || status === 403 ? "profile transcript" : "browser transcript")
    expect(await fixture.commands()).toBe(status === 401 || status === 403 ? "auth-export\n" : "transcribe-file\n")
    // 每次请求都必须是转录 POST；没有 session 刷新，也没有同凭据隐藏重试。
    expect(fixture.requests.map((entry) => entry.url)).toEqual(Array(status === 401 || status === 403 ? 2 : 1).fill(VOICE_TRANSCRIBE_URL))
    expect(fixture.requests.map((entry) => entry.cookie)).toEqual(status === 401 || status === 403 ? ["oai-did=did-1", "oai-did=profile"] : ["oai-did=did-1"])
  })

  // 未写入快照和格式错误的旧节点都不可用于直连，不能先发一个空凭据请求。
  test.each([undefined, { access_token: "old" }])("reads profile when cache is unavailable: %j", async (cached) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async () => new Response(JSON.stringify({ text: "profile transcript" })))
    await Bun.write(fixture.config, JSON.stringify({ mcp: { chatgpt: { auth: cached } } }))
    expect(await fixture.run()).toBe("profile transcript")
    expect(await fixture.commands()).toBe("auth-export\n")
    // 请求上的 Cookie 值来自真实子进程导出，而非预设的内存认证对象。
    expect(fixture.requests.map((entry) => entry.cookie)).toEqual(["oai-did=profile"])
  })

  // profile 的读取错误、协议错误和 POST 错误都进入末级；不允许重复离线读取。
  test.each(["exit", "json", "shape", "post"])("advances after profile %s failure", async (failure) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async () => {
      return new Response("{}", { status: 403 })
    }, `if (stage === 'auth-export') { if (${JSON.stringify(failure)} === 'exit') process.exit(3); console.log(${JSON.stringify(failure)} === 'json' ? 'invalid JSON' : JSON.stringify(${JSON.stringify(failure)} === 'shape' ? {} : exported)); return; } console.log(JSON.stringify({text:'browser transcript',auth:exported}));`)
    expect(await fixture.run()).toBe("browser transcript")
    expect(await fixture.commands()).toBe("auth-export\ntranscribe-file\n")
    // 只有拿到完整导出才允许 profile POST，失败导出不产生半可用凭据。
    expect(fixture.requests.map((entry) => entry.cookie)).toEqual(failure === "post" ? ["oai-did=did-1", "oai-did=profile"] : ["oai-did=did-1"])
  })

  // 静音的空串是成功；缺 text、类型错误和无效 JSON 是可观察的协议失败。
  test.each(['{"text":""}', '{}', 'null', '{"text":7}', 'not JSON'])("consumes direct response %s", async (body) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async () => new Response(body))
    expect(await fixture.run()).toBe(body === '{"text":""}' ? "" : "browser transcript")
    expect(await fixture.commands()).toBe(body === '{"text":""}' ? "" : "transcribe-file\n")
    // 即使解析失败也不能把它改判为认证失败，从而触发未批准的 profile 分支。
    expect(fixture.requests).toHaveLength(1)
  })

  // 末级失败结束整轮；固定错误消息也防止把含凭据的无效 stdout 泄露出去。
  test.each([
    ["process.stderr.write('login required'); process.exit(3)", "login required"],
    ["console.log('secret-invalid-json')", "Voice command did not return JSON"],
    ["console.log(JSON.stringify({text:7,auth:exported}))", "Voice response must contain text"],
    ["console.log(JSON.stringify({text:'text',auth:{}}))", "Invalid voice Cookie export"],
  ])("propagates terminal CLI failure %s", async (command, message) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async () => new Response("{}", { status: 500 }), command)
    const before = await Bun.file(fixture.config).text()
    await expect(fixture.run()).rejects.toThrow(message)
    expect(await fixture.commands()).toBe("transcribe-file\n")
    // 失败结果不落盘，也不能向调用者伪造可插入的文字。
    expect(await Bun.file(fixture.config).text()).toBe(before)
    expect(fixture.requests).toHaveLength(1)
  })

  // 写回属于提交阶段，不在恢复 catch 内；真实文件消失必须导致失败，不能返回内存态成功。
  test("propagates writeback failure without advancing to browser", async () => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, async (request) => {
      if (request.headers.get("cookie") !== "oai-did=profile") return new Response("{}", { status: 401 })
      await fs.unlink(path.join(tmp.path, "opencode.json"))
      return new Response(JSON.stringify({ text: "must not deliver" }))
    })
    await expect(fixture.run()).rejects.toThrow(/ENOENT/)
    expect(await fixture.commands()).toBe("auth-export\n")
    expect(await Bun.file(fixture.config).exists()).toBe(false)
  })
})

describe("backend cancellation and deadlines", () => {
  // 请求级取消高于恢复策略；无论当前处于哪个外部边界，都不能再推进下一步。
  test.each(["before", "cache", "profile", "profile-post", "browser"])("never advances after cancellation during %s", async (stage) => {
    await using tmp = await tmpdir()
    const ready = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const controller = new AbortController()
    const reason = new Error("cancel voice transaction")
    await using fixture = await backendFixture(tmp.path, (request) => {
      const pathname = new URL(request.url).pathname
      // CLI 用就绪握手证明已经启动；不靠固定 sleep 猜测进程是否到达取消点。
      if (pathname === "/ready" || stage === "cache" || stage === "profile-post") {
        // 握手与转录响应都只发布响应头；正文故意不关闭以观察原生 signal 的断连事实。
        // 取消回调只关闭测试流并发布完成点，不能替代生产请求的取消传播。
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener("abort", () => {
              closed.resolve()
              controller.close()
            }, { once: true })
            if (pathname !== "/ready") controller.enqueue(new TextEncoder().encode('{"text":"'))
            ready.resolve()
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      }
      return new Response("{}", { status: stage === "profile" ? 401 : 500 })
    }, stage === "profile-post" ? "console.log(JSON.stringify(exported))" : "await fetch(process.env.FIXTURE_URL+'/ready'); console.log(JSON.stringify({text:'late',auth:exported}));")
    // 无缓存使 profile POST 成为第一条直连，避免把缓存的响应头误作正文就绪。
    if (stage === "profile-post") await Bun.write(fixture.config, handwritten)
    const before = await Bun.file(fixture.config).text()
    if (stage === "before") controller.abort(reason)
    const pending = fixture.run(controller.signal)
    // 先附拒绝处理再触发取消，避免异步失败在就绪握手期间成为未处理异常。
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      if (stage !== "before") { await withTimeout(ready.promise, 30_000, `voice cancellation ${stage} readiness timed out`); controller.abort(reason) }
      expect(await outcome).toEqual({ error: reason })
      // 服务端观察响应读取请求被中断，避免只丢弃 Promise 的假取消。
      // 阶段标签让30秒总期限内的失败能区分握手缺失与服务端未收取消。
      if (stage !== "before") await withTimeout(closed.promise, 30_000, `voice cancellation ${stage} server abort timed out`)
      expect(await fixture.commands()).toBe(stage === "profile" || stage === "profile-post" ? "auth-export\n" : stage === "browser" ? "transcribe-file\n" : "")
      expect(fixture.requests).toHaveLength(stage === "before" ? 0 : 1)
      expect(await Bun.file(fixture.config).text()).toBe(before)
    } finally { controller.abort(reason); await pending.catch(() => {}) }
  })

  // rename 是提交点：之前取消不得改配置，之后取消保留快照但绝不交付本轮文字。
  test.each(["before", "after"])("cancels %s atomic rename without delivering text", async (when) => {
    await using tmp = await tmpdir()
    await using fixture = await backendFixture(tmp.path, (request) => {
      return new Response(JSON.stringify({ text: "must not deliver" }), { status: request.headers.get("cookie") === "oai-did=profile" ? 200 : 401 })
    })
    const controller = new AbortController()
    const reason = new Error(`cancel ${when} rename`)
    const before = await Bun.file(fixture.config).text()
    const write = Bun.write
    const rename = fs.rename
    const commits: string[] = []
    // 包装真实文件系统操作只安排取消时刻，不伪造写入、移动或内部 helper 的结果。
    const writing = spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
      if (typeof destination !== "string" || typeof data !== "string") throw new Error("Fixture expects JSONC filesystem writes")
      // 先落地临时 JSONC 再取消，确保 finally 确实有文件要清理，而非只测预取消入口。
      const result = await write(destination, data, options)
      if (destination.startsWith(`${fixture.config}.tmp-`) && when === "before") controller.abort(reason)
      return result
    })
    const renaming = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination)
      if (destination !== fixture.config) return
      commits.push(String(destination))
      // 取消发生在真正 rename 完成后，不能通过跳过磁盘提交来满足丢弃文字的断言。
      if (when === "after") controller.abort(reason)
    })
    try {
      await expect(fixture.run(controller.signal)).rejects.toBe(reason)
      // 字节级比较保护提交前的注释与格式；提交后则通过公开读接口确认新快照。
      if (when === "before") expect(await Bun.file(fixture.config).text()).toBe(before)
      if (when === "after") expect(await readVoiceAuth(fixture.config, "chatgpt")).toEqual({ fetched_at: "2026-09-18T00:00:00Z", cookies: { "oai-did": { value: "profile", expires: 0 } } })
      expect(commits).toHaveLength(when === "before" ? 0 : 1)
      // 成功提交和中止提交都必须清理临时文件；取消不能被当作浏览器恢复理由。
      expect((await fs.readdir(tmp.path)).filter((name) => name.includes(".tmp-"))).toEqual([])
      expect(await fixture.commands()).toBe("auth-export\n")
    } finally { writing.mockRestore(); renaming.mockRestore() }
  })

  // 受控时钟仅替换 timeout 信号，真实 fetch 收到响应头后仍须等待并取消真实正文。
  test.each(["cache", "profile"])("keeps %s body consumption inside one fixed 40-second attempt", async (stage) => {
    await using tmp = await tmpdir()
    const readingProfile = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const closed = Promise.withResolvers<void>()
    const controllers: AbortController[] = []
    const durations: number[] = []
    const timeout = AbortSignal.timeout
    const clock = spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
      if (duration !== 40_000) return timeout(duration)
      durations.push(duration)
      const controller = new AbortController()
      controllers.push(controller)
      return controller.signal
    })
    await using fixture = await backendFixture(tmp.path, (request) => {
      if (new URL(request.url).pathname === "/ready") {
        // CLI 只需要响应头继续启动；控制器由测试在既有计时点显式结束正文。
        const response = new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            readingProfile.resolve(controller)
          },
        }), { headers: { "content-type": "text/plain" } })
        return response
      }
      // 不发送结束花括号，确保返回响应头并不等于完成转录正文解析。
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => {
            closed.resolve()
            controller.close()
          }, { once: true })
          controller.enqueue(new TextEncoder().encode('{"text":"unfinished'))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }, "if (stage === 'auth-export') await fetch(process.env.FIXTURE_URL+'/ready'); console.log(JSON.stringify(stage === 'auth-export' ? exported : {text:'browser transcript',auth:exported}));")
    if (stage === "profile") await Bun.write(fixture.config, handwritten)
    const request = new AbortController()
    const pending = fixture.run(request.signal)
    try {
      // profile CLI 尚未结束时计时器就已存在，POST 不能另开一个新的 40 秒窗口。
      // 这里只释放握手正文，不缩短真实转录请求的固定尝试期限。
      if (stage === "profile") { const response = await withTimeout(readingProfile.promise, 30_000, "profile CLI readiness timed out"); expect(durations).toEqual([40_000]); response.close() }
      // 响应头、正文取消和下一步推进分别有独立阶段信号，避免单一超时掩盖顺序错误。
      await withTimeout(fixture.headers, 30_000, `${stage} response headers timed out`)
      expect(durations).toEqual([40_000])
      expect(fixture.requests).toHaveLength(1)
      const attempt = controllers[0]
      if (!attempt) throw new Error("Missing fixed attempt deadline")
      // 使用 TimeoutError 保持生产 timeout 的原因类型，同时避免测试真实等待四十秒。
      attempt.abort(new DOMException("attempt timed out", "TimeoutError"))
      // 单次超时仍允许下一契约步骤；整轮信号保持有效，浏览器获得独立完整窗口。
      expect(await pending).toBe("browser transcript")
      await withTimeout(closed.promise, 30_000, `${stage} response cancellation timed out`)
      expect(request.signal.aborted).toBe(false)
      expect(fixture.requests[0]?.signal?.aborted).toBe(true)
      expect(durations).toEqual([40_000, 40_000])
      expect(await fixture.commands()).toBe(stage === "profile" ? "auth-export\ntranscribe-file\n" : "transcribe-file\n")
    } finally { request.abort(); await pending.catch(() => {}); clock.mockRestore() }
  })

  // CLI 读取与浏览器执行都受各自尝试信号约束；只有末级超时终止整轮。
  test.each(["profile", "browser"])("uses fixed deadlines when %s CLI times out", async (stage) => {
    await using tmp = await tmpdir()
    const ready = Promise.withResolvers<void>()
    const controllers: AbortController[] = []
    const durations: number[] = []
    const timeout = AbortSignal.timeout
    const clock = spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
      if (duration !== 40_000) return timeout(duration)
      durations.push(duration)
      const controller = new AbortController()
      controllers.push(controller)
      return controller.signal
    })
    await using fixture = await backendFixture(tmp.path, (request) => {
      if (new URL(request.url).pathname === "/ready") { ready.resolve(); return new Response("ready") }
      return new Response("{}", { status: 401 })
    }, `if (stage === ${JSON.stringify(stage === "profile" ? "auth-export" : "transcribe-file")}) await fetch(process.env.FIXTURE_URL+'/ready'); console.log(JSON.stringify(stage === 'auth-export' ? exported : {text:'browser transcript',auth:exported}));`)
    const request = new AbortController()
    const reason = new DOMException("CLI deadline", "TimeoutError")
    const pending = fixture.run(request.signal)
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await withTimeout(ready.promise, 30_000, `${stage} CLI readiness timed out`)
      // 快速 401 必须立即推进，既不等满 40 秒，也不从末级扣除之前的耗时。
      expect(durations).toEqual(stage === "profile" ? [40_000, 40_000] : [40_000, 40_000, 40_000])
      const attempt = controllers[stage === "profile" ? 1 : 2]
      if (!attempt) throw new Error("Missing CLI deadline")
      attempt.abort(reason)
      expect(await outcome).toEqual(stage === "profile" ? { value: "browser transcript" } : { error: reason })
      expect(await fixture.commands()).toBe("auth-export\ntranscribe-file\n")
      // 超时的 profile 绝不能再 POST；浏览器成功写回，末级失败则保持旧快照。
      expect(fixture.requests).toHaveLength(stage === "profile" ? 1 : 2)
      expect(durations).toEqual([40_000, 40_000, 40_000])
      expect(await readVoiceAuth(fixture.config, "chatgpt")).toEqual(stage === "profile" ? { fetched_at: "2026-09-18T00:00:00Z", cookies: { "oai-did": { value: "browser", expires: 0 } } } : auth)
    } finally { request.abort(); await pending.catch(() => {}); clock.mockRestore() }
  })
})

describe("direct transcribe", () => {
  // 来源和执行环境必须同一个条目；相对脚本以配置文件目录解析，多个 TUI 得到同一目标。
  test("resolves the daemon voice target and honors disabled overrides", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    const override = path.join(tmp.path, "override.json")
    await Bun.write(path.join(tmp.path, "chatgpt.js"), "")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: [process.execPath, "./mcp-server.js"], environment: { CHATGPT_STATE_DIR: tmp.path } } } }))
    expect(await TuiControl.resolveVoiceTarget([config])).toEqual({ config, key: "chatgpt", interpreter: process.execPath, script: path.join(tmp.path, "chatgpt.js"), environment: { CHATGPT_STATE_DIR: tmp.path } })
    await Bun.write(override, JSON.stringify({ mcp: { chatgpt: { enabled: false } } }))
    await expect(TuiControl.resolveVoiceTarget([config, override])).rejects.toThrow("Voice input requires a user-configured ChatGPT MCP")
  })

  // 从后端入口穿过真实HTTP；缓存携带已有Bearer，profile导出保持Cookie-only。
  test.each(["cache", "profile", "browser"])("daemon transcribes through %s and persists its cookies", async (source) => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    const file = path.join(tmp.path, "voice.wav")
    const script = path.join(tmp.path, "chatgpt.cjs")
    const commands = path.join(tmp.path, "commands")
    const exported = { cookies: [{ name: "oai-did", value: source, expires: 0, domain: "chatgpt.com", path: "/" }], fetchedAt: "2026-09-18T00:00:00Z" }
    // 旧期限字段退出决策，缓存是否有效由真实服务端响应决定。
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { auth: { ...auth, access_token: "cached-token", token_expires_at: 1 } } } }))
    const initial = await Bun.file(config).text()
    await Bun.write(file, new Uint8Array([1, 2, 3, 4]))
    await Bun.write(commands, "")
    // 假 CLI 只模拟私有命令的外部协议；后端仍真实 spawn、消费 stdout 并写回 JSONC。
    await Bun.write(script, `require('fs').appendFileSync(${JSON.stringify(commands)}, process.argv[2]+'\\n'); if(process.argv.includes('auth-export') && ${JSON.stringify(source)} === 'browser') process.exit(1); console.log(JSON.stringify(process.argv.includes('auth-export') ? ${JSON.stringify(exported)} : {text:'browser transcript',auth:${JSON.stringify(exported)}}));`)
    const cookies: string[] = []
    const server = Http.createServer((request, response) => {
      request.resume()
      request.on("end", () => {
        cookies.push(request.headers.cookie ?? "")
        const accepted = request.headers.cookie === `oai-did=${source === "cache" ? "did-1" : source}` && request.headers.authorization === (source === "cache" ? "Bearer cached-token" : undefined)
        response.writeHead(accepted ? 200 : 401, { "content-type": "application/json" })
        response.end(JSON.stringify(accepted ? { text: "cookie transcript" } : { error: "credentials" }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture listener missing")
    const fetch = spyOn(NetworkProxy, "fetch").mockImplementation((_url, init) => globalThis.fetch(`http://127.0.0.1:${address.port}`, init))
    try {
      expect(await TuiControl.transcribeVoiceFile(file, { config, key: "chatgpt", interpreter: process.execPath, script, environment: {} }, new AbortController().signal)).toBe(source === "browser" ? "browser transcript" : "cookie transcript")
      if (source !== "cache") {
        expect((await Bun.file(config).json()).mcp.chatgpt.auth).toEqual({ cookies: { "oai-did": { value: source, expires: 0 } }, fetched_at: exported.fetchedAt })
      }
      // 缓存命中不是新快照，不能为了更新时间戳而改写用户配置。
      if (source === "cache") expect(await Bun.file(config).text()).toBe(initial)
      // 第二次仍从公共后端入口读取文件；真实 CLI 日志不变才证明没有重新收割。
      const before = await Bun.file(commands).text()
      expect(before).toBe(source === "cache" ? "" : source === "profile" ? "auth-export\n" : "auth-export\ntranscribe-file\n")
      expect(await TuiControl.transcribeVoiceFile(file, { config, key: "chatgpt", interpreter: process.execPath, script, environment: {} }, new AbortController().signal)).toBe("cookie transcript")
      expect(await Bun.file(commands).text()).toBe(before)
      expect(cookies).toEqual(source === "cache" ? ["oai-did=did-1", "oai-did=did-1"] : source === "profile" ? ["oai-did=did-1", "oai-did=profile", "oai-did=profile"] : ["oai-did=did-1", "oai-did=browser"])
    } finally {
      fetch.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  // 此快照来自仅含Cookie的profile导出；SendIfAvailable在该输入域省略Authorization。
  test("builds the documented direct transcribe request shape", async () => {
    const snapshot = { ...auth, cookies: { "oai-did": { value: "did-7", expires: 0 }, expired: { value: "omit", expires: 1 }, live: { value: "keep", expires: Date.now() / 1000 + 86_400 } } }
    const bytes = new Uint8Array([1, 2, 3, 4])
    const request = buildDirectTranscribeRequest({ file: "C:/tmp/voice .wav", bytes, auth: snapshot })
    expect(request.input).toBe(VOICE_TRANSCRIBE_URL)
    expect(request.init.method).toBe("POST")
    // 文件名带空格锁定 basename 原样进入 multipart，不发生任何 shell/路径改写。
    const headers = new Headers(request.init.headers)
    expect(headers.get("authorization")).toBeNull()
    // 只过滤过期条目，不能用最短 TTL 把仍然有效的整个快照淘汰。
    expect(headers.get("cookie")).toBe("oai-did=did-7; live=keep")
    expect(headers.get("oai-device-id")).toBe("did-7")
    expect(headers.get("oai-language")).toBe("en-US")
    expect(headers.get("referer")).toBe("https://chatgpt.com/")
    const form = request.init.body
    expect([...form.keys()]).toEqual(["file"])
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("Missing multipart file")
    expect(file.name).toBe("voice .wav")
    expect(file.type).toBe("audio/wav")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })

  // 目标解析已归后端所有；缺失脚本仍须在 spawn 前明确报错，不能删除原来的诊断覆盖。
  test("rejects a backend target whose agent script is missing", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: [process.execPath, path.join(tmp.path, "mcp-server.js")] } } }))
    await expect(resolveVoiceTarget([config])).rejects.toThrow("Voice MCP executable is unavailable")
  })
})

describe("backend browser protocol", () => {
  // transcriber只是后端持有的父进程；它启动的daemon/browser有独立生命周期，取消不能递归强杀后代。
  test("cancels only the backend CLI process and leaves its lifecycle child running", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "grandchild-alive")
    const ready = path.join(tmp.path, "grandchild-started")
    const grandchild = path.join(tmp.path, "grandchild.cjs")
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    await Bun.write(grandchild, "require('fs').writeFileSync(process.argv[3], 'ready'); setTimeout(() => require('fs').writeFileSync(process.argv[2], 'alive'), 500)")
    // 取消应由后端持有的 CLI 接收；浏览器后代仍按原 ownership 自行存活。
    const target = await browserFixture(tmp.path, `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}, ${JSON.stringify(ready)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000)`)
    const abort = new AbortController()
    const transcription = transcribeVoiceFile(file, target, abort.signal)
    const cancelled = transcription.then((text) => ({ text }), (error: unknown) => ({ error }))
    for (let attempts = 0; attempts < 100 && !(await Bun.file(ready).exists()); attempts++) await Bun.sleep(25)
    expect(await Bun.file(ready).text()).toBe("ready")
    abort.abort()
    expect(await cancelled).toMatchObject({ error: { name: "AbortError" } })
    await Bun.sleep(700)
    expect(await Bun.file(marker).text()).toBe("alive")
  })

  // 新协议同次返回 Cookie；只测路径字面量，不依赖旧的 {file} 替换器。
  test("passes the audio file as one argv argument without shell expansion", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice $HOME ; echo nope.wav")
    await Bun.write(file, "RIFF....WAVE")

    const target = await browserFixture(tmp.path, "process.stdout.write(JSON.stringify({ text: process.argv[4], auth: { cookies: [], fetchedAt: '2026-09-18T00:00:00Z' } }))")
    const text = await transcribeVoiceFile(file, target, new AbortController().signal)

    expect(text).toBe(file)
    expect(await Bun.file(path.join(tmp.path, "out.wav")).exists()).toBe(false)
  })

  // 外部转写器是独立进程，成功退出也可能返回非 JSON。
  // TUI 不能把这些输出直接插入 prompt，否则用户会看到不可诊断的脏文本。
  // 非 JSON 是协议错误；R9 的静音空文本则应成功返回，由 controller 保持输入不变。
  test("rejects invalid browser output", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")

    const invalid = await browserFixture(tmp.path, "process.stdout.write('not json')")
    await expect(transcribeVoiceFile(file, invalid, new AbortController().signal)).rejects.toThrow(/JSON/)
  })

  // 直连失败（如 Cloudflare 403 或收割不可用）后进入后端浏览器 CLI，仍返回浏览器页面路径的转写文本；
  // 回退成功不吞直连诊断：直连错误只影响本次请求的路径选择。
  test("falls back to the backend browser transcriber when the direct path fails", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    const target = await browserFixture(tmp.path, "process.stdout.write(JSON.stringify({ text: 'fallback browser text', auth: { cookies: [], fetchedAt: '2026-09-18T00:00:00Z' } }))")
    await Bun.write(target.config, JSON.stringify({ mcp: { chatgpt: { auth: { cookies: {}, fetched_at: "2026-09-18T00:00:00Z" } } } }))
    // 直连 403 与收割不可用同时注入：两级失败都压到同一回退口，覆盖最坏链路。
    // 只隔离真实远端网络，profile 失败与浏览器协议解析仍执行实际子进程。
    const transport = spyOn(NetworkProxy, "fetch").mockResolvedValue(new Response("{}", { status: 403 }))
    try {
      expect(await transcribeVoiceFile(file, target, new AbortController().signal)).toBe("fallback browser text")
    } finally { transport.mockRestore() }
  })

  // 直连成功时浏览器 argv 不得被调用（marker 文件是 argv 被调用的磁盘证据）。
  // 该断言锁定"直连是主路径"：成功场景回落浏览器会浪费整段 daemon 生命周期。
  test("uses the direct path without spawning the fallback argv", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    const marker = path.join(tmp.path, "argv-invoked")
    const target = await browserFixture(tmp.path, `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`)
    // R12仍支持没有Bearer的Cookie快照；此fixture验证匿名成功时不启动浏览器。
    await Bun.write(target.config, JSON.stringify({ mcp: { chatgpt: { auth: { cookies: { session: { value: "fixture", expires: 0 } }, fetched_at: "2026-09-18T00:00:00Z" } } } }))
    const transport = spyOn(NetworkProxy, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("cookie")).toBe("session=fixture")
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return Response.json({ text: "direct text" })
    })
    try {
      expect(await transcribeVoiceFile(file, target, new AbortController().signal)).toBe("direct text")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally { transport.mockRestore() }
  })
})

// ── 真实账户门禁 E2E（默认跳过）：与源测试文件同门禁同语义，随共享后端迁入 opencode 侧 ──

// 门禁 E2E：真实 profile 收割→直连转写→auth 节点写回，跨平台（无 darwin 音频工具依赖）。
// 运行：CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> bun test test/server/tui-control-voice.test.ts --test-name-pattern "direct harvest"
voiceE2E(
  "harvests real credentials and transcribes directly without the browser page path",
  async () => {
    if (!process.env.CHATGPT_BROWSER_USER_DATA_DIR) {
      throw new Error("voice E2E requires CHATGPT_BROWSER_USER_DATA_DIR for a logged-in agent profile")
    }
    const agent = path.resolve(import.meta.dir, "../../../../thirdparty/chatgpt-browser-agent")
    const script = path.join(agent, "chatgpt.js")
    const source = path.join(agent, "test-voice-hello.wav")
    const root = path.join(os.tmpdir(), "opencode", "voice")
    const state = path.join(root, `direct-e2e-state-${process.pid}`)
    const previousState = process.env.CHATGPT_STATE_DIR
    // daemon state 隔离：profile 复用登录，state/token/日志按 PID 分离。
    process.env.CHATGPT_STATE_DIR = state
    const wav = path.join(root, `direct-e2e-${process.pid}.wav`)
    const config = path.join(root, `direct-e2e-config-${process.pid}.json`)
    await fs.mkdir(root, { recursive: true })
    await fs.copyFile(source, wav)
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", script] } } }))
    // 真实 profile 收割由后端完成；TUI 不再持有 token 或嵌套转写器配置。
    const direct: VoiceTarget = {
      config,
      key: "chatgpt",
      interpreter: "node",
      script,
      environment: { CHATGPT_STATE_DIR: state, CHATGPT_BROWSER_USER_DATA_DIR: process.env.CHATGPT_BROWSER_USER_DATA_DIR },
    }
    try {
      const text = await transcribeVoiceFile(wav, direct, AbortSignal.timeout(120_000))
      const lowered = text.toLowerCase()
      // markers 与 darwin 五分钟 E2E 独立：hello/world 只能来自真实直连响应体。
      if (!lowered.includes("hello") || !lowered.includes("world")) throw new Error(`direct E2E markers missing: ${text.slice(0, 120)}`)
      // 本用例限定profile匿名直连成功，落盘仍只有Cookie；浏览器成功快照在R12另附Bearer。
      const authNode = await readVoiceAuth(config, "chatgpt")
      if (!authNode) throw new Error("direct E2E did not persist the harvested auth node")
      if (Object.keys(authNode.cookies).length === 0) throw new Error("direct E2E auth node has no cookies")
      // 文字本身不能证明走了直连；隔离 state 中出现 daemon 则说明末级浏览器被启动。
      expect(await Bun.file(path.join(state, "daemon.json")).exists()).toBe(false)
      expect(lowered).toContain("hello")
      expect(lowered).toContain("world")
    } finally {
      // 隔离 daemon 用真实 CLI ownership 收敛；先停进程再删 state。
      const stop = Bun.spawn(["node", script, "--stop"], { cwd: agent, env: process.env, stdout: "ignore", stderr: "ignore", windowsHide: true })
      await stop.exited
      await fs.rm(state, { recursive: true, force: true })
      await fs.rm(wav, { force: true })
      await fs.rm(config, { force: true })
      if (previousState === undefined) delete process.env.CHATGPT_STATE_DIR
      else process.env.CHATGPT_STATE_DIR = previousState
    }
  },
  300_000,
)

// darwin 五分钟长音频门禁：controller 只作为提交方，转录统一走后端事务入口。
voiceE2E(
  "runs a five-minute WAV through the shared backend transcriber",
  async () => {
    // Bun测试preload会隔离XDG_DATA_HOME；E2E必须显式复用真实agent profile，不能拿临时空profile制造假未登录。
    if (!process.env.CHATGPT_BROWSER_USER_DATA_DIR) {
      throw new Error("voice E2E requires CHATGPT_BROWSER_USER_DATA_DIR for a logged-in agent profile")
    }
    if (process.platform !== "darwin") throw new Error("voice E2E late-marker fixture requires Darwin system audio tools")
    const { createVoiceInputController } = await import("@opencode-ai/tui/prompt-voice-input")
    const agent = path.resolve(import.meta.dir, "../../../../thirdparty/chatgpt-browser-agent")
    const script = path.join(agent, "chatgpt.js")
    const source = path.join(agent, "test-voice-hello.wav")
    const root = path.join(process.env.TMPDIR || "/private/tmp", "opencode", "voice")
    const evidence = process.env.CHATGPT_VOICE_E2E_EVIDENCE
    const state = path.join(root, `e2e-state-${process.pid}`)
    const previousState = process.env.CHATGPT_STATE_DIR
    // 固定本次daemon state，保证transcriber与finally命中同一个PID。
    // profile与state刻意分离：前者复用登录，后者隔离daemon token、日志和PID索引。
    process.env.CHATGPT_STATE_DIR = state
    const long = path.join(root, `tui-long-${process.pid}.wav`)
    const short = path.join(root, `tui-short-${process.pid}.wav`)
    const markerAiff = path.join(root, `tui-marker-${process.pid}.aiff`)
    const marker = path.join(root, `tui-marker-${process.pid}.wav`)
    await fs.mkdir(root, { recursive: true })
    // 系统TTS只生成本地测试输入；argv调用避免shell解释，普通CI因voiceE2E门禁不会进入该分支。
    const say = Bun.spawn(["/usr/bin/say", "-v", "Samantha", "-o", markerAiff, "purple checkpoint orange"], { stdout: "ignore", stderr: "ignore" })
    if (await say.exited !== 0) throw new Error("voice E2E could not synthesize its late marker")
    const convert = Bun.spawn(["/usr/bin/afconvert", markerAiff, "-o", marker, "-f", "WAVE", "-d", "LEI16@48000", "-c", "1"], { stdout: "ignore", stderr: "ignore" })
    if (await convert.exited !== 0) throw new Error("voice E2E could not convert its late marker to PCM WAV")
    await writeLateMarkerWav(marker, long, 300)
    await fs.copyFile(source, short)
    // long必须先于short消费；交换顺序会让独立expected失去检测迟到回放的能力。
    const files = [long, short]
    // 只记录本地断言所需事实；真实转录文本不得写入证据文件或daemon状态。
    const inserted: string[] = []
    const errors: string[] = []
    const startedAt = Date.now()
    let completed = false
    let longRemoved = false
    let shortRemoved = false
    let longMarkersMatched = false
    let shortMarkersMatched = false
    let stopExitCode: number | null = null
    let daemonExited = false
    let stateRemoved = false
    // 测试配置独立于用户文件；profile/state 显式传入子进程，不依赖 TUI 的旧认证配置。
    const config = path.join(root, `e2e-config-${process.pid}.json`)
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", script] } } }))
    // 复用后端公开事务入口，保留长音频末端 marker 与下一次录音隔离的真实验证。
    const target: VoiceTarget = { config, key: "chatgpt", interpreter: "node", script, environment: {
      CHATGPT_STATE_DIR: state, CHATGPT_BROWSER_USER_DATA_DIR: process.env.CHATGPT_BROWSER_USER_DATA_DIR,
    } }
    const controller = createVoiceInputController({
      transcribe: (file, signal) => transcribeVoiceFile(file, target, signal),
      startRecorder: async () => {
        const file = files.shift()
        if (!file) throw new Error("voice E2E fixture queue is empty")
        return {
          file,
          stop: async () => {},
          // controller最终cleanup必须删除实际交给子进程的WAV，成功和timeout共用同一隐私边界。
          abort: async () => fs.rm(file, { force: true }),
        }
      },
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
    })
    try {
      await controller.toggle()
      await controller.toggle()
      expect(controller.status()).toEqual({ type: "idle" })
      longRemoved = !(await Bun.file(long).exists())
      expect(longRemoved).toBe(true)
      // 长音频必须返回只存在于本fixture末端的两个marker；任意非空或short旧结果都不能证明末端被处理。
      if (errors.length > 0) throw new Error(`five-minute voice failed: ${errors.join(" | ")}`)
      const longText = inserted[0]?.toLowerCase() ?? ""
      longMarkersMatched = longText.includes("purple") && longText.includes("orange")
      expect(longText).toContain("purple")
      expect(longText).toContain("orange")

      const errorsBeforeShort = errors.length
      await controller.toggle()
      await controller.toggle()
      expect(controller.status()).toEqual({ type: "idle" })
      shortRemoved = !(await Bun.file(short).exists())
      expect(shortRemoved).toBe(true)
      if (errors.length !== errorsBeforeShort) throw new Error(`subsequent short voice failed: ${errors.slice(errorsBeforeShort).join(" | ")}`)
      // short使用另一组独立expected，确保第二次结果不是long marker的迟到回放。
      const shortText = inserted.at(-1)?.toLowerCase() ?? ""
      shortMarkersMatched = shortText.includes("hello") && shortText.includes("world")
      expect(shortText).toContain("hello")
      expect(shortText).toContain("world")
      completed = true
    } finally {
      // 任一marker断言失败也必须先删除音频，再处理daemon；敏感WAV不能依赖成功路径清理。
      await fs.rm(long, { force: true })
      await fs.rm(short, { force: true })
      await fs.rm(markerAiff, { force: true })
      await fs.rm(marker, { force: true })
      await fs.rm(config, { force: true })
      try {
        const daemon = await Bun.file(path.join(state, "daemon.json")).json().catch(() => null) as { pid?: number } | null
        // stop走真实CLI ownership：shared CDP只disconnect，owned browser才关闭自身窗口。
        const stop = Bun.spawn(["node", script, "--stop"], { cwd: agent, env: process.env, stdout: "ignore", stderr: "ignore" })
        stopExitCode = await stop.exited
        if (stopExitCode !== 0) throw new Error("voice E2E could not stop its isolated daemon")
        // 不能只相信stop退出码；精确旧PID仍存活时profile锁尚未安全释放。
        const daemonAlive = () => {
          if (!daemon?.pid) return false
          try { process.kill(daemon.pid, 0); return true }
          catch { return false }
        }
        const deadline = Date.now() + 10_000
        while (daemonAlive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        daemonExited = !daemonAlive()
        if (!daemonExited) throw new Error(`voice E2E daemon ${daemon?.pid} did not exit after stop`)
      } finally {
        // state只能在daemon真实退出后删除；恢复调用方环境保证同进程其它测试不受影响。
        await fs.rm(state, { recursive: true, force: true })
        if (previousState === undefined) delete process.env.CHATGPT_STATE_DIR
        else process.env.CHATGPT_STATE_DIR = previousState
        // state删除是证据合同的一部分，防止本地bearer索引或测试PID残留在临时目录。
        stateRemoved = await fs.stat(state).then(() => false, () => true)
        if (evidence) {
          await fs.mkdir(path.dirname(evidence), { recursive: true })
          // 可选本地证据只保留布尔结果和长度；普通CI不登录，也不依赖任何被忽略目录。
          await Bun.write(evidence, JSON.stringify({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            command: 'CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> bun test tui-control-voice.test.ts --test-name-pattern "five-minute WAV"',
            // Cookie 直连成功不必启动 browser daemon；若曾启动，仍必须证明精确 PID 已退出。
            status: completed && stopExitCode === 0 && daemonExited && stateRemoved ? "passed" : "failed",
            elapsedMs: Date.now() - startedAt,
            long: { durationSeconds: 300, markersMatched: longMarkersMatched, chars: inserted[0]?.trim().length ?? 0, wavRemoved: longRemoved },
            short: { markersMatched: shortMarkersMatched, chars: inserted.at(-1)?.trim().length ?? 0, wavRemoved: shortRemoved },
            cleanup: { stopExitCode, daemonExited, stateRemoved },
          }, null, 2) + "\n")
        }
      }
    }
  },
  240_000,
)

// 双重 opt-in 才允许关闭真实默认 MCP；普通 CI 和旧隔离 profile 用例不改变生命周期。
defaultProfileE2E(
  "accepts the actual default MCP profile and browser snapshots across subsequent requests",
  async () => {
    const userConfig = process.env.CHATGPT_VOICE_USER_CONFIG
    if (process.platform !== "win32" || !userConfig || !process.env.LOCALAPPDATA) throw new Error("Default profile acceptance requires explicit Windows user config")
    const configured = await resolveVoiceTarget([userConfig])
    const environment = { ...process.env, ...configured.environment }
    // 非默认 profile/CDP 不能借本测试获得关闭授权；配置读取只用于绑定真实 Node 和 CLI。
    for (const key of ["CHATGPT_STATE_DIR", "CHATGPT_BROWSER_USER_DATA_DIR", "CHATGPT_BROWSER_PROFILE_DIRECTORY", "CHATGPT_BROWSER_CDP_URL", "CHATGPT_BROWSER_WS_ENDPOINT", "CHATGPT_BROWSER_DEBUG_PORT", "OPENCODE_DATA_DIR"]) {
      if (environment[key]) throw new Error("Default profile acceptance refuses overridden browser ownership")
    }
    const state = path.join(process.env.LOCALAPPDATA, "opencode", "chatgpt-browser-agent", "state")
    // 保留原字节用于最终比较，证明 fixture 写回没有误伤用户配置中的旧认证或其他设置。
    const originalConfig = Buffer.from(await Bun.file(userConfig).arrayBuffer())
    // 凭据只经过内存管道；CLI 的完整 stdout/stderr 不进入测试断言或错误报告。
    const cli = (args: string[]) => Process.run([configured.interpreter, configured.script, ...args], {
      env: configured.environment, nothrow: true, killTree: false, abort: AbortSignal.timeout(120_000),
    })
    const status = async () => {
      const daemon = await Bun.file(path.join(state, "daemon.json")).json()
      // 本地管理Bearer只发到回环地址；外部Bearer必须来自本次浏览器成功快照，不能混用。
      const response = await fetch(`http://127.0.0.1:${daemon.port}/status`, {
        headers: { authorization: `Bearer ${daemon.token}` }, signal: AbortSignal.timeout(5_000),
      })
      const body = await response.json()
      // 重读状态文件并校验 daemonID，避免旧端口被复用后对错误进程执行生命周期操作。
      if (!response.ok || body.daemonID !== daemon.daemonID) throw new Error("MCP status identity failed")
      return { ...body, version: daemon.version }
    }
    const before = await status()
    // ask 锁、pending 和 voice 队列都必须为空；仅 CLI 摘要的 Active locks 不足以证明可停。
    expect(before.browserConnected === true && before.activeLocks === 0 && before.pendingPageCount === 0 && before.voiceActive === 0 && before.voiceQueued === 0).toBe(true)
    const browser = await Bun.file(path.join(state, "browser-pid.json")).json()
    expect(Number.isInteger(browser.pid) && Number.isInteger(before.pid)).toBe(true)
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const root = path.join(os.tmpdir(), "opencode", "voice")
    await fs.mkdir(root, { recursive: true })
    const directory = await fs.mkdtemp(path.join(root, "default-profile-acceptance-"))
    const wav = path.join(directory, "hello.wav")
    const config = path.join(directory, "opencode.json")
    // 只替换写回目的地，解释器、脚本和 MCP 环境全部沿真实配置，避免隔离 state 偷换实际 profile。
    const target = { ...configured, config }
    const failures: string[] = []
    let stopped = false
    let restored = before.browserConnected === true
    try {
      // Windows 不执行 POSIX mode；取消继承并仅授权当前账户，保证临时 auth 配置是私有文件。
      const acl = await Process.run(["icacls", directory, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(OI)(CI)F`], { nothrow: true })
      expect(acl.code).toBe(0)
      await fs.copyFile(path.join(path.dirname(configured.script), "test-voice-hello.wav"), wav)
      expect((await cli(["--stop"])).code).toBe(0)
      stopped = true
      restored = false
      const deadline = Date.now() + 35_000
      // 等待精确记录的两个 PID 退出，不能把 stop 的 HTTP 接受当作 Cookie 已落盘。
      while ((alive(before.pid) || alive(browser.pid)) && Date.now() < deadline) await Bun.sleep(100)
      expect(alive(before.pid) || alive(browser.pid)).toBe(false)
      console.log(JSON.stringify({ profileClosed: true }))
      for (const scenario of ["profile", "browser"] as const) {
        const evidence = { scenario, exportCode: -1, exportedCookies: 0, profileCookieOnly: false, directStatuses: [] as number[], bearerSent: [] as boolean[], snapshotReused: true, helloWorld: [] as boolean[], persistedCookies: 0, persistedBearer: false, browserSubmitted: 0, daemonVersion: 0, challenge: false, retryAfterSeconds: 0, proxyRouted: false, errorJson: false, rateLimited: false, authRejected: false }
        // 前一个真实场景可能触发浏览器回退；只比较本场景增量，不把累计提交误判为重复发送。
        const initialSubmitted = await status().then((value) => value.voiceSubmitted, () => 0)
        // 原网络实现始终留存；仅 browser 场景首个外部请求注入 503，不伪造成功正文。
        const originalFetch = NetworkProxy.fetch
        let requests = 0
        let saved: Awaited<ReturnType<typeof readVoiceAuth>>
        const transport = spyOn(NetworkProxy, "fetch").mockImplementation(async (url, init) => {
          requests++
          const headers = new Headers(init?.headers)
          evidence.bearerSent.push(headers.has("authorization"))
          // R12同时比对Cookie和实际落盘Bearer；只断言布尔值，失败也不能打印认证头。
          if (saved) evidence.snapshotReused &&= headers.get("cookie") === Object.entries(saved.cookies).filter(([, c]) => c.expires <= 0 || c.expires > Date.now() / 1000).map(([name, c]) => `${name}=${c.value}`).join("; ") && headers.get("authorization") === (saved.access_token ? `Bearer ${saved.access_token}` : null)
          if (scenario === "browser" && requests === 1) { evidence.directStatuses.push(503); return new Response(null, { status: 503 }) }
          const response = await originalFetch(url, init)
          evidence.directStatuses.push(response.status)
          evidence.challenge ||= response.headers.get("cf-mitigated") === "challenge"
          evidence.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0
          // 只观察既有请求的错误副本，不增加远端重试；正文只转成已知类别布尔值。
          if (!response.ok) {
            const body = await response.clone().text()
            evidence.proxyRouted = (await NetworkProxy.resolveProxyRoute(String(url), "provider")).type === "proxy"
            evidence.errorJson ||= (response.headers.get("content-type") ?? "").includes("application/json")
            evidence.rateLimited ||= /rate.limit|too many requests|quota|limit for dictation without an account/i.test(body)
            evidence.authRejected ||= /unauthorized|invalid.token|expired.token|authentication.required/i.test(body)
          }
          return response
        })
        try {
          // 绝不复制用户旧 auth：profile 从缺席开始，browser 从空节点进入受控 503。
          await Bun.write(config, JSON.stringify({ mcp: { [target.key]: scenario === "profile" ? {} : { auth: { cookies: {}, fetched_at: new Date().toISOString() } } } }))
          if (scenario === "profile") {
            const exported = await cli(["auth-export", "--json"])
            evidence.exportCode = exported.code
            if (exported.code !== 0) {
              // 只分类已知环境错误，避免 Node 或远端错误意外携带凭据正文。
              failures.push(exported.stderr.includes("unable to open database") ? "profile:sqlite-open" : "profile:export-failed")
              continue
            }
            // 独立导出只证明关闭后的 reader 可用；后端必须自行再次收割，测试不向它注入导出结果。
            const payload = JSON.parse(exported.stdout.toString())
            evidence.exportedCookies = payload.cookies.length
            evidence.profileCookieOnly = payload.accessToken === undefined && payload.access_token === undefined
            expect(evidence.exportedCookies > 0).toBe(true)
            expect(evidence.profileCookieOnly).toBe(true)
          }
          for (let call = 0; call < 2; call++) {
            const text = await transcribeVoiceFile(wav, target, AbortSignal.timeout(120_000))
            // 独立已知音频 marker 排除空文字或错误页被视作成功，日志只保留匹配布尔值。
            evidence.helloWorld.push(/hello/i.test(text) && /world/i.test(text))
            expect(evidence.helloWorld.at(-1)).toBe(true)
            const auth = await readVoiceAuth(config, target.key)
            evidence.persistedCookies = Object.keys(auth?.cookies ?? {}).length
            evidence.persistedBearer = typeof auth?.access_token === "string" && auth.access_token.length > 0
            expect(evidence.persistedCookies > 0).toBe(true)
            if (call === 0) saved = auth
            // profile匿名额度不足可进入浏览器；后继请求必须只复用该次成功写回的完整快照。
            if (await Bun.file(path.join(state, "daemon.json")).exists()) {
              const current = await status()
              evidence.browserSubmitted = current.voiceSubmitted - initialSubmitted
              evidence.daemonVersion = current.version
              restored = current.browserConnected === true
              expect(evidence.daemonVersion).toBe(26)
            }
          }
          // 保留R11的429红信号；R12修复的是后继账户请求，不把首次匿名失败伪装成200。
          const recovered = scenario === "browser" || evidence.directStatuses[0] === 429
          expect(evidence.browserSubmitted).toBe(recovered ? 1 : 0)
          expect(evidence.snapshotReused).toBe(true)
          expect(evidence.persistedBearer).toBe(recovered)
          expect(evidence.bearerSent).toEqual([false, recovered])
          // profile匿名额度尚可用时允许200；两种输入域的第二次实际直连都必须200且不再提交浏览器。
          expect(evidence.directStatuses).toEqual(scenario === "profile" ? [recovered ? 429 : 200, 200] : [503, 200])
        } catch {
          // 测试失败仍继续另一条真实链路；不把凭据对象或响应文本放入 Bun 的失败快照。
          failures.push(`${scenario}:acceptance-failed`)
        } finally {
          // 场景异常也恢复网络 seam，首个 503 注入不得污染后继场景或同进程普通测试。
          transport.mockRestore()
          console.log(JSON.stringify(evidence))
        }
      }
    } finally {
      // profile 失败也必须恢复正常 MCP；仅真实转录启动既有 CLI，不发送 ask 或改写登录状态。
      try {
        if (stopped && !restored) {
          const result = await cli(["transcribe-file", "--file", wav, "--json"])
          console.log(JSON.stringify({ restoreVoiceExitCode: result.code }))
          restored = await status().then((value) => value.browserConnected === true, () => false)
        }
      } finally {
        // 即使恢复命令超时也必须清除私有配置；真实 profile 和正常 daemon 始终保留。
        await fs.rm(directory, { recursive: true, force: true })
      }
      const configUnchanged = originalConfig.equals(Buffer.from(await Bun.file(userConfig).arrayBuffer()))
      const temporaryRemoved = !await Bun.file(config).exists() && !await Bun.file(wav).exists()
      // 连接可用还不足以证明清理完成；voice队列和ask锁都归零才交还正常MCP。
      const finalStatus = await status()
      const idle = finalStatus.activeLocks === 0 && finalStatus.pendingPageCount === 0 && finalStatus.voiceActive === 0 && finalStatus.voiceQueued === 0
      console.log(JSON.stringify({ restored, idle, configUnchanged, temporaryRemoved }))
      expect(restored && idle && configUnchanged && temporaryRemoved).toBe(true)
    }
    expect(failures).toEqual([])
  },
  360_000,
)

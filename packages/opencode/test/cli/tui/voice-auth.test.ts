import { describe, expect, spyOn, test } from "bun:test"
import Http from "node:http"
import fs from "node:fs/promises"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import * as TuiControl from "../../../src/server/shared/tui-control"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { ConfigParse } from "../../../src/config/parse"
import { ConfigMCP } from "../../../src/config/mcp"
import { withTimeout } from "../../../src/util/timeout"
import {
  authFromHarvest,
  buildDirectTranscribeRequest,
  readVoiceAuth,
  VOICE_TRANSCRIBE_URL,
  writeVoiceAuth,
  type VoiceAuth,
} from "../../../src/server/shared/tui-control"

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
    expect(await readVoiceAuth(config, "unknown-key")).toBeUndefined()

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
    const decoded = ConfigParse.schema(ConfigMCP.Info, server, config)
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

})

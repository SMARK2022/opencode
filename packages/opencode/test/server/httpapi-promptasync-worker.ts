import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"

type ServerPath = "default" | "raw"
type App = {
  fetch: (request: Request) => Response | Promise<Response>
}
// stdout 的 JSON 是父测试唯一消费的 public behavior 快照，字段必须来自 SDK 响应而非内部表。
type PromptAsyncWorkerResult = {
  statuses: {
    session: number
    prompt: number
    asyncPrompt: number
    messages: number
    requestUsage: number
  }
  promptRole: string
  messageCount: number
  messageTexts: string[]
  requestUsageStatus: string
}

// 列表与 test/preload.ts 保持同步，清理 inherited env 是隔离契约而不是 provider fallback。
const credentials = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENROUTER_API_KEY",
  "LLM_GATEWAY_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
] as const

const [rawServerPath, dbPath] = process.argv.slice(2)

// argv 是父测试与 worker 之间的最小协议，未知 path 必须失败而不能静默回到 default。
function requireServerPath(input: string | undefined): ServerPath {
  if (input === "default" || input === "raw") return input
  throw new Error(`invalid server path: ${input}`)
}

const serverPath = requireServerPath(rawServerPath)
if (!dbPath || !path.isAbsolute(dbPath)) throw new Error(`worker DB path must be absolute: ${dbPath}`)

async function prepareEnvironment(databasePath: string) {
  const root = path.dirname(databasePath)
  // 父测试只传入唯一根目录下的 DB 文件，worker 负责让该根目录成为完整资源边界。
  // 所有 XDG 子目录共享该根目录，失败时可以一次性回收而不触碰 parent 的测试数据。
  const xdg = {
    data: path.join(root, "share"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  }

  // xdg-basedir 和 Flag 会在模块加载时读取环境变量，必须在任何 src import 前建立隔离边界。
  process.env["XDG_DATA_HOME"] = xdg.data
  process.env["XDG_CACHE_HOME"] = xdg.cache
  process.env["XDG_CONFIG_HOME"] = xdg.config
  process.env["XDG_STATE_HOME"] = xdg.state
  // worker 复用仓库 fixture 的模型描述，避免子进程读取开发者机器上的 models.json。
  process.env["OPENCODE_MODELS_PATH"] = path.join(import.meta.dir, "..", "tool", "fixtures", "models-api.json")
  // 这两个开关是现有 Bun preload 的行为契约，不能因换成子进程而改变路由初始化。
  process.env["OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
  process.env["OPENCODE_EXPERIMENTAL_WORKSPACES"] = "true"
  // 测试 home 与 managed config 分开，防止用户目录中的 skill 或系统配置影响 Agent 解析。
  process.env["OPENCODE_TEST_HOME"] = path.join(root, "home")
  process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = path.join(root, "managed")
  // cache version 文件阻止全局初始化清空本次 worker 的隔离 cache。
  await mkdir(path.join(xdg.cache, "opencode"), { recursive: true })
  await Bun.write(path.join(xdg.cache, "opencode", "version"), "14")
  // 子进程必须清除继承的 provider/auth，避免 CI secret 改变 build Agent 的模型选择。
  for (const name of credentials) delete process.env[name]
  // 数据库路径由父测试生成且是绝对路径，确保 child 的 SQLite client 不回到 preload 数据库。
  process.env["OPENCODE_DB"] = databasePath

  // 配置依赖标记属于测试启动契约，先写入再加载任何会触发 Config 的生产模块。
  await mkdir(xdg.config, { recursive: true })
  const { markConfigDependenciesInstalled } = await import("../fixture/plugin-deps")
  await markConfigDependenciesInstalled(path.join(xdg.config, "opencode"))
}

async function initializeSource() {
  // 关闭日志 stdout，保证 worker 的 stdout 只承载最终 JSON，而错误仍通过 stderr 传播。
  // 日志仍写入 worker-local 文件，保留诊断能力但不污染父测试的 JSON parser。
  const { Log } = await import("@opencode-ai/core/util/log")
  await Log.init({ print: false, dev: true, level: "DEBUG" })
  // Projector 必须在请求进入前注册，否则 public messages 可能缺少测试 preload 的事件转换行为。
  const { initProjectors } = await import("../../src/server/projectors")
  initProjectors()
}

async function createApp(input: ServerPath): Promise<App> {
  // default/raw 共享这里的 client、project 和观察逻辑，差异只保留在批准的 route realization。
  if (input === "default") {
    const { Server } = await import("../../src/server/server")
    return Server.Default().app
  }

  // raw route 使用与父测试相同的 HttpApiApp.routes，只改变 app 装配方式而不改变 endpoint。
  const { ConfigProvider, Layer } = await import("effect")
  const { HttpRouter } = await import("effect/unstable/http")
  const { HttpApiApp } = await import("../../src/server/routes/instance/httpapi/server")
  // 清空认证配置后再显式提供 undefined，确保 raw path 不读取父进程的 server password。
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: undefined,
            OPENCODE_SERVER_USERNAME: undefined,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return { fetch: (request) => handler(request, HttpApiApp.context) }
}

function createClient(app: App, directory: string) {
  // 通过 SDK 的 fetch seam 注入同一 app，测试覆盖 generated SDK 到真实 HttpApi handler 的完整调用链。
  // 虚拟 base URL 只用于 SDK 构造 Request，实际传输仍由当前 worker 的 HttpApi app 接收。
  const fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(request instanceof Request ? request : new Request(request, init)),
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
  return createOpencodeClient({ baseUrl: "http://localhost", directory, fetch })
}

async function runScenario(input: { path: ServerPath; directory: string }): Promise<PromptAsyncWorkerResult> {
  const { pollWithTimeout } = await import("../lib/effect")
  const sdk = createClient(await createApp(input.path), input.directory)
  // 先执行同步 noReply，再执行 async noReply，与原 parity 场景保持相同的 accepted-operation 顺序。
  const session = await sdk.session.create({ title: "prompt" })
  if (session.response.status !== 200 || !session.data)
    throw new Error(`session create failed: ${session.response.status}`)
  const sessionID = session.data.id
  const prompt = await sdk.session.prompt({
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "hello" }],
  })
  if (prompt.response.status !== 200 || !prompt.data) throw new Error(`prompt failed: ${prompt.response.status}`)
  // 204 只表示 async request 已被接受，不能作为 Message 或 usage 已完成的替代断言。
  const asyncPrompt = await sdk.session.promptAsync({
    sessionID,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "async hello" }],
  })
  const completed = await Effect.runPromise(
    // pollWithTimeout 等待公开状态变化，而不是用固定时长猜测后台 fiber 的调度速度。
    pollWithTimeout(
      Effect.promise(async () => {
        const messages = await sdk.session.messages({ sessionID })
        if (messages.response.status !== 200 || !messages.data) return undefined
        // 先从 public Message 找到 requestID，再查询对应 usage，避免直读 SQLite 或复制生产 ID 算法。
        const asyncMessage = messages.data.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "async hello"),
        )
        if (!asyncMessage) return undefined
        const requestUsage = await sdk.session.requestUsage.get({
          sessionID,
          requestID: asyncMessage.info.id,
        })
        // 未生成或仍为 running 的 usage 继续等待，HTTP 错误不能被转换成成功结果。
        if (requestUsage.response.status !== 200 || !requestUsage.data || requestUsage.data.status !== "completed") {
          return undefined
        }
        return { messages, requestUsage }
      }),
      `${input.path} promptAsync public state was not persisted`,
      "10 seconds",
    ),
  )
  const messageTexts = completed.messages.data
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .sort()
  // 这些 literal 是跨 default/raw 的独立行为期望，不从生产返回值动态生成，防止测试自证正确。
  if (asyncPrompt.response.status !== 204) throw new Error(`promptAsync failed: ${asyncPrompt.response.status}`)
  const promptRole = String(prompt.data.info.role)
  if (promptRole !== "user") throw new Error(`unexpected prompt role: ${promptRole}`)
  if (completed.messages.data.length !== 2)
    throw new Error(`unexpected message count: ${completed.messages.data.length}`)
  if (JSON.stringify(messageTexts) !== JSON.stringify(["async hello", "hello"])) {
    throw new Error(`unexpected message texts: ${JSON.stringify(messageTexts)}`)
  }
  if (completed.requestUsage.data.status !== "completed") throw new Error("request usage did not complete")
  // 返回完整状态而不是只返回文本，使父测试同时比较 HTTP、Message 和 usage 三类行为。
  return {
    statuses: {
      session: session.response.status,
      prompt: prompt.response.status,
      asyncPrompt: asyncPrompt.response.status,
      messages: completed.messages.response.status,
      requestUsage: completed.requestUsage.response.status,
    },
    promptRole,
    messageCount: completed.messages.data.length,
    messageTexts,
    requestUsageStatus: completed.requestUsage.data.status,
  }
}

async function main(): Promise<PromptAsyncWorkerResult> {
  const root = path.dirname(dbPath)
  let directory: string | undefined
  let closeDatabase: (() => void) | undefined
  let disposeProject: (() => Promise<void>) | undefined
  try {
    await mkdir(root, { recursive: true })
    await prepareEnvironment(dbPath)
    const { tmpdir } = await import("../fixture/fixture")
    // 复用仓库 tmpdir 的 git/config/Windows cleanup 契约，避免 worker 复制另一套项目 fixture 逻辑。
    const project = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false },
      init: async (projectDirectory) => {
        await Bun.write(path.join(projectDirectory, "hello.txt"), "hello")
        await Bun.write(path.join(projectDirectory, "needle.ts"), "export const needle = 'sdk-parity'\n")
      },
    })
    directory = project.path
    disposeProject = () => project[Symbol.asyncDispose]()
    await initializeSource()
    // 只在环境边界完成后加载生产 Database，避免模块级 Flag 缓存错误路径。
    const { Database } = await import("../../src/storage/db")
    closeDatabase = () => Database.close()
    return await runScenario({ path: serverPath, directory })
  } finally {
    // public terminal state 已观察后再释放 instance，避免 teardown 重新与 promptAsync fork 竞争。
    // 先释放生产 instance，再关闭 SQLite，最后清理临时目录，保持资源 owner 的逆序释放。
    if (directory) {
      const { disposeInstance } = await import("../../src/effect/instance-registry")
      await disposeInstance(directory)
    }
    closeDatabase?.()
    await disposeProject?.()
    // 子进程拥有整个临时根目录；移除它可避免 Windows WAL/SHM 文件泄漏到后续测试。
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}

try {
  const result = await main()
  // 生产 app 的全局 memoized runtime 可能留下非阻塞句柄；清理完成后显式退出，避免父测试永远等待 child。
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(0)
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  // 失败只写 stderr 并返回非零；父测试不能从半成品 stdout 推导成功。
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

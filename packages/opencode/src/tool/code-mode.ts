import { Tool } from "./tool"
import { Cause, Effect, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { isRecord } from "@/util/record"
import type { PermissionPrecheck } from "@/permission/precheck"
import { MAX_RESPONSE_SIZE } from "./webfetch"
// 保留状态由 Session/Location owner 管理；工具定义只取得服务，不私存跨轮解释器。
import { ExecuteEnvironments } from "./execute-environments"

export const CODE_MODE_TOOL = "execute"

export const Parameters = Schema.Struct({
  // 缺省创建新环境，显式 ID 只能恢复对应 owner 的现存环境，空字符串也不是缺省。
  environmentID: Schema.optionalKey(Schema.String).annotate({ description: "Environment ID from a prior execute result; omit to create a fresh environment." }),
  // 与 Shell 一样由宿主选择毫秒预算；只接受库支持的正安全整数，不引入任意上限。
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))).annotate({
    description: "Maximum execution time in milliseconds (default: 600000).",
  }),
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  // 进度回调替换整个 metadata；ID 必须随每次更新一起保留。
  environmentID: string
  toolCalls: CallEntry[]
  error?: boolean
  loaded?: string[]
  skills?: string[]
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

export type CatalogEntry = {
  // 目录只提供模型可见 schema 与路径，实际工具实现一直留在 SessionTools。
  id: string
  path: readonly [string, string]
  description: string
  inputSchema: JSONSchema7
  // 这是实际宿主 validator 的来源，不替换只负责展示的 JSON input。
  runtimeParameters?: Schema.Decoder<unknown>
  outputSchema?: JSONSchema7 | Schema.Decoder<unknown>
}

export interface CodeModeHost {
  catalog: readonly CatalogEntry[]
  signal: AbortSignal
  begin(code: string, calls: readonly PermissionPrecheck.ExecuteCall[]): Effect.Effect<void>
  invoke(id: string, input: unknown): Effect.Effect<Tool.ExecuteResult, unknown>
  fetch?: (...args: unknown[]) => Effect.Effect<unknown, unknown>
}

const FetchInit = Schema.Struct({ method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Union([Schema.Record(Schema.String, Schema.String), Schema.Array(Schema.Tuple([Schema.String, Schema.String]))])),
  body: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Number)])),
})

// HTTP能力由宿主显式提供；同webfetch权限，沿上游30秒请求预算及V1数据边界。
export const fetchHTTP = Effect.fn("CodeMode.fetch")(function* (input: unknown, options: unknown, ctx: Tool.Context) {
  const url = String(input)
  if (!/^https?:\/\//i.test(url)) return yield* Effect.fail(new Error("fetch requires an HTTP or HTTPS URL."))
  const init = yield* Schema.decodeUnknownEffect(FetchInit)(options ?? {})
  // URLSearchParams已在沙箱转为正文；宿主只接收数据，不能接收可执行对象。
  yield* ctx.ask({ permission: "webfetch", patterns: [url], always: ["*"], metadata: { url, method: init.method?.toUpperCase() ?? "GET" } })
  return yield* Effect.tryPromise({ try: async (signal) => {
    const response = await fetch(url, { method: init.method,
      // 原生Headers保留重复键的HTTP组合语义，不能先折叠成对象丢值。
      headers: init.headers ? new Headers(Array.isArray(init.headers) ? init.headers : Object.entries(init.headers)) : undefined,
      body: init.body === undefined || typeof init.body === "string" ? init.body : Uint8Array.from(init.body),
      // 本次HTTP取消、整段执行终止和请求期限分别约束同一传输。
      signal: AbortSignal.any([signal, ctx.abort, AbortSignal.timeout(30_000)]),
    })
    // 超限按失败传播，不能把截断JSON当成完整业务响应交给脚本。
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)")
    // 三种读取方法共享同一响应快照，不会重新下载或读取第二次响应体。
    return { url: response.url, status: response.status, statusText: response.statusText, ok: response.ok, redirected: response.redirected,
      headers: Object.fromEntries(response.headers), text: new TextDecoder().decode(bytes), bytes: Array.from(bytes) }
  }, catch: (error) => error })
})

const toolTree = Effect.fn("CodeMode.toolTree")(function* (
  catalog: readonly CatalogEntry[],
  run: (entry: CatalogEntry, input: unknown) => Effect.Effect<unknown, unknown>,
) {
  // 目录与执行共用工具定义，真实调用仍由宿主run进入原执行路径。
  const sandbox = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  const tree: Record<string, Record<string, import("@opencode-ai/codemode").Tool.Definition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.path[0]] ??= {})
    namespace[entry.path[1]] = sandbox.Tool.make({
      description: entry.description,
      // 沿用 V1 原 JSON Schema 签名适配：对象原样透传，真实输入校验仍由工具拥有。
      input: entry.inputSchema as import("@opencode-ai/codemode").Tool.JsonSchema,
      // 完整实际合同统一生成签名、字段索引与快捷形式，真实解码仍只由宿主执行。
      inputContract: entry.runtimeParameters,
      output: entry.outputSchema as import("@opencode-ai/codemode").Tool.SchemaType | undefined,
      run: (input) => run(entry, input).pipe(Effect.catchCause((cause) => {
        // 权限终止和用户取消须穿透 interpreter；普通异常才进入脚本可捕获的错误域。
        if (Cause.hasInterrupts(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.fail(sandbox.toolError(error instanceof Error ? error.message : String(error), error))
      })),
    })
  }
  return tree
})

// 来自当前过滤目录的原 schema 才证明 native 来源；同名 MCP/自定义条目没有隐式优先权。
const discovery = (catalog: readonly CatalogEntry[]) => ({
  priority: catalog.filter((entry) => entry.runtimeParameters && entry.path[0] === "$opencode" && ["read", "grep", "glob", "edit"].includes(entry.id))
    .map((entry) => entry.path.join(".")),
})

export const describeCatalog = Effect.fn("CodeMode.describeCatalog")(function* (catalog: readonly CatalogEntry[]) {
  // 目录说明与执行共享同一树形入口，搜索结果不会广告另一套能力。
  const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  const tools = yield* toolTree(catalog, () => Effect.die("Catalog preview is not executable."))
  return CodeMode.make({ tools, discovery: discovery(catalog) }).instructions()
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
    const environments = yield* ExecuteEnvironments.Service
    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      // 宿主才拥有环境句柄；共享库说明仍适用于无 Session 的一次性执行。
      description: `${CodeMode.description}\nReuse the returned environmentID to continue with saved variables and functions; omit it for a fresh environment. Schema-less MCP object/array JSON text becomes data; use String(value) for its original text.`,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        // 只去除完整且唯一的 JS/TS 外层围栏；混合文本、内层围栏及其它标签仍交给原编译器。
        const fenced = params.code.trim().match(/^```(?:js|javascript|ts|typescript)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
        const code = fenced && !fenced[1].includes("```") ? fenced[1] : params.code
        const host = ctx.codeMode
        if (!host) return yield* Effect.die(new Error("execute requires the current Session tool host."))
        if (host.signal.aborted) return yield* Effect.interrupt
        const abort = Effect.callback<never>((resume) => {
          if (host.signal.aborted) return resume(Effect.interrupt)
          const handler = () => resume(Effect.interrupt)
          host.signal.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => host.signal.removeEventListener("abort", handler))
        })
        // 外层取消覆盖排队中的 lease；持有者根作用域完成清理后 registry 才释放同环境串行门。
        return yield* Effect.raceFirst(environments.use(ctx.sessionID, params.environmentID, (lease) => Effect.gen(function* () {
          const calls: CallEntry[] = []
          // 这些数组属于一次调用，后续 execute 重新收集，避免媒体或规则跨调用残留。
          const attachments: Attachment[] = []
          const context = new Map<string, NonNullable<Tool.ExecuteResult["context"]>[number]>()
          const publish = () =>
            ctx.metadata({ title: CODE_MODE_TOOL, metadata: { environmentID: lease.id, output: `Environment: ${lease.id}`, toolCalls: calls.map((c) => ({ ...c })) } })
          // 在任何预跑/审查/调用进度之前同时交付结构化 ID 和错误正文证据，立即取消也可恢复。
          yield* publish()
          const tools = yield* toolTree(host.catalog, (entry, input) => Effect.gen(function* () {
            const result = yield* host.invoke(entry.id, input)
            attachments.push(...(result.program?.attachments ?? result.attachments ?? []))
            for (const item of result.context ?? []) context.set(`${item.kind}:${item.key}`, item)
            // key 只用于去重实际收取的上下文，脚本的聚合 return 不控制这些规则的交付。
            // 宿主已收取附件与指令；JS只消费业务值或原文本，临时真值和UI副本留在宿主。
            // null/false/0均是合法程序值，选择通道时保留这些值自身的语义。
            // 仅处理协议 owner 明确标记的候选；普通字符串/原生结构化值仍保持原类型。
            return result.program?.rawText !== undefined ? CodeMode.fromJsonText(result.program.rawText)
              : result.program ? result.program.value : result.output
          }))
          const runtime = CodeMode.make({
            tools,
            environment: lease.environment,
            // 模型目录与当前运行时搜索共享同一优先集合，不保存上一轮筛选结果。
            discovery: discovery(host.catalog),
            // 十分钟只约束真实执行（含工具/权限等待）；预跑和整段审查保留原有独立边界。
            limits: { timeoutMs: params.timeout ?? 600000 },
            fetch: host.fetch,
            onToolCallStart: ({ index, name, input }) =>
              Effect.suspend(() => {
                const shown = (() => {
                  if (input === null || input === undefined) return
                  // 沿上游fetch display仅记录方法和URL，恢复清单无需复制凭据或请求体。
                  if (name === "$codemode.fetch" && Array.isArray(input)) return {
                    method: isRecord(input[1]) && typeof input[1].method === "string" ? input[1].method.toUpperCase() : "GET",
                    url: String(input[0]),
                  }
                  if (isRecord(input)) return Object.keys(input).length > 0 ? input : undefined
                  return { input }
                })()
                calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
                return publish()
              }),
            onToolCallEnd: ({ index, outcome }) =>
              Effect.suspend(() => {
                const current = calls[index]
                if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
                return publish()
              }),
          })

          // 指令作为宿主上下文交付；即使脚本 return 1，也保留实际加载的规则正文。
          const contextText = () => [...context.values()].map((item) => item.text).join("\n\n")
          const result = yield* Effect.gen(function* () {
            const observed: PermissionPrecheck.ExecuteCall[] = []
            // 预跑始终是新的一次性状态，旧 helper 可以不可见；不能让探测重复修改真实词法状态。
            const probe = yield* toolTree(host.catalog.map((entry) => ({ ...entry, outputSchema: Schema.Null })),
              (entry, input) => Effect.sync(() => { observed.push({ tool: entry.id, input }); return null }))
            // 预跑仍限一秒/128次调用；同一规范化正文参与预检、整段审查与真实执行。
            yield* CodeMode.execute({ code, tools: probe, limits: { timeoutMs: 1000, maxToolCalls: 128 },
              // 预跑只记录HTTP意图，空响应不产生网络或权限副作用。
              fetch: host.fetch ? (url, init) => Effect.sync(() => {
                observed.push({ tool: "webfetch", input: { ...(isRecord(init) ? init : {}), url: String(url) } })
                return { url: String(url), status: 200, statusText: "", ok: true, redirected: false, headers: {}, text: "null", bytes: [] }
              }) : undefined,
            })
            // 审查与执行不能各自去围栏，否则批准的源码可能与实际行为不同。
            // 诊断前捕获的调用仍有分类价值；真实读结果依赖由后续原请求检查覆盖。
            yield* host.begin(code, observed)
            return yield* runtime.execute(code)
          }).pipe(Effect.onExit((exit) => {
            if (exit._tag === "Success" && exit.value.ok) return Effect.void
            // 错误父回执携带已完成事实，processor 保留 error 状态与原 child 记录。
            return ctx.metadata({ metadata: {
              environmentID: lease.id, toolCalls: calls, error: true,
              // 最后的错误更新同样带 ID，不能被 child 进度覆盖后在取消历史里丢失。
              output: [`Environment: ${lease.id}`, contextText(), host.signal.reason instanceof Error ? host.signal.reason.message : ""].filter(Boolean).join("\n\n"),
            } })
          }))
          const logs = result.logs ?? []
          const withLogs = (text: string) => {
            if (logs.length === 0) return text
            return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
          }

          if (!result.ok) {
            // 保留失败类型的宿主出口，错误日志不会被转换成普通成功文本。
            const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
            return yield* Effect.fail(new Error(`Environment: ${lease.id}\n\n${withLogs([result.error.message, ...hints].join("\n"))}`))
          }

          // The interpreter validates returned values as plain JSON, so stringify cannot throw;
          // it yields undefined only for a program that returns undefined.
          const output =
            typeof result.value === "string"
              ? result.value
              : (JSON.stringify(result.value, null, 2) ?? String(result.value))

          // 根作用域已完成清理；只投影已登记调用的终态，不改变 catch/allSettled 的脚本语义。
          const failed = calls.filter((call) => call.status === "error")
          // 最多展示五个完整名称、每个至多两百字符；超长名称计入省略数，不复制参数或私有错误。
          const names = failed.map((call) => call.tool).filter((name) => name.length <= 200).slice(0, 5)
          const receipt = failed.length > 0
            ? `Tool calls: ${calls.filter((call) => call.status === "completed").length} completed; ${failed.length} failed or interrupted.\nFailed or interrupted: ${names.join(", ")}${names.length < failed.length ? ` (${failed.length - names.length} more)` : ""}`
            : ""
          return {
            title: CODE_MODE_TOOL,
            metadata: {
              environmentID: lease.id,
              toolCalls: calls,
              // loaded/skills 只报告父回执实际包含的规则，后续截断仍由共享宿主清除声明。
              loaded: [...context.values()].filter((item) => item.kind === "instruction").map((item) => item.key),
              skills: [...context.values()].filter((item) => item.kind === "skill").map((item) => item.key),
            },
            // ID 独立于脚本值与终态回执，调用者恢复环境时无需从业务 JSON 猜测句柄。
            output: [`Environment: ${lease.id}`, receipt, contextText(), withLogs(receipt ? `Script result:\n${output}` : output)].filter(Boolean).join("\n\n"),
            ...(attachments.length > 0 ? { attachments } : {}),
          } satisfies Tool.ExecuteResult<Metadata>
        })), abort)
      }, Effect.orDie),
    }
    return init
  }),
)

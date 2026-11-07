import { Tool } from "./tool"
import { Cause, Effect, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { isRecord } from "@/util/record"
import type { PermissionPrecheck } from "@/permission/precheck"
import { MAX_RESPONSE_SIZE } from "./webfetch"

export const CODE_MODE_TOOL = "execute"

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
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

export const describeCatalog = Effect.fn("CodeMode.describeCatalog")(function* (catalog: readonly CatalogEntry[]) {
  // 目录说明与执行共享同一树形入口，搜索结果不会广告另一套能力。
  const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  const tools = yield* toolTree(catalog, () => Effect.die("Catalog preview is not executable."))
  return CodeMode.make({ tools }).instructions()
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: CodeMode.description,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        const host = ctx.codeMode
        if (!host) return yield* Effect.die(new Error("execute requires the current Session tool host."))
        if (host.signal.aborted) return yield* Effect.interrupt
        const calls: CallEntry[] = []
        // 这些数组属于一次调用，后续 execute 重新收集，避免媒体或规则跨调用残留。
        const attachments: Attachment[] = []
        const context = new Map<string, NonNullable<Tool.ExecuteResult["context"]>[number]>()
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })
        const tools = yield* toolTree(host.catalog, (entry, input) => Effect.gen(function* () {
          const result = yield* host.invoke(entry.id, input)
          attachments.push(...(result.program?.attachments ?? result.attachments ?? []))
          for (const item of result.context ?? []) context.set(`${item.kind}:${item.key}`, item)
          // key 只用于去重实际收取的上下文，脚本的聚合 return 不控制这些规则的交付。
          // 宿主已收取附件与指令；JS只消费业务值或原文本，临时真值和UI副本留在宿主。
          // null/false/0均是合法程序值，选择通道时保留这些值自身的语义。
          return result.program ? result.program.value : result.output
        }))
        const runtime = CodeMode.make({
          tools,
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

        const abort = Effect.callback<never>((resume) => {
          if (host.signal.aborted) return resume(Effect.interrupt)
          const handler = () => resume(Effect.interrupt)
          host.signal.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => host.signal.removeEventListener("abort", handler))
        })
        // 指令作为宿主上下文交付；即使脚本 return 1，也保留实际加载的规则正文。
        const contextText = () => [...context.values()].map((item) => item.text).join("\n\n")
        const result = yield* Effect.raceFirst(Effect.gen(function* () {
          const observed: PermissionPrecheck.ExecuteCall[] = []
          // 同一解释器与输入声明；预跑桩只记录参数，空返回专属于桩的输出契约。
          const probe = yield* toolTree(host.catalog.map((entry) => ({ ...entry, outputSchema: Schema.Null })),
            (entry, input) => Effect.sync(() => { observed.push({ tool: entry.id, input }); return null }))
          // 空值可能使循环持续：原预算把预检限制在一秒/128次调用内，真实执行保持原预算。
          yield* CodeMode.execute({ code: params.code, tools: probe, limits: { timeoutMs: 1000, maxToolCalls: 128 },
            // 预跑只记录HTTP意图，空响应不产生网络或权限副作用。
            fetch: host.fetch ? (url, init) => Effect.sync(() => {
              observed.push({ tool: "webfetch", input: { ...(isRecord(init) ? init : {}), url: String(url) } })
              return { url: String(url), status: 200, statusText: "", ok: true, redirected: false, headers: {}, text: "null", bytes: [] }
            }) : undefined,
          })
          // 诊断前捕获的调用仍有分类价值；真实读结果依赖由后续原请求检查覆盖。
          yield* host.begin(params.code, observed)
          return yield* runtime.execute(params.code)
        }), abort).pipe(Effect.onExit((exit) => {
          if (exit._tag === "Success" && exit.value.ok) return Effect.void
          // 错误父回执携带已完成事实，processor 保留 error 状态与原 child 记录。
          return ctx.metadata({ metadata: {
            toolCalls: calls, error: true,
            output: [contextText(), host.signal.reason instanceof Error ? host.signal.reason.message : ""].filter(Boolean).join("\n\n"),
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
          return yield* Effect.fail(new Error(withLogs([result.error.message, ...hints].join("\n"))))
        }

        // The interpreter validates returned values as plain JSON, so stringify cannot throw;
        // it yields undefined only for a program that returns undefined.
        const output =
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value, null, 2) ?? String(result.value))

        return {
          title: CODE_MODE_TOOL,
          metadata: {
            toolCalls: calls,
            // loaded/skills 只报告父回执实际包含的规则，后续截断仍由共享宿主清除声明。
            loaded: [...context.values()].filter((item) => item.kind === "instruction").map((item) => item.key),
            skills: [...context.values()].filter((item) => item.kind === "skill").map((item) => item.key),
          },
          output: [contextText(), withLogs(output)].filter(Boolean).join("\n\n"),
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)

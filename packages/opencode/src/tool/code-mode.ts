import { Tool } from "./tool"
import { Truncate } from "./truncate"
import { Cause, Clock, Deferred, Effect, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { isRecord } from "@/util/record"
import type { PermissionPrecheck } from "@/permission/precheck"
import { MAX_RESPONSE_SIZE } from "./webfetch"
import { ExecuteEnvironments } from "./execute-environments"

// 单个预算只属于一次执行；并发人工等待合并成一段暂停时间。
export const makeExecutionBudget = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  let waiting = 0
  let remaining = 0
  let started = clock.currentTimeMillisUnsafe()
  let changed = Deferred.makeUnsafe<void>()
  // 每次唤醒后换一个Deferred，让恢复和下一次暂停不会读到旧信号。
  const signal = () => {
    Deferred.doneUnsafe(changed, Effect.void)
    changed = Deferred.makeUnsafe<void>()
  }
  const wait = (milliseconds: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      // 在真实执行的竞争启动时才计时，创建预算及前置审查不消耗它。
      remaining = milliseconds
      started = clock.currentTimeMillisUnsafe()
      const tick: Effect.Effect<void> = Effect.suspend(() => {
        if (waiting) return Deferred.await(changed).pipe(Effect.andThen(tick))
        const duration = Math.max(0, remaining - (clock.currentTimeMillisUnsafe() - started))
        return Effect.raceFirst(
          Effect.sleep(duration).pipe(Effect.as(true)),
          Deferred.await(changed).pipe(Effect.as(false)),
        ).pipe(Effect.flatMap((expired) => (expired ? Effect.void : tick)))
      })
      return tick
    })
  const pause = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        // 重叠等待只在第一个入口扣除已用时间，避免双重暂停。
        if (waiting++ === 0) {
          remaining -= clock.currentTimeMillisUnsafe() - started
          signal()
        }
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          // 最后一个等待离开才续跑；拒绝和取消也通过release归还计数。
          if (--waiting === 0) {
            started = clock.currentTimeMillisUnsafe()
            signal()
          }
        }),
    )
  return { wait, pause }
})

export const CODE_MODE_TOOL = "execute"

export const Parameters = Schema.Struct({
  // 缺省创建新环境，显式 ID 只能恢复对应 owner 的现存环境，空字符串也不是缺省。
  environmentID: Schema.optionalKey(Schema.String).annotate({
    description: "Environment ID from a prior execute result; omit to create a fresh environment.",
  }),
  // 期限与库内 Effect 计时器的32位毫秒范围一致，避免超大值失去超时约束。
  timeout: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
  ).annotate({
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
  // 目录携带展示资料和原合同引用；执行能力仍由当前 SessionTools 提供。
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
  waitForTimeout?: (milliseconds: number) => Effect.Effect<void>
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
      run: (input) =>
        run(entry, input).pipe(
          Effect.catchCause((cause) => {
            // 权限终止和用户取消须穿透 interpreter；普通异常才进入脚本可捕获的错误域。
            if (Cause.hasInterrupts(cause)) return Effect.interrupt
            const error = Cause.squash(cause)
            return Effect.fail(sandbox.toolError(error instanceof Error ? error.message : String(error), error))
          }),
        ),
    })
  }
  return tree
})

// 来自当前过滤目录的原 schema 才证明 native 来源；同名 MCP/自定义条目没有隐式优先权。
const discovery = (catalog: readonly CatalogEntry[]) => ({
  priority: catalog
    .filter(
      (entry) =>
        entry.runtimeParameters && entry.path[0] === "$opencode" && ["read", "grep", "glob", "edit"].includes(entry.id),
    )
    .map((entry) => entry.path.join(".")),
})

export const describeCatalog = Effect.fn("CodeMode.describeCatalog")(function* (catalog: readonly CatalogEntry[]) {
  const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  const tools = yield* toolTree(catalog, () => Effect.die("Catalog preview is not executable."))
  return CodeMode.make({ tools, discovery: discovery(catalog) }).instructions()
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const { CodeMode } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
    const environments = yield* ExecuteEnvironments.Service
    const truncate = yield* Truncate.Service
    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      // 宿主才拥有环境句柄；共享库说明仍适用于无 Session 的一次性执行。
      description: `${CodeMode.description}\nReuse the returned environmentID to continue with saved variables and functions; omit it for a fresh environment. Schema-less MCP object/array JSON text becomes data; use String(value) for its original text.`,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        // 只去除完整且唯一的 JS/TS 外层围栏；混合文本、内层围栏及其它标签仍交给原编译器。
        const fenced = params.code
          .trim()
          .match(/^```(?:js|javascript|ts|typescript)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
        // 规范化只做一次，预跑、整段权限检查和真实执行必须看到完全相同的源码。
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
        return yield* Effect.raceFirst(
          environments.use(ctx.sessionID, params.environmentID, (lease) =>
            Effect.gen(function* () {
              const outputLimits = yield* truncate.limits()
              const calls: CallEntry[] = []
              const attachments: Attachment[] = []
              // 相同规则在多个子调用出现时只返回最新内容，去重不依赖脚本最终选择的字段。
              const context = new Map<string, NonNullable<Tool.ExecuteResult["context"]>[number]>()
              let lastProgress = -Infinity
              const publish = (delivery: "durable" | "ephemeral" = "ephemeral") =>
                Effect.suspend(() => {
                  const now = performance.now()
                  // 先检查窗口再复制 calls，才能同时省掉发送与整份调用列表快照。
                  if (delivery === "ephemeral" && now - lastProgress < 100) return Effect.void
                  // durable 的环境回执不占进度窗口，第一条真实运行状态仍立即可见。
                  if (delivery === "ephemeral") lastProgress = now
                  return ctx.metadata({
                    delivery,
                    title: CODE_MODE_TOOL,
                    metadata: {
                      environmentID: lease.id,
                      output: `Environment: ${lease.id}`,
                      toolCalls: calls.map((c) => ({ ...c })),
                    },
                  })
                })
              // 在任何预跑/审查/调用进度之前同时交付结构化 ID 和错误正文证据，立即取消也可恢复。
              yield* publish("durable")
              const tools = yield* toolTree(host.catalog, (entry, input) =>
                Effect.gen(function* () {
                  const result = yield* host.invoke(entry.id, input)
                  attachments.push(...(result.program?.attachments ?? result.attachments ?? []))
                  for (const item of result.context ?? []) context.set(`${item.kind}:${item.key}`, item)
                  // 附件与强制上下文由宿主收集，context 按 kind:key 去重，独立于脚本 return。
                  // 只有协议标记的 rawText 进入 JSON 投影；其他程序值原样交付，包括 null、false 和 0。
                  return result.program?.rawText !== undefined
                    ? CodeMode.fromJsonText(result.program.rawText)
                    : result.program
                      ? result.program.value
                      : result.output
                }),
              )
              const runtime = CodeMode.make({
                tools,
                environment: lease.environment,
                discovery: discovery(host.catalog),
                // 十分钟约束真实执行；人类输入与权限审批暂停预算，预跑和整段审查在计时前。
                limits: { timeoutMs: params.timeout ?? 600000, maxLogBytes: outputLimits.maxBytes },
                fetch: host.fetch,
                waitForTimeout: host.waitForTimeout,
                onToolCallStart: ({ index, name, input }) =>
                  Effect.suspend(() => {
                    const shown = (() => {
                      if (input === null || input === undefined) return
                      // 沿上游fetch display仅记录方法和URL，恢复清单无需复制凭据或请求体。
                      if (name === "$codemode.fetch" && Array.isArray(input))
                        return {
                          method:
                            isRecord(input[1]) && typeof input[1].method === "string"
                              ? input[1].method.toUpperCase()
                              : "GET",
                          url: String(input[0]),
                        }
                      if (isRecord(input)) return Object.keys(input).length > 0 ? input : undefined
                      return { input }
                    })()
                    // 用启动时分配的 index 更新原条目，完成顺序倒置也不会串到另一个调用。
                    calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
                    // 即使本次父进度被合并，调用事实已写入 calls，最终回执仍包含全部项。
                    return publish()
                  }),
                onToolCallEnd: ({ index, outcome }) =>
                  Effect.suspend(() => {
                    const current = calls[index]
                    if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
                    return publish()
                  }),
              })

              const contextText = () => [...context.values()].map((item) => item.text).join("\n\n")
              const result = yield* Effect.gen(function* () {
                const observed: PermissionPrecheck.ExecuteCall[] = []
                // 在租约内复制一次环境；旧 helper 只修改副本，根作用域结束后释放。
                const probe = yield* toolTree(
                  host.catalog.map((entry) => ({ ...entry, outputSchema: Schema.Null })),
                  (entry, input) =>
                    Effect.sync(() => {
                      observed.push({ tool: entry.id, input })
                      return null
                    }),
                )
                // 探针只设两秒执行期限；未跑到的调用仍由真实执行的权限入口处理。
                yield* CodeMode.execute({
                  code,
                  tools: probe,
                  environment: lease.environment,
                  snapshotEnvironment: true,
                  // 探针只发现调用，不重复真实脚本的轮询等待；Promise 仍由同一根作用域收尾。
                  sleep: () => Effect.void,
                  limits: { timeoutMs: 2000, maxLogBytes: outputLimits.maxBytes },
                  // 预跑只记录HTTP意图，空响应不产生网络或权限副作用。
                  fetch: host.fetch
                    ? (url, init) =>
                        Effect.sync(() => {
                          observed.push({
                            tool: "webfetch",
                            input: { ...(isRecord(init) ? init : {}), url: String(url) },
                          })
                          return {
                            url: String(url),
                            status: 200,
                            statusText: "",
                            ok: true,
                            redirected: false,
                            headers: {},
                            text: "null",
                            bytes: [],
                          }
                        })
                    : undefined,
                })
                // 诊断前捕获的调用仍有分类价值；真实读结果依赖由后续原请求检查覆盖。
                yield* host.begin(code, observed)
                return yield* runtime.execute(code)
              }).pipe(
                Effect.onExit((exit) => {
                  // 成功由返回的 ToolResult 持久化；这里再发布一次会重复完整终态写入。
                  if (exit._tag === "Success" && exit.value.ok) return Effect.void
                  // 错误父回执携带已完成事实，processor 保留 error 状态与原 child 记录。
                  return ctx.metadata({
                    metadata: {
                      environmentID: lease.id,
                      toolCalls: calls,
                      error: true,
                      output: [
                        `Environment: ${lease.id}`,
                        contextText(),
                        host.signal.reason instanceof Error ? host.signal.reason.message : "",
                      ]
                        .filter(Boolean)
                        .join("\n\n"),
                    },
                  })
                }),
              )
              const logs = result.logs ?? []
              // 日志与业务结果分栏，纯日志脚本也保留输出；两者最后共同经过统一截断。
              const withLogs = (text: string) => {
                if (logs.length === 0) return text
                return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
              }

              if (!result.ok) {
                // namespace 恢复签名可直接随原错误交付，已在正文中的提示不重复占上下文。
                const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
                return yield* Effect.fail(
                  new Error(`Environment: ${lease.id}\n\n${withLogs([result.error.message, ...hints].join("\n"))}`),
                )
              }

              // The interpreter validates returned values as plain JSON, so stringify cannot throw;
              // it yields undefined only for a program that returns undefined.
              const output =
                typeof result.value === "string"
                  ? result.value
                  : (JSON.stringify(result.value, null, 2) ?? String(result.value))

              // 调用审计也包含已 catch 的失败；提醒只依据解释器确认的未观察事实。
              const receipt = result.unobservedFailure
                ? "Some asynchronous work failed or was interrupted without the script observing its outcome."
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
                // 恢复文件必须包含环境、上下文、结果和已捕获日志，不能先在这里裁短正文。
                // 统一 wrapper 负责可见文本清理、截断和落盘；这里交付完整回执，不改变业务值。
                output: [
                  `Environment: ${lease.id}`,
                  receipt,
                  contextText(),
                  withLogs(receipt ? `Script result:\n${output}` : output),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                // 附件不经过正文截断，脚本筛选返回值也不会撤掉已收取的媒体。
                ...(attachments.length > 0 ? { attachments } : {}),
              } satisfies Tool.ExecuteResult<Metadata>
            }),
          ),
          abort,
        )
      }, Effect.orDie),
    }
    return init
  }),
)

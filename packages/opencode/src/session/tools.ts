import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { ToolSelection } from "@/tool/selection"
import { ShellID } from "@/tool/shell/id"
import { formatExecutionNotice, formatLongExecutionNotice } from "@/util/output-notice"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import type { GoalTurnContext } from "@/tool/goal"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Cause, Effect, Exit, Schema } from "effect"
import { Question } from "@/question"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionGoal } from "./goal"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import { describeCatalog, fetchHTTP, type CatalogEntry } from "@/tool/code-mode"

type ToolTimingInput = {
  source: "local" | "mcp"
  tool: string
  sessionID: string
  callID: string | undefined
}

function toolTiming(input: ToolTimingInput, extra: { phase: "tool.start" } | { phase: "tool.end"; status: "completed" | "error"; durationMs: number }) {
  // 工具 timing 只记录 daemon log 中的短 milestone，禁止携带 args、output、
  // metadata。tool.start/tool.end 是低基数字段，用来把“工具静默等待”
  // 和 provider 首 token 慢、TUI 接收/应用慢区分开。
  return Effect.logInfo("tool timing", { ...extra, ...input })
}

function timedToolExecution<A, E, R>(input: ToolTimingInput, effect: Effect.Effect<A, E, R>) {
  // 只在前置 plugin hook 通过后写 tool.start，避免 hook 自身失败被误判
  // 为工具静默。执行失败仍通过 Exit 原样恢复，保持既有错误传播语义。
  const startedAt = Date.now()
  return Effect.gen(function* () {
    yield* toolTiming(input, { phase: "tool.start" })
    const exit = yield* effect.pipe(Effect.exit)
    yield* toolTiming(input, {
      phase: "tool.end",
      status: Exit.isSuccess(exit) ? "completed" : "error",
      durationMs: Date.now() - startedAt,
    })
    return yield* exit
  })
}

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

// #216：把 AbortSignal 包裹成 Effect——permission.ask 与之竞速，cancel 时不再阻塞在权限询问
function waitForAbort(signal?: AbortSignal) {
  // #216：无 abort 信号时返回 never——raceFirst 中 permission.ask 独占完成，不引入空竞速
  if (!signal) return Effect.never
  return Effect.callback<never, Error>((resume) => {
    const onabort = () => resume(Effect.fail(Object.assign(new Error("Aborted"), { name: "AbortError" })))
    if (signal.aborted) return onabort()
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall" | "runChild">
  userTools?: Record<string, boolean>
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  goalSvc: SessionGoal.Interface
  // [local-smark] goalSvc 由 prompt 层注入而非 tools 层自取——
  // SessionGoal 依赖 Database，经 prompt 的 layer 传递可避免 tools 层重复接线
  // [local-smark] goalTurn 由 prompt 层注入：GoalTool 依赖它校验 trusted read snapshot，
  // 不能由工具参数伪造
  goalTurn?: GoalTurnContext
  // #557：Goal chronology 惰性加载——真实 goal Tool 启动才查询，同 step 共享 loader 结果。
  loadGoalTurn?: Effect.Effect<GoalTurnContext | undefined>
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const sessions = yield* Session.Service
  const mcpTools = yield* mcp.tools()

  type Execution = {
    // child 继承本次批准与已完成上下文，身份始终由宿主分配而非脚本传参。
    parentCallID: string
    review: Permission.ExecuteReview
    messages: SessionV1.WithParts[]
    settled: SessionV1.ToolPart[]
    partID?: PartID
  }
  // 恢复信息来自真实终态，而不是解释器用于展示的调用摘要。
  const evidence = (parts: SessionV1.ToolPart[]) => parts.map((part) => ({
    callID: part.callID, tool: part.tool, status: part.state.status,
    ...(part.state.status === "completed" && { title: part.state.title }),
    // Task 可能在启动子 Session 后失败，error 的 metadata 仍能提供真实恢复身份。
    ...("metadata" in part.state && typeof part.state.metadata?.sessionId === "string" && { task_id: part.state.metadata.sessionId }),
  }))
  const context = (args: Record<string, unknown>, options: ToolExecutionOptions, execution?: Execution): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    // #364：goalSvc 传入 ctx.extra，使 goal tool 能调用 SessionGoal.Service；
    // goalTurn 同样经 ctx.extra 传递，GoalTool 用它校验 read snapshot 与 turn 连续性
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps, goalSvc: input.goalSvc, goalTurn: input.goalTurn },
    agent: input.agent.name,
    executeParent: execution?.parentCallID,
    messages: execution?.messages ?? input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        // #214：工具 metadata 回调替换实时进度数据（如 shell 输出预览）
        // #214：仅保留 permission-review 包络——它由 PermissionReviewer 拥有，链接父工具到隐藏子会话
        // #214：shell/edit/write 进度更新不得丢弃 autoReview 审查状态
        const autoReview = match.state.status === "running" ? match.state.metadata?.autoReview : undefined
        return {
          ...match,
          state: {
            title: val.title,
            metadata: autoReview ? { ...(val.metadata ?? {}), autoReview } : val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      // live 进度经 val.delivery 透传：ephemeral 只广播不落盘，durable 保持原路径。
      }, val.delivery),
    ask: (req) => Effect.gen(function* () {
      // 工具执行期间可修改 Session 规则；实际权限请求使用最新值而非目录生成时的快照。
      const latest = execution ? yield* sessions.get(input.session.id) : input.session
      return yield* (execution?.review ?? permission).ask({
          ...req,
          // #230：permission reviewer 以 metadata.agent 为稳定信号——集中在此写入使 apply_patch/write/edit/插件共享同一安全路径
          metadata: { ...req.metadata, agent: input.agent.name, ...(execution && { completed: evidence(execution.settled) }) },
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, latest.permission ?? []),
        })
        // #216：权限询问与 abort 信号竞速——cancel 时不再阻塞在 permission.ask 而是立即失败
        .pipe(Effect.raceFirst(waitForAbort(options.abortSignal)))
    }).pipe(Effect.orDie),
  })

  const inventory: Record<string, Tool.Def> = Object.fromEntries((yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })).map((item) => [item.id, item]))
  // 初始化完成后才呈现目录，使 native、MCP 与 resources 接受同一轮过滤。
  const catalog: CatalogEntry[] = []

  const invoke = (item: Tool.Def, args: Record<string, unknown>, options: ToolExecutionOptions, execution?: Execution): Promise<Tool.ExecuteResult> =>
    run.promise(
          Effect.gen(function* () {
            // 审查期间新调用先等待同一权限锁，连没有 ctx.ask 的扩展也沿此入口暂停。
            if (execution) yield* execution.review.ready()
            // 普通对话不读取Goal历史；真实goal adapter共享本轮受信上下文。
            if (item.id === "goal" && input.loadGoalTurn) input.goalTurn = yield* input.loadGoalTurn
            const ctx = context(args, options, execution)
            // 只保存本次 child 的最终记录，避免后续调用扫描其它轮次的历史。
            const settled: SessionV1.ToolPart[] = []
            let parent: SessionV1.ToolPart | undefined
            return yield* Effect.gen(function* () {
            if (item.id === "execute") {
              const controller = new AbortController()
              // 用户取消与权限终止共享 signal，后续 leaf 和已运行任务观察同一结束原因。
              const signal = AbortSignal.any(options.abortSignal ? [options.abortSignal, controller.signal] : [controller.signal])
              let review: Permission.ExecuteReview | undefined
              let sequence = 0
              ctx.codeMode = {
                catalog, signal,
                fetch: (url, init) => Effect.gen(function* () {
                  if (signal.aborted) return yield* Effect.interrupt
                  const approved = review
                  if (!approved) return yield* Effect.die("execute preparation must precede invocation")
                  yield* approved.ready()
                  // 复用真实子调用的权限上下文，HTTP也服从整段批准、升阶及终止。
                  return yield* fetchHTTP(url, init, context({}, { ...options, abortSignal: signal }, {
                    parentCallID: options.toolCallId, review: approved, settled, messages: input.messages,
                  }))
                }),
                begin: (code, calls) => Effect.gen(function* () {
                  const current = yield* sessions.get(input.session.id)
                  review = yield* permission.beginExecute({
                    sessionID: input.session.id, tool: { messageID: ctx.messageID, callID: options.toolCallId },
                    code, calls, ruleset: Permission.merge(input.agent.permission, current.permission ?? []),
                    agent: input.agent.name, stop: (reason) => controller.abort(reason),
                  })
                }).pipe(Effect.orDie),
                invoke: (id, raw) => Effect.gen(function* () {
                  if (signal.aborted) return yield* Effect.interrupt
                  const approved = review
                  if (!approved) return yield* Effect.die("execute preparation must precede invocation")
                  const current = yield* sessions.get(input.session.id)
                  const selected = ToolSelection.filter(inventory, input.agent.permission, current.permission, input.userTools)[id]
                  const remote = mcpTools[id] ? (yield* mcp.tools())[id] : undefined
                  // MCP 重连后使用当前 entry，旧 catalog 只约束可用名称而不保留失效连接。
                  const leaf = remote ? fromMcp(id, remote) : selected
                  const resource = Object.values(MCP_RESOURCE_TOOLS).some((name) => name === id)
                  const available = mcpTools[id] ? Boolean(remote) : resource
                    ? Object.values(yield* mcp.clients()).some((client) => !!client.getServerCapabilities()?.resources)
                    : (yield* registry.ids()).includes(id)
                  // 每次接纳读取当前开关和 registry 成员，广告目录只界定本次最大工具集合。
                  if (!selected || !leaf || !catalog.some((entry) => entry.id === id) || !available) {
                    controller.abort(new Error(`Tool unavailable: ${id}`))
                    return yield* Effect.interrupt
                  }
                  // 原 MCP execute 允许省略空参数；统一入口保留这个已发布调用形状。
                  const args = raw ?? {}
                  if (!isRecord(args)) return yield* Effect.fail(new Error("Tool input must be an object"))
                  const callID = `${options.toolCallId}/${++sequence}`
                  // 目录搜索不创建宿主工具记录，连续编号只属于真实接纳的 leaf。
                  // 本次已完成 child 只在后续 child Context 中可见，主模型仍读取父聚合回执。
                  const completed = settled.filter((part) => part.state.status === "completed").map((part) => {
                      const { executeParent, ...metadata } = part.metadata ?? {}
                      // 临时投影只交给本次后续工具；数据库标记保留，主模型不会得到这些正文。
                      return { ...part, metadata }
                    })
                  const child: Execution = {
                    parentCallID: options.toolCallId, review: approved, settled,
                    messages: [...input.messages, { info: input.processor.message, parts: completed }],
                  }
                  return yield* input.processor.runChild({ parentCallID: options.toolCallId, callID, tool: id, input: args },
                    Effect.suspend(() => {
                      // 只有一个宿主 Promise；中断后等待它自己的清理，Bash 保留原 kill/drain。
                      const cancel = new AbortController()
                      const pending = invoke(leaf, args, { ...options, toolCallId: callID, abortSignal: AbortSignal.any([signal, cancel.signal]) }, child)
                      return Effect.tryPromise({ try: () => pending, catch: (error) => error }).pipe(
                        // race 取消只针对败方；先通知该次宿主执行，再等待原清理，父 scope 继续可用。
                        Effect.onInterrupt(() => Effect.sync(() => cancel.abort())),
                        Effect.ensuring(Effect.promise(() => pending.then(() => undefined, () => undefined))),
                      )
                    }),
                  ).pipe(Effect.onExit(() => Effect.gen(function* () {
                    if (!child.partID) return
                    // 每个子调用只读取一次结算记录，避免连续调用反复水合整段历史。
                    const part = yield* sessions.getPart({ sessionID: current.id, messageID: ctx.messageID, partID: child.partID })
                    // 结算 owner 的状态也涵盖中断和 hook 失败，不用解释器回调推测结果。
                    if (part?.type === "tool") settled.push(part)
                  })), Effect.catchCause((cause) => {
                    const error = Cause.squash(cause)
                    if (!(error instanceof Question.RejectedError)) return Effect.failCause(cause)
                    // 用户关闭问题属于整段取消；普通工具失败仍按原错误交给 JS catch。
                    controller.abort(error)
                    return Effect.interrupt
                  }))
                }),
              }
            }
            const adapterStartedAt = Date.now()
            const timing = {
              source: mcpTools[item.id] ? "mcp" as const : "local" as const,
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            }
            // #557：本地 Tool 的真实执行屏障先于 plugin/Permission——事件回调只能登记 Part，
            // 不能证明 mutation 尚未开始；worktree 声明在拒继行时也保留归因边界。
            const recorded = yield* input.processor.updateToolCall(options.toolCallId, (part) => part, "durable", item.worktree ?? "none")
            if (execution) execution.partID = recorded?.id
            if (item.id === "execute") parent = recorded
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            if (execution) {
              // hook 后的真实参数留给原 decoder/body；权限事实由工具自身的 ctx.ask 产生。
              yield* input.processor.updateToolCall(options.toolCallId, (part) => ({ ...part, state: { ...part.state, input: args } }))
            }
            const result = yield* timedToolExecution(timing, item.execute(args, ctx))
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            // 包含plugin前后hook的实际adapter耗时；Bash自行装饰，不能重复追加。
            const adapterElapsedMs = Date.now() - adapterStartedAt
            if (options.abortSignal?.aborted) {
              if (item.id !== ShellID.ToolID) output.output += "\n\n" + formatExecutionNotice({ source: "tool", severity: "warning", reason: "user_abort", elapsed_ms: adapterElapsedMs })
              yield* input.processor.completeToolCall(options.toolCallId, output)
            } else if (item.id !== ShellID.ToolID) {
              const notice = formatLongExecutionNotice("tool", adapterElapsedMs)
              if (notice) output.output += "\n\n" + notice
            }
            if (item.id === "execute" && output.metadata.truncated === true) {
              // 部分可见正文不能证明整份规则已交付，下一轮允许按原加载机制补齐。
              output.metadata.loaded = []
              output.metadata.skills = []
            }
            return output
            }).pipe(Effect.onExit((exit) => Effect.gen(function* () {
              if (item.id !== "execute" || Exit.isSuccess(exit) || !parent) return
              const part = yield* sessions.getPart({ sessionID: ctx.sessionID, messageID: ctx.messageID, partID: parent.id })
              const metadata = part?.type === "tool" && "metadata" in part.state ? part.state.metadata ?? {} : {}
              // HTTP是runtime能力，没有child ToolPart；复用进度事实补齐父失败回执。
              const requests = Array.isArray(metadata.toolCalls) ? metadata.toolCalls.filter((call) => isRecord(call) && call.tool === "$codemode.fetch") : []
              // 保留执行器已收取的规则正文和终止原因，再补真实完成清单。
              const text = [typeof metadata.output === "string" ? metadata.output : "",
                `Partial execution:\n${JSON.stringify([...evidence(settled), ...requests])}`].filter(Boolean).join("\n\n")
              // 包住 hooks 和结果投影：这些步骤失败时，已完成副作用同样需要可恢复回执。
              const partial = yield* truncate.output(text, {}, input.agent)
              yield* ctx.metadata({ metadata: { ...metadata, error: true, output: partial.content,
                loaded: [], skills: [], truncated: partial.truncated,
                ...(partial.truncated && { outputPath: partial.outputPath }),
              } })
            })))
          }),
          // Bash自己等待kill/drain并保留partial，不能被runtime抢先中断。
          item.id !== ShellID.ToolID ? { signal: options.abortSignal } : undefined,
        )
  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    const fields = { server: Schema.String, name: Schema.String, description: Schema.optionalKey(Schema.String), mime: Schema.optionalKey(Schema.String) }
    const templateSchema = Schema.Struct({ ...fields, pathTemplate: Schema.String })
    const templatesFor = Effect.fn("SessionTools.resourceTemplates")(function* (server?: string) {
      return Object.values(yield* mcp.resourceTemplates(server)).filter((item) => !server || item.client === server)
        .toSorted((a, b) => (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate))
    })
    inventory[MCP_RESOURCE_TOOLS.list] = {
      id: MCP_RESOURCE_TOOLS.list,
      output: Schema.Struct({ resources: Schema.Array(Schema.Struct({ ...fields, path: Schema.String })), templates: Schema.Array(templateSchema) }),
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      parameters: Schema.Unknown,
      jsonSchema: {
        type: "object",
        properties: { server: { type: "string", description: "Optional MCP server name. When omitted, lists resources from every connected server." } },
        additionalProperties: false,
      },
      execute: (args, ctx) => Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const templates = yield* templatesFor(parsed.server)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              // 资源与模板共享同一连接身份和权限边界；展示正文保留原格式。
              program: { value: { resources: filtered.map((item) => ({ ...resourceInfo(item), path: item.uri })),
                templates: templates.map((item) => ({ ...resourceInfo(item), pathTemplate: item.uriTemplate })),
              } },
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            return output
      }).pipe(Effect.orDie),
    }

    inventory[MCP_RESOURCE_TOOLS.listTemplates] = {
      id: MCP_RESOURCE_TOOLS.listTemplates,
      output: Schema.Struct({ templates: Schema.Array(templateSchema) }),
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      parameters: Schema.Unknown,
      jsonSchema: {
        type: "object",
        properties: { server: { type: "string", description: "Optional MCP server name. When omitted, lists resource templates from every connected server." } },
        additionalProperties: false,
      },
      execute: (args, ctx) => Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const filtered = yield* templatesFor(parsed.server)
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              program: { value: { templates: filtered.map((item) => ({ ...resourceInfo(item), pathTemplate: item.uriTemplate })) } },
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            return output
      }).pipe(Effect.orDie),
    }

    inventory[MCP_RESOURCE_TOOLS.read] = {
      id: MCP_RESOURCE_TOOLS.read,
      output: Schema.Struct({ server: Schema.String, contents: Schema.Array(Schema.Struct({ path: Schema.String,
        content: Schema.String, mime: Schema.optionalKey(Schema.String), encoding: Schema.Literals(["utf8", "base64"]),
      })) }),
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      parameters: Schema.Unknown,
      jsonSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name exactly as returned by list_mcp_resources." },
          uri: { type: "string", description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources." },
        },
        required: ["server", "uri"], additionalProperties: false,
      },
      execute: (args, ctx) => Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              program: { value: { server: parsed.server, contents: formatted.values } },
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments,
            }
            return output
      }).pipe(Effect.orDie),
    }
  }

  function fromMcp(key: string, entry: MCP.McpTool): Tool.Def {
    return {
      id: key, description: entry.def.description ?? "", parameters: Schema.Unknown,
      jsonSchema: McpCatalog.schemas(entry.def).input,
      // MCP 的工作树屏障与 hooks 由共享 invoke 承担，协议 owner 只执行一次 transport。
      worktree: "ambient",
      execute: (args, ctx) => Effect.gen(function* () {
          // MCP 的 flat ID 仍是权限键，namespace 只是脚本目录的寻址表示。
          yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
          const result = yield* Effect.promise(() => McpCatalog.callTool(entry, args, ctx.abort))

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if ("text" in resource && resource.text) textParts.push(resource.text)
              if ("blob" in resource && resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...(isRecord(result.metadata) ? result.metadata : {}),
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          return {
            title: "",
            metadata,
            output: truncated.content,
            attachments,
            content: result.content,
            program: McpCatalog.programResult(result),
          }
        }).pipe(Effect.orDie),
    }
  }
  for (const [key, entry] of Object.entries(mcpTools)) inventory[key] = fromMcp(key, entry)
  const eligible = ToolSelection.filter(inventory, input.agent.permission, input.session.permission, input.userTools)
  // 捕获的 Agent 和模型工具选择保持整轮稳定，运行中只刷新 Session 开关与连接成员。
  const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize).sort((a, b) => b.length - a.length)
  catalog.push(...Object.values(eligible)
    // 审批内部工具与 execute 自身不进入脚本目录，避免扩大权限或递归包装。
    .filter((item) => !["execute", "invalid", "_noop", "StructuredOutput", "permission_review_decision"].includes(item.id))
    .map((item): CatalogEntry => {
      const entry = mcpTools[item.id]
      // 保持已发布的 MCP namespace.local 拼法，包含带下划线的 server 名。
      const server = entry
        ? servers.find((name) => item.id.startsWith(name + "_")) ?? (item.id.includes("_") ? item.id.slice(0, item.id.indexOf("_")) : item.id)
        : "$opencode"
      const local = entry && item.id.startsWith(server + "_") ? item.id.slice(server.length + 1) : item.id
      // 文字工具已有 output:string 合同；远端声明保持原状，原生结构化结果复用原 codec。
      return { id: item.id, path: [server, local], description: item.description,
        inputSchema: ToolJsonSchema.fromTool(item), outputSchema: entry ? McpCatalog.schemas(entry.def).output : item.output ?? Schema.String }
    }))
  for (const item of Object.values(eligible)) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    // Provider 只负责参数呈现；直接与嵌套入口都继续复用工具原来的运行时校验。
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute: (args, options) => invoke(item, args, options),
    })
  }

  // 上游将稳定说明放工具定义，动态目录放当轮指令；V1保持原provider-turn边界。
  return { tools, instructions: eligible.execute ? [yield* describeCatalog(catalog)] : [] }
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function resourceInfo(item: { client: string; name: unknown; description?: unknown; mimeType?: unknown }) {
  return { server: item.client, name: item.name,
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mime: item.mimeType } : {}),
  }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
  const values: { path: string; content: string; mime?: string; encoding: "utf8" | "base64" }[] = []

  // 协议未声明mime时保持缺省，附件显示的默认MIME不能冒充远端声明。
  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      values.push({ path: itemUri, content: item.text, ...(typeof item.mimeType === "string" ? { mime: item.mimeType } : {}), encoding: "utf8" })
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      // 附件限制只控制模型媒体交付；程序保留原资源字节及显式编码。
      values.push({ path: itemUri, content: item.blob, ...(typeof item.mimeType === "string" ? { mime: item.mimeType } : {}), encoding: "base64" })
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    values,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"

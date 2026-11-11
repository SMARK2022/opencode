import { TokenEstimate } from "@/token/estimate"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Option, Scope, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { MessageError } from "./message-error"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { EffectBridge } from "@/effect/bridge"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq } from "drizzle-orm"
import { MessageTable } from "@opencode-ai/core/session/sql"
import type { EventV2 } from "@opencode-ai/core/event"
import { Usage, LLMError, LLMEvent, ToolResultValue } from "@opencode-ai/llm"
import { Token } from "@opencode-ai/core/util/token"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate" // 终态准备组成完整回执，再交原截断与提示 owner。
import { formatExecutionNotice } from "@/util/output-notice"

// #149：取消时给 bash 等工具完成截断/complete 的宽限
// 500ms升级窗口后给并行工具2秒结算宽限；输出消费及finalizer仍由原owner收尾。
const ABORTED_TOOL_SETTLE_TIMEOUT = "2 seconds"

// 产品合同「最近三次脱扣」：同 tool + 同 input + 全 error 的窗口长度；与测试矩阵阈值绑定。
const DOOM_LOOP_THRESHOLD = 3
// #216：工具中止错误文案常量——prompt.ts/tools.ts 共用同一字符串判断中止路径
export const TOOL_ABORTED_ERROR = "Tool execution aborted"
// attempt内全部Text Part共用65,536个UTF-16 code unit预算；不是UTF-8字节或token预算。
// 按string.length直接累计，不为每个delta编码或分配第二份正文。
const OUTPUT_TEXT_LIMIT = 64 * 1024

/**
 * #514：工具完成时的 input 真值回写（INV-16 / write format 同构）。
 * - `_syncInput`：整参数面替换为 { filePath, edits }，丢弃 legacy 顶层替换字段
 * - `_formattedContent`：仅覆盖 content（write 旧语义）
 * 有 _syncInput 时优先，不做浅合并旧 input。
 */
export function resolveCompletedToolInput(
  prev: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const meta = metadata ?? {}
  const sync = meta._syncInput
  if (sync && typeof sync === "object" && Array.isArray((sync as { edits?: unknown }).edits)) {
    const body = sync as { filePath?: string; edits: unknown[] }
    return {
      filePath: typeof body.filePath === "string" ? body.filePath : prev.filePath,
      edits: body.edits,
    }
  }
  if (typeof meta._formattedContent === "string") {
    return { ...prev, content: meta._formattedContent }
  }
  return prev
}

/** #514：持久化 metadata 前去掉真值临时字段，避免进 DB / event。 */
export function stripToolTruthMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { _formattedContent: _f, _syncInput: _s, ...rest } = metadata ?? {}
  return rest
}

// [local-smark] elapsedMs 由 server 在终态时写入，覆盖工具 metadata 中的同名键，
// 防止外部伪造。只有 Number.isFinite 且非负的值才写入；旧记录无此字段则不追加
export function interruptedToolMetadata(metadata: Record<string, unknown> | undefined, elapsedMs?: number): Record<string, unknown> {
  const base = metadata ?? {}
  const autoReview = base.autoReview
  const result: Record<string, unknown> = isRecord(autoReview)
    ? { ...base, interrupted: true, autoReview: { ...autoReview, status: "aborted", error: TOOL_ABORTED_ERROR } }
    : { ...base, interrupted: true }
  if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    result.executionElapsedMs = Math.floor(elapsedMs)
  }
  return result
}

export type Result = "compact" | "stop" | "continue"

export const publishAssistant = Effect.fnUntraced(function* (message: SessionV1.Assistant, events: EventV2.Interface, finalizer = false) {
  yield* events.publish(MessageV2.Event.Updated, { sessionID: message.sessionID, info: message }, {
    // 同一 durable commit 保存快照；退出仅隔离可能阻塞的 callback，实时 fanout 保留。
    finalizer,
    commit: () => Effect.gen(function* () {
      const usage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
      if (usage) yield* usage.recordAssistant({ sessionID: message.sessionID, requestID: message.parentID, assistant: message })
    }),
  })
})

export const ownAssistant = Effect.fnUntraced(function* (input: { sessionID: SessionID; requestID: SessionV1.User["id"] }, dependencies: { events: EventV2.Interface; db: Database.Interface["db"] }) {
  const db = dependencies.db
  let message: SessionV1.Assistant | undefined
  // 注册先于首次发布；唯一助手归属随后同步交接，不从最新 user 推测。
  yield* Effect.addFinalizer((exit) => Effect.gen(function* () {
    if (Exit.isSuccess(exit)) return
    const row = message ? yield* db.select().from(MessageTable).where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, message.id))).get().pipe(Effect.orDie) : undefined
    if (row && message) {
      const current = Schema.decodeUnknownSync(SessionV1.Info)({ ...row.data, id: row.id, sessionID: row.session_id })
      if (current.role !== "assistant" || current.time.completed !== undefined) return
      // 以持久化 completed 为准；内存可能已在尚未提交的 cleanup 中改写。
      const aborted = Cause.hasInterrupts(exit.cause)
      message.error ??= MessageV2.fromError(aborted ? new DOMException("Aborted", "AbortError") : Cause.squash(exit.cause), { providerID: message.providerID, aborted })
      // 准备窗口中断没有 provider finish；非取消故障仍保留原 error 结束原因。
      if (!aborted) message.finish ??= "error"
      message.time.completed = Date.now()
      // 退出不重入阻塞 callback；短 bridge observer、typed/all 与 durable wake 仍收到终态。
      yield* publishAssistant(message, dependencies.events, true)
      return
    }
    const usage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
    if (!usage) return
    const request = yield* usage.get({ sessionID: input.sessionID, requestID: input.requestID })
    if (!request || request.assistantCount !== 0 || request.status !== "running") return
    const failure = Cause.squash(exit.cause)
    // 创建未提交或摘要尚未创建时只闭合已有请求，不能制造幽灵助手或消费。
    yield* usage.complete({ sessionID: input.sessionID, requestID: input.requestID, status: Cause.hasInterrupts(exit.cause) ? "aborted" : "error",
      error: failure instanceof Error ? failure.message : String(failure), timeCompleted: Date.now() })
  }))
  return (assistant: SessionV1.Assistant) => { message = assistant }
})

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly runChild: <A extends Tool.ExecuteResult>(
    input: { parentCallID: string; callID: string; tool: string; input: Record<string, unknown> },
    run: Effect.Effect<A, unknown>,
  ) => Effect.Effect<A, unknown>
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
    delivery?: "durable" | "ephemeral",
    worktree?: "none" | "declared" | "ambient",
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  // 工具输入缓冲：累积原始输入避免逐 token 写入数据库
  toolInputBuffer: Record<string, string>
  // #557：registry 只活在当前 process；持久 authority 随后写入 ToolPart.metadata。
  toolWorktree: Record<string, "declared" | "ambient">
  shouldBreak: boolean
  snapshot: string | undefined
  // #557：active 区分「已有可复用 baseline」与「本 step 真实执行了副作用 Tool」。
  snapshotActive: boolean
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  // 当前 attempt 内全部 Text Part 的累计正文字符数；retry 入口与 process 起点重置。
  attemptTextChars: number
  // 本次尝试可撤回的非 Tool Part；工具副作用与已确认 step-finish 不进入集合。
  attemptPartIDs: Set<PartID>
  // 仅记录本次provider尝试的语义输出；重试不能借用上一轮的标志。
  // 空start/end不算正文，真实tool-call则必须防止重复副作用。
  hasText: boolean
  hasReasoning: boolean
  hasToolCall: boolean
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const truncate = yield* Truncate.Service // 完整回执只使用现有截断服务，不另建预算算法。

    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // #557：懒快照——纯文本/只读请求不再白付一次 git 扫描；baseline 推迟到首个副作用 Tool。
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        toolInputBuffer: {},
        toolWorktree: {},
        shouldBreak: false,
        snapshot: undefined,
        snapshotActive: false,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        attemptTextChars: 0,
        attemptPartIDs: new Set(),
        hasText: false,
        hasReasoning: false,
        hasToolCall: false,
      }
      let aborted = false
      // 语义重试额度跨内部attempt保留，在下一次process重置，不改通用retry policy。
      let outputLimitRetried = false
      // 三条终态写共享许可；只串行读写，不在其中等待工具完成信号。
      const toolPermit = Semaphore.makeUnsafe(1)
      // 并发副作用工具共享同一基线及失败；等待者取消不能让另一工具绕过捕获。
      // 基线在真实执行前建立，不能依赖稍后才到达的provider step事件。
      const captureToolSnapshot = yield* Effect.cached(
        snapshot.track().pipe(Effect.tap((hash) => Effect.sync(() => (ctx.snapshot = hash)))),
      )

      // 只撤回当前不完整尝试，不能把整个 Message 或已执行工具当作可重放副作用。
      const discardIncompleteAttempt = Effect.fn("SessionProcessor.discardIncompleteAttempt")(function* () {
        const open = new Set([ctx.currentText?.id, ...Object.values(ctx.reasoningMap).map(part => part.id)])
        const ids = new Set([...ctx.attemptPartIDs, ...Object.values(ctx.toolcalls).map(call => call.partID)])
        for (const partID of ids) {
          const part = yield* session.getPart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID, includeHidden: true })
          if (!part) continue
          // 有工具只撤回开放残片；未执行参数没有副作用，无工具时一并删除。
          if ((!ctx.hasToolCall && (part.type !== "tool" || part.state.status === "pending")) || (ctx.hasToolCall && open.has(partID))) {
            yield* session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID })
            continue
          }
          if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") continue
          // 失败轮只能保留可见上下文与真实工具事实，opaque 续接凭据不能回放。
          const provider = MessageV2.providerMeta(part.metadata)
          if (provider) yield* session.updatePart({ ...part,
            metadata: Object.fromEntries(Object.entries(part.metadata ?? {}).filter(([key]) => !(key in provider))),
          })
        }
        ctx.attemptPartIDs.clear()
        // 耗尽或退避中取消仍会走 cleanup，必须解除引用以免已删除正文被重新保存。
        ctx.currentText = undefined
        ctx.reasoningMap = {}
        if (!ctx.hasToolCall) {
          ctx.toolcalls = {}
          ctx.toolInputBuffer = {}
        }
      // 输出上限也复用此入口，串行元数据写以免覆盖并行工具的获胜终态。
      }, toolPermit.withPermits(1))


      // 这些 milestone 只写 daemon log，不记录 prompt、token 内容、工具参数
      // 或 provider metadata。phase 字符串是后续排查的稳定连接点：
      // processor.start/ai.first_event 区分 provider 首事件延迟，part.start /
      // part.first_delta 区分 processor 内部处理延迟，processor.end 标记回合收束。
      let timing:
        | { startedAt: number; firstStreamEvent: boolean; firstDelta: Set<string> }
        | undefined
      const streamTiming = (phase: string, extra?: Record<string, unknown>) =>
        Effect.logInfo("stream timing", {
          phase,
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          elapsedMs: timing ? Date.now() - timing.startedAt : 0,
          ...extra,
        })
      const logPartStart = (partType: string, extra: Record<string, unknown>) => streamTiming("part.start", { partType, ...extra })
      const logFirstDelta = (partType: string, partID: string, field: string, deltaChars: number) => {
        if (!timing) return Effect.void
        const key = `${partID}\0${field}`
        if (timing.firstDelta.has(key)) return Effect.void
        timing.firstDelta.add(key)
        return streamTiming("part.first_delta", { partType, partID, field, deltaChars })
      }

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      // 原生资格直接保留原 carrier；只让旧 SDK 错误经过既有分类入口。
      const toRetryCarrier = (error: unknown) =>
        error instanceof LLMError || LLMEvent.is.providerError(error) ? error : parse(error)

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        // 本消息结束前保留终态登记，SDK 迟到回声不能重新创建相同 callID。
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        // 此处是已登记 Tool 的状态写者，需保留 hidden 元数据并完成取消/结果的终态竞争。
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
          includeHidden: true,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
        delivery: "durable" | "ephemeral" = "durable",
        worktree: "none" | "declared" | "ambient" = "none",
      ) {
          // #557：登记先于 plugin/Permission——拒绝执行也保留准确归因边界。
        if (worktree !== "none") {
          // #557：execute 可能早于 tool-input-start；同步登记让事件创建路径也能持久化同一 policy。
          // none 不进入 gate，纯读取 Tool 因而不启动 git 子进程；policy 在 plugin/Permission 前登记，拒绝执行也保留归因边界。
          ctx.toolWorktree[toolCallID] = worktree
          yield* captureToolSnapshot
          ctx.snapshotActive = true
        }
        return yield* toolPermit.withPermits(1)(
          Effect.gen(function* () {
            // #557：permit 包住 read-update-write，progress 不能用 stale Part 擦除 policy；
            // updater 只执行一次，durable/live 分支不会产生不同 metadata。
            const match = yield* readToolCall(toolCallID)
            if (!match) return undefined
            const next = update(match.part)
            // durable 与 live progress 必须从同一 latest Part 派生；worktree marker 是 server-owned primitive。
            const marked =
              worktree === "none"
                ? next
                : { ...next, metadata: { ...next.metadata, worktree } }
            if (delivery === "ephemeral") {
              // ephemeral 进度只广播不落盘，避免高频工具输出把 PartUpdated 逐 tick 刷进 SQLite。
              yield* session.publishPartProgress(marked)
              return marked
            }
            const part = yield* session.updatePart(marked)
            ctx.toolcalls[toolCallID] = {
              ...match.call,
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return part
          }),
        )
      })

      const prepareToolOutput = Effect.fn("SessionProcessor.prepareToolOutput")(function* (output: {
        title: string
        metadata: Record<string, unknown>
        output: string
        attachments?: SessionV1.FilePart[]
      }, tool?: string) {
        // 真实工具身份同时选择 Read 图片预算与 Execute 最终预算。
        const normalized = yield* Effect.forEach(output.attachments ?? [], (candidate) => {
          const proof = Image.consumeNormalized(candidate)
          // #534：ReadTool 的匹配 proof 证明同一 MIME/URL 已 decode；缺失或被插件改写时必须回到唯一 Image owner。
          // 非图片 attachment 仍经过 consume 是为了统一剥离潜在 transient 字段，但绝不送入图片 decoder。
          // typed image failure 只移除对应附件；同一个 Tool 的文本和其他成功附件必须继续交付。
          if (proof.valid) return Effect.succeed(Exit.succeed<SessionV1.FilePart>(proof.attachment))
          if (!proof.attachment.mime.startsWith("image/"))
            return Effect.succeed(Exit.succeed<SessionV1.FilePart>(proof.attachment))
          return image.normalize(proof.attachment, tool === "read" ? { tokenBudget: 1600 } : undefined).pipe(Effect.exit)
        })
        const omitted = normalized.filter(Exit.isFailure).length
        const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
        const result = {
          ...output,
          // #534：provider 不支持的坏图片降级为文本事实；不保留原 bytes，也不把一次附件失败升级为整个 tool-error。
          // omission 计数来自同一 normalized 数组，避免事件分支和数据库分支各自过滤后计数漂移。
          // 返回值是唯一 prepared snapshot；调用方不能再次映射 attachments 或重新拼 omission 文案。
          output:
            omitted === 0
              ? output.output
              : `${output.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be decoded or resized within the image size limit.]`,
          attachments: attachments.length ? attachments : undefined,
        }
        if (tool !== "execute") return result
        // 最终预算覆盖耗时、取消及图片提示；恢复文件保存裁剪前完整回执。
        const truncated = yield* truncate.output(result.output, { maxChars: 36_000 })
        return {
          ...result,
          output: truncated.content,
          metadata: {
            ...result.metadata,
            truncated: truncated.truncated,
            // 部分可见正文不能证明完整规则已交付，下一轮允许按原加载机制补齐。
            ...(truncated.truncated && { outputPath: truncated.outputPath, loaded: [], skills: [] }),
          },
        }
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
        prepared = false,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        // #139：DB 已终态时仍 settle deferred，避免 LLM 死等
        if (match.part.state.status !== "running") {
          yield* settleToolCall(toolCallID)
          return
        }
        // direct completion也在既有permit内准备；普通事件复用已准备snapshot及Read预算。
        const result = prepared ? output : yield* prepareToolOutput(output, match.part.tool)
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            // #514：_syncInput/_formattedContent 真值回写收敛到 resolveCompletedToolInput；
            // edits 整表替换（丢弃 legacy 顶层字段）优先于旧 content 覆盖语义。
            input: resolveCompletedToolInput(
              match.part.state.input as Record<string, unknown>,
              result.metadata as Record<string, unknown> | undefined,
            ),
            output: result.output,
            // #209：auto-review 注解在 running 状态附加——completion 替换 metadata 时保留 autoReview 信封
            // #514：strip 真值临时字段（_formattedContent/_syncInput），避免进持久化 metadata
            metadata: (() => {
              const rest = stripToolTruthMetadata(result.metadata as Record<string, unknown> | undefined)
              return match.part.state.metadata?.autoReview
                ? { ...rest, autoReview: match.part.state.metadata.autoReview }
                : rest
            })(),
            title: result.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: result.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      }, toolPermit.withPermits(1))

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return false
        // #139：非 running 也 settle，防止卡死
        if (match.part.state.status !== "running") {
          yield* settleToolCall(toolCallID)
          return false
        }
        // #216：提取中止判定——aborted 标志、Aborted 文案和 TOOL_ABORTED_ERROR 三源合一
        const reason = errorMessage(error)
        const toolAborted = aborted || reason === "Aborted" || reason === TOOL_ABORTED_ERROR
        // [local-smark] abort 时写入 server-owned elapsedMs marker，使下一轮模型
        // 回放能追加 user_abort + elapsed_ms Notice；非 abort 保持既有 metadata 行为
        const failStart = match.part.state.time?.start ?? Date.now()
        const failure = toolAborted ? TOOL_ABORTED_ERROR : reason
        const elapsedMs = Date.now() - failStart
        const metadata = toolAborted
          ? interruptedToolMetadata(match.part.state.metadata, elapsedMs)
          : match.part.state.metadata
        // 错误与完整进度先合成一份终态回执；新记录回放不再追加第二份原因或取消提示。
        const receipt = match.part.tool === "execute"
          ? yield* prepareToolOutput({
              title: "execute",
              metadata: { ...metadata, finalizedError: true },
              output: [
                failure,
                typeof metadata?.output === "string" ? metadata.output : "",
                toolAborted
                  ? formatExecutionNotice({
                      source: "tool",
                      severity: "warning",
                      reason: "user_abort",
                      elapsed_ms: elapsedMs,
                    })
                  : "",
              ].filter(Boolean).join("\n\n"),
            }, "execute")
          : undefined
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            // #216：中止路径统一用 TOOL_ABORTED_ERROR 文案——非中止路径保留原始错误原因
            error: failure,
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            // #209：denied/failed auto-review 终态化为 error——UI 仍需 review 结果行和 reviewer 子会话链接
            // 中止时只更新审查终态，其他运行进度和普通错误metadata均保持完整。
            metadata: receipt ? { ...receipt.metadata, output: receipt.output } : metadata,
            time: { start: failStart, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      }, toolPermit.withPermits(1))

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
        parentCallID?: string
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        // #557：event 创建路径读取同步 registry；execute 先到时 marker 已经可用。
        // 空 metadata object 合法且不会进入 Provider schema；后续 lifecycle 统一 merge。
        const part = yield* session.updatePart({
            id: PartID.ascending(),
            messageID: ctx.assistantMessage.id,
            sessionID: ctx.assistantMessage.sessionID,
            type: "tool",
            tool: input.name,
            callID: input.id,
            state: { status: "pending", input: {}, raw: "" },
            metadata: {
              ...(input.providerExecuted ? { providerExecuted: true } : {}),
              ...(ctx.toolWorktree[input.id] ? { worktree: ctx.toolWorktree[input.id] } : {}),
              // 真实子记录保留文件归因，模型消费者据归属字段选择父回执。
              ...(input.parentCallID ? { executeParent: input.parentCallID } : {}),
            },
          } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      // 检查、创建与登记原子化；事件与实际 execute 必须共用同一 Part。
      }, toolPermit.withPermits(1))

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const runChild: Handle["runChild"] = (input, run) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // 登记和结算受同一生命周期保护，取消可中断 body，同时保留终态写入。
        // 真实宿主调用拥有独立 Part；无需伪造 provider 事件来借用旧的生命周期处理。
        yield* ensureToolCall({ id: input.callID, name: input.tool, parentCallID: input.parentCallID })
        yield* updateToolCall(input.callID, (part) => ({
          ...part, state: { status: "running", input: input.input, time: { start: Date.now() } },
        }))
        const exit = yield* restore(run).pipe(Effect.exit)
        // 先完成原 complete/fail，再把 Exit 交回解释器，后续 leaf 才能读取可靠终态。
        if (Exit.isSuccess(exit)) {
          yield* completeToolCall(input.callID, {
            ...exit.value,
            attachments: exit.value.attachments?.map((attachment) => ({
              // child 与父聚合各自拥有附件 Part 身份，媒体内容则来自同一次工具执行。
              ...attachment, id: PartID.ascending(), sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id,
            })),
          })
        } else {
          yield* failToolCall(input.callID, Cause.hasInterrupts(exit.cause) ? TOOL_ABORTED_ERROR : Cause.squash(exit.cause))
        }
        // 原 Exit 决定脚本的结果，持久化错误不会被转换为成功返回值。
        return yield* exit
      }))

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      // #508：doom_loop AND（用户 OR→AND）：最近 THRESHOLD 条非 pending tool 必须同时满足：
      // 同 tool 名、同 JSON.stringify(input)、status 全为 error；缺任一条件不 ask。
      // 仅相同输入（含成功）或仅跨 turn 不同 input 的连续失败都不拦截。
      // 窗口 = 跨多个前序 assistant 的有界 tail + 当前 message tool parts。
      // transcript 是唯一权威：不维护跨 step 计数 Map，避免双源与 input 无关计数。
      const askDoomLoopIfTripleFailure = (toolName: string, failedInput: unknown) =>
        Effect.gen(function* () {
          // 当前 message 只取 tool 终态，避免 step-finish/text 挤占 slice 尾部导致漏检。
          const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
            Effect.provideService(Database.Service, database),
          )
          const currentTools = parts.filter(
            (part) => part.type === "tool" && part.state.status !== "pending",
          )
          const preceding = yield* MessageV2.previousAssistantToolTail({
            sessionID: ctx.sessionID,
            before: { id: ctx.assistantMessage.id, time: ctx.assistantMessage.time.created },
            limit: DOOM_LOOP_THRESHOLD,
          }).pipe(Effect.provideService(Database.Service, database))
          const window = [...preceding, ...currentTools].slice(-DOOM_LOOP_THRESHOLD)
          // 与历史 identical 路径同用 JSON.stringify：不额外规范化键序，保持可比合同。
          const inputKey = JSON.stringify(failedInput)
          if (
            window.length !== DOOM_LOOP_THRESHOLD ||
            !window.every(
              (part) =>
                part.type === "tool" &&
                part.tool === toolName &&
                part.state.status === "error" &&
                JSON.stringify(part.state.input) === inputKey,
            )
          ) {
            return
          }
          // THRESHOLD=3 与产品「三次脱扣」字面一致；改常量须同步测试矩阵。
          const agent = yield* agents.get(ctx.assistantMessage.agent)
          yield* permission.ask({
            permission: "doom_loop",
            patterns: [toolName],
            sessionID: ctx.assistantMessage.sessionID,
            metadata: { tool: toolName, input: failedInput, consecutiveErrors: DOOM_LOOP_THRESHOLD },
            always: [toolName],
            ruleset: agent.permission,
          })
        })

      // 复用同一撤回owner，解除live引用后再失败，防止cleanup重建已拒绝正文。
      const breachOutputLimit = Effect.fnUntraced(function* () {
        yield* discardIncompleteAttempt()
        if (!outputLimitRetried && !ctx.hasToolCall) {
          outputLimitRetried = true
          return yield* Effect.fail(
            new SessionV1.APIError({
              message: "Provider output exceeded the 64 KiB text limit",
              isRetryable: true,
              metadata: { reason: "output-length" },
            }),
          )
        }
        return yield* Effect.fail(new MessageError.OutputLengthError({}))
      })

      const startToolCall = Effect.fnUntraced(function* (value: Extract<StreamEvent, { type: "tool-call" }>) {
        ctx.hasToolCall = true
        if (ctx.assistantMessage.summary) throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
        yield* ensureToolCall(value)
        const pendingRaw = ctx.toolInputBuffer[value.id]
        if (pendingRaw) {
          yield* updateToolCall(value.id, match => match.state.status !== "pending" ? match
            : { ...match, state: { ...match.state, raw: match.state.raw + pendingRaw } })
          delete ctx.toolInputBuffer[value.id]
        }
        const input = isRecord(value.input) ? value.input : { value: value.input }
        yield* updateToolCall(value.id, match => ({
          ...match, tool: value.name,
          // execute 与流事件可能交错；迟到的声明不能让已完成工具回到 running。
          state: match.state.status === "completed" || match.state.status === "error" ? match.state
            : match.state.status === "running" ? { ...match.state, input }
            : { status: "running", input, time: { start: Date.now() } },
          // 实际 execute 再登记时没有 Provider 字段；正常续接凭据只由失败收尾负责移除。
          metadata: { ...match.metadata, ...value.providerMetadata,
            ...(match.metadata?.providerExecuted ? { providerExecuted: true } : {}),
            ...(match.metadata?.worktree ? { worktree: match.metadata.worktree } : {}),
          },
        }))
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // ended reasoning 也可能已落库，集合须独立于当前 reasoningMap 生命周期。
            const reasoningPartID = PartID.ascending()
            ctx.attemptPartIDs.add(reasoningPartID)
            ctx.reasoningMap[value.id] = {
              id: reasoningPartID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            yield* logPartStart("reasoning", { partID: ctx.reasoningMap[value.id].id })
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            // 只有接纳的非空delta才证明provider实际输出了推理。
            if (value.text.length > 0) ctx.hasReasoning = true
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* logFirstDelta("reasoning", ctx.reasoningMap[value.id].id, "text", value.text.length)
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            yield* logPartStart("tool", { callID: value.id, partID: ctx.toolcalls[value.id]?.partID })
            return

          case "tool-input-delta": {
            // ensureToolCall 保留 delta-before-start；已运行工具必须在缓冲及 fanout 前排除迟到片段。
            const pending = yield* ensureToolCall(value)
            if (!pending || pending.part.state.status !== "pending") return
            // 上游 LLMEvent 使用 text；仅累积内存，不能恢复逐 token 的 durable PartUpdated 写入。
            ctx.toolInputBuffer[value.id] = (ctx.toolInputBuffer[value.id] ?? "") + value.text
            yield* logFirstDelta("tool", pending.call.partID, "raw", value.text.length)
            // raw 是既有 V1 wire 字段；consumer 在 pending state 内应用，不创造顶层 part.raw。
            yield* session.updatePartDelta({
              sessionID: pending.call.sessionID,
              messageID: pending.call.messageID,
              partID: pending.call.partID,
              field: "raw",
              delta: value.text,
            })
            return
          }

          case "tool-input-end": {
            yield* ensureToolCall(value)
            // end 是可重放的输入边界；提交成功才删除缓冲，写入失败仍可在 cleanup 保留。
            const buffered = ctx.toolInputBuffer[value.id]
            if (buffered) {
              yield* updateToolCall(value.id, (match) => {
                if (match.state.status !== "pending") return match
                return { ...match, state: { ...match.state, raw: match.state.raw + buffered } }
              })
              delete ctx.toolInputBuffer[value.id]
            }
            return
          }

          case "tool-call": {
            yield* startToolCall(value)
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            // 真实执行已保存结果时，回声不重复消费图片 proof 或输出准备。
            if (toolCall?.part.state.status === "completed" || toolCall?.part.state.status === "error") return
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              // 已完成或已收尾的重复事件没有新失败，不能再次触发权限询问。
              if (!(yield* failToolCall(value.id, value.result.value))) return
              yield* askDoomLoopIfTripleFailure(toolCall?.part.tool ?? "unknown", toolCall?.part.state.input)
              return
            }
            const rawOutput = toolResultOutput(value)
            const output = yield* prepareToolOutput(rawOutput, value.name)
            yield* completeToolCall(value.id, output, true)
            return
          }

          case "tool-error": {
            // [local-smark] breaker 需要工具名；readToolCall 可能失败（调用记录已清），失败则按 unknown 计
            // readToolCall 错误通道为 never，用 exit 包裹取回可能缺失的调用记录
            const errToolCallExit = yield* readToolCall(value.id).pipe(Effect.exit)
            const errToolCall = Exit.isSuccess(errToolCallExit) ? errToolCallExit.value : undefined
            if (!(yield* failToolCall(value.id, value.error ?? new Error(value.message)))) return
            yield* askDoomLoopIfTripleFailure(errToolCall?.part.tool ?? "unknown", errToolCall?.part.state.input)
            return
          }

          case "provider-error":
            yield* Effect.fail(value)
            return

          case "step-start":
            // #557：懒快照——start-step 不再兜底 track；baseline 由首个副作用 Tool 的 captureToolSnapshot 建立。
            // #124：把 daemon 请求前快照写入 step-start，供 streaming 展示分类
            // 本次 step-start 随失败前缀一起撤回，不制造孤立的成功步骤。
            const stepPartID = PartID.ascending()
            ctx.attemptPartIDs.add(stepPartID)
            yield* session.updatePart({
              id: stepPartID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
              // 读取发送前已准备的估算，不能把上一步确认 tokens 冒充本次输入。
              inputChars: ctx.assistantMessage.inputEstimate?.bodyChars,
              inputTokens: ctx.assistantMessage.inputEstimate?.input,
              inputBreakdown: ctx.assistantMessage.inputEstimate?.inputBreakdown,
            })
            return

            // #557：completedSnapshot 仅在 active step 产生；空 turn 不再为空 Patch 启动 git 扫描。
          case "step-finish": {
            // #557：未执行 non-none Tool 时没有 baseline，也不应为了空 Patch 再启动一次 git 扫描；
            // snapshotActive 只描述当前 step，不改变跨 step 保存的 completed baseline。
            const completedSnapshot = ctx.snapshotActive ? yield* snapshot.track() : undefined
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            // 无真实 Tool 的 unknown（源 other）在发布成功和确认 usage 之前进入原有 retry。
            if (value.reason === "unknown" && !ctx.hasToolCall) {
              yield* discardIncompleteAttempt()
              yield* Effect.fail(new SessionV1.APIError({
                message: `Provider returned incomplete completion (finish_reason: ${value.reason})`,
                isRetryable: true,
                metadata: { finishReason: value.reason },
              }))
            }
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            // 只有本 step 的实际确认能把请求体样本标记为可校准。
            if (ctx.assistantMessage.inputEstimate)
              ctx.assistantMessage.inputEstimate.confirmed = value.usage !== undefined
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              // 同一次准备的字符证明附在确认点；确认 tokens 与原子 publishAssistant owner 保持原值。
              inputChars: ctx.assistantMessage.inputEstimate?.bodyChars,
              inputBreakdown: ctx.assistantMessage.inputEstimate?.inputBreakdown,
              cost: usage.cost,
            })
            // 先保存 step part，再在消息 commit 中读取确认 parts，仍按同一 parentID 聚合。
            // 多工具续轮不能以当前助手 ID 新建另一轮用户请求。
            yield* publishAssistant(ctx.assistantMessage, events)
            if (ctx.snapshot && completedSnapshot && !aborted) {
          // #139：中断时跳过慢 git snapshot，优先完成终端态清理
          // #139：aborted 后 snapshot 非关键路径
          // #557：一个 step 内多个副作用 Tool 共用 before/after，Patch 只生成一次；Patch 为空仍推进 baseline。
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              // #557：下一 side-effect step 复用完成态 baseline；纯 Provider step 不触发 post-track。
              ctx.snapshot = completedSnapshot
              ctx.snapshotActive = false
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            // text-start 即持久化，完成后移出 currentText 的 Part 仍须能撤回。
            const textPartID = PartID.ascending()
            ctx.attemptPartIDs.add(textPartID)
            ctx.currentText = {
              id: textPartID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            yield* logPartStart("text", { partID: ctx.currentText.id })
            return

          case "text-delta":
            if (!ctx.currentText) return
            // 在追加正文和发布Part delta之前检查累计值，不接纳越界delta。
            // 等于预算仍合法；原始provider事件与用量结算继续由各自owner处理。
            if (ctx.attemptTextChars + value.text.length > OUTPUT_TEXT_LIMIT) {
              yield* breachOutputLimit()
              return
            }
            ctx.attemptTextChars += value.text.length
            // 只建立文本块而没有正文，不应绕过空完成检测。
            if (value.text.length > 0) ctx.hasText = true
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* logFirstDelta("text", ctx.currentText.id, "text", value.text.length)
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end": {
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            const beforePluginLength = ctx.currentText.text.length
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            // hook终值在持久写入前按长度差复检；收缩也同步下调，避免重复计数。
            // 这里只调整本attempt正文额度，不触碰Tool、已确认step用量或原始事件。
            const pluginGrowth = ctx.currentText.text.length - beforePluginLength
            if (ctx.attemptTextChars + pluginGrowth > OUTPUT_TEXT_LIMIT) {
              yield* breachOutputLimit()
              return
            }
            ctx.attemptTextChars += pluginGrowth
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return
          }

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        // #149：取消时先等 tool done（超时后仍走通用 interrupted 清理）
        if (aborted) {
          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout(ABORTED_TOOL_SETTLE_TIMEOUT), Effect.ignore),
            { concurrency: "unbounded", discard: true },
          )
        }

        // #139：中断时跳过慢 git snapshot，优先完成终端态清理
        // #557：stream error 可能跳过 step-finish；仅 active side-effect step 需要 rescue Patch。
        if (ctx.snapshot && ctx.snapshotActive && !aborted) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
        }
        // #139：aborted 也必须清空 snapshot 句柄，避免后续误用
        ctx.snapshot = undefined
        ctx.snapshotActive = false

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        // cleanup 直接唤醒协调信号，移除有界等待；这不表示工具执行已完成。
        for (const call of Object.values(ctx.toolcalls)) {
          yield* Deferred.succeed(call.done, undefined).pipe(Effect.ignore)
        }

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          yield* toolPermit.withPermits(1)(
            Effect.gen(function* () {
              const match = yield* readToolCall(toolCallID)
              if (!match) return
              const part = match.part
              // 在许可内重读，已获胜的complete/fail不能被cleanup旧快照覆盖。
              if (part.state.status !== "running" && part.state.status !== "pending") return
              const end = Date.now()
              const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
              const pendingRaw = ctx.toolInputBuffer[toolCallID]
              yield* session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: aborted ? TOOL_ABORTED_ERROR : "Tool execution did not complete before stream ended",
                  // pending原文放入metadata，普通失败保留进度，中断沿用412耗时与审查信封。
                  metadata: { ...(aborted ? interruptedToolMetadata(metadata, end - ("time" in part.state ? part.state.time.start : end)) : metadata),
                    ...(part.state.status === "pending" ? { raw: part.state.raw + (pendingRaw ?? "") } : {}),
                  },
                  time: { start: "time" in part.state ? part.state.time.start : end, end },
                },
              })
            }),
          )
        }
        ctx.toolcalls = {}
        // cleanup 终态提交后清空，重试与下一次 process 不继承上次工具的残片。
        ctx.toolInputBuffer = {}
        ctx.assistantMessage.time.completed = Date.now()
        // 工具终态及 raw 提交后再发布助手；中断继承 ensuring 保护，error/completed 与账本同事务提交后才通知。
        // 普通完成仍允许取消阻塞 callback；prompt caller 的 ownAssistant 继续负责其已注册的归属。
        yield* (aborted
          ? publishAssistant(ctx.assistantMessage, events, true)
          : Effect.interruptible(publishAssistant(ctx.assistantMessage, events)))
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        timing = { startedAt: Date.now(), firstStreamEvent: false, firstDelta: new Set() }
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        yield* streamTiming("processor.start", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          agent: streamInput.agent.name,
        })
        ctx.needsCompaction = false
        // 仅本次准备请求触发的内部转移，不能吞掉真实失败或用户中断。
        const preflightCompaction = Symbol("preflight-compaction")
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        // 每个 process() 只允许一次语义重试；跨 process 的新回合重新获得额度。
        outputLimitRetried = false

        const bridge = yield* EffectBridge.make()
        // 网络断流只结束消费；这个 controller 只属于用户取消，不能误杀在途工具。
        const toolAbort = new AbortController()
        const executions: Promise<Exit.Exit<void, unknown>>[] = []
        // 取消只等待 Execute 的真实清理；普通工具仍沿通用有界宽限退出。
        const executeJobs: Promise<unknown>[] = []
        const tools = Object.fromEntries(Object.entries(streamInput.tools).map(([name, item]) => {
          const execute = item.execute
          if (!execute) return [name, item]
          return [name, { ...item, execute: (args: Parameters<typeof execute>[0], options: Parameters<typeof execute>[1]) => {
            if (toolAbort.signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
            // 登记必须先于首个 await；流断开只释放连接，不取消已经开始的工具。
            ctx.hasToolCall = true
            const job = bridge.promise(Effect.gen(function* () {
              // 实际调用与终态写入归同一 owner；取消仅中断其后的人工询问。
              yield* startToolCall({ type: "tool-call", id: options.toolCallId, name, input: args })
              const exit = yield* Effect.tryPromise({
                try: () => Promise.resolve(execute(args, { ...options, abortSignal: toolAbort.signal })),
                catch: error => error,
              }).pipe(Effect.exit)
              if (Exit.isSuccess(exit)) {
                yield* completeToolCall(options.toolCallId, toolResultOutput(LLMEvent.toolResult({
                  id: options.toolCallId, name, result: ToolResultValue.make(exit.value),
                })))
                return exit
              }
              if (yield* failToolCall(options.toolCallId, Cause.squash(exit.cause))) {
                yield* askDoomLoopIfTripleFailure(name, isRecord(args) ? args : { value: args }).pipe(
                  Effect.interruptible,
                )
              }
              return exit
            }).pipe(Effect.uninterruptible), { signal: toolAbort.signal })
            // 普通工具失败已作为结果保存；登记/落库失败才使收尾本身失败。
            executions.push(job.then(() => Exit.succeed(undefined), error => Exit.fail(error)))
            if (name === "execute") executeJobs.push(job)
            return job.then(exit => {
              if (Exit.isSuccess(exit)) return exit.value
              throw Cause.squash(exit.cause)
            })
          } }]
        }))

        const result = yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            // 每次网络重试只跟踪本 attempt 的工具，已完成 Promise 不能重复等待。
            executions.length = 0
            executeJobs.length = 0
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.attemptTextChars = 0
            ctx.attemptPartIDs.clear()
            // 每次重试都重新判断本轮输出，不能被旧标志误放行。
            ctx.hasText = false
            ctx.hasReasoning = false
            ctx.hasToolCall = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream({ ...streamInput, tools, onRequestPrepared: (body) => Effect.gen(function* () {
              const metadata = yield* MessageV2.inputEstimateHistory({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, model: ctx.model }).pipe(
                Effect.provideService(Database.Service, database),
              )
              // 样本来自同provider/model的已确认历史，body是本次实际准备发送的完整载荷。
              const samples = TokenEstimate.inputHistory(metadata.history, ctx.model)
              const estimate = Token.estimateRequest(body, samples, streamInput.inputSections ?? [])
              // Core已分别折算正文、reasoning和媒体；这里的扩展只补充请求身份与水位。
              ctx.assistantMessage.inputEstimate = {
                ...estimate,
                contextLimit: ctx.model.limit.context,
                // V1 单助手多 step：新的确认 part 会立即遮掉此轮估算。
                afterPartID: metadata.afterPartID,
              }
              // inputEstimate记录本次估算，provider返回的step-finish再写入对应确认量。
              // 预检使用同一份请求估算判断可用窗口，随后沿用原有compact结果和续跑流程。
              if (!ctx.assistantMessage.summary && isOverflow({
                cfg: yield* config.get(), model: ctx.model,
                tokens: { input: ctx.assistantMessage.inputEstimate.input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })) {
                ctx.needsCompaction = true
                return yield* Effect.die(preflightCompaction)
              }
              yield* publishAssistant(ctx.assistantMessage, events)
            }) })

            const exit = yield* stream.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (timing && !timing.firstStreamEvent) {
                    timing.firstStreamEvent = true
                    yield* streamTiming("ai.first_event", { event: event.type })
                  }
                  yield* handleEvent(event)
                }),
              ),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
              // 只在 Provider 消费边界归一 cause；收尾持久化故障不进入网络重试。
              Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), cause => Effect.fail(Cause.squash(cause))),
              Effect.exit,
            )
            if (Exit.isFailure(exit) && (Cause.hasInterrupts(exit.cause) || Cause.squash(exit.cause) === preflightCompaction)) {
              return yield* Effect.failCause(exit.cause)
            }
            // 正常和断流共用一个屏障，不能用 cleanup 唤醒的 Deferred 冒充执行完成。
            const settled = yield* Effect.promise(() => Promise.all(executions))
            const failed = settled.find(Exit.isFailure)
            if (failed) return yield* Effect.die(Cause.squash(failed.cause))
            if (Exit.isSuccess(exit)) return undefined
            const retry = SessionRetry.retryable(toRetryCarrier(Cause.squash(exit.cause)), input.model.providerID)
            if (!retry) return yield* Effect.failCause(exit.cause)
            yield* discardIncompleteAttempt()
            if (!ctx.hasToolCall) return yield* Effect.failCause(exit.cause)
            // 已有真实工具结果时，把当前消息留在未完成态，下一 process 用已保存结果续跑。
            ctx.assistantMessage.finish = "unknown"
          }).pipe(
            // 转入已有 compact 结果，保留 cleanup 且不发布虚构的 provider 错误。
            Effect.catchCauseIf(
              (cause) => Cause.squash(cause) === preflightCompaction, () => Effect.void,
            ),
            // #214：SessionRetry.retry 封装替代 Effect.retry(SessionRetry.policy(...))
            // #214：processor 和 reviewer 子代理流共享同一重试策略和分类逻辑
            SessionRetry.retry({
              provider: input.model.providerID,
              parse: toRetryCarrier,
              set: (info) => {
                return status.set(ctx.sessionID, {
                  type: "retry",
                  attempt: info.attempt,
                  message: info.message,
                  action: info.action,
                  next: info.next,
                })
              },
            }),
            // 同一个取消 owner 覆盖消费、工具等待和退避，先停工具再发布中止。
            Effect.onInterrupt(() => Effect.gen(function* () {
              aborted = true
              toolAbort.abort()
              // Execute 自己收齐 child 清理及完整回执，再由通用 cleanup 收尾其余工具。
              yield* Effect.promise(() => Promise.allSettled(executeJobs))
              if (!ctx.assistantMessage.error) yield* halt(new DOMException("Aborted", "AbortError"))
            })),
            // 末端分别记录普通错误和收尾 defect，纯中断仍原样传播。
            Effect.catch(halt),
            Effect.catchDefect(halt),
            // #139：ensuring cleanup 必须尊重 aborted，跳过慢 snapshot
            Effect.ensuring(cleanup()),
            Effect.ensuring(Effect.sync(() => toolAbort.abort())),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
        yield* streamTiming("processor.end", {
          result,
          durationMs: timing ? Date.now() - timing.startedAt : 0,
        })
        // #237：timing 复位在 end 之后——下一轮次重新起算，避免跨 request 累计 duration
        timing = undefined
        return result
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        runChild,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    Truncate.node, // 终态准备沿同一依赖图使用现有截断 owner。
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"

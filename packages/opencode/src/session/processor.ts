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
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { ProviderError } from "@/provider/error"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq } from "drizzle-orm"
import { MessageTable } from "@opencode-ai/core/session/sql"
import type { EventV2 } from "@opencode-ai/core/event"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { Token } from "@opencode-ai/core/util/token"

// #149：取消时给 bash 等工具完成截断/complete 的宽限
// 500ms升级窗口后给并行工具2秒结算宽限；输出消费及finalizer仍由原owner收尾。
const ABORTED_TOOL_SETTLE_TIMEOUT = "2 seconds"

// 产品合同「最近三次脱扣」：同 tool + 同 input + 全 error 的窗口长度；与测试矩阵阈值绑定。
const DOOM_LOOP_THRESHOLD = 3
// #216：工具中止错误文案常量——prompt.ts/tools.ts 共用同一字符串判断中止路径
export const TOOL_ABORTED_ERROR = "Tool execution aborted"

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
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
    delivery?: "durable" | "ephemeral",
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
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
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

    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        toolInputBuffer: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        attemptPartIDs: new Set(),
        hasText: false,
        hasReasoning: false,
        hasToolCall: false,
      }
      let aborted = false
      // 三条终态写共享许可；只串行读写，不在其中等待工具完成信号。
      const toolPermit = Semaphore.makeUnsafe(1)

      // 只撤回当前不完整尝试，不能把整个 Message 或已执行工具当作可重放副作用。
      const discardIncompleteAttempt = Effect.fn("SessionProcessor.discardIncompleteAttempt")(function* () {
        yield* Effect.forEach([...ctx.attemptPartIDs], (partID) =>
          session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID }),
        )
        ctx.attemptPartIDs.clear()
        // 耗尽或退避中取消仍会走 cleanup，必须解除引用以免已删除正文被重新保存。
        ctx.currentText = undefined
        ctx.reasoningMap = {}
      })


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

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
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
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        // ephemeral 进度只广播不落盘，避免高频工具输出把 PartUpdated 逐 tick 刷进 SQLite。
        if (delivery === "ephemeral") {
          const part = update(match.part)
          yield* session.publishPartProgress(part)
          return part
        }
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const prepareToolOutput = Effect.fn("SessionProcessor.prepareToolOutput")(function* (output: {
        title: string
        metadata: Record<string, unknown>
        output: string
        attachments?: SessionV1.FilePart[]
      }, options?: { readonly tokenBudget?: number }) {
        const normalized = yield* Effect.forEach(output.attachments ?? [], (candidate) => {
          const proof = Image.consumeNormalized(candidate)
          // #534：ReadTool 的匹配 proof 证明同一 MIME/URL 已 decode；缺失或被插件改写时必须回到唯一 Image owner。
          // 非图片 attachment 仍经过 consume 是为了统一剥离潜在 transient 字段，但绝不送入图片 decoder。
          // typed image failure 只移除对应附件；同一个 Tool 的文本和其他成功附件必须继续交付。
          if (proof.valid) return Effect.succeed(Exit.succeed<SessionV1.FilePart>(proof.attachment))
          if (!proof.attachment.mime.startsWith("image/"))
            return Effect.succeed(Exit.succeed<SessionV1.FilePart>(proof.attachment))
          return image.normalize(proof.attachment, options).pipe(Effect.exit)
        })
        const omitted = normalized.filter(Exit.isFailure).length
        const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
        return {
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
        const result = prepared ? output : yield* prepareToolOutput(output, match.part.tool === "read" ? { tokenBudget: 1600 } : undefined)
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
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            // #216：中止路径统一用 TOOL_ABORTED_ERROR 文案——非中止路径保留原始错误原因
            error: toolAborted ? TOOL_ABORTED_ERROR : reason,
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            // #209：denied/failed auto-review 终态化为 error——UI 仍需 review 结果行和 reviewer 子会话链接
            // 中止时只更新审查终态，其他运行进度和普通错误metadata均保持完整。
            metadata: toolAborted ? interruptedToolMetadata(match.part.state.metadata, Date.now() - failStart) : match.part.state.metadata,
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
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

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
            (part) => part.type === "tool" && !part.hidden && part.state.status !== "pending",
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
            // [local-smark] 标记本轮已产生 tool 调用，用于 finish-step 空完成检测
            ctx.hasToolCall = true
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            // 某些 provider 省略 end；先持久化 pending 原文，再转换为解析后的 running input。
            const pendingRaw = ctx.toolInputBuffer[value.id]
            if (pendingRaw) {
              yield* updateToolCall(value.id, (match) => {
                if (match.state.status !== "pending") return match
                return { ...match, state: { ...match.state, raw: match.state.raw + pendingRaw } }
              })
              delete ctx.toolInputBuffer[value.id]
            }
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            // #508：doom_loop 仅在 tool-error 上做「同 tool + 同 input + 全 error」AND 判定。
            // tool-call 阶段结果未知：相同输入的成功重试是合法行为，不得在此预拦截。
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              // 已完成或已收尾的重复事件没有新失败，不能再次触发权限询问。
              if (!(yield* failToolCall(value.id, value.result.value))) return
              yield* askDoomLoopIfTripleFailure(toolCall?.part.tool ?? "unknown", toolCall?.part.state.input)
              return
            }
            const rawOutput = toolResultOutput(value)
            const output = yield* prepareToolOutput(rawOutput, toolCall?.part.tool === "read" ? { tokenBudget: 1600 } : undefined)
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
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
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

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
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
              ctx.assistantMessage.inputEstimate.confirmed = true
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
            if (ctx.snapshot && !aborted) {
          // #139：中断时跳过慢 git snapshot，优先完成终端态清理
          // #139：aborted 后 snapshot 非关键路径
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
              ctx.snapshot = undefined
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

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

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
        if (ctx.snapshot && !aborted) {
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

        const result = yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.attemptPartIDs.clear()
            // 每次重试都重新判断本轮输出，不能被旧标志误放行。
            ctx.hasText = false
            ctx.hasReasoning = false
            ctx.hasToolCall = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream({ ...streamInput, onRequestPrepared: (body) => Effect.gen(function* () {
              const history = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
              const samples = history.toReversed().flatMap((message) => {
                const info = message.info
                // 重放/重试只读已保存样本；provider 或模型切换不能借用旧比率。
                if (info.role !== "assistant" || info.providerID !== ctx.model.providerID || info.modelID !== ctx.model.id) return []
                // V1 单助手多 step 逐确认点取样；旧64数据缺少该字段时才沿用其已确认 carrier。
                const steps = message.parts.flatMap(part => part.type === "step-finish" && part.inputChars !== undefined
                  ? [{ bodyChars: part.inputChars, inputBreakdown: part.inputBreakdown, input: part.tokens.input + part.tokens.cache.read + part.tokens.cache.write }] : [])
                if (steps.length > 0) return steps.toReversed()
                if (!info.inputEstimate?.confirmed) return []
                return [{ bodyChars: info.inputEstimate.bodyChars, inputBreakdown: info.inputEstimate.inputBreakdown,
                  input: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write }]
              })
              // 每次请求准备都覆盖为未确认，旧 tokens 不得确认新请求体样本。
              const estimate = Token.estimateRequest(body, samples, streamInput.inputSections ?? [])
              // #194：同模型优先、会话历史回退，普通与摘要请求都在真实 prepared 入口学习。
              const charsPerToken = TokenEstimate.learnInputCharsPerToken({ messages: history, model: ctx.model })?.charsPerToken
                ?? estimate.charsPerToken ?? 4
              ctx.assistantMessage.inputEstimate = {
                ...estimate,
                // clamp 只调整文本密度，媒体 token 固定追加一次，raw 字符只作展示基数。
                input: Math.round((estimate.bodyChars - (estimate.inputBreakdown?.media?.rawChars ?? 0)
                  + (estimate.inputBreakdown?.media?.textChars ?? 0)) / charsPerToken) + (estimate.inputBreakdown?.media?.tokens ?? 0),
                charsPerToken,
                contextLimit: ctx.model.limit.context,
                // V1 单助手多 step：新的确认 part 会立即遮掉此轮估算。
                afterPartID: history.find(message => message.info.id === ctx.assistantMessage.id)?.parts.at(-1)?.id,
              }
              // 快照提交只刷新元数据；recordAssistant 仍只从 step-finish 结算。
              // 用即将发送的请求体判断，压缩保留的旧 tail 不再触发连续压缩。
              if (!ctx.assistantMessage.summary && isOverflow({
                cfg: yield* config.get(), model: ctx.model,
                tokens: { input: ctx.assistantMessage.inputEstimate.input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })) {
                ctx.needsCompaction = true
                return yield* Effect.die(preflightCompaction)
              }
              yield* publishAssistant(ctx.assistantMessage, events)
            }) })

            yield* stream.pipe(
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
            )
          }).pipe(
            // 保留 adapter 对 raw network_error 的更强失败路径，只补同一 no-Tool 撤回责任。
            Effect.tapError((error) => error instanceof ProviderError.ResponseStreamError && error.message === "Provider finish_reason: network_error" && !ctx.hasToolCall ? discardIncompleteAttempt() : Effect.void),
            // 转入已有 compact 结果，保留 cleanup 且不发布虚构的 provider 错误。
            Effect.catchCauseIf(
              (cause) => Cause.squash(cause) === preflightCompaction, () => Effect.void,
            ),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            // #214：SessionRetry.retry 封装替代 Effect.retry(SessionRetry.policy(...))
            // #214：processor 和 reviewer 子代理流共享同一重试策略和分类逻辑
            SessionRetry.retry({
              provider: input.model.providerID,
              parse,
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
            Effect.catch(halt),
            // #139：ensuring cleanup 必须尊重 aborted，跳过慢 snapshot
            Effect.ensuring(cleanup()),
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
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"

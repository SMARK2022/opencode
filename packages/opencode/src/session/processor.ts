import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Option, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { Image } from "@/image/image"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { SessionRequestUsage } from "./request-usage"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { RuntimeFlags } from "@/effect/runtime-flags"

// 产品合同「最近三次脱扣」：同 tool + 同 input + 全 error 的窗口长度；与测试矩阵阈值绑定。
const DOOM_LOOP_THRESHOLD = 3
// bounded kill（shell.ts 的 timeoutOrElse 500ms）后，tool 最多 500ms kill + ~500ms
// output drain = 1s。2s 给 ~100% 安全边际。settle 是 per-tool 并行（concurrency:
// "unbounded"），不串行累加。
const ABORTED_TOOL_SETTLE_TIMEOUT = "2 seconds"
export const TOOL_ABORTED_ERROR = "Tool execution aborted"
const log = Log.create({ service: "session.processor" })

/**
 * 工具完成时的 input 真值回写（INV-16 / write format 同构）。
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

/** 持久化 metadata 前去掉真值临时字段，避免进 DB / event。 */
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

// non-abort 终态不得抹掉 task 在 create 后写入的 sessionId：否则模型无法 resume。
// 这是 INV-07 的 first divergence 修复点：旧逻辑只留 autoReview，会丢掉 child id。
// 只保留 resume 所需字段 + 既有 autoReview，不把 running 进度 metadata 全量带入 error。
export function failedToolMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const next: Record<string, unknown> = {}
  // autoReview 合同保持：与历史 non-abort fail 行为一致
  if (isRecord(metadata.autoReview)) next.autoReview = metadata.autoReview
  // sessionId 即 task_id；parentSessionId 便于审计父子关系，投影只消费 sessionId
  if (typeof metadata.sessionId === "string") next.sessionId = metadata.sessionId
  if (typeof metadata.parentSessionId === "string") next.parentSessionId = metadata.parentSessionId
  return Object.keys(next).length > 0 ? next : undefined
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  inputChars: number | undefined
  inputBreakdown: MessageV2.StepFinishPart["inputBreakdown"]
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
    delivery?: "durable" | "ephemeral",
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  toolInputBuffer: Record<string, string>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  // 只记录本次 stream 已落库且可撤回的非 Tool Part；Tool Part 不进入集合，避免把外部副作用伪装成可安全重放。
  attemptPartIDs: Set<PartID>
  inputChars: number | undefined
  inputBreakdown: MessageV2.StepFinishPart["inputBreakdown"]
  // [local-smark] 追踪当前 step 是否产生了语义输出（text/reasoning/tool）。
  // 在 finish-step 时用于检测 provider 空完成：
  // finishReason="other"（AI SDK 对 network_error 等未知值的归一化）+ 三个标志全 false
  // = provider 返回了空终止流，必须抛出 retryable APIError 而非静默写成 completed。
  // 每个 process() 调用开头重置，retry 时也重置（与 currentText/reasoningMap 同处）。
  hasText: boolean
  hasReasoning: boolean
  hasToolCall: boolean
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
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
    const flags = yield* RuntimeFlags.Service

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
        inputChars: undefined,
        inputBreakdown: undefined,
        hasText: false,
        hasReasoning: false,
        hasToolCall: false,
      }
      let aborted = false
      // [local-smark] Tool 终态写入许可：串行化 completeToolCall / failToolCall /
      // cleanup 的 read-check-write，确保 ToolPart terminal state 有唯一 winner。
      // 不在 permit 内 await Tool Deferred——settleToolCall 的 Deferred.succeed 是同步的。
      const toolPermit = Semaphore.makeUnsafe(1)
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)
      let timing:
        | { startedAt: number; firstStreamEvent: boolean; firstDelta: Set<string> }
        | undefined

      // 这些 milestone 只写 daemon log，不记录 prompt、token 内容、工具参数
      // 或 provider metadata。phase 字符串是后续排查的稳定连接点：
      // processor.start/ai.first_event 区分 provider 首事件延迟，part.start /
      // part.first_delta 区分 processor 内部处理延迟，processor.end 标记回合收束。
      const streamTiming = (phase: string, extra?: Record<string, unknown>) => {
        if (!timing) return
        slog.info("stream timing", {
          phase,
          sessionID: ctx.sessionID,
          messageID: ctx.assistantMessage.id,
          elapsedMs: Date.now() - timing.startedAt,
          ...extra,
        })
      }
      const logPartStart = (partType: string, extra: Record<string, unknown>) => {
        streamTiming("part.start", { partType, ...extra })
      }
      const logFirstDelta = (partType: string, partID: string, field: string, deltaChars: number) => {
        if (!timing) return
        const key = `${partID}\0${field}`
        if (timing.firstDelta.has(key)) return
        timing.firstDelta.add(key)
        streamTiming("part.first_delta", { partType, partID, field, deltaChars })
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
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
        delivery: "durable" | "ephemeral" = "durable",
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const next = update(match.part)
        // delivery 只选择同一 next snapshot 的传输合同，不能重新执行 updater；
        // 否则有副作用的 metadata merge 会在 live/durable 分支产生不同 Part。
        // 缺省 durable 保持所有既有 Tool 调用语义；只有显式 ephemeral 的
        // shell progress 绕过 SQLite，并且仍复用同一个 Part updater。
        const part = yield* delivery === "ephemeral" ? session.publishPartProgress(next) : session.updatePart(next)
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
        attachments?: MessageV2.FilePart[]
      }) {
        const normalized = yield* Effect.forEach(output.attachments ?? [], (candidate) => {
          const proof = Image.consumeNormalized(candidate)
          // ReadTool 的匹配 proof 证明同一 MIME/URL 已 decode；缺失或被插件改写时必须回到唯一 Image owner。
          // 非图片 attachment 仍经过 consume 是为了统一剥离潜在 transient 字段，但绝不送入图片 decoder。
          // typed image failure 只移除对应附件；同一个 Tool 的文本和其他成功附件必须继续交付。
          if (proof.valid) return Effect.succeed(Exit.succeed<MessageV2.FilePart>(proof.attachment))
          if (!proof.attachment.mime.startsWith("image/"))
            return Effect.succeed(Exit.succeed<MessageV2.FilePart>(proof.attachment))
          return image.normalize(proof.attachment).pipe(Effect.exit)
        })
        const omitted = normalized.filter(Exit.isFailure).length
        const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
        return {
          ...output,
          // provider 不支持的坏图片降级为文本事实；不保留原 bytes，也不把一次附件失败升级为整个 tool-error。
          // omission 数量来自同一 normalized 数组，避免事件分支和数据库分支各自过滤后出现计数漂移。
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
          attachments?: MessageV2.FilePart[]
        },
        prepared = false,
      ) {
        // abort/provider-executed 等直达 completion 的路径也必须经过同一准备函数；普通 result 已准备时复用同一 snapshot。
        // prepared 标志只区分本函数内部已完成的普通事件路径，不是调用方可伪造的持久化 metadata。
        // direct 路径默认 false，因此取消时正常返回的 Tool 也无法绕过图片失败降级。
        const result = prepared ? output : yield* prepareToolOutput(output)
        // [local-smark] terminal state 写入需要串行化：确保 read-check-write 原子，
          // 防止 late metadata/result 或 cleanup 与正常完成路径竞争覆盖终态。
          yield* toolPermit.withPermits(1)(
            Effect.gen(function* () {
              const match = yield* readToolCall(toolCallID)
              if (!match) return
              if (match.part.state.status !== "running") {
                // Another cleanup path may already have terminalized the persisted
                // part.  Still settle the in-memory deferred so the LLM loop cannot
                // wait forever on a tool call whose DB state is already final.
                yield* settleToolCall(toolCallID)
                return
              }
              yield* session.updatePart({
                ...match.part,
                state: {
                  status: "completed",
                  input: resolveCompletedToolInput(
                    match.part.state.input as Record<string, unknown>,
                    result.metadata as Record<string, unknown> | undefined,
                  ),
                  output: result.output,
                  // strip 临时真值字段，避免进持久化 metadata
                  metadata: (() => {
                    const rest = stripToolTruthMetadata(result.metadata as Record<string, unknown> | undefined)
                    return match.part.state.metadata?.autoReview
                      ? { ...rest, autoReview: match.part.state.metadata.autoReview }
                      : rest
                  })(),
                  // ToolStateCompleted.title 契约是 string；raw AI SDK / 测试 tool 可不返回 title。
                  // 缺省写成空串（与 tool/registry 插件路径一致），禁止 undefined 经 JSON 省略后
                  // 让 ColdStorage extractPart 在 freeze/status 全库扫描时抛 corruption。
                  title: typeof result.title === "string" ? result.title : "",
                  time: { start: match.part.state.time.start, end: Date.now() },
                  attachments: result.attachments,
                },
              })
              yield* settleToolCall(toolCallID)
            }),
          )
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        // [local-smark] terminal state 写入串行化，与 completeToolCall 共享同一 permit，
          // 确保 fail / complete / cleanup 三条终态路径有唯一 winner。
          return yield* toolPermit.withPermits(1)(
            Effect.gen(function* () {
              const match = yield* readToolCall(toolCallID)
              if (!match) return false
              if (match.part.state.status !== "running") {
                yield* settleToolCall(toolCallID)
                return false
              }
              const reason = errorMessage(error)
              const toolAborted = aborted || reason === "Aborted" || reason === TOOL_ABORTED_ERROR
              // [local-smark] abort 时保留原 metadata 并写入 server-owned elapsedMs marker，
              // 使下一轮模型回放能追加 user_abort + elapsed_ms Notice。
              // non-abort 经 failedToolMetadata 保留 sessionId，避免 task create 后失败丢掉 resume id。
              // 不在此把 abort 改写为 completed，error 语义与 interrupted marker 必须保持。
              const failStart = match.part.state.time?.start ?? Date.now()
              yield* session.updatePart({
                ...match.part,
                state: {
                  status: "error",
                  input: match.part.state.input,
                  error: toolAborted ? TOOL_ABORTED_ERROR : reason,
                  metadata: toolAborted
                    ? interruptedToolMetadata(match.part.state.metadata, Date.now() - failStart)
                    : failedToolMetadata(match.part.state.metadata),
                  time: { start: failStart, end: Date.now() },
                },
              })
              if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              yield* settleToolCall(toolCallID)
              return true
            }),
          )
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ctx.sessionID,
                reasoningID: value.id,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            // [local-smark] 标记本轮已产生 reasoning 输出，用于 finish-step 空完成检测
            ctx.hasReasoning = true
            // reasoning Part 在 finish-step 前已落库；记录 ID 让 retry 清理当前 attempt，而不是清理整个 Message。
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
            logPartStart("reasoning", { partID: ctx.reasoningMap[value.id].id })
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            logFirstDelta("reasoning", ctx.reasoningMap[value.id].id, "text", value.text.length)
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Reasoning.Ended, {
                sessionID: ctx.sessionID,
                reasoningID: value.id,
                text: ctx.reasoningMap[value.id].text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Input.Started, {
                sessionID: ctx.sessionID,
                callID: value.id,
                name: value.toolName,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            // [local-smark] 标记本轮已产生 tool 调用，用于 finish-step 空完成检测
            ctx.hasToolCall = true
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            logPartStart("tool", { partID: part.id, callID: value.id })
            return

          case "tool-input-delta":
            // Accumulate raw in memory — no DB write per token.
            ctx.toolInputBuffer[value.id] = (ctx.toolInputBuffer[value.id] ?? "") + value.delta
            // Publish a bus-only delta so the UI stays real-time.
            const tcall = ctx.toolcalls[value.id]
            if (tcall) {
              logFirstDelta("tool", tcall.partID, "raw", value.delta.length)
              yield* session.updatePartDelta({
                sessionID: tcall.sessionID,
                messageID: tcall.messageID,
                partID: tcall.partID,
                field: "raw",
                delta: value.delta,
              })
            }
            return

          case "tool-input-end": {
            // Flush the accumulated raw string to DB in a single write.
            const buffered = ctx.toolInputBuffer[value.id]
            if (buffered) {
              delete ctx.toolInputBuffer[value.id]
              yield* updateToolCall(value.id, (match) => {
                if (match.state.status !== "pending") return match
                return { ...match, state: { ...match.state, raw: match.state.raw + buffered } }
              })
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ctx.sessionID,
                callID: value.id,
                text: "",
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // Flush any remaining buffer that wasn't flushed by tool-input-end.
            const pendingRaw = ctx.toolInputBuffer[value.toolCallId]
            if (pendingRaw) delete ctx.toolInputBuffer[value.toolCallId]
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                tool: value.toolName,
                input: value.input,
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))
            // doom_loop 仅在 tool-error 上做「同 tool + 同 input + 全 error」AND 判定。
            // tool-call 阶段结果未知：相同输入的成功重试是合法行为，不得在此预拦截。
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.toolCallId)
            const toolAttachments: MessageV2.FilePart[] = (
              Array.isArray(value.output.attachments) ? value.output.attachments : []
            ).filter(
              (attachment: unknown): attachment is MessageV2.FilePart =>
                isRecord(attachment) &&
                attachment.type === "file" &&
                typeof attachment.mime === "string" &&
                typeof attachment.url === "string",
            )
            const output = yield* prepareToolOutput({
              ...value.output,
              attachments: toolAttachments.length ? toolAttachments : undefined,
            })
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              // strip 真值临时字段，与持久化 metadata 一致
              const eventMetadata = stripToolTruthMetadata(output.metadata as Record<string, unknown> | undefined)
              yield* events.publish(SessionEvent.Tool.Success, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                structured: eventMetadata,
                content: [
                  {
                    type: "text",
                    text: output.output,
                  },
                  ...(output.attachments?.map((item: MessageV2.FilePart) => ({
                    type: "file" as const,
                    uri: item.url,
                    mime: item.mime,
                    name: item.filename,
                  })) ?? []),
                ],
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* completeToolCall(value.toolCallId, output, true)
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Failed, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                error: {
                  type: "unknown",
                  message: errorMessage(value.error),
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.toolCallId, value.error)
            // doom_loop AND（用户 OR→AND）：最近 THRESHOLD 条非 pending tool 必须同时满足：
            // 同 tool 名、同 JSON.stringify(input)、status 全为 error；缺任一条件不 ask。
            // 仅相同输入（含成功）或仅跨 turn 不同 input 的连续失败都不拦截。
            // 窗口 = 跨多个前序 assistant 的有界 tail + 当前 message tool parts。
            // transcript 是唯一权威：已删除 layer 内 consecutiveErrorMap，避免双源与 input 无关计数。
            // THRESHOLD=3 与产品「三次脱扣」字面一致；改常量须同步测试矩阵。
            const toolName = toolCall?.part.tool ?? "unknown"
            const failedInput = toolCall?.part.state.input
            // 当前 message 只取 tool 终态，避免 step-finish/text 挤占 slice 尾部导致漏检。
            const currentTools = MessageV2.parts(ctx.assistantMessage.id).filter(
              // current Tool 与历史 Tool 使用同一 visible contract，hidden error 不计入阈值。
              (part) => part.type === "tool" && !part.hidden && part.state.status !== "pending",
            )
            const preceding = MessageV2.previousAssistantToolTail({
              sessionID: ctx.sessionID,
              before: { id: ctx.assistantMessage.id, time: ctx.assistantMessage.time.created },
              limit: DOOM_LOOP_THRESHOLD,
            })
            const window = [...preceding, ...currentTools].slice(-DOOM_LOOP_THRESHOLD)
            // 与历史 identical 路径同用 JSON.stringify：不额外规范化键序，保持可比合同。
            const inputKey = JSON.stringify(failedInput)
            if (
              window.length === DOOM_LOOP_THRESHOLD &&
              window.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === toolName &&
                  part.state.status === "error" &&
                  JSON.stringify(part.state.input) === inputKey,
              )
            ) {
              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: toolName, input: failedInput, consecutiveErrors: DOOM_LOOP_THRESHOLD },
                always: [toolName],
                ruleset: agent.permission,
              })
            }
            return
          }

          case "error":
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: ctx.sessionID,
                  agent: input.assistantMessage.agent,
                  model: {
                    id: ModelV2.ID.make(ctx.model.id),
                    providerID: ProviderV2.ID.make(ctx.model.providerID),
                    variant: ModelV2.VariantID.make(input.assistantMessage.variant ?? "default"),
                  },
                  snapshot: ctx.snapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            // step-start 也属于当前尝试；失败时与 text/reasoning 一起撤回，避免留下孤立成功步骤。
            const stepPartID = PartID.ascending()
            ctx.attemptPartIDs.add(stepPartID)
            yield* session.updatePart({
              id: stepPartID,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
              // Expose the daemon's pre-request input snapshot so the TUI can
              // show per-category context usage immediately during streaming,
              // before the provider confirms token totals via step-finish.
              inputChars: ctx.inputChars,
              inputTokens: ctx.assistantMessage.tokens.input + ctx.assistantMessage.tokens.cache.read + ctx.assistantMessage.tokens.cache.write,
              inputBreakdown: ctx.inputBreakdown,
            })
            return

          case "finish-step": {
            const completedSnapshot = yield* snapshot.track()
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            // [local-smark] `other` 只在没有 Tool 的当前 attempt 中引流到既有 retry；
            // Tool 生命周期和后续重试策略由 prompt loop 另行拥有，本分支不重放 Tool。
            // 这里转换的是 Provider completion 语义，不改变外层 retry 的退避或次数。
            if (value.finishReason === "other" && !ctx.hasToolCall) {
              yield* Effect.forEach([...ctx.attemptPartIDs], (partID) =>
                session.removePart({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, partID }),
              )
              // 清理先于抛错，确保 retry 接收到的错误不会与上一轮部分输出混合。
              ctx.attemptPartIDs.clear()
              throw new MessageV2.APIError({
                message: `Provider returned incomplete completion (finish_reason: ${value.finishReason})`,
                isRetryable: true,
                metadata: { finishReason: value.finishReason },
              })
            }
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ctx.sessionID,
                  finish: value.finishReason,
                  cost: usage.cost,
                  tokens: usage.tokens,
                  snapshot: completedSnapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
              inputChars: ctx.inputChars,
              inputBreakdown: ctx.inputBreakdown,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            const reqUsage1 = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
            if (reqUsage1)
              yield* reqUsage1.recordAssistant({
                sessionID: ctx.sessionID,
                requestID: ctx.assistantMessage.parentID,
                assistant: ctx.assistantMessage,
              })
            if (ctx.snapshot) {
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
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Started, {
                  sessionID: ctx.sessionID,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            // [local-smark] 标记本轮已产生 text 输出，用于 finish-step 空完成检测
            ctx.hasText = true
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            // 结束后的 textPart 不再保存在 currentText 中，集合保留其 ID 供 finish-step 撤回。
            ctx.attemptPartIDs.add(ctx.currentText.id)
            yield* session.updatePart(ctx.currentText)
            logPartStart("text", { partID: ctx.currentText.id })
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            logFirstDelta("text", ctx.currentText.id, "text", value.text.length)
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
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Ended, {
                  sessionID: ctx.sessionID,
                  text: ctx.currentText.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
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

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
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
        // On interrupt, terminal assistant/tool state is the important cleanup
        // boundary.  Snapshot patching can involve slow git subprocess teardown,
        // so skip it for aborted turns rather than delaying cancellation.
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

        // On cancel, tool execution may still be unwinding from its AbortSignal.
        // Give tool-specific abort handlers (notably bash output truncation) a
        // chance to completeToolCall() before the generic cleanup marks leftovers
        // as interrupted errors.
        if (aborted) {
          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout(ABORTED_TOOL_SETTLE_TIMEOUT), Effect.ignore),
            { concurrency: "unbounded", discard: true },
          )
        }

        for (const call of Object.values(ctx.toolcalls)) {
          yield* Deferred.succeed(call.done, undefined).pipe(Effect.ignore)
        }

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          // [local-smark] cleanup 终态写入也走 permit，确保与 completeToolCall /
          // failToolCall 串行化。如果工具已完成（终态由 stream event 写入），
          // readToolCall 重读后 status !== "running"，直接跳过不覆盖。
          yield* toolPermit.withPermits(1)(
            Effect.gen(function* () {
              const match = yield* readToolCall(toolCallID)
              if (!match) return
              const part = match.part
              // 已终态的 ToolPart 不覆盖——stream event 的 complete/fail 是 winner
              if (part.state.status !== "running" && part.state.status !== "pending") return
              const end = Date.now()
              const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
              // Merge any un-flushed raw buffer into the part before writing error state.
              const pendingRaw = ctx.toolInputBuffer[toolCallID]
              if (pendingRaw) delete ctx.toolInputBuffer[toolCallID]
              yield* session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  ...(part.state.status === "pending" && pendingRaw
                    ? { raw: part.state.raw + pendingRaw }
                    : {}),
                  status: "error",
                  error: aborted ? TOOL_ABORTED_ERROR : "Tool execution did not complete before stream ended",
                  // [local-smark] abort 时写入 elapsed marker，供下一轮回放追加 Notice
                  metadata: aborted ? interruptedToolMetadata(metadata, end - ("time" in part.state ? part.state.time.start : end)) : metadata,
                  time: { start: "time" in part.state ? part.state.time.start : end, end },
                },
              })
            }),
          )
        }
        ctx.toolcalls = {}
        ctx.toolInputBuffer = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
        const reqUsage2 = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
        if (reqUsage2)
          yield* reqUsage2.recordAssistant({
            sessionID: ctx.sessionID,
            requestID: ctx.assistantMessage.parentID,
            assistant: ctx.assistantMessage,
          })
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (flags.experimentalEventSystem) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: ctx.sessionID,
              error: {
                type: "unknown",
                message: errorMessage(e),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        timing = { startedAt: Date.now(), firstStreamEvent: false, firstDelta: new Set() }
        streamTiming("processor.start", {
          providerID: ctx.model.providerID,
          modelID: ctx.model.id,
          agent: streamInput.agent.name,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const result = yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            // 每次 retry 建立新的 attempt 集合；上一轮已撤回，其他错误路径保持原有持久化行为。
            ctx.attemptPartIDs.clear()
            // [local-smark] 重置语义输出追踪标志：retry 时上一轮的 hasText 等标志
            // 必须清零，否则空完成检测会因残留标志而跳过。
            ctx.hasText = false
            ctx.hasReasoning = false
            ctx.hasToolCall = false
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (timing && !timing.firstStreamEvent) {
                    timing.firstStreamEvent = true
                    streamTiming("ai.first_event", { event: event.type })
                  }
                  yield* handleEvent(event)
                }),
              ),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
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
            SessionRetry.retry({
              provider: input.model.providerID,
              parse,
              set: (info) => {
                // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                const event = flags.experimentalEventSystem
                  ? events.publish(SessionEvent.Retried, {
                      sessionID: ctx.sessionID,
                      attempt: info.attempt,
                      error: {
                        message: info.message,
                        isRetryable: true,
                      },
                      timestamp: DateTime.makeUnsafe(Date.now()),
                    })
                  : Effect.void
                return event.pipe(
                  Effect.andThen(
                    status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      action: info.action,
                      next: info.next,
                    }),
                  ),
                )
              },
            }),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
        streamTiming("processor.end", {
          result,
          durationMs: timing ? Date.now() - timing.startedAt : 0,
        })
        timing = undefined
        return result
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get inputChars() {
          return ctx.inputChars
        },
        set inputChars(value: number | undefined) {
          ctx.inputChars = value
        },
        get inputBreakdown() {
          return ctx.inputBreakdown
        },
        set inputBreakdown(value: MessageV2.StepFinishPart["inputBreakdown"]) {
          ctx.inputBreakdown = value
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"

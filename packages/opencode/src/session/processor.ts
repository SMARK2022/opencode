import { TokenEstimate } from "@/token/estimate"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Option, Scope, Schema } from "effect"
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
const ABORTED_TOOL_SETTLE_TIMEOUT = "4 seconds"

const DOOM_LOOP_THRESHOLD = 3
// #216：工具中止错误文案常量——prompt.ts/tools.ts 共用同一字符串判断中止路径
export const TOOL_ABORTED_ERROR = "Tool execution aborted"

// #216：中断工具 metadata 构造——保留已有 autoReview 信封并标记 aborted 状态，供 UI 渲染审查终止行
export function interruptedToolMetadata(metadata: Record<string, unknown> | undefined) {
  const base = metadata ?? {}
  const autoReview = base.autoReview
  if (!isRecord(autoReview)) return { ...base, interrupted: true }
  return { ...base, interrupted: true, autoReview: { ...autoReview, status: "aborted", error: TOOL_ABORTED_ERROR } }
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
      }
      let aborted = false

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
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        // #139：DB 已终态时仍 settle deferred，避免 LLM 死等
        if (match.part.state.status !== "running") {
          yield* settleToolCall(toolCallID)
          return
        }
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            // #209：auto-review 注解在 running 状态附加——completion 替换 metadata 时保留 autoReview 信封
            // #209：completion 用工具自身 output.metadata 覆盖——autoReview 是 reviewer 写入的外部注解，不属于工具输出，必须显式回填
            // #209：无 autoReview 时直接用 output.metadata——非自动审查的工具不携带 reviewer 信封，无需额外合并
            metadata: match.part.state.metadata?.autoReview
              ? { ...output.metadata, autoReview: match.part.state.metadata.autoReview }
              : output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

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
            metadata: toolAborted ? interruptedToolMetadata(match.part.state.metadata) : match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

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

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
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

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                // 沿用唯一附件归一化分支，只有实际 Read 调用携带源预算。
                ? image.normalize(attachment, toolCall?.part.tool === "read" ? 1600 * 750 : undefined).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            // #124：把 daemon 请求前快照写入 step-start，供 streaming 展示分类
            yield* session.updatePart({
              id: PartID.ascending(),
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
            ctx.currentText = {
              id: PartID.ascending(),
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
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          // 协调信号唤醒后仍须先提交工具终态；error schema 不保留 state.raw，残余原文存入 metadata。
          const pendingRaw = ctx.toolInputBuffer[toolCallID]
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              // #153：区分用户中断与流结束未完成，避免误导性的 interrupted 标记
              // 非 abort 的未完成属于上游流异常收尾，不标记 interrupted 以免重试逻辑误判
              // #216：cleanup 路径也用 TOOL_ABORTED_ERROR 和 interruptedToolMetadata 保持文案/metadata 一致
              error: aborted ? TOOL_ABORTED_ERROR : "Tool execution did not complete before stream ended",
              metadata: { ...(aborted ? interruptedToolMetadata(metadata) : metadata),
                ...(part.state.status === "pending" ? { raw: part.state.raw + (pendingRaw ?? "") } : {}),
              },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
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

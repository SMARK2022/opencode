import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Option, Schema } from "effect"
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
import { SessionRequestUsage } from "./request-usage"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolOutput, Usage, type LLMEvent } from "@opencode-ai/llm"
import * as Log from "@opencode-ai/core/util/log"

const DOOM_LOOP_THRESHOLD = 3
const ABORTED_TOOL_SETTLE_TIMEOUT = "4 seconds"
export const TOOL_ABORTED_ERROR = "Tool execution aborted"
const log = Log.create({ service: "session.processor" })

export function interruptedToolMetadata(metadata: Record<string, unknown> | undefined) {
  const base = metadata ?? {}
  const autoReview = base.autoReview
  if (!isRecord(autoReview)) return { ...base, interrupted: true }
  return { ...base, interrupted: true, autoReview: { ...autoReview, status: "aborted", error: TOOL_ABORTED_ERROR } }
}
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  inputChars: number | undefined
  inputBreakdown: MessageV2.StepFinishPart["inputBreakdown"]
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
  assistantMessageID?: SessionMessage.ID
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  inputEnded: boolean
  raw: string
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  toolInputBuffer: Record<string, string>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  currentTextID: string | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  inputChars: number | undefined
  inputBreakdown: MessageV2.StepFinishPart["inputBreakdown"]
  v2AssistantMessageID: SessionMessage.ID | undefined
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
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
    const flags = yield* RuntimeFlags.Service
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
        currentTextID: undefined,
        reasoningMap: {},
        inputChars: undefined,
        inputBreakdown: undefined,
        v2AssistantMessageID: undefined,
      }
      const mirrorAssistant = flags.experimentalEventSystem && !input.assistantMessage.summary
      let aborted = false
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

      const ensureV2AssistantMessage = Effect.fn("SessionProcessor.ensureV2AssistantMessage")(function* () {
        if (ctx.v2AssistantMessageID) return ctx.v2AssistantMessageID
        ctx.v2AssistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: ctx.sessionID,
          assistantMessageID: ctx.v2AssistantMessageID,
          agent: input.assistantMessage.agent,
          model: {
            id: ModelV2.ID.make(ctx.model.id),
            providerID: ProviderV2.ID.make(ctx.model.providerID),
            variant: ModelV2.VariantID.make(input.assistantMessage.variant ?? "default"),
          },
          snapshot: ctx.snapshot,
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        return ctx.v2AssistantMessageID
      })

      const requireV2AssistantMessage = (toolCall?: ToolCall) =>
        toolCall?.assistantMessageID === undefined
          ? Effect.die("V2 tool settlement has no owning assistant message")
          : Effect.succeed(toolCall.assistantMessageID)

      const currentV2AssistantMessage = () =>
        ctx.v2AssistantMessageID === undefined
          ? Effect.die("V2 step settlement has no owning assistant message")
          : Effect.succeed(ctx.v2AssistantMessageID)

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
            input: match.part.state.input,
            output: output.output,
            // Permission auto-review annotates the running tool part before the
            // reviewed command executes. Tool completion replaces metadata with
            // the tool's own result, so preserve that small review envelope here
            // to keep the final shell card linked to the reviewer subagent.
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
        if (match.part.state.status !== "running") {
          yield* settleToolCall(toolCallID)
          return false
        }
        const reason = errorMessage(error)
        const toolAborted = aborted || reason === "Aborted" || reason === TOOL_ABORTED_ERROR
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: toolAborted ? TOOL_ABORTED_ERROR : reason,
            // Denied/failed auto reviews terminalize the shell as an error, but
            // the UI still needs the review result line and reviewer-session link
            // that were attached while the tool was running.
            metadata: match.part.state.metadata?.autoReview
              ? toolAborted
                ? interruptedToolMetadata(match.part.state.metadata)
                : { autoReview: match.part.state.metadata.autoReview }
              : undefined,
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
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (mirrorAssistant) {
          yield* events.publish(SessionEvent.Reasoning.Ended, {
            sessionID: ctx.sessionID,
            assistantMessageID: yield* currentV2AssistantMessage(),
            reasoningID,
            text: ctx.reasoningMap[reasoningID].text,
            providerMetadata: ctx.reasoningMap[reasoningID].metadata,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const flushV2Fragments = Effect.fn("SessionProcessor.flushV2Fragments")(function* () {
        if (!mirrorAssistant) return
        if (!ctx.assistantMessage.summary && ctx.currentText && ctx.currentTextID) {
          yield* events.publish(SessionEvent.Text.Ended, {
            sessionID: ctx.sessionID,
            assistantMessageID: yield* currentV2AssistantMessage(),
            textID: ctx.currentTextID,
            text: ctx.currentText.text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        yield* Effect.forEach(Object.entries(ctx.reasoningMap), ([reasoningID, part]) =>
          currentV2AssistantMessage().pipe(
            Effect.flatMap((assistantMessageID) =>
              events.publish(SessionEvent.Reasoning.Ended, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                reasoningID,
                text: part.text,
                providerMetadata: part.metadata,
                timestamp: DateTime.makeUnsafe(Date.now()),
              }),
            ),
          ),
        )
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
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        const assistantMessageID = mirrorAssistant ? yield* ensureV2AssistantMessage() : undefined
        if (assistantMessageID) {
          yield* events.publish(SessionEvent.Tool.Input.Started, {
            sessionID: ctx.sessionID,
            assistantMessageID,
            callID: input.id,
            name: input.name,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
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
          assistantMessageID,
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
          raw: "",
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
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ctx.sessionID,
                assistantMessageID: yield* ensureV2AssistantMessage(),
                reasoningID: value.id,
                providerMetadata: value.providerMetadata,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
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
            logPartStart("reasoning", { partID: ctx.reasoningMap[value.id].id })
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            logFirstDelta("reasoning", ctx.reasoningMap[value.id].id, "text", value.text.length)
            if (mirrorAssistant) {
              yield* events.publish(SessionEvent.Reasoning.Delta, {
                sessionID: ctx.sessionID,
                assistantMessageID: yield* currentV2AssistantMessage(),
                reasoningID: value.id,
                delta: value.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
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
            const toolStart = yield* ensureToolCall(value)
            logPartStart("tool", { partID: toolStart.part.id, callID: value.id })
            return

          case "tool-input-delta":
            {
              const toolCall = yield* ensureToolCall(value)
              logFirstDelta("tool", toolCall.call.partID, "raw", value.text.length)
              const assistantMessageID = mirrorAssistant ? yield* requireV2AssistantMessage(toolCall.call) : undefined
              if (assistantMessageID) {
                yield* events.publish(SessionEvent.Tool.Input.Delta, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  delta: value.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
              ctx.toolcalls[value.id] = { ...toolCall.call, raw: toolCall.call.raw + value.text }
            }
            return

          case "tool-input-end": {
            const toolCall = yield* ensureToolCall(value)
            yield* updateToolCall(value.id, (match) => {
              if (match.state.status !== "pending") return match
              return { ...match, state: { ...match.state, raw: toolCall.call.raw } }
            })
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                text: toolCall.call.raw,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.toolcalls[value.id] = { ...toolCall.call, inputEnded: true }
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const toolCall = yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            if (!toolCall.call.inputEnded) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
                yield* events.publish(SessionEvent.Tool.Input.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  text: toolCall.call.raw,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            yield* updateToolCall(value.id, (match) => {
              if (match.state.status !== "pending") return match
              return { ...match, state: { ...match.state, raw: toolCall.call.raw } }
            })
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall.call)
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                tool: value.name,
                input,
                provider: {
                  executed: toolCall.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
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
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
                yield* events.publish(SessionEvent.Tool.Failed, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  error: { type: "unknown", message: errorMessage(value.result.value) },
                  result: value.result,
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
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
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
              const content = [
                { type: "text" as const, text: output.output },
                ...(output.attachments?.map(
                  (item: SessionV1.FilePart) =>
                    ({
                      type: "file",
                      uri: item.url,
                      mime: item.mime,
                      name: item.filename,
                    }) as const,
                ) ?? []),
              ]
              const unsupported = content.find((item) => item.type === "file" && !item.uri.startsWith("data:"))
              if (unsupported?.type === "file") {
                const error = new Error(
                  `Tool attachment URI "${unsupported.uri}" must be materialized before durable V2 settlement`,
                )
                yield* events.publish(SessionEvent.Tool.Failed, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  error: {
                    type: "unknown",
                    message: error.message,
                  },
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
                yield* failToolCall(value.id, error)
                return
              } else
                yield* events.publish(SessionEvent.Tool.Success, {
                  sessionID: ctx.sessionID,
                  assistantMessageID,
                  callID: value.id,
                  structured: output.metadata,
                  content,
                  result: value.result,
                  provider: {
                    executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                    ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                  },
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.id)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (mirrorAssistant) {
              const assistantMessageID = yield* requireV2AssistantMessage(toolCall?.call)
              yield* events.publish(SessionEvent.Tool.Failed, {
                sessionID: ctx.sessionID,
                assistantMessageID,
                callID: value.id,
                error: {
                  type: "unknown",
                  message: value.message,
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* ensureV2AssistantMessage()
              }
            }
            yield* session.updatePart({
              id: PartID.ascending(),
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

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* currentV2AssistantMessage(),
                  finish: value.reason,
                  cost: usage.cost,
                  tokens: usage.tokens,
                  snapshot: completedSnapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
                ctx.v2AssistantMessageID = undefined
              }
            }
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
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
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Text.Started, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* ensureV2AssistantMessage(),
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  textID: value.id,
                })
              }
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.currentTextID = value.id
            yield* session.updatePart(ctx.currentText)
            logPartStart("text", { partID: ctx.currentText.id })
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            logFirstDelta("text", ctx.currentText.id, "text", value.text.length)
            if (mirrorAssistant) {
              yield* events.publish(SessionEvent.Text.Delta, {
                sessionID: ctx.sessionID,
                assistantMessageID: yield* currentV2AssistantMessage(),
                textID: value.id,
                delta: value.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
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
              if (mirrorAssistant) {
                yield* events.publish(SessionEvent.Text.Ended, {
                  sessionID: ctx.sessionID,
                  assistantMessageID: yield* currentV2AssistantMessage(),
                  text: ctx.currentText.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                  textID: value.id,
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
            ctx.currentTextID = undefined
            return

          case "finish":
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
          ctx.currentTextID = undefined
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
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          if (mirrorAssistant && match.call.assistantMessageID) {
            yield* events.publish(SessionEvent.Tool.Failed, {
              sessionID: ctx.sessionID,
              assistantMessageID: match.call.assistantMessageID,
              callID: toolCallID,
              error: { type: "unknown", message: "Tool execution aborted" },
              provider: { executed: part.metadata?.providerExecuted === true },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
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
              metadata: aborted ? interruptedToolMetadata(metadata) : metadata,
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
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
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        yield* flushV2Fragments()
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
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (mirrorAssistant) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: ctx.sessionID,
              assistantMessageID: yield* ensureV2AssistantMessage(),
              error: {
                type: "unknown",
                message: errorMessage(e),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
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
        streamTiming("processor.start", {
          providerID: ctx.model.providerID,
          modelID: ctx.model.id,
          agent: streamInput.agent.name,
        })
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const result = yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.currentTextID = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
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
                const event = mirrorAssistant
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
                return flushV2Fragments().pipe(
                  Effect.andThen(event),
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
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
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
  RuntimeFlags.node,
  Database.node,
])

export * as SessionProcessor from "./processor"

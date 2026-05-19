export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Cause, DateTime, Effect, Exit, Stream } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import type { Config } from "../config"
import { EventV2 } from "../event"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { tokens } from "./runner/publish-llm-event"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionRunnerModel } from "./runner/model"

const DEFAULT_BUFFER = 20_000
const DEFAULT_BUFFER_MIN = 5_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
// 保留上游工作状态结构；文件定位与错误修复单列，避免恢复时重读文件或重复失败尝试。
// 原生 Core 摘要不经过 V1 agent，语言约束须放在共享模板；路径、符号和错误等字面值仍保持原样。
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Files & Code
- [path: relevant symbols/sections and why they matter, or "(none)"]

## Errors & Fixes
- [exact error/output and fix or current status, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Respond in the same language as the conversation.
- Preserve exact file paths, symbols, commands, error strings, URLs, identifiers, and line numbers when known.
- Prefer facts over speculation; remove stale or resolved details to keep the snapshot accurate.
- Files entries must include why they matter and relevant symbols.
- Errors entries must include the fix or current status so the next model does not repeat dead ends.
- No long file contents or large command outputs — reference them, do not reproduce them.
- Do not mention the summary process or that context was compacted.`
// 前次摘要会被丢弃；合并必须保留仍需继续的约束，并由较新对话纠正旧事实。
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished, resolved, or no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  // 保留缺省与显式零的区别，provider reserve 只抵消缺省输入缓冲。
  readonly buffer?: number
  readonly tokens: number
}

type Dependencies = {
  // 唯一 runner 传入同一个 db；只验证本次 durable 身份，不查询或修改其他请求。
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  // 私有调用输入保留同次采样的价格和选择，不向公共 LLM Model 增加元数据字段。
  readonly pricing: ModelV2.Info["cost"]
  readonly variant?: ModelV2.Ref["variant"]
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
  manual = false,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    // 短会话也能手动摘要，但仍保留其余完整近期消息，而不是丢掉工具 tail。
    if (manual && index === 0) break
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

// V1 与 V2 共用此入口，首次快照和前次摘要合并都使用同一模板，避免维护第二套 builder。
export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input, reason: "auto" | "manual" = "auto") {
    const context = input.model.route.defaults.limits?.context
    if (reason === "auto" && (context === undefined || context <= 0)) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens, reason === "manual")
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    // 摘要也发送到同一模型，独立 input 上限不能只约束普通 turn 而放过摘要请求。
    if (context !== undefined && context > 0 && Token.estimate(summaryPrompt) > Math.min(input.model.route.defaults.limits?.input || context, context - summaryOutput)) return false
    const messageID = SessionMessage.ID.create()
    const startedEventID = EventV2.ID.create()
    const terminalEventID = EventV2.ID.create()
    // 一个现有压缩 stream 只有一个 provider turn，结算快照不另外驱动模型。
    let usage = { tokens: tokens(undefined), cost: 0, stepCount: 0 }
    const fail = Effect.fnUntraced(function* (aborted: boolean, message: string, finalizer = false) {
      yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: input.sessionID, messageID, timestamp: yield* DateTime.now,
        error: { type: "unknown", message }, aborted, usage,
      }, { id: terminalEventID, finalizer })
    })
    // 在 Started 之前注册，publish 的 commit 后 listener 与 terminal notify 都属于同一 scope。
    yield* Effect.addFinalizer((exit) => Effect.gen(function* () {
      if (Exit.isSuccess(exit)) return
      const committed = yield* dependencies.db.select({ id: EventTable.id }).from(EventTable)
        .where(and(eq(EventTable.aggregate_id, input.sessionID), inArray(EventTable.id, [startedEventID, terminalEventID]))).all().pipe(Effect.orDie)
      // commit hook 和返回前标志不能证明 SQL commit；已有 terminal 时不能重复 Ended/Failed。
      if (!committed.some(row => row.id === startedEventID) || committed.some(row => row.id === terminalEventID)) return
      // 只在真实 scope 退出启用短通知；运行时无摘要失败继续通知全部原 observer。
      yield* fail(Cause.hasInterrupts(exit.cause), String(Cause.squash(exit.cause)), true)
    }))
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
      // Started 冻结真实调用的 variant；未选择时仍省略，不在 finish 时查询会话或猜默认值。
      model: { id: ModelV2.ID.make(input.model.id), providerID: ProviderV2.ID.make(input.model.provider),
        ...(input.variant === undefined ? {} : { variant: input.variant }) },
    }, { id: startedEventID })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.request.http,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            const counted = tokens(event.usage)
            usage = { tokens: counted, cost: SessionRunnerModel.cost(input.pricing, counted), stepCount: 1 }
          }
          return Effect.void
        }),
        Effect.as(true),
        // 显式维护必须向调用者保留提供者失败，不能用 false 伪装成功。
        Effect.catchTag("LLM.Error", (error) => reason === "manual" ? Effect.fail(error) : Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) {
      yield* fail(false, "Compaction did not produce a usable summary")
      return false
    }
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
      text: summary,
      recent: selected.recent,
      usage,
    }, { id: terminalEventID })
    return true
    // 压缩返回前关闭自己的生命周期，不借用外层 prompt 的终态保护。
  }, Effect.scoped)
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    // 总窗口仍完整预留实际输出与 Core buffer，不能用较小 input 改写 context 后再次扣输出。
    const usable = context - Math.max(output, config.buffer ?? DEFAULT_BUFFER)
    const inputLimit = input.model.route.defaults.limits?.input
    // 输入增长只扣显式 buffer 或抵消 provider 差额后的缺省 floor，与总窗口预算取交集。
    const inputUsable = inputLimit
      ? Math.max(0, inputLimit - (config.buffer ?? Math.max(DEFAULT_BUFFER_MIN, DEFAULT_BUFFER - Math.max(0, context - inputLimit))))
      : usable
    if (
      // 媒体预算必须在压缩判定前生效，不能等 provider 准备完成才纠正 base64 的文本估值。
      Token.estimateRequest({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }, []).input <=
      Math.min(usable, inputUsable)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compact: (input: Input) => compactAfterOverflow(input, "manual"),
    compactAfterOverflow,
  }
}

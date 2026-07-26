import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbortedError, SessionV1 } from "@opencode-ai/core/v1/session"
// #242：AbortedError 随取消语义从 core 错误模型直接引入，避免经 MessageV2 间接引用
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
// #194：改用 TokenEstimate 统一上传估算
import { TokenEstimate } from "@/token/estimate"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Exit, Option, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CompactionFileEvidence } from "./file-evidence"
import { Todo } from "./todo"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
// 压缩回放时旧 tool 输出的 head/tail 双向截断预算。
// head=400 保 shell 头部的截断 notice（path 属性排在 guidance 前，长路径下
// 即使切到 notice 中段也能保住 path 前缀）；tail=2000 保 tool 末尾的截断
// notice 完整含 path，避免模型压缩后丢失恢复文件路径。
// #328：400/2000 的不对称是刻意设计——头部只需容纳 notice 的 path 前缀，尾部要装完整恢复指引。
const TOOL_OUTPUT_HEAD_CHARS = 400
const TOOL_OUTPUT_TAIL_CHARS = 2_000
// [local-smark] read 输出也受 prune 保护：compaction 后模型最常复用的是文件内容，
// 丢 read 证据会迫使模型重新读盘；skill 此前已受保护。
const PRUNE_PROTECTED_TOOLS = ["skill", "read"]
// #255：保留预算上下限翻倍——长会话尾部保留 4K-16K 令牌，降低频繁压缩对长任务的扰动
const MIN_PRESERVE_RECENT_TOKENS = 4_000
const MAX_PRESERVE_RECENT_TOKENS = 16_000
// #256：整轮尾部保留之外，还需要一条独立的最近用户指令通道（memento）：工具密集的
// 最近一轮可能因预算限制整轮被压缩，但用户最新意图必须原样交给后续模型。
// #256：20K 对齐 Codex memento 的绝对上限；ratio 0.2 使预算始终随模型窗口伸缩。
const DEFAULT_PRESERVE_RECENT_USER_TOKENS = 20_000
const PRESERVE_RECENT_USER_RATIO = 0.2
// #256：截断标记是模型可见交接的一部分——后续模型据此知道缺失文本是 memento 预算
// 主动省略而非用户删除。保持短小，因为它会出现在本就紧张的上下文中。
const RECENT_USER_MEMENTO_TRUNCATED = "...[truncated for compaction memento]"
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  // #328：head/tail 双向截断——head=400 保 notice 的 path 前缀（path 属性排在 guidance 前），
  // tail=2000 保 tool 末尾 notice 完整含 path，压缩回放不丢恢复文件路径。
  value.length <= TOOL_OUTPUT_HEAD_CHARS + TOOL_OUTPUT_TAIL_CHARS
    ? value
    : `${value.slice(0, TOOL_OUTPUT_HEAD_CHARS)}\n[truncated]\n...\n${value.slice(-TOOL_OUTPUT_TAIL_CHARS)}`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    // 确定性证据由本次磁盘重新生成，不把旧表格混入下一次模型摘要。
    .filter((part) => part.metadata?.kind !== CompactionFileEvidence.kind)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

// #256：memento 预算没有下限——与整轮尾部不同，它是 summary+tail 之上的增量，
// 小窗口模型必须允许把它缩到 0，否则压缩重放后立刻再次溢出。
function preserveRecentUserBudget(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  // [local-smark] 条件化 floor：仅当 usable >= 20K 时设 4K floor，
  // 小模型（8K context）的 20% 仅 1.6K，4K floor 会吃掉 2/3 预算加剧溢出。
  // 大模型 4K floor 确保关键 user intent 不被截断。
  const mementoFloor = usable(input) >= 20_000 ? 4_000 : 0
  return Math.min(
    DEFAULT_PRESERVE_RECENT_USER_TOKENS,
    Math.max(mementoFloor, Math.floor(usable(input) * PRESERVE_RECENT_USER_RATIO)),
  )
}

function collectRecentUserMessages(input: { messages: SessionV1.WithParts[]; maxTokens: number }) {
  // #256：预算归零直接返回空——memento 是增量通道，不允许倒逼上下文溢出
  if (input.maxTokens <= 0) return []
  const result: NonNullable<SessionV1.CompactionPart["recent_user_messages"]> = []
  // #256：从最新到最旧反向收集——预算有限时先保住最新指令；压缩标记消息本身不是用户指令。
  for (const msg of input.messages.toReversed()) {
    if (msg.info.role !== "user") continue
    // #257：撤销/隐藏产生的消息一律不进 memento——它们不是有效的用户意图
    if (msg.info.hidden) continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    // #256：只保留用户手写文本——synthetic 编辑器/文件上下文与 ignored 修复文本
    // 已由其他通道表示，再进 memento 会把记忆变成又一个无界上下文源。
    const text = msg.parts
      .flatMap((part) => {
        if (part.type !== "text") return []
        // #257：hidden part 同样排除——撤销粒度可到 part 级
        if (part.hidden) return []
        if (part.synthetic || part.ignored) return []
        const text = part.text.trim()
        return text ? [text] : []
      })
      .join("\n\n")
    if (!text) continue

    const next = [{ id: msg.info.id, text }, ...result]
    if (TokenEstimate.estimateText(MessageV2.formatRecentUserMemento(next)) <= input.maxTokens) {
      result.unshift({ id: msg.info.id, text })
      continue
    }

    const truncated = truncateRecentUserMessage({ id: msg.info.id, text, result, maxTokens: input.maxTokens })
    if (truncated) result.unshift({ id: msg.info.id, text: truncated, truncated: true })
    break
  }
  return result
}

function truncateRecentUserMessage(input: {
  id: MessageID
  text: string
  result: NonNullable<SessionV1.CompactionPart["recent_user_messages"]>
  maxTokens: number
}) {
  // #256：二分搜索对同一个将被重放的格式化信封做 token 估算——预算守卫绑定的是
  // 模型可见上下文，而不是会漂移的字符数近似。
  let low = 0
  let high = input.text.length
  let best = ""
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const text = [input.text.slice(0, mid).trimEnd(), RECENT_USER_MEMENTO_TRUNCATED].filter(Boolean).join("\n")
    const next = [{ id: input.id, text, truncated: true }, ...input.result]
    if (TokenEstimate.estimateText(MessageV2.formatRecentUserMemento(next)) <= input.maxTokens) {
      best = text
      low = mid + 1
      continue
    }
    high = mid - 1
  }
  return best
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const msg = input.messages[start]!
      // #205：持久化边界在 undo/repair 后仍须可重放——空、hidden、pending、errored 消息可能从可见历史消失
      // #205：这类消息必须留在 summarized head，不能成为 tail_start_id，否则边界丢失引发上下文组装故障
      if (msg.info.hidden || msg.parts.length === 0) continue
      // #205：pending(无 finish)或 errored assistant 不可重放，同样跳过不作锁点
      if (msg.info.role === "assistant" && (!msg.info.finish || msg.info.error)) continue
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: msg.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly run: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<SessionV1.User>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const todo = yield* Todo.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      // #194：tail-retention 保持原始大小启发式
      return TokenEstimate.estimateText(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    // #0500：prune 经 boundary-first 读取需要 Database.Service——层内解引用保持 Service.of 的 R=never 合同。
    const pruneDatabase = yield* Database.Service
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      // #0500：prune 只会扫描到最新 completed Compaction；boundary 以前的 Tool output
      // 已由 summary 取代，先 hydrate 再 break 会把整段归档 head 无意义预热。
      // #0500：prune 经 filterCompactedEffect 从最新 completed boundary 起读——
      // 归档 head 不被无意义预热。
      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, pruneDatabase),
      )
      if (msgs.length === 0) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          // #194：prune 用 estimateText 作粗略大小代理
          const estimate = TokenEstimate.estimateText(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()

      const requestUsage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
      if (requestUsage)
        yield* requestUsage.begin({
          sessionID: input.sessionID,
          // V1 压缩沿用 parentID 请求身份，不能换成 summary 助手身份拆分费用。
          requestID: input.parentID,
          rootRequestID: input.parentID,
          source: "system_compaction",
          agent: "compaction",
          // compaction agent 可选择不同模型，账本必须保存已解析的实际 provider/model。
          providerID: model.providerID,
          modelID: model.id,
          variant: userMessage.model.variant,
        })
      const own = yield* SessionProcessor.ownAssistant({ sessionID: input.sessionID, requestID: input.parentID }, { events, db })
      const rawHistory = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      // #251：压缩上传必须和普通 prompt 共用同一个 active replay window：数据库里的 raw history
      // 会保留已被 summary 覆盖的旧 head 作为审计/恢复数据，但这些旧 tool results 不能在
      // 后续 summary 更新时再次进入 provider 请求；否则每条工具输出会按 head/tail 预算
      // 重新截断并累计，导致本应压缩的可见会话膨胀成远超模型窗口的压缩请求。
      const history = MessageV2.filterCompacted(rawHistory)
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      // #256：visibleHistory 与 select 共用——memento 从可见窗口收集，避免把 hidden 的
      // 压缩标记/summary 对当作用户指令回放。
      const visibleHistory = history.filter((_, index) => !hidden.has(index))
      // #257：memento 从 rawHistory 采集——filterCompacted 会移除已压缩 head，但那些
      // 原始最近用户指令仍应有一次有界截断机会进入下次交接；hidden/synthetic/ignored/
      // 压缩标记内容由 collectRecentUserMessages 内部排除。
      const recentUserMessages = collectRecentUserMessages({
        messages: rawHistory,
        maxTokens: preserveRecentUserBudget({ cfg, model, outputTokenMax: flags.outputTokenMax }),
      })
      const selected = yield* select({
        messages: visibleHistory,
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      // #553：Compaction plugin 与普通 prompt 共用 visible head，序列化 conversation 不能消费已隐藏的 transformed history。
      // transformed clone 是唯一上传历史；raw history 仍仅服务审计和 bounded memento。
      const visibleMsgs = MessageV2.visible(msgs)
      const conversation = visibleMsgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      own(msg)
      // 入口仅拥有来源标记，tokens/cost 仍由共用 processor 的结算快照拥有。
      yield* SessionProcessor.publishAssistant(msg, events)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        // overflow 是 cleanup 之后的真实终验失败，原确认用量只覆盖快照，不退款。
        processor.message.time.completed ??= Date.now()
        yield* SessionProcessor.publishAssistant(processor.message, events)
        return "stop"
      }

      if (result === "continue" && !processor.message.error) {
        // 复用唯一附录追加点；Todo 由现有服务读取，不新建 evidence 状态或写入旁路。
        const todos = yield* todo.get(input.sessionID)
        const handoff = yield* CompactionFileEvidence.render(history, fs, ctx.worktree, completedCompactions(history).length + 1, ctx.directory, todos)
        if (handoff) yield* session.updatePart({
          id: PartID.ascending(), messageID: msg.id, sessionID: input.sessionID,
          type: "text", text: handoff, synthetic: true,
          // 与摘要同一消息持久化，UI与模型回放看到相同的当前磁盘证据。
          metadata: { kind: CompactionFileEvidence.kind, version: 1 },
          time: { start: Date.now(), end: Date.now() },
        })
      }

      // #256：双锚点更新——tail_start_id 保留整轮尾部，recent_user_messages 保留最新用户意图；
      // 任一变化都触发持久化，保证 memento 与尾部边界在同一压缩边界上对齐。
      const nextRecentUserMessages = recentUserMessages.length > 0 ? recentUserMessages : undefined
      if (
        compactionPart &&
        (compactionPart.tail_start_id !== selected.tail_start_id ||
          JSON.stringify(compactionPart.recent_user_messages ?? []) !== JSON.stringify(nextRecentUserMessages ?? []))
      ) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
          recent_user_messages: nextRecentUserMessages,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
              // [local-smark] 继承原始 canonical user 的 Goal turn ID，
              // 使 compaction replay 不产生新 eligible Goal turn
              goalTurnID: original.goalTurnID ?? original.id,
            })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
              // [local-smark] compaction continue 继承 compaction parent 的 Goal turn ID，
              // 不产生新 eligible Goal turn
              goalTurnID: userMessage.goalTurnID ?? userMessage.id,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    }, Effect.scoped)

    // #538：私有 seam 接受 run 预分配的 ID，覆盖 create 尚未返回就被取消的窗口；
    // 公开 create wrapper 仍自行分配 ID，不扩大原有调用接口。
    const createMarker = Effect.fn("SessionCompaction.createMarker")(function* (input: {
      id: MessageID
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      // 在写入 marker 之前读取最新 user，避免 newest-first 查询命中 marker 自身；
      // technical source 已有 lineage 时继续向原 canonical turn 透传，不能形成 lineage 链。
      const source = Option.getOrUndefined(
        // #493：predicate 只读取 role——历史 cold Parts 与 summary.diffs 不参与 marker source 定位；
      // 最终匹配仍 hydrate 完整 user，goalTurnID/model 等 lineage 输入不会来自不完整 projection。
      yield* session.findMessage(input.sessionID, (info) => info.role === "user").pipe(Effect.orDie),
      )
      const msg = yield* session.updateMessage({
        id: input.id,
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
        // [local-smark] Compaction marker 是 technical Message，只继承最近 canonical turn；
        // 它自身不能成为新的 Goal turn。空 Session 没有 source 时保持字段缺省。
        ...(source?.info.role === "user" ? { goalTurnID: source.info.goalTurnID ?? source.info.id } : {}),
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      // user 标记先于摘要 assistant 落库，流式与旧测试可观察同一持久化边界形态；
      // processCompaction 写入成功摘要前它仍是 scratch 状态，prompt 消费端刻意忽略未完成标记
      return msg
    })

    // #538：外部调用保持自分配 ID 形态，语义与旧 create 完全一致。
    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      return yield* createMarker({ ...input, id: MessageID.ascending() })
    })

    // #242：中断清理的唯一入口——只处理可见的未完成 compaction 对，不动已完成边界
    const hideIncomplete = Effect.fn("SessionCompaction.hideIncomplete")(function* (input: {
      sessionID: SessionID
      parentID: MessageID
    }) {
      // #538：cleanup 只定位本次最新 marker/summary，不再为失败终态 hydrate 整个长 Session。
      const find = (predicate: (info: MessageV2.HotInfo) => boolean) =>
        session
          .findMessage(input.sessionID, predicate)
          // Session 尚不存在时与 NotFound 同义：无可隐藏对象，返回 none 让调用方自然跳过。
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(Option.none<SessionV1.WithParts>())))
      // #538：summary 查询仍先执行：finished/no-error boundary 已经成功，后续可选动作失败
      // 不能反向隐藏该边界或撤销它承载的 retained context。
      const summary = Option.getOrUndefined(
        yield* find(
          (info) => info.role === "assistant" && info.parentID === input.parentID && info.summary === true,
        ),
      )
      if (summary?.info.role === "assistant" && summary.info.finish && !summary.info.error) return
      // marker 按 ID 定位：预分配 parentID 保证即使 create 中途回写未完成也能找到本次 scratch。
      const marker = Option.getOrUndefined(yield* find((info) => info.id === input.parentID))
      const now = Date.now()
      // #538：只隐藏 marker+summary 这一对（同时间戳）；展开原 info 只附加可见性终态，
      // 已记录的 tokens/cost/lineage 原值保留；未 completed 的 summary 才补 AbortedError。
      for (const msg of [marker, summary]) {
        if (!msg) continue
        const next = {
          ...msg.info,
          // #242：compaction-cancelled 与 undo 语义分离——维护操作取消不得冒充用户回滚
          hidden: { time: now, reason: "compaction-cancelled" as const },
        }
        if (next.role === "assistant" && !next.time.completed) {
          next.time.completed = now
          // #242：错误回填仅在缺失时——保留上游已记录的失败原因，中断只是兜底解释
          next.error ??= new AbortedError({ message: "Aborted by compact cancellation" }).toObject()
        }
        yield* session.updateMessage(next)
      }
    })

    // #242：run 是 compaction 的唯一执行主路径——摘要经 LLM 流式落库，取消经 onExit 归 hideIncomplete
    const run = Effect.fn("SessionCompaction.run")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      // #538：ID 必须先于 marker 的首次 durable write 归属 run；create 中任一 yield
      // 被中断时，finalizer 仍能精确定位本次 scratch，而不会扫描或猜测 latest。
      const parentID = MessageID.ascending()
      return yield* Effect.gen(function* () {
        const msg = yield* createMarker({ ...input, id: parentID })
        return yield* processCompaction({
          parentID: msg.id,
          messages: yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
          sessionID: input.sessionID,
          auto: input.auto,
          overflow: input.overflow,
        })
      }).pipe(
        Effect.onExit((exit) => {
          // compact 标记在成功摘要 assistant 出现前都是 scratch 状态。
          // #538：Effect success 只说明 processor 正常返回；业务结果 stop 仍表示
          // 本次 Compaction 未提交，必须和 interrupt/defect 进入同一 hidden 终态。
          // hard process exit 无法运行 finalizer，继续由 filterCompacted 守住 replay。
          if (Exit.isSuccess(exit) && exit.value === "continue") return Effect.void
          return hideIncomplete({ sessionID: input.sessionID, parentID })
        }),
      )
    })

    return Service.of({
      isOverflow,
      prune,
      run,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Database.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    FSUtil.node,
    Todo.node,
  ],
})

export * as SessionCompaction from "./compaction"

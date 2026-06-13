import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { TokenEstimate } from "@/token/estimate"
import * as Log from "@opencode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Option, Schema, Exit } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { Todo } from "./todo"
// [local-smark] request usage tracking
import { SessionRequestUsage } from "./request-usage"
import { serviceUse } from "@/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import path from "path"
import { createHash } from "crypto"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
// Whole-turn tail retention keeps exact assistant/tool continuity when it fits.
// The defaults deliberately preserve four recent user turns with a 4k-16k token
// adaptive budget: enough for normal coding turns, still bounded so compaction
// does not recreate the same oversized context it is trying to replace.
const DEFAULT_TAIL_TURNS = 4
const MIN_PRESERVE_RECENT_TOKENS = 4_000
const MAX_PRESERVE_RECENT_TOKENS = 16_000
// Separate from full-turn tail retention: a large tool-heavy recent turn can be
// too expensive to keep verbatim, but the user's latest instructions still need
// a bounded handoff lane. 20k mirrors Codex's memento budget as an absolute cap;
// preserveRecentUserBudget still clamps it to 20% of the active model's usable
// window so a 100k-token usable window can spend at most 20k on the memento.
const DEFAULT_PRESERVE_RECENT_USER_TOKENS = 20_000
const PRESERVE_RECENT_USER_RATIO = 0.2
// Evidence Handoff 是压缩摘要后的公开证据清单：它作为 assistant text part
// 同时给用户和模型看，不能变成隐藏状态或第二套 summary。下面这些上限只防止
// evidence 自身成为新的上下文膨胀源；被裁剪的数量会在同一段文本里公开显示。
const EVIDENCE_HANDOFF_KIND = "compaction_evidence_handoff"
const EVIDENCE_FILE_LIMIT = 20
const EVIDENCE_FILE_RANGE_LIMIT = 8
const EVIDENCE_COMMAND_LIMIT = 10
const EVIDENCE_TODO_LIMIT = 100
const EVIDENCE_COMMAND_MAX_CHARS = 120
const EVIDENCE_CELL_MAX_CHARS = 160
// The truncation marker is part of the model-visible handoff so the next model
// knows missing text was intentionally omitted by the memento budget, not by the
// user. Keep it short because it can appear inside an already tight context.
const RECENT_USER_MEMENTO_TRUNCATED = "...[truncated for compaction memento]"
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence current user goal]

## User Constraints & Preferences
- [durable user instructions, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work, verified findings, or "(none)"]

### In Progress
- [current unfinished work and where it stopped, or "(none)"]

### Blocked
- [blockers, missing info, failed commands, or "(none)"]

## Files & Code
- [path: relevant symbols/sections and why they matter, or "(none)"]

## Errors & Fixes
- [exact error/output and fix/status, or "(none)"]

## Key Decisions
- [decision and reason, or "(none)"]

## Next Steps
- [ordered next actions directly tied to the latest user request, or "(none)"]

## Critical Context
- [non-obvious technical facts, tool results, command outputs, open questions, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, identifiers, symbols, and line numbers when known.
- Prefer facts needed to continue work; remove stale or resolved details.
- For files, include why they matter and the relevant symbol/section when known.
- For errors, include the fix/status so the next model does not repeat dead ends.
- Do not include long file contents or large command outputs; summarize them by path, symbol, and result.
- Do not mention the summary process or that context was compacted.`
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

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    // Evidence Handoff 是原始 summary 的公开附录，不是 LLM 生成的 anchored
    // summary 内容。这里过滤它，避免下一轮 compaction 把结构化表格写进
    // <previous-summary> 后再被 LLM 改写或重复总结。
    .filter((part) => part.metadata?.kind !== EVIDENCE_HANDOFF_KIND)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
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

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function preserveRecentUserBudget(input: { cfg: Config.Info; model: Provider.Model; outputTokenMax?: number }) {
  // No minimum floor here: unlike the whole-turn tail, this memento is additive
  // to the summary and retained tail, so small-context models must be allowed to
  // shrink it all the way to zero instead of immediately overflowing again.
  return Math.min(DEFAULT_PRESERVE_RECENT_USER_TOKENS, Math.max(0, Math.floor(usable(input) * PRESERVE_RECENT_USER_RATIO)))
}

function collectRecentUserMessages(input: { messages: MessageV2.WithParts[]; maxTokens: number }) {
  if (input.maxTokens <= 0) return []
  const result: NonNullable<MessageV2.CompactionPart["recent_user_messages"]> = []
  for (const msg of input.messages.toReversed()) {
    if (msg.info.role !== "user") continue
    if (msg.info.hidden) continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    // Preserve only explicit user-authored text. Synthetic editor/file context
    // and ignored repair text are already represented elsewhere and replaying
    // them here would turn the memento into another unbounded context source.
    const text = msg.parts
      .flatMap((part) => {
        if (part.type !== "text") return []
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
  result: NonNullable<MessageV2.CompactionPart["recent_user_messages"]>
  maxTokens: number
}) {
  // Binary search against the same formatted envelope that will be replayed to
  // the provider. This keeps the budget guard tied to observable model context
  // rather than a second, drift-prone character-count approximation.
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

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }

type ToolEvent = {
  part: CompletedToolPart
  sequence: number
}

type InspectedFileEvidence = {
  path: string
  canonicalPath: string
  size: number | undefined
  ranges: Array<{ start: number; end: number }>
  total: number
  modified: string
  modifiedMs: number | undefined
  lastRead: number
  status: "current" | "stale" | "deleted"
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function numberField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function completedToolEvents(messages: MessageV2.WithParts[]) {
  const result: ToolEvent[] = []
  let sequence = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      sequence++
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      result.push({ part: part as CompletedToolPart, sequence })
    }
  }
  return result
}

function canonicalEvidencePath(input: string, worktree: string) {
  const resolved = path.isAbsolute(input) ? input : path.join(worktree, input)
  const normalized = resolved.replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function displayPath(input: string, worktree: string) {
  const resolved = path.isAbsolute(input) ? input : path.join(worktree, input)
  const relative = path.relative(worktree, resolved)
  // worktree 根目录是最常见的默认 shell cwd；渲染为 "." 避免 evidence
  // 暴露冗长临时目录，同时仍让工作区外路径保持绝对路径。
  if (relative === "") return "."
  const display = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved
  return display.replaceAll("\\", "/") || "."
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end)
  return sorted.reduce<Array<{ start: number; end: number }>>((result, range) => {
    const last = result.at(-1)
    if (!last || range.start > last.end + 1) return [...result, { ...range }]
    last.end = Math.max(last.end, range.end)
    return result
  }, [])
}

function hash8(input: string) {
  // 这里只需要稳定短指纹来区分被截断的公开文本，不把它当安全哈希使用。
  return createHash("sha256").update(input).digest("hex").slice(0, 8)
}

function evidenceCell(input: string) {
  return input.replaceAll("|", "\\|").replace(/\r?\n/g, " ").trim()
}

function compactCell(input: string, max: number, label: string) {
  const clean = evidenceCell(input)
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 18)).trimEnd()}... [${label}:${hash8(clean)}]`
}

function statSize(stat: { size: unknown }) {
  return typeof stat.size === "bigint" ? Number(stat.size) : Number(stat.size)
}

function statModifiedMs(stat: { mtime: Option.Option<Date> }) {
  return stat.mtime.pipe(
    Option.map((time) => Math.floor(time.getTime())),
    Option.getOrUndefined,
  )
}

function formatEvidenceModified(ms: number) {
  // 这里必须和 read tool 的 `<file modified="..." />` 展示保持同一种本地时间格式。
  // 不从 read.ts 导出 helper，是为了避免 session compaction 反向依赖 tool 内部实现。
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

function isNotFoundError(error: unknown) {
  if (!isRecord(error)) return false
  const reason = error.reason
  return isRecord(reason) && reason._tag === "NotFound"
}

function statFailureEvidence(error: unknown): Pick<InspectedFileEvidence, "modified" | "status"> {
  // NotFound 才代表当前路径已经没有可比对的磁盘文件；其它 stat 错误只说明无法确认，
  // 继续标 stale 比误报 current 或 deleted 更安全，也不会阻断 compaction 摘要落库。
  return { modified: "-", status: isNotFoundError(error) ? "deleted" : "stale" }
}

function currentFileEvidence(
  file: InspectedFileEvidence,
  stat: { type: string; size: unknown; mtime: Option.Option<Date> },
): Pick<InspectedFileEvidence, "modified" | "status"> {
  if (stat.type !== "File") return { modified: "-", status: "deleted" }
  const modifiedMs = statModifiedMs(stat)
  if (modifiedMs === undefined) return { modified: "-", status: "stale" }
  const modified = formatEvidenceModified(modifiedMs)
  // 历史会话里可能存在旧 read metadata，缺少 size/modifiedMs 时无法证明版本相同。
  // 仍展示当前磁盘 mtime，但状态必须保守标 stale，避免把不可确认的证据伪装成 current。
  if (file.size === undefined || file.modifiedMs === undefined) return { modified, status: "stale" }
  return {
    modified,
    status: statSize(stat) === file.size && modifiedMs === file.modifiedMs ? "current" : "stale",
  }
}

function renderInspectedFiles(input: { events: ToolEvent[]; fs: AppFileSystem.Interface; worktree: string }) {
  return Effect.gen(function* () {
    const files = new Map<string, InspectedFileEvidence>()

    for (const event of input.events) {
      if (event.part.tool !== "read") continue
      const read = isRecord(event.part.state.metadata.read) ? event.part.state.metadata.read : undefined
      if (!read || read.stub === true) continue
      const filePath = stringField(read, "path")
      const canonicalPath = stringField(read, "canonicalPath")
      const size = numberField(read, "size")
      const start = numberField(read, "start")
      const end = numberField(read, "end")
      const total = numberField(read, "total")
      const modified = stringField(read, "modified")
      const modifiedMs = numberField(read, "modifiedMs")
      if (!filePath || !canonicalPath || start === undefined || end === undefined || total === undefined || !modified) continue
      const canonical = canonicalEvidencePath(canonicalPath, input.worktree)
      const current = files.get(canonical)
      if (!current) {
        files.set(canonical, {
          path: displayPath(filePath, input.worktree),
          canonicalPath: canonical,
          size,
          ranges: [{ start, end }],
          total,
          modified,
          modifiedMs,
          lastRead: event.sequence,
          status: "current",
        })
        continue
      }
      current.ranges = mergeRanges([...current.ranges, { start, end }])
      current.size = size
      current.total = total
      current.modified = modified
      current.modifiedMs = modifiedMs
      current.lastRead = event.sequence
    }

    const rows = [...files.values()].toSorted((a, b) => b.lastRead - a.lastRead)
    const rendered = rows.slice(0, EVIDENCE_FILE_LIMIT)
    const omitted = Math.max(0, rows.length - rendered.length)
    // 当前磁盘 stat 是 handoff 的事实来源，但它只服务最终可见 rows。
    // 先按 evidence budget 截断，保证一次 compaction 最多触发 EVIDENCE_FILE_LIMIT 次 I/O。
    yield* Effect.forEach(rendered, (file) =>
      Effect.gen(function* () {
        const evidence = yield* input.fs.stat(file.canonicalPath).pipe(
          Effect.map((stat) => currentFileEvidence(file, stat)),
          Effect.catch((error) => Effect.succeed(statFailureEvidence(error))),
        )
        file.modified = evidence.modified
        file.status = evidence.status
      }),
    )

    const output = [
      "### Inspected Files",
      "| path | ranges | total | modified | status |",
      "|---|---:|---:|---|---|",
      ...rendered.map((file) => {
        const ranges = file.ranges.slice(0, EVIDENCE_FILE_RANGE_LIMIT).map((range) => `${range.start}-${range.end}`)
        const omittedRanges = Math.max(0, file.ranges.length - ranges.length)
        return `| ${evidenceCell(file.path)} | ${ranges.join(", ")}${omittedRanges ? `, ...(+${omittedRanges})` : ""} | ${file.total} | ${evidenceCell(file.modified)} | ${file.status} |`
      }),
    ]
    if (omitted > 0) output.push(`Omitted: ${omitted} inspected files due to evidence budget.`)
    return output.join("\n")
  })
}

function redactCommand(input: string) {
  return input
    .replace(/(authorization:\s*bearer\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)=)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)=)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
}

function commandDisplay(input: string) {
  const redacted = redactCommand(input).replace(/\s+/g, " ").trim()
  return compactCell(redacted, EVIDENCE_COMMAND_MAX_CHARS, "cmd")
}

function stripLeadingEnvAssignments(input: string) {
  let command = input.trim()
  while (true) {
    const match = command.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/)
    if (!match) return command
    command = command.slice(match[0].length).trimStart()
  }
}

function isSimpleVerificationCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) return false
  // Evidence 只记录已经完成的简单验证命令。带管道、重定向、子命令或链式操作的
  // shell 片段可能混入副作用，不能被压缩摘要误呈现为单纯 verification 结果。
  if (/[|<>`;]/.test(trimmed) || trimmed.includes("$(") || trimmed.includes("&&") || trimmed.includes("||")) return false
  const normalized = stripLeadingEnvAssignments(trimmed).toLowerCase()
  return (
    /^(bun|npm|pnpm|yarn)\s+(run\s+)?(typecheck|test|build|lint|check|audit)(\s|$)/.test(normalized) ||
    /^node\s+--check(\s|$)/.test(normalized) ||
    /^python\s+-m\s+py_compile(\s|$)/.test(normalized) ||
    /^tsc\s+--noemit(\s|$)/.test(normalized) ||
    /^eslint(\s|$)/.test(normalized) ||
    /^prettier\s+--check(\s|$)/.test(normalized)
  )
}

function commandCwd(input: Record<string, unknown>, directory: string) {
  const legacy = stringField(input, "cwd")
  if (legacy) return legacy
  const workdir = stringField(input, "workdir")
  // 真实 bash tool input 保存的是用户传入的 workdir，而不是 shell.ts 运行时
  // 解析后的 cwd；缺省 workdir 时命令实际在实例目录执行。
  if (!workdir) return directory
  return path.isAbsolute(workdir) ? workdir : path.join(directory, workdir)
}

function renderVerifiedCommands(input: { events: ToolEvent[]; directory: string; worktree: string }) {
  const commands = new Map<string, { command: string; cwd: string; exit: string; sequence: number }>()
  for (const event of input.events) {
    if (event.part.tool !== "bash") continue
    const command = stringField(event.part.state.input, "command")
    if (!command || !isSimpleVerificationCommand(command)) continue
    const cwd = commandCwd(event.part.state.input, input.directory)
    const exit = numberField(event.part.state.metadata, "exit")
    commands.set(`${canonicalEvidencePath(cwd, input.worktree)}\u0000${stripLeadingEnvAssignments(command)}`, {
      command,
      cwd,
      exit: exit === undefined ? "unknown" : String(exit),
      sequence: event.sequence,
    })
  }
  const all = [...commands.values()].toSorted((a, b) => b.sequence - a.sequence)
  const rows = all.slice(0, EVIDENCE_COMMAND_LIMIT)
  const omitted = Math.max(0, all.length - rows.length)
  const output = [
    "### Verified Commands",
    "| command | cwd | exit |",
    "|---|---|---:|",
    ...rows.map((item) => `| ${commandDisplay(item.command)} | ${evidenceCell(displayPath(item.cwd, input.worktree))} | ${item.exit} |`),
  ]
  if (omitted > 0) output.push(`Omitted: ${omitted} verified commands due to evidence budget.`)
  return output.join("\n")
}

function renderOutstandingTodos(todos: Todo.Info[]) {
  const rendered = todos.slice(0, EVIDENCE_TODO_LIMIT)
  const omitted = Math.max(0, todos.length - rendered.length)
  const output = [
    "### Outstanding Todos",
    "| status | priority | content |",
    "|---|---|---|",
    ...rendered.map((todo) =>
      `| ${evidenceCell(todo.status)} | ${evidenceCell(todo.priority)} | ${compactCell(todo.content, EVIDENCE_CELL_MAX_CHARS, "todo")} |`,
    ),
  ]
  if (omitted > 0) output.push(`Omitted: ${omitted} todos due to evidence budget.`)
  return output.join("\n")
}

function renderEvidenceHandoff(input: {
  messages: MessageV2.WithParts[]
  todos: Todo.Info[]
  directory: string
  fs: AppFileSystem.Interface
  worktree: string
}) {
  return Effect.gen(function* () {
    const events = completedToolEvents(input.messages)
    return [
      "## Evidence Handoff",
      "",
      yield* renderInspectedFiles({ events, fs: input.fs, worktree: input.worktree }),
      "",
      renderVerifiedCommands({ events, directory: input.directory, worktree: input.worktree }),
      "",
      renderOutstandingTodos(input.todos),
      "",
      "### Lost Context Notice",
      "- Older raw tool outputs were compacted.",
      "- Use current evidence before repeating reads or commands.",
      "- Treat stale evidence as advisory only.",
    ].join("\n")
  })
}

function turns(messages: MessageV2.WithParts[]) {
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
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const msg = input.messages[start]!
      // Split-turn anchors preserve long-running agent-loop context, but the
      // persisted boundary must still be replayable after undo/repair.  Empty,
      // hidden, pending, or errored messages can disappear from visible history
      // and must stay in the summarized head instead of becoming tail_start_id.
      if (msg.info.hidden || msg.parts.length === 0) continue
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
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly run: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<MessageV2.User>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* AppFileSystem.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
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
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      // Tail-retention budgeting intentionally remains a raw-size heuristic:
      // existing compaction behaviour treats large media-bearing turns as too
      // expensive to keep verbatim even though the final summary upload strips
      // media to placeholders. Only the actual request snapshot below uses the
      // provider-learned/media-aware estimator.
      return TokenEstimate.estimateText(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
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
        else if (!keep) log.info("tail fallback", { budget, size, total })
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
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
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
          // Prune only needs a coarse size proxy for old tool outputs; it still
          // uses the token primitive rather than upload history because pruning is
          // a local retention heuristic, not a provider request estimate.
          const estimate = TokenEstimate.estimateText(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
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
      // [local-smark] request usage tracking for compaction
      const requestUsage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
      if (requestUsage)
        yield* requestUsage.begin({
          sessionID: input.sessionID,
          requestID: input.parentID,
          rootRequestID: input.parentID,
          source: "system_compaction",
          agent: "compaction",
          providerID: model.providerID,
          modelID: model.id,
          variant: userMessage.model.variant,
        })
      const cfg = yield* config.get()
      const rawHistory = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      // 压缩上传必须和普通 prompt 共用同一个 active replay window：数据库里的 raw history
      // 会保留已被 summary 覆盖的旧 head 作为审计/恢复数据，但这些旧 tool results 不能在
      // 后续 summary 更新时再次进入 provider 请求；否则每条工具输出会按 TOOL_OUTPUT_MAX_CHARS
      // 重新截断并累计，导致本应压缩的可见会话膨胀成远超模型窗口的压缩请求。
      const history = MessageV2.filterCompacted(rawHistory)
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const visibleHistory = history.filter((_, index) => !hidden.has(index))
      const recentUserMessages = collectRecentUserMessages({
        // Use raw history for the memento lane: filterCompacted intentionally
        // removes the summarized head after a completed compaction, but those raw
        // recent user instructions still need one bounded chance to be truncated
        // into the next handoff. collectRecentUserMessages keeps hidden,
        // synthetic, ignored, and compaction-marker content out of this replay.
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
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const compactionMessages = [
        ...modelMessages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: nextPrompt }],
        },
      ]
      const messageEstimate = TokenEstimate.sanitizeModelMessages(compactionMessages)
      const rawMessagesText = JSON.stringify(compactionMessages)
      // Summary assistants bypass prompt.ts, so compaction must seed the same
      // daemon-side upload snapshot here. Reusing TokenEstimate keeps media
      // handling, legacy-attachment filtering, and learned input density identical
      // to normal prompts before TUI or stats consumers read the message.
      const estimatedInput = TokenEstimate.estimateUploadInput({
        text: messageEstimate.text,
        attachments: messageEstimate.attachments,
        history,
        model,
      }).inputTokens
      const inputBreakdown = {
        system: 0,
        instructions: 0,
        skills: 0,
        tools: 0,
        messages: {
          userText: nextPrompt.length,
          assistantText: Math.max(0, messageEstimate.textChars - nextPrompt.length),
          reasoning: 0,
          toolInput: 0,
          toolOutput: 0,
          attachments: messageEstimate.attachments.rawChars,
          total: rawMessagesText.length,
        },
        ...(messageEstimate.attachments.count > 0 ? { media: messageEstimate.attachments } : {}),
      }
      const msg: MessageV2.Assistant = {
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
          // The compaction request is uploaded through SessionProcessor directly,
          // bypassing prompt.ts where normal assistant requests get their pending
          // input snapshot.  Seed the same estimate here so the TUI does not show
          // 0 tokens while the summary request is streaming; finish-step replaces
          // this with provider-confirmed usage once the model responds.
          input: estimatedInput,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        inputChars: rawMessagesText.length,
        inputTokens: estimatedInput,
        inputBreakdown,
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      // SessionProcessor copies these fields into step-start/step-finish parts.
      // Without this handoff, the assistant message has a pending estimate but
      // the streaming parts still look empty, which makes live context accounting
      // flicker back to zero during manual or automatic compaction.
      processor.inputChars = rawMessagesText.length
      processor.inputBreakdown = inputBreakdown
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: compactionMessages,
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (result === "continue" && !processor.message.error) {
        const todo = Option.getOrUndefined(yield* Effect.serviceOption(Todo.Service))
        const todos = todo
          ? yield* todo.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed([] as Todo.Info[])))
          : []
        // Evidence 作为同一条 summary assistant 的 synthetic text 追加，保证用户可见内容
        // 和模型 replay 内容一致；不写隐藏 JSON，避免后续维护者误以为模型看到了 UI 看不到的状态。
        const handoff = yield* renderEvidenceHandoff({ messages: history, todos, directory: ctx.directory, fs, worktree: ctx.worktree })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          text: handoff,
          synthetic: true,
          metadata: { kind: EVIDENCE_HANDOFF_KIND, version: 1 },
          time: { start: Date.now(), end: Date.now() },
        })
      }

      const nextRecentUserMessages = recentUserMessages.length > 0 ? recentUserMessages : undefined
      if (
        compactionPart &&
        (compactionPart.tail_start_id !== selected.tail_start_id ||
          JSON.stringify(compactionPart.recent_user_messages ?? []) !== JSON.stringify(nextRecentUserMessages ?? []))
      ) {
        // Store both replay anchors on the same compaction boundary. tail_start_id
        // keeps whole recent turns when they fit, while recent_user_messages keeps
        // the latest user intent available even when a tool-heavy tail is too big.
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
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            text: summary ?? "",
            include: selected.tail_start_id,
          })
        }
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      // The user marker is written before the summary assistant so streaming and
      // legacy tests can observe the same persisted boundary shape. It remains
      // scratch state until processCompaction writes a successful summary; prompt
      // consumers deliberately ignore incomplete markers.
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
      return msg
    })

    const hideIncomplete = Effect.fn("SessionCompaction.hideIncomplete")(function* (input: {
      sessionID: SessionID
      parentID: MessageID
    }) {
      // Interrupts can happen after the scratch marker is visible but before the
      // summary request starts. Hide only this compaction pair, and only if no
      // successful summary exists, so completed boundaries keep anchoring history.
      const messages = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([] as MessageV2.WithParts[])))
      const completed = messages.some(
        (msg) =>
          msg.info.role === "assistant" &&
          msg.info.parentID === input.parentID &&
          msg.info.summary &&
          msg.info.finish &&
          !msg.info.error,
      )
      if (completed) return
      const now = Date.now()
      for (const msg of messages) {
        const marker = msg.info.id === input.parentID && msg.parts.some((part) => part.type === "compaction")
        const summary = msg.info.role === "assistant" && msg.info.parentID === input.parentID && msg.info.summary
        if (!marker && !summary) continue
        const next = {
          ...msg.info,
          hidden: { time: now, reason: "compaction-cancelled" as const },
        }
        if (next.role === "assistant" && !next.time.completed) {
          next.time.completed = now
          next.error ??= new MessageV2.AbortedError({ message: "Aborted by compact cancellation" }).toObject()
        }
        yield* session.updateMessage(next)
      }
    })

    const run = Effect.fn("SessionCompaction.run")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      let parentID: MessageID | undefined
      return yield* Effect.gen(function* () {
        const msg = yield* create(input)
        parentID = msg.id
        return yield* processCompaction({
          parentID: msg.id,
          messages: yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie),
          sessionID: input.sessionID,
          auto: input.auto,
          overflow: input.overflow,
        })
      }).pipe(
        Effect.onExit((exit) => {
          // Compact markers are scratch state until a successful summary assistant
          // exists. Interrupt cleanup keeps visible history tidy for Ctrl-C/abort,
          // while MessageV2.filterCompacted remains the correctness guard for hard
          // process exits where finalizers cannot run.
          if (Exit.isSuccess(exit) || !parentID) return Effect.void
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

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export * as SessionCompaction from "./compaction"

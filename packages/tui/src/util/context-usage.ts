import fs from "fs/promises"
import os from "os"
import path from "path"
import matter from "gray-matter"
import type { Agent, AssistantMessage, Config, Message, Part, Provider, Session, VcsInfo } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Token } from "@opencode-ai/core/util/token"
import { SessionOverflowV1 } from "@opencode-ai/core/v1/session/overflow"
import { ConfigProvider, Effect } from "effect"
import { boolean, withDefault } from "effect/Config"
// 过滤共享 Schema 的纯权限语法，避免新增 TUI 到 Core 的运行时入口。
import { Wildcard } from "@opencode-ai/schema/wildcard"
import { estimateDataUrlInputTokens } from "./token-estimate"
import EMBEDDED_TOOL_CATALOG from "./tool-definition-catalog.json"
import GIT_SAFETY from "../../../core/src/git-safety.txt"
import SHELL_DESCRIPTION from "../../../opencode/src/tool/shell/shell.txt"
// 提示词文本资产由 Bun 内嵌，估算无需加载服务或依赖打包后的源码目录。
import { SessionPrompts } from "@opencode-ai/core/system-context/prompts"
import { TaskPrompt } from "@opencode-ai/core/tool/task-prompt"

function truthy(key: string) {
  // 技能扫描只观察环境快照，不引入 Config/Flag 服务或另一份目录来源。
  const value = process.env[key]?.toLowerCase()
  // 历史技能开关只接受 true/1；Task 广告使用 Config.boolean，两个编码口径各自保留。
  return value === "true" || value === "1"
}

// RuntimeFlags 从环境 ConfigProvider 取值，不读取 SDK config.experimental；专用 false 覆盖实验伞。
function enabledByExperimental(key: string, inheritExperimental = true) {
  const provider = ConfigProvider.fromEnv()
  // withDefault 只处理缺失值；实际 Config.boolean 保留 yes/on/1 等编码及非法值失败，不自行复制真值表。
  const experimental = inheritExperimental && Effect.runSync(boolean("OPENCODE_EXPERIMENTAL").pipe(withDefault(false)).parse(provider))
  return Effect.runSync(boolean(key).pipe(withDefault(experimental)).parse(provider))
}

// 指引跟随本次定义集合；模型/权限过滤后的 patch-only 请求不能宣称拥有 edit/write。
function toolUsageSection(registeredTools: string[]) {
  const has = (name: string) => registeredTools.includes(name)
  const items: string[] = [
    `Do NOT use the bash tool when a dedicated tool is available.`,
    `Using dedicated tools lets the user review and track your work:`,
  ]
  // 每条文件操作替代项独立检查广告能力，不能从一次历史调用推导全部工具可用。
  if (has("read")) items.push(` - To read files use the read tool instead of cat, head, tail, or sed`)
  if (has("edit")) items.push(` - To edit files use the edit tool instead of sed or awk`)
  if (has("write")) items.push(` - To create files use the write tool instead of echo redirection or heredoc`)
  if (has("grep")) items.push(` - To search file content use the grep tool instead of grep/rg`)
  if (has("glob")) items.push(` - To find files use the glob tool instead of find or ls`)
  if (has("todowrite")) items.push(` - For non-trivial multi-step work, use the todowrite tool to track progress`)
  if (process.platform === "win32") {
    items.push(
      ` - On Windows, do not use Unix text utilities such as tail/head/sed/awk/grep for file operations. Use read/grep/glob, or shell-native commands only when a terminal operation truly requires shell execution.`,
    )
  }
  // 批次说明属于实际系统载荷，未执行任何工具的首轮同样产生这份开销。
  items.push(
    ` - Reserve bash for system commands and terminal operations requiring shell execution`,
    ``,
    `THINK FIRST before using tools. Before your first tool call, decide the FULL first batch of independent reads, searches, globs, directory listings, and status checks you already know you need.`,
    `BATCH independent tool calls in the SAME response so they can run in parallel. Do not issue only one discovery call when several independent discovery calls are already obvious.`,
    `For directory surveys, use a wide first wave. Example independent batch: glob("*"), glob("*/*"), glob("*/package.json"), glob("*/README*"), glob("*/src/*"), glob("*/packages/*").`,
    `After the first batch returns, identify all newly relevant directories/files and issue the next independent batch together.`,
    `BAD: glob("*") -> wait -> glob("*/*") -> wait -> glob("one-dir/*").`,
    `GOOD: broad independent batch -> summarize discovered structure -> second broad independent batch for important discovered roots.`,
    `Sequential calls are ONLY for true dependencies, conflicts, or cases where the next target cannot be known without the previous result.`,
    `DO NOT chain bash commands with separators like \`echo "====";\` to simulate grouped output; it renders poorly for the user.`,
    `Use bash only when dedicated tools are insufficient or when real terminal execution is required.`,
    // 并发读写是否冲突由目标范围决定，不能因工具名不同就假定它们可并行。
    `Parallel writes are allowed ONLY when target files or edit ranges cannot conflict.`,
    // 同一读取版本的多个替换合并提交，避免后一次编辑把前一次更新当作旧上下文覆盖。
    `For multiple changes in one file, prefer one edit/patch containing all non-overlapping changes.`,
  )
  if (has("todo")) {
    items.push(
      ``,
      `Keep todo state current while working: only one item should be in_progress at a time.`,
      `Move an item to in_progress before completing it; do not jump directly from pending to completed.`,
      `If your understanding changes, update the todo list before continuing implementation.`,
    )
  }
  return ["# Using your tools", ...items].join("\n")
}

// 这些稳定段落计入估算一次；不要把 tool result 内引用的同名章节再次当作系统指令。
const actionCareSection = `# Executing actions with care
Carefully consider the reversibility and blast radius of actions before proceeding:
- Local, reversible actions (editing files, running tests, reading code): proceed freely.
- Actions that are hard to reverse or affect shared state: confirm with the user first.


Actions that typically require user confirmation before proceeding:
- Deleting files, branches, or directories; rm -rf; overwriting uncommitted changes
- Force-pushing, git reset --hard, amending published commits
- Pushing code, creating or closing PRs, commenting on issues
- Sending messages to external services (Slack, email, webhooks)
- Modifying CI/CD pipelines or shared infrastructure

When you encounter an obstacle, do not use destructive actions as a shortcut. Identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify). If you discover unexpected state such as unfamiliar files, branches, or configuration, investigate before deleting or overwriting — it may represent the user's in-progress work.`

const sharedWorktreeSection = `# Shared worktree
You may be working in a dirty worktree with user or other-agent changes.
- If unknown changes are in files you need to edit, read them first and work with the current contents.
- If unknown changes are unrelated to your task, ignore them.
- If unknown changes directly block your task or make the correct edit ambiguous, ask the user one concise question.
- Never revert, overwrite, or clean up changes you did not make unless explicitly asked.`

const verificationSection = `# Verification
Before reporting a coding task complete, verify the change when feasible.
Start with the narrowest relevant check for the code you changed, then broaden to related tests, typecheck, lint, or build as confidence grows.
If you cannot verify, state that plainly and explain the blocker.`

const contextContinuitySection = `# Context continuity
The conversation may be compacted or resumed from a summary when context gets long.
After compaction, resume from the summary and current messages rather than restarting from scratch.
Compaction summaries can include stale or unrelated context; do not treat old tasks from the summary as current work unless the latest user message asks for them.
Before your final response after a resume, interruption, or context transition, sanity-check that your answer and tool actions address the newest user request, not an older ghost still lingering in the thread.`

const outputEfficiencySection = `# Output efficiency
Go straight to the point. Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said — just do it. When explaining, include only what is necessary for the user to understand.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at key milestones (e.g. "build passing", "all tests green")
- Errors or blockers that change the plan

If you can say it in one sentence, do not use three. Do not narrate each step or list every file you read. This does not apply to code or tool calls.`

function staticSections() {
  return [actionCareSection, sharedWorktreeSection, verificationSection, contextContinuitySection, outputEfficiencySection]
}

function escapeHtml(value: string) {
  // 用户可控技能路径先转义 XML 特殊字符，防止路径内容破坏公告结构。
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// 技能公告与 skill 工具描述使用不同格式，token 估算必须计入实际 XML 标签而非只加名称。
function skillFmt(
  list: Array<{ name: string; description?: string; location: string }>,
  opts: { verbose: boolean },
) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          // 公告载荷使用转义后的路径，实体增加的字符同样参与 token 估算。
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }
  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

function skillsSection(list: Array<{ name: string; description?: string; location: string }>) {
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    // 系统公告使用 verbose；工具动态描述仍用非 verbose，不能把两份不同载荷混成同一估算。
    skillFmt(list, { verbose: true }),
  ].join("\n")
}

// 模型输出上限为 0 时沿 runtime 的全局上限；不能把 0 当作没有输出预留。
const OUTPUT_TOKEN_MAX = 32_000

function maxOutputTokens(model: Provider["models"][string], outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}

// 显示阈值沿 V1 catalog 预算；不能混用 Core V2 的 request/config.buffer 契约。
function overflowUsable(input: { cfg: Config; model: Provider["models"][string]; outputTokenMax?: number }): number {
  // 限额来自模型输入契约，面板字符估算的 used 不参与压缩阈值计算。
  return SessionOverflowV1.usable({
    context: input.model.limit.context,
    input: input.model.limit.input,
    output: maxOutputTokens(input.model, input.outputTokenMax),
    reserved: (input.cfg as { compaction?: { reserved?: number } }).compaction?.reserved,
  })
}

type WithParts = {
  // compaction 依赖用户父 ID 与助手 finish 的关联，不能只传可见助手列表就裁掉请求边界。
  info: Message
  parts: Part[]
}

export type ContextCategoryColor = "primary" | "secondary" | "accent" | "warning" | "success" | "info" | "textMuted"

export interface ContextCategory {
  name: string
  // 分类是当前窗口文本估算，不能替代 provider 已确认的计费字段。
  tokens: number
  color: ContextCategoryColor
  // reserve/free/buffer 延迟分类只占网格空间，不再次增加已用 token。
  isDeferred?: boolean
}

export interface GridSquare {
  // 格子保存计算结果而非 store 引用，resize 的渲染过程不能再次读取正在流式变化的消息。
  symbol: string
  categoryName: string
  color: ContextCategoryColor
  fullness: number
}

export interface ContextUsageData {
  model: string
  // 已用量只覆盖当前模型窗口，整场会话消费保存在 details.usage。
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: ContextCategory[]
  gridRows: GridSquare[][]
  details: {
    instructions: Array<{ path: string; tokens: number }>
    loadedInstructions: Array<{ path: string; tokens: number }>
    skills: Array<{ name: string; tokens: number; path: string }>
    toolDefs: Array<{ name: string; tokens: number }>
    messages: {
      // 文本分类与 provider 用量分开保存，流式尚未确认时仍能展示窗口。
      userText: number
      assistantText: number
      reasoning: number
      toolCalls: number
      toolResults: number
      attachments: number
      compactionSummary: number
    }
    usage: {
      // input 是非缓存输入；缓存读写分别保留，合计时不会与 input 重复。
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      total: number
      cost: number
    }
    window: {
      // contextLimit 与 inputLimit 不同，差额归 providerReserve 而非压缩缓冲。
      contextLimit: number
      inputLimit: number
      usableInput: number
      providerReserve: number
      compactionBuffer: number
    }
  }
}

export interface ContextUsagePaths {
  cwd: string
  worktree?: string
  // 可选 shell 来自同步配置，仅用于工具描述估算，不参与执行或权限判定。
  shell?: string
  // home/config 可覆盖扫描位置；测试不必读真实用户的全局指令目录。
  home?: string
  config?: string
}

export interface ComputeContextDataInput {
  // messages 与 parts 保留全历史，窗口裁剪发生在 computeContextData 内。
  messages: Message[]
  parts: Record<string, Part[]>
  providers: Provider[]
  config?: Config
  agents?: Agent[]
  // 会话权限由 prompt 持久化；下一条用户消息省略 tools 时仍决定工具广告。
  session?: Session
  lastUserModel?: { providerID: string; modelID: string }
  vcs?: VcsInfo
  paths: ContextUsagePaths
  columns?: number
  // 显式空数组同样覆盖扫描结果，测试与调用方可阻止不相关磁盘观察。
  instructionFiles?: Array<{ path: string; content: string }>
  skills?: Array<{ name: string; description: string; path: string }>
  // 自定义定义是完整覆盖，不把 catalog 偷偷合并进注入的工具集合。
  toolDefinitions?: Array<{ name: string; text: string }>
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  ...(truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT") ? [] : ["CLAUDE.md"]),
  "CONTEXT.md",
]

function estimate(text: string, ratio = 4) {
  return Math.max(0, Math.round(text.length / ratio))
}

function latestInputEstimate(messages: WithParts[], raw: WithParts[], model: { providerID: string; modelID: string }): Partial<NonNullable<AssistantMessage["inputEstimate"]>> {
  // 仅无请求投影的旧 V1 数据扫描确认点；当前请求缺失估算不等于可以借用旧轮次。
  // 已有 inputChars 的助手只取确认 parts，不能再叠加同一助手旧 carrier 的相同样本。
  const samples = raw.toReversed().flatMap(message => {
    const info = message.info
    if (info.role !== "assistant" || info.providerID !== model.providerID || info.modelID !== model.modelID) return []
    const parts = message.parts.toReversed().flatMap(part => part.type === "step-finish" && part.inputChars !== undefined
      ? [{ bodyChars: part.inputChars, input: part.tokens.input + part.tokens.cache.read + part.tokens.cache.write }] : [])
    return parts.length > 0 ? parts : info.inputEstimate?.confirmed
      ? [{ bodyChars: info.inputEstimate.bodyChars, input: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write }] : []
  })
  for (const message of messages.toReversed()) {
    const info = message.info
    if (info.role !== "assistant" || info.providerID !== model.providerID || info.modelID !== model.modelID) continue
    if (info.inputEstimate) return { ...info.inputEstimate, charsPerToken: info.inputEstimate.charsPerToken ?? Token.charsPerTokenFromHistory(samples) }
    const part = message.parts.findLast(part => part.type === "step-finish" && part.inputBreakdown !== undefined)
    if (part?.type !== "step-finish") continue
    return { input: part.tokens.input + part.tokens.cache.read + part.tokens.cache.write,
      bodyChars: part.inputChars ?? 0, confirmed: true, inputBreakdown: part.inputBreakdown,
      charsPerToken: Token.charsPerTokenFromHistory(samples) }
  }
  return { charsPerToken: Token.charsPerTokenFromHistory(samples) }
}

function distribute<T extends { tokens: number }>(items: T[], total: number, equal = false) {
  const weight = items.reduce((sum, item) => sum + item.tokens, 0)
  let previous = 0
  let cumulative = 0
  return items.map((item) => {
    // instructions 无权重时清零；工具允许均分，累计舍入保证非空明细与服务端分类精确同额。
    cumulative += weight > 0 ? item.tokens / weight : equal ? 1 / items.length : 0
    const next = Math.round(cumulative * total)
    const tokens = next - previous
    previous = next
    return { ...item, tokens }
  })
}

function stableJson(input: unknown): string {
  if (input === undefined) return ""
  try {
    return JSON.stringify(input, (_, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value
      // 只排序对象键，数组顺序仍表达参数语义，不能为了稳定性重排数组。
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    })
  } catch {
    return String(input)
  }
}

function estimateFileToken(url: string, mime: string, ratio: number) {
  // 内联图片/PDF 沿已有编码负载启发式与图像封顶；不能把整份 data URL 当普通文本重复估算。
  if (url.startsWith("data:")) return estimateDataUrlInputTokens(url, mime)
  return estimate(url, ratio)
}

// 裁剪只认成功摘要与匹配的用户父 ID；正在压缩的请求仍需保留原上下文供重试。
export function filterCompactedMessages(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: string | undefined
  for (const msg of msgs) {
    result.push(msg)
    // retain 跨过旧摘要继续扫描至 tail_start_id，保留区不再由更早的压缩边界截断。
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    // 普通用户消息即使被 summary 引用也不构成压缩边界，必须同时存在 compaction 部件。
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item) => item.type === "compaction")
      if (!part) continue
      // 全量压缩仍保留刚刚 push 的请求，删除旧历史不能把生成摘要所依据的本轮用户记录删掉。
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    // 失败摘要不能成为裁剪依据，否则重试前的真实历史会被隐藏。
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
      // 摘要 parentID 指向用户压缩请求，裁剪匹配该身份而非摘要助手自身 ID。
      completed.add(msg.info.parentID)
    }
  }
  // 倒序只用于找到最新边界，返回值恢复时间顺序以保持 findLast 用户选择与工具载荷顺序。
  result.reverse()
  return result
}

// 当前窗口按投影用途分类；工具请求是输出，工具结果是下一轮输入，不能合并计入同一栏。
function messageTokens(messages: WithParts[], ratio: number) {
  const details: ContextUsageData["details"]["messages"] = {
    userText: 0,
    assistantText: 0,
    reasoning: 0,
    toolCalls: 0,
    toolResults: 0,
    attachments: 0,
    compactionSummary: 0,
  }
  const loadedInstructionPaths = new Set<string>()
  const text = [] as string[]
  const toolNames = new Set<string>()

  for (const msg of messages) {
    for (const part of msg.parts) {
      switch (part.type) {
        case "text": {
          // synthetic 正文也发送给模型；只有 ignored 文本被投影排除。
          if (part.ignored) continue
          text.push(part.text)
          const tokens = estimate(part.text, ratio)
          if (msg.info.role === "user") details.userText += tokens
          else if (msg.info.role === "assistant" && msg.info.summary === true) details.compactionSummary += tokens
          else details.assistantText += tokens
          break
        }
        case "reasoning":
          // reasoning 文本是窗口载荷估算，不替代 provider tokens.reasoning 的确认消费。
          details.reasoning += estimate(part.text, ratio)
          break
        case "tool": {
          toolNames.add(part.tool)
          // JSON 标点和字段名也属于调用载荷；字符数/4 仅用于显示估算。
          details.toolCalls += estimate(stableJson(part.state.input), ratio)
          if (part.state.status === "completed") {
            // metadata 是 wire unknown；只接纳字符串路径，避免把其他工具元数据当文件名读取。
            // 只有完成的 read 提供 loaded 证明，未完成或错误工具不产生指令来源。
            const loaded = part.tool === "read" ? part.state.metadata?.loaded : undefined
            if (Array.isArray(loaded)) {
              for (const item of loaded) if (typeof item === "string") loadedInstructionPaths.add(item)
            }
            // 已压缩的工具结果用占位符估算，避免读取已清除的大体积输出
            const output = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
            details.toolResults += estimate(output, ratio)
            // 内联证明必须来自已计入窗口的同一正文，压缩前残留 output 不能证明指令仍可见。
            text.push(output)
            for (const attachment of part.state.attachments ?? []) {
              details.attachments += estimateFileToken(attachment.url, attachment.mime, ratio)
            }
          }
          // 未解析 raw 属于流式请求载荷；完成/错误状态不得再把残留 raw 加入输出估算。
          if (part.state.status === "pending") details.toolCalls += estimate(part.state.raw, ratio)
          if (part.state.status === "error") details.toolResults += estimate(part.state.error, ratio)
          break
        }
        case "file":
          // data URL 使用既有视觉/PDF 启发式，普通 URL 只估算引用文本，不能把二者都按 base64 长度计费。
          details.attachments += estimateFileToken(part.url, part.mime, ratio)
          break
        case "subtask":
          // subtask 是用户发起的任务载荷，不能因最终由子代理执行就挪到助手输出分类。
          details.userText += estimate(`${part.prompt}\n${part.description}`, ratio)
          break
      }
    }
  }

  return {
    details,
    text,
    loadedInstructionPaths,
    toolNames,
    total: Object.values(details).reduce((sum, value) => sum + value, 0),
  }
}

function usageTotals(messages: WithParts[]): ContextUsageData["details"]["usage"] {
  const usage: ContextUsageData["details"]["usage"] = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  }
  let confirmed = false
  // 部件与消息携带同一生产者结果，存在确认部件时不能再加一次消息用量。
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "step-finish") continue
      // 零 token 的 step-finish 也已确认，历史回退取决于部件存在性而非总额真值。
      confirmed = true
      usage.input += part.tokens.input
      // getUsage 已扣除 reasoning；展示的 output 不应再次包含推理。
      usage.output += part.tokens.output
      usage.reasoning += part.tokens.reasoning
      usage.cacheRead += part.tokens.cache.read
      usage.cacheWrite += part.tokens.cache.write
      usage.cost += part.cost
    }
  }

  // 消息级字段仅服务没有确认部件的历史格式；这条回退不能与已有部件账本叠加。
  if (!confirmed) {
    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue
      usage.input += msg.info.tokens.input
      // 助手消息与 step-finish 保存同一 getUsage 结果，回退也保持分栏。
      usage.output += msg.info.tokens.output
      usage.reasoning += msg.info.tokens.reasoning
      usage.cacheRead += msg.info.tokens.cache.read
      usage.cacheWrite += msg.info.tokens.cache.write
      usage.cost += msg.info.cost
    }
  }
  // total 各加一次 output/reasoning；cost 是金额，不能进入 token 总额。
  usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
  return usage
}

async function exists(filepath: string) {
  // 指令发现允许目录不存在或不可访问；只有估算降级，不改变运行时工具的失败出口。
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

async function readText(filepath: string) {
  // 读不到的指令不制造内容占位 token；已加载的消息文本仍由 messageTokens 完整保留。
  try {
    return await fs.readFile(filepath, "utf8")
  } catch {
    return ""
  }
}

// 保留从 cwd 到 worktree 的全部祖先，嵌套项目的规则不能只扫描仓库根目录。
function parents(start: string, stop?: string) {
  const result: string[] = []
  let current = path.resolve(start)
  // 仓库根之外的 AGENTS.md 不属于项目来源，祖先遍历以传入 worktree 为边界而非进程 cwd。
  const root = stop ? path.resolve(stop) : path.parse(current).root
  while (true) {
    result.push(current)
    if (current === root) break
    const next = path.dirname(current)
    // cwd 不在 stop 之下时仍在文件系统根终止，避免一个未命中的 worktree 造成死循环。
    if (next === current) break
    current = next
  }
  return result
}

// 同类型祖先规则全部保留；父目录存在 AGENTS.md 不应覆盖更近目录的同名规则。
async function findUpAll(filename: string, start: string, stop?: string) {
  const result: string[] = []
  for (const dir of parents(start, stop)) {
    const filepath = path.resolve(dir, filename)
    if (await exists(filepath)) result.push(filepath)
  }
  return result
}

// 技能目录缺失是可选配置，不生成空技能；递归只收集普通文件 SKILL.md，目录名不能充当技能。
async function scanSkillFiles(root: string, result: Set<string>) {
  // 一处不可访问目录只终止该分支，其余项目/home/config 来源仍可进入去重集合。
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null)
  if (!entries) return
  for (const entry of entries) {
    // readdir 默认 utf8 返回字符串；目录路径必须保持平台编码，不能按字节拆成多个技能路径。
    const name = entry.name as string
    const item = path.join(root, name)
    if (entry.isDirectory()) {
      await scanSkillFiles(item, result)
      continue
    }
    if (entry.isFile() && name === "SKILL.md") result.add(path.resolve(item))
  }
}

// 显式传入 [] 表示无需磁盘扫描，不能用 length 判断并重新读取用户 home。
async function gatherInstructionFiles(input: ComputeContextDataInput) {
  if (input.instructionFiles) return input.instructionFiles
  const paths = new Set<string>()
  const cwd = input.paths.cwd
  const worktree = input.paths.worktree

  // 禁用项目配置只关闭项目来源；全局及显式 config.instructions 仍按各自契约参与估算。
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const file of INSTRUCTION_FILES) {
      const matches = await findUpAll(file, cwd, worktree)
      if (matches.length > 0) {
        for (const match of matches) paths.add(path.resolve(match))
        // 同类型祖先规则全部加入后停止类型扫描，AGENTS.md 与 CLAUDE.md 不叠加。
        break
      }
    }
  }

  const home = input.paths.home ?? os.homedir()
  // 全局来源按优先级取第一份，不能把同一配置通过环境路径与输入路径重复相加。
  const globalFiles = [
    ...(Flag.OPENCODE_CONFIG_DIR ? [path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md")] : []),
    ...(input.paths.config ? [path.join(input.paths.config, "AGENTS.md")] : []),
    ...(!truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT") ? [path.join(home, ".claude", "CLAUDE.md")] : []),
  ]
  for (const file of globalFiles) {
    if (await exists(file)) {
      paths.add(path.resolve(file))
      break
    }
  }

  // 额外 instructions 不受项目文件类型停止规则限制，显式配置必须独立解析并参与路径去重。
  const configured = Array.isArray(input.config?.instructions) ? input.config.instructions : []
  for (const raw of configured) {
    if (typeof raw !== "string") continue
    // 估算不能为了读取远程 instructions 发起网络请求；实际服务端加载行为不在此复制。
    if (raw.startsWith("https://") || raw.startsWith("http://")) continue
    const expanded = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw
    const matches = path.isAbsolute(expanded)
      ? [(await exists(expanded)) ? expanded : ""].filter(Boolean)
      : await findUpAll(expanded, cwd, worktree)
    for (const match of matches) paths.add(path.resolve(match))
  }

  const files = [] as Array<{ path: string; content: string }>
  for (const filepath of paths) {
    const content = await readText(filepath)
    if (content) files.push({ path: filepath, content: `Instructions from: ${filepath}\n${content}` })
  }
  return files
}

function skillInfo(skills: Array<{ name: string; description: string; path: string }>) {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: skill.path,
    // 技能尚未执行时正文留空，公告不会提前携带完整技能内容。
    content: "",
  }))
}

async function gatherSkills(input: ComputeContextDataInput) {
  // 调用方已提供技能时，不再访问用户 home 或项目技能目录。
  if (input.skills) return input.skills
  const matches = new Set<string>()
  const home = input.paths.home ?? os.homedir()
  const cwd = input.paths.cwd
  const worktree = input.paths.worktree

  // 关闭 external skills 时不触碰 .claude/.agents；.opencode 与显式 skills.paths 仍保留。
  if (!truthy("OPENCODE_DISABLE_EXTERNAL_SKILLS")) {
    for (const dir of [".claude", ".agents"]) {
      await scanSkillFiles(path.join(home, dir, "skills"), matches)
    }
    for (const dir of parents(cwd, worktree)) {
      for (const external of [".claude", ".agents"]) {
        await scanSkillFiles(path.join(dir, external, "skills"), matches)
      }
    }
  }

  // 相同配置目录可能来自多个入口，Set 防止同一 SKILL.md 因路径来源不同而多次估算。
  const configDirs = new Set([input.paths.config, Flag.OPENCODE_CONFIG_DIR].filter((x): x is string => !!x))
  for (const dir of parents(cwd, worktree)) {
    const configDir = path.join(dir, ".opencode")
    if (await exists(configDir)) configDirs.add(configDir)
  }
  const homeConfig = path.join(home, ".opencode")
  if (await exists(homeConfig)) configDirs.add(homeConfig)

  for (const dir of configDirs) {
    // 两种已发布目录拼写都扫描，最后按文件路径去重；不能把重复公告当作两项技能能力。
    await scanSkillFiles(path.join(dir, "skill"), matches)
    await scanSkillFiles(path.join(dir, "skills"), matches)
  }

  // 相对 skills.paths 基于会话 cwd 而非 TUI process.cwd，附着到远程/其他项目时保持输入归属。
  const configured = input.config?.skills?.paths
  if (Array.isArray(configured)) {
    for (const raw of configured) {
      if (typeof raw !== "string") continue
      const expanded = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw
      await scanSkillFiles(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded), matches)
    }
  }

  // 缺失或非字符串元数据的文件不广告为可用技能，不能以文件名猜测 description 来补空项。
  const skills = [] as Array<{ name: string; description: string; path: string }>
  for (const filepath of matches) {
    const content = await readText(filepath)
    if (!content) continue
    try {
      const parsed = matter(content)
      if (typeof parsed.data.name !== "string" || typeof parsed.data.description !== "string") continue
      // 名称和描述直接提取 frontmatter 字段，不能用正文标题推断广告内容。
      skills.push({ name: parsed.data.name, description: parsed.data.description, path: filepath })
    } catch {
      continue
    }
  }
  return skills
}

// 两份 Task 参数都是手工运输的完整 JSON；字段说明也参与字符估算，不能当作自动生成资产排除。
export function resolveToolDescriptions(paths: ContextUsagePaths, background = enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS")) {
  return Object.entries(EMBEDDED_TOOL_CATALOG).map(([name, entry]) => {
    // TaskTool 默认广告 BaseParameters；后台开关开启才同时广告完整参数与后台运行说明。
    const parameters = name === "task" && !background ? EMBEDDED_TOOL_CATALOG.task.baseParameters : entry.parameters
    // V1 description 已从 Shell.guidance 消费共享 Git 文本；目录估算使用同一资产，旧 catalog 不再复制政策。
    const description = name === "bash" ? [GIT_SAFETY, SHELL_DESCRIPTION].join("\n\n") : name === "task"
      ? [TaskPrompt.description, ...(background ? [EMBEDDED_TOOL_CATALOG.task.backgroundDescription] : [])].join("\n\n")
      : entry.description
    // 序列化必须保留 optional/required/default 与嵌套字段；这里只选择 owner 资产，不重建 Schema。
    // 参数文档不做 shell 占位符替换；字段说明中的特殊字符属于契约，不能在渲染时修改。
    return { name, text: [`Tool: ${name}`, resolveTemplateVars(description, paths), `Parameters: ${JSON.stringify(parameters)}`].join("\n") }
  })
}

// 模板只在已有文本上替换；不扫描文件、动态导入工具模块或解析 schema。
function resolveTemplateVars(text: string, paths: ContextUsagePaths): string {
  if (!text.includes("${") && !text.includes("{{year}}")) return text
  // 已配置 shell 优先于环境变量，路径末尾的 .exe 不影响 Windows 语法选择。
  const shell = paths.shell ?? process.env.SHELL ?? (process.platform === "win32" ? "powershell" : "bash")
  const shellName = path.basename(shell.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "")
  // 5.1 不支持链式运算符；7+ 与 cmd 使用各自的条件执行语法。
  const chain = shellName === "powershell"
    ? "If commands depend on each other, do NOT use '&&' or '||'. Use `cmd1; if ($?) { cmd2 }`."
    : shellName === "pwsh"
      ? "If commands depend on each other, use `&&` when the second command should only run after the first succeeds. Use `;` only for unconditional sequencing."
      : shellName === "cmd"
        ? "If commands depend on each other, use `&&` for conditional sequencing in cmd.exe."
        : "If commands depend on each other, use a single shell call with '&&' to chain them together."
  // Windows 文件操作提示必须跟随 shell，而非统一声称使用 PowerShell。
  const shellGuidance = process.platform !== "win32" ? "" : shellName === "powershell" ? [
    "PowerShell notes:",
    "- This shell is Windows PowerShell 5.1 unless configured otherwise.",
    "- Do NOT use Unix utilities such as tail, head, sed, awk, or grep.",
    "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
    "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
    "- Do NOT use /dev/null. Use $null.",
    "- Do NOT use && or ||. Use `A; if ($?) { B }` when B depends on A succeeding.",
    "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
  ].join("\n") : shellName === "pwsh" ? [
    "PowerShell notes:",
    "- This shell is PowerShell 7+.",
    "- Bash-like && and || are supported, but Unix utilities such as tail/head/sed/awk/grep may still be unavailable.",
    "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
    "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
    "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
  ].join("\n") : shellName === "cmd" ? [
    "Windows cmd notes:",
    "- Use cmd.exe syntax, not Bash or PowerShell syntax.",
    "- Use `dir` for directory listing and `type` for simple file output.",
    "- Do NOT use Unix utilities such as ls, tail, head, sed, awk, or grep.",
    "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
    "- Use `NUL` for the null device, not `/dev/null`.",
  ].join("\n") : "Windows shell notes: prefer dedicated OpenCode tools for file operations."
  // cwd 与 worktree 是调用方快照；不以本进程的工作目录覆盖它们。
  return text
    .replaceAll("${cwd}", paths.cwd)
    .replaceAll("${worktree}", paths.worktree ?? paths.cwd)
    .replaceAll("${intro}", "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.")
    .replaceAll("${workdirSection}", "All commands run in the current working directory by default. Use the workdir parameter if you need to run a command in a different directory.")
    .replaceAll("${commandSection}", "Before executing the command, please follow directory verification and quoting rules for paths with spaces.")
    // 临时目录、操作系统和 shell 身份仍是估算文本，不参与工具执行。
    .replaceAll("${tmp}", os.tmpdir())
    .replaceAll("${os}", process.platform)
    .replaceAll("${shell}", shellName)
    .replaceAll("${directory}", paths.cwd)
    .replaceAll("${chaining}", chain)
    .replaceAll("${shellGuidance}", shellGuidance)
    // 列目录示例使用 shell 原生命令，避免 Windows 出现 ls 示例。
    .replaceAll("${listCommand}", process.platform !== "win32" ? "`ls`" : ["powershell", "pwsh"].includes(shellName) ? "`Get-ChildItem`" : shellName === "cmd" ? "`dir`" : "the shell-native directory listing command")
    .replaceAll("${maxLines}", "1000")
    .replaceAll("${maxBytes}", "24576")
    // 压缩指引由运行时提供，此处没有虚构第二套配置。
    .replaceAll("${compressionGuidance}", "")
    // websearch 的年度提示也属于 catalog 文本渲染，不能留下未展开标记。
    .replaceAll("{{year}}", String(new Date().getFullYear()))
}



type PermissionRuleLike = Agent["permission"][number]
const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"])
// 后写规则覆盖早期默认规则，复用 core 的 ? 与 Windows 路径归一语义。
function evaluateRule(permission: string, pattern: string, ruleset: readonly PermissionRuleLike[] = []) {
  for (let i = ruleset.length - 1; i >= 0; i--) {
    const rule = ruleset[i]
    if (Wildcard.match(permission, rule.permission, process.platform === "win32") && Wildcard.match(pattern, rule.pattern, process.platform === "win32")) return rule
  }
  return undefined
}
// disabled 与 runtime 一样先取最后匹配 permission 的规则，再判断是否全资源 deny。
function disabledTools(names: string[], ruleset: readonly PermissionRuleLike[] = []) {
  return new Set(
    names.filter((name) => {
      const permission = EDIT_TOOL_NAMES.has(name) ? "edit" : ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name) ? "read" : name
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission, process.platform === "win32"))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}
// catalog 提供序列化定义，当前模型、开关及权限过滤决定集合，历史调用不覆写这些输入。
function baseToolDefinitions(
  input: ComputeContextDataInput,
  modelInfo: ReturnType<typeof currentModel>,
) {
  // 注入 definitions 是完整测试覆盖，包括空数组；不能再合并真实 catalog 扩大这个集合。
  if (input.toolDefinitions) return input.toolDefinitions
  // registry 收到解析后的 API ID；显示别名保留给面板，缺失模型不能猜测它的后端身份。
  const apiID = modelInfo.model?.api.id
  const usePatch = apiID !== undefined && apiID.includes("gpt-") && !apiID.includes("oss") && !apiID.includes("gpt-4")
  const resolved = resolveToolDescriptions(input.paths)
  // EXA 合并实验伞，Parallel/question 缺省 false；先解析全部键，不能用 provider/client 旁路掩盖非法值。
  const flags = {
    exa: ["OPENCODE_EXPERIMENTAL", "OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL_EXA"].map((key) => enabledByExperimental(key, false)).some(Boolean),
    parallel: ["OPENCODE_ENABLE_PARALLEL", "OPENCODE_EXPERIMENTAL_PARALLEL"].map((key) => enabledByExperimental(key, false)).some(Boolean),
    question: enabledByExperimental("OPENCODE_ENABLE_QUESTION_TOOL", false),
  }
  return resolved
    .filter((item) => {
      if (item.name === "question") {
        const client = process.env["OPENCODE_CLIENT"] ?? "cli"
        return ["app", "cli", "desktop"].includes(client) || flags.question
      }
      // 专用关闭值优先于实验伞；只有后端会提供 LSP 时才估算其定义 token。
      if (item.name === "lsp") return enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL")
      // plan_exit 还受 client=cli 限制，桌面客户端即使启用实验 plan 也不能看到不可执行工具。
      if (item.name === "plan_exit") {
        const client = process.env["OPENCODE_CLIENT"] ?? "cli"
        return enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE") && client === "cli"
      }
      // 与实际 registry 对齐：Go provider 与 Parallel 开关同样广告 websearch。
      if (item.name === "websearch") return ["opencode", "opencode-go"].includes(modelInfo.providerID) || flags.exa || flags.parallel
      if (usePatch) return item.name !== "edit" && item.name !== "write"
      return item.name !== "apply_patch"
    })
}

// 活跃集合以定义列表为基线，避免历史 tool parts 折叠
function activeToolNames(definitions: Array<{ name: string }>, lastUser: Message | undefined) {
  const names = new Set(definitions.map((item) => item.name))
  if (lastUser?.role === "user" && lastUser.tools) {
    for (const [name, enabled] of Object.entries(lastUser.tools)) {
      if (enabled === false) {
        names.delete(name)
        // 旧消息的 edit:false 是编辑能力禁令，模型切到 apply_patch 也不能绕过这份显式禁用。
        if (name === "edit") {
          names.delete("write")
          names.delete("apply_patch")
        }
      }
    }
  }
  return names
}

// 定义文本由 catalog 序列化，调用参数已归消息分类，不再加入工具定义样本。
function toolDefinitionTokens(
  input: ComputeContextDataInput,
  skills: Array<{ name: string; description: string; path: string }>,
  lastUser: Message | undefined,
  modelInfo: ReturnType<typeof currentModel>,
  ratio: number,
) {
  // catalog 渲染模板，动态描述保留原始文本并使用同一请求模型身份。
  const scanned = baseToolDefinitions(input, modelInfo)
  const agent = lastUser?.role === "user" ? input.agents?.find((item) => item.name === lastUser.agent) : undefined
  // Session 规则排在 agent 后；同一过滤也作用于完整注入定义，不能绕过持久 deny。
  const disabled = disabledTools(scanned.map((item) => item.name), [...(agent?.permission ?? []), ...(input.session?.permission ?? [])])
  // 可用定义先过滤权限与用户禁用项，历史调用不能重新广告已禁用工具。
  const active = activeToolNames(scanned.filter((item) => !disabled.has(item.name)), lastUser)
  const byName = new Map(scanned.map((item) => [item.name, item.text]))
  const details: Array<{ name: string; tokens: number }> = []
  for (const name of active) {
    const text = [byName.get(name), dynamicToolText(name, input, skills, lastUser)].filter(Boolean).join("\n")
    details.push({ name, tokens: estimate(text || name, ratio) })
  }
  return details.toSorted((a, b) => a.name.localeCompare(b.name))
}

function dynamicToolText(name: string, input: ComputeContextDataInput, skills: Array<{ name: string; description: string; path: string }>, lastUser?: Message) {
  if (name === "task") {
    // task 子代理名称按同一 Wildcard 规则过滤；revie? deny 必须影响动态描述而不仅是工具集合。
    const agent = lastUser?.role === "user" ? input.agents?.find((item) => item.name === lastUser.agent) : undefined
    const rules = agent?.permission ?? []
    const description = (input.agents ?? [])
      .filter((item) => item.mode !== "primary")
      .filter((item) => {
        if (!agent) return true
        const rule = evaluateRule("task", item.name, rules)
        return !(rule && rule.action === "deny")
      })
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((item) => "- " + item.name + ": " + (item.description ?? "This subagent should only be called manually by the user."))
      .join(String.fromCharCode(10))
    return ["Available agent types and the tools they have access to:", description].join(String.fromCharCode(10))
  }
  if (name === "skill") return skillFmt(skillInfo(skills), { verbose: false })
  return ""
}


// agent 自定义 prompt 完整替换模型模板，不能同时拼入两份族模板把系统开销翻倍。
function baseSystemPrompt(
  input: ComputeContextDataInput,
  lastUser: Message | undefined,
  model: Provider["models"][string] | undefined,
) {
  const agent = lastUser?.role === "user" ? input.agents?.find((item) => item.name === lastUser.agent) : undefined
  if (agent?.prompt) return agent.prompt
  // 未找到模型时只省略族模板；环境与用户 system 仍由调用方正常组装。
  if (!model) return ""
  // 模板字符串来自静态 asset，估算不再读取源码路径；packed binary 与源码运行使用同一文本。
  return SessionPrompts.provider(model.api?.id ?? model.id, model.providerID)
}

// 分段间的换行也是字符载荷；环境与族提示分别组装后统一估算，不能按段落名称补固定 token。
function environmentText(input: ComputeContextDataInput, modelID: string, providerID: string, toolNames: string[]) {
  const lines = [
    `You are powered by the model named ${modelID}. The exact model ID is ${providerID}/${modelID}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${input.paths.cwd}`,
    `  Workspace root folder: ${input.paths.worktree ?? input.paths.cwd}`,
    "  Is directory a git repo: unknown",
    `  Current branch: ${input.vcs?.branch ?? "(unknown)"}`,
    `  Platform: ${process.platform}`,
    // 这段历史环境模板描述宿主平台，具体工具 shell 模板另有配置来源，二者并非可互换的测量值。
    ...(process.platform === "win32"
      ? [
          "  Shell syntax: use PowerShell syntax, not Unix shell syntax.",
          "  Do NOT use Unix-only commands such as tail, head, sed, awk, or grep in shell commands.",
        ]
      : []),
    `  OS Version: ${os.type()} ${os.release()}`,
    `  Today's date: ${new Date().toDateString()}`,
    "</env>",
  ]
  return [lines.join("\n"), toolUsageSection(toolNames), ...staticSections()].join("\n\n")
}

// 会话最后用户模型优先于当前 UI 选择；只改变选择器不应把旧请求窗口切到另一个模型。
function currentModel(input: ComputeContextDataInput, lastUser: Message | undefined) {
  const selected = lastUser?.role === "user" ? lastUser.model : input.lastUserModel
  // 模型名只在所属 provider 内解析，不跨网关猜测相同 ID 的限制。
  const provider = input.providers.find((item) => item.id === selected?.providerID)
  const model = selected?.modelID ? provider?.models[selected.modelID] : undefined
  return {
    providerID: selected?.providerID ?? provider?.id ?? "",
    modelID: selected?.modelID ?? "",
    model,
  }
}

// usable 不超过 context；异常小窗口也只显示零可用输入，不让 reserve 产生负数占用。
function windowTokens(input: ComputeContextDataInput, model: Provider["models"][string] | undefined) {
  if (!model) return 0
  const context = model.limit.context
  if (!context) return 0
  return Math.max(0, Math.min(context, overflowUsable({ cfg: input.config ?? ({} as Config), model })))
}

// 两种预留拥有不同来源：provider input 差额不是自动压缩的阈值，不能合并显示。
function windowDetails(input: ComputeContextDataInput, model: Provider["models"][string] | undefined, contextLimit = model?.limit.context ?? 0) {
  // catalog 的 input 可能大于 context，先夹住才能让 reserve 与 buffer 保持非负。
  const inputLimit = model?.limit.input ? Math.min(model.limit.input, contextLimit) : contextLimit
  const usableInput = windowTokens(input, model)
  // 缺省 input 用 context 填充，未知限制不制造 reserve；非零差额也不属于本会话消费。
  const providerReserve = Math.max(0, contextLimit - inputLimit)
  // buffer 只覆盖 input 与 usable 的差额，未知模型/极小窗口也不显示负缓冲。
  const compactionBuffer = Math.max(0, inputLimit - usableInput)
  return {
    contextLimit,
    inputLimit,
    usableInput,
    providerReserve,
    compactionBuffer,
  }
}

// 网格密度受终端宽度限制，而 token 分母始终是模型窗口，resize 不能改变计数口径。
function gridSize(contextLimit: number, columns?: number, rows?: number) {
  const width = columns ?? process.stdout.columns ?? 80
  const narrow = width < 80
  if (narrow) {
    // 窄屏缩小列数而非裁掉分类；右侧明细仍按原始 token 展示，网格只改变采样密度。
    return {
      width: Math.max(5, Math.min(10, Math.floor(Math.max(12, width - 8) / 2))),
      height: rows ?? (contextLimit >= 1_000_000 ? 10 : 5),
    }
  }

  // 大模型增加采样格数但不能越过可用列宽，百万窗口也不能挤掉分类标签。
  const modelWidth = contextLimit >= 1_000_000 ? 32 : contextLimit >= 200_000 ? 24 : contextLimit >= 100_000 ? 16 : 10
  const maxWidth = Math.max(10, Math.floor(Math.min(width * 0.36, Math.max(20, width - 72)) / 2))
  const modelHeight = contextLimit >= 1_000_000 ? 14 : contextLimit >= 200_000 ? 12 : 10
  return {
    width: Math.max(10, Math.min(modelWidth, maxWidth)),
    height: rows ?? modelHeight,
  }
}

// 网格是有损采样：小于半格的分类可无符号，右侧整数明细仍保留它，不能从符号数还原 token。
export function contextGrid(categories: ContextCategory[], contextLimit: number, options?: { columns?: number; rows?: number }) {
  const { width: gridW, height: gridH } = gridSize(contextLimit, options?.columns, options?.rows)
  const total = gridW * gridH
  const cells: GridSquare[] = []
  // buffer 从尾部分配，避免前面的大额 reserve 抢走安全缓冲的最后一格。
  const tail = categories.find((category) => category.name === "Autocompact buffer")
  const body = categories.filter((category) => category.name !== "Autocompact buffer")

  const countFor = (category: ContextCategory, remaining: number) => {
    // 小分类只在超过半格时可见，不能每项强占一格并让许多 tiny 工具淹没实际窗口比例。
    const exact = contextLimit > 0 ? (category.tokens / contextLimit) * total : 0
    let count = Math.round(exact)
    if (category.tokens > 0 && !category.isDeferred && count === 0 && exact >= 0.5) count = 1
    return {
      exact,
      count: Math.max(0, Math.min(count, remaining)),
    }
  }

  // reserve/free 与其他分类共享 bodyLimit，先扣除尾部容量才能避免大额 reserve 吞掉压缩缓冲。
  const tailCount = tail ? countFor(tail, total).count : 0
  const bodyLimit = total - tailCount
  // 剩余容量约束每次分配，即使估算超过窗口也不会渲染无限格子。
  for (const category of body) {
    const { exact, count } = countFor(category, bodyLimit - cells.length)
    for (let i = 0; i < count; i++) {
      // 超窗口估算的余量仍夹在 [0,1]，否则饱满度会越过已定义的两档填充符号。
      const fullness = Math.max(0, Math.min(1, exact - i))
      cells.push({
        symbol: category.name === "Free space" ? "⛶" : category.name === "Model reserve" ? "⛝" : fullness >= 0.7 ? "⛁" : "⛀",
        categoryName: category.name,
        color: category.color,
        fullness,
      })
    }
    if (cells.length >= bodyLimit) break
  }

  // 舍入产生的空格归 free，而不是再计入某个 prompt 分类；token 总额不由格子数反推。
  const free = categories.find((item) => item.name === "Free space")
  while (cells.length < bodyLimit) {
    cells.push({
      symbol: "⛶",
      categoryName: "Free space",
      color: free?.color ?? "textMuted",
      fullness: 0,
    })
  }
  // 尾部饱满度使用 tail 自身比例而非总 used，安全缓冲不会因消息增长被画成消息占用。
  if (tail) {
    const exact = contextLimit > 0 ? (tail.tokens / contextLimit) * total : 0
    while (cells.length < total) {
      const i = cells.length - bodyLimit
      cells.push({
        symbol: "⛝",
        categoryName: tail.name,
        color: tail.color,
        fullness: Math.max(0, Math.min(1, exact - i)),
      })
    }
  }

  // 只切已有有限 cells，最后一行不足列宽也不增加虚构 used token。
  const rows: GridSquare[][] = []
  for (let i = 0; i < cells.length; i += gridW) rows.push(cells.slice(i, i + gridW))
  return rows
}

// 窗口分类使用裁剪结果；确认消费独立交给 usageTotals，不能从字符估算的 used 反算计费用量。
export async function computeContextData(input: ComputeContextDataInput): Promise<ContextUsageData> {
  // filter 接受新到旧的序列，源数组仍保持原顺序，不能原位 reverse 改掉 Sync 的消息顺序。
  const raw = input.messages.map((msg) => ({ info: msg, parts: input.parts[msg.id] ?? [] }))
  const compacted = filterCompactedMessages(raw.toReversed())
  const lastUser = compacted.findLast((msg) => msg.info.role === "user")?.info
  const modelInfo = currentModel(input, lastUser)
  // 请求投影包含 native 首包前与确认后的细分；只有没有投影的旧 V1 才读取确认 part。
  const prepared = input.session?.request ? input.session.request.inputEstimate : latestInputEstimate(compacted, raw, modelInfo)
  const bd = prepared?.inputBreakdown
  // 密度冻结自本轮输入侧校准；显示窗口或模型选择变化不能重新解释服务端 prepared input。
  const ratio = prepared?.charsPerToken && Number.isFinite(prepared.charsPerToken) && prepared.charsPerToken > 0 ? prepared.charsPerToken : 4
  // Catalog 消失或助手被淘汰仍保留本轮预算，零不能被当前同 API 的其他 alias 替换。
  const frozen = input.session?.request?.model?.contextLimit ?? prepared?.contextLimit
  const windowModel = modelInfo.model && frozen !== undefined
    ? { ...modelInfo.model, limit: { ...modelInfo.model.limit, context: frozen } } : modelInfo.model
  const maxTokens = frozen ?? modelInfo.model?.limit.context ?? 0

  const msg = messageTokens(compacted, ratio)
  // raw 保存整场会话用量；窗口分类仍由 compacted 估算。
  const usage = usageTotals(raw)
  const instructions = await gatherInstructionFiles(input)
  const instructionDetails = instructions.map((item) => ({ path: item.path, tokens: estimate(item.content, ratio) }))
  const messageText = msg.text.join("\n")
  // Read 的指令可能在工具 output 而非 text 部件；只为未在已计数正文内出现的 loaded 路径读盘。
  const loadedInstructions = [] as Array<{ path: string; tokens: number }>
  for (const filepath of msg.loadedInstructionPaths) {
    if (messageText.includes(`Instructions from: ${filepath}`)) continue
    const content = await readText(filepath)
    if (content && !bd) loadedInstructions.push({ path: filepath, tokens: estimate(`Instructions from: ${filepath}\n${content}`, ratio) })
  }

  const skills = await gatherSkills(input)
  const skillListing = skillsSection(skillInfo(skills))
  const skillTokens = bd ? Math.round(bd.skills / ratio) : estimate(skillListing, ratio)
  const skillDetails = skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    tokens: bd ? 1 : estimate(skillsSection(skillInfo([skill])), ratio),
  }))
  const toolDefs = toolDefinitionTokens(input, skills, lastUser, modelInfo, ratio)
  // 用户 system 是同一请求的附加系统载荷；存在自定义 agent prompt 也不能省略该字段。
  const systemText = [
    baseSystemPrompt(input, lastUser, modelInfo.model),
    environmentText(input, modelInfo.modelID, modelInfo.providerID, toolDefs.map((item) => item.name)),
    lastUser?.role === "user" ? lastUser.system : undefined,
  ].filter(Boolean).join("\n")
  // 五类与消息六子项只消费服务端字符证明；本地文件仅为旧数据或明细名称提供展示权重。
  const envTokens = bd ? Math.round(bd.system / ratio) : estimate(systemText, ratio)
  const instructionTokens = bd ? Math.round(bd.instructions / ratio) : instructionDetails.reduce((sum, item) => sum + item.tokens, 0)
  const loadedInstructionTokens = loadedInstructions.reduce((sum, item) => sum + item.tokens, 0)
  const toolDefTokens = bd ? Math.round(bd.tools / ratio) : toolDefs.reduce((sum, item) => sum + item.tokens, 0)
  const messageDetails = bd ? {
    userText: Math.round(bd.messages.userText / ratio), assistantText: Math.round(bd.messages.assistantText / ratio),
    reasoning: Math.round(bd.messages.reasoning / ratio), toolCalls: Math.round(bd.messages.toolInput / ratio),
    toolResults: Math.round(bd.messages.toolOutput / ratio), attachments: Math.round(bd.messages.attachments / ratio), compactionSummary: 0,
  } : msg.details
  const userMessageTokens = messageDetails.userText + messageDetails.attachments
  const assistantMessageTokens = messageDetails.assistantText + messageDetails.reasoning + messageDetails.compactionSummary
  // 源消息分类已区分工具入参与返回；部件归助手不能把工具结果并入助手正文，工具定义也只归广告开销。
  const toolCallTokens = messageDetails.toolCalls
  const toolResultTokens = messageDetails.toolResults
  // 四桶只重组同一份冻结整数，直接相加才能保留拆分前 used；逐桶重估会引入额外舍入误差。
  const messageTotal = userMessageTokens + toolResultTokens + assistantMessageTokens + toolCallTokens
  const window = windowDetails(input, windowModel, maxTokens)
  // used 只包含发送载荷；free、模型预留与压缩缓冲不是 token 消费，不能再次加入分子。
  // 分类分别 round 后相加会有短文本舍入误差；确认消费仍独立读取 provider 字段。
  const used = envTokens + instructionTokens + loadedInstructionTokens + skillTokens + toolDefTokens + messageTotal
  // 超出 usable 时自由空间归零，但 used 保留真实估算，不能为了百分比好看裁掉超额载荷。
  const free = maxTokens ? Math.max(0, window.usableInput - used) : 0

  const categories: ContextCategory[] = [
    { name: "System prompt", tokens: envTokens, color: "primary" },
    { name: "Instructions", tokens: instructionTokens + loadedInstructionTokens, color: "info" },
    { name: "Skills", tokens: skillTokens, color: "success" },
    // 工具定义与输入消息分别用 secondary/warning，保留两种分类的视觉辨识。
    { name: "Tool definitions", tokens: toolDefTokens, color: "secondary" },
    { name: "User Messages", tokens: userMessageTokens, color: "warning" },
    { name: "Tool Results", tokens: toolResultTokens, color: "warning" },
    { name: "Assistant Messages", tokens: assistantMessageTokens, color: "accent" },
    { name: "Tool Calls", tokens: toolCallTokens, color: "accent" },
    // free 非零也不能进入 used；isDeferred 只影响网格可见性门槛，不改变百分比分子。
    { name: "Free space", tokens: free, color: "textMuted", isDeferred: true },
    ...(window.providerReserve > 0
      ? [{ name: "Model reserve", tokens: window.providerReserve, color: "textMuted" as const, isDeferred: true }]
      : []),
    { name: "Autocompact buffer", tokens: window.compactionBuffer, color: "textMuted", isDeferred: true },
  ]

  // 返回脱离流式 proxy 的数值与字符串，resize 消费同一轮完成的估算结果。
  return {
    model: [input.session?.request?.model?.providerID ?? modelInfo.providerID, input.session?.request?.model?.modelID ?? modelInfo.modelID].filter(Boolean).join("/") || "(unknown)",
    totalTokens: used,
    maxTokens,
    percentage: maxTokens ? used / maxTokens : 0,
    categories,
    // 未知窗口只选择可渲染的网格分母，maxTokens 与百分比仍保留未知值 0。
    gridRows: contextGrid(categories, maxTokens || Math.max(used + window.compactionBuffer + free, 1), { columns: input.columns }),
    details: {
      // 服务端零总额也要清零本地明细，不能只在正值分支覆盖默认估算而残留上一轮数值。
      instructions: bd ? distribute(instructionDetails, instructionTokens) : instructionDetails,
      loadedInstructions,
      skills: bd ? distribute(skillDetails, skillTokens, true) : skillDetails,
      toolDefs: bd ? distribute(toolDefs, toolDefTokens, true) : toolDefs,
      messages: messageDetails,
      usage,
      window,
    },
  }
}

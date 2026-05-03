import fs from "fs/promises"
import os from "os"
import path from "path"
import matter from "gray-matter"
import type { Agent, Config, Message, Part, Provider, VcsInfo } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { toJsonSchema } from "@/util/effect-zod"
import { Schema } from "effect"
import { Shell } from "@/shell/shell"
import { Skill } from "@/skill"
import { Wildcard } from "@/util"
import APPLY_PATCH_DESCRIPTION from "@/tool/apply_patch.txt"
import BASH_DESCRIPTION from "@/tool/bash.txt"
import EDIT_DESCRIPTION from "@/tool/edit.txt"
import GLOB_DESCRIPTION from "@/tool/glob.txt"
import GREP_DESCRIPTION from "@/tool/grep.txt"
import LSP_DESCRIPTION from "@/tool/lsp.txt"
import PLAN_EXIT_DESCRIPTION from "@/tool/plan-exit.txt"
import QUESTION_DESCRIPTION from "@/tool/question.txt"
import READ_DESCRIPTION from "@/tool/read.txt"
import SKILL_DESCRIPTION from "@/tool/skill.txt"
import TASK_DESCRIPTION from "@/tool/task.txt"
import TODOWRITE_DESCRIPTION from "@/tool/todowrite.txt"
import WEBFETCH_DESCRIPTION from "@/tool/webfetch.txt"
import WEBSEARCH_DESCRIPTION from "@/tool/websearch.txt"
import WRITE_DESCRIPTION from "@/tool/write.txt"
import { ApplyPatchTool, Parameters as ApplyPatchParameters } from "@/tool/apply_patch"
import { BashTool, Parameters as BashParameters } from "@/tool/bash"
import { EditTool, Parameters as EditParameters } from "@/tool/edit"
import { GlobTool, Parameters as GlobParameters } from "@/tool/glob"
import { GrepTool, Parameters as GrepParameters } from "@/tool/grep"
import { InvalidTool, Parameters as InvalidParameters } from "@/tool/invalid"
import { LspTool, Parameters as LspParameters } from "@/tool/lsp"
import { PlanExitTool, Parameters as PlanExitParameters } from "@/tool/plan"
import { QuestionTool, Parameters as QuestionParameters } from "@/tool/question"
import { ReadTool, Parameters as ReadParameters } from "@/tool/read"
import { SkillTool, Parameters as SkillParameters } from "@/tool/skill"
import { TaskTool, Parameters as TaskParameters } from "@/tool/task"
import { TodoWriteTool, Parameters as TodoWriteParameters } from "@/tool/todo"
import { WebFetchTool, Parameters as WebFetchParameters } from "@/tool/webfetch"
import { WebSearchTool, Parameters as WebSearchParameters } from "@/tool/websearch"
import { WriteTool, Parameters as WriteParameters } from "@/tool/write"
import {
  provider as systemProviderPrompt,
  skillsSection as systemSkillsSection,
  staticSections as systemStaticSections,
  toolUsageSection as systemToolUsageSection,
} from "@/session/system"
import { usable as overflowUsable } from "@/session/overflow"
import { estimateDataUrlInputTokens } from "./token-estimate"

type WithParts = {
  info: Message
  parts: Part[]
}

export type ContextCategoryColor = "primary" | "secondary" | "accent" | "warning" | "success" | "info" | "textMuted"

export interface ContextCategory {
  name: string
  tokens: number
  color: ContextCategoryColor
  isDeferred?: boolean
}

export interface GridSquare {
  symbol: string
  categoryName: string
  color: ContextCategoryColor
  fullness: number
}

export interface ContextUsageData {
  model: string
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
      userText: number
      assistantText: number
      reasoning: number
      toolCalls: number
      toolResults: number
      attachments: number
      compactionSummary: number
    }
    usage: {
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      total: number
      cost: number
    }
    window: {
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
  home?: string
  config?: string
}

export interface ComputeContextDataInput {
  messages: Message[]
  parts: Record<string, Part[]>
  providers: Provider[]
  config?: Config
  agents?: Agent[]
  lastUserModel?: { providerID: string; modelID: string }
  vcs?: VcsInfo
  paths: ContextUsagePaths
  columns?: number
  instructionFiles?: Array<{ path: string; content: string }>
  skills?: Array<{ name: string; description: string; path: string }>
  toolDefinitions?: Array<{ name: string; text: string }>
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  ...(Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]),
  "CONTEXT.md",
]

const DEFAULT_CHARS_PER_TOKEN = 4

function estimate(input: unknown, ratio = DEFAULT_CHARS_PER_TOKEN) {
  const text = typeof input === "string" ? input : stableJson(input)
  return Math.max(0, Math.round((text || "").length / ratio))
}

/** 从 session 历史 step-finish 的 inputChars/inputTokens 计算输入侧 chars-per-token。 */
function computeInputRatio(messages: WithParts[]): number {
  let totalChars = 0
  let totalTokens = 0
  for (let i = messages.length - 1; i >= 0 && totalChars < 100_000; i--) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    for (const p of msg.parts) {
      if (p.type !== "step-finish") continue
      const chars = (p as any).inputChars as number | undefined
      if (!chars || chars < 100) continue
      const tokens = (p as any).tokens?.input + (p as any).tokens?.cache?.read + (p as any).tokens?.cache?.write
      if (!tokens || tokens <= 0) continue
      totalChars += chars
      totalTokens += tokens
    }
  }
  if (totalTokens > 0 && totalChars > 500) return totalChars / totalTokens
  return DEFAULT_CHARS_PER_TOKEN
}

type InputBreakdown = {
  system: number
  instructions: number
  skills: number
  tools: number
  messages: {
    userText: number
    assistantText: number
    reasoning: number
    toolInput: number
    toolOutput: number
    attachments: number
    total: number
  }
}

/** 从 session 历史取最近一个由 daemon 记录的 per-component 字符数，用于替代 TUI 自行重建。 */
function latestBreakdown(messages: WithParts[]): InputBreakdown | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const p = msg.parts[j] as any
      if (p.type !== "step-finish") continue
      const bd = p.inputBreakdown as InputBreakdown | undefined
      if (bd && bd.system >= 0 && bd.messages && bd.messages.total >= 0) return bd
    }
  }
  return undefined
}

function stableJson(input: unknown): string {
  if (input === undefined) return ""
  try {
    return JSON.stringify(input, (_, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    })
  } catch {
    return String(input)
  }
}

function estimateFileToken(url: string, mime: string, ratio = DEFAULT_CHARS_PER_TOKEN) {
  if (url.startsWith("data:")) return estimateDataUrlInputTokens(url, mime)
  return estimate(url, ratio)
}

export function filterCompactedMessages(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: string | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item) => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
      completed.add(msg.info.parentID)
    }
  }
  result.reverse()
  return result
}

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
          if (part.ignored || part.synthetic) continue
          text.push(part.text)
          const tokens = estimate(part.text, ratio)
          if (msg.info.role === "user") details.userText += tokens
          else if (msg.info.role === "assistant" && msg.info.summary === true) details.compactionSummary += tokens
          else details.assistantText += tokens
          break
        }
        case "reasoning":
          details.reasoning += estimate(part.text, ratio)
          break
        case "tool": {
          toolNames.add(part.tool)
          details.toolCalls += estimate(part.state.input, ratio)
          if (part.state.status === "completed") {
            const loaded = part.tool === "read" ? part.state.metadata?.loaded : undefined
            if (Array.isArray(loaded)) {
              for (const item of loaded) if (typeof item === "string") loadedInstructionPaths.add(item)
            }
            details.toolResults += part.state.time.compacted
              ? estimate("[Old tool result content cleared]", ratio)
              : estimate(part.state.output, ratio)
            for (const attachment of part.state.attachments ?? []) {
              details.attachments += estimateFileToken(attachment.url, attachment.mime, ratio)
            }
          }
          if (part.state.status === "pending") details.toolCalls += estimate(part.state.raw, ratio)
          if (part.state.status === "error") details.toolResults += estimate(part.state.error, ratio)
          break
        }
        case "file":
          details.attachments += estimateFileToken(part.url, part.mime, ratio)
          break
        case "subtask":
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
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "step-finish") continue
      confirmed = true
      usage.input += part.tokens.input
      usage.output += part.tokens.output
      usage.reasoning += part.tokens.reasoning
      usage.cacheRead += part.tokens.cache.read
      usage.cacheWrite += part.tokens.cache.write
      usage.cost += part.cost
    }
  }

  if (!confirmed) {
    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue
      usage.input += msg.info.tokens.input
      usage.output += msg.info.tokens.output
      usage.reasoning += msg.info.tokens.reasoning
      usage.cacheRead += msg.info.tokens.cache.read
      usage.cacheWrite += msg.info.tokens.cache.write
      usage.cost += msg.info.cost
    }
  }
  usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
  return usage
}

async function exists(filepath: string) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

async function readText(filepath: string) {
  try {
    return await fs.readFile(filepath, "utf8")
  } catch {
    return ""
  }
}

function parents(start: string, stop?: string) {
  const result: string[] = []
  let current = path.resolve(start)
  const root = stop ? path.resolve(stop) : path.parse(current).root
  while (true) {
    result.push(current)
    if (current === root) break
    const next = path.dirname(current)
    if (next === current) break
    current = next
  }
  return result
}

async function findUpAll(filename: string, start: string, stop?: string) {
  const result: string[] = []
  for (const dir of parents(start, stop)) {
    const filepath = path.resolve(dir, filename)
    if (await exists(filepath)) result.push(filepath)
  }
  return result
}

async function scanSkillFiles(root: string, result: Set<string>) {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const item = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await scanSkillFiles(item, result)
      continue
    }
    if (entry.isFile() && entry.name === "SKILL.md") result.add(path.resolve(item))
  }
}

async function gatherInstructionFiles(input: ComputeContextDataInput) {
  if (input.instructionFiles) return input.instructionFiles
  const paths = new Set<string>()
  const cwd = input.paths.cwd
  const worktree = input.paths.worktree

  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const file of INSTRUCTION_FILES) {
      const matches = await findUpAll(file, cwd, worktree)
      if (matches.length > 0) {
        for (const match of matches) paths.add(path.resolve(match))
        break
      }
    }
  }

  const home = input.paths.home ?? os.homedir()
  const globalFiles = [
    ...(Flag.OPENCODE_CONFIG_DIR ? [path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md")] : []),
    ...(input.paths.config ? [path.join(input.paths.config, "AGENTS.md")] : []),
    ...(!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [path.join(home, ".claude", "CLAUDE.md")] : []),
  ]
  for (const file of globalFiles) {
    if (await exists(file)) {
      paths.add(path.resolve(file))
      break
    }
  }

  const configured = Array.isArray(input.config?.instructions) ? input.config.instructions : []
  for (const raw of configured) {
    if (typeof raw !== "string") continue
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
    content: "",
  }))
}

async function gatherSkills(input: ComputeContextDataInput) {
  if (input.skills) return input.skills
  const matches = new Set<string>()
  const home = input.paths.home ?? os.homedir()
  const cwd = input.paths.cwd
  const worktree = input.paths.worktree

  if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
    for (const dir of [".claude", ".agents"]) {
      await scanSkillFiles(path.join(home, dir, "skills"), matches)
    }
    for (const dir of parents(cwd, worktree)) {
      for (const external of [".claude", ".agents"]) {
        await scanSkillFiles(path.join(dir, external, "skills"), matches)
      }
    }
  }

  const configDirs = new Set([input.paths.config, Flag.OPENCODE_CONFIG_DIR].filter((x): x is string => !!x))
  for (const dir of parents(cwd, worktree)) {
    const configDir = path.join(dir, ".opencode")
    if (await exists(configDir)) configDirs.add(configDir)
  }
  const homeConfig = path.join(home, ".opencode")
  if (await exists(homeConfig)) configDirs.add(homeConfig)

  for (const dir of configDirs) {
    await scanSkillFiles(path.join(dir, "skill"), matches)
    await scanSkillFiles(path.join(dir, "skills"), matches)
  }

  const configured = input.config?.skills?.paths
  if (Array.isArray(configured)) {
    for (const raw of configured) {
      if (typeof raw !== "string") continue
      const expanded = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw
      await scanSkillFiles(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded), matches)
    }
  }

  const skills = [] as Array<{ name: string; description: string; path: string }>
  for (const filepath of matches) {
    const content = await readText(filepath)
    if (!content) continue
    try {
      const parsed = matter(content)
      if (typeof parsed.data.name !== "string" || typeof parsed.data.description !== "string") continue
      skills.push({ name: parsed.data.name, description: parsed.data.description, path: filepath })
    } catch {
      continue
    }
  }
  return skills
}



type PermissionRuleLike = {
  permission: string
  pattern: string
  action: string
}

const EDIT_TOOL_NAMES = new Set<string>([EditTool.id, WriteTool.id, ApplyPatchTool.id])

function evaluateRule(permission: string, pattern: string, ruleset: readonly PermissionRuleLike[] = []) {
  return ruleset.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}

function disabledTools(names: string[], ruleset: readonly PermissionRuleLike[] = []) {
  return new Set(
    names.filter((name) => {
      const permission = EDIT_TOOL_NAMES.has(name) ? EditTool.id : name
      const rule = evaluateRule(permission, "*", ruleset)
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

type ToolDefinitionTemplate = {
  name: string
  description: string
  parameters: Schema.Top
}

const STATIC_TOOL_DEFINITIONS: ToolDefinitionTemplate[] = [
  { name: InvalidTool.id, description: "Do not use", parameters: InvalidParameters },
  { name: QuestionTool.id, description: QUESTION_DESCRIPTION, parameters: QuestionParameters },
  { name: BashTool.id, description: BASH_DESCRIPTION, parameters: BashParameters },
  { name: ReadTool.id, description: READ_DESCRIPTION, parameters: ReadParameters },
  { name: GlobTool.id, description: GLOB_DESCRIPTION, parameters: GlobParameters },
  { name: GrepTool.id, description: GREP_DESCRIPTION, parameters: GrepParameters },
  { name: EditTool.id, description: EDIT_DESCRIPTION, parameters: EditParameters },
  { name: WriteTool.id, description: WRITE_DESCRIPTION, parameters: WriteParameters },
  { name: TaskTool.id, description: TASK_DESCRIPTION, parameters: TaskParameters },
  { name: WebFetchTool.id, description: WEBFETCH_DESCRIPTION, parameters: WebFetchParameters },
  { name: TodoWriteTool.id, description: TODOWRITE_DESCRIPTION, parameters: TodoWriteParameters },
  { name: WebSearchTool.id, description: WEBSEARCH_DESCRIPTION, parameters: WebSearchParameters },
  { name: SkillTool.id, description: SKILL_DESCRIPTION, parameters: SkillParameters },
  { name: ApplyPatchTool.id, description: APPLY_PATCH_DESCRIPTION, parameters: ApplyPatchParameters },
  { name: LspTool.id, description: LSP_DESCRIPTION, parameters: LspParameters },
  { name: PlanExitTool.id, description: PLAN_EXIT_DESCRIPTION, parameters: PlanExitParameters },
]

function resolveTemplateVars(text: string, paths: ContextUsagePaths): string {
  if (!text.includes("${")) return text

  const shell = Shell.preferred()
  const shellPath = typeof shell === "string" ? shell : (shell as { path: string }).path
  const shellName = Shell.name(shellPath)

  const chain =
    shellName === "powershell"
      ? "If commands depend on each other, do NOT use '&&' or '||'. Use `cmd1; if ($?) { cmd2 }`."
      : shellName === "pwsh"
        ? "If commands depend on each other, use `&&` when the second command should only run after the first succeeds. Use `;` only for unconditional sequencing."
        : shellName === "cmd"
          ? "If commands depend on each other, use `&&` for conditional sequencing in cmd.exe."
          : "If commands depend on each other, use a single shell call with '&&' to chain them together."

  const shellGuidance = (() => {
    if (process.platform !== "win32") return ""
    if (shellName === "powershell") return [
      "PowerShell notes:",
      "- This shell is Windows PowerShell 5.1 unless configured otherwise.",
      "- Do NOT use Unix utilities such as tail, head, sed, awk, or grep.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
      "- Do NOT use /dev/null. Use $null.",
      "- Do NOT use && or ||. Use `A; if ($?) { B }` when B depends on A succeeding.",
      "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
    ].join("\n")
    if (shellName === "pwsh") return [
      "PowerShell notes:",
      "- This shell is PowerShell 7+.",
      "- Bash-like && and || are supported, but Unix utilities such as tail/head/sed/awk/grep may still be unavailable.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
      "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
    ].join("\n")
    if (shellName === "cmd") return [
      "Windows cmd notes:",
      "- Use cmd.exe syntax, not Bash or PowerShell syntax.",
      "- Use `dir` for directory listing and `type` for simple file output.",
      "- Do NOT use Unix utilities such as ls, tail, head, sed, awk, or grep.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- Use `NUL` for the null device, not `/dev/null`.",
    ].join("\n")
    return [
      "Windows shell notes:",
      "- This shell may not support Unix utilities. Prefer dedicated OpenCode tools for file operations.",
    ].join("\n")
  })()

  const listCommand =
    process.platform !== "win32" ? "`ls`"
      : shellName === "powershell" || shellName === "pwsh" ? "`Get-ChildItem`"
      : shellName === "cmd" ? "`dir`"
      : "the shell-native directory listing command"

  return text
    .replaceAll("${os}", process.platform)
    .replaceAll("${shell}", shellName)
    .replaceAll("${directory}", paths.cwd)
    .replaceAll("${chaining}", chain)
    .replaceAll("${shellGuidance}", shellGuidance)
    .replaceAll("${listCommand}", listCommand)
    .replaceAll("${maxLines}", "2000")
    .replaceAll("${maxBytes}", "24576")
    .replaceAll("${compressionGuidance}", "")
}

function baseToolDefinitions(input: ComputeContextDataInput, modelInfo: ReturnType<typeof currentModel>, lastUser: Message | undefined) {
  if (input.toolDefinitions) return input.toolDefinitions

  const usePatch =
    modelInfo.modelID.includes("gpt-") && !modelInfo.modelID.includes("oss") && !modelInfo.modelID.includes("gpt-4")
  const agent = lastUser?.role === "user" ? input.agents?.find((item) => item.name === lastUser.agent) : undefined
  const disabled = agent ? disabledTools(STATIC_TOOL_DEFINITIONS.map((item) => item.name), agent.permission as PermissionRuleLike[]) : new Set<string>()

  return STATIC_TOOL_DEFINITIONS
    .filter((item) => {
      if (item.name === QuestionTool.id) {
        return ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL
      }
      if (item.name === LspTool.id) return Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL
      if (item.name === PlanExitTool.id) return Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli"
      if (item.name === WebSearchTool.id) {
        return modelInfo.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
      }
      if (item.name === ApplyPatchTool.id) return usePatch
      if (item.name === EditTool.id || item.name === WriteTool.id) return !usePatch
      return true
    })
    .filter((item) => !disabled.has(item.name))
    .map((item) => ({
      name: item.name,
      text: [
        `Tool: ${item.name}`,
        resolveTemplateVars(item.description, input.paths),
        stableJson(toJsonSchema(item.parameters)),
      ].join("\n"),
    }))
}

function activeToolNames(definitions: Array<{ name: string; text: string }>, lastUser: Message | undefined) {
  const disabled = new Set<string>()
  if (lastUser?.role === "user" && lastUser.tools) {
    for (const [name, enabled] of Object.entries(lastUser.tools)) {
      if (enabled) continue
      disabled.add(name)
      if (name === "edit") {
        disabled.add(EditTool.id)
        disabled.add(WriteTool.id)
        disabled.add(ApplyPatchTool.id)
      }
    }
  }
  return definitions.map((item) => item.name).filter((name) => !disabled.has(name))
}

function dynamicToolText(name: string, input: ComputeContextDataInput, skills: Array<{ name: string; description: string; path: string }>, lastUser: Message | undefined) {
  if (name === TaskTool.id) {
    const current = lastUser?.role === "user" ? input.agents?.find((agent) => agent.name === lastUser.agent) : undefined
    const description = (input.agents ?? [])
      .filter((agent) => agent.mode !== "primary")
      .filter((agent) => !current || evaluateRule(TaskTool.id, agent.name, current.permission as PermissionRuleLike[])?.action !== "deny")
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((agent) => `- ${agent.name}: ${agent.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n")
    return ["Available agent types and the tools they have access to:", description].join("\n")
  }
  if (name === SkillTool.id) return skills.length === 0 ? "No skills are currently available." : Skill.fmt(skillInfo(skills), { verbose: false })
  return ""
}

async function toolDefinitionTokens(
  input: ComputeContextDataInput,
  skills: Array<{ name: string; description: string; path: string }>,
  lastUser: Message | undefined,
  modelInfo: ReturnType<typeof currentModel>,
  ratio: number,
) {
  const definitions = baseToolDefinitions(input, modelInfo, lastUser)
  const byName = new Map(definitions.map((item) => [item.name, item.text]))
  return activeToolNames(definitions, lastUser)
    .map((name) => ({
      name,
      tokens: estimate([byName.get(name), dynamicToolText(name, input, skills, lastUser)].filter(Boolean).join("\n"), ratio),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

function baseSystemPrompt(
  input: ComputeContextDataInput,
  lastUser: Message | undefined,
  model: Provider["models"][string] | undefined,
) {
  const agent = lastUser?.role === "user" ? input.agents?.find((item) => item.name === lastUser.agent) : undefined
  if (agent?.prompt) return agent.prompt
  if (!model) return ""
  return systemProviderPrompt(model as any).join("\n")
}

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
  return [lines.join("\n"), systemToolUsageSection(toolNames), ...systemStaticSections()].join("\n\n")
}

function currentModel(input: ComputeContextDataInput, lastUser: Message | undefined) {
  const selected = lastUser?.role === "user" ? lastUser.model : input.lastUserModel
  const provider = input.providers.find((item) => item.id === selected?.providerID)
  const model = selected?.modelID ? provider?.models[selected.modelID] : undefined
  return {
    providerID: selected?.providerID ?? provider?.id ?? "",
    modelID: selected?.modelID ?? "",
    model,
  }
}

function windowTokens(input: ComputeContextDataInput, model: Provider["models"][string] | undefined) {
  if (!model) return 0
  const context = model.limit.context
  if (!context) return 0
  return Math.max(0, Math.min(context, overflowUsable({ cfg: input.config ?? {}, model } as any)))
}

function windowDetails(input: ComputeContextDataInput, model: Provider["models"][string] | undefined) {
  const contextLimit = model?.limit.context ?? 0
  const inputLimit = model?.limit.input ? Math.min(model.limit.input, contextLimit) : contextLimit
  const usableInput = windowTokens(input, model)
  const providerReserve = Math.max(0, contextLimit - inputLimit)
  const compactionBuffer = Math.max(0, inputLimit - usableInput)
  return {
    contextLimit,
    inputLimit,
    usableInput,
    providerReserve,
    compactionBuffer,
  }
}

function gridSize(contextLimit: number, columns?: number, rows?: number) {
  const width = columns ?? process.stdout.columns ?? 80
  const narrow = width < 80
  if (narrow) {
    return {
      width: Math.max(5, Math.min(10, Math.floor(Math.max(12, width - 8) / 2))),
      height: rows ?? (contextLimit >= 1_000_000 ? 10 : 5),
    }
  }

  const modelWidth = contextLimit >= 1_000_000 ? 32 : contextLimit >= 200_000 ? 24 : contextLimit >= 100_000 ? 16 : 10
  const maxWidth = Math.max(10, Math.floor(Math.min(width * 0.36, Math.max(20, width - 72)) / 2))
  const modelHeight = contextLimit >= 1_000_000 ? 14 : contextLimit >= 200_000 ? 12 : 10
  return {
    width: Math.max(10, Math.min(modelWidth, maxWidth)),
    height: rows ?? modelHeight,
  }
}

export function contextGrid(categories: ContextCategory[], contextLimit: number, options?: { columns?: number; rows?: number }) {
  const { width: gridW, height: gridH } = gridSize(contextLimit, options?.columns, options?.rows)
  const total = gridW * gridH
  const cells: GridSquare[] = []
  const tail = categories.find((category) => category.name === "Autocompact buffer")
  const body = categories.filter((category) => category.name !== "Autocompact buffer")

  const countFor = (category: ContextCategory, remaining: number) => {
    const exact = contextLimit > 0 ? (category.tokens / contextLimit) * total : 0
    let count = Math.round(exact)
    if (category.tokens > 0 && !category.isDeferred && count === 0 && exact >= 0.5) count = 1
    return {
      exact,
      count: Math.max(0, Math.min(count, remaining)),
    }
  }

  const tailCount = tail ? countFor(tail, total).count : 0
  const bodyLimit = total - tailCount
  for (const category of body) {
    const { exact, count } = countFor(category, bodyLimit - cells.length)
    for (let i = 0; i < count; i++) {
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

  const free = categories.find((item) => item.name === "Free space")
  while (cells.length < bodyLimit) {
    cells.push({
      symbol: "⛶",
      categoryName: "Free space",
      color: free?.color ?? "textMuted",
      fullness: 0,
    })
  }
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

  const rows: GridSquare[][] = []
  for (let i = 0; i < cells.length; i += gridW) rows.push(cells.slice(i, i + gridW))
  return rows
}

export async function computeContextData(input: ComputeContextDataInput): Promise<ContextUsageData> {
  const raw = input.messages.map((msg) => ({ info: msg, parts: input.parts[msg.id] ?? [] }))
  const compacted = filterCompactedMessages(raw.toReversed())
  const lastUser = compacted.findLast((msg) => msg.info.role === "user")?.info
  const modelInfo = currentModel(input, lastUser)
  const maxTokens = modelInfo.model?.limit.context ?? 0

  // 从历史 step-finish 校准输入侧 chars-per-token 比值
  const ratio = computeInputRatio(raw)

  // 从历史 step-finish 取最近一次 daemon 记录的真实组件字符数
  const bd = latestBreakdown(raw)

  // 消息部分始终用 TUI 实时迭代（messages 内容随每轮变化）
  const msg = messageTokens(compacted, ratio)
  const usage = usageTotals(raw)

  // ── 各组件 token 估算 ──
  let envTokens: number
  let instructionTokens: number
  let loadedInstructionTokens = 0
  let skillTokens: number
  let toolDefTokens: number
  let inputMessageTokens: number
  let outputMessageTokens: number
  let instructionDetails: Array<{ path: string; tokens: number }>
  let loadedInstructions: Array<{ path: string; tokens: number }> = []
  let skillDetails: Array<{ name: string; tokens: number; path: string }>
  let toolDefs: Array<{ name: string; tokens: number }>

  if (bd) {
    // Daemon 的 breakdown 直接给出各组件字符数，除以校准 ratio 即得准确 token 估算
    envTokens = Math.round(bd.system / ratio)
    instructionTokens = Math.round(bd.instructions / ratio)
    skillTokens = Math.round(bd.skills / ratio)
    toolDefTokens = Math.round(bd.tools / ratio)

    // 消息子组件也使用 daemon 的真实 char 数（而非 TUI 自行从 parts 估算）
    inputMessageTokens = Math.round((bd.messages.userText + bd.messages.toolOutput + bd.messages.attachments) / ratio)
    outputMessageTokens = Math.round((bd.messages.assistantText + bd.messages.reasoning + bd.messages.toolInput) / ratio)

    // detail 列表仍需文件内容（用于展示），但 token 用 breakdown 等比分配
    const instructions = await gatherInstructionFiles(input)
    const instructionCharsTotal = instructions.reduce((s, i) => s + i.content.length, 0)
    instructionDetails = instructions.map((item) => ({
      path: item.path,
      tokens: instructionCharsTotal > 0
        ? Math.round((item.content.length / instructionCharsTotal) * instructionTokens)
        : 0,
    }))

    const skills = await gatherSkills(input)
    skillDetails = skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      tokens: skills.length > 0 ? Math.round(skillTokens / skills.length) : 0,
    }))

    const rawToolDefs = await toolDefinitionTokens(input, skills, lastUser, modelInfo, ratio)
    const rawToolCharsTotal = rawToolDefs.reduce((s, t) => s + t.tokens * ratio, 0)
    toolDefs = rawToolDefs.map((t) => ({
      name: t.name,
      tokens: rawToolCharsTotal > 0
        ? Math.round((t.tokens * ratio / rawToolCharsTotal) * toolDefTokens)
        : t.tokens,
    }))
  } else {
    // 降级路径：TUI 自行重建（无历史 breakdown 时，如 session 第一轮）
    const instructions = await gatherInstructionFiles(input)
    instructionDetails = instructions.map((item) => ({ path: item.path, tokens: estimate(item.content, ratio) }))
    const messageText = msg.text.join("\n")
    for (const filepath of msg.loadedInstructionPaths) {
      if (messageText.includes(`Instructions from: ${filepath}`)) continue
      const content = await readText(filepath)
      if (content) loadedInstructions.push({ path: filepath, tokens: estimate(`Instructions from: ${filepath}\n${content}`, ratio) })
    }
    const skills = await gatherSkills(input)
    const skillListing = systemSkillsSection(skillInfo(skills))
    skillTokens = estimate(skillListing, ratio)
    skillDetails = skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      tokens: estimate(systemSkillsSection(skillInfo([skill])), ratio),
    }))
    toolDefs = await toolDefinitionTokens(input, skills, lastUser, modelInfo, ratio)
    const systemText = [
      baseSystemPrompt(input, lastUser, modelInfo.model),
      environmentText(input, modelInfo.modelID, modelInfo.providerID, toolDefs.map((item) => item.name)),
      lastUser?.role === "user" ? lastUser.system : undefined,
    ].filter(Boolean).join("\n")
    envTokens = estimate(systemText, ratio)
    instructionTokens = instructionDetails.reduce((sum, item) => sum + item.tokens, 0)
    loadedInstructionTokens = loadedInstructions.reduce((sum, item) => sum + item.tokens, 0)
    toolDefTokens = toolDefs.reduce((sum, item) => sum + item.tokens, 0)
    inputMessageTokens = msg.details.userText + msg.details.toolResults + msg.details.attachments
    outputMessageTokens = msg.details.assistantText + msg.details.reasoning + msg.details.toolCalls + msg.details.compactionSummary
  }

  // 从 messages 拆出 tool call input 和 tool result output 作为独立 category
  const toolCallTokens = bd
    ? Math.round(bd.messages.toolInput / ratio)
    : msg.details.toolCalls
  const toolResultTokens = bd
    ? Math.round(bd.messages.toolOutput / ratio)
    : msg.details.toolResults
  const userMessageTokens = inputMessageTokens - toolResultTokens
  const assistantMessageTokens = outputMessageTokens - toolCallTokens
  const window = windowDetails(input, modelInfo.model)
  const used = envTokens + instructionTokens + loadedInstructionTokens + skillTokens + toolDefTokens
    + userMessageTokens + assistantMessageTokens + toolCallTokens + toolResultTokens
  const free = maxTokens ? Math.max(0, window.usableInput - used) : 0

  const categories: ContextCategory[] = [
    { name: "System prompt", tokens: envTokens, color: "primary" },
    { name: "Instructions", tokens: instructionTokens + loadedInstructionTokens, color: "info" },
    { name: "Skills", tokens: skillTokens, color: "success" },
    { name: "Tool definitions", tokens: toolDefTokens, color: "secondary" },
    { name: "Input Messages", tokens: userMessageTokens, color: "warning" },
    { name: "Tool results", tokens: toolResultTokens, color: "warning" },
    { name: "Output Messages", tokens: assistantMessageTokens, color: "accent" },
    { name: "Tool calls", tokens: toolCallTokens, color: "accent" },
    { name: "Free space", tokens: free, color: "textMuted", isDeferred: true },
    ...(window.providerReserve > 0
      ? [{ name: "Model reserve", tokens: window.providerReserve, color: "textMuted" as const, isDeferred: true }]
      : []),
    { name: "Autocompact buffer", tokens: window.compactionBuffer, color: "textMuted", isDeferred: true },
  ]

  return {
    model: [modelInfo.providerID, modelInfo.modelID].filter(Boolean).join("/") || "(unknown)",
    totalTokens: used,
    maxTokens,
    percentage: maxTokens ? used / maxTokens : 0,
    categories,
    gridRows: contextGrid(categories, maxTokens || Math.max(used + window.compactionBuffer + free, 1), { columns: input.columns }),
    details: {
      instructions: instructionDetails,
      loadedInstructions,
      skills: skillDetails,
      toolDefs,
      messages: bd
        ? {
            userText: Math.round(bd.messages.userText / ratio),
            assistantText: Math.round(bd.messages.assistantText / ratio),
            reasoning: Math.round(bd.messages.reasoning / ratio),
            toolCalls: Math.round(bd.messages.toolInput / ratio),
            toolResults: Math.round(bd.messages.toolOutput / ratio),
            attachments: Math.round(bd.messages.attachments / ratio),
            compactionSummary: 0,
          }
        : msg.details,
      usage,
      window,
    },
  }
}

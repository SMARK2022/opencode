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
import BASH_DESCRIPTION from "@/tool/shell/shell.txt"
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
import { ShellTool, Parameters as ShellParameters } from "@/tool/shell"
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
import { usable as overflowUsable } from "@/session/overflow"
import { estimateDataUrlInputTokens } from "./token-estimate"
import { tokenAccounting } from "./token-accounting"

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
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true }) as any
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
  { name: ShellTool.id, description: BASH_DESCRIPTION, parameters: ShellParameters },
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
  const lastUser = input.messages.findLast((msg) => msg.role === "user")
  const modelInfo = currentModel(input, lastUser)
  const maxTokens = modelInfo.model?.limit.context ?? 0

  const acc = tokenAccounting(input.messages, (id) => input.parts[id] ?? [], maxTokens)

  let envTokens = 0
  let instructionTokens = 0
  let skillTokens = 0
  let toolDefTokens = 0
  let instructionDetails: Array<{ path: string; tokens: number }> = []
  let skillDetails: Array<{ name: string; tokens: number; path: string }> = []
  let toolDefs: Array<{ name: string; tokens: number }> = []
  let msgDetails: ContextUsageData["details"]["messages"] = {
    userText: 0, assistantText: 0, reasoning: 0, toolCalls: 0, toolResults: 0, attachments: 0, compactionSummary: 0,
  }

  if (acc.breakdown) {
    const bd = acc.breakdown
    envTokens = bd.system
    instructionTokens = bd.instructions
    skillTokens = bd.skills
    toolDefTokens = bd.tools

    msgDetails = {
      userText: bd.userMessages,
      assistantText: bd.assistantText,
      reasoning: bd.reasoning,
      toolCalls: bd.toolCalls,
      toolResults: bd.toolResults,
      attachments: bd.attachments,
      compactionSummary: 0,
    }

    // 展示明细：文件系统只用于列出路径/名称，token 按 breakdown 预算等比分配
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

    const rawToolDefs = await toolDefinitionTokens(input, skills, lastUser, modelInfo, acc.ratio.input)
    const rawToolCharsTotal = rawToolDefs.reduce((s, t) => s + t.tokens * acc.ratio.input, 0)
    toolDefs = rawToolDefs.map((t) => ({
      name: t.name,
      tokens: rawToolCharsTotal > 0
        ? Math.round((t.tokens * acc.ratio.input / rawToolCharsTotal) * toolDefTokens)
        : t.tokens,
    }))
  }

  const wind = windowDetails(input, modelInfo.model)
  const used = acc.step.input + acc.step.output
  const free = maxTokens ? Math.max(0, wind.usableInput - used) : 0

  const categories: ContextCategory[] = [
    { name: "System prompt", tokens: envTokens, color: "primary" },
    { name: "Instructions", tokens: instructionTokens, color: "info" },
    { name: "Skills", tokens: skillTokens, color: "success" },
    { name: "Tool definitions", tokens: toolDefTokens, color: "secondary" },
    { name: "Input Messages", tokens: msgDetails.userText, color: "warning" },
    { name: "Tool results", tokens: msgDetails.toolResults, color: "warning" },
    { name: "Output Messages", tokens: msgDetails.assistantText + msgDetails.reasoning, color: "accent" },
    { name: "Tool calls", tokens: msgDetails.toolCalls, color: "accent" },
    { name: "Free space", tokens: free, color: "textMuted", isDeferred: true },
    ...(wind.providerReserve > 0
      ? [{ name: "Model reserve", tokens: wind.providerReserve, color: "textMuted" as const, isDeferred: true }]
      : []),
    { name: "Autocompact buffer", tokens: wind.compactionBuffer, color: "textMuted", isDeferred: true },
  ]

  return {
    model: [modelInfo.providerID, modelInfo.modelID].filter(Boolean).join("/") || "(unknown)",
    totalTokens: used,
    maxTokens,
    percentage: maxTokens ? used / maxTokens : 0,
    categories,
    gridRows: contextGrid(categories, maxTokens || Math.max(used + wind.compactionBuffer + free, 1), { columns: input.columns }),
    details: {
      instructions: instructionDetails,
      loadedInstructions: [],
      skills: skillDetails,
      toolDefs,
      messages: msgDetails,
      usage: { ...acc.session, total: acc.session.input + acc.session.output + acc.session.reasoning + acc.session.cacheRead + acc.session.cacheWrite },
      window: wind,
    },
  }
}

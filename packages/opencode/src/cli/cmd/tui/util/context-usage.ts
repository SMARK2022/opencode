import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import matter from "gray-matter"
import type { Agent, Config, Message, Part, Provider, VcsInfo } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { estimate as estimateTokens } from "@/util/token"
import { Skill } from "@/skill"
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

function estimate(input: unknown) {
  return estimateTokens(typeof input === "string" ? input : stableJson(input))
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

function estimateFileToken(url: string, mime: string) {
  if (url.startsWith("data:")) return estimateDataUrlInputTokens(url, mime)
  return estimate(url)
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

function messageTokens(messages: WithParts[]) {
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
          const tokens = estimate(part.text)
          if (msg.info.role === "user") details.userText += tokens
          else if (msg.info.role === "assistant" && msg.info.summary === true) details.compactionSummary += tokens
          else details.assistantText += tokens
          break
        }
        case "reasoning":
          details.reasoning += estimate(part.text)
          break
        case "tool": {
          toolNames.add(part.tool)
          details.toolCalls += estimate(part.state.input)
          if (part.state.status === "completed") {
            const loaded = part.tool === "read" ? part.state.metadata?.loaded : undefined
            if (Array.isArray(loaded)) {
              for (const item of loaded) if (typeof item === "string") loadedInstructionPaths.add(item)
            }
            details.toolResults += part.state.time.compacted
              ? estimate("[Old tool result content cleared]")
              : estimate(part.state.output)
            for (const attachment of part.state.attachments ?? []) {
              details.attachments += estimateFileToken(attachment.url, attachment.mime)
            }
          }
          if (part.state.status === "pending") details.toolCalls += estimate(part.state.raw)
          if (part.state.status === "error") details.toolResults += estimate(part.state.error)
          break
        }
        case "file":
          details.attachments += estimateFileToken(part.url, part.mime)
          break
        case "subtask":
          details.userText += estimate(`${part.prompt}\n${part.description}`)
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

async function scanToolDefinitions() {
  const toolDir = fileURLToPath(new URL("../../../../tool/", import.meta.url))
  const result = [] as Array<{ name: string; text: string }>
  let entries: string[]
  try {
    entries = await fs.readdir(toolDir)
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue
    const filepath = path.join(toolDir, entry)
    const source = await readText(filepath)
    const id = source.match(/Tool\.define(?:<[^>]+>)?\(\s*["']([^"']+)["']/)?.[1]
    if (!id) continue
    const descriptionImport = source.match(/import\s+([A-Z_]+)\s+from\s+["']\.\/([^"']+\.txt)["']/)
    const description = descriptionImport ? await readText(path.join(toolDir, descriptionImport[2])) : ""
    const parameterStart = source.search(/(?:export\s+)?const\s+Parameters\s*=/)
    const parameterEnd = source.search(/export\s+const\s+\w+Tool\s*=\s*Tool\.define/)
    const parameters = parameterStart >= 0
      ? source.slice(parameterStart, parameterEnd > parameterStart ? parameterEnd : undefined)
      : ""
    result.push({ name: id, text: [`Tool: ${id}`, description, parameters].filter(Boolean).join("\n") })
  }
  return result
}

function activeToolNames(messages: WithParts[], lastUser: Message | undefined) {
  const names = new Set<string>()
  if (lastUser?.role === "user" && lastUser.tools) {
    for (const [name, enabled] of Object.entries(lastUser.tools)) {
      if (enabled) names.add(name)
    }
  }
  for (const msg of messages) {
    for (const part of msg.parts) if (part.type === "tool") names.add(part.tool)
  }
  return names
}

function dynamicToolText(name: string, input: ComputeContextDataInput, skills: Array<{ name: string; description: string; path: string }>) {
  if (name === "task") {
    const description = (input.agents ?? [])
      .filter((agent) => agent.mode !== "primary")
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((agent) => `- ${agent.name}: ${agent.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n")
    return ["Available agent types and the tools they have access to:", description].join("\n")
  }
  if (name === "skill") return Skill.fmt(skillInfo(skills), { verbose: false })
  return ""
}

function observedToolShape(name: string, messages: WithParts[]) {
  const samples: unknown[] = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === name && samples.length < 3) samples.push(part.state.input)
    }
  }
  return samples.length ? `Observed inputs:\n${stableJson(samples)}` : ""
}

async function toolDefinitionTokens(
  input: ComputeContextDataInput,
  messages: WithParts[],
  skills: Array<{ name: string; description: string; path: string }>,
  lastUser: Message | undefined,
) {
  const scanned = input.toolDefinitions ?? await scanToolDefinitions()
  const active = activeToolNames(messages, lastUser)
  if (lastUser?.role === "user" && lastUser.tools === undefined && active.size === 0) {
    for (const item of scanned) active.add(item.name)
  }
  const byName = new Map(scanned.map((item) => [item.name, item.text]))
  const details = [] as Array<{ name: string; tokens: number }>
  for (const name of active) {
    const text = [byName.get(name), dynamicToolText(name, input, skills), observedToolShape(name, messages)]
      .filter(Boolean)
      .join("\n")
    details.push({ name, tokens: estimate(text || name) })
  }
  return details.toSorted((a, b) => a.name.localeCompare(b.name))
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

  const msg = messageTokens(compacted)
  const usage = usageTotals(raw)
  const instructions = await gatherInstructionFiles(input)
  const instructionDetails = instructions.map((item) => ({ path: item.path, tokens: estimate(item.content) }))
  const messageText = msg.text.join("\n")
  const loadedInstructions = [] as Array<{ path: string; tokens: number }>
  for (const filepath of msg.loadedInstructionPaths) {
    if (messageText.includes(`Instructions from: ${filepath}`)) continue
    const content = await readText(filepath)
    if (content) loadedInstructions.push({ path: filepath, tokens: estimate(`Instructions from: ${filepath}\n${content}`) })
  }

  const skills = await gatherSkills(input)
  const skillListing = systemSkillsSection(skillInfo(skills))
  const skillTokens = estimate(skillListing)
  const skillDetails = skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    tokens: estimate(systemSkillsSection(skillInfo([skill]))),
  }))
  const toolDefs = await toolDefinitionTokens(input, compacted, skills, lastUser)
  const systemText = [
    baseSystemPrompt(input, lastUser, modelInfo.model),
    environmentText(input, modelInfo.modelID, modelInfo.providerID, toolDefs.map((item) => item.name)),
    lastUser?.role === "user" ? lastUser.system : undefined,
  ].filter(Boolean).join("\n")
  const envTokens = estimate(systemText)
  const instructionTokens = instructionDetails.reduce((sum, item) => sum + item.tokens, 0)
  const loadedInstructionTokens = loadedInstructions.reduce((sum, item) => sum + item.tokens, 0)
  const toolDefTokens = toolDefs.reduce((sum, item) => sum + item.tokens, 0)
  const inputMessageTokens = msg.details.userText + msg.details.toolResults + msg.details.attachments
  const outputMessageTokens =
    msg.details.assistantText + msg.details.reasoning + msg.details.toolCalls + msg.details.compactionSummary
  const messageTotal = inputMessageTokens + outputMessageTokens
  const window = windowDetails(input, modelInfo.model)
  const used = envTokens + instructionTokens + loadedInstructionTokens + skillTokens + toolDefTokens + messageTotal
  const free = maxTokens ? Math.max(0, window.usableInput - used) : 0

  const categories: ContextCategory[] = [
    { name: "System prompt", tokens: envTokens, color: "primary" },
    { name: "Instructions", tokens: instructionTokens + loadedInstructionTokens, color: "info" },
    { name: "Skills", tokens: skillTokens, color: "success" },
    { name: "Tool definitions", tokens: toolDefTokens, color: "warning" },
    { name: "Input Messages", tokens: inputMessageTokens, color: "warning" },
    { name: "Output Messages", tokens: outputMessageTokens, color: "accent" },
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
      messages: msg.details,
      usage,
      window,
    },
  }
}

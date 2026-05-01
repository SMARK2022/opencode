import { Context, Effect, Layer } from "effect"
import { type as osType, release as osRelease } from "os"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_MINIMAX from "./prompt/minimax.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { InstanceContext } from "@/project/instance"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Git } from "@/git"
import { Flag } from "@opencode-ai/core/flag/flag"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool"
import { Shell } from "@/shell/shell"

// 将 git 状态上下文限制在固定长度，避免提示词膨胀。
const MAX_STATUS_CHARS = 2000

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("minimax") || model.api.id.toLowerCase().includes("mini-max")) return [PROMPT_MINIMAX]
  if (model.api.id.toLowerCase().includes("deepseek")) return [PROMPT_DEEPSEEK]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export function toolUsageSection(registeredTools: string[]) {
  const has = (name: string) => registeredTools.includes(name)

  const items: string[] = [
    `Do NOT use the bash tool when a dedicated tool is available.`,
    `Using dedicated tools lets the user review and track your work:`,
  ]

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
    `Parallel writes are allowed ONLY when target files or edit ranges cannot conflict.`,
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

export const actionCareSection = `# Executing actions with care
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

export const sharedWorktreeSection = `# Shared worktree
You may be working in a dirty worktree with user or other-agent changes.
- If unknown changes are in files you need to edit, read them first and work with the current contents.
- If unknown changes are unrelated to your task, ignore them.
- If unknown changes directly block your task or make the correct edit ambiguous, ask the user one concise question.
- Never revert, overwrite, or clean up changes you did not make unless explicitly asked.`

export const verificationSection = `# Verification
Before reporting a coding task complete, verify the change when feasible.
Start with the narrowest relevant check for the code you changed, then broaden to related tests, typecheck, lint, or build as confidence grows.
If you cannot verify, state that plainly and explain the blocker.`

export const contextContinuitySection = `# Context continuity
The conversation may be compacted or resumed from a summary when context gets long.
After compaction, resume from the summary and current messages rather than restarting from scratch.
Compaction summaries can include stale or unrelated context; do not treat old tasks from the summary as current work unless the latest user message asks for them.
Before your final response after a resume, interruption, or context transition, sanity-check that your answer and tool actions address the newest user request, not an older ghost still lingering in the thread.`

export const outputEfficiencySection = `# Output efficiency
Go straight to the point. Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said — just do it. When explaining, include only what is necessary for the user to understand.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at key milestones (e.g. "build passing", "all tests green")
- Errors or blockers that change the plan

If you can say it in one sentence, do not use three. Do not narrate each step or list every file you read. This does not apply to code or tool calls.`

export function staticSections() {
  return [
    actionCareSection,
    sharedWorktreeSection,
    verificationSection,
    contextContinuitySection,
    outputEfficiencySection,
  ]
}

export function skillsSection(list: Skill.Info[]) {
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    // the agents seem to ingest the information about skills a bit better if we present a more verbose
    // version of them here and a less verbose version in tool description, rather than vice versa.
    Skill.fmt(list, { verbose: true }),
  ].join("\n")
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcpInstructions: () => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const git = yield* Git.Service
    const registry = yield* ToolRegistry.Service

    // 该缓存是会话级快照，按 cwd 作为键。
    // 为保持“快照语义”，会话内不主动失效。
    const gitContextCache = new Map<string, string>()

    const getEnvExtras = Effect.fn("SystemPrompt.envExtras")(function* () {
      const actualShell = Shell.acceptable()
      const shellName = Shell.name(actualShell)
      const shellNotes =
        process.platform !== "win32"
          ? [`Shell: ${shellName}`]
          : shellName === "powershell"
            ? [
                `Shell: powershell (Windows PowerShell 5.1)`,
                `Shell syntax: use PowerShell syntax, not Unix shell syntax.`,
                `Do NOT use Unix-only commands such as tail, head, sed, awk, or grep in shell commands.`,
                `Do NOT use /dev/null. Use $null or dedicated tools instead.`,
                `Do NOT use && or || in Windows PowerShell 5.1. Use A; if ($?) { B } for conditional chaining.`,
              ]
            : shellName === "pwsh"
              ? [
                  `Shell: pwsh (PowerShell 7+)`,
                  `Shell syntax: use PowerShell syntax. Bash-like && and || are supported, but Unix utilities such as tail/head/sed/awk/grep may not exist.`,
                  `For file reads/searches/listing, use dedicated OpenCode tools instead of shell commands.`,
                ]
              : shellName === "cmd"
                ? [
                    `Shell: cmd.exe`,
                    `Shell syntax: use Windows cmd syntax, not Bash or PowerShell syntax.`,
                    `Use dir instead of ls, type instead of cat, and do not use tail/head/sed/awk/grep.`,
                    `For file reads/searches/listing, use dedicated OpenCode tools instead of shell commands.`,
                  ]
                : [
                    `Shell: ${shellName}`,
                    `Shell syntax: this Windows shell may not support Unix commands. Prefer dedicated OpenCode tools for file operations.`,
                  ]

      const osVersion = process.platform === "win32"
        ? `${osType()} ${osRelease()}`
        : `${osType()} ${osRelease()}`

      return { shellNotes, osVersion }
    })

    const getKnowledgeCutoff = (modelApiId: string): string | null => {
      if (modelApiId.includes("claude-sonnet-4-6")) return "August 2025"
      if (modelApiId.includes("claude-opus-4-6"))   return "May 2025"
      if (modelApiId.includes("claude-haiku-4"))     return "February 2025"
      if (modelApiId.includes("claude-opus-4") || modelApiId.includes("claude-sonnet-4")) return "January 2025"
      if (modelApiId.includes("gpt-4o"))  return "October 2024"
      if (modelApiId.includes("gemini-2")) return "January 2025"
      return null
    }

    const getGitContext = Effect.fn("SystemPrompt.gitContext")(function* (ctx: InstanceContext) {
      const cwd = ctx.directory
      const cached = gitContextCache.get(cwd)
      if (cached) return cached

      const project = ctx.project
      // 允许关闭详细 git 上下文，但仍保留是否为 git 仓库的信息。
      if (Flag.OPENCODE_DISABLE_GIT) {
        const result = `Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`
        gitContextCache.set(cwd, result)
        return result
      }
      if (project.vcs !== "git") {
        const result = "Is directory a git repo: no"
        gitContextCache.set(cwd, result)
        return result
      }

      // 并行采集 git 字段，降低组装 system prompt 的延迟。
      const [branch, defaultBranch, userName, status, log] = yield* Effect.all([
        git.branch(cwd),
        git.defaultBranch(cwd),
        git.run(["config", "user.name"], { cwd }).pipe(
          Effect.map(r => r.text().trim()),
          Effect.orElseSucceed(() => "")
        ),
        git.status(cwd).pipe(
          Effect.map(items => items.map(item => `${item.code} ${item.file}`).join("\n")),
          Effect.orElseSucceed(() => "")
        ),
        git.run(["log", "--oneline", "-n", "5"], { cwd }).pipe(
          Effect.map(r => r.text().trim()),
          Effect.orElseSucceed(() => "")
        )
      ], { concurrency: 5 })

      const truncatedStatus = status.length > MAX_STATUS_CHARS
        ? status.substring(0, MAX_STATUS_CHARS) + "\n... (truncated because it exceeds 2k characters. If you need more information, run \"git status\" using the bash tool)"
        : status

      const lines = [
        `Is directory a git repo: yes`,
        `This is the git status at the start of the conversation.`,
        `Note that this status is a snapshot in time, and will not update during the conversation.`,
        `Current branch: ${branch ?? "(detached)"}`,
        `Main branch (you will usually use this for PRs): ${defaultBranch?.name ?? "unknown"}`,
        ...(userName ? [`Git user: ${userName}`] : []),
        `Status:\n${truncatedStatus || "(clean)"}`,
        `Recent commits:\n${log || "(no commits)"}`,
      ]
      const result = lines.join("\n")
      gitContextCache.set(cwd, result)
      return result
    })

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const gitContext = yield* getGitContext(ctx)
        const { shellNotes, osVersion } = yield* getEnvExtras()
        const isWorktree = ctx.worktree !== ctx.directory
        const cutoff = getKnowledgeCutoff(model.api.id)
        const toolIds = yield* registry.ids()
        const envLines: string[] = [
          `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
          `Here is some useful information about the environment you are running in:`,
          `<env>`,
          `  Working directory: ${ctx.directory}`,
          `  Workspace root folder: ${ctx.worktree}`,
          // 将 git 多行内容逐行缩进，保持在 <env> 块内格式一致。
          ...gitContext.split("\n").map((line) => `  ${line}`),
          `  Platform: ${process.platform}`,
          ...shellNotes.map((line) => `  ${line}`),
          `  OS Version: ${osVersion}`,
          ...(cutoff ? [`  Knowledge cutoff: ${cutoff}`] : []),
          `  Today's date: ${new Date().toDateString()}`,
          ...(isWorktree ? [
            `  This is a git worktree — run ALL commands from this directory.`,
            `  Do NOT cd to the original repository root.`,
          ] : []),
          `</env>`,
        ]
        return [
          toolUsageSection(toolIds),
          ...staticSections(),
          envLines.join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)
        return skillsSection(list)
      }),

      mcpInstructions: Effect.fn("SystemPrompt.mcpInstructions")(function* () {
        return undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(ToolRegistry.defaultLayer)
)

export * as SystemPrompt from "./system"

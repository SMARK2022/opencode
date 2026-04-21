import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Git } from "@/git"
import { Flag } from "@/flag"

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
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const git = yield* Git.Service

    // 该缓存是会话级快照，按 cwd 作为键。
    // 为保持“快照语义”，会话内不主动失效。
    const gitContextCache = new Map<string, string>()

    const getGitContext = Effect.fn("SystemPrompt.gitContext")(function* () {
      const cwd = Instance.directory
      const cached = gitContextCache.get(cwd)
      if (cached) return cached

      const project = Instance.project
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
        ? status.substring(0, MAX_STATUS_CHARS) + "\n... (truncated because it exceeds 2k characters. If you need more information, run \"git status\" using BashTool)"
        : status

      const lines = [
        `Is directory a git repo: yes`,
        `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
        `Current branch: ${branch ?? "(detached)"}`,
        `Main branch (you will usually use this for PRs): ${defaultBranch?.name ?? "unknown"}`,
        ...(userName ? [`Git user: ${userName}`] : []),
        `Status:\n${truncatedStatus || "(clean)"}`,
        `Recent commits:\n${log || "(no commits)"}`
      ]
      const result = lines.join("\n")
      gitContextCache.set(cwd, result)
      return result
    })

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const gitContext = yield* getGitContext
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            // 将 git 多行内容逐行缩进，保持在 <env> 块内格式一致。
            ...gitContext.split("\n").map((line) => `  ${line}`),
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Git.defaultLayer)
)

export * as SystemPrompt from "./system"

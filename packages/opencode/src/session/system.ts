import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import { SessionPrompts } from "@opencode-ai/core/system-context/prompts"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Git } from "@/git"
import { RuntimeFlags } from "@/effect/runtime-flags"
import os from "node:os"
import { Shell } from "@opencode-ai/core/shell"
import { Config } from "@/config/config"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"

// 只限制状态字段，保留分支和最近提交，避免大型工作树挤占模型上下文。
const MAX_STATUS_CHARS = 2000

export function provider(model: Provider.Model) {
  // 两代按同一实际模型选择完整正文，后续族补丁不再维护两套文本。
  return [SessionPrompts.provider(model.api.id, model.providerID)]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service
    const git = yield* Git.Service
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service

    // 沿用源补丁的目录级缓存，工具改变工作树后仍返回首次采集的状态。
    const gitContextCache = new Map<string, string>()

    const getGitContext = Effect.fn("SystemPrompt.gitContext")(function* () {
      const ctx = yield* InstanceState.context
      const cwd = ctx.directory
      const cached = gitContextCache.get(cwd)
      if (cached) return cached

      // 禁用分支先于所有 Git 调用，确保关闭选项不会泄露用户名或工作树状态。
      if (flags.disableGit) {
        const result = `Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`
        gitContextCache.set(cwd, result)
        return result
      }
      // 非仓库无需探测父目录，保持 Instance 已解析的项目归属。
      if (ctx.project.vcs !== "git") {
        const result = "Is directory a git repo: no"
        gitContextCache.set(cwd, result)
        return result
      }

      // 五个字段互相独立，保留源补丁并行采集以避免串行进程启动延迟。
      const [branch, defaultBranch, userName, status, log] = yield* Effect.all([
        git.branch(cwd),
        git.defaultBranch(cwd),
        // 用户配置可能不存在；沿用源补丁的空字段退化，不阻断模型执行。
        git.run(["config", "user.name"], { cwd }).pipe(
          Effect.map((r) => r.text().trim()),
          Effect.orElseSucceed(() => ""),
        ),
        git.status(cwd).pipe(
          // 保留 Git 服务的双列状态码，不能 trim 掉暂存区与工作树的区别。
          Effect.map((items) => items.map((item) => `${item.code} ${item.file}`).join("\n")),
          Effect.orElseSucceed(() => ""),
        ),
        git.run(["log", "--oneline", "-n", "5"], { cwd }).pipe(
          // 无提交的仓库仍是仓库；日志为空不应改变 repository yes/no。
          Effect.map((r) => r.text().trim()),
          Effect.orElseSucceed(() => ""),
        ),
      ], { concurrency: 5 })

      // 截断发生在格式化后，提示模型按需读取完整状态而非假装状态完整。
      const truncatedStatus =
        status.length > MAX_STATUS_CHARS
          ? status.substring(0, MAX_STATUS_CHARS) +
            // 截断提示中工具名统一小写，与提示词文件保持一致
            "\n... (truncated because it exceeds 2k characters. If you need more information, run \"git status\" using the bash tool)"
          : status

      const lines = [
        `Is directory a git repo: yes`,
        `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
        `Current branch: ${branch ?? "(detached)"}`,
        // detached 与未知默认分支是不同事实，保留各自的源补丁标记。
        `Main branch (you will usually use this for PRs): ${defaultBranch?.name ?? "unknown"}`,
        // 未配置用户名时省略整行，不把缺失信息伪装成有效 Git 身份。
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
        // Effect.fn 返回函数，必须调用后再 yield*，不能直接执行函数值。
        const gitContext = yield* getGitContext()
        // 与 ShellTool 使用同一个实际选择器，Windows 的 pwsh/cmd 不能被 SHELL 猜测替代。
        const shell = Shell.acceptable((yield* config.get()).shell)
        const cutoff = SystemContextBuiltIns.knowledgeCutoff(model.api.id)
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            // 状态和日志可能多行，统一缩进保证它们仍属于同一个环境块。
            ...gitContext.split("\n").map((line) => `  ${line}`),
            `  Platform: ${process.platform}`,
            // 语法信息来自执行 shell；完整 PS/cmd 安全和 quoting 指引仍归工具 description。
            // 沿用上方 cfg.shell 的真实选择，共用说明不能重新猜测环境变量。
            ...Shell.guidance(shell, process.platform).split("\n").map((line) => `  ${line}`),
            `  OS Version: ${os.type()} ${os.release()}`,
            ...(cutoff ? [`  Knowledge cutoff: ${cutoff}`] : []),
            `  Today's date: ${new Date().toDateString()}`,
            // 保留打开目录作为执行位置，不能因为 workspace root 不同就让模型切回原仓库。
            ...(ctx.worktree !== ctx.directory ? ["  Run ALL commands from the working directory; do NOT cd to the original repository root."] : []),
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
          SystemContextBuiltIns.ACTION_GUIDANCE,
          SystemContextBuiltIns.OUTPUT_GUIDANCE,
        ].filter((part): part is string => part !== undefined)
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

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  // Git 与开关沿用既有依赖图，不引入会话事件订阅。
  deps: [Skill.node, MCP.node, locationServiceMapNode, Git.node, RuntimeFlags.node, Config.node],
})

export * as SystemPrompt from "./system"

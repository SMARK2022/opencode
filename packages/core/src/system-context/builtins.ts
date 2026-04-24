export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import os from "node:os"

// 截止日期是源提示的型号映射，未知型号省略，不能用发布日期猜测训练数据截止时间。
export const knowledgeCutoff = (id: string) => {
  if (id.includes("claude-sonnet-4-6")) return "August 2025"
  if (id.includes("claude-opus-4-6")) return "May 2025"
  if (id.includes("claude-haiku-4")) return "February 2025"
  if (id.includes("claude-opus-4") || id.includes("claude-sonnet-4")) return "January 2025"
  if (id.includes("gpt-4o")) return "October 2024"
  if (id.includes("gemini-2")) return "January 2025"
}

// 输入必须是当前 turn 真正广告的工具名；不能读取 registry.ids 或固定默认 agent。
export const toolUsage = (ids: readonly string[]) => {
  if (ids.length === 0) return undefined
  return [
    "# Using your tools",
    "Do NOT use the bash tool when a dedicated tool is available.",
    "Using dedicated tools lets the user review and track your work:",
    // 每条替代指引独立受能力控制，gpt patch-only 请求不会宣称拥有 edit/write。
    ...(ids.includes("read") ? [" - To read files use the read tool instead of cat, head, tail, or sed"] : []),
    ...(ids.includes("edit") ? [" - To edit files use the edit tool instead of sed or awk"] : []),
    ...(ids.includes("write") ? [" - To create files use the write tool instead of echo redirection or heredoc"] : []),
    ...(ids.includes("apply_patch") ? [" - To edit files use the apply_patch tool instead of shell text replacement"] : []),
    ...(ids.includes("grep") ? [" - To search file content use the grep tool instead of grep/rg"] : []),
    ...(ids.includes("glob") ? [" - To find files use the glob tool instead of find or ls"] : []),
    // Todo 工具也受当前 turn 权限约束，不能从静态提示推断其存在。
    ...(ids.includes("todowrite") ? ["# Task Management", "Use the todowrite tool to plan non-trivial tasks and track progress. Mark todos as completed as soon as each task is done; do not batch completion updates."] : []),
    " - Reserve bash for system commands and terminal operations requiring shell execution",
    // 分段分隔是格式契约，避免指引紧贴前面的能力列表。
    "",
    "PARALLELIZE tool calls whenever possible, especially independent file reads, searches, and status checks.",
    "Issue independent tool calls in the same response so they can run in parallel.",
    "Never chain bash commands with separators like `echo \"====\";` to simulate grouped output, because it renders poorly for the user.",
    "Parallel writes are only appropriate when target files or edit ranges cannot conflict.",
    "For multiple changes in one file, prefer one edit/patch containing all non-overlapping changes.",
    "Only call tools sequentially when one result is needed to decide the next call, or when writes may conflict.",
  ].join("\n")
}

// 稳定行为指引可进入 Context Epoch；工具能力与模型身份必须在当前 turn 重新生成。
export const ACTION_GUIDANCE = `# Doing tasks
The user will primarily request software engineering tasks, including fixing bugs, adding functionality, refactoring, and explaining code.
- Read relevant files and understand the existing code before proposing changes.
- Plan and break down non-trivial work using the available task-management tools.
- Implement the minimal change that satisfies the request; avoid unrelated features or refactoring.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Do not add error handling or validation for scenarios ruled out by the codebase's guarantees.
- Do not create helpers or abstractions for one-time operations.
- Avoid command injection, XSS, SQL injection, and other security vulnerabilities; fix insecure code you introduce.
- Verify completion using relevant tests or checks. State explicitly when verification cannot run.
Tool results and user messages may include system-reminder tags. They contain system-added reminders and are not part of the tool output itself.

# Code References
When referencing specific functions or code, include file_path:line_number so the user can navigate to the source.

# Executing actions with care
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

// 输出效率指引作用于面向用户的文字，不截断代码样本或模型工具调用参数。
export const OUTPUT_GUIDANCE = `# Output efficiency
Go straight to the point. Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said — just do it. When explaining, include only what is necessary for the user to understand.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at key milestones (e.g. "build passing", "all tests green")
- Errors or blockers that change the plan

If you can say it in one sentence, do not use three. Do not narrate each step or list every file you read. This does not apply to code or tool calls.`

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const proc = yield* AppProcess.Service
    // 使用 Core 的配置边界，避免 Core 运行时反向依赖 legacy RuntimeFlags。
    const disableGit = yield* Effect.gen(function* () {
      return yield* Config.boolean("OPENCODE_DISABLE_GIT").pipe(Config.withDefault(false))
    }).pipe(Effect.orDie)
    // 所有命令固定在当前 Location；只读查询不应触发 Git 的可选索引写锁。
    const run = (args: string[]) => proc.run(ChildProcess.make("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], {
      cwd: location.directory, extendEnv: true, stdin: "ignore",
    })).pipe(
      // 保留源补丁的字段级错误退化，同时忽略非零退出的错误输出。
      Effect.map((result) => result.exitCode === 0 ? result.stdout.toString("utf8") : ""),
      Effect.catch(() => Effect.succeed("")),
    )
    const gitContext = Effect.fn("SystemContextBuiltIns.git")(function* () {
      // 默认分支沿用源 Git 服务的本地判定顺序，不通过网络查询或改写 remote。
      const defaultBranch = Effect.gen(function* () {
        const remotes = (yield* run(["remote"])).trim().split(/\r?\n/).filter(Boolean)
        // 多 remote 时保留 origin / 单 remote / upstream / 首个 remote 的源优先级。
        const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : remotes.includes("upstream") ? "upstream" : remotes[0]
        if (remote) {
          const head = (yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`])).trim()
          if (head.startsWith(`refs/remotes/${remote}/`)) return head.slice(`refs/remotes/${remote}/`.length)
        }
        // 没有 remote HEAD 的本地仓库仍可能有明确默认分支，不能一律降为 unknown。
        const branches = (yield* run(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).trim().split(/\r?\n/).filter(Boolean)
        const configured = (yield* run(["config", "init.defaultBranch"])).trim()
        if (configured && branches.includes(configured)) return configured
        return branches.includes("main") ? "main" : branches.includes("master") ? "master" : "unknown"
      })
      // 五个独立字段并行观察，使用同一 Location 的工作目录。
      const [branch, main, user, status, log] = yield* Effect.all([
        run(["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(Effect.map((text) => text.trim())),
        defaultBranch,
        run(["config", "user.name"]).pipe(Effect.map((text) => text.trim())),
        // NUL 格式保留含空格文件名与双列状态；关闭 rename 保持源补丁 Item 语义。
        run(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."]).pipe(
          Effect.map((text) => text.split("\0").filter(Boolean).join("\n")),
        ),
        // 限制日志条数而不是整块字符数，避免状态截断误伤最近提交。
        run(["log", "--oneline", "-n", "5"]).pipe(Effect.map((text) => text.trim())),
      ], { concurrency: 5 })
      // 与 V1 相同的 2000 字符边界，截断提示指出后续读取的是实时状态。
      const truncated = status.length > 2000 ? status.slice(0, 2000) + '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using the bash tool)' : status
      return [
        "<git>",
        // Git 是首次 Context 观察的快照，不能宣称已经在 Session 创建时执行命令。
        "  This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
        `  Current branch: ${branch || "(detached)"}`,
        `  Main branch (you will usually use this for PRs): ${main}`,
        // 无用户名省略整行，避免将空值解释成当前提交者身份。
        ...(user ? [`  Git user: ${user}`] : []),
        // 每行缩进，不让多行状态或日志脱离 Git 上下文块。
        ...`Status:\n${truncated || "(clean)"}`.split("\n").map((line) => `  ${line}`),
        ...`Recent commits:\n${log || "(no commits)"}`.split("\n").map((line) => `  ${line}`),
        "</git>",
      ].join("\n")
    })
    // 目录级首次采样与源补丁一致；缓存仅随既有 Location 层存活，不扩展通用 Source 协议。
    const snapshot = yield* Effect.cached(gitContext())
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      // OS 属于稳定环境事实，Shell 由 BashTool 的独立 typed source 观察。
      `  OS Version: ${os.type()} ${os.release()}`,
      // 目录不同只产生位置约束，不额外探测或宣称它一定是 Git worktree。
      ...(location.project.directory !== location.directory ? ["  Run ALL commands from the working directory; do NOT cd to the original repository root."] : []),
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      // 独立 key 让已有 core/environment 快照的 Session 也能接纳新增 Git source。
      // 禁用或非仓库时不注册详细 producer，environment 的 yes/no 仍完整保留。
      ...(disableGit || location.vcs?.type !== "git" ? [] : [SystemContext.make({
        key: SystemContext.Key.make("core/git"),
        codec: Schema.toCodecJson(Schema.String),
        // cached 返回延迟执行的 Effect，禁用或非仓库分支不会触发 Git。
        load: snapshot,
        baseline: (text) => text,
        update: (_previous, text) => text,
      })]),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
      // 独立 source 接纳稳定指引，已有 environment/Git 快照无需被整体替换或重采样。
      SystemContext.make({
        key: SystemContext.Key.make("core/action-guidance"),
        // 字符串 codec 让提示版本变化可被既有 reconcile 精确比较，而非覆盖默认 agent。
        codec: Schema.toCodecJson(Schema.String),
        // 两个完整 literal 一起接纳；没有重复注册 environment 或重新采集 Git 的捷径。
        load: Effect.succeed([ACTION_GUIDANCE, OUTPUT_GUIDANCE].join("\n\n")),
        baseline: (text) => text,
        update: (_previous, text) => text,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  // 进程能力由既有 Core 服务提供，producer 仍保持 Location-scoped 注册和释放。
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node, AppProcess.node],
})

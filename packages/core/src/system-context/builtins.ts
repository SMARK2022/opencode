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

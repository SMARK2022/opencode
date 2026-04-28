import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Clock, Effect, Layer, PlatformError } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Shell } from "@opencode-ai/core/shell"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { BashDiagnosticCollector, compressVisibleOutput, renderDiagnosticAppendix } from "@opencode-ai/core/tool/bash-compress"
import { Global } from "@opencode-ai/core/global"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly args?: readonly string[]
  readonly env?: ChildProcess.CommandOptions["env"]
  readonly extendEnv?: boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: AppProcess.AppProcessError | undefined
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        // 显式PowerShell argv也记录原命令和实际可执行文件，同时保留完整argv供启动边界断言。
        // 在既有 process 观察边界记录真正交给 spawner 的环境，不重复执行命令。
        runs.push({ command: command.args.at(-1) ?? command.command, cwd: command.options.cwd, shell: command.options.shell === false ? command.command : command.options.shell,
          args: command.args, env: command.options.env, extendEnv: command.options.extendEnv, options })
        // 原有 process 替身必须履行新的观察回调契约，不能让 settlement 测试得到空原文。
        return (options?.onOutput ? options.onOutput(result.output ?? result.stdout) : Effect.void).pipe(
            Effect.andThen(runFailure ? Effect.fail(runFailure) : Effect.succeed(result)),
          )
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  denyAction = undefined
  runFailure = undefined
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
  shell?: string,
  compression?: boolean,
  filesystem: Layer.Layer<FSUtil.Service> = LayerNode.compile(FSUtil.node),
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        // 显式导出 Bash 依赖的同一 registry，测试 body 不能读取另建实例。
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node, SystemContextRegistry.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, processLayer],
          // 显式 Config 文档驱动真实 selectedShell，不改测试进程的 SHELL 或 platform。
          [Config.node, shell === undefined && compression === undefined ? config : Layer.succeed(Config.Service, Config.Service.of({
            entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({
              shell,
              tool_output: compression === undefined ? undefined : new ConfigToolOutput.Info({ bash_compression: compression }),
            }) })]),
          }))],
          // 托管日志放在本测试的临时目录，验证恢复后由 fixture 清理，不污染用户数据。
          [Global.node, Global.layerWith({ data: directory })],
          [FSUtil.node, filesystem],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            // 描述字段只记录调用意图，旧调用不提供它仍然合法。
            expect(definitions[0]?.inputSchema).toHaveProperty("properties.description")
            expect(definitions[0]?.inputSchema).toHaveProperty("required", ["command"])
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.output")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.command")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            // 真实 settlement 接纳说明字段，但授权与进程仍只收到原始 pwd 命令。
            expect(yield* settleTool(registry, call({ command: "pwd", description: "Shows the current working directory" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                  // 保留原有精确 settlement 断言，同时验证新增统计真的进入 transcript。
                  compression: expect.objectContaining({ compressed: false }),
                  durationMs: expect.any(Number),
                  diagnosticErrorLikeLines: 0,
                  diagnosticWarningLikeLines: 0,
                  diagnosticDiscardedChars: 0,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            // 检查真正交给进程边界的选择，不能只验证system里显示了哪个shell。
            expect(runs[0]?.shell).toBe(Shell.acceptable())
            expect(runs[0]?.options).toMatchObject({
              combineOutput: true,
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
            // 真实 leaf 的环境必须继承宿主，四项 Windows 覆盖与已有 options 精确对应。
            expect(runs[0]?.extendEnv).toBe(true)
            expect(runs[0]?.env).toEqual(process.platform === "win32" ? {
              PYTHONIOENCODING: "utf-8",
              PYTHONUTF8: "1",
              JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ""} -Dfile.encoding=UTF-8`.trim(),
              RUBYOPT: `${process.env.RUBYOPT || ""} -Eutf-8`.trim(),
            } : {})
            expect(runs).toHaveLength(1)
            // 真正 BashTool 节点注册的 typed source 必须描述实际进程选择，不只测试 formatter。
            const contexts = yield* SystemContextRegistry.Service
            const initialized = yield* SystemContext.initialize(yield* contexts.load())
            expect(initialized.baseline).toContain(`Shell: ${runs[0]?.shell}`)
            expect(initialized.baseline).toContain("captured output is decoded as UTF-8")
            // 完整政策只统一checkout换行，授权条件仍在真实BashTool的baseline上逐句核对。
            expect(initialized.baseline.replaceAll("\r\n", "\n")).toContain([
              // HEAD 作者与未推送状态是两个独立条件；完整 oracle 不能只留下“需显式请求”的摘要。
              "# Git repository state changes", "",
              "<!-- 授权对应操作类型并持续到撤回；后续调试消息不会自动授予写权限，也不会自动撤销既有授权。 -->",
              "Read-only git inspection commands are allowed when needed, such as `git status`, `git diff`, `git log`, `git show`, `git branch --show-current`, `git rev-parse`, and `git remote -v`.", "",
              "Do not run git commands that modify refs, history, the index, the working tree, stashes, or remotes",
              "unless a verbatim user message has requested that kind of operation for the current task; that authorization remains valid unless the last user message withdraws it.",
              "This includes `git add`, `git commit`, `git merge`, `git rebase`, `git cherry-pick`, `git revert`,",
              "`git pull`, `git push`, `git checkout`, `git switch`, `git restore`, `git reset`, `git clean`,",
              "and `git stash push/pop/apply/drop/clear`.",
              "Debugging, fixing tests, syncing a branch, resolving a blocker, or make-it-work is not authorization for these commands.",
              "If such an operation seems necessary, explain why and ask first.", "",
              "<!-- 三项 amend 前提共同成立才可执行；hook 拒绝仍要求新提交，不能用 amend 绕过失败记录。 -->",
              "# Git Safety Protocol",
              "- NEVER update the git config",
              "- NEVER run destructive/irreversible git commands (force push, hard reset, etc) unless the user explicitly requests them",
              "- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it",
              "- NEVER run force push to main/master; warn the user if they request it",
              "- Avoid git commit --amend. ONLY use --amend when ALL conditions are met:",
              "  (1) User explicitly requested amend",
              "  (2) HEAD commit was created by you in this conversation (verify: git log -1 --format='%an %ae')",
              '  (3) Commit has NOT been pushed to remote (verify: git status shows "Your branch is ahead")',
              "- CRITICAL: If commit FAILED or was REJECTED by hook, NEVER amend - fix the issue and create a NEW commit",
              "- CRITICAL: If you already pushed to remote, NEVER amend unless user explicitly requests it (requires force push)",
              "- NEVER commit changes unless the user explicitly asks you to.",
              "  Prior approval to make code changes, debug, test, or inspect git status is not approval to commit.", "",
              "<!-- commit 和 push 是独立授权；提交准备必须检查完整状态，不能把 stage 或测试成功视为可推送。 -->",
              "# Committing changes with git",
              "Only create commits when requested by the user. If unclear, ask first.",
              "- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.",
              "- Write a concise commit message that matches the repo style.",
              "- Do not use interactive `-i` or create empty commits unless explicitly requested.",
              "- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.", "",
              "# GitHub",
              "- Only push or create PRs when explicitly requested by the user.",
              "- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.",
              "- Review all commits included in the PR, not just the latest commit.",
              "- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.",
            ].join("\n"))
            // description 不再承载第二份政策；调用权仍来自 PermissionV2，提示文本不能授予执行权限。
            expect(definitions[0]?.description).not.toContain("# Git repository state changes")
            // 同一配置 refresh 不重复注入，保留既有 Context Epoch 的比较边界。
            expect(yield* SystemContext.reconcile(yield* contexts.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
            expect(definitions[0]?.description).toContain("Use workdir instead of changing directories")
            // 防止通用shell选项重新启用用户profile，直接检查实际单次命令的argv。
            if (process.platform === "win32" && Shell.ps(Shell.acceptable()))
              expect(runs[0]?.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "pwd"])
          }),
        )
          .pipe(Effect.andThen(() => Effect.gen(function* () {
            if (process.platform !== "win32") return
            for (const shell of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
              const cmd = shell === "cmd.exe"
              // 全部源分支走实际 registry settlement；路径参数故意在工作目录之外。
              yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
                const blocked = [
                  ...["tail", "head", "sed", "awk", "grep.exe"].map((name) => `${name} missing`),
                  cmd ? "ls" : "find .",
                  cmd ? '"HEAD.EXE" missing' : '& "HEAD.EXE" missing',
                  cmd ? 'call "grep.exe" missing' : ". 'grep.exe' missing",
                  cmd ? "@g^rep.exe missing" : "gre`p.exe missing",
                  cmd ? "echo ok&head missing" : "Write-Output ok;head missing",
                  // cmd 命令组与 PowerShell 条件块都应在授权前拒绝内部 Unix 命令。
                  ...(cmd ? ["(head)", "(head -n 1 missing)", "echo ok && (head -n 1 missing)"] : ["Write-Output ok; if ($?) { head -n 1 missing }"]),
                  "echo ok&&grep.exe missing",
                  "echo ok|awk missing",
                  "echo ok||sed missing",
                  "echo ok\ntail missing",
                ]
                for (const command of blocked) {
                  reset()
                  const settled = yield* settleTool(registry, call({ command, workdir: path.dirname(tmp.path) }))
                  expect(settled.result).toMatchObject({ type: "error", value: expect.stringMatching(/Unix utility|instead of ls|ambiguous/) })
                  // 同时证明 external_directory 与 bash 权限均未请求，进程边界也未调用。
                  expect(assertions).toEqual([])
                  expect(runs).toEqual([])
                }
                // PowerShell 递归检查命令节点；引号内的脚本文本仍然只是参数。
                const allowed = cmd ? ["echo head grep", 'echo "head&grep.exe"', "echo head^&grep.exe", "find needle input", '" head" missing'] : [
                  "Write-Output head grep", "Write-Output 'head;grep.exe'", 'Write-Output "head|grep.exe"',
                  "Write-Output 'if ($true) { head -n 1 missing }'",
                  "Write-Output head`;grep.exe", "Write-Output 'it''s head; grep'", "'head'", "ls",
                  "g`rep.exe missing",
                  "& ' head' missing",
                ]
                if (cmd) allowed.push(
                  // 显式路径即使basename是head也不属于源guard裸名范围，仍走实际授权。
                  '"C:\\tools with spaces\\HEAD.EXE" missing', 'call "C:\\tools with spaces\\grep.exe" missing', '.\\head.exe missing',
                )
                if (!cmd) allowed.push('& "C:\\tools with spaces\\HEAD.EXE" missing', ". 'C:\\tools with spaces\\grep.exe' missing", '.\\head.exe missing')
                for (const command of allowed) {
                  reset()
                  expect((yield* settleTool(registry, call({ command }))).result.type).toBe("content")
                  expect(assertions).toMatchObject([{ action: "bash", resources: [command] }])
                  expect(runs).toMatchObject([{ command, shell: Shell.acceptable(shell) }])
                }
              }), appProcess, shell)
            }
            // 配置 Git Bash 仍执行原 Unix 命令，不能把 Windows OS 当成 Windows shell。
            reset()
            // Shell选择器验证路径存在；使用临时文件和既有进程替身，不依赖主机Git安装位置或启动该文件。
            const gitBash = path.join(tmp.path, "Git with spaces", "bin", "bash.exe")
            yield* Effect.promise(() => fs.mkdir(path.dirname(gitBash), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(gitBash, "fixture executable is never invoked"))
            yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
              const command = "head input | grep needle; ls; find ."
              expect((yield* settleTool(registry, call({ command }))).result.type).toBe("content")
              expect(assertions).toMatchObject([{ action: "bash", resources: [command] }])
              expect(runs).toMatchObject([{ command, shell: gitBash }])
            }), appProcess, gitBash)
          })))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "Command exited with code 0." },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, outputTruncated: true }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, output: Buffer.from("ready\n") }
        runFailure = new AppProcess.AppProcessError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const text = settled.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? ""
              expect(text).toContain("ready\n")
              expect(text).toContain("Command exceeded timeout of 10 ms")
              expect(text).toContain("Retry with a larger timeout")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
              // 模型正文与唯一恢复文件同时保留已发生输出，不能只返回timeout标志。
              expect(settled.outputPaths).toHaveLength(1)
              const retained = settled.outputPaths?.[0]
              if (!retained) throw new Error("expected retained timeout output")
              expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe("ready\n")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("retains raw Bash output through canonical settlement and bounds diagnostic frames", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        // 同一测试观察真实 chunk、CRLF 跨块和末帧收尾，不用复制分帧算法当 oracle。
        const executable = `${Shell.ps(Shell.acceptable()) ? "& " : ""}"${process.execPath}"`
        const diag = new BashDiagnosticCollector()
        for (let i = 0; i < 100; i++) diag.push("x".repeat(8192))
        diag.push("\r")
        diag.push("\nerror: split")
        diag.push(" diagnostic\rprogress\rfinal")
        diag.end()
        const snapshot = diag.snapshot()
        expect(snapshot.totalLines).toBe(4)
        expect(snapshot.errorLikeLines).toBe(1)
        expect(snapshot.discardedChars).toBe(819200 - 4096)
        expect(snapshot.truncatedFrames).toBe(1)
        expect(snapshot.contexts.flatMap((context) => context.lines).every((line) => line.text.length < 4200)).toBe(true)
        expect(renderDiagnosticAppendix(snapshot, { durationMs: 3000, exitCode: 1, visibleOutput: "" })).toContain("diagnostic sampling omitted")
        // 无其他变换命中且收益被拒绝时，凭据掩码仍必须提交。
        const secret = "sk-abcdefghijklmnopqrstuvwxyz012345"
        const sensitive = `error: ${secret}`
        const masked = compressVisibleOutput(sensitive, { enabled: true, minSavedBytes: 100000 })
        expect(masked.text).toBe("error: <REDACTED_API-KEY>")
        expect(masked.stats).toMatchObject({ applied: false, secretsRedacted: 1 })
        expect(masked.stats.compressedBytes).toBe(Buffer.byteLength(masked.text))
        expect(compressVisibleOutput(sensitive, { enabled: false }).text).toBe(sensitive)
        // 普通跨LF凭据在正文、snapshot与附录都必须缺席，原文只由已有capture归档。
        const credential = "abcdefghijklmnop"
        const crossline = `password:\n${credential} ERROR: rejected`
        const crossMasked = compressVisibleOutput(crossline)
        expect(crossMasked.text).toBe("\n<REDACTED_CREDENTIAL> ERROR: rejected")
        expect(crossMasked.stats).toMatchObject({ applied: false, secretsRedacted: 1, originalBytes: Buffer.byteLength(crossline), compressedBytes: Buffer.byteLength(crossMasked.text) })
        expect(crossMasked.stats.savedBytes).toBe(Buffer.byteLength(crossline) - Buffer.byteLength(crossMasked.text))
        expect(compressVisibleOutput(crossline, { enabled: false }).text).toBe(crossline)
        const crossDiagnostic = new BashDiagnosticCollector()
        crossDiagnostic.push("password:\n")
        crossDiagnostic.push(`${credential} ERROR: rejected`)
        crossDiagnostic.end()
        const crossSnapshot = crossDiagnostic.snapshot()
        expect(JSON.stringify(crossSnapshot)).not.toContain(credential)
        const crossAppendix = renderDiagnosticAppendix(crossSnapshot, { durationMs: 3000, exitCode: 1, visibleOutput: "" })
        expect(crossAppendix).toContain("> 2 | <REDACTED_CREDENTIAL> ERROR: rejected")
        expect(crossAppendix).not.toContain(credential)
        expect(renderDiagnosticAppendix(crossSnapshot, { durationMs: 3000, exitCode: 1, visibleOutput: crossMasked.text })).toBe("")
        // 半径0与多个空白帧使标签完全离开邻域，续接仍受同一个canonical字段/长度门槛约束。
        for (const label of ["password:", "passwd=", "pwd:", "secret=", "token:", "key=", "api_key:", "api-key=", "apikey:", "password\n:", "api_key\n ="]) {
          const outside = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
          outside.push(`${label}\n${" ".repeat(8192)}\n\n \n\t\n\n`)
          outside.push(`${credential} ERROR: rejected`)
          outside.end()
          expect(JSON.stringify(outside.snapshot())).not.toContain(credential)
          expect(compressVisibleOutput(`${label}\n${credential} ERROR: rejected`).text).not.toContain(credential)
          expect(renderDiagnosticAppendix(outside.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "" })).toContain("<REDACTED_CREDENTIAL> ERROR: rejected")
        }
        // 非秘密字段与首个短值终止续接，不能把随后无标签的普通输出误作凭据。
        const cleared = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        cleared.push(`password:\nshort\n${credential} ERROR: public value\nunknown:\n${credential} ERROR: ordinary`)
        cleared.end()
        expect(renderDiagnosticAppendix(cleared.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "" })).toContain(`${credential} ERROR: ordinary`)
        // 超过长度预筛但没有重复或高熵命中，同样不能回退到原秘密。
        const plain = sensitive + "\n" + "ordinary output without repeated patterns ".repeat(6)
        expect(compressVisibleOutput(plain, { enabled: true, minSavedBytes: 100000 }).text).not.toContain(secret)
        const burst = new BashDiagnosticCollector({ diagnosticContextRadius: 6 })
        const burstRaw = Array.from({ length: 12 }, (_, i) => `error: burst-${i + 1}${i === 0 ? " " + secret : ""}\n`).join("")
        burst.push(burstRaw)
        burst.end()
        const early = burst.snapshot()
        // 大半径使第四个错误早于第一条封存，oracle 直接指定准入帧 1/2/3。
        expect(early.firstErrorContexts.flatMap((ctx) => ctx.lines).map((line) => line.text).join("\n")).toContain("burst-1")
        expect(early.firstErrorContexts[0]?.priority).toBe("first")
        expect(early.firstErrorContexts[0]?.centerLine).toBe(3)
        expect(burst.snapshot()).toEqual(early)
        const excerpt = renderDiagnosticAppendix(early, { durationMs: 3000, exitCode: 1, visibleOutput: "" })
        expect(excerpt).toContain("root cause")
        expect(excerpt).toContain("<REDACTED_API-KEY>")
        expect(excerpt).not.toContain(secret)
        // 末中心可见不代表first/recent整块可见；全部掩码中心可见时不重复附录。
        const latestVisible = renderDiagnosticAppendix(early, { durationMs: 3000, exitCode: 1, visibleOutput: "error: burst-12" })
        expect(latestVisible).toContain("error: burst-1 <REDACTED_API-KEY>")
        expect(latestVisible).toContain("error: burst-2")
        expect(latestVisible).toContain("> 8 | error: burst-8")
        expect(renderDiagnosticAppendix(early, { durationMs: 3000, exitCode: 1, visibleOutput: burstRaw.replace(secret, "<REDACTED_API-KEY>") })).toBe("")
        // 三条邻接错误与末帧无LF精确复现V1 tail只剩C的输入，oracle直接指定A/B。
        const adjacent = new BashDiagnosticCollector()
        const adjacentRaw = "error: root A\nerror: follow B\nerror: end C"
        adjacent.push(adjacentRaw)
        adjacent.end()
        const roots = renderDiagnosticAppendix(adjacent.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "error: end C" })
        expect(roots).toContain("> 1 | error: root A")
        expect(roots).toContain("> 2 | error: follow B")
        expect(roots).toContain("(root cause)")
        expect(renderDiagnosticAppendix(adjacent.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: adjacentRaw })).toBe("")
        // snapshot 样例也已掩码，未经过 renderer 的调用方没有原文秘密副本。
        expect(JSON.stringify(early)).not.toContain(secret)
        const first = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        first.push(Array.from({ length: 20 }, (_, i) => `error: ${i + 1}\n`).join(""))
        first.end()
        expect(first.snapshot().firstErrorContexts.map((ctx) => ctx.centerLine)).toEqual([3])
        const one = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        one.push(sensitive)
        one.end()
        // 可见性比较使用同一掩码，不能因 raw 与正文不同而重复附录。
        expect(renderDiagnosticAppendix(one.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: masked.text })).toBe("")
        const entropy = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(16)
        expect(compressVisibleOutput(entropy).text).toContain("high-entropy base64 omitted: 1024 bytes")
        expect(compressVisibleOutput(entropy).stats.highEntropyLines).toBe(1)
        const template = Array.from({ length: 20 }, (_, i) => `12:00:${String(i).padStart(2, "0")} worker completed a substantial ordinary task`).join("\n")
        expect(compressVisibleOutput(template).stats.templateGroups).toBe(1)
        expect(compressVisibleOutput(template, { templateNormalizationLevel: "off" }).stats.templateGroups).toBe(0)
        // 哈希碰撞 Aa/BB 的原文不同，不能合并成重复块。
        const collision = ["Aa".repeat(100), "BB".repeat(100), "Aa".repeat(100), "Aa".repeat(100)].join("\n")
        expect(compressVisibleOutput(collision, { minSavedBytes: 0, minSavingRatio: 0 }).stats.repeatedBlockGroups).toBe(0)
        // 私钥 body 的错误没有 BEGIN 邻域，状态掩码仍覆盖它并保留 fatal 队列。
        const privateKey = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        privateKey.push("-----BEGIN PRIVATE KEY-----\nerror: hidden-private-body\n-----END PRIVATE KEY-----\npanic: visible-fatal\n")
        privateKey.end()
        expect(JSON.stringify(privateKey.snapshot())).not.toContain("hidden-private-body")
        expect(privateKey.snapshot().fatalContexts[0]?.priority).toBe("fatal")
        expect(compressVisibleOutput("#".repeat(500)).text).toContain("[bar ")
        const list = Array.from({ length: 100 }, (_, i) => `item-${i}-with-long-name`).join(", ")
        expect(compressVisibleOutput(list).text).toContain("... (94 more)")
        // CSI 清行之后保留终态，未达阈值/收益的编辑则原样通过。
        const terminal = Array.from({ length: 10 }, () => "working ".repeat(20) + "\r\x1b[2Kdone").join("\n")
        expect(compressVisibleOutput(terminal).text).toContain("terminal progress collapsed")
        expect(compressVisibleOutput(terminal, { minSavedBytes: 100000 }).text).toBe(terminal)
        // 归一化新拼出的秘密必须被掩码；独立oracle固定最终密钥与实际UTF-8统计。
        const decoratedSecret = ("noise ".repeat(100) + "\r\x1b[2K").repeat(4) + "sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345"
        const canonical = compressVisibleOutput(decoratedSecret)
        expect(canonical.text).toContain("<REDACTED_API-KEY>")
        expect(canonical.text).not.toContain(secret)
        expect(canonical.stats).toMatchObject({ applied: true, carriageReturnGroups: 1, secretsRedacted: 1 })
        expect(canonical.stats.originalBytes).toBe(Buffer.byteLength(decoratedSecret))
        expect(canonical.stats.compressedBytes).toBe(Buffer.byteLength(canonical.text))
        expect(canonical.stats.savedBytes).toBe(Buffer.byteLength(decoratedSecret) - Buffer.byteLength(canonical.text))
        // 未采用VT或未知CSI保留格式，canonical匹配仍能遮住ANSI分隔的原始凭据。
        expect(compressVisibleOutput(decoratedSecret, { minSavedBytes: 100000 }).text).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
        const unsupported = "\x1b[99qerror: sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345"
        expect(compressVisibleOutput(unsupported).text).toBe("\x1b[99qerror: <REDACTED_API-KEY>")
        const decoratedDiagnostic = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        decoratedDiagnostic.push("error: sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345\n")
        decoratedDiagnostic.end()
        const maskedAppendix = renderDiagnosticAppendix(decoratedDiagnostic.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "" })
        expect(maskedAppendix).toContain("<REDACTED_API-KEY>")
        expect(maskedAppendix).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
        expect(renderDiagnosticAppendix(decoratedDiagnostic.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "error: <REDACTED_API-KEY>" })).toBe("")
        const unhealthy = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        unhealthy.push("no errors\n0 failed\nall tests passed\nTS1234 compile problem\nENOENT missing\npanic with 0 errors\n")
        unhealthy.end()
        expect(unhealthy.snapshot()).toMatchObject({ errorLikeLines: 3, fatalLikeLines: 1 })
        // 交错编号与长成功日志保证adapter有净收益，FAILED必须准确归属于步骤2。
        const docker = ["#1 [prepare]", "#2 [compile]", "#3 [package]",
          ...Array.from({ length: 100 }, (_, i) => `#${i % 2 ? 3 : 1} 0.1 successful log ${i}: a substantial build operation completed`),
          "#2 0.2 DETAILS2", "#1 DONE", "#2 ERROR: compile failed", "#3 DONE"].join("\n")
        // 命令参数由真实 registry caller 传入；固定输出替身不安装四个外部工具。
        for (const [command, output, marker] of [
          ["npm install", Array.from({ length: 20 }, (_, i) => `WARN peer dep package-${i} ${"detail ".repeat(10)}`).join("\n"), "peer dependency warnings grouped"],
          ["pytest", "--- Captured stdout call ---\n" + Array.from({ length: 80 }, (_, i) => `captured ${i} ${"detail ".repeat(10)}`).join("\n"), "lines of captured output omitted"],
          ["docker build .", docker, "docker_build_summary"],
          ["tsc", Array.from({ length: 40 }, (_, i) => `file-${i}.ts(1,1): error TS1234: ${"detail ".repeat(10)}`).join("\n"), "tsc_diagnostics_summary"],
          ["redaction-only", sensitive, "<REDACTED_API-KEY>"],
          ["terminal-redaction", decoratedSecret, "<REDACTED_API-KEY>"],
          ["crossline-redaction", crossline, "<REDACTED_CREDENTIAL>"],
        ]) {
          // 禁用适配器或收益拒绝仍走同一入口，不用私有适配函数作为测试 oracle。
          if (command !== "redaction-only" && command !== "terminal-redaction" && command !== "crossline-redaction") {
            expect(compressVisibleOutput(output, { enableCommandAdapters: false }, command).text).not.toContain(marker)
            expect(compressVisibleOutput(output, { minSavedBytes: 100000 }, command).text).toBe(output)
          }
          reset()
          result = { ...result, output: Buffer.from(output) }
          yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
            const settled = yield* settleTool(registry, call({ command }))
            const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
            expect(text).toContain(marker)
            expect(text).not.toContain(secret)
            if (command === "crossline-redaction") expect(text).not.toContain(credential)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.command).toBe(command)
            if (command === "redaction-only" || command === "crossline-redaction") expect(settled.output?.structured).toMatchObject({ compression: { compressed: false, compressionSecretsRedacted: 1 } })
            if (command === "terminal-redaction") expect(settled.output?.structured).toMatchObject({ compression: { compressed: true, compressionSecretsRedacted: 1 } })
            if (command === "docker build .") {
              // 不用adapter计算预期值，直接指定步骤摘要与失败详情的归属。
              expect(text).toContain("#2 compile: FAILED")
              expect(text).toContain("#3 package: DONE")
              expect(text).not.toContain("#3 package: FAILED")
              expect(text).toContain('<docker_failed_step step="#2">\n#2 [compile]\n#2 0.2 DETAILS2\n#2 ERROR: compile failed\n</docker_failed_step>')
              expect(text).not.toContain('<docker_failed_step step="#3">')
              expect(settled.output?.structured).toMatchObject({ compression: { compressed: true } })
            }
            const retained = settled.outputPaths?.[0]
            if (!retained) throw new Error("expected retained raw output")
            expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(output)
            expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
          }))
        }
        // 收益针对原始窗口，false 与不合算候选都必须原样通过，不能误报节省。
        const raw = "repeat payload with meaningful width\n".repeat(400)
        const compressed = compressVisibleOutput(raw, { enabled: true })
        expect(compressed.stats.applied).toBe(true)
        expect(compressed.stats.savingRatio).toBe(compressed.stats.savedBytes / Buffer.byteLength(raw))
        expect(compressVisibleOutput(raw, { enabled: false }).text).toBe(raw)
        expect(compressVisibleOutput(raw, { enabled: true, minSavedBytes: Buffer.byteLength(raw) }).text).toBe(raw)
        // 长空白与低收益运行都须完整通过；规模足以暴露逐后缀重扫的平方退化。
        const compressionStarted = performance.now()
        for (const text of ["\n".repeat(100000), "repeat payload with meaningful width\n".repeat(20000)]) {
          const unchanged = compressVisibleOutput(text, { enabled: true, ...(text.trim() ? { minSavedBytes: Buffer.byteLength(text) } : {}) })
          expect(unchanged.text).toBe(text)
          expect(unchanged.stats).toMatchObject({ applied: false, originalBytes: Buffer.byteLength(text), compressedBytes: Buffer.byteLength(text), savedBytes: 0, savingRatio: 0, repeatedLineGroups: 0 })
          expect(compressVisibleOutput(text, { enabled: false }).text).toBe(text)
        }
        // 绝对收益和比例拒绝都须覆盖，不能只在全日志低于门槛时短路。
        const alternating = "alpha\nbeta\n".repeat(20000)
        for (const config of [{ minSavedBytes: 300000 }, { minSavingRatio: 1 }]) {
          const unchanged = compressVisibleOutput(alternating, { enabled: true, ...config })
          expect(unchanged.text).toBe(alternating)
          expect(unchanged.stats).toMatchObject({ applied: false, repeatedBlockGroups: 0, savedBytes: 0, savingRatio: 0 })
        }
        expect(compressVisibleOutput(alternating, { enabled: false }).text).toBe(alternating)
        // 拒绝前段后仍须逐起点找后段，不能消费整个未盈利周期而跳过新的候选。
        const lateBlock = "甲".repeat(100) + "\n" + "乙".repeat(100) + "\n"
        const mixed = alternating + "boundary\n" + lateBlock.repeat(1000)
        const late = compressVisibleOutput(mixed, { enabled: true, minSavedBytes: 300000 })
        expect(late.text).toBe(alternating + "boundary\n" + lateBlock.trimEnd() + "\n... [previous 2 lines repeated 999 more times]\n")
        expect(late.stats).toMatchObject({ applied: true, repeatedBlockGroups: 1, repeatedLineGroups: 0 })
        // UTF-8 与区间末尾 LF 的计量必须和实际输出吻合，不借字符数近似收益。
        expect(late.stats.originalBytes).toBe(Buffer.byteLength(mixed))
        expect(late.stats.compressedBytes).toBe(Buffer.byteLength(late.text))
        expect(late.stats.savedBytes).toBe(Buffer.byteLength(mixed) - Buffer.byteLength(late.text))
        expect(compressVisibleOutput(mixed, { enabled: false }).text).toBe(mixed)
        // 宽松五秒预算只筛灾难性回退，不比较机器速度或要求毫秒级基准成绩。
        expect(performance.now() - compressionStarted).toBeLessThan(5000)

        // 四种策略共享同一收益门槛；CR 的最终帧、块样例与 ANSI 边界都应保留。
        expect(compressVisibleOutput(("progress payload with enough width".repeat(3) + "\r").repeat(10)).stats.carriageReturnGroups).toBe(1)
        const block = "alpha".repeat(20) + "\n" + "beta".repeat(20) + "\n"
        expect(compressVisibleOutput(block.repeat(10)).stats.repeatedBlockGroups).toBeGreaterThan(0)
        expect(compressVisibleOutput("xy".repeat(500)).stats.inlinePatternGroups).toBe(1)
        const ansi = "\x1b[31m" + "a".repeat(400) + "\x1b[0m"
        expect(compressVisibleOutput(ansi).text).toBe(ansi)
        // 短成功命令不追加错误邻域，但采样遗漏仍可见；已可见的中心帧也不重复附录。
        expect(renderDiagnosticAppendix(snapshot, { durationMs: 1, exitCode: 0, visibleOutput: "" })).not.toContain("bash_high_signal_excerpt")
        expect(renderDiagnosticAppendix(snapshot, { durationMs: 3000, exitCode: 1, visibleOutput: "error: split diagnostic" })).not.toContain("bash_high_signal_excerpt")
        expect(compressed.stats.repeatedLineGroups).toBe(1)
        expect(compressed.stats.compressedBytes).toBe(Buffer.byteLength(compressed.text))
        // 三种覆盖都经过 Core Bash、AppProcess 和 registry/store，不能只测试纯转换器。
        for (const mode of ["default", "parameter", "config"] as const) {
          reset()
          const command = `${executable} -e "process.stdout.write('repeat payload with meaningful width\\n'.repeat(400))"`
          yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
            const settled = yield* settleTool(registry, call({ command, ...(mode === "parameter" ? { compress_output: false } : {}) }))
            expect(settled.output?.structured).toMatchObject({ compression: { compressed: mode === "default" }, truncated: false })
            const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
            if (mode === "default") {
              // 压缩成功但未截断仍向模型提供恢复路径，原文文件必须逐字节相同。
              expect(settled.outputPaths).toHaveLength(1)
              expect(text).toContain("raw output saved")
              const retained = settled.outputPaths?.[0]
              if (!retained) throw new Error("expected retained raw output")
              expect(text).toContain(retained)
              expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(raw)
            } else {
              expect(settled.outputPaths).toBeUndefined()
              expect(text).toContain(raw)
            }
          }), LayerNode.compile(AppProcess.node), undefined, mode === "config" ? false : undefined)
        }
        // 无 LF 的尾部超过 capture 上限，诊断仍看全流，磁盘原文不能只保存内存前缀。
        reset()
        const command = `${executable} -e "process.stdout.write('x'.repeat(${BashTool.MAX_CAPTURE_BYTES + 8192})+'RAW-END')"`
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command, compress_output: false }))
          expect(settled.output?.structured).toMatchObject({ truncated: true, diagnosticDiscardedChars: BashTool.MAX_CAPTURE_BYTES + 8192 + 7 - 4096 })
          expect(settled.outputPaths).toHaveLength(1)
          const retained = settled.outputPaths?.[0]
          if (!retained) throw new Error("expected retained capture")
          const saved = yield* Effect.promise(() => fs.readFile(retained, "utf8"))
          expect(saved.length).toBe(BashTool.MAX_CAPTURE_BYTES + 8192 + 7)
          expect(saved.endsWith("RAW-END")).toBe(true)
          const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
          expect(text).toContain("diagnostic sampling omitted")
          expect(text).toContain("RAW-END")
        }), LayerNode.compile(AppProcess.node))
        // 淘汰穿过中文多字节字符时仍保留最终普通结果，不以raw文件代替模型可见性。
        reset()
        const unicode = "中".repeat(Math.ceil(BashTool.MAX_CAPTURE_BYTES / 3) + 100) + "终结-END"
        const unicodeCommand = `${executable} -e "process.stdout.write('中'.repeat(${Math.ceil(BashTool.MAX_CAPTURE_BYTES / 3) + 100})+'终结-END')"`
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: unicodeCommand, compress_output: false }))
          const text = settled.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? ""
          expect(text).toContain("终结-END")
          expect(text).not.toContain("\ufffd")
          expect(settled.output?.structured).toMatchObject({ truncated: true })
          const retained = settled.outputPaths?.[0]
          if (!retained) throw new Error("expected retained UTF-8 output")
          expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(unicode)
        }), LayerNode.compile(AppProcess.node))
        // 滚动窗口仍进入原压缩器，最终构建结果和压缩收益必须同时可见。
        reset()
        const repeated = "repeat payload with meaningful width\n".repeat(40000) + "BUILD-COMPLETE\n"
        const repeatedCommand = `${executable} -e "process.stdout.write('repeat payload with meaningful width\\n'.repeat(40000)+'BUILD-COMPLETE\\n')"`
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: repeatedCommand }))
          const text = settled.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? ""
          expect(text).toContain("BUILD-COMPLETE")
          expect(settled.output?.structured).toMatchObject({ truncated: true, compression: { compressed: true } })
          const retained = settled.outputPaths?.[0]
          if (!retained) throw new Error("expected retained compressed tail")
          expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(repeated)
        }), LayerNode.compile(AppProcess.node))
        // 正文恰好占满字节预算，中间错误会被最终状态与恢复标记挤出 head/tail。
        reset()
        const rows = Array.from({ length: 600 }, (_, i) => `${i}: ${i === 300 ? "error: UNIQUE-MIDDLE-FAILURE" : "ordinary output"}`.padEnd(84, ".") + "\n").join("")
        const exact = rows + "z".repeat(ToolOutputStore.MAX_BYTES - Buffer.byteLength(rows))
        result = { ...result, exitCode: 1, output: Buffer.from(exact) }
        const clock = yield* Clock.Clock
        let now = 0
        // 只控制领域耗时，真实 capture/registry/store 仍执行，不睡眠两秒。
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: "diagnostic-budget", compress_output: false }))
          const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
          expect(text).toContain("error: UNIQUE-MIDDLE-FAILURE")
          expect(text).toContain("bash_high_signal_excerpt")
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
          expect(text.split("\n").length).toBeLessThanOrEqual(ToolOutputStore.MAX_LINES)
          expect(settled.output?.structured).toMatchObject({ diagnosticErrorLikeLines: 1, durationMs: 3000 })
          expect(runs).toHaveLength(1)
          const retained = settled.outputPaths?.[0]
          if (!retained) throw new Error("expected retained exact-budget output")
          expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(exact)
        })).pipe(Effect.provideService(Clock.Clock, {
          // ClockImpl 的方法在原型上，不能靠 spread 提供 tracer/计时器需要的完整接口。
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: Effect.sync(() => { now += 3000; return now }),
          // span 时间和 sleep 委托原实例，领域耗时覆盖不改变 runtime 的计时语义。
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        }))
        // 后续失败路径继续使用独立真实进程，不复用上述可控输出。
        reset()
        // 真实进程首次 append 失败必须结束为模型工具错误，不能重跑命令或升级为会话 defect。
        const failure = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "writeFile", description: "ENOSPC: quota exhausted" })
        let appends = 0
        const filesystem = Layer.effect(FSUtil.Service, Effect.gen(function* () {
          const native = yield* FSUtil.Service
          return FSUtil.Service.of({ ...native, writeFile: () => Effect.sync(() => appends++).pipe(Effect.andThen(Effect.fail(failure))) })
        })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        const observed: AppProcess.AppProcessError[] = []
        // 只观察既有 run 的 typed failure，底层进程与输出流仍由同一次 AppProcess.run 创建。
        const processLayer = Layer.effect(AppProcess.Service, Effect.gen(function* () {
          const appProcess = yield* AppProcess.Service
          return AppProcess.Service.of({ ...appProcess, run: (command, options) => appProcess.run(command, options).pipe(
            Effect.tapError((error) => Effect.sync(() => observed.push(error))),
          ) })
        })).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
        const failedCommand = `${executable} -e "process.stdout.write('x'.repeat(${ToolOutputStore.MAX_BYTES + 1}))"`
        // 前面已发布的日志仍属于恢复数据，失败收尾只删除本次未发布文件。
        const directory = path.join(tmp.path, ToolOutputStore.MANAGED_DIRECTORY)
        const retainedBefore = yield* Effect.promise(() => fs.readdir(directory))
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: failedCommand }, "call-append-failure"))
          expect(settled).toEqual({ result: { type: "error", value: `Unable to execute command: ${failedCommand}` } })
          expect(appends).toBe(1)
          expect(observed).toHaveLength(1)
          const storage = observed[0]?.cause
          if (!(storage instanceof ToolOutputStore.StorageError)) throw new Error("expected typed storage cause")
          expect(storage.operation).toBe("write")
          expect(storage.cause).toBe(failure)
          expect((yield* Effect.promise(() => fs.readdir(directory))).toSorted()).toEqual(retainedBefore.toSorted())
        }), processLayer, undefined, undefined, filesystem)
        // 托管目录被普通文件占用：不需要原文的小命令仍必须执行一次并成功。
        yield* Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (blocked) => Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(blocked.path, ToolOutputStore.MANAGED_DIRECTORY), "not a directory"))
          reset()
          result = { ...result, output: Buffer.from("ok\n") }
          yield* withTool(blocked.path, (registry) => Effect.gen(function* () {
            const settled = yield* settleTool(registry, call({ command: "echo ok", compress_output: false }))
            expect(settled.result.type).toBe("content")
            expect(settled.outputPaths).toBeUndefined()
            expect(settled.output?.content[0]).toEqual({ type: "text", text: "ok\n" })
            expect(runs).toHaveLength(1)
          }))
          // 同一坏目录下压缩与超阈值确实要求保留，必须显式失败而非内存兜底。
          for (const output of ["repeat payload with meaningful width\n".repeat(400), "x".repeat(ToolOutputStore.MAX_BYTES + 1)]) {
            reset()
            result = { ...result, output: Buffer.from(output) }
            yield* withTool(blocked.path, (registry) => Effect.gen(function* () {
              const settled = yield* settleTool(registry, call({ command: "retention-required" }))
              expect(settled.result.type).toBe("error")
              expect(runs).toHaveLength(1)
              expect(settled.outputPaths).toBeUndefined()
            }))
          }
          // 原有占位文件属于外部状态，capture 清理不能删除或替换它。
          expect(yield* Effect.promise(() => fs.readFile(path.join(blocked.path, ToolOutputStore.MANAGED_DIRECTORY), "utf8"))).toBe("not a directory")
        }), (blocked) => Effect.promise(() => blocked[Symbol.asyncDispose]()))
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    // 原文流写已由 capture/onOutput 完成；后台任务观察仍是上游待迁移能力。
    "Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})

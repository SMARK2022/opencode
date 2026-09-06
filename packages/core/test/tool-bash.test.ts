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
import type { TextEncodingMode } from "@opencode-ai/core/text-decoding"
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
  readonly executable: string
  readonly spawnShell?: string | boolean
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly args?: readonly string[]
  readonly env?: ChildProcess.CommandOptions["env"]
  readonly extendEnv?: boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let denyReason: string | undefined
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
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [], reason: denyReason })) : Effect.void,
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
        // 非Windows独立进程组是取消/超时隔离契约，不能为规避stdout竞态改成仅Linux。
        expect(command.options.detached).toBe(process.platform !== "win32")
        // 仅在测试观察边界解码传输包装；完整argv仍保留，真实编码由另一个实进程用例验证。
        const argument = command.args.at(-1)
        // 只观察外层脚本块中的原始命令；偏好行数和末尾流重定向不属于用户输入。
        const script = command.args.includes("-EncodedCommand") && argument !== undefined ? Buffer.from(argument, "base64").toString("utf16le") : undefined
        const original = script === undefined
          ? command.options.shell === false && Shell.name(command.command) === "cmd" ? (argument ?? "").slice(1, -1) : argument ?? command.command
          : script.slice(script.indexOf("& {\n") + 4, script.lastIndexOf("\n} "))
        runs.push({ command: original, executable: command.command, spawnShell: command.options.shell, cwd: command.options.cwd,
          shell: command.options.shell === false ? command.command : command.options.shell,
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
  denyReason = undefined
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
  encoding?: TextEncodingMode,
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
          [Config.node, shell === undefined && compression === undefined && encoding === undefined ? config : Layer.succeed(Config.Service, Config.Service.of({
            entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({
              shell,
              tool_output: compression === undefined && encoding === undefined ? undefined : new ConfigToolOutput.Info({
                bash_compression: compression, shell_encoding: encoding,
              }),
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
  it.live("sanitizes visible Bash controls while preserving captured raw bytes", () =>
    Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => {
      reset()
      const raw = Buffer.from("safe\u0007end\r\n\u001b[31mred\u001b[0m\n\t\u0085\u007f")
      result = { ...result, output: raw }
      return withTool(tmp.path, (registry) => Effect.gen(function* () {
        const settled = yield* settleTool(registry, call({ command: "echo ready", compress_output: false }))
        expect(settled.result.type).not.toBe("error")
        const visible = settled.output?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? ""
        // 独立oracle覆盖BEL、ANSI、CRLF、tab及C1/DEL，不从生产sanitizer计算期望。
        expect(visible).toContain("safe\\x07end\nred\n\t\\x85\\x7f")
        expect(visible).not.toContain("\u0007")
        expect(visible).not.toContain("\u001b")
        expect(visible).not.toContain("\r")
        const file = settled.outputPaths?.[0]
        if (!file) return yield* Effect.die("Expected retained raw output")
        expect(Buffer.from(yield* Effect.promise(() => Bun.file(file).arrayBuffer()))).toEqual(raw)
      }))
    }, (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())),
  )

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
            expect(definitions[0]?.description).toContain("Short harness markers")
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
                  hasErrors: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            // 审批原文与实际spawn分开核对，默认PowerShell仍由下方独立字节期望验证。
            expect(runs[0]?.executable).toBe(Shell.acceptable())
            expect(runs[0]?.spawnShell).toBe(false)
            if (!Shell.ps(Shell.acceptable())) expect(runs[0]?.args).toEqual(Shell.name(Shell.acceptable()) === "cmd" ? ["/d", "/s", "/c", '"pwd"'] : ["-c", "pwd"])
            // 检查真正交给进程边界的选择，不能只验证system里显示了哪个shell。
            expect(runs[0]?.shell).toBe(Shell.acceptable())
            expect(runs[0]?.options).toMatchObject({
              combineOutput: true,
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
            // extendEnv 保留用户显式 Java/Ruby 值，leaf 的两项覆盖不能重写它们。
            expect(runs[0]?.extendEnv).toBe(true)
            expect(runs[0]?.env).toEqual(process.platform === "win32" ? {
              PYTHONIOENCODING: "utf-8",
              PYTHONUTF8: "1",
            } : {})
            expect(runs).toHaveLength(1)
            // 真正 BashTool 节点注册的 typed source 必须描述实际进程选择，不只测试 formatter。
            const contexts = yield* SystemContextRegistry.Service
            const initialized = yield* SystemContext.initialize(yield* contexts.load())
            expect(initialized.baseline).toContain(`Shell: ${runs[0]?.shell}`)
            expect(initialized.baseline).toContain("captured output is decoded as UTF-8")
            if (Shell.ps(Shell.acceptable())) expect(initialized.baseline).toContain("Do not append `2>&1` to PowerShell commands; the shell tool already captures stderr.")
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
            // 独立字节预期同时约束无profile、UTF-8前导与原命令，不能只检查编码标志。
            if (process.platform === "win32" && Shell.ps(Shell.acceptable()))
              expect(runs[0]?.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand",
                Buffer.from(["[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)", "$OutputEncoding = [Console]::OutputEncoding", "$ProgressPreference = 'SilentlyContinue'", "$InformationPreference = 'Continue'", "$WarningPreference = 'Continue'", "$VerbosePreference = 'SilentlyContinue'", "$DebugPreference = 'SilentlyContinue'", "& {", "pwd", "} 3>&1 4>&1 5>&1 6>&1", "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }"].join("\n"), "utf16le").toString("base64")])
          }),
        )
          .pipe(Effect.andThen(() => Effect.gen(function* () {
            // 危险命令仅作为审批输入；在实际进程替身之前拒绝，复用两代同一AST投影。
            const bash = path.join(tmp.path, "bash.exe")
            yield* Effect.promise(() => fs.writeFile(bash, "fixture executable is never invoked"))
            yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
              for (const [command, canonical, raw] of [
                ["CI=true git push --force", ["git push --force"], ["CI=true git push --force"]],
                ["FOO=1 BAR=2 echo hello", ["echo hello"], ["FOO=1 BAR=2 echo hello"]],
                ["CI=true git log --oneline -5 > output.txt", ["git log --oneline -5 > output.txt"], ["CI=true git log --oneline -5 > output.txt"]],
                ["echo before && CI=true git push --force", ["echo before", "git push --force"], ["CI=true git push --force"]],
              ] as const) {
                reset()
                denyAction = "bash"
                expect((yield* settleTool(registry, call({ command }))).result.type).toBe("error")
                const request = assertions.find((request) => request.action === "bash")
                expect(request).toMatchObject({ resources: [command], save: [command], metadata: {
                  command, canonical_patterns: canonical, raw_patterns: raw,
                } })
                expect(runs).toEqual([])
              }
            }), appProcess, bash)
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
                  "Write-Output ok | grep ok",
                  // cmd 命令组与 PowerShell 条件块都应在授权前拒绝内部 Unix 命令。
                  ...(cmd ? ["(head)", "(head -n 1 missing)", "echo ok && (head -n 1 missing)"] : ["Write-Output ok; if ($?) { head -n 1 missing }"]),
                  "echo ok&&grep.exe missing",
                  "echo ok|awk missing",
                  "echo ok||sed missing",
                  "echo ok\ntail missing",
                ]
                // 归一后偏移不能遮住后续宿主黑名单命令；此夹具的进程边界始终是替身。
                if (!cmd) blocked.push('git checkout --;head missing', 'git checkout --;ssh host "head ignored";head missing')
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
                  // 复用 source 载荷；只有 AST、权限和既有进程替身参与，绝不执行远程命令。
                  "Write-Host before; wsl.exe -d Ubuntu-22.04 -- bash -lc 'set -euo pipefail; echo \"WSL $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2-)\"'",
                  "ssh example.com 'cat /etc/os-release | grep PRETTY_NAME'",
                ]
                if (cmd) allowed.push(
                  // 显式路径即使basename是head也不属于源guard裸名范围，仍走实际授权。
                  '"C:\\tools with spaces\\HEAD.EXE" missing', 'call "C:\\tools with spaces\\grep.exe" missing', '.\\head.exe missing',
                )
                if (!cmd) allowed.push('& "C:\\tools with spaces\\HEAD.EXE" missing', ". 'C:\\tools with spaces\\grep.exe' missing", '.\\head.exe missing',
                  // 每项继续走既有资源/argv断言，证明裸--修复没有改写真实执行或授权原文。
                  'git commit -m "x" -- a.ts', 'git log --oneline -2 -- path', 'git checkout --;git reset --hard',
                  'git commit -m "unclosed', 'git checkout --;ssh host "cat /etc/os-release | grep NAME";Write-Output done',
                  'git checkout --;Write-Output head`;grep.exe',
                )
                for (const command of allowed) {
                  reset()
                  expect((yield* settleTool(registry, call({ command }))).result.type).toBe("content")
                  expect(assertions).toMatchObject([{ action: "bash", resources: [command] }])
                  expect(runs).toMatchObject([{ command, shell: Shell.acceptable(shell) }])
                  // cmd与PowerShell保留同一审批原文，但进程入口必须都是显式executable。
                  expect(runs[0]?.executable).toBe(Shell.acceptable(shell))
                  expect(runs[0]?.spawnShell).toBe(false)
                  if (cmd) expect(runs[0]?.args).toEqual(["/d", "/s", "/c", `"${command}"`])
                  if (!cmd) expect(Buffer.from(runs[0]?.args?.at(-1) ?? "", "base64").toString("utf16le")).toContain(command)
                  // 原命令观察不代替spawn契约；PowerShell必须实际使用非交互的编码argv。
                  if (!cmd) expect(runs[0]?.args?.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"])
                }
                if (!cmd) {
                  reset()
                  const command = String.raw`python -c "print('{\"native\":1}')"`
                  const input = { command, workdir: path.dirname(tmp.path) }
                  // 真实leaf/registry配已有process替身，验证双门、执行串和typed输出而不运行Python。
                  const settled = yield* settleTool(registry, call(input))
                  expect(settled.result.type).toBe("content")
                  expect(settled.output?.structured).toMatchObject({ commandAdaptation: "powershell-inline-python-quoting-v1" })
                  expect(assertions.map((request) => request.action)).toEqual(["external_directory", "bash"])
                  for (const request of assertions) expect(request.metadata).toMatchObject({ command, inline_scripts: [`print('{"native":1}')`] })
                  expect(assertions[1]?.resources).toEqual([command])
                  expect(assertions[1]?.save).toEqual([command])
                  expect(runs).toHaveLength(1)
                  const encoded = runs[0]?.args?.at(-1)
                  if (!encoded) throw new Error("expected captured transport")
                  const script = Buffer.from(encoded, "base64").toString("utf16le")
                  expect(script).toContain("$PSNativeCommandArgumentPassing = 'Legacy'")
                  expect(script).not.toContain(command)
                  for (const action of ["external_directory", "bash"]) {
                    reset()
                    denyAction = action
                    expect((yield* settleTool(registry, call(input))).result.type).toBe("error")
                    expect(runs).toEqual([])
                  }
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
              expect(runs).toMatchObject([{ executable: gitBash, args: ["-c", command], spawnShell: false }])
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

  if (process.platform === "win32") {
    it.live("preserves PowerShell UTF-8, quotes, inherited env and exit through the real Core leaf", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.gen(function* () {
          const shells = [Bun.which("pwsh"), Bun.which("powershell")].filter((file): file is string => Boolean(file))
          expect(shells.length).toBeGreaterThan(0)
          for (const shell of shells) {
            reset()
            const command = [
              `Write-Output '桌面 大学文档 毕业设计 压缩感知 ''单引号'' "双引号"'`,
              `[pscustomobject]@{ Name = '中文表格' } | Format-Table -HideTableHeaders`,
              // stderr 直接经过 Console 编码；表格与 stdout 正确不能替代这条独立生产端检查。
              `[Console]::Error.Write("中文错误")`,
              `& '${process.execPath.replaceAll("'", "''")}' -e 'process.stdout.write(JSON.stringify([process.env.JAVA_TOOL_OPTIONS ?? null, process.env.RUBYOPT ?? null])); process.exit(7)' # 尾注释`,
            ].join("\n")
            // 走 registry、真实 AppProcess 和原始 request 授权，不把编码串当资源或重跑解码。
            yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
              const settled = yield* settleTool(registry, call({ command, compress_output: false }))
              // fixture 的 Bun 路径在临时 Location 外；完整匹配 advisory，不能省略警告或只检查退出码子串。
              const status = `Warnings:\n- Command argument references external directory ${path.join(path.dirname(process.execPath), "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.\n\nCommand exited with code 7.`
              if (settled.result.type !== "content") throw new Error("expected content")
              expect(settled.result.value).toHaveLength(3)
              const first = settled.result.value[0]
              const second = settled.result.value[1]
              if (first?.type !== "text" || second?.type !== "text") throw new Error("expected two text parts")
              const text = first.text
              const actualStatus = second.text
              // CRLF清理新增原文恢复段；前两段的正文/完整状态契约继续精确验证。
              const retained = settled.outputPaths?.[0]
              if (!retained) return yield* Effect.die("Expected retained original PowerShell output")
              expect(settled.result.value[2]).toEqual({ type: "text", text: `\n\n... output presentation changed; captured raw output saved to ${retained} ...` })
              const original = yield* Effect.promise(() => fs.readFile(retained, "utf8"))
              expect(original).toContain("\r\n")
              expect(text).not.toContain("\r")
              expect(settled.output?.structured, text).toMatchObject({ exit: 7 })
              expect(text).not.toContain("\uFFFD")
              // 仍逐字检查原授权警告与退出状态，只允许尾部增加本项耗时。
              expect(actualStatus.replace(/\n\n<opencode_notice [^\n]*\/>$/, "")).toBe(status)
              expect(actualStatus).toMatch(/\n\n<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="7" elapsed_ms="\d+" \/>$/)
              for (const expected of ["桌面 大学文档 毕业设计 压缩感知", "'单引号'", '"双引号"', "中文表格", "中文错误"]) {
                expect(text).toContain(expected)
              }
              // native 子进程回显实际继承值；仅检查 leaf 的覆盖键无法发现继承时追加的 Java/Ruby 参数。
              expect(text).toContain(JSON.stringify([process.env.JAVA_TOOL_OPTIONS ?? null, process.env.RUBYOPT ?? null]))
              expect(assertions).toMatchObject([{ action: "bash", resources: [command], save: [command] }])
              // native 的 7、纯 cmdlet 的 0 与显式 exit 9 区分透传、旧 LASTEXITCODE 泄漏和用户退出优先。
              expect((yield* settleTool(registry, call({ command: "Write-Output '中文'" }))).output?.structured).toMatchObject({ exit: 0 })
              expect((yield* settleTool(registry, call({ command: "Write-Output '中文'; exit 9" }))).output?.structured).toMatchObject({ exit: 9 })
            }), LayerNode.compile(AppProcess.node), shell)
            const raw = Buffer.from("warning: 默认分发: Ubuntu-22.04\r\n", "utf16le")
            const bytesCommand = `$bytes = [byte[]](${Array.from(raw)}); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)`
            yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
              const settled = yield* settleTool(registry, call({ command: bytesCommand, compress_output: false }))
              expect(settled.result.type).toBe("content")
              const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
              expect(text).toContain("warning: 默认分发: Ubuntu-22.04")
              expect(text).not.toContain("\u0000")
              expect(text).not.toContain("\uFFFD")
              expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false, diagnosticWarningLikeLines: 1 })
              const retained = settled.outputPaths?.[0]
              if (!retained) throw new Error("expected retained UTF-16LE output")
              expect(yield* Effect.promise(() => fs.readFile(retained))).toEqual(raw)
              expect(assertions.at(-1)).toMatchObject({ action: "bash", resources: [bytesCommand], save: [bytesCommand] })
            }), LayerNode.compile(AppProcess.node), shell)
            for (const encoding of ["auto", "gb18030", "utf-8"] as const) {
              const raw = Buffer.concat([Buffer.from("warning: "), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])])
              const bytesCommand = `$bytes = [byte[]](${Array.from(raw)}); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)`
              yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
                const settled = yield* settleTool(registry, call({ command: bytesCommand, compress_output: true }))
                const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
                expect(settled.result.type).toBe("content")
                expect(settled.output?.structured).toMatchObject({ exit: 0, diagnosticWarningLikeLines: 1, compression: { compressed: false } })
                if (encoding === "utf-8") {
                  expect(text).toContain("\uFFFD")
                  expect(text).not.toContain("中文")
                }
                if (encoding !== "utf-8") {
                  expect(text).toContain("中文")
                  expect(text).not.toContain("\uFFFD")
                }
                const retained = settled.outputPaths?.[0]
                if (!retained) throw new Error("expected retained codepage output")
                expect(yield* Effect.promise(() => fs.readFile(retained))).toEqual(raw)
                expect(assertions.at(-1)).toMatchObject({ action: "bash", resources: [bytesCommand], save: [bytesCommand] })
              }), LayerNode.compile(AppProcess.node), shell, false, undefined, encoding)
            }
            const rawError = Buffer.from([0xbe, 0xaf, 0xb8, 0xe6, 0x3a, 0x20, 0x44, 0x4f, 0x4d, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xd7, 0xa8, 0xd3, 0xc3, 0x20, 0x41, 0x50, 0x49, 0x0a])
            const errorCommand = `$bytes = [byte[]](${Array.from(rawError)}); [Console]::OpenStandardError().Write($bytes, 0, $bytes.Length)`
            yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
              const settled = yield* settleTool(registry, call({ command: errorCommand, compress_output: false }))
              const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
              expect(settled.result.type).toBe("content")
              expect(text).toContain("警告: DOM是内部专用 API")
              expect(text).not.toContain("\uFFFD")
              expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false, compression: { compressed: false } })
              const retained = settled.outputPaths?.[0]
              if (!retained) throw new Error("expected retained CP936 stderr")
              expect(yield* Effect.promise(() => fs.readFile(retained))).toEqual(rawError)
              expect(assertions.at(-1)).toMatchObject({ action: "bash", resources: [errorCommand], save: [errorCommand] })
            }), LayerNode.compile(AppProcess.node), shell)
            const rawClixml = Buffer.from('BEFORE\n#< CLIXML\n<Objs>\n<S N="Message">VISIBLE_MESSAGE</S>\n</Objs>\nAFTER\n')
            const clixmlCommand = `$bytes = [byte[]](${Array.from(rawClixml)}); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)`
            for (const mode of ["enabled", "parameter", "config"] as const) {
              yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
                const settled = yield* settleTool(registry, call({ command: clixmlCommand, compress_output: mode !== "parameter" }))
                const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
                expect(settled.result.type).toBe("content")
                expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false, compression: { compressed: false } })
                expect(text).toContain("BEFORE\nVISIBLE_MESSAGE\nAFTER\n")
                expect(text).not.toMatch(/<Obj\b|<Objs\b|CLIXML/)
                expect(text).not.toContain("high-entropy powershell-clixml")
                const retained = settled.outputPaths?.[0]
                if (!retained) throw new Error("expected retained original CLIXML")
                expect(yield* Effect.promise(() => fs.readFile(retained))).toEqual(rawClixml)
                expect(assertions.at(-1)).toMatchObject({ action: "bash", resources: [clixmlCommand], save: [clixmlCommand] })
              }), LayerNode.compile(AppProcess.node), shell, mode === "config" ? false : undefined, undefined, "auto")
            }
          }
        }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

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
          Effect.andThen(() => Effect.forEach([
            { command: "ssh example.com cat /etc/os-release", warning: false },
            { command: "wsl --exec cat /mnt/rescue/data.txt", warning: false },
            { command: `wsl --exec cat /mnt/rescue/data.txt & type "${outside.path}"`, warning: true },
          ], (item) => Effect.gen(function* () {
            reset()
            // 原始命令仍完整授权；仅路径提示排除客体片段。
            const settled = yield* withTool(active.path, (registry) => settleTool(registry, call({ command: item.command })))
            expect(assertions.map((request) => request.action)).toEqual(["bash"])
            expect(assertions[0]?.resources).toEqual([item.command])
            expect(runs).toHaveLength(1)
            expect(settled.output?.content.some((part) => part.type === "text" && part.text.includes("Warnings:"))).toBe(item.warning)
          }), { concurrency: 1 })),
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

          // 拒绝正文必须进入真实结算的模型结果，且不能因此执行进程。
          denyReason = "Automatic review rejected this operation. Do not retry through another tool."
          expect(yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))).toEqual({ type: "error", value: denyReason })
          denyAction = "external_directory"
          expect(yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: outside.path })))).toEqual({ type: "error", value: denyReason })
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
              const status = settled.output?.content[1]
              expect(status?.type === "text" ? status.text : "").toMatch(/reason="exit" exit_code="7" elapsed_ms="\d+"/)
              expect(JSON.stringify(settled.output?.content).match(/opencode_notice/g)).toHaveLength(1)
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
            Effect.gen(function* () {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
              // 两个命令只经过AppProcess替身；正文方向、统一限幅和原文恢复均走真实owner。
              const raw = "FIRST-LISTING\n" + "ordinary row\n".repeat(100_000) + "LAST-LISTING\n"
              for (const command of ["git status", "bun test"]) {
                reset()
                result = { ...result, exitCode: 7, output: Buffer.from(raw) }
                const output = yield* withTool(tmp.path, registry => settleTool(registry, call({ command, compress_output: false }, command)))
                const shown = output.output?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? ""
                expect(shown).toContain(command === "git status" ? "FIRST-LISTING" : "LAST-LISTING")
                expect(shown).not.toContain(command === "git status" ? "LAST-LISTING" : "FIRST-LISTING")
                expect(shown).toContain("Command exited with code 7")
                expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
                expect(output.output?.structured).toMatchObject({ hasErrors: command === "bun test" })
                const retained = output.outputPaths?.[0]
                if (!retained) return yield* Effect.die("Missing raw output")
                expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(raw)
              }
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
              expect(text).toContain('type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="10"')
              expect(text.match(/reason="timeout"/g)).toHaveLength(1)
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringMatching(/reason="timeout" timeout_ms="10" elapsed_ms="\d+"/),
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
              expect(text).not.toContain("block-buffering")
              result = { ...result, output: Buffer.alloc(0), stdout: Buffer.alloc(0) }
              const empty = yield* withTool(tmp.path, registry => settleTool(registry, call({ command: "sleep 60", timeout: 10 }, "empty-timeout")))
              const shown = empty.output?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? ""
              expect(shown).toContain("block-buffering")
              expect(shown).toContain("--verbose")
              expect(shown.match(/reason="timeout"/g)).toHaveLength(1)
              runFailure = undefined
              const normal = yield* withTool(tmp.path, registry => settleTool(registry, call({ command: "echo", timeout: 10 }, "normal-empty")))
              expect(JSON.stringify(normal.output?.content)).not.toContain("block-buffering")
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
        // 正文独立过200B闸门；收益被拒绝也保留脱敏，短正文边界由source纯用例单独锁定。
        const secret = "sk-abcdefghijklmnopqrstuvwxyz012345"
        const padding = "\n" + "context ".repeat(30) + "boundary"
        const sensitive = `error: ${secret}${padding}`
        const masked = compressVisibleOutput(sensitive, { enabled: true, minSavedBytes: 100000 })
        expect(masked.text).toBe("error: sk-abcd…[redacted api-key]" + padding)
        expect(masked.stats).toMatchObject({ applied: true, secretsRedacted: 1 })
        expect(masked.stats.compressedBytes).toBe(Buffer.byteLength(masked.text))
        expect(compressVisibleOutput(sensitive, { enabled: false }).text).toBe(sensitive)
        // 普通跨LF凭据在正文、snapshot与附录都必须缺席，原文只由已有capture归档。
        const credential = "abcdefghijklmnop"
        const crossline = `password:\n${credential} ERROR: rejected${padding}`
        const crossMasked = compressVisibleOutput(crossline)
        expect(crossMasked.text).toContain("password:\nabcdefg…[redacted] ERROR: rejected")
        expect(crossMasked.stats).toMatchObject({ applied: true, secretsRedacted: 1, originalBytes: Buffer.byteLength(crossline), compressedBytes: Buffer.byteLength(crossMasked.text) })
        expect(crossMasked.stats.savedBytes).toBe(Buffer.byteLength(crossline) - Buffer.byteLength(crossMasked.text))
        expect(compressVisibleOutput(crossline, { enabled: false }).text).toBe(crossline)
        const crossDiagnostic = new BashDiagnosticCollector()
        crossDiagnostic.push("password:\n")
        crossDiagnostic.push(`${credential} ERROR: rejected`)
        crossDiagnostic.end()
        const crossSnapshot = crossDiagnostic.snapshot()
        expect(JSON.stringify(crossSnapshot)).not.toContain(credential)
        const crossAppendix = renderDiagnosticAppendix(crossSnapshot, { durationMs: 3000, exitCode: 1 })
        expect(crossAppendix).toContain("> 2 | abcdefg…[redacted] ERROR: rejected")
        expect(crossAppendix).not.toContain(credential)
        // 隐藏快照直接渲染，显式可见窗口仍沿用相同掩码去重。
        expect(renderDiagnosticAppendix(crossSnapshot, { durationMs: 3000, exitCode: 1, visibleOutput: "" })).toBe(crossAppendix)
        expect(renderDiagnosticAppendix(crossSnapshot, { durationMs: 3000, exitCode: 1, visibleOutput: crossMasked.text })).toBe("")
        // 半径0与多个空白帧使标签完全离开邻域，续接仍受同一个canonical字段/长度门槛约束。
        for (const label of ["password:", "passwd=", "pwd:", "secret=", "token:", "key=", "api_key:", "api-key=", "apikey:", "password\n:", "api_key\n ="]) {
          const outside = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
          outside.push(`${label}\n${" ".repeat(8192)}\n\n \n\t\n\n`)
          outside.push(`${credential} ERROR: rejected`)
          outside.end()
          expect(JSON.stringify(outside.snapshot())).not.toContain(credential)
          expect(compressVisibleOutput(`${label}\n${credential} ERROR: rejected${padding}`).text).not.toContain(credential)
          expect(renderDiagnosticAppendix(outside.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "" })).toContain("abcdefg…[redacted] ERROR: rejected")
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
        expect(excerpt).toContain("root_cause")
        expect(excerpt).toContain("sk-abcd…[redacted api-key]")
        expect(excerpt).not.toContain(secret)
        // 末中心可见不代表first/recent整块可见；全部掩码中心可见时不重复附录。
        const latestVisible = renderDiagnosticAppendix(early, { durationMs: 3000, exitCode: 1, visibleOutput: "error: burst-12" })
        expect(latestVisible).toContain("error: burst-1 sk-abcd…[redacted api-key]")
        expect(latestVisible).toContain("error: burst-2")
        expect(latestVisible).toContain("> 8 | error: burst-8")
        expect(renderDiagnosticAppendix(early, { durationMs: 3000, exitCode: 1, visibleOutput: burstRaw.replace(secret, "sk-abcd…[redacted api-key]") })).toBe("")
        // 三条邻接错误与末帧无LF精确复现V1 tail只剩C的输入，oracle直接指定A/B。
        const adjacent = new BashDiagnosticCollector()
        const adjacentRaw = "error: root A\nerror: follow B\nerror: end C"
        adjacent.push(adjacentRaw)
        adjacent.end()
        const roots = renderDiagnosticAppendix(adjacent.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "error: end C" })
        expect(roots).toContain("> 1 | error: root A")
        expect(roots).toContain("> 2 | error: follow B")
        expect(roots).toContain("root_cause")
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
        expect(compressVisibleOutput(entropy).text).toContain("high-entropy base64 1024B")
        expect(compressVisibleOutput(entropy).stats.highEntropyLines).toBe(1)
        // CLIXML 解码仍走同一入口，覆盖脱敏、禁用、低收益与后续重复压缩。
        const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31merror: _x0073_k-abcdefghijklmnopqrstuvwxyz012345_x001B_[0m_x000D__x000A_</S><S S="Error">_x4E2D__x6587__x000D__x000A_</S></Objs>'.replace("</Objs>", `<S S="Output">${padding}</S></Objs>`)
        const decoded = compressVisibleOutput(clixml)
        expect(decoded.text).toContain("error: sk-abcd…[redacted api-key]\n中文")
        expect(decoded.stats).toMatchObject({ applied: true, highEntropyLines: 0, secretsRedacted: 1, originalBytes: Buffer.byteLength(clixml), compressedBytes: Buffer.byteLength(decoded.text) })
        expect(decoded.stats.savedBytes).toBe(Buffer.byteLength(clixml) - Buffer.byteLength(decoded.text))
        expect(decoded.stats.savingRatio).toBe(decoded.stats.savedBytes / Buffer.byteLength(clixml))
        expect(compressVisibleOutput(clixml, { enabled: false })).toMatchObject({ text: `error: ${secret}\n中文\n${padding}`, stats: { applied: false, highEntropyLines: 0, secretsRedacted: 0 } })
        expect(compressVisibleOutput(clixml, { minSavedBytes: 100000 }).text).toBe(`error: sk-abcd…[redacted api-key]\n中文\n${padding}`)
        // 纯解码独立于50%收益门槛，不冒充压缩或高熵省略。
        const ordinary = Array.from({ length: 20 }, (_, i) => `ordinary output row ${i}: task completed successfully`).join("\n")
        const ordinaryClixml = `<Objs Version="1.1.0.1"><S S="Output">${ordinary}</S></Objs>`
        const ordinaryDecoded = compressVisibleOutput(ordinaryClixml)
        expect(ordinaryDecoded.text).toBe(ordinary)
        expect(ordinaryDecoded.stats).toMatchObject({ applied: false, highEntropyLines: 0, secretsRedacted: 0 })
        expect(ordinaryDecoded.stats.savedBytes).toBe(Buffer.byteLength(ordinaryClixml) - Buffer.byteLength(ordinary))
        expect(ordinaryDecoded.stats.savingRatio).toBe(ordinaryDecoded.stats.savedBytes / Buffer.byteLength(ordinaryClixml))
        const clixmlRun = `<Objs><S S="Output">${"repeatable ordinary output_x000D__x000A_".repeat(20)}</S></Objs>`
        const repeatedClixml = compressVisibleOutput(clixmlRun)
        expect(repeatedClixml.stats).toMatchObject({ applied: true, highEntropyLines: 0, repeatedLineGroups: 1 })
        expect(repeatedClixml.text).toContain("[... same line 20x]")
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
        expect(compressVisibleOutput("#".repeat(500)).text).toContain("[... bar ")
        const list = Array.from({ length: 100 }, (_, i) => `item-${i}-with-long-name`).join(", ")
        expect(compressVisibleOutput(list).text).toContain("[... 94 more]")
        // CSI 清行之后保留终态，未达阈值/收益的编辑则原样通过。
        const terminal = Array.from({ length: 10 }, () => "working ".repeat(20) + "\r\x1b[2Kdone").join("\n")
        expect(compressVisibleOutput(terminal).text).toContain("[... progress")
        expect(compressVisibleOutput(terminal, { minSavedBytes: 100000 }).text).toBe(terminal)
        // 归一化新拼出的秘密必须被掩码；独立oracle固定最终密钥与实际UTF-8统计。
        const decoratedSecret = ("noise ".repeat(100) + "\r\x1b[2K").repeat(4) + "sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345"
        const canonical = compressVisibleOutput(decoratedSecret)
        expect(canonical.text).toContain("sk-abcd…[redacted api-key]")
        expect(canonical.text).not.toContain(secret)
        expect(canonical.stats).toMatchObject({ applied: true, carriageReturnGroups: 1, secretsRedacted: 1 })
        expect(canonical.stats.originalBytes).toBe(Buffer.byteLength(decoratedSecret))
        expect(canonical.stats.compressedBytes).toBe(Buffer.byteLength(canonical.text))
        expect(canonical.stats.savedBytes).toBe(Buffer.byteLength(decoratedSecret) - Buffer.byteLength(canonical.text))
        // 未采用VT或未知CSI保留格式，canonical匹配仍能遮住ANSI分隔的原始凭据。
        expect(compressVisibleOutput(decoratedSecret, { minSavedBytes: 100000 }).text).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
        const unsupported = "\x1b[99qerror: sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345" + padding
        expect(compressVisibleOutput(unsupported, { minSavedBytes: 100000 }).text).toBe("\x1b[99qerror: sk-abcd…[redacted api-key]" + padding)
        const decoratedDiagnostic = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        decoratedDiagnostic.push("error: sk-\x1b[0mabcdefghijklmnopqrstuvwxyz012345\n")
        decoratedDiagnostic.end()
        const maskedAppendix = renderDiagnosticAppendix(decoratedDiagnostic.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "" })
        expect(maskedAppendix).toContain("sk-abcd…[redacted api-key]")
        expect(maskedAppendix).not.toContain("abcdefghijklmnopqrstuvwxyz012345")
        expect(renderDiagnosticAppendix(decoratedDiagnostic.snapshot(), { durationMs: 3000, exitCode: 1, visibleOutput: "error: sk-abcd…[redacted api-key]" })).toBe("")
        const unhealthy = new BashDiagnosticCollector({ diagnosticContextRadius: 0 })
        unhealthy.push("no errors\n0 failed\nall tests passed\nTS1234 compile problem\nENOENT missing\npanic with 0 errors\n")
        unhealthy.end()
        expect(unhealthy.snapshot()).toMatchObject({ errorLikeLines: 3, fatalLikeLines: 1 })
        // 交错编号与长成功日志保证adapter有净收益，FAILED必须准确归属于步骤2。
        const docker = ["#1 [prepare]", "#2 [compile]", "#3 [package]",
          ...Array.from({ length: 100 }, (_, i) => `#${i % 2 ? 3 : 1} 0.1 successful log ${i}: a substantial build operation completed`),
          "#2 0.2 DETAILS2", "#1 DONE", "#2 ERROR: compile failed", "#3 DONE"].join("\n")
        // 命令参数由真实 registry caller 传入；固定输出替身不安装四个外部工具。
        // PowerShell 先还原 CLIXML，再进入通用压缩；其他 shell 仍保留 wrapped 路径。
        const plainClixml = process.platform === "win32" && Shell.ps(Shell.acceptable())
        for (const [command, output, marker] of [
          ["npm install", Array.from({ length: 20 }, (_, i) => `WARN peer dep package-${i} ${"detail ".repeat(10)}`).join("\n"), "peer dependency warnings grouped"],
          ["pytest", "--- Captured stdout call ---\n" + Array.from({ length: 80 }, (_, i) => `captured ${i} ${"detail ".repeat(10)}`).join("\n"), "lines of captured output omitted"],
          ["docker build .", docker, "docker_build_summary"],
          ["tsc", Array.from({ length: 40 }, (_, i) => `file-${i}.ts(1,1): error TS1234: ${"detail ".repeat(10)}`).join("\n"), "tsc_diagnostics_summary"],
          ["redaction-only", sensitive, "sk-abcd…[redacted api-key]"],
          ["terminal-redaction", decoratedSecret, "sk-abcd…[redacted api-key]"],
          ["crossline-redaction", crossline, "abcdefg…[redacted]"],
          ["clixml-low-savings", ordinaryClixml, plainClixml ? ordinary : ordinaryDecoded.text],
          ["clixml-expanding", '<Objs><S S="Output">ordinary</S></Objs>', "ordinary"],
        ]) {
          // 四种专用摘要按source退休；仍通过真实registry验证普通正文、单次执行与归档。
          const retired = ["npm install", "pytest", "docker build .", "tsc"].includes(command)
          if (retired) {
            expect(compressVisibleOutput(output).text).not.toContain(marker)
            expect(compressVisibleOutput(output, { minSavedBytes: 100000 }).text).toBe(output)
          }
          reset()
          result = { ...result, output: Buffer.from(output) }
          yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
            const settled = yield* settleTool(registry, call({ command }))
            const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
            if (retired) expect(text).not.toContain(marker)
            else expect(text).toContain(marker)
            expect(text).not.toContain(secret)
            if (command === "crossline-redaction") expect(text).not.toContain(credential)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.command).toBe(command)
            // 压缩仍按原脚本分类，不能因测试观察raw argv而换掉分类输入。
            expect(runs[0]?.spawnShell).toBe(false)
            if (Shell.ps(Shell.acceptable())) expect(Buffer.from(runs[0]?.args?.at(-1) ?? "", "base64").toString("utf16le")).toContain(command)
            else expect(runs[0]?.args).toEqual(Shell.name(Shell.acceptable()) === "cmd" ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command])
            if (command === "redaction-only" || command === "crossline-redaction") expect(settled.output?.structured).toMatchObject({ compression: { compressed: true, compressionSecretsRedacted: 1 } })
            if (command === "terminal-redaction") expect(settled.output?.structured).toMatchObject({ compression: { compressed: true, compressionSecretsRedacted: 1 } })
            if (command === "clixml-expanding") expect(settled.output?.structured).toMatchObject({ compression: { compressed: false, compressionHighEntropyLines: 0, compressionOriginalBytes: plainClixml ? 8 : 39, compressionCompressedBytes: 8, compressionSavedBytes: 0 } })
            if (command === "docker build .") {
              // 撤专用汇总后保留原失败编号与正文，不再合成步骤状态。
              expect(text).toContain("#2 [compile]")
              expect(text).toContain("#3 DONE")
              expect(text).not.toContain("#3 package: FAILED")
              expect(text).toContain("#2 0.2 DETAILS2")
              expect(text).toContain("#2 ERROR: compile failed")
              expect(text).not.toContain("<docker_failed_step")
            }
            const retained = settled.outputPaths?.[0]
            // 未改变呈现可不落盘；一旦压缩/解码改变呈现，原文必须可逐字恢复。
            if (retained) expect(yield* Effect.promise(() => fs.readFile(retained, "utf8"))).toBe(output)
            else expect(text).toContain(output)
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
        expect(late.text).toBe(alternating + "boundary\n" + lateBlock.trimEnd() + "\n[... repeated block 1000x, 2000L->2L]\n")
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
        expect(renderDiagnosticAppendix(snapshot, { durationMs: 1, exitCode: 0, visibleOutput: "" })).not.toContain("opencode_excerpt")
        expect(renderDiagnosticAppendix(snapshot, { durationMs: 3000, exitCode: 1, visibleOutput: "error: split diagnostic" })).not.toContain("opencode_excerpt")
        expect(compressed.stats.repeatedLineGroups).toBe(1)
        expect(compressed.stats.compressedBytes).toBe(Buffer.byteLength(compressed.text))
        // 三种覆盖都经过 Core Bash、AppProcess 和 registry/store，不能只测试纯转换器。
        for (const mode of ["default", "parameter", "config"] as const) {
          reset()
          const command = `${executable} -e "process.stdout.write('repeat payload with meaningful width\\n'.repeat(400))"`
          yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
            expect((yield* toolDefinitions(registry))[0]?.description.includes("Short harness markers")).toBe(mode !== "config")
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
        // 两个真实进程流均进入共享解码器，不能只用AppProcess替身证明CLI链路。
        reset()
        const stdoutClixml = '<Objs><S S="Output">actual-stdout</S></Objs>'
        const stderrClixml = '<Objs><S S="Error">actual-stderr</S></Objs>'
        const clixmlCommand = `${executable} -e "process.stdout.write(String.fromCharCode(${Array.from(stdoutClixml, (char) => char.charCodeAt(0)).join(",")}));process.stderr.write(String.fromCharCode(${Array.from(stderrClixml, (char) => char.charCodeAt(0)).join(",")}))"`
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: clixmlCommand }))
          const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
          expect(text).toContain("actual-stdout")
          expect(text).toContain("actual-stderr")
          // 普通CLIXML解码不属于高熵压缩，完整正文和raw仍分别验收。
          expect(settled.output?.structured).toMatchObject({ compression: { compressionHighEntropyLines: 0 } })
          const retained = settled.outputPaths?.[0]
          if (!retained) throw new Error("expected retained dual-stream CLIXML")
          const saved = yield* Effect.promise(() => fs.readFile(retained, "utf8"))
          expect(saved).toContain(stdoutClixml)
          expect(saved).toContain(stderrClixml)
        }), LayerNode.compile(AppProcess.node))
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
        // 每行连同换行固定85字节，使根因始终位于当前预算中部，最后再补齐不足一行的字节。
        const count = Math.floor(ToolOutputStore.MAX_BYTES / 85)
        const rows = Array.from({ length: count }, (_, i) => `${i}: ${i === Math.floor(count / 2) ? "error: UNIQUE-MIDDLE-FAILURE" : "ordinary output"}`.padEnd(84, ".") + "\n").join("")
        const exact = rows + "z".repeat(ToolOutputStore.MAX_BYTES - Buffer.byteLength(rows))
        expect(Buffer.byteLength(exact)).toBe(ToolOutputStore.MAX_BYTES)
        result = { ...result, exitCode: 1, output: Buffer.from(exact) }
        const clock = yield* Clock.Clock
        let now = 0
        // 只控制领域耗时，真实 capture/registry/store 仍执行，不睡眠两秒。
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const settled = yield* settleTool(registry, call({ command: "diagnostic-budget", compress_output: false }))
          const text = settled.output?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""
          expect(text).toContain("error: UNIQUE-MIDDLE-FAILURE")
          expect(text).toContain("opencode_excerpt")
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

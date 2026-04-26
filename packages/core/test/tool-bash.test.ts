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

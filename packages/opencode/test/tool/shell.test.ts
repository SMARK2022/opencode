import { formatShellExecutionNotice, formatLongExecutionNotice } from "../../src/util/output-notice"
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import * as fs from "node:fs/promises"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PermissionReviewer } from "@/permission/reviewer/service"
import { Permission as PermissionService } from "@/permission"
import { ToolProgress } from "@/tool/progress"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
)
let reviewedCalls = 0
const shellReviewerLayer = Layer.succeed(
  PermissionReviewer.Service,
  PermissionReviewer.Service.of({
    review: () =>
      Effect.sync(() => {
        reviewedCalls++
        return {
          action: "deny" as const,
          reason: "reviewer rejected sensitive shell access",
          reviewID: "review_shell_sensitive",
          risk_level: "high" as const,
          user_authorization: "unknown" as const,
        }
      }),
  }),
)
const permissionShellLayer = Layer.mergeAll(
  shellLayer,
  PermissionService.layer.pipe(Layer.provide(Bus.layer), Layer.provide(shellReviewerLayer)),
)
const it = testEffect(shellLayer)
const reviewed = testEffect(permissionShellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

// Windows 上默认 shell 是 pwsh（PowerShell 7），其 .NET 运行时冷启动 +
// 首条 echo 输出在 CI 上可达 600ms+。500ms timeout 会在 echo 输出到达管道前
// 触发，导致 result.output 不含 "started" 而间歇性失败。
// Windows 放宽到 3000ms 保证 echo 先输出再 timeout；其他平台保持 500ms
// 以维持快速反馈。此常量仅用于 timeout + 预期有输出的测试场景。
const timeoutMs = process.platform === "win32" ? 3000 : 500

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
  timeout?: number,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)), timeout)
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          // 快退 echo 的输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
          command: "echo test",
          description: "Echo test message",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
    60_000,
  )

  it.live("coalesces shell progress without changing final output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const code =
          'for (let i = 1; i <= 40; i++) { process.stdout.write("\\rOPENCODE_DISK_WRITE_REPRO " + i + "/40"); await Bun.sleep(10) }'
        const command = PS.has(sh()) ? `& ${bin} -e ${evalarg(code)}` : `${bin} -e ${evalarg(code)}`
        // 该 literal 同时是 WAL feedback loop 的可识别输入和最终 output 的独立预期值。
        // 生产实现不能通过截断或丢弃 CR 帧来伪造较低 durable 计数。
        const updates: Array<{
          delivery?: "durable" | "ephemeral"
          metadata?: Record<string, unknown>
        }> = []

        // 这里观察真实 Tool Context delivery，而不是 coordinator 调用次数：缺省 delivery
        // 本身就是 durable 合同，因此旧实现的每个 transport chunk 都会被准确计入。
        const result = yield* run(
          { command, description: "Render progress" },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                updates.push(input)
              }),
          },
        )
        const durable = updates.filter((item) => item.delivery !== "ephemeral")

        // 短命令允许 initial、leading 与必要 trailing 三个 running durable 快照；
        // terminal result 不经过 metadata callback，不能混入该预算。
        expect(durable.length).toBeLessThanOrEqual(3)
        expect(updates.some((item) => item.delivery === "ephemeral")).toBe(true)
        expect(durable[0]?.metadata?.progressVersion).toBe(0)
        expect(result.metadata.output).toContain("OPENCODE_DISK_WRITE_REPRO 40/40")
        expect(result.output).toContain("OPENCODE_DISK_WRITE_REPRO 40/40")
      }),
    ),
  )

  it.live("does not repeat a durable version when close overlaps publication", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const versions: number[] = []
      const progress = yield* ToolProgress.make<{ output: string }>({
        live: () => Effect.void,
        durable: (metadata) =>
          Effect.gen(function* () {
            // 先记录版本再阻塞，模拟 SQLite 已提交但 publication 尚未返回的真实边界。
            versions.push(metadata.progressVersion)
            if (metadata.progressVersion === 1) yield* Deferred.succeed(first, undefined)
            if (metadata.progressVersion !== 2) return
            yield* Deferred.succeed(second, undefined)
            yield* Deferred.await(release)
          }),
      })
      yield* progress.update({ output: "a" })
      yield* Deferred.await(first).pipe(Effect.timeout("2 seconds"))
      yield* Effect.sleep("1100 millis")
      yield* progress.update({ output: "ab" })
      yield* Deferred.await(second).pipe(Effect.timeout("2 seconds"))
      // close 必须与第二次 publication 重叠；短暂窗口只放大已证实的生命周期竞态。
      const closing = yield* progress.close().pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      // 每个 version 对应一次 durable Part transaction，重复值就是额外磁盘写入。
      expect(versions).toEqual([1, 2])
    }),
  )

  it.live("keeps live progress moving while durable publication is delayed", () =>
    Effect.gen(function* () {
      const durableStarted = yield* Deferred.make<void>()
      const liveTwo = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const progress = yield* ToolProgress.make<{ output: string }>({
        live: (metadata) =>
          metadata.progressVersion === 2 ? Deferred.succeed(liveTwo, undefined).pipe(Effect.asVoid) : Effect.void,
        durable: (metadata) =>
          metadata.progressVersion === 1
            ? Deferred.succeed(durableStarted, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      })

      yield* progress.update({ output: "a" })
      yield* Deferred.await(durableStarted).pipe(Effect.timeout("2 seconds"))
      // 这里只推进真实 50ms cadence；durableStarted 才是 worker 已到达阻塞 seam 的 readiness。
      yield* Effect.sleep("60 millis")
      yield* progress.update({ output: "ab" })
      yield* Deferred.await(liveTwo).pipe(
        Effect.timeoutOrElse({
          duration: "500 millis",
          orElse: () => Effect.fail(new Error("live v2 waited for delayed durable publication")),
        }),
        // red 或 green 都先释放 adapter，避免失败测试把 scope finalizer 留在 blocked close。
        Effect.ensuring(Deferred.succeed(release, undefined)),
      )
      yield* progress.close()
    }),
  )

  // 回归：cmd() 从 spawn 的 shell 选项改为显式 -c 参数后，
  // 必须验证含引号、管道的命令仍被 shell 正确解析。
  // 仅在非 Windows 平台运行：tr 和单引号语义是 POSIX shell 专属。
  if (process.platform !== "win32") {
    each("handles commands with quotes and shell metacharacters", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // 单引号内的内容不应被 shell 二次展开；管道要求 shell 进程而非直接 exec
          const result = yield* run({
            command: "echo 'hello world' | tr a-z A-Z",
            description: "Echo with quotes and pipe",
          })
          expect(result.metadata.exit).toBe(0)
          expect(result.metadata.output).toContain("HELLO WORLD")
        }),
      ),
      60_000,
    )
  }

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  if (bash) {
    it.live("omits leading environment assignments from bash permission patterns [bash]", () =>
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'CI=true git commit -m "test"',
                    description: "Commit with CI env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain('git commit -m "test"')
              expect(bashReq!.patterns).not.toContain('CI=true git commit -m "test"')
              expect(bashReq!.metadata.raw_patterns).toContain('CI=true git commit -m "test"')
            }),
          )
        }),
      ),
    )

    it.live("omits multiple environment assignments from bash permission patterns [bash]", () =>
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "FOO=1 BAR=2 echo hello",
                    description: "Echo with env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain("echo hello")
              expect(bashReq!.patterns).not.toContain("FOO=1 BAR=2 echo hello")
              expect(bashReq!.metadata.raw_patterns).toContain("FOO=1 BAR=2 echo hello")
            }),
          )
        }),
      ),
    )
  }

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  each("includes shell action evidence in bash permission metadata", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git status",
              description: "Inspect git status",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.metadata).toMatchObject({
            action_kind: "shell",
            command: "git status",
            cwd: tmp,
          })
          expect(typeof bashReq!.metadata.shell).toBe("string")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("does not suggest broad wrapper prefixes for always-allow prompts", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "bash -lc 'git status'",
                description: "Inspect git status through shell wrapper",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always).not.toContain("bash *")
          expect(bashReq!.always).not.toContain("bash -lc *")
        }),
      )
    }),
  )

  each("does not suggest broad git branch prefixes for always-allow prompts", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "git branch -D feature/review",
                description: "Delete a branch",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always).not.toContain("git branch *")
        }),
      )
    }),
  )

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
              description: "Read wildcard path",
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
        // Auto 模式下 external_directory 需要使用同一次 shell 命令的证据进行
        // deterministic precheck；否则项目外路径会先退回普通 ask，绕开 bash auto。
        expect(extDirReq!.metadata).toMatchObject({
          action_kind: "shell",
          command: `cat ${file}`,
          cwd: projectRoot,
          agent: "build",
        })
        expect(typeof extDirReq!.metadata.shell).toBe("string")
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                    description: "Copy Windows ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                  description: "Read nested PowerShell file",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                    description: "Read home config",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for bash permission after PowerShell SSH private key path gate [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const fakeHome = yield* tmpdirScoped()
            yield* Effect.promise(() => fs.mkdir(path.join(fakeHome, ".ssh"), { recursive: true }))
            yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_rsa"), "fake private key"))
            yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_ed25519"), "fake private key"))
            yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_ecdsa"), "fake private key"))
            yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const prev = process.env.USERPROFILE
                process.env.USERPROFILE = fakeHome
                return prev
              }),
              () =>
                runIn(
                  projectRoot,
                  Effect.gen(function* () {
                    const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                    yield* run(
                      {
                        command: String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ed25519" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ecdsa" -ErrorAction SilentlyContinue`,
                        description: "Read SSH private keys",
                      },
                      capture(requests),
                    )

                    const extDirReq = requests.find((r) => r.permission === "external_directory")
                    const bashReq = requests.find((r) => r.permission === "bash")
                    expect(extDirReq).toBeDefined()
                    expect(extDirReq!.metadata).toMatchObject({ action_kind: "shell", agent: "build" })
                    expect(extDirReq!.patterns).toContain(glob(path.join(fakeHome, ".ssh", "*")))
                    expect(bashReq).toBeDefined()
                    expect(bashReq!.metadata).toMatchObject({ action_kind: "shell", agent: "build" })
                    expect(bashReq!.patterns.some((pattern) => pattern.includes("id_rsa"))).toBe(true)
                  }),
                ),
              (prev) =>
                Effect.sync(() => {
                  if (prev === undefined) delete process.env.USERPROFILE
                  else process.env.USERPROFILE = prev
                }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for bash permission for PowerShell SSH directory listing [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: String.raw`Get-ChildItem -Path "$env:USERPROFILE\.ssh" -Force -ErrorAction SilentlyContinue`,
                  description: "List SSH directory contents",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns.some((pattern) => pattern.includes("Get-ChildItem"))).toBe(true)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      reviewed.live(`routes auto PowerShell SSH private key access through reviewer [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const fakeHome = yield* tmpdirScoped()
            yield* Effect.promise(() => fs.mkdir(path.join(fakeHome, ".ssh"), { recursive: true }))
            yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_rsa"), "fake private key"))
            const permission = yield* PermissionService.Service
            const ruleset: PermissionService.Ruleset = [
              { permission: "external_directory", pattern: "*", action: "auto" },
              { permission: "bash", pattern: "*", action: "auto" },
            ]

            yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                const prev = process.env.USERPROFILE
                process.env.USERPROFILE = fakeHome
                reviewedCalls = 0
                return prev
              }),
              () =>
                runIn(
                  projectRoot,
                  Effect.gen(function* () {
                    const err = yield* fail(
                      {
                        command: String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue`,
                        description: "Read SSH private key",
                      },
                      {
                        ...ctx,
                        agent: "auto",
                        ask: (req) =>
                          permission.ask({
                            ...req,
                            sessionID: ctx.sessionID,
                            metadata: { ...req.metadata, agent: "auto" },
                            ruleset,
                          }).pipe(Effect.orDie),
                      },
                    ).pipe(
                      Effect.timeoutOrElse({
                        duration: "2 seconds",
                        orElse: () => Effect.fail(new Error("timed out waiting for reviewer denial")),
                      }),
                    )

                    expect(err).toBeInstanceOf(PermissionService.AutoDeniedError)
                    expect(reviewedCalls).toBe(1)
                    expect(yield* permission.list()).toHaveLength(0)
                  }),
                ),
              (prev) =>
                Effect.sync(() => {
                  if (prev === undefined) delete process.env.USERPROFILE
                  else process.env.USERPROFILE = prev
                }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                    description: "Read pshome file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "OPENCODE_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read Windows ini from FileSystem provider",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                    description: "Read Windows ini from braced env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                  description: "Change location",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`rejects local Unix text utilities in PowerShell pipelines [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              expect(
                yield* fail({
                  command: "Write-Output ok | grep ok",
                  description: "Search local pipeline output",
                }),
              ).toMatchObject({
                message: expect.stringContaining(`The current shell is ${item.label}`),
              })
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`allows Unix text utilities inside WSL bash scripts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command:
                      "Write-Host before; wsl.exe -d Ubuntu-22.04 -- bash -lc 'set -euo pipefail; echo \"WSL $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2-)\"'",
                    description: "Run WSL shell script",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`allows Unix text utilities inside WSL sh payloads [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    // This is a WSL guest pipeline, not a local PowerShell
                    // pipeline. The compatibility guard must preserve that
                    // namespace boundary so POSIX utilities remain valid inside
                    // the alternate OS shell while still rejecting local grep.
                    command: `wsl -d Ubuntu-22.04 -- sh -lc 'ps -ef | grep "[d]drescue"'`,
                    description: "Inspect ddrescue process in WSL",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests.find((r) => r.permission === "bash")).toBeDefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not ask for host external_directory for WSL mount paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    // `/mnt/rescue` lives in the WSL guest filesystem for this
                    // command. Mapping it through Windows path resolution would
                    // fabricate a host path such as `F:\mnt\rescue`, so the
                    // shell scanner must leave guest paths to the WSL command's
                    // normal bash permission instead of raising external_directory.
                    command:
                      "wsl -d Ubuntu-22.04 -- sh -lc \"sudo mkdir -p /mnt/rescue && sudo mount -t exfat /dev/sde3 /mnt/rescue && mkdir -p /mnt/rescue/LexarE300_rescue && df -h /mnt/rescue && lsblk -o NAME,SIZE,FSTYPE,LABEL,RO,TYPE,MOUNTPOINTS /dev/sdc /dev/sde\"",
                    description: "Inspect WSL rescue mount",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
              expect(requests.find((r) => r.permission === "bash")).toBeDefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`rejects Unix text utilities after WSL payloads in local pipelines [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              expect(
                yield* fail({
                  // The pipe after the WSL invocation is a host PowerShell
                  // pipeline boundary. Only the quoted `echo ok` belongs to the
                  // guest; the trailing `grep` must remain a local command so
                  // the existing PowerShell compatibility protection cannot be
                  // bypassed by prefixing a pipeline with WSL.
                  command: "wsl -d Ubuntu-22.04 -- sh -lc 'echo ok' | grep ok",
                  description: "Search WSL output locally",
                }),
              ).toMatchObject({
                message: expect.stringContaining(`The current shell is ${item.label}`),
              })
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for host external_directory after WSL payloads in local pipelines [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    // The WSL guest payload ends before the host pipeline. A
                    // following local file read is still a host filesystem access
                    // and must keep the external_directory gate that protects
                    // paths outside the current project.
                    command: `wsl -d Ubuntu-22.04 -- sh -lc 'echo ok' | Get-Content ${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read host file after WSL output",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`rejects Unix text utilities after SSH payloads in local pipelines [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              expect(
                yield* fail({
                  // SSH has the same host/remote boundary as WSL for this
                  // scanner: quoted remote commands may use POSIX utilities, but
                  // a PowerShell pipeline after the SSH call is local and remains
                  // subject to the existing Unix-utility rejection.
                  command: "ssh example.com 'echo ok' | grep ok",
                  description: "Search SSH output locally",
                }),
              ).toMatchObject({
                message: expect.stringContaining(`The current shell is ${item.label}`),
              })
            }),
          ),
        ),
      )
    }

    if (cmdShell) {
      it.live("rejects Unix text utilities after WSL payloads in cmd command chains [cmd]", () =>
        withShell(
          cmdShell,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              expect(
                yield* fail({
                  // In cmd.exe, a single `&` starts another local command. The
                  // WSL guest range must stop before that separator so a trailing
                  // local `grep` remains covered by the existing cmd Unix-utility
                  // rejection instead of being hidden inside the WSL payload.
                  command: 'wsl -d Ubuntu-22.04 -- sh -lc "echo ok" & grep ok',
                  description: "Search WSL output locally with cmd",
                }),
              ).toMatchObject({
                message: expect.stringContaining("The current shell is cmd"),
              })
            }),
          ),
        ),
      )

      it.live("asks for host external_directory after WSL payloads in cmd command chains [cmd]", () =>
        withShell(
          cmdShell,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    // The WSL command ends before cmd's `&` separator. A `TYPE`
                    // command after that point reads the Windows host filesystem,
                    // so it must still request external_directory for the Windows
                    // directory rather than being swallowed by the guest range.
                    command: `wsl -d Ubuntu-22.04 -- sh -lc "echo ok" & TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                    description: "Read host file after WSL output with cmd",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`allows Unix text utilities inside SSH remote commands [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "ssh example.com 'cat /etc/os-release | grep PRETTY_NAME'",
                    description: "Run SSH remote shell command",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not ask for host external_directory for SSH remote paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    // `/etc/os-release` is read on the SSH target, not on the
                    // Windows host. SSH shares the same remote-payload invariant
                    // as WSL: remote POSIX paths must not become fabricated host
                    // external_directory prompts.
                    command: "ssh example.com 'cat /etc/os-release | grep PRETTY_NAME'",
                    description: "Inspect SSH remote OS release",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
              expect(requests.find((r) => r.permission === "bash")).toBeDefined()
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                description: "Read Windows ini with cmd",
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                    description: "Echo from Git Bash tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                    description: "Read Git Bash tmp file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  if (bash) {
    it.live("keeps redirects after removing environment assignments from permission pattern [bash]", () =>
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: "CI=true echo hello > output.txt", description: "Redirect output with env" },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain("echo hello > output.txt")
              expect(bashReq!.patterns).not.toContain("CI=true echo hello > output.txt")
              expect(bashReq!.metadata.raw_patterns).toContain("CI=true echo hello > output.txt")
            }),
          )
        }),
      ),
    )
  }

  each("always pattern has space before wildcard to not include different commands", (item) =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          // 这个用例只验证 approval 的 `always` pattern 必须是 `命令 + 空格 + *`，
          // 避免 `ls*` 一类宽泛规则误放行其它命令；cmd.exe 下 `ls` 会被兼容性
          // 保护提前拒绝，所以使用同样会产生文件访问 permission 的原生命令 `dir`。
          const command = item.label === "cmd" ? "dir" : "ls -la"
          yield* run({ command, description: "List" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe(item.label === "cmd" ? "dir *" : "ls *")
        }),
      )
    }),
  )
})

describe("tool.shell display output", () => {
  it.live(
    "renders carriage-return progress in metadata without changing returned output",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // Decimal ASCII bytes keep the Bun snippet quote-free across pwsh,
          // Windows cmd, and POSIX shells. They spell "one\rtwo\rthree\nfinal\n",
          // the minimal terminal-progress shape where two frames are overwritten.
          const progressBytes = [
            111, 110, 101, 13, 116, 119, 111, 13, 116, 104, 114, 101, 101, 10, 102, 105, 110, 97,
            108, 10,
          ]
          const script = `process.stdout.write(Buffer.from([${progressBytes.join(",")}]))`
          const text = `${bin} -e ${evalarg(script)}`
          const result = yield* run({
            command: PS.has(sh()) ? `& ${text}` : text,
            description: "Emit carriage-return progress",
            compress_output: false,
          })

          // Default shell metadata is the live UI surface. It must match terminal
          // redraw semantics so OpenTUI does not expose raw CR bytes as `\\x0d`,
          // while `result.output` below remains the faithful model-return value.
          expect(result.metadata.output).toContain("three")
          expect(result.metadata.output).toContain("final")
          expect(result.metadata.output).not.toContain("one")
          expect(result.metadata.output).not.toContain("two")
          expect(result.metadata.output).not.toContain("\r")
          expect(result.output).toContain("one")
          expect(result.output).toContain("two")
          expect(result.output).toContain("three")
        }),
      ),
    15_000,
  )

  it.live(
    "keeps clear-line display metadata clean when command exits non-zero",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // The byte sequence is "boot\nworking\r\x1b[2Kdone\n". 27,91,50,75 is
          // ESC[2K, the ANSI clear-line command used by progress renderers before
          // repainting the current line; exit 7 covers non-zero tool completion.
          const clearLineBytes = [
            98, 111, 111, 116, 10, 119, 111, 114, 107, 105, 110, 103, 13, 27, 91, 50, 75, 100, 111,
            110, 101, 10,
          ]
          const script = `process.stdout.write(Buffer.from([${clearLineBytes.join(",")}])); process.exit(7)`
          const text = `${bin} -e ${evalarg(script)}`
          const result = yield* run({
            command: PS.has(sh()) ? `& ${text}` : text,
            description: "Emit clear-line progress then fail",
            compress_output: false,
          })

          // Non-zero exits still render the same default terminal snapshot; the
          // failure status belongs to metadata.exit and must not force the UI back
          // to raw control sequences or discard the returned model output.
          expect(result.metadata.exit).toBe(7)
          expect(result.metadata.output).toContain("boot")
          expect(result.metadata.output).toContain("done")
          expect(result.metadata.output).not.toContain("working")
          expect(result.metadata.output).not.toContain("\r")
          expect(result.metadata.output).not.toContain("\x1b")
          expect(result.output).toContain("working")
          expect(result.output).toContain("done")
        }),
      ),
    15_000,
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          // [local-smark] abort Notice 必须包含 elapsed_ms，让模型知道实际运行时长
          expect(res.output).toContain('<opencode_notice type="execution" source="shell" severity="warning" reason="user_abort"')
          expect(res.output).toContain('elapsed_ms="')
          expect(res.output).not.toContain('reason="exit"')
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // timeoutMs 在 Windows 上为 3000ms，给 pwsh 冷启动足够时间先输出 "started"；
          // 在 Linux/macOS 上为 500ms，保持快速反馈。timeout_ms 断言须与平台值一致。
          const result = yield* run({
            command: `echo started && sleep 60`,
            description: "Timeout test",
            timeout: timeoutMs,
          })
          expect(result.output).toContain("started")
          // [local-smark] timeout Notice 现在包含 elapsed_ms，不再以 /> 结尾
          expect(result.output).toContain(
            `<opencode_notice type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="${timeoutMs}"`,
          )
          expect(result.output).toContain('elapsed_ms="')
          expect(result.output).not.toContain('reason="exit"')
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo started && sleep 60`,
            description: "Default timeout test",
          })
          expect(result.output).toContain("started")
          // bashDefaultTimeoutMs 与 timeoutMs 保持同值，确保 notice 中 timeout_ms
          // 在所有平台都与实际使用的默认超时一致
          expect(result.output).toContain(`reason="timeout" timeout_ms="${timeoutMs}"`)
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: timeoutMs }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
            description: "Stderr test",
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
          description: "Non-zero exit",
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("reports exit notice for empty successful output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg("process.exit(0)")}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Empty successful command",
        })

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("(no output)")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="info" reason="exit" exit_code="0"',
        )
        // 用户面板只展示终端占位，不得回灌模型 execution notice
        expect(result.metadata.output).toBe("(no output)")
        expect(result.metadata.output).not.toContain("opencode_notice")
      }),
    ),
  )

  it.live("reports exit notice for empty failed output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg("process.exit(42)")}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Empty failed command",
        })

        expect(result.metadata.exit).toBe(42)
        expect(result.output).toContain("(no output)")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="42"',
        )
        // 空失败同样：exit notice 仅模型可见，用户侧仍是 (no output)
        expect(result.metadata.output).toBe("(no output)")
        expect(result.metadata.output).not.toContain("opencode_notice")
      }),
    ),
  )

  it.live("reports exit notice for non-empty failed output without diagnostics", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg('console.log("plain output"); process.exit(7)')}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Non-empty failed command",
        })

        expect(result.metadata.exit).toBe(7)
        expect(result.output).toContain("plain output")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="7"',
        )
      }),
    ),
  )

  it.live("adds hidden diagnostics without suppressing non-empty failure exit notice", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const script = [
          'console.error("fatal: hidden root cause")',
          "await new Promise((resolve) => setTimeout(resolve, 2100))",
          `for (let i = 0; i < ${Truncate.MAX_LINES + 500}; i++) console.log("tail line " + i + " " + "x".repeat(80))`,
          "process.exit(9)",
        ].join(";")
        const command = `${bin} -e ${evalarg(script)}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Diagnostic failed command",
          // 这个用例只验证 tail 截断隐藏区会生成诊断附录；关闭压缩，并让尾部
          // 文本同时超过默认行数/字节阈值，避免平台输出差异让 root cause 仍可见。
          compress_output: false,
        })

        expect(result.metadata.exit).toBe(9)
        expect(result.output).toContain("<bash_high_signal_excerpt>")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9"',
        )
      }),
    ),
    15_000,
  )

  it.live("keeps visible diagnostics out of appendix without suppressing exit notice", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const script = [
          "await new Promise((resolve) => setTimeout(resolve, 2100))",
          'console.log("fatal: visible root cause")',
          "process.exit(9)",
        ].join(";")
        const command = `${bin} -e ${evalarg(script)}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Visible diagnostic failed command",
        })

        expect(result.metadata.exit).toBe(9)
        expect(result.output).toContain("fatal: visible root cause")
        // 诊断摘录只来自最终输出隐藏掉的文本；可见 fatal 行本身不需要再复制到
        // <bash_high_signal_excerpt>，但执行状态 notice 仍然独立保留 exit code。
        expect(result.output).not.toContain("<bash_high_signal_excerpt>")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9"',
        )
      }),
    ),
    15_000,
  )

  it.live("omits exit notice for non-empty successful output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `echo ok`,
          description: "Non-empty successful command",
        })

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("ok")
        expect(result.output).not.toContain('reason="exit"')
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            // 0.3 秒用于制造可观察的流式输出边界，避免依赖不同平台对
            // 相邻 echo 的管道 chunk 拆分；这些 chunk 在 Windows/CI 上可能被合并。
            command: `echo first && sleep 0.3 && echo second`,
            description: "Streaming test",
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )

  it.live(
    "waits for final output metadata before returning",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          let finalMetadataDelivered = false
          const command = `${bin} -e ${evalarg('console.log("first"); console.log("final")')}`
          const result = yield* run(
            {
              command: PS.has(sh()) ? `& ${command}` : command,
              description: "Emit final metadata output",
            },
            {
              ...ctx,
              metadata: (input) => {
                const output = (input.metadata as { output?: string })?.output
                if (!output?.includes("final") || finalMetadataDelivered) return Effect.void

                // "final" 是本用例的最后输出哨兵；延迟的 metadata 回调模拟
                // live UI 仍在消费最后一个 shell 输出 chunk。ShellTool 必须等
                // 这个输出消费者 drain 完再组装完成态结果，否则 fast-exit 命令
                // 会和最终 metadata、截断、诊断摘要计算发生竞态。
                return Effect.sleep("750 millis").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      finalMetadataDelivered = true
                    }),
                  ),
                )
              },
            },
          )

          expect(result.output).toContain("final")
          expect(finalMetadataDelivered).toBe(true)
        }),
      ),
    15_000,
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toContain('<opencode_notice type="output_truncated" source="shell"')
        expect(result.output).toContain(`total="${lineCount}L/`)
        expect(result.output).toContain('shown="tail')
        expect(result.output).toContain(`path="${(result.metadata as { outputPath?: string }).outputPath}`)
        // Shell 日志通常很长，notice 必须引导模型先搜索保存文件、再按行段读取，
        // 否则截断恢复容易退化成读取完整日志并浪费上下文。
        expect(result.output).toContain("grep")
        expect(result.output).toContain("read offset/limit")
        expect(result.output).toContain("Avoid reading the full file")
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes exceeding limit",
          // 本用例只验证截断边界；重复字节默认会被 bash 压缩器折叠，
          // 导致压缩后的可见输出低于 byte limit，所以这里显式关闭压缩。
          compress_output: false,
        })
        mustTruncate(result)
        expect(result.output).toContain('<opencode_notice type="output_truncated" source="shell"')
        expect(result.output).toContain('total="1L/')
        expect(result.output).toContain('shown="tail')
        expect(result.output).toContain(`path="${(result.metadata as { outputPath?: string }).outputPath}`)
      }),
    ),
  )

  it.live("keeps a visible tail preview for an oversized single line with final newline", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const code = 'console.log("0123456789".repeat(2400))'
        const command = `${bin} -e ${evalarg(code)}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          description: "Generate one oversized line with final newline",
          compress_output: false,
        })

        mustTruncate(result)
        expect(result.output).toContain('<opencode_notice type="output_truncated" source="shell"')
        expect(result.output).toContain('total="1L/')
        expect(result.output).toContain('shown="tail 1L/')
        expect(result.output).toContain("0123456789")
        expect(result.output).not.toContain("(no output)")
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
          description: "Generate one line",
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* AppFileSystem.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )

  // [local-smark] timeout + 空输出时追加诊断提示，帮助模型区分
  // "block-buffered 未 flush" vs "等待交互输入" vs "进程 hang 住"。
  // 不改 pipe 架构（pty 改造是 P2），仅改善模型决策质量。
  describe("timeout empty-output diagnostic", () => {
    it.live(
      "appends block-buffering hint on timeout with no output",
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // sleep 不产生任何输出，触发 timeout + emptyOutput
            const result = yield* run({
              command: PS.has(sh()) ? "Start-Sleep -Seconds 60" : "sleep 60",
              description: "Timeout no output test",
              timeout: 500,
            })

            expect(result.output).toContain("(no output)")
            expect(result.output).toContain('reason="timeout"')
            // [local-smark] 诊断提示应包含 block-buffering 说明
            expect(result.output).toContain("block-buffering")
            expect(result.output).toContain("--verbose")
            // 用户面板保持空输出占位，不展示 timeout 诊断散文或 notice
            expect(result.metadata.output).toBe("(no output)")
            expect(result.metadata.output).not.toContain("opencode_notice")
            expect(result.metadata.output).not.toContain("block-buffering")
          }),
        ),
      15_000,
    )

    it.live(
      "does not append block-buffering hint on timeout with output",
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // [local-smark] echo 先输出再 sleep，timeout 时已有 output → emptyOutput=false
            // 验证有输出时不触发 block-buffering 诊断（仅 timeout+空输出触发）
            // timeoutMs 在 Windows 上放宽到 3000ms，确保 pwsh 冷启动后
            // "started" 先到达管道再触发 timeout，否则 emptyOutput=true 会误触诊断
            const result = yield* run({
              command: `echo started && sleep 60`,
              description: "Timeout with output test",
              timeout: timeoutMs,
            })

            expect(result.output).toContain("started")
            expect(result.output).toContain("reason=\"timeout\"")
            // 有输出时不应追加 block-buffering 诊断
            expect(result.output).not.toContain("block-buffering")
          }),
        ),
      15_000,
    )

    it.live(
      "does not append block-buffering hint on normal exit with no output",
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const command = `${bin} -e ${evalarg("process.exit(0)")}`
            const result = yield* run({
              command: PS.has(sh()) ? `& ${command}` : command,
              description: "Normal exit no output test",
            })

            expect(result.output).toContain("(no output)")
            // 正常退出（非 timeout）不应追加 block-buffering 诊断
            expect(result.output).not.toContain("block-buffering")
          }),
        ),
    )
  })
})

// [local-smark] PowerShell inline Python 命令规范化：PowerShell 对 python -c "..."
// 内双引号源码做二次解析，导致 Bash 风格的 \" 转义被剥离、$() 被展开。
// 规范化把源码移入 PowerShell 单引号 literal，使 Python 收到原始源码。
// 仅在 Windows PowerShell 下生效；非 Windows 或无 PowerShell 时跳过。
describe("tool.shell inline python normalization", () => {
  // 最小复现：Bash 风格 \" 在 PowerShell 双引号内被剥离，导致 Python SyntaxError
  for (const item of ps) {
    it.live(`preserves escaped quotes in python -c [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "print('{\"key\":1}')"`,
              description: "Print JSON with escaped quotes",
            })
            expect(result.metadata.exit).toBe(0)
            // Python 应输出 {"key":1}，而非 SyntaxError: unterminated string literal
            expect(result.output).toContain('{"key":1}')
            // 规范化生效时 metadata 记录 adaptation tag
            expect(result.metadata).toHaveProperty("commandAdaptation")

            // 静态绝对路径必须保留模型选择的解释器，只修复同一个 -c 参数。
            const interpreter = Bun.which("python")!
            const pathResult = yield* run({
              command: `& "${interpreter}" -c "import sys; print(sys.executable); print('{\"path\":1}')"`,
              description: "Print JSON with an explicit Python path",
            })
            expect(pathResult.metadata.exit).toBe(0)
            expect(pathResult.output).toContain('{"path":1}')
            // 输出实际解释器路径，防止规范化悄悄退回 PATH 中的 bare python。
            expect(pathResult.output.toLowerCase().replaceAll("\\", "/")).toContain(interpreter.toLowerCase().replaceAll("\\", "/"))
            expect(pathResult.metadata).toHaveProperty("commandAdaptation")
          }),
        ),
      ),
      30_000,
    )
  }

  for (const item of ps) {
    it.live(`preserves valid Python semicolon statements [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "print('{\"key\":1}'); print(2)"`,
              description: "Print two Python statements",
            })
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain('{"key":1}')
            expect(result.output).toContain("2")
            expect(result.metadata).toHaveProperty("commandAdaptation")
          }),
        ),
      ),
      30_000,
    )
  }

  // $() 和 $env: 在 PowerShell 双引号内会被展开；规范化后应保持字面量
  for (const item of ps) {
    it.live(`prevents PowerShell variable expansion in python source [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "s='$(Write-Output EXPANDED)'; print(s)"`,
              description: "Print literal dollar-paren",
            })
            expect(result.metadata.exit).toBe(0)
            // 源码中的 $(...) 应原样到达 Python，不被 PowerShell 求值
            expect(result.output).toContain("$(Write-Output EXPANDED)")
            expect(result.output).not.toContain("EXPANDED\n")
          }),
        ),
      ),
      30_000,
    )
  }

  // Unicode 和各种引号组合应逐字符到达 Python
  for (const item of ps) {
    it.live(`preserves unicode and quote combinations [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // 混合单双引号和 Unicode 在 -c 源码内，验证规范化后逐字符一致
            const result = yield* run({
              command: `python -c "print('{\"k\":\"v\"} 汉字')"`,
              description: "Print unicode with escaped quotes",
            })
            expect(result.metadata.exit).toBe(0)
            // Python 应输出原始源码中的 JSON 和 Unicode
            expect(result.output).toContain('{"k":"v"} 汉字')
          }),
        ),
      ),
      30_000,
    )
  }

  // 尾部 Select-Object -First/-Last 应保持行为
  for (const item of ps) {
    it.live(`preserves Select-Object -First suffix [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "for i in range(10): print(i)" | Select-Object -First 3`,
              description: "Print first 3 lines",
            })
            expect(result.metadata.exit).toBe(0)
            const lines = result.output.trim().split("\n")
            expect(lines.length).toBeLessThanOrEqual(3)
            expect(lines[0]).toContain("0")
          }),
        ),
      ),
      30_000,
    )
  }

  // 不支持的命令结构应原样执行，不产生 adaptation metadata
  for (const item of ps) {
    it.live(`does not normalize compound commands [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "print(1)"; Write-Output "done"`,
              description: "Compound command",
            })
            // 复合命令不命中规范化，原样执行
            expect(result.metadata).not.toHaveProperty("commandAdaptation")
            expect(result.output).toContain("1")
            expect(result.output).toContain("done")
          }),
        ),
      ),
      30_000,
    )
  }

  // conda run 前缀必须保留原环境选择，只规范化嵌套 Python 的 -c 源码。
  // 在 bash permission 处中断，验证 parser 而不实际启动 conda 或历史载荷。
  for (const item of ps) {
    it.live(`normalizes conda run inline Python without execution [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            const stop = new Error("stop before conda execution")
            expect(
              yield* fail(
                {
                  command: `conda run -n agent python -c "print('{\"key\":1}')"`,
                  description: "Conda run command",
                },
                capture(requests, stop),
              ),
            ).toMatchObject({ message: stop.message })
            expect(requests.find((request) => request.permission === "bash")?.metadata).toMatchObject({
              inline_scripts: [`print('{"key":1}')`],
            })
            const raw = requests.find((request) => request.permission === "bash")?.metadata.raw_patterns
            expect(Array.isArray(raw) && raw.some((pattern) =>
              typeof pattern === "string" && pattern.startsWith("conda run -n agent python -c '")
            )).toBe(true)
          }),
        ),
      ),
      30_000,
    )
  }

  for (const item of ps) {
    it.live(`handles bounded conda options and rejects dynamic forms [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const cases = [
              { option: "--name=agent", normalized: true },
              { option: "--prefix=C:\\envs\\agent", normalized: true },
              { option: "--cwd=H:\\work", normalized: true },
              { option: "--name=$env:ENV", normalized: false },
              { option: "--prefix=$(Get-Location)", normalized: false },
              { option: '--cwd="somewhere"', normalized: false },
              { option: "--name=agent;Write-Output", normalized: false },
              { option: "--prefix=C:\\envs\\agent|Write-Output", normalized: false },
              { option: "-n agent;Write-Output", normalized: false },
              { option: "-p C:\\envs\\agent&&Write-Output", normalized: false },
              { option: "-n @environmentArgs", normalized: false },
              { option: "--prefix @prefixArgs", normalized: false },
              { option: "--unknown value", normalized: false },
            ]
            for (const entry of cases) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const stop = new Error(`stop before conda ${entry.option}`)
              expect(
                yield* fail(
                  {
                    command: `conda run ${entry.option} --live-stream python -c "print(1)"`,
                    description: "Conda option boundary",
                  },
                  capture(requests, stop),
                ),
              ).toMatchObject({ message: stop.message })
              expect(Boolean(requests.find((request) => request.permission === "bash")?.metadata.inline_scripts)).toBe(entry.normalized)
            }
          }),
        ),
      ),
      30_000,
    )
  }

  for (const item of ps) {
    it.live(`supports static Python launchers and flags without execution [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const cases = [
              // 版本化名称和静态绝对路径仍保留调用方选择的原解释器。
              // 动态路径反例保证 `$env:` 不会被误认成固定解释器。
              { prefix: "python3.12", normalized: true },
              { prefix: '& "C:\\Python312\\python3.12.exe"', normalized: true },
              { prefix: "& 'C:\\Python312\\python3.12.exe'", normalized: true },
              { prefix: "& C:\\Python312\\python3.12.exe", normalized: true },
              { prefix: '& "C:\\$env:PYTHON\\python.exe"', normalized: false },
              { prefix: "python3.$env:PY", normalized: false },
              { prefix: "python -b -bb -d -x", normalized: true },
              { prefix: "python -Wdefault -Xutf8", normalized: true },
              { prefix: "py -32", normalized: true },
              { prefix: "py -64", normalized: true },
              { prefix: "py -3.12", normalized: true },
              { prefix: "python -Wdefault;python", normalized: false },
              { prefix: "python -W default;python", normalized: false },
              { prefix: "python -Xutf8|python", normalized: false },
              { prefix: "python -X utf8||python", normalized: false },
              { prefix: "python -W@warningArgs", normalized: false },
              { prefix: "python -X @xoptions", normalized: false },
            ]
            for (const entry of cases) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const stop = new Error(`stop before ${entry.prefix}`)
              expect(
                yield* fail(
                  { command: `${entry.prefix} -c "print(1)"`, description: "Python flag boundary" },
                  capture(requests, stop),
                ),
              ).toMatchObject({ message: stop.message })
              expect(Boolean(requests.find((request) => request.permission === "bash")?.metadata.inline_scripts)).toBe(entry.normalized)
            }
          }),
        ),
      ),
      30_000,
    )
  }

  for (const item of ps) {
    it.live(`leaves backtick and extra argv commands unchanged [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            for (const command of [
              'python -c "print(`"hello`")"',
              'python -c "print(1)" "extra"',
              'python -c "print(1)" > output.txt',
              'python -c "print(1)"\nWrite-Output done',
            ]) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const stop = new Error("stop before unsupported boundary")
              expect(yield* fail({ command, description: "Unsupported Python boundary" }, capture(requests, stop))).toMatchObject({
                message: stop.message,
              })
              expect(requests.find((request) => request.permission === "bash")?.metadata).not.toHaveProperty("inline_scripts")
            }
          }),
        ),
      ),
      30_000,
    )
  }

  // Python flags 应保留
  for (const item of ps) {
    it.live(`preserves Python flags [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // -B 设置 dont_write_bytecode flag 为 1
            const result = yield* run({
              command: `python -B -c "import sys; print(sys.flags.dont_write_bytecode)"`,
              description: "Print dont_write_bytecode flag",
            })
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("1")
          }),
        ),
      ),
      30_000,
    )
  }

  // 真正的 Python SyntaxError 应由原解释器直接输出，不增加 wrapper frame
  for (const item of ps) {
    it.live(`reports real SyntaxError without wrapper frame [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "print("`,
              description: "Syntax error command",
            })
            expect(result.metadata.exit).not.toBe(0)
            // Python 语法错误应直接出现在输出中
            expect(result.output).toMatch(/SyntaxError|Unexpected EOF|was never closed/)
            // traceback 不应包含 bootstrap/wrapper frame
            expect(result.output).not.toContain("__opencode")
          }),
        ),
      ),
      30_000,
    )
  }

  // permission 请求应同时携带原始 command 和 inline_scripts 证据
  for (const item of ps) {
    it.live(`sends inline_scripts in both permission gates [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `python -c "print(1)"`,
                description: "Permission evidence",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            // bash gate 必须携带 inline_scripts 附加证据
            expect(bashReq!.metadata).toHaveProperty("inline_scripts")
          }),
        ),
      ),
      30_000,
    )
  }
})

// [local-smark] execution notice policy 纯函数测试：不依赖真实子进程，
// 确定性验证 Bash outcome 优先级、elapsed_ms 和 120 秒阈值
describe("tool.shell execution notice policy", () => {
  // pure policy 函数已通过顶部 ESM import 导入

  test("abort 包含正整数 elapsed_ms 且不含 exit", () => {
    const notice = formatShellExecutionNotice({ aborted: true, expired: false, exitCode: null, emptyOutput: false, timeoutMs: 120000, elapsedMs: 61742 })
    expect(notice).toContain('reason="user_abort"')
    expect(notice).toContain('elapsed_ms="61742"')
    expect(notice).not.toContain('reason="exit"')
    expect(notice).not.toContain('reason="timeout"')
  })

  test("timeout 同时包含 timeout_ms 和 elapsed_ms", () => {
    const notice = formatShellExecutionNotice({ aborted: false, expired: true, exitCode: null, emptyOutput: false, timeoutMs: 120000, elapsedMs: 120487 })
    expect(notice).toContain('reason="timeout"')
    expect(notice).toContain('timeout_ms="120000"')
    expect(notice).toContain('elapsed_ms="120487"')
  })

  test("non-zero exit 包含 exit_code 和 elapsed_ms", () => {
    const notice = formatShellExecutionNotice({ aborted: false, expired: false, exitCode: 1, emptyOutput: false, timeoutMs: 120000, elapsedMs: 8421 })
    expect(notice).toContain('reason="exit"')
    expect(notice).toContain('exit_code="1"')
    expect(notice).toContain('elapsed_ms="8421"')
  })

  test("exit 0 + 有输出 + 119999ms 不生成 Notice", () => {
    const notice = formatShellExecutionNotice({ aborted: false, expired: false, exitCode: 0, emptyOutput: false, timeoutMs: 120000, elapsedMs: 119999 })
    expect(notice).toBeUndefined()
  })

  test("exit 0 + 有输出 + 120000ms 生成 completed Notice", () => {
    const notice = formatShellExecutionNotice({ aborted: false, expired: false, exitCode: 0, emptyOutput: false, timeoutMs: 120000, elapsedMs: 120000 })
    expect(notice).toContain('reason="completed"')
    expect(notice).toContain('elapsed_ms="120000"')
  })

  // 验证 outcome 互斥：abort 优先于 long completed
  test("abort >=120000ms 只有 user_abort，不追加 completed", () => {
    const notice = formatShellExecutionNotice({ aborted: true, expired: false, exitCode: 0, emptyOutput: false, timeoutMs: 120000, elapsedMs: 300000 })
    expect(notice).toContain('reason="user_abort"')
    expect(notice).not.toContain('reason="completed"')
  })

  // 验证 timeout 优先于 abort
  test("timeout >=120000ms 只有 timeout", () => {
    const notice = formatShellExecutionNotice({ aborted: true, expired: true, exitCode: null, emptyOutput: false, timeoutMs: 120000, elapsedMs: 300000 })
    expect(notice).toContain('reason="timeout"')
    expect(notice).not.toContain('reason="user_abort"')
  })

  // 空输出 exit 0 保留 exit Notice，不改成 completed
  test("空输出 exit 0 保留 exit Notice", () => {
    const notice = formatShellExecutionNotice({ aborted: false, expired: false, exitCode: 0, emptyOutput: true, timeoutMs: 120000, elapsedMs: 500 })
    expect(notice).toContain('reason="exit"')
    expect(notice).toContain('exit_code="0"')
    expect(notice).not.toContain('reason="completed"')
  })

  // NaN/Infinity 被规范化为 0，不输出畸形属性
  test("NaN elapsed 被规范化为 0", () => {
    const notice = formatShellExecutionNotice({ aborted: true, expired: false, exitCode: null, emptyOutput: false, timeoutMs: 120000, elapsedMs: NaN })
    expect(notice).toContain('elapsed_ms="0"')
  })

  test("正 Infinity elapsed 被规范化为 0", () => {
    const notice = formatShellExecutionNotice({ aborted: true, expired: false, exitCode: null, emptyOutput: false, timeoutMs: 120000, elapsedMs: Infinity })
    expect(notice).toContain('elapsed_ms="0"')
  })

  // 通用长成功 Notice 阈值
  test("formatLongExecutionNotice 119999ms 返回 undefined", () => {
    expect(formatLongExecutionNotice("tool", 119999)).toBeUndefined()
  })

  test("formatLongExecutionNotice 120000ms 返回 completed Notice", () => {
    const notice = formatLongExecutionNotice("tool", 120000)
    expect(notice).toContain('reason="completed"')
    expect(notice).toContain('source="tool"')
  })
})

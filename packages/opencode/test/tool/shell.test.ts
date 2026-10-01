import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { formatShellExecutionNotice, formatLongExecutionNotice } from "../../src/util/output-notice"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Sink, Stream } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { Config } from "@/config/config"
import { ChildProcessSpawner, ExitCode, ProcessId, makeHandle } from "effect/unstable/process/ChildProcessSpawner"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Permission } from "../../src/permission"
import { PermissionReviewer } from "../../src/permission/reviewer/service"
import { PermissionSessionCache } from "../../src/permission/cache/session-cache"
import { PermissionCircuitBreaker } from "../../src/permission/reviewer/circuit-breaker"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { ToolProgress } from "@/tool/progress"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { PermissionPrecheck } from "../../src/permission/precheck"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
// #203：带确定性 deny reviewer 的 shell env——恢复 original 三组 PowerShell SSH/gci 回归：
// #203：Auto 敏感访问须端到端经 reviewer fail-closed，而非仅 precheck 单测覆盖。
let reviewedCalls = 0
const reviewedShellEnv = Layer.mergeAll(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      PermissionReviewer.node,
      PermissionSessionCache.node,
      PermissionCircuitBreaker.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      // #203：noop bootstrap 阻止测试环境启动完整实例生命周期
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
      [
        PermissionReviewer.node,
        Layer.succeed(
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
        ),
      ],
    ],
  ),
  testInstanceStoreLayer,
)
const reviewed = testEffect(reviewedShellEnv)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
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
// 首条 echo 输出在 CI 上可达 600ms+。500ms timeout 会在输出到达管道前触发，
// 导致 timeout 相关断言间歇性失败。Windows 放宽到 3000ms；其他平台保持
// 500ms 快速反馈。仅用于 timeout + 预期有输出的测试场景。
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
    // #179：ERROR 节点用例主要覆盖 Windows PS
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
  // #315：basic 用例贯穿 shell+fixture 完整链路，Windows CI 需要显式更大预算；
  // 其余用例不传 timeout，保持 it.live 默认行为不变。
  timeout?: number,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)), timeout)
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
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
  // 复用真实 shell 矩阵，同时覆盖 PowerShell 编码入口及其余原生脚本入口。
  for (const plugin of [false, true]) {
    each(`process identity ${plugin ? "explicit plugin precedence" : "ordinary child"}`, () =>
      Effect.gen(function* () {
        // 子进程只读取真实继承环境，不启动产品入口或复制身份初始化算法。
        const dir = yield* tmpdirScoped()
        const inherited = {
          OPENCODE_PROCESS_ROLE: "worker",
          OPENCODE_RUN_ID: "parent-run",
          // 无关变量也使用 OPENCODE_ 前缀，防止修复误删整个命名空间。
          OPENCODE_SHELL_TEST_VALUE: "parent-value",
          PYTHONIOENCODING: "parent-encoding",
          PYTHONUTF8: "parent-utf8",
        }
        // 与已有 shell 矩阵一样恢复全局环境，失败的断言也不能污染后续用例。
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]))
            Object.assign(process.env, inherited)
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
              }
            }),
        )
        // 文件入口避免各 shell 的内联 JavaScript 引号规则掩盖环境继承行为。
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "identity.mjs"),
            `
          console.log(JSON.stringify({ processRole: process.env.OPENCODE_PROCESS_ROLE ?? null,
            runID: process.env.OPENCODE_RUN_ID ?? null,
            value: process.env.OPENCODE_SHELL_TEST_VALUE,
            encoding: process.env.PYTHONIOENCODING, utf8: process.env.PYTHONUTF8 }));
        `,
          ),
        )
        if (plugin) {
          // 真实本地插件走配置发现及 shell.env；不能用服务替身绕开覆盖顺序。
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode/plugin/identity.ts"),
              `
            export default async () => ({ "shell.env": (_input, output) => Object.assign(output.env, {
              OPENCODE_PROCESS_ROLE: "worker", OPENCODE_RUN_ID: "plugin-run",
              OPENCODE_SHELL_TEST_VALUE: "plugin-value", PYTHONIOENCODING: "plugin-encoding", PYTHONUTF8: "plugin-utf8"
            }) });
          `,
            ),
          )
          // 本地文件无需网络安装，沿用配置依赖 fixture 的已满足标记。
          yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))
        }
        const result = yield* runIn(
          dir,
          run({ command: "bun identity.mjs", workdir: dir, description: "Read child identity" }),
        )
        // 成功必须来自真实有限进程正常返回，不能用中止后的部分输出代替。
        expect(result.metadata.exit).toBe(0)
        const identity: unknown = JSON.parse(result.output)
        // 目标入口在角色缺省时走普通路径；插件显式身份仍属于调用者的覆盖契约。
        expect(identity).toEqual({
          processRole: plugin ? "worker" : null,
          runID: plugin ? "plugin-run" : null,
          value: plugin ? "plugin-value" : "parent-value",
          // Windows 默认 UTF-8 胜过父环境，但不得胜过插件的显式设置。
          encoding: plugin ? "plugin-encoding" : process.platform === "win32" ? "utf-8" : "parent-encoding",
          utf8: plugin ? "plugin-utf8" : process.platform === "win32" ? "1" : "parent-utf8",
        })
        // 仅断言 main 不足以防止父运行标识继续串入子进程。
        if (!plugin) expect(identity).not.toMatchObject({ runID: "parent-run" })
      }),
    )
  }

  it.live(
    "coalesces shell progress without changing final output",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // JSON.stringify 传输让 CR 转义跨 shell 安全，避免 pwsh/bash 引号解析吃掉字面转义。
          const script = `for (let i = 1; i <= 40; i++) { process.stdout.write('\rOPENCODE_DISK_WRITE_REPRO ' + i + '/40'); await Bun.sleep(10) }`
          const command = `bun -e ${JSON.stringify(script)}`
          // 该 literal 同时是 WAL feedback loop 的可识别输入和最终 output 的独立预期值。
          // 生产实现不能通过截断或丢弃 CR 帧来伪造较低 durable 计数。
          const updates: Array<{
            delivery?: "durable" | "ephemeral"
            metadata?: Record<string, unknown>
          }> = []

          // 这里观察真实 Tool Context delivery，而不是 coordinator 调用次数：缺省 delivery
          // 本身就是 durable 合同，因此旧实现的每个 transport chunk 都会被准确计入。
          const result = yield* run(
            { command },
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
    60_000,
  )

  it.live(
    "does not repeat a durable version when close overlaps publication",
    () =>
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

  it.live(
    "keeps live progress moving while durable publication is delayed",
    () =>
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

  // #155：BEL 测试只注册一次，勿放进 each() 避免按 shell 组合重复
  it.live("sanitizes BEL and control characters in shell output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const seen: string[] = []
        // 数字源码跨 shell 不需嵌套引号；当前 Bun 路径不依赖 PATH 中同名程序。
        const code = "process.stdout.write(Buffer.from([115,97,102,101,7,101,110,100,10]))"
        const result = yield* run(
          {
            command: `${PS.has(sh()) ? "& " : ""}${bin} -e ${evalarg(code)}`,
          },
          {
            // 保留权限、取消及会话上下文，只观察 metadata，不能绕开真实执行前置条件。
            ...ctx,
            metadata: (input) => {
              const out = input?.metadata?.output
              if (typeof out === "string") seen.push(out)
              return Effect.void
            },
          },
        )
        // #155：断言转义后可见文本，原始 BEL 不得出现
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("safe\\x07end")
        expect(result.output.includes("\u0007")).toBe(false)
        expect(result.metadata.output).not.toContain("\u0007")
        // 必须实际收到消毒后的进度，空数组上的全称断言不能证明 streaming 安全。
        expect(seen.some((item) => item.includes("safe\\x07end"))).toBe(true)
        for (const item of seen) {
          expect(item.includes("\u0007")).toBe(false)
        }
      }),
    ),
  )

  each("basic", (item) =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          // #590：快退 echo 的输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
          command: "echo test",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
        if (process.platform !== "win32" || !PS.has(item.label)) return
        // 在既有每-shell 实进程测试中验证中文、单双引号、表格与 native 最后退出码。
        const command = [
          `Write-Output '桌面 大学文档 毕业设计 压缩感知 ''单引号'' "双引号"'`,
          `[pscustomobject]@{ Name = '中文表格' } | Format-Table -HideTableHeaders`,
          `[Console]::Error.Write("中文错误")`,
          `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(7)' # 尾注释`,
        ].join("\n")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const encoded = yield* run({ command, compress_output: false }, capture(requests))
        expect(encoded.metadata.exit).toBe(7)
        for (const text of ["桌面 大学文档 毕业设计 压缩感知", "'单引号'", '"双引号"', "中文表格", "中文错误"]) {
          expect(encoded.output).toContain(text)
        }
        expect(encoded.output).not.toContain("\uFFFD")
        expect(requests.some((request) => request.metadata.command === command)).toBe(true)
        expect((yield* run({ command: "Write-Output '中文'; exit 9" })).metadata.exit).toBe(9)

      }),
    ),
    60_000,
  )

  // [local-smark] 回归：cmd() 从 spawn 的 shell 选项改为显式 -c 参数后，
  // 必须验证含引号、管道的命令仍被 shell 正确解析。
  // 仅在非 Windows 平台运行：tr 和单引号语义是 POSIX shell 专属。
  if (process.platform !== "win32") {
    each("handles commands with quotes and shell metacharacters", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // 单引号内的内容不应被 shell 二次展开；管道要求 shell 进程而非直接 exec；
          // #590：输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
          const result = yield* run({
            command: "echo 'hello world' | tr a-z A-Z",
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
              // #590：输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
              command: "echo fallback",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )

  // [INV-04] 图例是给模型的防退守契约：声明标记由 harness 插入（命令未打印）、
  // 首现/错误行保留、省略是有意的，避免模型把标记当异常排查或因此关闭压缩。
  it.live("tool description documents harness compression markers", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bash = yield* initBash()
        expect(bash.description).toContain("Short harness markers")
        expect(bash.description).toContain("the command did not print them")
        expect(bash.description).toContain("[... same line Nx]")
        expect(bash.description).toContain("[redacted ...]")
      }),
    ),
  )

  it.live("omits marker legend when bash compression is disabled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { tool_output: { bash_compression: false } } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          expect(bash.description).not.toContain("Short harness markers")
        }),
      )
    }),
  )
})

it.live("guards Windows command heads without rejecting literal arguments", () => Effect.gen(function* () {
  // 平台无关地验证实际共用 renderer；5.1/7+/cmd 的变量与链式规则不能混用。
  expect(Shell.guidance("powershell", "win32")).toContain("do NOT use && or ||")
  expect(Shell.guidance("pwsh", "win32")).toContain("PowerShell 7+: && and || are supported")
  expect(Shell.guidance("cmd", "win32")).toContain("%NAME%")
  expect(Shell.guidance("bash", "win32")).not.toContain("Do NOT use Unix text utilities")
  if (process.platform !== "win32") return
  for (const item of shells.filter((item) => PS.has(item.label) || item.label === "cmd")) {
    // 显式配置所测 shell，环境默认值不能冒充本用例的执行配置。
    const tmp = yield* tmpdirScoped({ config: { shell: item.shell } })
    yield* runIn(tmp, Effect.gen(function* () {
      const tool = yield* initShell()
      expect(tool.description).toContain("captured output is decoded as UTF-8")
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      for (const command of ["head -n 1 missing", "grep.exe needle missing", item.label === "cmd" ? "ls" : "find ."]) {
        // 真正命令头在执行与权限之前被阻止，不调用外部 Unix 程序来证明失败。
        const error = yield* fail({ command }, capture(requests))
        expect(error.message).toMatch(/Unix utility|instead of ls|ambiguous/)
      }
      expect(requests).toEqual([])
      // 同样的文字作为参数必须正常执行，阻止基于整串关键词的假 guard。
      const result = yield* tool.execute({
        command: item.label === "cmd" ? "echo head grep" : "Write-Output 'head grep'",
        description: "Prints literal words without invoking utilities",
      }, ctx)
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("head grep")
    }))
  }
}))

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
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
    // #285：permission pattern 不含 CI=true 前缀，规则只需匹配真实命令；
    // 原始命令进 raw_patterns 供 deny 检查
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'CI=true git commit -m "test"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain('git commit -m "test"')
              expect(bashReq!.patterns).not.toContain('CI=true git commit -m "test"')
              expect(bashReq!.metadata.raw_patterns).toContain('CI=true git commit -m "test"')
              // #285：raw_patterns 保留完整原始命令，作为审计与硬拒绝证据
            }),
          )
        }),
      ),
    )

    it.live("omits multiple environment assignments from bash permission patterns [bash]", () =>
    // #285：多个 env 赋值全部剥离，pattern 只留 echo hello
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "FOO=1 BAR=2 echo hello",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain("echo hello")
              expect(bashReq!.patterns).not.toContain("FOO=1 BAR=2 echo hello")
              expect(bashReq!.metadata.raw_patterns).toContain("FOO=1 BAR=2 echo hello")
              // #285：raw_patterns 保留全部前缀赋值——顺序与原文一致，供 deny 规则精确匹配
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
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

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
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

  // #158：ssh 引号内 Unix 管道视为远程载荷，不触发本地兼容拦截
  for (const item of ps) {
    it.live(`does not reject Unix commands inside remote ssh string [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            // #158：应越过兼容检查进入 permission
            expect(
              yield* fail(
                { command: `ssh host "grep foo /tmp/file | sed 's/x/y/'"` },
                capture(requests, err),
              ),
            ).toMatchObject({ message: err.message })
          }),
        ),
      ),
    )
  }

  // #158：wsl 引号载荷同样放行
  for (const item of ps) {
    it.live(`does not reject Unix commands inside wsl string [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            // #158：wsl 与 ssh 同判：引号载荷不构成本地管道
            expect(
              yield* fail(
                { command: `wsl bash -lc "grep foo /tmp/file | head -40"` },
                capture(requests, err),
              ),
            ).toMatchObject({ message: err.message })
          }),
        ),
      ),
    )
  }

  // #158：本地管道 head 仍拦截，并提示 Select-Object
  // #158：错误文案必须含 local command 与 Select-Object -First N
  for (const item of ps) {
    it.live(`rejects local Unix pipeline head on PowerShell [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const exit = yield* fail({ command: "Write-Output one,two,three | head -1" }, ctx)
            expect(String((exit as any)?.message ?? exit)).toMatch(
              /local command uses Unix utility `head`.*Select-Object -First N/s,
            )
          }),
        ),
      ),
    )
  }
  // #197：验证 bash 权限元数据包含 shell action 证据——action_kind、command、cwd、shell 均须存在
  each("includes shell action evidence in bash permission metadata", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git status",
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

each("does not suggest broad wrapper prefixes for always-allow prompts", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "bash -lc 'git status'",
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "git branch -D feature/review",
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


  // #203：恢复 original 三组 PowerShell 回归——SSH 私钥路径门禁、gci 目录列举门禁、
  // #203：Auto 端到端 reviewer fail-closed（适配：PermissionV1 类型/Bun.write 建目录/两空格缩进）。
  for (const item of ps) {
    it.live(`asks for bash permission after PowerShell SSH private key path gate [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const fakeHome = yield* tmpdirScoped()
          // #203：Bun.write 自动建父目录，替代 original 的 fs.mkdir 依赖
          yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_rsa"), "fake private key"))
          yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_ed25519"), "fake private key"))
          yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_ecdsa"), "fake private key"))
          // #203：USERPROFILE 环境切换必须经 acquireUseRelease 还原，防止污染后续用例
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
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  yield* run(
                    {
                      // #203：三条私钥读命令一次执行，覆盖 id_rsa/ed25519/ecdsa 全部敏感文件名模式
                      command: String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ed25519" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ecdsa" -ErrorAction SilentlyContinue`,
                    },
                    capture(requests),
                  )

                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  const bashReq = requests.find((r) => r.permission === "bash")
                  expect(extDirReq).toBeDefined()
                  // #203：extDir 证据须携带完整 shell 上下文——precheck 的 shell-origin 分支依赖 command/cwd
                  expect(extDirReq!.metadata).toMatchObject({ action_kind: "shell", command: String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ed25519" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ecdsa" -ErrorAction SilentlyContinue`, cwd: projectRoot, agent: "build" })
                  // #203：shell 字段记录实际解释器，供证据回放与审计定位
                  expect(typeof extDirReq!.metadata.shell).toBe("string")
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
    // #203：gci/Get-ChildItem 在 FILES 集内，目录列举须触发 bash 门禁（precheck 单测不覆盖工具层）
    it.live(`asks for bash permission for PowerShell SSH directory listing [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: String.raw`Get-ChildItem -Path "$env:USERPROFILE\.ssh" -Force -ErrorAction SilentlyContinue`,
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(extDirReq).toBeDefined()
            expect(bashReq).toBeDefined()
            // #203：bash pattern 携带原始命令文本，证明门禁见到的是未改写的 PowerShell 命令
            expect(bashReq!.patterns.some((pattern) => pattern.includes("Get-ChildItem"))).toBe(true)
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    // #225：agent 标识统一小写 auto——与 agent key/name、metadata.agent 的生产比较保持同构
    reviewed.live(`routes auto PowerShell SSH private key access through reviewer [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const fakeHome = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(fakeHome, ".ssh", "id_rsa"), "fake private key"))
          const permission = yield* Permission.Service
          const ruleset: PermissionV1.Ruleset = [
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
              // #203：permission.ask 经 InstanceState 读项目配置，runIn 提供 InstanceRef
              runIn(
                projectRoot,
                Effect.gen(function* () {
                // #203：与 shell 工具产出的证据同构（上一组已锁定该 metadata 形状）；
                // #203：组1 锁定工具产出形状，本组用同构输入验证 Auto 链路（Tool.Context.ask 跨 env 类型不可行，分段覆盖）
                // #203：此处验证同一证据在 Auto 路由下经 precheck→reviewer 端到端 fail-closed。
                const err = yield* permission
                  .ask({
                    sessionID: ctx.sessionID,
                    // #203：目标 Request.tool 为 messageID/callID 对象（original 为字符串 tool 名），always 必填空集
                    tool: {
                      messageID: ctx.messageID,
                      callID: "call_auto_ssh_gate",
                    },
                    permission: "bash",
                    patterns: [String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa"`],
                    metadata: {
                      action_kind: "shell",
            agent: "auto",
                      command: String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue`,
                      cwd: projectRoot,
                      shell: item.shell,
                    },
                    always: [],
                    ruleset,
                  })
                  .pipe(
                    // #203：2 秒超时防 reviewer 挂起导致用例悬挂；超时即失败而非跳过
                    Effect.timeoutOrElse({
                      duration: "2 seconds",
                      orElse: () => Effect.fail(new Error("timed out waiting for reviewer denial")),
                    }),
                    Effect.flip,
                  )

                expect(err).toBeInstanceOf(PermissionV1.AutoDeniedError)
                expect(reviewedCalls).toBe(1)
                // #203：deny 不留 pending 项——fail-closed 不得以挂起请求形式等待用户
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

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
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
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
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
            // #108：F: 工作目录下 drive-relative 用例 flaky，直接跳过
            if (process.cwd().startsWith("F:")) return
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      // 相对盘符必须跟随临时目录，跨盘运行仍验证同一外部目录权限。
                      command: `Get-Content "${path.parse(tmp).root.slice(0, 2)}../outside.txt"`,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
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
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
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
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
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
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            directories: [outerTmp],
            patterns: [expected],
          })
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          // 在权限边界停止，测试真实 scanner 而不执行 reset/stash 写操作。
          for (const [command, write] of [
            ["git log --oneline -5", false],
            ["git -C repo reset --hard", true],
            ["git -C repo stash -m checkpoint", true],
            ["git -c key=stash stash -m list", true],
            ["git -C repo stash -mcheckpoint list", true],
            ["git --config-env key=ENV reset", true],
            ["git --git-dir=repo -C repo stash --message=checkpoint", true],
            ["git -C repo stash list", false],
            ["git -c key=value stash show", false],
          ] as const) {
            requests.length = 0
            const err = new Error("stop after permission")
            yield* fail({ command }, capture(requests, err))
            expect(requests.length).toBe(1)
            expect(requests[0].patterns).toContain(command)
            // 只读必须保留原 always 入口，不能通过把所有 Git 建议清空来使危险样例看似安全。
            expect(requests[0].always.length > 0).toBe(!write)
          }
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  // 裸--会使PowerShell grammar丢节点或命令段；以下保留事故与缺段形态的公开授权回归。
  for (const item of ps) {
    it.live(`asks for bash permission when bare -- separates git command arguments [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：修复前裸 -- 使 grammar 断裂，patterns 空集触发零 ask 直通。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `git commit -m "x" -- a.ts` },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：引号化后 command 节点恢复，git commit 进入审批 pattern。
              expect(bashReq!.patterns.some((p) => p.startsWith("git commit"))).toBe(true)
            }),
          )
        }),
      ),
    )
  }

  for (const item of ps) {
    it.live(`asks for bash permission for the incident commit shape with bare -- [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：生产事故逐字原形（多 -m+多路径+裸 --）——事故当日三次零 ask 的命令。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `git commit --only -m "a" -m "b" -- p1.txt p2.txt`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：事故原形（双 -m+多路径）完整解析后前缀恢复，非零节点兜底通道。
              expect(bashReq!.patterns.some((p) => p.startsWith("git commit"))).toBe(true)
            }),
          )
        }),
      ),
    )
  }

  // 精度锁：安全类 git log 形态修复后只恢复 ask，不升级为整体 cautious
  for (const item of ps) {
    it.live(`asks for bash permission for git log with bare -- without coarsening [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：git log 属只读安全类——修复不得借机把它升为 cautious 粗断言。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `git log --oneline -2 -- path` },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns.some((p) => p.startsWith("git log"))).toBe(true)
              // 600：分级断言交 precheck 既有测试；此处锁 ask 形态与前缀精度不变。
            }),
          )
        }),
      ),
    )
  }

  // 缺段锁（R1 审计 B-02）：紧邻分隔符的裸 `--` 不得使所在命令段从 patterns 消失
  for (const item of ps) {
    it.live(`keeps both command segments when bare -- is adjacent to a separator [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：分隔符 `;` 紧贴 -- 是最小丢段形态（token 边界含分隔符的原因）。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `git checkout --;git reset --hard`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：`;` 前裸 -- 修复前丢弃 git checkout 段——两段前缀都在才证明无丢段。
              expect(bashReq!.patterns.some((p) => p.startsWith("git checkout"))).toBe(true)
              expect(bashReq!.patterns.some((p) => p.startsWith("git reset"))).toBe(true)
            }),
          )
        }),
      ),
    )
  }

  // 兜底锁（零 command 节点残余失败）：未闭合引号命令仍须以原文 pattern 进入 ask
  for (const item of ps) {
    it.live(`falls back to raw-text pattern when parsing yields zero command nodes [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：未闭合引号是归一化后仍零节点的残余形态——兜底必须仍然 ask。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `git commit -m "unclosed`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：零节点兜底注入解析输入 trim 原文——非空 pattern 即非零 ask。
              expect(bashReq!.patterns.some((p) => p.trim().length > 0)).toBe(true)
            }),
          )
        }),
      ),
    )
  }

  // 三类豁免：引号内是数据，--%是保留字，--flag不满足独立token边界。
  for (const item of ps) {
    it.live(`keeps in-quote double dash untouched in permission pattern [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：引号状态机验证——引号内 token 属数据域，越过引号即破坏语义。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `echo "a -- b"` },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：引号内 -- 是数据；出现引号化痕迹即状态机越界改写。
              expect(bashReq!.patterns.some((p) => p.includes("a -- b"))).toBe(true)
              expect(bashReq!.patterns.some((p) => p.includes('"--"'))).toBe(false)
            }),
          )
        }),
      ),
    )
  }

  for (const item of ps) {
    it.live(`keeps stop-parsing sequence --% untouched in permission pattern [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：--% 后续 token 不经 PowerShell 解析——引号化会改变其语义。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `git push --% --force` },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：--% 是 PowerShell stop-parsing 保留字，sequel 豁免不改写。
              expect(bashReq!.patterns.some((p) => p.includes("--%"))).toBe(true)
              expect(bashReq!.patterns.some((p) => p.includes('"--%"'))).toBe(false)
              expect(bashReq!.patterns.some((p) => p.includes('"--"'))).toBe(false)
            }),
          )
        }),
      ),
    )
  }

  for (const item of ps) {
    it.live(`keeps flag-style dashes verbatim in permission pattern [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              // 600：同命令内 flag 与裸 -- 共存——只有独立 token 被引号化。
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `git log --oneline -2 -- path` },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              // 600：flag 形态 `--oneline` 原样保留；只有独立 `--` 被引号化，
              // 防止改写器扩大到带参形态（INV-05 第三类豁免）。
              expect(bashReq!.patterns.some((p) => p.includes("--oneline"))).toBe(true)
              expect(bashReq!.patterns.some((p) => p.includes('"--oneline"'))).toBe(false)
            }),
          )
        }),
      ),
    )
  }


  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(yield* fail({ command: "echo test > output.txt" }, capture(requests, err))).toMatchObject({
            message: err.message,
          })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  // #108：always 模式按 shell 选择命令，避免 Windows cmd/pwsh 硬编码 ls
  if (bash) {
    it.live("keeps redirects after removing environment assignments from permission pattern [bash]", () =>
    // #285：重定向不是前缀赋值，归属于命令本体——pattern 必须包含 > output.txt
      withShell(
        { label: "bash", shell: bash },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: "CI=true echo hello > output.txt" },
                  // #285：env 赋值 + 重定向混合场景验证 permissionPattern 拼接顺序：命令后接重定向
                  // （raw 集合则保留完整原文）
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain("echo hello > output.txt")
              // #285：parser 剥离 env 后，重定向作为后缀拼回 pattern，可复现真实命令
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
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const cmd = item.label === "cmd" ? "dir" : item.label === "powershell" || item.label === "pwsh" ? "Get-ChildItem" : "ls -la"
          const always = item.label === "cmd" ? "dir *" : item.label === "powershell" || item.label === "pwsh" ? "Get-ChildItem *" : "ls *"
          yield* run({ command: cmd }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe(always)
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
          // #215：数字字节跨 shell 保留 one\rtwo\rthree\nfinal\n 的真实控制字符。
          const progressBytes = [
            111, 110, 101, 13, 116, 119, 111, 13, 116, 104, 114, 101, 101, 10, 102, 105, 110, 97,
            108, 10,
          ]
          const script = `process.stdout.write(Buffer.from([${progressBytes.join(",")}]))`
          const text = `${bin} -e ${evalarg(script)}`
          const updates: string[] = []
          const result = yield* run(
            {
              command: PS.has(sh()) ? `& ${text}` : text,
              compress_output: false,
            },
            {
              ...ctx,
              metadata: (input) => Effect.sync(() => {
                const output = input.metadata?.output
                if (typeof output === "string") updates.push(output)
              }),
            },
          )

          expect(result.metadata.output).toContain("three")
          expect(result.metadata.output).toContain("final")
          expect(result.metadata.output).not.toContain("one")
          expect(result.metadata.output).not.toContain("two")
          expect(result.metadata.output).not.toContain("\r")
          // #215：Tool.wrap 会把 CR 转成字面量，须同时检查真实流式快照与转义残留。
          expect(result.metadata.output).not.toContain("\\x0d")
          expect(updates).toContain("three\nfinal")
          expect(updates.every((output) => !output.includes("\r") && !output.includes("\\x0d"))).toBe(true)
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
          // #215：boot\nworking\rESC[2Kdone\n 后退出 7，失败状态不改变屏幕语义。
          const clearLineBytes = [
            98, 111, 111, 116, 10, 119, 111, 114, 107, 105, 110, 103, 13, 27, 91, 50, 75, 100, 111,
            110, 101, 10,
          ]
          const script = `process.stdout.write(Buffer.from([${clearLineBytes.join(",")}])); process.exit(7)`
          const text = `${bin} -e ${evalarg(script)}`
          const updates: string[] = []
          const result = yield* run(
            {
              command: PS.has(sh()) ? `& ${text}` : text,
              compress_output: false,
            },
            {
              ...ctx,
              metadata: (input) => Effect.sync(() => {
                const output = input.metadata?.output
                if (typeof output === "string") updates.push(output)
              }),
            },
          )

          expect(result.metadata.exit).toBe(7)
          expect(result.metadata.output).toContain("boot")
          expect(result.metadata.output).toContain("done")
          expect(result.metadata.output).not.toContain("working")
          expect(result.metadata.output).not.toContain("\r")
          expect(result.metadata.output).not.toContain("\x1b")
          expect(result.metadata.output).not.toContain("\\x0d")
          expect(updates).toContain("boot\ndone")
          expect(updates.every((output) => !output.includes("\r") && !output.includes("\x1b") && !output.includes("\\x0d"))).toBe(true)
          expect(result.output).toContain("working")
          expect(result.output).toContain("done")
        }),
      ),
    15_000,
  )
})

describe("tool.shell background launch completion", () => {
  for (const selected of ps) {
    it.live(
      `returns after ${selected.label} launches a redirected background process`,
      () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const release = path.join(dir, "release")
          const done = path.join(dir, "done")
          const script = path.join(dir, "child.ps1")
          const out = path.join(dir, "out.txt")
          const err = path.join(dir, "err.txt")
          const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
          // release只由Tool返回后的测试清理放行；八秒上限让旧实现也能完成并给出明确red。
          // 后台任务始终使用自己的日志，避免把启动返回测试变成共享输出的寿命测试。
          yield* Effect.promise(() =>
            Bun.write(
              script,
              `
          $end = [DateTime]::UtcNow.AddSeconds(8)
          while (!(Test-Path ${literal(release)}) -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 20 }
          [Console]::Out.WriteLine('background complete')
          [Console]::Error.WriteLine('background error stream')
          [IO.File]::WriteAllText(${literal(done)}, 'done')
        `,
            ),
          )
          yield* Effect.gen(function* () {
            const result = yield* withShell(
              selected,
              runIn(
                dir,
                run({
                  command: `$p = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-File',${literal(script)} -RedirectStandardOutput ${literal(out)} -RedirectStandardError ${literal(err)} -WindowStyle Hidden -PassThru; Write-Output "started PID=$($p.Id)"`,
                  timeout: 15000,
                  description: "Launch background process",
                }),
              ),
            )
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toMatch(/^started PID=\d+\n$/)
            // 正常返回必须先于后台工作完成；不用最后一行文本或固定耗时猜测进程结束。
            expect(yield* Effect.promise(() => Bun.file(done).exists())).toBe(false)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Effect.promise(() => Bun.write(release, ""))
                while (!(yield* Effect.promise(() => Bun.file(done).exists()))) yield* Effect.sleep(20)
              }).pipe(Effect.timeout("10 seconds"), Effect.orDie),
            ),
          )
          expect(yield* Effect.promise(() => Bun.file(out).text())).toBe("background complete\r\n")
          expect(yield* Effect.promise(() => Bun.file(err).text())).toBe("background error stream\r\n")
        }),
      30000,
    )
  }
})

describe("tool.shell post-root lifetime", () => {
  // POSIX继续保留原EOF合同；Windows PowerShell由上面的启动返回用例约束前台寿命。
  for (const mode of process.platform === "win32" ? [] : (["abort", "timeout", "normal"] as const)) {
    it.live(`keeps ${mode} active after the root exits with output still open`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const root = yield* Deferred.make<void>()
        // 两个独立信号区分“root确已退出”与“consumer已有可交付文本”，不靠启动延迟推断顺序。
        const ready = yield* Deferred.make<void>()
        const controller = new AbortController()
        const spawner = yield* ChildProcessSpawner
        // 有限后代持有真实管道；最终业务输出与 root exit 均先于取消，避免测成前台 kill。
        // release 是正常退出信号，六秒上限仅保护失败的测试，不能参与成功断言。
        // 后代吸收取消后的broken pipe只是为了自然清理fixture，工具结果仍须报告取消。
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "holder.mjs"),
            `
        import fs from 'node:fs';
        process.stdout.on('error', () => {});
        process.stderr.on('error', () => {});
        console.log('HOLDER_READY');
        const end = Date.now() + 6000;
        while (!fs.existsSync('release') && Date.now() < end) await Bun.sleep(20);
        console.log('LATE_STDOUT');
        console.error('LATE_STDERR');
        fs.writeFileSync('done', '');
      `,
          ),
        )
        const command = `${bin} holder.mjs & printf 'ROOT_FINAL\\n'`
        const execute = runIn(
          dir,
          run(
            // 手动取消预算长于fixture寿命；deadline用独立预算，避免二者争胜掩盖取消回归。
            { command, timeout: mode === "timeout" ? 3000 : 15000, description: "Complete post-root output lifetime" },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                typeof input.metadata?.output === "string" && input.metadata.output.includes("HOLDER_READY")
                  ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            },
          ).pipe(
            Effect.provideService(ChildProcessSpawner, {
              ...spawner,
              // 只观察公开 exitCode，实际 spawn、输出与资源释放始终来自生产 adapter。
              spawn: (cmd) =>
                spawner
                  .spawn(cmd)
                  .pipe(
                    Effect.tap((handle) =>
                      Effect.forkScoped(handle.exitCode.pipe(Effect.andThen(Deferred.succeed(root, undefined)))),
                    ),
                  ),
            }),
          ),
        )
        const running = yield* Effect.forkScoped(execute)
        yield* Deferred.await(root)
        yield* Deferred.await(ready)
        // 正常路径显式放行晚到输出；取消与deadline路径必须在后代尚未放行时交付部分结果。
        if (mode === "normal") yield* Effect.promise(() => Bun.write(path.join(dir, "release"), ""))
        if (mode === "abort") controller.abort()
        const result = yield* Fiber.join(running).pipe(
          Effect.ensuring(Effect.promise(() => Bun.write(path.join(dir, "release"), ""))),
        )
        // 子进程用真实broken-pipe语义收尾；完成标记用于fixture清理，绝不参与工具的完成条件。
        // POSIX取消会终止整个进程组，后代不会再写done。
        if (mode === "normal") {
          yield* Effect.gen(function* () {
            while (!(yield* Effect.promise(() => Bun.file(path.join(dir, "done")).exists()))) yield* Effect.sleep(20)
          }).pipe(Effect.timeout("5 seconds"))
        }
        expect(result.output).toContain("ROOT_FINAL")
        if (mode === "normal") {
          // root之后两个流仍有真实字节，不能用退出事件代替EOF，也不能在正常路径截断读取。
          expect(result.output).toContain("LATE_STDOUT")
          expect(result.output).toContain("LATE_STDERR")
          expect(result.metadata.exit).toBe(0)
          return
        }
        // 取消交付已经捕获的结果，不等待未来 late 字节，也不把 root 的0误报成成功。
        expect(result.output).toContain(`reason="${mode === "abort" ? "user_abort" : "timeout"}"`)
        expect(result.output).not.toContain("LATE_STDOUT")
        expect(result.metadata.exit).toBeNull()
      }),
    )
  }

  for (const mode of ["exit", "output", "defect", "early-eof"] as const) {
    it.live(`observes ${mode} while coordinating process and output`, () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const failed = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const spawner = yield* ChildProcessSpawner
          const error = PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: mode,
            cause: new Error("lifetime probe failure"),
          })
          // OS错误通过公开spawner seam注入，避免依赖平台随机产生信号退出或管道读错误。
          // 另一完成条件保持未决，直接检验错误监督，而不是最终超时以后仍能看到同一错误。
          const failure = Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail(error)))
          const all =
            mode === "output"
              ? Stream.fromEffect(failure)
              : mode === "defect"
                ? Stream.fromEffect(Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.die(error))))
                : Stream.empty.pipe(Stream.ensuring(Deferred.succeed(failed, undefined)))
          // 合成handle仅注入合法adapter结果，PID不连接OS；虚拟kill不会触碰真实进程。
          const handle = makeHandle({
            pid: ProcessId(1),
            stdin: Sink.drain,
            stdout: all,
            stderr: Stream.empty,
            all,
            exitCode: mode === "exit" ? failure : Deferred.await(release).pipe(Effect.as(ExitCode(17))),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            // Shell只消费all；其他描述符按公开空流/空sink合同提供，不另造消费算法。
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
          const call = yield* run({
            command: "echo probe",
            timeout: 5000,
            description: "Observe complete process outcome",
          }).pipe(
            Effect.provideService(ChildProcessSpawner, { ...spawner, spawn: () => Effect.succeed(handle) }),
            Effect.exit,
            Effect.forkScoped,
          )
          if (mode === "early-eof") {
            // EOF不能让仍在运行的程序提前成功；释放root后仍应交付原生数值非零退出码。
            yield* Deferred.await(failed)
            // 窗口从真实EOF起算；输出结束时尚有异步收尾，单次即时poll会漏掉提前成功。
            expect(
              yield* Effect.raceAllFirst([
                Fiber.join(call).pipe(Effect.as("completed")),
                Effect.sleep(50).pipe(Effect.as("waiting for root")),
              ]),
            ).toBe("waiting for root")
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(call)
            if (Exit.isFailure(result)) return yield* result
            expect(result.value.metadata.exit).toBe(17)
            return
          }
          yield* Deferred.await(failed)
          // 一秒仅是错误已产生后的外层测试保护；不用于控制生产timer或猜测fixture就绪。
          const result = yield* Fiber.join(call).pipe(
            Effect.timeout("1 second"),
            // 测试失败也解开合成root的闸门，防止一个红测把整个测试进程挂住。
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("lifetime probe failure")
        }),
      ),
    )
  }

  it.live("cleans up a live process when its output consumer fails", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        let running: Effect.Effect<boolean, PlatformError.PlatformError> = Effect.succeed(true)
        const error = PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "read",
          cause: new Error("ready stream failed"),
        })
        // POSIX写出ready之前就忽略TERM，保证错误触发的scope释放真实经过强杀升级。
        // Windows沿现有tree kill；两者都验证失败返回前已释放存活root，而非只取消一个Promise。
        const command =
          process.platform === "win32"
            ? `& ${bin} -e 'console.log("READY"); setInterval(() => {}, 1000)'`
            : `trap '' TERM; printf 'READY\\n'; while :; do sleep 1; done`
        const selected = process.platform === "win32" ? ps.find((item) => item.label === "pwsh") : undefined
        if (process.platform === "win32" && !selected) throw new Error("pwsh is required for the live failure fixture")
        const execute = fail({ command, timeout: 5000, description: "Fail an active output consumer" }).pipe(
          Effect.provideService(ChildProcessSpawner, {
            ...spawner,
            spawn: (cmd) =>
              spawner.spawn(cmd).pipe(
                Effect.map((handle) => {
                  // 保存公开存活查询，在Tool返回之后检查实际root，而不是清理函数是否被调用。
                  running = handle.isRunning
                  // 使用真实字节作为故障触发点；继承原handle的kill、scope和exit观察。
                  const all = handle.all.pipe(
                    Stream.flatMap((bytes) =>
                      Buffer.from(bytes).includes("READY") ? Stream.fail(error) : Stream.make(bytes),
                    ),
                  )
                  return makeHandle({ ...handle, all })
                }),
              ),
          }),
        )
        const result = yield* selected ? withShell(selected, execute) : execute
        // 错误对象原样交付，同时root已终止；共同排除“快速丢弃异常但遗留进程”。
        expect(result).toBe(error)
        expect(yield* running).toBe(false)
      }),
    ),
  )

  it.live("starts its execution budget after the existing permission wait", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // 延迟本身是本例的审批行为，不是fixture readiness；超过命令预算后仍应正常执行。
        // 复用Context.ask边界，权限分类和真实reviewer模型均保持既有实现与既有测试。
        const result = yield* run(
          { command: "echo approved", timeout: 3000, description: "Run after approval" },
          {
            ...ctx,
            ask: () => Effect.sleep(3200),
          },
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output.trim()).toBe("approved")
      }),
    ),
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
              // POSIX 后代先忽略 TERM 再发布 readiness；主进程退出后仍会持有输出管道。
              // 保留原有输出触发取消及结果断言，验证强杀升级不能只等待主进程。
              command: process.platform === "win32"
                ? `echo before && sleep 30`
                : `sh -c 'trap "" TERM; echo before; sleep 30' & wait`,
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
          const result = yield* run({
            command: `sleep 60`,
            timeout: timeoutMs,
          })
          // [local-smark] timeout Notice 现在包含 elapsed_ms，不再以 /> 结尾
          expect(result.output).toContain(
            `<opencode_notice type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="${timeoutMs}"`,
          )
          expect(result.output).toContain('elapsed_ms="')
          expect(result.output).not.toContain('reason="exit"')
          // #289：abort/timeout notice 不带 exit reason——中止不是进程自身退出，防止状态混淆
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
          const tool = yield* initShell()
          // description 断言须与 RuntimeFlags 注入值一致，避免改超时值时断言漂移
          expect(tool.description).toContain(`commands will time out after ${timeoutMs}ms`)
          const result = yield* tool.execute(
            {
              command: `sleep 60`,
            },
            ctx,
          )
          // bashDefaultTimeoutMs 与 timeoutMs 保持同值，notice 的 timeout_ms
          // 在所有平台都与实际默认超时一致
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
            // #590：输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
            command: `echo stdout_msg && echo stderr_msg >&2`,
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
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  
  it.live("reports exit notice for empty successful output", () =>
  // #289：空输出成功（exit 0）仍需 notice——模型无法从空输出推断命令是否真的执行成功
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg("process.exit(0)")}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
        })

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("(no output)")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="info" reason="exit" exit_code="0"',
        )
        // #536：exit notice 只进模型面板；空成功的用户面板是精确占位符且无 notice。
        expect(result.metadata.output).toBe("(no output)")
        expect(result.metadata.output).not.toContain("opencode_notice")
      }),
    ),
  )

  it.live("reports exit notice for empty failed output", () =>
  // #289：空输出失败必须携带退出码，模型才能区分静默失败与结果丢失
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg("process.exit(42)")}`
        // #289：退出码 42 覆盖非 1 的任意错误码路径，验证 exit_code 原样透传
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
        })

        expect(result.metadata.exit).toBe(42)
        expect(result.output).toContain("(no output)")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="42"',
        )
        // #536：失败 notice 同样只进模型面板；用户面板不携带退出码散文。
        expect(result.metadata.output).toBe("(no output)")
        expect(result.metadata.output).not.toContain("opencode_notice")
      }),
    ),
  )

  it.live("reports exit notice for non-empty failed output without diagnostics", () =>
  // #289：非空但无诊断摘录的失败靠 exit notice 兜底，避免模型误读为成功产物
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const command = `${bin} -e ${evalarg("console.log(String.fromCharCode(112,108,97,105,110,32,111,117,116,112,117,116)); process.exit(7)")}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
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
          "console.error(String.fromCharCode(102,97,116,97,108,58,32,104,105,100,100,101,110,32,114,111,111,116,32,99,97,117,115,101))",
          "await new Promise((resolve) => setTimeout(resolve, 2100))",
          `for (let i = 0; i < ${Truncate.MAX_LINES + 500}; i++) console.log(String.fromCharCode(116,97,105,108,32,108,105,110,101,32) + i + String.fromCharCode(32) + String.fromCharCode(120).repeat(80))`,
          "process.exit(9)",
        ].join(";")
        const command = `${bin} -e ${evalarg(script)}`
        // #289：诊断场景脚本较慢（2.1s 等待根因行）且触发截断，15s 超时留足余量
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          // 这个用例只验证 tail 截断隐藏区会生成诊断附录；关闭压缩，并让尾部
          // 文本同时超过默认行数/字节阈值，避免平台输出差异让 root cause 仍可见。
          compress_output: false,
        })

        expect(result.metadata.exit).toBe(9)
        expect(result.output).toContain('<opencode_excerpt type="shell_high_signal"')
        expect(result.output).toContain("fatal: hidden root cause")
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
          "console.log(String.fromCharCode(102,97,116,97,108,58,32,118,105,115,105,98,108,101,32,114,111,111,116,32,99,97,117,115,101))",
          "process.exit(9)",
        ].join(";")
        const command = `${bin} -e ${evalarg(script)}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
        })

        expect(result.metadata.exit).toBe(9)
        expect(result.output).toContain("fatal: visible root cause")
        // 可见 fatal 不进入隐藏摘录，失败退出码仍需独立回放。
        expect(result.output).not.toContain("<opencode_excerpt")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9"',
        )
      }),
    ),
    15_000,
  )

  it.live("omits exit notice for non-empty successful output", () =>
  // #289：非空成功是正常路径，零噪音不加 notice
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          // #590：输出保真由 spawner 急切缓冲保证（INV-01），无需 sleep 保活补丁。
          command: `echo ok`,
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
            // #291：0.3 秒用于制造可观察的流式输出边界，避免依赖不同平台对
            // 相邻 echo 的管道 chunk 拆分；这些 chunk 在 Windows/CI 上可能被合并。
            command: `echo first && sleep 0.3 && echo second`,
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
            },
            {
              ...ctx,
              metadata: (input) => {
                const output = (input.metadata as { output?: string })?.output
                if (!output?.includes("final") || finalMetadataDelivered) return Effect.void

                // #291：“final” 是本用例的最后输出哨兵；延迟的 metadata 回调模拟
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
        })
        mustTruncate(result)
        // #282：total 用源码常量计算行数，锁定 total 与实际完整行数的一致性
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
          // #288：本用例只验证截断边界；重复字节默认会被 bash 压缩器折叠，
          // 导致压缩后的可见输出低于 byte limit，所以这里显式关闭压缩。
          compress_output: false,
        })
        mustTruncate(result)
        // 无换行日志必须报告诊断采样损失；producer 的原始文件仍保持完整字节数。
        expect(result.metadata.diagnosticDiscardedChars).toBeGreaterThan(0)
        const retained = result.metadata.outputPath
        if (typeof retained !== "string") throw new Error("expected retained raw output")
        const fs = yield* FSUtil.Service
        expect(yield* fs.readFileString(retained)).toBe("a".repeat(byteCount))
        // #282：单行超大输出的 total 固定为 1L——notice 行数口径与 tail 预览一致
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
        // #283：cmd 的 evalarg 使用双引号；数字构造保留原始内容及末尾换行。
        const code = "console.log(String.fromCharCode(48,49,50,51,52,53,54,55,56,57).repeat(2400))"
        const command = `${bin} -e ${evalarg(code)}`
        const result = yield* run({
          command: PS.has(sh()) ? `& ${command}` : command,
          compress_output: false,
        })

        mustTruncate(result)
        expect(result.output).toContain('<opencode_notice type="output_truncated" source="shell"')
        expect(result.output).toContain('total="1L/')
        expect(result.output).toContain('shown="tail 1L/')
        expect(result.output).toContain(`path="${result.metadata.outputPath}"`)
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
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
        // 小于截断限额的行内重复也要向模型广告原文路径，不能只藏在 metadata。
        const compacted = yield* run({ command: fill("bytes", 1000), compress_output: true })
        expect(compacted.metadata.compressed).toBe(true)
        expect(compacted.metadata.truncated).toBe(false)
        const retained = compacted.metadata.outputPath
        if (typeof retained !== "string") throw new Error("expected compacted raw output")
        expect(compacted.output).toContain(retained)
        const fs = yield* FSUtil.Service
        expect(yield* fs.readFileString(retained)).toBe("a".repeat(1000))
        // 真实 V1 caller 的短输出没有其它压缩命中，也必须脱敏并保留未修改 raw。
        const secret = "sk-abcdefghijklmnopqrstuvwxyz012345"
        const redacted = yield* run({ command: `echo ${secret}` })
        expect(redacted.output).toContain("<REDACTED_API-KEY>")
        expect(redacted.output).not.toContain(secret)
        expect(redacted.metadata).toMatchObject({ compressed: false, compressionSecretsRedacted: 1 })
        const rawPath = redacted.metadata.outputPath
        if (typeof rawPath !== "string") throw new Error("expected redacted raw output")
        expect(redacted.output).toContain(rawPath)
        expect(yield* fs.readFileString(rawPath)).toContain(secret)
        // 短CLIXML净增长时不标记压缩，但实际V1调用仍须返回解码正文和可读raw。
        const clixml = '<Objs><S S="Output">ordinary</S></Objs>'
        const program = `process.stdout.write(String.fromCharCode(${Array.from(clixml, (char) => char.charCodeAt(0)).join(",")}))`
        const command = `${bin} -e ${evalarg(program)}`
        const decoded = yield* run({ command: PS.has(sh()) ? `& ${command}` : command })
        expect(decoded.output).toContain("<high-entropy powershell-clixml>ordinary</high-entropy>")
        expect(decoded.metadata).toMatchObject({ compressed: false, compressionOriginalBytes: 39, compressionCompressedBytes: 55 })
        const clixmlPath = decoded.metadata.outputPath
        if (typeof clixmlPath !== "string") throw new Error("expected decoded raw output")
        expect(decoded.output).toContain(clixmlPath)
        expect(yield* fs.readFileString(clixmlPath)).toBe(clixml)
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
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})

// #128：Windows PowerShell 多编码 shell 输出（与 tip it.live 风格对齐）
describe("tool.shell windows multi-encoding", () => {
  if (process.platform !== "win32") return

  for (const item of ps) {
    it.live(
      `decodes UTF-8 box drawing output from Windows commands [${item.label}]`,
      () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const bash = yield* initBash()
                // #128：PS 写 UTF-8 盒线字符，验证 shell_encoding auto
                const result = yield* bash.execute(
                  {
                    command: `Write-Output "┌─ TARGET OUTPUT ──"; Write-Output "— delivered"`,
                  },
                  ctx,
                )
                expect(result.output).toContain("TARGET OUTPUT")
                expect(result.output).toContain("delivered")
                expect(result.output).not.toContain("\uFFFD")
              }),
            )
          }),
        ),
    )

    it.live(
      `decodes GB18030 legacy shell output from Windows commands [${item.label}]`,
      () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const bash = yield* initBash()
                // #128：模拟 OpenStandardOutput 写入 GBK 字节
                const result = yield* bash.execute(
                  {
                    command: `$bytes = [byte[]](0xD6,0xD0,0xCE,0xC4); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)`,
                  },
                  ctx,
                )
                expect(result.output).toContain("中文")
              }),
            )
          }),
        ),
    )
  }
})


// #130：javac CP936 诊断经 shell 字节路径应可读
describe("tool.shell CP936 diagnostics", () => {
  it.live(
    "decodes javac-style CP936 bytes through shell stdout",
    () =>
      withShell(
        { label: "default", shell: Shell.acceptable() },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const bash = yield* initBash()
              // 当前 Bun 直接写固定 CP936 字节，避免缺少 Python 或 shell 引号转换污染输入。
              const code = "process.stdout.write(Buffer.from([0x48,0x3a,0x5c,0x46,0x52,0x43,0x68,0x65,0x63,0x6b,0x5c,0x73,0x72,0x63,0x5c,0x76,0x65,0x72,0x69,0x66,0x79,0x63,0x6d,0x64,0x5c,0x56,0x65,0x72,0x69,0x66,0x79,0x43,0x6f,0x6d,0x6d,0x61,0x6e,0x64,0x2e,0x6a,0x61,0x76,0x61,0x3a,0x33,0x3a,0x20,0xbe,0xaf,0xb8,0xe6,0x3a,0x20,0x44,0x4f,0x4d,0xca,0xc7,0xc4,0xda,0xb2,0xbf,0xd7,0xa8,0xd3,0xc3,0x20,0x41,0x50,0x49,0x0a]))"
              const result = yield* bash.execute(
                {
                  command: `${PS.has(sh()) ? "& " : ""}${bin} -e ${evalarg(code)}`,
                },
                ctx,
              )
              expect(result.metadata.exit).toBe(0)
              expect(result.output).toContain("警告: DOM是内部专用 API")
            }),
          )
        }),
      ),
  )
})

// #130：保留 PS stderr 原生字节；Progress 不污染纯文本路径
describe("tool.shell windows PS stderr and progress", () => {
  if (process.platform !== "win32") return

  for (const item of ps) {
    it.live(
      // #130：PS stderr 必须仍是原始代码页字节
      `preserves native CP936 stderr bytes from PowerShell wrapper [${item.label}]`,
      () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const bash = yield* initBash()
                // #130：经 OpenStandardError 写 CP936，验证 3-6>&1 不预解码
                const result = yield* bash.execute(
                  {
                    command: `$bytes = [byte[]](0xBE,0xAF,0xB8,0xE6,0x3A,0x20,0x44,0x4F,0x4D,0xCA,0xC7,0xC4,0xDA,0xB2,0xBF,0xD7,0xA8,0xD3,0xC3,0x20,0x41,0x50,0x49,0x0A); [Console]::OpenStandardError().Write($bytes,0,$bytes.Length)`,
                  },
                  ctx,
                )
                expect(result.output).toContain("警告: DOM是内部专用 API")
                expect(result.output).not.toContain("\uFFFD")
              }),
            )
          }),
        ),
    )
  }

  for (const item of ps) {
    it.live(
      // #130：Progress 不得泄漏到主输出
      `keeps PowerShell output as plain text with Progress silenced [${item.label}]`,
      () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const bash = yield* initBash()
                // #130：Progress 静默 + Information 纯文本
                const result = yield* bash.execute(
                  {
                    command: `Write-Progress -Activity '部署' -Status '传输中' -PercentComplete 50; Write-Host '1/4 BUILD'; Write-Information '2/4 EXPORT'; Write-Host '3/4 TRANSFER'`,
                  },
                  ctx,
                )
                expect(result.output).toContain("1/4 BUILD")
                expect(result.output).toContain("2/4 EXPORT")
                expect(result.output).toContain("3/4 TRANSFER")
                expect(result.output).not.toMatch(/<Obj\b|<Objs\b|CLIXML/)
                expect(result.output).not.toContain("部署")
                expect(result.output).not.toContain("传输中")
              }),
            )
          }),
        ),
    )
  }

  // #207：SSH 远程路径不触发主机 external_directory——/etc/os-release 在 SSH 目标上读取不在 Windows 主机上
  for (const item of ps) {
    it.live(`does not ask for host external_directory for SSH remote paths [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail(
                {
                  // #207：/etc/os-release 在 SSH 目标上读取——SSH 与 WSL 共享远程载荷不变式：远程 POSIX 路径不应成为主机 external_directory 提示
                  command: "ssh example.com 'cat /etc/os-release | grep PRETTY_NAME'",
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
              timeout: 500,
            })

            expect(result.output).toContain("(no output)")
            expect(result.output).toContain('reason="timeout"')
            // [local-smark] 诊断提示应包含 block-buffering 说明
            expect(result.output).toContain("block-buffering")
            expect(result.output).toContain("--verbose")
            // #536：timeout notice 与 block-buffering 诊断都只进模型面板；
            // #536：空输出超时的用户面板是精确占位符，不含任何诊断散文。
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
            // timeout 用平台感知 timeoutMs：pwsh 冷启动 600ms+ 时 500ms 会在输出到达前触发，
            // emptyOutput=true 反而误追加 block-buffering 诊断，双断言皆败
            const result = yield* run({
              command: `echo started && sleep 60`,
              timeout: timeoutMs,
            })

            expect(result.output).toContain("started")
            expect(result.output).toContain('reason="timeout"')
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
            })

            expect(result.output).toContain("(no output)")
            // 正常退出（非 timeout）不应追加 block-buffering 诊断
            expect(result.output).not.toContain("block-buffering")
          }),
        ),
    )
  })

})
// #179：PowerShell ERROR 恢复节点上的本地 Unix 工具拒绝/放行
describe("tool.shell local command ERROR nodes (#179)", () => {
  // #179：ERROR 节点用例主要覆盖 Windows PS
  if (process.platform !== "win32") return
  // #179：无 PS 则跳过
  if (ps.length === 0) return

  for (const item of ps) {
    it.live(`rejects local Unix text utilities in PowerShell pipelines [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // #179：本地管道应拒绝 grep
            expect(
              yield* fail({
                command: "Write-Output ok | grep ok",
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
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            // #179：WSL 包装内允许 Unix 工具
            expect(
              yield* fail(
                {
                  command:
                    "Write-Host before; wsl.exe -d Ubuntu-22.04 -- bash -lc 'set -euo pipefail; echo \"WSL $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2-)\"'",
                },
                capture(requests, err),
              ),
            ).toMatchObject({ message: err.message })
          }),
        ),
      ),
    )
  }

  // #207：WSL 客户机管道内允许 Unix 工具——兼容性守卫必须保留命名空间边界
  for (const item of ps) {
    it.live(`allows Unix text utilities inside WSL sh payloads [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail(
                {
                  // #207：WSL 客户机管道不是本地 PowerShell 管道——兼容性守卫必须保留命名空间边界使 POSIX 工具在备用 OS shell 内有效
                  command: `wsl -d Ubuntu-22.04 -- sh -lc 'ps -ef | grep "[d]drescue"'`,
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

  // #207：WSL 挂载路径不触发主机 external_directory——客户机路径不应被 Windows 路径解析伪造为主机路径
  for (const item of ps) {
    it.live(`does not ask for host external_directory for WSL mount paths [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail(
                {
                  // #207：/mnt/rescue 位于 WSL 客户机文件系统中——映射到 Windows 路径解析会伪造主机路径如 F:\mnt\rescue
                  command:
                    "wsl -d Ubuntu-22.04 -- sh -lc \"sudo mkdir -p /mnt/rescue && sudo mount -t exfat /dev/sde3 /mnt/rescue && mkdir -p /mnt/rescue/LexarE300_rescue && df -h /mnt/rescue && lsblk -o NAME,SIZE,FSTYPE,LABEL,RO,TYPE,MOUNTPOINTS /dev/sdc /dev/sde\"",
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

  // #207：WSL 载荷后的本地管道仍受兼容性检查——尾部 grep 必须保持为本地命令
  for (const item of ps) {
    it.live(`rejects Unix text utilities after WSL payloads in local pipelines [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            expect(
              yield* fail({
                // #207：WSL 调用后的管道是主机 PowerShell 管道边界——只有引号内 echo ok 属于客户机
                command: "wsl -d Ubuntu-22.04 -- sh -lc 'echo ok' | grep ok",
              }),
            ).toMatchObject({
              message: expect.stringContaining(`The current shell is ${item.label}`),
            })
          }),
        ),
      ),
    )
  }

  // #207：WSL 载荷后的本地文件读取仍需 external_directory——主机文件系统访问不受客户机范围影响
  for (const item of ps) {
    it.live(`asks for host external_directory after WSL payloads in local pipelines [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail(
                {
                  // #207：WSL 客户机载荷在主机管道前结束——后续本地文件读取仍是主机文件系统访问
                  command: `wsl -d Ubuntu-22.04 -- sh -lc 'echo ok' | Get-Content ${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
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

  // #207：SSH 载荷后的本地管道与 WSL 相同——引号内远程命令可用 POSIX 工具，本地管道仍受兼容性检查
  for (const item of ps) {
    it.live(`rejects Unix text utilities after SSH payloads in local pipelines [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            expect(
              yield* fail({
                // #207：SSH 远程命令可用 POSIX 工具，但 SSH 调用后的 PowerShell 管道是本地的
                command: "ssh example.com 'echo ok' | grep ok",
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
    // #207：cmd.exe 中单 & 启动另一个本地命令——WSL 客户机范围必须在分隔符前停止
    it.live("rejects Unix text utilities after WSL payloads in cmd command chains [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            expect(
              yield* fail({
                // #207：cmd.exe 的 & 分隔符后尾部 grep 仍受现有 cmd Unix 工具拒绝覆盖
                command: 'wsl -d Ubuntu-22.04 -- sh -lc "echo ok" & grep ok',
              }),
            ).toMatchObject({
              message: expect.stringContaining("The current shell is cmd"),
            })
          }),
        ),
      ),
    )

    // #207：cmd & 分隔符后的 TYPE 命令读取 Windows 主机文件系统——仍需 external_directory
    it.live("asks for host external_directory after WSL payloads in cmd command chains [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const err = new Error("stop after permission")
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail(
                {
                  // #207：WSL 命令在 cmd & 分隔符前结束——TYPE 读取 Windows 主机文件系统
                  command: `wsl -d Ubuntu-22.04 -- sh -lc "echo ok" & TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
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
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            // #179：SSH 远程串内允许 Unix 工具
            expect(
              yield* fail(
                {
                  command: "ssh example.com 'cat /etc/os-release | grep PRETTY_NAME'",
                },
                capture(requests, err),
              ),
            ).toMatchObject({ message: err.message })
          }),
        ),
      ),
    )
  }
})
// #129：PowerShell 输出保持纯文本（Information 流可见、无 CLIXML 噪声）
describe("tool.shell windows plain text", () => {
  if (process.platform !== "win32") return

  for (const item of ps) {
    it.live(
      `keeps PowerShell output as plain text [${item.label}]`,
      () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const bash = yield* initBash()
                // #129：Write-Host + Write-Information 应保持纯文本
                const result = yield* bash.execute(
                  {
                    command: `Write-Host '1/4 BUILD'; Write-Information '2/4 EXPORT'; Write-Host '3/4 TRANSFER'`,
                  },
                  ctx,
                )
                expect(result.output).toContain("1/4 BUILD")
                expect(result.output).toContain("2/4 EXPORT")
                expect(result.output).toContain("3/4 TRANSFER")
                expect(result.output).not.toMatch(/<Obj\b|<Objs\b|CLIXML/)
              }),
            )
          }),
        ),
    )
  }
})


// #126：非 Windows 也可用的 UTF-16LE 字节输出解码路径
describe("tool.shell text decoding", () => {
  it.live(
    "decodes raw UTF-16LE output from Windows-style byte streams",
    () =>
      withShell(
        { label: "default", shell: Shell.acceptable() },
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const bash = yield* initBash()
              // 写出 UTF-16LE 中文再读回，验证 createAutoTextDecoder 路径
              // 非 Windows 用当前 Bun 写原始字节；Windows PowerShell 保留原生 UTF-16LE producer。
              const code = `process.stdout.write(Buffer.from([${Array.from(Buffer.from("默认分发: Ubuntu-22.04", "utf16le"))}]))`
              const result = yield* bash.execute(
                {
                  // #126：混入 ASCII 以触发无 BOM UTF-16LE 的 NUL 启发式（纯中文无 NUL）
                  command: PS.has(sh())
                    ? '$bytes = [System.Text.Encoding]::Unicode.GetBytes("默认分发: Ubuntu-22.04"); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)'
                    : `${bin} -e ${evalarg(code)}`,
                },
                ctx,
              )
              expect(result.metadata.exit).toBe(0)
              expect(result.output).toContain("默认分发: Ubuntu-22.04")
              expect(result.output).not.toContain("\u0000")
              expect(result.output).not.toContain("\uFFFD")
            }),
          )
        }),
      ),
  )
})


// [local-smark] execution notice policy 纯函数测试：不依赖真实子进程，
// 确定性验证 Bash outcome 优先级、elapsed_ms 和 120 秒阈值
describe("tool.shell execution notice policy", () => {
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

  test("formatLongExecutionNotice 119999ms 返回 undefined", () => {
    expect(formatLongExecutionNotice("tool", 119999)).toBeUndefined()
  })

  test("formatLongExecutionNotice 120000ms 返回 completed", () => {
    const notice = formatLongExecutionNotice("tool", 120000)
    expect(notice).toContain('reason="completed"')
    expect(notice).toContain('elapsed_ms="120000"')
  })
})

describe.skipIf(process.platform !== "win32")("tool.shell native script fidelity", () => {
  for (const item of ps) {
    it.live(`reports final PowerShell status with native exit codes [${item.label}]`, () =>
      withShell(item, runIn(projectRoot, Effect.gen(function* () {
        // 独立状态常量覆盖cmdlet失败、native码、成功恢复和显式控制流。
        const cases = [
          { command: "Write-Error 'probe'", exit: 1 },
          { command: "opencode_missing_command_for_status_probe", exit: 1 },
          { command: "cmd /d /c exit 7; Write-Output recovered", exit: 0 },
          { command: "cmd /d /c exit 0; Write-Error 'probe'", exit: 1 },
          { command: "cmd /d /c exit 7; Write-Error 'probe'", exit: 7 },
          { command: "cmd /d /c exit 9", exit: 9 },
          { command: "exit 42", exit: 42 },
          { command: "throw 'probe'", exit: 1 },
          { command: "param([string]$value = 'ok'); Write-Output $value", exit: 0 },
          { command: "Write-Information 'probe'", exit: 0 },
        ]
        for (const entry of cases) {
          const result = yield* run({ command: entry.command })
          expect(result.metadata.exit).toBe(entry.exit)
          // 模型收到同一准确退出码和真实shell名称，便于按正确方言修正错误。
          if (entry.exit !== 0) {
            expect(result.output).toContain(`exit_code="${entry.exit}"`)
            expect(result.output).toContain(`shell="${item.label}"`)
          }
        }
      }))), 30_000)
  }

  for (const item of ps) {
    it.live(`preserves native Python quote codepoints [${item.label}]`, () =>
      withShell(item, runIn(projectRoot, Effect.gen(function* () {
        // String.raw保留测试需要的真实反斜杠，避免JS先消耗转义而测成另一条命令。
        const command = String.raw`python -B -c "x=[ord(c) for c in r'\""']; print(x)"`
        expect([...command].filter((char) => char === "\\")).toHaveLength(1)
        const result = yield* run({ command })
        // 92和34分别是反斜杠、双引号；直接调用两版PowerShell的独立探针给出原生预期。
        // 5.1的Legacy binder消费反斜杠，7保持该字符；Harness忠实保留各自语言语义。
        expect(result.metadata.exit).toBe(0)
        expect(result.output.trim()).toBe(item.label === "powershell" ? "[34]" : "[92, 34]")
        // 删除内容改写后，新调用保持原命令身份且不再写adaptation标签。
        expect(result.metadata).not.toHaveProperty("commandAdaptation")
      }))), 30_000)
  }
})

// 字面块把源码与本层插值区分开，两个PowerShell版本均可通过程序原有stdin接口执行。
describe.skipIf(process.platform !== "win32")("tool.shell native Python inputs", () => {
  for (const item of ps) {
    it.live(`preserves Python source quotes through literal stdin [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `@'\nprint('{"key":1}')\n'@ | python -`,
            })
            expect(result.metadata.exit).toBe(0)
            // JSON引号由Python字符串承载，PowerShell字面块保留源码中的引号。
            expect(result.output).toContain('{"key":1}')
            expect(result.metadata).not.toHaveProperty("commandAdaptation")

            // 静态绝对路径保持调用者选定的解释器，stdout给出实际程序身份。
            const interpreter = Bun.which("python")
            if (!interpreter) throw new Error("Python is required for native shell tests")
            const pathResult = yield* run({
              command: `@'\nimport sys; print(sys.executable); print('{"path":1}')\n'@ | & '${interpreter.replaceAll("'", "''")}' -`,
            })
            expect(pathResult.metadata.exit).toBe(0)
            expect(pathResult.output).toContain('{"path":1}')
            // 输出路径同时验证带空格的静态调用入口及解释器身份。
            expect(pathResult.output.toLowerCase().replaceAll("\\", "/")).toContain(interpreter.toLowerCase().replaceAll("\\", "/"))
            expect(pathResult.metadata).not.toHaveProperty("commandAdaptation")
          }),
        ),
      ),
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
              command: `@'\nprint('{"key":1}'); print(2)\n'@ | python -`,
            })
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain('{"key":1}')
            expect(result.output).toContain("2")
            expect(result.metadata).not.toHaveProperty("commandAdaptation")
          }),
        ),
      ),
      30_000,
    )
  }

  // 双引号明确请求本层展开；与字面块测试配对，覆盖两种不同的调用意图。
  for (const item of ps) {
    it.live(`applies requested PowerShell expansion in python source [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `python -c "s='$(Write-Output EXPANDED)'; print(s)"`,
            })
            expect(result.metadata.exit).toBe(0)
            expect(result.output.trim()).toBe("EXPANDED")
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
            // 同一字面块同时保留Unicode和JSON引号，验证UTF-8环境与正文传递。
            const result = yield* run({
              command: `@'\nprint('{"k":"v"} 汉字')\n'@ | python -`,
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
            })
            // 复合命令交给shell原生顺序执行，保持原始命令身份。
            expect(result.metadata).not.toHaveProperty("commandAdaptation")
            expect(result.output).toContain("1")
            expect(result.output).toContain("done")
          }),
        ),
      ),
      30_000,
    )
  }

  // conda保留原环境选择；在权限处中断，只检查原始命令证据。
  for (const item of ps) {
    it.live(`preserves conda command evidence without execution [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            const stop = new Error("stop before conda execution")
            expect(
              yield* fail(
                {
                  command: String.raw`conda run -n agent python -c "print('{\"key\":1}')"`,
                },
                capture(requests, stop),
              ),
            ).toMatchObject({ message: stop.message })
            const metadata = requests.find((request) => request.permission === "bash")?.metadata
            expect(metadata?.command).toBe(String.raw`conda run -n agent python -c "print('{\"key\":1}')"`)
            expect(metadata).not.toHaveProperty("inline_scripts")
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
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const stop = new Error("stop before unsupported boundary")
              expect(yield* fail({ command }, capture(requests, stop))).toMatchObject({
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

  // 真实Tool依次经过两个门禁，危险源码仅分类；在第二个门禁停止以证明执行尚未发生。
  for (const item of ps) {
    it.live(`classifies original literal source in both permission gates [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            const outside = yield* tmpdirScoped()
            const command = "@'\nimport os; os.remove('example.tmp')\n'@ | python -"
            const stop = new Error("stop before source execution")
            const result = yield* fail({ command, workdir: outside }, {
              ...ctx,
              ask: (request) => Effect.gen(function* () {
                requests.push(request)
                if (request.permission === "bash") return yield* Effect.die(stop)
              }),
            })
            expect(result.message).toBe(stop.message)
            expect(requests.map((request) => request.permission)).toEqual(["external_directory", "bash"])
            for (const request of requests) {
              // 两个门禁都从同一正文取得源码风险，专属附加源码已退出请求合同。
              expect(request.metadata.command).toBe(command)
              expect(request.metadata).not.toHaveProperty("inline_scripts")
              const risk = yield* Effect.promise(() => PermissionPrecheck.evaluate({ permission: request.permission, patterns: request.patterns, metadata: request.metadata }))
              expect(risk.level).toBe("cautious")
            }
          }),
        ),
      ),
      30_000,
    )
  }
})


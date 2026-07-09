import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
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
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"

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
          // 单引号内的内容不应被 shell 二次展开；管道要求 shell 进程而非直接 exec
          // sleep 0.01 防止 macOS CI 上 echo|tr 管道退出过快导致 stdout 竞态
          //（detached:true + Bun 调度抖动，与 "basic" 测试同款问题）
          const result = yield* run({
            command: "echo 'hello world' | tr a-z A-Z; sleep 0.01",
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
          expect(res.output).toContain('<opencode_notice type="execution" source="shell" severity="warning" reason="user_abort" />')
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
          expect(result.output).toContain(
            `<opencode_notice type="execution" source="shell" severity="warning" reason="timeout" timeout_ms="${timeoutMs}" />`,
          )
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
            // sleep 0.01 防止 macOS CI 上 echo 退出过快导致 stdout 管道竞态
            command: `echo stdout_msg && echo stderr_msg >&2; sleep 0.01`,
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
          '<opencode_notice type="execution" source="shell" severity="info" reason="exit" exit_code="0" />',
        )
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
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="42" />',
        )
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
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="7" />',
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
        expect(result.output).toContain("<bash_high_signal_excerpt>")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9" />',
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
        expect(result.output).not.toContain("<bash_high_signal_excerpt>")
        expect(result.output).toContain(
          '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9" />',
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
          // sleep 0.01 防止 macOS CI 上 echo 退出过快导致 stdout 管道竞态
          command: `echo ok; sleep 0.01`,
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


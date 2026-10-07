import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WindowsShellOutput } from "@opencode-ai/core/windows-shell-output"
import { testEffect } from "../lib/effect"

const live = CrossSpawnSpawner.defaultLayer
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe("cross-spawn spawner", () => {
  if (process.platform === "win32") {
    for (const delayed of [false, true]) {
      fx.live(`drains owned output with ${delayed ? "late subscription" : "slow consumption"}`, () =>
        Effect.gen(function* () {
          const size = delayed ? 16384 : 2097152
          const command = WindowsShellOutput.mark(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                `process.stdout.write(Buffer.alloc(${size},65)); process.stderr.write(Buffer.alloc(${size},66)); process.exitCode=${delayed ? 17 : 0}`,
              ],
              { stdin: "ignore" },
            ),
          )
          const handle = yield* command
          // 小输出先让root退出，再订阅，验证冻结额度保留尚在内核中的字节。
          // 大输出用真实背压跨越多轮读取，避免仅验证最后一个可见buffer。
          if (delayed) yield* handle.exitCode
          const output = yield* Effect.all(
            [handle.stdout, handle.stderr].map((stream) =>
              Stream.runCollect(stream.pipe(Stream.tap(() => (delayed ? Effect.void : Effect.sleep(2))))).pipe(
                Effect.map((chunks) => Buffer.concat(chunks)),
              ),
            ),
            { concurrency: "unbounded" },
          )
          expect(output[0]).toEqual(Buffer.alloc(size, 65))
          expect(output[1]).toEqual(Buffer.alloc(size, 66))
          expect(yield* handle.exitCode).toBe(ChildProcessSpawner.ExitCode(delayed ? 17 : 0))
        }),
      )
    }
    fx.live("releases owned pending reads when a consumer stops early", () =>
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* WindowsShellOutput.mark(
              ChildProcess.make(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
                stdin: "ignore",
              }),
            )
            // 取得真实输出后结束scope；stderr此时仍有pending read，不能提前释放OVERLAPPED。
            yield* Stream.runCollect(handle.stdout.pipe(Stream.take(1)))
            return handle.pid
          }),
        )
        expect(alive(pid)).toBe(false)
      }),
    )
    fx.live("releases owned capture after a real spawn failure", () =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
          Effect.promise(() => value[Symbol.asyncDispose]()),
        )
        const executable = path.join(dir.path, "broken.exe")
        yield* Effect.promise(() => fs.writeFile(executable, "not an executable"))
        // 现存exe交给OS启动后失败；避开cross-spawn对找不到命令时启动cmd的既有行为。
        // 管道已取得，创建失败仍须沿原错误链返回并释放本次资源。
        const result = yield* Effect.exit(
          Effect.scoped(WindowsShellOutput.mark(ChildProcess.make(executable, [], { stdin: "ignore" })).asEffect()),
        )
        expect(Exit.isFailure(result)).toBe(true)
      }),
    )
    fx.live("keeps concurrent owned capture scopes independent", () =>
      Effect.gen(function* () {
        // 两次同时创建的pipe和额度彼此独立，不能复用可写的native buffer或关闭另一次调用。
        const values = yield* Effect.all(
          ["first", "second"].map((value) =>
            Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* WindowsShellOutput.mark(
                  ChildProcess.make(process.execPath, ["-e", `process.stdout.write('${value}')`], { stdin: "ignore" }),
                )
                return yield* decodeByteStream(handle.stdout)
              }),
            ),
          ),
          { concurrency: "unbounded" },
        )
        expect(values).toEqual(["first", "second"])
      }),
    )
    fx.live("runs marked commands inside an isolated capture host", () =>
      Effect.gen(function* () {
        const command = WindowsShellOutput.mark(
          ChildProcess.make(process.execPath, ["-e", "console.log(process.ppid)"], { stdin: "ignore" }),
        )
        const handle = yield* command
        const out = yield* decodeByteStream(handle.stdout)
        // 隔离验收：真实命令的直接父进程必须是本次调用独占的 capture host；
        // 等于测试进程自身意味着原生捕获仍与共享宿主同地址空间，单一原生故障会拖死全部 Session。
        expect(out).not.toBe(String(process.pid))
        expect(Number(out)).toBeGreaterThan(0)
      }),
    )
  }

  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        // macOS can report /private/var for /var, and Windows runners can report
        // an 8.3 short path such as RUNNER~1. Normalize both sides through the
        // filesystem so this test asserts the spawned cwd, not its display form.
        const expected = yield* Effect.promise(() => fs.realpath(tmp.path))
        const actual = yield* Effect.promise(() => fs.realpath(out))
        expect(path.normalize(actual)).toBe(path.normalize(expected))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" }).asEffect(),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        // js() 写手替代 echo：Windows 无 echo.exe，cross-spawn 回退 cmd 包装会对
        // 参数加引号，输出含字面引号使断言平台分叉；node 写 stdout 字节确定。
        const handle = yield* js('process.stdout.write("hello from stdout")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("output retention across subscription timing", () => {
    // INV-01：快退写手 + exit 后订阅是「写入↔订阅」窗口的最对抗性排序；
    // 惰性订阅下该形态实测确定性丢失输出（Windows 10/10、macOS CI basic 红），
    // 急切缓冲后必须完整保留。fx.live（实时钟）+ 显式 30s 预算：
    // packages/core 裸跑无 canonical --timeout，循环 10 次实测 ~2.5s，
    // 5s 默认仅 2 倍余量。
    fx.live(
      "retains fast-exit stdout when subscription happens after exit",
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 10; attempt++) {
          const handle = yield* js(`process.stdout.write('instant-${attempt}')`)
          yield* handle.exitCode
          expect(yield* decodeByteStream(handle.stdout)).toBe(`instant-${attempt}`)
        }
      }),
      30_000,
    )
  })

  describe("exit signal decoupled from stdio drain", () => {
    // INV-06：消费者停止读取且输出超过 tap 缓冲时，kill 后 'close'（= exit + stdio 排干）
    // 不会到来；kill/exitCode/scope finalizer 必须由进程死亡（'exit'）驱动、有界完成。
    // INV-07：exit 完成后 tap 缓冲仍可读取开头字节——保真语义不回归。
    // 显式 20s 预算：修复前该形态确定性挂死（scope finalizer 同源等待），
    // 预算把挂死转化为可诊断的红而不是冻结运行器。
    fx.live(
      "resolves kill and exitCode when backpressured output is never drained",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("x".repeat(200_000)); process.stdout.write("y".repeat(200_000))')
        yield* Effect.sleep(500)
        yield* handle.kill().pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("kill did not resolve after process death")),
          }),
          Effect.orDie,
        )
        const chunks: string[] = []
        yield* Stream.runForEach(Stream.decodeText(handle.stdout), (bytes) =>
          Effect.sync(() => {
            chunks.push(bytes.toString())
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("stdout did not end after exit")),
          }),
        )
        expect(chunks.join("")).toContain("x")
      }),
      20_000,
    )
  })

  describe("capture scope ownership", () => {
    for (const mode of ["unsubscribed", "interrupted"]) {
      fx.live(
        `releases captured readers when an ${mode} scope ends`,
        Effect.gen(function* () {
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const release = path.join(tmp.path, "release")
          const result = path.join(tmp.path, "result")
          const file = path.join(tmp.path, "holder.cjs")
          // 后代只在测试放行后写入，避免把进程启动快慢误当作读端释放。
          // 微小同步写入直接验证实际管道行为，不观察私有 tap 或监听器数量。
          const child = [
            "const fs = require('node:fs')",
            "const timer = setInterval(() => {",
            `  if (!fs.existsSync(${JSON.stringify(release)})) return`,
            "  clearInterval(timer)",
            "  clearTimeout(limit)",
            "  const results = [1, 2].map(fd => {",
            "    try { fs.writeSync(fd, 'late'); return 'open' } catch { return 'closed' }",
            "  })",
            // 原子发布完整结果，避免文件刚创建尚未写完时被轮询读到。
            `  fs.writeFileSync(${JSON.stringify(result + ".tmp")}, results.join('|'))`,
            `  fs.renameSync(${JSON.stringify(result + ".tmp")}, ${JSON.stringify(result)})`,
            "}, 20)",
            // 有限寿命只负责失败后的自然清理，不用于判定 scope 应何时完成。
            "const limit = setTimeout(() => clearInterval(timer), 5000)",
            "fs.writeSync(1, 'ready')",
            "process.send('ready')",
          ].join("\n")
          yield* Effect.promise(() => fs.writeFile(file, child))
          yield* Effect.scoped(
            Effect.gen(function* () {
              // Windows 后代需独立存活，否则 root 的退出本身就结束 fixture，掩盖泄漏。
              // IPC ready 保证后代已建立管道；放行文件才允许它尝试晚到写入。
              const handle = yield* js(
                `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(file)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); child.once('message', () => { child.disconnect(); child.unref() })`,
              )
              if (mode === "interrupted") {
                // 先消费真实 ready 字节再中断，保证覆盖已订阅 consumer 的释放路径。
                // 只停止 tap 不会关闭原读端；随后同一晚到写入必须仍能揭示这个缺口。
                const ready = yield* Deferred.make<void>()
                const reader = yield* Stream.runForEach(handle.all, () => Deferred.succeed(ready, undefined)).pipe(
                  Effect.forkScoped,
                )
                yield* Deferred.await(ready)
                yield* Fiber.interrupt(reader)
              }
              // root 已退出，但后代仍持有写端；scope 才是 capture 的所有权边界。
              expect(yield* handle.exitCode).toBe(ChildProcessSpawner.ExitCode(0))
            }),
          )
          // 无订阅也必须释放 eager capture；放行后再检查两条真实管道的写入结果。
          yield* Effect.promise(() => fs.writeFile(release, "go"))
          yield* Effect.gen(function* () {
            while (!(yield* Effect.promise(() => Bun.file(result).exists()))) yield* Effect.sleep(20)
          }).pipe(Effect.timeout("5 seconds"))
          expect(yield* Effect.promise(() => fs.readFile(result, "utf8"))).toBe("closed|closed")
        }),
        15_000,
      )
    }

    fx.live(
      "keeps another scope's stdout and stderr open",
      Effect.gen(function* () {
        const release = yield* Deferred.make<Uint8Array>()
        // stdin 是另一个 scope 的因果闸门；关闭第一个 scope 后才允许第二个写出结果。
        // 同一 spawner service 的释放必须只作用于自己的 capture，不能误关并行调用。
        const other = yield* js(
          "process.stdin.once('data', data => { process.stdout.write('out:' + data); process.stderr.write('err:' + data); process.stdin.destroy() })",
          { stdin: Stream.fromEffect(Deferred.await(release)) },
        )
        yield* Effect.scoped(
          js("process.stdout.write('first')")
            .asEffect()
            .pipe(Effect.flatMap((handle) => handle.exitCode)),
        )
        yield* Deferred.succeed(release, Buffer.from("still open"))
        const output = yield* decodeByteStream(other.all)
        expect(output).toContain("out:still open")
        expect(output).toContain("err:still open")
      }),
      15_000,
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    for (const [stubborn, exited] of process.platform === "win32"
      ? []
      : [
          [false, true],
          [true, true],
          [false, false],
          [true, false],
        ])
      fx.live(
        `reaps a POSIX descendant when cancelling (stubborn=${stubborn}, rootExited=${exited})`,
        () =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<{ root: number; child: number }>()
            const running = yield* Effect.forkScoped(
              Effect.scoped(
                Effect.gen(function* () {
                  // 同时覆盖取消前root已退、以及收到TERM才退出；后者不能让宽限提前结算。
                  const script = `${stubborn ? 'process.on("SIGTERM", () => {});' : ""} console.log(process.pid); setInterval(() => {}, 1000)`
                  const handle = yield* ChildProcess.make(
                    "/bin/sh",
                    ["-c", `"${process.execPath}" -e '${script}' &${exited ? "" : " wait"}`],
                    {
                      stdin: "ignore",
                      forceKillAfter: 100, // 短宽限只控制信号升级；慢机退出由gone轮询观察，不要求100ms内完成。
                    },
                  )
                  if (exited) expect(Number(yield* handle.exitCode)).toBe(0)
                  const pid = Number(yield* decodeByteStream(handle.stdout.pipe(Stream.take(1))))
                  expect(yield* handle.isRunning).toBe(!exited)
                  yield* Deferred.succeed(ready, { root: Number(handle.pid), child: pid })
                  yield* Effect.never
                }),
              ),
            )
            const owned = yield* Deferred.await(ready)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                try {
                  process.kill(owned.child, "SIGKILL")
                } catch {}
              }),
            )
            expect(alive(owned.child)).toBe(true)
            yield* Fiber.interrupt(running)
            // 先观察生产finalizer的回收结果，再由fixture兜底清理，避免测试主动kill造成假绿。
            expect(yield* Effect.promise(() => gone(owned.child))).toBe(true)
            // root与后代分别核验，root先消失不能冒充整个进程组已经回收。
            expect(yield* Effect.promise(() => gone(owned.root))).toBe(true)
          }),
        15000,
      )

    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { OPENCODE_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("OPENCODE_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
})

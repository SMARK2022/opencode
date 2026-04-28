import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { TuiThreadCommand, resolveThreadDirectory, discoverOrSpawnDaemon } from "../../../src/cli/cmd/tui"
import type { DiscoverDaemonDeps } from "../../../src/cli/cmd/tui"
import { resolveNetworkOptionsNoConfig } from "../../../src/cli/network"
import { ServerLock } from "../../../src/cli/tui/server-lock"
import { EventClients } from "@opencode-ai/server/event-clients"
import { cliIt } from "../../lib/cli-process"

// 测试真实 discover 函数的决策，只替换 I/O，不能另写一套单服务器模拟器。
describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("forwards the CLI environment to the daemon process", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    // 入口必须同时含 worker 角色和实际 spawn seam，只有注释提到 daemon 不能通过此约束。
    expect(source).toContain("OPENCODE_PROCESS_ROLE")
    expect(source).toContain('"worker"')
    expect(source).toMatch(/deps\.spawn\(|DaemonProcess\.spawn\(/)
    // 静态锁定内部 listener 的 exact-zero 入口，fixture 不能为此启动另一个 CLI 进程。
    const worker = await Bun.file(new URL("../../../src/cli/tui/worker.ts", import.meta.url)).text()
    expect(worker).toContain("ephemeral: true, eventClients, sharedServices")
    expect(worker).toContain("Server.listen({ ...network, eventClients, sharedServices })")
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )


  describe("single-server enforcement", () => {
    const FAKE_DAEMON_PID = 99999
    const fakeLock = {
      pid: FAKE_DAEMON_PID,
      port: 9999,
      token: "test-token",
      dbPath: "/tmp/test.db",
      channel: "local" as const,
      startedAt: new Date().toISOString(),
      externalUrl: undefined as string | undefined,
    }

    // 所有场景共用 production deps 形状，新增身份字段不能只在某个测试的独立 mock 中补齐。
    function baseDeps(overrides: Partial<DiscoverDaemonDeps> & Pick<DiscoverDaemonDeps, "read" | "spawn">): DiscoverDaemonDeps {
      return {
        alive: () => true,
        ping: async () => true,
        clear: async () => {},
        acquire: async () => ({ release: async () => {} }) as never,
        sleep: async () => {},
        resolveDaemonFile: async () => "/tmp/daemon.ts",
        identity: () => ({ dbPath: "/tmp/test.db", channel: "local" }),
        placement: ServerLock.placement,
        resolveNetwork: async (args) => resolveNetworkOptionsNoConfig(args),
        electionTimeoutMs: 10_000,
        electionStaleMs: 5_000,
        pollMs: 0,
        waitMs: 5_000,
        ...overrides,
      }
    }

    // 显式给出本地默认值，保证用例只测试 owner 状态，不误进入 external listener 分支。
    const localNet = { port: 0, hostname: "127.0.0.1", mdns: false, cors: [] as string[] }

    test("reuses existing server: returns HTTP URL, no daemon spawned", async () => {
      let daemonSpawnCount = 0
      const result = await discoverOrSpawnDaemon(localNet as never, baseDeps({
        read: async () => ({
          pid: process.pid,
          port: 9999,
          token: "test-token",
          dbPath: "/tmp/test.db",
          channel: "local",
          startedAt: new Date().toISOString(),
        }),
        spawn: ((_cmd, _opts) => {
          daemonSpawnCount++
          return { pid: FAKE_DAEMON_PID, exited: Promise.resolve(0), unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
        }) as DiscoverDaemonDeps["spawn"],
      }))
      expect(daemonSpawnCount).toBe(0)
      expect(result.url).toBe("http://127.0.0.1:9999")
    })

    test("no existing server: daemon is spawned then URL returned", async () => {
      let daemonSpawnCount = 0
      let readCount = 0
      const result = await discoverOrSpawnDaemon(localNet as never, baseDeps({
        read: async () => {
          readCount++
          if (readCount <= 2) return undefined
          return fakeLock
        },
        spawn: ((_cmd, _opts) => {
          daemonSpawnCount++
          return { pid: FAKE_DAEMON_PID, exited: Promise.resolve(0), unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
        }) as DiscoverDaemonDeps["spawn"],
      }))
      expect(daemonSpawnCount).toBe(1)
      expect(result.url).toBe("http://127.0.0.1:9999")
    })

    test("lock exists + pid alive but HTTP ping fails: preserves owner and rejects", async () => {
      let daemonSpawnCount = 0
      let clearCalled = false
      let pingCount = 0
      await expect(discoverOrSpawnDaemon(localNet as never, baseDeps({
        read: async () => fakeLock,
        ping: async () => {
          pingCount++
          // 认证失败与短暂不可达均不能创建同身份的第二个服务。
          return pingCount > 2
        },
        clear: async () => {
          clearCalled = true
        },
        spawn: ((_cmd, _opts) => {
          daemonSpawnCount++
          return { pid: FAKE_DAEMON_PID, unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
        }) as DiscoverDaemonDeps["spawn"],
      }))).rejects.toThrow("health or authentication")
      expect(daemonSpawnCount).toBe(0)
      expect(clearCalled).toBe(false)
    })

    test("lock exists but pid dead (orphan): clears and spawns new daemon", async () => {
      let daemonSpawnCount = 0
      let clearCalled = false
      let readCount = 0
      const result = await discoverOrSpawnDaemon(localNet as never, baseDeps({
        read: async () => {
          readCount++
          if (readCount <= 2) {
            return {
              pid: 1,
              port: 9999,
              token: "orphan",
              dbPath: "/tmp/test.db",
              channel: "local",
              startedAt: new Date().toISOString(),
            }
          }
          return fakeLock
        },
        alive: (pid) => pid === FAKE_DAEMON_PID,
        clear: async () => {
          clearCalled = true
        },
        spawn: ((_cmd, _opts) => {
          daemonSpawnCount++
          return { pid: FAKE_DAEMON_PID, exited: Promise.resolve(0), unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
        }) as DiscoverDaemonDeps["spawn"],
      }))
      expect(daemonSpawnCount).toBe(1)
      expect(clearCalled).toBe(true)
      expect(result.url).toBe("http://127.0.0.1:9999")
    })

    test("releases owned leases on exceptions and rejects incompatible live identities", async () => {
      // 一个参数化用例覆盖 handoff 前失败点，避免依赖 CLI/spawn fixture。
      for (const stage of ["target", "spawn", "unref", "read", "sleep"]) {
        let reads = 0
        let releases = 0
        let kills = 0
        const fail = () => { throw new Error(stage) }
        await expect(discoverOrSpawnDaemon(localNet as never, baseDeps({
          acquire: async () => ({ release: async () => { releases++ } }) as never,
          read: async () => { if (++reads > 2 && stage === "read") fail(); return undefined },
          resolveDaemonFile: async () => stage === "target" ? fail() : "/tmp/daemon.ts",
          sleep: async () => { if (stage === "sleep") fail() },
          spawn: (() => {
            if (stage === "spawn") fail()
            return { pid: FAKE_DAEMON_PID, exited: Promise.resolve(0),
              unref() { if (stage === "unref") fail() }, kill() { kills++ } } as ReturnType<typeof Bun.spawn>
          }) as DiscoverDaemonDeps["spawn"],
        }))).rejects.toThrow(stage)
        expect(releases).toBe(1)
        expect(kills).toBe(["target", "spawn"].includes(stage) ? 0 : 1)
      }
      // 同库默认与显式网络请求必须读同一 owner；环境覆盖在 finally 恢复。
      const previousLockPath = process.env.OPENCODE_LOCK_PATH
      delete process.env.OPENCODE_LOCK_PATH
      try {
        const ownerPath = ServerLock.placement()
        // 活的跨 DB/channel/外部监听请求明确拒绝，不能清理全局 owner。
        for (const mismatch of ["database", "channel", "network"]) {
          let spawns = 0
          let clears = 0
          const paths: Array<string | undefined> = []
          await expect(discoverOrSpawnDaemon(
            (mismatch === "network" ? { ...localNet, port: 4321 } : localNet) as never,
            baseDeps({
              identity: () => ({ dbPath: mismatch === "database" ? "/tmp/other.db" : fakeLock.dbPath,
                channel: mismatch === "channel" ? "beta" : fakeLock.channel }),
              read: async (lockPath) => {
                paths.push(lockPath)
                return lockPath === ownerPath ? fakeLock : undefined
              },
              clear: async () => { clears++ },
              spawn: (() => { spawns++; throw new Error("unexpected spawn") }) as DiscoverDaemonDeps["spawn"],
            }),
          )).rejects.toThrow(mismatch === "network" ? "incompatible network" : "different database or channel")
          expect(paths).toEqual([ownerPath])
          expect(spawns).toBe(0)
          expect(clears).toBe(0)
        }
      } finally {
        if (previousLockPath === undefined) delete process.env.OPENCODE_LOCK_PATH
        if (previousLockPath !== undefined) process.env.OPENCODE_LOCK_PATH = previousLockPath
      }
      // 同一服务跨两个订阅 scope 计数；其中一个失败不能让另一个活跃客户端变成 idle。
      const counts: number[] = []
      const clients = EventClients.make((count) => counts.push(count))
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        yield* clients.acquire
        yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
          yield* clients.acquire
          return yield* Effect.fail("event stream disconnected")
        })))
        expect(counts).toEqual([1, 2, 1])
      })))
      // 外层最后释放才归零，证明 exceptional stream cleanup 与 daemon callback 使用同一 owner。
      expect(counts).toEqual([1, 2, 1, 0])
      // callback 不是 Scope owner；通知失败后仍必须发出归零清理，不能遗留假活跃客户端。
      const failedCounts: number[] = []
      const failedClients = EventClients.make((count) => { failedCounts.push(count); if (count > 0) throw new Error("callback failed") })
      await Effect.runPromise(Effect.exit(Effect.scoped(failedClients.acquire)))
      expect(failedCounts).toEqual([1, 0])
    })
  })

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})

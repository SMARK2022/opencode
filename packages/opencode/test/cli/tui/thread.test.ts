import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import {
  DaemonProcess,
  TuiThreadCommand,
  resolveThreadDirectory,
  discoverOrSpawnDaemon,
  DAEMON_START_TIMEOUT_MS,
  SERVER_ELECTION_TIMEOUT_MS,
  SERVER_ELECTION_STALE_MS,
  SERVER_POLL_INTERVAL_MS,
  status,
  printDaemonExitHint,
} from "../../../src/cli/cmd/tui"
import type { DiscoverDaemonDeps } from "../../../src/cli/cmd/tui"
import { resolveNetworkOptionsNoConfig } from "../../../src/cli/network"
import { ServerLock } from "../../../src/cli/tui/server-lock"
import { EventClients } from "@opencode-ai/server/event-clients"
import { Global } from "@opencode-ai/core/global"
import { cliIt } from "../../lib/cli-process"
import { UI } from "../../../src/cli/ui"

// #271：保护测试进程的退出码，避免 TuiThreadCommand 设置的 exitCode 在测试间泄漏
const originalExitCode = process.exitCode

// 测试真实 discover 函数的决策，只替换 I/O，不能另写一套单服务器模拟器。
// #179：幸福路径 mock 使用永不 resolve 的 exited
function hangingExited() {
  return new Promise<number>(() => {})
}

describe("tui thread", () => {
  // #271：每次测试后重置退出码，避免检验分支设置的 exitCode 影响后续用例
  afterEach(() => {
    restoreExitCode(originalExitCode)
  })

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
    // 发现会修改父进程绕过名单，每例都恢复双写法，避免污染后续网络用例。
    const parentNoProxy = new Map<string, string | undefined>()
    beforeEach(() => {
      for (const key of ["NO_PROXY", "no_proxy"]) parentNoProxy.set(key, process.env[key])
    })
    afterEach(() => {
      for (const [key, value] of parentNoProxy) {
        if (value === undefined) delete process.env[key]
        if (value !== undefined) process.env[key] = value
      }
    })

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
    function baseDeps(
      overrides: Partial<DiscoverDaemonDeps> & Pick<DiscoverDaemonDeps, "read" | "spawn">,
    ): DiscoverDaemonDeps {
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

    test("awaits asynchronous spawn and releases the election lease on rejection", async () => {
      let published = false
      let released = 0
      let unrefs = 0
      const acquire: DiscoverDaemonDeps["acquire"] = async () =>
        ({
          release: async () => {
            released++
          },
        }) as never
      const proc = {
        pid: FAKE_DAEMON_PID,
        exited: hangingExited(),
        unref() {
          unrefs++
        },
        kill() {
          throw new Error("delivered owner must survive")
        },
      }
      // 所有 I/O 均显式注入；异步返回前不发布锁，不能误用 Promise 当作真实进程 handle。
      const result = await discoverOrSpawnDaemon(
        localNet as never,
        baseDeps({
          placement: () => "/tmp/async-daemon.json",
          read: async () => (published ? fakeLock : undefined),
          acquire,
          spawn: async () => {
            await Promise.resolve()
            published = true
            return proc
          },
        }),
      )
      expect(result).toEqual({
        url: "http://127.0.0.1:9999",
        fwdPid: FAKE_DAEMON_PID,
        lockPath: "/tmp/async-daemon.json",
      })
      expect(unrefs).toBe(1)
      if (process.platform === "win32") {
        // 只替换 native spawn 边界；真实 adapter 读取分块 PID 并持续 drain，整个测试不创建进程。
        const encoder = new TextEncoder()
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("99"))
            controller.enqueue(encoder.encode("999\r\nworker output"))
            controller.close()
          },
        })
        const wrapper = {
          pid: 12345,
          exited: Promise.resolve(0),
          stdout,
          unref() {
            unrefs++
          },
          kill() {},
        }
        const spawn = spyOn(Bun, "spawn").mockReturnValue(wrapper as never)
        try {
          const target = "C:\\fake worker\\target.ts"
          const handle = await DaemonProcess.spawn([process.execPath, target], {
            env: { ...process.env },
            stdout: "ignore",
          })
          expect(handle.pid).toBe(FAKE_DAEMON_PID)
          expect(await handle.exited).toBe(0)
          expect(stdout.locked).toBe(false)
          expect(spawn).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
              windowsHide: true,
              stdout: "pipe",
              env: expect.objectContaining({ OPENCODE_DAEMON_TARGET: target }),
            }),
          )
          handle.unref()
          expect(unrefs).toBe(2)
        } finally {
          spawn.mockRestore()
        }
      }

      // spawn 本身拒绝时也须释放相同选举 lease，不交付替代进程或伪造 URL。
      const failure = new Error("async spawn rejected")
      await expect(
        discoverOrSpawnDaemon(
          localNet as never,
          baseDeps({
            placement: () => "/tmp/async-daemon.json",
            read: async () => undefined,
            acquire,
            spawn: async () => {
              throw failure
            },
          }),
        ),
      ).rejects.toBe(failure)
      expect(released).toBe(2)
    })

    test("reuses existing server: returns HTTP URL, no daemon spawned", async () => {
      const aliases = { NO_PROXY: "upper.example", no_proxy: "lower.example" }
      expect(NetworkProxy.noProxyString(Object.values(aliases))).toBe(
        "localhost,127.0.0.1,::1,::ffff:127.0.0.1,::ffff:7f00:1,upper.example,lower.example",
      )
      process.env.NO_PROXY = aliases.NO_PROXY
      process.env.no_proxy = aliases.no_proxy
      const parent = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
      const noProxy = Array.from(
        new Set([
          "localhost",
          "127.0.0.1",
          "::1",
          "::ffff:127.0.0.1",
          "::ffff:7f00:1",
          ...[parent.NO_PROXY, parent.no_proxy].flatMap((value) =>
            (value ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]),
      ).join(",")
      let daemonSpawnCount = 0
      const result = await discoverOrSpawnDaemon(
        localNet as never,
        baseDeps({
          read: async () => {
            expect(process.env.NO_PROXY).toBe(noProxy)
            expect(process.env.no_proxy).toBe(noProxy)
            return {
              pid: process.pid,
              port: 9999,
              token: "test-token",
              dbPath: "/tmp/test.db",
              channel: "local",
              startedAt: new Date().toISOString(),
            }
          },
          ping: async () => {
            expect(process.env.NO_PROXY).toBe(noProxy)
            expect(process.env.no_proxy).toBe(noProxy)
            return true
          },
          spawn: ((_cmd, _opts) => {
            daemonSpawnCount++
            return { pid: FAKE_DAEMON_PID, exited: hangingExited(), unref() {}, kill() {} } as ReturnType<
              typeof Bun.spawn
            >
          }) as DiscoverDaemonDeps["spawn"],
        }),
      )
      expect(daemonSpawnCount).toBe(0)
      expect(result.url).toBe("http://127.0.0.1:9999")
    })

    test("normalizes proxies in the actual daemon spawn while retaining the full environment", async () => {
      const proxyKeys = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
      ]
      const keys = [...proxyKeys, "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "SMARK_ENV_KEEP"]
      const previous = keys.map((key) => process.env[key])
      try {
        // 三条 CA 路径和任意用户变量都不属于代理白名单，仍须进入真实 spawn 参数。
        Object.assign(process.env, {
          NODE_EXTRA_CA_CERTS: "extra.pem",
          SSL_CERT_FILE: "ca.pem",
          SSL_CERT_DIR: "certs",
          SMARK_ENV_KEEP: "retained",
        })
        const cases: Array<{ env: Record<string, string>; values: Array<string | undefined> }> = [
          // 协议代理冲突仍选大写，绕过名单则保留两种写法，不能丢掉用户已有目的地。
          {
            env: {
              HTTP_PROXY: "http-upper",
              http_proxy: "http-lower",
              HTTPS_PROXY: "https-upper",
              https_proxy: "https-lower",
              ALL_PROXY: "all-upper",
              all_proxy: "all-lower",
              NO_PROXY: "no-upper",
              no_proxy: "no-lower",
            },
            values: ["http-upper", "https-upper", "all-upper"],
          },
          // HTTP 继承只作用于协议代理，不能因此删掉固定回环绕过。
          { env: { http_proxy: "http-only" }, values: ["http-only", "http-only", undefined] },
          // 小写 HTTPS 是明确配置，不应被大写 HTTP 的继承值抢占。
          {
            env: { HTTP_PROXY: "http", https_proxy: "https", all_proxy: "all", no_proxy: "no" },
            values: ["http", "https", "all"],
          },
          // 空 HTTP 大写仍优先；空 NO_PROXY 不能删除小写中的用户绕过目的地。
          {
            env: { HTTP_PROXY: "", http_proxy: "lower", NO_PROXY: "", no_proxy: "lower" },
            values: ["", "", undefined],
          },
        ]
        for (const item of cases) {
          proxyKeys.forEach((key) => {
            delete process.env[key]
          })
          Object.assign(process.env, item.env)
          const parent = { ...process.env, ...Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]])) }
          const noProxy = Array.from(
            new Set([
              "localhost",
              "127.0.0.1",
              "::1",
              "::ffff:127.0.0.1",
              "::ffff:7f00:1",
              ...[parent.NO_PROXY, parent.no_proxy].flatMap((value) =>
                (value ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ]),
          ).join(",")
          let reads = 0
          let spawns = 0
          const result = await discoverOrSpawnDaemon(
            localNet as never,
            baseDeps({
              read: async () => {
                // 首读按赋值后的实际快照校验，Windows 别名不能按声明表制造两个独立值。
                expect(process.env.NO_PROXY).toBe(noProxy)
                expect(process.env.no_proxy).toBe(noProxy)
                proxyKeys.slice(0, 6).forEach((key) => expect(process.env[key]).toBe(parent[key]))
                return ++reads <= 2 ? undefined : fakeLock
              },
              spawn: ((_cmd, opts) => {
                spawns++
                const env = opts?.env
                // 断言生产函数实际传入的 env，不能只测试一个独立归一 helper。
                expect(env).toBeDefined()
                proxyKeys.forEach((key, index) => {
                  if (index >= 6) return expect(env?.[key]).toBe(noProxy)
                  expect(env?.[key]).toBe(
                    process.platform === "win32" || process.platform === "darwin"
                      ? undefined
                      : item.values[Math.floor(index / 2)],
                  )
                })
                // 全量转发的保护覆盖所有非代理父键，而非仅检查上述四个 fixture 值。
                Object.entries(parent).forEach(([key, value]) => {
                  // launcher 身份属于本次 spawn 的 owner；其余非代理父键仍须逐项完整转发。
                  if (
                    proxyKeys.includes(key) ||
                    [
                      "OPENCODE_PROCESS_ROLE",
                      "OPENCODE_DAEMON_LAUNCHER_PID",
                      "OPENCODE_LOCK_PATH",
                      "OPENCODE_EXTERNAL_NETWORK",
                      "OPENCODE_PRINT_LOGS",
                    ].includes(key)
                  )
                    return
                  expect(env?.[key]).toBe(value)
                })
                expect(env?.OPENCODE_PROCESS_ROLE).toBe("worker")
                expect(env?.SMARK_ENV_KEEP).toBe("retained")
                // 注入 proc handle 不创建进程；就绪仍走真实 PID、身份和 token 复查。
                return { pid: FAKE_DAEMON_PID, exited: hangingExited(), unref() {}, kill() {} } as ReturnType<
                  typeof Bun.spawn
                >
              }) as DiscoverDaemonDeps["spawn"],
            }),
          )
          expect(spawns).toBe(1)
          expect(result.url).toBe("http://127.0.0.1:9999")
        }
      } finally {
        // 精确恢复缺失与空值，避免代理设置污染既有发现异常和网络身份用例。
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key]
          else process.env[key] = previous[index]
        })
      }
    })

    test("accepts the real daemon owner after spawning a Windows launcher", async () => {
      const launcherPid = 99998
      let daemonSpawnCount = 0
      let readCount = 0
      const result = await discoverOrSpawnDaemon(
        localNet as never,
        baseDeps({
          read: async () => {
            readCount++
            if (readCount <= 2) return undefined
            // 快速读取和持锁复读均为空；只有实际 mock spawn 后才发布 daemon owner。
            return daemonSpawnCount === 1 ? fakeLock : undefined
          },
          spawn: ((_cmd, _opts) => {
            daemonSpawnCount++
            return { pid: launcherPid, exited: Promise.resolve(0), unref() {}, kill() {} } as ReturnType<
              typeof Bun.spawn
            >
          }) as DiscoverDaemonDeps["spawn"],
          alive: (pid) => pid === FAKE_DAEMON_PID,
          sleep: async (ms) => {
            if (ms === 0) throw new Error("healthy daemon was not accepted")
          },
        }),
      )
      expect(daemonSpawnCount).toBe(1)
      expect(result.url).toBe("http://127.0.0.1:9999")
      expect(readCount).toBeGreaterThanOrEqual(4)
      // 独立断言重载目标的语义，URL 正确不代表返回了锁 owner 的 PID。
      expect(result.fwdPid).toBe(FAKE_DAEMON_PID)
    })

    test("uses a 75-second contender deadline without changing heartbeat staleness", async () => {
      expect(DAEMON_START_TIMEOUT_MS).toBe(60_000)
      expect(SERVER_ELECTION_TIMEOUT_MS).toBe(75_000)
      expect(SERVER_ELECTION_TIMEOUT_MS).toBe(DAEMON_START_TIMEOUT_MS + 15_000)
      expect(SERVER_ELECTION_STALE_MS).toBe(5_000)
      expect(SERVER_POLL_INTERVAL_MS).toBe(200)
      const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
      expect(source).toContain("electionTimeoutMs: SERVER_ELECTION_TIMEOUT_MS")
      expect(source).toContain("electionStaleMs: SERVER_ELECTION_STALE_MS")
      expect(source).toContain("pollMs: SERVER_POLL_INTERVAL_MS")
      expect(source).toContain("waitMs: DAEMON_START_TIMEOUT_MS")
      let acquisitions = 0
      await expect(
        discoverOrSpawnDaemon(
          localNet as never,
          baseDeps({
            read: async () => undefined,
            electionTimeoutMs: SERVER_ELECTION_TIMEOUT_MS,
            acquire: async (key, opts) => {
              acquisitions++
              // 核对完整获锁请求，不能把注入的 75 秒误用为 staleMs 或只断言常量大小。
              expect(key).toBe(`opencode.server:${ServerLock.placement()}`)
              expect(opts).toEqual({ dir: path.join(Global.Path.state, "locks"), timeoutMs: 75_000, staleMs: 5_000 })
              throw new Error("contender deadline")
            },
            spawn: () => {
              throw new Error("spawn without election lease")
            },
          }),
        ),
      ).rejects.toThrow("contender deadline")
      expect(acquisitions).toBe(1)
    })

    test("lock exists + pid alive but HTTP ping fails: preserves owner and rejects", async () => {
      let daemonSpawnCount = 0
      let clearCalled = false
      let pingCount = 0
      await expect(
        discoverOrSpawnDaemon(
          localNet as never,
          baseDeps({
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
          }),
        ),
      ).rejects.toThrow("health or authentication")
      expect(daemonSpawnCount).toBe(0)
      expect(clearCalled).toBe(false)
    })

    test("lock exists but pid dead (orphan): clears and spawns new daemon", async () => {
      let daemonSpawnCount = 0
      let clearCalled = false
      let readCount = 0
      const result = await discoverOrSpawnDaemon(
        localNet as never,
        baseDeps({
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
            return { pid: FAKE_DAEMON_PID, exited: hangingExited(), unref() {}, kill() {} } as ReturnType<
              typeof Bun.spawn
            >
          }) as DiscoverDaemonDeps["spawn"],
        }),
      )
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
        const fail = () => {
          throw new Error(stage)
        }
        await expect(
          discoverOrSpawnDaemon(
            localNet as never,
            baseDeps({
              acquire: async () =>
                ({
                  release: async () => {
                    releases++
                  },
                }) as never,
              read: async () => {
                if (++reads > 2 && stage === "read") fail()
                return undefined
              },
              resolveDaemonFile: async () => (stage === "target" ? fail() : "/tmp/daemon.ts"),
              sleep: async () => {
                if (stage === "sleep") fail()
              },
              spawn: (() => {
                if (stage === "spawn") fail()
                return {
                  pid: FAKE_DAEMON_PID,
                  exited: hangingExited(),
                  unref() {
                    if (stage === "unref") fail()
                  },
                  kill() {
                    kills++
                  },
                } as ReturnType<typeof Bun.spawn>
              }) as DiscoverDaemonDeps["spawn"],
            }),
          ),
        ).rejects.toThrow(stage)
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
          await expect(
            discoverOrSpawnDaemon(
              (mismatch === "network" ? { ...localNet, port: 4321 } : localNet) as never,
              baseDeps({
                identity: () => ({
                  dbPath: mismatch === "database" ? "/tmp/other.db" : fakeLock.dbPath,
                  channel: mismatch === "channel" ? "beta" : fakeLock.channel,
                }),
                read: async (lockPath) => {
                  paths.push(lockPath)
                  return lockPath === ownerPath ? fakeLock : undefined
                },
                clear: async () => {
                  clears++
                },
                spawn: (() => {
                  spawns++
                  throw new Error("unexpected spawn")
                }) as DiscoverDaemonDeps["spawn"],
              }),
            ),
          ).rejects.toThrow(mismatch === "network" ? "incompatible network" : "different database or channel")
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
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* clients.acquire
            yield* Effect.exit(
              Effect.scoped(
                Effect.gen(function* () {
                  yield* clients.acquire
                  return yield* Effect.fail("event stream disconnected")
                }),
              ),
            )
            expect(counts).toEqual([1, 2, 1])
          }),
        ),
      )
      // 外层最后释放才归零，证明 exceptional stream cleanup 与 daemon callback 使用同一 owner。
      expect(counts).toEqual([1, 2, 1, 0])
      // callback 不是 Scope owner；通知失败后仍必须发出归零清理，不能遗留假活跃客户端。
      const failedCounts: number[] = []
      const failedClients = EventClients.make((count) => {
        failedCounts.push(count)
        if (count > 0) throw new Error("callback failed")
      })
      await Effect.runPromise(Effect.exit(Effect.scoped(failedClients.acquire)))
      expect(failedCounts).toEqual([1, 0])
    })

    // 认证走真实 ping/header 构造，仅替换 fetch 与发现 I/O，复用和启动路径都必须携带凭证。
    test("authenticates daemon health checks when server password is configured", async () => {
      const keys = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"] as const
      const previous = keys.map((key) => process.env[key])
      Object.assign(process.env, {
        OPENCODE_SERVER_PASSWORD: "daemon password with spaces",
        OPENCODE_SERVER_USERNAME: "daemon-user",
      })
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            expect(String(input)).toBe("http://127.0.0.1:9999/global/health")
            expect(new Headers(init?.headers).get("Authorization")).toBe(
              "Basic ZGFlbW9uLXVzZXI6ZGFlbW9uIHBhc3N3b3JkIHdpdGggc3BhY2Vz",
            )
            return Response.json({ healthy: true, version: InstallationVersion })
          },
          { preconnect() {} },
        ),
      )

      try {
        for (const mode of ["reuse", "spawn"]) {
          let reads = 0
          let spawns = 0
          const calls = fetchSpy.mock.calls.length
          const result = await discoverOrSpawnDaemon(
            { ...localNet, "mdns-domain": "opencode.local" },
            baseDeps({
              read: async () => (mode === "spawn" && ++reads <= 2 ? undefined : fakeLock),
              ping: ServerLock.ping,
              spawn: (() => {
                spawns++
                return { pid: FAKE_DAEMON_PID, exited: hangingExited(), unref() {}, kill() {} } as ReturnType<
                  typeof Bun.spawn
                >
              }) as DiscoverDaemonDeps["spawn"],
              // 凭证错误时让零间隔轮询立即失败，不能用长超时掩盖健康检查回归。
              sleep: async (ms) => {
                if (ms === 0) throw new Error("authenticated health check failed")
              },
            }),
          )
          expect(spawns).toBe(mode === "spawn" ? 1 : 0)
          expect(result.url).toBe("http://127.0.0.1:9999")
          expect(fetchSpy.mock.calls.length).toBeGreaterThan(calls)
        }
      } finally {
        fetchSpy.mockRestore()
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key]
          if (previous[index] !== undefined) process.env[key] = previous[index]
        })
      }
    })

    // 无 owner 时不能发出控制面请求；直接注入读取结果，避免泄漏锁路径覆盖。
    test("status returns undefined when no daemon lock exists", async () => {
      const readSpy = spyOn(ServerLock, "read").mockResolvedValue(undefined)
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected control request"))
      try {
        expect(await status("/tmp/test-daemon.json")).toBeUndefined()
        expect(readSpy).toHaveBeenCalledWith("/tmp/test-daemon.json")
        expect(fetchSpy).not.toHaveBeenCalled()
      } finally {
        fetchSpy.mockRestore()
        readSpy.mockRestore()
      }
    })

    // 提示沿用发现的锁路径，调用真实 status；只替换锁、存活探测、HTTP 与输出。
    test("printDaemonExitHint shows stop guidance when daemon has active clients", async () => {
      const printlns: string[] = []
      const readSpy = spyOn(ServerLock, "read").mockResolvedValue({ ...fakeLock, controlPort: 9998 })
      const aliveSpy = spyOn(ServerLock, "alive").mockReturnValue(true)
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            expect(String(input)).toBe(`http://127.0.0.1:9998${ServerLock.CONTROL_STATUS_PATH}`)
            expect(new Headers(init?.headers).get(ServerLock.CONTROL_TOKEN_HEADER)).toBe(fakeLock.token)
            return Response.json({ tuiClients: 2, sessionActivity: 0 })
          },
          { preconnect() {} },
        ),
      )
      const printlnSpy = spyOn(UI, "println").mockImplementation((...msg) => {
        printlns.push(msg.join(" "))
      })

      try {
        await printDaemonExitHint("/tmp/test-daemon.json")
        const output = printlns.join("\n")
        expect(output).toContain("2 TUI connections")
        expect(output).toContain("0 active sessions")
        expect(output).toContain("opencode daemon stop")
        expect(readSpy).toHaveBeenCalledWith("/tmp/test-daemon.json")
        expect(fetchSpy).toHaveBeenCalled()
      } finally {
        printlnSpy.mockRestore()
        fetchSpy.mockRestore()
        aliveSpy.mockRestore()
        readSpy.mockRestore()
      }
    })

    test("printDaemonExitHint does not show guidance when daemon has no active clients", async () => {
      const printlns: string[] = []
      const readSpy = spyOn(ServerLock, "read").mockResolvedValue({ ...fakeLock, controlPort: 9998 })
      const aliveSpy = spyOn(ServerLock, "alive").mockReturnValue(true)
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            expect(String(input)).toBe(`http://127.0.0.1:9998${ServerLock.CONTROL_STATUS_PATH}`)
            expect(new Headers(init?.headers).get(ServerLock.CONTROL_TOKEN_HEADER)).toBe(fakeLock.token)
            return Response.json({ tuiClients: 0, sessionActivity: 0 })
          },
          { preconnect() {} },
        ),
      )
      const printlnSpy = spyOn(UI, "println").mockImplementation((...msg) => {
        printlns.push(msg.join(" "))
      })

      try {
        await printDaemonExitHint("/tmp/test-daemon.json")
        expect(printlns.join("\n")).not.toContain("opencode daemon stop")
        expect(printlnSpy).not.toHaveBeenCalled()
        expect(readSpy).toHaveBeenCalledWith("/tmp/test-daemon.json")
        expect(fetchSpy).toHaveBeenCalled()
      } finally {
        printlnSpy.mockRestore()
        fetchSpy.mockRestore()
        aliveSpy.mockRestore()
        readSpy.mockRestore()
      }
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

function restoreExitCode(exitCode: typeof process.exitCode) {
  // #462：Bun 对已置位的 exitCode 再赋 undefined 是 no-op；Linux 上会以退出码 1 误报失败，
  // 统一重置为 0 而不是还原捕获值里的 undefined。
  process.exitCode = exitCode ?? 0
}

// #179：单元覆盖启动前崩溃的快速失败路径
describe("daemon startup exit (#179)", () => {
  test("reports daemon worker exit before startup instead of waiting for timeout", async () => {
    const started = Date.now()
    let killed = false
    await expect(
      discoverOrSpawnDaemon(
        {} as never,
        {
          // #179：超时故意很长，证明快速失败不是靠缩短 waitMs
          waitMs: 60_000,
          pollMs: 50,
          electionTimeoutMs: 1000,
          electionStaleMs: 1000,
          read: async () => undefined,
          alive: () => false,
          ping: async () => false,
          acquire: async () => ({ release: async () => undefined }),
          clear: async () => undefined,
          resolveDaemonFile: async () => "/tmp/fake-daemon.js",
          identity: () => ({ dbPath: "/tmp/test.db", channel: "local" }),
          placement: () => undefined,
          resolveNetwork: async (args: Parameters<DiscoverDaemonDeps["resolveNetwork"]>[0]) =>
            resolveNetworkOptionsNoConfig(args),
          spawn: () =>
            ({
              pid: 4242,
              // #179：模拟启动前崩溃 exit 132
              exited: Promise.resolve(132),
              unref() {},
              kill() {
                killed = true
              },
            }) as never,
          sleep: async (ms: number) => {
            await new Promise((r) => setTimeout(r, Math.min(ms, 15)))
          },
        } as never,
      ),
    ).rejects.toThrow(/exited before startup with exit code 132/)
    expect(Date.now() - started) // #179：必须远快于 60s 超时
      .toBeLessThan(5_000)
    // #179：进程已退出，不应再 kill
    expect(killed).toBe(false)
  })
})

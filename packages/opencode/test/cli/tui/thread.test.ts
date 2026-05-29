import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as App from "../../../src/cli/cmd/tui/app"
import { UI } from "../../../src/cli/ui"
import * as Win32 from "../../../src/cli/cmd/tui/win32"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"
import * as ThreadModule from "../../../src/cli/cmd/tui/thread"
import * as DaemonModule from "../../../src/cli/cmd/tui/daemon"
import { Flock } from "@opencode-ai/core/util/flock"
import { Flag } from "@opencode-ai/core/flag/flag"

const stop = new Error("stop")
const seen = {
  tui: [] as string[],
  tuiUrls: [] as string[],
  errors: [] as string[],
  printlns: [] as string[],
}
type ThreadArgs = Parameters<NonNullable<typeof ThreadModule.TuiThreadCommand.handler>>[0]

function setup() {
  seen.tui.length = 0
  seen.tuiUrls.length = 0
  seen.errors.length = 0
  seen.printlns.length = 0
  // Intentionally avoid mock.module() here: Bun keeps module overrides in cache
  // and mock.restore() does not reset mock.module values. If this switches back
  // to module mocks, later suites can see mocked @/config/tui and fail (e.g.
  // plugin-loader tests expecting real TuiConfig.waitForDependencies). See:
  // https://github.com/oven-sh/bun/issues/7823 and #12823.
  spyOn(App, "tui").mockImplementation(async (input) => {
    if (input.directory) seen.tui.push(input.directory)
    seen.tuiUrls.push(input.url)
    throw stop
  })
  spyOn(UI, "error").mockImplementation((message) => {
    seen.errors.push(String(message))
  })
  spyOn(UI, "println").mockImplementation((...message) => {
    seen.printlns.push(message.join(" "))
  })
  spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
  spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
}

describe("tui thread", () => {
  afterEach(() => {
    ThreadModule._setSpawn(undefined)
    mock.restore()
    ServerLockModule._setLockPath(undefined)
  })

  async function call(project?: string, overrides?: Partial<ThreadArgs>) {
    const { TuiThreadCommand } = await import("../../../src/cli/cmd/tui/thread")
    const args: ThreadArgs = {
      _: [],
      $0: "opencode",
      project,
      prompt: "hi",
      model: undefined,
      agent: undefined,
      session: undefined,
      continue: false,
      fork: false,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      mdnsDomain: "opencode.local",
      cors: [],
      ...overrides,
    }
    return TuiThreadCommand.handler(args)
  }

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(ThreadModule.resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
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

  describe("single-server enforcement", () => {
    const FAKE_DAEMON_PID = 99999

    const fakeLock = {
      pid: FAKE_DAEMON_PID,
      port: 9999,
      token: "test-token",
      dbPath: "/tmp/test.db",
      channel: "local" as const,
      startedAt: new Date().toISOString(),
    }

    function spawnedDaemon(pid = FAKE_DAEMON_PID, overrides: Partial<ReturnType<typeof Bun.spawn>> = {}) {
      return {
        pid,
        exited: new Promise<number>(() => {}),
        unref() {},
        kill() {},
        ...overrides,
      } as ReturnType<typeof Bun.spawn>
    }

    async function callWithDaemonSpy(existingUrl: string | null, overrides?: Partial<ThreadArgs>) {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      ThreadModule._setSpawn(() => {
        daemonSpawnCount++
        return spawnedDaemon()
      })

      if (existingUrl) {
        spyOn(ServerLockModule, "read").mockResolvedValue({
          pid: process.pid,
          port: 9999,
          token: "test-token",
          dbPath: "/tmp/test.db",
          channel: "local" as const,
          startedAt: new Date().toISOString(),
        })
        spyOn(ServerLockModule, "alive").mockReturnValue(true)
        spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      } else {
        let readCount = 0
        spyOn(ServerLockModule, "read").mockImplementation(async () => {
          readCount++
          if (readCount <= 2) return undefined
          return fakeLock
        })
        spyOn(ServerLockModule, "alive").mockReturnValue(true)
        spyOn(ServerLockModule, "ping").mockResolvedValue(true)
        spyOn(ServerLockModule, "clear").mockResolvedValue(undefined)
      }

      const cwd = process.cwd()
      try {
        await expect(call(undefined, overrides)).rejects.toBe(stop)
        return { daemonSpawnCount, tuiUrls: [...seen.tuiUrls] }
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    }

    test("reuses existing server: tui receives HTTP URL, no daemon spawned", async () => {
      const { daemonSpawnCount, tuiUrls } = await callWithDaemonSpy("http://127.0.0.1:9999")
      expect(daemonSpawnCount).toBe(0)
      expect(tuiUrls[0]).toBe("http://127.0.0.1:9999")
    })

    test("reuses existing server while keeping loopback out of proxy env", async () => {
      const prevNoProxy = process.env.NO_PROXY
      const prevNoProxyLower = process.env.no_proxy
      process.env.NO_PROXY = "example.com"
      delete process.env.no_proxy

      try {
        const { daemonSpawnCount } = await callWithDaemonSpy("http://127.0.0.1:9999")
        const noProxy = process.env.NO_PROXY ?? ""
        const noProxyLower = process.env["no_proxy"] ?? ""
        expect(daemonSpawnCount).toBe(0)
        expect(noProxy).toContain("127.0.0.1")
        expect(noProxyLower).toBe(noProxy)
      } finally {
        if (prevNoProxy === undefined) delete process.env.NO_PROXY
        else process.env.NO_PROXY = prevNoProxy
        if (prevNoProxyLower === undefined) delete process.env["no_proxy"]
        else process.env["no_proxy"] = prevNoProxyLower
      }
    })

    test("rejects --port for VS Code bridge registry guidance", async () => {
      setup()
      const exitCode = process.exitCode
      try {
        await expect(call(undefined, { port: 8080 })).resolves.toBeUndefined()
        expect(seen.errors[0]).toContain("--port is no longer supported")
        expect(seen.errors[0]).toContain("instead of community bridge plugins")
        expect(seen.errors[0]).toContain("https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge")
        expect(seen.tuiUrls).toHaveLength(0)
      } finally {
        process.exitCode = exitCode
      }
    })

    test("rejects explicit --port=0 for VS Code bridge registry guidance", async () => {
      setup()
      const exitCode = process.exitCode
      const argv = process.argv
      process.argv = ["opencode", "--port=0"]
      try {
        await expect(call()).resolves.toBeUndefined()
        expect(seen.errors[0]).toContain("--port is no longer supported")
        expect(seen.tuiUrls).toHaveLength(0)
      } finally {
        process.argv = argv
        process.exitCode = exitCode
      }
    })

    test("no existing server: daemon is spawned", async () => {
      const { daemonSpawnCount } = await callWithDaemonSpy(null)
      expect(daemonSpawnCount).toBe(1)
    })

    test("spawned daemon is detached on Unix and not detached on Windows", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let spawnOptions: Parameters<typeof Bun.spawn>[1] | undefined
      ThreadModule._setSpawn((_cmd, opts) => {
        spawnOptions = opts
        return spawnedDaemon()
      })

      let readCount = 0
      spyOn(ServerLockModule, "read").mockImplementation(async () => {
        readCount++
        if (readCount <= 2) return undefined
        return fakeLock
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      spyOn(ServerLockModule, "clear").mockResolvedValue(undefined)

      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(spawnOptions?.detached).toBe(process.platform !== "win32")
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("reports daemon worker exit before startup instead of waiting for timeout", async () => {
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))

      let killed = false
      DaemonModule._setSpawn(() =>
        spawnedDaemon(FAKE_DAEMON_PID, {
          exited: Promise.resolve(132),
          kill() {
            killed = true
          },
        }),
      )
      spyOn(ServerLockModule, "read").mockResolvedValue(undefined)

      const started = Date.now()
      await expect(
        DaemonModule.ensure({
          port: 0,
          hostname: "127.0.0.1",
          mdns: false,
          "mdns-domain": "opencode.local",
          cors: [],
        }),
      ).rejects.toThrow("opencode daemon exited before startup with exit code 132")
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(killed).toBe(false)
    })

    test("thread installs and releases the Windows Ctrl+C guard around TUI lifetime", async () => {
      let released = false
      const order: string[] = []
      setup()
      mock.restore()
      spyOn(App, "tui").mockImplementation(async () => {
        order.push("tui")
        throw stop
      })
      spyOn(UI, "error").mockImplementation(() => {})
      spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {
        order.push("disable")
      })
      const guard = spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(() => {
        order.push("release")
        released = true
      })

      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      spyOn(ServerLockModule, "read").mockResolvedValue({
        pid: process.pid,
        port: 9999,
        token: "test-token",
        dbPath: "/tmp/test.db",
        channel: "local" as const,
        startedAt: new Date().toISOString(),
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      ThreadModule._setSpawn(() => {
        order.push("spawn")
        return spawnedDaemon(99999)
      })

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(guard).toHaveBeenCalledTimes(1)
        expect(released).toBe(true)
        expect(order).toEqual(["disable", "tui", "release"])
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("prints daemon stop guidance when other clients or sessions keep the daemon alive after TUI exits", async () => {
      setup()
      mock.restore()
      seen.printlns.length = 0
      spyOn(App, "tui").mockImplementation(async () => undefined)
      spyOn(UI, "error").mockImplementation(() => {})
      spyOn(UI, "println").mockImplementation((...message) => {
        seen.printlns.push(message.join(" "))
      })
      spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
      spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
      spyOn(DaemonModule, "status").mockResolvedValue({ tuiClients: 2, sessionActivity: 0 })
      spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`)
      }) as never)

      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      spyOn(ServerLockModule, "read").mockResolvedValue({
        pid: process.pid,
        port: 9999,
        token: "test-token",
        dbPath: "/tmp/test.db",
        channel: "local" as const,
        startedAt: new Date().toISOString(),
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toThrow("exit:0")
        const output = seen.printlns.join("\n")
        expect(output).toContain("2 TUI connections")
        expect(output).toContain("0 active sessions")
        expect(output).toContain("opencode daemon stop")
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("does not print daemon stop guidance when daemon has no remaining clients or active sessions", async () => {
      setup()
      mock.restore()
      seen.printlns.length = 0
      spyOn(App, "tui").mockImplementation(async () => undefined)
      spyOn(UI, "error").mockImplementation(() => {})
      spyOn(UI, "println").mockImplementation((...message) => {
        seen.printlns.push(message.join(" "))
      })
      spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
      spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
      spyOn(DaemonModule, "status").mockResolvedValue({ tuiClients: 0, sessionActivity: 0 })
      spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`exit:${code}`)
      }) as never)

      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      spyOn(ServerLockModule, "read").mockResolvedValue({
        pid: process.pid,
        port: 9999,
        token: "test-token",
        dbPath: "/tmp/test.db",
        channel: "local" as const,
        startedAt: new Date().toISOString(),
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toThrow("exit:0")
        expect(seen.printlns.join("\n")).not.toContain("opencode daemon stop")
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("Windows Ctrl+C guard is active before any daemon spawn attempt", async () => {
      const order: string[] = []
      setup()
      mock.restore()
      spyOn(App, "tui").mockImplementation(async () => {
        order.push("tui")
        throw stop
      })
      spyOn(UI, "error").mockImplementation(() => {})
      spyOn(Win32, "win32InstallCtrlCGuard").mockImplementation(() => {
        order.push("guard")
        return () => order.push("release")
      })
      spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {
        order.push("disable")
      })

      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      let readCount = 0
      spyOn(ServerLockModule, "read").mockImplementation(async () => {
        readCount++
        if (readCount <= 2) return undefined
        return fakeLock
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      spyOn(ServerLockModule, "clear").mockResolvedValue(undefined)
      ThreadModule._setSpawn(() => {
        order.push("spawn")
        return spawnedDaemon()
      })

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(order).toEqual(["guard", "disable", "spawn", "tui", "release"])
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("concurrent daemon recovery elects a single replacement worker", async () => {
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))

      let spawned = false
      let spawnCount = 0
      const fakeLock = {
        pid: FAKE_DAEMON_PID,
        port: 9999,
        token: "test-token",
        dbPath: "/tmp/test.db",
        channel: "local" as const,
        startedAt: new Date().toISOString(),
      }

      DaemonModule._setSpawn(() => {
        spawnCount++
        spawned = true
        return spawnedDaemon()
      })
      spyOn(ServerLockModule, "read").mockImplementation(async () => (spawned ? fakeLock : undefined))
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      spyOn(ServerLockModule, "clear").mockResolvedValue(undefined)

      const args: ThreadArgs = {
        _: [],
        $0: "opencode",
        project: undefined,
        prompt: "hi",
        model: undefined,
        agent: undefined,
        session: undefined,
        continue: false,
        fork: false,
        port: 0,
        hostname: "127.0.0.1",
        mdns: false,
        "mdns-domain": "opencode.local",
        mdnsDomain: "opencode.local",
        cors: [],
      }

      const [first, second] = await Promise.all([DaemonModule.ensure(args), DaemonModule.ensure(args)])
      expect(first).toBe("http://127.0.0.1:9999")
      expect(second).toBe("http://127.0.0.1:9999")
      expect(spawnCount).toBe(1)
    })

    test("accepts lock from real daemon when spawned pid is only a Windows launcher", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      const launcherPid = 99998
      const realDaemonPid = 99999
      let daemonSpawnCount = 0
      ThreadModule._setSpawn(() => {
        daemonSpawnCount++
        return spawnedDaemon(launcherPid)
      })

      let readCount = 0
      spyOn(ServerLockModule, "read").mockImplementation(async () => {
        readCount++
        if (readCount <= 2) return undefined
        return {
          ...fakeLock,
          pid: realDaemonPid,
        }
      })
      spyOn(ServerLockModule, "alive").mockImplementation((pid) => pid === realDaemonPid)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      spyOn(ServerLockModule, "clear").mockResolvedValue(undefined)

      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(daemonSpawnCount).toBe(1)
        expect(seen.tuiUrls[0]).toBe("http://127.0.0.1:9999")
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("waits longer than the daemon startup window for server election", async () => {
      setup()
      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      spyOn(ServerLockModule, "read").mockResolvedValue(undefined)

      let timeoutMs: number | undefined
      spyOn(Flock, "acquire").mockImplementation(async (_key, input) => {
        timeoutMs = input?.timeoutMs
        throw stop
      })

      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(timeoutMs).toBeGreaterThan(ThreadModule.DAEMON_START_TIMEOUT_MS)
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("lock exists + pid alive but HTTP ping fails (unresponsive owner): reuses existing URL without spawning", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      ThreadModule._setSpawn(() => {
        daemonSpawnCount++
        return spawnedDaemon()
      })

      let clearCalled = false
      // pid alive + ping fails = unresponsive owner. ensure() must return
      // the existing URL without spawning a second daemon.
      spyOn(ServerLockModule, "read").mockResolvedValue({
        pid: process.pid,
        port: 9999,
        token: "test-token",
        dbPath: "/tmp/test.db",
        channel: "local" as const,
        startedAt: new Date().toISOString(),
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      spyOn(ServerLockModule, "ping").mockResolvedValue(false)
      spyOn(ServerLockModule, "clear").mockImplementation(async () => {
        clearCalled = true
      })

      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        // No daemon spawned — owner is alive, just unresponsive.
        expect(daemonSpawnCount).toBe(0)
        expect(clearCalled).toBe(false)
        expect(seen.tuiUrls[0]).toBe("http://127.0.0.1:9999")
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })

    test("authenticates daemon health checks when server password is configured", async () => {
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      const previousPassword = Flag.OPENCODE_SERVER_PASSWORD
      const previousUsername = Flag.OPENCODE_SERVER_USERNAME
      Flag.OPENCODE_SERVER_PASSWORD = "daemon password with spaces"
      Flag.OPENCODE_SERVER_USERNAME = "daemon-user"

      try {
        spyOn(ServerLockModule, "read").mockResolvedValue({
          pid: process.pid,
          port: 9999,
          token: "test-token",
          dbPath: "/tmp/test.db",
          channel: "local" as const,
          startedAt: new Date().toISOString(),
        })
        spyOn(ServerLockModule, "alive").mockReturnValue(true)
        spyOn(ServerLockModule, "ping").mockImplementation(async (_port, init) => {
          return init?.headers instanceof Headers
            ? init.headers.get("Authorization") === "Basic ZGFlbW9uLXVzZXI6ZGFlbW9uIHBhc3N3b3JkIHdpdGggc3BhY2Vz"
            : (init?.headers as Record<string, string> | undefined)?.Authorization ===
                "Basic ZGFlbW9uLXVzZXI6ZGFlbW9uIHBhc3N3b3JkIHdpdGggc3BhY2Vz"
        })

        const url = await DaemonModule.ensure({
          port: 0,
          hostname: "127.0.0.1",
          mdns: false,
          "mdns-domain": "opencode.local",
          cors: [],
        })
        expect(url).toBe("http://127.0.0.1:9999")
      } finally {
        Flag.OPENCODE_SERVER_PASSWORD = previousPassword
        Flag.OPENCODE_SERVER_USERNAME = previousUsername
      }
    })

    test("lock exists but pid dead (orphan lock): clears stale lock and spawns daemon", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      ThreadModule._setSpawn(() => {
        daemonSpawnCount++
        return spawnedDaemon()
      })

      let clearCalled = false
      let readCount = 0
      spyOn(ServerLockModule, "read").mockImplementation(async () => {
        readCount++
        if (readCount <= 2)
          return { pid: 2_000_000_000, port: 9999, token: "test-token", dbPath: "/tmp/test.db", channel: "local" as const, startedAt: new Date().toISOString() }
        return fakeLock
      })
      spyOn(ServerLockModule, "alive").mockImplementation((pid) => pid === FAKE_DAEMON_PID)
      spyOn(ServerLockModule, "ping").mockResolvedValue(true)
      spyOn(ServerLockModule, "clear").mockImplementation(async () => {
        clearCalled = true
      })

      const cwd = process.cwd()
      try {
        await expect(call()).rejects.toBe(stop)
        expect(daemonSpawnCount).toBe(1)
        expect(clearCalled).toBe(true)
      } finally {
        process.chdir(cwd)
        if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
        else delete (process.stdin as { isTTY?: boolean }).isTTY
      }
    })
  })
})

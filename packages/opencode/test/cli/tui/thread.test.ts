import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as App from "../../../src/cli/cmd/tui/app"
import { Rpc } from "@/util/rpc"
import { UI } from "../../../src/cli/ui"
import * as Timeout from "../../../src/util/timeout"
import * as Network from "../../../src/cli/network"
import * as Win32 from "../../../src/cli/cmd/tui/win32"
import { TuiConfig } from "../../../src/cli/cmd/tui/config/tui"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"
import * as ThreadModule from "../../../src/cli/cmd/tui/thread"
import { Flock } from "@opencode-ai/core/util/flock"

const stop = new Error("stop")
const seen = {
  tui: [] as string[],
  tuiUrls: [] as string[],
}

function setup() {
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
  spyOn(UI, "error").mockImplementation(() => {})
  spyOn(Timeout, "withTimeout").mockImplementation((input) => input)
  spyOn(Network, "resolveNetworkOptions").mockResolvedValue({
    mdns: false,
    port: 0,
    hostname: "127.0.0.1",
    mdnsDomain: "opencode.local",
    cors: [],
  })
  spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
  spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
}

describe("tui thread", () => {
  afterEach(() => {
    mock.restore()
    ServerLockModule._setLockPath(undefined)
  })

  async function call(project?: string) {
    const { TuiThreadCommand } = await import("../../../src/cli/cmd/tui/thread")
    const args: Parameters<NonNullable<typeof TuiThreadCommand.handler>>[0] = {
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
    }
    return TuiThreadCommand.handler(args)
  }

  async function check(project?: string) {
    setup()
    await using tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    const pwd = process.env.PWD
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"
    seen.tui.length = 0
    seen.tuiUrls.length = 0
    await fs.symlink(tmp.path, link, type)

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })

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

    try {
      process.chdir(tmp.path)
      process.env.PWD = link
      await expect(call(project)).rejects.toBe(stop)
      expect(seen.tui[0]).toBe(tmp.path)
    } finally {
      process.chdir(cwd)
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
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

    async function callWithDaemonSpy(existingUrl: string | null) {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      spyOn(ThreadModule, "_spawn").mockImplementation(() => {
        daemonSpawnCount++
        return { pid: FAKE_DAEMON_PID, unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
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
        await expect(call()).rejects.toBe(stop)
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

    test("no existing server: daemon is spawned", async () => {
      const { daemonSpawnCount } = await callWithDaemonSpy(null)
      expect(daemonSpawnCount).toBe(1)
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
      spyOn(ThreadModule, "_spawn").mockImplementation(() => {
        daemonSpawnCount++
        return { pid: launcherPid, unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
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

    test("lock exists + pid alive but HTTP ping fails (server crashed): spawns new daemon and clears stale lock", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      spyOn(ThreadModule, "_spawn").mockImplementation(() => {
        daemonSpawnCount++
        return { pid: FAKE_DAEMON_PID, unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
      })

      let clearCalled = false
      let readCount = 0
      spyOn(ServerLockModule, "read").mockImplementation(async () => {
        readCount++
        if (readCount <= 2)
          return { pid: process.pid, port: 9999, token: "test-token", dbPath: "/tmp/test.db", channel: "local" as const, startedAt: new Date().toISOString() }
        return fakeLock
      })
      spyOn(ServerLockModule, "alive").mockReturnValue(true)
      let pingCount = 0
      spyOn(ServerLockModule, "ping").mockImplementation(async () => {
        pingCount++
        return pingCount > 2
      })
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

    test("lock exists but pid dead (orphan lock): clears stale lock and spawns daemon", async () => {
      setup()
      await using tmp = await tmpdir()
      ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
      seen.tui.length = 0
      seen.tuiUrls.length = 0

      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

      let daemonSpawnCount = 0
      spyOn(ThreadModule, "_spawn").mockImplementation(() => {
        daemonSpawnCount++
        return { pid: FAKE_DAEMON_PID, unref() {}, kill() {} } as ReturnType<typeof Bun.spawn>
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

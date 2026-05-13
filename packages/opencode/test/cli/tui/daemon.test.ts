/**
 * Daemon lifecycle integration tests.
 *
 * These tests spawn a REAL daemon process (bun worker.ts) and exercise the
 * full startup → health-check → shutdown cycle.  They catch bugs that unit
 * tests with mocked _spawn cannot catch — e.g. the compiled-binary bug where
 * Bun.spawn([opencode.exe, "worker.ts"]) ran the TUI CLI instead of the
 * daemon, causing a 30-second timeout.
 *
 * Isolation: OPENCODE_LOCK_PATH plus XDG_* and OPENCODE_DB are set to a temp
 * directory so tests never touch a developer's live daemon lock or database.
 */
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../../fixture/fixture"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url))

const DAEMON_START_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100
const SIGNAL_TEST_TIMEOUT_MS = 10_000

afterEach(() => {
  ServerLockModule._setLockPath(undefined)
})

/**
 * Spawn the daemon with an isolated lock file in `tmp`, then poll until the
 * lock appears and the HTTP server responds.  Returns the running proc and the
 * live lock contents.
 */
async function spawnDaemon(lockPath: string) {
  const root = path.dirname(lockPath)
  const proc = Bun.spawn([process.execPath, WORKER_TS], {
    env: {
      ...process.env,
      OPENCODE_PROCESS_ROLE: "worker",
      OPENCODE_LOCK_PATH: lockPath,
      OPENCODE_DB: path.join(root, "opencode.db"),
      OPENCODE_TEST_HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "share"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

  // Poll until the lock file appears AND the HTTP server responds.
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const lock = await Bun.file(lockPath)
      .text()
      .then((t) => JSON.parse(t) as ServerLockModule.ServerLock)
      .catch(() => undefined)

    if (lock && lock.pid === proc.pid && ServerLockModule.alive(lock.pid)) {
      const ok = await ServerLockModule.ping(lock.port)
      if (ok) return { proc, lock }
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }

  proc.kill()
  throw new Error(`Daemon did not start within ${DAEMON_START_TIMEOUT_MS} ms`)
}

async function readFirstLine(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) throw new Error("missing stdout stream")
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      const line = text.split(/\r?\n/)[0]
      if (line) return line
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error("timed out waiting for child pid")
}

describe("daemon lifecycle", () => {
  test(
    "daemon writes lock file and responds to HTTP health check",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const { proc, lock } = await spawnDaemon(lockPath)
      try {
        // Verify /global/health
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/health`)
        expect(res.ok).toBe(true)
        const body = (await res.json()) as { healthy: boolean }
        expect(body.healthy).toBe(true)

        // Lock PID must match the spawned process
        expect(lock.pid).toBe(proc.pid)
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )

  test(
    "SIGTERM triggers graceful shutdown and clears the lock file",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const { proc } = await spawnDaemon(lockPath)

      // Send SIGTERM.  On Unix, gracefulShutdown() catches it, exits 0, and
      // clears the lock.  On Windows, TerminateProcess() bypasses Node's signal
      // handler, so we only assert the process exits.
      proc.kill("SIGTERM")
      const exitCode = await proc.exited

      if (process.platform !== "win32") {
        // Unix: gracefulShutdown() ran → clean exit + lock cleared.
        expect(exitCode).toBe(0)
        const lockAfter = await Bun.file(lockPath).text().catch(() => undefined)
        expect(lockAfter).toBeUndefined()
      } else {
        // Windows: TerminateProcess() terminates immediately; just verify exit.
        expect(typeof exitCode).toBe("number")
      }
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )

  test(
    "daemon port is reachable; second HTTP call proves server is live",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const { proc, lock } = await spawnDaemon(lockPath)
      try {
        // Ping twice to rule out a single lucky response.
        expect(await ServerLockModule.ping(lock.port)).toBe(true)
        expect(await ServerLockModule.ping(lock.port)).toBe(true)
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )

  test(
    "compiled-binary path: spawning with OPENCODE_PROCESS_ROLE=worker env bypasses yargs and starts daemon",
    async () => {
      // This test validates the fix for the compiled-binary bug:
      //   Bun.spawn([opencode.exe, "worker.ts"]) → yargs treats "worker.ts" as
      //   --project arg → TUI runs instead of daemon → lock never written → timeout.
      //
      // Fix: src/index.ts checks processRole === "worker" before yargs.
      // Here we simulate the compiled binary by spawning src/index.ts (the CLI
      // entrypoint) with OPENCODE_PROCESS_ROLE=worker — it must start the daemon,
      // not the TUI.
      const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const proc = Bun.spawn([process.execPath, INDEX_TS, "src/cli/cmd/tui/worker.ts"], {
        env: {
          ...process.env,
          OPENCODE_PROCESS_ROLE: "worker",
          OPENCODE_LOCK_PATH: lockPath,
          OPENCODE_DB: path.join(tmp.path, "opencode.db"),
          OPENCODE_TEST_HOME: path.join(tmp.path, "home"),
          XDG_DATA_HOME: path.join(tmp.path, "share"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      // If the bug is present, this times out (yargs runs a TUI, no lock file).
      // If fixed, daemon starts and writes the lock.
      const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
      let lock: ServerLockModule.ServerLock | undefined
      while (Date.now() < deadline) {
        lock = await Bun.file(lockPath)
          .text()
          .then((t) => JSON.parse(t) as ServerLockModule.ServerLock)
          .catch(() => undefined)
        if (lock && lock.pid === proc.pid && (await ServerLockModule.ping(lock.port))) break
        lock = undefined
        await Bun.sleep(POLL_INTERVAL_MS)
      }

      proc.kill()
      await proc.exited

      // Must have found the lock — daemon started via the role env var, not yargs TUI.
      expect(lock).toBeDefined()
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )

  test(
    "Unix detached child survives SIGINT sent to the launcher process group",
    async () => {
      if (process.platform === "win32") return

      const childCode = `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`
      const parentCode = `
        const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childCode)}], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        })
        child.unref()
        console.log(child.pid)
        setInterval(() => {}, 1000)
      `
      const parent = Bun.spawn([process.execPath, "-e", parentCode], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        detached: true,
      })
      const childPid = Number(await readFirstLine(parent.stdout))

      try {
        expect(ServerLockModule.alive(childPid)).toBe(true)
        process.kill(-parent.pid, "SIGINT")
        await Promise.race([parent.exited, Bun.sleep(2_000)])
        expect(ServerLockModule.alive(childPid)).toBe(true)
      } finally {
        try {
          process.kill(childPid, "SIGTERM")
        } catch {}
        try {
          parent.kill("SIGTERM")
        } catch {}
        await parent.exited.catch(() => undefined)
      }
    },
    SIGNAL_TEST_TIMEOUT_MS,
  )
})

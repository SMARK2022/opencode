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
import { mkdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../../fixture/fixture"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url))
// `daemon stop` 是用户可见的 CLI 行为，测试必须从真实入口验证，而不是直接调用内部 helper；
// 这样后续重构命令注册、yargs 包装或 worker 启动路径时，仍会保住完整的外部契约。
const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))

const DAEMON_START_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100
const SIGNAL_TEST_TIMEOUT_MS = 10_000

afterEach(() => {
  ServerLockModule._setLockPath(undefined)
})

function isolatedDaemonEnv(lockPath: string, env: Record<string, string> = {}) {
  const root = path.dirname(lockPath)
  return {
    ...process.env,
    // 继承真实 opencode 会话的 launcher pid 会让 startup idle 认为启动 TUI 仍存活；
    // 默认清空以保持测试隔离，具体 launcher 场景再通过 env 参数显式覆盖。
    OPENCODE_DAEMON_LAUNCHER_PID: "",
    // CLI 行为测试必须走 main/yargs 入口；测试进程可能继承 opencode 自身的 worker 角色，
    // 不显式覆盖会让子进程绕过命令解析并启动 daemon worker，导致 stop 命令契约没有被测试到。
    OPENCODE_PROCESS_ROLE: "main",
    ...env,
    // 每个测试都使用独立 lock、数据库和 XDG 目录；这是命令路径相关测试的安全边界，
    // 可避免 `daemon stop` 在测试机上读取或停止开发者正在使用的真实后台 daemon。
    OPENCODE_LOCK_PATH: lockPath,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "share"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function prepareCliData(lockPath: string) {
  const dataDir = path.join(path.dirname(lockPath), "share", "opencode")
  await mkdir(dataDir, { recursive: true })
  // CLI 子进程会在 handler 前执行一次历史数据迁移检查；这些测试验证的是 stop 命令，
  // 预置 marker 可避免首次迁移耗时或阻塞把断言焦点从 daemon 生命周期偏移到存储迁移。
  await Bun.write(path.join(dataDir, "opencode.db"), "")
}

function authHeaders(env: Record<string, string>) {
  if (!env.OPENCODE_SERVER_PASSWORD) return undefined
  // 测试 helper 必须按协议构造 Basic auth，而不是依赖 ServerAuth/Flag 的模块加载时机；
  // 这样可以精确模拟 CLI 子进程环境里的 OPENCODE_SERVER_PASSWORD/USERNAME。
  return {
    Authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
  }
}

async function runDaemonStop(lockPath: string, env: Record<string, string> = {}) {
  await prepareCliData(lockPath)
  // 使用 argv 数组直接调用真实 CLI，避免 shell 引号、空格路径、管道或重定向参与解析；
  // 这样测试覆盖的是 opencode 命令契约，而不是当前 shell 的字符串拆分行为。
  const proc = Bun.spawn([process.execPath, INDEX_TS, "daemon", "stop"], {
    env: isolatedDaemonEnv(lockPath, env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { exitCode, stderr }
}

/**
 * Spawn the daemon with an isolated lock file in `tmp`, then poll until the
 * lock appears and the HTTP server responds.  Returns the running proc and the
 * live lock contents.
 */
async function spawnDaemon(lockPath: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, WORKER_TS], {
    env: {
      ...isolatedDaemonEnv(lockPath, env),
      OPENCODE_PROCESS_ROLE: "worker",
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
      const ok = await ServerLockModule.ping(lock.port, { headers: authHeaders(env) })
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

async function readUntil(reader: ReadableStreamDefaultReader<string>, text: string) {
  let seen = ""
  while (!seen.includes(text)) {
    const next = await reader.read()
    if (next.done) break
    seen += next.value
  }
  return seen
}

describe("daemon lifecycle", () => {
  test(
    "daemon stop command gracefully stops daemon and clears the lock file",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        const result = await runDaemonStop(lockPath)
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("Stopped opencode daemon.")

        const daemonExit = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(daemonExit).not.toBe("timeout")
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "daemon stop announces shutdown to connected TUI event streams before exit",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, { signal: ctrl.signal })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

        try {
          const first = await reader.read()
          expect(first.value).toContain("server.connected")

          const stop = runDaemonStop(lockPath)
          const shutdownEvent = await Promise.race([readUntil(reader, "daemon-stop"), Bun.sleep(5_000).then(() => "timeout")])
          expect(shutdownEvent).not.toBe("timeout")
          expect(String(shutdownEvent)).toContain("global.disposed")
          expect(String(shutdownEvent)).toContain("daemon-stop")
          await stop
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "daemon stop command authenticates the health check when server password is configured",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const env = {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_SERVER_USERNAME: "daemon-user",
        OPENCODE_SERVER_PASSWORD: "daemon password with spaces",
      }
      const { proc } = await spawnDaemon(lockPath, env)

      try {
        const result = await runDaemonStop(lockPath, env)
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("Stopped opencode daemon.")
        const daemonExit = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(daemonExit).not.toBe("timeout")
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test("daemon stop command is a no-op when no daemon lock exists", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "path with spaces", "tui-server.json")

    const result = await runDaemonStop(lockPath)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("No opencode daemon is running.")
  })

  test("daemon stop command removes a stale lock without signalling a missing process", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")
    const exited = Bun.spawn([process.execPath, "-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await exited.exited

    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: exited.pid,
        port: 4096,
        token: "stale-test-token",
        dbPath: path.join(tmp.path, "opencode.db"),
        channel: "test",
        startedAt: new Date().toISOString(),
      }),
    )

    const result = await runDaemonStop(lockPath)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Removed stale opencode daemon lock.")
    expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
  })

  test("daemon stop command refuses a live lock without a safe control port", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")
    const nonDaemon = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })

    // 旧 lock 或损坏 lock 没有 controlPort 时，stop 不能退回到 process.kill；
    // 用真实存活进程覆盖“pid 被复用后误杀其他进程”的安全边界。
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: nonDaemon.pid,
        port: 1,
        token: "wrong-owner-token",
        dbPath: path.join(tmp.path, "opencode.db"),
        channel: "test",
        startedAt: new Date().toISOString(),
      }),
    )

    try {
      const result = await runDaemonStop(lockPath)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("does not support safe stop")
      expect(ServerLockModule.alive(nonDaemon.pid)).toBe(true)
      expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeDefined()
    } finally {
      if (ServerLockModule.alive(nonDaemon.pid)) nonDaemon.kill("SIGTERM")
      await nonDaemon.exited.catch(() => undefined)
    }
  })

  test(
    "daemon stop command refuses a mismatched control token without signalling the lock pid",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })
      const nonDaemon = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      try {
        // 端口可达并不证明 lock pid 是 daemon；这里故意把 controlPort 指向真实 daemon，
        // 但 token 换成错误值，验证 stop 只接受当前 lock owner 的私有控制面确认。
        await Bun.write(
          lockPath,
          JSON.stringify({
            ...lock,
            pid: nonDaemon.pid,
            token: "wrong-owner-token",
          }),
        )

        const result = await runDaemonStop(lockPath)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("control endpoint returned 401")
        expect(ServerLockModule.alive(nonDaemon.pid)).toBe(true)
        expect(ServerLockModule.alive(proc.pid)).toBe(true)
      } finally {
        if (ServerLockModule.alive(nonDaemon.pid)) nonDaemon.kill("SIGTERM")
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await Promise.all([nonDaemon.exited.catch(() => undefined), proc.exited.catch(() => undefined)])
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

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
    "daemon private status reports current TUI client count",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        if (!lock.controlPort) throw new Error("missing control port")
        const statusBefore = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_STATUS_PATH}`, {
          headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token },
        }).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
        expect(statusBefore.tuiClients).toBe(0)
        expect(statusBefore.sessionActivity).toBe(0)

        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, { signal: ctrl.signal })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

        try {
          const first = await reader.read()
          expect(first.value).toContain("server.connected")
          const statusDuring = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_STATUS_PATH}`, {
            headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token },
          }).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
          expect(statusDuring.tuiClients).toBe(1)
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
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
    "daemon exits after the last SSE client disconnects",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "250" })

      try {
        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, { signal: ctrl.signal })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        try {
          const first = await reader.read()
          expect(first.value).toContain("server.connected")
          await Bun.sleep(750)
          expect(ServerLockModule.alive(proc.pid)).toBe(true)
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }

        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(exitCode).toBe(0)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "daemon exits if no SSE client connects before startup idle timeout",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
      })

      try {
        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(exitCode).toBe(0)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "daemon exits when launcher dies before the first SSE client connects",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_DAEMON_LAUNCHER_PID: "987654321",
      })

      try {
        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(exitCode).toBe(0)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "daemon does not exit before first SSE while the launcher is alive",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
        OPENCODE_DAEMON_LAUNCHER_PID: String(process.pid),
      })

      try {
        await Bun.sleep(750)
        expect(ServerLockModule.alive(proc.pid)).toBe(true)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeDefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
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
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const proc = Bun.spawn([process.execPath, INDEX_TS, "src/cli/cmd/tui/worker.ts"], {
        env: {
          ...isolatedDaemonEnv(lockPath),
          OPENCODE_PROCESS_ROLE: "worker",
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

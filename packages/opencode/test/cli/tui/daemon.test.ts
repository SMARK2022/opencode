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
import { mkdir, rename } from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Database as SQLite } from "bun:sqlite"
import { tmpdir } from "../../fixture/fixture"
import * as DaemonModule from "../../../src/cli/cmd/tui/daemon"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"
import * as Win32Module from "../../../src/cli/cmd/tui/win32"
import type { MaintenanceTask } from "../../../src/storage/cold"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url))
// `daemon stop` 是用户可见的 CLI 行为，测试必须从真实入口验证，而不是直接调用内部 helper；
// 这样后续重构命令注册、yargs 包装或 worker 启动路径时，仍会保住完整的外部契约。
const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))
const DAEMON_TS_URL = new URL("../../../src/cli/cmd/tui/daemon.ts", import.meta.url).href
const MAINTENANCE_RETRY_WORKER = fileURLToPath(new URL("./maintenance-retry-worker.ts", import.meta.url))
const TASK_WRITE_RETRY_WORKER = fileURLToPath(new URL("./task-write-retry-worker.ts", import.meta.url))

const DAEMON_START_TIMEOUT_MS = 30_000
const DAEMON_STOP_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 100
const SIGNAL_TEST_TIMEOUT_MS = 10_000

afterEach(() => {
  // 每个case恢复默认spawn与lock owner，测试注入不能泄漏到后续真实进程生命周期场景。
  DaemonModule._setSpawn(undefined)
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
    // Slow WSL/drvfs cold starts can make the real CLI stop path take >5s before
    // it reaches the daemon control endpoint. Startup-idle behavior tests pass
    // explicit shorter values below; lifecycle tests need the daemon to stay up.
    OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
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

async function spawnHangingDisposerDaemon(lockPath: string) {
  // registry 必须在 worker 子进程内注册；测试 runner 与 daemon 不共享进程内 Set。
  // wrapper 先加载 worker，再注册 disposer，确保测试使用真实启动和 shutdown 生命周期。
  // disposer 永不完成，用来稳定制造原始 teardown 卡点而不是依赖时间竞争。
  const registry = pathToFileURL(fileURLToPath(new URL("../../../src/effect/instance-registry.ts", import.meta.url))).href
  const worker = pathToFileURL(WORKER_TS).href
  const wrapper = [
    `const { registerDisposer } = await import(${JSON.stringify(registry)})`,
    `await import(${JSON.stringify(worker)})`,
    `registerDisposer(async () => new Promise(() => {}))`,
    `process.stdout.write("disposer-ready\\n")`,
  ].join("\n")
  const proc = Bun.spawn([process.execPath, "-e", wrapper], {
    env: {
      ...isolatedDaemonEnv(lockPath),
      OPENCODE_PROCESS_ROLE: "worker",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const { lock } = await (async () => {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const lock = await Bun.file(lockPath)
        .text()
        .then((t) => JSON.parse(t) as ServerLockModule.ServerLock)
        .catch(() => undefined)
      if (lock && lock.pid === proc.pid && ServerLockModule.alive(lock.pid)) {
        const ok = await ServerLockModule.ping(lock.port)
        if (ok) return { lock }
      }
      await Bun.sleep(POLL_INTERVAL_MS)
    }
    proc.kill()
    throw new Error(`Hanging disposer daemon did not start within ${DAEMON_START_TIMEOUT_MS} ms`)
  })()
  expect(await readFirstLine(proc.stdout)).toBe("disposer-ready")
  return { proc, lock }
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

async function spawnEnsureLauncher(lockPath: string) {
  // launcher 子进程只发布 lock，不建立 SSE；这正是首个 TUI 事件前的真实边界。
  // detached worker 仍通过环境中的 launcher PID 观察该进程生命周期。
  const launcherCode = `
    const { Daemon } = await import(${JSON.stringify(DAEMON_TS_URL)})
    await Daemon.ensure({})
    const lock = await Bun.file(process.env.OPENCODE_LOCK_PATH).json()
    process.stdout.write(JSON.stringify(lock) + "\\n")
    setInterval(() => {}, 1_000)
  `
  const proc = Bun.spawn([process.execPath, "-e", launcherCode], {
    env: isolatedDaemonEnv(lockPath, {
      OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000",
      OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  const lock = JSON.parse(await readFirstLine(proc.stdout)) as ServerLockModule.ServerLock
  return { proc, lock }
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
    "worker deadline terminates a hanging instance disposer",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnHangingDisposerDaemon(lockPath)

      try {
        const configURL = new URL(`http://127.0.0.1:${lock.port}/config`)
        configURL.searchParams.set("directory", tmp.path)
        // 该 route 经过 InstanceStore middleware，确保 hanging disposer 已拥有 Project context。
        // 先建立真实 Project context，再发送信号，避免只测试一个空闲 worker。
        expect((await fetch(configURL)).ok).toBe(true)
        // 直接给 worker SIGTERM，刻意绕开 CLI force path，才能单独验证 worker deadline。
        // 如果进程只在 CLI 强杀时退出，这个断言会在 7 秒窗口内失败。
        process.kill(proc.pid, "SIGTERM")
        const exit = await Promise.race([proc.exited, Bun.sleep(7_000).then(() => "timeout" as const)])
        expect(exit).not.toBe("timeout")
        expect(ServerLockModule.alive(proc.pid)).toBe(false)
        // worker deadline 的成功条件是进程消失，而不是测试主动发送的信号返回。
        // 该断言也确认 hanging disposer 没有把测试 runner 一起拖入未完成状态。
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    20_000,
  )

  test(
    "force stops an authenticated non-exiting owner",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const token = "isolated-force-stop-token"
      const fakeOwner = `
        const token = ${JSON.stringify(token)}
        const publicServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ healthy: true }) })
        const controlServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            if (request.headers.get("x-opencode-daemon-token") !== token) return new Response("unauthorized", { status: 401 })
            const path = new URL(request.url).pathname
            if (path === "/shutdown") return Response.json({ ok: true })
            if (path === "/status") return Response.json({ tuiClients: 0, sessionActivity: 0, stopping: true })
            return new Response("not found", { status: 404 })
          },
        })
        await Bun.write(${JSON.stringify(lockPath)}, JSON.stringify({
          pid: process.pid,
          port: publicServer.port,
          token,
          dbPath: "isolated",
          channel: "local",
          startedAt: new Date().toISOString(),
          controlPort: controlServer.port,
        }))
        setInterval(() => {}, 1_000)
      `
      const proc = Bun.spawn([process.execPath, "-e", fakeOwner], {
        env: isolatedDaemonEnv(lockPath),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      try {
        // 该 owner 不属于 worker cleanup 测试，专门验证 CLI 的授权 force escalation。
        // fake owner 接受 graceful 请求但保持存活，迫使 stop 命令进入 force 分支。
        // lock 中的 token、PID 和 controlPort 都来自该同一 owner。
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLockModule.ServerLock)
            .catch(() => undefined)
          if (lock?.pid === proc.pid) break
          await Bun.sleep(25)
        }
        const result = await runDaemonStop(lockPath)
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain("Force-stopped opencode daemon.")
        expect(ServerLockModule.alive(proc.pid)).toBe(false)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
        // lock 清理断言同时覆盖 force 后的 stale-owner recovery 边界。
        // 复核失败或 PID 仍存活时，测试必须观察到非零退出而不是这个成功文案。
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    30_000,
  )

  test(
    "refuses force stop when the lock owner changes after graceful timeout",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const token = "changed-owner-original-token"
      const replacementToken = "changed-owner-replacement-token"
      const replacementCode = `
        const token = ${JSON.stringify(replacementToken)}
        const publicServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ healthy: true }) })
        const controlServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ stopping: false }) })
        await Bun.write(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, port: publicServer.port, token, dbPath: "replacement", channel: "local", startedAt: new Date().toISOString(), controlPort: controlServer.port }))
        setInterval(() => {}, 1_000)
      `
      const fakeOwner = `
        const token = ${JSON.stringify(token)}
        const publicServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ healthy: true }) })
        const controlServer = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            if (request.headers.get("x-opencode-daemon-token") !== token) return new Response("unauthorized", { status: 401 })
            if (new URL(request.url).pathname === "/shutdown") {
              Bun.spawn([process.execPath, "-e", ${JSON.stringify(replacementCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
              return Response.json({ ok: true })
            }
            return Response.json({ stopping: true })
          },
        })
        await Bun.write(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, port: publicServer.port, token, dbPath: "original", channel: "local", startedAt: new Date().toISOString(), controlPort: controlServer.port }))
        setInterval(() => {}, 1_000)
      `
      const original = Bun.spawn([process.execPath, "-e", fakeOwner], {
        env: isolatedDaemonEnv(lockPath),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      try {
        const originalDeadline = Date.now() + 5_000
        while (Date.now() < originalDeadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLockModule.ServerLock)
            .catch(() => undefined)
          if (lock?.pid === original.pid) break
          await Bun.sleep(POLL_INTERVAL_MS)
        }

        // graceful 请求会启动 replacement；stop 随后必须基于新 lock 拒绝 SIGKILL。
        const resultPromise = runDaemonStop(lockPath)
        let replacementPid: number | undefined
        const replacementDeadline = Date.now() + 12_000
        while (Date.now() < replacementDeadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLockModule.ServerLock)
            .catch(() => undefined)
          if (lock?.token === replacementToken) {
            replacementPid = lock.pid
            break
          }
          await Bun.sleep(POLL_INTERVAL_MS)
        }
        const result = await resultPromise
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("owner changed")
        expect(result.stderr).not.toContain("Force-stopped")
        expect(replacementPid).toBeDefined()
        expect(ServerLockModule.alive(replacementPid!)).toBe(true)
        // replacement 存活是 changed-owner 安全断言的核心，而非仅检查错误文案。
      } finally {
        if (ServerLockModule.alive(original.pid)) original.kill()
        const replacement = await Bun.file(lockPath)
          .text()
          .then((text) => JSON.parse(text) as ServerLockModule.ServerLock)
          .catch(() => undefined)
        if (replacement && replacement.pid !== original.pid && ServerLockModule.alive(replacement.pid)) process.kill(replacement.pid)
        await original.exited.catch(() => undefined)
      }
    },
    40_000,
  )

  test("does not reuse an owner that reports stopping", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")
    ServerLockModule._setLockPath(lockPath)
    const token = "stopping-owner-token"
    const fakeOwner = `
      const token = ${JSON.stringify(token)}
      const publicServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ healthy: true }) })
      const controlServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          if (request.headers.get("x-opencode-daemon-token") !== token) return new Response("unauthorized", { status: 401 })
          if (new URL(request.url).pathname === "/status") return Response.json({ stopping: true })
          return Response.json({ ok: true })
        },
      })
      await Bun.write(${JSON.stringify(lockPath)}, JSON.stringify({
        pid: process.pid,
        port: publicServer.port,
        token,
        dbPath: "isolated",
        channel: "local",
        startedAt: new Date().toISOString(),
        controlPort: controlServer.port,
      }))
      setTimeout(() => process.exit(0), 300)
    `
    const owner = Bun.spawn([process.execPath, "-e", fakeOwner], {
      env: isolatedDaemonEnv(lockPath),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    DaemonModule._setSpawn(() => ({
      pid: process.pid,
      exited: Promise.resolve(1),
      unref() {},
      kill() {},
    }))

    try {
      // stopping owner 必须等待退出后再进入选主，不能把旧 public URL 当作成功结果。
      // fake owner 的 status 只通过 token-protected control endpoint 暴露 stopping。
      // ensure 若复用旧 URL，测试会在 owner 退出后返回不可用地址并失败。
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const lock = await Bun.file(lockPath)
          .text()
          .then((text) => JSON.parse(text) as ServerLockModule.ServerLock)
          .catch(() => undefined)
        if (lock?.pid === owner.pid) break
        await Bun.sleep(25)
      }
      await expect(
        DaemonModule.ensure({
          port: 0,
          hostname: "127.0.0.1",
          mdns: false,
          "mdns-domain": "opencode.local",
          cors: [],
        }),
      ).rejects.toThrow(/daemon exited before startup/)
    } finally {
      if (ServerLockModule.alive(owner.pid)) owner.kill()
      await owner.exited.catch(() => undefined)
    }
  })

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
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
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
          const shutdownEvent = await Promise.race([
            readUntil(reader, "daemon-stop"),
            Bun.sleep(DAEMON_STOP_TIMEOUT_MS).then(() => "timeout"),
          ])
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
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
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
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeUndefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
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
    expect(
      await Bun.file(lockPath)
        .text()
        .catch(() => undefined),
    ).toBeUndefined()
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
      expect(
        await Bun.file(lockPath)
          .text()
          .catch(() => undefined),
      ).toBeDefined()
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
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
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
        const statusBefore = await fetch(
          `http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_STATUS_PATH}`,
          {
            headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token },
          },
        ).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
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
          const statusDuring = await fetch(
            `http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_STATUS_PATH}`,
            {
              headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token },
            },
          ).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
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

  test("maintenance lease rejects a live owner and reclaims a dead owner", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "lease.db")
    // 第一段锁定 live owner 不能被第二任务抢占；release 后手工构造 dead owner 覆盖 crash reclaim。
    // dead reclaim 必须让新 lease assertOwned 成功，而不是仅删除旧目录后留下未发布窗口。
    // 该测试使用显式 dbPath，不触碰开发者 daemon lock/DB，也不依赖平台 advisory lock 实现。
    const first = await ServerLockModule.acquireMaintenanceLease({ taskID: "dbm_live", dbPath })
    await expect(ServerLockModule.acquireMaintenanceLease({ taskID: "dbm_competing", dbPath })).rejects.toBeInstanceOf(
      ServerLockModule.MaintenanceBusyError,
    )
    await first.release()

    const lockDir = path.join(`${dbPath}.maintenance`, "lock")
    await mkdir(lockDir, { recursive: true })
    await Bun.write(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-owner",
        taskID: "dbm_dead",
        dbPath: path.resolve(dbPath),
        startedAt: 1,
      }),
    )
    const recovered = await ServerLockModule.acquireMaintenanceLease({ taskID: "dbm_recovered", dbPath })
    recovered.assertOwned()
    await recovered.release()

    // record 放在当前 DB root 却声明另一个 dbPath 时必须拒绝，防止 resume 锁错数据库后执行当前连接。
    const now = Date.now()
    const taskDir = path.join(`${dbPath}.maintenance`, "tasks")
    await mkdir(taskDir, { recursive: true })
    await Bun.write(
      path.join(taskDir, "dbm_wrong-path.json"),
      JSON.stringify({
        version: 1,
        taskID: "dbm_wrong-path",
        dbPath: path.join(tmp.path, "other.db"),
        operation: "compress",
        args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
        status: "interrupted",
        cursor: { owner: "message", lastID: "" },
        processed: 0,
        skipped: 0,
        failed: 0,
        rawBytes: 0,
        compressedBytes: 0,
        createdAt: now,
        updatedAt: now,
      }),
    )
    await expect(ServerLockModule.readMaintenanceTask("dbm_wrong-path", dbPath)).rejects.toBeInstanceOf(
      ServerLockModule.MaintenanceLeaseError,
    )
  }, 10_000)

  test.skipIf(process.platform !== "win32")(
    "maintenance owner handle produces the transient rename code used by stale reclaim",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "lease-sharing.db")
      const lockDir = path.join(`${dbPath}.maintenance`, "lock")
      const ownerPath = path.join(lockDir, "owner.json")
      await mkdir(lockDir, { recursive: true })
      await Bun.write(
        ownerPath,
        JSON.stringify({
          pid: 2_147_483_647,
          token: "dead-sharing-owner",
          taskID: "dbm_dead_sharing",
          dbPath: path.resolve(dbPath),
          startedAt: 1,
        }),
      )
      // FileShare.Read拒绝delete/rename，复现CI全量负载下scanner或延迟reader留下的真实NT sharing boundary。
      // holder用stdin作为释放协议，测试控制真实handle时序而非依赖PowerShell timer精度。
      const holder = Bun.spawn(
        [
          "pwsh",
          "-NoProfile",
          "-Command",
          '$stream=[System.IO.File]::Open($env:OWNER_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::Out.WriteLine("ready"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()',
        ],
        { env: { ...process.env, OWNER_PATH: ownerPath }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const ready = await holder.stdout.getReader().read()
      expect(new TextDecoder().decode(ready.value)).toContain("ready")

      try {
        // 真实NT句柄只验证production允许列表的错误形状，retry时序由独立worker的published marker证明。
        const conflict = await rename(lockDir, path.join(`${dbPath}.maintenance`, "stale-dead-sharing-owner")).catch(
          (error) => error,
        )
        const code = typeof conflict === "object" && conflict !== null && "code" in conflict ? conflict.code : undefined
        expect(["EPERM", "EACCES", "EBUSY"]).toContain(code)
      } finally {
        await holder.stdin.write("release\n")
        await holder.stdin.end()
        if (ServerLockModule.alive(holder.pid)) holder.kill()
        await holder.exited.catch(() => undefined)
      }
    },
    10_000,
  )

  test("maintenance lease retries after a published transient rename conflict", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "lease-injected.db")
    const worker = Bun.spawn([process.execPath, MAINTENANCE_RETRY_WORKER], {
      env: { ...process.env, OPENCODE_TEST_MAINTENANCE_DB: dbPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = worker.stdout.pipeThrough(new TextDecoderStream()).getReader()

    try {
      // worker marker证明public acquisition已收到首次EACCES；此后release不再依赖调度延迟或elapsed time。
      expect(await readUntil(reader, "rename-blocked")).toContain("rename-blocked")
      await worker.stdin.write("release\n")
      await worker.stdin.end()
      expect(await readUntil(reader, "lease-owned")).toContain("lease-owned")
      expect(await worker.exited).toBe(0)
    } finally {
      reader.releaseLock()
      if (ServerLockModule.alive(worker.pid)) worker.kill()
      await worker.exited.catch(() => undefined)
    }
  }, 10_000)

  test("writeMaintenanceTask retries after a published transient task-file rename conflict", async () => {
    // 覆盖 checkpoint 路径：task json 的 tmp→rename 与 Windows 轮询 reader 竞争时的 EPERM 重试，
    // 与 stale lock directory rename 共用 renameWithTransientRetry 合同。
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "task-write-injected.db")
    const worker = Bun.spawn([process.execPath, TASK_WRITE_RETRY_WORKER], {
      env: { ...process.env, OPENCODE_TEST_MAINTENANCE_DB: dbPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = worker.stdout.pipeThrough(new TextDecoderStream()).getReader()

    try {
      expect(await readUntil(reader, "rename-blocked")).toContain("rename-blocked")
      await worker.stdin.write("release\n")
      await worker.stdin.end()
      expect(await readUntil(reader, "write-ok")).toContain("write-ok")
      expect(await worker.exited).toBe(0)
      const task = await ServerLockModule.readMaintenanceTask("dbm_write_atomic_retry", dbPath)
      expect(task?.status).toBe("interrupted")
    } finally {
      reader.releaseLock()
      if (ServerLockModule.alive(worker.pid)) worker.kill()
      await worker.exited.catch(() => undefined)
    }
  }, 10_000)

  test(
    "daemon maintenance control persists and completes a task",
    async () => {
      // 真实 worker 子进程覆盖 token-protected start/status 协议，不能用直接调用 helper 代替 daemon lifecycle。
      // 空数据库仍创建持久 task，证明 task contract 不依赖存在可压缩 owner 才可查询。
      // 轮询 terminal record 而非固定 sleep，避免 CI 启动速度影响行为断言。
      // 测试结束走 SIGTERM graceful shutdown，确保 maintenance 完成后 daemon lock 可正常释放。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        if (!lock.controlPort) throw new Error("missing control port")
        const start = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_MAINTENANCE_PATH}`, {
          method: "POST",
          headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token, "content-type": "application/json" },
          body: JSON.stringify({ operation: "compress", olderThanMs: 0, batchSize: 1 }),
        })
        expect(start.status).toBe(202)
        const started: unknown = await start.json()
        if (
          typeof started !== "object" ||
          started === null ||
          !("taskID" in started) ||
          typeof started.taskID !== "string" ||
          !("status" in started) ||
          typeof started.status !== "string" ||
          !("createdAt" in started) ||
          typeof started.createdAt !== "number"
        ) {
          throw new Error("invalid maintenance start response")
        }
        expect(started.taskID).toStartWith("dbm_")
        expect(started.status).toBe("queued")
        expect(started.createdAt).toBeGreaterThan(0)

        let terminal: { status: string } | undefined
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const response = await fetch(
            `http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_MAINTENANCE_STATUS_PATH}?task=${started.taskID}`,
            { headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token } },
          )
          const body: unknown = await response.json()
          if (typeof body !== "object" || body === null || !("status" in body) || typeof body.status !== "string") {
            throw new Error("invalid maintenance status response")
          }
          terminal = { status: body.status }
          if (terminal.status === "completed" || terminal.status === "failed") break
          await Bun.sleep(50)
        }
        expect(terminal?.status).toBe("completed")
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 20_000,
  )

  test(
    "db status waits for the daemon's complete report beyond the control acknowledgement deadline",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })

      try {
        if (!lock.controlPort) throw new Error("missing control port")
        // worker 延迟打开数据库；先走同一 status seam 完成真实 migration，再写入压力夹具。
        const initialized = await fetch(
          `http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_MAINTENANCE_PATH}`,
          {
            method: "POST",
            headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token, "content-type": "application/json" },
            body: JSON.stringify({ operation: "status" }),
          },
        )
        expect(initialized.status).toBe(200)
        // 该夹具只放大真实 eligibility 扫描，不伪造 worker 延迟或添加测试专用生产分支。
        const db = new SQLite(lock.dbPath)
        // 关闭 FK 仅服务压力夹具插入速度，不改变 status 的 eligibility 语义。
        db.exec("PRAGMA foreign_keys = OFF")
        const insert = db.prepare(
          "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
        )
        // 单一缺失 Session 让每行仍经过公开候选/extraction 路径，同时避免构造无关业务历史。
        // 40 万 reasoning 行把 exact candidate 扫描推过旧 2s 合同，规模取自 live 证据量级。
        db.transaction(() => {
          for (let i = 0; i < 400_000; i++)
            insert.run(`prt_status_${i}`, "msg_status", "ses_status", '{"type":"reasoning","text":"x"}')
        })()
        db.close()

        // 真实 CLI 读取同一 lock/token；旧两秒 deadline 会在 daemon 完成精确报告前退出。
        const status = Bun.spawn([process.execPath, INDEX_TS, "db", "status"], {
          env: isolatedDaemonEnv(lockPath),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        // 外层安全期限只约束测试进程，不缩短产品 status 对合法数据库的完成合同。
        const result = await Promise.race([
          Promise.all([status.exited, new Response(status.stdout).text(), new Response(status.stderr).text()]),
          Bun.sleep(30_000).then(() => "timeout" as const),
        ])
        if (result === "timeout") {
          status.kill()
          throw new Error("db status test exceeded 30 seconds")
        }
        const [exitCode, stdout, stderr] = result
        expect(exitCode, stderr).toBe(0)
        // UI JSON 与一次性 migration 提示共用 stderr，按首个对象边界读取用户可见报告。
        const output = stdout || stderr.slice(stderr.indexOf("{"))
        // 完成证据必须是完整 StatusReport 字段，而不是仅证明 HTTP 连接未报错。
        expect(JSON.parse(output)).toMatchObject({
          type: "status",
          report: { eligibleOwners: 0, payloads: 0, refCountMismatches: 0, orphans: 0 },
        })
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 45_000,
  )

  test(
    "daemon startup resumes an interrupted maintenance task from its persisted record",
    async () => {
      // interrupted record 在 worker 启动前落盘，覆盖 startup timer 尚未登记 activeMaintenance 的竞争窗口。
      // startup idle 小于常规任务窗口，completed 断言证明 recoveryPending 阻止 daemon 提前退出。
      // operation/args/cursor 全部来自 record，测试不通过 control resume 人工触发恢复。
      // 独立 dbPath/lock/XDG 目录保证不会读取开发者实际 daemon 或 maintenance tasks。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const dbPath = path.join(tmp.path, "opencode.db")
      const task: MaintenanceTask = {
        version: 1,
        taskID: "dbm_startup-recovery",
        dbPath,
        operation: "compress",
        args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
        status: "interrupted",
        cursor: { owner: "message", lastID: "" },
        processed: 0,
        skipped: 0,
        failed: 0,
        rawBytes: 0,
        compressedBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await ServerLockModule.writeMaintenanceTask(task)
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
      })

      try {
        const deadline = Date.now() + 10_000
        let recovered: MaintenanceTask | undefined
        while (Date.now() < deadline) {
          recovered = await ServerLockModule.readMaintenanceTask(task.taskID, dbPath)
          if (recovered?.status === "completed" || recovered?.status === "failed") break
          await Bun.sleep(50)
        }
        if (recovered?.status === "failed") throw new Error(`startup recovery failed: ${recovered.error ?? "unknown"}`)
        expect(recovered?.status).toBe("completed")
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 20_000,
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
        const lockAfter = await Bun.file(lockPath)
          .text()
          .catch(() => undefined)
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
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeUndefined()
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
        // Windows CI 冷启动时 worker 写 lock 和 HTTP ready 可能超过 250ms；
        // 这里仍验证“无首个 SSE 会在启动 idle 后退出”，但给 daemon 留出可观测的启动窗口。
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "2000",
      })

      try {
        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(exitCode).toBe(0)
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeUndefined()
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
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeUndefined()
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
        expect(
          await Bun.file(lockPath)
            .text()
            .catch(() => undefined),
        ).toBeDefined()
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "launcher Ctrl-C before first SSE releases the worker for subsequent acquisition",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const first = await spawnEnsureLauncher(lockPath)

      try {
        // 真实 launcher 已完成 Daemon.ensure，但刻意没有打开 SSE，再模拟启动期 Ctrl-C。
        first.proc.kill("SIGINT")
        const launcherExit = await Promise.race([first.proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(launcherExit).not.toBe("timeout")

        const cleanupDeadline = Date.now() + 8_000
        while (Date.now() < cleanupDeadline && ServerLockModule.alive(first.lock.pid)) await Bun.sleep(POLL_INTERVAL_MS)
        expect(ServerLockModule.alive(first.lock.pid)).toBe(false)
        // 这里等待的是 worker PID 死亡，而不是 lock 文件偶然被删除。

        // 清理完成后再次走公开 Daemon.ensure 路径，不能返回第一个已死亡 owner 的旧 URL。
        const second = await spawnEnsureLauncher(lockPath)
        expect(second.lock.pid).not.toBe(first.lock.pid)
        await runDaemonStop(lockPath)
        second.proc.kill("SIGINT")
        await second.proc.exited.catch(() => undefined)
      } finally {
        if (ServerLockModule.alive(first.proc.pid)) first.proc.kill()
        if (ServerLockModule.alive(first.lock.pid)) process.kill(first.lock.pid)
        await first.proc.exited.catch(() => undefined)
      }
    },
    40_000,
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

  test("win32DetachConsole is a no-op on non-Windows platforms", () => {
    // win32DetachConsole 在非 win32 平台必须静默返回，不抛错、不依赖 kernel32。
    // 这是跨平台安全边界：worker.ts 无条件 import win32 模块，函数内自检平台。
    expect(() => Win32Module.win32DetachConsole()).not.toThrow()
  })

  test.skipIf(process.platform !== "win32")(
    "Windows daemon wrapper preserves a worker target path containing spaces",
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "worker path with spaces")
      const marker = path.join(tmp.path, "worker.json")
      const worker = path.join(directory, "worker script.ts")
      await mkdir(directory, { recursive: true })
      await Bun.write(
        worker,
        `await Bun.write(Bun.stdout, "x".repeat(1_000_000))\nawait Bun.write(process.env.DAEMON_SPACE_MARKER, JSON.stringify({ pid: process.pid }))\nsetInterval(() => {}, 1000)\n`,
      )
      // marker写在大输出之后，若adapter只读取PID首行而不持续drain，本测试会卡在可观察ready之前。
      // target来自真实空格路径；marker位于大段stdout之后，同时证明PID channel持续drain而不会堵住worker。
      const proc = await DaemonModule._spawn([process.execPath, worker], {
        env: { ...process.env, DAEMON_SPACE_MARKER: marker },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: false,
      })

      try {
        const deadline = Date.now() + 10_000
        let pid: number | undefined
        while (Date.now() < deadline) {
          const value = await Bun.file(marker)
            .json()
            .catch(() => undefined)
          if (typeof value?.pid === "number") {
            pid = value.pid
            break
          }
          await Bun.sleep(25)
        }
        // adapter暴露的必须是真实worker而非wrapper PID，startup timeout和Server Lock才能共享同一owner。
        expect(pid).toBe(proc.pid)
      } finally {
        proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    20_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Windows daemon remains healthy after its launcher exits",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const project = path.join(tmp.path, "project")
      await mkdir(project, { recursive: true })
      // Project内故意放置同名假程序，证明wrapper解析依赖SystemRoot绝对路径而不是当前cwd搜索顺序。
      await Bun.write(path.join(project, "powershell.exe"), "not a system executable")
      const parentCode = `
        const { Daemon } = await import(${JSON.stringify(DAEMON_TS_URL)})
        const url = await Daemon.ensure({})
        const ctrl = new AbortController()
        const response = await fetch(url + "/global/event", { signal: ctrl.signal })
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        await reader.read()
        const lock = await Bun.file(process.env.OPENCODE_LOCK_PATH).json()
        process.stdout.write(JSON.stringify(lock) + "\\n")
        ctrl.abort()
        await reader.cancel().catch(() => undefined)
        process.exit(0)
      `
      const launcher = Bun.spawn([process.execPath, "-e", parentCode], {
        cwd: project,
        env: {
          ...isolatedDaemonEnv(lockPath),
          OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000",
          OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const lock = JSON.parse(await readFirstLine(launcher.stdout)) as ServerLockModule.ServerLock
      expect(await launcher.exited).toBe(0)

      try {
        // Project中的同名程序不能参与wrapper解析；launcher退出也不能成为daemon生命周期事件。
        // 同一PID/lock必须继续服务，第二个TUI才能复用owner而不是发布替代daemon。
        await Bun.sleep(500)
        expect(ServerLockModule.alive(lock.pid)).toBe(true)
        // 断言原lock PID而非任意health响应，防止replacement daemon把parent-exit回归伪装成成功。
        expect(await ServerLockModule.ping(lock.port)).toBe(true)
        expect((await Bun.file(lockPath).json()).pid).toBe(lock.pid)
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLockModule.alive(lock.pid)) process.kill(lock.pid)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "Windows daemon detaches from the shared console yet keeps serving HTTP, SSE and control port",
    async () => {
      if (process.platform !== "win32") return

      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      // 给 daemon 较长 idle 超时，避免测试期间因 SSE 断开而退出；
      // 这里验证 worker 调用 FreeConsole 脱离 console 后，所有服务通道仍功能正常。
      //
      // 注意：无法在 bun:test 内安全发送真实 CTRL_C_EVENT 来断言「daemon 存活」——
      // GenerateConsoleCtrlEvent(0,0) 会广播给当前 console 全部进程并杀掉测试 runner
      // 自身，且 SetConsoleCtrlHandler(NULL,TRUE) 在 Bun 上无法保护发送进程。
      // Ctrl+C 免疫行为已通过独立进程拓扑实测确认（daemon 心跳在事件广播后持续）。
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "30000" })

      try {
        // 1. 公共 HTTP 健康检查
        const health = await fetch(`http://127.0.0.1:${lock.port}/global/health`)
        expect(health.ok).toBe(true)

        // 2. SSE 事件流：FreeConsole 不影响 HTTP 长连接和 server.connected 推送
        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, { signal: ctrl.signal })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        try {
          expect((await reader.read()).value).toContain("server.connected")
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }

        // 3. 私有控制端口：opencode daemon stop 的安全通道仍可用
        if (!lock.controlPort) throw new Error("missing control port")
        const status = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLockModule.CONTROL_STATUS_PATH}`, {
          headers: { [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token },
        })
        expect(status.ok).toBe(true)
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
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

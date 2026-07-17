/**
 * Daemon lifecycle integration tests.
 *
 * 这些测试启动真实的守护进程（bun worker.ts），覆盖完整的
 * 启动 → 健康检查 → 关闭生命周期。它们能捕获单元测试无法捕获的
 * bug——例如编译后的二进制以 Bun.spawn([opencode.exe, "worker.ts"]) 方式
 * 启动时 yargs 将 "worker.ts" 误解析为 --project 参数，导致 TUI 运行
 * 而非守护进程，最终 30 秒超时。
 *
 * 隔离：OPENCODE_LOCK_PATH 设置为临时目录，测试不会触碰真实 XDG state 目录。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"
// #493：maintenance task record 类型来自 core ColdStorage——三用例覆盖 lease 抢占/reclaim、control 协议与 startup recovery。
import type { MaintenanceTask } from "@opencode-ai/core/storage/cold-storage"
import { win32DetachConsole } from "@opencode-ai/tui/terminal-win32"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/tui/worker.ts", import.meta.url))
// stop 的命令注册和参数解析必须通过真实 CLI 入口保留回归覆盖。
const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))
const credentials = { username: "daemon-test", password: "daemon-test-password" }

const DAEMON_START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100
const DAEMON_STOP_TIMEOUT_MS = 60_000

afterEach(() => {
  ServerLock._setLockPath(undefined)
})

// 显式覆盖角色和 launcher，避免 CLI 走 worker 旁路或被宿主存活 PID 保活。
// lock、数据库与 XDG 全部落在同一临时目录，stop 只能找到本用例的服务。
function isolatedDaemonEnv(lockPath: string, env: Record<string, string> = {}) {
  const root = path.dirname(lockPath)
  return {
    ...process.env,
    OPENCODE_DAEMON_LAUNCHER_PID: "",
    OPENCODE_PROCESS_ROLE: "main",
    // Slow WSL/drvfs cold starts can make the real CLI stop path take >5s before
    // it reaches the daemon control endpoint. Startup-idle behavior tests pass
    // explicit shorter values below; lifecycle tests need the daemon to stay up.
    OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
    OPENCODE_SERVER_USERNAME: credentials.username,
    OPENCODE_SERVER_PASSWORD: credentials.password,
    ...env,
    OPENCODE_LOCK_PATH: lockPath,
    OPENCODE_EXTERNAL_NETWORK: "",
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
  // 预置迁移 marker，避免首次数据迁移阻塞 stop 命令的生命周期断言。
  await Bun.write(path.join(dataDir, "opencode.db"), "")
}

async function runDaemonStop(lockPath: string, env: Record<string, string> = {}) {
  await prepareCliData(lockPath)
  // 用 argv 数组保留路径和密码中的空格，并从真实入口验证命令注册。
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
 * 在临时目录中启动守护进程，轮询直到锁文件出现且 HTTP 服务器响应。
 * 返回运行中的进程和锁文件内容。
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

  // 锁文件存在不足以交付 fixture；真实子 PID 与受保护的 HTTP health 必须同时成立。
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const lock = await ServerLock.read(lockPath)

    if (lock && lock.pid === proc.pid && ServerLock.alive(lock.pid)) {
      // 与 worker 使用同一显式凭证，覆盖自定义用户名和含空格密码。
      const ok = await ServerLock.ping(lock.port, {
        username: env.OPENCODE_SERVER_USERNAME ?? credentials.username,
        password: env.OPENCODE_SERVER_PASSWORD ?? credentials.password,
      })
      if (ok) return { proc, lock }
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }

  // 超时后终止进程并抛出错误，避免僵尸守护进程残留
  proc.kill()
  throw new Error(`Daemon did not start within ${DAEMON_START_TIMEOUT_MS} ms`)
}

// 累积 SSE 分块，避免关闭事件被分帧后漏检；五秒上限由调用方负责。
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
  // 这些用例启动真实 worker/CLI，保留完整 stop 契约，仅作静态审查。
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
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

  // 先等待 connected 再调用 stop，确保观察到主动关闭广播；真实启动用例仅作静态审查。
  test(
    "daemon stop announces shutdown to connected TUI event streams before exit",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        const ctrl = new AbortController()
        // 与 fixture 共用显式认证，401 不能被误判为关闭广播缺失。
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, {
          signal: ctrl.signal,
          headers: ServerLock.headers(credentials),
        })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

        try {
          const first = await reader.read()
          expect(first.value).toContain("server.connected")

          const stop = runDaemonStop(lockPath)
          // 同一订阅必须收到 global.disposed 及 daemon-stop 原因，五秒内未收到就失败。
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
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
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
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
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

    // 没有 controlPort 的旧锁不能授权 process.kill；真实存活进程覆盖 PID 复用风险。
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
      expect(ServerLock.alive(nonDaemon.pid)).toBe(true)
      expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeDefined()
    } finally {
      if (ServerLock.alive(nonDaemon.pid)) nonDaemon.kill("SIGTERM")
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
        // 可达的控制端口不证明 PID 属于 daemon，错误 token 必须同时保护两个存活进程。
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
        expect(ServerLock.alive(nonDaemon.pid)).toBe(true)
        expect(ServerLock.alive(proc.pid)).toBe(true)
      } finally {
        if (ServerLock.alive(nonDaemon.pid)) nonDaemon.kill("SIGTERM")
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await Promise.all([nonDaemon.exited.catch(() => undefined), proc.exited.catch(() => undefined)])
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

  test(
    "daemon private status reports current TUI client count",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000" })

      try {
        if (!lock.controlPort) throw new Error("missing control port")
        const statusBefore = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
          headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
        }).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
        expect(statusBefore.tuiClients).toBe(0)
        expect(statusBefore.sessionActivity).toBe(0)

        const ctrl = new AbortController()
        // SSE 与健康 fixture 共用显式认证，401 不能伪装成客户端计数没有增加。
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, {
          signal: ctrl.signal,
          headers: ServerLock.headers(credentials),
        })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

        try {
          const first = await reader.read()
          expect(first.value).toContain("server.connected")
          const statusDuring = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
            headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
          }).then((x) => x.json() as Promise<{ tuiClients: number; sessionActivity: number }>)
          expect(statusDuring.tuiClients).toBe(1)
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
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
        // 直接请求而非复用 poll 的布尔值，确保 fixture 没把锁文件存在误当服务就绪。
        // 已知 credentials 同时供 worker 与请求端使用，401 必须暴露为断言失败而非开放 health。
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/health`, { headers: ServerLock.headers(credentials) })
        expect(res.ok).toBe(true)
        const body: unknown = await res.json()
        expect(body).toMatchObject({ healthy: true })

        // 临时目录若残留旧锁，本断言拒绝把旧 daemon 的健康响应当作本次启动结果。
        expect(lock.pid).toBe(proc.pid)
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )
  test.skipIf(process.platform === "win32")("win32DetachConsole is a no-op on non-Windows platforms", () => {
    // win32DetachConsole 在非 win32 平台必须静默返回，不抛错、不依赖 kernel32。
    // 这是跨平台安全边界：worker.ts 无条件 import win32 模块，函数内自检平台。
    expect(() => win32DetachConsole()).not.toThrow()
  })

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
        const health = await fetch(`http://127.0.0.1:${lock.port}/global/health`, { headers: ServerLock.headers(credentials) })
        expect(health.ok).toBe(true)

        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, { signal: ctrl.signal, headers: ServerLock.headers(credentials) })
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

        if (!lock.controlPort) throw new Error("missing control port")
        const status = await fetch(
          `http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`,
          { headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token } },
        )
        expect(status.ok).toBe(true)
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill()
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

      // fixture 只持有本次启动的 proc handle，不能根据全局发现文件终止其他窗口的服务。
      const { proc } = await spawnDaemon(lockPath)

      // 发送 SIGTERM：Unix 下 gracefulShutdown() 捕获后退出码 0 并清除锁；
      // Windows 下 TerminateProcess() 绕过信号处理器，仅验证进程退出
      proc.kill("SIGTERM")
      const exitCode = await proc.exited

      if (process.platform !== "win32") {
        // Unix 信号进入资源闭包，必须同时断言正常退出和 owner 锁消失，不能只看进程结束。
        expect(exitCode).toBe(0)
        const lockAfter = await Bun.file(lockPath).text().catch(() => undefined)
        expect(lockAfter).toBeUndefined()
      } else {
        // Windows 不执行 Unix SIGTERM handler，不能把 OS 终止行为冒充已验证的 finally 清锁。
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
        // 第二次独立连接排除一次性响应后已经退出的 worker，同时覆盖 auth header 的重复构造。
        expect(await ServerLock.ping(lock.port, credentials)).toBe(true)
        expect(await ServerLock.ping(lock.port, credentials)).toBe(true)
      } finally {
        proc.kill()
        await proc.exited
      }
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )

  // #235：startup idle——首个 SSE client 前无保护会遗留孤儿 daemon
  test(
    "daemon exits if no SSE client connects before startup idle timeout",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      // #235：startup idle 250ms 远小于常规 idle——验证启动期保护独立生效
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
        // #235：显式清零 launcher——宿主 opencode 会话注入的 LAUNCHER_PID 会让 startup idle 永久 skip
        OPENCODE_DAEMON_LAUNCHER_PID: "0",
      })

      try {
        const exitCode = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(exitCode).toBe(0)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  // #235：launcher watcher——launcher 先死且无 client 时按 1s 轮询快速清场
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
        if (ServerLock.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  // #235：launcher 存活时 startup idle 必须重排而非退出——防启动慢的 TUI 误杀
  test(
    "daemon does not exit before first SSE while the launcher is alive",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
        // Windows CI 冷启动窗口更大，通用用例用 2000ms 启动 idle 避免启动期竞态；
        // 专用启动保护用例仍保留 250ms 以验证保护语义本身。
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "2000",
        OPENCODE_DAEMON_LAUNCHER_PID: String(process.pid),
      })

      try {
        await Bun.sleep(750)
        expect(ServerLock.alive(proc.pid)).toBe(true)
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeDefined()
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test(
    "compiled-binary path: spawning with OPENCODE_PROCESS_ROLE=worker env bypasses yargs and starts daemon",
    async () => {
      // 本测试验证编译后二进制的 bug 修复：
      //   Bun.spawn([opencode.exe, "worker.ts"]) → yargs 将 "worker.ts" 解析为
      //   --project 参数 → TUI 运行而非守护进程 → 锁文件永不写入 → 超时。
      //
      // 修复：src/index.ts 在 yargs 之前检查 processRole === "worker"。
      // 这里通过启动 src/index.ts（CLI 入口）并设置 OPENCODE_PROCESS_ROLE=worker
      // 来模拟编译后的二进制——它必须启动守护进程而非 TUI。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const proc = Bun.spawn([process.execPath, INDEX_TS, "src/cli/tui/worker.ts"], {
        env: {
          ...isolatedDaemonEnv(lockPath),
          OPENCODE_PROCESS_ROLE: "worker",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })

      // 锁轮询对编译入口也要求同一子 PID，不能因 cwd 中另一个 daemon 已启动而掩盖 yargs 错路。
      // 进入错误的 TUI 分支不会发布 worker owner，deadline 必须使这种路径显式失败。
      const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
      let lock: ServerLock.ServerLock | undefined
      while (Date.now() < deadline) {
        lock = await ServerLock.read(lockPath)
        if (lock && lock.pid === proc.pid && (await ServerLock.ping(lock.port, credentials))) break
        lock = undefined
        await Bun.sleep(POLL_INTERVAL_MS)
      }

      proc.kill()
      await proc.exited

      // 只有 role 旁路真正运行 worker 才会得到锁，源码文本含旁路条件本身不构成这个断言。
      expect(lock).toBeDefined()
    },
    DAEMON_START_TIMEOUT_MS + 5_000,
  )
  // #173：短 idle 超时 + SSE 断开后守护进程应退出并清锁
  test(
    "daemon exits after the last SSE client disconnects",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      // #173：250ms idle，测试不必等 30s
      // #235：startup idle 显式放宽——本测试验证运行期 idle，不能误触启动期保护
      const { proc, lock } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "250",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "5000",
      })

      try {
        const ctrl = new AbortController()
        const res = await fetch(`http://127.0.0.1:${lock.port}/global/event`, {
          signal: ctrl.signal,
          headers: ServerLock.headers(credentials),
        })
        expect(res.ok).toBe(true)
        if (!res.body) throw new Error("missing SSE body")

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        try {
          const first = await reader.read()
          // #173：先读到 connected，确认 SSE 计数已 +1
          expect(first.value).toContain("server.connected")
          // #173：连接期间必须仍存活，证明 idle 只在断开后计时
          await Bun.sleep(750)
          expect(ServerLock.alive(proc.pid)).toBe(true)
        } finally {
          ctrl.abort()
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }

        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && ServerLock.alive(proc.pid)) {
          await Bun.sleep(50)
        }
        // #173：退出后进程与锁都应消失
        expect(ServerLock.alive(proc.pid)).toBe(false)
        expect(await Bun.file(lockPath).exists()).toBe(false)
      } finally {
        try {
          proc.kill()
        } catch {}
      }
    },
    15_000,
  )

test(
    "maintenance lease rejects a live owner and reclaims a dead owner",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "lease.db")
      // 第一段锁定 live owner 不能被第二任务抢占；release 后手工构造 dead owner 覆盖 crash reclaim。
      // dead reclaim 必须让新 lease assertOwned 成功，而不是仅删除旧目录后留下未发布窗口。
      // 该测试使用显式 dbPath，不触碰开发者 daemon lock/DB，也不依赖平台 advisory lock 实现。
      const first = await ServerLock.acquireMaintenanceLease({ taskID: "dbm_live", dbPath })
      await expect(ServerLock.acquireMaintenanceLease({ taskID: "dbm_competing", dbPath })).rejects.toBeInstanceOf(
        ServerLock.MaintenanceBusyError,
      )
      await first.release()
      const lockDir = path.join(`${dbPath}.maintenance`, "lock")
      await mkdir(lockDir, { recursive: true })
      await Bun.write(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 2_147_483_647,
          token: "deadowner0123456789",
          taskID: "dbm_dead",
          dbPath: path.resolve(dbPath),
          startedAt: 1,
        }),
      )
      const recovered = await ServerLock.acquireMaintenanceLease({ taskID: "dbm_recovered", dbPath })
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
      await expect(ServerLock.readMaintenanceTask("dbm_wrong-path", dbPath)).rejects.toBeInstanceOf(
        ServerLock.MaintenanceLeaseError,
      )
    },
    10_000,
  )

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
        const start = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_MAINTENANCE_PATH}`, {
          method: "POST",
          headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token, "content-type": "application/json" },
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
            `http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${started.taskID}`,
            { headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token } },
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
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 20_000,
  )

  test(
    "daemon startup resumes an interrupted maintenance task from its persisted record",
    async () => {
      // interrupted record 在 worker 启动前落盘，覆盖 startup timer 尚未登记 activeMaintenance 的竞争窗口。
      // startup idle 小于常规任务窗口，completed 断言证明 recovery 阻止 daemon 提前退出。
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
      await ServerLock.writeMaintenanceTask(task)
      const { proc } = await spawnDaemon(lockPath, {
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "5000",
      })

      try {
        const deadline = Date.now() + 10_000
        let recovered: MaintenanceTask | undefined
        while (Date.now() < deadline) {
          recovered = await ServerLock.readMaintenanceTask(task.taskID, dbPath)
          if (recovered?.status === "completed" || recovered?.status === "failed") break
          await Bun.sleep(50)
        }
        if (recovered?.status === "failed") throw new Error(`startup recovery failed: ${recovered.error ?? "unknown"}`)
        expect(recovered?.status).toBe("completed")
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 20_000,
  )
})

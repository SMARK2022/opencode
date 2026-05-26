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
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/tui/worker.ts", import.meta.url))
const credentials = { username: "daemon-test", password: "daemon-test-password" }

const DAEMON_START_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100

afterEach(() => {
  ServerLock._setLockPath(undefined)
})

/**
 * 在临时目录中启动守护进程，轮询直到锁文件出现且 HTTP 服务器响应。
 * 返回运行中的进程和锁文件内容。
 */
async function spawnDaemon(lockPath: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, WORKER_TS], {
    env: {
      ...process.env,
      ...env,
      OPENCODE_PROCESS_ROLE: "worker",
      OPENCODE_LOCK_PATH: lockPath,
      // 真实生命周期 fixture 保持健康路由受保护，显式使用与客户端相同的认证。
      OPENCODE_SERVER_USERNAME: credentials.username,
      OPENCODE_SERVER_PASSWORD: credentials.password,
      OPENCODE_EXTERNAL_NETWORK: "",
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
      const ok = await ServerLock.ping(lock.port, credentials)
      if (ok) return { proc, lock }
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }

  // 超时后终止进程并抛出错误，避免僵尸守护进程残留
  proc.kill()
  throw new Error(`Daemon did not start within ${DAEMON_START_TIMEOUT_MS} ms`)
}

describe("daemon lifecycle", () => {
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
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
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
      const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")

      const proc = Bun.spawn([process.execPath, INDEX_TS, "src/cli/tui/worker.ts"], {
        env: {
          ...process.env,
          OPENCODE_PROCESS_ROLE: "worker",
          OPENCODE_LOCK_PATH: lockPath,
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
        if (lock && lock.pid === proc.pid && (await ServerLock.ping(lock.port))) break
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

})

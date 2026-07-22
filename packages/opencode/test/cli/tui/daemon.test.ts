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
import { mkdir, rename } from "fs/promises"
// #495：win32 spawn adapter 测试沿目标唯一 DaemonProcess seam。
import { DaemonProcess, discoverOrSpawnDaemon } from "../../../src/cli/cmd/tui"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
// #524：db status 压力夹具直接用 bun:sqlite 写入 part 行（FK OFF）。
import { Database } from "bun:sqlite"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"
// #493：maintenance task record 类型来自 core ColdStorage——三用例覆盖 lease 抢占/reclaim、control 协议与 startup recovery。
import type { MaintenanceTask } from "@opencode-ai/core/storage/cold-storage"
import { win32DetachConsole } from "@opencode-ai/tui/terminal-win32"

const WORKER_TS = fileURLToPath(new URL("../../../src/cli/tui/worker.ts", import.meta.url))

// #495：maintenance retry 注入 worker——mock fs/promises.rename 注入一次 EACCES 并发布 marker。
const MAINTENANCE_RETRY_WORKER = fileURLToPath(new URL("./maintenance-retry-worker.ts", import.meta.url))
const TASK_WRITE_RETRY_WORKER = fileURLToPath(new URL("./task-write-retry-worker.ts", import.meta.url))



// #495：marker 读取以 published readiness 为准——不依赖调度延迟或 elapsed-time 断言。
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

// #523：registry 必须在 worker 子进程内注册；测试 runner 与 daemon 不共享进程内 Set。
// wrapper 先加载 worker，再注册 disposer，确保测试使用真实启动和 shutdown 生命周期。
// disposer 永不完成，用来稳定制造原始 teardown 卡点而不是依赖时间竞争。
// 目标 worker 以模块 import 在 -e 子进程内启动，与 spawnDaemon 同一入口语义。
async function spawnHangingDisposerDaemon(lockPath: string) {
  const registry = pathToFileURL(fileURLToPath(new URL("../../../src/effect/instance-registry.ts", import.meta.url))).href
  const worker = pathToFileURL(WORKER_TS).href
  const wrapper = [
    `const { registerDisposer } = await import(${JSON.stringify(registry)})`,
    `await import(${JSON.stringify(worker)})`,
    `registerDisposer(async () => new Promise(() => {}))`,
    `process.stdout.write("disposer-ready\\n")`,
  ].join("\n")
  // #523：wrapper 内的 \\n 必须保持双反斜杠——模板字面量消费一次，-e 解析再消费一次。
  const proc = Bun.spawn([process.execPath, "-e", wrapper], {
    env: {
      ...isolatedDaemonEnv(lockPath),
      OPENCODE_PROCESS_ROLE: "worker",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const lock = await (async () => {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const lock = await Bun.file(lockPath)
        .text()
        .then((t) => JSON.parse(t) as ServerLock.ServerLock)
        .catch(() => undefined)
      if (lock && lock.pid === proc.pid && ServerLock.alive(lock.pid)) {
        const ok = await ServerLock.ping(lock.port, credentials)
        if (ok) return lock
      }
      await Bun.sleep(POLL_INTERVAL_MS)
    }
    proc.kill()
    throw new Error(`Hanging disposer daemon did not start within ${DAEMON_START_TIMEOUT_MS} ms`)
  })()
  await readLineMatching(proc.stdout, (line) => line === "disposer-ready")
  return { proc, lock }
}

// #523：daemon 子进程自身会向 stdout 写 [daemon] 日志行；读取方必须按行匹配而不是假设首行即目标。
async function readLineMatching(stream: ReadableStream<Uint8Array> | null, predicate: (line: string) => boolean) {
  if (!stream) throw new Error("missing stdout stream")
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (predicate(line.trim())) return line.trim()
      }
    }
    throw new Error(`expected stdout line not found; buffer=${JSON.stringify(buffer.slice(0, 200))}`)
  } finally {
    reader.releaseLock()
  }
}

// #523：launcher 子进程只发布 lock，不建立 SSE；这正是首个 TUI 事件前的真实边界。
// detached worker 仍通过环境中的 launcher PID 观察该进程生命周期。
// discover 调用必须在子进程内执行——lock/env 隔离按进程边界生效。
async function spawnEnsureLauncher(lockPath: string) {
  const tuiURL = pathToFileURL(fileURLToPath(new URL("../../../src/cli/cmd/tui.ts", import.meta.url))).href
  const launcherCode = `
    const { discoverOrSpawnDaemon } = await import(${JSON.stringify(tuiURL)})
    await discoverOrSpawnDaemon({ port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] })
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
  const lock = JSON.parse(await readLineMatching(proc.stdout, (line) => line.startsWith("{"))) as ServerLock.ServerLock
  return { proc, lock }
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
  // #523：worker 5s deadline 独立于 CLI force path——SIGTERM 直达 worker 验证自杀边界。
  // 前置 /config 请求建立真实 Project context，避免空 worker 立即 idle-exit 干扰 deadline。
  test(
    "worker deadline terminates a hanging instance disposer",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnHangingDisposerDaemon(lockPath)

      try {
        const configURL = new URL(`http://127.0.0.1:${lock.port}/config`)
        configURL.searchParams.set("directory", tmp.path)
        // #523：该 route 经过 InstanceStore middleware，确保 hanging disposer 已拥有 Project context。
        // 先建立真实 Project context，再发送信号，避免只测试一个空闲 worker。
        expect((await fetch(configURL, { headers: ServerLock.headers(credentials) })).ok).toBe(true)
        // #523：直接给 worker SIGTERM，刻意绕开 CLI force path，才能单独验证 worker deadline。
        // 若 deadline 无效，进程会活到 20s 测试上限而不是 5s timer。
        process.kill(proc.pid, "SIGTERM")
        const exit = await Promise.race([proc.exited, Bun.sleep(7_000).then(() => "timeout" as const)])
        expect(exit).not.toBe("timeout")
        expect(ServerLock.alive(proc.pid)).toBe(false)
        // #523：成功条件是进程消失；hanging disposer 不得把 runner 一起拖入未完成状态。
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    20_000,
  )

  // #523：fake owner 接受 graceful 请求但保持存活，迫使 stop 命令进入 force 分支。
  // control /status 返回 stopping:true 与 force 语义独立——即使 owner 报 stopping 也能被 SIGKILL。
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
        // #523：等待 fake owner 写出 lock——pid 匹配后才可发起 stop，避免误判未启动。
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLock.ServerLock)
            .catch(() => undefined)
          if (lock?.pid === proc.pid) break
          await Bun.sleep(25)
        }
        const result = await runDaemonStop(lockPath)
        expect(result.exitCode).toBe(0)
        // #523：Force-stopped 文案只在同 owner 复核+SIGKILL 成功路径出现。
        expect(result.stderr).toContain("Force-stopped opencode daemon.")
        expect(ServerLock.alive(proc.pid)).toBe(false)
        // #523：lock 清理断言同时覆盖 force 后的 stale-owner recovery 边界。
        expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    30_000,
  )

  // #523：graceful 请求会启动 replacement；stop 随后必须基于新 lock 拒绝 SIGKILL。
  // 这是 force 升级的安全闸：同 pid/token/port 任一变化都拒绝升级。
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
        // #523：先等 original 写锁；后续 replacement 检测以 token 差异为准。
        const originalDeadline = Date.now() + 5_000
        while (Date.now() < originalDeadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLock.ServerLock)
            .catch(() => undefined)
          if (lock?.pid === original.pid) break
          await Bun.sleep(POLL_INTERVAL_MS)
        }

        const resultPromise = runDaemonStop(lockPath)
        let replacementPid: number | undefined
        // #523：10s graceful 窗口内 replacement 必须完成接管，否则测试退化为同 owner force。
        const replacementDeadline = Date.now() + 12_000
        while (Date.now() < replacementDeadline) {
          const lock = await Bun.file(lockPath)
            .text()
            .then((text) => JSON.parse(text) as ServerLock.ServerLock)
            .catch(() => undefined)
          if (lock?.token === replacementToken) {
            replacementPid = lock.pid
            break
          }
          await Bun.sleep(POLL_INTERVAL_MS)
        }
        const result = await resultPromise
        expect(result.exitCode).toBe(1)
        // #523：owner changed 与 Force-stopped 互斥——两者同时出现说明复核分支未生效。
        expect(result.stderr).toContain("owner changed")
        expect(result.stderr).not.toContain("Force-stopped")
        expect(replacementPid).toBeDefined()
        // #523：replacement 存活是 changed-owner 安全断言的核心，而非仅检查错误文案。
        expect(ServerLock.alive(replacementPid!)).toBe(true)
      } finally {
        // #523：replacement 不在本测试的直接句柄内——从 lock 反查 pid 再清理，避免残留进程。
        if (ServerLock.alive(original.pid)) original.kill()
        const replacement = await Bun.file(lockPath)
          .text()
          .then((text) => JSON.parse(text) as ServerLock.ServerLock)
          .catch(() => undefined)
        if (replacement && replacement.pid !== original.pid && ServerLock.alive(replacement.pid)) process.kill(replacement.pid)
        await original.exited.catch(() => undefined)
      }
    },
    40_000,
  )

  // #523：stopping owner 必须等待退出后再进入选主，不能把旧 public URL 当作成功结果。
  // 与源仓 Daemon.ensure 不同，目标的 discoverOrSpawnDaemon 通过 deps 注入便于确定性测试。
  test("does not reuse an owner that reports stopping", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")
    ServerLock._setLockPath(lockPath)
    const token = "stopping-owner-reuse-token"
    // #523：fake owner 在 300ms 后自杀——stopping 探测返回 true 后 discover 必须等它退出。
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

    try {
      // #523：owner 写锁后立即进入 stopping+300ms 自杀窗口；探测时序由短轮询 deps 控制。
      // fake owner 的 status 只通过 token-protected control endpoint 暴露 stopping。
      // deps 全量注入短轮询与假 spawn；owner 退出后选举 spawn 假进程立即 exited，验证不复用旧 URL。
      // 假 spawn 的 exited 立即兑现，等价于「新 daemon 启动即崩溃」；断言的是失败而不是复用旧 URL。
      // 与源仓断言相同：失败信息匹配 /daemon exited before startup/（#179 文案）。
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const lock = await Bun.file(lockPath)
          .text()
          .then((text) => JSON.parse(text) as ServerLock.ServerLock)
          .catch(() => undefined)
        if (lock?.pid === owner.pid) break
        await Bun.sleep(25)
      }
      const deps = {
        // #523：acquire 提供 asyncDispose 空实现——测试不进入真实 flock 文件锁竞争。
        read: () => Bun.file(lockPath).text().then((t) => JSON.parse(t)).catch(() => undefined),
        alive: ServerLock.alive,
        ping: async () => true,
        clear: ServerLock.clearIfOwner,
        acquire: async () => ({ release: async () => {}, [Symbol.asyncDispose]: async () => {} }),
        spawn: async () => ({ pid: process.pid, exited: Promise.resolve(1), unref() {}, kill() {} }),
        sleep: (ms: number) => Bun.sleep(ms),
        resolveDaemonFile: async () => WORKER_TS,
        identity: () => ({ dbPath: "isolated", channel: "local" }),
        placement: () => lockPath,
        resolveNetwork: async () => ({ port: 0, hostname: "127.0.0.1", mdns: false, mdnsDomain: "opencode.local", cors: [] }),
        electionTimeoutMs: 1_000,
        electionStaleMs: 500,
        pollMs: 25,
        waitMs: 5_000,
      } as Parameters<typeof discoverOrSpawnDaemon>[1]
      await expect(
        discoverOrSpawnDaemon({ port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] }, deps),
      ).rejects.toThrow(/daemon exited before startup/)
    } finally {
      if (ServerLock.alive(owner.pid)) owner.kill()
      await owner.exited.catch(() => undefined)
    }
  })

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

  // #523：launcher Ctrl-C 测试——源仓用 Daemon.ensure；目标等价 seam 是 discoverOrSpawnDaemon。
  // #523：真实 launcher 已完成 daemon 发现但未打开 SSE；启动期 Ctrl-C 后 worker 必须可被后续接管。
  test(
    "launcher Ctrl-C before first SSE releases the worker for subsequent acquisition",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const first = await spawnEnsureLauncher(lockPath)

      try {
        // #523：模拟启动期 Ctrl-C——launcher 死亡后 detached worker 不应残留为永久 owner。
        first.proc.kill("SIGINT")
        const launcherExit = await Promise.race([first.proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)])
        expect(launcherExit).not.toBe("timeout")

        // #523：等待 worker PID 死亡，而不是 lock 文件偶然被删除。
        const cleanupDeadline = Date.now() + 8_000
        while (Date.now() < cleanupDeadline && ServerLock.alive(first.lock.pid)) await Bun.sleep(POLL_INTERVAL_MS)
        // #523：8s 窗口覆盖 launcher-exit watcher 的默认检查间隔；超时即回归。
        expect(ServerLock.alive(first.lock.pid)).toBe(false)

        // #523：清理完成后再次走公开发现路径，不能返回第一个已死亡 owner 的旧 URL。
        const second = await spawnEnsureLauncher(lockPath)
        expect(second.lock.pid).not.toBe(first.lock.pid)
        await runDaemonStop(lockPath)
        second.proc.kill("SIGINT")
        await second.proc.exited.catch(() => undefined)
      } finally {
        // #523：first.lock.pid 可能已被二次接管——kill 前再验 alive，避免杀到新 owner。
        if (ServerLock.alive(first.proc.pid)) first.proc.kill()
        if (ServerLock.alive(first.lock.pid)) process.kill(first.lock.pid)
        await first.proc.exited.catch(() => undefined)
      }
    },
    40_000,
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

  test.skipIf(process.platform !== "win32")(
    "maintenance owner handle produces the transient rename code used by stale reclaim",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "lease-sharing.db")
      const lockDir = path.join(`${dbPath}.maintenance`, "lock")
      const ownerPath = path.join(lockDir, "owner.json")
      // owner.json 先于任何 lease 竞争写入，reclaim 路径读到的是本用例构造的 stale 快照。
      await mkdir(lockDir, { recursive: true })
      await Bun.write(
        ownerPath,
        JSON.stringify({
          // PID 取 Windows 合法上限但宿主不可达：alive() 探测必然失败，构造确定性 stale owner。
          pid: 2_147_483_647,
          token: "dead-sharing-owner",
          taskID: "dbm_dead_sharing",
          dbPath: path.resolve(dbPath),
          startedAt: 1,
        }),
      )
      // FileShare.Read 拒绝 delete/rename，复现 CI 全量负载下 scanner 或延迟 reader 留下的真实 NT sharing boundary。
      // holder 用 stdin 作为释放协议，测试控制真实 handle 时序而非依赖 PowerShell timer 精度。
      const holder = Bun.spawn(
        [
          "pwsh",
          "-NoProfile",
          "-Command",
          '$stream=[System.IO.File]::Open($env:OWNER_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::Out.WriteLine("ready"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()',
        ],
        { env: { ...process.env, OWNER_PATH: ownerPath }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      // ready 行是 holder 完成句柄建立的协议；未就绪就 rename 会测到竞态而非 sharing 边界。
      const ready = await holder.stdout.getReader().read()
      expect(new TextDecoder().decode(ready.value)).toContain("ready")

      try {
        // 真实 NT 句柄只验证 production 允许列表的错误形状，retry 时序由独立 worker 的 published marker 证明。
        const conflict = await rename(lockDir, path.join(`${dbPath}.maintenance`, "stale-dead-sharing-owner")).catch(
          (error: unknown) => error,
        )
        const code = typeof conflict === "object" && conflict !== null && "code" in conflict ? (conflict as { code?: string }).code : undefined
        // #495：code 必须属于 production retry 白名单——形状断言而非次数断言。
        expect(code !== undefined && ["EPERM", "EACCES", "EBUSY"].includes(code)).toBe(true)
      } finally {
        // 释放协议经 stdin 而非 kill：Dispose 路径也被覆盖，handle 泄漏窗口才被真实关闭。
        await holder.stdin.write("release\n")
        await holder.stdin.end()
        if (ServerLock.alive(holder.pid)) holder.kill()
        await holder.exited.catch(() => undefined)
      }
    },
    10_000,
  )

  test(
    "maintenance lease retries after a published transient rename conflict",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "lease-injected.db")
      const worker = Bun.spawn([process.execPath, MAINTENANCE_RETRY_WORKER], {
        env: { ...process.env, OPENCODE_TEST_MAINTENANCE_DB: dbPath },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      // 文本流按行读 marker；worker 侧只写 \n 结尾行，跨平台换行判定不依赖二进制解析。
      const reader = worker.stdout.pipeThrough(new TextDecoderStream()).getReader()

      try {
        // worker marker 证明 public acquisition 已收到首次 EACCES；此后 release 不再依赖调度延迟或 elapsed time。
        expect(await readUntil(reader, "rename-blocked")).toContain("rename-blocked")
        await worker.stdin.write("release\n")
        await worker.stdin.end()
        expect(await readUntil(reader, "lease-owned")).toContain("lease-owned")
        // 退出码 0 证明 retry 后的 acquisition 完整走完 release 生命周期，而非中途 fail。
        expect(await worker.exited).toBe(0)
      } finally {
        reader.releaseLock()
        if (ServerLock.alive(worker.pid)) worker.kill()
        await worker.exited.catch(() => undefined)
      }
    },
    10_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Windows daemon wrapper preserves a worker target path containing spaces",
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "worker path with spaces")
      const marker = path.join(tmp.path, "worker.json")
      // 空格同时出现在目录与文件名：任何一层把 target 拼进命令行字符串都会在此用例失败。
      const worker = path.join(directory, "worker script.ts")
      await mkdir(directory, { recursive: true })
      await Bun.write(
        worker,
        `await Bun.write(Bun.stdout, "x".repeat(1_000_000))\nawait Bun.write(process.env.DAEMON_SPACE_MARKER!, JSON.stringify({ pid: process.pid }))\n`,
      )
      // marker 写在大输出之后，若 adapter 只读取 PID 首行而不持续 drain，本测试会卡在可观察 ready 之前。
      // target 来自真实空格路径；marker 位于大段 stdout 之后，同时证明 PID channel 持续 drain 而不会堵住 worker。
      const proc = await DaemonProcess.spawn([process.execPath, worker], {
        env: { ...process.env, DAEMON_SPACE_MARKER: marker },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: false,
      })
      try {
        // 轮询上限只约束测试等待；adapter 的 60s 握手预算独立存在，两者不得互相假设。
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
        // adapter 暴露的必须是真实 worker 而非 wrapper PID，startup timeout 和 Server Lock 才能共享同一 owner。
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
      // #495：Project 内故意放置同名假程序，证明 wrapper 解析依赖 SystemRoot 绝对路径而不是当前 cwd 搜索顺序。
      await Bun.write(path.join(project, "powershell.exe"), "not a system executable")
      // #495：目标 owner 是 cmd/tui 的 discoverOrSpawnDaemon（旧树 Daemon.ensure 的等价 seam）。
      const tuiUrl = fileURLToPath(new URL("../../../src/cli/cmd/tui.ts", import.meta.url))
      const parentCode = `
        const { discoverOrSpawnDaemon } = await import(${JSON.stringify(tuiUrl)})
        const { url } = await discoverOrSpawnDaemon({} as never)
        const ctrl = new AbortController()
        const response = await fetch(url + "/global/event", { headers: ${JSON.stringify(ServerLock.headers(credentials))}, signal: ctrl.signal })
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        await reader.read()
        const lock = await Bun.file(process.env.OPENCODE_LOCK_PATH!).json()
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
        // launcher 本身退出后 lock 与 daemon 必须存活；本用例的关键时序是先观察 lock 再结束 parent。
        stdout: "pipe",
        stderr: "pipe",
      })
      const firstLine = await new Response(launcher.stdout).text()
      const lock = JSON.parse(firstLine.trim()) as ServerLock.ServerLock
      expect(await launcher.exited).toBe(0)
      try {
        // #495：Project 中的同名程序不能参与 wrapper 解析；launcher 退出也不能成为 daemon 生命周期事件。
        // 同一 PID/lock 必须继续服务，第二个 TUI 才能复用 owner 而不是发布替代 daemon。
        await Bun.sleep(500)
        expect(ServerLock.alive(lock.pid)).toBe(true)
        // 断言原 lock PID 而非任意 health 响应，防止 replacement daemon 把 parent-exit 回归伪装成成功。
        expect(await ServerLock.ping(lock.port, credentials)).toBe(true)
        expect((await Bun.file(lockPath).json()).pid).toBe(lock.pid)
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLock.alive(lock.pid)) process.kill(lock.pid)
      }
    },
    DAEMON_START_TIMEOUT_MS + 10_000,
  )

  test("writeMaintenanceTask retries after a published transient task-file rename conflict", async () => {
    // #509：覆盖 checkpoint 路径：task json 的 tmp→rename 与 Windows 轮询 reader 竞争时的 EPERM 重试，
    // 与 stale lock directory rename 共用 renameWithTransientRetry 合同。
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "task-write-injected.db")
    const worker = Bun.spawn([process.execPath, TASK_WRITE_RETRY_WORKER], {
      env: { ...process.env, OPENCODE_TEST_MAINTENANCE_DB: dbPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = worker.stdout!.pipeThrough(new TextDecoderStream()).getReader()

    try {
      expect(await readUntil(reader, "rename-blocked")).toContain("rename-blocked")
      await worker.stdin!.write("release\n")
      await worker.stdin!.end()
      expect(await readUntil(reader, "write-ok")).toContain("write-ok")
      expect(await worker.exited).toBe(0)
      const task = await ServerLock.readMaintenanceTask("dbm_write_atomic_retry", dbPath)
      expect(task?.status).toBe("interrupted")
    } finally {
      reader.releaseLock()
      if (ServerLock.alive(worker.pid)) worker.kill()
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



  // status 报告没有可轮询 task，真实 CLI 必须等到同一请求的完整结果。
  test(
    "db status waits for the daemon's complete report beyond the control acknowledgement deadline",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })

      try {
        if (!lock.controlPort) throw new Error("missing control port")
        // #524：worker 延迟打开数据库；先走同一 status seam 完成真实 migration，再写入压力夹具。
        const initialized = await fetch(
          `http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_MAINTENANCE_PATH}`,
          {
            method: "POST",
            headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token, "content-type": "application/json" },
            body: JSON.stringify({ operation: "status" }),
          },
        )
        expect(initialized.status).toBe(200)
        // #524：该夹具只放大真实 eligibility 扫描，不伪造 worker 延迟或添加测试专用生产分支。
        const db = new Database(lock.dbPath)
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

        // #524：真实 CLI 读取同一 lock/token；旧两秒 deadline 会在 daemon 完成精确报告前退出。
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
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 45_000,
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

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
import stripAnsi from "strip-ansi"
import { spawn as spawnPty } from "#pty"
import { tmpdir } from "../../fixture/fixture"
import * as DaemonModule from "../../../src/cli/cmd/tui/daemon"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"
import * as Win32Module from "../../../src/cli/cmd/tui/win32"
import type { MaintenanceTask } from "../../../src/storage/cold"
import { Flock } from "@opencode-ai/core/util/flock"

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

// 测试后台非交互子进程在 Windows 上必须隐藏 console，与生产 Process/NetworkProxy hide 合同一致；PTY 不走此 helper。
// 返回 any：Bun.spawn 在合并 windowsHide 后会丢失 stdin/stdout 字面量重载，测试侧保留原 pipe 访问写法。
function spawnBackground(cmd: string[], opts: Parameters<typeof Bun.spawn>[1] = {}): any {
  return Bun.spawn(cmd, { ...opts, windowsHide: process.platform === "win32" })
}

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

function controlRequest(
  lock: ServerLockModule.ServerLock,
  pathname: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
) {
  // POST body 与 token 在同一个 request envelope 中，测试不会绕过 daemon control 的鉴权边界。
  return fetch(`http://127.0.0.1:${lock.controlPort}${pathname}`, {
    method,
    headers: {
      [ServerLockModule.CONTROL_TOKEN_HEADER]: lock.token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
// control helper 始终绑定受测 owner token，fixture 不能绕过生产鉴权路径直接调用 worker 内部函数。
async function runDaemonStop(lockPath: string, env: Record<string, string> = {}) {
  await prepareCliData(lockPath)
  // 使用 argv 数组直接调用真实 CLI，避免 shell 引号、空格路径、管道或重定向参与解析；
  // 这样测试覆盖的是 opencode 命令契约，而不是当前 shell 的字符串拆分行为。
  const proc = spawnBackground([process.execPath, INDEX_TS, "daemon", "stop"], {
    env: isolatedDaemonEnv(lockPath, env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { exitCode, stderr }
}

async function runInteractiveDb(
  lockPath: string,
  args: readonly string[],
  answer: "y" | "n",
  beforeAnswer: () => Promise<unknown> = async () => {},
  observe: (chunk: string) => void = () => {},
) {
  const proc = spawnPty(process.execPath, [INDEX_TS, "db", ...args], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: path.dirname(INDEX_TS),
    env: isolatedDaemonEnv(lockPath),
  })
  // 累积完整 PTY scrollback 后再去 ANSI，断言不会依赖单个 onData chunk 的切分。
  let output = ""
  let answered = false
  let reclaimAnswered = false
  proc.onData((data) => {
    output += data
    const text = stripAnsi(output)
    observe(stripAnsi(data))
    if (!answered && text.includes("Stop daemon and continue?")) {
      answered = true
      // hook 在 prompt 已可见而答案尚未提交时运行，专门覆盖用户思考期间的 owner replacement。
      void beforeAnswer().then(() => proc.write(`${answer}\r`))
    }
    if (answered && !reclaimAnswered && text.includes("? Reclaim")) {
      reclaimAnswered = true
      proc.write("n\r")
    }
  })
  const exited = new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode)))
  // prompt 和 task terminal 都来自真实进程；期限只保护测试，不替代产品 status readiness。
  const result = await Promise.race([exited, Bun.sleep(30_000).then(() => "timeout" as const)])
  if (result === "timeout") {
    proc.kill()
    throw new Error(`interactive database command exceeded 30 seconds:\n${stripAnsi(output)}`)
  }
  return { exitCode: result, output: stripAnsi(output).replaceAll("\r", ""), answered }
}
// machine helper 保留 stdout/stderr 分离，daemon JSON 不能借 UI stream 混入提示文本。
async function runDaemonMachine(lockPath: string, command: "status" | "start", env: Record<string, string> = {}) {
  await prepareCliData(lockPath)
  const args = [process.execPath, INDEX_TS, "daemon", command, "--json"]
  if (command === "start") args.push("--launcher-pid", String(process.pid))
  // 机器接口从真实 argv 入口执行，确保 yargs 参数、stdout 协议和 daemon owner 语义一起受测。
  // stdout 只允许一个 JSON value；日志和迁移信息必须留在 stderr，调用方无需解析人类文案。
  const proc = spawnBackground(args, {
    env: isolatedDaemonEnv(lockPath, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

/**
 * Spawn the daemon with an isolated lock file in `tmp`, then poll until the
 * lock appears and the HTTP server responds.  Returns the running proc and the
 * live lock contents.
 */
async function spawnDaemon(lockPath: string, env: Record<string, string> = {}) {
  const proc = spawnBackground([process.execPath, WORKER_TS], {
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
  const proc = spawnBackground([process.execPath, "-e", wrapper], {
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
  const proc = spawnBackground([process.execPath, "-e", launcherCode], {
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

// 同一 reader 上的 stdout 必须跨 wait 累积：同 chunk 内先匹配 A 后的 B 不能在第二次 wait 中丢失。
// WeakMap 按 reader 实例隔离缓冲，禁止跨用例/跨流泄漏状态。
// 本泵只服务 daemon lifecycle 的 marker 合同；不得用于替代生产 control 超时语义。
const stdoutPumpBuffers = new WeakMap<ReadableStreamDefaultReader<string>, string>()

async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  text: string,
  // 有界等待把 marker 缺失变成可诊断失败；默认对齐本文件最长 daemon 安全窗，避免 120s 静默 hang。
  // Force A/B 必须显式传入 2–5s，禁止误用默认窗掩盖分类失败。
  timeoutMs = DAEMON_START_TIMEOUT_MS + 90_000,
) {
  let seen = stdoutPumpBuffers.get(reader) ?? ""
  const deadline = Date.now() + timeoutMs
  while (!seen.includes(text)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // dump 已读缓冲用于区分 IPC 漏 marker 与生产路径挂起；不把 harness 超时伪装成 CI hang 根因已修。
      throw new Error(`timed out waiting for ${JSON.stringify(text)} after ${timeoutMs}ms; seen=${JSON.stringify(seen)}`)
    }
    // 超时分支返回 sentinel，避免与 ReadableStream 的 done 结果混淆。
    const next = await Promise.race([
      reader.read().then((value) => ({ kind: "chunk" as const, value })),
      Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
    ])
    if (next.kind === "timeout") {
      throw new Error(`timed out waiting for ${JSON.stringify(text)} after ${timeoutMs}ms; seen=${JSON.stringify(seen)}`)
    }
    if (next.value.done) break
    seen += next.value.value
    // 每 chunk 回写，保证并发 waitStartGate 与 readUntil 共享同一已读前缀。
    stdoutPumpBuffers.set(reader, seen)
  }
  stdoutPumpBuffers.set(reader, seen)
  return seen
}

// 只读缓冲快照，不推进 stream；供 waitStartGate 在 HTTP settle 时复查 marker。
function stdoutSeen(reader: ReadableStreamDefaultReader<string>) {
  return stdoutPumpBuffers.get(reader) ?? ""
}

// 仅用于 blocked-2：start 的 continue 尚未预缓冲，HTTP 先完成且缓冲无 marker 才可分类为异常。
// blocked-3 禁止使用本竞态（double-continue 预缓冲会使 rename 立即结束并 202）。
// 只观察 Response 对象是否 settled，不消费 body，调用方仍可 await 同一 Promise。
// 25ms 二次泵给 marker 与 HTTP 同窗到达留出缓冲刷新时间，避免假阳性 classify。
async function waitStartGate(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
  http: Promise<Response>,
  timeoutMs: number,
) {
  let settled: Response | undefined
  void http.then((response) => {
    settled = response
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stdoutSeen(reader).includes(marker)) return stdoutSeen(reader)
    if (settled) {
      try {
        await readUntil(reader, marker, 25)
        return stdoutSeen(reader)
      } catch {
        // HTTP 已决且缓冲仍无 marker：对应 outcome B/D 分类，不是 suite 静默 hang。
        throw new Error(
          `start gate HTTP settled without ${JSON.stringify(marker)}: status=${settled.status} seen=${JSON.stringify(stdoutSeen(reader))}`,
        )
      }
    }
    try {
      await readUntil(reader, marker, Math.min(50, Math.max(1, deadline - Date.now())))
      return stdoutSeen(reader)
    } catch {
      // 短窗未命中则继续与 HTTP 竞态。
    }
  }
  // 超时 dump 必须带 stages，供 OD-1 区分 A（有 rename）与 C（无 mkdir-attempt）。
  throw new Error(
    `timed out waiting for start gate ${JSON.stringify(marker)} after ${timeoutMs}ms; seen=${JSON.stringify(stdoutSeen(reader))}`,
  )
}

// 空库 compress 夹具：仅服务 recovery/start gate 诊断，不扩展 ColdStorage 产品语义。
// olderThanMs=0 + batchSize=1 保证 maintain 在空库上快速 completed，避免诊断被业务耗时淹没。
function interruptedCompressTask(taskID: string, dbPath: string): MaintenanceTask {
  return {
    version: 1,
    taskID,
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
}

// 统一 stage worker 源码：mkdir/rename/rm 诊断序与 Track H write-gate 合同只维护一处。
// stage:mkdir-attempt 在 real mkdir 前发出；mkdir-ok 仅成功路径；失败 EEXIST 不发 ok（对齐 stale reclaim）。
// stage:stale-rename 与 rename-blocked-N 同序，表示进入 dead-owner rename gate，非 pre-FS acquire-enter。
// pid 哨兵 2147483647 在 Windows/Unix 上均 dead，强制走 rename reclaim 而非 live busy。
function maintenanceStageWorkerSource(leaseDir: string) {
  return `
    import { mock } from "bun:test"
    import * as fs from "node:fs/promises"
    import path from "node:path"
    const input = Bun.stdin.stream().getReader()
    const realRename = fs.rename.bind(fs)
    const realRm = fs.rm.bind(fs)
    const realMkdir = fs.mkdir.bind(fs)
    const leaseLock = path.resolve(${JSON.stringify(leaseDir)})
    let buffered = ""
    let renameIndex = 0
    let release = true
    const gate = async (name) => {
      process.stdout.write(name + "\\n")
      while (!buffered.includes("\\n")) {
        const next = await input.read()
        if (next.done) return
        buffered += new TextDecoder().decode(next.value)
      }
      buffered = buffered.slice(buffered.indexOf("\\n") + 1)
    }
    mock.module("fs/promises", () => ({
      ...fs,
      mkdir: async (target, options) => {
        if (path.resolve(String(target)) === leaseLock) {
          process.stdout.write("stage:mkdir-attempt\\n")
          try {
            const out = await realMkdir(target, options)
            process.stdout.write("stage:mkdir-ok\\n")
            return out
          } catch (error) {
            throw error
          }
        }
        return realMkdir(target, options)
      },
      rename: async (from, to) => {
        if (path.resolve(String(from)) === leaseLock) {
          process.stdout.write("stage:stale-rename\\n")
          await gate("rename-blocked-" + (++renameIndex))
        }
        return realRename(from, to)
      },
      rm: async (target, options) => {
        if (release && options?.recursive && path.resolve(String(target)) === leaseLock) {
          release = false
          await gate("lease-release-blocked")
        }
        return realRm(target, options)
      },
    }))
    await import(${JSON.stringify(pathToFileURL(WORKER_TS).href)})
  `
}

// stderr ignore 对齐 spawnDaemon：长生命周期 worker 禁止未读 pipe 卫生风险；非 hang 根因声明。
function spawnStageWorker(lockPath: string, leaseDir: string) {
  // 专用 pipe overload 保留 stdin/stdout 静态类型；windowsHide 直接落在同一真实 spawn。
  const proc = Bun.spawn([process.execPath, "-e", maintenanceStageWorkerSource(leaseDir)], {
    env: {
      ...isolatedDaemonEnv(lockPath),
      OPENCODE_PROCESS_ROLE: "worker",
      OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "180000",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: process.platform === "win32",
  })
  return { proc, reader: proc.stdout.pipeThrough(new TextDecoderStream()).getReader() }
}

// dead owner.json 触发 acquire 的 stale rename 分支；token 按调用区分 tombstone 目标名。
async function writeDeadLease(leaseDir: string, taskID: string, dbPath: string, token: string) {
  await mkdir(leaseDir, { recursive: true })
  await Bun.write(
    path.join(leaseDir, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token, taskID, dbPath, startedAt: 1 }),
  )
}

// spawnStageWorker 固定 stdin:"pipe"，收窄 FileSink 供 gate token 写入。
function stageWorkerStdin(proc: ReturnType<typeof Bun.spawn>) {
  const stdin = proc.stdin
  if (!stdin || typeof stdin === "number") throw new Error("stage worker stdin pipe is required")
  return stdin
}

// recovery 段：blocked-1 → continue → lease-release → release → completed；返回可发 start 的 lock。
// 与主 lifecycle 用例共享同一握手，避免 Force A/B 复制第三套 recovery 时序。
async function recoverStageWorkerToIdle(
  proc: ReturnType<typeof Bun.spawn>,
  reader: ReadableStreamDefaultReader<string>,
  lockPath: string,
  taskID: string,
) {
  expect(await readUntil(reader, "rename-blocked-1", 30_000)).toContain("rename-blocked-1")
  await stageWorkerStdin(proc).write("continue\n")
  expect(await readUntil(reader, "lease-release-blocked", 30_000)).toContain("lease-release-blocked")
  let lock: ServerLockModule.ServerLock | undefined
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (!lock && Date.now() < deadline) {
    lock = await Bun.file(lockPath).json().catch(() => undefined)
    if (!lock) await Bun.sleep(POLL_INTERVAL_MS)
  }
  if (!lock?.controlPort) throw new Error("daemon lock missing")
  const terminal = controlRequest(lock, `${ServerLockModule.CONTROL_MAINTENANCE_STATUS_PATH}?task=${taskID}`)
  await stageWorkerStdin(proc).write("release\n")
  expect((await terminal).status).toBe(200)
  return lock
}

describe("daemon lifecycle", () => {
  test("readUntil keeps trailing markers from the same stdout chunk", async () => {
    // INV-H1 红绿：同 chunk 先命中 A 后的 B 必须仍可读；非累积 seen 会在第二次 wait 中永久丢 B。
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("rename-blocked-1\nlease-release-blocked\n")
        controller.close()
      },
    })
    const reader = stream.getReader()
    try {
      expect(await readUntil(reader, "rename-blocked-1", 1_000)).toContain("rename-blocked-1")
      expect(await readUntil(reader, "lease-release-blocked", 1_000)).toContain("lease-release-blocked")
    } finally {
      reader.releaseLock()
    }
  })

  test("readUntil timeout dumps the accumulated stdout buffer", async () => {
    // INV-H3 红绿：有界失败必须带已读缓冲，禁止 marker 缺失时吞掉整段 suite timeout。
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("partial-marker\n")
      },
    })
    const reader = stream.getReader()
    try {
      await expect(readUntil(reader, "missing-marker", 50)).rejects.toThrow(/timed out waiting for "missing-marker".*partial-marker/s)
    } finally {
      reader.releaseLock()
    }
  })

  test(
    "start gate Force A dump includes rename-blocked-2 when continue is withheld",
    async () => {
      // OD-1 Force A：marker 已写但不 continue → 短超时 dump 含 rename 阶段，诊断可红。
      // 不 await start Response：gate 阻塞时 fetch 可能 ECONNRESET，与 dump 断言无关。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const dbPath = path.join(tmp.path, "opencode.db")
      const task = interruptedCompressTask("dbm_force_a", dbPath)
      await ServerLockModule.writeMaintenanceTask(task)
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      await writeDeadLease(leaseDir, task.taskID, dbPath, "dead-force-a")
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      try {
        const lock = await recoverStageWorkerToIdle(proc, reader, lockPath, task.taskID)
        // 第二枚 dead lease 专供 start rename-blocked-2，与 recovery taskID 隔离。
        await writeDeadLease(leaseDir, "dbm_start_gate", dbPath, "dead-start")
        void controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", {
          operation: "compress",
          olderThanMs: 0,
          batchSize: 1,
        }).catch(() => undefined)
        const gated = await readUntil(reader, "rename-blocked-2", 30_000)
        expect(gated).toContain("stage:stale-rename")
        // 3s 故意失败窗：dump 须同时含 stage:stale-rename 与 rename-blocked-2（outcome A）。
        await expect(readUntil(reader, "force-a-missing-marker", 3_000)).rejects.toThrow(
          /timed out waiting for "force-a-missing-marker"[\s\S]*stage:stale-rename[\s\S]*rename-blocked-2/,
        )
      } finally {
        reader.releaseLock()
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 60_000,
  )

  test(
    "start without stale lease fails fast without rename-blocked-2",
    async () => {
      // OD-1 Force B：无 dead lock → mkdir-ok、无 rename-blocked-2；5s 内分类失败，禁 120s 静默。
      // 与 Force A 的差异仅在 start 前是否 writeDeadLease；共享 recover helper 保证对照干净。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const dbPath = path.join(tmp.path, "opencode.db")
      const task = interruptedCompressTask("dbm_force_b", dbPath)
      await ServerLockModule.writeMaintenanceTask(task)
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      await writeDeadLease(leaseDir, task.taskID, dbPath, "dead-force-b")
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      try {
        const lock = await recoverStageWorkerToIdle(proc, reader, lockPath, task.taskID)
        // 故意不装 start 用 stale lease：acquire 应 mkdir 成功路径，不进 rename gate。
        const starting = controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", {
          operation: "compress",
          olderThanMs: 0,
          batchSize: 1,
        })
        await expect(waitStartGate(reader, "rename-blocked-2", starting, 5_000)).rejects.toThrow(
          /start gate HTTP settled without "rename-blocked-2"|timed out waiting for start gate "rename-blocked-2"/,
        )
        // outcome B：无 rename-blocked-2；至少见 mkdir-attempt/ok 之一，证明 start 触达 lease FS。
        const dump = stdoutSeen(reader)
        expect(dump).not.toContain("rename-blocked-2")
        expect(dump.includes("stage:mkdir-ok") || dump.includes("stage:mkdir-attempt")).toBe(true)
      } finally {
        reader.releaseLock()
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 60_000,
  )

  test("daemon status JSON reports no owner without spawning", async () => {
    // 独立lock/XDG/DB保证该查询不可能观察或停止开发者真实daemon。
    // running=false是公开expected literal，测试不读取private lock parser返回类型。
    // lock仍不存在证明status没有把read操作偷偷升级为ensure。
    // 真实CLI入口同时覆盖yargs注册与stdout协议，不使用内部helper得到假绿。
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")

    const result = await runDaemonMachine(lockPath, "status")
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ running: false })
    // status 是纯观察操作；没有 owner 时不得创建 lock 或用 ensure 把查询变成启动。
    expect(await Bun.file(lockPath).exists()).toBe(false)
  })

  test(
    "daemon status JSON reports the current owner without private lock fields",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })

      try {
        const result = await runDaemonMachine(lockPath, "status")
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
          running: true,
          pid: lock.pid,
          url: `http://127.0.0.1:${lock.port}`,
          responsive: true,
        })
        // machine contract 只公开连接所需的 PID/URL；token、control port 和 DB 路径仍属于 lock owner。
        expect(result.stdout).not.toContain(lock.token)
        expect(result.stdout).not.toContain("controlPort")
        expect(result.stdout).not.toContain("dbPath")
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLockModule.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

  test(
    "daemon start JSON creates one owner protected by the external launcher PID and reuses it",
    async () => {
      // 250ms startup idle刻意短于750ms观察窗，使错误launcher PID稳定暴露。
      // 测试进程保持存活代表bot，首次SSE尚未建立，隔离两个liveness阶段。
      // 第二次start比较同一PID/URL，证明复用而非仅有另一个健康owner。
      // finally通过safe stop清理真实worker，失败case也不遗留实验进程。
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const env = {
        OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000",
        OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "250",
      }

      const first = await runDaemonMachine(lockPath, "start", env)
      expect(first.exitCode).toBe(0)
      const owner = JSON.parse(first.stdout) as { running: boolean; pid: number; url: string; responsive: boolean }
      expect(owner.running).toBe(true)
      expect(owner.responsive).toBe(true)

      try {
        // CLI 已退出且没有 SSE；worker 仍须观察测试进程这个外部 launcher，不能观察短命 CLI PID。
        await Bun.sleep(750)
        expect(ServerLockModule.alive(owner.pid)).toBe(true)

        const second = await runDaemonMachine(lockPath, "start", env)
        expect(second.exitCode).toBe(0)
        expect(JSON.parse(second.stdout)).toEqual(owner)
        // 重复 start 必须复用同一 PID/URL，最终选主权仍由现有 Daemon.ensure 持有。
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLockModule.alive(owner.pid)) process.kill(owner.pid)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

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
      const proc = spawnBackground([process.execPath, "-e", fakeOwner], {
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
              // 嵌套 -e 子进程同样隐藏 Windows console，不能依赖外层 spawnBackground。
              Bun.spawn([process.execPath, "-e", ${JSON.stringify(replacementCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: process.platform === "win32" })
              return Response.json({ ok: true })
            }
            return Response.json({ stopping: true })
          },
        })
        await Bun.write(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, port: publicServer.port, token, dbPath: "original", channel: "local", startedAt: new Date().toISOString(), controlPort: controlServer.port }))
        setInterval(() => {}, 1_000)
      `
      const original = spawnBackground([process.execPath, "-e", fakeOwner], {
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
    const owner = spawnBackground([process.execPath, "-e", fakeOwner], {
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
    const exited = spawnBackground([process.execPath, "-e", ""], {
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
    const nonDaemon = spawnBackground([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
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
      const nonDaemon = spawnBackground([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
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
      const holder = spawnBackground(
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
    const worker = spawnBackground([process.execPath, MAINTENANCE_RETRY_WORKER], {
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
    const worker = spawnBackground([process.execPath, TASK_WRITE_RETRY_WORKER], {
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
    "db compress variants keep the daemon and skip reclaim after the user declines shutdown",
    async () => {
      const variants = [[], ["--vacuum"]]
      for (const flags of variants) {
        await using tmp = await tmpdir()
        const lockPath = path.join(tmp.path, "tui-server.json")
        const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
        // 每个 variant 使用独立 owner，避免前一次 task/lock 状态掩盖第二次 N 行为。
        // flags 只改变用户可见的 vacuum 选择，daemon owner 和 compression route 必须保持一致。
        try {
          const result = await runInteractiveDb(
            lockPath,
            ["compress", ...flags, "--older-than", "0ms", "--batch-size", "1"],
            "n",
          )
          expect(result.exitCode, result.output).toBe(0)
          expect(result.answered).toBe(true)
          // N 的权威含义覆盖普通与 --vacuum：保留 daemon 完成 compression，且不再取得 vacuum 授权。
          expect(result.output).toMatch(new RegExp(`OpenCode daemon is running \\(pid ${lock.pid}\\)[\\s\\S]*Continuing through the running daemon[\\s\\S]*Compression completed`))
          expect(result.output).not.toContain("Reclaim")
          // 同一 PID 存活证明 CLI 没有先停 daemon 再偷偷转向 offline writer。
          expect(ServerLockModule.alive(proc.pid)).toBe(true)
        } finally {
          if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
          await proc.exited.catch(() => undefined)
        }
      }
      // Y 场景使用新 owner 与数据库，确保前两个 N variant 的 task/lease 不会提供偶然成功条件。
      await using yesTmp = await tmpdir()
      const yesLockPath = path.join(yesTmp.path, "tui-server.json")
      const yesDaemon = await spawnDaemon(yesLockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      try {
        // 未替换 owner 的 Y 必须安全停掉同一 PID，再由当前 CLI 完成 offline compression。
        let acquired = false
        let acquiredAtTerminal = false
        let contender = Promise.resolve()
        // reconnect 竞争者在旧 PID 退出后争用同一 election lock；terminal renderer 执行时它仍不得进入。
        const result = await runInteractiveDb(
          yesLockPath,
          ["compress", "--older-than", "0ms", "--batch-size", "1"],
          "y",
          async () => {
          const db = new SQLite(yesDaemon.lock.dbPath)
          db.exec("PRAGMA foreign_keys = OFF")
          const insert = db.prepare(
            `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_election', 'ses_election', 1, 1, ?)`,
          )
          const data = JSON.stringify({ type: "reasoning", text: "election-".repeat(1_024), time: { start: 1 } })
          // 大 payload 让 Y 的 offline sequence 足够长，contender 的成功时机只能由 election release 决定。
          db.transaction(() => {
            for (let index = 0; index < 100; index++) {
              insert.run(`prt_election_${index}`, data)
            }
          })()
          db.close()
          contender = yesDaemon.proc.exited.then(async () => {
            await using _ = await Flock.acquire("opencode.server", {
              dir: path.join(yesTmp.path, "state", "opencode", "locks"),
              timeoutMs: 30_000,
            })
            acquired = true
          })
          },
          (chunk) => {
            if (chunk.includes("Compression completed")) {
              acquiredAtTerminal = acquired
            }
          },
        )
        expect(result.exitCode, result.output).toBe(0)
        // 组合顺序断言要求 stop、活动行换行和 terminal 依次出现，不能由三个独立子串偶然满足。
        expect(result.output).toMatch(/Daemon stopped[\s\S]*elapsed \d+\.\ds[^\n]*\n✓ Compression completed/)
        expect(acquiredAtTerminal).toBe(false)
        await contender
        expect(acquired).toBe(true)
        expect(ServerLockModule.alive(yesDaemon.proc.pid)).toBe(false)
      } finally {
        if (ServerLockModule.alive(yesDaemon.proc.pid)) yesDaemon.proc.kill("SIGTERM")
        await yesDaemon.proc.exited.catch(() => undefined)
      }
      // replacement 场景独立启动 control server，任何 prompt 后请求都会改变公开错误并使测试失败。
      await using replacementTmp = await tmpdir()
      const replacementLockPath = path.join(replacementTmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(replacementLockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      const replacementControl = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("unexpected control request", { status: 500 }),
      })
      try {
        // replacement server 只作为意外 control request 的失败信号，不承担维护或成功响应。
        // prompt 显示后替换完整 identity；Y 必须在首次 control request 前拒绝该 replacement。
        const replacement = { ...lock }
        replacement.token = "replacement-owner"
        replacement.controlPort = replacementControl.port
        const result = await runInteractiveDb(replacementLockPath, ["compress", "--older-than", "0ms"], "y", () =>
          Bun.write(replacementLockPath, JSON.stringify(replacement)),
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.output).toContain("owner changed")
        expect(ServerLockModule.alive(proc.pid)).toBe(true)
      } finally {
        replacementControl.stop(true)
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS * 2 + 60_000,
  )
  // 此切片同时验证 query-selected shutdown 与普通 stop，防止 DB preflight 改写共享 endpoint 默认语义。
  test(
    "maintenance-idle shutdown refuses active work without changing daemon stop",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      // 普通 stop 与 maintenance-idle 共用 endpoint，但只有后者在 active work 时返回 busy。
      try {
        if (!lock.controlPort) throw new Error("missing control port")
        const initialized = await controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", { operation: "status" })
        expect(initialized.status).toBe(200)
        const db = new SQLite(lock.dbPath)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec(`WITH RECURSIVE rows(index_value) AS (SELECT 0 UNION ALL SELECT index_value + 1 FROM rows WHERE index_value < 499) INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_gate_' || index_value, 'msg_gate', 'ses_gate', 1, 1, '{"type":"reasoning","text":"x"}' FROM rows`)
        db.close()
        // 202 证明 worker 已接受真实 task；后续 409 不能由测试伪造的内存 flag 提供。
        const start = await controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", { operation: "compress", olderThanMs: 0, batchSize: 1 })
        expect(start.status).toBe(202)
        // 只有公开 202 之后发出的 conditional request 才能证明 gate 覆盖已接受任务，而非预请求占位。
        // query mode 的授权只属于 DB preflight；它不能继承显式 daemon stop 的“中断后关闭”语义。
        const conditional = await controlRequest(lock, `${ServerLockModule.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(conditional.status).toBe(409)
        expect(ServerLockModule.alive(proc.pid)).toBe(true)
        // 不带 query 的公开 stop 仍须成功，防止 DB preflight 收紧既有用户控制面。
        const stopped = await runDaemonStop(lockPath)
        expect(stopped.exitCode, stopped.stderr).toBe(0)
        expect(stopped.stderr).toContain("Stopped opencode daemon.")
        expect(ServerLockModule.alive(proc.pid)).toBe(false)
      } finally {
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )
  // 长 status 使用真实延迟报告证明 control acknowledgement timeout 不能截断完整统计读取。
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
        const status = spawnBackground([process.execPath, INDEX_TS, "db", "status"], {
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
      // dead owner 强制 recovery 经过真实 stale-rename 边界，而不是直接调用 worker 私有状态。
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      const staleLease = async (taskID: string) => {
        await mkdir(leaseDir, { recursive: true })
        await Bun.write(
          path.join(leaseDir, "owner.json"),
          JSON.stringify({ pid: 2_147_483_647, token: `dead-${taskID}`, taskID, dbPath, startedAt: 1 }),
        )
      }
      await staleLease(task.taskID)
      // Track H+D：共享 stage worker；write-gate + OD-1 stages；不声称关闭 CI hang。
      // 主 lifecycle 仍走完整 start/resume/409/idle 合同；Force A/B 只验证诊断可红。
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      // 两个 marker 分别控制“注册前”和“terminal 后释放前”，完全避免依赖调度速度。
      try {
        expect(await readUntil(reader, "rename-blocked-1")).toContain("rename-blocked-1")
        // recovery 尚未取得 lease 时不得先发布可接受 shutdown/start 的 daemon owner。
        expect(await Bun.file(lockPath).exists()).toBe(false)
        await proc.stdin.write("continue\n")
        expect(await readUntil(reader, "lease-release-blocked")).toContain("lease-release-blocked")
        // lock 只在 recovery 已取得 lease 并登记 activeMaintenance 后才允许对外发布。
        let lock: ServerLockModule.ServerLock | undefined
        const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
        while (!lock && Date.now() < deadline) {
          lock = await Bun.file(lockPath).json().catch(() => undefined)
          if (!lock) await Bun.sleep(POLL_INTERVAL_MS)
        }
        if (!lock?.controlPort) throw new Error("recovered daemon did not publish its control lock")
        // token 来自 recovery 完成注册后发布的真实 daemon lock，所有后续请求都验证同一 owner。
        let settled = false
        const terminal = controlRequest(lock, `${ServerLockModule.CONTROL_MAINTENANCE_STATUS_PATH}?task=${task.taskID}`)
          .then(async (response) => ({ status: response.status, body: await response.json() }))
        void terminal.then(() => (settled = true))
        await Bun.sleep(100)
        // 固定等待只观察 marker 已建立的 pending 状态，不用于猜测 worker 是否进入该状态。
        expect(settled).toBe(false)
        // lease cleanup 被 marker 挡住时，其他 control 请求仍可响应，证明不是整个 server 被阻塞。
        const status = await controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", { operation: "status" })
        expect(status.status).toBe(200)
        const busy = await controlRequest(lock, `${ServerLockModule.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(busy.status).toBe(409)
        // 释放 lease 后 terminal 与 conditional shutdown 才能依次成功，禁止 CLI retry workaround。
        await proc.stdin.write("release\n")
        expect(await terminal).toMatchObject({ status: 200, body: { status: "completed" } })
        const conditional = () => controlRequest(lock, `${ServerLockModule.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        const waitIdle = async (taskID: string) => {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const response = await controlRequest(lock, `${ServerLockModule.CONTROL_MAINTENANCE_STATUS_PATH}?task=${taskID}`)
            const body = await response.json() as { status?: string }
            if (response.ok && ["completed", "failed", "interrupted"].includes(body.status ?? "")) {
              return
            }
            await Bun.sleep(25)
          }
          throw new Error("maintenance transition did not settle")
        }
        // start gate 使用独立 stale lease marker，不能借 recovery 已登记的 active promise 获得假阳性。
        // start 在 stale-lease rename await 中尚未发布 active；pending gate 必须独立返回 busy。
        await staleLease("dbm_start_gate")
        const starting = controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_PATH, "POST", { operation: "compress", olderThanMs: 0, batchSize: 1 })
        // blocked-2 用 waitStartGate：continue 未预缓冲，HTTP 无 marker 可分类；blocked-3 仍 marker-first。
        // 30s 仅覆盖正常 gate 出现；Force A 的 3s 是故意失败窗，二者不可互换。
        const startGate = await waitStartGate(reader, "rename-blocked-2", starting, 30_000)
        expect(startGate).toContain("rename-blocked-2")
        expect(startGate).toContain("stage:stale-rename")
        expect((await conditional()).status).toBe(409)
        // 同一 chunk 预置 start/resume 两个 gate token，避免 Windows pipe 的第三次小写入延迟。
        // 预缓冲使 blocked-3 的 gate 在 marker 写出后立即放行，故禁止对 blocked-3 做 HTTP-without-marker 竞态。
        await proc.stdin.write("continue\ncontinue\n")
        const startResponse = await starting
        expect(startResponse.status).toBe(202)
        await waitIdle((await startResponse.json() as { taskID: string }).taskID)
        // resume gate 重新写 interrupted record，验证另一 producer 也在首个 await 前发布 pending。
        // resume 经过独立 reconcile/lease producer；它不能只依赖 start 路径偶然设置的 active 状态。
        const resumeTask = { ...task, taskID: "dbm_resume_gate", status: "interrupted" as const, updatedAt: Date.now() }
        await ServerLockModule.writeMaintenanceTask(resumeTask)
        await staleLease(resumeTask.taskID)
        const resuming = controlRequest(lock, ServerLockModule.CONTROL_MAINTENANCE_RESUME_PATH, "POST", { taskID: resumeTask.taskID })
        // blocked-3：marker-first 顺序；HTTP 202 可在 marker 之后任意时刻返回，不得误分类。
        expect(await readUntil(reader, "rename-blocked-3")).toContain("rename-blocked-3")
        expect((await conditional()).status).toBe(409)
        const resumeResponse = await resuming
        expect(resumeResponse.status).toBe(202)
        await waitIdle((await resumeResponse.json() as { taskID: string }).taskID)
        // 两个过渡期都 terminal 后才允许 conditional stop，证明 pending 与 active 没有残留计数。
        const stopped = await controlRequest(lock, `${ServerLockModule.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(stopped.status).toBe(200)
        expect(await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")])).not.toBe("timeout")
      } finally {
        reader.releaseLock()
        if (ServerLockModule.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 90_000,
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

      const proc = spawnBackground([process.execPath, INDEX_TS, "src/cli/cmd/tui/worker.ts"], {
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
    "Windows daemon PowerShell wrapper hides its console window",
    async () => {
      // INV-01：必须拦截真实 Bun.spawn 上的 powershell wrapper 选项；_setSpawn 会替换整个 spawnImpl，进不了 wrapper 构造。
      await using tmp = await tmpdir()
      const original = Bun.spawn
      let wrapperHide: boolean | undefined
      Bun.spawn = ((cmd: string[], opts?: Parameters<typeof Bun.spawn>[1]) => {
        const exe = Array.isArray(cmd) ? cmd[0] : cmd
        if (typeof exe === "string" && exe.toLowerCase().includes("powershell.exe")) {
          wrapperHide = opts?.windowsHide === true
        }
        return original(cmd as never, opts as never)
      }) as typeof Bun.spawn

      const marker = path.join(tmp.path, "daemon-hide-marker.json")
      // 最小 worker：只写 marker 后挂起，足够触发 wrapper 启动与 PID 握手。
      const worker = path.join(tmp.path, "hide-worker.ts")
      await Bun.write(
        worker,
        `await Bun.write(process.env.DAEMON_HIDE_MARKER!, JSON.stringify({ pid: process.pid }))\nsetInterval(() => {}, 1000)\n`,
      )

      try {
        const proc = await DaemonModule._spawn([process.execPath, worker], {
          env: { ...process.env, DAEMON_HIDE_MARKER: marker },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: false,
        })
        try {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            if (await Bun.file(marker).exists()) break
            await Bun.sleep(25)
          }
          expect(await Bun.file(marker).exists()).toBe(true)
          expect(wrapperHide).toBe(true)
        } finally {
          proc.kill()
          await proc.exited.catch(() => undefined)
        }
      } finally {
        Bun.spawn = original
      }
    },
    20_000,
  )

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
      const launcher = spawnBackground([process.execPath, "-e", parentCode], {
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
          windowsHide: process.platform === "win32",
        })
        child.unref()
        console.log(child.pid)
        setInterval(() => {}, 1000)
      `
      const parent = spawnBackground([process.execPath, "-e", parentCode], {
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

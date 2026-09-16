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
import { DaemonProcess, connectionInfo, discoverOrSpawnDaemon, type DiscoverDaemonDeps } from "../../../src/cli/cmd/tui"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
// #524：db status 压力夹具直接用 bun:sqlite 写入 part 行（FK OFF）。
import { Database } from "bun:sqlite"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"
// #493：maintenance task record 类型来自 core ColdStorage——三用例覆盖 lease 抢占/reclaim、control 协议与 startup recovery。
import type { MaintenanceTask } from "@opencode-ai/core/storage/cold-storage"
import { win32DetachConsole } from "@opencode-ai/tui/terminal-win32"
// #535：交互 DB 命令走真实 PTY；control 断言用同 token 的公开 endpoint。
import stripAnsi from "strip-ansi"
import { spawn as spawnPty } from "@lydell/node-pty"
import { Flock } from "@opencode-ai/core/util/flock"

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

// 测试后台非交互子进程在 Windows 上必须隐藏 console，与生产 Process/NetworkProxy hide 合同一致；PTY 不走此 helper。
// 返回 any：Bun.spawn 在合并 windowsHide 后会丢失 stdin/stdout 字面量重载，测试侧保留原 pipe 访问写法。
function spawnBackground(cmd: string[], opts: Parameters<typeof Bun.spawn>[1] = {}): any {
  return Bun.spawn(cmd, { ...opts, windowsHide: process.platform === "win32" })
}

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

// #535：POST body 与 token 在同一个 request envelope 中，测试不会绕过 daemon control 的鉴权边界。
function controlRequest(
  lock: ServerLock.ServerLock,
  pathname: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
) {
  // control helper 始终绑定受测 owner token；fixture 不能绕过生产鉴权直接调用 worker 内部函数。
  return fetch(`http://127.0.0.1:${lock.controlPort}${pathname}`, {
    method,
    headers: {
      [ServerLock.CONTROL_TOKEN_HEADER]: lock.token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function runDaemonStop(lockPath: string, env: Record<string, string> = {}) {
  await prepareCliData(lockPath)
  // 用 argv 数组保留路径和密码中的空格，并从真实入口验证命令注册。
  const proc = spawnBackground([process.execPath, INDEX_TS, "daemon", "stop"], {
    env: isolatedDaemonEnv(lockPath, env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { exitCode, stderr }
}

// #535：PTY 驱动真实 db 命令——prompt 应答、owner replacement hook 和 terminal 观察都在同一进程 seam。
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
  // 累积完整 PTY scrollback 后再去 ANSI，断言不依赖单个 onData chunk 的切分。
  let output = ""
  let answered = false
  let reclaimAnswered = false
  proc.onData((data) => {
    output += data
    const text = stripAnsi(output)
    observe(stripAnsi(data))
    if (!answered && text.includes("Stop daemon and continue?")) {
      answered = true
      // hook 在 prompt 已可见而答案尚未提交时运行，覆盖用户思考期间的 owner replacement。
      void beforeAnswer().then(() => proc.write(`${answer}\r`))
    }
    if (answered && !reclaimAnswered && text.includes("? Reclaim")) {
      reclaimAnswered = true
      // 后续 reclaim prompt 一律自动拒绝；用例焦点是首次停机决策，不让第二层授权模糊断言。
      proc.write("n\r")
    }
  })
  const exited = new Promise<number>((resolve) => proc.onExit((event) => resolve(event.exitCode)))
  // prompt 和 task terminal 都来自真实进程；期限只保护测试，不替代产品 status readiness。
  const result = await Promise.race([exited, Bun.sleep(30_000).then(() => "timeout" as const)])
  if (result === "timeout") {
    proc.kill()
    // 超时错误携带完整 scrollback，失败现场可直接从测试输出定位到具体 prompt 阶段。
    throw new Error(`interactive database command exceeded 30 seconds:\n${stripAnsi(output)}`)
  }
  // CRLF 归一化交给调用方断言；这里只保证 answered 反映首次 prompt 是否真的出现过。
  return { exitCode: result, output: stripAnsi(output).replaceAll("\r", ""), answered }
}

// #532：机器接口从真实 argv 入口执行，确保 yargs 参数、stdout 协议和 daemon owner 语义一起受测。
// stdout 只允许一个 JSON value；日志和迁移信息必须留在 stderr，调用方无需解析人类文案。
async function runDaemonMachine(
  lockPath: string,
  command: "status" | "start",
  env: Record<string, string> = {},
) {
  await prepareCliData(lockPath)
  const args = [process.execPath, INDEX_TS, "daemon", command, "--json"]
  if (command === "start") args.push("--launcher-pid", String(process.pid))
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
 * 在临时目录中启动守护进程，轮询直到锁文件出现且 HTTP 服务器响应。
 * 返回运行中的进程和锁文件内容。
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
  const proc = spawnBackground([process.execPath, "-e", wrapper], {
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
  const lock = JSON.parse(await readLineMatching(proc.stdout, (line) => line.startsWith("{"))) as ServerLock.ServerLock
  return { proc, lock }
}

// #273：读取 SSE 流直到出现指定文本；#539：同一 reader 上的 stdout 必须跨 wait 累积，
// 同 chunk 内先匹配 A 后的 B 不能在第二次 wait 中丢失；WeakMap 按 reader 实例隔离缓冲，禁止跨用例泄漏。
const stdoutPumpBuffers = new WeakMap<ReadableStreamDefaultReader<string>, string>()
const stdoutPumpReads = new WeakMap<ReadableStreamDefaultReader<string>, ReturnType<ReadableStreamDefaultReader<string>["read"]>>()

async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  text: string,
  // #539：有界等待把 marker 缺失变成可诊断失败；默认对齐本文件最长 daemon 安全窗，避免 120s 静默 hang。
  // Force A/B 必须显式传入 2–5s，禁止误用默认窗掩盖分类失败。
  timeoutMs = DAEMON_START_TIMEOUT_MS + 90_000,
) {
  let seen = stdoutPumpBuffers.get(reader) ?? ""
  const deadline = Date.now() + timeoutMs
  while (!seen.includes(text)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // #539：dump 已读缓冲用于区分 IPC 漏 marker 与生产路径挂起；不把 harness 超时伪装成 hang 根因已修。
      throw new Error(`timed out waiting for ${JSON.stringify(text)} after ${timeoutMs}ms; seen=${JSON.stringify(seen)}`)
    }
    // 超时只结束本次等待；同一未决read继续更新缓冲，不能遗弃它吞掉后续marker。
    const pending = stdoutPumpReads.get(reader) ?? reader.read().then((value) => {
      if (!value.done) stdoutPumpBuffers.set(reader, stdoutSeen(reader) + value.value)
      return value
    }).finally(() => stdoutPumpReads.delete(reader))
    stdoutPumpReads.set(reader, pending)
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      pending.then((value) => ({ kind: "chunk" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remaining)
      }),
    ]).finally(() => clearTimeout(timer))
    if (next.kind === "timeout") {
      throw new Error(`timed out waiting for ${JSON.stringify(text)} after ${timeoutMs}ms; seen=${JSON.stringify(seen)}`)
    }
    if (next.value.done) throw new Error(`stdout ended waiting for ${JSON.stringify(text)}; seen=${JSON.stringify(stdoutSeen(reader))}`)
    seen = stdoutSeen(reader)
  }
  stdoutPumpBuffers.set(reader, seen)
  return seen
}

// #539：只读缓冲快照，不推进 stream；供 waitStartGate 在 HTTP settle 时复查 marker。
function stdoutSeen(reader: ReadableStreamDefaultReader<string>) {
  return stdoutPumpBuffers.get(reader) ?? ""
}

// #539：仅用于 blocked-2：start 的 continue 尚未预缓冲，HTTP 先完成且缓冲无 marker 才可分类为异常。
// blocked-3 禁止使用本竞态（double-continue 预缓冲会使 rename 立即结束并 202）。
// 只观察 Response 是否 settled，不消费 body；25ms 二次泵避免假阳性 classify。
async function waitStartGate(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
  http: Promise<Response>,
  timeoutMs: number,
) {
  let settled: Response | undefined
  let failure: { error: unknown } | undefined
  void http.then((response) => {
    settled = response
  }, (error) => {
    failure = { error }
  })
  // #539：双重时钟——marker 先到则立即返回；HTTP 先到则二次泵后才允许分类失败。
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (failure) throw failure.error
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
  // 超时 dump 必须带 stages，供区分 A（有 rename）与 C（无 mkdir-attempt）。
  throw new Error(
    `timed out waiting for start gate ${JSON.stringify(marker)} after ${timeoutMs}ms; seen=${JSON.stringify(stdoutSeen(reader))}`,
  )
}

// #539：空库 compress 夹具：仅服务 recovery/start gate 诊断，不扩展 ColdStorage 产品语义。
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

// #539：统一 stage worker 源码：mkdir/rename/rm 诊断序与 write-gate 合同只维护一处。
// stage:mkdir-attempt 在 real mkdir 前发出；mkdir-ok 仅成功路径；失败 EEXIST 不发 ok（对齐 stale reclaim）。
// stage:stale-rename 与 rename-blocked-N 同序，表示进入 dead-owner rename gate。
// pid 哨兵 2147483647 在 Windows/Unix 上均 dead，强制走 rename reclaim 而非 live busy。
function maintenanceStageWorkerSource(leaseDir: string) {
  return `
    import { mock } from "bun:test"
    import * as fs from "node:fs/promises"
    import path from "node:path"
    // #539：write-before-stdin 合同：就绪信号必须用 stdout.write 而非 console.log，
    // 避免跨进程缓冲延迟导致 gate token 与 marker 观察顺序错乱。
    const input = Bun.stdin.stream().getReader()
    const realRename = fs.rename.bind(fs)
    const realRm = fs.rm.bind(fs)
    const realMkdir = fs.mkdir.bind(fs)
    const leaseLock = path.resolve(${JSON.stringify(leaseDir)})
    // #539：path.resolve 归一匹配——Windows 分隔符/相对前缀差异不得让 rename gate 漏拦。
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
        // #539：mkdir stage 只针对 lease 目录：诊断序验证 acquire FS 触达，不干扰其它 mkdir。
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
        // #539：release 单次标志——仅首笔 lease 释放阻塞，后续清理走原生路径防死锁。
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

// #539：stderr ignore 对齐 spawnDaemon：长生命周期 worker 禁止未读 pipe 卫生风险；非 hang 根因声明。
function spawnStageWorker(lockPath: string, leaseDir: string) {
  const proc = Bun.spawn([process.execPath, "-e", maintenanceStageWorkerSource(leaseDir)], {
    env: {
      ...isolatedDaemonEnv(lockPath),
      OPENCODE_PROCESS_ROLE: "worker",
      OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "180000",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    // #548：脱离 spawnBackground 统一注入后，hide 在直连 spawn 显式携带（等值）。
    windowsHide: process.platform === "win32",
  })
  return { proc, reader: proc.stdout.pipeThrough(new TextDecoderStream()).getReader() }
}

// #539：dead owner.json 触发 acquire 的 stale rename 分支；token 按调用区分 tombstone 目标名。
async function writeDeadLease(leaseDir: string, taskID: string, dbPath: string, token: string) {
  // #539：与 staleLease 分离——token 显式传参供 Force A/B 区分 tombstone 目标名。
  await mkdir(leaseDir, { recursive: true })
  await Bun.write(
    path.join(leaseDir, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token, taskID, dbPath, startedAt: 1 }),
  )
}

// #540：spawnStageWorker 固定 stdin:"pipe"，收窄 FileSink 供 gate token 写入；
// 宽化的 ReturnType<typeof Bun.spawn> 联合（number|undefined）在严格模式下无法直接 write。
function stageWorkerStdin(proc: ReturnType<typeof Bun.spawn>) {
  const stdin = proc.stdin
  // #540：运行时断言而非 as-cast：spawn 配置漂移时立即失败，不把坏 stdin 静默写成 0 字节。
  if (!stdin || typeof stdin === "number") {
    throw new Error("stage worker stdin is not a writable FileSink")
  }
  return stdin
}

// #539：recovery 段：blocked-1 → continue → lease-release → release → completed；返回可发 start 的 lock。
// 与主 lifecycle 用例共享同一握手，避免 Force A/B 复制第三套 recovery 时序。
async function recoverStageWorkerToIdle(
  proc: ReturnType<typeof spawnStageWorker>["proc"],
  reader: ReadableStreamDefaultReader<string>,
  lockPath: string,
  taskID: string,
) {
  expect(await readUntil(reader, "rename-blocked-1", 30_000)).toContain("rename-blocked-1")
  await stageWorkerStdin(proc).write("continue\n")
  expect(await readUntil(reader, "lease-release-blocked", 30_000)).toContain("lease-release-blocked")
  let lock: ServerLock.ServerLock | undefined
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (!lock && Date.now() < deadline) {
    lock = await Bun.file(lockPath).json().catch(() => undefined)
    if (!lock) await Bun.sleep(POLL_INTERVAL_MS)
  }
  if (!lock?.controlPort) throw new Error("daemon lock missing")
  const terminal = controlRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${taskID}`)
  await stageWorkerStdin(proc).write("release\n")
  expect((await terminal).status).toBe(200)
  return lock
}

describe("daemon lifecycle", () => {
  // #535：ConPTY 下 Bun 子进程 stdin 不可回写（平台缺陷，探针见 record），runInteractiveDb 用例仅 POSIX 执行。
  const ptyInteractive = process.platform === "win32" ? test.skip : test
  // #539：INV-H1 红绿：同 chunk 先命中 A 后的 B 必须仍可读；非累积 seen 会在第二次 wait 中永久丢 B。
  test("readUntil keeps trailing markers from the same stdout chunk", async () => {
    // #539：夹具一次性 enqueue 两个 marker 后 close：close 后二次 read 必须 hit done-break
    // 而非死循环——同 chunk 尾部 marker 依靠 WeakMap 缓冲命中。
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

  // #539：INV-H3 红绿：有界失败必须带已读缓冲，禁止 marker 缺失时吞掉整段 suite timeout。
  test("readUntil timeout dumps the accumulated stdout buffer", async () => {
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

  // #539：OD-1 Force A：marker 已写但不 continue → 短超时 dump 含 rename 阶段，诊断可红。
  // 不 await start Response：gate 阻塞时 fetch 可能 ECONNRESET，与 dump 断言无关。
  test(
    "start gate Force A dump includes rename-blocked-2 when continue is withheld",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const dbPath = path.join(tmp.path, "opencode.db")
      const task = interruptedCompressTask("dbm_force_a", dbPath)
      await ServerLock.writeMaintenanceTask(task)
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      await writeDeadLease(leaseDir, task.taskID, dbPath, "dead-force-a")
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      try {
        const lock = await recoverStageWorkerToIdle(proc, reader, lockPath, task.taskID)
        // 第二枚 dead lease 专供 start rename-blocked-2，与 recovery taskID 隔离。
        // #539：不装第二枚则 mkdir 直接成功，Force A 的 rename gate 就无从发生。
        await writeDeadLease(leaseDir, "dbm_start_gate", dbPath, "dead-start")
        void controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", {
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
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 60_000,
  )

  // #539：OD-1 Force B：无 dead lock → mkdir-ok、无 rename-blocked-2；5s 内分类失败，禁 120s 静默。
  // 与 Force A 的差异仅在 start 前是否 writeDeadLease；共享 recover helper 保证对照干净。
  test(
    "start without stale lease fails fast without rename-blocked-2",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const dbPath = path.join(tmp.path, "opencode.db")
      const task = interruptedCompressTask("dbm_force_b", dbPath)
      await ServerLock.writeMaintenanceTask(task)
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      await writeDeadLease(leaseDir, task.taskID, dbPath, "dead-force-b")
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      try {
        const lock = await recoverStageWorkerToIdle(proc, reader, lockPath, task.taskID)
        // 故意不装 start 用 stale lease：acquire 应 mkdir 成功路径，不进 rename gate。
        const startOffset = stdoutSeen(reader).length
        const starting = controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", {
          operation: "compress",
          olderThanMs: 0,
          batchSize: 1,
        })
        await expect(waitStartGate(reader, "rename-blocked-2", starting, 5_000)).rejects.toThrow(
          /start gate HTTP settled without "rename-blocked-2"|timed out waiting for start gate "rename-blocked-2"/,
        )
        // outcome B：无 rename-blocked-2；至少见 mkdir-attempt/ok 之一，证明 start 触达 lease FS。
        // #539：双分支容斥——attempt-only 表示 mkdir 被拒（EEXIST），ok 表示 acquire 直达成功。
        const dump = stdoutSeen(reader).slice(startOffset)
        expect(dump).not.toContain("rename-blocked-2")
        expect(dump.includes("stage:mkdir-ok") || dump.includes("stage:mkdir-attempt")).toBe(true)
      } finally {
        reader.releaseLock()
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 60_000,
  )

  test("observes injected connection owners without process or network access", async () => {
    const forbidden = () => { throw new Error("observation must not start, elect, clear, or wait") }
    const lock: ServerLock.ServerLock = { pid: 71, port: 3101, token: "private-token", dbPath: path.resolve("observer-only.db"), channel: "test", startedAt: "2026-10-28" }
    const observe = (owner: ServerLock.ServerLock | undefined, overrides: Partial<DiscoverDaemonDeps> = {}) => connectionInfo({
      read: async () => owner, alive: () => true, ping: async () => true,
      clear: forbidden, acquire: forbidden, spawn: forbidden,
      sleep: forbidden, resolveDaemonFile: forbidden, resolveNetwork: forbidden,
      identity: () => ({ dbPath: lock.dbPath, channel: lock.channel }), placement: () => "observer-only",
      electionTimeoutMs: 1, electionStaleMs: 1, pollMs: 1, waitMs: 1,
      ...overrides,
    })
    // 无controlPort才跳过真实控制面fetch；健康探测及owner读取也全部显式替换。
    expect(lock.controlPort).toBeUndefined()
    await expect(observe(undefined)).resolves.toEqual({ running: false })
    await expect(observe(lock, { alive: () => false })).resolves.toEqual({ running: false })
    const healthy = await observe(lock)
    expect(healthy).toEqual({ running: true, pid: 71, url: "http://127.0.0.1:3101", responsive: true })
    expect(Object.keys(healthy).toSorted()).toEqual(["pid", "responsive", "running", "url"])
    await expect(observe(lock, { ping: async () => false })).resolves.toMatchObject({ running: true, pid: 71, responsive: false })
    // 身份不符、探测中换代与读取失败均保留失败，不伪装无owner并触发重建。
    await expect(observe({ ...lock, dbPath: path.resolve("other.db") })).rejects.toThrow("different database or channel")
    let reads = 0
    await expect(observe(lock, { read: async () => ++reads === 1 ? lock : { ...lock, token: "replacement" } })).rejects.toThrow("ownership changed")
    await expect(observe(lock, { read: async () => { throw new Error("observer read failure") } })).rejects.toThrow("observer read failure")
  })

  // #532：独立 lock/XDG/DB 保证该查询不可能观察或停止开发者真实 daemon。
  // running=false 是公开 expected literal，测试不读取 private lock parser 返回类型。
  // lock 仍不存在证明 status 没有把 read 操作偷偷升级为 ensure。
  // 真实 CLI 入口同时覆盖 yargs 注册与 stdout 协议，不使用内部 helper 得到假绿。
  test("daemon status JSON reports no owner without spawning", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")

    const result = await runDaemonMachine(lockPath, "status")
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ running: false })
    // status 是纯观察操作；没有 owner 时不得创建 lock 或用 ensure 把查询变成启动
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
        // machine contract 只公开连接所需的 PID/URL；token、control port 和 DB 路径仍属于 lock owner
        expect(result.stdout).not.toContain(lock.token)
        expect(result.stdout).not.toContain("controlPort")
        expect(result.stdout).not.toContain("dbPath")
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLock.alive(proc.pid)) proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

  test(
    "daemon start JSON creates one owner protected by the external launcher PID and reuses it",
    async () => {
      // 250ms startup idle 刻意短于 750ms 观察窗，使错误 launcher PID 稳定暴露。
      // 测试进程保持存活代表 bot，首次 SSE 尚未建立，隔离两个 liveness 阶段。
      // 第二次 start 比较同一 PID/URL，证明复用而非仅有另一个健康 owner。
      // finally 通过 safe stop 清理真实 worker，失败 case 也不遗留实验进程。
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
        // CLI 已退出且没有 SSE；worker 仍须观察测试进程这个外部 launcher，不能观察短命 CLI PID
        await Bun.sleep(750)
        expect(ServerLock.alive(owner.pid)).toBe(true)

        const second = await runDaemonMachine(lockPath, "start", env)
        expect(second.exitCode).toBe(0)
        // 重复start在所有平台均保持同一PID/URL，不用平台分支弱化源复用合同。
        expect(JSON.parse(second.stdout)).toEqual(owner)
      } finally {
        await runDaemonStop(lockPath).catch(() => undefined)
        if (ServerLock.alive(owner.pid)) process.kill(owner.pid)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
  )

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
      const proc = spawnBackground([process.execPath, "-e", fakeOwner], {
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
    const owner = spawnBackground([process.execPath, "-e", fakeOwner], {
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
    expect(await Bun.file(lockPath).text().catch(() => undefined)).toBeUndefined()
  })

  test("daemon stop command refuses a live lock without a safe control port", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "tui-server.json")
    const nonDaemon = spawnBackground([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
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
      const nonDaemon = spawnBackground([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
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

  test.skipIf(process.platform !== "win32")(
    "Windows daemon keeps stdout and stderr as pipes after FreeConsole",
    async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "stdio-after-free-console.json")
      const worker = path.join(tmp.path, "stdio-after-free-console.ts")
      // 必须调用真实DaemonProcess.spawn；替换整个adapter会绕过本次损坏发生的HANDLE owner。
      // AllocConsole 只固定“先有 console、再 detach”的前置条件，不替代 launcher 对 stdio pipe 的责任。
      await Bun.write(
        worker,
        `
          import { dlopen } from "bun:ffi"
          const kernel = dlopen("kernel32.dll", {
            AllocConsole: { args: [], returns: "i32" },
            FreeConsole: { args: [], returns: "i32" },
            GetStdHandle: { args: ["i32"], returns: "ptr" },
            GetFileType: { args: ["ptr"], returns: "u32" },
          })
          kernel.symbols.AllocConsole()
          const detached = kernel.symbols.FreeConsole()
          const stdout = kernel.symbols.GetStdHandle(-11)
          const stderr = kernel.symbols.GetStdHandle(-12)
          await Bun.write(process.env.DAEMON_STDIO_MARKER!, JSON.stringify({
            detached,
            stdout: kernel.symbols.GetFileType(stdout),
            stderr: kernel.symbols.GetFileType(stderr),
          }))
          setInterval(() => {}, 1000)
        `,
      )

      const proc = await DaemonProcess.spawn([process.execPath, worker], {
        env: { ...process.env, DAEMON_STDIO_MARKER: marker },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: false,
      })

      try {
        // marker 是 worker 在 detach 后发布的 readiness；轮询它而非固定 sleep，避免慢 CI 时序假红。
        const deadline = Date.now() + 10_000
        let result: { detached: number; stdout: number; stderr: number } | undefined
        while (Date.now() < deadline) {
          result = await Bun.file(marker)
            .json()
            .catch(() => undefined)
          if (result) break
          await Bun.sleep(25)
        }
        // FILE_TYPE_PIPE=3 来自 Win32 合同；当前失效 HANDLE 返回 0，不能用“未抛错”伪装安全。
        expect(result).toEqual({ detached: 1, stdout: 3, stderr: 3 })
      } finally {
        // 失败断言也必须先终止真实 worker 再等待 wrapper，避免泄漏进程污染后续 daemon owner 测试。
        proc.kill()
        await proc.exited.catch(() => undefined)
      }
    },
    20_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Windows daemon preserves shared console and forwards pipes in print-log mode",
    async () => {
      await using tmp = await tmpdir()
      const worker = path.join(tmp.path, "print-log-worker.ts")
      const stdoutMarker = "PRINT_LOG_STDOUT="
      const stderrMarker = "PRINT_LOG_STDERR"
      // print-logs 的兼容合同同时包含console成员关系与可见输出；只断言文本会漏掉CreateNoWindow回归。
      await Bun.write(
        worker,
        `
          import { dlopen } from "bun:ffi"
          const kernel = dlopen("kernel32.dll", {
            GetConsoleCP: { args: [], returns: "u32" },
            GetConsoleProcessList: { args: ["ptr", "u32"], returns: "u32" },
            GetStdHandle: { args: ["i32"], returns: "ptr" },
            GetFileType: { args: ["ptr"], returns: "u32" },
          })
          // console成员关系与stdio重定向是独立维度；两类信号必须来自同一个真实worker。
          const processes = new Uint32Array(16)
          const stdout = kernel.symbols.GetStdHandle(-11)
          const stderr = kernel.symbols.GetStdHandle(-12)
          process.stdout.write(${JSON.stringify(stdoutMarker)} + JSON.stringify({
            consoleCP: kernel.symbols.GetConsoleCP(),
            consoleProcesses: kernel.symbols.GetConsoleProcessList(processes, processes.length),
            stdout: kernel.symbols.GetFileType(stdout),
            stderr: kernel.symbols.GetFileType(stderr),
          }) + "\\n")
          process.stderr.write(${JSON.stringify(stderrMarker + "\n")})
          // 非零23是独立sentinel，证明adapter传播worker code而不是固定返回launcher成功。
          process.exit(23)
        `,
      )

      // 子launcher让测试可以独立捕获inherit输出；生产adapter仍按原协议消费PID首行，不把它混入worker stdout。
      const launcher = spawnBackground(
        [
          process.execPath,
          "-e",
          `
            const { DaemonProcess } = await import(${JSON.stringify(new URL("../../../src/cli/cmd/tui.ts", import.meta.url).href)})
            const proc = await DaemonProcess.spawn([process.execPath, ${JSON.stringify(worker)}], {
              env: { ...process.env, OPENCODE_PRINT_LOGS: "1" },
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
              detached: false,
            })
            process.stdout.write("ADAPTER_EXIT=" + await proc.exited + "\\n")
          `,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )

      // 同时读取两条pipe与exit，避免先等进程导致任一缓冲区填满而把测试自身变成死锁源。
      const [stdout, stderr, exit] = await Promise.all([
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
        launcher.exited,
      ])
      const line = stdout.split(/\r?\n/).find((item) => item.startsWith(stdoutMarker))
      if (!line) throw new Error(`missing print-log stdout marker: ${stdout}`)
      const contract = JSON.parse(line.slice(stdoutMarker.length)) as {
        consoleCP: number
        consoleProcesses: number
        stdout: number
        stderr: number
      }

      // 非零console值锁定既有Ctrl+C成员关系；FILE_TYPE_PIPE=3则锁定安全的双流HANDLE。
      expect(contract.consoleCP).toBeGreaterThan(0)
      // 共享console内可能还有其他TUI/wrapper，只断言非零，避免把并发进程数量误当产品合同。
      expect(contract.consoleProcesses).toBeGreaterThan(0)
      expect(contract.stdout).toBe(3)
      expect(contract.stderr).toBe(3)
      expect(stdout).toContain("ADAPTER_EXIT=23")
      // stderr marker必须留在独立pipe，不能混入承载PID协议与worker stdout的wrapper输出流。
      expect(stderr).toContain(stderrMarker)
      expect(exit).toBe(0)
    },
    20_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Windows daemon PowerShell wrapper hides its console window",
    async () => {
      // INV-01：必须拦截真实Bun.spawn；DaemonProcess.spawn调用默认wrapper，替换整个adapter无法证明hide。
      await using tmp = await tmpdir()
      const original = Bun.spawn
      let wrapperHide: boolean | undefined
      Bun.spawn = ((cmd: string[], opts?: Parameters<typeof Bun.spawn>[1]) => {
        const exe = Array.isArray(cmd) ? cmd[0] : cmd
        // 目标 wrapper 走 System32 WindowsPowerShell 绝对路径（#495），按 powershell.exe 片段识别即可。
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
        const proc = await DaemonProcess.spawn([process.execPath, worker], {
          env: { ...isolatedDaemonEnv(path.join(tmp.path, "tui-server.json")), DAEMON_HIDE_MARKER: marker },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: false,
        })
        try {
          // marker 以 published readiness 为准：wrapper 完成 PID 握手即视为启动成功。
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
        // 拦截必须在 finally 恢复，否则泄漏到同 runner 的后续真实 spawn 生命周期场景。
        Bun.spawn = original
      }
    },
    20_000,
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

      const proc = spawnBackground([process.execPath, INDEX_TS, "src/cli/tui/worker.ts"], {
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
      const holder = spawnBackground(
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
      const worker = spawnBackground([process.execPath, MAINTENANCE_RETRY_WORKER], {
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
      const launcher = spawnBackground([process.execPath, "-e", parentCode], {
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
    const worker = spawnBackground([process.execPath, TASK_WRITE_RETRY_WORKER], {
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



  // #535：N 的权威含义覆盖普通与 --vacuum 变体；Y 验证 election 覆盖完整 offline sequence，replacement owner 必须被拒绝。
  ptyInteractive(
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
          // answered=true 证明 N 是对真实停机 prompt 的应答，不是超时或解析缺失的假成功。
          expect(result.answered).toBe(true)
          // N 的语义覆盖普通与 --vacuum：保留 daemon 完成 compression，且不再取得 vacuum 授权。
          expect(result.output).toMatch(new RegExp(`OpenCode daemon is running \\(pid ${lock.pid}\\)[\\s\\S]*Continuing through the running daemon[\\s\\S]*Compression completed`))
          // N 之后不能再出现 reclaim 文案；首次拒绝已耗尽本命令的全部停机授权。
          expect(result.output).not.toContain("Reclaim")
          // 同一 PID 存活证明 CLI 没有先停 daemon 再偷偷转向 offline writer。
          expect(ServerLock.alive(proc.pid)).toBe(true)
        } finally {
          if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
          await proc.exited.catch(() => undefined)
        }
      }
      // Y 场景使用新 owner 与数据库，确保前两个 N variant 的 task/lease 不会提供偶然成功条件。
      await using yesTmp = await tmpdir()
      const yesLockPath = path.join(yesTmp.path, "tui-server.json")
      const yesDaemon = await spawnDaemon(yesLockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      // contender 属于此 fixture；断言失败时也必须在临时目录销毁前等待它结束。
      let contender = Promise.resolve()
      try {
        // 未替换 owner 的 Y 必须安全停掉同一 PID，再由当前 CLI 完成 offline compression。
        let acquired = false
        let acquiredAtTerminal = false
        // reconnect 竞争者在旧 PID 退出后争用同一 election lock；terminal renderer 执行时它仍不得进入。
        const result = await runInteractiveDb(
          yesLockPath,
          ["compress", "--older-than", "0ms", "--batch-size", "1"],
          "y",
          async () => {
            const db = new Database(yesDaemon.lock.dbPath)
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
            // contender 与旧 daemon 退出绑定：停机完成即开始争锁，成功时序揭示 release 位置。
            contender = yesDaemon.proc.exited.then(async () => {
              await using _ = await Flock.acquire(`opencode.server:${yesLockPath}`, {
                dir: path.join(yesTmp.path, "state", "opencode", "locks"),
                timeoutMs: 30_000,
              })
              acquired = true
            })
            // 立即登记 rejection handler；成功路径仍 await 原 Promise，使竞争失败正常暴露。
            void contender.catch(() => undefined)
          },
          (chunk) => {
            if (chunk.includes("Compression completed")) {
              acquiredAtTerminal = acquired
            }
          },
        )
        expect(result.exitCode, result.output).toBe(0)
        // 组合顺序断言要求 stop、活动行换行和 terminal 依次出现，不能由三个独立子串偶然满足。
        // #549：elapsed 字段定宽 pad 后允许空白；\r 进度帧 strip 后可能粘连。
        expect(result.output).toMatch(/Daemon stopped[\s\S]*elapsed\s+\d+\.\ds[\s\S]*✓ Compression completed/)
        // terminal 渲染时 contender 仍未拿到锁：election 覆盖到输出层而不是在 checkpoint 后提前释放。
        expect(acquiredAtTerminal).toBe(false)
        await contender
        expect(acquired).toBe(true)
        // Y 路径的旧 daemon 必须遇出：offline handoff 的前提是唯一 writer。
        expect(ServerLock.alive(yesDaemon.proc.pid)).toBe(false)
      } finally {
        if (ServerLock.alive(yesDaemon.proc.pid)) yesDaemon.proc.kill("SIGTERM")
        await yesDaemon.proc.exited.catch(() => undefined)
        // 失败清理不覆盖原始断言错误，也不让竞争者在下一用例中访问已删除目录。
        await Promise.allSettled([contender])
      }
      // replacement 场景独立启动 control server，任何 prompt 后请求都会改变公开错误并使测试失败。
      await using replacementTmp = await tmpdir()
      const replacementLockPath = path.join(replacementTmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(replacementLockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      // 独立 control server 作为哨兵：CLI 若误连 replacement 端口会得到 500 而非预期响应。
      const replacementControl = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("unexpected control request", { status: 500 }),
      })
      try {
        // replacement server 只作为意外 control request 的失败信号，不承担维护或成功响应。
        // prompt 显示后替换完整 identity；Y 必须在首次 control request 前拒绝该 replacement。
        const replacement = { ...lock }
        // token 换成哨兵端口对应的假 owner：sameOwner 四重比较任一失配都必须拒绝。
        replacement.token = "replacement-owner"
        replacement.controlPort = replacementControl.port
        const result = await runInteractiveDb(replacementLockPath, ["compress", "--older-than", "0ms"], "y", () =>
          Bun.write(replacementLockPath, JSON.stringify(replacement)),
        )
        // replacement 后的 Y 必须以非零退出失败；expected-owner 校验先于任何 control 请求。
        expect(result.exitCode).not.toBe(0)
        expect(result.output).toContain("owner changed")
        // 原 daemon 不受影响：拒绝路径不能附带停机或锁清理副作用。
        expect(ServerLock.alive(proc.pid)).toBe(true)
      } finally {
        replacementControl.stop(true)
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS * 2 + 60_000,
  )

  // #535：此切片同时验证 query-selected shutdown 与普通 stop，防止 DB preflight 改写共享 endpoint 默认语义。
  test(
    "maintenance-idle shutdown refuses active work without changing daemon stop",
    async () => {
      await using tmp = await tmpdir()
      const lockPath = path.join(tmp.path, "tui-server.json")
      const { proc, lock } = await spawnDaemon(lockPath, { OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000" })
      // 普通 stop 与 maintenance-idle 共用 endpoint，但只有后者在 active work 时返回 busy。
      try {
        if (!lock.controlPort) throw new Error("missing control port")
        // 先用公开 status 请求完成数据库初始化，后续插入的行才能进入真实 eligibility 扫描。
        const initialized = await controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", { operation: "status" })
        expect(initialized.status).toBe(200)
        const db = new Database(lock.dbPath)
        db.exec("PRAGMA foreign_keys = OFF")
        // 500 行 batchSize 1 的任务足够长：409 请求落在任务 still running 的窗口内。
        db.exec(`WITH RECURSIVE rows(index_value) AS (SELECT 0 UNION ALL SELECT index_value + 1 FROM rows WHERE index_value < 499) INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_gate_' || index_value, 'msg_gate', 'ses_gate', 1, 1, '{"type":"reasoning","text":"x"}' FROM rows`)
        db.close()
        // 202 证明 worker 已接受真实 task；后续 409 不能由测试伪造的内存 flag 提供。
        const start = await controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", { operation: "compress", olderThanMs: 0, batchSize: 1 })
        expect(start.status).toBe(202)
        // 只有公开 202 之后发出的 conditional request 才能证明 gate 覆盖已接受任务，而非预请求占位。
        // query mode 的授权只属于 DB preflight；它不能继承显式 daemon stop 的“中断后关闭”语义。
        const conditional = await controlRequest(lock, `${ServerLock.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(conditional.status).toBe(409)
        // 409 是业务拒绝：daemon 必须继续存活，不得把 busy 错误升级成进程退出。
        expect(ServerLock.alive(proc.pid)).toBe(true)
        // 不带 query 的公开 stop 仍须成功，防止 DB preflight 收紧既有用户控制面。
        const stopped = await runDaemonStop(lockPath)
        expect(stopped.exitCode, stopped.stderr).toBe(0)
        // 普通 stop 文案保持 #259 契约；maintenance-idle 不得改写共享 endpoint 的默认语义。
        expect(stopped.stderr).toContain("Stopped opencode daemon.")
        expect(ServerLock.alive(proc.pid)).toBe(false)
      } finally {
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS,
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
        // #535：machine JSON 已与提示共用 stderr；truncate WAL 避免 CLI 打开库时的恢复日志把首个 "{" 前移进夹具文本。
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()

        // #524：真实 CLI 读取同一 lock/token；旧两秒 deadline 会在 daemon 完成精确报告前退出。
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
      // #535：dead owner 强制 recovery 经过真实 stale-rename 边界，而不是直接调用 worker 私有状态。
      const leaseDir = path.join(`${dbPath}.maintenance`, "lock")
      const staleLease = async (taskID: string) => {
        // pid 取 int32 上限：必然不存在于任何活进程表，reconcile 必走 dead-owner 分支。
        await mkdir(leaseDir, { recursive: true })
        await Bun.write(
          path.join(leaseDir, "owner.json"),
          JSON.stringify({ pid: 2_147_483_647, token: `dead-${taskID}`, taskID, dbPath, startedAt: 1 }),
        )
      }
      await staleLease(task.taskID)
      // #539：Track H+D：共享 stage worker；write-gate + OD-1 stages；不声称关闭 CI hang。
      // 主 lifecycle 仍走完整 start/resume/409/idle 合同；Force A/B 只验证诊断可红。
      const { proc, reader } = spawnStageWorker(lockPath, leaseDir)
      // 两个 marker 分别控制“注册前”和“terminal 后释放前”，完全避免依赖调度速度。
      try {
        expect(await readUntil(reader, "rename-blocked-1")).toContain("rename-blocked-1")
        // recovery 尚未取得 lease 时不得先发布可接受 shutdown/start 的 daemon owner。
        expect(await Bun.file(lockPath).exists()).toBe(false)
        // 第一个 gate 放行后 recovery 才能拿 lease；终态 checkpoint 先于 lease release 到达。
        await stageWorkerStdin(proc).write("continue\n")
        expect(await readUntil(reader, "lease-release-blocked")).toContain("lease-release-blocked")
        // lock 只在 recovery 已取得 lease 并登记 activeMaintenance 后才允许对外发布。
        let lock: ServerLock.ServerLock | undefined
        const lockDeadline = Date.now() + DAEMON_START_TIMEOUT_MS
        while (!lock && Date.now() < lockDeadline) {
          lock = await Bun.file(lockPath).json().catch(() => undefined)
          if (!lock) await Bun.sleep(POLL_INTERVAL_MS)
        }
        if (!lock?.controlPort) throw new Error("recovered daemon did not publish its control lock")
        // token 来自 recovery 完成注册后发布的真实 daemon lock，后续请求都验证同一 owner。
        let settled = false
        const terminal = controlRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${task.taskID}`)
          .then(async (response) => ({ status: response.status, body: await response.json() }))
        void terminal.then(() => (settled = true))
        await Bun.sleep(100)
        // 固定等待只观察 marker 已建立的 pending 状态，不用于猜测 worker 是否进入该状态。
        expect(settled).toBe(false)
        // lease cleanup 被 marker 挡住时，其他 control 请求仍可响应，证明不是整个 server 被阻塞。
        const statusReport = await controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", { operation: "status" })
        expect(statusReport.status).toBe(200)
        // terminal-but-active 窗口内 conditional shutdown 必须拒绝；lease release 尚未完成。
        const busy = await controlRequest(lock, `${ServerLock.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(busy.status).toBe(409)
        // 释放 lease 后 terminal 与 conditional shutdown 才能依次成功，禁止 CLI retry workaround。
        await stageWorkerStdin(proc).write("release\n")
        expect(await terminal).toMatchObject({ status: 200, body: { status: "completed" } })
        const conditional = () => controlRequest(lock, `${ServerLock.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        const waitIdle = async (taskID: string) => {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const response = await controlRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${taskID}`)
            const body = (await response.json()) as { status?: string }
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
        const starting = controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, "POST", { operation: "compress", olderThanMs: 0, batchSize: 1 })
        // #539：blocked-2 用 waitStartGate：continue 未预缓冲，HTTP 无 marker 可分类；blocked-3 仍 marker-first。
        // 30s 仅覆盖正常 gate 出现；Force A 的 3s 是故意失败窗，二者不可互换。
        const startGate = await waitStartGate(reader, "rename-blocked-2", starting, 30_000)
        expect(startGate).toContain("rename-blocked-2")
        expect(startGate).toContain("stage:stale-rename")
        expect((await conditional()).status).toBe(409)
        // 同一 chunk 预置 start/resume 两个 gate token，避免 Windows pipe 的第三次小写入延迟。
        // #539：预缓冲使 blocked-3 的 gate 在 marker 写出后立即放行，故禁止对 blocked-3 做 HTTP-without-marker 竞态。
        await stageWorkerStdin(proc).write("continue\ncontinue\n")
        const startResponse = await starting
        // pending 期拒绝不消耗 start 请求；放行后同一请求仍须返回 202。
        expect(startResponse.status).toBe(202)
        await waitIdle(((await startResponse.json()) as { taskID: string }).taskID)
        // resume gate 重新写 interrupted record，验证另一 producer 也在首个 await 前发布 pending。
        // resume 经过独立 reconcile/lease producer；它不能只依赖 start 路径偶然设置的 active 状态。
        const resumeTask = { ...task, taskID: "dbm_resume_gate", status: "interrupted" as const, updatedAt: Date.now() }
        await ServerLock.writeMaintenanceTask(resumeTask)
        await staleLease(resumeTask.taskID)
        const resuming = controlRequest(lock, ServerLock.CONTROL_MAINTENANCE_RESUME_PATH, "POST", { taskID: resumeTask.taskID })
        // #539：blocked-3：marker-first 顺序；HTTP 202 可在 marker 之后任意时刻返回，不得误分类。
        // rename-blocked-3 锁定 resume 也在 lease await 阶段；409 覆盖它的过渡期。
        expect(await readUntil(reader, "rename-blocked-3")).toContain("rename-blocked-3")
        expect((await conditional()).status).toBe(409)
        const resumeResponse = await resuming
        expect(resumeResponse.status).toBe(202)
        await waitIdle(((await resumeResponse.json()) as { taskID: string }).taskID)
        // 两个过渡期都 terminal 后才允许 conditional stop，证明 pending 与 active 没有残留计数。
        const stopped = await controlRequest(lock, `${ServerLock.CONTROL_SHUTDOWN_PATH}?maintenance-idle=1`, "POST")
        expect(stopped.status).toBe(200)
        // conditional 200 后 daemon 必须真实退出；否则门控只是返回值而不是生命周期语义。
        expect(await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout")])).not.toBe("timeout")
      } finally {
        reader.releaseLock()
        if (ServerLock.alive(proc.pid)) proc.kill("SIGTERM")
        await proc.exited.catch(() => undefined)
      }
    },
    DAEMON_START_TIMEOUT_MS + 90_000,
  )
})

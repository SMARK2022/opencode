#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Terminal } from "@xterm/headless"
import { spawn, type Proc } from "../src/pty/pty.bun"

const binaryArg = process.argv[process.argv.indexOf("--binary") + 1]
if (!binaryArg || process.argv.indexOf("--binary") === -1) {
  console.error("Usage: bun run script/smoke-opentui-artifact.ts --binary <absolute-path>")
  process.exit(1)
}

const binary = path.resolve(binaryArg)
if (!(await Bun.file(binary).exists())) throw new Error(`Compiled OpenCode binary not found: ${binary}`)

// rootReport同时是scenario-child标记和唯一IPC路径，避免outer误递归启动第二层child。
const rootReport = process.env.OPENCODE_SMOKE_ROOT_REPORT
if (process.platform === "win32" && !rootReport) {
  // 随机report不位于待删除root内，ConPTY锁住root时outer仍能读取清理ownership信息。
  const report = path.join(os.tmpdir(), `opencode-smoke-root-${crypto.randomUUID()}.txt`)
  // bun-pty的ConPTY cwd handle只在宿主Bun退出时完全释放；outer等待scenario child后再删除隔离root。
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, OPENCODE_SMOKE_ROOT_REPORT: report },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  // 必须先观察宿主Bun退出，再删除cwd root；只等待PTY child死亡不足以证明ConPTY host已释放handle。
  const code = await child.exited
  const childRoot = await Bun.file(report)
    .text()
    .catch(() => undefined)
  let error: unknown
  if (childRoot) {
    // child只上报本次mkdtemp绝对路径，outer不扫描宿主temp或根据进程名猜测清理目标。
    await fs.rm(childRoot.trim(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((cause) => {
      error = cause
    })
  } else if (code === 0) {
    error = new Error("Windows artifact smoke child did not publish its cleanup root")
  }
  await fs.rm(report, { force: true })
  // scenario failure已经由child输出；outer cleanup不能把它改写成另一种exit结果。
  if (code !== 0) {
    if (error) console.error("[opentui-smoke] cleanup after scenario failure:", error)
    process.exit(code)
  }
  if (error) throw error
  process.exit(0)
}

const objective = "检查log，请你自行独立完整完成相应的调研与检查，并进行多轮的负载并发、高压"
const spinnerGlyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⋯"]
// objective直接复用Goal API的green literal，测试验证的是最终生产字符串而不是缩短后的样例。
// 两个“查”必须在source和headless frame中数量一致，才能观察到wide glyph跨行重复。
// 不在这里手工插入换行，因为那会绕过OpenTUI word-wrap的真实边界。
const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-opentui-smoke-"))
// root在创建任何PTY之前发布，scenario早退时outer仍拥有确定且有界的清理目标。
if (rootReport) await Bun.write(rootReport, root)
const lockPath = path.join(root, "tui-server.json")
const project = path.join(root, "project")
let modelRequests = 0
// fixture只实现OpenAI-compatible chat completion的必要SSE，不访问外网或真实账号。
// request计数是独立的readiness信号，比固定sleep更能证明prompt真正到达provider。
// 响应先保持busy窗口，再发送ok和DONE，覆盖spinner和完成态的顺序不变量。
const fixture = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 })
    }
    modelRequests += 1
    await Bun.sleep(1_000)
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const terminal = new Terminal({ cols: 160, rows: 30, allowProposedApi: true })
// headless terminal使用与PTY相同的初始geometry，避免测试模型和真实进程从第一帧就产生宽度分歧。
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !["OPENCODE_PROCESS_ROLE", "OPENCODE_RUN_ID", "OPENCODE_PID"].includes(entry[0]),
    ),
  ),
  OPENCODE_PROCESS_ROLE: "main",
  OPENCODE_RUN_ID: crypto.randomUUID(),
  OPENCODE_LOCK_PATH: lockPath,
  OPENCODE_DB: path.join(root, "opencode.db"),
  OPENCODE_TEST_HOME: path.join(root, "home"),
  OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000",
  OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
  OPENCODE_PURE: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "test/test-model",
    provider: {
      test: {
        name: "Artifact Smoke Fixture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: { "test-model": { name: "Artifact Smoke Model", limit: { context: 128000, output: 4096 } } },
        options: { apiKey: "test-key", baseURL: `${fixture.url}v1` },
      },
    },
  }),
  XDG_DATA_HOME: path.join(root, "share"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  NO_COLOR: "1",
}
// 清理继承的process metadata，避免compiled worker误走worker入口或复用宿主daemon。
// 所有状态目录都位于本次mkdtemp根下，最终finally删除它们以证明harness没有污染用户环境。
// OPENCODE_CONFIG_CONTENT锁定唯一fixture model，隔离配置不会读取宿主home中的provider。

let launcher: Proc | undefined
let tui: Proc | undefined
let daemonPid: number | undefined
let launcherExit: { exitCode: number; signal?: number | string } | undefined
let launcherRaw = ""
let raw = ""
let stage = "setup"
let lockInfo: { port: number; pid: number; token: string; controlPort: number } | undefined
let sessionID: string | undefined
let terminalData: { dispose(): void } | undefined
// subscription分别保存，成功路径提前dispose后finally仍可幂等清理，不依赖事件库的隐式GC。
let launcherData: { dispose(): void } | undefined
let launcherExited: { dispose(): void } | undefined
let tuiData: { dispose(): void } | undefined
// scenario与cleanup错误分槽保存，finally阶段不能通过抛出较晚错误篡改first divergence。
let scenarioError: unknown
let cleanupError: unknown

try {
  await Promise.all([
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(path.join(root, "share", "opencode"), { recursive: true }),
  ])
  // migration marker只跳过历史JSON迁移；SQLite schema仍由真实compiled daemon初始化。
  await Bun.write(path.join(root, "share", "opencode", "opencode.db"), "")

  stage = "start launcher"
  console.error(`[opentui-smoke] ${stage}`)
  launcher = spawn(binary, [project], {
    name: "xterm-256color",
    cols: 160,
    rows: 30,
    cwd: project,
    env: { ...env, OPENCODE_RUN_ID: crypto.randomUUID() },
  })
  launcherData = launcher.onData((chunk) => {
    // launcher transcript独立保存，失败时可以区分bootstrap输出和第二次Session TUI输出。
    launcherRaw += chunk
    raw += chunk
    terminal.write(chunk)
  })
  terminalData = terminal.onData((chunk) => (tui ?? launcher)?.write(chunk))
  launcherExited = launcher.onExit((event) => {
    // readiness轮询必须同时观察提前退出，避免等待完整timeout后才报告已知失败。
    launcherExit = event
  })
  const lock = await waitFor(
    async () => {
      if (launcherExit)
        throw new Error(`initial compiled TUI exited before daemon readiness: ${JSON.stringify(launcherExit)}`)
      const value = await Bun.file(lockPath)
        .json()
        .catch(() => undefined)
      if (!value?.port || !value?.pid) return
      const response = await fetch(`http://127.0.0.1:${value.port}/global/health`).catch(() => undefined)
      if (!response?.ok) return
      return value as { port: number; pid: number; token: string; controlPort: number }
    },
    "compiled daemon did not publish a healthy lock",
    60_000,
  )
  // lock中的health只证明内部HTTP已监听；后续control SSE才证明真实TUI已经接管daemon。
  // 两个阶段分开记录，避免一个偶然可访问的HTTP端口掩盖TUI没有连接的情况。
  lockInfo = lock
  daemonPid = lock.pid

  // health只证明HTTP server可用；control status中的首个SSE client才证明真实TUI已完成attach。
  stage = "wait for launcher SSE"
  console.error(`[opentui-smoke] ${stage}`)
  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${lock.controlPort}/status`, {
        headers: { "x-opencode-daemon-token": lock.token },
        signal: AbortSignal.timeout(500),
      }).catch(() => undefined)
      if (!response?.ok) return
      const status = await response.json().catch(() => undefined)
      // Bootstrap SSE的断开可能晚于PTY退出；第二个TUI只要求至少有一个真实client已接管。
      if (!status || typeof status !== "object" || !("tuiClients" in status) || status.tuiClients < 1) return
      return true
    },
    "initial compiled TUI did not attach to the daemon",
    60_000,
  )
  // 首个SSE client已经建立；此后launcher退出会进入正常idle策略，不再触发startup shutdown。
  console.error(`[opentui-smoke] daemon ready pid=${lock.pid} port=${lock.port}`)

  const headers = { "content-type": "application/json", "x-opencode-directory": project }
  // Session和Goal通过公开HTTP seam创建，不能直接写SQLite或调用TUI内部store。
  // 这样frame断言同时覆盖producer（API持久化）和consumer（Goal sidebar同步）。
  stage = "create Session"
  console.error(`[opentui-smoke] ${stage}`)
  const sessionResponse = await fetch(`http://127.0.0.1:${lock.port}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "OpenTUI artifact smoke" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!sessionResponse.ok)
    throw new Error(`Session creation failed: ${sessionResponse.status} ${await sessionResponse.text()}`)
  const session = await sessionResponse.json()
  if (typeof session?.id !== "string") throw new Error(`Session creation returned no id: ${JSON.stringify(session)}`)
  sessionID = session.id

  stage = "create Goal"
  console.error(`[opentui-smoke] ${stage}`)
  const goalResponse = await fetch(`http://127.0.0.1:${lock.port}/session/${session.id}/goal`, {
    // directory header与Session创建保持一致，Goal不能写入另一个instance的数据库命名空间。
    method: "POST",
    headers,
    body: JSON.stringify({ objective }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!goalResponse.ok) throw new Error(`Goal creation failed: ${goalResponse.status} ${await goalResponse.text()}`)

  stage = "persist Session and Goal"
  console.error(`[opentui-smoke] ${stage}`)
  // 第一个TUI只负责daemon bootstrap；第二个TUI必须通过公开--session参数重新接管同一Session。
  // 禁止select-session或源码入口fallback，否则无法证明compiled CLI的真实恢复路径。
  // 首个TUI只负责让真实daemon完成启动；第二个TUI通过公开CLI session参数进入目标Session。
  stage = "wait for bootstrap input readiness"
  console.error(`[opentui-smoke] ${stage}`)
  // SSE attach早于renderer/input bindings；只在用户可见prompt出现后发送一次真实退出键，不能靠重复输入补偿。
  await waitFor(
    () => (capture(terminal).includes("Ask anything") ? true : undefined),
    "bootstrap TUI never became input-ready",
    30_000,
  )
  stage = "stop bootstrap TUI"
  console.error(`[opentui-smoke] ${stage}`)
  await requestTuiExit(launcher, "bootstrap TUI did not exit after the exit request")
  launcherData?.dispose()
  launcherData = undefined
  launcherExited?.dispose()
  launcherExited = undefined
  launcher = undefined

  stage = "start Session TUI"
  console.error(`[opentui-smoke] ${stage}`)
  terminal.reset()
  raw = ""
  tui = spawn(binary, [project, "--session", session.id], {
    name: "xterm-256color",
    cols: 160,
    rows: 30,
    cwd: project,
    env: { ...env, OPENCODE_RUN_ID: crypto.randomUUID() },
  })
  tuiData = tui.onData((chunk) => {
    // ANSI chunk按到达顺序写入同一个terminal model，不能按行重排或先strip控制码。
    // OpenTUI输出是增量diff，只有保留顺序才能还原用户实际看到的cell状态。
    raw += chunk
    terminal.write(chunk)
  })
  tui.onExit((event) => {
    // 第二次TUI退出事件复用bounded diagnostic字段，failure artifact不需要额外全局listener。
    launcherExit = event
  })
  await waitFor(
    async () => {
      // 第二次attach读取同一control token，证明没有偷偷启动另一个daemon owner。
      // client计数必须回到一个活跃TUI，旧bootstrap连接不能成为成功依据。
      const response = await fetch(`http://127.0.0.1:${lock.controlPort}/status`, {
        headers: { "x-opencode-daemon-token": lock.token },
        signal: AbortSignal.timeout(500),
      }).catch(() => undefined)
      if (!response?.ok) return
      const status = await response.json().catch(() => undefined)
      if (!status || typeof status !== "object" || !("tuiClients" in status) || status.tuiClients !== 1) return
      return true
    },
    "session TUI did not attach to the daemon",
    60_000,
  )
  const initial = await waitFor(
    () => {
      // 轮询cell frame而不是raw ANSI，因为同一glyph可能在增量diff中被多次擦写。
      // 只有最终viewport能回答用户观察到的重复、错位和replacement character问题。
      const frame = capture(terminal)
      if (!frame.includes("Goal") || !frame.includes("检查log")) return
      return frame
    },
    "compiled TUI never rendered the Goal sidebar",
    60_000,
  )
  // 只在Goal和精确objective同时出现时进入断言，避免空sidebar的偶然渲染被算作通过。
  stage = "verify initial frame"
  console.error(`[opentui-smoke] ${stage}`)
  assertFrame(initial, "initial")

  tui.resize(150, 28)
  terminal.resize(150, 28)
  // PTY和headless terminal必须同步resize；单独改变一侧会把terminal模型误差当成renderer错误。
  // 150x28覆盖窄宽和少行场景，随后恢复160x30验证resize不会丢失Goal状态。
  stage = "verify resized frame"
  console.error(`[opentui-smoke] ${stage}`)
  const resized = await waitFor(() => {
    // resize完成条件仍要求完整Goal文字，单纯收到SIGWINCH或任意新frame都不足以通过。
    const frame = capture(terminal)
    if (!frame.includes("Goal") || !frame.includes("检查log")) return
    return frame
  }, "compiled TUI did not render Goal after resize")
  assertFrame(resized, "resized")

  tui.resize(160, 30)
  terminal.resize(160, 30)
  stage = "verify restored frame"
  console.error(`[opentui-smoke] ${stage}`)
  const restored = await waitFor(() => {
    const frame = capture(terminal)
    if (!frame.includes("Goal") || !frame.includes("检查log")) return
    return frame
  }, "compiled TUI did not render Goal after restoring size")
  // 恢复尺寸后重新取frame，不能复用窄尺寸的旧字符串作为resize green证据。
  assertFrame(restored, "restored")

  stage = "verify busy spinner"
  console.error(`[opentui-smoke] ${stage}`)
  tui.write("hello\r")
  // prompt输入走PTY公开边界；fixture request计数证明不是只渲染静态busy装饰。
  await waitFor(() => (modelRequests > 0 ? true : undefined), "local model fixture did not receive the prompt", 15_000)
  await waitFor(
    () => {
      // 当前UI以agent/model标签表达运行态；fixture的一秒延迟保证该状态可被真实frame捕获。
      // 这里不匹配日志字符串，避免--print-logs改变测试结果。
      const frame = capture(terminal)
      return frame.includes("Build · Artifact Smoke Model") ? frame : undefined
    },
    "compiled TUI did not render a busy spinner",
    15_000,
  )
  // Build/模型标签是当前production spinner的可观察busy状态；直接spinner intrinsic另有单测覆盖。
  await waitFor(
    () => {
      const frame = capture(terminal)
      return frame.includes("ok") ? frame : undefined
    },
    "compiled TUI did not render model completion",
    15_000,
  )
  const completed = capture(terminal)
  // 完成后允许历史assistant文本保留，但spinner glyph不能继续占用当前busy状态。
  if (spinnerGlyphs.some((indicator) => completed.includes(indicator))) {
    throw new Error("compiled TUI retained spinner glyph after model completion")
  }

  stage = "stop Session TUI"
  console.error(`[opentui-smoke] ${stage}`)
  await requestTuiExit(tui, "compiled TUI did not exit after the exit request")
  tuiData?.dispose()
  tuiData = undefined
  tui = undefined

  stage = "stop daemon"
  console.error(`[opentui-smoke] ${stage}`)
  const stop = Bun.spawn([binary, "daemon", "stop"], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [stopCode, stopOut, stopErr] = await Promise.all([
    stop.exited,
    new Response(stop.stdout).text(),
    new Response(stop.stderr).text(),
  ])
  // daemon stop必须通过公开控制命令完成，随后PID死亡才算cleanup成功，不能只杀PTY子进程。
  if (stopCode !== 0) throw new Error(stopErr || stopOut || `daemon stop exited ${stopCode}`)
  await waitFor(() => (!alive(lock.pid) ? true : undefined), "compiled daemon remained alive after stop", 15_000)
  // 清零daemonPid只发生在确认进程死亡后，finally仍能处理stop命令半成功的情况。
  daemonPid = undefined

  console.log(
    JSON.stringify({
      binary,
      sessionID: session.id,
      sourceCount: count(objective, "查"),
      renderedCount: count(initial, "查"),
      modelRequests,
    }),
  )
} catch (error) {
  // 失败artifact只记录隔离root、相关PID和有界frame，不扫描宿主home或全量环境变量。
  // 诊断必须帮助定位阶段，同时不能把用户凭据或无关runner进程写入上传产物。
  const artifacts = path.resolve(import.meta.dir, "../.artifacts/opentui-smoke")
  await fs.mkdir(artifacts, { recursive: true })
  // 文件清单仅遍历隔离root并在artifact中截断，恢复诊断能力但不读取用户home或无限扩大上传内容。
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: false })).catch(() => [])
  const processes =
    process.platform === "win32"
      ? "process inventory unavailable on Windows before ConPTY validation"
      : await processInventory([launcher?.pid, tui?.pid, daemonPid].filter((pid): pid is number => pid !== undefined))
  // 只保存有界的转义PTY尾部，既保留worker退出原因，也避免完整ANSI帧无限放大CI artifact。
  const diagnostic = {
    binary,
    root,
    stage,
    files: files.slice(0, 200),
    processes,
    launcherPid: launcher?.pid,
    launcher: JSON.stringify(launcherRaw.slice(-16_384)),
    launcherExit,
    tui: JSON.stringify(raw.slice(-16_384)),
    goalSync: {
      started: raw.includes("goal sync started"),
      response: raw.includes("goal sync response"),
      stored: raw.includes("goal sync stored"),
      failed: raw.includes("goal sync failed"),
    },
    frame: capture(terminal),
    daemon: lockInfo
      ? {
          // failure时重新读取health、control、Session和Goal，区分renderer失败与daemon/API失败。
          // 这些探针都有短timeout，诊断自身不能让CI在原始故障后永久挂起。
          health: await fetch(`http://127.0.0.1:${lockInfo.port}/global/health`, {
            signal: AbortSignal.timeout(2_000),
          })
            .then((response) => response.status)
            .catch((error) => String(error)),
          status: await fetch(`http://127.0.0.1:${lockInfo.controlPort}/status`, {
            headers: { "x-opencode-daemon-token": lockInfo.token },
            signal: AbortSignal.timeout(2_000),
          })
            .then((response) => response.text())
            .catch((error) => String(error)),
          session: sessionID
            ? await fetch(`http://127.0.0.1:${lockInfo.port}/session/${sessionID}`, {
                headers: { "x-opencode-directory": project },
                signal: AbortSignal.timeout(2_000),
              })
                .then((response) => response.status)
                .catch((error) => String(error))
            : undefined,
          goal: sessionID
            ? await fetch(`http://127.0.0.1:${lockInfo.port}/session/${sessionID}/goal`, {
                headers: { "x-opencode-directory": project },
                signal: AbortSignal.timeout(2_000),
              })
                .then(async (response) => ({ status: response.status, body: await response.text() }))
                .catch((error) => String(error))
            : undefined,
        }
      : undefined,
    tuiStack: tui?.pid ? await sampleProcess(tui.pid) : undefined,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  }
  await Bun.write(path.join(artifacts, "failure.json"), JSON.stringify(diagnostic, null, 2) + "\n")
  scenarioError = error
} finally {
  // 某个资源清理失败后仍继续关闭其余owner；最终只报告首个cleanup错误且不覆盖scenario first divergence。
  for (const subscription of [launcherData, launcherExited, tuiData, terminalData]) {
    await cleanupStep(() => subscription?.dispose())
  }
  await cleanupStep(() => Promise.all([terminatePty(launcher), terminatePty(tui)]))
  launcher = undefined
  tui = undefined
  launcherData = undefined
  launcherExited = undefined
  tuiData = undefined
  terminalData = undefined
  await cleanupStep(async () => {
    const current = await Bun.file(lockPath)
      .json()
      .catch(() => undefined)
    const daemonPids = new Set(
      [daemonPid, typeof current?.pid === "number" ? current.pid : undefined].filter(
        (pid): pid is number => pid !== undefined,
      ),
    )
    // failure可能发生在replacement owner发布之后；只读取本次隔离lock，不扫描或终止宿主其他进程。
    await Promise.all([...daemonPids].map((pid) => terminatePID(pid)))
  })
  await cleanupStep(() => fixture.stop(true))
  await cleanupStep(() => terminal.dispose())
  if (!rootReport)
    await cleanupStep(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
}

// cleanup故障不能覆盖更早的scenario first divergence；成功scenario仍会被cleanup故障阻断。
if (scenarioError) {
  if (cleanupError) console.error("[opentui-smoke] cleanup after scenario failure:", cleanupError)
  throw scenarioError
}
if (cleanupError) throw cleanupError

async function cleanupStep(run: () => void | Promise<unknown>) {
  // 每一步独立执行并保留首个错误，单个PTY故障不能阻止daemon、fixture和terminal继续释放。
  try {
    await run()
  } catch (error) {
    cleanupError ??= error
  }
}

function assertFrame(frame: string, phase: string) {
  // xterm cell model消化多次diff重绘，最终frame中的字形计数才能独立证明没有边界重复。
  if (count(frame, "查") !== count(objective, "查")) {
    throw new Error(`${phase} Goal frame duplicates CJK glyphs: ${JSON.stringify(frame)}`)
  }
  if (frame.includes("\uFFFD")) throw new Error(`${phase} Goal frame contains replacement characters`)
  // 这两个断言分别覆盖宽字重复和UTF-8解码损坏，复制顺序正常不能替代cell frame证据。
}

function capture(value: Terminal) {
  // viewportY保证读取用户当前可见区域，scrollback中的旧Goal不能冒充当前resize frame。
  // translateToString保留cell顺序并只裁掉行尾空白，行首几何仍参与错位证据。
  const buffer = value.buffer.active
  return Array.from(
    { length: value.rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
  ).join("\n")
}

function count(value: string, needle: string) {
  return value.split(needle).length - 1
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string, timeout = 10_000) {
  // 轮询只接受显式非undefined readiness，false或空frame不会被truthy转换误判。
  // 每个调用方提供行为级错误信息，使CI artifact能标识准确失败阶段。
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(message)
}

function alive(pid: number) {
  // signal 0只探测PID存在性，不改变目标进程状态，适合cleanup前后的同一不变量检查。
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function requestTuiExit(proc: Proc, message: string) {
  // 调用方已观察公开input-ready frame，此函数只负责subscribe-before-action和同一进程退出，不补发输入。
  const exited = Promise.withResolvers<void>()
  // 先订阅再触发退出，避免快速renderer cleanup发生在onExit注册前而被误报成超时。
  const subscription = proc.onExit(() => exited.resolve())
  try {
    if (process.platform !== "win32") {
      // Unix直接向真实child PID发送SIGINT，走ExitProvider的production signal handler；adapter.kill会忽略传入signal。
      process.kill(proc.pid, "SIGINT")
    } else {
      // Ctrl+C会广播给共享console中的daemon；input-ready后使用同步内建命令，只关闭当前TUI且不依赖autocomplete。
      proc.write("exit\r")
    }
    await Promise.race([
      exited.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error(message)
      }),
    ])
    // bun-pty自然退出只发布event，不关闭native PTY handle；此时kill是幂等close，必须早于root rm。
    proc.kill()
    await waitFor(() => (!alive(proc.pid) ? true : undefined), `TUI ${proc.pid} remained alive after exit`, 5_000)
  } finally {
    subscription.dispose()
  }
}

async function terminatePty(proc: Proc | undefined) {
  if (!proc) return
  // 订阅必须早于kill；快速退出若发生在listener注册前，会留下ConPTY handle并重现Windows EBUSY。
  const subscription = proc.onExit(() => undefined)
  try {
    // 即使child已经死亡也必须调用kill，让bun-pty执行native close；alive只描述进程，不描述PTY handle。
    proc.kill()
    // bun-pty.kill会同步发synthetic exit；删除root前必须另外等待OS PID消失，不能把event当作进程死亡。
    const stopped = await waitFor(() => (!alive(proc.pid) ? true : undefined), `PTY ${proc.pid} ignored cleanup`, 2_000)
      .then(() => true)
      .catch(() => false)
    if (stopped) return
    if (alive(proc.pid)) process.kill(proc.pid, "SIGKILL")
    await waitFor(() => (!alive(proc.pid) ? true : undefined), `PTY ${proc.pid} ignored cleanup`, 5_000)
  } finally {
    subscription.dispose()
  }
}

async function terminatePID(pid: number) {
  // PID集合只来自本次隔离lock和已记录daemon owner，cleanup不会按名称终止runner上的无关进程。
  if (!alive(pid)) return
  process.kill(pid)
  const stopped = await waitFor(() => (!alive(pid) ? true : undefined), `daemon ${pid} ignored cleanup`, 2_000)
    .then(() => true)
    .catch(() => false)
  if (stopped) return
  process.kill(pid, "SIGKILL")
  await waitFor(() => (!alive(pid) ? true : undefined), `daemon ${pid} ignored forced cleanup`, 5_000)
}

async function processInventory(pids: number[]) {
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,state=,command="], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) return stderr || `ps exited ${code}`
  // launcher后代与隔离root足以定位本harness进程，不能把runner上其他命令或凭据写入artifact。
  return stdout
    .split("\n")
    .filter((line) => pids.some((pid) => line.includes(String(pid))) || line.includes(root) || line.includes(binary))
    .slice(0, 100)
}

async function sampleProcess(pid: number) {
  // sample只在macOS失败诊断中执行，其他平台不引入不存在的系统工具依赖。
  if (process.platform !== "darwin") return "sample unavailable on this platform"
  const proc = Bun.spawn(["sample", String(pid), "1", "-mayDie"], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return code === 0 ? stdout.slice(-16_384) : stderr || `sample exited ${code}`
}

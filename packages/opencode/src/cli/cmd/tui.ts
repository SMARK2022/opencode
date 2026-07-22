import { cmd } from "@/cli/cmd/cmd"
import { ServerLock } from "@/cli/tui/server-lock"
import { Flock } from "@opencode-ai/core/util/flock"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { Global } from "@opencode-ai/core/global"
import path from "path"
// #532：Windows relay spawn 需要 os.tmpdir 与 randomUUID（env/pid 握手文件）
import os from "os"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { UpdateNotice, UpdateSource } from "@opencode-ai/tui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"

declare global {
  const OPENCODE_WORKER_PATH: string
}

// 唯一生产 spawn seam 同时用于注入测试；测试不能另跑一条模拟发现算法。
type DaemonProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "unref" | "kill">
type SpawnDaemon = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => DaemonProcess | Promise<DaemonProcess>
async function spawnDaemon(cmd: string[], opts: Parameters<typeof Bun.spawn>[1]): Promise<DaemonProcess> {
  // 平台分支在默认 adapter 内一次选择，Windows 失败后绝不回退到会随 parent 死亡的 direct Bun child。
  if (process.platform !== "win32") return Bun.spawn(cmd, opts)
  const systemRoot = process.env.SystemRoot
  // wrapper 必须来自受 OS 管理的绝对目录，Project cwd 中的同名 powershell.exe 不能参与可执行文件解析。
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is not an absolute path")
  if (!cmd[0] || !cmd[1]) throw new Error("Windows daemon executable and worker target are required")
  // #495：encoded script 内容固定，两个动态路径只经环境变量传入，避免路径字符改变 PowerShell 语法结构。
  // #532：worker 不再由 wrapper 直接 Start-Process——wrapper 与 CLI 同属 kill-on-close job object，
  // 其子进程会随短命 launcher 连锁击杀，daemon 无法存活到外部 client 接入（机器接口语义在 Windows 失效）。
  // 改由 wrapper 经 WMI Win32_Process.Create 拉起 relay（服务进程上下文，天然脱离 CLI job），
  // relay 在 job 外 Start-Process worker；WMI Create 不继承调用方环境，env 经一次性 JSON 文件传递。
  const envRecord = { ...(opts?.env ?? {}) } as Record<string, string>
  // env 文件放在 lock 同目录（隔离的 daemon state root）——泄漏面与 lock 一致，relay 读完即删
  const baseDir = envRecord.OPENCODE_LOCK_PATH ? path.dirname(envRecord.OPENCODE_LOCK_PATH) : os.tmpdir()
  const nonce = randomUUID()
  const envFile = path.join(baseDir, `daemon-env-${nonce}.env`)
  const pidFile = path.join(baseDir, `daemon-pid-${nonce}.txt`)
  // 路径/argv/env 值全部 b64 编码：避免引号/空格/大小写重复键（PS5.1 Json 字典对 NO_PROXY/no_proxy 报重复键）
  const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64")
  // 过滤 undefined 值：Bun env 对象允许 undefined（写入时丢弃），b64 编码前必须剔除
  await Bun.write(
    envFile,
    Object.entries(envRecord)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}\t${b64u(v as string)}`)
      .join("\n"),
  )
  const relayScript = [
    "$ErrorActionPreference = 'Stop'",
    `$envPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u(envFile)}'))`,
    `$pidPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u(pidFile)}'))`,
    `$cwdPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u(process.cwd())}'))`,
    `$exePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u(cmd[0])}'))`,
    `$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u(cmd[1])}'))`,
    "try {",
    "  foreach ($line in [IO.File]::ReadAllLines($envPath)) {",
    "    if ([string]::IsNullOrWhiteSpace($line)) { continue }",
    "    $parts = $line -split [char]9, 2",
    "    if ($parts.Count -ne 2 -or $parts[0].Length -eq 0) { continue }",
    "    [Environment]::SetEnvironmentVariable($parts[0], [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1])))",
    "  }",
    "  $start = @{ FilePath = $exePath; ArgumentList = [char]34 + $targetPath + [char]34; PassThru = $true; WorkingDirectory = $cwdPath }",
    "  $worker = Start-Process @start -WindowStyle Hidden",
    "  [IO.File]::WriteAllText($pidPath, [string]$worker.Id)",
    "  Remove-Item -LiteralPath $envPath",
    "} catch {",
    "  # relay 失败可观测：错误落盘在 pid 文件旁，供 launcher 诊断（relay 无 stdout 通道）",
    "  [IO.File]::WriteAllText(($pidPath + '.err'), ($_ | Out-String))",
    "}",
  ].join("\n")
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:OPENCODE_DAEMON_TARGET
if ([string]::IsNullOrEmpty($target) -or $target.Contains([char]34)) { exit 87 }
# relay 由 WMI 服务进程创建——脱离 CLI 的 job object；其 Start-Process 的 worker 因此在 job 外存活
$relayEncoded = '${Buffer.from(relayScript, "utf16le").toString("base64")}'
$relayCmd = [char]34 + (Join-Path $PSHOME 'powershell.exe') + [char]34 + ' -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $relayEncoded
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($relayCmd, (Get-Location).Path, $startup)
if ($result.ReturnValue -ne 0) { exit 88 }
$deadline = (Get-Date).AddSeconds(60)
$workerPid = 0
while ((Get-Date) -lt $deadline -and $workerPid -le 0) {
  if (Test-Path -LiteralPath $env:OPENCODE_DAEMON_PID_FILE) { $workerPid = [int](Get-Content -Raw -LiteralPath $env:OPENCODE_DAEMON_PID_FILE) }
  else { Start-Sleep -Milliseconds 100 }
}
if ($workerPid -le 0) { exit 89 }
[Console]::Out.WriteLine($workerPid)
[Console]::Out.Flush()
# worker 可能已自行退出（快速失败路径）：Wait-Process 对不存在的 pid 抛终止错误，
# 会把健康的 startup 失败误报成 wrapper 崩溃（#179 race 检测消费该退出码）
if (Get-Process -Id $workerPid -ErrorAction SilentlyContinue) { Wait-Process -Id $workerPid -ErrorAction SilentlyContinue }
exit 0
`
  // absolute system wrapper 避免 Project cwd 选择同名程序；encoded source 保持动态路径只作为 data 进入脚本。
  const wrapper = Bun.spawn(
    [
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      // UTF-16LE base64 让整段脚本作为单一 data 进入 PowerShell；引号/空格不再进命令行解析层。
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      ...opts,
      env: {
        // 继承调用方隔离环境后只追加 wrapper 协议字段，worker 看到的配置与原 direct spawn 保持一致。
        ...(opts?.env as Record<string, string>),
        OPENCODE_DAEMON_EXECUTABLE: cmd[0],
        OPENCODE_DAEMON_TARGET: cmd[1],
        // #532：relay 写出 worker PID 的握手文件路径（env 文件路径已 b64 嵌入 relay 脚本）
        OPENCODE_DAEMON_PID_FILE: pidFile,
      },
      // stdout 必须 pipe：PID 握手与持续 drain 都依赖该协议通道，inherit 会同时丢失两者。
      stdout: "pipe",
      // detached:false 让 wrapper 与 parent 同属一个 job object；异常退出不会留下孤儿 supervisor。
      detached: false,
      // wrapper 是纯 supervisor，任何情况下都不得弹出新控制台窗口；worker 可见性由脚本的
      // -WindowStyle Hidden / -NoNewWindow 分支控制，与 wrapper 自身窗口无关。
      windowsHide: true,
    },
  )
  const stdout = wrapper.stdout
  if (!stdout || typeof stdout === "number") throw new Error("Windows daemon wrapper has no stdout pipe")
  // reader 只被握手与 drain 两个阶段顺序使用；并发持有会触发 stream 锁冲突。
  const reader = stdout.getReader()
  const timeout = Promise.withResolvers<never>()
  // timer 必须在 PID 握手完成时清除；普通 Promise.race 不会取消 sleep，残留回调会在超时后误杀健康 wrapper。
  const timer = setTimeout(() => {
    try {
      wrapper.kill()
    } catch {}
    timeout.reject(new Error("Windows daemon wrapper did not publish the worker PID"))
  }, DAEMON_START_TIMEOUT_MS)
  const worker = await Promise.race([readWorkerPID(reader), timeout.promise]).finally(() => clearTimeout(timer))
  // PID 首行之后继续消费同一 pipe；否则 daemon 日志填满 pipe 会阻塞 worker，--print-logs 也会静默丢失 stdout。
  const output = drainWrapperOutput(reader, worker.remainder, opts?.stdout === "inherit")
  // lock 发布前 wrapper 的 exit/PID 仍代表同一 worker；timeout kill 不能只结束 wrapper 后留下无锁后台进程。
  return {
    pid: worker.pid,
    // exit 同时等待 pipe EOF，确保大量 stdout 不会在 worker 退出后留下未消费的 native handle。
    exited: Promise.all([wrapper.exited, output]).then(([code]) => code),
    unref: () => wrapper.unref(),
    kill: (signal?: Parameters<DaemonProcess["kill"]>[0]) => {
      // 先终止真实 worker 再关闭 supervisor，避免 wrapper 消失后留下无 lock 生命周期观察者的孤儿 worker。
      try {
        process.kill(worker.pid, signal)
      } catch {}
      try {
        wrapper.kill()
      } catch {}
    },
  }
}
async function readWorkerPID(reader: ReadableStreamDefaultReader<Uint8Array>) {
  // 首个换行是 wrapper 协议边界；同一 chunk 中后续 worker 日志必须作为 remainder 交给 drain 而不能丢弃。
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (!text.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error("Windows daemon wrapper exited before publishing the worker PID")
      text += decoder.decode(next.value, { stream: true })
    }
    const end = text.indexOf("\n")
    const pid = Number(text.slice(0, end).trim())
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Windows daemon wrapper published an invalid PID: ${text}`)
    return { pid, remainder: text.slice(end + 1) }
  } catch (error) {
    // releaseLock 后 reader 不可复用：错误路径必须放弃 pipe 所有权，drain 不会再被调度。
    reader.releaseLock()
    throw error
  }
}
async function drainWrapperOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainder: string,
  forward: boolean,
) {
  // 默认模式也必须消费数据防止 pipe 背压；forward 仅控制用户可见性，不改变 worker 是否能继续运行。
  try {
    if (forward && remainder) process.stdout.write(remainder)
    while (true) {
      const next = await reader.read()
      // done 表示 wrapper 已退出且 pipe 排空；此后 exited promise 才能反映真实退出码。
      if (next.done) return
      if (forward) process.stdout.write(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}
// adapter 经对象属性暴露：测试 spy 替换属性后，同模块调用点立即生效。
export const DaemonProcess = {
  spawn: spawnDaemon as SpawnDaemon,
}

// Mirrors the V2 CLI updater: the TUI process checks every 10 minutes and installs on this machine,
// but only when the user picks an option in the /update dialog.
function createUpdater(latest: () => Promise<UpdateNotice | undefined>): UpdateSource {
  const listeners = new Set<(notice: UpdateNotice) => void>()
  let current: UpdateNotice | undefined
  const check = () =>
    latest()
      .then((notice) => {
        if (!notice || JSON.stringify(notice) === JSON.stringify(current)) return
        current = notice
        listeners.forEach((notify) => notify(notice))
      })
      .catch(() => {})
  setTimeout(check, 1000).unref?.()
  setInterval(check, 10 * 60 * 1000).unref?.()
  return {
    subscribe: (notify) => {
      if (current) notify(current)
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    check: async () => {
      const { Installation } = await import("@/installation")
      // A failed check leaves latest unset, which /update reports as "Couldn't check for updates."
      const latest = await Installation.latest(await Installation.method()).catch(() => undefined)
      return { current: InstallationVersion, latest }
    },
    apply: async (target) => {
      const { Installation } = await import("@/installation")
      const method = await Installation.method()
      if (method === "unknown") throw new Error("Installation method not found")
      if (target.type === "major") return Installation.upgradeMajor(method)
      return Installation.upgrade(method, target.version)
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  // 编译入口与源码入口共用 argv，文件 URL 必须在启动边界转换成原生路径。
  if (await Filesystem.exists(fileURLToPath(dist))) return fileURLToPath(dist)
  return fileURLToPath(new URL("../tui/worker.ts", import.meta.url))
}

// 依赖注入只替换外部 I/O，身份判断与失败清理仍执行下面的生产主路径。
export type DiscoverDaemonDeps = {
  read: typeof ServerLock.read
  alive: typeof ServerLock.alive
  ping: typeof ServerLock.ping
  clear: typeof ServerLock.clearIfOwner
  acquire: typeof Flock.acquire
  spawn: typeof DaemonProcess.spawn
  sleep: (ms: number) => Promise<unknown>
  resolveDaemonFile: () => Promise<string>
  identity: typeof ServerLock.identity
  placement: typeof ServerLock.placement
  resolveNetwork: (args: Parameters<typeof resolveNetworkOptionsNoConfig>[0]) => Promise<ReturnType<typeof resolveNetworkOptionsNoConfig>>
  electionTimeoutMs: number
  electionStaleMs: number
  pollMs: number
  waitMs: number
}

// 冷插件预热使用完整 60 秒健康等待，选举竞争者另有获锁等待预算。
export const DAEMON_START_TIMEOUT_MS = 60_000
// 75 秒只限制 contender 等待 acquire；持锁期限由 heartbeat 和 release 管理。
export const SERVER_ELECTION_TIMEOUT_MS = DAEMON_START_TIMEOUT_MS + 15_000
export const SERVER_ELECTION_STALE_MS = 5_000
export const SERVER_POLL_INTERVAL_MS = 200
// #259：daemon status 返回的类型——tuiClients 和 sessionActivity 用于退出提示
export type Status = { tuiClients: number; sessionActivity: number }


// 子进程快照只在唯一 spawn 前归一，父进程的 HTTP/HTTPS/ALL 代理与 CA 配置保持原值。
function applyProxyEnv(env: Record<string, string>) {
  const noProxy = [env.NO_PROXY, env.no_proxy].flatMap((value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  const merged = NetworkProxy.noProxyString(noProxy)
  env.NO_PROXY = merged
  env.no_proxy = merged
  if (process.platform === "win32" || process.platform === "darwin") {
    for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      delete env[k]
    }
  } else {
    // Linux 仍从 env 获取代理，双大小写必须一致才能避免各网络库选到不同地址。
    for (const [up, low] of [
      ["HTTP_PROXY", "http_proxy"],
      ["HTTPS_PROXY", "https_proxy"],
      ["ALL_PROXY", "all_proxy"],
    ] as const) {
      const v = env[up] ?? env[low]
      if (v) {
        env[up] = v
        env[low] = v
      }
    }
    if (!env.HTTPS_PROXY && !env.https_proxy && (env.HTTP_PROXY || env.http_proxy)) {
      const v = env.HTTP_PROXY ?? env.http_proxy!
      env.HTTPS_PROXY = v
      env.https_proxy = v
    }
  }
  return env
}

// 默认依赖不缓存发现结果；新的启动方必须重新核对磁盘 owner 与认证配置。
// 只缩短 contender 等待和探测频率，完整启动 deadline 仍由独立 waitMs 约束。
const defaultDiscoverDeps = (): DiscoverDaemonDeps => ({
  read: ServerLock.read,
  alive: ServerLock.alive,
  ping: ServerLock.ping,
  clear: ServerLock.clearIfOwner,
  acquire: Flock.acquire,
  spawn: DaemonProcess.spawn,
  sleep: (ms) => Bun.sleep(ms),
  resolveDaemonFile: target,
  identity: ServerLock.identity,
  placement: ServerLock.placement,
  // 全局 server 配置与 CLI 显式值按现有 network owner 合并，复用前即解析。
  resolveNetwork: async (args) => {
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { resolveNetworkOptions } = await import("@/cli/network")
    return AppRuntime.runPromise(resolveNetworkOptions(args))
  },
  // contender 可等待冷启动 winner 完成交付；超时只拒绝此次获锁请求，不驱逐持锁者。
  // acquire 超时必须显式失败，不能在未获得租约时私自拉起另一个同身份服务。

  electionTimeoutMs: SERVER_ELECTION_TIMEOUT_MS,
  // staleMs 交给已有 Flock heartbeat 维护，不能凭 HTTP 超时自行打破活租约。
  // Flock 持有期间仍按 staleMs 更新 heartbeat，长启动不等于 lease 已失效。

  electionStaleMs: SERVER_ELECTION_STALE_MS,
  // 启动轮询等待 owner 写锁，不能把尚未发布端口的进程当作可复用服务。
  // Windows 启动器不是锁 owner；轮询仍验证存活、认证、身份和 token 复读。

  pollMs: SERVER_POLL_INTERVAL_MS,
  // 与超时文案共用常量，完整启动 deadline 仍在避让早期探测的 sleep 后开始。
  waitMs: DAEMON_START_TIMEOUT_MS,
})

// 只信任带 token 的私有 stopping 状态；探测失败仍执行既有认证健康检查。
async function ownerIsStopping(lock: ServerLock.ServerLock) {
  if (!lock.controlPort) return false
  try {
    const response = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
      headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return typeof body === "object" && body !== null && "stopping" in body && body.stopping === true
  } catch {
    return false
  }
}

async function waitForOwnerExit(lock: ServerLock.ServerLock, deps: DiscoverDaemonDeps) {
  // 退出确认前既不清锁也不另起进程；超时保持失败，不返回退出中服务的 URL。
  const deadline = Date.now() + deps.waitMs
  while (Date.now() < deadline) {
    if (!deps.alive(lock.pid)) return
    await deps.sleep(deps.pollMs)
  }
  throw new Error(`opencode daemon pid=${lock.pid} is still stopping`)
}

function bypassLoopbackProxy() {
  const noProxy = NetworkProxy.noProxyString(
    [process.env.NO_PROXY, process.env.no_proxy].flatMap((value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  )
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
}

// #532：观察与发现共用身份/健康检查；只有发现调用方负责等待、选举和清理。
async function inspectDaemonOwner(
  lock: ServerLock.ServerLock | undefined,
  deps: DiscoverDaemonDeps,
  lockPath: string | undefined,
  identity: ReturnType<typeof ServerLock.identity>,
  network?: ReturnType<typeof resolveNetworkOptionsNoConfig>,
) {
  if (!lock || !deps.alive(lock.pid)) return
  const dbPath = path.normalize(lock.dbPath)
  const expectedPath = path.normalize(identity.dbPath)
  if ((process.platform === "win32" ? dbPath.toLowerCase() !== expectedPath.toLowerCase() : dbPath !== expectedPath) || lock.channel !== identity.channel)
    throw new Error("Existing opencode daemon has a different database or channel; stop it explicitly before switching")
  if (network && (!lock.externalUrl || JSON.stringify(lock.network) !== JSON.stringify(network)))
    throw new Error("Existing opencode daemon has incompatible network options; stop it explicitly before changing listeners")
  const stopping = await ownerIsStopping(lock)
  const responsive = !stopping && await deps.ping(lock.port)
  // 探测完成后仍复读同一placement，不能把换代前的PID/端口交给调用方。
  const current = await deps.read(lockPath)
  if (current?.token !== lock.token || current.pid !== lock.pid) throw new Error("Opencode daemon ownership changed during discovery")
  return { lock, stopping, responsive }
}

// #532：只公开连接字段，不把token、私有控制端口或数据库路径交给外部client。
export type ConnectionInfo = { running: false } | { running: true; pid: number; url: string; responsive: boolean }

// 纯查询报告存活但不可响应的owner，不清锁或创建第二个daemon。
export async function connectionInfo(deps: DiscoverDaemonDeps = defaultDiscoverDeps()): Promise<ConnectionInfo> {
  bypassLoopbackProxy()
  const lockPath = deps.placement()
  const owner = await inspectDaemonOwner(await deps.read(lockPath), deps, lockPath, deps.identity())
  if (!owner) return { running: false }
  return { running: true, pid: owner.lock.pid, url: `http://127.0.0.1:${owner.lock.port}`, responsive: owner.responsive }
}

// #165：共享 daemon 选举/复用；禁止重引入 per-TUI Worker+Rpc.client
// #532：外部client使用长命launcher；TUI缺省仍观察自身。
export async function discoverOrSpawnDaemon(
  networkArgs: Parameters<typeof resolveNetworkOptionsNoConfig>[0],
  deps: DiscoverDaemonDeps = defaultDiscoverDeps(),
  launcherPid?: number,
): Promise<{ url: string; fwdPid?: number; lockPath?: string }> {
  // 父进程健康探测直接调用 fetch，首次读锁前就须补回环绕过，不能仅在 spawn 后保护子进程。
  bypassLoopbackProxy()

  // 身份与网络请求先于快速路径解析，禁止复用另一数据库或忽略显式外部端口。
  const identity = deps.identity()
  const network = await deps.resolveNetwork(networkArgs)
  const external = ["--port", "--hostname", "--mdns", "--mdns-domain", "--cors"].some(hasArg) ||
    network.mdns || network.port !== 0 || network.hostname !== "127.0.0.1" || network.cors.length > 0
  // 同一 DB/channel 共用发现路径；显式网络请求只在复用检查中判断兼容性。
  const lockPath = deps.placement()
  async function reuse(lock: ServerLock.ServerLock | undefined) {
    const owner = await inspectDaemonOwner(lock, deps, lockPath, identity, external ? network : undefined)
    if (!owner) return null
    if (owner.stopping) {
      await waitForOwnerExit(owner.lock, deps)
      return null
    }
    if (!owner.responsive) throw new Error("Existing opencode daemon health or authentication check failed")
    return external && owner.lock.externalUrl ? owner.lock.externalUrl : `http://127.0.0.1:${owner.lock.port}`
  }
  // 快速检查与持锁复查都调用 reuse，身份、认证与 token 校验不分叉。
  let existingUrl = await reuse(await deps.read(lockPath))
  let fwdPid: number | undefined

  // URL 为空只能进入选举或失败出口，不能返回一个猜测的旧端口作为成功。
      
  if (!existingUrl) {
    // Flock key 与发现路径绑定，四个并发 TUI 对同一身份只能产生一个 winner。
    // 租约由此作用域获取并 finally 释放，调用方不能传入已持有的 lease。
    const electionLease = await deps.acquire(`opencode.server:${lockPath ?? "default"}`, {
      dir: path.join(Global.Path.state, "locks"),
      timeoutMs: deps.electionTimeoutMs,
      staleMs: deps.electionStaleMs,
    })
    try {
      // acquire 等待期间其他 contender 可能已完成启动，持锁后重新读取 owner。
      const lock = await deps.read(lockPath)
      existingUrl = await reuse(lock)
      // 仅清除已确认死亡的 owner；短暂不可达的存活服务不能被替换。
      if (!existingUrl && lock) await deps.clear(lock.token, lockPath)

      if (existingUrl) {
        return { url: existingUrl, lockPath }
      } else {
        const daemonFile = await deps.resolveDaemonFile()
        // 机器stdout只交付单个JSON；显式TUI日志不受此机器调用分支影响。
        const printLogs = process.argv.includes("--print-logs") && launcherPid === undefined
        // 全量快照保留 PATH、认证和 CA；归一只覆盖代理键，不另建选择性环境。
        const env = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        // 大写优先，即使为空也不回退小写，防止消费者按不同大小写选到不同代理。
        const http = env.HTTP_PROXY ?? env.http_proxy
        // 仅 HTTPS 两种写法都缺失时继承 HTTP，显式 HTTPS 配置不被覆盖。
        const https = env.HTTPS_PROXY ?? env.https_proxy ?? http
        const all = env.ALL_PROXY ?? env.all_proxy
        const no = env.NO_PROXY ?? env.no_proxy
        // 同一快照原位补齐双写法；下方唯一 spawn 仍负责覆盖 worker 身份和监听请求。
        Object.assign(env, {
          ...(http !== undefined ? { HTTP_PROXY: http, http_proxy: http } : {}),
          ...(https !== undefined ? { HTTPS_PROXY: https, https_proxy: https } : {}),
          ...(all !== undefined ? { ALL_PROXY: all, all_proxy: all } : {}),
          ...(no !== undefined ? { NO_PROXY: no, no_proxy: no } : {}),
        })
        // 快照已补齐代理键后再调整，桌面 shell 的旧代理不能冻结 daemon 的系统路由。
        applyProxyEnv(env)
        // 编译二进制必须凭 worker 环境角色旁路 yargs，不能把模块路径当成用户 project。
      const proc = await deps.spawn([process.execPath, daemonFile], {
        // #139：Unix 下 detached，避免 TUI 进程组 SIGINT 带走共享 daemon。
        // Windows 不能用 detached:true（Bun #31603：子进程被 job object 绑定，
        // parent 退出即杀）。Windows 的 daemon Ctrl+C 免疫改由 worker 进程内
        // 调用 FreeConsole 实现（见 worker.ts win32DetachConsole）：worker 脱离
        // 共享 console 后，CTRL_C_EVENT 不再送达，等价 Unix detached 进程组。
        detached: process.platform !== "win32",
          env: {
            ...env,
            OPENCODE_PROCESS_ROLE: "worker",
            // 首个订阅前由daemon判断启动方是否仍存活，不改变监听与锁路径运输。
            // 短命机器CLI退出后，首个SSE前仍由worker观察真实client。
            OPENCODE_DAEMON_LAUNCHER_PID: String(launcherPid ?? process.pid),
            ...(lockPath ? { OPENCODE_LOCK_PATH: lockPath } : {}),
            // 覆盖继承的外部监听变量，避免内部请求误启动旧的外部端口。
            OPENCODE_EXTERNAL_NETWORK: external ? JSON.stringify(network) : "",
            ...(printLogs ? { OPENCODE_PRINT_LOGS: "1" } : {}),
          },
          stdin: "ignore",
          stdout: printLogs ? "inherit" : "ignore",
          stderr: printLogs ? "inherit" : "ignore",
        })
        let exitedBeforeReady = false
        try {
          // exited 的拒绝先安装 observer；read/unref 的同步异常仍由两层 finally 清理。
          void proc.exited.catch(() => undefined)
          proc.unref()

          // 首等和轮询共用退出观察，崩溃不能一直占用选举租约直到超时。
          const exited = proc.exited.then(
            (code) => ({ kind: "code" as const, code }),
            () => ({ kind: "error" as const }),
          )
          const raceSleep = async (ms: number) => {
            const result = await Promise.race([deps.sleep(ms).then(() => ({ kind: "sleep" as const })), exited])
            if (result.kind === "sleep") return
            // Windows 启动器可退出而真实 daemon 已发布锁，交付仍经过唯一 read/reuse 的身份认证。
            if (result.kind === "code" && result.code === 0) {
              const lock = await deps.read(lockPath)
              if (lock && deps.alive(lock.pid)) existingUrl = await reuse(lock)
              if (existingUrl) { fwdPid = lock!.pid; return }
            }
            exitedBeforeReady = true
            const msg = result.kind === "code"
              ? `opencode daemon exited before startup with exit code ${result.code}. Re-run with --print-logs to show daemon startup logs.`
              : "opencode daemon exited before startup. Re-run with --print-logs to show daemon startup logs."
            UI.error(msg)
            throw new Error(msg)
          }
          // 等待放在 proc 与 lease 的 finally 内，sleep 拒绝也不能泄漏选举所有权。
          // 完整启动预算从 sleep 后开始，不能用避让早期探测的延迟吃掉健康等待时间。
          await raceSleep(1000)
          const deadline = Date.now() + deps.waitMs
          // 启动器 PID 可不同；健康锁仍必须通过 reuse 的身份与稳定 owner 校验。
          while (!existingUrl && Date.now() < deadline) {
            const daemonLock = await deps.read(lockPath)
            if (daemonLock && deps.alive(daemonLock.pid) && await deps.ping(daemonLock.port)) {
              // 交付身份、认证与 token 复读均通过的 daemon owner，启动器 PID 不代替锁身份。
              existingUrl = await reuse(daemonLock)
              // 重载信号的目标是已验证 daemon，而不是可能已经退出的启动器。
              if (existingUrl) {
                fwdPid = daemonLock.pid
                break
              }
            }
            // 轮询间隔也被退出打断，不扩大原有健康等待期限。
            await raceSleep(Math.min(deps.pollMs, Math.max(0, deadline - Date.now())))
          }

          if (!existingUrl) {
            // deadline 只结束此次交付尝试，清理随后只作用于尚未交付的 proc handle。
            // 超时仍向上失败；杀本次 proc 与释放 lease 继续由原有两层 finally 执行。
            // 超时诊断与提前退出共享日志指引，资源仍由原 finally 清理。
            UI.error(`opencode daemon failed to start within ${DAEMON_START_TIMEOUT_MS / 1000} seconds. Re-run with --print-logs to show daemon startup logs.`)
            throw new Error(`opencode daemon failed to start within ${DAEMON_START_TIMEOUT_MS / 1000} seconds. Re-run with --print-logs to show daemon startup logs.`)
          }
        } finally {
          // 只终止本次启动且尚未交付的子进程；read/sleep/ping 异常也会进入此处。
          // 已观察退出不重复终止；其他未交付异常仍保留原清理责任。
          if (!existingUrl && !exitedBeforeReady) proc.kill()
        }
      }
    } finally {
      // acquire 的同一作用域释放租约，spawn 同步抛错也不依赖返回值交接。
      await electionLease.release()
    }
  }

  if (!existingUrl) throw new Error("Opencode daemon discovery produced no ready listener")
  return { url: existingUrl, fwdPid, lockPath }
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

// #259：status 走 lock token 保护的本机私有 control port；失败时保持静默
// 因为它只用于 TUI 退出后的提示，不能影响主流程退出
export async function status(lockPath = ServerLock.placement()): Promise<Status | undefined> {
  // 独立 status 调用也可能跳过发现，回环绕过不能只依赖 TUI 启动时设置。
  const noProxy = NetworkProxy.noProxyString(
    [process.env.NO_PROXY, process.env.no_proxy].flatMap((value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  )
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
  const lock = await ServerLock.read(lockPath).catch(() => undefined)
  // #259：controlPort 与 pid 存活双重校验——旧 lock 或已死 daemon 都直接静默退出
  if (!lock?.controlPort || !ServerLock.alive(lock.pid)) return

  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
    headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
    // #259：500ms 有界——status 是退出路径上的旁路查询，不能拖慢主流程退出
    signal: AbortSignal.timeout(500),
  }).catch(() => undefined)
  if (!response?.ok) return
  return parseStatus(await response.json().catch(() => undefined))
}

function parseStatus(input: unknown): Status | undefined {
  if (!input || typeof input !== "object") return
  if (!("tuiClients" in input) || !("sessionActivity" in input)) return
  if (typeof input.tuiClients !== "number" || typeof input.sessionActivity !== "number") return
  // 只提取 worker 的两个计数，响应的其他字段不会进入退出提示。
  return { tuiClients: input.tuiClients, sessionActivity: input.sessionActivity }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const unguard = win32InstallCtrlCGuard()
    // 转发句柄属于 TUI，选举租约在 discoverOrSpawnDaemon 内部闭合。
    let fwdReload: (() => void) | undefined
    // 退出提示沿用发现路径；重连交付新 owner 后同步更新，不能退回旧的默认锁。
    let daemonLockPath: string | undefined
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      // chdir 后再发现服务，保证会话 directory 与配置解析使用同一个实际 cwd。
      let existingUrl: string
      try {
        const discovered = await discoverOrSpawnDaemon(args)
        existingUrl = discovered.url
        daemonLockPath = discovered.lockPath
        // Windows 不注册不支持的 SIGUSR2；TUI 也不能因重载信号走共享服务的退出路径。
        if (discovered.fwdPid !== undefined && process.platform !== "win32") {
          const pid = discovered.fwdPid
          fwdReload = () => {
            try {
              process.kill(pid, "SIGUSR2")
            } catch {}
          }
          process.on("SIGUSR2", fwdReload)
        }
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      // validateSession 和 TUI 必须使用同一发现 URL，避免校验一个库却连接另一个服务。
      // HTTP transport 不能沿用旧内部 RPC 的免认证假设，校验与事件流必须带同一 auth header。
      const headers = ServerLock.headers()
      try {
        await validateSession({
          url: existingUrl,
          sessionID: args.session,
          directory: cwd,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      // 更新检查沿用原 upgrade owner，只将已移除的 RPC 调用改为同进程调用。
      const updater = createUpdater(async () => {
        const { upgrade } = await import("@/cli/upgrade")
        return upgrade()
      })

      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: existingUrl,
            async onSnapshot() {
              // 不伪造已移除的 RPC snapshot 响应；本回调只返回实际生成的本进程快照。
              return [writeHeapSnapshot("tui.heapsnapshot")]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            headers,
            updater,
            // #139：SSE/API 失败时重新 discoverOrSpawn，重绑定 live URL
            reconnect: async () => {
              const discovered = await discoverOrSpawnDaemon(args)
              existingUrl = discovered.url
              daemonLockPath = discovered.lockPath
              // #139：每次 respawn 必须重绑 SIGUSR2 转发到新 daemon PID
              if (process.platform !== "win32") {
                if (fwdReload) {
                  process.off("SIGUSR2", fwdReload)
                  fwdReload = undefined
                }
                if (discovered.fwdPid !== undefined) {
                  const pid = discovered.fwdPid
                  fwdReload = () => {
                    try {
                      process.kill(pid, "SIGUSR2")
                    } catch {}
                  }
                  process.on("SIGUSR2", fwdReload)
                }
              }
              return discovered.url
            },
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
      } finally {
        // 共享 daemon 可能仍服务其他窗口，TUI finally 只卸载自己的信号监听。
        if (fwdReload) {
          process.off("SIGUSR2", fwdReload)
          fwdReload = undefined
        }
      }
    } finally {
      // 校验会话提前返回时仍卸载转发，避免 TUI 留下 daemon 信号监听。
      if (fwdReload) process.off("SIGUSR2", fwdReload)
      try {
        unguard?.()
      } catch {}
    }
    // #259：退出前提示 daemon 状态——仅当有活跃连接/会话时显示 stop 命令
    await printDaemonExitHint(daemonLockPath)
    process.exit()
  },
})

// 退出提示只查询已经连接的发现路径，不启动或重连 daemon。
export async function printDaemonExitHint(lockPath?: string) {
  const snapshot = await status(lockPath).catch(() => undefined)
  if (!snapshot || (snapshot.tuiClients === 0 && snapshot.sessionActivity === 0)) return

  UI.println(
    UI.Style.TEXT_DIM + "Daemon still running: " + UI.Style.TEXT_NORMAL,
    [count(snapshot.tuiClients, "TUI connection"), count(snapshot.sessionActivity, "active session")].join(", "),
    UI.Style.TEXT_DIM + "- stop with",
    UI.Style.TEXT_INFO_BOLD + "opencode daemon stop" + UI.Style.TEXT_NORMAL,
  )
}

function count(value: number, label: string) {
  return `${value} ${label}${value === 1 ? "" : "s"}`
}
// scratch

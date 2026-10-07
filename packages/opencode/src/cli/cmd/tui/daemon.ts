export * as Daemon from "./daemon"

import { hasCliBooleanOption, hasCliOption, resolveNetworkOptionsNoConfig, type NetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { ServerLock, type ServerLock as ServerLockInfo } from "@/cli/cmd/tui/server-lock"
import { ServerAuth } from "@/server/auth"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Log } from "@opencode-ai/core/util/log"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
import path from "path"
import { fileURLToPath } from "url"

declare global {
  const OPENCODE_WORKER_PATH: string
}

export const DAEMON_START_TIMEOUT_MS = 60_000
export const SERVER_ELECTION_TIMEOUT_MS = DAEMON_START_TIMEOUT_MS + 15_000
const SERVER_ELECTION_STALE_MS = 5_000
const SERVER_POLL_INTERVAL_MS = 200

type Args = NetworkOptions & { launcherPid?: number }
type DaemonExit = { exitCode: number } | { error: unknown }
export type Status = { tuiClients: number; sessionActivity: number }
export type ConnectionInfo =
  | { running: false }
  | { running: true; pid: number; url: string; responsive: boolean }
// adapter只暴露ensure实际依赖的四项authority，wrapper细节不能泄漏给选主和健康检查调用方。
type DaemonProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "unref" | "kill">
// Promise返回允许Windows先完成worker PID握手，Unix测试注入仍可保持同步Bun.spawn形状。
type SpawnDaemon = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => DaemonProcess | Promise<DaemonProcess>

// Exposed for tests only.  Keep the daemon spawn path injectable without
// forcing production code through a heavier process abstraction.
let spawnImpl: SpawnDaemon = spawnDaemon
export const _spawn = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => spawnImpl(cmd, opts)
export function _setSpawn(fn: SpawnDaemon | undefined) {
  spawnImpl = fn ?? spawnDaemon
}

let reloadTarget: DaemonProcess | undefined
let reloadForwarderInstalled = false

function forwardReload(proc: DaemonProcess) {
  if (process.platform === "win32") return
  reloadTarget = proc
  if (reloadForwarderInstalled) return
  reloadForwarderInstalled = true
  process.on("SIGUSR2", () => {
    try {
      reloadTarget?.kill("SIGUSR2")
    } catch {}
  })
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return fileURLToPath(dist)
  return fileURLToPath(new URL("./worker.ts", import.meta.url))
}

async function spawnDaemon(cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) {
  // 平台分支在默认adapter内部一次选择，Windows失败后绝不回退到会随parent死亡的direct Bun child。
  if (process.platform !== "win32") return Bun.spawn(cmd, opts)
  const systemRoot = process.env.SystemRoot
  // wrapper必须来自受OS管理的绝对目录，Project cwd中的同名powershell.exe不能参与可执行文件解析。
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is not an absolute path")
  if (!cmd[0] || !cmd[1]) throw new Error("Windows daemon executable and worker target are required")

  // encoded script内容固定，两个动态路径只经环境变量传入，避免路径字符改变PowerShell语法结构。
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:OPENCODE_DAEMON_TARGET
if ([string]::IsNullOrEmpty($target) -or $target.Contains([char]34)) { exit 87 }
$diag = $env:OPENCODE_DAEMON_DIAG_DIR
# 父端强制提供每次launch的独占路径；目录不可建即退出，不留半初始化取证态。
try { [System.IO.Directory]::CreateDirectory($diag) | Out-Null } catch { exit 86 }
# 有界stderr尾部落盘：两段1MiB轮转，worker无声崩溃时panic尾部是唯一原生证据；Add-Type只编译一次。
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
public sealed class TailFile : FileStream {
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
  public static void Exit(int code) {
    // 只结束已完成监督的自身，unchecked保留NTSTATUS退出码的32位位型。
    if (!TerminateProcess(GetCurrentProcess(), unchecked((uint)code))) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  private readonly string previous, marker;
  private Stream terminal = Environment.GetEnvironmentVariable("OPENCODE_PRINT_LOGS") == "1" ? Console.OpenStandardError() : Stream.Null;
  private readonly long limit;
  private bool unavailable, rotated, done;
  // FileShare.Read允许事故取证在wrapper写入时读取；文件能力直接由FileStream持有。
  public TailFile(string dir, long limit) : base(Path.Combine(dir, "stderr.b"), FileMode.Create, FileAccess.Write, FileShare.Read) {
    previous = Path.Combine(dir, "stderr.a");
    marker = Path.Combine(dir, "stderr.state.json");
    this.limit = limit;
  }
  // CopyToAsync调用WriteAsync；必须回到同一写入口，不能绕过轮转和诊断失败隔离。
  public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
    Write(buffer, offset, count);
    return Task.CompletedTask;
  }
  // CopyToAsync与主线程Finish共享实例锁；截止后迟到的块只能丢弃，不能再写已关闭文件。
  [MethodImpl(MethodImplOptions.Synchronized)]
  public override void Write(byte[] buffer, int offset, int count) {
    if (done) return;
    // 同一消费块同时服务终端与持久化，不让print-logs改变取证责任。
    try { terminal.Write(buffer, offset, count); }
    catch (Exception error) {
      terminal = Stream.Null;
      Report(error);
    }
    if (unavailable) return;
    try {
      while (count > 0) {
        if (Position == limit) {
          Flush();
          File.Copy(Name, previous, true);
          SetLength(0);
          Position = 0;
          rotated = true;
        }
        // CopyToAsync的块可能跨段边界，按剩余额度切片才保证每段严格不超1MiB。
        int take = (int)Math.Min(count, limit - Position);
        base.Write(buffer, offset, take);
        offset += take;
        count -= take;
      }
    } catch (Exception error) {
      // 持久化失败只关闭文件目标，CopyToAsync仍消费pipe，避免磁盘故障反压整个daemon。
      unavailable = true;
      Report(error);
      try { Dispose(); } catch {}
    }
  }
  public void Report(Exception error) {
    try { Console.Error.WriteLine("diagnostic unavailable launch=" + Path.GetFileName(Path.GetDirectoryName(Name)) + ": " + error.Message); } catch {}
  }
  [MethodImpl(MethodImplOptions.Synchronized)]
  public void Finish(bool tailAbandoned) {
    done = true;
    try {
      if (!unavailable) {
        Flush();
        Dispose();
      }
    } catch (Exception error) {
      unavailable = true;
      Report(error);
    }
    var t = (rotated || tailAbandoned) ? "true" : "false";
    try { File.WriteAllText(marker, "{\\\"tailTruncated\\\":" + t + ",\\\"diagnosticUnavailable\\\":" + (unavailable ? "true" : "false") + "}"); } catch (Exception error) { Report(error); }
  }
}
'@
# ProcessStartInfo.Arguments接收native command line；显式保留双引号才能让空格路径仍是一个argv。
$arguments = [char]34 + $target + [char]34
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:OPENCODE_DAEMON_EXECUTABLE
$start.Arguments = $arguments
$start.UseShellExecute = $false
# worker必须继续加入现有console：默认模式随后FreeConsole，print-logs则保留当前Ctrl+C传播合同。
$start.CreateNoWindow = $false
# pipe在Bun启动前进入进程表，FreeConsole只解除console关联，不能再留下可复用的失效stdio HANDLE。
# stdout与stderr都可能被第三方直接写入；只修一条流仍保留同类HANDLE别名入口。
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$worker = New-Object System.Diagnostics.Process
$worker.StartInfo = $start
# 文件目标必须在worker启动前取得，初始化失败时不存在需要追杀的后台worker。
$stderr = New-Object TailFile($diag, 1MB)
# Start失败保持原错误出口，不回退旧Start-Process，否则primary path会再次分叉。
if (-not $worker.Start()) { exit 87 }
$code = 86
$tailDone = $false
try {
  # 生命周期记录先于PID行发布：父进程看到PID时取证文件已可关联wrapper与worker身份。
  # TUI身份可跨重连复用，目录身份必须对应这一次worker启动，避免覆盖上一代崩溃证据。
  $life = @{ runID = $env:OPENCODE_RUN_ID; launchID = (Split-Path $diag -Leaf); wrapperPID = $PID; workerPID = $worker.Id; startedAt = [DateTime]::UtcNow.ToString('o'); stderr = @('stderr.a', 'stderr.b') }
  [System.IO.File]::WriteAllText((Join-Path $diag 'lifecycle.json'), ($life | ConvertTo-Json -Compress))
  # PID行是wrapper协议边界；任何worker stdout都必须在它发布并flush之后才能进入同一输出流。
  [Console]::Out.WriteLine($worker.Id)
  [Console]::Out.Flush()
  $stdout = if ($env:OPENCODE_PRINT_LOGS -eq '1') { [Console]::OpenStandardOutput() } else { [System.IO.Stream]::Null }
  # 两条pipe必须在WaitForExit前并发drain；任一缓冲区写满都会反向阻塞worker退出。
  $stdoutTask = $worker.StandardOutput.BaseStream.CopyToAsync($stdout)
  $stderrTask = $worker.StandardError.BaseStream.CopyToAsync($stderr)
  $worker.WaitForExit()
  $code = $worker.ExitCode
  # 取证写失败必须可见，但不能覆盖worker的真实退出码或跳过pipe收尾。
  $life.exitedAt = [DateTime]::UtcNow.ToString('o')
  $life.workerExitCode = $code
  $life.workerExitHex = $code.ToString('X8')
  try { [System.IO.File]::WriteAllText((Join-Path $diag 'lifecycle.json'), ($life | ConvertTo-Json -Compress)) } catch { $stderr.Report($_.Exception) }
  # 两条流共用退出后的一秒窗口，不能先无界等待stdout再开始stderr倒计时。
  $tailDone = [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), 1000)
} catch {
  # Start已成功后的初始化失败也拥有worker回收责任；只关闭wrapper会留下无lock孤儿。
  $stderr.Report($_.Exception)
  if (-not $worker.HasExited) { $worker.Kill() }
  $worker.WaitForExit()
}
$stderr.Finish(-not $tailDone)
# worker已退出且取证已收尾，由OS关闭残留pipe，避免CLR退出继续等待后代持有者。
[TailFile]::Exit($code)
`
  // absolute system wrapper避免Project cwd选择同名程序；encoded source保持动态路径只作为data进入脚本。
  const wrapper = Bun.spawn(
    [
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      ...opts,
      env: {
        // 继承调用方隔离环境后只追加wrapper协议字段，worker看到的配置与原direct spawn保持一致。
        ...opts?.env,
        [OPENCODE_RUN_ID]: opts?.env?.[OPENCODE_RUN_ID] ?? ensureRunID(),
        OPENCODE_DAEMON_EXECUTABLE: cmd[0],
        OPENCODE_DAEMON_TARGET: cmd[1],
        // 每次spawn独占一个目录；调用方只能选择父目录，重连不会混入上一代exit或stderr。
        OPENCODE_DAEMON_DIAG_DIR: path.join(
          opts?.env?.OPENCODE_DAEMON_DIAG_DIR ?? path.join(Global.Path.log, "daemon-native"),
          crypto.randomUUID(),
        ),
      },
      stdout: "pipe",
      // 长命wrapper只持有专用pipe，不能阻止短命CLI上游stderr取得EOF。
      stderr: "pipe",
      detached: false,
      // wrapper 在 ...opts 之后强制 hide：防止 conhost/PowerShell 闪窗，且调用方 opts 不能改回可见。
      windowsHide: true,
    },
  )
  const stdout = wrapper.stdout
  const stderr = wrapper.stderr
  if (!stdout || typeof stdout === "number" || !stderr || typeof stderr === "number")
    throw new Error("Windows daemon wrapper has no output pipes")
  const reader = stdout.getReader()
  const errorReader = stderr.getReader()
  // 握手前开始消费supervisor错误；原Promise仍交给终态，不把读取失败改写成成功。
  const errors = drainWrapperOutput(errorReader, "", process.stderr)
  void errors.catch(() => {})
  const timeout = Promise.withResolvers<never>()
  // timer必须在PID握手完成时清除；普通Promise.race不会取消sleep，残留回调会在60秒后误杀健康wrapper。
  const timer = setTimeout(() => {
    try {
      wrapper.kill()
    } catch {}
    timeout.reject(new Error("Windows daemon wrapper did not publish the worker PID"))
  }, DAEMON_START_TIMEOUT_MS)
  const worker = await Promise.race([readWorkerPID(reader), timeout.promise]).finally(() => clearTimeout(timer))
  // PID首行之后继续消费同一pipe；否则daemon日志填满pipe会阻塞worker，--print-logs也会静默丢失stdout。
  const output = Promise.all([
    drainWrapperOutput(reader, worker.remainder, opts?.stdout === "inherit" ? process.stdout : undefined),
    errors,
  ])
  void output.catch(() => {})
  // lock发布前wrapper的exit/PID仍代表同一worker；timeout kill不能只结束wrapper后留下无锁后台进程。
  return {
    pid: worker.pid,
    exited: wrapper.exited.then(async (code) => {
      // wrapper已死后继续排空现有数据；后代持有句柄不能永久阻止reader释放。
      const stopped = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        Promise.all([
          stdout.locked ? reader.cancel() : undefined,
          stderr.locked ? errorReader.cancel() : undefined,
        ]).then(() => stopped.resolve(), stopped.reject)
        Log.create({ service: "daemon" }).warn("wrapper output tail cutoff", { wrapperPID: wrapper.pid })
      }, 1000)
      try {
        await Promise.race([output, stopped.promise])
        await output
        return code
      } finally {
        clearTimeout(timer)
      }
    }),
    unref: () => wrapper.unref(),
    kill: (signal?: Parameters<DaemonProcess["kill"]>[0]) => {
      // 先终止真实worker再关闭supervisor，避免wrapper消失后留下无lock生命周期观察者的孤儿worker。
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
  // 首个换行是wrapper协议边界；同一chunk中后续worker日志必须作为remainder交给drain而不能丢弃。
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
    reader.releaseLock()
    throw error
  }
}

async function drainWrapperOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainder: string,
  forward: NodeJS.WritableStream | undefined,
) {
  // 默认模式也必须消费数据防止pipe背压；forward仅控制用户可见性，不改变worker是否能继续运行。
  try {
    if (remainder) forward?.write(remainder)
    while (true) {
      const next = await reader.read()
      if (next.done) return
      forward?.write(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

function applyProxyEnv(env: Record<string, string>) {
  // Merge loopback addresses into NO_PROXY so the daemon never proxies its own
  // server.  This must run for every respawn because reconnect can create a new
  // worker long after the original launcher setup finished.
  const parts = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const no = NetworkProxy.noProxyString(parts)
  env.NO_PROXY = no
  env.no_proxy = no

  if (process.platform === "win32" || process.platform === "darwin") {
    // The daemon installs a global fetch wrapper that resolves system proxy
    // dynamically per request. Strip inherited shell proxy env so Bun doesn't
    // freeze routing to stale variables captured before the proxy app started.
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
      delete env[key]
    return
  }

  // Linux: normalize proxy env — ensure both casings, HTTPS falls back to HTTP.
  const http = env.HTTP_PROXY ?? env.http_proxy
  const https = env.HTTPS_PROXY ?? env.https_proxy ?? http
  const all = env.ALL_PROXY ?? env.all_proxy
  if (http) {
    env.HTTP_PROXY = http
    env.http_proxy = http
  }
  if (https) {
    env.HTTPS_PROXY = https
    env.https_proxy = https
  }
  if (all) {
    env.ALL_PROXY = all
    env.all_proxy = all
  }
}

function internalUrl(port: number) {
  return `http://127.0.0.1:${port}`
}

function lockUrl(lock: ServerLock, external: boolean) {
  if (external && lock.externalUrl) return lock.externalUrl
  return internalUrl(lock.port)
}

// Determine the URL of an existing daemon owner.
// Returns:
//   - { type: "missing" }        → no lock file exists
//   - { type: "dead", lock }     → pid is dead, lock is stale
//   - { type: "responsive" | "unresponsive", url, lock }
//                                → pid is alive; responsive=HTTP ping OK
//   - { type: "stopping", lock } → owner has entered graceful shutdown
//
// CRITICAL: "unresponsive" means the owner process is alive but its control
// plane is temporarily blocked (e.g. during a long model call).  We must NOT
// spawn a second daemon in this state — the single-owner invariant would break.
//
// NOTE: Calls ServerLock.read/alive/ping through the namespace so test spies
// on those exports can intercept the calls.
async function existingOwnerUrl(external: boolean) {
  const lock = await ServerLock.read()

  if (!lock) return { type: "missing" as const }

  if (!ServerLock.alive(lock.pid)) return { type: "dead" as const, lock }

  // stopping owner 仍可能通过 health；必须先看私有状态，不能把它当普通 unresponsive owner 复用。
  // 这样可以把正在释放资源的 owner 与长时间模型调用中的 owner 区分开。
  // 前者需要等待，后者仍然遵守原有的单 owner 复用规则。
  if (await ownerIsStopping(lock)) return { type: "stopping" as const, lock }

  // pid alive — whether or not HTTP ping succeeded, the owner still exists.
  const responsive = await ServerLock.ping(lock.port, { headers: ServerAuth.headers() })
  return {
    type: responsive ? ("responsive" as const) : ("unresponsive" as const),
    url: lockUrl(lock, external),
    lock,
  }
}

async function ownerIsStopping(lock: ServerLockInfo) {
  if (!lock.controlPort) return false
  // control status is the only owner-local signal that distinguishes shutdown from a long call.
  // 该请求必须带 lock token，避免普通 public health 请求伪造 stopping 状态。
  // 请求失败时保守地返回 false，保留既有 unresponsive owner 的复用语义。
  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
    headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
    signal: AbortSignal.timeout(500),
  }).catch(() => undefined)
  if (!response?.ok) return false
  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object" || !("stopping" in body)) return false
  return body.stopping === true
}

async function waitForOwnerExit(pid: number) {
  // 等待期间不另起 daemon，保持 SQLite 单 owner；退出后再回到既有选主路径。
  // worker 自己有 teardown deadline，因此这里不会无限期等待 disposer。
  // 超时仍然报错，而不是悄悄启动第二个进程覆盖原 owner。
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!ServerLock.alive(pid)) return
    await Bun.sleep(SERVER_POLL_INTERVAL_MS)
  }
  throw new Error(`opencode daemon pid=${pid} is still stopping`)
}

function wantsExternal(args: Args) {
  const network = resolveNetworkOptionsNoConfig(args)
  return {
    network,
    external:
      hasCliOption("--port") ||
      hasCliOption("--hostname") ||
      hasCliBooleanOption("--mdns") ||
      network.mdns ||
      network.port !== 0 ||
      network.hostname !== "127.0.0.1",
  }
}

export async function ensure(args: Args) {
  const { network, external } = wantsExternal(args)
  const env = sanitizedProcessEnv({
    [OPENCODE_PROCESS_ROLE]: "worker",
    [OPENCODE_RUN_ID]: ensureRunID(),
  })
  applyProxyEnv(env)
  // Preserve the original TUI launcher behavior: the UI process itself must
  // also bypass proxies for loopback SDK calls, even when an existing daemon is
  // reused and no child process is spawned.
  process.env.NO_PROXY = env.NO_PROXY
  process.env.no_proxy = env.no_proxy

  // Fast path: if an owner is alive (responsive OR unresponsive), reuse it.
  const quick = await existingOwnerUrl(external)
  if (quick.type === "responsive" || quick.type === "unresponsive") return quick.url
  if (quick.type === "stopping") await waitForOwnerExit(quick.lock.pid)

  let electionLease: Awaited<ReturnType<typeof Flock.acquire>> | undefined
  try {
    // A shared election lock is required both on initial TUI startup and during
    // later reconnect recovery; otherwise two surviving TUIs can race and spawn
    // duplicate daemon workers after the original process dies.
    electionLease = await Flock.acquire("opencode.server", {
      dir: path.join(Global.Path.state, "locks"),
      timeoutMs: SERVER_ELECTION_TIMEOUT_MS,
      staleMs: SERVER_ELECTION_STALE_MS,
    })

    // Re-check under lock: another TUI may have started a daemon while we waited.
    const existing = await existingOwnerUrl(external)
    if (existing.type === "responsive" || existing.type === "unresponsive") return existing.url
    if (existing.type === "stopping") {
      // owner 已经承诺退出；等待结束后只清理它自己的 token。
      await waitForOwnerExit(existing.lock.pid)
      await ServerLock.clearIfOwner(existing.lock.token)
    }

    // Only clear the lock if the owner is truly dead.
    if (existing.type === "dead") await ServerLock.clear()

    const printLogs = process.argv.includes("--print-logs")
    const proc = await spawnImpl([process.execPath, await target()], {
      env: {
        ...env,
        ...(printLogs ? { OPENCODE_PRINT_LOGS: "1" } : {}),
        // 外部client会先退出短命CLI再建立SSE；首连前必须观察真实client PID，TUI缺省仍观察自身。
        OPENCODE_DAEMON_LAUNCHER_PID: String(args.launcherPid ?? process.pid),
        ...(external
          ? {
              OPENCODE_EXTERNAL_PORT: String(network.port),
              OPENCODE_EXTERNAL_HOSTNAME: network.hostname,
              OPENCODE_EXTERNAL_MDNS: network.mdns ? "1" : "",
            }
          : {}),
      },
      stdin: "ignore",
      stdout: printLogs ? "inherit" : "ignore",
      stderr: printLogs ? "inherit" : "ignore",
      // Unix Ctrl+C is delivered to the foreground process group. Detaching the
      // worker gives it its own group so TUI exits do not accidentally take down
      // the shared daemon.
      // Windows 不能用 detached:true（Bun #31603）；spawnDaemon以system PowerShell
      // 托管worker生命周期，worker仍通过FreeConsole隔离共享console的CTRL_C_EVENT。
      detached: process.platform !== "win32",
    })
    proc.unref()
    forwardReload(proc)
    const exited = proc.exited.then(
      (exitCode): DaemonExit => ({ exitCode }),
      (error): DaemonExit => ({ error }),
    )

    // The daemon cannot be ready immediately: worker startup has to load the
    // server, bind a port, and write the lock atomically before health can pass.
    const initialExit = await Promise.race([exited, Bun.sleep(1000).then(() => undefined)])
    if (initialExit) throw new Error(daemonExitMessage(initialExit))

    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const lock = await ServerLock.read()
      if (lock && ServerLock.alive(lock.pid)) {
        if (external) {
          if (lock.externalUrl) return lock.externalUrl
        } else if (await ServerLock.ping(lock.port, { headers: ServerAuth.headers() })) {
          return internalUrl(lock.port)
        }
      }
      const exit = await Promise.race([
        exited,
        Bun.sleep(Math.min(SERVER_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))).then(() => undefined),
      ])
      if (exit) throw new Error(daemonExitMessage(exit))
    }

    proc.kill()
    throw new Error(
      `opencode daemon failed to start within ${DAEMON_START_TIMEOUT_MS / 1000} seconds. Re-run with --print-logs to show daemon startup logs.`,
    )
  } finally {
    await electionLease?.release().catch(() => undefined)
  }
}

export async function connectionInfo(): Promise<ConnectionInfo> {
  // connection query复用existingOwnerUrl分类，不能再实现一套alive/ping判断。
  // dead lock只表现为running=false；纯查询不清理状态或触发election副作用。
  // stopping owner仍占有single-owner位置，因此报告running但不可响应。
  // internal URL由OpenCode生成，bot不获得lock文件位置或认证控制面信息。
  const owner = await existingOwnerUrl(false)
  // 查询不能调用ensure或清理lock；missing/dead都表示当前没有可复用的存活owner。
  if (owner.type === "missing" || owner.type === "dead") return { running: false }
  if (owner.type === "stopping") {
    // stopping仍是当前唯一owner；报告存活但不可用，调用方不能据此启动第二个daemon。
    return { running: true, pid: owner.lock.pid, url: lockUrl(owner.lock, false), responsive: false }
  }
  // machine contract只暴露连接和身份复用所需字段，lock token/control/db永远留在OpenCode内部。
  return {
    running: true,
    pid: owner.lock.pid,
    url: owner.url,
    responsive: owner.type === "responsive",
  }
}

export async function status(): Promise<Status | undefined> {
  const lock = await ServerLock.read()
  if (!lock?.controlPort || !ServerLock.alive(lock.pid)) return

  // status 走 lock token 保护的本机私有 control port；失败时保持静默，
  // 因为它只用于 TUI 退出后的提示，不能影响主流程退出。
  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${ServerLock.CONTROL_STATUS_PATH}`, {
    headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
    signal: AbortSignal.timeout(500),
  }).catch(() => undefined)
  if (!response?.ok) return
  return parseStatus(await response.json().catch(() => undefined))
}

function parseStatus(input: unknown): Status | undefined {
  if (!input || typeof input !== "object") return
  if (!("tuiClients" in input) || !("sessionActivity" in input)) return
  if (typeof input.tuiClients !== "number" || typeof input.sessionActivity !== "number") return
  return { tuiClients: input.tuiClients, sessionActivity: input.sessionActivity }
}

function daemonExitMessage(exit: DaemonExit) {
  if ("exitCode" in exit)
    return `opencode daemon exited before startup with exit code ${exit.exitCode}. Re-run with --print-logs to show daemon startup logs.`
  return `opencode daemon exited before startup. Re-run with --print-logs to show daemon startup logs.`
}

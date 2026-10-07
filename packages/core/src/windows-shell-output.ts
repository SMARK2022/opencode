import type { StandardCommand } from "effect/unstable/process/ChildProcess"
import { spawn } from "node:child_process"
import { closeSync, constants, openSync } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { sanitizedProcessEnv } from "./util/opencode-process"

// ---------- Win32 常量 ----------

// 命名管道服务端：句柄只读、字节模式、允许异步 I/O。
const PIPE_ACCESS_INBOUND = 0x00000001
const PIPE_TYPE_BYTE = 0
const FILE_FLAG_OVERLAPPED = 0x40000000

// 读取生命周期涉及的 GetLastError 值。
const ERROR_BROKEN_PIPE = 109 // 全部写端关闭：正常 EOF
const ERROR_OPERATION_ABORTED = 995 // 本次 CancelIoEx 生效
const ERROR_NOT_FOUND = 1168 // 取消时操作已抢先完成

// 映射为 Node 风格错误码的 Win32 值。
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5

// Win64（x64/ARM64）的 OVERLAPPED 固定 32 字节，hEvent 位于偏移 24。
const OVERLAPPED_SIZE = 32
const OVERLAPPED_EVENT_OFFSET = 24
const READ_BUFFER_SIZE = 65536
const STATUS_PENDING = 259 // NTSTATUS：I/O 已受理但尚未完成
const WAIT_TIMEOUT = 258 // WaitForSingleObject 在零等待下未观察到事件发布的返回值

// cbJobObjectInfoLength 必须等于本机结构大小：Win11 x64 实测仅 144 被接受（FFI 探针验证）。
// LimitFlags 位于偏移 16；KILL_ON_JOB_CLOSE 让宿主被强退时由 OS 回收本次调用的全部后代，
// 正常完成前必须清除，否则会误杀 Start-Process 后台任务。
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JobObjectExtendedLimitInformation = 9
const JOB_EXTENDED_LIMIT_BYTES = 144
const LIMIT_FLAGS_OFFSET = 16

// 轮询只调度观察；完成事件发布之后才读取该操作的状态和字节数。
const POLL_INTERVAL_MS = 1

// 单帧原始字节上限与本地 capture 读缓冲一致；base64 编码后最大 87,384 字符。
const FRAME_BYTES = 65536
let sharedKernel: ReturnType<typeof loadKernel> | undefined
async function loadKernel() {
  const { dlopen, ptr } = await import("bun:ffi")
  // 原生返回NTSTATUS，避免JS运行时活动覆盖两次FFI调用之间的GetLastError。
  const nt = dlopen("ntdll.dll", {
    NtReadFile: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr", "ptr"], returns: "u32" },
    RtlNtStatusToDosError: { args: ["u32"], returns: "u32" },
  })
  const library = dlopen("kernel32.dll", {
    CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "ptr" },
    CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "ptr" },
    CancelIoEx: { args: ["ptr", "ptr"], returns: "i32" },
    PeekNamedPipe: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
    ResetEvent: { args: ["ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    AssignProcessToJobObject: { args: ["ptr", "i64"], returns: "i32" },
  })
  return {
    libraries: [library, nt], // 仅持有两个DLL句柄至宿主退出；调用方只消费合并后的symbols
    symbols: { ...library.symbols, ...nt.symbols },
    ptr,
    error: (method: string, value = library.symbols.GetLastError()) =>
      Object.assign(new Error(`${method}: win32=${value}`), { code: toErrno(value), errno: value, syscall: method }),
  }
}

// FFI 可调用对象与其库的寿命必须覆盖全部使用：每次调用 dlopen/close 的高密度序列
// 可使 Bun 1.3.14 在 Windows 段错误（生产 spawner 实跑复现 exit 3）。绑定懒创建一次后
// 随执行宿主进程退出统一释放；每次调用只拥有管道、事件与 fd 这些调用级资源。
function kernel32() {
  return (sharedKernel ??= loadKernel())
}

const toErrno = (value: number) => {
  if (value === ERROR_ACCESS_DENIED) return "EACCES"
  return value === ERROR_FILE_NOT_FOUND || value === ERROR_PATH_NOT_FOUND ? "ENOENT" : "EIO"
}

// ---------- 命令标记 ----------

const markedCommands = new WeakSet<StandardCommand>()

// 只有 ShellTool 能选择前台调用寿命；共享 spawner 的其他消费者继续等待真正 EOF。
// 标记附着于本次 command 对象，不进入 env 或脚本，也不会被后台子进程继承。
export function mark(command: StandardCommand) {
  markedCommands.add(command)
  return command
}

export const has = (command: StandardCommand) => markedCommands.has(command)

// open：前台进程存活，正常读取；draining：前台已退出，只排空已产生的字节；
// closing：取消并释放全部资源。close 可从任意阶段进入 closing。
type Phase = "open" | "draining" | "closing"

export async function make() {
  const kernel = await kernel32()
  const k = kernel.symbols
  const ptr = kernel.ptr
  const win32Error = kernel.error
  // 创建中途由 using 清理；全部 pipe 成功后才把资源转交 spawn scope。
  using partialCleanup = new DisposableStack()
  const ownHandle = (value: ReturnType<typeof k.CreateEventW>, method: string) => {
    // 两个创建 API 失败时返回 NULL；同时防御 FFI 以 -1 形式返回无效句柄的变体。
    if (!value || value === -1) throw win32Error(method)
    partialCleanup.defer(() => {
      if (!k.CloseHandle(value)) throw win32Error("CloseHandle")
    })
    return value
  }

  const writerFds = new DisposableStack()
  // 创建中途失败时也关闭已打开的 fd；spawn 成功后父进程写端可提前释放。
  partialCleanup.defer(() => writerFds.dispose())

  const createPipe = (index: number) => {
    // 每次调用、每个流有独立名字，避免并发 scope 连接到彼此的写端。
    const name = `\\\\.\\pipe\\opencode-shell-${process.pid}-${crypto.randomUUID()}-${index}`
    const encoded = Buffer.from(name + "\0", "utf16le")
    const handle = ownHandle(
      k.CreateNamedPipeW(
        ptr(encoded),
        PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE,
        1,
        READ_BUFFER_SIZE,
        READ_BUFFER_SIZE,
        0,
        null,
      ),
      "CreateNamedPipeW",
    )
    // manual-reset 事件每次只服务一个 read，前一操作结算后才能 ResetEvent。
    const event = ownHandle(k.CreateEventW(null, 1, 0, null), "CreateEventW")
    // 由同一 JS 运行时打开 fd，避免把 Win32 HANDLE 误当作 cross-spawn 接受的 descriptor。
    // 不带 O_CREAT：这里只连接已创建的内存 pipe，不创建磁盘日志。
    const fd = openSync(name, constants.O_WRONLY)
    writerFds.defer(() => closeSync(fd))
    const overlapped = Buffer.alloc(OVERLAPPED_SIZE)
    return {
      handle,
      event,
      fd,
      buffer: Buffer.alloc(READ_BUFFER_SIZE),
      overlapped,
      // Win64 IO_STATUS_BLOCK的状态在0、字节数在8；视图在提交内核前固定同一存储。
      result: new Uint32Array(overlapped.buffer, overlapped.byteOffset, OVERLAPPED_SIZE / 4),
      // 最近一次 read 的 Promise，保留到被下一次读取替换；finish/close 据此等待终态。
      pendingRead: undefined as Promise<Buffer | undefined> | undefined,
      // 内核侧仍在执行的异步读；CancelIoEx 只对它有意义。
      kernelPending: false,
      eof: false,
      // finish 冻结的可再读字节数；只减不增。
      remaining: 0,
    }
  }
  type Pipe = ReturnType<typeof createPipe>
  const pipes = [createPipe(0), createPipe(1)]

  let phase: Phase = "open"
  // 经函数读取以避开 TS 对捕获变量的控制流窄化；close/finish 可能在该函数外推进阶段。
  const currentPhase = (): Phase => phase
  let finishError: Error | undefined
  let referenced = true
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const quotaReady = Promise.withResolvers<void>()
  let finishPromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined

  const pause = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        resolve()
      }, POLL_INTERVAL_MS)
      timers.add(timer)
      if (!referenced) timer.unref()
    })

  const read = (pipe: Pipe, length: number) => {
    const operation = (async () => {
      // 每个流最多一个在途读取；OVERLAPPED/event/buffer 保持存活直到该操作结算。
      pipe.overlapped.fill(0)
      pipe.overlapped.writeBigUInt64LE(BigInt(pipe.event), OVERLAPPED_EVENT_OFFSET)
      if (!k.ResetEvent(pipe.event)) throw win32Error("ResetEvent")
      let status = k.NtReadFile(
        pipe.handle,
        pipe.event,
        null,
        null,
        ptr(pipe.overlapped),
        ptr(pipe.buffer),
        length,
        null,
        null,
      )
      if (status === STATUS_PENDING) {
        // STATUS_PENDING必须来自本次发起结果，不能由旧状态或零字节猜测。
        pipe.kernelPending = true
        do {
          await pause()
          const wait = k.WaitForSingleObject(pipe.event, 0)
          if (wait !== 0 && wait !== WAIT_TIMEOUT) throw win32Error("WaitForSingleObject")
          status = wait === WAIT_TIMEOUT ? STATUS_PENDING : pipe.result[0] // 事件未发布期间不得读取状态块
        } while (status === STATUS_PENDING)
        pipe.kernelPending = false
      }
      status = k.RtlNtStatusToDosError(status)
      // ERROR_OPERATION_ABORTED 只接受本 owner 已发起的停止。
      if (status === ERROR_OPERATION_ABORTED && phase !== "open") return
      if (status === ERROR_BROKEN_PIPE) {
        pipe.eof = true
        return
      }
      if (status !== 0) throw win32Error("NtReadFile", status)
      // 消费者可能背压或迟订阅，必须在 buffer 复用前复制已完成的字节。
      return Buffer.from(pipe.buffer.subarray(0, pipe.result[2]))
    })()
    // root 通知等待这次复制完成，再观察内核额度，避免漏掉刚离开内核的字节。
    pipe.pendingRead = operation
    return operation
  }

  const cancelPendingReads = () => {
    let first: Error | undefined
    for (const pipe of pipes) {
      if (!pipe.kernelPending || k.CancelIoEx(pipe.handle, ptr(pipe.overlapped))) continue
      const status = k.GetLastError()
      // ERROR_NOT_FOUND 表示完成抢先于取消；结果仍须通过原操作结算。
      if (status !== ERROR_NOT_FOUND) first ??= win32Error("CancelIoEx", status)
    }
    return first
  }
  const pendingReads = () => pipes.flatMap((pipe) => (pipe.pendingRead ? [pipe.pendingRead] : []))

  // 双流各自读取，避免一端的背压阻塞另一端；传输保持原始字节及非 TTY 语义。
  const streams = pipes.map((pipe) =>
    Readable.from(
      (async function* () {
        while (phase !== "closing" && !pipe.eof) {
          if (phase === "draining") {
            await quotaReady.promise
            if (finishError) throw finishError
            // 等待期间 close 可能已推进阶段，必须重新读取。
            // 本地额度为空即可结束；已经进入 tap 的字节仍由原 Tool 消费后才返回。
            if (currentPhase() === "closing" || pipe.remaining === 0) break
            const data = await read(pipe, Math.min(pipe.remaining, pipe.buffer.length))
            if (!data?.length) throw new Error("Owned output drain ended before its recorded byte count")
            pipe.remaining -= data.length
            yield data
            continue
          }
          // Readable 的背压只暂停新读，不阻止独立的 root exit 通知和额度冻结。
          const data = await read(pipe, pipe.buffer.length)
          if (data?.length) yield data
        }
      })(),
      // Readable.from 默认按对象数缓存；此处保持原 stdio 的按字节背压。
      { objectMode: false },
    ),
  )

  const finish = () =>
    (finishPromise ??= (async () => {
      // 单一 JS owner 先推进阶段，再取消在途 I/O；之后不再提交一般读取。
      if (phase === "open") phase = "draining"
      const cancelError = cancelPendingReads()
      await Promise.all(pendingReads())
      if (cancelError) throw cancelError
      if (phase === "closing") return
      // 先结算在途 read 再同时冻结两个额度；内核为空不代表在途 buffer 也为空。
      // 后续排空不重新 peek，所以后台未来写入不会再次延长本次调用。
      for (const pipe of pipes) {
        if (pipe.eof) continue
        const available = new Uint32Array(1)
        if (!k.PeekNamedPipe(pipe.handle, null, 0, null, ptr(available), null)) {
          const status = k.GetLastError()
          if (status !== ERROR_BROKEN_PIPE) throw win32Error("PeekNamedPipe", status)
        }
        pipe.remaining = available[0]
      }
    })()
      .catch((cause: unknown) => {
        finishError = cause instanceof Error ? cause : new Error(String(cause))
        throw finishError
      })
      .finally(() => quotaReady.resolve()))

  const resources = partialCleanup.move()
  const close = () =>
    (closePromise ??= (async () => {
      // 先禁止新读，确保等待集合不会在释放 native 资源期间继续增长。
      phase = "closing"
      // finalizer 可能来自创建失败、取消或正常返回；释放不能依赖 reader 仍有消费者。
      const cancelError = cancelPendingReads()
      // 这里只等待资源终态；读取失败已经沿 Readable 错误链交付，不转成正常结果。
      await Promise.allSettled(pendingReads())
      quotaReady.resolve()
      if (finishPromise) await Promise.allSettled([finishPromise])
      for (const stream of streams) stream.destroy()
      // pending 操作已终态后才能释放 OVERLAPPED 所指向的句柄与事件。
      resources.dispose()
      if (cancelError) throw cancelError
    })())

  return {
    descriptors: pipes.map((pipe) => pipe.fd),
    streams,
    releaseWriters: () => writerFds.dispose(),
    finish,
    close,
    ref(value: boolean) {
      referenced = value
      // 保持 ChildProcessHandle.unref 的进程存活合同，包含尚未创建的后续轮询。
      for (const timer of timers) value ? timer.ref() : timer.unref()
    },
  }
}

// 已标记命令的捕获在独立进程中执行，原生故障域被限制在单次 Tool 调用；
// 宿主角色内在自身创建本地capture，始终使用同一个原生捕获算法。
export const HOST_ROLE = "shell-capture"
export const isHost = () => process.env.OPENCODE_PROCESS_ROLE === HOST_ROLE

// ready/run/started先于输出；chunk/end与root-exit可交错，最后是completed/accepted屏障。
// started 必须先于任何 chunk：父端凭 rootPID 建立命令身份，晚到的身份无法归因已有输出。
// completed 是唯一的成功终态；root-exit 只上报根进程退出码，不证明输出已交付。
type StreamName = "stdout" | "stderr"

const WireCommand = Schema.Struct({
  file: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  killSignal: Schema.optional(Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT"])),
  forceKillAfter: Schema.optional(Schema.Number),
})
type WireCommand = typeof WireCommand.Type
// 同一schema同时定义线缆类型与入口校验，避免手写第二份形状及未经验证的env类型断言。
const parseWireCommand = Schema.decodeUnknownSync(WireCommand)

type HostMessage =
  | { v: 1; type: "ready"; executionID: string; hostPID: number }
  | { v: 1; type: "started"; executionID: string; rootPID: number }
  | { v: 1; type: "chunk"; executionID: string; stream: StreamName; seq: number; base64: string }
  | { v: 1; type: "end"; executionID: string; stream: StreamName }
  | { v: 1; type: "root-exit"; executionID: string; code: number | null; signal: string | null }
  | { v: 1; type: "completed"; executionID: string }
  | { v: 1; type: "failed"; executionID: string; stage: string; message: string }

// 外部 signal 名称只在协议边界被承认；未知值降级为 null，不会注入不存在的语义。
const SIGNALS = ["SIGTERM", "SIGKILL", "SIGINT"] as const
const toSignal = (value: unknown) => SIGNALS.find((signal) => signal === value) ?? null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// 协议消息只在 IPC 边界校验一次；之后的消费不再重复防御。
function isHostMessage(raw: unknown, executionID: string): raw is HostMessage {
  if (!isRecord(raw) || raw.v !== 1 || raw.executionID !== executionID) return false
  switch (raw.type) {
    case "ready":
      return typeof raw.hostPID === "number"
    case "started":
      return typeof raw.rootPID === "number"
    case "chunk":
      return (
        (raw.stream === "stdout" || raw.stream === "stderr") &&
        Number.isSafeInteger(raw.seq) &&
        typeof raw.base64 === "string" &&
        raw.base64.length <= Math.ceil(FRAME_BYTES / 3) * 4
      )
    case "end":
      return raw.stream === "stdout" || raw.stream === "stderr"
    case "root-exit":
      return (
        (typeof raw.code === "number" || raw.code === null) && (typeof raw.signal === "string" || raw.signal === null)
      )
    case "completed":
      return true
    case "failed":
      return typeof raw.stage === "string" && typeof raw.message === "string"
  }
  return false
}

export type RemoteSession = {
  proc: ReturnType<typeof spawn>
  signal: Deferred.Deferred<readonly [number | null, NodeJS.Signals | null], Error>
  // started 消息兑现真实命令 PID；宿主启动失败沿该 Promise 成为本次 Tool 的启动错误。
  ready: Promise<number>
  capture: { streams: Readable[] }
  // close完成表示host已退出；内部cancel/升级负责回收本次进程树。
  close(): Promise<void>
}

// Readable本身就是字节队列：push=false时字节已接收，只扣住下一帧额度。
// _read恢复额度而非重推同一字节，避免重复缓冲、重复输出与到达即授权的无界增长。
function remoteReadable(grant: (seq: number) => void) {
  let pending: number | undefined
  const credit = () => {
    if (pending === undefined) return
    const seq = pending
    pending = undefined
    grant(seq)
  }
  const readable = new Readable({ highWaterMark: FRAME_BYTES, read: credit })
  // 启动失败时尚无消费者；错误仍存于Readable并交付之后的订阅者，而不抛进共享事件循环。
  readable.on("error", () => {})
  return {
    readable,
    push(seq: number, data: Buffer) {
      if (readable.destroyed) return
      pending = seq
      if (readable.push(data)) credit()
    },
  }
}

export function openRemote(command: StandardCommand, opts: { cwd?: string; env?: NodeJS.ProcessEnv }): RemoteSession {
  const executionID = crypto.randomUUID()
  const options = command.options
  // 标记域的合同构造点只使用毫秒数字与 SIGTERM/SIGKILL；stdin 只支持 ignore。
  // 其它形态不在支持域内，显式报错而不是在跨进程边界静默改变语义。
  if (options.forceKillAfter !== undefined && typeof options.forceKillAfter !== "number")
    throw new Error("marked shell commands require a numeric forceKillAfter")
  if (options.stdin !== undefined && options.stdin !== "ignore")
    throw new Error("marked shell commands require stdin to be ignored")
  if (options.shell !== undefined) throw new Error("marked shell commands do not use a shell wrapper")
  if (options.additionalFds !== undefined)
    throw new Error("marked shell commands do not carry additional file descriptors")
  const commandEnv = opts.env
    ? Object.fromEntries(Object.entries(opts.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    : undefined
  const killSignal = toSignal(options.killSignal)
  const wire: WireCommand = {
    file: command.command,
    args: [...command.args],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(commandEnv ? { env: commandEnv } : {}),
    ...(killSignal ? { killSignal } : {}),
    ...(typeof options.forceKillAfter === "number" ? { forceKillAfter: options.forceKillAfter } : {}),
  }
  const env = sanitizedProcessEnv({
    OPENCODE_PROCESS_ROLE: HOST_ROLE,
    OPENCODE_SHELL_EXEC: executionID,
  })
  // 执行宿主不得继承 daemon/TUI 的协议身份字段，避免其工具子进程误认共享 owner 上下文。
  const daemonFields = [
    "OPENCODE_DAEMON_LAUNCHER_PID",
    "OPENCODE_DAEMON_EXECUTABLE",
    "OPENCODE_DAEMON_TARGET",
    "OPENCODE_DAEMON_DIAG_DIR",
    "OPENCODE_PRINT_LOGS",
    "OPENCODE_PID",
  ]
  for (const key of daemonFields) delete env[key]

  // 源码Bun执行本模块；编译产物由role进入bundle，虚拟bunfs路径不能作为脚本传给OS。
  // 可执行加载失败由真实子进程启动路径报告，不在父端做存在性快照检查。
  const args = /^bun(?:\.exe)?$/i.test(path.basename(process.execPath)) ? [fileURLToPath(import.meta.url)] : []
  const proc = spawn(process.execPath, args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    detached: false,
  })

  const signal = Deferred.makeUnsafe<readonly [number | null, NodeJS.Signals | null], Error>()
  const out = remoteReadable((seq) => sendCredit("stdout", seq))
  const err = remoteReadable((seq) => sendCredit("stderr", seq))
  const ended = { stdout: false, stderr: false }
  const nextSeq = { stdout: 0, stderr: 0 }

  let root: number | undefined
  let settled = false
  let lost: Error | undefined
  const exited = Promise.withResolvers<void>()
  const started = Promise.withResolvers<number>()
  // 同步返回资源后才由spawner等待ready；立即登记拒绝处理，避免spawn事件先到引发游离rejection。
  // 这里只观察Promise，原ready仍保持reject并交付给真实调用者。
  void started.promise.catch(() => {})

  // 宿主原生 stderr 只保留尾部 64KiB：它是运行时级证据，不是命令输出。
  let tail = Buffer.alloc(0)
  proc.stderr?.on("data", (chunk: Buffer) => {
    tail = Buffer.from(Buffer.concat([tail, chunk]).subarray(-FRAME_BYTES))
  })

  const failAll = (error: Error) => {
    if (lost) return
    lost = error
    out.readable.destroy(lost)
    err.readable.destroy(lost)
    // host丢失不是收到未知信号；退出等待与输出消费必须携带同一个执行故障身份。
    Deferred.doneUnsafe(signal, Exit.fail(error))
    started.reject(lost)
  }

  type ParentMessage =
    | { v: 1; type: "run"; executionID: string; command: WireCommand }
    | { v: 1; type: "cancel" | "accepted"; executionID: string }
    | { v: 1; type: "credit"; executionID: string; stream: StreamName; seq: number }

  const sendRaw = proc.send?.bind(proc)
  const sendMessage = (msg: ParentMessage) => {
    if (!sendRaw) return
    try {
      sendRaw(msg, () => {})
    } catch {
      // IPC 写入失败总是伴随随后的 exit/disconnect，这里不另起错误通道。
    }
  }
  // credit 是唯一的出站流控；cancel 只是建议，真正的终止保证来自 kill finalizer 与 Job 兼底。
  const sendCredit = (stream: StreamName, seq: number) =>
    sendMessage({ v: 1, type: "credit", executionID, stream, seq })

  // 协议违例 = 宿主实现已不可信：立即 SIGKILL 收摊，不等待其自证，
  // 违例与宿主丢失走同一 failAll 通道，消费侧只看到一种终态错误。
  const protocolError = (detail: string) => {
    failAll(new Error(`shell capture protocol violation (${detail}, executionID=${executionID})`))
    proc.kill("SIGKILL")
  }

  proc.on("message", (raw: unknown) => {
    // 违例证据必须带原始帧的有界预览：否则宿主 bug、IPC 串扰、版本漂移不可归因。
    if (!isHostMessage(raw, executionID)) {
      let preview = String(typeof raw)
      try {
        preview = JSON.stringify(raw)?.slice(0, 200) ?? preview
      } catch {}
      return protocolError(`unrecognized message: ${preview}`)
    }
    switch (raw.type) {
      case "ready":
        sendMessage({ v: 1, type: "run", executionID, command: wire })
        return
      case "started":
        root = raw.rootPID
        started.resolve(raw.rootPID)
        return
      case "chunk": {
        // seq 必须严格连续：丢帧=输出洞、乱序=宿主实现错误，两者都不能静默重排后继续。
        const expected = nextSeq[raw.stream]
        if (raw.seq !== expected) return protocolError(`chunk seq ${raw.seq} != ${expected}`)
        nextSeq[raw.stream] = expected + 1
        const stream = raw.stream === "stdout" ? out : err
        stream.push(raw.seq, Buffer.from(raw.base64, "base64"))
        return
      }
      case "end":
        // 字节结束尚未证明native清理成功，保持Readable可失败直到completed。
        ended[raw.stream] = true
        return
      case "root-exit":
        Deferred.doneUnsafe(signal, Exit.succeed([raw.code, toSignal(raw.signal)] as const))
        return
      case "completed":
        // 双流必须先交付 end；completed 意味着宿主内 capture 已结算完毕。
        if (!ended.stdout || !ended.stderr || !Deferred.isDoneUnsafe(signal))
          return protocolError("completed before root or stream end")
        settled = true
        sendMessage({ v: 1, type: "accepted", executionID })
        out.readable.push(null)
        err.readable.push(null)
        return
      case "failed": {
        settled = true
        failAll(
          new Error(
            `shell capture host failed at ${raw.stage}: ${raw.message} (executionID=${executionID} hostPID=${proc.pid} rootPID=${root})`,
          ),
        )
        return
      }
    }
  })
  proc.on("error", (error) => failAll(error))
  // close在stdio和IPC结束后判定缺失终态；资源释放也等待此点，避免提前销毁待报错的流。
  proc.on("close", (code, signalCode) => {
    exited.resolve()
    if (settled) return
    // 宿主丢失后命令的最终状态不可知：错误必须携带本次执行身份，不得伪造退出码。
    const tailText = tail.toString("utf-8").trim()
    failAll(
      new Error(
        `shell capture host lost (executionID=${executionID} hostPID=${proc.pid} rootPID=${root} exit=${code}/${signalCode})` +
          (tailText ? `: ${tailText.slice(-2000)}` : ""),
      ),
    )
  })

  return {
    proc,
    signal,
    ready: started.promise,
    capture: { streams: [out.readable, err.readable] },
    async close() {
      // 取得进程即拥有回收责任，ready仍未完成时也可取消；宽限后只终止本次host。
      // 正常completed不发送cancel，保证后台任务已经解除Job限制后继续运行。
      if (!settled && proc.exitCode === null && proc.signalCode === null)
        sendMessage({ v: 1, type: "cancel", executionID })
      const timer = setTimeout(() => proc.kill("SIGKILL"), wire.forceKillAfter ?? 500)
      try {
        await exited.promise
      } finally {
        clearTimeout(timer)
        out.readable.destroy()
        err.readable.destroy()
      }
    },
  }
}

export async function runHost(): Promise<number> {
  const executionID = process.env.OPENCODE_SHELL_EXEC ?? crypto.randomUUID()
  const sendRaw = process.send?.bind(process)
  if (!sendRaw) throw new Error("shell capture host requires an ipc channel")
  const send = (msg: HostMessage) =>
    new Promise<void>((resolve, reject) => {
      sendRaw(msg, (error: Error | null) => (error ? reject(error) : resolve()))
    })

  const kernel = await kernel32()
  const k = kernel.symbols
  const ptr = kernel.ptr
  // Job 必须在任何命令启动前建立：之后创建的后代全部纳入 kill-on-close 回收域。
  const job = k.CreateJobObjectW(null, null)
  if (!job) throw kernel.error("CreateJobObjectW")
  const limits = Buffer.alloc(JOB_EXTENDED_LIMIT_BYTES)
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)
  // i64的-1n保留当前进程伪句柄全部位，不再通过浮点ptr往返或额外OpenProcess。
  if (
    !k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(limits), limits.length) ||
    !k.AssignProcessToJobObject(job, -1n)
  ) {
    const error = kernel.error("initialize capture Job")
    k.CloseHandle(job)
    throw error
  }

  const next = Promise.withResolvers<unknown>()
  const accepted = Promise.withResolvers<void>()
  const abort = new AbortController()
  let finished = false
  const granted = { stdout: 0, stderr: 0 }
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
    waiters.clear()
  }
  // 失去父端与显式取消共用执行scope的终止信号；Job限制保留到host退出。
  // 同时解除尚未收到run/credit的等待，避免没有命令句柄时留下空闲孤儿。
  const cancel = () => {
    if (finished) return
    abort.abort()
    next.resolve(undefined)
    wake()
  }

  process.on("message", (raw: unknown) => {
    if (!isRecord(raw) || raw.v !== 1 || raw.executionID !== executionID) return
    if (raw.type === "run") {
      next.resolve(raw)
      return
    }
    if (raw.type === "credit" && (raw.stream === "stdout" || raw.stream === "stderr") && typeof raw.seq === "number") {
      // credit(seq) 授权下一帧；初始 granted=0 预授权首帧，双方不需要额外界面。
      granted[raw.stream] = raw.seq + 1
      wake()
      return
    }
    if (raw.type === "cancel") {
      cancel()
      return
    }
    if (raw.type === "accepted") accepted.resolve()
  })
  process.on("disconnect", () => {
    cancel()
    accepted.resolve()
  })

  // 进程退出码合同：0=completed 交付且未被取消；1=执行失败或取消。
  // 父端只信 completed，不信退出码——IPC 可能先于进程退出被截断。
  await send({ v: 1, type: "ready", executionID, hostPID: process.pid })
  const runMessage = await next.promise
  if (abort.signal.aborted) return 1
  const wire = parseWireCommand(isRecord(runMessage) ? runMessage.command : undefined)

  const { CrossSpawnSpawner } = await import("./cross-spawn-spawner")
  const { ChildProcess } = await import("effect/unstable/process")
  const { Cause, Effect, Exit: EffectExit, Fiber, Stream } = await import("effect")

  const sent = { stdout: 0, stderr: 0 }
  // 预授权窗口恰为每流一帧：父端不消费时宿主最多再持有一帧待发，传输两侧内存均有界。
  // cancel 到达时等待中的发送静默返回：取消路径的输出按合同丢弃，不再入流。
  // 上游一次性交付的字节可能超过单帧上限（NodeStream 会拼接缓冲区）：发送侧按
  // FRAME_BYTES 切片分帧，帧序号逐帧递增，父端的 seq 连续性与单帧上限同时成立。
  const sendChunk = async (stream: StreamName, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
      const seq = sent[stream]++
      while (seq > granted[stream] && !abort.signal.aborted) {
        await new Promise<void>((resolve) => waiters.add(resolve))
      }
      if (abort.signal.aborted) return
      await send({
        v: 1,
        type: "chunk",
        executionID,
        stream,
        seq,
        base64: Buffer.from(bytes.subarray(offset, offset + FRAME_BYTES)).toString("base64"),
      })
    }
  }

  const program = Effect.scoped(
    Effect.gen(function* () {
      const command = mark(
        ChildProcess.make(wire.file, wire.args, {
          cwd: wire.cwd,
          env: wire.env,
          stdin: "ignore",
          detached: false,
          ...(wire.killSignal ? { killSignal: wire.killSignal } : {}),
          ...(wire.forceKillAfter !== undefined ? { forceKillAfter: wire.forceKillAfter } : {}),
        }),
      )
      const handle = yield* command
      yield* Effect.promise(() => send({ v: 1, type: "started", executionID, rootPID: Number(handle.pid) }))
      const forward = (stream: typeof handle.stdout, name: StreamName) =>
        Stream.runForEach(stream, (bytes) => Effect.promise(() => sendChunk(name, bytes))).pipe(
          Effect.andThen(Effect.promise(() => send({ v: 1, type: "end", executionID, stream: name }))),
        )
      // 必须先启动双流转发再等待退出：capture 的内核管道只有被消费才会排空，先等退出
      // 会与正在写满管道的命令互相等待。root-exit 仍在排空前上报，保留退出码时序。
      const forwarding = yield* Effect.forkScoped(
        Effect.all([forward(handle.stdout, "stdout"), forward(handle.stderr, "stderr")], { concurrency: "unbounded" }),
      )
      const exit = yield* Effect.exit(handle.exitCode)
      const payload =
        exit._tag === "Success"
          ? { code: Number(exit.value), signal: null as string | null }
          : {
              code: null,
              // 取消路径以请求的信号为准；外部 signal 死亡从既有错误文本提取名称。
              signal: abort.signal.aborted
                ? "SIGTERM"
                : (/signal: '([^']+)'/.exec(String(Cause.squash(exit.cause)))?.[1] ?? null),
            }
      yield* Effect.promise(() =>
        send({ v: 1, type: "root-exit", executionID, code: payload.code, signal: payload.signal }),
      )
      yield* Fiber.join(forwarding)
    }),
  )
  const result = await Effect.runPromiseExit(program.pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)), {
    signal: abort.signal,
  })

  if (EffectExit.isFailure(result)) {
    const message = String(Cause.squash(result.cause))
    await send({ v: 1, type: "failed", executionID, stage: "execute", message }).catch(() => {})
    return 1
  }
  // 只有scope和Job都成功结算才进入正常终态；更早的取消始终保留后代回收责任。
  if (abort.signal.aborted) return 1
  // 正常完成解除kill-on-close，失败必须阻止completed，不能静默杀掉已承诺独立寿命的后台任务。
  const info = Buffer.alloc(JOB_EXTENDED_LIMIT_BYTES)
  if (!k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(info), info.length))
    throw kernel.error("SetInformationJobObject")
  k.CloseHandle(job)
  finished = true
  await send({ v: 1, type: "completed", executionID })
  await accepted.promise
  return 0
}

// 源码布局的直接执行入口；编译 bundle 中本模块不是入口，此分支不成立。
if (process.platform === "win32" && import.meta.main) {
  runHost()
    .then((code) => process.exit(code))
    .catch((error) => {
      // 宿主入口失败必须留在原生 stderr：父端把该尾部纳入执行错误证据。
      console.error(error)
      process.exit(1)
    })
}

export * as WindowsShellOutput from "./windows-shell-output"

import type { StandardCommand } from "effect/unstable/process/ChildProcess"
import { closeSync, constants, openSync } from "node:fs"
import { Readable } from "node:stream"

// ---------- Win32 常量 ----------

// 命名管道服务端：句柄只读、字节模式、允许异步 I/O。
const PIPE_ACCESS_INBOUND = 0x00000001
const PIPE_TYPE_BYTE = 0
const FILE_FLAG_OVERLAPPED = 0x40000000

// 读取生命周期涉及的 GetLastError 值。
const ERROR_BROKEN_PIPE = 109 // 全部写端关闭：正常 EOF
const ERROR_OPERATION_ABORTED = 995 // 本次 CancelIoEx 生效
const ERROR_IO_INCOMPLETE = 996 // 异步操作尚未完成
const ERROR_IO_PENDING = 997 // ReadFile 已受理为异步操作
const ERROR_NOT_FOUND = 1168 // 取消时操作已抢先完成

// 映射为 Node 风格错误码的 Win32 值。
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5

// Win64（x64/ARM64）的 OVERLAPPED 固定 32 字节，hEvent 位于偏移 24。
const OVERLAPPED_SIZE = 32
const OVERLAPPED_EVENT_OFFSET = 24
const READ_BUFFER_SIZE = 65536

// 该间隔只调度下一次状态检查；完成与否由 GetOverlappedResult 决定。
const POLL_INTERVAL_MS = 1

// ---------- 命令标记 ----------

const markedCommands = new WeakSet<StandardCommand>()

// 只有 ShellTool 能选择前台调用寿命；共享 spawner 的其他消费者继续等待真正 EOF。
// 标记附着于本次 command 对象，不进入 env 或脚本，也不会被后台子进程继承。
export function mark(command: StandardCommand) {
  markedCommands.add(command)
  return command
}

export const has = (command: StandardCommand) => markedCommands.has(command)

// ---------- 前台输出捕获 ----------

// open：前台进程存活，正常读取；draining：前台已退出，只排空已产生的字节；
// closing：取消并释放全部资源。close 可从任意阶段进入 closing。
type Phase = "open" | "draining" | "closing"

export async function make() {
  // Node/POSIX 加载 core 不会加载 FFI；Windows 路径复用系统 DLL，不产生可部署的 native 资产。
  const { dlopen, ptr } = await import("bun:ffi")
  // 创建中途由 using 清理；全部 pipe 成功后才把资源转交 spawn scope。
  using partialCleanup = new DisposableStack()
  const library = dlopen("kernel32.dll", {
    CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "ptr" },
    CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "ptr" },
    ReadFile: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    GetOverlappedResult: { args: ["ptr", "ptr", "ptr", "i32"], returns: "i32" },
    CancelIoEx: { args: ["ptr", "ptr"], returns: "i32" },
    PeekNamedPipe: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
    ResetEvent: { args: ["ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  })
  // library 最先取得、最后释放，保证资源清理时 FFI 函数仍然有效。
  partialCleanup.defer(() => library.close())
  const k = library.symbols

  const toErrno = (value: number) => {
    if (value === ERROR_ACCESS_DENIED) return "EACCES"
    if (value === ERROR_FILE_NOT_FOUND || value === ERROR_PATH_NOT_FOUND) return "ENOENT"
    return "EIO"
  }
  const win32Error = (method: string, value = k.GetLastError()) =>
    Object.assign(new Error(`${method}: win32=${value}`), { code: toErrno(value), errno: value, syscall: method })

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
    return {
      handle,
      event,
      fd,
      buffer: Buffer.alloc(READ_BUFFER_SIZE),
      overlapped: Buffer.alloc(OVERLAPPED_SIZE),
      bytesRead: new Uint32Array(1),
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
      pipe.bytesRead[0] = 0
      let ok = k.ReadFile(pipe.handle, ptr(pipe.buffer), length, ptr(pipe.bytesRead), ptr(pipe.overlapped))
      let status = ok ? 0 : k.GetLastError()
      if (status === ERROR_IO_PENDING) {
        pipe.kernelPending = true
        do {
          await pause()
          ok = k.GetOverlappedResult(pipe.handle, ptr(pipe.overlapped), ptr(pipe.bytesRead), 0)
          status = ok ? 0 : k.GetLastError()
        } while (status === ERROR_IO_INCOMPLETE)
        pipe.kernelPending = false
      }
      // ERROR_OPERATION_ABORTED 只接受本 owner 已发起的停止。
      if (status === ERROR_OPERATION_ABORTED && phase !== "open") return
      if (status === ERROR_BROKEN_PIPE) {
        pipe.eof = true
        return
      }
      if (status !== 0) throw win32Error("ReadFile", status)
      // 消费者可能背压或迟订阅，必须在 buffer 复用前复制已完成的字节。
      return Buffer.from(pipe.buffer.subarray(0, pipe.bytesRead[0]))
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
      // pending 操作已终态后才能释放 OVERLAPPED 所指向的资源及 DLL。
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

export * as WindowsShellOutput from "./windows-shell-output"

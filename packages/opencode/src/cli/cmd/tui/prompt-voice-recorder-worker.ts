import { createRequire } from "module"
type NativePvRecorder = {
  init(frameLength: number, deviceIndex: number, bufferedFrames: number): { status: number; handle: bigint }
  read(handle: bigint, frame: Int16Array): number
  start(handle: bigint): number
  stop(handle: bigint): number
  delete(handle: bigint): void
}
type StartCommand = {
  type: "start"
  native: string
  frameLength: number
  bufferedFrames: number
  control: SharedArrayBuffer
}
type Command = StartCommand | { type: "probe" }
self.onmessage = ({ data }: MessageEvent<Command>) => {
  if (data.type === "probe") {
    // 只确认 compiled bunfs entrypoint 可启动，不加载 native 或伪造录音成功。
    self.postMessage({ type: "probe" })
    self.close()
    return
  }
  record(data)
}
function record(command: StartCommand) {
  let native: NativePvRecorder | undefined
  let handle: bigint | undefined
  let started = false
  let failure: unknown
  try {
    // require 发生在 Worker，TUI 线程不再触碰 `.node`，且缺失时不会回退到第二套 reader。
    const recorder: NativePvRecorder = createRequire(import.meta.url)(command.native)
    native = recorder
    const initialized = recorder.init(command.frameLength, -1, command.bufferedFrames) // init 失败时尚未取得可释放的 handle。
    if (initialized.status !== 0) throw new Error(`PvRecorder initialize failed with status ${initialized.status}`)
    handle = initialized.handle // handle 是后续 stop/delete 的唯一 native 资源标识。
    const startStatus = recorder.start(handle) // start 失败只 delete，不能先调用 stop。
    if (startStatus !== 0) throw new Error(`PvRecorder start failed with status ${startStatus}`)
    started = true // 该状态只记录 stop ownership，不参与 frame 判断。
    self.postMessage({ type: "started" }) // 主线程收到 readiness 后才暴露 recorder handle。
    const control = new Int32Array(command.control) // 共享原子位是唯一 stop 接受边界。
    while (Atomics.load(control, 0) === 0) { // 同步 read 在 Worker 内阻塞，不再阻塞 TUI event loop。
      // 每帧独立 backing store，既适配 native 写回，也允许 postMessage 后转移所有权。
      const frame = new Int16Array(new ArrayBuffer(command.frameLength * Int16Array.BYTES_PER_ELEMENT))
      const readStatus = recorder.read(handle, frame) // read 错误保留为 primary failure。
      if (readStatus !== 0) throw new Error(`PvRecorder read failed with status ${readStatus}`)
      // 阻塞 read 结束后重新检查，禁止发送 stop 之后才完成的帧。
      if (Atomics.load(control, 0) !== 0) break
      self.postMessage({ type: "frame", frame }, [frame.buffer]) // 转移 backing store 后不再复用该帧。
    }
  } catch (error) {
    failure = error
  }
  // Worker 是 native handle 唯一 owner；cleanup 各尝试一次，且不得覆盖 primary failure。
  try {
    if (native && handle !== undefined && started) native.stop(handle) // normal/read failure 均只尝试一次 stop。
  } catch {}
  try {
    if (native && handle !== undefined) native.delete(handle) // delete failure 不覆盖 earlier failure。
  } catch {}
  if (failure) self.postMessage({ type: "error", message: failure instanceof Error ? failure.message : String(failure) }) // terminal 排在 cleanup 与全部 accepted frame 之后。
  else self.postMessage({ type: "stopped" })
  self.close()
}

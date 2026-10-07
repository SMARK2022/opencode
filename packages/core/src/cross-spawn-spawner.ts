import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"
import { WindowsShellOutput } from "./windows-shell-output"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    // 隔离捕获的错误身份必须进入公开错误文本，否则Tool只见Unknown而丢失host证据。
    description: command._tag === "StandardCommand" && WindowsShellOutput.has(command) ? err.message : undefined,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
    capture?: Pick<Awaited<ReturnType<typeof WindowsShellOutput.make>>, "streams">,
  ) {
    // 急切缓冲（写入与订阅时序解耦）：spawn 建柄后立即把主 stdout/stderr pipe 进
    // PassThrough（与下方 extra-fd 输出同款模式）。惰性 fromReadable 下快退子进程
    // 在订阅前写入并退出会丢管道数据（macOS CI shell basic 红 + Windows 10/10
    // 探针复现）；立即 pipe 让读取端自 spawn 时刻持有数据，订阅延迟只推迟消费
    // 时刻、不再影响输出保真。
    // acquireRelease 原子建立两对 capture 并注册释放，避免取消落在所有权空窗。
    const taps = yield* Effect.acquireRelease(
      Effect.sync(() =>
        (capture?.streams ?? [proc.stdout, proc.stderr]).map((source) => {
          if (!source) return
          const tap = new PassThrough()
          const relay = (cause: Error) => tap.destroy(toError(cause))
          source.on("error", relay)
          // close 发生在异步 error 之后；保留 relay 到实际关闭，避免清理中出现未处理错误。
          source.once("close", () => source.off("error", relay))
          source.pipe(tap)
          return { source, tap }
        }),
      ),
      (taps) =>
        Effect.sync(() => {
          // NodeStream 只销毁 tap；原始读端必须由创建它的 spawn scope 一并释放。
          // 不绑定 root exit：scope 内的晚订阅与后代真实输出仍需保留。
          for (const pair of taps) {
            if (!pair) continue
            pair.source.unpipe(pair.tap)
            pair.source.destroy()
            pair.tap.destroy()
          }
        }),
    )
    const tapOut = taps[0]?.tap
    const tapErr = taps[1]?.tap
    let stdout = tapOut
      ? NodeStream.fromReadable({
          evaluate: () => tapOut,
          onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
        })
      : Stream.empty
    let stderr = tapErr
      ? NodeStream.fromReadable({
          evaluate: () => tapErr,
          onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
        })
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout, stderr, all: Stream.merge(stdout, stderr) }
  })

  const spawn = (
    command: ChildProcess.StandardCommand,
    opts: NodeChildProcess.SpawnOptions,
    capture?: Awaited<ReturnType<typeof WindowsShellOutput.make>>,
  ) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ExitSignal], PlatformError.PlatformError>((resume) => {
      const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
      const proc = launch(command.command, command.args, opts)
      // 子进程已取得自己的写端；父进程不得用这些fd阻止管道完成。
      capture?.releaseWriters()
      let end = false
      let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
      // exit 信号与 stdio 排干解耦（INV-06）：'close' 要等输出流读完，而 tap 背压下
      // 消费者提前停止会使流暂停在数据中段、'close' 永不触发——kill/exitCode/scope
      // finalizer 三处 await 将无限挂起。进程死亡（'exit'）即完成信号；'close' 兜底
      // 经同一幂等闭包，仅在 exit 缺席时生效，exit 后到达为 no-op。
      const completeSignal = (args: readonly [code: number | null, signal: NodeJS.Signals | null]) => {
        if (end) return
        end = true
        Deferred.doneUnsafe(signal, Exit.succeed(args))
      }
      proc.on("error", (err) => {
        resume(Effect.fail(toPlatformError("spawn", err, command)))
      })
      proc.on("exit", (...args) => {
        exit = args
        completeSignal(args)
        // exitCode继续只表示进程结果；排空失败走原输出流错误链，不伪造退出码。
        // fd启动时proc.close可早于owned排空，Tool仍通过原output fiber等待缓冲消费。
        void capture?.finish().catch((cause) => {
          for (const source of capture.streams) source.destroy(toError(cause))
        })
      })
      proc.on("close", (...args) => {
        completeSignal(exit ?? args)
      })
      proc.on("spawn", () => {
        resume(Effect.succeed([proc, signal]))
      })
      return Effect.sync(() => {
        proc.kill("SIGTERM")
      })
    })

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          if (err) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-proc.pid!, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })
  }

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  const timeout =
    (
      proc: NodeChildProcess.ChildProcess,
      command: ChildProcess.StandardCommand,
      opts: ChildProcess.KillOptions | undefined,
    ) =>
    <A, E, R>(
      f: (
        command: ChildProcess.StandardCommand,
        proc: NodeChildProcess.ChildProcess,
        signal: NodeJS.Signals,
      ) => Effect.Effect<A, E, R>,
    ) => {
      const signal = opts?.killSignal ?? "SIGTERM"
      if (Predicate.isUndefined(opts?.forceKillAfter)) return f(command, proc, signal)
      return Effect.timeoutOrElse(f(command, proc, signal), {
        duration: opts.forceKillAfter,
        orElse: () => f(command, proc, "SIGKILL"),
      })
    }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const dir = yield* cwd(command.options)

          const marked = WindowsShellOutput.has(command)
          // 原生捕获的进程级故障域必须限制在单次调用：普通进程把已标记命令委托给独占
          // 执行宿主；只有宿主角色内才在当前进程创建本地 capture。
          const remote = marked && !WindowsShellOutput.isHost()
          // capture先取得、后释放：原process finalizer仍负责取消存活进程。
          // marker来自ShellTool构造点，通用core、MCP和管道组合保持原EOF路径。
          const capture =
            marked && !remote
              ? yield* Effect.acquireRelease(
                  Effect.tryPromise({
                    try: WindowsShellOutput.make,
                    catch: (cause) => toPlatformError("capture", toError(cause), command),
                  }),
                  (output) => Effect.promise(output.close),
                )
              : undefined
          // 同步取得host立即登记回收；ready是可中断等待，不把用户取消锁在acquire内。
          const session = remote
            ? yield* Effect.acquireRelease(
                Effect.try({
                  try: () => WindowsShellOutput.openRemote(command, { cwd: dir, env: env(command.options) }),
                  catch: (cause) => toPlatformError("capture", toError(cause), command),
                }),
                (s) => Effect.promise(() => s.close()),
              )
            : undefined

          // 本地资源合同保留在原owner；Effect是惰性的，remote分支不会执行这份本地spawn。
          const local = Effect.acquireRelease(
            spawn(
              command,
              {
                cwd: dir,
                env: env(command.options),
                stdio: capture ? ["ignore", ...capture.descriptors] : stdios(sin, sout, serr, extra),
                detached: command.options.detached ?? process.platform !== "win32",
                shell: command.options.shell,
                windowsHide: process.platform === "win32",
              },
              capture,
            ),
            Effect.fnUntraced(function* ([proc, signal], outcome) {
              const done = yield* Deferred.isDone(signal)
              const kill = timeout(proc, command, command.options)
              // 取消等待整个独占组：root在宽限期内先退出也不省略后代强杀；repeat以kill(-pid,0)探测，ESRCH即组已清空，20ms只是调度节拍。
              if (process.platform !== "win32" && command.options.detached !== false && Exit.isFailure(outcome))
                return yield* Effect.ignore(
                  kill((cmd, child, sig) =>
                    killGroup(cmd, child, sig).pipe(
                      Effect.andThen(
                        sig === "SIGKILL"
                          ? Deferred.await(signal).pipe(Effect.asVoid)
                          : Effect.try({
                              try: () => process.kill(-Number(child.pid), 0),
                              catch: (error) => error,
                            }).pipe(Effect.repeat({ schedule: Schedule.spaced(20) }), Effect.asVoid),
                      ),
                    ),
                  ),
                )
              if (done) {
                const [code] = yield* Deferred.await(signal)
                if (process.platform === "win32") return yield* Effect.void
                if (code !== 0 && Predicate.isNotNull(code)) return yield* Effect.ignore(kill(killGroup))
                return yield* Effect.void
              }
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const sig = command.options.killSignal ?? "SIGTERM"
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              const escalated = command.options.forceKillAfter
                ? Effect.timeoutOrElse(attempt, {
                    duration: command.options.forceKillAfter,
                    orElse: () => send("SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid),
                  })
                : attempt
              return yield* Effect.ignore(escalated)
            }),
          )
          const root = session
            ? yield* Effect.tryPromise({
                try: () => session.ready,
                catch: (cause) => toPlatformError("spawn", toError(cause), command),
              })
            : undefined
          const [proc, exit, done] = session
            ? ([
                session.proc,
                Deferred.await(session.signal).pipe(
                  Effect.mapError((cause) => toPlatformError("capture", cause, command)),
                ),
                Deferred.isDone(session.signal),
              ] as const)
            : yield* local.pipe(
                Effect.map(([proc, signal]) => [proc, Deferred.await(signal), Deferred.isDone(signal)] as const),
              )

          const fd = yield* setupFds(command, proc, extra)
          const out = yield* setupOutput(command, proc, sout, serr, capture ?? session?.capture)
          let ref = true
          return makeHandle({
            // 远端路径暴露真实命令 PID（宿主内根进程），不是宿主自身 PID。
            pid: ProcessId(root ?? proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(done, (value) => !value),
            exitCode: Effect.flatMap(exit, ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts?: ChildProcess.KillOptions) => {
              // 远端回收由session持有真实host寿命，root已退也不能跳过仍未结算的host。
              if (session)
                return Effect.tryPromise({
                  try: () => session.close(),
                  catch: (cause) => toPlatformError("kill", toError(cause), command),
                })
              const sig = opts?.killSignal ?? "SIGTERM"
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const attempt = send(sig).pipe(Effect.andThen(exit), Effect.asVoid)
              if (!opts?.forceKillAfter) return attempt
              return Effect.timeoutOrElse(attempt, {
                duration: opts.forceKillAfter,
                orElse: () => send("SIGKILL").pipe(Effect.andThen(exit), Effect.asVoid),
              })
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                capture?.ref(false)
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  capture?.ref(true)
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

export const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))

export * as CrossSpawnSpawner from "./cross-spawn-spawner"

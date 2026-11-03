#!/usr/bin/env bun

// 新CLI的编译产物也可能作为当前可执行文件；宿主不得先加载Commands、Runtime或Daemon层。
if (process.env.OPENCODE_PROCESS_ROLE === "shell-capture") {
  const { runHost } = await import("@opencode-ai/core/windows-shell-output")
  process.exit(await runHost())
}

// probe在Runtime.run和Daemon.layer之前退出；不启动产品服务或加载native录音addon。
if (process.env.OPENCODE_PROCESS_ROLE === "voice-smoke") {
  const { voiceWorkerPath } = await import("../../tui/src/prompt-voice-recorder")
  const worker = new Worker(voiceWorkerPath(), { ref: true })
  const acknowledged = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const timeout = Bun.sleep(10_000).then(() => {
    throw new Error("Compiled voice Worker probe timed out")
  })
  worker.onmessage = (event) => {
    if (event.data?.type === "probe") acknowledged.resolve()
  }
  worker.onerror = (event) => acknowledged.reject(new Error(event.message || "Compiled voice Worker failed"))
  worker.addEventListener("close", () => closed.resolve(), { once: true })
  worker.postMessage({ type: "probe" })
  try {
    // ack证明入口、close证明资源已释放；任何错误仍拒绝，finally只负责回收。
    await Promise.race([Promise.all([acknowledged.promise, closed.promise]), timeout])
    process.stdout.write("voice-worker-probe-ok\n")
  } finally {
    worker.terminate()
  }
  process.exit(0)
}

const NodeRuntime = await import("@effect/platform-node/NodeRuntime")
const NodeServices = await import("@effect/platform-node/NodeServices")
const { Effect } = await import("effect")
const { Commands } = await import("./commands/commands")
const { Runtime } = await import("./framework/runtime")
const { Daemon } = await import("./services/daemon")

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  api: () => import("./commands/handlers/api"),
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
  },
  migrate: () => import("./commands/handlers/migrate"),
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    password: () => import("./commands/handlers/service/password"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Runtime.run(Commands, Handlers, { version: "local" }).pipe(
  Effect.provide(Daemon.layer),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)

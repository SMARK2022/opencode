// 捕获宿主先于应用模块加载；仅把if写在静态import前仍会先初始化应用和数据库。
if (process.env.OPENCODE_PROCESS_ROLE === "shell-capture") {
  const { runHost } = await import("@opencode-ai/core/windows-shell-output")
  process.exit(await runHost())
}

// 编译入口只凭明确的 worker 环境角色旁路 yargs，普通用户参数仍走原 CLI parser。
if (process.env.OPENCODE_PROCESS_ROLE === "worker") {
  await import("./cli/tui/worker")
  // listener 拥有事件循环；悬置入口防止继续启动 TUI，退出仍由 worker 的资源清理决定。
  await new Promise<never>(() => {})
}
// 独立诊断角色复用生产地址解析，不能进入CLI或native录音路径。
if (process.env.OPENCODE_PROCESS_ROLE === "voice-smoke") {
  const { voiceWorkerPath } = await import("../../tui/src/prompt-voice-recorder")
  const worker = new Worker(voiceWorkerPath(), { ref: true })
  const acknowledged = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const timeout = Bun.sleep(10_000).then(() => {
    throw new Error("Compiled voice Worker probe timed out")
  })
  worker.onmessage = (event) => { if (event.data?.type === "probe") acknowledged.resolve() }
  worker.onerror = (event) => acknowledged.reject(new Error(event.message || "Compiled voice Worker failed"))
  worker.addEventListener("close", () => closed.resolve(), { once: true })
  worker.postMessage({ type: "probe" })
  try {
    // ack证明入口运行，close证明线程退出；两者完成才允许报告成功。
    await Promise.race([Promise.all([acknowledged.promise, closed.promise]), timeout])
    process.stdout.write("voice-worker-probe-ok\n")
  } finally {
    worker.terminate()
  }
  process.exit(0)
}

// 普通CLI保留原命令注册顺序；worker和诊断角色不进入这些有副作用的应用依赖。
const { default: yargs } = await import("yargs")
const { hideBin } = await import("yargs/helpers")
const { UI } = await import("./cli/ui")
const { InstallationVersion } = await import("@opencode-ai/core/installation/version")
const { FormatError } = await import("./cli/error")
const { EOL } = await import("os")
const { errorMessage } = await import("./util/error")
const { Heap } = await import("./cli/heap")

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

// 仅无额外参数的 daemon stop 跳过无关模块；其他 argv 保留完整注册和 fail-help。
const daemonStop = args.length === 2 && args[0] === "daemon" && args[1] === "stop"
if (daemonStop) {
  const { DaemonCommand } = await import("./cli/cmd/daemon")
  cli.command(DaemonCommand)
}
if (!daemonStop) {
  const { RunCommand } = await import("./cli/cmd/run")
  const { GenerateCommand } = await import("./cli/cmd/generate")
  const { ConsoleCommand } = await import("./cli/cmd/account")
  const { ProvidersCommand } = await import("./cli/cmd/providers")
  const { AgentCommand } = await import("./cli/cmd/agent")
  const { UpgradeCommand } = await import("./cli/cmd/upgrade")
  const { UninstallCommand } = await import("./cli/cmd/uninstall")
  const { ModelsCommand } = await import("./cli/cmd/models")
  const { ServeCommand } = await import("./cli/cmd/serve")
  const { DebugCommand } = await import("./cli/cmd/debug")
  const { StatsCommand } = await import("./cli/cmd/stats")
  const { McpCommand } = await import("./cli/cmd/mcp")
  const { GithubCommand } = await import("./cli/cmd/github")
  const { ExportCommand } = await import("./cli/cmd/export")
  const { ImportCommand } = await import("./cli/cmd/import")
  const { AttachCommand } = await import("./cli/cmd/attach")
  const { TuiThreadCommand } = await import("./cli/cmd/tui")
  const { AcpCommand } = await import("./cli/cmd/acp")
  const { WebCommand } = await import("./cli/cmd/web")
  const { PrCommand } = await import("./cli/cmd/pr")
  const { SessionCommand } = await import("./cli/cmd/session")
  const { DbCommand } = await import("./cli/cmd/db")
  const { DaemonCommand } = await import("./cli/cmd/daemon")
  const { PluginCommand } = await import("./cli/cmd/plug")
  cli
    .command(AcpCommand)
    .command(McpCommand)
    // #259：daemon 管理的是 TUI 共享后台进程；必须早于默认 $0 [project] 入口注册
    // 否则 opencode daemon stop 会被解释成“打开名为 daemon 的项目并把 stop 当参数”
    .command(DaemonCommand)
    .command(TuiThreadCommand)
    .command(AttachCommand)
    .command(RunCommand)
    .command(GenerateCommand)
    .command(DebugCommand)
    .command(ConsoleCommand)
    .command(ProvidersCommand)
    .command(AgentCommand)
    .command(UpgradeCommand)
    .command(UninstallCommand)
    .command(ServeCommand)
    .command(WebCommand)
    .command(ModelsCommand)
    .command(StatsCommand)
    .command(ExportCommand)
    .command(ImportCommand)
    .command(GithubCommand)
    .command(PrCommand)
    .command(SessionCommand)
    .command(PluginCommand)
    .command(DbCommand)
}

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

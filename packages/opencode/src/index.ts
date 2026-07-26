import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { DaemonCommand } from "./cli/cmd/daemon"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"

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

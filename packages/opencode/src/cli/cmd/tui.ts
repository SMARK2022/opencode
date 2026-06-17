import { cmd } from "@/cli/cmd/cmd"
import path from "path"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./tui/win32"
import { Daemon } from "./tui/daemon"
import type { TuiInput } from "@opencode-ai/tui"

const SMARK_IDE_BRIDGE_URL = "https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge"

// [local-devsmark] Keep the TUI on the shared daemon transport instead of the
// upstream RPC-thread transport. The daemon is the single SQLite owner for TUI
// sessions, which avoids cross-TUI database write races when multiple opencode
// instances are open. Do not reintroduce per-TUI Rpc.client/new Worker startup
// here unless the database ownership model is redesigned.
export const DAEMON_START_TIMEOUT_MS = Daemon.DAEMON_START_TIMEOUT_MS
export const SERVER_ELECTION_TIMEOUT_MS = Daemon.SERVER_ELECTION_TIMEOUT_MS
export const _spawn = Daemon._spawn
export const _setSpawn = Daemon._setSpawn
let runOverride: ((input: TuiInput) => Promise<void>) | undefined
export function _setRun(next: typeof runOverride) {
  runOverride = next
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

function hasPortRequest(args: { port?: number }) {
  return (
    (args.port !== undefined && args.port !== 0) ||
    process.argv.some((arg) => arg === "--port" || arg.startsWith("--port="))
  )
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
      withNetworkOptions(yargs)
      // [dev-smark] Keep --port parsed but hidden so the handler can emit the
      // curated SMARK bridge-extension guidance instead of generic yargs output.
      .option("port", { type: "number", default: 0, hidden: true })
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
      }),
  handler: async (args) => {
    const unguard = win32InstallCtrlCGuard()
    win32DisableProcessedInput()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      if (hasPortRequest(args)) {
        // [dev-smark] VS Code integration is bridge-registry driven now: the
        // SMARK extension writes the IDE lock/registry and opencode reads that
        // source of truth. Reject --port here so users do not install or rely
        // on community plugins that expect the removed random-port TUI path.
        UI.error(
          `--port is no longer supported for the VS Code TUI bridge. Install the official SMARK OpenCode IDE Bridge extension instead of community bridge plugins: ${SMARK_IDE_BRIDGE_URL}`,
        )
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
      const existingUrl = await Daemon.ensure(args)

      // ── Common path: validate session then start TUI ──────────────────────
      try {
        await validateSession({
          url: existingUrl!,
          sessionID: args.session,
          directory: cwd,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      const tuiInput: Omit<TuiInput, "pluginHost"> = {
        url: existingUrl,
        async onSnapshot() {
          return [writeHeapSnapshot("tui.heapsnapshot")]
        },
        config,
        directory: cwd,
        reconnect: () => Daemon.ensure(args),
        args: {
          continue: args.continue,
          sessionID: args.session,
          agent: args.agent,
          model: args.model,
          prompt,
          fork: args.fork,
        },
      }
      if (runOverride) await runOverride(tuiInput as TuiInput)
      else {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(run({ ...tuiInput, pluginHost: createLegacyTuiPluginHost() }))
      }
      await printDaemonExitHint()
    } finally {
      try {
        unguard?.()
      } catch {}
    }
    process.exit(0)
  },
})

async function printDaemonExitHint() {
  const status = await Daemon.status()
  if (!status || (status.tuiClients === 0 && status.sessionActivity === 0)) return

  UI.println(
    UI.Style.TEXT_DIM + "Daemon still running: " + UI.Style.TEXT_NORMAL,
    [count(status.tuiClients, "TUI connection"), count(status.sessionActivity, "active session")].join(", "),
    UI.Style.TEXT_DIM + "- stop with",
    UI.Style.TEXT_INFO_BOLD + "opencode daemon stop" + UI.Style.TEXT_NORMAL,
  )
}

function count(value: number, label: string) {
  return `${value} ${label}${value === 1 ? "" : "s"}`
}

import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { UI } from "@/cli/ui"
import { errorMessage } from "@/util/error"
import { withNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import { validateSession } from "./validate-session"
import { Daemon } from "./daemon"

export const DAEMON_START_TIMEOUT_MS = Daemon.DAEMON_START_TIMEOUT_MS
export const SERVER_ELECTION_TIMEOUT_MS = Daemon.SERVER_ELECTION_TIMEOUT_MS
export const _spawn = Daemon._spawn
export const _setSpawn = Daemon._setSpawn

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
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

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

      await tui({
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
      })
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})

import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { Log } from "@/util"
import { errorMessage } from "@/util/error"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
import { validateSession } from "./validate-session"
import { ServerLock } from "@/cli/cmd/tui/server-lock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"

declare global {
  const OPENCODE_WORKER_PATH: string
}

// Exposed for testing only – do not call outside this module.
export const _spawn = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
  Bun.spawn(cmd, opts)

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return fileURLToPath(dist)
  return fileURLToPath(new URL("./worker.ts", import.meta.url))
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
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
    let electionLease: Awaited<ReturnType<typeof Flock.acquire>> | undefined
    let fwdReload: (() => void) | undefined
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
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const next = args.project
        ? Filesystem.resolve(path.isAbsolute(args.project) ? args.project : path.join(root, args.project))
        : Filesystem.resolve(process.cwd())
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      const env = sanitizedProcessEnv({
        [OPENCODE_PROCESS_ROLE]: "worker",
        [OPENCODE_RUN_ID]: ensureRunID(),
      })

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      // ── Server discovery ──────────────────────────────────────────────────
      // Fast path: no election lock needed when a server is clearly alive.
      const quickCheck = await ServerLock.read()
      const quickAlive =
        quickCheck && ServerLock.alive(quickCheck.pid) && (await ServerLock.ping(quickCheck.port))
      let existingUrl: string | null = quickAlive ? `http://127.0.0.1:${quickCheck!.port}` : null

      if (!existingUrl) {
        // Acquire an election lock so that concurrent TUI startups do not all
        // spawn a daemon at the same time (e.g. opening 4 tabs simultaneously).
        electionLease = await Flock.acquire("opencode.server", {
          dir: path.join(Global.Path.state, "locks"),
          timeoutMs: 10_000,
          staleMs: 5_000,
        })
        // Re-check under lock: another process may have won the race between
        // the fast-check and the lock acquisition.
        const lock = await ServerLock.read()
        existingUrl =
          lock && ServerLock.alive(lock.pid) && (await ServerLock.ping(lock.port))
            ? `http://127.0.0.1:${lock.port}`
            : null
        if (!existingUrl && lock) await ServerLock.clear()

        if (existingUrl) {
          // Slave path found under lock: release lease immediately.
          await electionLease.release()
          electionLease = undefined
        } else {
          // ── Spawn the daemon ──────────────────────────────────────────────
          const network = resolveNetworkOptionsNoConfig(args)
          const external =
            process.argv.includes("--port") ||
            process.argv.includes("--hostname") ||
            process.argv.includes("--mdns") ||
            network.mdns ||
            network.port !== 0 ||
            network.hostname !== "127.0.0.1"

          const daemonFile = await target()
          const printLogs = process.argv.includes("--print-logs")
          const proc = _spawn(
            [process.execPath, daemonFile],
            {
              env: {
                ...env,
                ...(printLogs ? { OPENCODE_PRINT_LOGS: "1" } : {}),
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
            },
          )
          proc.unref()

          // The daemon cannot possibly be ready within 1 s — skip the first
          // poll iterations to avoid pointless lock reads.
          await Bun.sleep(1000)

          // Wait for the daemon to write the lock and for its server to respond.
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline) {
            const daemonLock = await ServerLock.read()
            if (daemonLock && daemonLock.pid === proc.pid && ServerLock.alive(daemonLock.pid)) {
              if (external) {
                if (daemonLock.externalUrl) {
                  existingUrl = daemonLock.externalUrl
                  break
                }
              } else if (await ServerLock.ping(daemonLock.port)) {
                existingUrl = `http://127.0.0.1:${daemonLock.port}`
                break
              }
            }
            await Bun.sleep(200)
          }

          // Release election lease: daemon is live (or we are about to error).
          await electionLease.release()
          electionLease = undefined

          if (!existingUrl) {
            UI.error("opencode daemon failed to start within 30 seconds")
            proc.kill()
            return
          }

          // Forward SIGUSR2 (config reload) to the daemon (Unix only).
          if (process.platform !== "win32") {
            fwdReload = () => { try { proc.kill("SIGUSR2") } catch {} }
            process.on("SIGUSR2", fwdReload)
          }
        }
      }

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

      // Release election lease if still held from the slave path.
      if (electionLease) {
        await electionLease.release()
        electionLease = undefined
      }

      try {
        await tui({
          url: existingUrl!,
          async onSnapshot() {
            return [writeHeapSnapshot("tui.heapsnapshot")]
          },
          config,
          directory: cwd,
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
        if (fwdReload) {
          process.off("SIGUSR2", fwdReload)
          fwdReload = undefined
        }
      }
    } finally {
      await electionLease?.release().catch(() => undefined)
      unguard?.()
    }
    process.exit(0)
  },
})

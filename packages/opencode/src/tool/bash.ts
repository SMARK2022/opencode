import { Effect, Schema, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  BashDiagnosticCollector,
  bashCompressionMetadata,
  compressVisibleOutput,
  renderDiagnosticAppendix,
} from "./bash-compress"
import { InstanceState } from "@/effect"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const GIT_WRITES = new Set([
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "pull",
  "push",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
])
const GIT_STASH_WRITES = new Set(["push", "pop", "apply", "drop", "clear", "branch"])

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to execute" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
  }),
  description: Schema.String.annotate({
    description:
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
  }),
  compress_output: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether this Bash call may compress repetitive output before returning it. Defaults to the user's Bash output compression setting. Set false when exact raw formatting is important.",
  }),
})

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function gitSubcommand(tokens: string[]) {
  const name = tokens[0]?.toLowerCase().replace(/\.exe$/, "")
  if (name !== "git") return
  let skip = false
  for (const token of tokens.slice(1)) {
    if (skip) {
      skip = false
      continue
    }
    const lower = token.toLowerCase()
    if (lower === "-c" || lower === "--git-dir" || lower === "--work-tree" || lower === "--namespace") {
      skip = true
      continue
    }
    if (lower.startsWith("--git-dir=") || lower.startsWith("--work-tree=") || lower.startsWith("--namespace=")) continue
    if (lower.startsWith("-")) continue
    return lower
  }
}

function riskyGit(tokens: string[]) {
  const subcommand = gitSubcommand(tokens)
  if (!subcommand) return false
  if (subcommand === "stash") {
    const action = tokens.slice(2).map((item) => item.toLowerCase()).find((item) => !item.startsWith("-"))
    if (!action) return true
    return GIT_STASH_WRITES.has(action)
  }
  return GIT_WRITES.has(subcommand)
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function bashCompressionEnabled(config?: Config.Info) {
  return config?.tool_output?.bash_compression ?? true
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

const UNIX_TEXT_COMMANDS = new Set(["tail", "head", "sed", "awk", "grep"])

function shellGuidance(name: string) {
  if (process.platform !== "win32") return ""

  if (name === "powershell") {
    return [
      "PowerShell notes:",
      "- This shell is Windows PowerShell 5.1 unless configured otherwise.",
      "- Do NOT use Unix utilities such as tail, head, sed, awk, or grep. They are not PowerShell built-ins.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
      "- Do NOT use /dev/null. Use $null.",
      "- Do NOT use && or ||. Use `A; if ($?) { B }` when B depends on A succeeding.",
      "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
    ].join("\n")
  }

  if (name === "pwsh") {
    return [
      "PowerShell notes:",
      "- This shell is PowerShell 7+.",
      "- Bash-like && and || are supported, but Unix utilities such as tail/head/sed/awk/grep may still be unavailable.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- If shell text processing is truly required, use Get-Content -Tail, Select-String, Get-ChildItem, Test-Path, and $null.",
      "- Read environment variables with `$env:NAME`, not `export NAME=...`.",
    ].join("\n")
  }

  if (name === "cmd") {
    return [
      "Windows cmd notes:",
      "- Use cmd.exe syntax, not Bash or PowerShell syntax.",
      "- Use `dir` for directory listing and `type` for simple file output.",
      "- Do NOT use Unix utilities such as ls, tail, head, sed, awk, or grep.",
      "- Use dedicated tools for file operations: read, grep, glob, edit, write.",
      "- Use `NUL` for the null device, not `/dev/null`.",
    ].join("\n")
  }

  return [
    "Windows shell notes:",
    "- This shell may not support Unix utilities. Prefer dedicated OpenCode tools for file operations.",
  ].join("\n")
}

function listCommand(name: string) {
  if (process.platform !== "win32") return "`ls`"
  if (name === "powershell" || name === "pwsh") return "`Get-ChildItem`"
  if (name === "cmd") return "`dir`"
  return "the shell-native directory listing command"
}

function shellCompatibilityError(root: Node, shellName: string): string | undefined {
  if (process.platform !== "win32") return
  if (shellName !== "powershell" && shellName !== "pwsh" && shellName !== "cmd") return

  for (const node of commands(root)) {
    const command = parts(node)
    const raw = command[0]?.text
    if (!raw) continue
    const name = raw.toLowerCase().replace(/\.exe$/, "")

    if (UNIX_TEXT_COMMANDS.has(name)) {
      return [
        `The current shell is ${shellName}, but the command uses Unix utility \`${raw}\`.`,
        `Use OpenCode's dedicated tools instead: read for files, grep for content search, glob for file search.`,
        shellName === "powershell" || shellName === "pwsh"
          ? `If a shell command is truly required, use PowerShell equivalents such as Get-Content -Tail or Select-String.`
          : `If a shell command is truly required in cmd.exe, use cmd-native commands such as dir/type/findstr.`,
      ].join(" ")
    }

    if (shellName === "cmd" && name === "ls") {
      return `The current shell is cmd.exe, where \`ls\` is not native. Use read/glob for file listing, or \`dir\` only when a shell command is required.`
    }

    if ((shellName === "powershell" || shellName === "pwsh") && name === "find") {
      return `The current shell is ${shellName}; \`find\` is ambiguous on Windows. Use glob for file search or grep for content search.`
    }
  }
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const configService = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const instance = yield* InstanceState.context

    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("BashTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("BashTool.collect")(function* (root: Node, cwd: string, ps: boolean, shell: string) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && FILES.has(cmd)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          if (!riskyGit(tokens)) scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )

      // 兼容性修改：探测 Windows 平台并静默挂载 UTF-8 强控变量以解决管道读取乱码
      const isWin = process.platform === "win32"
      const utf8EnvOverrides = isWin ? {
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ""} -Dfile.encoding=UTF-8`.trim(),
        RUBYOPT: `${process.env.RUBYOPT || ""} -Eutf-8`.trim()
      } : {}

      return {
        ...process.env,
        ...utf8EnvOverrides,
        ...extra.env,
      }
    })

    const run = Effect.fn("BashTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
        compressOutput: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const started = Date.now()
      const diag = new BashDiagnosticCollector()

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              diag.push(chunk)

              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      diag.end()
      const durationMs = Date.now() - started
      const diagnosticSnapshot = diag.snapshot()

      const meta: string[] = []
      if (expired) {
        meta.push(
          `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")

      const compressed = compressVisibleOutput(raw, { enabled: input.compressOutput })
      const end = tail(compressed.text, limits.maxLines, limits.maxBytes)

      if (end.cut) cut = true

      if (!file && (end.cut || compressed.stats.applied)) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      const appendix = renderDiagnosticAppendix(diagnosticSnapshot, {
        durationMs,
        exitCode: code,
        visibleOutput: output,
      })

      if (appendix) {
        output += "\n\n" + appendix
      }

      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }

      if (sink) {
        const stream = sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          durationMs,
          diagnosticErrorLikeLines: diagnosticSnapshot.errorLikeLines,
          diagnosticWarningLikeLines: diagnosticSnapshot.warningLikeLines,
          ...bashCompressionMetadata(compressed.stats),
          ...((cut || compressed.stats.applied) && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* configService.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const chain =
          name === "powershell"
            ? "If commands depend on each other, do NOT use '&&' or '||'. Use `cmd1; if ($?) { cmd2 }`."
            : name === "pwsh"
              ? "If commands depend on each other, use `&&` when the second command should only run after the first succeeds. Use `;` only for unconditional sequencing."
              : name === "cmd"
                ? "If commands depend on each other, use `&&` for conditional sequencing in cmd.exe."
                : "If commands depend on each other, use a single shell call with '&&' to chain them together."
        log.info("bash tool using shell", { shell })

        const limits = yield* trunc.limits()
        const configInfo = yield* configService.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
        const userCompressionEnabled = bashCompressionEnabled(configInfo)
        const compressionGuidance = userCompressionEnabled
          ? [
              "  - Bash output compression is enabled by default. Repetitive output may be compacted before being returned, while the full raw output is still saved to a file when needed.",
              "  - Use `compress_output: false` for commands where exact raw formatting matters, such as snapshot tests, binary/text fixture generation, or commands whose spacing is the result.",
            ].join("\n")
          : ""

        return {
          description: DESCRIPTION.replaceAll("${directory}", instance.directory)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${shellGuidance}", shellGuidance(name))
            .replaceAll("${listCommand}", listCommand(name))
            .replaceAll("${maxLines}", String(limits.maxLines))
            .replaceAll("${maxBytes}", String(limits.maxBytes))
            .replaceAll("${compressionGuidance}", compressionGuidance),
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, Instance.directory, shell)
                : Instance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = Shell.ps(shell)
              const root = yield* parse(params.command, ps)
              const compatibility = shellCompatibilityError(root, name)
              if (compatibility) throw new Error(compatibility)
              const scan = yield* collect(root, cwd, ps, shell)
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
              yield* ask(ctx, scan)
              const configInfo = yield* configService.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
              const compressOutput = bashCompressionEnabled(configInfo) && (params.compress_output ?? true)

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                  compressOutput,
                },
                ctx,
              )
            }),
        }
      })
  }),
)

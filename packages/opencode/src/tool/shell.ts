import { Effect, Schema, Stream } from "effect"
import { PositiveInt } from "@/util/schema"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { createAutoTextDecoder, type TextEncodingMode } from "@/util/text-decoding"
import {
  BashDiagnosticCollector,
  bashCompressionMetadata,
  compressVisibleOutput,
  normalizePowerShellOutput,
  renderDiagnosticAppendix,
} from "./bash-compress"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
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
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
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
const UNIX_TEXT_COMMANDS = new Set(["tail", "head", "sed", "awk", "grep"])

function bashCompressionEnabled(config?: Config.Info) {
  return config?.tool_output?.bash_compression ?? true
}

function shellOutputEncoding(config?: Config.Info): TextEncodingMode {
  return config?.tool_output?.shell_encoding ?? "auto"
}

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

export const log = Log.create({ service: "shell-tool" })

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

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
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

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
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

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
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
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        psEncoded(command),
      ],
      {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
      },
    )
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

// PowerShell expects -EncodedCommand input as UTF-16LE. Keep native stderr as raw bytes:
// redirecting stream 2 here makes PowerShell decode legacy tools (javac/GBK) before our decoder can.
function psEncoded(command: string) {
  return Buffer.from(
    [
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
      "$ProgressPreference = 'SilentlyContinue'",
      "$InformationPreference = 'Continue'",
      "$WarningPreference = 'Continue'",
      "$VerbosePreference = 'Continue'",
      "$DebugPreference = 'Continue'",
      "& {",
      command,
      "} 3>&1 4>&1 5>&1 6>&1",
      "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }",
    ].join("\n"),
    "utf16le",
  ).toString("base64")
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

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const utf8Env = process.platform === "win32" ? { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } : {}
      return {
        ...process.env,
        ...utf8Env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
        compressOutput: boolean
        encoding: TextEncodingMode
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

      const decoder = createAutoTextDecoder({ encoding: input.encoding })
      const onChunk = (chunk: string) => {
        if (!chunk) return Effect.void
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
      }

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(handle.all, (bytes) => onChunk(decoder.write(bytes))).pipe(
              Effect.ensuring(Effect.suspend(() => onChunk(decoder.end()))),
            ),
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

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const normalized = process.platform === "win32" && Shell.ps(input.shell) ? normalizePowerShellOutput(raw) : raw
      diag.end()
      const diagnosticSnapshot = diag.snapshot()

      // Compress output if enabled
      const compressed = input.compressOutput
        ? compressVisibleOutput(normalized)
        : { text: normalized, stats: undefined as ReturnType<typeof compressVisibleOutput>["stats"] | undefined }

      const end = tail(input.compressOutput ? compressed.text : normalized, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(normalized)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      // Append diagnostic appendix for failed commands
      const appendix = renderDiagnosticAppendix(diagnosticSnapshot, {
        durationMs: Date.now() - started,
        exitCode: code,
        visibleOutput: output,
      })
      if (appendix) {
        output += "\n\n" + appendix
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
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

      const durationMs = Date.now() - started
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
          ...(compressed.stats ? bashCompressionMetadata(compressed.stats) : {}),
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits)
        log.info("shell tool using shell", { shell })

        const userCompressionEnabled = bashCompressionEnabled(cfg)
        const compressionGuidance = userCompressionEnabled
          ? [
              "  - Shell output compression is enabled by default. Repetitive output may be compacted before being returned, while the full raw output is still saved to a file when needed.",
              "  - Use `compress_output: false` for commands where exact raw formatting matters, such as snapshot tests, binary/text fixture generation, or commands whose spacing is the result.",
            ].join("\n")
          : ""

        const wsGuidance = shellGuidance(name)
        let description = prompt.description
        if (wsGuidance) description += "\n" + wsGuidance + "\n"
        if (compressionGuidance) description += "\n" + compressionGuidance + "\n"

        return {
          description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const executeInstance = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, executeInstance.directory, shell)
                : executeInstance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const compatibility = shellCompatibilityError(tree.rootNode, name)
                  if (compatibility) throw new Error(compatibility)
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, executeInstance)
                  if (!containsPath(cwd, executeInstance)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )

              const configInfo = yield* config.get().pipe(Effect.catch(() => Effect.succeed(undefined as Config.Info | undefined)))
              const compressOutput = bashCompressionEnabled(configInfo) && (params.compress_output ?? true)
              const encoding = shellOutputEncoding(configInfo)

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                  compressOutput,
                  encoding,
                },
                ctx,
              )
            }),
        }
      })
  }),
)

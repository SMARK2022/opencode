import { Effect, Fiber, Schema, Stream } from "effect"
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
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { PermissionPrecheck } from "@/permission/precheck"
import { createAutoTextDecoder, type TextEncodingMode } from "@/util/text-decoding"
import {
  BashDiagnosticCollector,
  bashCompressionMetadata,
  compressVisibleOutput,
  createTerminalDisplay,
  normalizePowerShellOutput,
  renderDiagnosticAppendix,
} from "./bash-compress"
import { formatExecutionNotice, formatOutputTruncatedNotice, outputStats } from "@/util/output-notice"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
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
  // Only include PowerShell names that expose new path effects. Aliases already
  // covered above stay there, while gci is needed so .ssh listings hit the same
  // external-directory and bash gates as Get-ChildItem.
  "get-content",
  "get-childitem",
  "gci",
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
// These commands carry an inner shell for another filesystem namespace. The
// local PowerShell/cmd compatibility checks and external_directory scanner must
// inspect the wrapper invocation itself, but must not reinterpret the payload's
// POSIX commands or guest paths as host Windows commands/paths.
const REMOTE_SHELL_COMMANDS = new Set(["ssh", "wsl"])
// WSL option names that consume the following token before the guest command
// starts. Keeping this list explicit prevents distro/user/cd values such as
// `Ubuntu-22.04` or `/tmp` from being mistaken for guest executable text.
const WSL_OPTIONS_WITH_VALUE = new Set(["-d", "--distribution", "-u", "--user", "--cd"])
// SSH option names that consume the following token before the remote host. The
// scanner only needs common option/value boundaries so it can keep local SSH
// options local while marking text after the host as remote shell payload.
const SSH_OPTIONS_WITH_VALUE = new Set(["-b", "-c", "-e", "-F", "-i", "-J", "-l", "-m", "-o", "-p", "-S", "-W"])

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
  raw: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

// Raw text tokens preserve source offsets from the original command line. Those
// offsets let `localCommands` filter parser-recovered payload commands without
// depending on a particular tree-sitter recovery shape for malformed WSL/SSH
// strings.
type Token = {
  text: string
  start: number
  end: number
}

type Range = {
  start: number
  end: number
}

type Segment = Range & {
  text: string
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

function permissionPattern(node: Node, tokens: string[]) {
  const command = tokens.join(" ")
  // Permission patterns are the rule-matching key, not raw shell evidence. POSIX
  // leading environment assignments are skipped by `parts()` so they cannot hide
  // the actual command from a rule like `git push --force*`. Redirection appears
  // as a parent suffix in bash and as a child node in PowerShell; in both cases it
  // remains part of the visible shell effect for redirect-specific rules.
  const redirect =
    node
      .descendantsOfType("redirection")
      .filter((item): item is Node => Boolean(item))
      .map((item) => item.text.trim())
      .join(" ") || redirectedSuffix(node)
  if (!redirect) return command
  return `${command} ${redirect}`
}

function rawPattern(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function redirectedSuffix(node: Node) {
  if (node.parent?.type !== "redirected_statement") return ""
  return node.parent.text.slice(node.endIndex - node.parent.startIndex).trim()
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
  const source = text.replace(/\r?\n$/, "")
  const lines = source.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
      hidden: "",
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
  const visible = out.join("\n")
  return {
    text: visible,
    cut: true,
    // tail 只展示末尾窗口；hidden 是同一个 source 中被窗口丢弃的前缀。
    // 后续诊断只扫描这段文本，避免从全量输出再反推“是否已经可见”。
    hidden: visible ? source.slice(0, Math.max(0, source.length - visible.length)) : source,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  metadata: { command: string; cwd: string; shell: string },
) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      // Auto 模式下，项目外路径访问不能先退回普通 ask；把同一次 shell
      // 命令证据传给 permission 层，让 dangerous payload 在 external_directory
      // 门禁 deterministic deny，其他外部路径则进入同一条 cautious review 边界。
      metadata: {
        action_kind: "shell",
        command: metadata.command,
        cwd: metadata.cwd,
        shell: metadata.shell,
        agent: ctx.agent,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    // [local-smark] auto permission preflight needs the exact shell action.
    // Patterns are user-facing approval summaries and can be split/reordered by
    // parsing; keep the raw command and resolved cwd here so future reviewers do
    // not infer security decisions from presentation strings.
    metadata: {
      action_kind: "shell",
      command: metadata.command,
      // raw_patterns is deny-only compatibility evidence. Canonical patterns
      // deliberately omit POSIX env assignments so `git push --force*` still
      // matches; the raw form remains available to explicit hard-deny rules
      // such as `GITHUB_TOKEN=*` without affecting allow/ask/auto routing.
      ...(scan.raw.size ? { raw_patterns: Array.from(scan.raw) } : {}),
      cwd: metadata.cwd,
      shell: metadata.shell,
      agent: ctx.agent,
    },
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
      // 默认静默 verbose/debug，避免 PowerShell 模块自动加载日志污染终端输出；用户仍可在命令内显式开启。
      "$VerbosePreference = 'SilentlyContinue'",
      "$DebugPreference = 'SilentlyContinue'",
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

  for (const node of localCommands(root)) {
    const command = parts(node)
    const raw = command[0]?.text
    if (!raw) continue
    const name = raw.toLowerCase().replace(/\.exe$/, "")

    if (UNIX_TEXT_COMMANDS.has(name)) {
      if (shellName === "powershell" || shellName === "pwsh") {
        return [
          `The current shell is ${shellName}, but the local command uses Unix utility \`${raw}\`.`,
          powershellUnixAlternative(name),
          `If the command is meant to run remotely, keep it inside the remote shell command instead of the local PowerShell pipeline.`,
        ].join(" ")
      }

      return [
        `The current shell is ${shellName}, but the command uses Unix utility \`${raw}\`.`,
        `Use OpenCode's dedicated tools instead: read for files, grep for content search, glob for file search.`,
        `If a shell command is truly required in cmd.exe, use cmd-native commands such as dir/type/findstr.`,
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

function localCommands(root: Node) {
  const remoteRanges = remotePayloadRanges(root.text)
  return commands(root).filter((node) => {
    if (remoteRanges.some((range) => range.start <= node.startIndex && node.startIndex < range.end)) return false
    let parent = node.parent
    while (parent && parent.id !== root.id) {
      // tree-sitter-powershell can recover POSIX fragments inside quoted WSL/ssh
      // arguments as commands under ERROR nodes; those are not local shell commands.
      if (parent.type === "ERROR") return false
      if (parent.type.includes("string")) return false
      parent = parent.parent
    }
    return true
  })
}

function remotePayloadRanges(command: string) {
  // Compute source ranges for remote/alternate-OS payloads before relying on the
  // parse tree. PowerShell recovery can surface commands from quoted payloads as
  // root-level commands, so parent-node checks alone cannot protect host scans.
  return commandSegments(command).flatMap((segment) => {
    const tokens = tokenizeLocalSegment(segment.text, segment.start)
    const cmd = (tokens[0]?.text ?? "").toLowerCase().replace(/\.exe$/, "")
    if (!REMOTE_SHELL_COMMANDS.has(cmd)) return []
    if (cmd === "wsl") return wslPayloadRange(tokens, segment.end)
    if (cmd === "ssh") return sshPayloadRange(tokens, segment.end)
    return []
  })
}

function commandSegments(command: string) {
  // Segmenting stops remote ranges at host shell separators while respecting
  // quotes. This keeps `wsl ... 'guest | grep'` inside the guest, but treats
  // `wsl ... 'guest' | grep` as a local pipeline after the WSL process exits.
  const result: Segment[] = []
  let start = 0
  let quote = ""
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === "`") i++
      else if (char === quote) quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    const paired = (char === "&" || char === "|") && command[i + 1] === char
    // These separators terminate the current host command segment. Single `|`
    // and `&` matter because `wsl ... 'guest' | grep x` in PowerShell and
    // `wsl ... "guest" & grep x` in cmd both have a guest command before the
    // separator and a local host command after it; the remote payload range must
    // stop before those local commands continue.
    if (char === "|" || char === "&" || char === ";" || char === "\n" || paired) {
      result.push({ start, end: i, text: command.slice(start, i) })
      start = i + (paired ? 2 : 1)
      if (paired) i++
    }
  }
  result.push({ start, end: command.length, text: command.slice(start) })
  return result
}

function tokenizeLocalSegment(command: string, offset: number) {
  // This is intentionally a tiny offset-preserving lexer, not a shell parser. It
  // only understands whitespace, simple quotes, and PowerShell backtick escapes
  // because the caller only needs wrapper names/options and payload boundaries.
  const result: Token[] = []
  for (let i = 0; i < command.length; i++) {
    if (/\s/.test(command[i])) continue
    const start = i
    if (command[i] === "'" || command[i] === '"') {
      const quote = command[i]
      let text = ""
      for (i++; i < command.length; i++) {
        if (command[i] === "`") {
          text += command[i + 1] ?? ""
          i++
          continue
        }
        if (command[i] === quote) break
        text += command[i]
      }
      result.push({ text, start: offset + start, end: offset + Math.min(i + 1, command.length) })
      continue
    }
    while (i + 1 < command.length && !/\s/.test(command[i + 1])) i++
    result.push({ text: command.slice(start, i + 1), start: offset + start, end: offset + i + 1 })
  }
  return result
}

function wslPayloadRange(tokens: Token[], end: number) {
  // WSL options are parsed here only to locate the guest command boundary. The
  // payload is not approved or interpreted by this scanner; once the boundary is
  // found, every recovered command inside it is excluded from host path and local
  // shell-compatibility checks so `/mnt/rescue` remains a guest path.
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].text.toLowerCase()
    if (token === "--" || token === "-e" || token === "--exec") return tokens[i + 1] ? [{ start: tokens[i + 1].start, end }] : []
    if (WSL_OPTIONS_WITH_VALUE.has(token)) {
      i++
      continue
    }
    if (token.startsWith("-")) continue
    return [{ start: tokens[i].start, end }]
  }
  return []
}

function sshPayloadRange(tokens: Token[], end: number) {
  // SSH has a local executable and local options followed by a remote host. Only
  // tokens after that host are remote shell text; keeping the host/options local
  // preserves existing permission prompts while preventing remote grep/cat paths
  // from being treated as Windows PowerShell commands or host external paths.
  const host = tokens.slice(1).findIndex((item, index, items) => {
    if (items[index - 1] && SSH_OPTIONS_WITH_VALUE.has(items[index - 1].text)) return false
    if (item.text === "--") return false
    return !item.text.startsWith("-")
  })
  if (host < 0) return []
  const start = host + 2
  return tokens[start] ? [{ start: tokens[start].start, end }] : []
}

function powershellUnixAlternative(name: string) {
  if (name === "head") return `For pipeline output, use \`Select-Object -First N\`; for files, prefer the read tool.`
  if (name === "tail") return `For pipeline output, use \`Select-Object -Last N\`; for files, prefer the read tool or \`Get-Content -Tail N\`.`
  if (name === "grep") return `For pipeline output, use \`Select-String\`; for workspace content search, prefer the grep tool.`
  if (name === "sed" || name === "awk") return `Use PowerShell string processing for local pipeline output, or run \`${name}\` inside a POSIX shell such as a remote ssh command.`
  return `Use PowerShell equivalents for local pipeline output.`
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeout = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

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
        const textPath = AppFileSystem.windowsPath(text)
        // PowerShell drive-relative paths like `C:../file` are scoped to the
        // shell's current location on that drive. Node resolves them against the
        // process-level per-drive cwd, which is unrelated to the command cwd and
        // can request the wrong external_directory. Permission scanning keeps the
        // visible command cwd as the only trust boundary while preserving absolute
        // drive paths such as `C:/file` and `C:\\file`.
        return AppFileSystem.normalizePath(path.resolve(root, Shell.ps(shell) ? textPath.replace(/^[A-Za-z]:(?![\\/])/, "") : textPath))
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
        raw: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of localCommands(root)) {
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
          const pattern = permissionPattern(node, tokens)
          scan.patterns.add(pattern)
          const raw = rawPattern(node)
          if (raw && raw !== pattern) scan.raw.add(raw)
          const always = BashArity.prefix(tokens)
          // Auto permission must never suggest broad wrapper or interpreter
          // allow-rules (for example `bash *`, `python -c *`, or `git *`). Those
          // prefixes can hide arbitrary follow-up behavior, so the UI should only
          // offer Always for concrete low-risk commands that precheck can later
          // evaluate with the same visible prefix.
          if (PermissionPrecheck.canAlwaysAllowPrefix(always)) scan.always.add(always.join(" ") + " *")
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
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      const started = Date.now()
      const hiddenDiag = new BashDiagnosticCollector()

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const decoder = createAutoTextDecoder({ encoding: input.encoding })
      const display = createTerminalDisplay({ maxLines: limits.maxLines, maxChars: MAX_METADATA_LENGTH })
      let displayed = false
      const onChunk = (chunk: string) => {
        if (!chunk) return Effect.void
        const visible = preview(display.push(chunk))
        displayed = true
        const size = Buffer.byteLength(chunk, "utf-8")
        list.push({ text: chunk, size })
        used += size
        while (used > keep && list.length > 1) {
          const item = list.shift()
          if (!item) break
          // 这些 chunk 已经被内存窗口丢弃，最终不会进入模型可见输出。
          // 诊断摘录只从隐藏输出生成，避免和 exit notice 或可见输出互相推断。
          hiddenDiag.push(item.text)
          used -= item.size
          cut = true
        }
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
                    // `metadata.output` is the default live UI surface. Keep it
                    // as a terminal display snapshot so CR progress and clear-line
                    // redraws do not leak control bytes into TUI/OpenTUI, while the
                    // raw chunks below still feed truncation and the model output.
                    output: visible,
                    description: input.description,
                  },
                }),
              ),
            )
          }
        }

        return ctx.metadata({
          metadata: {
            // Same invariant as the truncated branch above: metadata is the
            // default display channel, not the faithful model-return channel. An
            // empty terminal screen after a clear-line/clear-screen sequence is a
            // valid display state, so never fall back to the raw chunk preview here.
            output: visible,
            description: input.description,
          },
        })
      }

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          const output = yield* Effect.forkScoped(
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

          // 子进程 close 只说明 OS 管道已关闭，不代表 Effect stream 已经处理完
          // 已缓冲的最后几个 chunk 或它们触发的 metadata 更新。最终输出、截断、
          // 诊断摘要都必须在输出消费完成后组装，否则 Linux 上 fast-exit 命令
          // 会偶发丢尾部输出并把错误上下文误判为仍然可见。
          yield* Fiber.join(output)

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          formatExecutionNotice({ severity: "warning", reason: "timeout", timeout_ms: input.timeout }),
        )
      }
      if (aborted) meta.push(formatExecutionNotice({ severity: "warning", reason: "user_abort" }))
      const raw = list.map((item) => item.text).join("")
      const normalized = process.platform === "win32" && Shell.ps(input.shell) ? normalizePowerShellOutput(raw) : raw
      const normalizedStats = outputStats(normalized)

      // Compress output if enabled
      const compressed = input.compressOutput
        ? compressVisibleOutput(normalized)
        : { text: normalized, stats: undefined as ReturnType<typeof compressVisibleOutput>["stats"] | undefined }

      const end = tail(input.compressOutput ? compressed.text : normalized, limits.maxLines, limits.maxBytes)
      if (end.cut) {
        cut = true
        hiddenDiag.push(end.hidden)
      }
      if (!file && end.cut) {
        file = yield* trunc.write(normalized)
      }
      hiddenDiag.end()
      const diagnosticSnapshot = hiddenDiag.snapshot()

      const emptyOutput = end.text.length === 0
      let output = emptyOutput ? "(no output)" : end.text

      if (cut && file) {
        output =
          formatOutputTruncatedNotice({
            source: "shell",
            total: normalizedStats,
            shown: { direction: "tail", ...outputStats(output) },
            path: file,
          }) +
          "\n\n" +
          output
      }

      // Append diagnostic appendix for failed commands. The snapshot only contains
      // text omitted by the final output window, so any rendered excerpt is a
      // genuinely missing signal rather than a duplicate of visible output.
      const diagnosticAppendix = renderDiagnosticAppendix(diagnosticSnapshot, {
        durationMs: Date.now() - started,
        exitCode: code,
      })
      if (diagnosticAppendix) {
        output += "\n\n" + diagnosticAppendix
      }

      // metadata.exit 已经保存结构化退出码，但 state.metadata 不会作为工具输出回放给模型。
      // exit notice 只描述进程如何结束；它和隐藏输出诊断互相独立，不能互相抑制。
      // 这里刻意不回放命令文本、环境变量或原始 metadata，保持模型可见信息的最小安全边界。
      const exitNotice =
        code === null
          ? undefined
        : emptyOutput
            ? formatExecutionNotice({
                severity: code === 0 ? "info" : "error",
                reason: "exit",
                exit_code: code,
              })
            : code !== 0
              ? formatExecutionNotice({ severity: "error", reason: "exit", exit_code: code })
              : undefined
      if (exitNotice) meta.push(exitNotice)

      if (meta.length > 0) {
        output += "\n\n" + meta.join("\n")
      }
      const durationMs = Date.now() - started
      const displayOutput = preview(display.value())
      return {
        title: input.description,
        metadata: {
          // Completion metadata preserves the final terminal screen for default
          // UI rendering. The `output` field returned alongside this metadata is
          // intentionally left on the existing raw/compressed/truncated path so
          // right-click "model context output" and provider input stay unchanged.
          output: displayed ? displayOutput : preview(output),
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
              "  - Shell output compression follows the user's default and is strongly recommended for normal commands; repetitive output, oversized lines, and terminal progress noise may be compacted.",
              "  - Strongly prefer leaving `compress_output` omitted; set false only for exact raw formatting. Truncated output includes a compact notice and recovery path.",
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
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeout
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  // [local-smark] shell compatibility check
                  const compatibility = shellCompatibilityError(tree.rootNode, name)
                  if (compatibility) throw new Error(compatibility)
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, { command: params.command, cwd, shell: name })
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

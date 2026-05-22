export type Decision =
  | { action: "allow"; reason: string }
  | { action: "prompt"; reason: string }
  | { action: "deny"; reason: string }

// Wrappers return either a script we can inspect for critical deny patterns or
// an explicit `ask` result when the wrapper is too open-ended to inspect. These
// helper result types intentionally do not include `allow`: wrapper execution is
// never safe enough for deterministic approval by itself.
type UnwrapResult = { action: "script"; script: string; reason: string } | { action: "ask"; reason: string } | { action: "none" }
type RemoteResult = { action: "remote"; script?: string; reason: string } | { action: "none" }

// Permission precheck is the deterministic, non-LLM classifier that runs before
// the optional reviewer. Keep the boundary intentionally narrow:
// - `allow`: direct, plainly read-only commands with no dynamic shell behavior.
// - `prompt`: destructive, state-changing, wrapper-based, remote, interpreter,
//   dynamic, or otherwise opaque commands that are not visibly critical.
// - `deny`: visible critical payloads where prompting would teach or encourage
//   retries through shell indirection, generated scripts, MCP tools, or another
//   bypass. Every new allow rule must preserve that fail-closed invariant.

// POSIX shell wrappers are treated as containers for another script. We inspect
// `-c`/`-lc` payloads only to find critical denials, then still return prompt so
// users do not accidentally grant a broad future rule like `bash *`.
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"])

// PowerShell has several command-entry surfaces (`-Command`, `-EncodedCommand`,
// aliases, providers) and can hide filesystem/network effects behind strings.
// Decoded payloads are scanned for critical denials, but all PowerShell wrapper
// usage remains prompt-only unless an earlier raw critical regex denies it.
const POWERSHELL_WRAPPERS = new Set(["pwsh", "powershell", "powershell.exe"])

// Remote and alternate-OS wrappers cross a trust boundary. Even apparently
// read-only commands can touch remote credentials, SSH config, WSL mounts, or
// another filesystem namespace, so the deterministic layer never auto-allows
// them. Payload extraction exists only to catch visible critical commands.
const REMOTE_WRAPPERS = new Set(["ssh", "ssh.exe", "wsl", "wsl.exe"])

// Interpreter eval flags are high-leverage escape hatches. For example,
// `python -c`, `node -e`, or `ruby -e` can synthesize shell commands, paths, and
// network calls that token-level parsing cannot understand. Raw scanning catches
// obvious critical payloads; all non-critical eval forms route to reviewer/user.
const INTERPRETER_FLAGS = new Map([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["py", new Set(["-3", "-c"])],
  ["node", new Set(["-e"])],
  ["perl", new Set(["-e"])],
  ["ruby", new Set(["-e"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
])
// Sensitive paths are prompt-only when read locally and deny-only when the same
// path is visibly piped/uploaded to a network or remote target. This regex is a
// guardrail, not a secret scanner: keep it specific enough to avoid blocking
// ordinary project files while still catching common credentials and key names.
const SENSITIVE_PATH_PATTERN = String.raw`(?:\.env(?:\.[^\s|;]+)?|~\/\.ssh\/[^\s|;]+|~\/\.aws\/credentials|~\/\.config\/gcloud\/[^\s|;]+|~\/\.kube\/config|~\/\.npmrc|~\/\.netrc|~\/\.git-credentials|credentials\.json|id_rsa|id_ed25519|[^\s|;]+\.pem|[^\s|;]+\.key)`

// These prefixes are too broad to suggest as "always allow" rules from the shell
// tool. The list mirrors the wrapper/interpreter/remote classifications below:
// granting any exact prefix here would authorize arbitrary future payload text
// that precheck never saw when the user clicked Always.
const BANNED_AUTO_ALLOW_PREFIXES = [
  // Shell wrappers can conceal future scripts behind `-c`, `-lc`, or arguments.
  ["bash"],
  ["bash", "-c"],
  ["bash", "-lc"],
  ["/bin/bash"],
  ["/bin/bash", "-lc"],
  ["sh"],
  ["sh", "-c"],
  ["sh", "-lc"],
  ["/bin/sh"],
  ["/bin/sh", "-c"],
  ["zsh"],
  ["zsh", "-c"],
  ["zsh", "-lc"],
  ["/bin/zsh"],
  ["/bin/zsh", "-lc"],
  ["dash"],
  ["fish"],
  ["ksh"],
  // Script interpreters and package executors can generate filesystem/network
  // side effects from opaque source code or dependency resolution.
  ["python"],
  ["python", "-c"],
  ["python3"],
  ["python3", "-c"],
  ["py"],
  ["py", "-3"],
  ["pythonw"],
  ["pyw"],
  ["pypy"],
  ["pypy3"],
  ["node"],
  ["node", "-e"],
  ["deno"],
  ["bun"],
  ["bun", "x"],
  ["perl"],
  ["perl", "-e"],
  ["ruby"],
  ["ruby", "-e"],
  ["php"],
  ["php", "-r"],
  ["lua"],
  ["lua", "-e"],
  ["osascript"],
  // Privilege and environment wrappers can change the effective user, PATH, or
  // target namespace, so an allow prefix would be broader than the shown call.
  ["sudo"],
  ["doas"],
  ["su"],
  ["pkexec"],
  ["env"],
  // VCS prefixes are banned at the top level because many subcommands mutate
  // refs, history, remotes, or the working tree; safe subcommands are allowed as
  // concrete command patterns rather than via `git *`.
  ["git"],
  // Branch names and branch flags can create, delete, copy, or rename refs, so
  // `git branch *` is too broad even though specific read-only branch queries are
  // still eligible for deterministic allow.
  ["git", "branch"],
  ["hg"],
  ["svn"],
  // PowerShell/cmd/remote wrappers need command-string-specific review.
  ["pwsh"],
  ["pwsh", "-command"],
  ["pwsh", "-c"],
  ["pwsh", "-encodedcommand"],
  ["pwsh", "-enc"],
  ["powershell"],
  ["powershell", "-command"],
  ["powershell", "-c"],
  ["powershell", "-encodedcommand"],
  ["powershell", "-enc"],
  ["powershell.exe"],
  ["powershell.exe", "-command"],
  ["powershell.exe", "-c"],
  ["powershell.exe", "-encodedcommand"],
  ["ssh"],
  ["wsl"],
  ["cmd"],
  ["cmd", "/c"],
  ["cmd", "/k"],
  // Remote file transfer tools can move credentials or publish artifacts; safe
  // reads should use dedicated read/glob/grep tools instead of an always rule.
  ["scp"],
  ["sftp"],
  ["rsync"],
]

export function evaluate(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision {
  // Only bash permission currently has enough syntactic evidence for precheck.
  // Other tools intentionally fall through to prompt/user approval instead of
  // guessing about unrelated argument schemas.
  if (input.permission !== "bash") return { action: "prompt", reason: "precheck only has bash coverage" }
  return evaluateShell(typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "), 0)
}

export function canAlwaysAllowPrefix(tokens: string[]) {
  // Prefixes come from the shell parser's arity calculation, not from this
  // hand-rolled classifier. Normalize command names the same way as evaluation
  // so `wsl.exe`, `/bin/bash`, and case variants cannot escape the ban list.
  const normalized = tokens.map((item, index) => (index === 0 ? normalizeCommandName(item) : item.toLowerCase()))
  return !BANNED_AUTO_ALLOW_PREFIXES.some(
    (prefix) => prefix.length === normalized.length && prefix.every((item, index) => item === normalized[index]),
  )
}

function evaluateShell(command: string, depth: number): Decision {
  // Recursion only follows wrapper payloads we extracted as plain text. A depth
  // cap keeps malformed or adversarial nested wrappers from consuming time while
  // preserving the fail-safe behavior: prompt instead of allow.
  if (depth > 4) return { action: "prompt", reason: "nested shell wrapper requires explicit approval" }
  if (!command.trim()) return { action: "prompt", reason: "empty shell command requires explicit approval" }

  // Raw scanning runs before token splitting so critical payloads hidden behind
  // command substitution, redirection, wrapper strings, or invalid syntax still
  // fail closed instead of being downgraded to a generic prompt.
  const danger = dangerousRaw(command)
  if (danger) return { action: "deny", reason: danger }

  const commands = splitCommands(command)
  if (!commands) return { action: "prompt", reason: "opaque shell command requires explicit approval" }

  const decisions = commands.map((item) => evaluateCommand(item, depth))
  const deny = decisions.find((item) => item.action === "deny")
  if (deny) return deny
  if (decisions.every((item) => item.action === "allow")) return { action: "allow", reason: "known read-only shell command" }
  return decisions.find((item) => item.action === "prompt") ?? { action: "prompt", reason: "unknown shell command" }
}

function evaluateCommand(command: string, depth: number): Decision {
  const tokens = tokenize(command)
  if (!tokens) return { action: "prompt", reason: "unable to tokenize shell command" }
  if (tokens.length === 0) return { action: "prompt", reason: "empty shell command requires explicit approval" }

  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") {
    const decision = evaluateShell(unwrapped.script, depth + 1)
    if (decision.action === "deny") return decision
    return { action: "prompt", reason: unwrapped.reason }
  }
  if (unwrapped.action === "ask") return { action: "prompt", reason: unwrapped.reason }

  const remote = remoteWrapper(tokens)
  if (remote.action === "remote") {
    if (remote.script) {
      const decision = evaluateShell(remote.script, depth + 1)
      if (decision.action === "deny") return decision
    }
    return { action: "prompt", reason: remote.reason }
  }

  const risk = riskyTokens(tokens)
  if (risk) return risk
  if (safeTokens(tokens)) return { action: "allow", reason: "known read-only shell command" }
  return { action: "prompt", reason: "unknown shell command" }
}

function splitCommands(command: string) {
  // This splitter intentionally recognizes only the simple separators that can
  // compose already-safe commands. Any dynamic expansion, redirection, glob, or
  // malformed empty segment returns undefined so the caller prompts. This avoids
  // approving `git status &&` or `| git status` after filtering away the empty
  // side of the separator.
  const out: string[] = []
  let start = 0
  let quote = ""
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      // Double-quoted shell fragments may still expand variables or execute
      // substitutions. Treat them as opaque instead of approving literal text.
      else if (quote !== "'" && (char === "$" || char === "`")) return
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "$" || char === "`" || char === "(" || char === ")" || char === "{" || char === "}") return
    if (char === ">" || char === "<" || char === "*" || char === "?" || char === "[") return

    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      const segment = command.slice(start, i).trim()
      if (!segment) return
      out.push(segment)
      i++
      start = i + 1
      continue
    }
    if (char === ";" || char === "|") {
      const segment = command.slice(start, i).trim()
      if (!segment) return
      out.push(segment)
      start = i + 1
    }
  }

  if (quote || escaped) return
  const segment = command.slice(start).trim()
  if (!segment) return
  out.push(segment)
  return out
}

function tokenize(command: string) {
  // Tokenization is deliberately smaller than a full shell parser. It preserves
  // quoted spaces and escaped characters for path-like arguments, but malformed
  // quotes or dangling escapes force prompt instead of trying to repair input.
  const out: string[] = []
  let current = ""
  let quote = ""
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) out.push(current)
      current = ""
      continue
    }
    current += char
  }

  if (quote || escaped) return
  if (current) out.push(current)
  return out
}

function unwrap(tokens: string[]): UnwrapResult {
  // Wrapper handling is ordered from most shell-like to interpreter-like. Any
  // wrapper that exposes a plain script returns that script for recursive deny
  // scanning; the wrapper itself still requires prompt because future arguments
  // could execute arbitrary code.
  const cmd = normalizeCommandName(tokens[0])
  if (SHELL_WRAPPERS.has(cmd)) {
    const index = tokens.findIndex((item, i) => i > 0 && ["-c", "-lc"].includes(item))
    if (index >= 0 && tokens[index + 1]) {
      return { action: "script", script: tokens[index + 1], reason: "shell wrapper requires explicit approval" }
    }
    return { action: "ask", reason: "shell wrapper without a plain script requires explicit approval" }
  }

  if (POWERSHELL_WRAPPERS.has(cmd)) {
    const encoded = tokens.findIndex((item, i) => i > 0 && ["-encodedcommand", "-enc"].includes(item.toLowerCase()))
    if (encoded >= 0 && tokens[encoded + 1]) {
      const script = decodePowerShell(tokens[encoded + 1])
      if (script) return { action: "script", script, reason: "PowerShell encoded command requires explicit approval" }
      return { action: "ask", reason: "PowerShell encoded command requires explicit approval" }
    }

    const index = tokens.findIndex((item, i) => i > 0 && ["-command", "-c"].includes(item.toLowerCase()))
    if (index >= 0 && tokens[index + 1]) {
      return { action: "script", script: tokens[index + 1], reason: "PowerShell wrapper requires explicit approval" }
    }
    return { action: "ask", reason: "PowerShell wrapper without a plain script requires explicit approval" }
  }

  if (cmd === "cmd") {
    const index = tokens.findIndex((item, i) => i > 0 && ["/c", "/k"].includes(item.toLowerCase()))
    if (index >= 0 && tokens[index + 1]) {
      return { action: "script", script: joinShellTokens(tokens.slice(index + 1)), reason: "cmd wrapper requires explicit approval" }
    }
    return { action: "ask", reason: "cmd wrapper without a plain script requires explicit approval" }
  }

  const evalFlags = INTERPRETER_FLAGS.get(cmd)
  if (evalFlags && tokens.some((item) => evalFlags.has(item))) {
    return { action: "ask", reason: "interpreter eval command requires explicit approval" }
  }
  if (["pythonw", "pyw", "pypy", "pypy3", "deno", "osascript"].includes(cmd)) {
    return { action: "ask", reason: "script interpreter requires explicit approval" }
  }
  if (cmd === "bun" && tokens[1] === "x") return { action: "ask", reason: "package executor requires explicit approval" }
  if (cmd === "env") return { action: "ask", reason: "env wrapper requires explicit approval" }
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  return { action: "none" }
}

function remoteWrapper(tokens: string[]): RemoteResult {
  // Remote wrappers are separated from local unwraps so their reason remains a
  // trust-boundary prompt even when no script payload is available to inspect.
  const cmd = normalizeCommandName(tokens[0])
  if (!REMOTE_WRAPPERS.has(cmd)) return { action: "none" }
  if (cmd === "wsl") {
    const script = wslScript(tokens)
    return { action: "remote", script, reason: "alternate OS environment requires explicit approval" }
  }

  const script = sshScript(tokens)
  return { action: "remote", script, reason: "remote shell execution requires explicit approval" }
}

function sshScript(tokens: string[]) {
  // SSH options may consume the next token before the host. Walk past known
  // option/value pairs so a remote command like `ssh -p 22 host rm -rf /` is
  // still visible to the critical scanner.
  const optionsWithValue = new Set(["-b", "-c", "-e", "-F", "-i", "-J", "-l", "-m", "-o", "-p", "-S", "-W"])
  const host = tokens.slice(1).findIndex((item, index, items) => {
    if (items[index - 1] && optionsWithValue.has(items[index - 1])) return false
    if (item === "--") return false
    return !item.startsWith("-")
  })
  if (host < 0) return
  const start = host + 2
  if (!tokens[start]) return
  return tokens.slice(start).join(" ")
}

function wslScript(tokens: string[]) {
  // WSL accepts either explicit `--exec` payloads or a command after distro/user
  // options. Extract only the visible payload; absence still prompts because WSL
  // starts an alternate OS shell outside this classifier's trust boundary.
  const optionsWithValue = new Set(["-d", "--distribution", "-u", "--user", "--cd"])
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === "--" || tokens[i] === "-e" || tokens[i] === "--exec") {
      return tokens[i + 1] ? joinShellTokens(tokens.slice(i + 1)) : undefined
    }
    if (optionsWithValue.has(tokens[i])) {
      i++
      continue
    }
    if (tokens[i].startsWith("-")) continue
    return joinShellTokens(tokens.slice(i))
  }
}

function dangerousRaw(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  // Raw scanning is deliberately narrow: it catches critical payloads hidden in
  // opaque shell features while all non-critical ambiguity falls back to ask.
  // Protected-root recursive deletion is fail-closed before tokenization so
  // `$HOME`, `~/`, `/*`, and wrapper-quoted forms cannot bypass the deny path.
  if (
    new RegExp(
      String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))(?=[^|;]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?(?=[\s)'"]|$)|~\/?(?=[\s)'"]|$)|\$HOME\/?(?=[\s)'"]|$)|\/etc(?:\/|(?=[\s)'"]|$)))`,
    ).test(normalized)
  ) {
    return "critical recursive delete"
  }
  // Remote downloads piped directly to interpreters execute unreviewed network
  // bytes as code. Privilege/env wrappers are included because they are common
  // install-script indirections and should not downgrade to prompt.
  if (/\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i.test(normalized)) {
    return "remote download piped to interpreter"
  }
  // PowerShell aliases for web download plus `iex` are equivalent to curl|sh.
  if (/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i.test(normalized)) {
    return "remote PowerShell download executed as code"
  }
  // Credential exfiltration is critical only when a sensitive read is visibly
  // connected to a network transfer. Direct reads stay prompt-only in safeTokens.
  if (new RegExp(String.raw`\b(?:cat|type|Get-Content|gc)\s+${SENSITIVE_PATH_PATTERN}[^|;]*\|\s*(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`, "i").test(normalized)) {
    return "credential read piped to network transfer"
  }
  // Upload flags that reference sensitive files are treated as exfiltration even
  // without a pipe because the file is the outbound request body/form/upload.
  if (new RegExp(String.raw`\b(?:curl|wget)\b(?=.*(?:--data(?:-binary|-raw)?|-d|--form|-F|--upload-file|--form-string|-T)\s+@?${SENSITIVE_PATH_PATTERN})`).test(normalized)) {
    return "credential file sent with network transfer"
  }
  // `scp`, `sftp`, and `rsync` use `host:path` syntax rather than pipes/flags.
  if (new RegExp(String.raw`\b(?:scp|rsync|sftp)\b(?=.*${SENSITIVE_PATH_PATTERN})(?=.*:)`).test(normalized)) {
    return "credential file sent with remote transfer"
  }
  // Common interpreter APIs and reverse shell idioms are scanned as raw text
  // because their dangerous target may be inside strings rather than tokens.
  if (/\bRemove-Item\b(?=.*\s-Recurse\b)(?=.*\s-Force\b)(?=.*\s(?:\/|~\/?|\$HOME\/?|[A-Za-z]:[\\/]?)(?=[\s)'"]|$))/i.test(normalized)) {
    return "critical PowerShell recursive delete"
  }
  if (/\bshutil\.rmtree\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) return "critical Python recursive delete"
  if (/\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) return "critical Python file removal"
  if (/(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    return "critical Node.js file removal"
  }
  if (/\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    return "critical recursive delete through interpreter"
  }
  if (/\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^|;]*(?:\s-e\s|\s--exec\s|\s--sh-exec\s)|\bsocat\b[^|;]*EXEC:|bash\s+-i\s+>&\s+\/dev\/tcp\//i.test(normalized)) {
    return "reverse shell pattern"
  }
}

function riskyTokens(tokens: string[]): Decision | undefined {
  // Token-level risks are visible commands with known side effects. Critical
  // protected targets deny; otherwise destructive-but-bounded operations prompt
  // so explicit user approval or reviewer policy can decide.
  const cmd = normalizeCommandName(tokens[0])
  if (cmd === "rm" && hasRecursiveForceDeleteFlags(tokens.slice(1))) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      return { action: "deny", reason: "critical recursive delete" }
    }
    return { action: "prompt", reason: "recursive force delete requires explicit approval" }
  }
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/"))) return { action: "deny", reason: "raw disk write" }
  if (["mkfs", "mkfs.ext4", "fdisk", "parted", "wipefs", "shutdown", "reboot", "halt", "poweroff"].includes(cmd)) {
    return { action: "deny", reason: "system destructive command" }
  }
  if (cmd === "git" && tokens[1] === "reset" && tokens.includes("--hard")) {
    return { action: "prompt", reason: "destructive git reset requires explicit approval" }
  }
  if (cmd === "git" && tokens[1] === "clean" && tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d"))) {
    return { action: "prompt", reason: "destructive git clean requires explicit approval" }
  }
  if (cmd === "git" && tokens[1] === "push" && tokens.some((item) => item === "--force" || item === "-f")) {
    return { action: "prompt", reason: "force push requires explicit approval" }
  }
  if (cmd === "chmod" && tokens.some((item) => item === "777" || item === "-R")) {
    return { action: "prompt", reason: "permission widening requires explicit approval" }
  }
  if (cmd === "chown" && tokens.some((item) => item.includes("root"))) {
    return { action: "prompt", reason: "root ownership change requires explicit approval" }
  }
  if (cmd === "remove-item" && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      return { action: "deny", reason: "critical PowerShell recursive delete" }
    }
    return { action: "prompt", reason: "recursive PowerShell delete requires explicit approval" }
  }
  if (["scp", "sftp", "rsync"].includes(cmd)) return { action: "prompt", reason: "remote file transfer requires explicit approval" }
}

function joinShellTokens(tokens: string[]) {
  // Reconstruct cmd/WSL payloads for recursive raw scanning without reusing the
  // original command text. Quoting keeps spaces intact and avoids inventing new
  // separators while still surfacing dangerous substrings to `dangerousRaw`.
  return tokens.map((item) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`)).join(" ")
}

function decodePowerShell(input: string) {
  // PowerShell encoded commands are UTF-16LE base64. Decode failures are prompt
  // rather than deny because opaque encoded text is risky but not evidence of a
  // specific critical payload.
  try {
    return Buffer.from(input, "base64").toString("utf16le").replace(/^\uFEFF/, "")
  } catch {
    return
  }
}

function hasRecursiveForceDeleteFlags(tokens: string[]) {
  // `rm` accepts recursive/force as combined short flags (`-rf`, `-fr`), split
  // short flags (`-r -f`, `-R -f`), or long flags. Treat the pair as equivalent
  // before checking protected targets so option spelling cannot downgrade a root
  // delete from deny to prompt.
  return tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item)) && tokens.some((item) => item === "--force" || /^-[^-]*f/.test(item))
}

function protectedDeleteTarget(input: string) {
  // Protected roots cover local POSIX roots, common home aliases, Windows drive
  // roots, and `/etc`. These are the cases where recursive deletion is treated
  // as critical instead of merely destructive.
  const normalized = input.replaceAll("\\", "/")
  return (
    normalized === "/" ||
    normalized === "/*" ||
    normalized === "/." ||
    normalized === "~" ||
    normalized === "~/" ||
    normalized === "$HOME" ||
    normalized === "$HOME/" ||
    normalized === "$env:USERPROFILE" ||
    normalized === "$env:USERPROFILE/" ||
    /^\w:\/?$/.test(normalized) ||
    normalized === "/etc" ||
    normalized.startsWith("/etc/")
  )
}

function safeTokens(tokens: string[]) {
  // Safe commands must be direct, local, and read-only. Sensitive path reads are
  // excluded before command-specific checks so `cat .env` prompts even though
  // `cat README.md` is otherwise a safe file read.
  const cmd = normalizeCommandName(tokens[0])
  if (hasSensitivePath(tokens)) return false
  if (["pwd", "whoami", "id", "uname", "which", "ls", "cat", "head", "wc", "file", "stat", "grep"].includes(cmd)) return true
  if (cmd === "tail") return !tokens.some((item) => item === "-f" || item === "--follow")
  if (cmd === "rg") return !tokens.some((item) => ["--pre", "--hostname-bin", "--search-zip", "-z"].includes(item))
  if (cmd === "find") return !tokens.some((item) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint"].includes(item))
  if (cmd === "sed") return tokens.length <= 4 && tokens[1] === "-n" && /^\d+(?:,\d+)?p$/.test(tokens[2] ?? "")
  if (cmd === "git") return gitSafe(tokens)
  if (["npm", "pnpm", "yarn"].includes(cmd)) return ["ls", "list", "view", "info", "why", "outdated"].includes(tokens[1])
  return versionSafe(tokens)
}

function gitSafe(tokens: string[]) {
  // Only read-only git subcommands are safe. Global flags that alter config,
  // worktrees, or execution path are rejected because they can redirect a safe
  // subcommand into another repository or helper.
  const unsafeGlobal = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"])
  const safe = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"])
  for (let i = 1; i < tokens.length; i++) {
    if (unsafeGlobal.has(tokens[i]) || Array.from(unsafeGlobal).some((item) => tokens[i].startsWith(item + "="))) return false
    if (tokens[i] === "remote") return tokens[i + 1] === "-v"
    if (tokens[i] === "config") return tokens[i + 1] === "--get" || tokens[i + 1] === "--list"
    if (tokens[i] === "branch") return gitBranchSafe(tokens.slice(i + 1))
    if (!tokens[i].startsWith("-")) return safe.has(tokens[i])
  }
  return false
}

function gitBranchSafe(args: string[]) {
  // `git branch` is both a read-only listing command and a ref mutation command.
  // Only allow no-argument listing and flags that query branch state without
  // accepting a branch name target.
  const allowed = new Set(["--show-current", "--list", "-l", "--all", "-a", "--remotes", "-r", "-v", "-vv"])
  return args.every((item) => allowed.has(item))
}

function versionSafe(tokens: string[]) {
  // Version probes are safe for common runtimes/package managers, but only when
  // every argument is a version flag so no package install/run form is hidden.
  const cmd = normalizeCommandName(tokens[0])
  if (!["node", "python", "python3", "bun", "npm", "pnpm", "yarn"].includes(cmd)) return false
  return tokens.length > 1 && tokens.slice(1).every((item) => item === "--version" || item === "-v" || item === "-V")
}

function hasSensitivePath(tokens: string[]) {
  // This mirrors SENSITIVE_PATH_PATTERN for tokenized direct reads. Keep both in
  // sync: raw patterns catch exfiltration syntax, token patterns downgrade local
  // secret reads from allow to prompt.
  return tokens.slice(1).some((item) => {
    const normalized = item.replaceAll("\\", "/")
    return (
      normalized === ".env" ||
      normalized.startsWith(".env.") ||
      normalized.includes("/.env") ||
      normalized.includes("/.ssh/") ||
      normalized === "~/.aws/credentials" ||
      normalized.startsWith("~/.config/gcloud/") ||
      normalized === "~/.kube/config" ||
      normalized === "~/.npmrc" ||
      normalized === "~/.netrc" ||
      normalized === "~/.git-credentials" ||
      normalized.endsWith("/credentials.json") ||
      normalized.endsWith("/id_rsa") ||
      normalized.endsWith("/id_ed25519") ||
      normalized.endsWith(".pem") ||
      normalized.endsWith(".key")
    )
  })
}

function normalizeCommandName(input: string) {
  // Normalize paths and Windows executable suffixes so policy constants do not
  // need duplicate entries for `/usr/bin/git`, `git.exe`, or `PowerShell.EXE`.
  const name = input.replaceAll("\\", "/").split("/").at(-1) ?? input
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase()
}

export * as PermissionPrecheck from "./precheck"

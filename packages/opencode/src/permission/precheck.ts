export const LEVELS = ["safe", "general", "cautious", "dangerous"] as const
export type Level = (typeof LEVELS)[number]
export type Decision = { level: Level; reason: string }

// Wrappers return either a script we can inspect for critical deny patterns or
// an explicit `ask` result when the wrapper is too open-ended to inspect. These
// helper result types intentionally do not include `allow`: wrapper execution is
// never safe enough for deterministic approval by itself.
type UnwrapResult =
  | { action: "script"; script: string; reason: string }
  | { action: "ask"; reason: string }
  | { action: "none" }
type RemoteResult = { action: "remote"; script?: string; reason: string } | { action: "none" }

// [local-smark] 四级预审分层开始
// Permission precheck 是 reviewer 之前的确定性分类器。这里不用 allow/prompt/deny
// 表达执行结果，而是先给 shell 命令分层：safe 表示直接、只读、无敏感路径的
// 无害命令；general 表示未知、动态、包装器或普通副作用，开发测试期 shell
// general 会直接 allow，非 shell general 交给 reviewer；cautious 表示删除、
// git 状态变更、远程传输、敏感读取等需要 reviewer 判断的操作；dangerous 表示
// 全盘/根目录删除、远程脚本直管道执行、凭据外传、反连 shell 等直接拒绝的操作。
// [local-smark] 四级预审分层结束

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
const SSH_PRIVATE_KEY_NAME_PATTERN = String.raw`id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?`
const WINDOWS_HOME_SENSITIVE_PATH_PATTERN = String.raw`(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)[\\/](?:\.ssh(?:[\\/][^\s|;]+)?|\.aws(?:[\\/]credentials)?|\.config[\\/]gcloud(?:[\\/][^\s|;]+)?|\.kube[\\/]config|\.npmrc|\.netrc|\.git-credentials)`
const SENSITIVE_PATH_PATTERN = String.raw`(?:\.env(?:\.[^\s|;]+)?|${WINDOWS_HOME_SENSITIVE_PATH_PATTERN}|(?:~|[^\s|;]+)\/\.ssh(?:\/[^\s|;]+)?|(?:~|[^\s|;]+)\/\.aws(?:\/credentials)?|(?:~|[^\s|;]+)\/\.config\/gcloud(?:\/[^\s|;]+)?|(?:~|[^\s|;]+)\/\.kube\/config|(?:~|[^\s|;]+)\/\.npmrc|(?:~|[^\s|;]+)\/\.netrc|(?:~|[^\s|;]+)\/\.git-credentials|credentials\.json|${SSH_PRIVATE_KEY_NAME_PATTERN}|[^\s|;]+\.pem|[^\s|;]+\.key)`
// These raw destructive patterns deliberately sit below dangerousRaw checks and
// above tokenization. They catch visible file mutations in opaque shells such as
// PowerShell env paths, redirection, command substitution, SSH/WSL payloads, and
// unsupported separators without upgrading protected-root recursive deletes from
// dangerous to merely cautious.
const RAW_COMMAND_START = "(?:^|[;&|{(]\\s*|[\\r\\n]\\s*|\\$\\(\\s*|`\\s*)"
const RAW_COMMAND_PATH = String.raw`(?:[^\s|;&(){}'"]+[\\/])*`
const RAW_FILE_DELETE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:rm|unlink|rmdir|del|erase|rd|Remove-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`
const RAW_FILE_MOVE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:mv|move|ren|rename|Move-Item|Rename-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`
// Token-level sets mirror the raw destructive patterns after command-name
// normalization, so path-qualified binaries like `/bin/rm` cannot bypass review
// once tokenization succeeds.
const FILE_DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "del", "erase", "rd", "remove-item"])
const FILE_MOVE_COMMANDS = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item"])
// [local-smark] 敏感路径参数匹配开始
// raw 扫描发生在 shell quote 被移除之前；允许敏感路径外侧有一层引号，避免
// `cat ".env" | curl ...` 这类明显外传被降级成 cautious reviewer 判断。
const SENSITIVE_PATH_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_PATTERN}["']?`
// [local-smark] 敏感路径参数匹配结束

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
  // Other tools intentionally fall through to user approval instead of
  // guessing about unrelated argument schemas.
  if (input.permission === "external_directory" && input.metadata.action_kind === "shell") {
    // shell 发起的 external_directory 不是独立工具动作，它只是 bash 命令执行前
    // 的项目外路径门禁。复用同一条命令的预审结果，避免项目外路径先触发普通
    // ask，从而绕开 Auto agent 的 bash auto 路由。
    return evaluateShell(
      typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "),
      0,
    )
  }
  if (input.permission !== "bash") return { level: "general", reason: "precheck only has bash coverage" }
  return evaluateShell(
    typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "),
    0,
  )
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
  // preserving the fail-safe behavior: general/user approval instead of safe.
  if (depth > 4) return { level: "general", reason: "nested shell wrapper requires explicit approval" }
  if (!command.trim()) return { level: "general", reason: "empty shell command requires explicit approval" }

  // Raw scanning runs before token splitting so critical payloads hidden behind
  // command substitution, redirection, wrapper strings, or invalid syntax still
  // fail closed instead of being downgraded to a generic prompt.
  const danger = dangerousRaw(command)
  if (danger) return { level: "dangerous", reason: danger }
  const caution = cautiousRaw(command)
  if (caution) return { level: "cautious", reason: caution }

  for (const wrapped of rawWrapperScripts(command)) {
    const decision = evaluateShell(wrapped, depth + 1)
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
  }

  const commands = splitCommands(command)
  if (!commands) return { level: "general", reason: "opaque shell command requires explicit approval" }

  const decisions = commands.map((item) => evaluateCommand(item, depth))
  const dangerous = decisions.find((item) => item.level === "dangerous")
  if (dangerous) return dangerous
  const cautious = decisions.find((item) => item.level === "cautious")
  if (cautious) return cautious
  if (decisions.every((item) => item.level === "safe"))
    return { level: "safe", reason: "known read-only shell command" }
  return decisions.find((item) => item.level === "general") ?? { level: "general", reason: "unknown shell command" }
}

function evaluateCommand(command: string, depth: number): Decision {
  const tokens = tokenize(command)
  if (!tokens) return { level: "general", reason: "unable to tokenize shell command" }
  if (tokens.length === 0) return { level: "general", reason: "empty shell command requires explicit approval" }

  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") {
    const decision = evaluateShell(unwrapped.script, depth + 1)
    // [local-smark] 包装器载荷分层传播开始
    // 包装器本身仍不能变成 safe，因为未来同一前缀可能承载任意脚本；但如果
    // 可见脚本已经是 cautious/dangerous，就保留更高风险层级，让 auto reviewer
    // 只审真正需要判断的谨慎操作，而普通包装器仍回到用户审批。
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
    return { level: "general", reason: unwrapped.reason }
    // [local-smark] 包装器载荷分层传播结束
  }
  if (unwrapped.action === "ask") return { level: "general", reason: unwrapped.reason }

  const remote = remoteWrapper(tokens)
  if (remote.action === "remote") {
    if (remote.script) {
      const decision = evaluateShell(remote.script, depth + 1)
      // [local-smark] 远程载荷分层传播开始
      // SSH/WSL 跨越本机信任边界，安全的远程只读命令仍是 general；可见的远程
      // 删除、git 变更等谨慎操作要保留 cautious，避免把用户明确提到的远程破坏
      // 性动作降级成普通未知命令。
      if (decision.level === "dangerous" || decision.level === "cautious") return decision
      // [local-smark] 远程载荷分层传播结束
    }
    return { level: "general", reason: remote.reason }
  }

  const risk = riskyTokens(tokens)
  if (risk) return risk
  if (safeTokens(tokens)) return { level: "safe", reason: "known read-only shell command" }
  return { level: "general", reason: "unknown shell command" }
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
    // [local-smark] 不完整 shell 分隔符保护开始
    // 单个 `&` 和换行也是 shell 命令分隔/后台执行语法。当前 splitter 只支持
    // 明确的 `&&`、`||`、`;`、`|` 组合；遇到这些未建模分隔符时必须整体降级为
    // general，不能让 `git status & rm -rf ...` 被当成 safe 的 git 参数。
    if (char === "\n" || char === "\r") return
    // [local-smark] 不完整 shell 分隔符保护结束
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
    if (char === "&") return
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
      return {
        action: "script",
        script: tokens[index + 1].includes(" ") ? tokens[index + 1] : joinShellTokens(tokens.slice(index + 1)),
        reason: "cmd wrapper requires explicit approval",
      }
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
  if (cmd === "bun" && tokens[1] === "x")
    return { action: "ask", reason: "package executor requires explicit approval" }
  if (cmd === "env") return { action: "ask", reason: "env wrapper requires explicit approval" }
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  return { action: "none" }
}

function rawWrapperScripts(command: string) {
  // Top-level redirection or unsupported separators can make the full command
  // opaque before normal per-command unwrapping runs. Scan unquoted command
  // segments for visible wrapper payloads so destructive script bodies still keep
  // their cautious/dangerous layer; harmless payloads fall through to general.
  return rawCommandSegments(command).flatMap((segment) => {
    const script = rawWrapperScript(segment)
    return script ? [script] : []
  })
}

function rawWrapperScript(command: string) {
  const tokens = tokenize(command)
  if (!tokens) return
  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") return unwrapped.script
  const remote = remoteWrapper(tokens)
  return remote.action === "remote" ? remote.script : undefined
}

function rawCommandSegments(command: string) {
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
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== ";" && char !== "&" && char !== "|" && char !== "\n" && char !== "\r") continue
    const segment = command.slice(start, i).trim()
    if (segment) out.push(segment)
    if ((char === "&" || char === "|") && command[i + 1] === char) i++
    start = i + 1
  }
  const tail = command.slice(start).trim()
  return tail ? [...out, tail] : out
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
      String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))(?=[^|;]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?(?=[\s)'"\x60]|$)|~\/?(?=[\s)'"\x60]|$)|\$HOME\/?(?=[\s)'"\x60]|$)|\/etc(?:\/|(?=[\s)'"\x60]|$)))`,
    ).test(normalized)
  ) {
    return "critical recursive delete"
  }
  // Remote downloads piped directly to interpreters execute unreviewed network
  // bytes as code. Privilege/env wrappers are included because they are common
  // install-script indirections and should not downgrade to prompt.
  if (
    /\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i.test(
      normalized,
    )
  ) {
    return "remote download piped to interpreter; review the script locally before running safe commands"
  }
  // PowerShell aliases for web download plus `iex` are equivalent to curl|sh.
  if (/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i.test(normalized)) {
    return "remote PowerShell download executed as code; review the script locally before running safe commands"
  }
  // [local-smark] Windows 保护目标危险扫描开始
  // Windows 的 format/rd/rmdir/del 可以直接作用于盘符根或用户目录。它们不一定
  // 使用 rm 风格参数，所以在 raw 层先拦截，避免 token 解析差异把整盘/用户目录
  // 删除降级成 general 或 cautious。
  if (/\bformat\b\s+[A-Za-z]:/i.test(normalized)) return "Windows drive format"
  if (
    /\b(?:rd|rmdir|del)\b(?=.*(?:\/s|-s|--recursive))(?=.*(?:[A-Za-z]:[\\/]?(?=[\s)'"\x60]|$)|[A-Za-z]:[\\/](?:Users|Documents and Settings)(?:[\\/][^\s)'"\x60]*)?|%USERPROFILE%|\$env:USERPROFILE|~[\\/]?)(?=[\s)'"\x60]|$))/i.test(
      normalized,
    )
  ) {
    return "Windows protected directory delete"
  }
  // [local-smark] Windows 保护目标危险扫描结束
  // Credential exfiltration is critical only when a sensitive read is visibly
  // connected to a network transfer. Direct sensitive reads are handled below as
  // cautious so Auto can route them to reviewer without treating them as exfil.
  if (
    new RegExp(
      String.raw`\b(?:cat|type|Get-Content|gc|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})[^|;]*\|\s*(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
      "i",
    ).test(normalized)
  ) {
    return "credential read piped to network transfer"
  }
  // Upload flags that reference sensitive files are treated as exfiltration even
  // without a pipe because the file is the outbound request body/form/upload.
  if (
    new RegExp(
      String.raw`\b(?:curl|wget)\b(?=.*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|--form-string|-T)(?:\s+|=)(?:[^\s|;=@]+(?:=|@)@?)?@?${SENSITIVE_PATH_ARGUMENT_PATTERN})`,
      "i",
    ).test(normalized)
  ) {
    return "credential file sent with network transfer"
  }
  // `scp`, `sftp`, and `rsync` use `host:path` syntax rather than pipes/flags.
  if (
    new RegExp(String.raw`\b(?:scp|rsync|sftp)\b(?=.*${SENSITIVE_PATH_ARGUMENT_PATTERN})(?=.*:)`, "i").test(normalized)
  ) {
    return "credential file sent with remote transfer"
  }
  // Common interpreter APIs and reverse shell idioms are scanned as raw text
  // because their dangerous target may be inside strings rather than tokens.
  if (
    /\bRemove-Item\b(?=.*\s-Recurse\b)(?=.*\s-Force\b)(?=.*\s(?:\/|~\/?|\$HOME\/?|\$env:USERPROFILE[\\/]?|\$env:SystemDrive[\\/]?|[A-Za-z]:[\\/]?)(?=[\s)'"\x60]|$))/i.test(
      normalized,
    )
  ) {
    return "critical PowerShell recursive delete"
  }
  if (/\bshutil\.rmtree\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized))
    return "critical Python recursive delete"
  if (/\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized))
    return "critical Python file removal"
  if (
    /(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(
      normalized,
    )
  ) {
    return "critical Node.js file removal"
  }
  if (
    /\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(
      normalized,
    )
  ) {
    return "critical recursive delete through interpreter"
  }
  if (
    /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^|;]*(?:\s-e\s|\s--exec\s|\s--sh-exec\s)|\bsocat\b[^|;]*EXEC:|bash\s+-i\s+>&\s+\/dev\/tcp\//i.test(
      normalized,
    )
  ) {
    return "reverse shell pattern"
  }
}

function cautiousRaw(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (rawExecutableMatch(command, RAW_FILE_DELETE_PATTERN)) return "file deletion requires explicit approval"
  if (rawExecutableMatch(command, RAW_FILE_MOVE_PATTERN)) return "file move or rename requires explicit approval"
  // [local-smark] raw 敏感读取谨慎扫描开始
  // `$HOME/.aws/credentials` 这类 env-expanded 路径会让 splitter 降级为 opaque，
  // 导致 token 级敏感读取看不到真实路径。dangerousRaw 已先处理外传；这里仅把
  // 本地敏感读取提升到 cautious，避免 safe 绕过，同时不把普通 `$HOME` 查询送审。
  if (
    new RegExp(
      String.raw`\b(?:cat|type|Get-Content|gc|Get-ChildItem|gci|ls|dir|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})`,
      "i",
    ).test(normalized)
  ) {
    return "sensitive file read requires explicit approval"
  }
  // [local-smark] raw 敏感读取谨慎扫描结束
}

function rawExecutableMatch(command: string, pattern: string) {
  // Raw delete/move scans need shell-syntax context: separators inside quoted
  // read-only search text are data. `$()` and backticks execute in unquoted or
  // double-quoted shell text, but remain literal inside POSIX single quotes.
  const quotes = quoteOffsets(command)
  for (const match of command.matchAll(new RegExp(pattern, "gi"))) {
    const index = match.index ?? 0
    if (!quotes[index] || (quotes[index] === '"' && (command.startsWith("$(", index) || command[index] === "`"))) return true
  }
  return false
}

function quoteOffsets(command: string) {
  const quotes = Array.from({ length: command.length }, () => "")
  let quote = ""
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    quotes[i] = quote
    if (escaped) {
      escaped = false
      continue
    }
    if (command[i] === "\\") {
      // POSIX single quotes treat backslash as literal text; marking it as an
      // escape would incorrectly keep a following separator quoted and hide a
      // visible delete after malformed single-quoted data.
      if (quote === "'") continue
      escaped = true
      continue
    }
    if (quote) {
      if (command[i] === quote) quote = ""
      continue
    }
    if (command[i] === "'" || command[i] === '"') quote = command[i]
  }
  return quotes
}

function riskyTokens(tokens: string[]): Decision | undefined {
  // Token-level risks are visible commands with known side effects. Critical
  // protected targets are dangerous; destructive-but-bounded operations are
  // cautious so only that layer reaches the optional reviewer.
  const cmd = normalizeCommandName(tokens[0])
  if (readsSensitivePath(tokens)) return { level: "cautious", reason: "sensitive file read requires explicit approval" }
  if (cmd === "rm" && hasRecursiveForceDeleteFlags(tokens.slice(1))) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      return { level: "dangerous", reason: "critical recursive delete" }
    }
    return { level: "cautious", reason: "recursive force delete requires explicit approval" }
  }
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/")))
    return { level: "dangerous", reason: "raw disk write" }
  if (["mkfs", "mkfs.ext4", "fdisk", "parted", "wipefs", "shutdown", "reboot", "halt", "poweroff"].includes(cmd)) {
    return { level: "dangerous", reason: "system destructive command" }
  }
  if (cmd === "git" && tokens[1] === "reset" && tokens.includes("--hard")) {
    return { level: "cautious", reason: "destructive git reset requires explicit approval" }
  }
  if (
    cmd === "git" &&
    tokens[1] === "clean" &&
    tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d"))
  ) {
    return { level: "cautious", reason: "destructive git clean requires explicit approval" }
  }
  if (cmd === "git" && tokens[1] === "push" && tokens.some((item) => item === "--force" || item === "-f")) {
    return { level: "cautious", reason: "force push requires explicit approval" }
  }
  if (cmd === "git" && cautiousGitSubcommand(tokens)) {
    return { level: "cautious", reason: "git state-changing command requires explicit approval" }
  }
  if (cmd === "chmod" && tokens.some((item) => item === "777" || item === "-R")) {
    return { level: "cautious", reason: "permission widening requires explicit approval" }
  }
  if (cmd === "chown" && tokens.some((item) => item.includes("root"))) {
    return { level: "cautious", reason: "root ownership change requires explicit approval" }
  }
  if (cmd === "remove-item" && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      return { level: "dangerous", reason: "critical PowerShell recursive delete" }
    }
    return { level: "cautious", reason: "recursive PowerShell delete requires explicit approval" }
  }
  if (FILE_DELETE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  if (FILE_MOVE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file move or rename requires explicit approval" }
  if (["scp", "sftp", "rsync"].includes(cmd))
    return { level: "cautious", reason: "remote file transfer requires explicit approval" }
}

function cautiousGitSubcommand(tokens: string[]) {
  // [local-smark] Git 谨慎子命令识别开始
  // Git 的很多子命令会修改索引、历史、引用或远端状态，且通常难以自动恢复。
  // 这些命令不应像 unknown 一样只走 general/user，也不应直接 dangerous；标为
  // cautious 后仅 auto 分支的 reviewer/user 会判断是否符合用户意图。
  const subcommand = tokens[1]
  if (!subcommand) return false
  if (
    ["add", "commit", "merge", "rebase", "cherry-pick", "revert", "push", "pull", "reset", "clean", "mv"].includes(subcommand)
  )
    return true
  return subcommand === "branch" && !gitBranchSafe(tokens.slice(2))
  // [local-smark] Git 谨慎子命令识别结束
}

function readsSensitivePath(tokens: string[]) {
  // [local-smark] 敏感读取谨慎分层开始
  // 读取或列出 .env、SSH key、云凭据等本地敏感位置不是立即外传，因此不是
  // dangerous；但它会把密钥内容或密钥存在性暴露给 shell 输出和模型上下文，
  // 所以从 safe/general 提升为 cautious，交给 reviewer 判断是否确有授权。
  const cmd = normalizeCommandName(tokens[0])
  if (
    ![
      "cat",
      "type",
      "get-content",
      "gc",
      "get-childitem",
      "gci",
      "ls",
      "dir",
      "grep",
      "rg",
      "head",
      "tail",
      "less",
      "more",
      "sed",
      "awk",
    ].includes(cmd)
  ) {
    return false
  }
  return hasSensitivePath(tokens)
  // [local-smark] 敏感读取谨慎分层结束
}

function joinShellTokens(tokens: string[]) {
  // Reconstruct cmd/WSL payloads for recursive raw scanning without reusing the
  // original command text. Quoting keeps spaces intact and avoids inventing new
  // separators while still surfacing dangerous substrings to `dangerousRaw`.
  return tokens
    .map((item) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`))
    .join(" ")
}

function decodePowerShell(input: string) {
  // PowerShell encoded commands are UTF-16LE base64. Decode failures are prompt
  // rather than deny because opaque encoded text is risky but not evidence of a
  // specific critical payload.
  try {
    return Buffer.from(input, "base64")
      .toString("utf16le")
      .replace(/^\uFEFF/, "")
  } catch {
    return
  }
}

function hasRecursiveForceDeleteFlags(tokens: string[]) {
  // `rm` accepts recursive/force as combined short flags (`-rf`, `-fr`), split
  // short flags (`-r -f`, `-R -f`), or long flags. Treat the pair as equivalent
  // before checking protected targets so option spelling cannot downgrade a root
  // delete from deny to prompt.
  return (
    tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item)) &&
    tokens.some((item) => item === "--force" || /^-[^-]*f/.test(item))
  )
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
    normalized === "$env:SystemDrive" ||
    normalized === "$env:SystemDrive/" ||
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
  if (["pwd", "whoami", "id", "uname", "which", "ls", "cat", "head", "wc", "file", "stat", "grep"].includes(cmd))
    return true
  if (cmd === "tail") return !tokens.some((item) => item === "-f" || item === "--follow")
  if (cmd === "rg") return !tokens.some(unsafeRipgrepFlag)
  if (cmd === "find")
    return !tokens.some((item) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint"].includes(item))
  if (cmd === "sed") return tokens.length <= 4 && tokens[1] === "-n" && /^\d+(?:,\d+)?p$/.test(tokens[2] ?? "")
  if (cmd === "git") return gitSafe(tokens)
  if (["npm", "pnpm", "yarn"].includes(cmd))
    return ["ls", "list", "view", "info", "why", "outdated"].includes(tokens[1])
  return versionSafe(tokens)
}

function gitSafe(tokens: string[]) {
  // Only read-only git subcommands are safe. Global flags that alter config,
  // worktrees, or execution path are rejected because they can redirect a safe
  // subcommand into another repository or helper.
  const unsafeGlobal = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"])
  const unsafeReadFlag = new Set(["--ext-diff", "--textconv"])
  const safe = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"])
  let subcommand: string | undefined
  for (let i = 1; i < tokens.length; i++) {
    if (unsafeGlobal.has(tokens[i]) || Array.from(unsafeGlobal).some((item) => tokens[i].startsWith(item + "=")))
      return false
    if (unsafeReadFlag.has(tokens[i])) return false
    if (tokens[i] === "remote") return tokens[i + 1] === "-v"
    if (tokens[i] === "config") return tokens[i + 1] === "--get" || tokens[i + 1] === "--list"
    if (tokens[i] === "branch") return gitBranchSafe(tokens.slice(i + 1))
    if (!tokens[i].startsWith("-") && !subcommand) subcommand = tokens[i]
  }
  return subcommand ? safe.has(subcommand) : false
}

function unsafeRipgrepFlag(item: string) {
  // [local-smark] rg 外部命令 flag 保护开始
  // `rg --pre=cmd` 和 `--hostname-bin=cmd` 会执行外部程序；native shell backend
  // 没有 sandbox，因此这些 read-looking 命令不能进入 safe 直通路径。
  return (
    item === "-z" ||
    item === "--pre" ||
    item.startsWith("--pre=") ||
    item === "--hostname-bin" ||
    item.startsWith("--hostname-bin=") ||
    item === "--search-zip" ||
    item.startsWith("--search-zip=")
  )
  // [local-smark] rg 外部命令 flag 保护结束
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
      normalized.endsWith("/.ssh") ||
      normalized.includes("/.ssh/") ||
      normalized === "~/.aws/credentials" ||
      normalized === "~/.aws" ||
      normalized.endsWith("/.aws") ||
      normalized.endsWith("/.aws/credentials") ||
      normalized.startsWith("~/.config/gcloud/") ||
      normalized.includes("/.config/gcloud/") ||
      normalized === "~/.kube/config" ||
      normalized.endsWith("/.kube/config") ||
      normalized === "~/.npmrc" ||
      normalized.endsWith("/.npmrc") ||
      normalized === "~/.netrc" ||
      normalized.endsWith("/.netrc") ||
      normalized === "~/.git-credentials" ||
      normalized.endsWith("/.git-credentials") ||
      normalized === "credentials.json" ||
      normalized.endsWith("/credentials.json") ||
      normalized === "id_rsa" ||
      normalized.endsWith("/id_rsa") ||
      normalized === "id_dsa" ||
      normalized.endsWith("/id_dsa") ||
      normalized === "id_ecdsa" ||
      normalized.endsWith("/id_ecdsa") ||
      normalized === "id_ed25519" ||
      normalized.endsWith("/id_ed25519") ||
      normalized === "id_ecdsa_sk" ||
      normalized.endsWith("/id_ecdsa_sk") ||
      normalized === "id_ed25519_sk" ||
      normalized.endsWith("/id_ed25519_sk") ||
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

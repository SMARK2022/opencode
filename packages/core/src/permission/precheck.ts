// #202：四级预审分层——safe/general/cautious/dangerous 替代 allow/prompt/deny 三态
export const LEVELS = ["safe", "general", "cautious", "dangerous"] as const
export type Level = (typeof LEVELS)[number]
export type Decision = { level: Level; reason: string }

// #197：wrapper 解包结果不含 safe 分支——wrapper 执行本身永远不够安全到可确定性放行，只提取脚本用于递归检测危险模式
type UnwrapResult = { action: "script"; script: string; reason: string } | { action: "ask"; reason: string } | { action: "none" }
type RemoteResult = { action: "remote"; script?: string; reason: string } | { action: "none" }

// #202：四级预审分层刻意保持狭窄——safe 仅限直接只读无敏感路径的无害命令；general 表示未知、动态、
// #202：包装器或普通副作用，回到用户审批但不占用 LLM；cautious 表示删除、git 状态变更、远程传输、
// #202：敏感读取等需 reviewer/user 判断的操作；dangerous 表示全盘/根目录删除、远程脚本直管道执行、
// #202：凭据外传、反连 shell 等直接拒绝的操作。分层是降低 LLM 负载的边界：默认只有 cautious 进入 reviewer
// #197：shell wrapper 将 -c/-lc 载荷视为容器脚本——仅查找危险拒绝模式，仍返回 general 防止用户误授 `bash *` 等宽泛规则
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"])

// #197：PowerShell 多入口面（-Command/-EncodedCommand/别名/provider）可隐藏文件系统/网络副作用——解码后扫描危险模式但所有 wrapper 仍 general
const POWERSHELL_WRAPPERS = new Set(["pwsh", "powershell", "powershell.exe"])

// #197：远程 wrapper 跨信任边界——即使只读命令也可能触及远程凭证或另一文件系统命名空间，确定性层永不自动放行
const REMOTE_WRAPPERS = new Set(["ssh", "ssh.exe", "wsl", "wsl.exe"])

// #197：解释器 eval flag 是高杠杆逃逸口——python -c/node -e 可合成 shell 命令和网络调用，token 级解析无法理解
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
// #203：拆分 SSH 私钥名/Windows home 模式，覆盖 id_dsa/id_ecdsa/*_sk 及 $env:USERPROFILE/%USERPROFILE% 路径
const SSH_PRIVATE_KEY_NAME_PATTERN = String.raw`id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?`
const WINDOWS_HOME_SENSITIVE_PATH_PATTERN = String.raw`(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)[\\/](?:\.ssh(?:[\\/][^\s|;]+)?|\.aws(?:[\\/]credentials)?|\.config[\\/]gcloud(?:[\\/][^\s|;]+)?|\.kube[\\/]config|\.npmrc|\.netrc|\.git-credentials)`
// #202：敏感路径正则放宽——允许 ~ 之外的非空白前缀路径，使 /home/alice/.aws/credentials、$HOME 展开后的
// #202：绝对路径也能被 raw 扫描命中；护栏而非密钥扫描器，需足够精确避免拦截普通项目文件
const SENSITIVE_PATH_PATTERN = String.raw`(?:\.env(?:\.[^\s|;]+)?|${WINDOWS_HOME_SENSITIVE_PATH_PATTERN}|(?:~|[^\s|;]+)\/\.ssh(?:\/?[^\s|;]+)?|(?:~|[^\s|;]+)\/\.aws(?:\/credentials)?|(?:~|[^\s|;]+)\/\.config\/gcloud(?:\/?[^\s|;]+)?|(?:~|[^\s|;]+)\/\.kube\/config|(?:~|[^\s|;]+)\/\.npmrc|(?:~|[^\s|;]+)\/\.netrc|(?:~|[^\s|;]+)\/\.git-credentials|credentials\.json|${SSH_PRIVATE_KEY_NAME_PATTERN}|[^\s|;]+\.pem|[^\s|;]+\.key)`
// #202：敏感路径参数匹配——raw 扫描发生在 shell quote 移除之前，允许敏感路径外侧有一层引号，
// #202：避免 `cat ".env" | curl ...` 这类明显外传被降级成 cautious reviewer 判断
const SENSITIVE_PATH_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_PATTERN}["']?`

// #197：禁止 always-allow 的宽泛前缀——授权后可隐藏未来任意载荷文本，用户点击 Always 时 precheck 从未见过这些未来载荷
const BANNED_AUTO_ALLOW_PREFIXES = [
  // #197：shell wrapper 可通过 -c/-lc/参数隐藏未来脚本
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
  // #197：解释器和包执行器可从不透明源码或依赖解析产生文件系统/网络副作用
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
  // #197：特权和环境 wrapper 可改变有效用户/PATH/目标命名空间
  ["sudo"],
  ["doas"],
  ["su"],
  ["pkexec"],
  ["env"],
  // #197：VCS 前缀因多数子命令可变 ref/历史/远程/工作树——安全子命令应作为具体命令模式而非 `git *`
  ["git"],
  // #197：branch 可创建/删除/复制/重命名 ref——`git branch *` 过宽
  ["git", "branch"],
  ["hg"],
  ["svn"],
  // #197：PowerShell/cmd/remote wrapper 需逐命令字符串审查
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
  // #197：远程文件传输工具可移动凭证或发布制品——安全读取应用专用 read/glob/grep 工具
  ["scp"],
  ["sftp"],
  ["rsync"],
]

export function evaluate(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision {
  // #197：目前仅 bash 有足够语法证据支持确定性预检——其他工具直接回退到用户审批而非猜测无关参数模式
  // #202：非 bash 工具缺乏 shell 级语义证据，归为 general 而非 prompt，保持既有用户审批路径
  // #203：shell 发起的 external_directory 不是独立工具动作，复用同一条命令的预审结果，
  // #203：避免项目外路径先触发普通 ask 从而绕开 Auto agent 的 bash auto 路由
  if (input.permission === "external_directory" && input.metadata.action_kind === "shell") {
    return evaluateShell(typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "), 0)
  }
  if (input.permission !== "bash") return { level: "general", reason: "precheck only has bash coverage" }
  return evaluateShell(typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "), 0)
}

export function canAlwaysAllowPrefix(tokens: string[]) {
  // #197：前缀来自 shell 解析器的 arity 计算——需与评估时同样规范化命令名，防止 wsl.exe、/bin/bash 等变体逃逸禁用列表
  const normalized = tokens.map((item, index) => (index === 0 ? normalizeCommandName(item) : item.toLowerCase()))
  return !BANNED_AUTO_ALLOW_PREFIXES.some(
    (prefix) => prefix.length === normalized.length && prefix.every((item, index) => item === normalized[index]),
  )
}

function evaluateShell(command: string, depth: number): Decision {
  // #197：递归深度上限 4 防止对抗性嵌套 wrapper 消耗时间——超限回退到 general 而非 safe 保持失败安全
  if (depth > 4) return { level: "general", reason: "nested shell wrapper requires explicit approval" }
  // #197：空命令无只读意图证据——可能是解析器残留或占位符，需用户确认实际意图
  if (!command.trim()) return { level: "general", reason: "empty shell command requires explicit approval" }

  // #197：原始扫描先于分词——命令替换/重定向/wrapper 字符串/无效语法中隐藏的危险载荷仍需 fail closed
  // #202：dangerousRaw 命中已知危险模式直接 dangerous——防止用户反复重试绕过护栏
  const danger = dangerousRaw(command)
  if (danger) return { level: "dangerous", reason: danger }
  // #202：cautiousRaw 捕获本地敏感读取——$HOME 展开等会让 splitter 降级为 opaque，token 级看不到真实路径；
  // #202：dangerousRaw 已先处理外传，此处仅把本地敏感读取提升为 cautious，避免 safe 绕过
  const caution = cautiousRaw(command)
  if (caution) return { level: "cautious", reason: caution }

  const commands = splitCommands(command)
  // #197：分词失败意味着命令包含预检器无法理解的 shell 特性——不透明命令归为 general
  if (!commands) return { level: "general", reason: "opaque shell command requires explicit approval" }

  // #202：层级聚合——dangerous 优先，其次 cautious；全部 safe 才 safe；否则 general 传播
  const decisions = commands.map((item) => evaluateCommand(item, depth))
  const dangerous = decisions.find((item) => item.level === "dangerous")
  // #202：单个 dangerous 子命令足以否决整条命令链
  if (dangerous) return dangerous
  const cautious = decisions.find((item) => item.level === "cautious")
  if (cautious) return cautious
  // #202：所有子命令均为 safe 时整体 safe——每个子命令已独立通过只读不变量验证
  if (decisions.every((item) => item.level === "safe")) return { level: "safe", reason: "known read-only shell command" }
  // #202：混合决策中任一 general 即整体 general——保守策略确保模糊命令不因其他子命令安全而自动放行
  return decisions.find((item) => item.level === "general") ?? { level: "general", reason: "unknown shell command" }
}

function evaluateCommand(command: string, depth: number): Decision {
  const tokens = tokenize(command)
  // #197：分词失败表示引号不闭合或转义悬空——解析不可靠的命令归为 general
  if (!tokens) return { level: "general", reason: "unable to tokenize shell command" }
  // #197：空 token 列表无只读意图证据——可能是纯空白段，需用户确认
  if (tokens.length === 0) return { level: "general", reason: "empty shell command requires explicit approval" }

  // #197：wrapper 脚本递归评估——dangerous/cautious 传播，但 safe 不传播，因为 wrapper 本身永远不够安全到可确定性放行
  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") {
    const decision = evaluateShell(unwrapped.script, depth + 1)
    // #202：wrapper 内脚本命中 dangerous/cautious 时传播——隐藏在嵌套层中的风险不应逃逸检测
    // #202：wrapper 本身仍归 general，因未来同一前缀可能承载任意脚本
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
    return { level: "general", reason: unwrapped.reason }
  }
  // #197：无脚本载荷的 wrapper 无法检查——执行内容不透明，归为 general
  if (unwrapped.action === "ask") return { level: "general", reason: unwrapped.reason }

  // #197：远程 wrapper 提取脚本后递归检测——远程执行本身仍 general 因跨信任边界
  const remote = remoteWrapper(tokens)
  if (remote.action === "remote") {
    if (remote.script) {
      const decision = evaluateShell(remote.script, depth + 1)
      // #202：远程命令中的 dangerous/cautious 载荷仍需传播——跨信任边界不降低风险层级
      if (decision.level === "dangerous" || decision.level === "cautious") return decision
    }
    // #197：远程执行即使无可见危险载荷仍 general——远程主机可能访问不同凭证和文件系统命名空间
    return { level: "general", reason: remote.reason }
  }

  // #197：安全 token 判定——先检风险 token（dangerous/cautious），再检安全 token（safe），最后默认 general
  const risk = riskyTokens(tokens)
  // #197：风险判定优先于安全判定——已知破坏性命令即使用只读子命令形式也不自动放行
  if (risk) return risk
  // #197：通过只读不变量验证的命令才 safe——安全命令必须直接、本地且只读
  if (safeTokens(tokens)) return { level: "safe", reason: "known read-only shell command" }
  // #197：未识别命令无法证明只读——默认 general 确保未知命令不因缺乏危险特征而自动放行
  return { level: "general", reason: "unknown shell command" }
}

function splitCommands(command: string) {
  // #197：分割器仅识别可组合安全命令的简单分隔符——动态展开/重定向/通配符/畸形空段返回 undefined 由调用方回退 general
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
      // #197：双引号片段仍可能展开变量或执行替换——视为不透明而非批准字面文本
      else if (quote !== "'" && (char === "$" || char === "`")) return
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    // #197：命令替换和变量展开可注入任意命令——$() 和 `` 可执行子进程，花括号可展开路径列表
    if (char === "$" || char === "`" || char === "(" || char === ")" || char === "{" || char === "}") return
    // #202：单个换行/回车也是 shell 命令分隔——splitter 只支持明确的 &&/||/;/| 组合，遇到未建模分隔符
    // #202：整体降级为 general，不能让 `git status\nrm -rf ...` 被当成 safe 的 git 参数
    if (char === "\n" || char === "\r") return
    // #197：重定向可覆写文件、通配符可扩展到意外路径——这些特性使只读命令变为写入或遍历
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
    // #202：单个 & 是后台执行/分隔符——未建模分隔符整体降级为 general，防止 `git status & rm -rf ...` 被切错
    if (char === "&") return
    if (char === ";" || char === "|") {
      const segment = command.slice(start, i).trim()
      if (!segment) return
      out.push(segment)
      start = i + 1
    }
  }

  // #197：不闭合引号或悬空转义表示命令不完整——解析不可靠时返回 undefined 由调用方回退 general
  if (quote || escaped) return
  const segment = command.slice(start).trim()
  // #197：空段可能是语法错误或多余分隔符——拒绝而非忽略以防止意外组合
  if (!segment) return
  out.push(segment)
  return out
}

function tokenize(command: string) {
  // #197：分词器比完整 shell 解析器更小——保留引号空格和转义字符用于路径参数，但畸形引号或悬空转义强制 general
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

  // #197：不闭合引号或悬空转义表示命令不完整——分词器返回 undefined 强制 general 而非猜测 token 边界
  if (quote || escaped) return
  if (current) out.push(current)
  return out
}

function unwrap(tokens: string[]): UnwrapResult {
  // #197：wrapper 处理按 shell 到解释器排序——暴露明文脚本的 wrapper 返回脚本用于递归 dangerous 扫描，wrapper 本身仍 general
  const cmd = normalizeCommandName(tokens[0])
  if (SHELL_WRAPPERS.has(cmd)) {
    const index = tokens.findIndex((item, i) => i > 0 && ["-c", "-lc"].includes(item))
    if (index >= 0 && tokens[index + 1]) {
      // #197：提取 -c/-lc 后的脚本用于递归检测——脚本内容可见但 wrapper 本身仍 general
      return { action: "script", script: tokens[index + 1], reason: "shell wrapper requires explicit approval" }
    }
    // #197：无脚本的 shell wrapper 无法检查载荷——交互式 shell 或文件脚本内容不透明
    return { action: "ask", reason: "shell wrapper without a plain script requires explicit approval" }
  }

  if (POWERSHELL_WRAPPERS.has(cmd)) {
    const encoded = tokens.findIndex((item, i) => i > 0 && ["-encodedcommand", "-enc"].includes(item.toLowerCase()))
    if (encoded >= 0 && tokens[encoded + 1]) {
      const script = decodePowerShell(tokens[encoded + 1])
      // #197：解码成功时提取明文脚本用于递归危险扫描——编码命令是常见混淆手段
      if (script) return { action: "script", script, reason: "PowerShell encoded command requires explicit approval" }
      // #197：解码失败仍 general——不透明编码文本有风险但无特定 dangerous 载荷证据
      return { action: "ask", reason: "PowerShell encoded command requires explicit approval" }
    }

    const index = tokens.findIndex((item, i) => i > 0 && ["-command", "-c"].includes(item.toLowerCase()))
    if (index >= 0 && tokens[index + 1]) {
      // #197：提取 -Command 后的脚本用于递归检测——PowerShell 命令字符串可包含管道和别名
      return { action: "script", script: tokens[index + 1], reason: "PowerShell wrapper requires explicit approval" }
    }
    // #197：无命令参数的 PowerShell wrapper 可能进入交互式会话——载荷不透明
    return { action: "ask", reason: "PowerShell wrapper without a plain script requires explicit approval" }
  }

  if (cmd === "cmd") {
    const index = tokens.findIndex((item, i) => i > 0 && ["/c", "/k"].includes(item.toLowerCase()))
    if (index >= 0 && tokens[index + 1]) {
      // #197：重组 /c 后的载荷用于递归原始扫描——cmd 语法与 POSIX shell 不同但仍可隐藏危险命令
      return { action: "script", script: joinShellTokens(tokens.slice(index + 1)), reason: "cmd wrapper requires explicit approval" }
    }
    // #197：无载荷的 cmd 可能进入交互式命令解释器——无法预检后续输入
    return { action: "ask", reason: "cmd wrapper without a plain script requires explicit approval" }
  }

  const evalFlags = INTERPRETER_FLAGS.get(cmd)
  // #197：解释器 eval flag 可执行任意代码字符串——python -c/node -e 合成 shell 命令和网络调用的能力超出 token 级分析
  if (evalFlags && tokens.some((item) => evalFlags.has(item))) {
    return { action: "ask", reason: "interpreter eval command requires explicit approval" }
  }
  // #197：脚本解释器执行文件内容不在命令行中——预检无法看到实际代码
  if (["pythonw", "pyw", "pypy", "pypy3", "deno", "osascript"].includes(cmd)) {
    return { action: "ask", reason: "script interpreter requires explicit approval" }
  }
  // #197：bun x 可运行任意远程 npm 包——包内容和网络拉取不在预检范围内
  if (cmd === "bun" && tokens[1] === "x") return { action: "ask", reason: "package executor requires explicit approval" }
  // #197：env 可修改环境变量后执行命令——修改后的环境可改变程序行为和安全边界
  if (cmd === "env") return { action: "ask", reason: "env wrapper requires explicit approval" }
  // #197：提权 wrapper 放大命令影响范围——sudo/doas/su/pkexec 后的命令以更高权限执行
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  // #197：非 wrapper 分支返回 none——none 不等于 allow，调用方继续 token 级判定，避免此处单点放行
  return { action: "none" }
}

function remoteWrapper(tokens: string[]): RemoteResult {
  // #197：远程 wrapper 与本地解包分离——即使无可检脚本载荷，原因仍为信任边界 general
  const cmd = normalizeCommandName(tokens[0])
  // #197：远程集合外返回 none——远程判定仅对 ssh/wsl 生效，本地 wrapper 已由 unwrap 处理，两处职责不重叠
  if (!REMOTE_WRAPPERS.has(cmd)) return { action: "none" }
  if (cmd === "wsl") {
    const script = wslScript(tokens)
    // #197：WSL 启动另一 OS shell——文件系统命名空间和权限模型与宿主不同
    return { action: "remote", script, reason: "alternate OS environment requires explicit approval" }
  }

  const script = sshScript(tokens)
  // #197：SSH 在远程主机执行命令——远程凭证和文件系统不在本地信任域内
  return { action: "remote", script, reason: "remote shell execution requires explicit approval" }
}

function sshScript(tokens: string[]) {
  // #197：SSH 选项可能消耗下一 token——跳过带值选项定位主机名，使 `ssh -p 22 host rm -rf /` 的远程命令对危险扫描器可见
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
  // #197：WSL 接受 --exec 载荷或 distro/user 选项后的命令——仅提取可见载荷，缺失仍 general 因 WSL 启动另一 OS shell
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
  // #197：原始扫描刻意狭窄——捕获隐藏在不透明 shell 特性中的危险载荷，非 dangerous 的模糊性回退到 general/cautious
  if (
    new RegExp(
      // #197：rm 同时带 -r/-R/--recursive 和 -f/--force 且目标为根/home/etc——递归强制删除保护目录不可恢复
      String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))(?=[^|;]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?(?=[\s)'"]|$)|~\/?(?=[\s)'"]|$)|\$HOME\/?(?=[\s)'"]|$)|\/etc(?:\/|(?=[\s)'"]|$)))`,
    ).test(normalized)
  ) {
    // #197：递归强制删除根文件系统或 home 目录——系统不可恢复，直接 dangerous 防止重试绕过
    return "critical recursive delete"
  }
  // #197：远程下载管道到解释器执行未审查的网络字节——特权/env wrapper 包含在内因它们是常见安装脚本间接调用
  // #202：reason 追加本地审查提示，便于区分"远程脚本本身"与"本地 safe 命令"
  if (/\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i.test(normalized)) {
    return "remote download piped to interpreter; review the script locally before running safe commands"
  }
  // #197：PowerShell Web 下载别名加 iex 等价于 curl|sh
  if (/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i.test(normalized)) {
    return "remote PowerShell download executed as code; review the script locally before running safe commands"
  }
  // #202：Windows 保护目标危险扫描——format/rd/rmdir/del 可直接作用于盘符根或用户目录，不一定使用 rm 风格参数，
  // #202：在 raw 层先拦截，避免 token 解析差异把整盘/用户目录删除降级成 general 或 cautious
  if (/\bformat\b\s+[A-Za-z]:/i.test(normalized)) return "Windows drive format"
  if (
    /\b(?:rd|rmdir|del)\b(?=.*(?:\/s|-s|--recursive))(?=.*(?:[A-Za-z]:[\\/]?(?=[\s)'"]|$)|[A-Za-z]:[\\/](?:Users|Documents and Settings)(?:[\\/][^\s)'"]*)?|%USERPROFILE%|\$env:USERPROFILE|~[\\/]?)(?=[\s)'"]|$))/i.test(
      normalized,
    )
  ) {
    return "Windows protected directory delete"
  }
  // #202：凭证外泄仅在敏感读取可见连接到网络传输时 dangerous——直接敏感读取由 cautiousRaw/readsSensitivePath 处理为 cautious
  // #202：扩展读取器集合（rg/grep/head/tail/sed/awk）并使用 SENSITIVE_PATH_ARGUMENT_PATTERN 容忍外侧引号
  if (
    new RegExp(
      String.raw`\b(?:cat|type|Get-Content|gc|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})[^|;]*\|\s*(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
      "i",
    ).test(normalized)
  ) {
    return "credential read piped to network transfer"
  }
  // #197：上传标志引用敏感文件视为外泄——文件即出站请求体/表单/上传
  // #202：扩展上传标志（--data-urlencode/--data-raw/-F/--form 等）并容忍 name@path 与外侧引号
  if (
    new RegExp(
      String.raw`\b(?:curl|wget)\b(?=.*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|--form-string|-T)(?:\s+|=)(?:[^\s|;=@]+(?:=|@)@?)?@?${SENSITIVE_PATH_ARGUMENT_PATTERN})`,
      "i",
    ).test(normalized)
  ) {
    return "credential file sent with network transfer"
  }
  // #197：scp/sftp/rsync 使用 host:path 语法而非管道/标志
  // #202：加 i 标志并使用 SENSITIVE_PATH_ARGUMENT_PATTERN，捕获大写 SCP 及带引号路径
  if (new RegExp(String.raw`\b(?:scp|rsync|sftp)\b(?=.*${SENSITIVE_PATH_ARGUMENT_PATTERN})(?=.*:)`, "i").test(normalized)) {
    return "credential file sent with remote transfer"
  }
  // #197：解释器 API 和反向 shell 惯用法作为原始文本扫描——危险目标可能在字符串内而非 token 中
  if (/\bRemove-Item\b(?=.*\s-Recurse\b)(?=.*\s-Force\b)(?=.*\s(?:\/|~\/?|\$HOME\/?|[A-Za-z]:[\\/]?)(?=[\s)'"]|$))/i.test(normalized)) {
    return "critical PowerShell recursive delete"
  }
  if (/\bshutil\.rmtree\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    // #197：Python shutil.rmtree 删除整个目录树——针对根/home/etc 的调用等同于 rm -rf /
    return "critical Python recursive delete"
  }
  if (/\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    // #197：Python os.remove/unlink/rmdir 针对保护路径——删除系统关键文件可破坏系统
    return "critical Python file removal"
  }
  if (/(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    // #197：Node.js fs 同步删除 API 针对保护路径——与 Python os.remove 等价的不可逆破坏
    return "critical Node.js file removal"
  }
  if (/\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/.test(normalized)) {
    // #197：解释器通过 subprocess 调用 rm -rf——绕过 shell 层的危险载荷仍需 dangerous
    return "critical recursive delete through interpreter"
  }
  if (/\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^|;]*(?:\s-e\s|\s--exec\s|\s--sh-exec\s)|\bsocat\b[^|;]*EXEC:|bash\s+-i\s+>&\s+\/dev\/tcp\//i.test(normalized)) {
    // #197：反向 shell 惯用法——/dev/tcp、nc -e、socat EXEC 建立入站连接使攻击者获得交互式访问
    return "reverse shell pattern"
  }
}

// #202：cautiousRaw——raw 层敏感读取谨慎扫描。$HOME/.aws/credentials 等 env-expanded 路径会让 splitter
// #202：降级为 opaque，导致 token 级敏感读取看不到真实路径。dangerousRaw 已先处理外传；此处仅把本地敏感
// #202：读取提升到 cautious，避免 safe 绕过，同时不把普通 `$HOME` 查询送审
function cautiousRaw(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (
    new RegExp(
      // #209：去掉 (?:^|[;&|]\s*) 锚点——if(Test-Path){Get-Content} 内的 Get-Content 不紧跟行首/分隔符，锚点导致漏审
      // #209：\b 词边界单独足以匹配块内读取命令——Get-Content 前的 { 或 ( 不构成词字符，\b 仍能在标识符边界命中
      String.raw`\b(?:cat|type|Get-Content|gc|Get-ChildItem|gci|ls|dir|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})`,
      // #209：[^|;]* 前瞻仍把匹配限定在同一管道段内——去掉锚点不会让跨管道的读取命令误判为敏感读取
      "i",
    ).test(normalized)
  ) {
    return "sensitive file read requires explicit approval"
  }
}

function riskyTokens(tokens: string[]): Decision | undefined {
  // #202：token 级风险——critical 保护目标 dangerous；破坏性但有限操作 cautious，仅该层到达 reviewer
  const cmd = normalizeCommandName(tokens[0])
  // #202：敏感读取谨慎分层——读取 .env/SSH key/云凭据不是立即外传（非 dangerous），但会把密钥内容
  // #202：暴露给 shell 输出和模型上下文，所以从 safe 提升为 cautious，交 reviewer/user 判断
  if (readsSensitivePath(tokens)) return { level: "cautious", reason: "sensitive file read requires explicit approval" }
  // #202：rm -rf 针对保护目录 dangerous——其他目标 cautious 因虽危险但可能是有意操作
  if (cmd === "rm" && hasRecursiveForceDeleteFlags(tokens.slice(1))) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      // #197：rm -rf 针对根/home/etc 的 dangerous——递归强制删除保护目录不可恢复
      return { level: "dangerous", reason: "critical recursive delete" }
    }
    // #202：rm -rf 针对非保护目录 cautious——虽危险但可能是有意清理操作
    return { level: "cautious", reason: "recursive force delete requires explicit approval" }
  }
  // #197：dd 写裸盘/mkfs 格式化/shutdown 停机——均为不可逆系统级破坏，直接 dangerous
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/"))) return { level: "dangerous", reason: "raw disk write" }
  // #197：磁盘格式化和系统停机命令——不可逆系统级操作直接 dangerous
  if (["mkfs", "mkfs.ext4", "fdisk", "parted", "wipefs", "shutdown", "reboot", "halt", "poweroff"].includes(cmd)) {
    return { level: "dangerous", reason: "system destructive command" }
  }
  // #202：git reset --hard 可丢弃未提交工作区变更——cautious 需 reviewer/user 确认
  if (cmd === "git" && tokens[1] === "reset" && tokens.includes("--hard")) {
    return { level: "cautious", reason: "destructive git reset requires explicit approval" }
  }
  // #202：git clean -fd 删除未跟踪文件——cautious，不可逆且范围可能超出预期
  if (cmd === "git" && tokens[1] === "clean" && tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d"))) {
    return { level: "cautious", reason: "destructive git clean requires explicit approval" }
  }
  // #202：force push 覆盖远程历史——cautious，可导致他人提交丢失
  if (cmd === "git" && tokens[1] === "push" && tokens.some((item) => item === "--force" || item === "-f")) {
    return { level: "cautious", reason: "force push requires explicit approval" }
  }
  // #202：git 谨慎子命令——add/commit/merge/rebase/cherry-pick/revert/push/pull/reset/clean 及非安全 branch
  // #202：会修改索引/历史/引用/远端状态且难以自动恢复，标为 cautious 仅由 reviewer/user 判断
  if (cmd === "git" && cautiousGitSubcommand(tokens)) {
    return { level: "cautious", reason: "git state-changing command requires explicit approval" }
  }
  // #202：chmod 777 或 -R 放宽权限——cautious，可导致敏感文件变为全局可写
  if (cmd === "chmod" && tokens.some((item) => item === "777" || item === "-R")) {
    return { level: "cautious", reason: "permission widening requires explicit approval" }
  }
  // #202：chown 到 root 改变所有权——cautious，可绕过文件权限模型
  if (cmd === "chown" && tokens.some((item) => item.includes("root"))) {
    return { level: "cautious", reason: "root ownership change requires explicit approval" }
  }
  if (cmd === "remove-item" && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    if (tokens.slice(1).some((item) => protectedDeleteTarget(item))) {
      // #197：PowerShell Remove-Item -Recurse 针对保护目录——与 rm -rf / 等价的不可逆删除 dangerous
      return { level: "dangerous", reason: "critical PowerShell recursive delete" }
    }
    // #202：PowerShell 递归删除非保护目录——cautious，危险但可能有意
    return { level: "cautious", reason: "recursive PowerShell delete requires explicit approval" }
  }
  // #202：远程文件传输可移动凭证到外部主机——cautious，安全读取应用专用 read/glob/grep 工具
  if (["scp", "sftp", "rsync"].includes(cmd)) return { level: "cautious", reason: "remote file transfer requires explicit approval" }
}

// #202：cautiousGitSubcommand——识别修改索引/历史/引用/远端的 git 子命令。这些命令不应像 unknown 一样
// #202：只走 general/user，也不应直接 dangerous；标为 cautious 后仅 auto 分支的 reviewer/user 判断
function cautiousGitSubcommand(tokens: string[]) {
  const subcommand = tokens[1]
  if (!subcommand) return false
  if (["add", "commit", "merge", "rebase", "cherry-pick", "revert", "push", "pull", "reset", "clean"].includes(subcommand)) return true
  return subcommand === "branch" && !gitBranchSafe(tokens.slice(2))
}

// #203：读取或列出 .env、SSH key、云凭据等本地敏感位置不是立即外传，因此不是
// #203：dangerous；但它会把密钥内容或密钥存在性暴露给 shell 输出和模型上下文，
// #203：所以从 safe/general 提升为 cautious，交给 reviewer 判断是否确有授权
function readsSensitivePath(tokens: string[]) {
  const cmd = normalizeCommandName(tokens[0])
  if (!["cat", "type", "get-content", "gc", "get-childitem", "gci", "ls", "dir", "grep", "rg", "head", "tail", "less", "more", "sed", "awk"].includes(cmd)) {
    return false
  }
  return hasSensitivePath(tokens)
}

function joinShellTokens(tokens: string[]) {
  // #197：重组 cmd/WSL 载荷用于递归原始扫描——加引号保持空格完整，避免发明新分隔符，仍向 dangerousRaw 暴露危险子串
  return tokens.map((item) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`)).join(" ")
}

function decodePowerShell(input: string) {
  // #197：PowerShell 编码命令为 UTF-16LE base64——解码失败返回 general 而非 dangerous，因不透明编码文本有风险但无特定 dangerous 载荷证据
  try {
    return Buffer.from(input, "base64").toString("utf16le").replace(/^\uFEFF/, "")
  } catch {
    return
  }
}

function hasRecursiveForceDeleteFlags(tokens: string[]) {
  // #197：rm 接受组合短标志(-rf/-fr)、拆分短标志(-r -f/-R -f)或长标志——视为等价后检查保护目标，防止选项拼写将根删除从 dangerous 降级为 cautious
  return tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item)) && tokens.some((item) => item === "--force" || /^-[^-]*f/.test(item))
}

function protectedDeleteTarget(input: string) {
  // #197：保护根覆盖本地 POSIX 根、常见 home 别名、Windows 盘符根和 /etc——递归删除这些目标视为 dangerous 而非仅破坏性
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
  // #197：安全命令必须直接、本地且只读——敏感路径读取在命令特定检查前排除，使 `cat .env` cautious 而 `cat README.md` safe
  const cmd = normalizeCommandName(tokens[0])
  // #197：敏感路径检查优先于安全命令判定——即使 cat 是只读命令，读取 .env/密钥文件仍需 cautious
  if (hasSensitivePath(tokens)) return false
  // #197：基本只读命令直接 safe——这些命令无写入/网络/执行副作用
  if (["pwd", "whoami", "id", "uname", "which", "ls", "cat", "head", "wc", "file", "stat", "grep"].includes(cmd)) return true
  // #197：tail -f/--follow 持续跟踪文件——可监控日志但可能长时间持有文件描述符，排除后安全
  if (cmd === "tail") return !tokens.some((item) => item === "-f" || item === "--follow")
  // #202：rg --pre/--hostname-bin 可执行外部程序、--search-zip/-z 可解压——native shell backend 无 sandbox，不能进入 safe
  if (cmd === "rg") return !tokens.some(unsafeRipgrepFlag)
  // #197：find -delete/-exec 可修改文件系统——排除这些 flag 后 find 为只读遍历
  if (cmd === "find") return !tokens.some((item) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint"].includes(item))
  // #197：仅允许 sed -n 'Np' 打印模式——替换/写入/执行 flag 不安全
  if (cmd === "sed") return tokens.length <= 4 && tokens[1] === "-n" && /^\d+(?:,\d+)?p$/.test(tokens[2] ?? "")
  // #197：git 子命令需单独审查——global flag 可重定向到另一仓库
  if (cmd === "git") return gitSafe(tokens)
  // #197：包管理器仅只读查询子命令安全——install/run/exec 可执行任意代码
  if (["npm", "pnpm", "yarn"].includes(cmd)) return ["ls", "list", "view", "info", "why", "outdated"].includes(tokens[1])
  // #197：版本探测安全——但仅当所有参数为版本标志时
  return versionSafe(tokens)
}

function gitSafe(tokens: string[]) {
  // #197：仅只读 git 子命令安全——改变 config/worktree/exec-path 的 global flag 被拒绝，因可将安全子命令重定向到另一仓库或 helper
  // #202：--ext-diff/--textconv 可调用外部 diff/textconv 程序，read-looking 但有执行副作用，从 safe 排除
  const unsafeGlobal = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"])
  const unsafeReadFlag = new Set(["--ext-diff", "--textconv"])
  const safe = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"])
  let subcommand: string | undefined
  for (let i = 1; i < tokens.length; i++) {
    // #197：unsafe global flag 可重定向 git 操作到另一仓库或注入配置——任何安全子命令在 -C/-c 下都不安全
    if (unsafeGlobal.has(tokens[i]) || Array.from(unsafeGlobal).some((item) => tokens[i].startsWith(item + "="))) return false
    // #202：unsafe read flag 可执行外部 diff/textconv 程序——read-looking 但有执行副作用
    if (unsafeReadFlag.has(tokens[i])) return false
    // #197：git remote -v 仅列出远程——其他 remote 子命令可 add/rename/remove
    if (tokens[i] === "remote") return tokens[i + 1] === "-v"
    // #197：git config --get/--list 只读——其他 config 子命令可写入设置
    if (tokens[i] === "config") return tokens[i + 1] === "--get" || tokens[i + 1] === "--list"
    // #197：git branch 需单独审查——既是只读列表也是 ref 变更命令
    if (tokens[i] === "branch") return gitBranchSafe(tokens.slice(i + 1))
    // #202：第一个非 flag token 是子命令——记录后继续扫描 global flag，仅在安全集合内才 safe
    if (!tokens[i].startsWith("-") && !subcommand) subcommand = tokens[i]
  }
  // #202：仅有 flag 无子命令时不安全——git 不带子命令的行为不可判定
  return subcommand ? safe.has(subcommand) : false
}

// #202：unsafeRipgrepFlag——rg --pre/--hostname-bin 会执行外部程序，--search-zip/-z 可解压；
// #202：native shell backend 无 sandbox，这些 read-looking 命令不能进入 safe 直通路径
function unsafeRipgrepFlag(item: string) {
  return item === "-z" || item === "--pre" || item.startsWith("--pre=") || item === "--hostname-bin" || item.startsWith("--hostname-bin=") || item === "--search-zip" || item.startsWith("--search-zip=")
}

function gitBranchSafe(args: string[]) {
  // #197：git branch 既是只读列表命令也是 ref 变更命令——仅允许无参数列表和查询分支状态的 flag，不接受分支名目标
  const allowed = new Set(["--show-current", "--list", "-l", "--all", "-a", "--remotes", "-r", "-v", "-vv"])
  return args.every((item) => allowed.has(item))
}

function versionSafe(tokens: string[]) {
  // #197：版本探测对常见运行时/包管理器安全——但仅当所有参数为版本标志时，防止隐藏包安装/运行形式
  const cmd = normalizeCommandName(tokens[0])
  if (!["node", "python", "python3", "bun", "npm", "pnpm", "yarn"].includes(cmd)) return false
  return tokens.length > 1 && tokens.slice(1).every((item) => item === "--version" || item === "-v" || item === "-V")
}

function hasSensitivePath(tokens: string[]) {
  // #197：镜像 SENSITIVE_PATH_PATTERN 用于 token 化直接读取——原始模式捕获外泄语法，token 模式将本地密钥读取从 safe 降级为 cautious
  // #202：扩展endsWith/精确匹配，覆盖 /home/alice/.aws/credentials、credentials.json、id_rsa 等非 ~ 前缀路径
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
  // #197：规范化路径和 Windows 可执行后缀——使策略常量无需为 /usr/bin/git、git.exe、PowerShell.EXE 添加重复条目
  const name = input.replaceAll("\\", "/").split("/").at(-1) ?? input
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase()
}

export * as PermissionPrecheck from "./precheck"

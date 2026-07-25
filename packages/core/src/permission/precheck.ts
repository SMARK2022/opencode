// #220：precheck.ts — shell 命令静态启发式预分类器
// #220：设计哲学：fail-closed。无法理解的语法/动态展开/编码混淆都降级为 general 或更高风险层级
// #220：分层：raw 扫描 → 包装器递归 → 结构解析 → token 分类 → 聚合
// #220：不变量：包装器永不 safe；splitCommands 未建模语法降级；dangerous 短路
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
// #220：核心敏感路径模式（不含 .pem/.key）——本地读取检测用
const SENSITIVE_PATH_CORE_PATTERN = String.raw`(?:\.env(?:\.[^\s|;]+)?|${WINDOWS_HOME_SENSITIVE_PATH_PATTERN}|(?:~|[^\s|;]+)\/\.ssh(?:\/?[^\s|;]+)?|(?:~|[^\s|;]+)\/\.aws(?:\/credentials)?|(?:~|[^\s|;]+)\/\.config\/gcloud(?:\/?[^\s|;]+)?|(?:~|[^\s|;]+)\/\.kube\/config|(?:~|[^\s|;]+)\/\.npmrc|(?:~|[^\s|;]+)\/\.netrc|(?:~|[^\s|;]+)\/\.git-credentials|credentials\.json|${SSH_PRIVATE_KEY_NAME_PATTERN})`
// #220：完整敏感路径模式（含 .pem/.key）——仅用于外传检测
const SENSITIVE_PATH_PATTERN = SENSITIVE_PATH_CORE_PATTERN + String.raw`|[^\s|;]+\.pem|[^\s|;]+\.key`
// #202：敏感路径参数匹配——raw 扫描发生在 shell quote 移除之前，允许敏感路径外侧有一层引号，
// #202：避免 `cat ".env" | curl ...` 这类明显外传被降级成 cautious reviewer 判断
const SENSITIVE_PATH_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_PATTERN}["']?`
// #220：本地读取用窄版参数模式（不含 .pem/.key）——减少误报
const SENSITIVE_PATH_LOCAL_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_CORE_PATTERN}["']?`
// #217：raw 层文件删除/移动模式——在 dangerousRaw 之后、token 化之前运行，
// #217：捕获不透明 shell（重定向、命令替换、SSH/WSL 载荷、不支持分隔符）中的可见文件变更
const RAW_COMMAND_START = "(?:^|[;&|{(]\\s*|[\\r\\n]\\s*|\\$\\(\\s*|`\\s*)"
const RAW_COMMAND_PATH = String.raw`(?:[^\s|;&(){}'"]+[\\/])*`
const RAW_FILE_DELETE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:rm|unlink|rmdir|del|erase|rd|Remove-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`
const RAW_FILE_MOVE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:mv|move|ren|rename|Move-Item|Rename-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`

// #220：预编译正则常量——dangerous raw 层，模块加载时编译一次。
// 递归保护根判定仅依赖递归标志：-f（force）只压制提示符不增加破坏性，
// rm -r / 与 rm -rf / 破坏力等价，不应把 -f 作为 dangerous 门槛。
// 系统根（/etc、/usr 等）保护所有子目录；用户数据根（/home、/Users）仅保护
// 根本身和一级子目录（用户家目录），深层子目录是正常用户操作不视为保护根；
// /root 仅保护根本身，子目录不保护
const POSIX_SYSTEM_ROOTS = String.raw`etc|usr|var|lib(?:64)?|s?bin|boot|sys|proc|dev|opt|Library|Applications|System`
const POSIX_USER_DATA_ROOTS = String.raw`home|Users`
const RE_D_RM_RF_ROOT = new RegExp(
  String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?\s*(?=[\s)'"` + "`" + String.raw`]|$)|~\/?(?=[\s)'"` + "`" + String.raw`]|$)|\$HOME\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_SYSTEM_ROOTS})(?:\/|(?=[\s)'"` + "`" + String.raw`]|$))|\/(?:${POSIX_USER_DATA_ROOTS})\/[^\/\s)'"` + "`" + String.raw`|;]+\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_USER_DATA_ROOTS}|root)\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_USER_DATA_ROOTS})\/\.\.(?:\/|(?=[\s)'"` + "`" + String.raw`]|$)))`,
)
const RE_D_CURL_PIPE_INTERPRETER = /\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i
const RE_D_PS_DOWNLOAD_EXEC = /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i
const RE_D_DECODE_PIPE_INTERPRETER = /\b(?:base64|openssl|xxd|gunzip|bunzip2|unxz|zcat)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|dash|fish|ksh|python|python3|node|ruby|perl|pwsh|powershell)\b/i
const RE_D_WINDOWS_FORMAT = /\bformat\b\s+[A-Za-z]:/i
// #530：旧 RE_D_WINDOWS_PROTECTED_DELETE 整串正则已删——跨段 .* 共现把 python heredoc（del + tree-sitter 的 -s + if not m: 盘符形）
// 误报 dangerous；改由 windowsProtectedDeleteInCommand 同段 token 谓词承载（见 protectedDeleteTarget 附近）。
const RE_D_CREDENTIAL_PIPE_NETWORK = new RegExp(String.raw`\b(?:cat|type|Get-Content|gc|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})[^|;]*\|\s*(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,"i",)
const RE_D_CREDENTIAL_UPLOAD_FLAG = new RegExp(String.raw`\b(?:curl|wget)\b(?=.*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|--form-string|-T)(?:\s+|=)(?:[^\s|;=@]+(?:=|@)@?)?@?${SENSITIVE_PATH_ARGUMENT_PATTERN})`,"i",)
const RE_D_CREDENTIAL_REMOTE_TRANSFER = new RegExp(String.raw`\b(?:scp|rsync|sftp)\b(?=.*${SENSITIVE_PATH_ARGUMENT_PATTERN})(?=.*:)`,"i",)
const RE_D_PS_RECURSIVE_DELETE_ROOT = /\bRemove-Item\b(?=.*\s-Recurse\b)(?=.*\s(?:\/|~\/?|\$HOME\/?|\$env:USERPROFILE[\\/]?|\$env:SystemDrive[\\/]?|[A-Za-z]:[\\/]?)(?=[\s)'"\x60]|$))/i
const RE_D_PYTHON_RMTREE = /\bshutil\.rmtree\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/
const RE_D_PYTHON_REMOVE = /\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/
const RE_D_NODE_REMOVE = /(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/
const RE_D_SUBPROCESS_RM = /\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/
const RE_D_REVERSE_SHELL = /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^|;]*(?:\s-e\s|\s--exec\s|\s--sh-exec\s)|\bsocat\b[^|;]*EXEC:|bash\s+(?:-i\s+)?[>&]+\s*\/dev\/tcp\/|\bmkfifo\b[^|;]*\b(?:sh|bash)\b|\bNew-Object\s+System\.Net\.Sockets\.TCPClient\b/i
// #222：SSH authorized_keys 写入（后门持久化访问）。除 ~/$HOME 外，也覆盖常见
// #222：绝对家目录；重定向会让结构解析降级，因此必须在 raw 层捕获。
const RE_D_AUTHORIZED_KEYS_WRITE = />>?\s*["']?(?:(?:~|\$HOME)[\\/]|\/(?:home\/[^\/|;]+|root|Users\/[^\/|;]+)[\\/]|[A-Za-z]:[\\/]Users[\\/][^\/|;]+[\\/])?\.ssh[\\/]authorized_keys/i
const RE_D_SUDOERS_WRITE = /(?:>>?\s*["']?\/etc\/sudoers|\bvisudo\b)/i
const RE_D_CHMOD_SETUID = /\bchmod\b[^|;]*\b[ug]\+s\b/i
const RE_D_IPTABLES_FLUSH = /\b(?:iptables|ip6tables)\b[^|;]*(?:\s-F\b|\s-X\b|\s--flush\b|\s--delete-chain\b)/i
const RE_D_UFW_DISABLE = /\bufw\s+disable\b/i
const RE_D_KILL_ALL = /\bkill\b[^|;]*\s-9\b[^|;]*\s-1\b/i

// #220：预编译正则常量——cautious raw 层
const RE_C_SHELL_RC_WRITE = />>?\s*["']?(?:~|\$HOME)?[\\/]?\.(?:bash(?:rc|_profile|_login|_logout)|zshrc|zprofile|zlogin|profile|login|cshrc|tcshrc)["']?(?:\s|$)/i
const RE_C_GIT_HOOKS_WRITE = />>?\s*["']?[^\s]*\.git[\\/]hooks[\\/]/i
const RE_C_SCHTASKS_CREATE = /\bschtasks\b[^|;]*\/create\b/i
const RE_C_REGISTER_SCHEDULED_TASK = /\bRegister-ScheduledTask\b/i
const RE_C_CRON_WRITE = />>?\s*["']?\/(?:etc\/cron|var\/spool\/cron)/i
const RE_C_SYSTEMD_WRITE = />>?\s*["']?(?:\/etc\/systemd|~\/\.config\/systemd)[\\/]/i
const RE_C_ECHO_PIPE_INTERPRETER = /\b(?:echo|printf)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|dash|fish|ksh|python|python3|node|ruby|perl|pwsh|powershell)\b/i
const RE_C_SENSITIVE_READ = new RegExp(String.raw`\b(?:cat|type|Get-Content|gc|Get-ChildItem|gci|ls|dir|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_LOCAL_ARGUMENT_PATTERN})`,"i",)
// #222：find/Python 删除规则按可执行命令切出 token 后判断，避免第一个 safe `find`
// #222：看穿到后续 quoted search 文本，也保留 `"-delete"`/`'rm'` 这类 shell
// #222：引号移除后仍会执行的参数形态。
const RAW_FIND_OR_PYTHON_COMMAND_PATTERN = String.raw`${RAW_COMMAND_START}(${RAW_COMMAND_PATH}\b(?:find|python|python3|py)\b)`
const RE_C_PYTHON_FILE_REMOVE_CALL = /\bos\.(?:remove|unlink|rmdir)\(\s*["'][^"']+["']/
// #217：token 级文件删除/移动集合——与 raw 层模式镜像，路径限定的二进制（如 /bin/rm）在 token 化成功后也无法绕过审查
const FILE_DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "del", "erase", "rd", "remove-item", "trash-put"]) // #222：trash-put 是 trash-cli 的删除命令
const FILE_MOVE_COMMANDS = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item"])
// #220：系统级破坏性命令——执行即不可逆，直接 dangerous
const SYSTEM_DESTRUCTIVE_COMMANDS = new Set([
  "mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs",
  "fdisk", "parted", "wipefs",
  "shutdown", "reboot", "halt", "poweroff",
])
// #220：用户/组账号管理命令——修改系统用户数据库
const USER_ACCOUNT_COMMANDS = new Set([
  "useradd", "userdel", "groupadd", "groupdel", "chpasswd", "passwd",
  "usermod", "adduser", "deluser", "addgroup", "delgroup",
])


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
  // #220: 包执行器前缀——npx/pipx/uvx 可下载并运行不受信任的代码
  ["npx"],
  ["pipx"],
  ["pipx", "run"],
  ["uvx"],
]

export function evaluate(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision {
  const externalDirectory = externalDirectoryEffect(input)
  if (externalDirectory) return externalDirectory
  const fileEffect = structuredFileEffect(input)
    // #230：结构化文件效果优先于通用规则——delete 是不可逆效果，必须谨慎处理
  if (fileEffect) return fileEffect

  // #232：bash 与所有 external_directory 边界携带足够上下文做确定性预审；其他权限
  // #232：默认回到 general allow，除非上方的结构化边界（如 workspace delete metadata）
  // #232：先把它们提升到 cautious。
  if (input.permission !== "bash") return { level: "general", reason: "precheck only has bash coverage" }
  return bashEffect(input)
}

function bashEffect(input: {
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}) {
  const command = typeof input.metadata.command === "string" ? input.metadata.command : undefined
  // #285：metadata.command 缺省时退化为 patterns 拼接，保持与旧 evaluateShell 兼容；
  // 存在原始命令时始终以其为最低基线
  const patternCommand = input.patterns.join(" && ")
  if (!command) return evaluateShell(patternCommand, 0)

  // 原始命令、canonical与最终inline源码取最高风险，附加证据不能降低既有判断。
  const raw = shellEvidenceRisk(command, input.metadata)
  if (!patternCommand.trim() || patternCommand === command) return raw
  // #285：canonical 与原始命令相同时无需二次评估，避免重复解析

  // #285：shell metadata 是原始审计证据，permission patterns 是 canonical 规则键。
  // auto precheck 必须同时考虑两个视角并保留更高风险，防止原始危险载荷被削弱，
  // 也不能让 env 赋值将 git push --force 从 cautious 降为 general。
  return maxRisk(raw, evaluateShell(patternCommand, 0))
}

// 附加证据是没有python -c前缀的源码；补单文件删除分类，畸形项不降低原风险。
// 复用既有classifier和maxRisk，不建立另一套Python执行或审批路径。
function shellEvidenceRisk(command: string, metadata: Readonly<Record<string, unknown>>): Decision {
  const scripts = Array.isArray(metadata.inline_scripts)
    ? metadata.inline_scripts.filter((item): item is string => typeof item === "string")
    : []
  return scripts.reduce((risk, script) => {
    const scriptRisk = RE_C_PYTHON_FILE_REMOVE_CALL.test(script)
      ? maxRisk(evaluateShell(script, 0), { level: "cautious", reason: "Python file deletion requires explicit approval" })
      : evaluateShell(script, 0)
    return maxRisk(risk, scriptRisk)
  }, evaluateShell(command, 0))
}

function maxRisk(left: Decision, right: Decision) {
// #285：双视角取风险更高者——env 赋值不得降低 git push --force 的 cautious 等级，
// 原始危险载荷也不得因安全 pattern 被降级
  return LEVELS.indexOf(right.level) > LEVELS.indexOf(left.level) ? right : left
}

// #232：external_directory 边界统一为 cautious review seam——shell 发起的访问复用同一条
// #232：命令的确定性预审，dangerous payload 仍 deterministic deny；其他外部路径（含
// #232：glob/grep/lsp/repo_overview 等只读工具）不再需要逐工具证据即可进入 reviewer。
function externalDirectoryEffect(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision | undefined {
  if (input.permission !== "external_directory") return

  if (input.metadata.action_kind === "shell") {
    // [local-smark] external_directory 第一道门禁：与 bashEffect 同一
    // shellEvidenceRisk，dangerous inline source 在此即 deterministic deny
    const shell = shellEvidenceRisk(
      typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "),
      input.metadata,
    )
    // #232：已经确定性的危险 shell 载荷必须在 external_directory 门禁保持 deny——
    // #232：否则 rm -rf / 仅因同时跨越外部路径边界就会变成 reviewer 可审批。
    if (shell.level === "dangerous") return shell
  }

  // #232：该 reason 命名外部路径边界的 cautious seam；刻意不依赖逐工具证据，
  // #232：使 glob/grep/lsp/repo_overview 等只读工具不因缺少写类载荷退回可点击 ask。
  return { level: "cautious", reason: "external directory access requires auto review" }
}

function structuredFileEffect(input: {
    // #230：仅 edit/external_directory 两类携带结构化效果 metadata——其他权限无此证据
  permission: string
  metadata: Readonly<Record<string, unknown>>
}): Decision | undefined {
  // apply_patch 的项目内执行最终通过 edit 权限，并在 metadata.files 中携带
  // add/update/delete/move 的结构化效果。这里仅提升 delete：普通 update 继续
  // 走既有 non-shell general 路径。必须限定 permission=edit，避免其他工具恰好
  // 使用 files metadata 时被误归类为 workspace edit 删除。
  if (
    input.permission === "edit" &&
    // #230：edit 权限的 files 数组含 delete 项即提升 cautious——update/add 不提升
    Array.isArray(input.metadata.files) &&
    input.metadata.files.some((item) => fileEffectType(item) === "delete")
  ) {
    // #232：该 reason 命名 delete 专属的 cautious seam 供 reviewer 审计——普通 update
    // #232：不得共享它；apply_patch 项目外删除统一由 externalDirectoryEffect 覆盖。
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  }
}

function fileEffectType(input: unknown) {
    // #230：files 元素可能来自外部 metadata——用 type 字段而非 instanceof 判定
  if (!input || typeof input !== "object" || !("type" in input)) return
  return input.type
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

  // #217：包装器载荷递归——重定向或不支持分隔符会让整条命令不透明，
  // #217：扫描未引用段以发现可见的包装器载荷，破坏性脚本体保留 cautious/dangerous 层级
  for (const wrapped of rawWrapperScripts(command)) {
    const decision = evaluateShell(wrapped, depth + 1)
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
  }

  // #355：splitCommands 对未建模语法按段降级为 opaque(general) 而非整条丢弃，
  // #355：故一个 bail 字符不会藏掉同条命令里其它干净段的 cautious/dangerous
  // #355：（修 `scp; echo $HOME` / `scp 2>&1` 类绕过）。
  const { segments, opaque } = splitCommands(command)
  const decisions = segments.map((item) => evaluateCommand(item, depth))
  // #355：opaque 段以 general 参与 max 聚合：既不允许整条降为 safe，也保留干净
  // #355：cautious 段的审查信号。无任何可分析段（整条 opaque）时回退 general，等价旧行为。
  if (opaque) decisions.push({ level: "general", reason: "opaque shell segment requires explicit approval" })
  if (decisions.length === 0) return { level: "general", reason: "opaque shell command requires explicit approval" }
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
  // #220: token 层启发式分类——按威胁类别逐项检查
  const risk = classifyTokens(tokens)
  // #197：风险判定优先于安全判定——已知破坏性命令即使用只读子命令形式也不自动放行
  if (risk) return risk
  // #197：通过只读不变量验证的命令才 safe——安全命令必须直接、本地且只读
  if (safeTokens(tokens)) return { level: "safe", reason: "known read-only shell command" }
  // 未知前缀穿透启发式：tokens[0] 不命中任何已知 cmd 分支时，RAW_FILE_DELETE
  // 等需 `;`/`&`/`\n` 起点的 raw 正则看不到空格后的内层 rm 等，token 层也
  // 因 cmd=tokens[0] 而漏过。剥去前缀后对 tokens.slice(1) 再分类一次。
  // 仅升 cautious ——dangerous 仍由 raw 层确定性短路（evaluateShell 先跑
  // dangerousRaw），启发式不越权升级到 dangerous，避免把 token 独有的
  // mkfs / dd of=/dev / setcap 等在前缀遮蔽下从 general 跳到 dangerous。
  // 注意：POSIX 形如 `KEY=value cmd` 的环境变量赋值前缀不在此启发式范围——
  // bashEffect 的 patterns 通常不含前置 env，故 pattern 路径直接命中 classifyGit；
  // raw 路径受 env 排除保持 general，maxRisk 取 pattern 的 cautious 及其 reason，
  // 避免剥头路径产生不同 reason 改写既有断言（如 L704 force push reason）。
  if (tokens.length > 1 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const stripped = classifyTokens(tokens.slice(1))
    if (stripped?.level === "cautious") {
      const inner = normalizeCommandName(tokens[1])
      return {
        level: "cautious",
        // 审计线索：透传被未知前缀遮蔽的内层命令名和原始 reason
        reason: `unknown wrapper prefix shadows ${inner}; ${stripped.reason}`,
      }
    }
  }
  // #197：未识别命令无法证明只读——默认 general 确保未知命令不因缺乏危险特征而自动放行
  return { level: "general", reason: "unknown shell command" }
}

function splitCommands(command: string): { segments: string[]; opaque: boolean } {
  // #355：此分割器只识别可组合已安全命令的简单分隔符（; | && ||）。遇到未建模语法
  // #355：（动态展开 $/反引号、子 shell ()、大括号 {}、glob *?[、文件重定向 ><、
  // #355：后台单 &、换行）时，仅让**当前段**降级为 opaque(general) 并从下一字符起重开
  // #355：新段，不毒化同条命令的其它干净段——故 `scp; echo $HOME` 中后段 `$` 不会
  // #355：藏掉前段 scp 的 cautious。整条都 opaque 时等价旧的"整条→general"。
  const segments: string[] = []
  let opaque = false
  // tainted 标记当前段是否由 bail 字符重开（即 bail 之后的残余片段）。残余片段
  // 是被未建模语法切碎的 token 残骸（如 `echo $mkfs` 中 `$` 之后的 "mkfs"），
  // 并非真实命令——分类它会把变量名误判为危险命令（mkfs→dangerous 误拒）。
  // 故 tainted 段只记 opaque(general)，不入 segments 参与分类；分隔符会重置它，
  // 因为分隔符之后是真实的新命令。与剥头启发式"不越权升 token 层 dangerous"一致。
  let tainted = false
  let start = 0
  let quote = ""
  let escaped = false

  // 分隔符处收尾当前段：非空且未 tainted→干净段入列；空段或 tainted 段→记 opaque
  // （前导/尾部/连续分隔符的空侧、bail 残骸，保既有 general 而非 safe/误判）
  const pushSegment = (end: number) => {
    const segment = command.slice(start, end).trim()
    if (segment && !tainted) segments.push(segment)
    else opaque = true
    tainted = false
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    // #220：POSIX 单引号内反斜材是字面量，不应作为转义符处理
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      // #555：双引号内 $/` 仍可能展开：整条不得升 safe（opaque→general），但不可 taint-restart。
      // #555：taint-restart 会丢掉前缀 `git …` argv，使 classifyGit 不可达，auto 把 general 直过 allow。
      else if (quote !== "'" && (char === "$" || char === "`")) opaque = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    // #355：fd-merge 重定向（2>&1 / 1>&2 / >&2 / 2>&- 等）：仅合并或关闭 fd，不写文件，
    // #355：属良性。原子消费 >/< + & + fd 数字串/- 并继续当前段，避免误 bail 让
    // #355：`scp 2>&1` 因 `>` 或 `&` 落入 opaque 而绕过 scp 的 cautious 审查。
    // #355：必须在下方 `>`/`<` 与单 `&` 的 bail 判断之前命中并 continue——否则 `2>&1`
    // #355：里的 `&` 会触发单 `&` bail 使本改动失效。
    if ((char === ">" || char === "<") && command[i + 1] === "&" && (/\d/.test(command[i + 2]) || command[i + 2] === "-")) {
      let j = i + 2
      if (command[j] === "-") j++
      else while (/\d/.test(command[j])) j++
      i = j - 1
      continue
    }

    // #555：空重定向到 /dev/null（含 2>/dev/null）：丢弃流、不写普通文件，与 fd-merge 同属良性。
    // #555：若按普通 `>` bail，会 taint 掉 `git reset … 2>/dev/null` 的前缀 token 分类。
    if ((char === ">" || char === "<") && command.startsWith("/dev/null", i + 1)) continue

    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      pushSegment(i)
      i++
      start = i + 1
      continue
    }
    if (char === ";" || char === "|") {
      pushSegment(i)
      start = i + 1
      continue
    }

    // #355：未建模 shell 语法：当前段 opaque（不入 segments），紧随其后字符起开始新段。
    // #355：不再 return 整条，避免一个 bail 字符毒化已切出的干净 cautious 段。
    // #355：单 `&`（后台）与换行在此 opaque 而非切分——保 `git status & rg`/`git status\nrg`
    // #355：为 general，不能 split 否则会变 safe。
    // #555：`$`/反引号只标 opaque、不 taint-restart，保留前缀 argv 给 classifyTokens/classifyGit；
    // #555：max(safe, general)=general，max(cautious, general)=cautious，堵住 auto 直过洞。
    if (char === "$" || char === "`") {
      opaque = true
      continue
    }
    if (
      char === "(" || char === ")" ||
      char === "{" || char === "}" || char === "*" || char === "?" || char === "[" ||
      char === ">" || char === "<" || char === "&" || char === "\n" || char === "\r"
    ) {
      opaque = true
      tainted = true
      start = i + 1
      continue
    }
  }

  // #355：未闭合引号/悬挂转义：末段 opaque（`git status '` → general，保既有行为）
  if (quote || escaped) opaque = true
  else pushSegment(command.length)

  return { segments, opaque }
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
    // #220：POSIX 单引号内反斜材是字面量，不应作为转义符处理
    if (char === "\\" && quote !== "'") {
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
      // #220：cmd /c 语义是将 /c 之后所有参数拼成一条命令执行，统一使用空格拼接以保留内容完整性
      return { action: "script", script: tokens.slice(index + 1).join(" "), reason: "cmd wrapper requires explicit approval" }
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
  // #220：bun x 移至 classifyTokens 中处理为 cautious，不再在 unwrap 中损害为 ask
  // #197：env 可修改环境变量后执行命令——修改后的环境可改变程序行为和安全边界
  if (cmd === "env") return { action: "ask", reason: "env wrapper requires explicit approval" }
  // #197：提权 wrapper 放大命令影响范围——sudo/doas/su/pkexec 后的命令以更高权限执行
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    // 特权包装器：提取内层命令递归评估，而非短路为 ask。
    // sudo rm file 应至少 cautious，sudo rm -rf / 应 dangerous
    if (tokens.length > 1)
      return { action: "script", script: joinShellTokens(tokens.slice(1)), reason: "privilege wrapper requires explicit approval" }
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  // #197：非 wrapper 分支返回 none——none 不等于 allow，调用方继续 token 级判定，避免此处单点放行
  return { action: "none" }
}

// #217：rawWrapperScripts——顶层重定向或不支持分隔符可在逐命令解包前让整条命令不透明。
// #217：扫描未引用命令段以发现可见的包装器载荷，使得破坏性脚本体仍保留 cautious/dangerous 层级
function rawWrapperScripts(command: string) {
  return rawCommandSegments(command).flatMap((segment) => {
    const script = rawWrapperScript(segment)
    return script ? [script] : []
  })
}

// #217：rawWrapperScript——对单个命令段调用 unwrap/remoteWrapper 提取脚本载荷
function rawWrapperScript(command: string) {
  // #217：先尝试本地 wrapper 解包，再尝试远程 wrapper——两种路径都可能暴露可检查的脚本载荷
  const tokens = tokenize(command)
  if (!tokens) return
  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") return unwrapped.script
  const remote = remoteWrapper(tokens)
  return remote.action === "remote" ? remote.script : undefined
}

// #217：rawCommandSegments——按 shell 分隔符切分命令为独立段，跳过引号内的分隔符。
// #217：POSIX 单引号内反斜材为字面量，不开启转义状态，避免错误地在格式错误的单引号数据后隐藏可见删除
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
    // #217：切分出当前段——分颞粒度足以让 rawWrapperScript 对每个段独立解包
    const segment = command.slice(start, i).trim()
    if (segment) out.push(segment)
    // #217：&& 和 || 是双字符分隔符——跳过第二个字符避免误切
    if ((char === "&" || char === "|") && command[i + 1] === char) i++
    start = i + 1
  }
  const tail = command.slice(start).trim()
  return tail ? [...out, tail] : out
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

// #220：dangerousRaw——使用预编译正则常量，在 token 化之前拦截跨管道/编码/命令替换内的危险载荷
// raw 层正则用 [^|;]* 作为段边界，只在 ; 和 | 处截断。但 shell 换行
// 也是命令分隔符；若归一化时把 \n 变成空白，[^|;]* 就会跨过换行把
// 下一条命令的参数混入当前命令，导致误报（如 rm -rf /tmp/foo\n/Users）。
// 将命令分隔型换行转为 " ; " 让 [^|;]* 在 ; 处截断；而管道续行
// （\n 后跟 |）前的换行保留为空格，避免断裂管道检测。
// 注意：& 和 && 不属于续行豁免——[^|;]* 不排除 &，保留为空格会让
//  [^|;]* 仍能跨过 && 将下一命令的参数混入，重引入同类误报。
function normalizeForRawScan(command: string): string {
  return command
    .replace(/[ \t]+/g, " ")
    .replace(/[\n\r]+/g, (match, offset, input) => {
      const after = input.slice(offset + match.length).trimStart()
      // 仅管道续行符 | 前的换行是装饰性空白；& 在 [^|;]* 中是普通字符不豁免
      if (after.startsWith("|")) return " "
      return " ; "
    })
    .replace(/ +/g, " ")
    .trim()
}

function dangerousRaw(command: string): string | undefined {
  const normalized = normalizeForRawScan(command)
  // 在 token 化之前拦截 $HOME、~/、/* 和包装器引号形式。
  // 折叠多斜杠（/home//user → /home/user）并解析 .. 穿越（/root/../etc → /etc），
  // 归一化后才能正确匹配保护根路径
  let rawNormalized = normalized.replace(/(?!^)\/{2,}/g, "/")
  while (/\/[^/\s]+\/\.\.(?=\/|$)/.test(rawNormalized)) {
    rawNormalized = rawNormalized.replace(/\/[^/\s]+\/\.\.(?=\/|$)/, "")
  }
  if (RE_D_RM_RF_ROOT.test(rawNormalized)) return "critical recursive delete"
  if (RE_D_CURL_PIPE_INTERPRETER.test(normalized))
    return "remote download piped to interpreter; review the script locally before running safe commands"
  if (RE_D_PS_DOWNLOAD_EXEC.test(normalized))
    return "remote PowerShell download executed as code; review the script locally before running safe commands"
  // #220：解码/解压载荷管道到解释器——载荷不可见，必须阻止
  if (RE_D_DECODE_PIPE_INTERPRETER.test(normalized))
    return "decoded/decompressed payload piped to interpreter"
  if (RE_D_WINDOWS_FORMAT.test(normalized)) return "Windows drive format"
  // #530：Windows 保护递归删除：同段 token 谓词（禁整串子串共现误报）
  if (windowsProtectedDeleteInCommand(normalized)) return "Windows protected directory delete"
  // #220：凭据外传——敏感文件读取管道到网络传输是 dangerous
  if (RE_D_CREDENTIAL_PIPE_NETWORK.test(normalized)) return "credential read piped to network transfer"
  if (RE_D_CREDENTIAL_UPLOAD_FLAG.test(normalized)) return "credential file sent with network transfer"
  if (RE_D_CREDENTIAL_REMOTE_TRANSFER.test(normalized)) return "credential file sent with remote transfer"
  if (RE_D_PS_RECURSIVE_DELETE_ROOT.test(normalized)) return "critical PowerShell recursive delete"
  if (RE_D_PYTHON_RMTREE.test(normalized)) return "critical Python recursive delete"
  if (RE_D_PYTHON_REMOVE.test(normalized)) return "critical Python file removal"
  if (RE_D_NODE_REMOVE.test(normalized)) return "critical Node.js file removal"
  if (RE_D_SUBPROCESS_RM.test(normalized)) return "critical recursive delete through interpreter"
  // #220：反弹 shell——含扩展变体（/dev/tcp、nc -e、socat、bash >&/dev/tcp、mkfifo、PowerShell TCPClient）
  if (RE_D_REVERSE_SHELL.test(normalized)) return "reverse shell pattern"
  // #222：authorized_keys 和防火墙保护移除降级到 cautiousRaw——常见于用户明确的运维任务
  if (RE_D_SUDOERS_WRITE.test(normalized)) return "sudoers modification grants privilege escalation"
  // #220：特权升级——setuid/setgid 位创建特权升级面
  if (RE_D_CHMOD_SETUID.test(normalized)) return "setuid/setgid bit creates privilege escalation surface"
  // #220：全进程终止
  if (RE_D_KILL_ALL.test(normalized)) return "mass process kill"
}

// #220：cautiousRaw——引号感知的文件删除/移动 + 持久化写入 + 可见载荷管道 + 本地敏感读取
function cautiousRaw(command: string): string | undefined {
  if (rawExecutableMatch(command, RAW_FILE_DELETE_PATTERN)) return "file deletion requires explicit approval"
  if (rawExecutableMatch(command, RAW_FILE_MOVE_PATTERN)) return "file move or rename requires explicit approval"
  const normalized = normalizeForRawScan(command)
  // #355：持久化写入（重定向目标）——splitCommands 遇重定向把该段降级为 opaque(general)，必须在 raw 层捕获
  if (RE_C_SHELL_RC_WRITE.test(normalized)) return "shell RC file modification enables persistent code execution"
  if (RE_C_GIT_HOOKS_WRITE.test(normalized)) return "git hook modification runs code on git operations"
  if (RE_C_CRON_WRITE.test(normalized)) return "cron directory write enables persistent scheduled execution"
  if (RE_C_SYSTEMD_WRITE.test(normalized)) return "systemd unit file write enables persistent service execution"
  if (RE_C_SCHTASKS_CREATE.test(normalized)) return "Windows scheduled task creation enables persistent execution"
  if (RE_C_REGISTER_SCHEDULED_TASK.test(normalized)) return "PowerShell scheduled task registration enables persistent execution"
  // #220：可见载荷管道到解释器——echo/printf 内容可审查但仍需人工确认
  if (RE_C_ECHO_PIPE_INTERPRETER.test(normalized)) return "visible payload piped to interpreter requires review"
  // #220：本地敏感路径读取——使用不含 .pem/.key 的窄版模式减少误报
  if (RE_C_SENSITIVE_READ.test(normalized)) return "sensitive file read requires explicit approval"
  // #222：authorized_keys 和防火墙保护移除风险很高，但常见于用户明确的运维任务；
  // #222：保持 cautious 让 reviewer 判断授权与上下文，根目录删除等不可逆破坏仍在
  // #222：dangerousRaw 中 fail-closed。
  if (RE_D_AUTHORIZED_KEYS_WRITE.test(normalized)) return "SSH authorized_keys modification requires explicit approval"
  if (RE_D_IPTABLES_FLUSH.test(normalized) || RE_D_UFW_DISABLE.test(normalized))
    return "firewall protection removal requires explicit approval"
  // #222：find/Python 删除在 raw 层也需要捕获——重定向和命令替换会让 tokenizer 降级
  const rawTokens = rawFindOrPythonTokens(command)
  if (rawTokens.some(findDeletesFile)) return "find file deletion requires explicit approval"
  if (rawTokens.some(pythonRemovesFile)) return "Python file deletion requires explicit approval"
}

// #220：rawExecutableMatch——引号感知的文件删除/移动匹配，委托 isShellActive 判断可执行上下文
function rawExecutableMatch(command: string, pattern: string) {
  const quotes = quoteOffsets(command)
  for (const match of command.matchAll(new RegExp(pattern, "gi"))) {
    const index = match.index ?? 0
    if (isShellActive(quotes[index], command, index)) return true
  }
  return false
}

// #220：isShellActive——无引号总是可执行，单引号内总是字面量，双引号内 $()、反引号、$ 仍然活跃
function isShellActive(quote: string, command: string, index: number) {
  if (!quote) return true
  if (quote === "'") return false
  return command.startsWith("$(", index) || command[index] === "`" || command[index] === "$"
}

// #222：rawFindOrPythonTokens——定位 find/Python 可执行命令起点，交给 tokenizer 判断删除语义
function rawFindOrPythonTokens(command: string) {
  // #222：raw 正则只定位可执行命令起点，实际删除语义交给 tokenizer 判断；这样同一
  // #222：命令段内的 quoted data 不会被 lookahead 误当作 find/Python 删除参数。
  const quotes = quoteOffsets(command)
  return Array.from(command.matchAll(new RegExp(RAW_FIND_OR_PYTHON_COMMAND_PATTERN, "gi"))).flatMap((match) => {
    const matchIndex = match.index ?? 0
    if (!isShellActive(quotes[matchIndex], command, matchIndex)) return []
    const executable = match[1]
    const executableIndex = matchIndex + match[0].lastIndexOf(executable)
    const tokens = tokenize(command.slice(executableIndex, rawExecutableSegmentEnd(command, executableIndex, matchIndex, quotes)).trim())
    return tokens ? [tokens] : []
  })
}

// #222：rawExecutableSegmentEnd——确定 find/Python 命令段的右边界
function rawExecutableSegmentEnd(command: string, start: number, matchIndex: number, quotes: string[]) {
  // #222：对 $()/反引号中的命令，右边界是替换结束符；普通命令则到未引用的 shell
  // #222：分隔符为止。反斜杠转义的 `\;` 是 find -exec 的普通参数，不能截断。
  const substitutionEnd = command.startsWith("$(", matchIndex) ? ")" : command[matchIndex] === "`" ? "`" : ""
  let escaped = false
  for (let i = start; i < command.length; i++) {
    if (escaped) {
      escaped = false
      continue
    }
    if (command[i] === "\\" && quotes[i] !== "'") {
      escaped = true
      continue
    }
    if (quotes[i]) continue
    if (substitutionEnd && command[i] === substitutionEnd) return i
    if (command[i] === ";" || command[i] === "&" || command[i] === "|" || command[i] === "\n" || command[i] === "\r") return i
  }
  return command.length
}

// #217：quoteOffsets——为命令中每个字符位置记录其所在的引号状态。
// #217：POSIX 单引号内反斜材为字面量文本，不应开启转义状态，避免错误地在格式错误单引号数据后隐藏可见删除
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

// #220：classifyTokens——token 层启发式分类，按威胁类别逐项检查
function classifyTokens(tokens: string[]): Decision | undefined {
  const cmd = normalizeCommandName(tokens[0])
  // #220: 敏感路径读取——读取 .env/SSH key/云凭据会暴露密钥内容给 shell 输出/模型上下文
  if (readsSensitivePath(tokens)) return { level: "cautious", reason: "sensitive file read requires explicit approval" }
  // #220: 文件删除——rm -r 保护根 dangerous（递归即门槛，不要求 -f），其他 cautious
  if (cmd === "rm" && hasRecursiveDeleteFlags(tokens.slice(1))) {
    if (tokens.slice(1).some(protectedDeleteTarget))
      return { level: "dangerous", reason: "critical recursive delete" }
    return { level: "cautious", reason: "recursive delete requires explicit approval" }
  }
  if (cmd === "remove-item" && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    if (tokens.slice(1).some(protectedDeleteTarget))
      return { level: "dangerous", reason: "critical PowerShell recursive delete" }
    return { level: "cautious", reason: "recursive PowerShell delete requires explicit approval" }
  }
  // #530：与 rm 对称：del/erase/rd/rmdir 保护根递归删除走同一 Windows 谓词，不降到 cautious
  if (windowsProtectedRecursiveDelete(tokens))
    return { level: "dangerous", reason: "Windows protected directory delete" }
  if (FILE_DELETE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  // #222：find -delete / -exec rm 也属于文件删除——argv 语义判断
  if (findDeletesFile(tokens))
    return { level: "cautious", reason: "find file deletion requires explicit approval" }
  // #220: 文件移动/重命名
  if (FILE_MOVE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file move or rename requires explicit approval" }
  // #220: 原始磁盘写入
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/")))
    return { level: "dangerous", reason: "raw disk write" }
  // #220: 系统破坏性命令
  if (SYSTEM_DESTRUCTIVE_COMMANDS.has(cmd))
    return { level: "dangerous", reason: "system destructive command" }
  // #220: Git 操作委托专项分类器
  if (cmd === "git") return classifyGit(tokens)
  // #555: GNU/BSD patch 改工作树；仅 help/version/裸命令保持 general，避免无载荷噪声。
  if (cmd === "patch") {
    const args = tokens.slice(1)
    if (args.some((item) => !["--help", "-h", "--version", "-v"].includes(item)))
      return { level: "cautious", reason: "patch apply modifies working tree" }
  }
  // #220: 权限变更——setuid/setgid dangerous，777/-R cautious
  if (cmd === "chmod") {
    if (tokens.some((item) => /[ug]\+s/.test(item)))
      return { level: "dangerous", reason: "setuid/setgid bit creates privilege escalation surface" }
    if (tokens.some((item) => item === "777" || item === "-R"))
      return { level: "cautious", reason: "permission widening requires explicit approval" }
  }
  if (cmd === "chown" && tokens.some((item) => item.includes("root")))
    return { level: "cautious", reason: "root ownership change requires explicit approval" }
  // #220: 特权升级——visudo/setcap
  if (cmd === "visudo")
    return { level: "dangerous", reason: "sudoers modification grants privilege escalation" }
  if (cmd === "setcap")
    return { level: "dangerous", reason: "file capability setting creates privilege escalation surface" }
  // #220: 用户/组账号管理
  if (USER_ACCOUNT_COMMANDS.has(cmd))
    return { level: "cautious", reason: "user/group account management requires explicit approval" }
  // #220: 防火墙与网络安全——flush/disable dangerous，修改 cautious
  if (cmd === "iptables" || cmd === "ip6tables") {
    // #222：防火墙 flush 降级为 cautious——reviewer 可判断是否为合法运维操作
    if (tokens.some((item) => ["-F", "-X", "--flush", "--delete-chain"].includes(item)))
      return { level: "cautious", reason: "firewall protection removal requires explicit approval" }
    return { level: "cautious", reason: "firewall rule modification requires explicit approval" }
  }
  if (cmd === "ufw") {
    // #222：ufw disable 降级为 cautious
    if (tokens[1] === "disable")
      return { level: "cautious", reason: "firewall protection removal requires explicit approval" }
    return { level: "cautious", reason: "firewall configuration change requires explicit approval" }
  }
  // #222：nft flush 降级为 cautious
  if (cmd === "nft" && tokens.some((item) => item === "flush"))
    return { level: "cautious", reason: "firewall protection removal requires explicit approval" }
  // #220: 服务管理——mask dangerous，其他 cautious
  if (cmd === "systemctl") {
    if (tokens[1] === "mask")
      return { level: "dangerous", reason: "service mask permanently prevents startup" }
    if (["stop", "disable", "enable", "start", "restart"].includes(tokens[1]))
      return { level: "cautious", reason: "service state change requires explicit approval" }
  }
  // #220: 全进程终止
  if (cmd === "kill" && tokens.includes("-9") && tokens.includes("-1"))
    return { level: "dangerous", reason: "mass process kill" }
  // #220: 定时任务——crontab/schtasks/Register-ScheduledTask
  if (cmd === "crontab") {
    const args = tokens.slice(1)
    const flags = args.filter((t) => t.startsWith("-"))
    const isListing = flags.length > 0 && flags.every((f) => f === "-l" || f === "-u")
    if (!isListing) return { level: "cautious", reason: "crontab modification creates persistent scheduled execution" }
  }
  if (cmd === "schtasks") {
    if (tokens.some((t) => t.toLowerCase() === "/query")) return undefined
    return { level: "cautious", reason: "Windows scheduled task operation requires explicit approval" }
  }
  if (cmd === "register-scheduledtask")
    return { level: "cautious", reason: "PowerShell scheduled task registration enables persistent execution" }
  // #220: 注册表操作——Run/RunOnce 键写入 dangerous
  if (cmd === "reg") {
    const sub = tokens[1]?.toLowerCase()
    if (sub === "add" && tokens.some((t) => /(?:\\|n)(?:Run|RunOnce)$/i.test(t)))
      return { level: "dangerous", reason: "registry Run key write creates persistent startup backdoor" }
    if (sub === "add" || sub === "delete")
      return { level: "cautious", reason: "registry modification requires explicit approval" }
  }
  // #220: 网络监听
  if (cmd === "nc" || cmd === "ncat" || cmd === "netcat") {
    if (tokens.some((t) => t === "-l" || /^-[A-Za-z]*l/.test(t)))
      return { level: "cautious", reason: "network listener port requires explicit approval" }
  }
  if (cmd === "socat" && tokens.some((t) => t.startsWith("TCP-LISTEN:")))
    return { level: "cautious", reason: "network listener port requires explicit approval" }
  // #220: HTTP 服务器——暴露本地文件
  if (cmd === "python" || cmd === "python3") {
    if (tokens.includes("-m") && tokens.some((t) => t === "http.server" || t === "SimpleHTTPServer"))
      return { level: "cautious", reason: "HTTP server exposes local files" }
  }
  // #220: 包管理器安装——postinstall 脚本是供应链攻击载体
  if (["npm", "pnpm", "yarn"].includes(cmd)) {
    if (["install", "i", "add", "ci"].includes(tokens[1]))
      return { level: "cautious", reason: "package install executes postinstall scripts; verify dependencies" }
  }
  if (cmd === "bun") {
    if (["install", "i", "add"].includes(tokens[1]))
      return { level: "cautious", reason: "package install executes postinstall scripts; verify dependencies" }
    // #220: bun x 是包执行器，可能下载并运行不受信任的代码
    if (tokens[1] === "x")
      return { level: "cautious", reason: "package executor may run untrusted code" }
  }
  if (["pip", "pip3"].includes(cmd) && tokens[1] === "install")
    return { level: "cautious", reason: "Python package install requires explicit approval" }
  if (cmd === "cargo" && tokens[1] === "install")
    return { level: "cautious", reason: "Rust package install requires explicit approval" }
  if (cmd === "gem" && tokens[1] === "install")
    return { level: "cautious", reason: "Ruby package install requires explicit approval" }
  // #220: 包执行器——npx/pipx/uvx 可从网络下载并立即执行任意包
  if (cmd === "npx")
    return { level: "cautious", reason: "package executor may run untrusted code" }
  if (cmd === "pipx" && tokens[1] === "run")
    return { level: "cautious", reason: "package executor may run untrusted code" }
  if (cmd === "uvx")
    return { level: "cautious", reason: "package executor may run untrusted code" }
  // #220: 远程文件传输
  if (["scp", "sftp", "rsync"].includes(cmd))
    return { level: "cautious", reason: "remote file transfer requires explicit approval" }
}

// #222：findDeletesFile——find 的删除语义来自 argv，而不是源码字符串
function findDeletesFile(tokens: string[]) {
  // #222：`"-delete"` 和 `'-exec' 'rm'` 经 shell 去引号后仍是真实删除参数；
  // #222：quoted search 文本不会以 find 命令起头。
  if (normalizeCommandName(tokens[0]) !== "find") return false
  return tokens.some(
    (item, index) =>
      item === "-delete" ||
      (["-exec", "-execdir"].includes(item) && normalizeCommandName(tokens[index + 1] ?? "") === "rm"),
  )
}

// #222：pythonRemovesFile——只处理显式 `python -c` 里的可见单文件删除
function pythonRemovesFile(tokens: string[]) {
  // #222：更宽的解释器行为仍保持 general，由用户/后续 sandbox 处理。
  if (!["python", "python3", "py"].includes(normalizeCommandName(tokens[0]))) return false
  return RE_C_PYTHON_FILE_REMOVE_CALL.test(tokens[tokens.findIndex((item) => item === "-c") + 1] ?? "")
}

// #365：git 全局 flag 中可重定向执行上下文的 flag。这些 flag 可将 git 操作指向
// 其他仓库(-C/--git-dir/--work-tree)、注入配置(-c/--config-env)或替换
// helper 二进制路径(--exec-path)。与 gitSafe 共用,消除重复。
const GIT_UNSAFE_GLOBAL = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"])

// #220：classifyGit——Git 子命令专项分类器，替代 cautiousGitSubcommand
function classifyGit(tokens: string[]): Decision | undefined {
  // #365：单遍遍历:跳过全局 flag 找到真正的子命令,同时检测 unsafe global flag。
  // unsafe global(-C/-c/--git-dir 等)可重定向 git 到其他仓库或注入配置
  // (如 core.hooksPath),即使子命令本身只读(如 status),跨仓库操作仍需审查。
  // 支持 flag=value 形式(如 --git-dir=/path)和裸 flag 形式(如 -C /path)。
  let i = 1
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const flag = tokens[i].includes("=") ? tokens[i].slice(0, tokens[i].indexOf("=")) : tokens[i]
    if (GIT_UNSAFE_GLOBAL.has(flag))
      return { level: "cautious", reason: "git global flag redirects execution context" }
    // 安全的 boolean flag(--no-pager/--paginate 等)不消费参数,直接跳过。
    // 极少数吃参数的全局 flag(如 --namespace)不在 GIT_UNSAFE_GLOBAL 中,
    // 会将参数误当作子命令;但这些 flag 极少使用且命令仍落入 general(非 safe)。
    i++
  }
  const sub = tokens[i]
  if (!sub) return undefined
  // #220: 特定高风险 git 操作
  if (sub === "reset" && tokens.includes("--hard"))
    return { level: "cautious", reason: "destructive git reset requires explicit approval" }
  if (sub === "clean" && tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d")))
    return { level: "cautious", reason: "destructive git clean requires explicit approval" }
  if (sub === "push" && tokens.some((item) => item === "--force" || item === "-f"))
    return { level: "cautious", reason: "force push requires explicit approval" }
  // bundle create 会写出归档文件；仅提升 create，避免把 verify/list-heads 等读取模式扩大为 cautious。
  if (sub === "bundle" && tokens[i + 1] === "create")
    return { level: "cautious", reason: "git bundle creation requires explicit approval" }
  // #220: 通用状态变更命令
  // #222：git rm 也加入 cautious——删除跟踪文件，改变仓库状态
  // #365：补充 checkout/switch/restore/apply/am/filter-branch/update-ref/
  // bisect/symbolic-ref/worktree/submodule 等遗漏子命令——它们修改索引、
  // 历史、引用、工作树或远端状态，落入 general 会被自动放行。
  // #555：filter-repo 与 filter-branch 同属历史重写；仅列 filter-branch 时 filter-repo 会 general 直过 auto。
  if (
    ["add", "commit", "merge", "rebase", "cherry-pick", "revert", "push", "pull",
     "reset", "clean", "mv", "rm",
     "checkout", "switch", "restore", "apply", "am",
     "filter-branch", "filter-repo", "update-ref", "bisect", "symbolic-ref",
     "worktree", "submodule"].includes(sub)
  )
    return { level: "cautious", reason: "git state-changing command requires explicit approval" }

  // #365：stash: list 是只读;其余(push/pop/drop/clear)修改工作树或丢失暂存
  if (sub === "stash" && tokens[i + 1] !== "list")
    return { level: "cautious", reason: "git stash modifies working tree state" }

  // #365：config: 无参数仅打印 help(--get/--list 由 gitSafe 放行为 safe);
  // 其余可设 hooksPath 等危险配置,需审查
  if (sub === "config" && tokens[i + 1] && tokens[i + 1] !== "--get" && tokens[i + 1] !== "--list")
    return { level: "cautious", reason: "git config modification requires explicit approval" }

  // #365：remote: 无参数和 -v 是只读;add/remove/set-url 可将 push 重定向到攻击者仓库
  if (sub === "remote" && tokens[i + 1] && tokens[i + 1] !== "-v")
    return { level: "cautious", reason: "git remote modification requires explicit approval" }

  // #365：tag: 无参数和 -l/--list 是只读;创建/删除标签修改仓库状态
  if (sub === "tag" && tokens[i + 1] && tokens[i + 1] !== "-l" && tokens[i + 1] !== "--list")
    return { level: "cautious", reason: "git tag creation or deletion requires explicit approval" }

  // #365：分支操作：仅在非只读模式时为 cautious。用 tokens.slice(i + 1) 而非
  // tokens.slice(2),以支持安全 boolean flag(如 --no-pager)前置的情况。
  if (sub === "branch" && !gitBranchSafe(tokens.slice(i + 1)))
    return { level: "cautious", reason: "git branch mutation requires explicit approval" }
  return undefined
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

function hasRecursiveDeleteFlags(tokens: string[]) {
  // #197：rm 递归标志可作组合短标志(-rf/-fr)、拆分短标志(-r -f/-R -f)或长标志。
  // 保护根判定只看递归标志：-f 只压制提示符不增加破坏性，rm -r / 与 rm -rf /
  // 同等危险，防止把 -f 作为 dangerous 门槛造成 rm -r / 降级 cautious
  return tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item))
}

// #530：cmd del/rd/rmdir 可合并的单字母开关；s=递归。禁止 tree-sitter、/setup 等非开关词。
const WINDOWS_CMD_SWITCH_LETTERS = new Set(["a", "f", "p", "q", "s", "u"])

function hasWindowsRecursiveDeleteFlag(tokens: string[]) {
  return tokens.some(isWindowsRecursiveDeleteFlagToken)
}

function isWindowsRecursiveDeleteFlagToken(token: string) {
  const t = token.toLowerCase()
  if (t === "/s" || t === "-s" || t === "--recursive") return true
  // #530：仅整 token 纯开关 cluster：/s/q、/s/p、/sq；不得裸子串匹配 -sitter
  if (!(t.startsWith("/") || (t.startsWith("-") && !t.startsWith("--")))) return false
  const body = t.slice(1)
  if (!body) return false
  if (body.includes("/")) {
    const parts = body.split("/")
    return parts.every((part) => part.length === 1 && WINDOWS_CMD_SWITCH_LETTERS.has(part)) && parts.includes("s")
  }
  if (body.length < 1 || body.length > 4) return false
  return [...body].every((ch) => WINDOWS_CMD_SWITCH_LETTERS.has(ch)) && body.includes("s")
}

function windowsProtectedRecursiveDelete(tokens: string[]) {
  // #530：三元组同时成立才 dangerous：命令名 + 递归开关 + 保护根（与 rm 语义对称）
  if (tokens.length < 2) return false
  const cmd = normalizeCommandName(tokens[0])
  if (cmd !== "del" && cmd !== "erase" && cmd !== "rd" && cmd !== "rmdir") return false
  const rest = tokens.slice(1)
  return hasWindowsRecursiveDeleteFlag(rest) && rest.some(protectedDeleteTarget)
}

// #530：仅空白切分并保留 \。POSIX tokenize 把 \ 当转义吞掉，C:\Users 会变成 C:Users 导致保护根 FN。
function windowsCmdTokens(segment: string) {
  return segment.trim().split(/\s+/).filter(Boolean)
}

// #530：normalize 后按段扫描；sole windowsCmdTokens，禁止再顺序 tokenize（R5 impl audit B-01）
function windowsProtectedDeleteInCommand(normalized: string) {
  for (const segment of normalized.split(/[;|&]+/)) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    if (windowsProtectedRecursiveDelete(windowsCmdTokens(trimmed))) return true
  }
  return false
}

// #220：protectedDeleteTarget——保护根目录覆盖 POSIX 根、家目录、Windows 盘符、系统目录和 macOS 特有目录
function protectedDeleteTarget(input: string) {
  // 折叠多斜杠并解析 .. 穿越，保证 /home//user、/home/../etc 等形式正确判定
  let normalized = input.replaceAll("\\", "/").replace(/\/+$/, "").replace(/\/{2,}/g, "/")
  while (/\/[^/]+\/\.\.(?=\/|$)/.test(normalized)) {
    normalized = normalized.replace(/\/[^/]+\/\.\.(?=\/|$)/, "")
  }
  if (normalized === "/" || normalized === "/*" || normalized === "/.") return true
  if (normalized === "~" || normalized === "$HOME") return true
  // #220: Windows 环境变量家目录
  if (normalized === "$env:USERPROFILE" || normalized === "$env:SystemDrive") return true
  // #530：Windows 环境变量家目录（%USERPROFILE% 大小写不敏感，对齐旧 raw i 旗）
  if (normalized.toLowerCase() === "%userprofile%") return true
  if (/^\w:\/?$/.test(normalized)) return true
  // #220: POSIX 系统根目录（扩展版）
  const posixRoots = new Set([
    "/etc", "/usr", "/var", "/lib", "/lib64", "/bin", "/sbin",
    "/boot", "/sys", "/proc", "/dev", "/opt", "/root", "/home",
    "/Library", "/Applications", "/System", "/Users",
  ])
  if (posixRoots.has(normalized)) return true
  // 用户数据根（/home、/Users）仅保护一级子目录（用户家目录），
  // 深层子目录（/home/<user>/Download/...）是正常用户操作不视为保护根
  if (normalized.startsWith("/home/") || normalized.startsWith("/Users/")) {
    return !normalized.replace(/^\/(?:home|Users)\//, "").includes("/")
  }
  // /root 仅保护根本身（已由 posixRoots.has 覆盖），子目录不保护
  if (normalized.startsWith("/root/")) return false
  // 其他系统根目录：保护根及所有子目录（如 /etc/passwd、/usr/local/bin）
  for (const root of posixRoots) {
    if (normalized.startsWith(root + "/")) return true
  }
  // #220: Windows 系统目录
  if (/^[A-Za-z]:\/(?:Windows|Program Files|Users)(?:\/|$)/i.test(normalized)) return true
  return false
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
  // #220：bun 总是返回 false——install/x 移至 classifyTokens 处理为 cautious
  if (cmd === "bun") return false
  // #197：版本探测安全——但仅当所有参数为版本标志时
  return versionSafe(tokens)
}

function gitSafe(tokens: string[]) {
  // #197：仅只读 git 子命令安全——改变 config/worktree/exec-path 的 global flag 被拒绝，因可将安全子命令重定向到另一仓库或 helper
  // #202：--ext-diff/--textconv 可调用外部 diff/textconv 程序，read-looking 但有执行副作用，从 safe 排除
  // #365：防御性冗余:主路径已在 classifyGit 拦截 unsafe global flag;
  // 保留此检查防止未来 classifyGit 改动引入绕过。
  const unsafeReadFlag = new Set(["--ext-diff", "--textconv"])
  const safe = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"])
  let subcommand: string | undefined
  for (let i = 1; i < tokens.length; i++) {
    // #197：unsafe global flag 可重定向 git 操作到另一仓库或注入配置——任何安全子命令在 -C/-c 下都不安全
    if (GIT_UNSAFE_GLOBAL.has(tokens[i]) || Array.from(GIT_UNSAFE_GLOBAL).some((item) => tokens[i].startsWith(item + "="))) return false
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
  // #220: .pem/.key 仅在路径含安全相关上下文时才判定为敏感
  return tokens.slice(1).some((item) => {
    const normalized = item.replaceAll("\\", "/")
    if (
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
      normalized.endsWith("/credentials.json")
    ) {
      return true
    }
    // #220: SSH 私钥文件名匹配
    const basename = normalized.split("/").at(-1) ?? ""
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(basename)) return true
    // #220: .pem/.key 仅在路径含安全相关上下文时才判定为敏感
    if (normalized.endsWith(".pem") || normalized.endsWith(".key")) {
      return isSensitiveKeyFile(normalized)
    }
    return false
  })
}

// #220：isSensitiveKeyFile——仅在路径含 ssl/tls/cert/pki/private/secret/.ssh/.gnupg 时才将 .pem/.key 视为密钥文件
function isSensitiveKeyFile(normalizedPath: string) {
  return /(?:ssl|tls|cert|pki|private|secret|\.ssh|\.gnupg)/i.test(normalizedPath)
}

function normalizeCommandName(input: string) {
  // #197：规范化路径和 Windows 可执行后缀——使策略常量无需为 /usr/bin/git、git.exe、PowerShell.EXE 添加重复条目
  const name = input.replaceAll("\\", "/").split("/").at(-1) ?? input
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase()
}

export * as PermissionPrecheck from "./precheck"


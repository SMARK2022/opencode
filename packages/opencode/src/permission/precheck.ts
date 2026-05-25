// ============================================================
// precheck.ts — shell 命令静态启发式预分类器
// ============================================================
//
// 设计哲学：fail-closed（失败保守）。任何无法理解的语法、动态展开、
// 编码混淆都降级为 general 或更高风险层级，绝不猜测为 safe。
//
// 分层架构：
//   Phase 1 — raw 文本扫描：在 token 化之前用预编译正则捕获跨管道、
//             编码、命令替换内的危险载荷，配合引号感知避免字符串内误报
//   Phase 2 — 包装器载荷提取与递归：shell/PowerShell/cmd/ssh/wsl 等
//             包装器的内层脚本提取后递归预审，内层风险向外传播
//   Phase 3 — 结构解析：命令分割 + token 化，解析失败 → general
//   Phase 4 — token 启发式分类：基于命令名 + 参数谓词的结构化规则，
//             按威胁类别组织（删除、权限、持久化、网络、包管理等）
//   Phase 5 — 多段聚合：取所有分段中的最高风险层级
//
// 核心不变量：
//   • 包装器永远不是 safe（内层 safe 仍回 general）
//   • splitCommands 遇到未建模语法直接降级
//   • dangerous 结果短路，不继续后续阶段
// ============================================================

export const LEVELS = ["safe", "general", "cautious", "dangerous"] as const
export type Level = (typeof LEVELS)[number]
export type Decision = { level: Level; reason: string }

// 包装器处理结果：script 表示提取到可检查的脚本载荷，ask 表示包装器过于
// 开放无法检查，none 表示不是包装器。包装器结果不包含 allow：包装器执行
// 本身永远不足够安全到可以确定性地批准。
type UnwrapResult =
  | { action: "script"; script: string; reason: string }
  | { action: "ask"; reason: string }
  | { action: "none" }
type RemoteResult = { action: "remote"; script?: string; reason: string } | { action: "none" }

// ============================================================
// 第一部分：包装器与解释器常量集合
// ============================================================

// POSIX shell 包装器：检查 -c/-lc 载荷以发现危险操作，但包装器本身
// 始终需要审批，因为未来参数可以执行任意代码。
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"])

// PowerShell 有多个命令入口（-Command、-EncodedCommand、别名、提供程序），
// 可以在字符串背后隐藏文件系统/网络副作用。解码载荷只用于扫描危险操作。
const POWERSHELL_WRAPPERS = new Set(["pwsh", "powershell", "powershell.exe"])

// 远程和替代 OS 包装器跨越信任边界。即使是看似只读的命令也可能触及远程
// 凭据、SSH 配置、WSL 挂载或另一个文件系统命名空间。
const REMOTE_WRAPPERS = new Set(["ssh", "ssh.exe", "wsl", "wsl.exe"])

// 解释器 eval 标志是高杠杆逃逸通道：python -c、node -e、ruby -e 等
// 可以合成 shell 命令、路径和网络调用，token 级解析无法理解。
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

// ============================================================
// 第二部分：文件操作与系统命令集合
// ============================================================

// token 级文件删除/移动集合：与 raw 层的破坏性模式镜像，这样路径限定的
// 二进制文件（如 /bin/rm）在 token 化成功后也无法绕过审查。
const FILE_DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "del", "erase", "rd", "remove-item", "trash-put"])
const FILE_MOVE_COMMANDS = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item"])

// 系统级破坏性命令：执行即造成不可逆损害，直接判定 dangerous。
const SYSTEM_DESTRUCTIVE_COMMANDS = new Set([
  "mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs",
  "fdisk", "parted", "wipefs",
  "shutdown", "reboot", "halt", "poweroff",
])

// 用户/组账号管理命令：修改系统用户数据库，需要显式审批。
const USER_ACCOUNT_COMMANDS = new Set([
  "useradd", "userdel", "groupadd", "groupdel", "chpasswd", "passwd",
  "usermod", "adduser", "deluser", "addgroup", "delgroup",
])

// ============================================================
// 第三部分：敏感路径模式
// ============================================================

// SSH 私钥文件名模式
const SSH_PRIVATE_KEY_NAME_PATTERN = String.raw`id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?`

// Windows 家目录下的敏感路径
const WINDOWS_HOME_SENSITIVE_PATH_PATTERN = String.raw`(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)[\\/](?:\.ssh(?:[\\/][^\s|;]+)?|\.aws(?:[\\/]credentials)?|\.config[\\/]gcloud(?:[\\/][^\s|;]+)?|\.kube[\\/]config|\.npmrc|\.netrc|\.git-credentials)`

// 核心敏感路径模式（不含 .pem/.key），用于本地读取检测。
// .pem/.key 文件在开发中经常用于非密钥用途（i18n、配置模板等），
// 仅在路径包含安全相关上下文时才判定为敏感（见 isSensitiveKeyFile）。
const SENSITIVE_PATH_CORE_PATTERN = String.raw`(?:\.env(?:\.[^\s|;]+)?|${WINDOWS_HOME_SENSITIVE_PATH_PATTERN}|(?:~|[^\s|;]+)\/\.ssh(?:\/[^\s|;]+)?|(?:~|[^\s|;]+)\/\.aws(?:\/credentials)?|(?:~|[^\s|;]+)\/\.config\/gcloud(?:\/[^\s|;]+)?|(?:~|[^\s|;]+)\/\.kube\/config|(?:~|[^\s|;]+)\/\.npmrc|(?:~|[^\s|;]+)\/\.netrc|(?:~|[^\s|;]+)\/\.git-credentials|credentials\.json|${SSH_PRIVATE_KEY_NAME_PATTERN})`

// 完整敏感路径模式（含 .pem/.key），仅用于外传检测（dangerousRaw）。
// 在外传上下文中（管道到 curl/网络传输），即使是没有上下文的 .pem/.key
// 也应该被拦截，因为风险收益比倾向于保守。
const SENSITIVE_PATH_PATTERN = SENSITIVE_PATH_CORE_PATTERN + String.raw`|[^\s|;]+\.pem|[^\s|;]+\.key`

// raw 扫描发生在 shell 引号移除之前，允许敏感路径外侧有一层引号
const SENSITIVE_PATH_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_PATTERN}["']?`
// 本地读取用的窄版参数模式（不含 .pem/.key）
const SENSITIVE_PATH_LOCAL_ARGUMENT_PATTERN = String.raw`["']?${SENSITIVE_PATH_CORE_PATTERN}["']?`

// ============================================================
// 第四部分：raw 层文件操作模式（需要引号感知的特殊匹配）
// ============================================================

// 这些 raw 破坏性模式在 dangerousRaw 检查之后、token 化之前运行。
// 它们捕获不透明 shell（PowerShell 环境路径、重定向、命令替换、
// SSH/WSL 载荷、不支持的分隔符）中的可见文件变更。
const RAW_COMMAND_START = "(?:^|[;&|{(]\\s*|[\\r\\n]\\s*|\\$\\(\\s*|`\\s*)"
const RAW_COMMAND_PATH = String.raw`(?:[^\s|;&(){}'"]+[\\/])*`
const RAW_FILE_DELETE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:rm|unlink|rmdir|del|erase|rd|Remove-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`
const RAW_FILE_MOVE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:mv|move|ren|rename|Move-Item|Rename-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`

// ============================================================
// 第五部分：预编译正则 — dangerous raw 层
// ============================================================
// 所有 raw 层正则在模块加载时编译一次，避免热路径重复编译。

// 保护根目录递归删除：/ | /* | /. | ~ | $HOME | /etc 以及扩展的系统根目录
const POSIX_ROOT_ALTERNATION = String.raw`etc|usr|var|lib(?:64)?|s?bin|boot|sys|proc|dev|opt|root|home|Library|Applications|System|Users`
const RE_D_RM_RF_ROOT = new RegExp(
  String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))(?=[^|;]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?\s*(?=[\s)'"` + "`" + String.raw`]|$)|~\/?(?=[\s)'"` + "`" + String.raw`]|$)|\$HOME\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_ROOT_ALTERNATION})(?:\/|(?=[\s)'"` + "`" + String.raw`]|$)))`,
)

// 远程下载管道到解释器：curl/wget | sh/bash/python/...
const RE_D_CURL_PIPE_INTERPRETER = /\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i

// PowerShell 远程下载执行：iwr/irm | iex
const RE_D_PS_DOWNLOAD_EXEC = /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i

// Windows 驱动器格式化
const RE_D_WINDOWS_FORMAT = /\bformat\b\s+[A-Za-z]:/i

// Windows 保护目录删除：rd/rmdir/del /s 作用于盘根或用户目录
const RE_D_WINDOWS_PROTECTED_DELETE = new RegExp(
  String.raw`\b(?:rd|rmdir|del)\b(?=.*(?:\/s|-s|--recursive))(?=.*(?:[A-Za-z]:[\\/]?(?=[\s)'"` + "`" + String.raw`]|$)|[A-Za-z]:[\\/](?:Users|Windows|Program Files|Documents and Settings)(?:[\\/][^\s)'"` + "`" + String.raw`]*)?|%USERPROFILE%|\$env:USERPROFILE|~[\\/]?)(?=[\s)'"` + "`" + String.raw`]|$))`,
  "i",
)

// 凭据读取管道到网络传输
const RE_D_CREDENTIAL_PIPE_NETWORK = new RegExp(
  String.raw`\b(?:cat|type|Get-Content|gc|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_ARGUMENT_PATTERN})[^|;]*\|\s*(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
  "i",
)

// 凭据文件通过上传标志发送
const RE_D_CREDENTIAL_UPLOAD_FLAG = new RegExp(
  String.raw`\b(?:curl|wget)\b(?=.*(?:--data(?:-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|--form-string|-T)(?:\s+|=)(?:[^\s|;=@]+(?:=|@)@?)?@?${SENSITIVE_PATH_ARGUMENT_PATTERN})`,
  "i",
)

// 凭据文件通过 scp/rsync/sftp 远程传输
const RE_D_CREDENTIAL_REMOTE_TRANSFER = new RegExp(
  String.raw`\b(?:scp|rsync|sftp)\b(?=.*${SENSITIVE_PATH_ARGUMENT_PATTERN})(?=.*:)`,
  "i",
)

// PowerShell 保护根目录递归删除
const RE_D_PS_RECURSIVE_DELETE_ROOT = new RegExp(
  String.raw`\bRemove-Item\b(?=.*\s-Recurse\b)(?=.*\s-Force\b)(?=.*\s(?:\/|~\/?|\$HOME\/?|\$env:USERPROFILE[\\/]?|\$env:SystemDrive[\\/]?|[A-Za-z]:[\\/]?)(?=[\s)'"` + "`" + String.raw`]|$))`,
  "i",
)

// Python 保护根目录递归删除
const RE_D_PYTHON_RMTREE = /\bshutil\.rmtree\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/
const RE_D_PYTHON_REMOVE = /\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/

// Node.js 保护根目录文件删除
const RE_D_NODE_REMOVE = /(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/

// Python subprocess 执行 rm
const RE_D_SUBPROCESS_RM = /\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:\/|~|\$HOME|\/etc(?:\/|["']))/

// 反弹 shell 模式（含扩展变体）：
//   - /dev/tcp/ 文件描述符重定向
//   - nc/ncat/netcat -e 执行
//   - socat EXEC 执行
//   - bash >& /dev/tcp/（无需 -i 标志）
//   - mkfifo 命名管道反弹
//   - PowerShell TCPClient 反弹
const RE_D_REVERSE_SHELL = /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^|;]*(?:\s-e\s|\s--exec\s|\s--sh-exec\s)|\bsocat\b[^|;]*EXEC:|bash\s+(?:-i\s+)?[>&]+\s*\/dev\/tcp\/|\bmkfifo\b[^|;]*\b(?:sh|bash)\b|\bNew-Object\s+System\.Net\.Sockets\.TCPClient\b/i

// 解码/解压载荷管道到解释器（内容不可见，必须阻止）
const RE_D_DECODE_PIPE_INTERPRETER = /\b(?:base64|openssl|xxd|gunzip|bunzip2|unxz|zcat)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|dash|fish|ksh|python|python3|node|ruby|perl|pwsh|powershell)\b/i

// SSH authorized_keys 写入（后门持久化访问）。除 ~/$HOME 外，也覆盖常见
// 绝对家目录；重定向会让结构解析降级，因此必须在 raw 层捕获。
const RE_D_AUTHORIZED_KEYS_WRITE = />>?\s*["']?(?:(?:~|\$HOME)[\\/]|\/(?:home\/[^\/|;]+|root|Users\/[^\/|;]+)[\\/]|[A-Za-z]:[\\/]Users[\\/][^\\/|;]+[\\/])?\.ssh[\\/]authorized_keys/i

// sudoers 直写（特权升级）
const RE_D_SUDOERS_WRITE = /(?:>>?\s*["']?\/etc\/sudoers|\bvisudo\b)/i

// setuid/setgid 位设置（raw 层覆盖不可 token 化的场景）
const RE_D_CHMOD_SETUID = /\bchmod\b[^|;]*\b[ug]\+s\b/i

// 防火墙规则清空
const RE_D_IPTABLES_FLUSH = /\b(?:iptables|ip6tables)\b[^|;]*(?:\s-F\b|\s-X\b|\s--flush\b|\s--delete-chain\b)/i
const RE_D_UFW_DISABLE = /\bufw\s+disable\b/i

// 全进程终止
const RE_D_KILL_ALL = /\bkill\b[^|;]*\s-9\b[^|;]*\s-1\b/i

// ============================================================
// 第六部分：预编译正则 — cautious raw 层
// ============================================================

// Shell RC 文件写入（每次登录执行持久化代码）
const RE_C_SHELL_RC_WRITE = />>?\s*["']?(?:~|\$HOME)?[\\/]?\.(?:bash(?:rc|_profile|_login|_logout)|zshrc|zprofile|zlogin|profile|login|cshrc|tcshrc)["']?(?:\s|$)/i

// Git hooks 写入（git 操作时执行持久化代码）
const RE_C_GIT_HOOKS_WRITE = />>?\s*["']?[^\s]*\.git[\\/]hooks[\\/]/i

// Windows 计划任务创建
const RE_C_SCHTASKS_CREATE = /\bschtasks\b[^|;]*\/create\b/i

// PowerShell 计划任务注册
const RE_C_REGISTER_SCHEDULED_TASK = /\bRegister-ScheduledTask\b/i

// cron 目录/spool 写入
const RE_C_CRON_WRITE = />>?\s*["']?\/(?:etc\/cron|var\/spool\/cron)/i

// systemd 单元文件写入
const RE_C_SYSTEMD_WRITE = />>?\s*["']?(?:\/etc\/systemd|~\/\.config\/systemd)[\\/]/i

// 可见载荷管道到解释器（echo/printf 内容可审查但仍需人工确认）
const RE_C_ECHO_PIPE_INTERPRETER = /\b(?:echo|printf)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|dash|fish|ksh|python|python3|node|ruby|perl|pwsh|powershell)\b/i

// 敏感路径本地读取（使用不含 .pem/.key 的窄版模式）
const RE_C_SENSITIVE_READ = new RegExp(
  String.raw`\b(?:cat|type|Get-Content|gc|Get-ChildItem|gci|ls|dir|rg|grep|head|tail|sed|awk)\b(?=[^|;]*${SENSITIVE_PATH_LOCAL_ARGUMENT_PATTERN})`,
  "i",
)

// find/Python 删除规则按可执行命令切出 token 后判断，避免第一个 safe `find`
// 看穿到后续 quoted search 文本，也保留 `"-delete"`/`'rm'` 这类 shell
// 引号移除后仍会执行的参数形态。
const RAW_FIND_OR_PYTHON_COMMAND_PATTERN = String.raw`${RAW_COMMAND_START}(${RAW_COMMAND_PATH}\b(?:find|python|python3|py)\b)`
const RE_C_PYTHON_FILE_REMOVE_CALL = /\bos\.(?:remove|unlink|rmdir)\(\s*["'][^"']+["']/

// ============================================================
// 第七部分：禁止自动允许前缀
// ============================================================
// 这些前缀太宽泛，不适合作为 "always allow" 规则。列表与包装器/解释器/
// 远程分类镜像：授予此处任何精确前缀将授权预审查未审查过的任意未来载荷。

const BANNED_AUTO_ALLOW_PREFIXES = [
  // Shell 包装器可以在 -c、-lc 或参数后面隐藏未来脚本
  ["bash"], ["bash", "-c"], ["bash", "-lc"],
  ["/bin/bash"], ["/bin/bash", "-lc"],
  ["sh"], ["sh", "-c"], ["sh", "-lc"],
  ["/bin/sh"], ["/bin/sh", "-c"],
  ["zsh"], ["zsh", "-c"], ["zsh", "-lc"],
  ["/bin/zsh"], ["/bin/zsh", "-lc"],
  ["dash"], ["fish"], ["ksh"],
  // 脚本解释器和包执行器可以从不透明源代码或依赖解析生成文件系统/网络副作用
  ["python"], ["python", "-c"],
  ["python3"], ["python3", "-c"],
  ["py"], ["py", "-3"],
  ["pythonw"], ["pyw"],
  ["pypy"], ["pypy3"],
  ["node"], ["node", "-e"],
  ["deno"], ["bun"], ["bun", "x"],
  ["perl"], ["perl", "-e"],
  ["ruby"], ["ruby", "-e"],
  ["php"], ["php", "-r"],
  ["lua"], ["lua", "-e"],
  ["osascript"],
  // 包执行器可以下载并运行不受信任的代码
  ["npx"], ["pipx"], ["pipx", "run"], ["uvx"],
  // 特权和环境包装器可以更改有效用户、PATH 或目标命名空间
  ["sudo"], ["doas"], ["su"], ["pkexec"], ["env"],
  // VCS 前缀被禁止，因为许多子命令会修改引用、历史、远端或工作树
  ["git"], ["git", "branch"],
  ["hg"], ["svn"],
  // PowerShell/cmd/远程包装器需要命令字符串级别的审查
  ["pwsh"], ["pwsh", "-command"], ["pwsh", "-c"],
  ["pwsh", "-encodedcommand"], ["pwsh", "-enc"],
  ["powershell"], ["powershell", "-command"], ["powershell", "-c"],
  ["powershell", "-encodedcommand"], ["powershell", "-enc"],
  ["powershell.exe"], ["powershell.exe", "-command"], ["powershell.exe", "-c"],
  ["powershell.exe", "-encodedcommand"],
  ["ssh"], ["wsl"],
  ["cmd"], ["cmd", "/c"], ["cmd", "/k"],
  // 远程文件传输工具
  ["scp"], ["sftp"], ["rsync"],
]

// ============================================================
// 第八部分：入口函数
// ============================================================

export function evaluate(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision {
  const fileEffect = structuredFileEffect(input)
  if (fileEffect) return fileEffect

  // 目前只有 bash 权限有足够的语法证据进行预审查。其他工具默认回退到
  // reviewer/user 审批。上面的 structuredFileEffect 是例外：edit/apply_patch
  // 已经把最终文件效果作为权限 metadata 暴露出来，删除这种不可逆效果必须在
  // auto reviewer 边界前被提升为 cautious，而不是留作普通 non-shell general。
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

function structuredFileEffect(input: {
  permission: string
  metadata: Readonly<Record<string, unknown>>
}): Decision | undefined {
  // apply_patch 的项目内执行最终通过 edit 权限，并在 metadata.files 中携带
  // add/update/delete/move 的结构化效果。这里仅提升 delete：普通 update 继续
  // 走既有 non-shell general 路径。必须限定 permission=edit，避免其他工具恰好
  // 使用 files metadata 时被误归类为 workspace edit 删除。
  if (
    input.permission === "edit" &&
    Array.isArray(input.metadata.files) &&
    input.metadata.files.some((item) => fileEffectType(item) === "delete")
  ) {
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  }

  // apply_patch 访问项目外路径时，external_directory preflight 发生在最终
  // edit diff 构造之前，此时只有 operation/patchText 能证明这是一次删除。
  // 要求 patchText 存在，避免任意 path-only external_directory 请求仅凭 tool
  // 名称就被提升到 reviewer 作为可审批的文件删除事实。
  if (
    input.permission === "external_directory" &&
    input.metadata.tool === "apply_patch" &&
    input.metadata.operation === "delete" &&
    typeof input.metadata.patchText === "string"
  ) {
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  }
}

function fileEffectType(input: unknown) {
  if (!input || typeof input !== "object" || !("type" in input)) return
  return input.type
}

export function canAlwaysAllowPrefix(tokens: string[]) {
  // 前缀来自 shell 解析器的 arity 计算。归一化命令名使得 wsl.exe、/bin/bash
  // 和大小写变体无法逃脱禁止列表。
  const normalized = tokens.map((item, index) => (index === 0 ? normalizeCommandName(item) : item.toLowerCase()))
  return !BANNED_AUTO_ALLOW_PREFIXES.some(
    (prefix) => prefix.length === normalized.length && prefix.every((item, index) => item === normalized[index]),
  )
}

// ============================================================
// 第九部分：核心流程
// ============================================================

function evaluateShell(command: string, depth: number): Decision {
  // 递归仅跟踪提取为纯文本的包装器载荷。深度上限防止恶意或格式错误的嵌套
  // 包装器消耗时间，同时保留失败安全行为：general/用户审批而非 safe。
  if (depth > 4) return { level: "general", reason: "nested shell wrapper requires explicit approval" }
  if (!command.trim()) return { level: "general", reason: "empty shell command requires explicit approval" }

  // raw 扫描在 token 分割之前运行，这样隐藏在命令替换、重定向、包装器字符串
  // 或无效语法后面的危险载荷仍然会被阻止而不是被降级为通用提示。
  const danger = dangerousRaw(command)
  if (danger) return { level: "dangerous", reason: danger }
  const caution = cautiousRaw(command)
  if (caution) return { level: "cautious", reason: caution }

  // 包装器载荷提取：在完整命令可能因重定向或不支持的分隔符而不透明时，
  // 扫描未引用的命令段以发现可见的包装器载荷。
  for (const wrapped of rawWrapperScripts(command)) {
    const decision = evaluateShell(wrapped, depth + 1)
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
  }

  // 结构解析：将命令分割为独立子命令并逐个分析
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

  // 包装器展开：提取内层脚本递归检查
  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") {
    const decision = evaluateShell(unwrapped.script, depth + 1)
    // 包装器载荷分层传播：包装器本身不能变成 safe，因为未来同一前缀可能
    // 承载任意脚本；但如果可见脚本是 cautious/dangerous，保留更高风险层级。
    if (decision.level === "dangerous" || decision.level === "cautious") return decision
    return { level: "general", reason: unwrapped.reason }
  }
  if (unwrapped.action === "ask") return { level: "general", reason: unwrapped.reason }

  // 远程包装器展开
  const remote = remoteWrapper(tokens)
  if (remote.action === "remote") {
    if (remote.script) {
      const decision = evaluateShell(remote.script, depth + 1)
      // SSH/WSL 跨越本机信任边界：安全的远程只读命令仍是 general；可见的远程
      // 破坏性动作保留 cautious/dangerous。
      if (decision.level === "dangerous" || decision.level === "cautious") return decision
    }
    return { level: "general", reason: remote.reason }
  }

  // token 层启发式分类：按威胁类别逐项检查
  const risk = classifyTokens(tokens)
  if (risk) return risk
  if (safeTokens(tokens)) return { level: "safe", reason: "known read-only shell command" }
  return { level: "general", reason: "unknown shell command" }
}

// ============================================================
// 第十部分：raw 层扫描
// ============================================================

function dangerousRaw(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, " ").trim()

  // ---- 保护根目录递归删除 ----
  // 在 token 化之前拦截 $HOME、~/、/* 和包装器引号形式
  if (RE_D_RM_RF_ROOT.test(normalized)) return "critical recursive delete"

  // ---- 远程下载管道执行 ----
  if (RE_D_CURL_PIPE_INTERPRETER.test(normalized))
    return "remote download piped to interpreter; review the script locally before running safe commands"
  if (RE_D_PS_DOWNLOAD_EXEC.test(normalized))
    return "remote PowerShell download executed as code; review the script locally before running safe commands"

  // ---- 解码/混淆载荷管道执行 ----
  // base64 -d | sh、openssl enc -d | sh、xxd -r | sh 等：载荷不可见，必须阻止
  if (RE_D_DECODE_PIPE_INTERPRETER.test(normalized))
    return "decoded/decompressed payload piped to interpreter"

  // ---- Windows 破坏性操作 ----
  if (RE_D_WINDOWS_FORMAT.test(normalized)) return "Windows drive format"
  if (RE_D_WINDOWS_PROTECTED_DELETE.test(normalized)) return "Windows protected directory delete"

  // ---- 凭据外传 ----
  // 敏感文件读取管道到网络传输是 dangerous；单独的敏感读取在 cautiousRaw 处理
  if (RE_D_CREDENTIAL_PIPE_NETWORK.test(normalized)) return "credential read piped to network transfer"
  if (RE_D_CREDENTIAL_UPLOAD_FLAG.test(normalized)) return "credential file sent with network transfer"
  if (RE_D_CREDENTIAL_REMOTE_TRANSFER.test(normalized)) return "credential file sent with remote transfer"

  // ---- PowerShell 保护根目录递归删除 ----
  if (RE_D_PS_RECURSIVE_DELETE_ROOT.test(normalized)) return "critical PowerShell recursive delete"

  // ---- 解释器 API 内的保护根目录删除 ----
  if (RE_D_PYTHON_RMTREE.test(normalized)) return "critical Python recursive delete"
  if (RE_D_PYTHON_REMOVE.test(normalized)) return "critical Python file removal"
  if (RE_D_NODE_REMOVE.test(normalized)) return "critical Node.js file removal"
  if (RE_D_SUBPROCESS_RM.test(normalized)) return "critical recursive delete through interpreter"

  // ---- 反弹 shell ----
  if (RE_D_REVERSE_SHELL.test(normalized)) return "reverse shell pattern"

  // sudoers 修改授予特权升级
  if (RE_D_SUDOERS_WRITE.test(normalized)) return "sudoers modification grants privilege escalation"

  // ---- 特权升级 ----
  if (RE_D_CHMOD_SETUID.test(normalized)) return "setuid/setgid bit creates privilege escalation surface"

  // ---- 全进程终止 ----
  if (RE_D_KILL_ALL.test(normalized)) return "mass process kill"
}

function cautiousRaw(command: string): string | undefined {
  // 引号感知的文件删除/移动扫描：只有在 shell 可执行上下文中匹配才计数
  if (rawExecutableMatch(command, RAW_FILE_DELETE_PATTERN)) return "file deletion requires explicit approval"
  if (rawExecutableMatch(command, RAW_FILE_MOVE_PATTERN)) return "file move or rename requires explicit approval"

  const normalized = command.replace(/\s+/g, " ").trim()

  // ---- 持久化写入（重定向目标）----
  // splitCommands 遇到重定向会返回 undefined（降级为 general），因此这些
  // 持久化写入必须在 raw 层捕获，否则 >> ~/.bashrc 等会被当作普通未知命令。
  if (RE_C_SHELL_RC_WRITE.test(normalized)) return "shell RC file modification enables persistent code execution"
  if (RE_C_GIT_HOOKS_WRITE.test(normalized)) return "git hook modification runs code on git operations"
  if (RE_C_CRON_WRITE.test(normalized)) return "cron directory write enables persistent scheduled execution"
  if (RE_C_SYSTEMD_WRITE.test(normalized)) return "systemd unit file write enables persistent service execution"
  if (RE_C_SCHTASKS_CREATE.test(normalized)) return "Windows scheduled task creation enables persistent execution"
  if (RE_C_REGISTER_SCHEDULED_TASK.test(normalized)) return "PowerShell scheduled task registration enables persistent execution"

  // ---- 可见载荷管道到解释器 ----
  // echo/printf 的内容是可审查的明文，但通过管道到解释器执行仍需人工确认
  if (RE_C_ECHO_PIPE_INTERPRETER.test(normalized)) return "visible payload piped to interpreter requires review"

  // ---- 本地敏感路径读取 ----
  // $HOME/.aws/credentials 这类 env-expanded 路径会让 splitter 降级为 opaque，
  // 导致 token 级敏感读取看不到真实路径。dangerousRaw 已先处理外传；这里仅把
  // 本地敏感读取提升到 cautious。使用不含 .pem/.key 的窄版模式减少误报。
  if (RE_C_SENSITIVE_READ.test(normalized)) return "sensitive file read requires explicit approval"
  // authorized_keys 和防火墙保护移除风险很高，但常见于用户明确的运维任务；
  // 保持 cautious 让 reviewer 判断授权与上下文，根目录删除等不可逆破坏仍在
  // dangerousRaw 中 fail-closed。
  if (RE_D_AUTHORIZED_KEYS_WRITE.test(normalized)) return "SSH authorized_keys modification requires explicit approval"
  if (RE_D_IPTABLES_FLUSH.test(normalized) || RE_D_UFW_DISABLE.test(normalized))
    return "firewall protection removal requires explicit approval"
  const rawTokens = rawFindOrPythonTokens(command)
  if (rawTokens.some(findDeletesFile)) return "find file deletion requires explicit approval"
  if (rawTokens.some(pythonRemovesFile)) return "Python file deletion requires explicit approval"
}

// ============================================================
// 第十一部分：引号感知辅助
// ============================================================

function rawExecutableMatch(command: string, pattern: string) {
  // raw 删除/移动扫描需要 shell 语法上下文：分隔符在引号内的只读搜索文本
  // 中是数据。$() 和反引号在未引用或双引号 shell 文本中执行，但在 POSIX
  // 单引号中保持字面量。
  const quotes = quoteOffsets(command)
  for (const match of command.matchAll(new RegExp(pattern, "gi"))) {
    const index = match.index ?? 0
    if (isShellActive(quotes[index], command, index)) return true
  }
  return false
}

function rawFindOrPythonTokens(command: string) {
  // raw 正则只定位可执行命令起点，实际删除语义交给 tokenizer 判断；这样同一
  // 命令段内的 quoted data 不会被 lookahead 误当作 find/Python 删除参数。
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

function rawExecutableSegmentEnd(command: string, start: number, matchIndex: number, quotes: string[]) {
  // 对 $()/反引号中的命令，右边界是替换结束符；普通命令则到未引用的 shell
  // 分隔符为止。反斜杠转义的 `\;` 是 find -exec 的普通参数，不能截断。
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

function isShellActive(quote: string, command: string, index: number) {
  // 判断给定位置是否处于 shell 可执行上下文：
  //   - 无引号：总是可执行
  //   - 单引号内：总是字面量（不可执行）
  //   - 双引号内：变量展开和命令替换仍然活跃
  if (!quote) return true
  if (quote === "'") return false
  // 双引号内：$() 和反引号启动命令替换，$ 启动变量展开
  return command.startsWith("$(", index) || command[index] === "`" || command[index] === "$"
}

function quoteOffsets(command: string) {
  // 为命令中的每个字符位置记录其所在的引号状态：
  //   "" = 未引用, "'" = 单引号内, '"' = 双引号内
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
      // POSIX 单引号内反斜杠是字面量文本；将其标记为转义会错误地让后续
      // 分隔符保持在引号状态中，从而隐藏格式错误的单引号数据后的可见删除。
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

// ============================================================
// 第十二部分：结构解析
// ============================================================

function splitCommands(command: string) {
  // 此分割器有意只识别可以组合已安全命令的简单分隔符。任何动态展开、重定向、
  // glob 或格式错误的空段都返回 undefined，让调用者提示用户。这避免在过滤掉
  // 分隔符的空侧后批准 `git status &&` 或 `| git status`。
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
    // POSIX 单引号内反斜杠是字面量，不应开启转义状态
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      // 双引号 shell 片段仍可能展开变量或执行替换，视为不透明
      else if (quote !== "'" && (char === "$" || char === "`")) return
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    // 未建模的 shell 语法：$ 展开、反引号替换、子 shell 括号、大括号展开
    if (char === "$" || char === "`" || char === "(" || char === ")" || char === "{" || char === "}") return
    // 单个 & 和换行也是 shell 命令分隔/后台执行语法。当前 splitter 只支持
    // 明确的 &&、||、;、| 组合；遇到这些未建模分隔符时必须整体降级为
    // general，不能让 `git status & rm -rf ...` 被当成 safe 的 git 参数。
    if (char === "\n" || char === "\r") return
    // 重定向、glob、通配符
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
  // token 化有意小于完整的 shell 解析器。它保留带引号的空格和转义字符
  // 用于类路径参数，但格式错误的引号或悬挂的转义会强制提示而不是修复输入。
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
    // POSIX 单引号内反斜杠是字面量，不应作为转义符处理。
    // 与 quoteOffsets 行为保持一致，避免 `echo 'a\b'` 在 token 里
    // 丢失反斜杠字符。
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

  if (quote || escaped) return
  if (current) out.push(current)
  return out
}

// ============================================================
// 第十三部分：包装器处理
// ============================================================

function unwrap(tokens: string[]): UnwrapResult {
  // 包装器处理按从最类似 shell 到解释器的顺序排列。暴露纯脚本的包装器
  // 返回该脚本用于递归拒绝扫描；包装器本身仍需提示，因为未来参数可以
  // 执行任意代码。
  const cmd = normalizeCommandName(tokens[0])
  if (SHELL_WRAPPERS.has(cmd)) {
    const index = tokens.findIndex((item, i) => i > 0 && ["-c", "-lc"].includes(item))
    if (index >= 0 && tokens[index + 1]) {
      return { action: "script", script: tokens[index + 1], reason: "shell wrapper requires explicit approval" }
    }
    return { action: "ask", reason: "shell wrapper without a plain script requires explicit approval" }
  }

  if (POWERSHELL_WRAPPERS.has(cmd)) {
    // 优先检查编码命令：-EncodedCommand 的载荷是 UTF-16LE base64
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
      // cmd /c 的语义是将 /c 之后所有参数拼成一条命令执行。统一使用
      // 空格拼接以保留内容完整性，避免旧的空格检测启发式丢弃尾部 token。
      return {
        action: "script",
        script: tokens.slice(index + 1).join(" "),
        reason: "cmd wrapper requires explicit approval",
      }
    }
    return { action: "ask", reason: "cmd wrapper without a plain script requires explicit approval" }
  }

  // 解释器 eval 标志检查
  const evalFlags = INTERPRETER_FLAGS.get(cmd)
  if (evalFlags && tokens.some((item) => evalFlags.has(item))) {
    return { action: "ask", reason: "interpreter eval command requires explicit approval" }
  }
  // 其他脚本解释器
  if (["pythonw", "pyw", "pypy", "pypy3", "deno", "osascript"].includes(cmd)) {
    return { action: "ask", reason: "script interpreter requires explicit approval" }
  }
  if (cmd === "env") return { action: "ask", reason: "env wrapper requires explicit approval" }
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  return { action: "none" }
}

function rawWrapperScripts(command: string) {
  // 顶层重定向或不支持的分隔符可能使完整命令在正常的逐命令展开运行之前
  // 变得不透明。扫描未引用的命令段以发现可见的包装器载荷。
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
  // 将命令按 shell 分隔符分割为独立段，用于提取包装器载荷。
  // 注意：这里正确处理了单引号内反斜杠为字面量的行为。
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
  // 远程包装器与本地展开分离，这样它们的原因始终是信任边界提示。
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
  // SSH 选项可能在主机之前消耗下一个 token。跳过已知的选项/值对，
  // 使得 `ssh -p 22 host rm -rf /` 这样的远程命令仍然对扫描器可见。
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
  // WSL 接受显式 --exec 载荷或发行版/用户选项之后的命令。
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

// ============================================================
// 第十四部分：token 层启发式分类
// ============================================================
// 这是预分类器的主要分类引擎。按威胁类别组织，对每个命令使用结构化的
// 参数谓词进行判断，优先于正则匹配，提供更精确的语义理解。

function classifyTokens(tokens: string[]): Decision | undefined {
  const cmd = normalizeCommandName(tokens[0])

  // ---- 跨命令：敏感路径读取 ----
  // 读取或列出 .env、SSH key、云凭据等本地敏感位置会把密钥内容或存在性
  // 暴露给 shell 输出和模型上下文，从 safe/general 提升为 cautious。
  if (readsSensitivePath(tokens)) return { level: "cautious", reason: "sensitive file read requires explicit approval" }

  // ---- 文件删除 ----
  // rm -rf 保护根 → dangerous；rm -rf 普通路径 → cautious；其他删除 → cautious
  if (cmd === "rm" && hasRecursiveForceDeleteFlags(tokens.slice(1))) {
    if (tokens.slice(1).some(protectedDeleteTarget))
      return { level: "dangerous", reason: "critical recursive delete" }
    return { level: "cautious", reason: "recursive force delete requires explicit approval" }
  }
  if (cmd === "remove-item" && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    if (tokens.slice(1).some(protectedDeleteTarget))
      return { level: "dangerous", reason: "critical PowerShell recursive delete" }
    return { level: "cautious", reason: "recursive PowerShell delete requires explicit approval" }
  }
  if (FILE_DELETE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  if (findDeletesFile(tokens))
    return { level: "cautious", reason: "find file deletion requires explicit approval" }

  // ---- 文件移动/重命名 ----
  if (FILE_MOVE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file move or rename requires explicit approval" }

  // ---- 原始磁盘写入 ----
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/")))
    return { level: "dangerous", reason: "raw disk write" }

  // ---- 系统破坏性命令 ----
  if (SYSTEM_DESTRUCTIVE_COMMANDS.has(cmd))
    return { level: "dangerous", reason: "system destructive command" }

  // ---- Git 操作 ----
  // Git 子命令的分类较复杂，委托给专项分类器
  if (cmd === "git") return classifyGit(tokens)

  // ---- 权限变更 ----
  if (cmd === "chmod") {
    // setuid/setgid 位创建特权升级面，必须 dangerous
    if (tokens.some((item) => /[ug]\+s/.test(item)))
      return { level: "dangerous", reason: "setuid/setgid bit creates privilege escalation surface" }
    // 777 或递归权限变更需要审查
    if (tokens.some((item) => item === "777" || item === "-R"))
      return { level: "cautious", reason: "permission widening requires explicit approval" }
  }
  if (cmd === "chown" && tokens.some((item) => item.includes("root")))
    return { level: "cautious", reason: "root ownership change requires explicit approval" }

  // ---- 特权升级 ----
  if (cmd === "visudo")
    return { level: "dangerous", reason: "sudoers modification grants privilege escalation" }
  if (cmd === "setcap")
    return { level: "dangerous", reason: "file capability setting creates privilege escalation surface" }

  // ---- 用户/组账号管理 ----
  if (USER_ACCOUNT_COMMANDS.has(cmd))
    return { level: "cautious", reason: "user/group account management requires explicit approval" }

  // ---- 防火墙与网络安全 ----
  if (cmd === "iptables" || cmd === "ip6tables") {
    if (tokens.some((item) => ["-F", "-X", "--flush", "--delete-chain"].includes(item)))
      return { level: "cautious", reason: "firewall protection removal requires explicit approval" }
    return { level: "cautious", reason: "firewall rule modification requires explicit approval" }
  }
  if (cmd === "ufw") {
    if (tokens[1] === "disable")
      return { level: "cautious", reason: "firewall protection removal requires explicit approval" }
    return { level: "cautious", reason: "firewall configuration change requires explicit approval" }
  }
  if (cmd === "nft" && tokens.some((item) => item === "flush"))
    return { level: "cautious", reason: "firewall protection removal requires explicit approval" }

  // ---- 服务管理 ----
  if (cmd === "systemctl") {
    if (tokens[1] === "mask")
      return { level: "dangerous", reason: "service mask permanently prevents startup" }
    if (["stop", "disable", "enable", "start", "restart"].includes(tokens[1]))
      return { level: "cautious", reason: "service state change requires explicit approval" }
  }

  // ---- 进程终止 ----
  if (cmd === "kill" && tokens.includes("-9") && tokens.includes("-1"))
    return { level: "dangerous", reason: "mass process kill" }

  // ---- 定时任务 ----
  if (cmd === "crontab") {
    // crontab -l 仅列出现有定时任务（只读），通过不匹配回退到 general
    const args = tokens.slice(1)
    const flags = args.filter((t) => t.startsWith("-"))
    const isListing = flags.length > 0 && flags.every((f) => f === "-l" || f === "-u")
    if (!isListing) return { level: "cautious", reason: "crontab modification creates persistent scheduled execution" }
  }
  if (cmd === "schtasks") {
    // /query 是只读查询
    if (tokens.some((t) => t.toLowerCase() === "/query")) return undefined
    return { level: "cautious", reason: "Windows scheduled task operation requires explicit approval" }
  }
  if (cmd === "register-scheduledtask")
    return { level: "cautious", reason: "PowerShell scheduled task registration enables persistent execution" }

  // ---- 注册表操作 ----
  if (cmd === "reg") {
    const sub = tokens[1]?.toLowerCase()
    // 注册表 Run/RunOnce 键写入实现开机自启动持久化后门。
    // tokenizer 在双引号内会吃掉反斜杠，所以 "HKCU\...\Run" 变成 "HKCU...Run"。
    // 同时匹配两种形式：带反斜杠（未引用）和不带反斜杠（引用后反斜杠被吃掉）。
    if (sub === "add" && tokens.some((t) => /(?:\\|n)(?:Run|RunOnce)$/i.test(t)))
      return { level: "dangerous", reason: "registry Run key write creates persistent startup backdoor" }
    if (sub === "add" || sub === "delete")
      return { level: "cautious", reason: "registry modification requires explicit approval" }
  }

  // ---- 网络监听 ----
  if (cmd === "nc" || cmd === "ncat" || cmd === "netcat") {
    if (tokens.some((t) => t === "-l" || /^-[A-Za-z]*l/.test(t)))
      return { level: "cautious", reason: "network listener port requires explicit approval" }
  }
  if (cmd === "socat" && tokens.some((t) => t.startsWith("TCP-LISTEN:")))
    return { level: "cautious", reason: "network listener port requires explicit approval" }

  // ---- HTTP 服务器 ----
  if (cmd === "python" || cmd === "python3") {
    if (tokens.includes("-m") && tokens.some((t) => t === "http.server" || t === "SimpleHTTPServer"))
      return { level: "cautious", reason: "HTTP server exposes local files" }
  }

  // ---- 包管理器安装 ----
  // 包安装会执行 postinstall 脚本、下载不受信任的代码或编译原生扩展，
  // 这些都是供应链攻击的常见载体。
  if (["npm", "pnpm", "yarn"].includes(cmd)) {
    if (["install", "i", "add", "ci"].includes(tokens[1]))
      return { level: "cautious", reason: "package install executes postinstall scripts; verify dependencies" }
  }
  if (cmd === "bun") {
    if (["install", "i", "add"].includes(tokens[1]))
      return { level: "cautious", reason: "package install executes postinstall scripts; verify dependencies" }
    // bun x 是包执行器，可能下载并运行不受信任的代码
    if (tokens[1] === "x")
      return { level: "cautious", reason: "package executor may run untrusted code" }
  }
  if (["pip", "pip3"].includes(cmd) && tokens[1] === "install")
    return { level: "cautious", reason: "Python package install requires explicit approval" }
  if (cmd === "cargo" && tokens[1] === "install")
    return { level: "cautious", reason: "Rust package install requires explicit approval" }
  if (cmd === "gem" && tokens[1] === "install")
    return { level: "cautious", reason: "Ruby package install requires explicit approval" }

  // ---- 包执行器 ----
  // npx/pipx/uvx 可以从网络下载并立即执行任意包
  if (cmd === "npx")
    return { level: "cautious", reason: "package executor may run untrusted code" }
  if (cmd === "pipx" && tokens[1] === "run")
    return { level: "cautious", reason: "package executor may run untrusted code" }
  if (cmd === "uvx")
    return { level: "cautious", reason: "package executor may run untrusted code" }

  // ---- 远程文件传输 ----
  if (["scp", "sftp", "rsync"].includes(cmd))
    return { level: "cautious", reason: "remote file transfer requires explicit approval" }
}

function findDeletesFile(tokens: string[]) {
  // find 的删除语义来自 argv，而不是源码字符串：`"-delete"` 和 `'-exec' 'rm'`
  // 经 shell 去引号后仍是真实删除参数；quoted search 文本不会以 find 命令起头。
  if (normalizeCommandName(tokens[0]) !== "find") return false
  return tokens.some(
    (item, index) =>
      item === "-delete" ||
      (["-exec", "-execdir"].includes(item) && normalizeCommandName(tokens[index + 1] ?? "") === "rm"),
  )
}

function pythonRemovesFile(tokens: string[]) {
  // 只处理显式 `python -c` 里的可见单文件删除；更宽的解释器行为仍保持
  // general，由用户/后续 sandbox 处理。
  if (!["python", "python3", "py"].includes(normalizeCommandName(tokens[0]))) return false
  return RE_C_PYTHON_FILE_REMOVE_CALL.test(tokens[tokens.findIndex((item) => item === "-c") + 1] ?? "")
}

// ---- Git 子命令专项分类器 ----
// Git 操作复杂且有多个风险层级，需要细化的启发式判断。
function classifyGit(tokens: string[]): Decision | undefined {
  const sub = tokens[1]
  if (!sub) return undefined

  // 特定高风险 git 操作（先于通用检查，提供更精确的原因描述）
  if (sub === "reset" && tokens.includes("--hard"))
    return { level: "cautious", reason: "destructive git reset requires explicit approval" }
  if (sub === "clean" && tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d")))
    return { level: "cautious", reason: "destructive git clean requires explicit approval" }
  if (sub === "push" && tokens.some((item) => item === "--force" || item === "-f"))
    return { level: "cautious", reason: "force push requires explicit approval" }

  // 通用状态变更命令：修改索引、历史、引用或远端状态，需要审批。
  // git add/commit/merge/rebase 等均视为 cautious，因为这些操作修改
  // 仓库状态且通常难以自动恢复。
  if (
    ["add", "commit", "merge", "rebase", "cherry-pick", "revert", "push", "pull", "reset", "clean", "mv", "rm"].includes(sub)
  )
    return { level: "cautious", reason: "git state-changing command requires explicit approval" }

  // 分支操作：仅在非只读模式时为 cautious
  if (sub === "branch" && !gitBranchSafe(tokens.slice(2)))
    return { level: "cautious", reason: "git branch mutation requires explicit approval" }

  return undefined
}

// ============================================================
// 第十五部分：safe 层判定
// ============================================================

function safeTokens(tokens: string[]) {
  // safe 命令必须是直接的、本地的、只读的。敏感路径读取在命令特定检查
  // 之前排除，这样 `cat .env` 会提示即使 `cat README.md` 是安全的文件读取。
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
  // 包管理器只读子命令
  if (["npm", "pnpm", "yarn"].includes(cmd))
    return ["ls", "list", "view", "info", "why", "outdated"].includes(tokens[1])
  // bun 只读子命令（排除 install/x 等）
  if (cmd === "bun") return false
  return versionSafe(tokens)
}

function gitSafe(tokens: string[]) {
  // 只有只读的 git 子命令是 safe。更改配置、工作树或执行路径的全局标志
  // 被拒绝，因为它们可以将安全子命令重定向到另一个仓库或辅助程序。
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

function gitBranchSafe(args: string[]) {
  // `git branch` 既是只读列出命令也是引用变更命令。只允许无参数列出
  // 和查询分支状态的标志，不接受分支名目标。
  const allowed = new Set(["--show-current", "--list", "-l", "--all", "-a", "--remotes", "-r", "-v", "-vv"])
  return args.every((item) => allowed.has(item))
}

function unsafeRipgrepFlag(item: string) {
  // rg --pre=cmd 和 --hostname-bin=cmd 会执行外部程序。
  return (
    item === "-z" ||
    item === "--pre" ||
    item.startsWith("--pre=") ||
    item === "--hostname-bin" ||
    item.startsWith("--hostname-bin=") ||
    item === "--search-zip" ||
    item.startsWith("--search-zip=")
  )
}

function versionSafe(tokens: string[]) {
  // 版本探测对常见运行时/包管理器是安全的，但仅当每个参数都是版本标志时，
  // 这样就不会隐藏包安装/运行形式。
  const cmd = normalizeCommandName(tokens[0])
  if (!["node", "python", "python3", "bun", "npm", "pnpm", "yarn"].includes(cmd)) return false
  return tokens.length > 1 && tokens.slice(1).every((item) => item === "--version" || item === "-v" || item === "-V")
}

// ============================================================
// 第十六部分：辅助函数
// ============================================================

function readsSensitivePath(tokens: string[]) {
  // 检查读取/列出命令是否涉及敏感路径。只有已知的读取命令才触发此检查，
  // 避免 `npm run build .env.example` 等无关命令误报。
  const cmd = normalizeCommandName(tokens[0])
  if (
    ![
      "cat", "type", "get-content", "gc", "get-childitem", "gci",
      "ls", "dir", "grep", "rg", "head", "tail", "less", "more", "sed", "awk",
    ].includes(cmd)
  ) {
    return false
  }
  return hasSensitivePath(tokens)
}

function hasSensitivePath(tokens: string[]) {
  // 与 SENSITIVE_PATH_PATTERN 的 token 级镜像。保持两者同步：raw 模式
  // 捕获外传语法，token 模式将本地密钥读取从 allow 降级为 prompt。
  //
  // .pem/.key 文件的特殊处理：仅在路径包含安全相关上下文（ssl、tls、cert、
  // pki、private、secret、.ssh、.gnupg）时才判定为敏感，减少 i18n key 文件、
  // 配置模板等常见开发文件的误报。
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
    // SSH 私钥文件名匹配
    const basename = normalized.split("/").at(-1) ?? ""
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(basename)) return true
    // .pem/.key 文件仅在路径包含安全相关上下文时才判定为敏感
    if (normalized.endsWith(".pem") || normalized.endsWith(".key")) {
      return isSensitiveKeyFile(normalized)
    }
    return false
  })
}

function isSensitiveKeyFile(normalizedPath: string) {
  // 仅在路径包含 ssl/tls/cert/pki/private/secret/.ssh/.gnupg 等安全相关
  // 目录名或关键字时，才将 .pem/.key 文件视为密钥文件。这避免了将 i18n
  // key 文件、配置模板等常见开发文件误判为敏感凭据。
  return /(?:ssl|tls|cert|pki|private|secret|\.ssh|\.gnupg)/i.test(normalizedPath)
}

function hasRecursiveForceDeleteFlags(tokens: string[]) {
  // rm 接受递归/强制作为组合短标志（-rf、-fr）、分离短标志（-r -f、-R -f）
  // 或长标志。将这对标志视为等价，然后再检查保护目标。
  return (
    tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item)) &&
    tokens.some((item) => item === "--force" || /^-[^-]*f/.test(item))
  )
}

function protectedDeleteTarget(input: string) {
  // 保护根目录覆盖本地 POSIX 根、常见家目录别名、Windows 驱动器根、
  // 系统目录和 macOS 特有目录。这些是递归删除被视为 dangerous 而非
  // 仅 cautious 的情况。
  const normalized = input.replaceAll("\\", "/").replace(/\/+$/, "")
  // POSIX 根和通配符
  if (normalized === "/" || normalized === "/*" || normalized === "/.") return true
  // 家目录别名
  if (normalized === "~" || normalized === "$HOME") return true
  // Windows 环境变量家目录
  if (normalized === "$env:USERPROFILE" || normalized === "$env:SystemDrive") return true
  // Windows 驱动器根：C:\ 或 C:
  if (/^\w:\/?$/.test(normalized)) return true
  // POSIX 系统根目录（扩展版）
  const posixRoots = new Set([
    "/etc", "/usr", "/var", "/lib", "/lib64", "/bin", "/sbin",
    "/boot", "/sys", "/proc", "/dev", "/opt", "/root", "/home",
    // macOS 特有
    "/Library", "/Applications", "/System", "/Users",
  ])
  if (posixRoots.has(normalized)) return true
  if (posixRoots.has(normalized.replace(/\/.*/, ""))) {
    // 也匹配 /etc/... 形式（但 /etc 本身已由上面的集合覆盖）
  }
  // 检查以系统根目录开头的路径（如 /etc/passwd）
  for (const root of posixRoots) {
    if (normalized.startsWith(root + "/")) return true
  }
  // Windows 系统目录
  if (/^[A-Za-z]:\/(?:Windows|Program Files|Users)(?:\/|$)/i.test(normalized)) return true
  return false
}

function normalizeCommandName(input: string) {
  // 归一化路径和 Windows 可执行后缀，使策略常量不需要为 /usr/bin/git、
  // git.exe 或 PowerShell.EXE 设置重复条目。
  const name = input.replaceAll("\\", "/").split("/").at(-1) ?? input
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase()
}

function joinShellTokens(tokens: string[]) {
  // 重建 cmd/WSL 载荷用于递归 raw 扫描，不重用原始命令文本。引号保持空格
  // 完整并避免发明新的分隔符，同时仍然向 dangerousRaw 暴露危险子字符串。
  return tokens
    .map((item) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`))
    .join(" ")
}

function decodePowerShell(input: string) {
  // PowerShell 编码命令是 UTF-16LE base64。解码失败是 prompt 而非 deny，
  // 因为不透明的编码文本有风险但不是特定危险载荷的证据。
  try {
    return Buffer.from(input, "base64")
      .toString("utf16le")
      .replace(/^\uFEFF/, "")
  } catch {
    return
  }
}

export * as PermissionPrecheck from "./precheck"

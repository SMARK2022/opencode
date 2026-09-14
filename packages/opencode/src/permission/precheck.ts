// ============================================================
// precheck.ts — shell 命令静态启发式预分类器
// ============================================================

import * as nodePath from "node:path"
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

// [local-smark] 五级词汇（R2 计划）：dangerous 与 forbidden 拆分——dangerous 是
// 可授权高风险（进 reviewer，显式授权可 allow）；forbidden 是终审拒绝
// （不可逆灾难，任何授权不可放行）。maxRisk 依赖本数组顺序作为严重度序。
export const LEVELS = ["safe", "general", "cautious", "dangerous", "forbidden"] as const
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
// ri 是 Remove-Item 官方别名；必须与 remove-item 同级（含保护根 -Recurse dangerous）。
const FILE_DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "del", "erase", "rd", "remove-item", "ri", "trash-put"])
const FILE_MOVE_COMMANDS = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item"])
// PowerShell 工作树覆写/截断：与删除不同族，但同样不可 auto 直过。
const FILE_WRITE_COMMANDS = new Set(["clear-content", "set-content", "out-file"])

// [local-smark] 磁盘格式化/分区族 → forbidden：盘上数据不可逆（用户决策：格式化等
// 磁盘操作归 Forbidden）。mkfs 不走封闭集合：`mkfs` / `mkfs.*` 前缀族判定
// （R2 GAP-1：vfat/ntfs/exfat/f2fs/msdos 等变体曾因枚举缺失而 general 直通）。
const DISK_FORMAT_COMMANDS = new Set(["fdisk", "parted", "wipefs"])

// [local-smark] 关机/重启族 → dangerous：可逆（重新开机），归 dangerous 进
// reviewer，显式用户授权可 allow（用户决策，R2 五级拆分）。
const SHUTDOWN_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff"])

// 用户/组账号管理命令：修改系统用户数据库，需要显式审批。
const USER_ACCOUNT_COMMANDS = new Set([
  "useradd", "userdel", "groupadd", "groupdel", "chpasswd", "passwd",
  "usermod", "adduser", "deluser", "addgroup", "delgroup",
])

// [local-smark] 进程终止族（R3 计划）：Unix/macOS（kill/pkill/killall）、
// PowerShell（stop-process 及其官方别名 kill/spps——依 :72-73 "ri 与 remove-item
// 同级"先例，官方别名与主 cmdlet 同级；sp 是 Set-ItemProperty 别名故排除）、
// Windows 原生（taskkill/tskill）。族内默认 cautious；杀全部进程形态（kill
// 尾操作数 -1、killall5）在前置分支判 dangerous。
const PROCESS_TERMINATION_COMMANDS = new Set(["kill", "pkill", "killall", "stop-process", "spps", "taskkill", "tskill"])

// ============================================================
// 第三部分：敏感路径模式
// ============================================================

// SSH 私钥文件名模式：`(?![.\w-]*\.pub\b)` 排除公钥后缀（公钥是公开物）；
// `.backup` 等其它后缀变体仍按敏感处理（R2 W4）。
const SSH_PRIVATE_KEY_NAME_PATTERN = String.raw`id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?![.\w-]*\.pub\b)`

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
const RAW_FILE_DELETE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:rm|unlink|rmdir|del|erase|rd|Remove-Item|ri)\b\s+(?!--?(?:h|help|v|version)\b)\S`
const RAW_FILE_MOVE_PATTERN = String.raw`${RAW_COMMAND_START}${RAW_COMMAND_PATH}\b(?:mv|move|ren|rename|Move-Item|Rename-Item)\b\s+(?!--?(?:h|help|v|version)\b)\S`

// ============================================================
// 第五部分：预编译正则 — dangerous raw 层
// ============================================================
// 所有 raw 层正则在模块加载时编译一次，避免热路径重复编译。

// 保护根目录递归删除：/ | /* | /. | ~ | $HOME | /etc 以及扩展的系统根目录。
// 仅检查递归标志（-r/-R/--recursive），不要求 -f（force）：force 只压制提示符，
// 不增加破坏性，rm -r / 与 rm -rf / 破坏力等价。
// [local-smark] R3 分级：系统根（/etc、/usr 等）保护根本身与一级子目录
// （/usr/local、/etc/ssl）；恰好二级子目录降为 dangerous（由 dangerousRaw 的
// RE_D_RM_RF_SYSTEM_SUBTREE 承载）；更深子树不保护。用户数据根（/home、/Users）
// 仅保护根本身和一级子目录（用户家目录）；/root 仅保护根本身，子目录不保护。
const POSIX_SYSTEM_ROOTS = String.raw`etc|usr|var|lib(?:64)?|s?bin|boot|sys|proc|dev|opt|Library|Applications|System`
const POSIX_USER_DATA_ROOTS = String.raw`home|Users`
const RE_D_RM_RF_ROOT = new RegExp(
  String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))[^|;]*\s(?:\/(?:\*|\.)?\s*(?=[\s)'"` + "`" + String.raw`]|$)|~\/?(?=[\s)'"` + "`" + String.raw`]|$)|\$HOME\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_SYSTEM_ROOTS})(?:\/[^\/\s)'"` + "`" + String.raw`;]*)?\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_USER_DATA_ROOTS})\/[^\/\s)'"` + "`" + String.raw`|;]+\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_USER_DATA_ROOTS}|root)\/?(?=[\s)'"` + "`" + String.raw`]|$)|\/(?:${POSIX_USER_DATA_ROOTS})\/\.\.(?:\/|(?=[\s)'"` + "`" + String.raw`]|$)))`,
)

// [local-smark] R3：系统根恰好二级子目录的 dangerous 提升。恰好两段的边界前瞻
// （可选尾斜杠）保证更深子树不命中——/usr/local/libexec/.linkd 落普通 cautious。
const RE_D_RM_RF_SYSTEM_SUBTREE = new RegExp(
  String.raw`\brm\b(?=[^|;]*\s(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?=\s|$))[^|;]*\s\/(?:${POSIX_SYSTEM_ROOTS})\/[^\/\s)'"` + "`" + String.raw`;]+\/[^\/\s)'"` + "`" + String.raw`;]+\/?(?=[\s)'"` + "`" + String.raw`]|$)`,
)

// [local-smark] R3 reason 语义化：明示删除对象层级与终局性（forbidden 授权不可
// 放行 / dangerous 需显式授权），替换 "critical recursive delete" 黑话。
const FORBIDDEN_ROOT_DELETE =
  "recursive delete of filesystem root, home, or top-level system directory — forbidden (cannot be authorized)"
const WIN_FORBIDDEN_DELETE =
  "recursive delete of Windows drive root, user profile, or system directory — forbidden (cannot be authorized)"
const DANGEROUS_SUBTREE_DELETE = "recursive delete under a system directory — requires explicit user authorization"
const DANGEROUS_INTERPRETER_DELETE =
  "file deletion under a system directory via interpreter — requires explicit user authorization"

// [local-smark] 解释器族共享路径交替组（R3 审计 B-01）：旧版裸 `\/` 分支匹配任意
// 绝对路径（os.remove("/tmp/x") 都被 forbidden）。真实矩阵：forbidden 根/家/系统根
// 一级；dangerous 恰好二级；任意路径由 cautious 兜底（RE_C_*）。边界前瞻前必须
// 容忍可选尾斜杠（tab 补全形态 "/etc/ssl/"），该族无 token 层兜底。
const INTERPRETER_FORBIDDEN_PATH = String.raw`\/(?=["'\s)])|~\/?(?=["'\s)])|\$HOME\/?(?=["'\s)])|\/(?:${POSIX_SYSTEM_ROOTS})(?:\/[^\/\s"']+)?\/?(?=["'\s)])|\/(?:${POSIX_USER_DATA_ROOTS})\/[^\/\s"']+\/?(?=["'\s)])`
const INTERPRETER_DANGEROUS_PATH = String.raw`\/(?:${POSIX_SYSTEM_ROOTS})\/[^\/\s"']+\/[^\/\s"']+\/?(?=["'\s)])`

// 远程下载管道到解释器：curl/wget | sh/bash/python/...
const RE_D_CURL_PIPE_INTERPRETER = /\b(?:curl|wget)\b[^|;]*\|\s*(?:(?:sudo|doas|env)\s+)*(?:sh|bash|zsh|python|node|ruby|perl|pwsh|powershell|cmd|iex|invoke-expression)\b/i

// PowerShell 远程下载执行：iwr/irm | iex
const RE_D_PS_DOWNLOAD_EXEC = /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i

// Windows 驱动器格式化
const RE_D_WINDOWS_FORMAT = /\bformat\b\s+[A-Za-z]:/i


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

// 凭据文件通过 scp/rsync/sftp 远程传输：由 W4 方向感知 helper 取代（R2）；
// 出向（本地敏感路径作源）才 dangerous，入向/认证键/.pub 不命中。

// PowerShell 保护根目录递归删除已由 windowsProtectedDeleteTier 统一承载（cmd/PS
// 双族统一扫描器，见 forbiddenRaw/dangerousRaw 双出口）；原 RE_D_PS_RECURSIVE_DELETE_ROOT
// 的 i 旗语义由 protectedDeleteTier 的大小写不敏感别名分支承载。

// 解释器族保护路径删除（R3 重写：共享交替组承载分级矩阵，修复裸 \/ 过宽）
const RE_D_PYTHON_RMTREE = new RegExp(String.raw`\bshutil\.rmtree\(\s*["'](?:${INTERPRETER_FORBIDDEN_PATH})`)
const RE_D_PYTHON_REMOVE = new RegExp(String.raw`\bos\.(?:remove|unlink|rmdir)\(\s*["'](?:${INTERPRETER_FORBIDDEN_PATH})`)
const RE_D_NODE_REMOVE = new RegExp(
  String.raw`(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:${INTERPRETER_FORBIDDEN_PATH})`,
)
const RE_D_SUBPROCESS_RM = new RegExp(
  String.raw`\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:${INTERPRETER_FORBIDDEN_PATH})`,
)
// 解释器族恰好二级子目录 → dangerous（可授权高风险）
const RE_DANGER_INTERPRETER_DELETE = new RegExp(
  String.raw`(?:\bshutil\.rmtree|\bos\.(?:remove|unlink|rmdir))\(\s*["'](?:${INTERPRETER_DANGEROUS_PATH})|(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'](?:${INTERPRETER_DANGEROUS_PATH})|\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf][^"']*["'][^)]*["'](?:${INTERPRETER_DANGEROUS_PATH})`,
)

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
const RE_D_SUDOERS_WRITE = /(?:>>?\s*["']?\/etc\/sudoers|\bvisudo\b|\btee\b[^|;]*\/etc\/sudoers)/i

// [local-smark] cp/mv/install 的 sudoers 目的位（R2 GAP-2）：sudoers 路径须紧邻
// 段尾（$、;、| 或行尾前空白）才判定为写入目的；源位（sudoers 后还有其它路径）不命中。
const RE_D_SUDOERS_COPY_DEST = /\b(?:cp|mv|install)\b[^|;]*\s(?:["']?)\/etc\/sudoers(?:\.d)?(?:\/[^\s|;]*)?["']?(?=\s*(?:$|[|;]))/i

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
// R3：shutil.rmtree 并入（修复裸 \/ 过宽后任意路径删除仍需 cautious 兜底）；
// node/subprocess 任意路径删除同理，与 bash rm 同层级，不得低于矩阵。
const RE_C_PYTHON_FILE_REMOVE_CALL = /\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree)\(\s*["'][^"']+["']/
const RE_C_NODE_FILE_REMOVE_CALL = /(?:\bfs\.|\brequire\(["']fs["']\)\.)(?:rmSync|rmdirSync|unlinkSync)\(\s*["'][^"']+["']/
const RE_C_SUBPROCESS_RM_ANY = /\bsubprocess\.(?:run|call|Popen)\([^)]*["']rm["'][^)]*["']-[^"']*[rf]/

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
  const externalDirectory = externalDirectoryEffect(input)
  if (externalDirectory) return externalDirectory
  const fileEffect = structuredFileEffect(input)
  if (fileEffect) return fileEffect

  // bash and external_directory carry enough context for deterministic precheck.
  // Other permissions default to general allow unless a structured boundary above
  // promoted them to cautious first, such as workspace delete metadata.
  if (input.permission !== "bash") return { level: "general", reason: "precheck only has bash coverage" }
  return bashEffect(input)
}

function bashEffect(input: {
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}) {
  const command = typeof input.metadata.command === "string" ? input.metadata.command : undefined
  // [local-smark] R1：cwd 是 git -C membership 判定的基准。bash tool 的审批请求
  // metadata 必带 cwd；缺失时（pattern 直评路径等）向下传 undefined，
  // classifyGit 按 fail-closed 保守判 outside。
  const cwd = typeof input.metadata.cwd === "string" ? input.metadata.cwd : undefined
  const patternCommand = input.patterns.join(" && ")
  if (!command) return evaluateShell(patternCommand, 0, cwd)

  // 原始命令风险 + canonical pattern 风险 + inline_scripts 附加证据风险取 max。
  // inline_scripts 是 ShellTool 规范化 PowerShell inline Python 时附加的源码证据，
  // 只能提高风险，不能降低：forbidden/dangerous source 在任何 gate 都不可被弱化。
  const raw = shellEvidenceRisk(command, input.metadata, cwd)
  if (!patternCommand.trim() || patternCommand === command) return raw

  // Shell metadata is the raw audit/reviewer evidence, while permission patterns
  // are canonical rule keys that may omit POSIX leading environment assignments.
  // Auto precheck must consider both views and keep the higher risk so raw
  // forbidden/dangerous payloads cannot be weakened, and env assignments cannot
  // downgrade a canonical `git push --force` pattern from cautious to general.
  return maxRisk(raw, evaluateShell(patternCommand, 0, cwd))
}

// inline_scripts 附加证据风险计算：在原命令风险之上单调叠加每个字符串 source
// 的 evaluateShell 结果。非数组或非字符串元素被忽略，不会降低原命令风险。
// inline_scripts 包含 Python 源码而非 shell 命令，因此除了 evaluateShell 的常规
// 危险模式外，还需检查 RE_C_PYTHON_FILE_REMOVE_CALL：该模式在正常 token 级检查
// 中需要 python -c 前缀才能命中，但 inline_scripts 的源码没有该前缀。
function shellEvidenceRisk(command: string, metadata: Readonly<Record<string, unknown>>, cwd?: string): Decision {
  const scripts = Array.isArray(metadata.inline_scripts)
    ? metadata.inline_scripts.filter((item): item is string => typeof item === "string")
    : []
  return scripts.reduce((risk, script) => {
    const scriptRisk = RE_C_PYTHON_FILE_REMOVE_CALL.test(script)
      ? maxRisk(evaluateShell(script, 0, cwd), { level: "cautious", reason: "Python file deletion requires explicit approval" })
      : evaluateShell(script, 0, cwd)
    return maxRisk(risk, scriptRisk)
  }, evaluateShell(command, 0, cwd))
}

function maxRisk(left: Decision, right: Decision) {
  return LEVELS.indexOf(right.level) > LEVELS.indexOf(left.level) ? right : left
}

function externalDirectoryEffect(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Decision | undefined {
  if (input.permission !== "external_directory") return

  if (input.metadata.action_kind === "shell") {
    // external_directory 是第一道权限门禁；使用与 bashEffect 相同的 shellEvidenceRisk，
    // 确保 dangerous inline source 在此就被 deterministic deny，而非等到后续 bash gate。
    const shell = shellEvidenceRisk(
      typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "),
      input.metadata,
    )
    // external_directory access is normally reviewable, but an already-critical
    // shell payload must remain deterministic deny (forbidden) or keep its stronger
    // dangerous signal into review. Otherwise a command like `rm -rf /` would
    // become reviewer/user approved merely because it also crosses the
    // external-directory gate.
    if (shell.level === "forbidden" || shell.level === "dangerous") return shell
  }

  // This exact reason names the cautious seam for external path boundaries. It is
  // intentionally independent of per-tool evidence so read-only tools such as
  // glob/grep/lsp/repo_overview do not fall back to a clickable ask just because
  // they lack write-style operation payloads.
  return { level: "cautious", reason: "external directory access requires auto review" }
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
    // This exact reason labels the delete-specific cautious seam for reviewer
    // audit; ordinary updates must not share it.
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

function evaluateShell(command: string, depth: number, cwd?: string): Decision {
  // 递归仅跟踪提取为纯文本的包装器载荷。深度上限防止恶意或格式错误的嵌套
  // 包装器消耗时间，同时保留失败安全行为：general/用户审批而非 safe。
  if (depth > 4) return { level: "general", reason: "nested shell wrapper requires explicit approval" }
  if (!command.trim()) return { level: "general", reason: "empty shell command requires explicit approval" }

  // raw 扫描在 token 分割之前运行，这样隐藏在命令替换、重定向、包装器字符串
  // 或无效语法后面的危险载荷仍然会被阻止而不是被降级为通用提示。
  // forbidden（不可逆灾难）先于 dangerous（可授权高风险）短路。
  const forbidden = forbiddenRaw(command)
  if (forbidden) return { level: "forbidden", reason: forbidden }
  const danger = dangerousRaw(command)
  if (danger) return { level: "dangerous", reason: danger }
  const caution = cautiousRaw(command)
  if (caution) return { level: "cautious", reason: caution }

  // 包装器载荷提取：在完整命令可能因重定向或不支持的分隔符而不透明时，
  // 扫描未引用的命令段以发现可见的包装器载荷。
  // [local-smark] R2 实现审计 B-01：此处必须含 forbidden——否则
  // `bash -c 'mkfs.vfat …' > log` 的 token 独有 forbidden 载荷被丢弃，
  // 重定向致整段 opaque 后回退 general 直通 auto-allow（安全回归实测）。
  for (const wrapped of rawWrapperScripts(command)) {
    const decision = evaluateShell(wrapped, depth + 1, cwd)
    if (decision.level === "dangerous" || decision.level === "cautious" || decision.level === "forbidden") return decision
  }

  // 结构解析：将命令分割为独立子命令并逐个分析。splitCommands 对未建模语法按段
  // 降级为 opaque(general) 而非整条丢弃，故一个 bail 字符不会藏掉同条命令里
  // 其它干净段的 cautious/dangerous（修 `scp; echo $HOME` / `scp 2>&1` 类绕过）。
  const { segments, opaque } = splitCommands(command)
  const decisions = segments.map((item) => evaluateCommand(item, depth, cwd))
  // opaque 段以 general 参与 max 聚合：既不允许整条降为 safe，也保留干净 cautious
  // 段的审查信号。无任何可分析段（整条 opaque）时回退 general，等价旧行为。
  if (opaque) decisions.push({ level: "general", reason: "opaque shell segment requires explicit approval" })
  if (decisions.length === 0) return { level: "general", reason: "opaque shell command requires explicit approval" }
  // [local-smark] R1 段合并：同层全量收集去重保序后才拼 reason（用户需求：
  // 「等直到所有的cautious待检项检出之后进行reason的附加」），不再 find(first)
  // 丢信号；每条命中规则独占一行，层级优先序 forbidden > dangerous > cautious
  // 不变，safe/general 收尾行为不变。
  const aggregate = (level: "forbidden" | "dangerous" | "cautious"): Decision | undefined => {
    const hits = decisions.filter((item) => item.level === level)
    if (hits.length === 0) return undefined
    return { level, reason: [...new Set(hits.map((item) => item.reason))].join("\n") }
  }
  const escalated = aggregate("forbidden") ?? aggregate("dangerous") ?? aggregate("cautious")
  if (escalated) return escalated
  if (decisions.every((item) => item.level === "safe"))
    return { level: "safe", reason: "known read-only shell command" }
  return decisions.find((item) => item.level === "general") ?? { level: "general", reason: "unknown shell command" }
}

function evaluateCommand(command: string, depth: number, cwd?: string): Decision {
  const tokenized = tokenizeRich(command)
  if (!tokenized) return { level: "general", reason: "unable to tokenize shell command" }
  const { tokens, stripped } = tokenized
  if (tokens.length === 0) return { level: "general", reason: "empty shell command requires explicit approval" }

  // 包装器展开：提取内层脚本递归检查
  const unwrapped = unwrap(tokens)
  if (unwrapped.action === "script") {
    const decision = evaluateShell(unwrapped.script, depth + 1, cwd)
    // 包装器载荷分层传播：包装器本身不能变成 safe，因为未来同一前缀可能
    // 承载任意脚本；可见脚本为 cautious/dangerous/forbidden 时保留更高风险层级。
    if (decision.level === "dangerous" || decision.level === "cautious" || decision.level === "forbidden") return decision
    return { level: "general", reason: unwrapped.reason }
  }
  if (unwrapped.action === "ask") return { level: "general", reason: unwrapped.reason }

  // 远程包装器展开
  const remote = remoteWrapper(tokens)
  if (remote.action === "remote") {
    if (remote.script) {
      const decision = evaluateShell(remote.script, depth + 1, cwd)
      // SSH/WSL 跨越本机信任边界：安全的远程只读命令仍是 general；可见的远程
      // 破坏性动作保留 cautious/dangerous/forbidden。
      if (decision.level === "dangerous" || decision.level === "cautious" || decision.level === "forbidden") return decision
    }
    return { level: "general", reason: remote.reason }
  }

  // token 层启发式分类：按威胁类别逐项检查
  const risk = classifyTokens(tokens, cwd, stripped)
  if (risk) return risk
  if (safeTokens(tokens, cwd, stripped)) return { level: "safe", reason: "known read-only shell command" }

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
    const strippedPrefix = classifyTokens(tokens.slice(1), cwd, stripped.slice(1))
    if (strippedPrefix?.level === "cautious") {
      const inner = normalizeCommandName(tokens[1])
      return {
        level: "cautious",
        // 审计线索：透传被未知前缀遮蔽的内层命令名和原始 reason
        reason: `unknown wrapper prefix shadows ${inner}; ${strippedPrefix.reason}`,
      }
    }
  }

  return { level: "general", reason: "unknown shell command" }
}

// ============================================================
// 第十部分：raw 层扫描
// ============================================================

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

// [local-smark] forbiddenRaw：不可逆灾难族（R2 五级拆分）——保护根删除、驱动器
// 格式化、解释器内保护根删除、反弹 shell、全进程终止。终审拒绝，任何授权不可放行。
// [local-smark] 保护路径文本折叠（forbidden/dangerous 双 raw 出口共享）：折叠
// 多斜杠（/home//user → /home/user）并解析 .. 穿越（/root/../etc → /etc）。
function foldProtectedPathText(text: string) {
  let out = text.replace(/(?!^)\/{2,}/g, "/")
  while (/\/[^/]+\/\.\.(?=\/|$)/.test(out)) {
    out = out.replace(/\/[^/]+\/\.\.(?=\/|$)/, "")
  }
  return out
}

function forbiddenRaw(command: string): string | undefined {
  const normalized = normalizeForRawScan(command)

  // ---- 保护目录递归删除（R3 分级：根本身/一级 forbidden，恰好二级由
  // dangerousRaw 的 RE_D_RM_RF_SYSTEM_SUBTREE 承载）----
  // 在 token 化之前拦截 $HOME、~/、/* 和包装器引号形式。
  const rawNormalized = foldProtectedPathText(normalized)
  if (RE_D_RM_RF_ROOT.test(rawNormalized)) return FORBIDDEN_ROOT_DELETE

  // ---- Windows 破坏性操作 ----
  if (RE_D_WINDOWS_FORMAT.test(normalized)) return "Windows drive format"
  // Windows 保护递归删除：cmd/PS 双族统一扫描器（tokenize 剥损使 token 层对
  // 未加引号反斜杠路径不可见，raw 层是唯一检测路径）
  if (windowsProtectedDeleteTier(normalized) === "forbidden") return WIN_FORBIDDEN_DELETE

  // ---- 解释器 API 内的保护目录删除 ----
  if (RE_D_PYTHON_RMTREE.test(normalized))
    return "recursive delete of filesystem root, home, or top-level system directory via Python — forbidden (cannot be authorized)"
  if (RE_D_PYTHON_REMOVE.test(normalized))
    return "file removal targeting filesystem root, home, or top-level system directory via Python — forbidden (cannot be authorized)"
  if (RE_D_NODE_REMOVE.test(normalized))
    return "file removal targeting filesystem root, home, or top-level system directory via Node.js — forbidden (cannot be authorized)"
  if (RE_D_SUBPROCESS_RM.test(normalized))
    return "recursive delete of filesystem root, home, or top-level system directory through interpreter — forbidden (cannot be authorized)"

  // ---- 反弹 shell ----
  if (RE_D_REVERSE_SHELL.test(normalized)) return "reverse shell pattern"

  // ---- 全进程终止 ----
  // mass kill 全族统一 forbidden（R1 审计 B-01）：向全部进程发信号与 rm -rf / 同级不可逆
  if (RE_D_KILL_ALL.test(normalized)) return "mass process kill"
}

// [local-smark] dangerousRaw：可授权高风险族（R2 五级拆分）——凭据外传、远程下载
// 管道执行、解码管道、sudoers/setuid 提权面。进 reviewer，显式用户授权可 allow。
function dangerousRaw(command: string): string | undefined {
  const normalized = normalizeForRawScan(command)

  // ---- 远程下载管道执行 ----
  if (RE_D_CURL_PIPE_INTERPRETER.test(normalized))
    return "remote download piped to interpreter; review the script locally before running safe commands"
  if (RE_D_PS_DOWNLOAD_EXEC.test(normalized))
    return "remote PowerShell download executed as code; review the script locally before running safe commands"

  // ---- 解码/混淆载荷管道执行 ----
  // base64 -d | sh、openssl enc -d | sh、xxd -r | sh 等：载荷不可见，须 reviewer 审
  if (RE_D_DECODE_PIPE_INTERPRETER.test(normalized))
    return "decoded/decompressed payload piped to interpreter"

  // ---- 凭据外传 ----
  // 敏感文件读取管道到网络传输；单独的敏感读取在 cautiousRaw 处理
  if (RE_D_CREDENTIAL_PIPE_NETWORK.test(normalized)) return "credential read piped to network transfer"
  if (RE_D_CREDENTIAL_UPLOAD_FLAG.test(normalized)) return "credential file sent with network transfer"
  // scp/rsync/sftp 仅出向才 dangerous（R2 W4 方向感知）：入向拉取、-i 认证键、
  // .pub 公钥不命中，落 token 层既有 cautious
  if (RE_REMOTE_TRANSFER_TOOL.test(normalized) && credentialOutboundTransfer(normalized))
    return "credential file sent with remote transfer"

  // ---- sudoers 提权面 ----
  if (RE_D_SUDOERS_WRITE.test(normalized)) return "sudoers modification grants privilege escalation"
  // cp/mv/install 目的位写入 sudoers：sudoers 路径位于段尾（$ / ; / | 前）→ dangerous。
  // 必须在 raw 层拦：cautiousRaw 的 RAW_FILE_MOVE 会把 `sudo mv ... /etc/sudoers.d/x`
  // 抢先降为 cautious（R2 GAP-2 实测）。源位形式（sudoers 在前）不匹配。
  if (RE_D_SUDOERS_COPY_DEST.test(normalized)) return "sudoers modification grants privilege escalation"

  // ---- 系统根二级子目录删除（R3 分级：可授权高风险，显式授权可放行）----
  // 与 forbiddenRaw 共享折叠归一化，穿越/多斜杠/尾斜杠形态同样命中。
  const folded = foldProtectedPathText(normalized)
  if (RE_D_RM_RF_SYSTEM_SUBTREE.test(folded)) return DANGEROUS_SUBTREE_DELETE
  if (windowsProtectedDeleteTier(normalized) === "dangerous") return DANGEROUS_SUBTREE_DELETE
  if (RE_DANGER_INTERPRETER_DELETE.test(normalized)) return DANGEROUS_INTERPRETER_DELETE

  // ---- 特权升级 ----
  if (RE_D_CHMOD_SETUID.test(normalized)) return "setuid/setgid bit creates privilege escalation surface"
}

// scp/rsync/sftp 工具词（W4 方向感知入口）
const RE_REMOTE_TRANSFER_TOOL = /\b(?:scp|rsync|sftp)\b/i

// 远端操作数近似（W4）：`user@host:path`、`[ipv6]:path`、≥3 字符裸/点分主机名
// `host:path`（含 example.com 形态）；单字母盘符 `F:\x` 不匹配（避免 Windows 本地路径误判为远端）。
const RE_REMOTE_OPERAND = /^(?:[^\s"@]+@[^\s:"]+:|\[[0-9a-fA-F:]+\]:|[A-Za-z][A-Za-z0-9.-]{2,}:)/

// [local-smark] W4 出向判定：剥除 -i / -o IdentityFile 身份参数后，若存在远端
// 操作数且首个远端操作数之前出现敏感本地路径（非 .pub 后缀）则视为出向外传。
// 判错方向为 cautious（fail 方向偏严），与既有 token 层 remote transfer 审查衔接。
function credentialOutboundTransfer(normalized: string): boolean {
  const stripped = normalized
    .replace(/(?:\s|^)-i\s+\S+/g, " ")
    .replace(/(?:\s|^)-o\s+IdentityFile(?:=|\s)\S+/g, " ")
    .replace(/(?:\s|^)-oIdentityFile=\S+/g, " ")
  const tokens = stripped.split(/\s+/).filter(Boolean)
  let firstRemote = -1
  for (let i = 0; i < tokens.length; i++) {
    if (RE_REMOTE_OPERAND.test(tokens[i]!.replace(/^["']+|["']+$/g, ""))) {
      firstRemote = i
      break
    }
  }
  // 无远端操作数则不是凭据外传（token 层另有 cautious 审查）
  if (firstRemote === -1) return false
  // [local-smark] R2 实现审计 B-02：必须用非锚定包含语义（与旧
  // RE_D_CREDENTIAL_REMOTE_TRANSFER 一致）：`/home/alice/.env`、`keys/id_rsa` 等
  // 带路径前缀的敏感文件同样算出向载荷；锚定全 token 匹配会把它们静默降为
  // cautious 并重新进入会话缓存（授权放大）。.pub 拒绝仍在前置过滤。
  const sensitive = new RegExp(SENSITIVE_PATH_ARGUMENT_PATTERN, "i")
  return tokens
    .slice(0, firstRemote)
    .some((token) => {
      const bare = token.replace(/^["']+|["']+$/g, "")
      // .pub 公钥非秘密（R2 B-03 双机制：覆盖 .ssh 路径/Windows 家目录/裸名三分支）
      if (/\.pub$/i.test(bare)) return false
      return sensitive.test(bare)
    })
}

function cautiousRaw(command: string): string | undefined {
  // 引号感知的文件删除/移动扫描：只有在 shell 可执行上下文中匹配才计数
  if (rawExecutableMatch(command, RAW_FILE_DELETE_PATTERN)) return "file deletion requires explicit approval"
  if (rawExecutableMatch(command, RAW_FILE_MOVE_PATTERN)) return "file move or rename requires explicit approval"

  const normalized = normalizeForRawScan(command)

  // ---- 持久化写入（重定向目标）----
  // splitCommands 遇到重定向会把该段降级为 opaque(general)，因此这些持久化
  // 写入必须在 raw 层捕获，否则 >> ~/.bashrc 等会被当作普通未知命令。
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
  // 解释器任意路径删除兜底（R3：修复裸 \/ 过宽后，node/subprocess 删除保持
  // cautious，与 bash rm 同层级）
  if (RE_C_NODE_FILE_REMOVE_CALL.test(normalized) || RE_C_SUBPROCESS_RM_ANY.test(normalized))
    return "interpreter file deletion requires explicit approval"
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

function splitCommands(command: string): { segments: string[]; opaque: boolean } {
  // 此分割器只识别可组合已安全命令的简单分隔符（; | && ||）。遇到未建模语法
  // （动态展开 $/反引号、子 shell ()、大括号 {}、glob *?[、文件重定向 ><、
  // 后台单 &、换行）时，仅让**当前段**降级为 opaque(general) 并从下一字符起重开
  // 新段，不毒化同条命令的其它干净段——故 `scp; echo $HOME` 中后段 `$` 不会
  // 藏掉前段 scp 的 cautious。整条都 opaque 时等价旧的"整条→general"。
  const segments: string[] = []
  let opaque = false
  // tainted 标记当前段是否由 bail 字符重开（即 bail 之后的残余片段）。残余片段
  // 是被未建模语法切碎的 token 残骸（如 `echo $mkfs` 中 `$` 之后的 "mkfs"），
  // 并非真实命令——分类它会把变量名误判为危险命令（mkfs→dangerous 误拒）。
  // 故 tainted 段只记 opaque(general)，不入 segments 参与分类；分隔符会重置它，
  // 因为分隔符之后是真实的新命令。与 :480 剥头启发式"不越权升 token 层
  // dangerous"的设计保持一致。
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
    // POSIX 单引号内反斜杠是字面量，不应开启转义状态
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      // 双引号内 $/` 仍可能展开：整条不得升 safe（opaque→general），但不可 taint-restart。
      // taint-restart 会丢掉前缀 `git …` argv，使 classifyGit 不可达，auto 把 general 直过 allow。
      else if (quote !== "'" && (char === "$" || char === "`")) opaque = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    // fd-merge 重定向（2>&1 / 1>&2 / >&2 / 2>&- 等）：仅合并或关闭 fd，不写文件，
    // 属良性。原子消费 >/< + & + fd 数字串/- 并继续当前段，避免误 bail 让
    // `scp 2>&1` 因 `>` 或 `&` 落入 opaque 而绕过 scp 的 cautious 审查。
    // 必须在下方 `>`/`<` 与单 `&` 的 bail 判断之前命中并 continue——否则 `2>&1`
    // 里的 `&` 会触发单 `&` bail 使本改动失效。
    if ((char === ">" || char === "<") && command[i + 1] === "&" && (/\d/.test(command[i + 2]) || command[i + 2] === "-")) {
      let j = i + 2
      if (command[j] === "-") j++
      else while (/\d/.test(command[j])) j++
      i = j - 1
      continue
    }

    // 空重定向到 /dev/null（含 2>/dev/null）：丢弃流、不写普通文件，与 fd-merge 同属良性。
    // 若按普通 `>` bail，会 taint 掉 `git reset … 2>/dev/null` 的前缀 token 分类。
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

    // 未建模 shell 语法：当前段 opaque（不入 segments），紧随其后字符起开始新段。
    // 不再 return 整条，避免一个 bail 字符毒化已切出的干净 cautious 段。
    // 单 `&`（后台）与换行在此 opaque 而非切分——保 `git status & rg`/`git status\nrg`
    // 为 general（:69/:70），不能 split 否则会变 safe。
    // `$`/`：只标 opaque、不 taint-restart，保留前缀 argv 给 classifyTokens/classifyGit；
    // max(safe, general)=general，max(cautious, general)=cautious，堵住 auto 直过洞。
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

  // 未闭合引号/悬挂转义：末段 opaque（`git status '` → general，保既有 :231 行为）
  if (quote || escaped) opaque = true
  else pushSegment(command.length)

  return { segments, opaque }
}

function tokenize(command: string) {
  return tokenizeRich(command)?.tokens
}

// [local-smark] R1 实现审计 B-01r2：tokenize 的 POSIX 反斜杠转义会剥掉未加
// 单引号的反斜杠（..\other → ..other），剥损事实只存在于本解析循环——
// 以 per-token 标记暴露给 -C membership 消费者：目标 token 经历过剥损即
// 无法与字面量区分，一律保守 outside（多审不漏审），镜像盘符相对剥损 guard。
function tokenizeRich(command: string): { tokens: string[]; stripped: boolean[] } | undefined {
  // token 化有意小于完整的 shell 解析器。它保留带引号的空格和转义字符
  // 用于类路径参数，但格式错误的引号或悬挂的转义会强制提示而不是修复输入。
  const out: string[] = []
  const stripped: boolean[] = []
  let current = ""
  let quote = ""
  let escaped = false
  let tokenStripped = false

  for (const char of command) {
    if (escaped) {
      current += char
      tokenStripped = true
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
      if (current) {
        out.push(current)
        stripped.push(tokenStripped)
        tokenStripped = false
      }
      current = ""
      continue
    }
    current += char
  }

  if (quote || escaped) return
  if (current) {
    out.push(current)
    stripped.push(tokenStripped)
  }
  return { tokens: out, stripped }
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
      // 与 cmd /c 对齐：-Command 后全部剩余 token 拼成载荷。
      // 旧逻辑只取 tokens[index+1]，会丢掉 `Remove-Item file.txt` 的路径参数 → general 直过。
      return {
        action: "script",
        script: tokens.slice(index + 1).join(" "),
        reason: "PowerShell wrapper requires explicit approval",
      }
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
  if (cmd === "env") {
    // env 不是读 .env 文件，而是包装器：剥 KEY=val 与常见 flag 后对内层命令递归分类。
    // 旧 always-ask 会让 `env rm` / `env git reset --hard` 在 auto 下 general 直过。
    const rest = pierceEnvTokens(tokens.slice(1))
    if (rest.length > 0)
      return { action: "script", script: joinShellTokens(rest), reason: "env wrapper requires explicit approval" }
    return { action: "ask", reason: "env wrapper requires explicit approval" }
  }
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    // 特权包装器：提取内层命令递归评估，而非短路为 general。
    // sudo rm file 应至少 cautious，sudo rm -rf / 应 dangerous。
    if (tokens.length > 1)
      return { action: "script", script: joinShellTokens(tokens.slice(1)), reason: "privilege wrapper requires explicit approval" }
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

function classifyTokens(tokens: string[], cwd?: string, stripped?: boolean[]): Decision | undefined {
  const cmd = normalizeCommandName(tokens[0])

  // ---- 跨命令：敏感路径读取 ----
  // 读取或列出 .env、SSH key、云凭据等本地敏感位置会把密钥内容或存在性
  // 暴露给 shell 输出和模型上下文，从 safe/general 提升为 cautious。
  if (readsSensitivePath(tokens)) return { level: "cautious", reason: "sensitive file read requires explicit approval" }

  // [local-smark] sudoers 方向判定（R2 GAP-2）：cp/mv/install 的目的操作数位
  // （最后一个路径实参）指向 sudoers 路径 → dangerous 提权写入；sudoers 仅作
  // 源（读方向）→ cautious 敏感读取。必须先于通用文件删除/移动分支：
  // 否则 mv 被 FILE_MOVE_COMMANDS 抢先降为 cautious（R2 实测发现）。
  if ((cmd === "cp" || cmd === "mv" || cmd === "install") && tokens.some((item) => item.startsWith("/etc/sudoers"))) {
    const lastPath = tokens.at(-1)
    if (lastPath && lastPath.startsWith("/etc/sudoers"))
      return { level: "dangerous", reason: "sudoers modification grants privilege escalation" }
    return { level: "cautious", reason: "sensitive system file read requires explicit approval" }
  }

  // ---- 文件删除 ----
  // [local-smark] R3 三级分级（protectedDeleteTier）：保护根/一级 → forbidden；
  // 系统根恰好二级 → dangerous（可授权高风险）；普通递归删除 → cautious。
  if (cmd === "rm" && hasRecursiveDeleteFlags(tokens.slice(1))) {
    const tier = highestProtectedDeleteTier(tokens.slice(1))
    if (tier === "forbidden") return { level: "forbidden", reason: FORBIDDEN_ROOT_DELETE }
    if (tier === "dangerous") return { level: "dangerous", reason: DANGEROUS_SUBTREE_DELETE }
    return { level: "cautious", reason: "recursive delete requires explicit approval" }
  }
  if ((cmd === "remove-item" || cmd === "ri") && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    const tier = highestProtectedDeleteTier(tokens.slice(1))
    if (tier === "forbidden") return { level: "forbidden", reason: WIN_FORBIDDEN_DELETE }
    if (tier === "dangerous") return { level: "dangerous", reason: DANGEROUS_SUBTREE_DELETE }
    return { level: "cautious", reason: "recursive PowerShell delete requires explicit approval" }
  }
  // 与 rm 对称：del/rd/rmdir 保护目录递归删除走同一分级谓词，不降到 cautious
  const winTier = windowsRecursiveDeleteTier(tokens)
  if (winTier === "forbidden") return { level: "forbidden", reason: WIN_FORBIDDEN_DELETE }
  if (winTier === "dangerous") return { level: "dangerous", reason: DANGEROUS_SUBTREE_DELETE }
  if (FILE_DELETE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file deletion requires explicit approval" }
  if (findDeletesFile(tokens))
    return { level: "cautious", reason: "find file deletion requires explicit approval" }

  // ---- 文件移动/重命名 ----
  if (FILE_MOVE_COMMANDS.has(cmd) && tokens.length > 1)
    return { level: "cautious", reason: "file move or rename requires explicit approval" }

  // ---- PowerShell 内容覆写/截断 ----
  // Clear-Content/Set-Content/Out-File 可清空或覆盖工作树文件；help-only 不抬升。
  if (FILE_WRITE_COMMANDS.has(cmd)) {
    const args = tokens.slice(1)
    if (args.some((item) => !["--help", "-h", "--version", "-v"].includes(item.toLowerCase())))
      return { level: "cautious", reason: "PowerShell file content write requires explicit approval" }
  }

  // ---- 原始磁盘写入 ----
  if (cmd === "dd" && tokens.some((item) => item.startsWith("of=/dev/")))
    return { level: "forbidden", reason: "raw disk write" }

  // ---- 磁盘格式化/分区（R2 五级拆分 + GAP-1；R3 只读形态收窄）----
  // mkfs 前缀族覆盖全部文件系统变体，任何形态都写盘 → forbidden（用户决策）。
  // fdisk/parted 的 -l/--list 与 wipefs 无 -a/--all 均为只读打印（分区表/签名）
  // → cautious；合并短开关簇感知（wipefs -af、fdisk -lu）防簇形态漏检。
  if (cmd === "mkfs" || cmd.startsWith("mkfs."))
    return { level: "forbidden", reason: "disk formatting or partition table destruction is irreversible" }
  if (DISK_FORMAT_COMMANDS.has(cmd)) {
    const args = tokens.slice(1)
    const clusterHas = (ch: string) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(ch))
    const listOnly = clusterHas("l") || args.some((a) => a === "--list")
    const wipefsWrites = cmd === "wipefs" && (clusterHas("a") || args.some((a) => a === "--all"))
    if (cmd === "wipefs" ? !wipefsWrites : listOnly)
      return { level: "cautious", reason: "disk partition inspection is read-only" }
    return { level: "forbidden", reason: "disk formatting or partition table destruction is irreversible" }
  }

  // ---- 关机/重启族（R2 五级拆分）----
  // 可逆（重新开机），归 dangerous 进 reviewer：显式用户授权可 allow
  if (SHUTDOWN_COMMANDS.has(cmd))
    return { level: "dangerous", reason: "system shutdown or reboot requires explicit user authorization" }

  // ---- Git 操作 ----
  // Git 子命令的分类较复杂，委托给专项分类器
  if (cmd === "git") return classifyGit(tokens, cwd, stripped)

  // ---- 系统 patch 应用 ----
  // GNU/BSD patch 改工作树；仅 help/version/裸命令保持 general，避免无载荷噪声。
  if (cmd === "patch") {
    const args = tokens.slice(1)
    if (args.some((item) => !["--help", "-h", "--version", "-v"].includes(item)))
      return { level: "cautious", reason: "patch apply modifies working tree" }
  }

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
    // mask 可逆（unmask 即恢复），归 dangerous 进 reviewer；旧注释“永久阻止”不准确
    if (tokens[1] === "mask")
      return { level: "dangerous", reason: "service mask alters system service policy" }
    if (["stop", "disable", "enable", "start", "restart"].includes(tokens[1]))
      return { level: "cautious", reason: "service state change requires explicit approval" }
  }

  // ---- 进程终止 ----
  // [local-smark] 危险前置保序（:718 kill -9 -1 契约）：killall5 唯一语义即向
  // 全部进程发信号（sysvinit-utils/busybox）无条件 forbidden（R2 五级拆分：
  // 与 rm -rf / 同级不可逆）；kill 的 -1 必须处于尾操作数位（POSIX
  // `kill -<signum> <pid>` 中信号位 -1 如 `kill -1 1234` 是单进程 SIGHUP，
  // 属 cautious 档）；-l 只读豁免对齐 crontab -l 先例（flags 全为 -l 且有实参，
  // 容忍非 flag 实参：kill -l / kill -l 9 仅列信号名）。
  if (cmd === "killall5")
    return { level: "forbidden", reason: "mass process kill" }
  if (cmd === "kill" && tokens.at(-1) === "-1" && !tokens.slice(1).includes("-l"))
    return { level: "forbidden", reason: "mass process kill" }
  if (PROCESS_TERMINATION_COMMANDS.has(cmd)) {
    const args = tokens.slice(1)
    const flags = args.filter((item) => item.startsWith("-"))
    if (args.length > 0 && flags.length > 0 && flags.every((item) => item === "-l")) return
    return { level: "cautious", reason: "process termination requires explicit approval" }
  }

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

// [local-smark] R1 语义二分：-C 只是 cwd 重定向，按目标目录 membership 豁免；
// 注入族(-c/--config-env/--git-dir/--work-tree/--exec-path)可重定向仓库、
// 注入配置(hooksPath)或替换 git 辅助二进制，永不豁免。与 gitSafe 共用，
// 消除重复。
const GIT_INJECTION_GLOBAL = new Set(["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"])

// 判定单个 token 属于哪类 git 全局 flag。=附着长形式与短选项附着形式
// (-Cdir/-cconf=v)都在此处归一化，闭合旧实现只做精确集合匹配时
// `git -Cdir status` 落入安全 boolean 分支被跳过的直通绕过。
function gitFlagKind(t: string): "redirect" | "injection" | "safe" {
  const flag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t
  if (t === "-C" || /^-C.+/.test(t)) return "redirect"
  if (GIT_INJECTION_GLOBAL.has(flag) || /^-c.+/.test(t)) return "injection"
  return "safe"
}

// -C 的目标目录：裸形式取下一 token，附着形式(-Cdir/-C=dir)自含并剥去引导 =。
function gitRedirectTarget(t: string, next: string | undefined) {
  return t.length > 2 ? t.slice(2).replace(/^=/, "") : next
}

// [local-smark] R1 membership 纯词法判定（无 I/O，precheck 同步契约）：
// 相对实参以 cwd 为基 resolve+normalize；$VAR/通配/~ 静态不可解析时保守判
// outside（fail-closed，与 opaque→general 同哲学）。win32 文件系统大小写
// 不敏感→折叠比较；POSIX 严格字节。symlink 逃逸为已接受残留（plan §20）。
function redirectsInsideCwd(target: string | undefined, cwd: string | undefined) {
  if (!cwd || !target || /[$*?~]/.test(target)) return false
  // 盘符冒号后无分隔符（F:foo / 裸 F:）是 win32 盘符相对路径：它随该盘的
  // remembered cwd 漂移，无法静态证明 inside；且 tokenize 的 POSIX 反斜杠转义
  // 会把未加单引号的 Windows 路径 F:\a\b 剥成 F:ab，恰好落入此形态——一律
  // 保守 outside，剥损只会导致多审不会导致漏审。
  if (/^[A-Za-z]:(?:$|[^\\/])/.test(target)) return false
  const abs = nodePath.normalize(nodePath.resolve(cwd, target))
  const base = nodePath.normalize(cwd)
  if (process.platform === "win32") {
    const a = abs.toLowerCase()
    const c = base.toLowerCase()
    return a === c || a.startsWith(c + nodePath.sep)
  }
  return abs === base || abs.startsWith(base + nodePath.sep)
}

// ---- Git 子命令专项分类器 ----
// Git 操作复杂且有多个风险层级，需要细化的启发式判断。
function classifyGit(tokens: string[], cwd?: string, stripped?: boolean[]): Decision | undefined {
  // 单遍扫描全局 flag：不再早返回，记录全部命中信号后继续定位子命令，
  // 保证子命令分类不被 flag 遮蔽（R1 根因修复）。
  const reasons: string[] = []
  let i = 1
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const t = tokens[i]
    const kind = gitFlagKind(t)
    if (kind === "redirect") {
      // 目标 token 若经历过 tokenize 的反斜杠剥损（..\other → ..other）则
      // 与字面量不可区分且真目标可能位于 cwd 之外——保守 outside（B-01r2）。
      const mangled = t.length > 2 ? stripped?.[i] === true : stripped?.[i + 1] === true
      if (mangled || !redirectsInsideCwd(gitRedirectTarget(t, tokens[i + 1]), cwd))
        reasons.push("git -C redirects outside the working directory")
      i += t.length > 2 ? 1 : 2
      continue
    }
    if (kind === "injection") {
      reasons.push("git global flag injects configuration or binary path")
      // 自含形式(=附着/短选项附着)只跳 1；裸注入 flag 消费一个实参跳 2；
      // --exec-path 裸形是可选参（print-and-exit 不消费子命令位）例外跳 1。
      i += t.includes("=") || t.length > 2 || t === "--exec-path" ? 1 : 2
      continue
    }
    // 安全的 boolean flag(--no-pager/--paginate 等)不消费参数,直接跳过。
    // 极少数吃参数的全局 flag(如 --namespace)不在注入集合中,
    // 会将参数误当作子命令;但这些 flag 极少使用且命令仍落入 general(非 safe)。
    i++
  }
  const subDecision = classifyGitSubcommand(tokens, i)
  // 合并规则（R1）：flag 信号为空（-C inside 或无 flag）→与无 flag 完全同构，
  // 保证无 flag reason 字节不变与 inside 只读零负担；双信号命中时效应类在前、
  // 每条规则独占一行（用户原文「两行」）。
  if (reasons.length === 0) return subDecision
  if (subDecision) return { level: subDecision.level, reason: [subDecision.reason, ...reasons].join("\n") }
  return { level: "cautious", reason: reasons.join("\n") }
}

function classifyGitSubcommand(tokens: string[], i: number): Decision | undefined {
  const sub = tokens[i]
  if (!sub) return undefined

  // 特定高风险 git 操作（先于通用检查，提供更精确的原因描述）
  if (sub === "reset" && tokens.includes("--hard"))
    return { level: "cautious", reason: "destructive git reset requires explicit approval" }
  if (sub === "clean" && tokens.some((item) => item.startsWith("-") && item.includes("f") && item.includes("d")))
    return { level: "cautious", reason: "destructive git clean requires explicit approval" }
  if (sub === "push" && tokens.some((item) => item === "--force" || item === "-f"))
    return { level: "cautious", reason: "force push requires explicit approval" }
  // bundle create 会写出归档文件；仅提升 create，避免把 verify/list-heads 等读取模式扩大为 cautious。
  if (sub === "bundle" && tokens[i + 1] === "create")
    return { level: "cautious", reason: "git bundle creation requires explicit approval" }

  // 通用状态变更命令：修改索引、历史、引用、工作树或远端状态，需要审批。
  // checkout/switch/restore 可丢弃未提交修改;apply/am 修改工作树;
  // filter-branch/filter-repo 重写历史;update-ref 直接改引用;bisect checkout 不同提交;
  // symbolic-ref 改符号引用;worktree 创建/删除工作树;submodule 可克隆+执行 hooks。
  // filter-repo 与 filter-branch 同属历史重写；仅列 filter-branch 时 filter-repo 会 general 直过 auto。
  if (
    ["add", "commit", "merge", "rebase", "cherry-pick", "revert", "push", "pull",
     "reset", "clean", "mv", "rm",
     "checkout", "switch", "restore", "apply", "am",
     "filter-branch", "filter-repo", "update-ref", "bisect", "symbolic-ref",
     "worktree", "submodule"].includes(sub)
  )
    return { level: "cautious", reason: "git state-changing command requires explicit approval" }

  // stash: list 是只读;其余(push/pop/drop/clear)修改工作树或丢失暂存
  if (sub === "stash" && tokens[i + 1] !== "list")
    return { level: "cautious", reason: "git stash modifies working tree state" }

  // config: 无参数仅打印 help(--get/--list 由 gitSafe 放行为 safe);
  // 其余可设 hooksPath 等危险配置,需审查
  if (sub === "config" && tokens[i + 1] && tokens[i + 1] !== "--get" && tokens[i + 1] !== "--list")
    return { level: "cautious", reason: "git config modification requires explicit approval" }

  // remote: 无参数和 -v 是只读;add/remove/set-url 可将 push 重定向到攻击者仓库
  if (sub === "remote" && tokens[i + 1] && tokens[i + 1] !== "-v")
    return { level: "cautious", reason: "git remote modification requires explicit approval" }

  // tag: 无参数和 -l/--list 是只读;创建/删除标签修改仓库状态
  if (sub === "tag" && tokens[i + 1] && tokens[i + 1] !== "-l" && tokens[i + 1] !== "--list")
    return { level: "cautious", reason: "git tag creation or deletion requires explicit approval" }

  // 分支操作：仅在非只读模式时为 cautious。用 tokens.slice(i + 1) 而非
  // tokens.slice(2),以支持安全 boolean flag(如 --no-pager)前置的情况。
  if (sub === "branch" && !gitBranchSafe(tokens.slice(i + 1)))
    return { level: "cautious", reason: "git branch mutation requires explicit approval" }

  return undefined
}

// ============================================================
// 第十五部分：safe 层判定
// ============================================================

function safeTokens(tokens: string[], cwd?: string, stripped?: boolean[]) {
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
  if (cmd === "git") return gitSafe(tokens, cwd, stripped)
  // 包管理器只读子命令
  if (["npm", "pnpm", "yarn"].includes(cmd))
    return ["ls", "list", "view", "info", "why", "outdated"].includes(tokens[1])
  // bun 只读子命令（排除 install/x 等）
  if (cmd === "bun") return false
  return versionSafe(tokens)
}

function gitSafe(tokens: string[], cwd?: string, stripped?: boolean[]) {
  // 只有只读的 git 子命令是 safe。-C 经 membership 豁免（与 classifyGit 同
  // 语义，防御层一致性）；注入族仍拒绝，因为它们可以将安全子命令重定向到
  // 另一个仓库或辅助程序。防御性冗余:主路径已在 classifyGit 处理全局 flag;
  // 保留此检查防止未来 classifyGit 改动引入绕过。redirect 的实参一并跳过，
  // 避免把 -C 的目标目录误当子命令。
  const unsafeReadFlag = new Set(["--ext-diff", "--textconv"])
  const safe = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"])
  let subcommand: string | undefined
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.startsWith("-")) {
      const kind = gitFlagKind(t)
      if (kind === "redirect") {
        // 剥损标记与 classifyGit 同判定（防御层一致性，B-01r2）：被剥损的
        // 目标不可证 inside，一律拒绝 safe。
        const mangled = t.length > 2 ? stripped?.[i] === true : stripped?.[i + 1] === true
        if (mangled || !redirectsInsideCwd(gitRedirectTarget(t, tokens[i + 1]), cwd)) return false
        i += t.length > 2 ? 1 : 2
        continue
      }
      if (kind === "injection") return false
      if (unsafeReadFlag.has(t)) return false
      i++
      continue
    }
    if (t === "remote") return tokens[i + 1] === "-v"
    if (t === "config") return tokens[i + 1] === "--get" || tokens[i + 1] === "--list"
    if (t === "branch") return gitBranchSafe(tokens.slice(i + 1))
    if (!subcommand) subcommand = t
    i++
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

function hasRecursiveDeleteFlags(tokens: string[]) {
  // rm 的递归/强制可作组合短标志（-rf、-fr）、分离短标志（-r -f、-R -f）
  // 或长标志。保护根判定仅依赖递归标志——-f（force）只压制提示符，不增加
  // 破坏性，因此 rm -r / 与 rm -rf / 同等危险，不应将 -f 作为 dangerous 门槛。
  return tokens.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item))
}

// cmd del/rd/rmdir 可合并的单字母开关；s=递归。禁止 tree-sitter、/setup 等非开关词。
const WINDOWS_CMD_SWITCH_LETTERS = new Set(["a", "f", "p", "q", "s", "u"])

function hasWindowsRecursiveDeleteFlag(tokens: string[]) {
  return tokens.some(isWindowsRecursiveDeleteFlagToken)
}

function isWindowsRecursiveDeleteFlagToken(token: string) {
  const t = token.toLowerCase()
  if (t === "/s" || t === "-s" || t === "--recursive") return true
  // 仅整 token 纯开关 cluster：/s/q、/s/p、/sq；不得裸子串匹配 -sitter
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

// [local-smark] Windows 删除族统一 raw 扫描器（R3 审计 B-02）：tokenizeRich 的
// POSIX 转义会剥掉未加引号反斜杠（C:\Users\u\AppData → C:UsersuAppData），token
// 层对这类路径不可见——cmd 与 PS 双族的层级判定只能在 raw 文本层完成。除段首
// 外，已知包装器（powershell/pwsh/cmd/bash/sh/wsl 的 -Command/-c/-lc 与 /c、--）
// 载荷起点之后同样视为可执行位置（承载原 RE_D_PS_RECURSIVE_DELETE_ROOT 的包装器
// 内覆盖）；纯文本形态（echo "del /s …"）不进入判定。
// forbiddenRaw 消费 forbidden 档，dangerousRaw 消费 dangerous 档。
function windowsProtectedDeleteTier(command: string): "forbidden" | "dangerous" | undefined {
  let tier: "forbidden" | "dangerous" | undefined
  const consider = (rawTokens: string[]) => {
    if (rawTokens.length < 2) return
    // 包装器载荷常带引号包裹（powershell -Command "Remove-Item …"），剥除后判定
    const tokens = rawTokens.map((t) => t.replace(/^["']+|["']+$/g, ""))
    const cmd = normalizeCommandName(tokens[0])
    const rest = tokens.slice(1)
    const isCmdDelete = (cmd === "del" || cmd === "erase" || cmd === "rd" || cmd === "rmdir") && hasWindowsRecursiveDeleteFlag(rest)
    const isPsDelete = (cmd === "remove-item" || cmd === "ri") && rest.some((t) => t.toLowerCase() === "-recurse")
    if (!isCmdDelete && !isPsDelete) return
    const t2 = highestProtectedDeleteTier(rest)
    if (t2 === "forbidden") tier = "forbidden"
    else if (t2 === "dangerous" && tier !== "forbidden") tier = "dangerous"
  }
  for (const segment of command.split(/[;|&]+/)) {
    const tokens = windowsCmdTokens(segment.trim())
    consider(tokens)
    for (let i = 1; i < tokens.length; i++) {
      if (/^(?:-(?:command|c|lc)|\/c|--)$/i.test(tokens[i])) consider(tokens.slice(i + 1))
    }
  }
  return tier
}

function windowsRecursiveDeleteTier(tokens: string[]): "forbidden" | "dangerous" | undefined {
  // 三元组同时成立才定级：命令名 + 递归开关 + 保护目录（与 rm 语义对称）
  if (tokens.length < 2) return undefined
  const cmd = normalizeCommandName(tokens[0])
  if (cmd !== "del" && cmd !== "erase" && cmd !== "rd" && cmd !== "rmdir") return undefined
  const rest = tokens.slice(1)
  if (!hasWindowsRecursiveDeleteFlag(rest)) return undefined
  return highestProtectedDeleteTier(rest)
}

// 仅空白切分并保留 \。POSIX tokenize 把 \ 当转义吞掉，C:\Users 会变成 C:Users 导致保护根 FN。
function windowsCmdTokens(segment: string) {
  return segment.trim().split(/\s+/).filter(Boolean)
}

// POSIX 保护根（与 RE 常量 POSIX_SYSTEM_ROOTS/POSIX_USER_DATA_ROOTS 同族，
// /root 另行保持既有"仅根本身"豁免）
const PROTECTED_POSIX_ROOTS = [
  "/etc", "/usr", "/var", "/lib", "/lib64", "/bin", "/sbin",
  "/boot", "/sys", "/proc", "/dev", "/opt", "/root", "/home",
  // macOS 特有
  "/Library", "/Applications", "/System", "/Users",
]

// [local-smark] 保护删除三级分级（R3）：根/家/驱动器根与系统根根本身及其一级
// 子目录是不可逆灾难 → forbidden（终审）；系统根恰好二级子目录 → dangerous
// （可授权高风险）；更深子树不保护（落普通递归删除 cautious）。
// 用户数据根（/home /Users）深层与 /root 子目录保持既有豁免，不 widen。
// 家目录/环境变量别名大小写不敏感（PowerShell env provider 语义，承载原
// RE_D_PS_RECURSIVE_DELETE_ROOT 的 i 旗）。
function protectedDeleteTier(input: string): "forbidden" | "dangerous" | undefined {
  // 折叠多斜杠并解析 .. 穿越以正确判定保护根（/home//user → /home/user、
  // /home/../etc → /etc）
  let normalized = input.replaceAll("\\", "/").replace(/\/{2,}/g, "/")
  // 尾斜杠剥除不得把根 "/" 本身剥成空串（保护根 "/" 必须保持可判定）
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "")
  while (/\/[^/]+\/\.\.(?=\/|$)/.test(normalized)) {
    normalized = normalized.replace(/\/[^/]+\/\.\.(?=\/|$)/, "")
  }
  // POSIX 根和通配符
  if (normalized === "/" || normalized === "/*" || normalized === "/.") return "forbidden"
  // 家目录/环境变量别名（大小写不敏感）
  const alias = normalized.toLowerCase()
  if (alias === "~" || alias === "$home" || alias === "$env:userprofile" || alias === "$env:systemdrive" || alias === "%userprofile%")
    return "forbidden"
  // Windows 驱动器根：C:\ 或 C:
  if (/^\w:\/?$/i.test(normalized)) return "forbidden"
  // Windows 系统目录：根本身与一级 forbidden、恰好二级 dangerous、更深不保护
  const win = /^[A-Za-z]:\/([^/]+)(?:\/(.*))?$/.exec(normalized)
  if (win && /^(Windows|Program Files|Users)$/i.test(win[1]!)) {
    const depth = win[2] ? win[2].split("/").length : 0
    return depth <= 1 ? "forbidden" : depth === 2 ? "dangerous" : undefined
  }
  // POSIX 系统根：根本身与一级 forbidden、恰好二级 dangerous、更深不保护；
  // 用户数据根（/home /Users）深层与 /root 子目录保持既有豁免
  for (const root of PROTECTED_POSIX_ROOTS) {
    if (normalized === root) return "forbidden"
    if (!normalized.startsWith(root + "/")) continue
    const depth = normalized.slice(root.length + 1).split("/").length
    if (root === "/root") return undefined
    if (root === "/home" || root === "/Users") return depth === 1 ? "forbidden" : undefined
    return depth <= 1 ? "forbidden" : depth === 2 ? "dangerous" : undefined
  }
  return undefined
}

function highestProtectedDeleteTier(tokens: string[]): "forbidden" | "dangerous" | undefined {
  let tier: "forbidden" | "dangerous" | undefined
  for (const token of tokens) {
    const t = protectedDeleteTier(token)
    if (t === "forbidden") return "forbidden"
    if (t === "dangerous") tier = "dangerous"
  }
  return tier
}

function normalizeCommandName(input: string) {
  // 归一化路径和 Windows 可执行后缀，使策略常量不需要为 /usr/bin/git、
  // git.exe 或 PowerShell.EXE 设置重复条目。
  const name = input.replaceAll("\\", "/").split("/").at(-1) ?? input
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase()
}

function pierceEnvTokens(args: string[]) {
  // 剥掉 env 的 KEY=value 与常见 flag，露出内层可执行命令 argv（token 语义，非正则扫全文）。
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) continue
    const lower = item.toLowerCase()
    if (lower === "-i" || lower === "-0" || lower === "--null" || lower === "--ignore-environment") continue
    if (lower === "-u" || lower === "--unset") {
      i++
      continue
    }
    out.push(...args.slice(i))
    break
  }
  return out
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

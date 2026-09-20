// ============================================================
// precheck.ts — shell 命令静态语义预分类器
// ============================================================

import * as nodePath from "node:path"
import { ShellParse } from "@/shell/parse"
//
// 设计哲学：fail-closed（失败保守）。任何无法理解的语法、动态展开、
// 编码混淆都降级为 general 或更高风险层级，绝不猜测为 safe。
//
// 分层架构：
//   Phase 1 — 语法事实提取：共享grammar确定命令、引用、重定向与管道边界，
//             输入文件和输出文件单独保存，避免被误作删除操作数
//   Phase 2 — 包装器载荷提取与递归：shell/PowerShell/cmd/ssh/wsl 等
//             包装器的内层脚本提取后递归预审，内层风险向外传播
//   Phase 3 — 参数角色绑定：选项消费自己的值，源码按对应语言识别调用与数据
//   Phase 4 — token 启发式分类：基于命令名 + 参数谓词的结构化规则，
//             按威胁类别组织（删除、权限、持久化、网络、包管理等）
//   Phase 5 — 多段聚合：取所有分段中的最高风险层级
//
// 核心不变量：
//   • 包装器永远不是 safe（内层 safe 仍回 general）
//   • 语法问题与普通动态参数沿用general，已确定风险继续参与聚合
//   • 最高等级优先，同级具体原因去重保留，审批政策仍由原路由负责
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

// token 级文件删除/移动集合：承接原文本扫描和参数分类的共同范围，路径限定的
// 二进制文件（如 /bin/rm）在 token 化成功后也无法绕过审查。
// ri 是 Remove-Item 官方别名；必须与 remove-item 同级（含保护根 -Recurse dangerous）。
const FILE_DELETE_COMMANDS = new Set(["rm", "unlink", "rmdir", "del", "erase", "rd", "remove-item", "ri", "trash-put"])
const FILE_MOVE_COMMANDS = new Set(["mv", "move", "ren", "rename", "move-item", "rename-item"])
// PowerShell 工作树覆写/截断：与删除不同族，但同样不可 auto 直过。
const FILE_WRITE_COMMANDS = new Set(["clear-content", "set-content", "out-file"])

// find的这些选项会消费后一个参数；例如-name "-delete"中的-delete是匹配值。
// 此表只描述参数元数，真正的删除动作仍由原-delete和-exec/-execdir规则判定。
const FIND_VALUES = ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth", "-size", "-user", "-group"]

// curl取值表同时包含上传、请求数据、认证、代理和输出选项，用于确定值的归属。
// -H '--data=@.env'整体是header值；列入此表不代表该选项会读取文件或触发审查。
const CURL_VALUES = ["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form", "--form-string", "-T", "--upload-file", "-H", "--header", "--proxy-header", "-u", "--user", "-U", "--proxy-user", "-o", "--output", "-A", "--user-agent", "-e", "--referer", "-X", "--request", "--url", "-x", "--proxy", "-K", "--config"]

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

// 完整敏感路径模式（含 .pem/.key），仅用于已绑定的外传来源检测。
// 在外传上下文中（管道到 curl/网络传输），即使是没有上下文的 .pem/.key
// 也应该被拦截，因为风险收益比倾向于保守。
const SENSITIVE_PATH_PATTERN = SENSITIVE_PATH_CORE_PATTERN + String.raw`|[^\s|;]+\.pem|[^\s|;]+\.key`

// ============================================================
// 第五部分：保护路径值域与既有拒绝原因
// ============================================================
// 路径表达式只消费已确认的目标值，命令范围与参数角色由Token层提供。

// 保护根目录递归删除：/ | /* | /. | ~ | $HOME | /etc 以及扩展的系统根目录。
// 仅检查递归标志（-r/-R/--recursive），不要求 -f（force）：force 只压制提示符，
// 不增加破坏性，rm -r / 与 rm -rf / 破坏力等价。
// [local-smark] R3 分级：系统根（/etc、/usr 等）保护根本身与一级子目录
// （/usr/local、/etc/ssl）；恰好二级子目录为dangerous，由原目录分级谓词承载；
// 更深子树保持普通删除分类。用户数据根（/home、/Users）
// 仅保护根本身和一级子目录（用户家目录）；/root 仅保护根本身，子目录不保护。
const POSIX_SYSTEM_ROOTS = String.raw`etc|usr|var|lib(?:64)?|s?bin|boot|sys|proc|dev|opt|Library|Applications|System`
const POSIX_USER_DATA_ROOTS = String.raw`home|Users`

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
// 一级；dangerous 恰好二级；普通字面路径删除保持cautious。路径边界前必须
// 容忍可选尾斜杠（tab补全形态"/etc/ssl/"），并沿用解释器独立的路径集合。
const INTERPRETER_FORBIDDEN_PATH = String.raw`\/(?=["'\s)])|~\/?(?=["'\s)])|\$HOME\/?(?=["'\s)])|\/(?:${POSIX_SYSTEM_ROOTS})(?:\/[^\/\s"']+)?\/?(?=["'\s)])|\/(?:${POSIX_USER_DATA_ROOTS})\/[^\/\s"']+\/?(?=["'\s)])`
const INTERPRETER_DANGEROUS_PATH = String.raw`\/(?:${POSIX_SYSTEM_ROOTS})\/[^\/\s"']+\/[^\/\s"']+\/?(?=["'\s)])`

// 原持久化写入规则只接收已绑定的输出路径；正文中的同名路径保持普通数据。
const redirectRules = new Map([
  [/^(?:~|\$HOME)?\/?\.(?:bash(?:rc|_profile|_login|_logout)|zshrc|zprofile|zlogin|profile|login|cshrc|tcshrc)$/i, "shell RC file modification enables persistent code execution"],
  [/\.git\/hooks\//i, "git hook modification runs code on git operations"],
  [/^\/(?:etc\/cron|var\/spool\/cron)/i, "cron directory write enables persistent scheduled execution"],
  [/^(?:\/etc\/systemd|~\/\.config\/systemd)\//i, "systemd unit file write enables persistent service execution"],
  [/^(?:(?:~|\$HOME)\/|\/(?:home\/[^/]+|root|Users\/[^/]+)\/|[A-Za-z]:\/Users\/[^/]+\/)?\.ssh\/authorized_keys/i, "SSH authorized_keys modification requires explicit approval"],
])

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

export async function evaluate(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Promise<Decision> {
  const externalDirectory = await externalDirectoryEffect(input)
  if (externalDirectory) return externalDirectory
  const fileEffect = structuredFileEffect(input)
  if (fileEffect) return fileEffect

  // bash and external_directory carry enough context for deterministic precheck.
  // Other permissions default to general allow unless a structured boundary above
  // promoted them to cautious first, such as workspace delete metadata.
  if (input.permission !== "bash") return { level: "general", reason: "precheck only has bash coverage" }
  return bashEffect(input)
}

async function bashEffect(input: {
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}) {
  const command = typeof input.metadata.command === "string" ? input.metadata.command : undefined
  // [local-smark] R1：cwd 是 git -C membership 判定的基准。bash tool 的审批请求
  // metadata 必带 cwd；缺失时（pattern 直评路径等）向下传 undefined，
  // classifyGit 按 fail-closed 保守判 outside。
  const cwd = typeof input.metadata.cwd === "string" ? input.metadata.cwd : undefined
  const patternCommand = input.patterns.join(" && ")
  if (!command) return evaluateShell(patternCommand, 0, cwd, shellDialect(input.metadata.shell))

  // 执行原文承载外层命令与源码，模式键提供额外匹配信息并参与风险取高。
  const raw = await evaluateShell(command, 0, cwd, shellDialect(input.metadata.shell))
  if (!patternCommand.trim() || patternCommand === command) return raw

  // Shell metadata is the raw audit/reviewer evidence, while permission patterns
  // are canonical rule keys that may omit POSIX leading environment assignments.
  // Auto precheck must consider both views and keep the higher risk so raw
  // forbidden/dangerous payloads cannot be weakened, and env assignments cannot
  // downgrade a canonical `git push --force` pattern from cautious to general.
  return maxRisk(raw, await evaluateShell(patternCommand, 0, cwd, shellDialect(input.metadata.shell)))
}

// inline_scripts 随 Python 命令改写移除，两道门禁改为直接分析实际执行的 command。
function maxRisk(left: Decision, right: Decision) {
  return LEVELS.indexOf(right.level) > LEVELS.indexOf(left.level) ? right : left
}

// 方言来自工具的shell证据；缺省保持原POSIX入口，包装器载荷显式传入自身方言。
function shellDialect(shell: unknown): ShellParse.Dialect {
  const name = typeof shell === "string" ? normalizeCommandName(shell) : ""
  return name === "cmd" ? "cmd" : ["powershell", "pwsh"].includes(name) ? "powershell" : "bash"
}

// 按当前工具的选项元数取得flags、values与路径；结束符后的文本全是操作数。
function bind(args: string[], valued: readonly string[], insensitive = false) {
  const flags: string[] = []
  const values = new Map<string, string[]>()
  const operands: string[] = []
  for (let index = 0; index < args.length; index++) {
    const text = args[index]
    if (text === "--") { operands.push(...args.slice(index + 1)); break }
    if (!text.startsWith("-") || text === "-") { operands.push(text); continue }
    const equal = text.indexOf("=")
    const raw = equal < 0 ? text : text.slice(0, equal)
    const option = insensitive ? raw.toLowerCase() : raw
    const at = valued.includes(option) ? 0 : !insensitive && !text.startsWith("--")
      ? [...text].findIndex((char, position) => position > 0 && valued.includes(`-${char}`)) : -1
    if (at >= 0) {
      // 短簇遇到取值选项便结束，剩余字符属于值，不能再次解释为风险标志。
      if (at > 1) flags.push(text.slice(0, at))
      const key = at === 0 ? option : `-${text[at]}`
      // 两种写法共用取值记录；等号空值也是显式取值，保持原有的参数消费边界。
      const value = at === 0 ? equal < 0 ? args[++index] : text.slice(equal + 1)
        : text.length > at + 1 ? text.slice(at + 1) : args[++index]
      if (value !== undefined) values.set(key, [...(values.get(key) ?? []), value])
      continue
    }
    flags.push(option)
  }
  return { flags, values, operands }
}

// 只取得Python代码区域的Token；字符串保持整体，f-string只展开插值的语法区域。
function pythonTokens(source: string) {
  // 捕获组分别标注注释与完整字符串，后续API匹配只消费组外的标识符和标点。
  const lexeme = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[A-Za-z_$][\w$]*|\s+|./sy
  const modes = [{ depth: 0, quote: "", group: 0 }]
  const tokens: { text: string; string: boolean }[] = []
  let groups = 0
  for (let index = 0; index < source.length;) {
    const mode = modes[modes.length - 1]
    if (mode.quote) {
      // Python反斜杠不取消花括号插值，双花括号则是实际文字。
      if (source[index] === "\\" && !["{", "}"].includes(source[index + 1])) { index += 2; continue }
      if (source.startsWith(mode.quote, index)) {
        index += mode.quote.length
        modes.pop()
        if (mode.quote === "}") modes.pop()
        continue
      }
      if (["{{", "}}"].includes(source.slice(index, index + 2))) { index += 2; continue }
      if (source[index] === "{") modes.push({ depth: 1, quote: "", group: groups })
      index++
      continue
    }
    const formatted = /^(?:fr|rf|f)("""|'''|"|')/i.exec(source.slice(index))
    if (formatted) { modes.push({ depth: 0, quote: formatted[1], group: groups }); index += formatted[0].length; continue }
    lexeme.lastIndex = index
    const match = lexeme.exec(source)
    if (!match) break
    index = lexeme.lastIndex
    if (match[1] !== undefined || /^\s+$/.test(match[0])) continue
    // 字段顶层冒号之后是格式文字；括号内冒号仍属于Python表达式。
    if (mode.depth === 1 && groups === mode.group && match[0] === ":") { modes.push({ depth: 0, quote: "}", group: groups }); continue }
    if (mode.depth > 0 && match[2] === undefined) {
      if (match[0] === "{") mode.depth++
      if (match[0] === "}" && --mode.depth === 0) { modes.pop(); continue }
    }
    if (["(", "["].includes(match[0])) groups++
    if ([")", "]"].includes(match[0])) groups--
    tokens.push({ text: match[0], string: match[2] !== undefined })
  }
  return tokens
}

// 从已确认的解释器源码中取得原删除API事实；语言各自解析，原路径政策分别消费。
async function sourceRisk(source: string, language: "python" | "javascript"): Promise<Decision> {
  const calls: { owner: string; method: string; target?: string }[] = []
  if (language === "javascript") {
    const { parseSync, types } = await import("@babel/core")
    let tree: ReturnType<typeof parseSync>
    try {
      // 权限检查只生成AST，关闭babelrc和项目配置以避免加载用户插件。
      tree = parseSync(source, { babelrc: false, configFile: false, sourceType: "unambiguous" })
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { level: "general", reason: "interpreter source has invalid syntax" }
    }
    if (tree) types.traverseFast(tree, (node) => {
      if (!types.isCallExpression(node) || !types.isMemberExpression(node.callee) || node.callee.computed) return
      const member = node.callee
      if (!types.isIdentifier(member.property) || !["rmSync", "rmdirSync", "unlinkSync"].includes(member.property.name)) return
      const object = member.object
      const fs = types.isIdentifier(object, { name: "fs" }) || (types.isCallExpression(object) && types.isIdentifier(object.callee, { name: "require" }) && types.isStringLiteral(object.arguments[0], { value: "fs" }))
      // Babel已区分正则文字、模板插值和除法；只消费原成员调用及字符串路径。
      // 用户单独授权unlinkSync变量目标进入cautious；留空target沿用普通删除reason，其他API保持字面范围。
      if (fs && (types.isStringLiteral(node.arguments[0]) ? node.arguments[0].value.length > 0 : member.property.name === "unlinkSync" && types.isIdentifier(node.arguments[0])))
        calls.push({ owner: "fs", method: member.property.name, target: types.isStringLiteral(node.arguments[0]) ? node.arguments[0].value : undefined })
    })
  }
  if (language === "python") {
    const tokens = pythonTokens(source)
    const methods = new Map([["os", ["remove", "unlink", "rmdir"]], ["shutil", ["rmtree"]]])
    // 词法项中的引用外壳独立去除，文件API路径不会进行Shell家目录展开。
    // lexer已保证完整的配对引号；这里只解开该单个Token的单/三引号与已有转义。
    const value = (text: string) => text.replace(/^("""|'''|"|')([\s\S]*)\1$/, "$2").replace(/\\([\\'"])/g, "$1")
    for (let i = 0; i < tokens.length; i++) {
      const owner = tokens[i].text
      const method = tokens[i + 2]?.text
      if (tokens[i + 1]?.text !== "." || tokens[i + 3]?.text !== "(") continue
      // 相邻字符串在Python中属于同一个字面参数，游标止于逗号、闭括号或其他表达式。
      let literalEnd = i + 4
      while (tokens[literalEnd]?.string) literalEnd++
      // 只连接已分词的静态片段；变量名保持空target，继续使用用户指定的普通审查。
      const target = literalEnd > i + 4 ? tokens.slice(i + 4, literalEnd).map((token) => value(token.text)).join("") : undefined
      // os.remove变量目标是用户指定的另一项cautious例外；仅记录调用，变量值交实际解释器处理。
      if (methods.get(owner)?.includes(method) && tokens[i + 4] && [",", ")"].includes(tokens[Math.max(literalEnd, i + 5)]?.text) && (target !== undefined ? target.length > 0 : owner === "os" && method === "remove" && /^[A-Za-z_]\w*$/.test(tokens[i + 4].text)))
        calls.push({ owner, method, target })
      if (owner !== "subprocess" || !["run", "call", "Popen"].includes(method) || tokens[i + 4]?.text !== "[") continue
      const end = tokens.findIndex((token, at) => at > i + 4 && token.text === "]")
      const args = tokens.slice(i + 5, end).filter((token) => token.text !== ",")
      if (end < 0 || !args[0]?.string || value(args[0].text) !== "rm") continue
      const stop = args.findIndex((token) => token.string && value(token.text) === "--")
      if (!(stop < 0 ? args.slice(1) : args.slice(1, stop)).some((token) => token.string && /^-[^-]*[rf]/.test(value(token.text)))) continue
      // 原subprocess规则以r/f为条件；--后的同名参数始终是文件操作数。
      const targets = args.slice(1).filter((token, at) => token.string && value(token.text) !== "--" && ((stop >= 0 && at + 1 > stop) || !value(token.text).startsWith("-")))
      if (!targets.length) calls.push({ owner, method })
      for (const target of targets) calls.push({ owner, method, target: value(target.text) })
    }
  }
  return calls.reduce<Decision>((result, call) => {
    // 解释器沿用独立的原保护范围，不与Shell的Windows/别名规则扩大合并。
    const level = call.target === undefined ? "cautious" : new RegExp(`^(?:${INTERPRETER_FORBIDDEN_PATH})`).test(call.target + '"') ? "forbidden"
      : new RegExp(`^(?:${INTERPRETER_DANGEROUS_PATH})`).test(call.target + '"') ? "dangerous" : "cautious"
    const reason = call.owner === "subprocess" ? "recursive delete of filesystem root, home, or top-level system directory through interpreter — forbidden (cannot be authorized)"
      : call.owner === "shutil" ? "recursive delete of filesystem root, home, or top-level system directory via Python — forbidden (cannot be authorized)"
      : `file removal targeting filesystem root, home, or top-level system directory via ${call.owner === "fs" ? "Node.js" : "Python"} — forbidden (cannot be authorized)`
    // 沿源码顺序归并原等级；同级保持先前reason，变量目标始终停留在普通删除审查。
    return maxRisk(result, { level, reason: level === "forbidden" ? reason : level === "dangerous" ? DANGEROUS_INTERPRETER_DELETE
      : call.owner === "fs" || call.owner === "subprocess" ? "interpreter file deletion requires explicit approval" : "Python file deletion requires explicit approval" })
  }, { level: "general", reason: "interpreter eval command requires explicit approval" })
}

async function externalDirectoryEffect(input: {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
}): Promise<Decision | undefined> {
  if (input.permission !== "external_directory") return

  if (input.metadata.action_kind === "shell") {
    // 两道门禁共享原command、方言与cwd；外部目录的cautious下限不覆盖更高源码风险。
    const shell = await evaluateShell(
      typeof input.metadata.command === "string" ? input.metadata.command : input.patterns.join(" && "),
      0,
      typeof input.metadata.cwd === "string" ? input.metadata.cwd : undefined,
      shellDialect(input.metadata.shell),
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

// 将一段Shell文本归并为原level/reason：先取得语法角色，再分别检查命令、目标和管道。
// depth仅限制显式载荷的递归，cwd供原Git目录边界使用，dialect决定引用与转义语义。
async function evaluateShell(command: string, depth: number, cwd?: string, dialect: ShellParse.Dialect = "bash"): Promise<Decision> {
  // 递归仅跟踪提取为纯文本的包装器载荷。深度上限防止恶意或格式错误的嵌套
  // 包装器消耗时间，同时保留失败安全行为：general/用户审批而非 safe。
  if (depth > 4) return { level: "general", reason: "nested shell wrapper requires explicit approval" }
  if (!command.trim()) return { level: "general", reason: "empty shell command requires explicit approval" }

  // 先取得语法角色再应用原规则：输入/输出路径与argv分别归属，引用数据保持整体。
  // 语法不完整只维持原general下限，已取得的相邻风险命令继续参与最高等级聚合。
  const analysis = await ShellParse.analyze(command, dialect)
  const decisions: Decision[] = []
  const fifos = new Set<number>()
  if (analysis.incomplete || analysis.environment || analysis.opaque)
    decisions.push({ level: "general", reason: "opaque shell segment requires explicit approval" })
  for (const item of analysis.commands) {
    const words = item.words.slice(directStart(item.words.map((word) => word.value)))
    const producer = normalizeCommandName(words[0]?.value ?? "")
    // 保留原mkfifo后接sh/bash的组合政策；同组执行节点才关联，参数中的Shell名字保持数据。
    if (producer === "mkfifo") fifos.add(item.group)
    if (fifos.has(item.group) && ["sh", "bash"].includes(producer)) decisions.push({ level: "forbidden", reason: "reverse shell pattern" })
    const decision = await evaluateCommand(item, depth, cwd, dialect)
    decisions.push(decision.level === "safe" && item.words.some((word) => word.dynamic) ? { level: "general", reason: "opaque shell segment requires explicit approval" } : decision)
    for (const redirect of item.redirects) {
      const target = redirect.target?.value
      if (!target) continue
      if (target.startsWith("/dev/tcp/")) decisions.push({ level: "forbidden", reason: "reverse shell pattern" })
      if (target === "/dev/null" || !redirect.operator.includes(">") || (/>&$/.test(redirect.operator) && /^(?:\d+|-)$/.test(target))) continue
      // 普通文件输出保持general；原sudoers、启动文件等专项政策只检查真实写入目标。
      decisions.push({ level: "general", reason: "opaque shell segment requires explicit approval" })
      if (target.startsWith("/etc/sudoers")) decisions.push({ level: "dangerous", reason: "sudoers modification grants privilege escalation" })
      for (const [pattern, reason] of redirectRules) {
        if (pattern.test(target.replaceAll("\\", "/"))) decisions.push({ level: "cautious", reason })
      }
    }
    const next = item.pipeTo === undefined ? undefined : analysis.commands[item.pipeTo]
    if (!next) continue
    const nextTokens = next.words.map((word) => word.value)
    const consumer = normalizeCommandName(nextTokens[directStart(nextTokens)] ?? "")
    // 下载到解释器沿用原curl/wget消费者集合；这里检查AST管道边而非参数里的竖线。
    if (["curl", "wget"].includes(producer) && ["sh", "bash", "zsh", "python", "node", "ruby", "perl", "pwsh", "powershell", "cmd", "iex", "invoke-expression"].includes(consumer))
      decisions.push({ level: "dangerous", reason: "remote download piped to interpreter; review the script locally before running safe commands" })
    // PowerShell下载与执行组合有独立的原规则和reason，保留其命令别名集合。
    if (["iwr", "irm", "invoke-webrequest", "invoke-restmethod"].includes(producer) && ["iex", "invoke-expression"].includes(consumer))
      decisions.push({ level: "dangerous", reason: "remote PowerShell download executed as code; review the script locally before running safe commands" })
    // 原解码管道政策按工具族匹配；此迁移保留该集合，不增加编码/解码模式分级。
    if (["base64", "openssl", "xxd", "gunzip", "bunzip2", "unxz", "zcat"].includes(producer) && ["sh", "bash", "zsh", "dash", "fish", "ksh", "python", "python3", "node", "ruby", "perl", "pwsh", "powershell"].includes(consumer))
      decisions.push({ level: "dangerous", reason: "decoded/decompressed payload piped to interpreter" })
    // 敏感读取到HTTP的左右命令族来自原政策；路径敏感性仍由读取参数规则决定。
    if (["cat", "type", "get-content", "gc", "rg", "grep", "head", "tail", "sed", "awk"].includes(producer) && readsSensitivePath(words.map((word) => word.value), true) && ["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(consumer))
      decisions.push({ level: "dangerous", reason: "credential read piped to network transfer" })
    // 可见文字送入解释器保留原cautious规则；后续再核对文字中已有的具体风险操作。
    if (["echo", "printf"].includes(producer) && ["sh", "bash", "zsh", "dash", "fish", "ksh", "python", "python3", "node", "ruby", "perl", "pwsh", "powershell"].includes(consumer))
      decisions.push({ level: "cautious", reason: "visible payload piped to interpreter requires review" })
    // 这里只取得当前命令中已可见的字面载荷，不执行程序、不读取cat指向的外部文件。
    const output = producer === "echo" ? words.slice(1).map((word) => word.value).join(" ")
      : producer === "printf" ? printfOutput(words)
      : producer === "cat" ? item.redirects.findLast((redirect) => redirect.content !== undefined)?.content : undefined
    // 同一文字只有被已有解释器作为stdin消费时才作为源码，单纯输出保持数据。
    if (output !== undefined && !item.words.some((word) => word.dynamic) && consumesInput(nextTokens.slice(directStart(nextTokens)))) {
      if (["python", "python3", "py", "node"].includes(consumer)) decisions.push(await sourceRisk(output, consumer === "node" ? "javascript" : "python"))
      if (SHELL_WRAPPERS.has(consumer)) decisions.push(await evaluateShell(output, depth + 1, cwd, "bash"))
    }
  }
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

// 分类一条已分离重定向的命令；包装器传递原参数，解释器只分析明确的源码入口。
// 值数组供旧规则消费，平行stripped数组保留同一参数的Git路径转义证据。
async function evaluateCommand(command: ShellParse.Command, depth: number, cwd?: string, dialect: ShellParse.Dialect = "bash"): Promise<Decision> {
  const tokens = command.words.map((word) => word.value)
  const stripped = command.words.map((word) => word.stripped)
  if (!tokens[0]) return { level: "general", reason: "empty shell command requires explicit approval" }
  const name = normalizeCommandName(tokens[0])
  const start = directStart(tokens)
  if (start > 0) {
    const inner = await evaluateCommand({ ...command, words: command.words.slice(start) }, depth, cwd, dialect)
    // 包装器不升级safe，其实际载荷的已有风险完整保留。
    return inner.level === "safe" ? { level: "general", reason: "privilege wrapper requires explicit approval" } : inner
  }
  // PowerShell 的版本后缀和 conda 参数在此定位 Python 源码，随后沿用 sourceRisk。
  const content = command.redirects.findLast((redirect) => redirect.content !== undefined)?.content
    ?? (command.stdin?.dynamic ? undefined : command.stdin?.value)
  const python = dialect === "powershell" ? pythonSource(command.words, content) : undefined
  if (python !== undefined) return sourceRisk(python, "python")
  const evalFlags = INTERPRETER_FLAGS.get(name) ?? (SHELL_WRAPPERS.has(name) ? new Set(["-c", "-lc"]) : POWERSHELL_WRAPPERS.has(name) ? new Set(["-command", "-c", "-encodedcommand", "-enc"]) : undefined)
  let evalIndex = -1
  for (let index = 1; evalFlags && index < tokens.length; index++) {
    const option = POWERSHELL_WRAPPERS.has(name) ? tokens[index].toLowerCase() : tokens[index]
    // 首个脚本文件或模块入口结束解释器选项；后续-c/-e是脚本自己的参数。
    if (["--", "-"].includes(option) || (option === "-m" && !SHELL_WRAPPERS.has(name)) || (POWERSHELL_WRAPPERS.has(name) && option === "-file") || !option.startsWith("-")) break
    if (option !== "-3" && evalFlags.has(option)) { evalIndex = index; break }
    // Shell的-o/-O配置与解释器的告警、运行时配置、预载模块各消费自己的值。
    // 这些值即使拼作-c/-e，也属于选项参数，而非新的源码入口。
    // PowerShell的策略、格式和启动目录也是取值选项，大小写归一化只作用于该方言。
    if ((POWERSHELL_WRAPPERS.has(name) ? ["-executionpolicy", "-inputformat", "-outputformat", "-workingdirectory", "-windowstyle", "-configurationname", "-configurationfile"] : SHELL_WRAPPERS.has(name) ? ["-o", "-O"] : ["-W", "-X", "-r", "--require", "--import", "--loader", "--preload"]).includes(option)) index++
  }
  if (evalIndex > 0 && tokens[evalIndex + 1] && ["python", "python3", "py", "node"].includes(name))
    return sourceRisk(tokens[evalIndex + 1], name === "node" ? "javascript" : "python")
  // Shell直接消费stdin时走既有Shell主路径；显式脚本文件继续把stdin作为数据。
  if (content !== undefined && (["python", "python3", "py", "node"].includes(name) || SHELL_WRAPPERS.has(name)) && consumesInput(tokens, command.stdin !== undefined))
    return SHELL_WRAPPERS.has(name) ? evaluateShell(content, depth + 1, cwd, "bash") : sourceRisk(content, name === "node" ? "javascript" : "python")
  if (["curl", "wget"].includes(name)) {
    const upload = bind(tokens.slice(1), CURL_VALUES)
    for (const [flag, values] of upload.values) {
      // 取值表包含很多普通参数；此子集才具有原上传规则中的文件引用语法。
      if (!["-d", "--data", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file"].includes(flag)) continue
      for (const value of values) {
        // 只有文件引用语法提供上传路径，header及普通正文保持原参数用途。
        const at = value.indexOf("@")
        const source = ["-T", "--upload-file"].includes(flag) ? value
          : at === 0 || (["--data-urlencode", "-F", "--form"].includes(flag) && at >= 0) ? value.slice(at + 1) : ""
        if (source && new RegExp(SENSITIVE_PATH_PATTERN, "i").test(source))
          return { level: "dangerous", reason: "credential file sent with network transfer" }
      }
    }
    return { level: "general", reason: "unknown shell command" }
  }

  if (["scp", "rsync", "sftp"].includes(name)) {
    // scp/sftp的身份、跳板和端口消费取值；rsync使用-e/--rsh指定远端shell。
    // 同名-P在rsync中是布尔选项，后面的本地文件仍需保留为传输操作数。
    if (credentialOutboundTransfer(bind(tokens.slice(1), name === "rsync" ? ["-e", "--rsh"] : ["-i", "-o", "-J", "-P"]).operands))
      return { level: "dangerous", reason: "credential file sent with remote transfer" }
  }
  // 原Windows格式化规则由命令名与盘符参数共同触发，普通数据中的format保持数据。
  if (name === "format" && /^[a-z]:/i.test(tokens[1] ?? "")) return { level: "forbidden", reason: "Windows drive format" }
  // nc执行选项与代理/地址参数先各自取值，代理header中的--exec文字不会成为开关。
  if (["nc", "ncat", "netcat"].includes(name) && [...bind(tokens.slice(1), ["-e", "--exec", "--sh-exec", "--proxy-header", "--proxy", "--proxy-auth", "-s", "-p", "-w"]).values.keys()].some((flag) => ["-e", "--exec", "--sh-exec"].includes(flag)))
    return { level: "forbidden", reason: "reverse shell pattern" }
  // socat的EXEC位于地址类型前缀；日志文件与缓冲参数先消费，避免误作执行地址。
  if (name === "socat" && bind(tokens.slice(1), ["-f", "-r", "-R", "-b", "-t", "-T", "-lp", "-lf"]).operands.some((path) => /^EXEC:/i.test(path)))
    return { level: "forbidden", reason: "reverse shell pattern" }
  if (name === "new-object") {
    // TypeName决定构造类型；ArgumentList、ComObject与Property保持独立取值角色。
    const bound = bind(tokens.slice(1), ["-typename", "-argumentlist", "-comobject", "-property"], true)
    if ((bound.values.get("-typename")?.[0] ?? bound.operands[0] ?? "").split("(", 1)[0].toLowerCase() === "system.net.sockets.tcpclient")
      return { level: "forbidden", reason: "reverse shell pattern" }
  }
  // tee只迁移原sudoers专项写入政策，普通输出文件继续沿用原分类。
  if (name === "tee" && tokens.slice(1).some((path) => path.startsWith("/etc/sudoers")))
    return { level: "dangerous", reason: "sudoers modification grants privilege escalation" }

  // 包装器展开：提取内层脚本递归检查
  const unwrapped = unwrap(tokens, evalIndex)
  if (unwrapped.action === "script") {
    // 外层方言只解释包装器argv；载荷交给显式选择的Shell语言，保留其命令替换语义。
    const decision = await evaluateShell(unwrapped.script, depth + 1, cwd, POWERSHELL_WRAPPERS.has(name) ? "powershell" : name === "cmd" ? "cmd" : SHELL_WRAPPERS.has(name) ? "bash" : dialect)
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
      const decision = await evaluateShell(remote.script, depth + 1, undefined, "bash")
      // SSH/WSL 跨越本机信任边界：安全的远程只读命令仍是 general；可见的远程
      // 破坏性动作保留 cautious/dangerous/forbidden。
      if (decision.level === "dangerous" || decision.level === "cautious" || decision.level === "forbidden") return decision
    }
    return { level: "general", reason: remote.reason }
  }

  // token 层启发式分类：按威胁类别逐项检查
  const risk = classifyTokens(tokens, cwd, stripped)
  if (risk) return risk
  // 已知输出和搜索命令的数据参数不是包装器入口，修正旧echo kill穿透误报。
  if (["echo", "printf"].includes(name)) return { level: "general", reason: "unknown shell command" }
  if (safeTokens(tokens, cwd, stripped)) return { level: "safe", reason: "known read-only shell command" }

  // 未知前缀穿透沿用原一次候选合同：rtk/task等前缀后可以有已知变更命令。
  // 已知输出/搜索的数据角色在此前确定；这里不把它们的参数再次当成执行名。
  // 候选使用tokens.slice(1)保留原参数边界，按既有规则只传播cautious。
  // 原文本规则曾另外覆盖前缀后的保护目录删除，迁移后保留该已有删除族等级。
  // 其他仅由Token层定义的高风险族继续维持原未知前缀边界，包括mkfs、dd和setcap，
  // 从而将词法修正与新增候选权限范围保持分离。
  // 注意：POSIX 形如 `KEY=value cmd` 的环境变量赋值前缀不在此启发式范围——
  // bashEffect 的 patterns 通常不含前置 env，故 pattern 路径直接命中 classifyGit；
  // 原文路径的环境事实保持general下限，maxRisk仍取pattern的cautious及其reason，
  // 避免剥头路径产生不同 reason 改写既有断言（如 L704 force push reason）。
  if (tokens.length > 1 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const strippedPrefix = classifyTokens(tokens.slice(1), cwd, stripped.slice(1))
    // 原raw层已覆盖前缀后的保护目录删除；只为同一已有删除族保留其确定等级。
    if (strippedPrefix && FILE_DELETE_COMMANDS.has(normalizeCommandName(tokens[1])) && ["forbidden", "dangerous"].includes(strippedPrefix.level)) return strippedPrefix
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

// 解释可见字符串占位格式；返回实际文字，其他格式继续由原printf管道审查处理。
function printfOutput(words: ShellParse.Word[]) {
  const start = words[1]?.value === "--" ? 2 : 1
  // 格式本身的转义先解码，%s插入的参数保持字面内容，避免二次解码改变其意义。
  const format = (words[start]?.value ?? "").replace(/\\([nrt\\])/g, (_, char: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[char] ?? char)
  const slots = format.match(/%%|%./g) ?? []
  if (slots.some((slot) => !["%%", "%s", "%b"].includes(slot))) return
  let index = start + 1
  // printf用剩余参数重复格式，%%消耗零个参数；零占位格式仅输出一次。
  // %b对其参数解释转义，%s保持字面；两者同样消费一个参数并参与格式重复。
  return Array.from({ length: Math.max(1, Math.ceil((words.length - index) / (slots.filter((slot) => slot !== "%%").length || Infinity))) }, () =>
    format.replace(/%%|%[sb]/g, (slot) => slot === "%%" ? "%" : slot === "%s" ? (words[index++]?.value ?? "") : (words[index++]?.value ?? "").replace(/\\([nrt\\])/g, (_, char: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[char] ?? char))).join("")
}

// Python 源码的位置由解释器名称、环境选项和 -c/stdin 入口共同确定。
function pythonSource(words: ShellParse.Word[], input?: string) {
  let index = 0
  if (/^conda(?:\.exe)?$/i.test(words[0]?.value ?? "")) {
    if (words[1]?.value.toLowerCase() !== "run") return
    index = 2
    for (; index < words.length; index++) {
      const option = words[index]
      if (option.dynamic) return
      if (!option.value.startsWith("-")) break
      // 选项集合来自旧INLINE_PYTHON_CONDA常量，未知模式不增加源码识别。
      if (["--dev", "--debug-wrapper-scripts", "--no-capture-output", "--live-stream"].includes(option.value) || /^-v{1,3}$/.test(option.value)) continue
      if (/^--(?:name|prefix|cwd)=[^\s"'`$@;&|<>(){}]+$/.test(option.value)) continue
      if (!["-n", "--name", "-p", "--prefix", "--cwd"].includes(option.value)) return
      const value = words[++index]
      if (!value || value.dynamic || !value.value || /^-/.test(value.value) || /[`$@;&|<>(){}]/.test(value.value)) return
    }
  }
  const executable = words[index]
  if (!executable || executable.dynamic) return
  const name = normalizeCommandName(executable.value)
  if (!/^(?:python(?:3(?:\.\d+)?)?|py)$/.test(name)) return
  // 普通解释器保留原入口算法；这里只补conda与版本后缀，避免影响其它命令政策。
  if (index === 0 && !/^python3\.\d+$/.test(name)) return
  if (index === 0 && /[/\\]/.test(executable.value) && !/^(?:[a-z]:[/\\]|\\\\)/i.test(executable.value)) return
  if (index > 0 && /[/\\]/.test(executable.value)) return
  let version = name === "py"
  for (index++; index < words.length; index++) {
    const flag = words[index]
    if (flag.dynamic) return
    // -c 的可见源码交给 sourceRisk；源码中的变量表达式由现有源码规则处理。
    if (flag.value === "-c") return words[index + 1]?.value
    if (flag.value === "-") return input
    if (version && /^(?:-3(?:\.\d+)?(?:-32|-64)?|-32|-64)$/.test(flag.value)) continue
    version = false
    // 旧Python布尔/取值flags决定入口位置；文件、模块、未知参数均不消费可见stdin源码。
    if (["-B", "-E", "-I", "-O", "-OO", "-P", "-b", "-bb", "-d", "-q", "-s", "-S", "-u", "-v", "-x"].includes(flag.value)) continue
    if (/^-[WX][^\s"'`$@;&|<>(){}]+$/.test(flag.value)) continue
    if (!["-W", "-X"].includes(flag.value)) return
    const value = words[++index]
    if (!value || value.dynamic || !/^[^-\s"'`$@;&|<>(){}][^\s"'`$@;&|<>(){}]*$/.test(value.value)) return
  }
  return input
}

// 只有stdin入口消费字面输入；eval、模块和脚本文件参数分别指定其他源码来源。
function consumesInput(tokens: string[], literal = false) {
  // 已有管道和重定向继续使用原参数判定；新提取的字面输入按首个源码入口绑定 argv。
  if (!literal) {
    const bound = bind(tokens.slice(1), ["-c", "-e", "-m", "-command", "-file", "-encodedcommand", "-W", "-X", "-r", "--require", "--import", "--loader", "--preload"])
    return !["-c", "-e", "-m", "-command", "-file", "-encodedcommand"].some((flag) => bound.values.has(flag)) && bound.operands.every((path) => path === "-")
  }
  for (let index = 1; index < tokens.length; index++) {
    const option = tokens[index]
    // 横线选定 stdin 源码后，后续参数属于脚本自身的 argv。
    if (option === "-") return true
    if (option === "--") return tokens[index + 1] === undefined || tokens[index + 1] === "-"
    if (!option.startsWith("-")) return false
    // 完整取值表先绑定短簇，-Werror的e与-rmodule的m都属于前一个选项的值。
    const bound = bind([option, tokens[index + 1] ?? ""], ["-c", "-e", "-m", "-command", "-file", "-encodedcommand", "-W", "-X", "-r", "--require", "--import", "--loader", "--preload"])
    if (["-c", "-e", "-m", "-command", "-file", "-encodedcommand"].some((flag) => bound.values.has(flag))) return false
    // 与既有eval入口相同的元数；告警和预载模块的值不会成为新的入口选项。
    if (["-W", "-X", "-r", "--require", "--import", "--loader", "--preload"].includes(option)) index++
  }
  return true
}

// 返回已知包装器链后第一个可执行名的索引；调用者据此切片，原Token数组保持不变。
// 只消费包装器自己的选项和取值，未知前缀交回evaluateCommand的原候选规则。
function directStart(tokens: string[]) {
  let index = 0
  // 这些程序将剩余argv交给子进程；循环用于sudo env KEY=value command这样的嵌套。
  while (["sudo", "doas", "pkexec", "env", "nohup", "setsid"].includes(normalizeCommandName(tokens[index] ?? ""))) {
    const name = normalizeCommandName(tokens[index++])
    // env的赋值与选项由既有Token helper处理；以长度差保留原Word数组的切片位置。
    if (name === "env") { index = tokens.length - pierceEnvTokens(tokens.slice(index)).length; continue }
    // sudo的身份、目录、提示和安全上下文参数各占一个值；doas/pkexec采用各自元数，env由专用helper消费。
    // 这里只决定跳过几个Token，例如-u root的root属于选项值，并非要运行的程序。
    const valued = name === "sudo" ? ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-T", "-D", "-R", "-r", "-t"]
      : name === "doas" ? ["-u", "-C"] : name === "pkexec" ? ["--user"] : []
    for (; index < tokens.length && tokens[index].startsWith("-"); index++) {
      // --结束当前包装器选项，后续内容回到外层循环识别可执行名。
      if (tokens[index] === "--") { index++; break }
      if (valued.includes(tokens[index])) index++
    }
  }
  return index
}

// 远端操作数近似（W4）：`user@host:path`、`[ipv6]:path`、≥3 字符裸/点分主机名
// `host:path`（含 example.com 形态）；单字母盘符 `F:\x` 不匹配（避免 Windows 本地路径误判为远端）。
const RE_REMOTE_OPERAND = /^(?:[^\s"@]+@[^\s:"]+:|\[[0-9a-fA-F:]+\]:|[A-Za-z][A-Za-z0-9.-]{2,}:)/

// 接收已绑定的传输操作数；首个远端之前的敏感本地源沿用原出向政策。
// 连接身份参数已由调用方消费，远端输入与公钥继续使用原传输分级。
function credentialOutboundTransfer(tokens: string[]): boolean {
  let firstRemote = -1
  for (let i = 0; i < tokens.length; i++) {
    if (RE_REMOTE_OPERAND.test(tokens[i])) {
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
  const sensitive = new RegExp(SENSITIVE_PATH_PATTERN, "i")
  return tokens
    .slice(0, firstRemote)
    .some((token) => {
      // .pub 公钥非秘密（R2 B-03 双机制：覆盖 .ssh 路径/Windows 家目录/裸名三分支）
      if (/\.pub$/i.test(token)) return false
      return sensitive.test(token)
    })
}

// ============================================================
// 第十三部分：包装器处理
// ============================================================

function unwrap(tokens: string[], evalIndex: number): UnwrapResult {
  // 包装器处理按从最类似 shell 到解释器的顺序排列。暴露纯脚本的包装器
  // 返回该脚本用于递归拒绝扫描；包装器本身仍需提示，因为未来参数可以
  // 执行任意代码。
  const cmd = normalizeCommandName(tokens[0])
  if (SHELL_WRAPPERS.has(cmd)) {
    // 入口索引已按选项元数与脚本边界绑定，避免再扫描脚本自己的参数。
    const index = evalIndex
    if (index >= 0 && tokens[index + 1]) {
      return { action: "script", script: tokens[index + 1], reason: "shell wrapper requires explicit approval" }
    }
    return { action: "ask", reason: "shell wrapper without a plain script requires explicit approval" }
  }

  if (POWERSHELL_WRAPPERS.has(cmd)) {
    // 已绑定的入口决定源码形式；-File之后的参数保持脚本数据，编码载荷使用UTF-16LE base64。
    const encoded = ["-encodedcommand", "-enc"].includes(tokens[evalIndex]?.toLowerCase() ?? "") ? evalIndex : -1
    if (encoded >= 0 && tokens[encoded + 1]) {
      const script = decodePowerShell(tokens[encoded + 1])
      if (script) return { action: "script", script, reason: "PowerShell encoded command requires explicit approval" }
      return { action: "ask", reason: "PowerShell encoded command requires explicit approval" }
    }
    const index = ["-command", "-c"].includes(tokens[evalIndex]?.toLowerCase() ?? "") ? evalIndex : -1
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
  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    // 特权包装器：提取内层命令递归评估，而非短路为 general。
    // sudo rm file 应至少 cautious，sudo rm -rf / 应 dangerous。
    if (tokens.length > 1)
      return { action: "script", script: joinShellTokens(tokens.slice(1)), reason: "privilege wrapper requires explicit approval" }
    return { action: "ask", reason: "privilege wrapper requires explicit approval" }
  }
  return { action: "none" }
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
    const tier = highestProtectedDeleteTier(bind(tokens.slice(1), []).operands)
    if (tier === "forbidden") return { level: "forbidden", reason: FORBIDDEN_ROOT_DELETE }
    if (tier === "dangerous") return { level: "dangerous", reason: DANGEROUS_SUBTREE_DELETE }
    return { level: "cautious", reason: "recursive delete requires explicit approval" }
  }
  if ((cmd === "remove-item" || cmd === "ri") && tokens.some((item) => item.toLowerCase() === "-recurse")) {
    // Path/LiteralPath才是删除目标；过滤条件和错误处理参数的值保持数据角色。
    const bound = bind(tokens.slice(1), ["-path", "-literalpath", "-exclude", "-include", "-filter", "-erroraction"], true)
    const tier = highestProtectedDeleteTier([...bound.operands, ...(bound.values.get("-path") ?? []), ...(bound.values.get("-literalpath") ?? [])])
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
    // mode来自首个操作数或reference文件，后续名为u+s/777的文件仍只是目标。
    const bound = bind(tokens.slice(1), ["--reference"])
    const mode = bound.values.has("--reference") ? "" : (bound.operands[0] ?? "")
    // setuid/setgid 位创建特权升级面，必须 dangerous
    if (/[ug]\+s/.test(mode))
      return { level: "dangerous", reason: "setuid/setgid bit creates privilege escalation surface" }
    // 777 或递归权限变更需要审查
    if (mode === "777" || bound.flags.includes("-R"))
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
    // 操作位置的/query才是查询；/TN后面的同名值仍是任务名称。
    if (tokens[1]?.toLowerCase() === "/query") return undefined
    return { level: "cautious", reason: "Windows scheduled task operation requires explicit approval" }
  }
  if (cmd === "register-scheduledtask")
    return { level: "cautious", reason: "PowerShell scheduled task registration enables persistent execution" }

  // ---- 注册表操作 ----
  if (cmd === "reg") {
    const sub = tokens[1]?.toLowerCase()
    // 注册表 Run/RunOnce 键写入实现开机自启动持久化后门。
    // 键名固定在操作后的路径位置，/d和/v中的Run文字保留数据角色。
    // 保留旧Token转义后的兼容形式，同时让Windows方言使用真实反斜杠键路径。
    if (sub === "add" && /(?:\\|n)(?:Run|RunOnce)$/i.test(tokens[2] ?? ""))
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
  // 动作的首个值就是执行名，按位置绑定避免同名-name值误占-exec的位置。
  const bound = bind(tokens.slice(1), [...FIND_VALUES, "-exec", "-execdir"])
  return bound.flags.includes("-delete") || ["-exec", "-execdir"].some((flag) => bound.values.get(flag)?.some((name) => normalizeCommandName(name) === "rm"))
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
  if (cmd === "rg" || cmd === "grep" ? readsSensitivePath(tokens) : hasSensitivePath(tokens)) return false
  if (["pwd", "whoami", "id", "uname", "which", "ls", "cat", "head", "wc", "file", "stat", "grep"].includes(cmd))
    return true
  if (cmd === "tail") return !tokens.some((item) => item === "-f" || item === "--follow")
  if (cmd === "rg") return !tokens.some(unsafeRipgrepFlag)
  if (cmd === "find")
    return !bind(tokens.slice(1), FIND_VALUES).flags.some((item) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint"].includes(item))
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

function readsSensitivePath(tokens: string[], outbound = false) {
  // 检查读取/列出命令是否涉及敏感路径。只有已知的读取命令才触发此检查，
  // 避免 `npm run build .env.example` 等无关命令误报。
  const cmd = normalizeCommandName(tokens[0])
  if (cmd === "rg" || cmd === "grep") {
    // 模式值保持数据，-f读取模式文件；显式模式或--files模式让剩余操作数全部是路径。
    const bound = bind(tokens.slice(1), ["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count", "--encoding", "--pre", "--hostname-bin"])
    const files = [...(bound.values.get("-f") ?? []), ...(bound.values.get("--file") ?? [])]
    // 仅在本函数中构造文件参数视图，调用方argv保持原样；本地与外传共用同一角色绑定。
    tokens = [cmd, ...files, ...bound.operands.slice(files.length || bound.values.has("-e") || bound.values.has("--regexp") || bound.flags.includes("--files") ? 0 : 1)]
  }
  if (
    ![
      "cat", "type", "get-content", "gc", "get-childitem", "gci",
      "ls", "dir", "grep", "rg", "head", "tail", "less", "more", "sed", "awk",
    ].includes(cmd)
  ) {
    return false
  }
  // 外传采用原完整路径集合；单独读取继续保留.pem/.key需要安全上下文的既有例外。
  return outbound ? tokens.slice(1).some((path) => new RegExp(SENSITIVE_PATH_PATTERN, "i").test(path)) : hasSensitivePath(tokens)
}

function hasSensitivePath(tokens: string[]) {
  // 与SENSITIVE_PATH_PATTERN分别承载原本地读取及外传路径合同；外传匹配已绑定来源，
  // 本地读取匹配已绑定文件，保留原.pem/.key上下文差异。
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
  return bind(tokens, []).flags.some((item) => item === "--recursive" || /^-[^-]*[rR]/.test(item))
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

function windowsRecursiveDeleteTier(tokens: string[]): "forbidden" | "dangerous" | undefined {
  // 三元组同时成立才定级：命令名 + 递归开关 + 保护目录（与 rm 语义对称）
  if (tokens.length < 2) return undefined
  const cmd = normalizeCommandName(tokens[0])
  if (cmd !== "del" && cmd !== "erase" && cmd !== "rd" && cmd !== "rmdir") return undefined
  const rest = tokens.slice(1)
  if (!hasWindowsRecursiveDeleteFlag(rest)) return undefined
  return highestProtectedDeleteTier(rest)
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
  // directStart直接消费此结果，env rm/git等载荷继续进入原风险规则，取代原重建脚本文本的分支。
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    // --之后属于子进程argv，形如KEY=value的内容也保留其实际命令位置。
    if (item === "--") return args.slice(i + 1)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) continue
    const lower = item.toLowerCase()
    if (item.startsWith("-") && !["-u", "--unset"].includes(lower)) continue
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
  // 重建显式包装器传递的argv载荷用于同一grammar递归解释，保留每个参数的边界。
  // 引号保护空格与连接符，使参数数据不会在再次解析时变成额外执行语句。
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

export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "url"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { lazy } from "./util/lazy"
import { which } from "./util/which"
// 共享纯文本沿既有 txt loader 内嵌；Core 不从 Opencode 的工具模板反向加载运行时。
import GIT_SAFETY from "./git-safety.txt"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

// 只返回子进程覆盖项，不修改 process.env，也不改变非 Windows 环境。
export const utf8Environment = (platform: string = process.platform) => {
  if (platform !== "win32") return {}
  return {
    // Python 管道编码与 UTF-8 模式分别控制输出编码和解释器默认编码。
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    // 不注入 Java/Ruby 参数；用户原值由宿主继承，V1 插件 extras 仍最后覆盖。
  }
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash() || which(shell) || shell
  return which(shell) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string) {
  const shell = full(file)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return which(shell) ?? undefined
}

function win() {
  return Array.from(
    new Set(
      [which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"]
        .filter((item): item is string => Boolean(item))
        .map(full),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || ok(file))) {
    const shell = resolve(file)
    if (shell) return shell
  }
  if (process.platform === "win32") return win()[0]
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string): Item {
  const item = full(file)
  const n = name(item)
  return {
    path: item,
    name: resolve(n) ? n : item,
    acceptable: ok(item),
  }
}

export function cmd(file: string, command: string, platform: string = process.platform) {
  if (platform !== "win32" || !ps(file)) {
    // 显式shell argv避开Bun/macOS shell+detached丢stdout；cmd保留AutoRun与引号控制。
    // cmd /s会剥去最外层引号；包装整个脚本才能保留可执行路径与参数原有引号。
    return { command: file, args: name(file) === "cmd" ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], shell: false }
  }
  // Windows PowerShell仍走既有UTF-16传输及UTF-8输出，不重复解释脚本文本。
  // UTF-16LE base64 只传输脚本文本；Console 与管道生产端使用无 BOM 的 UTF-8。
  const script = [
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$ProgressPreference = 'SilentlyContinue'",
    "$InformationPreference = 'Continue'",
    "$WarningPreference = 'Continue'",
    // #221：默认静默模块加载噪声；用户可在命令中显式开启verbose/debug，信息和警告流保持。
    "$VerbosePreference = 'SilentlyContinue'",
    "$DebugPreference = 'SilentlyContinue'",
    "& {",
    command,
    // stderr 必须保持原生字节，避免 PowerShell 按控制台编码提前解释 CP936。
    "} 3>&1 4>&1 5>&1 6>&1",
    // 换行隔开用户尾注释；仅透传实际 native exit，不把 cmdlet 的空值变成退出码。
    "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }",
  ].join("\n")
  return {
    command: file,
    // 显式文本格式降低 PowerShell 信息流被序列化为 CLIXML 的概率。
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    // 显式 argv 不能再经 shell 包装，否则引号和中文会被第二次解释。
    shell: false,
  }
}

// 只修Windows PowerShell高置信inline Python的native引号，不替换解释器、环境或stdin。

export const INLINE_PYTHON_TAG = "powershell-inline-python-quoting-v1" as const
// EncodedCommand 的 Base64 参数长度上限：Windows 命令行 32,767 字符减去 shell
// path、固定 flags 和 terminating NUL 的余量。历史最大 normalized 长度为 31,024。
const INLINE_PYTHON_MAX_ENCODED = 31_500
// 捕获 executable basename，使 bare 名称、conda 和绝对路径共用 py launcher 判断。
const INLINE_PYTHON_EXECUTABLE = /^(python(?:3(?:\.\d+)?)?|py)(?:\.exe)?(?=$|[ \t])/i
// 路径只接受 `&` 调用的静态绝对值；三种引用形式均保留原解释器且拒绝动态语法。
const INLINE_PYTHON_PATH = /^(?:"(?=(?:[A-Za-z]:[\\/]|\\\\))[^"`$\r\n]*[\\/](python(?:3(?:\.\d+)?)?|py)(?:\.exe)?"|'(?=(?:[A-Za-z]:[\\/]|\\\\))[^'`$\r\n]*[\\/](python(?:3(?:\.\d+)?)?|py)(?:\.exe)?'|(?=(?:[A-Za-z]:[\\/]|\\\\))[^\s"'`$@;&|<>(){}]*[\\/](python(?:3(?:\.\d+)?)?|py)(?:\.exe)?)(?=$|[ \t])/i
// 允许的 Python 无值 boolean flags（不含 -i 交互模式、--% stop-parsing）
// -b/-bb/-d/-x 不消费后续 token，可沿用现有静态 flag 边界。
const INLINE_PYTHON_BOOL_FLAGS = new Set(["-B", "-E", "-I", "-O", "-OO", "-P", "-b", "-bb", "-d", "-q", "-s", "-S", "-u", "-v", "-x"])
// 允许的 Python 有值 flags（-W value / -X value）
const INLINE_PYTHON_VALUE_FLAGS = new Set(["-W", "-X"])
// py launcher 版本选择器，只允许紧随 executable、位于其他 flags 之前
const INLINE_PYTHON_VERSION_SELECTOR = /^(?:-3(?:\.\d+)?(?:-32|-64)?|-32|-64)$/
// conda run 仅识别不会改变后续 token 边界的显式选项；未知结构原样 fallback。
const INLINE_PYTHON_CONDA_BOOL_FLAGS = new Set(["--dev", "--debug-wrapper-scripts", "--no-capture-output", "--live-stream"])
const INLINE_PYTHON_CONDA_VALUE_FLAGS = new Set(["-n", "--name", "-p", "--prefix", "--cwd"])

type InlinePythonNormalization = {
  command: string
  source: string
  audit: string
}

// conda 与 Python value flags 共用同一静态 token 边界。任何 PowerShell
// operator、动态表达式或引用语法都意味着 prefix 可能包含另一条命令，必须 fallback。
function inlinePythonStaticValue(value: string) {
  return value.length > 0 && !/[\s"'`$@;&|<>(){}]/.test(value)
}

export function normalizePowerShellInlinePython(command: string, shell: string, platform: string = process.platform): InlinePythonNormalization | undefined {
  if (platform !== "win32" || !ps(shell)) return undefined
  let pos = 0
  let callOperator = false
  // 跳过前导空白
  while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
  // 跳过可选的 PowerShell call operator &
  if (command[pos] === "&") {
    callOperator = true
    pos++
    while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
  }

  // 直接 Python 与 `conda run ... python` 共用后续 -c parser。conda 前缀原样
  // 保留，因此 environment name、PATH 和 launcher 选择不会被 harness 猜测或替换。
  let exeMatch = command.slice(pos).match(INLINE_PYTHON_EXECUTABLE)
  if (!exeMatch && callOperator) exeMatch = command.slice(pos).match(INLINE_PYTHON_PATH)
  if (!exeMatch) {
    const conda = command.slice(pos).match(/^conda(?:\.exe)?(?=$|[ \t])/i)
    if (!conda) return undefined
    pos += conda[0].length
    while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
    const run = command.slice(pos).match(/^run(?=$|[ \t])/i)
    if (!run) return undefined
    pos += run[0].length

    while (pos < command.length) {
      while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
      exeMatch = command.slice(pos).match(INLINE_PYTHON_EXECUTABLE)
      if (exeMatch) break

      const option = command.slice(pos).match(/^\S+/)?.[0]
      if (!option) return undefined
      pos += option.length
      if (INLINE_PYTHON_CONDA_BOOL_FLAGS.has(option) || /^-v{1,3}$/.test(option)) continue
      const inlineValue = option.match(/^--(?:name|prefix|cwd)=(.+)$/)?.[1]
      if (inlineValue) {
        // 等号形式与分离形式使用同一静态值边界；动态环境变量、命令替换、
        // 引号或 backtick 均原样 fallback，不能改变 conda environment 选择。
        if (!inlinePythonStaticValue(inlineValue)) return undefined
        continue
      }
      if (!INLINE_PYTHON_CONDA_VALUE_FLAGS.has(option)) return undefined

      // name/prefix/cwd 的值必须是单一 bare token；引号化或动态表达式保持原样。
      while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
      const value = command.slice(pos).match(/^[^-\s][^\s]*/)?.[0]
      if (!value || !inlinePythonStaticValue(value)) return undefined
      pos += value.length
    }
  }
  if (!exeMatch) return undefined
  const exeEnd = pos + exeMatch[0].length
  const isPy = exeMatch.slice(1).some((value) => /^py$/i.test(value))

  pos = exeEnd
  // 解析 flags 直到找到 -c
  let foundC = false
  let sawNonVersionFlag = false
  while (pos < command.length) {
    // 跳过空白
    while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
    if (pos >= command.length) break

    if (command[pos] !== "-") break

    // 读取 flag token（到下一个空白为止）
    const flagStart = pos
    while (pos < command.length && command[pos] !== " " && command[pos] !== "\t") pos++
    const flag = command.slice(flagStart, pos)

    if (flag === "-c") {
      foundC = true
      break
    }

    // py launcher 版本选择器只允许在非版本 flag 之前
    if (isPy && !sawNonVersionFlag && INLINE_PYTHON_VERSION_SELECTOR.test(flag)) continue
    sawNonVersionFlag = true

    // 无值 boolean flags
    if (INLINE_PYTHON_BOOL_FLAGS.has(flag)) continue
    // Python 同时支持 `-W value`/`-X value` 与 attached `-Wvalue`/`-Xvalue`。
    if (/^-(?:W|X).+/.test(flag)) {
      if (!inlinePythonStaticValue(flag.slice(2))) return undefined
      continue
    }
    // 有值 flags：下一个 token 是值
    if (INLINE_PYTHON_VALUE_FLAGS.has(flag)) {
      while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
      if (pos >= command.length || command[pos] === "-") return undefined
      const valueStart = pos
      while (pos < command.length && command[pos] !== " " && command[pos] !== "\t") pos++
      if (!inlinePythonStaticValue(command.slice(valueStart, pos))) return undefined
      continue
    }
    // 未知 flag → 不命中
    return undefined
  }

  if (!foundC) return undefined

  // -c 后必须有空白和一个双引号开头的源码
  while (pos < command.length && (command[pos] === " " || command[pos] === "\t")) pos++
  if (pos >= command.length || command[pos] !== '"') return undefined

  const openingQuote = pos
  // 从左到右找 closing quote。Bash 风格的 \" 属于源码；首个后缀完整匹配的
  // 非转义 quote 才是边界。若更早 quote 后出现 shell operator 或额外 argv，
  // 说明它是实际外层闭引号，必须原样 fallback，不能吸收到 Python source。
  const validSuffix = /^(?:[ \t]*(?:2>&1)?(?:[ \t]*\|[ \t]*(?:Select-Object[ \t]+-(?:First|Last|Skip)[ \t]+\d+|Out-String[ \t]+-Stream))?[ \t]*)?$/
  let closingQuote = -1
  for (let i = openingQuote + 1; i < command.length; i++) {
    if (command[i] !== '"') continue
    let slashes = 0
    for (let j = i - 1; j > openingQuote && command[j] === "\\"; j--) slashes++
    if (slashes % 2 === 1) continue

    const tail = command.slice(i + 1)
    if (validSuffix.test(tail)) {
      closingQuote = i
      break
    }
    if (/^[ \t]*(?:;|&&|\|\||\|)|^[ \t]*[\r\n]|^[ \t]+\S/.test(tail)) return undefined
  }
  if (closingQuote === -1) return undefined

  const source = command.slice(openingQuote + 1, closingQuote)
  const suffix = command.slice(closingQuote + 1)
  const prefix = command.slice(0, openingQuote)

  // 排除空源码、NUL、尾随反斜杠（legacy binder closing-quote 歧义）
  if (!source || source.includes("\0") || source.includes("`") || source.endsWith("\\")) return undefined

  // 保守 quote normalization：只处理双引号前的奇数反斜杠 run
  const normalizedSource = source.replace(/\\+"/g, (value) => {
    const count = value.length - 1
    if (count % 2 === 0) return value
    return "\\".repeat((count - 1) / 2) + '"'
  })

  // Windows native argv 编码：双引号前的反斜杠双写后加保护反斜杠
  const encoded = normalizedSource.replace(/(\\*)"/g, (_, slashes: string) => slashes + slashes + '\\"')
  // PowerShell 单引号 literal：内部单引号写成 ''
  const argument = `'${encoded.replaceAll("'", "''")}'`
  const audit = prefix + argument + suffix
  // 在子作用域中设置 Legacy native argument passing，兼容 PS 5.1 和 PS 7
  const normalizedCommand = `$PSNativeCommandArgumentPassing = 'Legacy'; ${audit}`

  // 使用真实transport连同固定flags计长度，不能复建已经移除的第二编码器。
  if (cmd(shell, normalizedCommand, platform).args.join(" ").length > INLINE_PYTHON_MAX_ENCODED) return undefined

  return { command: normalizedCommand, source: normalizedSource, audit }
}


export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

let defaultPreferred: string | undefined
let defaultAcceptable: string | undefined

export function preferred(configShell?: string) {
  if (configShell) return select(configShell)
  defaultPreferred ??= select(process.env.SHELL)
  return defaultPreferred
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function acceptable(configShell?: string) {
  if (configShell) return select(configShell, { acceptable: true })
  defaultAcceptable ??= select(process.env.SHELL, { acceptable: true })
  return defaultAcceptable
}
acceptable.reset = () => {
  defaultAcceptable = undefined
}

export async function list(): Promise<Item[]> {
  const shells = process.platform === "win32" ? win() : await unix()
  return shells.filter((s) => resolve(s)).map(info)
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

// 两套语法共用一次惰性初始化，V1 与 Core 使用同一缓存。
const parser = lazy(async () => {
  const { Parser, Language } = await import("web-tree-sitter")
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

export async function parse(command: string, ps: boolean) {
  const p = await parser()
  const tree = (ps ? p.ps : p.bash).parse(command)
  if (!tree) throw new Error("Failed to parse command")
  return tree
}

// 只渲染已选择的 shell，调用方继续拥有各自的配置优先级与 fallback。
export function guidance(file: string, platform: NodeJS.Platform) {
  const shell = name(file)
  return [
    `Shell: ${file}`,
    // PowerShell 跨平台仍使用自身语法，不能根据 OS 把它误判为 Bash。
    ...(ps(file) ? [
      "Use PowerShell syntax; read environment variables with $env:NAME, not export NAME=...; use $null, not /dev/null.",
      // stderr已由同一个进程handle采集，保留源提示原话而非另行合并流。
      "Do not append `2>&1` to PowerShell commands; the shell tool already captures stderr.",
      // 5.1 与 7+ 链式能力不同，分号始终是无条件顺序执行。
      shell === "powershell" ? "Windows PowerShell 5.1: do NOT use && or ||. Use A; if ($?) { B } for success-dependent commands." : "PowerShell 7+: && and || are supported; use ; only for unconditional sequencing.",
    ] : shell === "cmd" ? [
      // cmd 的变量与空设备均不同于 PowerShell 和 POSIX。
      "Use cmd.exe syntax, %NAME% for environment variables, NUL instead of /dev/null, and && for success-dependent commands.",
    ] : ["Use this shell's native syntax."]),
    // Git Bash 保留 Unix 工具；严格禁用仅面向 Windows 原生 shell。
    ...(platform === "win32" && ["powershell", "pwsh", "cmd"].includes(shell) ? [
      "Do NOT use Unix text utilities tail/head/sed/awk/grep for file operations. Prefer available dedicated tools.",
      // 仅必要的终端处理给出等价命令，不宣称当前请求拥有未注册工具。
      shell === "cmd" ? "For necessary terminal checks use dir/type/findstr." : "For necessary terminal checks use Test-Path, Get-Content -Tail or Select-String.",
    ] : []),
    // 两条执行路径都按 UTF-8 解码，非 ASCII 程序输出必须使用相同编码。
    "For non-ASCII output, configure the shell/native program to emit UTF-8; captured output is decoded as UTF-8.",
    // BashTool 的 Location source 与 V1 description 都调用此入口，配置 refresh 仍由原 Context Epoch 去重。
    // 输出压缩、cwd 或 shell 身份变化不授予 Git 写权限，这份授权协议不受这些执行选项改写。
    "",
    GIT_SAFETY,
  ].join("\n")
}

// 只识别直接调用和顶层命令链；复杂脚本保留 Core 原有权限路径，不在这里补写 shell 解释器。
export function* commandHeads(command: string, shellName: string) {
  if (!["powershell", "pwsh", "cmd"].includes(shellName)) return
  const powershell = shellName !== "cmd"
  const separators = powershell ? ";|&\r\n" : "|&\r\n"
  const escapes: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", ...(shellName === "pwsh" ? { e: "\x1b" } : {}) }
  let head = true
  let invoked = false
  let depth = 0
  for (let index = 0; index < command.length;) {
    const character = command[index]
    if (powershell && character === "#") {
      while (index < command.length && command[index] !== "\n") index++
      continue
    }
    // cmd 在命令起点的括号是命令组，不应遮掉组内首个实际命令。
    if (!powershell && head && character === "(") { index++; continue }
    // 嵌套表达式和脚本块不属于此浅层检查，避免把标签、数组值或哈希键当命令。
    if ("({".includes(character)) { depth++; head = false; index++; continue }
    if (")}".includes(character)) { depth = Math.max(0, depth - 1); index++; continue }
    if (separators.includes(character)) {
      if (!depth) { invoked = powershell && character === "&" && head; head = true }
      index++
      continue
    }
    if (/\s/.test(character)) { index++; continue }
    const quoted = character === '"' || (powershell && character === "'")
    let quote = ""
    let text = ""
    while (index < command.length) {
      const current = command[index]
      // 引号与转义只用于划分参数，参数中的分隔符不能制造新命令。
      if (current === (powershell ? "`" : "^") && (powershell ? quote !== "'" : !quote)) {
        index++
        text += (powershell ? escapes[command[index] ?? ""] : undefined) ?? command[index] ?? ""
        index++
        continue
      }
      if (quote) {
        if (current === quote) {
          if (powershell && command[index + 1] === quote) { text += current; index += 2; continue }
          quote = ""
        } else text += current
        index++
        continue
      }
      if (current === '"' || (powershell && current === "'")) { quote = current; index++; continue }
      if (/\s/.test(current) || separators.includes(current) || "(){}".includes(current)) break
      text += current
      index++
    }
    if (!head || depth) continue
    // 保留常见显式调用形式，不把 PowerShell 裸字符串当成可执行文件。
    if ((powershell && text === ".") || (!powershell && text.toLowerCase() === "call")) { invoked = true; continue }
    if (text && (!powershell || !quoted || invoked)) yield text
    head = false
    invoked = false
  }
}

// 两条执行路径共用分类；调用方传 AST 或词法命令头，不传任意参数文字。
export function compatibilityError(heads: Iterable<string>, shellName: string) {
  if (process.platform !== "win32" || !["powershell", "pwsh", "cmd"].includes(shellName)) return
  for (const raw of heads) {
    // 源guard仅匹配裸命令名，显式路径交给原权限/advisory，不用basename扩大范围。
    const file = raw.replace(/^[&.]\s+/, "").replace(/^(['"])(.*)\1$/, "$2")
    const command = (shellName === "cmd" ? file.replace(/^@/, "") : file).toLowerCase().replace(/\.exe$/, "")
    if (["tail", "head", "sed", "awk", "grep"].includes(command)) {
      // 本地 PowerShell 给出对应替代，远程管道继续留在 SSH/WSL 字符串内。
      if (shellName !== "cmd") {
        return `The current shell is ${shellName}, but the local command uses Unix utility \`${raw}\`. ${powershellUnixAlternative(command)} Keep remote Unix pipelines inside the remote shell string (ssh/wsl), not as a local pipeline.`
      }
      return `The current shell is ${shellName}, but the command uses Unix utility ${raw}. Prefer available dedicated file tools; if terminal processing is required, use ${shellName === "cmd" ? "dir/type/findstr" : "Get-Content -Tail or Select-String"}.`
    }
    // ls 是 PS 的目录别名，只有 cmd 需要拦截；find 在 PS 语义含糊。
    if (shellName === "cmd" && command === "ls") return "The current shell is cmd.exe; use available directory tools or dir instead of ls."
    if (shellName !== "cmd" && command === "find") return `The current shell is ${shellName}; find is ambiguous on Windows. Prefer available dedicated search tools.`
  }
}

// #158：PowerShell 本地 Unix 工具的可操作替代提示
function powershellUnixAlternative(name: string) {
  if (name === "head") return "Prefer Select-Object -First N for local pipelines."
  if (name === "tail") return "Prefer Get-Content -Tail N or Select-Object -Last N."
  if (name === "grep") return "Prefer Select-String for local content search."
  if (name === "sed" || name === "awk") return "Prefer PowerShell -replace / ForEach-Object, or run inside POSIX/ssh."
  // #158：sed/awk 无单命令直接等价，避免给出误导性的直接映射
  // #158：默认回退到通用 PowerShell 工具提示
  return "Prefer PowerShell-native commands, or run the Unix utility inside ssh/wsl."
}


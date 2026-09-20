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
    // 在用户脚本同一作用域观察最终状态，成功恢复优先于此前native程序的残留码。
    "if ($?) { exit 0 }",
    // 失败保留本脚本已有的精确native非零码，纯cmdlet失败使用PowerShell失败码1。
    "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "exit 1",
    // stderr 必须保持原生字节，避免 PowerShell 按控制台编码提前解释 CP936。
    "} 3>&1 4>&1 5>&1 6>&1",
  ].join("\n")
  return {
    command: file,
    // 显式文本格式降低 PowerShell 信息流被序列化为 CLIXML 的概率。
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    // 显式 argv 不能再经 shell 包装，否则引号和中文会被第二次解释。
    shell: false,
  }
}

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    // 正文通过位置参数跨过初始化解析；双引号只保护参数，不提前展开正文中的变量。
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval "$2"
      `,
      "opencode",
      cwd,
      command,
    ]
  }
  if (n === "bash") {
    // 保留 Bash 的别名与 rc 初始化；cwd 仍是 $1，原命令独占 $2。
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval "$2"
      `,
      "opencode",
      cwd,
      command,
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

// grammar将裸横线预留给运算符，命令参数中的-与--需使用等值引用的分析表示。
// 单次词法扫描只定位兼容变换区域；AST仍由原grammar提供，执行与审计保留原文。
function normalizeBareDoubleDash(source: string) {
  let result = ""
  let quote = ""
  let command: boolean | undefined
  let invocation = false
  const groups: (boolean | undefined)[] = []
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      // here-string只在行首结束；正文内的引号、注释与横线均不可触发兼容变换。
      if (quote.length === 2) {
        if (source[index - 1] === "\n" && source.startsWith(quote, index)) {
          result += quote
          index++
          quote = ""
          continue
        }
        result += char
        continue
      }
      // 单引号内只有成对单引号特殊；双引号内反引号一次消费下一个字符。
      if ((quote === '"' && char === "`") || (char === quote && source[index + 1] === quote)) {
        result += char + (source[++index] ?? "")
        continue
      }
      if (char === quote) quote = ""
      result += char
      continue
    }
    // 反引号不是引用定界符；跳过被保护字符后立刻恢复普通扫描。
    if (char === "`") { result += char + (source[++index] ?? ""); continue }
    // 块注释允许嵌套；整段前进，避免为每个字符重扫此前的源码。
    if (source.startsWith("<#", index)) {
      const start = index
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source.startsWith("<#", index)) { depth++; index += 2; continue }
        if (source.startsWith("#>", index)) { depth--; index += 2; continue }
        index++
      }
      result += source.slice(start, index--)
      continue
    }
    // 行注释与stop-parsing正文保持原样，换行本身仍恢复下一条语句的边界。
    if ((char === "#" && (index === 0 || /[\s;|&({]/.test(source[index - 1]))) || (command && source.startsWith("--%", index))) {
      const end = source.indexOf("\n", index)
      if (end < 0) { result += source.slice(index); break }
      result += source.slice(index, end)
      index = end - 1
      continue
    }
    // 括号上下文只决定是否允许横线兼容；运算表达式的含义仍完全交给grammar。
    if (/[;|&\r\n(){}=]/.test(char)) {
      if (/[;|\r\n]/.test(char)) { command = undefined; invocation = false }
      if (char === "&") { command = true; invocation = true }
      if (char === "(" || char === "{") { groups.push(command ?? false); command = undefined }
      if (char === ")" || char === "}") command = groups.pop()
      if (char === "=" && !command) command = undefined
      result += char
      continue
    }
    if (!/\s/.test(char)) {
      // 只恢复旧conda/Python前缀的三个静态等号选项；引用/动态值与其它子程序不匹配。
      if ((command === undefined || invocation) && /c/i.test(char)) {
        const prefix = /^(conda(?:\.exe)?[ \t]+run[ \t]+(?:(?:--(?:dev|debug-wrapper-scripts|no-capture-output|live-stream)|-v{1,3})[ \t]+|(?:-n|--name|-p|--prefix|--cwd)[ \t]+[^-\s"'`$@;&|<>(){}][^\s"'`$@;&|<>(){}]*[ \t]+|--(?:name|prefix|cwd)=[^\s"'`$@;&|<>(){}]+[ \t]+)*)(python(?:3(?:\.\d+)?)?|py)(?:\.exe)?(?=$|[ \t])/i.exec(source.slice(index))
        // 只有旧flags后的-c或本次字面stdin入口适用；脚本文件和模块不恢复等号选项。
        if (prefix && /^(?:[ \t]+(?:-3(?:\.\d+)?(?:-32|-64)?|-32|-64|-B|-E|-I|-O|-OO|-P|-b|-bb|-d|-q|-s|-S|-u|-v|-x|-[WX](?:[ \t]+)?[^\s"'`$@;&|<>(){}]+))*[ \t]+(?:-c(?=[ \t]+['"])|-(?=$|[ \t;|]))/.test(source.slice(index + prefix[0].length))) {
          // 只改grammar表示，选项值不解码；该段消费一次，避免逐字符重扫前缀。
          result += prefix[1].replace(/--(?:name|prefix|cwd)=[^\s]+/g, (option) => `'${option}'`)
          index += prefix[1].length - 1
          command = true
          invocation = false
          continue
        }
      }
      invocation = false
      // 表达式以数值、变量或引用开始；调用运算符则已明确后续字符串是执行名。
      command ??= /[A-Za-z_./\\]/.test(char)
      if (char === "@" && ["'", '"'].includes(source[index + 1]) && /[\r\n]/.test(source[index + 2] ?? "")) {
        quote = source[index + 1] + "@"
        result += char + source[++index]
        continue
      }
      if (["'", '"'].includes(char)) quote = char
      // 仅检查独立参数，不触碰负数、自减、长选项或括号内的数值减法。
      if (command && char === "-" && /[\s;&|]/.test(source[index - 1] ?? "")) {
        const dash = source[index + 1] === "-" ? "--" : "-"
        if (index + dash.length === source.length || /[\s;&|)}]/.test(source[index + dash.length])) {
          result += `"${dash}"`
          index += dash.length - 1
          continue
        }
      }
    }
    result += char
  }
  return result
}

export async function parse(command: string, ps: boolean) {
  const p = await parser()
  // 节点偏移属于归一后的tree.text；调用者仍保留原command用于实际执行和授权。
  const tree = (ps ? p.ps : p.bash).parse(ps ? normalizeBareDoubleDash(command) : command)
  if (!tree) throw new Error("Failed to parse command")
  return tree
}

// 只渲染已选择的 shell，调用方继续拥有各自的配置优先级与 fallback。
export function guidance(file: string, platform: NodeJS.Platform) {
  const shell = name(file)
  return [
    `Shell: ${file}`,
    "JSON decoding happens once; execute native quoting and newlines without extra escaping. Native multiline scripts are allowed.",
    // PowerShell 跨平台仍使用自身语法，不能根据 OS 把它误判为 Bash。
    ...(ps(file) ? [
      "Use PowerShell syntax; read environment variables with $env:NAME, not export NAME=...; use $null, not /dev/null.",
      // stderr已由同一个进程handle采集，保留源提示原话而非另行合并流。
      "Do not append `2>&1` to PowerShell commands; the shell tool already captures stderr.",
      // 引用合同随实际Shell source共享给V1/V2，不在两个工具入口各造一份解释器说明。
      '- PowerShell expands $name and evaluates $(...) inside double quotes; use "..." when you want those local values.',
      "- In single-quoted strings, PowerShell leaves $name and $(...) unevaluated; backslash is ordinary. Write '' for a single quote.",
      '- Inside double quotes, `$name keeps $name as text and `" inserts a double quote; \\$name still expands $name, and \\" does not escape a quote.',
      "- For multiline text without variable substitution, start with @' followed by a newline; close with '@ at the start of a new line.",
      '- To run a Linux program through WSL, use wsl --exec <program> ...; for Bash use wsl --exec bash -lc \'echo "$HOME"\'. wsl -- bash -lc adds another shell that can expand variables first.',
      ...(shell === "powershell" ? ["Windows PowerShell 5.1 rebuilds native arguments as a command line, consuming embedded double quotes; use a program's stdin interface for quoted code."] : []),
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


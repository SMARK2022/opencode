import { Effect, Fiber, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import { ToolProgress } from "./progress"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import type { Node } from "web-tree-sitter"
import { ShellParse } from "@opencode-ai/core/shell/parse"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellRemote } from "@opencode-ai/core/shell-remote"
import { parts, permissionPattern, rawPattern } from "@opencode-ai/core/shell-permission"
import { ShellID } from "./shell/id"
import { BashDiagnosticCollector, bashCompressionMetadata, compressVisibleOutput, createTerminalDisplay, normalizePowerShellOutput, renderDiagnosticAppendix } from "@opencode-ai/core/tool/bash-compress"
// #282：超时/中止/截断改用统一 notice 信封
import { formatOutputTruncatedNotice, formatShellExecutionNotice, outputStats } from "@/util/output-notice"

import { Truncate } from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { PermissionPrecheck } from "@/permission/precheck"
import { createAutoTextDecoder, type TextEncodingMode } from "@/util/text-decoding"
// #126：自动检测 UTF-8/UTF-16/GB18030 的流式解码

// 只有写操作失去 always 前缀建议；只读 Git 仍保留现有权限匹配路径。
const GIT_WRITES = new Set(["add", "commit", "merge", "rebase", "cherry-pick", "revert", "pull", "push", "checkout", "switch", "restore", "reset", "clean"])
// stash 的默认行为是 push，不能把消息文本误当成只读子命令。
const GIT_STASH_WRITES = new Set(["push", "pop", "apply", "drop", "clear", "branch", "save", "create", "store", "export", "import"])

function riskyGit(tokens: string[]) {
  // AST 直接命令的建议收窄不等于执行授权；alias/eval 与间接脚本仍由原权限链决定。
  if (tokens[0]?.toLowerCase().replace(/\.exe$/, "") !== "git") return false
  // -C 与 -c 都消费下一项；保留原 token 的大小写才能区分 Git 的短选项。
  let i = 1
  while (i < tokens.length) {
    const token = tokens[i]
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"].includes(token)) {
      i += 2
      continue
    }
    // 附着值和无值全局选项整个跳过，不把路径或配置误识别为子命令。
    if (token.startsWith("-")) {
      i++
      continue
    }
    break
  }
  const subcommand = tokens[i]?.toLowerCase()
  if (subcommand !== "stash") return subcommand !== undefined && GIT_WRITES.has(subcommand)
  // 从真实子命令位置继续，配置值含 stash 也不会改变扫描起点。
  for (i++; i < tokens.length; i++) {
    const token = tokens[i]
    // 裸 stash 的 -m/--message 消费值，checkpoint/list 都不是动作。
    if (token === "-m" || token === "--message") {
      i++
      return true
    }
    if (token.startsWith("-m") || token.startsWith("--message=")) return true
    // -- 后是路径限定，仍然是默认 push，不应扩大为只读许可。
    if (token === "--") return true
    if (token.startsWith("-")) continue
    const action = token.toLowerCase()
    // list/show 是只读；未知位置参数可能是隐式 push 的路径，保守保留询问。
    return GIT_STASH_WRITES.has(action) || !["list", "show"].includes(action)
  }
  return true
}

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
  // #203：仅纳入暴露新路径效果的 PowerShell 名称——已覆盖的别名留在上面，gci 需单独纳入
  // #203：使 .ssh 列举与 Get-ChildItem 走相同的 external-directory/bash 门禁
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

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  raw: Set<string>
  // #285：raw 集合与 patterns 并行收集，两者来源不同（原始文本 vs 规范化 pattern）
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
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
  return truncateWindow(text, maxLines, maxBytes, "tail")
}

// [local-smark] head 截断：从头取 maxLines 行，与 tail 对称。
// 用于列表/树形命令（ls/find/tree/git status/git diff）的输出，
// 这些命令的重要信息在开头（文件列表、变更概览），tail 会丢失。
function head(text: string, maxLines: number, maxBytes: number) {
  return truncateWindow(text, maxLines, maxBytes, "head")
}

// 统一的截断窗口实现：direction="tail" 从末尾取，direction="head" 从头取。
// 返回 {text, cut, hidden}，hidden 是被窗口丢弃的部分（供诊断扫描）。
// #283/#293 语义保留：折叠行换行先去除；hidden 仅包含被窗口丢弃的文本。
function truncateWindow(text: string, maxLines: number, maxBytes: number, direction: "head" | "tail") {
  const source = text.replace(/\r?\n$/, "")
  const lines = source.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, cut: false, hidden: "" }
  }

  const out: string[] = []
  let bytes = 0
  // head: 从头遍历；tail: 从尾遍历
  for (const i of direction === "head" ? lines.keys() : [...lines.keys()].reverse()) {
    if (out.length >= maxLines) break
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = direction === "head" ? 0 : buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        const slice = direction === "head" ? buf.subarray(start, start + maxBytes) : buf.subarray(start)
        if (direction === "head") out.push(slice.toString("utf-8"))
        else out.unshift(slice.toString("utf-8"))
      }
      break
    }
    if (direction === "head") out.push(lines[i])
    else out.unshift(lines[i])
    bytes += size
  }
  const visible = out.join("\n")
  // hidden 语义按方向区分：head 丢弃后缀，tail 丢弃前缀（与 #293 一致）
  const hidden = direction === "head"
    ? source.slice(visible.length)
    : visible ? source.slice(0, Math.max(0, source.length - visible.length)) : source
  return { text: visible, cut: true, hidden }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, dialect: ShellParse.Dialect) {
  // 工具与预检共享同一grammar，原执行文本与Tree释放责任保持不变。
  return yield* Effect.promise(() => ShellParse.parse(command, dialect))
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string; cwd: string; shell: string; inline_scripts?: string[] }) {
  // [local-smark] shared evidence：两个 permission request 必须从同一对象展开，
  // 确保 inline_scripts 附加证据同时到达 external_directory 和 bash gate
  const sharedEvidence = input.inline_scripts ? { inline_scripts: input.inline_scripts } : {}
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      // #232：项目外路径访问不能先退回普通 ask；把同一次 shell 命令证据传给 permission
      // #232：层，让 dangerous payload 在 external_directory 门禁 deterministic deny，
      // #232：其他外部路径则进入同一条 cautious review 边界。
      metadata: {
        action_kind: "shell",
        command: input.command,
        cwd: input.cwd,
        shell: input.shell,
        agent: ctx.agent,
        directories,
        patterns: globs,
        ...sharedEvidence,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    // 审查使用原始命令与实际 cwd；展示用 patterns 可能被拆分或重排，不作为执行证据。
    metadata: {
      action_kind: "shell",
      command: input.command,
      // #285：raw_patterns 是 deny-only 兼容证据。canonical patterns 刻意省略
      // POSIX env 赋值，使 git push --force* 仍能匹配；原始形式保留给显式硬拒规则
      ...(scan.raw.size ? { raw_patterns: Array.from(scan.raw) } : {}),
      cwd: input.cwd,
      shell: input.shell,
      agent: ctx.agent,
      ...sharedEvidence,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  // 编码仅发生在授权后的 spawn 边界；AST 与权限 metadata 继续使用原始输入。
  const invocation = Shell.cmd(shell, command)
  return ChildProcess.make(invocation.command, invocation.args, {
    shell: invocation.shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

// 只检查解析出的命令头，不能把 echo 参数或路径里的 grep 当成执行工具。
function shellCompatibilityError(root: Node, shellName: string) {
  // V1 保留完整 AST 提取；分类与错误文字复用 Core 的同一 guard。
  return Shell.compatibilityError(localCommands(root, shellName).flatMap((node) => parts(node)[0]?.text ?? []), shellName)
}

// #158：只扫描本地 command 节点；祖先含 string 视为远程/WSL 引号载荷
function localCommands(root: Node, shellName: string) {
  const remote = ShellRemote.ranges(root.text, shellName)
  return commands(root).filter((node) => {
    // 客体命名空间只从宿主扫描剔除，原始命令仍完整进入bash授权。
    if (remote.some((range) => range.start <= node.startIndex && node.startIndex < range.end)) return false
    let cur: Node | null = node
    while (cur) {
      // #158：string/raw_string 等类型包含 string 即视为载荷边界
      // #179：ERROR 恢复节点中的 POSIX 碎片不算本地命令
      // #179：与 string 载荷过滤叠加，避免 WSL/ssh 引号内误判
      // #179：根 ERROR 仍承载主机命令，不能清空权限扫描；只排除内部恢复碎片。
      if (cur.id !== root.id && cur.type === "ERROR") return false
      if (cur.type.includes("string")) return false
      // #158：root 自身 type 不含 string，向上遍历到 null 自然终止
      cur = cur.parent
    }
    return true
  })
}


// #128：config.tool_output.shell_encoding，默认 auto
function shellOutputEncoding(config?: { tool_output?: { shell_encoding?: TextEncodingMode } }): TextEncodingMode {
  return config?.tool_output?.shell_encoding ?? "auto"
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    // 捕获当前 Layer 的必需配置服务；cfg 仍在工具初始化时读取，不恢复可选探测或吞错默认值。
    const configService = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        const textPath = FSUtil.windowsPath(text)
        // PowerShell 盘符相对路径按命令 cwd 解析，避免使用进程的盘符 cwd。
        // 保留 C:/file 与 C:\file 这类绝对路径，权限扫描仍以可见 cwd 为边界。
        return FSUtil.normalizePath(path.resolve(root, Shell.ps(shell) ? textPath.replace(/^[A-Za-z]:(?![\\/])/, "") : textPath))
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
      const locals = localCommands(root, Shell.name(shell))

      for (const node of locals) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
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
          // #285：raw 与 canonical pattern 相同时不加重复证据；只有差异（如 env 赋值）才进 raw
          // 仍保留完整请求 pattern，只撤销危险写操作的自动前缀建议。
          const always = BashArity.prefix(tokens)
          // #197：高风险 git 写操作与宽泛 wrapper 前缀不自动加入 always-allow
          if (!riskyGit(tokens) && PermissionPrecheck.canAlwaysAllowPrefix(always)) scan.always.add(always.join(" ") + " *")
        }
      }

      // PowerShell 错误恢复可能只留下命令前缀；权限必须审查完整输入，不能据残缺 AST 建议自动放行。
      if (ps && root.hasError) {
        scan.patterns.clear()
        scan.patterns.add(root.text.trim())
        scan.always.clear()
      }

      // 只给零命令节点补送审入口；cd等有意零pattern仍保持原契约，分类交给既有precheck。
      if (scan.patterns.size === 0 && locals.length === 0 && root.text.trim()) {
        scan.patterns.add(root.text.trim())
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        // 保留源顺序：宿主环境、Windows UTF-8、插件 extras；插件显式覆盖仍最后生效。
        ...Shell.utf8Environment(),
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        // [local-smark] PowerShell inline Python 规范化后的实际执行命令
        executeCommand?: string
        // 规范化 tag，进 result metadata 便于数据库度量
        adaptation?: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        compressOutput: boolean
      // #128：输出文本编码策略
      encoding: TextEncodingMode
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      // #215：屏幕独立于原始环形缓冲和写盘，先渲染再交给 Tool.wrap 消毒。
      const display = createTerminalDisplay({ maxLines: limits.maxLines, maxChars: MAX_METADATA_LENGTH })
      const list: Chunk[] = []
      let used = 0
      // total描述恢复路径中的完整原始归档，统计不能重新载入已淘汰的输出。
      const total = { bytes: 0, lines: 0 }
      let trailingLine = false
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

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

      // 隐藏诊断只采样被窗口驱逐的原始块与 tail 前缀，避免重复可见错误。
      // V1 采样与最终附录复用同一个开关，保留源逐字 opt-out。
      const hiddenDiag = new BashDiagnosticCollector({ enabled: input.compressOutput })
      const started = Date.now()

      // version 0 是新 producer initial 与旧持久化 running Part 的共同基线。
      yield* ctx.metadata({
        metadata: {
          output: "",
          progressVersion: 0,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.executeCommand ?? input.command, input.cwd, input.env))

          // #126：按字节喂给自动解码器，避免 UTF-16 被 decodeText 当 UTF-8 破坏
          // #126：按字节喂解码器，解决 PowerShell/重定向 UTF-16 输出
          // #128：按 input.encoding 锁定或自动探测
          const decoder = createAutoTextDecoder({ encoding: input.encoding })
          // 沿现有进程 scope 收尾：输出消费完成后 flush，外层才提交 terminal Part。
          const progress = yield* ToolProgress.make({
            live: (metadata) => ctx.metadata({ metadata, delivery: "ephemeral" }),
            durable: (metadata) => ctx.metadata({ metadata, delivery: "durable" }),
          })
          let lastVisible = ""
          // #126：字符串 chunk 写入环形缓冲与截断/落盘逻辑
          const onChunk = (chunk: string) => {
            if (!chunk) return Effect.void
            const visible = preview(display.push(chunk))
            const size = Buffer.byteLength(chunk, "utf-8")
            total.bytes += size
            for (const char of chunk) if (char === "\n") total.lines++
            trailingLine = !chunk.endsWith("\n")
            list.push({ text: chunk, size })
            used += size
            while (used > keep && list.length > 1) {
              const item = list.shift()
              if (!item) break
              hiddenDiag.push(item.text)
              used -= item.size
              cut = true
            }
            const spill = file
              ? Effect.sync(() => sink?.write(chunk))
              : Effect.sync(() => {
                  full += chunk
                  return Buffer.byteLength(full, "utf-8") > limits.maxBytes
                }).pipe(
                  Effect.andThen((overflow) =>
                    overflow
                      ? trunc.write(full).pipe(
                          Effect.andThen((next) =>
                            Effect.sync(() => {
                              file = next
                              cut = true
                              sink = createWriteStream(next, { flags: "a" })
                              full = ""
                            }),
                          ),
                        )
                      : Effect.void,
                  ),
                )
            if (visible === lastVisible) return spill
            lastVisible = visible
            // metadata 是 replace 型终端快照；raw chunk 仍走原有内存/截断路径，
            // 所以 latest-wins 只减少 UI/SQLite 更新，不会丢失模型可见字节。
            return spill.pipe(
              Effect.andThen(progress.update({ output: visible })),
            )
          }

          // #291：将 forkScoped 赋值给 output 变量，以便后续 Fiber.join 等待流消费完成
          const output = yield* Effect.forkScoped(
            // #126：end 时 flush decoder 尾部不完整码点
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
            // 底层已把退出等待纳入forceKillAfter，复用它而不叠加第二套超时与吞错。
            yield* handle.kill({ forceKillAfter: "500 millis" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "500 millis" }).pipe(Effect.orDie)
          }

          // #291：子进程 close 只说明 OS 管道已关闭，不代表 Effect stream 已经处理完
          // 已缓冲的最后几个 chunk 或它们触发的 metadata 更新。最终输出、截断、
          // 诊断摘要都必须在输出消费完成后组装，否则 Linux 上 fast-exit 命令
          // 会偶发丢尾部输出并把错误上下文误判为仍然可见。
          yield* Fiber.join(output)

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      // [local-smark] 统一调用 pure outcome policy，保证一个 Bash 结果只生成一种系统 Notice
      const shellElapsedMs = Date.now() - started
      const raw = list.map((item) => item.text).join("")
      // 仅模型可见窗口正常化 CLIXML，完整归档仍保留原始输出。
      const normalized = process.platform === "win32" && Shell.ps(input.shell) ? normalizePowerShellOutput(raw) : raw
      // 压缩只改变模型窗口；已经流式写盘的 file 始终保持原始内容。
      // 压缩器不再依赖command，执行与授权仍使用未改动原文。
      const compressed = compressVisibleOutput(normalized, { enabled: input.compressOutput })
      // 列表类命令保留开头，验证日志保留末尾；环境变量前缀不参与命令分类。
      let cmdForMatch = input.command.trim()
      while (true) {
        const m = cmdForMatch.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/)
        if (!m) break
        cmdForMatch = cmdForMatch.slice(m[0].length).trimStart()
      }
      const useHead = /^(ls|dir|find|tree|git\s+(status|diff|log|ls-files))/.test(cmdForMatch.toLowerCase())
      const end = (useHead ? head : tail)(compressed.text, limits.maxLines, limits.maxBytes)
      if (end.cut) {
        cut = true
        hiddenDiag.push(end.hidden)
      }
      hiddenDiag.end()
      const diagnostic = hiddenDiag.snapshot()
      // 诊断采样遗漏也必须能恢复，不能因压缩禁用而省掉原始日志。
      // CLIXML解码可能净增长；呈现变化仍须生成并广告未经改写的原文。
      const transformed = compressed.text !== raw
      if (!file && (transformed || end.cut || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0)) {
        file = yield* trunc.write(raw)
      }

      // #289：空输出检测前移，exit notice 依赖此标志决定是否追加退出码
      const emptyOutput = end.text.length === 0
      let output = emptyOutput ? "(no output)" : end.text

      // [local-smark] timeout + 空输出时追加诊断提示，帮助模型区分三种可能：
      // 1. 进程 block-buffering（pipe 非 tty 时 C 库默认 4-8KB 块缓冲，
      //    bun install/bundle install 等构建工具的进度输出停留在进程内部缓冲区，
      //    timeout kill 时被 OS 丢弃）→ 建议 --verbose 或增大 timeout
      // 2. 进程等待交互输入 → 建议非交互 flag
      // 3. 进程 hang 住 → 检查命令和环境
      // 不改 pipe 架构（pty 改造是 P2），仅改善模型在 timeout-no-output 时的决策质量。
      // 仅在 timeout（expired）且空输出时触发；有输出或正常退出不触发。
      if (emptyOutput && expired) {
        output +=
          "\n\nThe process produced no output before timeout. This may indicate:" +
          "\n- The command is block-buffering output (common for build tools like bun install, bundle install);" +
          " consider adding --verbose or running with a larger timeout." +
          "\n- The process is waiting for interactive input; provide input or use a non-interactive flag." +
          "\n- The process is hung; check the command and environment."
      }

      if (cut && file) {
        // 末尾换行不额外算一行；内存只保留计数器与原有尾部窗口。
        output =
          formatOutputTruncatedNotice({
            source: "shell",
            total: { bytes: total.bytes, lines: total.lines + Number(trailingLine) },
            shown: { direction: useHead ? "head" : "tail", ...outputStats(output) },
            path: file,
          }) +
          "\n\n" +
          output
      }

      // 呈现变化与单独脱敏都广告原文路径，不能把收益布尔值当作恢复条件。
      if (file && !cut && (transformed || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0)) {
        output = `...output compacted or diagnostic frames sampled...\n\nFull output saved to: ${file}\n\n` + output
      }

      // 附录只读取隐藏诊断；采样遗漏的恢复路径仍指向不可变原始归档。
      const appendix = renderDiagnosticAppendix(diagnostic, { durationMs: Date.now() - started, exitCode: code, config: { enabled: input.compressOutput } })
      if (appendix) output += "\n\n" + appendix
      // 退出 notice 独立描述进程结束，隐藏诊断不能抑制失败退出码。
      // 这里刻意不回放命令文本、环境变量或原始 metadata，保持模型可见信息的最小安全边界。
      // [local-smark] outcome policy 在 emptyOutput 确定后统一处理
      // timeout/abort/exit/long-completed，优先级固定不叠加
      const shellNotice = formatShellExecutionNotice({
        aborted,
        expired,
        exitCode: code,
        emptyOutput,
        timeoutMs: input.timeout,
        elapsedMs: shellElapsedMs,
      })
      if (shellNotice) {
        output += "\n\n" + shellNotice
      }
      // 用户面板只取最终终端画面，不能用模型notice或诊断回填空屏幕。
      const displayText = display.value()
      const userOutput = displayText.length > 0 ? preview(displayText) : "(no output)"

      // [local-smark] typecheck error flag：对已知验证命令（typecheck/tsc/test/lint），
      // 检测 error pattern 并设置 hasErrors flag，帮助模型识别验证失败。
      // 使用独立 regex 限定检测范围（与 compaction.ts renderExecutedCommands 无关），
      // 避免对非验证命令误判。error pattern 覆盖 tsc/eslint/python/mypy 等常见工具。
      const isVerificationCmd = /^(bun|npm|pnpm|yarn)\s+(run\s+)?(typecheck|test|build|lint|check|audit)(\s|$)/.test(input.command.trim().toLowerCase()) ||
        /^node\s+--check(\s|$)/.test(input.command.trim().toLowerCase()) ||
        /^python\s+-m\s+py_compile(\s|$)/.test(input.command.trim().toLowerCase()) ||
        /^tsc\s+--noemit(\s|$)/.test(input.command.trim().toLowerCase())
      const hasErrors = isVerificationCmd && (
        code !== null && code !== 0 ||
        /error TS\d|SyntaxError|FAIL|Error:|✗/i.test(output)
      )

      return {
        title: input.command,
        metadata: {
          // #536：metadata.output 是用户面板唯一事实——终端屏幕或精确占位符，不携带模型侧 notice。
          output: userOutput,
          exit: code,
          truncated: cut,
          // [local-smark] 规范化生效时记录 adaptation tag，便于数据库度量和后续诊断
          ...(input.adaptation ? { commandAdaptation: input.adaptation } : {}),
          ...((transformed || cut || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0) && file ? { outputPath: file } : {}),
          // truncated 只表示窗口损失，compressed 的收益针对本次可见捕获计算。
          ...bashCompressionMetadata(compressed.stats),
          durationMs: Date.now() - started,
          // 错误频率与采样遗漏独立持久化，未观察的长行中段不能被计为无错误。
          diagnosticErrorLikeLines: diagnostic.errorLikeLines,
          diagnosticWarningLikeLines: diagnostic.warningLikeLines,
          // [local-smark] hasErrors flag 供 TUI 和后续逻辑判断验证是否失败
          hasErrors,
          diagnosticDiscardedChars: diagnostic.discardedChars,
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* configService.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        // #116：压缩指引；tip 已默认压缩，补全 SMARK 全文案（含 raw 落盘说明）
        const compressionEnabled = cfg.tool_output?.bash_compression ?? true
        // #116：启用时提示默认压缩 + 需要精确格式时关 compress_output
        const compressionGuidance = compressionEnabled
          ? [
              "Shell output compression follows the user's default and is strongly recommended for normal commands; repetitive output, oversized lines, and terminal progress noise may be compacted.",
              "Strongly prefer leaving `compress_output` omitted; set false only for exact raw formatting. Truncated output includes a compact notice and recovery path.",
              // 图例声明标记由harness插入且省略有意，避免为排查标记而关闭压缩。
              "Short harness markers may appear inside compressed output; the command did not print them: `[... same line Nx]`, `[... repeated block Nx]`, `[... template repeated Nx]`, `[... progress N frames->final]`, `[... high-entropy <kind> <size>B head=...]` (oversized base64/JWT/hash lines), `[redacted ...]` (detected secrets; a short head is kept for identification). First occurrences and error lines are preserved; omitted content is intentionally dropped, not a failure to investigate.",
            ].join(" ")
          : ""
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description + (compressionGuidance ? "\n\n" + compressionGuidance : ""),
          parameters: prompt.parameters,
          // #557：shell 命令副作用不透明，只能使用短窗口 Patch best-effort 归因。
          worktree: "ambient",
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              // 只在共享owner确认Windows PowerShell静态边界后适配，原命令仍用于分析和授权。
              const normalization = Shell.normalizePowerShellInlinePython(params.command, shell)
              // 全局 false 优先于单次 true；精确排版可由单次 false 独立关闭。
              const compressOutput = (cfg.tool_output?.bash_compression ?? true) && (params.compress_output ?? true)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps ? "powershell" : name === "cmd" ? "cmd" : "bash"), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  // 检查发生在权限与执行之前，tree 的 acquireRelease 仍负责失败释放。
                  const compatibility = shellCompatibilityError(tree.rootNode, name)
                  if (compatibility) throw new Error(compatibility)
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  // 原始command继续授权；audit只补充拒绝证据，不生成allow/always键。
                  if (normalization) scan.raw.add(normalization.audit)
                  yield* ask(ctx, scan, {
                    command: params.command, cwd, shell: name,
                    ...(normalization ? { inline_scripts: [normalization.source] } : {}),
                  })
                }),
              )

              // #128：读取 shell_encoding 配置
              const encoding = shellOutputEncoding(cfg)
              return yield* run(
                {
                  shell,
                  command: params.command,
                  // [local-smark] 规范化后的实际执行命令；原始 params.command 继续用于
                  // UI、压缩、分类、日志和 ToolPart input
                  ...(normalization ? { executeCommand: normalization.command } : {}),
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  compressOutput,
                  encoding,
                  // 规范化生效时在 result metadata 中记录 adaptation tag，便于数据库度量
                  ...(normalization ? { adaptation: Shell.INLINE_PYTHON_TAG } : {}),
                },
                ctx,
              )
            }),
        }
      })
  }),
)

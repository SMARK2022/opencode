import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import type { Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { BashDiagnosticCollector, bashCompressionMetadata, compressVisibleOutput, renderDiagnosticAppendix } from "@opencode-ai/core/tool/bash-compress"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

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
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
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
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
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
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  return yield* Effect.promise(() => Shell.parse(command, ps))
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
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
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
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
  return Shell.compatibilityError(commands(root).flatMap((node) => parts(node)[0]?.text ?? []), shellName)
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
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
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
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
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
          scan.patterns.add(source(node))
          // 仍保留完整请求 pattern，只撤销危险写操作的自动前缀建议。
          if (!riskyGit(tokens)) scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      // PowerShell 错误恢复可能只留下命令前缀；权限必须审查完整输入，不能据残缺 AST 建议自动放行。
      if (ps && root.hasError) {
        scan.patterns.clear()
        scan.patterns.add(root.text.trim())
        scan.always.clear()
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
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        compressOutput: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
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

      // 诊断观察完整流，不能只观察已经丢弃旧块的内存窗口。
      // V1 采样与最终附录复用同一个开关，保留源逐字 opt-out。
      const diag = new BashDiagnosticCollector({ enabled: input.compressOutput })
      const started = Date.now()

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              // 采样容量独立于 capture 限额，无换行输出也不能无限积累。
              diag.push(chunk)
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
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
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      // 压缩只改变模型窗口；已经流式写盘的 file 始终保持原始内容。
      // V1 与 Core 传同一种实际 command，适配器只作用于既有可见投影。
      const compressed = compressVisibleOutput(raw, { enabled: input.compressOutput }, input.command)
      diag.end()
      const diagnostic = diag.snapshot()
      const end = tail(compressed.text, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      // 诊断采样遗漏也必须能恢复，不能因压缩禁用而省掉原始日志。
      // CLIXML解码可能净增长；呈现变化仍须生成并广告未经改写的原文。
      const transformed = compressed.text !== raw
      if (!file && (transformed || end.cut || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0)) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      // 呈现变化与单独脱敏都广告原文路径，不能把收益布尔值当作恢复条件。
      if (file && (transformed || cut || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0)) {
        output = `${cut ? "...output truncated..." : "...output compacted or diagnostic frames sampled..."}\n\nFull output saved to: ${file}\n\n` + output
      }

      // 先完成最终窗口再判定可见性，不能用截断前的原文隐藏附录。
      const appendix = renderDiagnosticAppendix(diagnostic, { durationMs: Date.now() - started, exitCode: code, visibleOutput: output, config: { enabled: input.compressOutput } })
      if (appendix) output += "\n\n" + appendix
      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...((transformed || cut || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0) && file ? { outputPath: file } : {}),
          // truncated 只表示窗口损失，compressed 的收益针对本次可见捕获计算。
          ...bashCompressionMetadata(compressed.stats),
          durationMs: Date.now() - started,
          // 错误频率与采样遗漏独立持久化，未观察的长行中段不能被计为无错误。
          diagnosticErrorLikeLines: diagnostic.errorLikeLines,
          diagnosticWarningLikeLines: diagnostic.warningLikeLines,
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
              "Bash output compression is enabled by default. Repetitive output may be compacted before being returned, while the full raw output is still saved to a file when needed.",
              "Use `compress_output: false` for commands where exact raw formatting matters, such as snapshot tests, binary/text fixture generation, or commands whose spacing is the result of careful formatting.",
            ].join(" ")
          : ""
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description + (compressionGuidance ? "\n\n" + compressionGuidance : ""),
          parameters: prompt.parameters,
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
              // 全局 false 优先于单次 true；精确排版可由单次 false 独立关闭。
              const compressOutput = (cfg.tool_output?.bash_compression ?? true) && (params.compress_output ?? true)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  // 检查发生在权限与执行之前，tree 的 acquireRelease 仍负责失败释放。
                  const compatibility = shellCompatibilityError(tree.rootNode, name)
                  if (compatibility) throw new Error(compatibility)
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  compressOutput,
                },
                ctx,
              )
            }),
        }
      })
  }),
)

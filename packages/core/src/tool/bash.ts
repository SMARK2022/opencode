export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { SystemContext } from "../system-context/index"
import { SystemContextRegistry } from "../system-context/registry"
import { Shell } from "../shell"
import { ShellPermission } from "../shell-permission"
import { ShellRemote } from "../shell-remote"
import { ToolOutputStore } from "../tool-output-store"
import { BashDiagnosticCollector, bashCompressionMetadata, compressVisibleOutput, normalizePowerShellOutput, renderDiagnosticAppendix } from "./bash-compress"
import { sanitizedProcessEnv } from "../util/opencode-process"
import { WindowsShellOutput } from "../windows-shell-output"
import { createAutoTextDecoder } from "../text-decoding"
import { formatShellExecutionNotice } from "../util/output-notice"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "The native script to execute in the configured shell. JSON decoding happens once; use native quoting and newlines, without extra escaping." }),
  // description 是调用意图，不参与命令拼接，也不替代原始命令授权资源。
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "Clear, concise description of what this command does in 5-10 words. Example: git status -> Shows working tree status.",
  }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
  // 只控制模型呈现，false 不能改变进程 capture 限额或绕过完整原文保留。
  compress_output: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Whether repetitive output may be compressed. Defaults to the user's bash_compression setting. Set false for exact raw formatting.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
  // 取消没有退出码，也不能用 timeout 冒充；durable progress 保留真实终止原因。
  interrupted: Schema.Boolean.pipe(Schema.optional),
  // 统计属于 typed transcript，不能把内存窗口的收益误称为磁盘全日志的收益。
  compression: Schema.Struct({
    compressed: Schema.Boolean,
    compressionOriginalBytes: Schema.Number,
    compressionCompressedBytes: Schema.Number,
    compressionSavedBytes: Schema.Number,
    compressionSavingRatio: Schema.Number,
    compressionCarriageReturnGroups: Schema.Number,
    compressionRepeatedBlockGroups: Schema.Number,
    compressionRepeatedLineGroups: Schema.Number,
    compressionInlinePatternGroups: Schema.Number,
    // typed transcript 接住共享 owner 的新统计，不能在 schema 投影时丢掉。
    compressionTemplateGroups: Schema.Number,
    compressionHighEntropyLines: Schema.Number,
    compressionSecretsRedacted: Schema.Number,
  }).pipe(Schema.optional),
  durationMs: Schema.Number.pipe(Schema.optional),
  // typed输出与投影共同保留适配标记，不能只写一个会被Schema丢弃的临时属性。
  commandAdaptation: Schema.String.pipe(Schema.optional),
  diagnosticErrorLikeLines: Schema.Number.pipe(Schema.optional),
  diagnosticWarningLikeLines: Schema.Number.pipe(Schema.optional),
  diagnosticDiscardedChars: Schema.Number.pipe(Schema.optional),
  hasErrors: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  // 原文与模型窗口保持分离，路径和最终限额仍由 registry/store 持有。
  contextOutput: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
  executionNotice: Schema.String.pipe(Schema.optional),
})

type Output = typeof Output.Type

// 两代共用实际shell选择器；执行与环境指引不能分别回退cmd和PowerShell。
const selectedShell = (entries: readonly Config.Entry[]) =>
  Shell.acceptable(Object.assign({}, ...entries.flatMap((entry) => entry.type === "document" ? [entry.info] : [])).shell)

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  // 终止原因已由唯一finish写入正文，状态投影不再叠加第二条同义提示。
  if (output.timeout || output.interrupted) return [output.executionNotice, warnings.trimStart()].filter(Boolean).join("\n\n")
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.${output.executionNotice ? "\n\n" + output.executionNotice : ""}`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = Effect.fn("BashTool.externalCommandDirectories")(function* (
  fs: FSUtil.Interface,
  command: string,
  cwd: string,
) {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = yield* fs.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(yield* fs.resolve(path.dirname(resolved)))
  }
  return [...directories]
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const outputStore = yield* ToolOutputStore.Service
    const permission = yield* PermissionV2.Service
    const registry = yield* SystemContextRegistry.Service
    // 图例服从同一用户配置，只在启用呈现压缩时向模型解释harness标记。
    const compressionEnabled = Object.assign({}, ...(yield* config.entries()).flatMap((entry) => entry.type === "document" ? [entry.info] : [])).tool_output?.bash_compression ?? true
    // Shell source 随实际执行配置刷新；持久快照比较和更新仍由 Session Context Epoch 处理。
    const shellContext = SystemContext.make({
      key: SystemContext.Key.make("core/shell"),
      codec: Schema.toCodecJson(Schema.String),
      load: config.entries().pipe(Effect.map(selectedShell)),
      // 与执行共用selectedShell，说明不再自行猜测POSIX或Windows默认值。
      baseline: (shell) => Shell.guidance(shell, process.platform),
      // 更新正文同样点名实际 shell，模型不能在换 shell 后继续使用旧的语法假设。
      // 换 shell 后同时更新链式/变量/编码语义，不能只替换显示名。
      update: (_previous, shell) => `The execution shell is now:\n${Shell.guidance(shell, process.platform)}`,
    })
    // 注册只提供上下文，不调用 tools.materialize，因此不创建另一个权限或执行 owner。
    // 注册身份独立于 core/builtins，重建或释放工具 Location 不会创建第二个环境 owner。
    yield* registry.register({ key: SystemContext.Key.make("core/shell"), load: Effect.succeed(shellContext) })

    yield* tools
      .register({
        [name]: Tool.make({
          // Shell副作用无法由参数穷举，按source显式声明ambient而非名称猜测。
          worktree: "ambient",
          // 专用工具存在性由 request.toolUsage 广告，本 description 不伪造固定工具列表。
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. Use workdir instead of changing directories inside the command. Verify a parent directory exists before creating files or directories, using available dedicated tools or the selected shell's native existence check. Prefer available dedicated tools for file operations. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the acceptable shell shown in system context, selected from configuration or the platform default. Follow the execution shell guidance supplied in system context. Independent commands may be separate calls in one response; dependent commands must use shell-native success conditions. Output supports UTF-8, UTF-16 and legacy codepage decoding; a bounded rolling preview keeps the latest output, including output observed before timeout. Observed raw bytes are retained when presentation changes. Repetitive output may be compacted according to the user's bash_compression setting. Use compress_output: false when exact raw formatting matters, including snapshots and text fixtures. Read the retained raw output for complete logs.` +
            (compressionEnabled ? " Short harness markers may appear inside compressed output; the command did not print them: `[... same line Nx]`, `[... repeated block Nx]`, `[... template repeated Nx]`, `[... progress N frames->final]`, `[... high-entropy <kind> <size>B head=...]` (oversized base64/JWT/hash lines), `[redacted ...]` (detected secrets; a short head is kept for identification). First occurrences and error lines are preserved; omitted content is intentionally dropped, not a failure to investigate." : ""),
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
            ...(output.compression === undefined ? {} : { compression: output.compression }),
            ...(output.interrupted === undefined ? {} : { interrupted: output.interrupted }),
            ...(output.durationMs === undefined ? {} : { durationMs: output.durationMs }),
            ...(output.diagnosticErrorLikeLines === undefined ? {} : { diagnosticErrorLikeLines: output.diagnosticErrorLikeLines }),
            ...(output.diagnosticWarningLikeLines === undefined ? {} : { diagnosticWarningLikeLines: output.diagnosticWarningLikeLines }),
            ...(output.diagnosticDiscardedChars === undefined ? {} : { diagnosticDiscardedChars: output.diagnosticDiscardedChars }),
            ...(output.commandAdaptation === undefined ? {} : { commandAdaptation: output.commandAdaptation }),
            ...(output.hasErrors === undefined ? {} : { hasErrors: output.hasErrors }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.contextOutput },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              // 配置只采样一次，兼容检查和最终 spawn 必须使用同一个实际 shell。
              const entries = yield* config.entries()
              const shell = selectedShell(entries)
              // 两道门禁与实际进程共享原生正文；源码事实由Core解析层提取，不再猜测改写Python。
              const remote = ShellRemote.ranges(input.command, Shell.name(shell))
              // Windows PowerShell 递归检查命令节点；解析失败不能退回浅层扫描，Tree 在检查后释放。
              const scan = Shell.name(shell) === "cmd" ? { patterns: [], raw: [], heads: [] } : yield* Effect.gen(function* () {
                    const tree = yield* Effect.acquireRelease(
                      Effect.tryPromise({
                        try: () => Shell.parse(input.command, Shell.ps(shell)),
                        catch: () => new ToolFailure({ message: `Unable to execute command: ${input.command}` }),
                      }),
                      (tree) => Effect.sync(() => tree.delete()),
                    )
                    // 引号化--会移动节点；remote范围与转义检查必须跟同一解析文本对齐。
                    const parsed = tree.rootNode.text
                    const parsedRemote = ShellRemote.ranges(parsed, Shell.name(shell))
                    const nodes = tree.rootNode
                      .descendantsOfType("command")
                      .filter((node) => {
                        if (!node) return false
                        if (parsedRemote.some((range) => range.start <= node.startIndex && node.startIndex < range.end)) return false
                        if (!Shell.ps(shell)) return true
                        // 引号与内部 ERROR 恢复出的远程脚本片段不是本地 PowerShell 命令。
                        let parent = node.parent
                        while (parent && parent.id !== tree.rootNode.id) {
                          if (parent.type === "ERROR" || parent.type.includes("string")) return false
                          parent = parent.parent
                        }
                        // 根 ERROR 仍承载真实主机命令，不能因此绕过本地管道的拒绝检查。
                        // grammar 会误拆已转义分隔符；奇数个反引号表示参数仍属前一命令。
                        const escaped = parsed.slice(0, node.startIndex).match(/(`+)[;|&][ \t]*$/)?.[1]
                        return !escaped || escaped.length % 2 === 0
                      })
                    // 同一棵AST同时提供规则键和原始拒绝证据；不改执行串或保存审批资源。
                    const commands = nodes.flatMap((node) => {
                      if (!node) return []
                      const tokens = ShellPermission.parts(node).map((part) => part.text)
                      return tokens.length ? [{ pattern: ShellPermission.permissionPattern(node, tokens), raw: ShellPermission.rawPattern(node) }] : []
                    })
                    return {
                      patterns: [...new Set(commands.map((command) => command.pattern))],
                      raw: [...new Set(commands.flatMap((command) => command.raw !== command.pattern ? [command.raw] : []))],
                      heads: nodes.flatMap((node) => node ? [...Shell.commandHeads(node.text, Shell.name(shell))] : []),
                    }
                  }).pipe(Effect.scoped)
              const heads = process.platform === "win32" && Shell.ps(shell) ? scan.heads : Shell.commandHeads(input.command, Shell.name(shell))
              const compatibility = Shell.compatibilityError(heads, Shell.name(shell))
              // 在目录授权和命令授权之前返回已有 ToolFailure，不执行任何进程。
              if (compatibility) return yield* new ToolFailure({ message: compatibility })
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  metadata: { action_kind: "shell", command: input.command, cwd: target.canonical, shell, agent: context.agent },
                  source,
                })
              // 路径提示只看宿主片段；掩去客体载荷时保持偏移和后续本地命令。
              const local = remote.reduce((text, range) => text.slice(0, range.start) + " ".repeat(range.end - range.start) + text.slice(range.end), input.command)
              const warnings = (yield* externalCommandDirectories(fs, local, target.canonical)).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                metadata: {
                  action_kind: "shell", command: input.command, cwd: target.canonical, shell, agent: context.agent,
                  // 只有leaf产生的AST证据参与规则匹配；原资源与save继续表示整条原始调用。
                  ...(scan.patterns.length && (scan.patterns.length !== 1 || scan.patterns[0] !== input.command) ? { canonical_patterns: scan.patterns } : {}),
                  // 原始拒绝证据仍来自同一AST，不再引入猜测改写后的audit正文。
                  ...(scan.raw.length ? { raw_patterns: scan.raw } : {}),
                },
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              // leaf 消费同一配置快照中的单次覆盖，全局 false 优先于单次 true，通用 store 不读取 Bash 开关。
              const configured = Object.assign({}, ...entries.flatMap((entry) => entry.type === "document" ? [entry.info.tool_output ?? {}] : []))
              const enabled = (configured.bash_compression ?? true) && (input.compress_output ?? true)
              // 诊断使用本次有效开关，opt-out 的样例不能预先被不可逆掩码。
              const diag = new BashDiagnosticCollector({ enabled })
              const decoder = createAutoTextDecoder({ encoding: configured.shell_encoding ?? "auto" })
              let commandForMatch = input.command.trim()
              while (true) {
                const match = commandForMatch.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/)
                if (!match) break
                commandForMatch = commandForMatch.slice(match[0].length).trimStart()
              }
              const useHead = /^(ls|dir|find|tree|git\s+(status|diff|log|ls-files))/.test(commandForMatch.toLowerCase())
              const parts: string[] = []
              let captured = 0
              let cut = false
              const observe = (text: string) => {
                // 诊断先观察全流；淘汰仅影响有界正文，原文字节仍由同一capture保留。
                diag.push(text)
                if (!text) return
                if (useHead) {
                  const bytes = Buffer.from(text)
                  let end = Math.min(bytes.length, Math.max(0, MAX_CAPTURE_BYTES - captured))
                  // 保留列表开头时也须在UTF-8边界截断，原始capture仍接收全部字节。
                  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
                  if (end > 0) parts.push(bytes.subarray(0, end).toString("utf8"))
                  captured += end
                  if (end < bytes.length) cut = true
                  return
                }
                parts.push(text)
                captured += Buffer.byteLength(text)
                for (let first = parts[0]; captured > MAX_CAPTURE_BYTES && first !== undefined; first = parts[0]) {
                  const bytes = Buffer.from(first)
                  let start = Math.min(bytes.length, captured - MAX_CAPTURE_BYTES)
                  // 从完整UTF-8字符开始展示，不能因窗口淘汰制造替换字符。
                  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
                  captured -= start
                  parts.shift()
                  if (start < bytes.length) parts.unshift(bytes.subarray(start).toString("utf8"))
                  cut = true
                }
              }
              const started = yield* Clock.currentTimeMillis
              const limits = yield* outputStore.limits()
              // 目录参数由 Location 解析并授权，实际进程只能使用已经确认的 canonical 目录。
              // 共用无profile的UTF-8 argv，原始命令仍是授权资源，执行与capture各只有一次。
              const invocation = Shell.cmd(shell, input.command)
              const command = ChildProcess.make(invocation.command, invocation.args, {
                cwd: target.canonical,
                shell: invocation.shell,
                // 完整过滤后关闭二次继承，避免spawner把worker身份重新补回。
                extendEnv: false,
                // 原生路径仍无插件hook；编码覆盖与其余宿主环境保持原有优先级。
                env: { ...sanitizedProcessEnv(), ...Shell.utf8Environment() },
                stdin: "ignore",
                detached: process.platform !== "win32",
                // 原生Bash scope退出同样按500ms升级，清理仍归现有AppProcess/spawner。
                forceKillAfter: Duration.millis(500),
              })
              // 标记最终交给AppProcess的对象，普通命令与非Windows继续原EOF合同。
              if (process.platform === "win32" && Shell.ps(shell)) WindowsShellOutput.mark(command)
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              let ended = false
              const finish = Effect.fnUntraced(function* (result?: AppProcess.RunResult, interrupted = false) {
              // 取消也可能发生在正常结果限幅期间；decoder/诊断尾块只能结束一次。
              if (!ended) {
                observe(decoder.end())
                diag.end()
                ended = true
              }
              const diagnostic = diag.snapshot()
              const durationMs = (yield* Clock.currentTimeMillis) - started

              // 正常结束和超时共用正文与压缩；超时不伪造退出码，也不丢弃已观察的ready等普通行。
              const text = parts.join("")
              const output = text || "(no output)"
              const normalized = process.platform === "win32" && Shell.ps(shell) ? normalizePowerShellOutput(output) : output
              const truncated = cut || result?.outputTruncated === true
              const outcome = interrupted ? { interrupted: true } : result ? { exit: result.exitCode } : { timeout: true }
              // 两代共用唯一outcome policy；READY和原文仍由原capture/finish保存。
              const executionNotice = formatShellExecutionNotice({
                shell: Shell.name(shell),
                aborted: interrupted, expired: !result && !interrupted,
                exitCode: result?.exitCode ?? null, emptyOutput: text.length === 0,
                timeoutMs: timeout, elapsedMs: durationMs,
              })
              const emptyTimeout = !result && !interrupted && !text ? "The process produced no output before timeout. This may indicate:\n- The command is block-buffering output (common for build tools like bun install, bundle install); consider adding --verbose or running with a larger timeout.\n- The process is waiting for interactive input; provide input or use a non-interactive flag.\n- The process is hung; check the command and environment." : undefined
              const command = input.command.trim().toLowerCase()
              const verification = /^(bun|npm|pnpm|yarn)\s+(run\s+)?(typecheck|test|build|lint|check|audit)(\s|$)/.test(command) || /^node\s+--check(\s|$)/.test(command) || /^python\s+-m\s+py_compile(\s|$)/.test(command) || /^tsc\s+--noemit(\s|$)/.test(command)
              const hasErrors = verification && ((result !== undefined && result.exitCode !== 0) || /error TS\d|SyntaxError|FAIL|Error:|✗/i.test(output))
              // 与V1复用无命令适配器的呈现入口，原始command只用于执行/授权。
              const compressed = compressVisibleOutput(normalized, { enabled })
              // 去重须计入退出状态；需要恢复标记时路径尚未发布，保守保留摘录。
              const diagnostics = renderDiagnosticAppendix(diagnostic, { durationMs, exitCode: result?.exitCode ?? null, visibleOutput: "", config: { enabled } })
              const projected = [compressed.text, emptyTimeout, diagnostics].filter(Boolean).join("\n\n") + modelOutput({ ...outcome, truncated, output, contextOutput: "", warnings, executionNotice })
              // 摘录放在正文末端进入既有 head/tail 预算，不在 leaf 复制通用截断。
              const visible = !compressed.stats.applied && !truncated && diagnostic.discardedChars === 0 && Buffer.byteLength(projected) <= limits.maxBytes && projected.split("\n").length <= limits.maxLines ? compressed.text : ""
              const appendix = renderDiagnosticAppendix(diagnostic, { durationMs, exitCode: result?.exitCode ?? null, visibleOutput: visible, config: { enabled } })
              const notice = truncated
                ? "[output capture truncated at the in-memory safety limit]"
                : undefined
              return {
                // 呈现变化即使没有净压缩也要求原文；既有 capture 与失败传播不变。
                retain: !result || truncated || (result.output !== undefined && !Buffer.from(text).equals(result.output)) || compressed.text !== output || compressed.stats.applied || compressed.stats.secretsRedacted > 0 || diagnostic.discardedChars > 0,
                value: {
                ...outcome,
                output: [output, notice, executionNotice].filter(Boolean).join("\n\n"),
                contextOutput: [compressed.text, notice, emptyTimeout, appendix].filter(Boolean).join("\n\n"),
                executionNotice,
                  // capture 损失由真实进程结果报告，不能把内存窗口当作完整输出文件承诺。
                truncated,
                compression: bashCompressionMetadata(compressed.stats),
                durationMs,
                diagnosticErrorLikeLines: diagnostic.errorLikeLines,
                diagnosticWarningLikeLines: diagnostic.warningLikeLines,
                diagnosticDiscardedChars: diagnostic.discardedChars,
                hasErrors,
                ...(warnings.length ? { warnings } : {}),
                },
              }
              })
              // 原文仍由同一 capture 保留；取消快照只提供领域内容，托管路径只由 registry 发布。
              return yield* outputStore.capture<Output, AppProcess.AppProcessError>({ sessionID: context.sessionID, toolCallID: context.toolCallID, direction: useHead ? "head" : "tail" }, (write) => appProcess.run(command, {
                combineOutput: true,
                timeout: Duration.millis(timeout),
                maxOutputBytes: MAX_CAPTURE_BYTES,
                // 单块原文写入与 decoder 观察一起完成，不能在两者之间取消而丢失刚读到的 READY。
                onOutput: (chunk) => write(chunk).pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: input.command, cause })),
                  Effect.andThen(Effect.sync(() => observe(decoder.write(chunk)))),
                  Effect.uninterruptible,
                ),
              }).pipe(
                Effect.catchTag("AppProcessError", (error) => isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error)),
                Effect.flatMap((result) => finish(result)),
              ), () => finish(undefined, true).pipe(Effect.map(({ value }) => ({
                structured: Schema.encodeSync(StructuredOutput)(value),
                content: [{ type: "text", text: value.contextOutput }, { type: "text", text: modelOutput(value) }],
              }))))
              // 兼容错误保留可纠正的具体文字，其余既有执行错误映射不变。
            }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? `Unable to execute command: ${input.command}`, error }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [ToolRegistry.node, ToolOutputStore.node, LocationMutation.node, FSUtil.node, AppProcess.node, Config.node, PermissionV2.node, SystemContextRegistry.node],
})

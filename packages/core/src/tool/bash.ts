export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
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

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
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
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

// 两代共用实际shell选择器；执行与环境指引不能分别回退cmd和PowerShell。
const selectedShell = (entries: readonly Config.Entry[]) =>
  Shell.acceptable(Object.assign({}, ...entries.flatMap((entry) => entry.type === "document" ? [entry.info] : [])).shell)

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timeout) return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command timed out before completion.`
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.`
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
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

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
    const permission = yield* PermissionV2.Service
    const registry = yield* SystemContextRegistry.Service
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
          // 专用工具存在性由 request.toolUsage 广告，本 description 不伪造固定工具列表。
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. Use workdir instead of changing directories inside the command. Verify a parent directory exists before creating files or directories, using available dedicated tools or the selected shell's native existence check. Prefer available dedicated tools for file operations. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the acceptable shell shown in system context, selected from configuration or the platform default. Follow the execution shell guidance supplied in system context. Independent commands may be separate calls in one response; dependent commands must use shell-native success conditions. Output is decoded as UTF-8 and may lose data at the process capture limit.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              // 配置只采样一次，兼容检查和最终 spawn 必须使用同一个实际 shell。
              const entries = yield* config.entries()
              const shell = selectedShell(entries)
              // Windows PowerShell 递归检查命令节点；解析失败不能退回浅层扫描，Tree 在检查后释放。
              const heads = process.platform === "win32" && Shell.ps(shell)
                ? yield* Effect.gen(function* () {
                    const tree = yield* Effect.acquireRelease(
                      Effect.tryPromise({
                        try: () => Shell.parse(input.command, true),
                        catch: () => new ToolFailure({ message: `Unable to execute command: ${input.command}` }),
                      }),
                      (tree) => Effect.sync(() => tree.delete()),
                    )
                    return tree.rootNode
                      .descendantsOfType("command")
                      .flatMap((node) => {
                        if (!node) return []
                        // grammar 会误拆已转义分隔符；奇数个反引号表示参数仍属前一命令。
                        const escaped = input.command.slice(0, node.startIndex).match(/(`+)[;|&][ \t]*$/)?.[1]
                        return escaped && escaped.length % 2 ? [] : [...Shell.commandHeads(node.text, Shell.name(shell))]
                      })
                  }).pipe(Effect.scoped)
                : Shell.commandHeads(input.command, Shell.name(shell))
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
                  source,
                })
              const warnings = (yield* externalCommandDirectories(fs, input.command, target.canonical)).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              // 目录参数由 Location 解析并授权，实际进程只能使用已经确认的 canonical 目录。
              const powershell = process.platform === "win32" && Shell.ps(shell)
              // 与V1同样禁用PowerShell profile和交互；仍只创建一个命令并调用一次AppProcess.run。
              const command = ChildProcess.make(powershell ? shell : input.command,
                powershell ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command] : [], {
                cwd: target.canonical,
                shell: powershell ? false : shell,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const result = yield* appProcess
                .run(command, {
                  combineOutput: true,
                  timeout: Duration.millis(timeout),
                  maxOutputBytes: MAX_CAPTURE_BYTES,
                })
                .pipe(
                  Effect.catchTag("AppProcessError", (error) =>
                    isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                  ),
                )
              if (!result) {
                return {
                  output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                  truncated: false,
                  timeout: true,
                  ...(warnings.length ? { warnings } : {}),
                }
              }

              const output = result.output?.toString("utf8") || "(no output)"
              const notice = result.outputTruncated
                ? "[output capture truncated at the in-memory safety limit]"
                : undefined
              return {
                exit: result.exitCode,
                output: notice ? `${output}\n\n${notice}` : output,
                  // capture 损失由真实进程结果报告，不能把内存窗口当作完整输出文件承诺。
                truncated: result.outputTruncated === true,
                ...(warnings.length ? { warnings } : {}),
              }
              // 兼容错误保留可纠正的具体文字，其余既有执行错误映射不变。
            }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to execute command: ${input.command}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, AppProcess.node, Config.node, PermissionV2.node, SystemContextRegistry.node],
})

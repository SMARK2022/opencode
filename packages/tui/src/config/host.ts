export * as TuiConfigHost from "./host"

import path from "path"
import { fileURLToPath } from "node:url"
import { Cause, Effect } from "effect"
import { mergeDeep } from "remeda"
import { ConfigParse } from "@opencode-ai/core/config/parse"
import { ConfigPaths } from "@opencode-ai/core/config/paths"
import { ConfigVariable } from "@opencode-ai/core/config/variable"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { TuiConfig } from "."
import { TuiKeybind } from "./keybind"
import { isRecord } from "../util/record"
import type { VoiceTranscriber } from "../prompt-voice-input"

export const DefaultVoiceTranscriber = {
  // 默认CLI和MCP推导共用字面量argv，配置阶段不启动转写器或解释shell。
  command: "chatgpt-browser-agent",
  args: ["transcribe-file", "--file", "{file}", "--json"],
}
// 无实体文件的内容配置保留argv；有文件时来源决定用户级写回或项目级仅内存。
// 两个host携带来源而不各自实现凭据存储，raw auth仍由唯一reader/writer维护。
type VoiceTranscriberSource = { filepath?: string; scope: "user" | "project" }

export const parse = Effect.fn("TuiConfigHost.parse")(function* (text: string, filepath: string) {
  const expanded = yield* Effect.promise(() =>
    ConfigVariable.substitute({ text, type: "path", path: filepath, missing: "empty" }),
  )
  const raw = ConfigParse.jsonc(expanded, filepath)
  if (!isRecord(raw)) return {}
  // 保持旧tui包装展开规则：外层同名设置覆盖内层，而不是新增一层配置语义。
  const { tui, ...outer } = raw
  const data = { ...(isRecord(tui) ? tui : {}), ...outer }
  const invalid = isRecord(data.keybinds) ? TuiKeybind.unknownKeys(data.keybinds) : []
  if (isRecord(data.keybinds) && invalid.length) {
    data.keybinds = Object.fromEntries(Object.entries(data.keybinds).filter(([key]) => !invalid.includes(key)))
  }
  const parsed = ConfigParse.schema(TuiConfig.Info, data, filepath)
  if (!parsed.attention?.sounds) return parsed
  // 声音路径仍相对所属配置文件，不能因Native从项目cwd启动而漂移。
  return {
    ...parsed,
    attention: {
      ...parsed.attention,
      sounds: Object.fromEntries(Object.entries(parsed.attention.sounds).flatMap(([name, file]) => {
        if (!file) return []
        return [[name, file.startsWith("file://") ? fileURLToPath(file) : path.resolve(path.dirname(filepath), file)]]
      })),
    },
  }
})

function voiceTranscriberFromMcpConfig(input: unknown, cwd: string, source: VoiceTranscriberSource): VoiceTranscriber | undefined {
  if (!isRecord(input) || !isRecord(input.mcp)) return
  // 仅投影两种原始MCP布局；flat同名优先，不能将lower结果写回配置或引入Legacy依赖。
  const servers = { ...(isRecord(input.mcp.servers) ? input.mcp.servers : {}), ...input.mcp }
  for (const [key, server] of Object.entries(servers)) {
    // 只有明确命名的本地ChatGPT服务是转写载体，普通MCP与远程配置不参与推导。
    if (!key.toLowerCase().includes("chatgpt") || !isRecord(server)) continue
    if (server.enabled === false || server.disabled === true || (server.type !== undefined && server.type !== "local")) continue
    if (!Array.isArray(server.command)) continue
    const command = server.command.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    const mcpServer = command.find((item) => path.basename(item).toLowerCase() === "mcp-server.js")
    if (!mcpServer || !command[0]) continue
    // 与原本地MCP一致，相对脚本以项目目录解析，不以配置文件目录解析。
    const resolved = path.isAbsolute(mcpServer) ? mcpServer : path.resolve(cwd, mcpServer)
    // 直接执行mcp-server.js仍沿shebang使用node，同一argv供显式配置和直连失败回退。
    const interpreter = path.basename(command[0]).toLowerCase() === "mcp-server.js" ? "node" : command[0]
    const script = path.join(path.dirname(resolved), "chatgpt.js")
    const argv = { command: interpreter, args: [script, "transcribe-file", "--file", "{file}", "--json"] }
    // 内容源没有auth写回落点，不因引入direct改变其原argv产品语义。
    if (!source.filepath) return argv
    // project/user只决定凭据存储范围，不改变录音、会话agent或聊天模型选择。
    return { type: "chatgpt-direct", config: source.filepath, key, interpreter, script, scope: source.scope, transcriber: argv }
  }
}

export const loadMcpVoiceTranscriber = Effect.fn("TuiConfigHost.loadMcpVoiceTranscriber")(function* (
  sources: { file: string; scope: "user" | "project" }[], cwd: string,
) {
  const fs = yield* FSUtil.Service
  let result: VoiceTranscriber | undefined
  for (const source of sources) {
    const filepath = source.file
    const transcriber = yield* Effect.gen(function* () {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: filepath, missing: "empty" }),
      )
      const value = voiceTranscriberFromMcpConfig(ConfigParse.jsonc(expanded, filepath), cwd, { filepath, scope: source.scope })
      const script = value?.type === "chatgpt-direct" ? value.script : value?.args?.[0]
      // 缺失脚本不覆盖前一个有效配置；默认CLI仍由同一controller在录音前校验。
      if (!script || !(yield* fs.existsSafe(script))) return
      return value
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("skipping invalid mcp config while resolving voice transcriber", {
      path: filepath, reason: Cause.squash(cause),
    }).pipe(Effect.as(undefined))))
    result = transcriber ?? result
  }
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    result = voiceTranscriberFromMcpConfig(
      ConfigParse.jsonc(process.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT"), cwd, { scope: "project" },
    ) ?? result
  }
  return result
})

export const load = Effect.fn("TuiConfigHost.load")(function* (directory: string, options: TuiConfig.ResolveOptions) {
  const fs = yield* FSUtil.Service
  const directories = yield* ConfigPaths.directories(directory)
  const dirs = directories.filter((dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)
  const projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", directory)
  const projectMcpFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("opencode", directory)
  // 与旧host保持同一优先级；此入口只读配置，不迁移文件或安装插件。
  const files = [
    ...ConfigPaths.fileInDirectory(Global.Path.config, "tui"),
    ...(Flag.OPENCODE_TUI_CONFIG ? [Flag.OPENCODE_TUI_CONFIG] : []),
    ...projectFiles,
    ...dirs.flatMap((dir) => ConfigPaths.fileInDirectory(dir, "tui")),
  ]
  let result: TuiConfig.Info = {}
  for (const filepath of files) {
    const data = yield* Effect.gen(function* () {
      const text = yield* fs.readFileStringSafe(filepath)
      return text ? yield* parse(text, filepath) : {}
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("skipping invalid tui config", {
      path: filepath, reason: Cause.squash(cause),
    }).pipe(Effect.as({}))))
    result = mergeDeep(result, data)
  }
  const transcriber = yield* loadMcpVoiceTranscriber([
    ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode").map(file => ({ file, scope: "user" as const })),
    ...(Flag.OPENCODE_CONFIG ? [{ file: Flag.OPENCODE_CONFIG, scope: "user" as const }] : []),
    ...projectMcpFiles.map(file => ({ file, scope: "project" as const })),
    ...dirs.flatMap(dir => ConfigPaths.fileInDirectory(dir, "opencode").map(file => ({ file, scope: (dir === Flag.OPENCODE_CONFIG_DIR ? "user" : "project") as "user" | "project" }))),
  ], directory)
  // 显式TUI设置优先于MCP推导和默认CLI，两代最后均交同一个canonical resolve。
  return TuiConfig.resolve({
    ...result,
    voice: { ...result.voice, transcriber: result.voice?.transcriber ?? transcriber ?? DefaultVoiceTranscriber },
  }, options)
})

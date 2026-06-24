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

export const DefaultVoiceTranscriber = {
  // 默认CLI和MCP推导共用字面量argv，配置阶段不启动转写器或解释shell。
  command: "chatgpt-browser-agent",
  args: ["transcribe-file", "--file", "{file}", "--json"],
}
type VoiceTranscriber = NonNullable<TuiConfig.Info["voice"]>["transcriber"]

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

function voiceTranscriberFromMcpConfig(input: unknown, cwd: string): VoiceTranscriber {
  if (!isRecord(input) || !isRecord(input.mcp)) return
  for (const [key, server] of Object.entries(input.mcp)) {
    // 只有明确命名的本地ChatGPT服务是转写载体，普通MCP与远程配置不参与推导。
    if (!key.toLowerCase().includes("chatgpt") || !isRecord(server)) continue
    if (server.enabled === false || (server.type !== undefined && server.type !== "local")) continue
    if (!Array.isArray(server.command)) continue
    const command = server.command.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    const mcpServer = command.find((item) => path.basename(item).toLowerCase() === "mcp-server.js")
    if (!mcpServer || !command[0]) continue
    // 与原本地MCP一致，相对脚本以项目目录解析，不以配置文件目录解析。
    const resolved = path.isAbsolute(mcpServer) ? mcpServer : path.resolve(cwd, mcpServer)
    return {
      // 直接执行 mcp-server.js 时没有显式解释器；沿用 shebang 依赖的 node 运行同目录 chatgpt.js。
      command: path.basename(command[0]).toLowerCase() === "mcp-server.js" ? "node" : command[0],
      args: [path.join(path.dirname(resolved), "chatgpt.js"), "transcribe-file", "--file", "{file}", "--json"],
    }
  }
}

export const loadMcpVoiceTranscriber = Effect.fn("TuiConfigHost.loadMcpVoiceTranscriber")(function* (
  files: string[], cwd: string,
) {
  const fs = yield* FSUtil.Service
  let result: VoiceTranscriber
  for (const filepath of files) {
    const transcriber = yield* Effect.gen(function* () {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: filepath, missing: "empty" }),
      )
      const value = voiceTranscriberFromMcpConfig(ConfigParse.jsonc(expanded, filepath), cwd)
      const script = value?.args?.[0]
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
      ConfigParse.jsonc(process.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT"), cwd,
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
    ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
    ...(Flag.OPENCODE_CONFIG ? [Flag.OPENCODE_CONFIG] : []),
    ...projectMcpFiles,
    ...dirs.flatMap((dir) => ConfigPaths.fileInDirectory(dir, "opencode")),
  ], directory)
  // 显式TUI设置优先于MCP推导和默认CLI，两代最后均交同一个canonical resolve。
  return TuiConfig.resolve({
    ...result,
    voice: { ...result.voice, transcriber: result.voice?.transcriber ?? transcriber ?? DefaultVoiceTranscriber },
  }, options)
})

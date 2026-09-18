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

export const load = Effect.fn("TuiConfigHost.load")(function* (directory: string, options: TuiConfig.ResolveOptions) {
  const fs = yield* FSUtil.Service
  const directories = yield* ConfigPaths.directories(directory)
  const dirs = directories.filter((dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)
  const projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", directory)
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
  // 两代host仅解析界面设置，用户MCP和凭据选择由同一后端事务承担。
  return TuiConfig.resolve(result, options)
})

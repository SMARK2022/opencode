export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Fiber, Layer } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@opencode-ai/tui/util/record"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CurrentWorkingDirectory } from "./tui-cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@opencode-ai/core/npm"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@opencode-ai/tui/config"

const DefaultVoiceTranscriber = {
  // 默认值只假设用户通过安装脚本能找到 browser-agent CLI；显式 MCP 路径会在后面覆盖它。
  command: "chatgpt-browser-agent",
  // `{file}` 保留给 prompt-voice-input 做 argv 字面量替换，不在配置层拼接 shell 字符串。
  args: ["transcribe-file", "--file", "{file}", "--json"],
}

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info
type VoiceTranscriber = NonNullable<NonNullable<Info["voice"]>["transcriber"]>

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = TuiConfig.Resolved

export type HostMetadata = {
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly pluginOrigins: () => Effect.Effect<ConfigPlugin.Origin[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TuiConfig") {}

function pluginScope(file: string, ctx: { directory: string }): ConfigPlugin.Scope {
  if (Filesystem.contains(ctx.directory, file)) return "local"
  // if (ctx.worktree !== "/" && Filesystem.contains(ctx.worktree, file)) return "local"
  return "global"
}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

function voiceTranscriberFromMcpConfig(input: unknown, cwd: string): VoiceTranscriber | undefined {
  if (!isRecord(input) || !isRecord(input.mcp)) return
  for (const [key, server] of Object.entries(input.mcp)) {
    // 只复用名称明确包含 chatgpt 的 MCP 配置，避免把其它本地 MCP server 误当成语音后端。
    if (!key.toLowerCase().includes("chatgpt")) continue
    if (!isRecord(server)) continue
    // disabled 或非 local server 不代表本机存在 chatgpt.js，不能作为默认转写器来源。
    if (server.enabled === false) continue
    if (server.type !== undefined && server.type !== "local") continue
    if (!Array.isArray(server.command)) continue
    // command 是 MCP 启动 argv；这里只读取字面量数组，不解析 shell，也不执行任何命令。
    const command = server.command.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    const mcpServer = command.find((item) => path.basename(item).toLowerCase() === "mcp-server.js")
    if (!mcpServer || !command[0]) continue
    // 相对路径按当前项目目录解析，保持和本地 MCP 配置文件里的路径语义一致。
    const resolved = path.isAbsolute(mcpServer) ? mcpServer : path.resolve(cwd, mcpServer)
    return {
      command: command[0],
      // voice 默认只复用 ChatGPT MCP 同目录的 CLI 入口；不注册 MCP tool，也不要求 chatgpt-browser-agent 在 PATH。
      args: [path.join(path.dirname(resolved), "chatgpt.js"), "transcribe-file", "--file", "{file}", "--json"],
    }
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  let appliedOrder = 0

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      return {
        ...config,
        plugin: yield* Effect.forEach(plugins, (plugin) =>
          Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugin as ConfigPlugin.Origin["spec"], configFilepath)),
        ),
      }
    })

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old opencode.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data))
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid tui config", {
          path: configFilepath,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read tui config", {
            path: filepath,
            reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!text) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const loadMcpVoiceTranscriberFile = (filepath: string): Effect.Effect<VoiceTranscriber | undefined> =>
    Effect.gen(function* () {
      // MCP 配置缺失是正常情况；这里只是寻找更精确的 ChatGPT agent 安装位置。
      const text = yield* afs.readFileStringSafe(filepath).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!text) return
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: filepath, missing: "empty" }),
      )
      const transcriber = voiceTranscriberFromMcpConfig(ConfigParse.jsonc(expanded, filepath), ctx.directory)
      if (!transcriber) return
      const script = transcriber.args?.[0]
      // 推导出的 chatgpt.js 必须存在，否则保留默认 CLI，让 controller 在录音前给出更清晰的配置错误。
      if (!script || !(yield* afs.existsSafe(script))) return
      return transcriber
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          yield* Effect.logWarning("skipping invalid mcp config while resolving voice transcriber", { path: filepath, reason })
          return undefined
        }),
      ),
    )

  const loadMcpVoiceTranscriber = (files: string[]): Effect.Effect<VoiceTranscriber | undefined> =>
    Effect.gen(function* () {
      let result: VoiceTranscriber | undefined
      for (const file of files) result = (yield* loadMcpVoiceTranscriberFile(file)) ?? result
      if (process.env.OPENCODE_CONFIG_CONTENT) {
        result = voiceTranscriberFromMcpConfig(
          ConfigParse.jsonc(process.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT"),
          ctx.directory,
        ) ?? result
      }
      return result
    })

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = pluginScope(file, ctx)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec: spec as ConfigPlugin.Origin["spec"], scope, source: file })),
      ])
      acc.result = {
        ...acc.result,
        plugin: plugins.map((item) => item.spec),
      }
      acc.plugin_origins = plugins
    })

  // Every config dir we may read from: global config dir, any `.opencode`
  // folders between cwd and home, and OPENCODE_CONFIG_DIR.
  const directories = yield* ConfigPaths.directories(ctx.directory)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)
  const projectOpencodeFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("opencode", ctx.directory)

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit OPENCODE_TUI_CONFIG override, if set.
  if (Flag.OPENCODE_TUI_CONFIG) {
    const configFile = Flag.OPENCODE_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    yield* Effect.logDebug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 4. `.opencode` directories (and OPENCODE_CONFIG_DIR) discovered while
  // walking up the tree. Also returned below so callers can install plugin
  // dependencies from each location.
  const dirs = unique(directories).filter((dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)

  for (const dir of dirs) {
    if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  const defaultVoiceTranscriber =
    // 这里读取 opencode MCP 配置而不是 tui.json，复用用户已经安装好的 ChatGPT browser-agent 载体。
    (yield* loadMcpVoiceTranscriber([
      ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
      ...(Flag.OPENCODE_CONFIG ? [Flag.OPENCODE_CONFIG] : []),
      ...projectOpencodeFiles,
      ...dirs.flatMap((dir) => ConfigPaths.fileInDirectory(dir, "opencode")),
    ])) ?? DefaultVoiceTranscriber

  const result = TuiConfig.resolve(
    {
      ...acc.result,
      // 默认只绑定到 browser-agent 的稳定 CLI 子命令，不把 ChatGPT DOM/HTTP 细节放进 TUI。
      // 用户仍可用 tui.json 覆盖为任意 argv 转写器；`{file}` 占位由 prompt-voice-input 做安全校验。
      voice: {
        ...acc.result.voice,
        // 显式 tui.voice.transcriber 优先；MCP 推导和固定默认值只填补未配置场景。
        transcriber: acc.result.voice?.transcriber ?? defaultVoiceTranscriber,
      },
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )

  return {
    config: result,
    pluginOrigins: acc.plugin_origins,
    dirs: result.plugin?.length ? dirs : [],
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    const deps = yield* Effect.forEach(
      data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@opencode-ai/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const pluginOrigins = Effect.fn("TuiConfig.pluginOrigins")(() => Effect.succeed(data.pluginOrigins))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, pluginOrigins, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(Npm.defaultLayer), Layer.provide(FSUtil.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}

export async function pluginOrigins() {
  return runPromise((svc) => svc.pluginOrigins())
}

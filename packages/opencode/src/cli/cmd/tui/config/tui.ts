export * as TuiConfig from "./tui"

import path from "path"
import { createBindingLookup } from "@opentui/keymap/extras"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { KeymapLeaderTimeoutDefault, resolveAttentionSoundPaths, TuiInfo } from "./tui-schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@/util/record"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CurrentWorkingDirectory } from "./cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "./keybind"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@opencode-ai/core/npm"
import type { DeepMutable } from "@opencode-ai/core/schema"
import type { TuiAttentionSoundName } from "@opencode-ai/plugin/tui"
import { FormatError, FormatUnknownError } from "@/cli/error"
import type { VoiceTranscriber } from "../prompt-voice-input"

const log = Log.create({ service: "tui.config" })

const DefaultVoiceTranscriber = {
  // 默认值只假设用户通过安装脚本能找到 browser-agent CLI；显式 MCP 路径会在后面覆盖它。
  command: "chatgpt-browser-agent",
  // `{file}` 保留给 prompt-voice-input 做 argv 字面量替换，不在配置层拼接 shell 字符串。
  args: ["transcribe-file", "--file", "{file}", "--json"],
}

export const Info = TuiInfo
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout" | "voice"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: Partial<Record<TuiAttentionSoundName, string>>
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  // 解析后的 transcriber 是 argv|chatgpt-direct 联合：用户显式配置只能是 argv（schema 限制），
  // direct 变体仅由 MCP 推导产生并内嵌回退 argv。保持可选以兼容不关心语音的测试 fixture。
  voice?: { transcriber?: VoiceTranscriber }
  // Internal resolved plugin list used by runtime loading.
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
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

function dropUnknownKeybinds(input: Record<string, unknown>, configFilepath: string) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  log.warn("ignored unknown tui keybinds", {
    path: configFilepath,
    keybinds: invalid,
    hint: "Remove these entries or rename them to keys from the tui.json schema.",
  })
  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

function voiceTranscriberFromMcpConfig(
  input: unknown,
  cwd: string,
  source: { filepath?: string; scope: "user" | "project" },
): VoiceTranscriber | undefined {
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
    // 直接执行 mcp-server.js 时没有显式解释器；沿用 shebang 依赖的 node 运行同目录 chatgpt.js。
    const interpreter = path.basename(command[0]).toLowerCase() === "mcp-server.js" ? "node" : command[0]
    const script = path.join(path.dirname(resolved), "chatgpt.js")
    const argv: { command: string; args: string[] } = { command: interpreter, args: [script, "transcribe-file", "--file", "{file}", "--json"] }
    // OPENCODE_CONFIG_CONTENT 没有可写回的文件：保留旧 argv 形态（配置源域的合法分支）。
    if (!source.filepath) return argv
    // 有实体配置文件时产出 direct 变体：内嵌同一 argv 供直连失败后的用户批准回退。
    return { type: "chatgpt-direct", config: source.filepath, key, interpreter, script, scope: source.scope, transcriber: argv }
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* AppFileSystem.Service
  let appliedOrder = 0

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      for (let i = 0; i < plugins.length; i++) {
        plugins[i] = yield* Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugins[i], configFilepath))
      }
      return config
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
      const normalized = dropUnknownKeybinds(normalize(data), configFilepath)
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid tui config", {
            path: configFilepath,
            reason,
          })
          return {} as Info
        }),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            const reason = FormatError(error) ?? FormatUnknownError(error)
            log.warn("failed to read tui config", {
              path: filepath,
              reason,
            })
            return undefined
          }),
        ),
      )
      if (!text) return {} as Info
      log.info("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const loadMcpVoiceTranscriberFile = (file: string, scope: "user" | "project"): Effect.Effect<VoiceTranscriber | undefined> =>
    Effect.gen(function* () {
      // MCP 配置缺失是正常情况；这里只是寻找更精确的 ChatGPT agent 安装位置。
      const text = yield* afs.readFileStringSafe(file).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!text) return
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: file, missing: "empty" }),
      )
      const transcriber = voiceTranscriberFromMcpConfig(ConfigParse.jsonc(expanded, file), ctx.directory, { filepath: file, scope })
      if (!transcriber) return
      // 推导出的 chatgpt.js 必须存在，否则保留默认 CLI，让 controller 在录音前给出更清晰的配置错误。
      const script = transcriber.type === "chatgpt-direct" ? transcriber.script : transcriber.args?.[0]
      if (!script || !(yield* afs.existsSafe(script))) return
      return transcriber
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid mcp config while resolving voice transcriber", { path: file, reason })
          return undefined
        }),
      ),
    )

  const loadMcpVoiceTranscriber = (sources: { file: string; scope: "user" | "project" }[]): Effect.Effect<VoiceTranscriber | undefined> =>
    Effect.gen(function* () {
      let result: VoiceTranscriber | undefined
      for (const source of sources) result = (yield* loadMcpVoiceTranscriberFile(source.file, source.scope)) ?? result
      if (process.env.OPENCODE_CONFIG_CONTENT) {
        result = voiceTranscriberFromMcpConfig(
          ConfigParse.jsonc(process.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT"),
          ctx.directory,
          // 无实体文件：保留 argv 形态，auth 节点无处写回。
          { scope: "project" },
        ) ?? result
      }
      return result
    })

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        log.info("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = pluginScope(file, ctx)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec, scope, source: file })),
      ])
      acc.result.plugin = plugins.map((item) => item.spec)
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
    log.debug("loaded custom tui config", { path: configFile })
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
    // scope 判定：全局 config / OPENCODE_CONFIG / OPENCODE_CONFIG_DIR 是用户级（auth 可写回）；
    // project 文件与 .opencode 目录受版本管理，凭据只驻内存（R4 统一）。
    (yield* loadMcpVoiceTranscriber([
      ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode").map((file) => ({ file, scope: "user" as const })),
      ...(Flag.OPENCODE_CONFIG ? [{ file: Flag.OPENCODE_CONFIG, scope: "user" as const }] : []),
      ...projectOpencodeFiles.map((file) => ({ file, scope: "project" as const })),
      ...dirs.flatMap((dir) =>
        ConfigPaths.fileInDirectory(dir, "opencode").map((file) => ({
          file,
          scope: (dir === Flag.OPENCODE_CONFIG_DIR ? "user" : "project") as "user" | "project",
        })),
      ),
    ])) ?? DefaultVoiceTranscriber

  const keybinds = { ...acc.result.keybinds }
  if (process.platform === "win32") {
    // Native Windows terminals do not support POSIX suspend, so prefer prompt undo.
    keybinds.terminal_suspend = "none"
    const inputUndo = TuiKeybind.defaultValue("input_undo")
    keybinds.input_undo ??= unique(["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]).join(",")
  }
  if (process.platform === "darwin") {
    // macOS 终端里 Option/Alt 常被当作文本输入，Ctrl+Shift+字母也可能退化成 Ctrl+字母；F8 避开粘贴键和既有 Ctrl+R。
    // 只在用户未配置 prompt_voice_toggle 时填默认值，避免破坏已有自定义 keybind。
    keybinds.prompt_voice_toggle ??= "f8"
  }
  const parsedKeybinds = TuiKeybind.parse(keybinds)
  const result: Resolved = {
    ...acc.result,
    attention: {
      enabled: acc.result.attention?.enabled ?? true,
      notifications: acc.result.attention?.notifications ?? true,
      sound: acc.result.attention?.sound ?? true,
      // 默认音量 0.5：经 BS.1770 响度分析，内嵌 done 音效在此增益下
      // stereo 综合响度约 -27.8 LUFS、true peak 约 -13.9 dBTP，
      // 与 macOS 系统提示音（Pop -29 LUFS、Ping -28.8 LUFS）同区间偏轻，
      // 既有足够提醒力又不至于在频繁触发时形成听觉疲劳。
      // 0.4 偏轻（约 -29.7 LUFS），0.6+ 会比多数系统提示音更突出。
      volume: acc.result.attention?.volume ?? 0.5,
      sound_pack: acc.result.attention?.sound_pack ?? "opencode.default",
      sounds: acc.result.attention?.sounds ?? {},
    },
    // 默认只绑定到 browser-agent 的稳定 CLI 子命令，不把 ChatGPT DOM/HTTP 细节放进 TUI。
    // 用户仍可用 tui.json 覆盖为任意 argv 转写器；`{file}` 占位由 prompt-voice-input 做安全校验。
    voice: {
      ...acc.result.voice,
      // 显式 tui.voice.transcriber 优先；MCP 推导和固定默认值只填补未配置场景。
      transcriber: acc.result.voice?.transcriber ?? defaultVoiceTranscriber,
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(parsedKeybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: acc.result.leader_timeout ?? KeymapLeaderTimeoutDefault,
    plugin_origins: acc.plugin_origins.length ? acc.plugin_origins : undefined,
  }

  return {
    config: result,
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

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(Npm.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}

import { spyOn } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { awaitWithTimeout } from "../lib/effect"
import { resolve, type Info, type Resolved } from "@opencode-ai/tui/config"
import { TuiConfig } from "../../src/config/tui"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"

type PluginSpec = string | [string, Record<string, unknown>]
type PluginOrigin = {
  spec: PluginSpec
  scope: "global" | "local"
  source: string
}
type HostResolved = Resolved & { plugin_origins?: PluginOrigin[] }
type ResolvedInput = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention?: Partial<Resolved["attention"]>
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader_timeout?: number
  plugin_origins?: PluginOrigin[]
}

export function createTuiResolvedKeybinds(input: Partial<TuiKeybind.Keybinds> = {}): Resolved["keybinds"] {
  return resolve({ keybinds: input }, { terminalSuspend: process.platform !== "win32" }).keybinds
}

export function createTuiResolvedConfig(input: ResolvedInput = {}): HostResolved {
  return {
    ...resolve(input, { terminalSuspend: process.platform !== "win32" }),
    plugin_origins: input.plugin_origins,
  }
}

export function mockTuiRuntime(dir: string, plugin: PluginSpec[], opts?: { plugin_enabled?: Record<string, boolean> }) {
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(dir, "plugin-meta.json")
  const plugin_origins = plugin.map((spec) => ({
    spec,
    scope: "local" as const,
    source: path.join(dir, "tui.json"),
  }))
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => dir)

  const config = createTuiResolvedConfig({
    plugin,
    plugin_origins,
    ...(opts?.plugin_enabled && { plugin_enabled: opts.plugin_enabled }),
  })

  return {
    config,
    restore: () => {
      cwd.mockRestore()
      wait.mockRestore()
      delete process.env.OPENCODE_PLUGIN_META_FILE
    },
  }
}

// 测试断言完整外部状态时等真实任务完成，不能通过 file 特例让生产首屏重新 await。
export async function waitForTuiPlugins() {
  const { TuiPluginRuntime } = await import("../../src/plugin/tui/runtime")
  // deadline 只检出任务卡住，不用固定 sleep 猜测 import/install/init 的耗时。
  await Effect.runPromise(
    awaitWithTimeout(
      Effect.promise(() => TuiPluginRuntime.ready()),
      "TUI plugins did not finish loading",
      "5 seconds",
    ),
  )
}

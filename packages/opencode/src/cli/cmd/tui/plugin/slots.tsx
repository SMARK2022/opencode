import type { TuiPluginApi, TuiSlotContext, TuiSlotMap, TuiSlotProps } from "@opencode-ai/plugin/tui"
import { createSlot, createSolidSlotRegistry, useRenderer, type JSX, type SolidPlugin } from "@opentui/solid"
import { isRecord } from "@/util/record"

type RuntimeSlotMap = TuiSlotMap<Record<string, object>>

type Slot = <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
export type HostSlotPlugin<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type HostPluginApi = TuiPluginApi
export type HostSlots = {
  register: {
    (plugin: HostSlotPlugin): () => void
    <Slots extends Record<string, object>>(plugin: HostSlotPlugin<Slots>): () => void
  }
  dispose: () => void
}

function empty<Name extends string>(_props: TuiSlotProps<Name>) {
  return null
}

let view: Slot = empty
let renderer: HostPluginApi["renderer"] | undefined

export const Slot: Slot = (props) => {
  const current = useRenderer()
  // Slot 是 runtime 单例入口，但测试和嵌入式调用可能在同一进程内并发创建多个
  // renderer。只允许创建该 slot registry 的 renderer 使用它，避免一个 TUI 实例
  // 的插件 fallback/鼠标区域泄漏到另一个未初始化插件 runtime 的渲染树。
  if (renderer && current !== renderer) return empty(props)
  return view(props)
}

function isHostSlotPlugin(value: unknown): value is HostSlotPlugin<Record<string, object>> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  if (!isRecord(value.slots)) return false
  return true
}

export function setupSlots(api: HostPluginApi): HostSlots {
  const reg = createSolidSlotRegistry<RuntimeSlotMap, TuiSlotContext>(
    api.renderer,
    {
      theme: api.theme,
    },
    {
      onPluginError(event) {
        console.error("[tui.slot] plugin error", {
          plugin: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          source: event.source,
          message: event.error.message,
        })
      },
    },
  )

  const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props)
  renderer = api.renderer
  const current = view
  const currentRenderer = renderer
  return {
    register(plugin: HostSlotPlugin) {
      if (!isHostSlotPlugin(plugin)) return () => {}
      return reg.register(plugin)
    },
    dispose() {
      // TUI 插件 runtime 是单例，Slot 视图同样是模块级全局入口。
      // dispose 后必须恢复 no-op，否则后续未初始化 runtime 的测试/实例会继续渲染上一轮
      // slot registry 的 fallback children，改变会话布局并泄漏上一轮 renderer 上下文。
      if (view !== current || renderer !== currentRenderer) return
      view = empty
      renderer = undefined
    },
  }
}

import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { extend, type JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { SpinnerRenderable } from "opentui-spinner"

// 显式注册 <spinner> intrinsic。opentui-spinner/solid 原本通过裸副作用导入
// (import "opentui-spinner/solid") 调用 extend 完成注册，但在 Bun --compile
// + splitting 产物中，该副作用落在独立共享 chunk，经动态导入到达时可能晚于
// 首次 <spinner> 渲染求值，触发 [Reconciler] Unknown component type: spinner。
// 改为与 bg-pulse.tsx 一致的显式 extend：注册语句内联在本模块体内，而本模块
// 是全部 <spinner> 渲染点的静态值依赖（Spinner/SPINNER_FRAMES），ESM 保证其
// 先于任何渲染求值，同时消除 tree-shaking 与 chunk 求值时序两类风险。
declare module "@opentui/solid" {
  interface OpenTUIComponents {
    spinner: typeof SpinnerRenderable
  }
}
extend({ spinner: SpinnerRenderable })

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

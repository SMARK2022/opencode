import { Index, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { ColorInput, RGBA } from "@opentui/core"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export type SpinnerColor =
  | ColorInput
  | ((frameIndex: number, charIndex: number, totalFrames: number, totalChars: number) => ColorInput)

export function SpinnerIcon(props: { frames?: string[]; interval?: number; color?: SpinnerColor; width?: number }) {
  const frames = createMemo(() => (props.frames?.length ? props.frames : SPINNER_FRAMES))
  const [frameIndex, setFrameIndex] = createSignal(0)

  createEffect(() => {
    const total = frames().length
    const interval = props.interval ?? 80
    setFrameIndex((index) => index % total)
    if (total <= 1 || interval <= 0) return

    const timer = setInterval(() => setFrameIndex((index) => (index + 1) % frames().length), interval)
    onCleanup(() => clearInterval(timer))
  })

  const frame = createMemo(() => frames()[frameIndex() % frames().length] ?? "")
  const chars = createMemo(() => Array.from(frame()))
  const width = createMemo(() => props.width ?? Math.max(1, ...frames().map((item) => Bun.stringWidth(item))))
  const color = (index: number) => {
    if (typeof props.color === "function") return props.color(frameIndex(), index, frames().length, chars().length)
    return props.color
  }

  return (
    <text wrapMode="none" width={width()}>
      <Index each={chars()}>{(char, index) => <span style={{ fg: color(index) }}>{char()}</span>}</Index>
    </text>
  )
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <SpinnerIcon frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

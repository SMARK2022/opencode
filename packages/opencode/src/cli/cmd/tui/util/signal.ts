import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { debounce, leadingAndTrailing, throttle, type Scheduled } from "@solid-primitives/scheduled"

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, Scheduled<[value: T]>] {
  const [get, set] = createSignal(value)
  return [get, debounce((v: T) => set(() => v), ms)]
}

/**
 * Creates a signal whose value is updated at most once every `ms` milliseconds.
 * Uses leading-and-trailing throttle so the first update is applied immediately
 * and a final update is always flushed after the throttle window closes.
 */
export function createThrottledSignal<T>(value: T, ms: number): [Accessor<T>, (v: T) => void] {
  const [get, set] = createSignal<T>(value)
  const trigger = leadingAndTrailing(throttle, (v: T) => set(() => v), ms)
  return [get, trigger]
}

export function createFadeIn(show: Accessor<boolean>, enabled: Accessor<boolean>) {
  const [alpha, setAlpha] = createSignal(show() ? 1 : 0)
  let revealed = show()

  createEffect(
    on([show, enabled], ([visible, animate]) => {
      if (!visible) {
        setAlpha(0)
        return
      }

      if (!animate || revealed) {
        revealed = true
        setAlpha(1)
        return
      }

      const start = performance.now()
      revealed = true
      setAlpha(0)

      const timer = setInterval(() => {
        const progress = Math.min((performance.now() - start) / 160, 1)
        setAlpha(progress * progress * (3 - 2 * progress))
        if (progress >= 1) clearInterval(timer)
      }, 16)

      onCleanup(() => clearInterval(timer))
    }),
  )

  return alpha
}

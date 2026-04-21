import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (next: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return [get, debounced]
}

// 固定窗口从首值开始计时，后续输入不延长窗口，避免持续流式更新饿死尾值。
// 窗口关闭后允许新的首值立即发布，因此这不是任意两次发布都相隔 ms 的限速器。
export function createThrottledSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal<T>(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastValue: T | undefined
  let hasPending = false

  const throttled = (next: T) => {
    // 空闲时同步发布首值，让首次用量显示无需等待一个窗口。
    // 用函数包装 next，使泛型中的函数值作为数据保存，而非被 Solid 当作 updater 执行。
    if (!timer) {
      set(() => next)
      timer = setTimeout(() => {
        timer = undefined
        // 单次调用没有尾值，不重复发布；有多次调用时只保留最后一次的快照。
        // hasPending 独立于 lastValue，允许 undefined 作为有效尾值清空消费者的显示。
        if (hasPending) {
          hasPending = false
          set(() => lastValue as T)
        }
      }, ms)
      return
    }
    // 覆盖待发快照而不重启计时，使最终状态在输入停止后仍能发布。
    lastValue = next
    hasPending = true
  }

  // 计时器归创建时的 Solid owner 所有；卸载时取消尾值，而不是向已卸载视图补发。
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  return [get, throttled]
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

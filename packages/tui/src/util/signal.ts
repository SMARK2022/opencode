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

// 默认 1s 与 footer 秒级显示粒度一致；调小只增加重绘频率不改变口径
export function createRefreshClock(active: Accessor<boolean>, ms = 1000) {
  const [now, setNow] = createSignal(Date.now())

  createEffect(
    on(active, (enabled) => {
      // 这个 clock 只负责驱动 UI 重新计算"当前时间"，不持有业务计时起点。
      // 耗时边界必须继续来自 session messages，保证重连和组件重挂载后口径不变。
      // 切换 active 时先立即对时一次，避免启用瞬间显示陈旧时间
      setNow(Date.now())
      if (!enabled) return

      // interval 只写 now 信号；所有耗时 memo 派生自它，卸载时随 onCleanup 终止
      const timer = setInterval(() => setNow(Date.now()), ms)
      onCleanup(() => clearInterval(timer))
    }),
  )

  // now 作为只读 Accessor 下发；调用方不得写入，起点权威始终在 session messages
  return now
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

// 比较相邻已发布快照的数值增长，不以对象身份或格式化文本变化判断流量。
// ms 是最后一次增长后的保持时长；它与上游 50ms 快照节流窗口独立。
export function createTokenFlowPulse<T extends { input: number; output: number } | undefined>(
  value: Accessor<T>,
  ms = 900,
) {
  const [flow, setFlow] = createSignal({ input: false, output: false })
  let inputTimer: ReturnType<typeof setTimeout> | undefined
  let outputTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(
    on(value, (next, prev) => {
      // undefined 表示消费者已无可显示用量，立即熄灭两侧而非等旧脉冲自然到期。
      if (!next) {
        setFlow({ input: false, output: false })
        return
      }
      // 首个有效值只建立基线；载入已有历史计数不应伪装成刚发生的流量。
      if (!prev) return
      // 同方向增长撤销旧到期回调，避免旧回调提前熄灭刚续期的脉冲。
      if (next.input > prev.input) {
        if (inputTimer) clearTimeout(inputTimer)
        setFlow((x) => ({ ...x, input: true }))
        inputTimer = setTimeout(() => setFlow((x) => ({ ...x, input: false })), ms)
      }
      // 输出用独立计时器，输入增长不能延长输出脉冲，反之亦然。
      // 相等或下降不触发续期，估算被修正时不会被显示成新增输出。
      if (next.output > prev.output) {
        if (outputTimer) clearTimeout(outputTimer)
        setFlow((x) => ({ ...x, output: true }))
        outputTimer = setTimeout(() => setFlow((x) => ({ ...x, output: false })), ms)
      }
    }),
  )

  // helper 随创建它的视图 owner 清理，两方向的到期回调都不能越过卸载边界。
  onCleanup(() => {
    if (inputTimer) clearTimeout(inputTimer)
    if (outputTimer) clearTimeout(outputTimer)
  })

  return flow
}

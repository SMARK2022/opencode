import { expect, test } from "bun:test"
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

async function fixture(preserveVisibleContent = true, wrapped = false) {
  // 窄视口保证根列表远大于可见范围，不会因原生边界裁剪掩盖历史位置漂移。
  const app = await createTestRenderer({ width: 60, height: 15, useThread: false, footerHeight: 0 })
  // 与 Session 同款开关组合：关闭 preserveVisibleContent 的对照由最后一个用例单独覆盖。
  const scroll = new ScrollBoxRenderable(app.renderer, {
    width: 60,
    height: 15,
    preserveVisibleContent,
    stickyScroll: true,
    stickyStart: "bottom",
    stickyScrollTolerance: 1,
  })
  app.renderer.root.add(scroll)
  // 三百个根覆盖实际 Session 窗口量级；宽度用例让文本真正换行，不能手工估算高度。
  const rows = Array.from({ length: 300 }, (_, i) => {
    const row = new BoxRenderable(app.renderer, { height: wrapped ? "auto" : 3, flexShrink: 0 })
    row.add(
      new TextRenderable(app.renderer, { content: `MESSAGE ${i}` + (wrapped ? " wrapped content".repeat(12) : "") }),
    )
    scroll.add(row)
    return row
  })
  await app.renderOnce()
  await app.renderOnce()
  // 从历史中部开始，顶部和底部的原生粘附都不能替内容保持功能代偿。
  scroll.scrollTo(rows[150].y - rows[0].y)
  await app.renderOnce()
  return { app, scroll, rows }
}

// 当前smark.13由Bun补丁交付布局owner修复，本组观察实际安装依赖的逐帧行为。

test("scroll layout preserves the visible message on every growth and shrink frame", async () => {
  const app = await createTestRenderer({ width: 60, height: 15, useThread: false, footerHeight: 0 })
  // 使用真实容器和文本，避免仅比较高度差公式却遗漏实际绘制顺序。
  const options = { width: 60, height: 15, preserveVisibleContent: true }
  const scroll = new ScrollBoxRenderable(app.renderer, options)
  app.renderer.root.add(scroll)
  const rows = Array.from({ length: 40 }, (_, i) => {
    const row = new BoxRenderable(app.renderer, { height: 3, flexShrink: 0 })
    row.add(new TextRenderable(app.renderer, { content: `MESSAGE ${i}` }))
    scroll.add(row)
    return row
  })
  try {
    await app.renderOnce()
    await app.renderOnce()
    scroll.scrollTo(60)
    // 双 renderOnce 让初始 Yoga 布局与 scrollbar 几何先后稳定，
    // scrollTo(60) 才落在确定性位置而非过渡帧。
    await app.renderOnce()
    // 顶部标记是独立期望值；每帧断言才能拒绝“先偏移、最终恢复”的实现。
    // rows[20] 是 scrollTo(60) 后的首行——与后续高度变化无关，期望值自证。
    for (let i = 0; i < 8; i++) {
      rows[i].height = i % 2 ? 1 : 8
      await app.renderOnce()
      expect(app.captureCharFrame().split("\n")[0].trim()).toBe("MESSAGE 20")
      expect(rows[20].y - scroll.viewport.y).toBe(0)
    }
  } finally {
    app.renderer.destroy()
  }
})

test.each(["wheel", "line", "resize", "redistribute", "padding"])(
  "scroll layout preserves input during %s",
  async (kind) => {
    const { app, scroll, rows } = await fixture(true, kind === "resize")
    try {
      if (kind === "padding") {
        // 内容内边距和消息外边距都参与 Yoga 坐标，不能按零边距的特例通过。
        scroll.content.paddingTop = 2
        rows[20].marginTop = 3
        await app.renderOnce()
      }
      const original = rows[150].y - scroll.viewport.y
      // 累加已经接受的输入位移，避免用新布局后的绝对位置倒推期望而自证正确。
      // resize 用例的宽度交替（60↔40）同时覆盖换行扩张与收缩两个方向。
      let movement = 0
      // 输入量来自公开滚动接口的实际接受值；断言只排除布局额外引入的位移。
      for (let i = 0; i < 8; i++) {
        const before = scroll.scrollTop
        if (kind === "wheel") await app.mockMouse.scroll(10, 5, "down")
        if (kind === "line") scroll.scrollBy(1)
        movement += scroll.scrollTop - before
        // 反复恢复原宽度同时验证收缩路径，只有变窄时正确不足以保证连续调整窗口。
        if (kind === "resize") scroll.width = i % 2 ? 60 : 40
        else rows[i].height = i % 2 ? 1 : 5
        // 上下各改相反的两行，总高不变也必须保持中间正在阅读的消息。
        if (kind === "redistribute") rows[280 + i].height = i % 2 ? 5 : 1
        await app.renderOnce()
        expect(rows[150].y - scroll.viewport.y).toBe(original - movement)
      }
      // 若鼠标事件未到达容器，零漂移也会假通过，因此必须证明输入确实生效。
      if (kind === "wheel" || kind === "line") expect(movement).toBeGreaterThan(0)
      // 停止输入后再观察，拒绝把补偿延迟到后续空闲帧的实现。
      // 这是旧事后锚点恢复的失败模式：中间帧偏移、帧外恢复仍能骗过终态断言。
      for (let i = 0; i < 4; i++) {
        await app.renderOnce()
        expect(rows[150].y - scroll.viewport.y).toBe(original - movement)
      }
    } finally {
      app.renderer.destroy()
    }
  },
)

test("scroll layout keeps bottom tolerance and explicit navigation semantics", async () => {
  const { app, scroll, rows } = await fixture()
  try {
    // 通过公开导航进入尾部，检验既有贴底状态，而不是手工设置内部标志。
    // stickyStart="bottom" 的重验活点由 recalculateBarProps 承担，这里只验证
    // 一行容差与主动离开两个用户可感知语义。
    scroll.scrollTo(scroll.scrollHeight)
    await app.renderOnce()
    scroll.scrollBy(-1)
    await app.renderOnce()
    // 一行上滚没有内容增长时不能被吞掉；增长时则沿用 Session 的视觉贴底约定。
    expect(scroll.scrollHeight - scroll.viewport.height - scroll.scrollTop).toBe(1)
    rows[0].height = 8
    await app.renderOnce()
    expect(scroll.scrollHeight - scroll.viewport.height - scroll.scrollTop).toBe(0)
    // 主动离开底部后不应被旧贴底意图拉回，空闲帧也要保留导航结果。
    scroll.scrollTo(60)
    await app.renderOnce()
    const top = scroll.scrollTop
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(top)
    // 已删除内容没有可保留的位置，原生范围裁剪必须收敛到空列表起点。
    // 销毁而非隐藏根可同时覆盖节点退订和父容器几何失效的真实路径。
    // 补偿分支找不到可见子节点时不得抛错，交由 clamp 收敛到 0。
    for (const row of rows) row.destroyRecursively()
    await app.renderOnce()
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("scroll layout leaves non-opted-in consumers unchanged", async () => {
  const { app, scroll, rows } = await fixture(false)
  try {
    const top = scroll.scrollTop
    rows[0].height = 8
    await app.renderOnce()
    // 其他滚动容器未承诺消息位置保持，默认仍使用原生绝对位置行为。
    // 该对照锁定 opt-in 边界：补丁不得改变未开启容器的任何既有语义。
    expect(scroll.scrollTop).toBe(top)
    expect(rows[150].y - scroll.viewport.y).toBe(5)
  } finally {
    app.renderer.destroy()
  }
})

test("scroll layout settles its real scheduler after geometry changes", async () => {
  const { app, rows } = await fixture()
  try {
    rows[0].height = 8
    // 这里不手动泵帧：idle 只有真实调度队列排空才返回，可抓到无限预约下一帧。
    await new Promise<void>((resolve) => process.nextTick(resolve))
    await app.renderer.idle()
    // 坐标不变仍可能持续空转；公开调度状态必须证明没有等待绘制的任务。
    // updateLayout 覆写只读几何不预约渲染——空转即说明补偿路径引入了额外调度。
    expect(app.renderer.getSchedulerState()).toEqual({
      isRunning: false,
      isRendering: false,
      hasScheduledRender: false,
    })
  } finally {
    app.renderer.destroy()
  }
}, 5000)

test("scroll layout benchmark", async () => {
  if (process.env.SCROLL_BENCH !== "1") return
  // 同一容器以开关区分基线与修复，避免加载两套 native 模块污染计时。
  // 该用例只报告耗时，不把机器负载波动转成普通 CI 的不稳定断言。
  // 关闭选项即同一smark.13的原生基线，不加载第二份native模块。
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const enabled of [false, true]) {
      const { app, scroll, rows } = await fixture(enabled)
      try {
        const times: number[] = []
        for (let i = 0; i < 230; i++) {
          rows[0].height = i % 2 ? 3 : 5
          scroll.scrollBy(i % 2 ? -1 : 1)
          const start = performance.now()
          await app.renderOnce()
          // 前三十帧用于预热，剩余两百帧同时包含输入与几何变化的真实绘制成本。
          if (i >= 30) times.push(performance.now() - start)
        }
        // 固定采样下标先于结果确定，避免事后挑选有利样本或仅报告最快一帧。
        times.sort((a, b) => a - b)
        console.log(JSON.stringify({ repeat, enabled, median: times[100], p95: times[190] }))
      } finally {
        app.renderer.destroy()
      }
    }
  }
}, 30000)

import { describe, expect, test } from "bun:test"
import { createSignal, untrack } from "solid-js"
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

const sessionSource = await Bun.file(new URL("../../../src/routes/session/index.tsx", import.meta.url)).text()
// #212：提取生产回调在原生布局中执行，避免测试另写一份跟随公式。
const callback = sessionSource.match(/  function syncSessionViewportStuckToBottom\(\) \{[\s\S]*?\n  \}/)?.[0]

async function fixture() {
  expect(callback).toBeDefined()
  expect(sessionSource).toContain("renderAfter={syncSessionViewportStuckToBottom}")
  const app = await createTestRenderer({ width: 100, height: 18, useThread: false })
  // #212：非零屏幕位置与边框让 y/height 不等于滚动偏移/视口高度。
  const scroll = new ScrollBoxRenderable(app.renderer, {
    width: 96,
    height: 14,
    top: 2,
    border: true,
    stickyScroll: true,
    stickyStart: "bottom",
    preserveVisibleContent: true,
    stickyScrollTolerance: 1,
  })
  // 使用生产信号契约，回调同时验证跟随和裁剪，不在测试中重写位置算法。
  const [viewportStuckToBottom, setViewportStuckToBottom] = createSignal(true)
  scroll.renderAfter = new Function(
    "scroll",
    "untrack",
    "viewportStuckToBottom",
    "setViewportStuckToBottom",
    "syncMessageResidency",
    `${callback}\nreturn syncSessionViewportStuckToBottom`,
    // 本窄测试只观察生产状态发布与容器跟随；驻留由完整Session harness验证。
  )(scroll, untrack, viewportStuckToBottom, setViewportStuckToBottom, () => {}) as () => void
  app.renderer.root.add(scroll)
  const message = new BoxRenderable(app.renderer, { flexShrink: 0 })
  const text = new TextRenderable(app.renderer, {
    content: `${"wrapped content ".repeat(180)}OLD_BOTTOM`,
    wrapMode: "word",
  })
  message.add(text)
  scroll.add(message)
  return { app, scroll, text, viewportStuckToBottom }
}

describe("session viewport streaming bottom follow (#212)", () => {
  test.each([0, 1, 3])("streaming layout respects a %s-row bottom gap", async (gap) => {
    const { app, scroll, text, viewportStuckToBottom } = await fixture()
    try {
      // #212：用真实 renderOnce 推进原生回绕、滚动范围刷新和后续绘制。
      for (let frame = 0; frame < 4; frame++) await app.renderOnce()
      expect(scroll.scrollTop).toBeGreaterThan(3)
      expect(scroll.y).toBeGreaterThan(0)
      expect(scroll.viewport.height).toBeLessThan(scroll.height)
      expect(app.captureCharFrame()).toContain("OLD_BOTTOM")

      const previous = scroll.scrollTop
      const previousHeight = scroll.scrollHeight
      scroll.scrollBy(-gap)
      // #212：没有内容增长的普通帧不得吞掉手动一行上滚。
      await app.renderOnce()
      await app.renderOnce()
      expect(scroll.scrollTop).toBe(previous - gap)
      expect(viewportStuckToBottom()).toBe(gap <= 1)
      if (gap > 0) expect(app.captureCharFrame()).not.toContain("OLD_BOTTOM")

      // #212：同一文本节点追加 delta，实际换行增高，不靠新增节点或手工改高度。
      text.content = `${text.plainText}${" new content".repeat(80)} NEW_BOTTOM`
      for (let frame = 0; frame < 4; frame++) await app.renderOnce()
      expect(scroll.scrollHeight).toBeGreaterThan(previousHeight)
      expect(scroll.getChildren()).toHaveLength(1)

      if (gap > 1) {
        expect(viewportStuckToBottom()).toBe(false)
        expect(scroll.scrollTop).toBe(previous - gap)
        expect(app.captureCharFrame()).not.toContain("NEW_BOTTOM")
        return
      }
      expect(viewportStuckToBottom()).toBe(true)
      expect(scroll.scrollTop).toBeGreaterThan(previous)
      expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.viewport.height)
      expect(app.captureCharFrame()).toContain("NEW_BOTTOM")
    } finally {
      app.renderer.destroy()
    }
  })
})

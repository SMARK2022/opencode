/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createMalformedSgrMouseGuard } from "../../../../src/cli/cmd/tui/app"

// 畸形 SGR mouse 报告修复测试
//
// 某些终端/IDE/触摸屏在坐标不可用时发送畸形 SGR mouse 报告（如 ESC[<64;NaN;NaNM）。
// OpenTUI StdinParser 在遇到大写 N（CSI final byte 范围）时错误结束 CSI，
// 剩余字节 aN;NaNM 逐字符变成普通 key event，被 TextareaRenderable.insertText() 插入。
// 本测试验证 createMalformedSgrMouseGuard handler 能拦截这些碎片，阻止它们进入 textarea。

// 辅助：创建带 guard 的 testRender 并返回 textarea 引用
async function setupTextareaWithGuard(width = 20, height = 3) {
  let textarea: any
  const app = await testRender(
    () => <textarea ref={(r: any) => (textarea = r)} width={width} height={1} />,
    { width, height, prependInputHandlers: [createMalformedSgrMouseGuard()] },
  )
  await app.renderOnce()
  textarea.focus()
  await app.renderOnce()
  return { app, textarea }
}

// 辅助：向 test renderer 的 stdin 推入原始字节
function feedStdin(app: any, data: string) {
  app.renderer.stdin.push(Buffer.from(data))
}

// 辅助：排空 parser 并渲染一帧
async function flushAndRender(app: any) {
  await app.renderOnce()
  await app.renderOnce()
}

// ─── 根因复现：畸形 SGR mouse 报告不得进入 textarea ───────────────────

test("畸形 SGR mouse 报告 ESC[<64;NaN;NaNM 不进入 textarea", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    // 注入畸形 SGR mouse press 报告
    feedStdin(app, "\x1b[<64;NaN;NaNM")
    await flushAndRender(app)

    // textarea 不应包含畸形碎片的任何部分
    expect(textarea.plainText).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("畸形 SGR mouse 报告 ESC[<64;NaN;NaNm（释放）不进入 textarea", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    feedStdin(app, "\x1b[<64;NaN;NaNm")
    await flushAndRender(app)

    expect(textarea.plainText).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("三条连续畸形报告不产生 aN;NaNMaN;NaNMaN;NaNm", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    // 模拟用户报告的完整场景：两条 press + 一条 release
    feedStdin(app, "\x1b[<64;NaN;NaNM\x1b[<64;NaN;NaNM\x1b[<64;NaN;NaNm")
    await flushAndRender(app)

    expect(textarea.plainText).toBe("")
    // 确保不是空字符串碰巧通过——显式检查不包含已知碎片
    expect(textarea.plainText).not.toContain("aN")
    expect(textarea.plainText).not.toContain("NaN")
  } finally {
    app.renderer.destroy()
  }
})

// ─── 正常路径：合法输入不受影响 ─────────────────────────────────

test("合法 SGR mouse 报告不触发 guard、不进入 textarea", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    // 合法 SGR mouse press：ESC[<button;x;yM —— parser 应识别为 mouse event
    feedStdin(app, "\x1b[<64;12;8M")
    await flushAndRender(app)

    // 合法 mouse event 不经过 sequenceHandlers，textarea 不受影响
    expect(textarea.plainText).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("普通文本输入正常进入 textarea", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    feedStdin(app, "hello")
    await flushAndRender(app)

    expect(textarea.plainText).toBe("hello")
  } finally {
    app.renderer.destroy()
  }
})

test("直接键入 aN;NaNm 文本正常进入 textarea（guard 不误拦）", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    // 用户合法输入 aN;NaNm —— 不带 ESC mouse 前缀，guard 不应触发
    feedStdin(app, "aN;NaNm")
    await flushAndRender(app)

    expect(textarea.plainText).toBe("aN;NaNm")
  } finally {
    app.renderer.destroy()
  }
})

// ─── 边界：recovery 中遇到非法字符立即放行 ─────────────────────────

test("recovery 中遇到非 mouse 字符集字符立即放行后续输入", async () => {
  const { app, textarea } = await setupTextareaWithGuard()
  try {
    // 先注入畸形报告触发 recovery，但报告中间混入了非法字符 x
    // ESC[<64;N 是 parser 拆出的第一个 key event
    // 后续 aN;NaN; 被 recovery 消费，但 x 不在 mouse 字符集中
    feedStdin(app, "\x1b[<64;NaN;xM")
    await flushAndRender(app)

    // x 不在 mouse 字符集中，recovery 退出并放行 x
    // recovery 已退出后，M 也是普通字符，正常进入 textarea
    expect(textarea.plainText).toBe("xM")
  } finally {
    app.renderer.destroy()
  }
})

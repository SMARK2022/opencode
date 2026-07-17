import { describe, expect, test } from "bun:test"
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { SpinnerRenderable } from "opentui-spinner"
import {
  SESSION_SIDEBAR_WIDTH,
  sessionMessageContentWidth,
} from "../../../../src/cli/cmd/tui/routes/session/layout"

describe("session layout width", () => {
  test("matches OpenTUI's actual assistant text column", async () => {
    for (const item of [
      { terminalWidth: 80, sidebarVisible: false, scrollbarEnabled: true },
      { terminalWidth: 80, sidebarVisible: false, scrollbarEnabled: false },
      { terminalWidth: 160, sidebarVisible: true, scrollbarEnabled: true },
      { terminalWidth: 160, sidebarVisible: true, scrollbarEnabled: false },
    ]) {
      const expected = sessionMessageContentWidth({
        terminalWidth: item.terminalWidth,
        sidebarInLayout: item.sidebarVisible,
        scrollbarEnabled: item.scrollbarEnabled,
      })
      // 同一 expected 同时约束普通正文和 reasoning preview，防止两套宽度公式日后漂移。
      expect(await measureAssistantTextWidth(item, "text")).toBe(expected)
      // reasoning 多一层左边框、少一格 padding，总 chrome 仍为四格；preview 预算依赖这一不变量。
      expect(await measureAssistantTextWidth(item, "reasoning")).toBe(expected)
    }
  })
})

async function measureAssistantTextWidth(
  input: {
    terminalWidth: number
    sidebarVisible: boolean
    scrollbarEnabled: boolean
  },
  kind: "text" | "reasoning",
) {
  const setup = await createTestRenderer({
    width: input.terminalWidth,
    height: 20,
    footerHeight: 0,
    useThread: false,
    consoleMode: "disabled",
  })

  try {
    const root = new BoxRenderable(setup.renderer, {
      width: input.terminalWidth,
      height: 20,
      flexDirection: "row",
    })
    const main = new BoxRenderable(setup.renderer, {
      flexGrow: 1,
      minHeight: 0,
      paddingLeft: 2,
      paddingRight: 2,
    })

    root.add(main)
    if (input.sidebarVisible) {
      root.add(new BoxRenderable(setup.renderer, { width: SESSION_SIDEBAR_WIDTH, height: "100%" }))
    }

    const scroll = new ScrollBoxRenderable(setup.renderer, {
      flexGrow: 1,
      viewportOptions: { paddingRight: 1 },
      contentOptions: { paddingRight: 1 },
      verticalScrollbarOptions: {
        visible: true,
        trackOptions: {
          backgroundColor: RGBA.fromInts(20, 20, 20),
          foregroundColor: RGBA.fromInts(200, 200, 200),
        },
      },
      stickyScroll: true,
      stickyStart: "bottom",
    })
    main.add(scroll)

    const assistant = new BoxRenderable(setup.renderer, { border: ["left"], flexShrink: 0 })
    // 两条路径复刻生产树的实际水平 chrome，不能用手工减常量替代 Yoga 实测。
    const textPart = new BoxRenderable(setup.renderer, {
      paddingLeft: kind === "text" ? 3 : 2,
      border: kind === "reasoning" ? ["left"] : false,
      flexShrink: 0,
    })
    const text = new TextRenderable(setup.renderer, { content: "x ".repeat(2_000), wrapMode: "word" })
    textPart.add(text)
    assistant.add(textPart)
    scroll.add(assistant)
    setup.renderer.root.add(root)

    for (let i = 0; i < 3; i++) await setup.renderOnce()
    scroll.viewportOptions = { paddingRight: input.scrollbarEnabled ? 1 : 0 }
    scroll.contentOptions = { paddingRight: input.scrollbarEnabled ? 1 : 0 }
    scroll.verticalScrollbarOptions = { visible: input.scrollbarEnabled }
    for (let i = 0; i < 5; i++) await setup.renderOnce()

    return text.width
  } finally {
    setup.renderer.destroy()
  }
}

// CJK 全角字符在视觉行尾刚好填满整行时（偶数宽度），OpenTUI 的 native
// getRealCharBytes 不会在行尾插入 \n，导致 captureCharFrame() 把所有文字
// 放在第一行。cell buffer 内容本身正确，bug 仅在 native 层。
// 以下测试覆盖 TextRenderable（sidebar/footer/user message 底层路径）和
// TextareaRenderable（prompt/dialog 输入底层路径）两条渲染链。
// 每个全角中文字符占 2 个终端 cell，width=24 时一行恰好容纳 12 个全角字符。
const CJK_ROW_1 = "一二三四五六七八九十甲乙"
const CJK_ROW_2 = "丙丁戊己庚辛壬癸子丑寅卯"
const CJK_ROW_3 = "辰巳午未申酉戌亥乾坤艮巽"
const CJK_FULLWIDTH_TEXT = CJK_ROW_1 + CJK_ROW_2 + CJK_ROW_3

describe("CJK fullwidth wrapping", () => {
  test("Goal sidebar does not duplicate a CJK glyph across the 35-cell wrap boundary", async () => {
    const objective = "检查log，请你自行独立完整完成相应的调研与检查，并进行多轮的负载并发、高压"
    // expected literal来自Goal产品路径，不从被测frame反向生成，避免测试与实现共享错误算法。
    // 42-cell外框故意比35-cell文本盒更宽，才能让越界双宽cell留下可观察证据。
    // 断言source中两个“查”恰好在frame中出现两次，覆盖跨virtual-line重复而非只覆盖乱码。
    const setup = await createTestRenderer({
      width: 42,
      height: 6,
      footerHeight: 0,
      useThread: false,
      consoleMode: "disabled",
    })
    try {
      // 42-cell sidebar经过两层左右padding和content右padding后，Goal文本真实可用宽度是35格。
      // 外层framebuffer仍比文本盒宽，能直接暴露越界cell，而不是被renderer根边界裁掉。
      const sidebar = new BoxRenderable(setup.renderer, {
        width: 42,
        height: 6,
        paddingLeft: 2,
        paddingRight: 2,
      })
      const content = new BoxRenderable(setup.renderer, { flexShrink: 0, gap: 1, paddingRight: 1 })
      const goal = new BoxRenderable(setup.renderer, { paddingLeft: 2 })
      goal.add(new TextRenderable(setup.renderer, { content: objective, wrapMode: "word" }))
      content.add(goal)
      sidebar.add(content)
      setup.renderer.root.add(sidebar)
      // 多次renderOnce模拟稳定后的静态frame，排除首帧尚未提交造成的偶然差异。
      for (let i = 0; i < 3; i++) await setup.renderOnce()

      const frame = setup.captureCharFrame()
      // frame必须同时保留Goal文本和真实缩进；trim掉行尾空格不能掩盖x偏移。
      // 输入中的两个“查”是独立期望；边界virtual chunk回退到旧byte offset时会渲染出第三个。
      expect(frame.split("查")).toHaveLength(3)
      expect(frame).not.toContain("\uFFFD")
      // replacement character是UTF-8切片损坏的独立信号，不能由数量相等的重复断言替代。
    } finally {
      setup.renderer.destroy()
    }
  })

  test("TextRenderable distributes fullwidth chars across visual rows at exact boundary", async () => {
    const frame = await renderTextFrame({ width: 24, height: 6, content: CJK_FULLWIDTH_TEXT })
    const rows = frame.split("\n")
    // 只 trimEnd 不 trim：行首空白也是错位信号，去掉左侧会掩盖缩进类回归
    expect(rows[0].trimEnd()).toBe(CJK_ROW_1)
    expect(rows[1].trimEnd()).toBe(CJK_ROW_2)
    expect(rows[2].trimEnd()).toBe(CJK_ROW_3)
    // 防止多字节切割产生替换字符（U+FFFD）
    expect(frame).not.toContain("\uFFFD")
  })

  test("TextareaRenderable distributes fullwidth chars across visual rows at exact boundary", async () => {
    const frame = await renderTextareaFrame({ width: 24, height: 6, content: CJK_FULLWIDTH_TEXT })
    const rows = frame.split("\n")
    expect(rows[0].trimEnd()).toBe(CJK_ROW_1)
    expect(rows[1].trimEnd()).toBe(CJK_ROW_2)
    expect(rows[2].trimEnd()).toBe(CJK_ROW_3)
    expect(frame).not.toContain("\uFFFD")
  })

  test("SpinnerRenderable mounts and renders after OpenTUI upgrade (peer compat smoke)", async () => {
    // opentui-spinner 的 SpinnerRenderable 直接继承 @opentui/core 的 Renderable
    // 和 native buffer 接口；升级三件套后必须验证其仍能挂载和渲染
    const setup = await createTestRenderer({
      width: 20,
      height: 3,
      footerHeight: 0,
      useThread: false,
      consoleMode: "disabled",
    })
    try {
      const spinner = new SpinnerRenderable(setup.renderer, {
        frames: ["⠋", "⠙", "⠹"],
        interval: 80,
      })
      setup.renderer.root.add(spinner)
      for (let i = 0; i < 3; i++) await setup.renderOnce()
      // autoplay 默认开启，renderSelf 至少渲染出第一个 frame 字符
      expect(setup.captureCharFrame()).toMatch(/[⠋⠙⠹]/)
    } finally {
      setup.renderer.destroy()
    }
  })
})

// captureCharFrame() 在 CJK 全角字符恰好填满视觉行时，native getRealCharBytes
// 不会在行尾插入 \n。此 helper 通过 getRealCharBytes(false) 获取不带 \n 的全部
// resolved chars（按行序排列），再用 captureSpans() 每行 span 文本长度
//（= 非连续 cell 数）重新分割，正确重建带 \n 的 frame。
// 限制：假设每行要么全满要么全空（CJK 测试场景），若行内 text cell 与空 cell
// 交替出现，span text 的 fallback 空格会与 getRealCharBytes 跳过空 cell 的行为
// 产生 charCount 偏差，不适用于含中间空白的通用 frame 捕获。
function captureCJKFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>): string {
  const buf = setup.renderer.currentRenderBuffer
  const chars = [...new TextDecoder().decode(buf.getRealCharBytes(false))]
  const spans = setup.captureSpans()
  let charIdx = 0
  const rows: string[] = []
  for (const line of spans.lines) {
    // span 文本长度 = 非连续 cell 数 = 该行应分配的 resolved char 数
    const charCount = [...line.spans.map((s) => s.text).join("")].length
    let rowText = ""
    for (let i = 0; i < charCount && charIdx < chars.length; i++) rowText += chars[charIdx++]
    rows.push(rowText)
  }
  return rows.join("\n")
}

async function renderTextFrame(opts: { width: number; height: number; content: string }): Promise<string> {
  const setup = await createTestRenderer({
    width: opts.width,
    height: opts.height,
    footerHeight: 0,
    useThread: false,
    consoleMode: "disabled",
  })
  try {
    const text = new TextRenderable(setup.renderer, { content: opts.content, wrapMode: "word" })
    setup.renderer.root.add(text)
    for (let i = 0; i < 3; i++) await setup.renderOnce()
    return captureCJKFrame(setup)
  } finally {
    // createTestRenderer 持有 native renderer、timer 和 selection 状态，
    // 必须 destroy 避免泄漏到后续测试
    setup.renderer.destroy()
  }
}

async function renderTextareaFrame(opts: { width: number; height: number; content: string }): Promise<string> {
  const setup = await createTestRenderer({
    width: opts.width,
    height: opts.height,
    footerHeight: 0,
    useThread: false,
    consoleMode: "disabled",
  })
  try {
    // showCursor=false 避免 cursor cell 污染 frame 断言
    const textarea = new TextareaRenderable(setup.renderer, {
      initialValue: opts.content,
      wrapMode: "word",
      showCursor: false,
    })
    setup.renderer.root.add(textarea)
    for (let i = 0; i < 3; i++) await setup.renderOnce()
    return captureCJKFrame(setup)
  } finally {
    setup.renderer.destroy()
  }
}

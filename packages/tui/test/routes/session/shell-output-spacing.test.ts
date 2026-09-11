import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "path"

// #449 语义：bash 展开输出的命令与输出之间统一空行分隔，且不再有内联
// "Model context output" 标签——标题的 · returned to model 与上下文背景色已足够区分。
const sessionSource = readFileSync(
  path.join(import.meta.dir, "../../../src/routes/session/index.tsx"),
  "utf8",
)

describe("Session Shell output spacing", () => {
  test("Shell does not show 'Model context output' inline label", () => {
    expect(sessionSource).not.toContain("Model context output")
  })

  test("Shell body keeps consistent command/output spacing", () => {
    // 目标 Shell 容器使用 gap={1} 提供与折叠预览一致的空行分隔；
    // 源实现的 marginTop={1} 由这一容器级 gap 等价承担。
    const shellStart = sessionSource.indexOf("function Shell(props: ToolProps)")
    expect(shellStart).toBeGreaterThan(-1)
    const shellBody = sessionSource.slice(shellStart, shellStart + 6000)
    expect(shellBody).toContain("gap={1}")
    // 合成文本仅在存在输出时插入空行，展开态仍由原 gap 承担间距。
    expect(shellBody).toContain('if (!output()) return `$ ${stringValue(props.input.command) ?? ""}`')
    expect(shellBody).toContain('[`$ ${stringValue(props.input.command) ?? ""}`, "", output()].join("\\n")')
  })

  test("BlockTool uses one vertical spacing strategy", () => {
    const blockToolSource = sessionSource.slice(sessionSource.indexOf("function BlockTool("), sessionSource.indexOf("function Shell("))
    expect(blockToolSource).toContain("marginTop={1}")
    expect(blockToolSource).not.toContain("gap={1}")
  })

  test("BlockTool can collapse long wrapped single-line content", () => {
    // 源 totalChars 契约由目标 preview owner 承担，不恢复第二套折叠状态。
    expect(sessionSource).toContain("DEFAULT_BLOCK_CHAR_THRESHOLD = 800")
    expect(sessionSource).toContain("maxChars = DEFAULT_BLOCK_CHAR_THRESHOLD")
    expect(sessionSource).toContain("Math.min(maxChars() * 2, DEFAULT_BLOCK_CHAR_THRESHOLD)")
    expect(sessionSource).toContain('diffContent().length > DEFAULT_BLOCK_CHAR_THRESHOLD')
    expect(sessionSource).toContain('(file.patch ?? "").length > DEFAULT_BLOCK_CHAR_THRESHOLD')
    expect(sessionSource).toContain('(diff() ?? "").length > DEFAULT_BLOCK_CHAR_THRESHOLD')
  })

  test("Shell counts command and output characters for collapse", () => {
    const shellSource = sessionSource.slice(sessionSource.indexOf("function Shell("), sessionSource.indexOf("function DiffView("))
    expect(shellSource).toContain("shellPreviewText")
    expect(shellSource).toContain("collapseToolOutput(shellPreviewText(), 20,")
    expect(shellSource).toContain("previewText(shellPreviewText(), maxLines, maxChars())")
  })

  // #458：继承源 session-integration 断言——scrollbox 视口裁剪由 helper 与粘底信号驱动
  test("scrollbox uses session viewport culling helper", () => {
    expect(sessionSource).toContain("shouldCullSessionViewport")
    expect(sessionSource).toContain("stuckToBottom: viewportStuckToBottom()")
    expect(sessionSource).toContain("viewportCulling={viewportCulling()}")
    expect(sessionSource).toContain("renderAfter={syncSessionViewportStuckToBottom}")
  })

  // 首帧从实际 preview 同步决定正文挂载，不恢复已移除的内置折叠状态。
  test("BlockTool decides collapse eligibility before mounting previews", () => {
    const start = sessionSource.indexOf("function BlockTool(")
    const end = sessionSource.indexOf("function Shell(")
    const blockToolSource = sessionSource.slice(start, end)
    // 存在性检查与挂载共用一次getter求值，不能要求恢复已修复的重复构树路径。
    expect(blockToolSource).toContain("const previewTree = createMemo(() => props.preview)")
    expect(blockToolSource).toContain("const collapsed = createMemo(() => previewTree() !== undefined)")
    expect(blockToolSource).toContain("createSignal(!collapsed())")
    expect(blockToolSource).not.toContain("setCanCollapse")
  })

  // #460：首个工具 part 需要消息级顶距——无前驱兄弟时 margin=1（与文本气泡基线一致）
  test("InlineTool gives first tool part message-level top spacing", () => {
    const start = sessionSource.indexOf("function InlineToolRow(")
    const end = sessionSource.indexOf("function BlockTool(")
    const inlineToolSource = sessionSource.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(inlineToolSource).toContain('if (!previous) return 1')
  })
})

// 主会话保留共享截断入口；真实预览与展开行为另由helper和headless BlockTool用例覆盖。
describe("Session collapsed preview sentinel removal", () => {
  test("main previewText returns truncated content without ellipsis row", () => {
    // sentinel 注入形态（两种旧分支）必须全部消失，直接返回真实截断内容。
    expect(sessionSource).not.toContain('[preview, "…"].join("\\n")')
    expect(sessionSource).not.toContain(': "…"')
    expect(sessionSource).toContain("return collapseToolOutput(input, maxLines, Math.min(maxChars, DEFAULT_BLOCK_CHAR_THRESHOLD), false).output")
  })

  test("notebook previewText drops the ellipsis sentinel row", () => {
    const notebookSource = readFileSync(
      path.join(import.meta.dir, "../../../src/routes/session/notebook-tool.tsx"),
      "utf8",
    )
    expect(notebookSource).not.toContain('[...lines.slice(0, maxLines), "…"].join("\\n")')
    expect(notebookSource).toContain('lines.slice(0, maxLines).join("\\n")')
  })

  test("previewDiff no longer pushes a sentinel context row", () => {
    const previewDiffSource = readFileSync(
      path.join(import.meta.dir, "../../../src/util/preview-diff.ts"),
      "utf8",
    )
    expect(previewDiffSource).not.toContain('body.push(" …")')
  })
})

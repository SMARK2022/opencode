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
    // totalChars 统一由容器消费，长单行不能绕过 800 字符预算；卡片不再各自维护 overflow。
    expect(sessionSource).toContain("DEFAULT_BLOCK_CHAR_THRESHOLD = 800")
    expect(sessionSource).toContain("maxChars = DEFAULT_BLOCK_CHAR_THRESHOLD")
    expect(sessionSource).toContain("const charThreshold = createMemo(() => props.charThreshold ?? DEFAULT_BLOCK_CHAR_THRESHOLD)")
    expect(sessionSource).toContain("totalChars={diffContent().length}")
    expect(sessionSource).toContain('totalChars={(file.patch ?? "").length}')
    expect(sessionSource).toContain('totalChars={(diff() ?? "").length}')
    expect(sessionSource).toContain("totalChars={code().length}")
    // 这些字面申报分别覆盖 Shell、Edit、Write 与逐文件 Patch，防止某张卡继续自算 overflow。
  })

  test("Shell counts command and output characters for collapse", () => {
    const shellSource = sessionSource.slice(sessionSource.indexOf("function Shell("), sessionSource.indexOf("function DiffView("))
    expect(shellSource).toContain("shellPreviewText")
    expect(shellSource).toContain('totalLines={shellPreviewText().split("\\n").length}')
    expect(shellSource).toContain("totalChars={shellPreviewText().length}")
    expect(shellSource).toContain("previewText(shellPreviewText(), 10)")
  })

  // #458：继承源 session-integration 断言——scrollbox 视口裁剪由 helper 与粘底信号驱动
  test("scrollbox uses session viewport culling helper", () => {
    expect(sessionSource).toContain("shouldCullSessionViewport")
    expect(sessionSource).toContain("stuckToBottom: viewportStuckToBottom()")
    expect(sessionSource).toContain("viewportCulling={viewportCulling()}")
    expect(sessionSource).toContain("renderAfter={syncSessionViewportStuckToBottom}")
  })

  // 首帧由容器同步计算 collapsible，预览存在性与正文挂载共用同一棵树和同一展开状态。
  test("BlockTool decides collapse eligibility before mounting previews", () => {
    const start = sessionSource.indexOf("function BlockTool(")
    const end = sessionSource.indexOf("function Shell(")
    const blockToolSource = sessionSource.slice(start, end)
    expect(blockToolSource).toContain("const collapsible = createMemo(() => {")
    expect(blockToolSource).toContain("const previewTree = createMemo(() => props.preview)")
    expect(blockToolSource).toContain("const collapsed = createMemo(() => collapsible() && !expanded())")
    expect(blockToolSource).toContain("const hasPreview = createMemo(() => previewTree() !== undefined || errorPreview() !== undefined)")
    expect(blockToolSource).toContain("<Show when={!hasPreview() || !collapsed()}>")
    expect(blockToolSource).not.toContain("createSignal(!collapsed())")
    expect(blockToolSource).not.toContain("setCanCollapse")
    // hasPreview 同时纳入错误预览，缺失该分支时长错误会在折叠态没有可见摘要。
  })

  // 首块零内距与消息外距由 session-message-render 的真实帧覆盖，删除与恢复语义相反的源码断言。
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

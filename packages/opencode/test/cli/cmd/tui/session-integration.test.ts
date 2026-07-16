/**
 * Integration-level source assertions for the live Session route.
 *
 * These tests verify that critical smark TUI features remain wired into the
 * Session component tree by checking the source code for key integration
 * points. If a future merge removes or renames these integration points,
 * these tests will fail immediately — acting as a regression guard without
 * needing a full component mount (which requires many providers).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const sessionSource = readFileSync(
  path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui/routes/session/index.tsx"),
  "utf-8",
)

const promptSource = readFileSync(
  path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui/component/prompt/index.tsx"),
  "utf-8",
)

const blockToolSource = sessionSource.slice(
  sessionSource.indexOf("function BlockTool("),
  sessionSource.indexOf("function Shell("),
)

const shellSource = sessionSource.slice(
  sessionSource.indexOf("function Shell("),
  sessionSource.indexOf("function DiffView("),
)

describe("Session route integration points", () => {
  describe("scrollbar", () => {
    test("imports drawSmoothScrollbar", () => {
      expect(sessionSource).toContain("drawSmoothScrollbar")
    })

    test("scrollbox uses renderAfter with drawSessionScrollbar", () => {
      expect(sessionSource).toContain("renderAfter: drawSessionScrollbar")
    })

    test("scrollbar_enabled kv signal is declared", () => {
      expect(sessionSource).toContain('"scrollbar_enabled"')
    })

    test("scrollbox uses session viewport culling helper", () => {
      expect(sessionSource).toContain("shouldCullSessionViewport")
      expect(sessionSource).toContain("stuckToBottom: viewportStuckToBottom()")
      expect(sessionSource).toContain("viewportCulling={viewportCulling()}")
      expect(sessionSource).toContain("renderAfter={syncSessionViewportStuckToBottom}")
    })

    test("scrollbox has contentOptions paddingRight for scrollbar", () => {
      expect(sessionSource).toContain("contentOptions")
      expect(sessionSource).toContain("paddingRight: showScrollbar()")
    })
  })

  describe("prompt area overlay (renderBefore)", () => {
    test("footer box uses renderBefore to clear background below messages", () => {
      expect(sessionSource).toContain("renderBefore={function")
      expect(sessionSource).toContain("buffer.fillRect(x, y, width, height, theme.background)")
    })
  })

  describe("context usage panel", () => {
    test("imports ContextUsagePanel", () => {
      expect(sessionSource).toContain('import { ContextUsagePanel }')
    })

    test("renders ContextUsagePanel when contextVisible", () => {
      expect(sessionSource).toContain("<ContextUsagePanel")
      expect(sessionSource).toContain("contextVisible()")
    })

    test("session.context command is registered", () => {
      expect(sessionSource).toContain('"session.context"')
      expect(sessionSource).toContain("setContextVisible")
    })
  })

  describe("diff preview and collapse", () => {
    test("DiffView component is defined", () => {
      expect(sessionSource).toContain("function DiffView(")
    })

    test("DiffPreview component is defined", () => {
      expect(sessionSource).toContain("function DiffPreview(")
    })

    test("previewDiff is imported and used", () => {
      expect(sessionSource).toContain('import { previewDiff }')
      expect(sessionSource).toContain("previewDiff(")
    })

    test("BlockTool supports collapse props", () => {
      expect(sessionSource).toContain("maxLines")
      expect(sessionSource).toContain("threshold")
      expect(sessionSource).toContain("totalLines")
      expect(sessionSource).toContain("preview")
      expect(sessionSource).toContain("collapsible")
    })

    test("BlockTool uses one vertical spacing strategy", () => {
      expect(blockToolSource).toContain("marginTop={1}")
      expect(blockToolSource).not.toContain("gap={1}")
    })

    test("BlockTool can collapse long wrapped single-line content", () => {
      expect(sessionSource).toContain("DEFAULT_BLOCK_CHAR_THRESHOLD = 800")
      expect(sessionSource).toContain("maxChars = DEFAULT_BLOCK_CHAR_THRESHOLD")
      expect(blockToolSource).toContain("totalChars?: number")
      expect(blockToolSource).toContain("charThreshold")
      expect(blockToolSource).toContain("(props.totalChars ?? 0) > charThreshold()")
    })

    test("BlockTool decides collapse eligibility before mounting previews", () => {
      expect(blockToolSource).toContain("const collapsible = createMemo")
      expect(blockToolSource).not.toContain("setCanCollapse")
    })

    test("Shell counts command and output characters for collapse", () => {
      expect(shellSource).toContain("shellPreviewText")
      expect(shellSource).toContain("totalChars={shellPreviewText().length}")
      expect(shellSource).toContain("previewText(shellPreviewText(), 10)")
    })

    test("Edit tool shows diff stats in title", () => {
      expect(sessionSource).toContain("← Edit")
      expect(sessionSource).toContain("stats().added")
      expect(sessionSource).toContain("stats().removed")
    })

    test("Write tool shows diff when overwriting", () => {
      expect(sessionSource).toContain("isOverwrite")
      expect(sessionSource).toContain("<DiffView")
    })
  })

  describe("shell context output", () => {
    test("Shell has context output toggle", () => {
      expect(sessionSource).toContain("showContextOutput")
      expect(sessionSource).toContain("contextOutputAvailable")
      expect(sessionSource).toContain("toggleContextOutput")
    })

    test("Shell uses onRightClick for context toggle", () => {
      expect(sessionSource).toContain("onRightClick={contextOutputAvailable")
    })

    test("Shell does not show 'Model context output' inline label", () => {
      expect(shellSource).not.toContain("Model context output")
    })

    test("Shell body has marginTop spacing between command and output", () => {
      expect(shellSource).toContain("marginTop={1}")
    })
  })

  describe("text part completed remount", () => {
    test("TextPart uses completedKey for keyed remount", () => {
      expect(sessionSource).toContain("completedKey")
      expect(sessionSource).toContain("<Show keyed when={completedKey()}")
    })

    test("TextPart checks OPENCODE_EXPERIMENTAL_MARKDOWN flag", () => {
      expect(sessionSource).toContain("Flag.OPENCODE_EXPERIMENTAL_MARKDOWN")
    })

    test("streaming text keeps dev-smark CodeRenderable streaming semantics", () => {
      expect(sessionSource).toMatch(
        /<Match when={streaming\(\)}>\s*<code\s+filetype="markdown"\s+drawUnstyledText={false}\s+streaming={true}\s+syntaxStyle={syntax\(\)}\s+content={content\(\)}/,
      )
    })
  })

  describe("event dispatch", () => {
    test("global and explicit project event matches return before workspace fallback", () => {
      const eventSource = readFileSync(path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui/context/event.ts"), "utf-8")
      expect(eventSource).toMatch(
        /if \(event\.directory === "global"\) \{\s*handler\(event\.payload, \{ workspace: event\.workspace \}\)\s*return\s*\}/,
      )
      expect(eventSource).toMatch(
        /if \(event\.project\) \{\s*if \(event\.project === project\.project\(\)\) handler\(event\.payload, \{ workspace: event\.workspace \}\)\s*return\s*\}/,
      )
    })
  })

  describe("stale session refresh", () => {
    test("shouldRefreshStaleBusyStatus is imported and used", () => {
      expect(sessionSource).toContain("shouldRefreshStaleBusyStatus")
    })

    test("server.connected event triggers force sync", () => {
      expect(sessionSource).toContain('"server.connected"')
      expect(sessionSource).toContain("force: true")
    })

    test("ConnectionError check prevents navigating away", () => {
      expect(sessionSource).toContain("ConnectionError.isConnectionError")
    })
  })
})

describe("Prompt component integration points", () => {
  describe("autocomplete overlay order", () => {
    test("Autocomplete is rendered before the prompt anchor box", () => {
      const autocompleteIndex = promptSource.indexOf("<Autocomplete")
      const anchorIndex = promptSource.indexOf('<box ref={(r: BoxRenderable) => (anchor = r)')
      expect(autocompleteIndex).toBeGreaterThan(-1)
      expect(anchorIndex).toBeGreaterThan(-1)
      expect(autocompleteIndex).toBeLessThan(anchorIndex)
    })
  })

  describe("prompt border and overlay structure", () => {
    test("prompt has bottom border with ╹ char", () => {
      expect(promptSource).toContain('bottomLeft: "╹"')
    })

    test("prompt has ▀ overlay separator", () => {
      expect(promptSource).toContain('"▀"')
    })
  })

  describe("token usage display", () => {
    // 宽屏 footer 改为分拆 ↑/↓ 流量(移除累积括号)，断言锁定 Locale.number 分拆渲染与流量脉冲接线，
    // 替代旧版对 totalInput/totalOutput 渲染的断言——累积量改由 sidebar 承载，prompt 不再展示。
    test("shows split input/output flow with arrows", () => {
      expect(promptSource).toContain("usageFlow")
      expect(promptSource).toContain("Locale.number(item().input)")
      expect(promptSource).toContain("Locale.number(item().output)")
    })

    test("imports tokenAccounting", () => {
      expect(promptSource).toContain("tokenAccounting")
    })
  })
})

import { describe, expect, test } from "bun:test"
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
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
      const measured = await measureAssistantTextWidth(item)
      expect(measured).toBe(
        sessionMessageContentWidth({
          terminalWidth: item.terminalWidth,
          sidebarInLayout: item.sidebarVisible,
          scrollbarEnabled: item.scrollbarEnabled,
        }),
      )
    }
  })
})

async function measureAssistantTextWidth(input: {
  terminalWidth: number
  sidebarVisible: boolean
  scrollbarEnabled: boolean
}) {
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
    const textPart = new BoxRenderable(setup.renderer, { paddingLeft: 3, flexShrink: 0 })
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

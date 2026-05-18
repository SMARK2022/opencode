import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SmoothScrollbarMarker } from "../../../../src/cli/cmd/tui/util/smooth-scrollbar"

describe("smooth scrollbar markers", () => {
  test("SmoothScrollbarMarker interface accepts offset and RGBA color", () => {
    const marker: SmoothScrollbarMarker = {
      offset: 120,
      color: RGBA.fromInts(255, 100, 50),
    }
    expect(marker.offset).toBe(120)
    expect(marker.color.r).toBeCloseTo(1, 0)
  })

  test("drawSmoothScrollbar is exported and callable", async () => {
    const mod = await import("../../../../src/cli/cmd/tui/util/smooth-scrollbar")
    expect(typeof mod.drawSmoothScrollbar).toBe("function")
  })
})

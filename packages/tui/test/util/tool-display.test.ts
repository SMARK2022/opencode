import { describe, expect, test } from "bun:test"
import { toolDisplayMetadata, webSearchProviderLabel } from "../../src/util/tool-display"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

describe("collapseToolOutput previews", () => {
  test("bounds a 10K single line by the terminal character budget", () => {
    const output = "x".repeat(10_000)
    const maxChars = 10 * Math.max(20, 80 - 6)
    const preview = collapseToolOutput(output, 10, maxChars)
    expect(preview.overflow).toBe(true)
    expect(Array.from(preview.output).length).toBe(maxChars)
    expect(preview.output).toBe("x".repeat(maxChars - 1) + "…")
    expect(output.length).toBe(10_000)
  })

  test("keeps ten source lines and an overflow hint", () => {
    const output = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n")
    const preview = collapseToolOutput(output, 10, 1000)
    expect(preview.output).toBe([...output.split("\n").slice(0, 10), "…"].join("\n"))
    expect(preview.overflow).toBe(true)
    expect(collapseToolOutput(output.split("\n").slice(0, 10).join("\n"), 10, 1000).overflow).toBe(false)
  })

  test("counts Unicode code points without splitting surrogate pairs", () => {
    const output = String.fromCodePoint(0x1f600).repeat(10_000)
    const preview = collapseToolOutput(output, 10, 200)
    expect(Array.from(preview.output).length).toBe(200)
    expect(preview.output.endsWith("…")).toBe(true)
    expect(Array.from(preview.output).slice(0, -1).every((item) => item === String.fromCodePoint(0x1f600))).toBe(true)
  })

  test("disclosure previews keep real rows and Unicode character budgets", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")
    const preview = collapseToolOutput(output, 10, 1000, false)
    expect(preview.output).toBe(output.split("\n").slice(0, 10).join("\n"))
    expect(preview.overflow).toBe(true)
    // 隐藏sentinel不能多留半个surrogate，也不能把真实省略号字符从源内容中抹掉。
    const unicode = String.fromCodePoint(0x1f600).repeat(201)
    const clipped = collapseToolOutput(unicode, 10, 200, false)
    expect(Array.from(clipped.output)).toEqual(Array(200).fill(String.fromCodePoint(0x1f600)))
    expect(clipped.overflow).toBe(true)
    expect(collapseToolOutput("真实…内容", 10, 200, false)).toEqual({ output: "真实…内容", overflow: false })
    expect(collapseToolOutput("tail", 10, 0, false)).toEqual({ output: "", overflow: true })
  })
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an unexpected string", "other"],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
    // V2覆写展示读取完整structured，不回退到空的旧metadata。
    const write = { operation: "write", existed: true, diff: "@@ -1 +1 @@\n-before\n+after\n" }
    expect(toolDisplayMetadata({ status: "completed", metadata: {}, structured: write })).toBe(write)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "pending", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})

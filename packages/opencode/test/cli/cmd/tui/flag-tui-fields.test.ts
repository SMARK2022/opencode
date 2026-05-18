import { describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"

describe("Flag TUI-required fields", () => {
  test("OPENCODE_EXPERIMENTAL_MARKDOWN is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_EXPERIMENTAL_MARKDOWN).toBe("boolean")
  })

  test("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("boolean")
  })

  test("OPENCODE_DISABLE_EXTERNAL_SKILLS is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("boolean")
  })

  test("OPENCODE_ENABLE_QUESTION_TOOL is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_ENABLE_QUESTION_TOOL).toBe("boolean")
  })

  test("OPENCODE_ENABLE_EXA is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_ENABLE_EXA).toBe("boolean")
  })

  test("OPENCODE_EXPERIMENTAL_LSP_TOOL is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL).toBe("boolean")
  })

  test("OPENCODE_EXPERIMENTAL_PLAN_MODE is defined and boolean", () => {
    expect(typeof Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE).toBe("boolean")
  })

  test("OPENCODE_CLIENT getter returns a string", () => {
    expect(typeof Flag.OPENCODE_CLIENT).toBe("string")
  })
})

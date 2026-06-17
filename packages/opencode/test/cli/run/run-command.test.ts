import { describe, expect, test } from "bun:test"
import { resolveRunClientDirectory } from "@/cli/cmd/run"

describe("run command directory resolution", () => {
  test("resumes local sessions in their original directory unless --dir is explicit", () => {
    expect(
      resolveRunClientDirectory({
        attach: false,
        explicitDir: false,
        directory: "current",
        sessionDirectory: "session",
        fallback: "fallback",
      }),
    ).toBe("session")

    expect(
      resolveRunClientDirectory({
        attach: false,
        explicitDir: true,
        directory: "current",
        sessionDirectory: "session",
        fallback: "fallback",
      }),
    ).toBe("current")
  })

  test("preserves attach directory precedence", () => {
    expect(
      resolveRunClientDirectory({
        attach: true,
        explicitDir: false,
        directory: "attached",
        sessionDirectory: "session",
        fallback: "fallback",
      }),
    ).toBe("attached")

    expect(
      resolveRunClientDirectory({
        attach: true,
        explicitDir: false,
        sessionDirectory: "session",
        fallback: "fallback",
      }),
    ).toBe("session")
  })
})

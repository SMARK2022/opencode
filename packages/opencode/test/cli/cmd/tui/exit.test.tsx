import { expect, test } from "bun:test"
import { ExitSignals } from "@opencode-ai/tui/context/exit"

test("ExitProvider listens for terminal-driven exit signals", () => {
  expect(ExitSignals).toContain("SIGINT")
  expect(ExitSignals).toContain("SIGTERM")
  expect(ExitSignals).toContain("SIGHUP")
})

test("TUI app module imports without provider/reviewer initialization cycles", async () => {
  await expect(import("../../../../src/cli/cmd/tui/app")).resolves.toBeDefined()
})

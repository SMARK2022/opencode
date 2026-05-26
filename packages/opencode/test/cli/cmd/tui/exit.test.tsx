import { expect, test } from "bun:test"
import { ExitSignals } from "@opencode-ai/tui/context/exit"

// #235：终端驱动信号常量——app.tsx 据此注册 SIGINT/SIGTERM/SIGHUP
test("ExitProvider listens for terminal-driven exit signals", () => {
  expect(ExitSignals).toContain("SIGINT")
  expect(ExitSignals).toContain("SIGTERM")
  expect(ExitSignals).toContain("SIGHUP")
})

// #235：TUI 包整体导入不触发 provider/reviewer 初始化循环——与 thread 懒加载互补
test("TUI app module imports without provider/reviewer initialization cycles", async () => {
  await expect(import("@opencode-ai/tui")).resolves.toBeDefined()
})

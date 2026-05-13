import { expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"

// #139：锁定 discoverOrSpawn spawn detached 与 reconnect SIGUSR2 重绑
test("tui daemon spawn is detached on Unix and reconnect rebinds SIGUSR2", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = await Bun.file(path.join(here, "../../../src/cli/cmd/tui.ts")).text()
  // #139：Unix detached 防进程组 SIGINT 杀掉共享 daemon
  expect(src).toContain('detached: process.platform !== "win32"')
  // #139：reconnect 必须使用新 fwdPid 并 off 旧 handler
  expect(src).toContain("discovered.fwdPid")
  expect(src).toContain('process.off("SIGUSR2"')
})

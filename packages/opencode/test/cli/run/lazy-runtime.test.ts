import { expect, test } from "bun:test"

test("importing the run command does not execute the interactive runtime module", async () => {
  const key = Symbol.for("opencode.test.run-runtime-loaded")
  const state = globalThis as typeof globalThis & { [key: symbol]: number }
  state[key] = 0
  // 用模块替换探针观察真实的 import 副作用边界：run 命令注册只需要命令元数据，
  // 交互 runtime 子图（TUI runner 及其依赖）只有用户真正进入交互分支时才允许执行。
  Bun.plugin({
    name: "run-runtime-eager-probe",
    setup(build) {
      build.onLoad({ filter: /[\\/]cli[\\/]cmd[\\/]run[\\/]runtime\.ts$/ }, () => ({
        contents: 'globalThis[Symbol.for("opencode.test.run-runtime-loaded")]++; export {};',
        loader: "js",
      }))
    },
  })
  try {
    const command = await import("../../../src/cli/cmd/run")
    await Bun.sleep(0)
    expect(command.RunCommand.command).toContain("run")
    expect(state[key]).toBe(0)
  } finally {
    Bun.plugin.clearAll()
    delete state[key]
  }
})

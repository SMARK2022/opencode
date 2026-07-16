import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "path"

// #449 语义：bash 展开输出的命令与输出之间统一空行分隔，且不再有内联
// "Model context output" 标签——标题的 · returned to model 与上下文背景色已足够区分。
const sessionSource = readFileSync(
  path.join(import.meta.dir, "../../../src/routes/session/index.tsx"),
  "utf8",
)

describe("Session Shell output spacing", () => {
  test("Shell does not show 'Model context output' inline label", () => {
    expect(sessionSource).not.toContain("Model context output")
  })

  test("Shell body keeps consistent command/output spacing", () => {
    // 目标 Shell 容器使用 gap={1} 提供与折叠预览一致的空行分隔；
    // 源实现的 marginTop={1} 由这一容器级 gap 等价承担。
    const shellStart = sessionSource.indexOf("function Shell(props: ToolProps)")
    expect(shellStart).toBeGreaterThan(-1)
    const shellBody = sessionSource.slice(shellStart, shellStart + 6000)
    expect(shellBody).toContain("gap={1}")
    // 折叠预览的 join 数组必须显式承载空行元素，filter 只剔除 undefined 不剔除空串。
    expect(shellBody).toContain(`limited() ? "" : undefined`)
    expect(shellBody).toContain(`filter((x): x is string => x !== undefined)`)
  })
})
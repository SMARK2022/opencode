import { describe, expect, test } from "bun:test"
import { SessionPath } from "@opencode-ai/core/session/path"

// #132：Windows 全局 path 与别名
describe("SessionPath", () => {
  test("relative for non-global worktree uses path.relative style", () => {
    if (process.platform === "win32") return
    expect(SessionPath.relative("/repo", "/repo/sub")).toBe("sub")
  })

  test("normalizes Windows global session paths against the request drive", () => {
    if (process.platform !== "win32") return
    expect(SessionPath.relative("/", "F:\\ML\\PythonAIProject\\Claude-Code")).toBe("F:/ML/PythonAIProject/Claude-Code")
  })

  test("aliases include drive-relative form for global windows paths", () => {
    if (process.platform !== "win32") return
    const p = SessionPath.relative("/", "F:\\ML\\proj")
    const al = SessionPath.aliases({ path: p, directory: "F:\\ML\\proj", global: true })
    expect(al.some((item) => item.startsWith("F:/"))).toBe(true)
    expect(al.some((item) => !/^[A-Za-z]:\//.test(item))).toBe(true)
  })
})

// #132：list aliases 必须覆盖历史无盘符 path
test("aliases surface drive-relative legacy form for global windows paths", () => {
  if (process.platform !== "win32") {
    expect(SessionPath.aliases({ path: "sub", global: false })).toEqual(["sub"])
    return
  }
  const qualified = SessionPath.relative("/", "C:\\Users\\demo\\proj")
  const al = SessionPath.aliases({ path: qualified, directory: "C:\\Users\\demo\\proj", global: true })
  expect(al.some((item) => /^[A-Za-z]:\//.test(item))).toBe(true)
  expect(al.some((item) => !/^[A-Za-z]:\//.test(item))).toBe(true)
})

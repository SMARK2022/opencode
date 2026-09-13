import { describe, expect, test } from "bun:test"
import { PartView } from "../../src/session/part-view"

const patch = "+same rendered patch\n"

function editPart(metadata: Record<string, unknown>) {
  return {
    id: "prt_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "tool",
    callID: "call_1",
    tool: "edit",
    state: {
      status: "completed",
      input: { filePath: "a.ts" },
      output: "Edit applied successfully.",
      title: "a.ts",
      metadata,
      time: { start: 1, end: 2 },
    },
  } as const
}

describe("PartView.project", () => {
  test("drops filediff.patch only when it is identical to metadata.diff", () => {
    const part = editPart({ diff: patch, filediff: { file: "a.ts", patch, additions: 1, deletions: 0 }, diagnostics: {} })
    const projected = PartView.project(part)
    // 与 diff 逐字相同的 patch 是重复驻留；file/additions/deletions 属于轻量元数据必须保留。
    expect(projected.state.metadata.filediff).toEqual({ file: "a.ts", additions: 1, deletions: 0 })
    expect(projected.state.metadata.diff).toBe(patch)
    // 原对象不被改写：投影必须返回副本，共享事件/DB 对象不能就地修改。
    expect((part.state.metadata.filediff as Record<string, unknown>).patch).toBe(patch)
  })

  test("keeps filediff.patch when it differs from metadata.diff", () => {
    const part = editPart({ diff: patch, filediff: { file: "a.ts", patch: "+different\n" } })
    expect(PartView.project(part)).toBe(part)
  })

  test("keeps unknown third-party tools with same-shaped fields untouched", () => {
    // 投影只覆盖已证实重复生产的内建 edit；第三方工具恰好提供同名 diff/filediff
    // 字段时语义未知，必须原样保留，不能按字段形状猜测裁剪。
    const custom = {
      ...editPart({ diff: patch, filediff: { file: "a.ts", patch, additions: 1, deletions: 0 } }),
      tool: "third_party_custom",
    } as const
    expect(PartView.project(custom)).toBe(custom)
  })

  test("keeps non-tool, non-completed and metadata-less parts untouched", () => {
    const text = { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" } as const
    expect(PartView.project(text)).toBe(text)
    const pending = {
      ...editPart({ diff: patch, filediff: { patch } }),
      state: { status: "pending", input: {}, raw: "" },
    } as const
    expect(PartView.project(pending)).toBe(pending)
    const completed = editPart({})
    expect(PartView.project(completed)).toBe(completed)
  })
})

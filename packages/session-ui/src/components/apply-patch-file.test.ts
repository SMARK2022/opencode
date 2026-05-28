import { describe, expect, test } from "bun:test"
import { patchFiles } from "./apply-patch-file"
import { text } from "./session-diff"
import { normalizeSessionMessages } from "../../../app/src/utils/session-message"

describe("apply patch file", () => {
  test("preserves native patch files through real message projection into the patch display", () => {
    const patch = "--- src/old.ts\t\n+++ src/old.ts\t\n@@ -1,3 +0,0 @@\n-KEEP_THIS_first\n-KEEP_THIS_second\n-KEEP_THIS_third\n"
    const files = [
      { file: "src/old.ts", status: "deleted", patch, additions: 0, deletions: 3 },
      { file: "src/new.ts", status: "added", patch: "--- src/new.ts\t\n+++ src/new.ts\t\n@@ -0,0 +1 @@\n+new\n", additions: 1, deletions: 0 },
      { file: "src/edit.ts", status: "modified", patch: "--- src/edit.ts\t\n+++ src/edit.ts\t\n@@ -1 +1 @@\n-old\n+changed\n", additions: 1, deletions: 1 },
    ]
    // 经过实际App normalizer，不能用手工V1 metadata掩盖Native字段丢失。
    const result = normalizeSessionMessages("ses_patch", [{ id: "msg_user", type: "user", text: "Apply the requested patch", time: { created: 0 } }, { id: "msg_patch", type: "assistant", agent: "build", model: { id: "test", providerID: "test" }, time: { created: 1, completed: 2 }, content: [{ type: "tool", id: "patch", name: "apply_patch", time: { created: 1, ran: 1, completed: 2 }, state: { status: "completed", input: {}, content: [{ type: "text", text: patch }], ...{ structured: { files } } } }] }])
    const part = result.parts.get("msg_patch")?.find(part => part.type === "tool")
    if (!part || part.type !== "tool" || part.state.status !== "completed") throw new Error("Expected completed patch projection")
    const displayed = patchFiles(part.state.metadata.files)
    expect(displayed).toHaveLength(3)
    expect(displayed.map(file => file.type)).toEqual(["delete", "add", "update"])
    expect(displayed[0]).toMatchObject({ filePath: "src/old.ts", relativePath: "src/old.ts", additions: 0, deletions: 3 })
    expect(displayed[0]?.view.status).toBe("deleted")
    // 使用真实diff数据喂给File组件的view，删除内容不是仅保存在原始output里。
    const deleted = displayed[0]
    if (!deleted) throw new Error("Expected deleted diff")
    expect(text(deleted.view, "deletions")).toBe("KEEP_THIS_first\nKEEP_THIS_second\nKEEP_THIS_third\n")
    expect(text(deleted.view, "additions")).toBe("")
    expect(displayed[1]?.view.status).toBe("added")
    expect(displayed[2]?.view.status).toBe("modified")
  })
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })
})

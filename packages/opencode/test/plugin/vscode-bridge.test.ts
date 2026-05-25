import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { VscodeBridgePlugin } from "@/plugin/vscode-bridge"
import * as VscodeBridge from "@/ide/vscode-bridge"

afterEach(() => {
  mock.restore()
})

describe("vscode bridge plugin", () => {
  test("checks notebook mutation permissions before calling the VS Code bridge", async () => {
    const plugin = await VscodeBridgePlugin()
    const calls: Array<{ permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }> = []
    const stop = "stopped after permission check"
    const filePath = "F:\\project with spaces\\demo.ipynb"

    const context = (): ToolContext => ({
      sessionID: "ses_test",
      messageID: "msg_test",
      agent: "build",
      directory: "F:\\project with spaces",
      worktree: "F:\\project with spaces",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask(input) {
        calls.push({
          permission: input.permission,
          patterns: [...input.patterns],
          always: [...input.always],
          metadata: input.metadata,
        })
        // 这个错误是测试哨兵：权限层拒绝后，工具必须停止在本地，
        // 不能继续进入真实的 127.0.0.1 VS Code bridge 调用。
        return Effect.die(new Error(stop))
      },
    })

    await expect(
      plugin.tool.vscode_notebook_run.execute(
        {
          filePath,
          cellId: "#VSC-12345678",
          timeoutMs: 1_000,
        },
        context(),
      ),
    ).rejects.toThrow(stop)

    await expect(
      plugin.tool.vscode_notebook_edit.execute(
        {
          filePath,
          cellId: "#VSC-12345678",
          editType: "edit",
          newCode: "print('changed')",
          language: "python",
        },
        context(),
      ),
    ).rejects.toThrow(stop)

    await expect(
      plugin.tool.vscode_notebook_env.execute(
        {
          filePath,
          operation: "restart",
          reason: "test restart approval",
        },
        context(),
      ),
    ).rejects.toThrow(stop)

    expect(calls.map((call) => call.permission)).toEqual([
      "vscode_notebook_run",
      "vscode_notebook_edit",
      "vscode_notebook_env",
    ])
    for (const call of calls) {
      expect(call.patterns).toEqual([filePath])
      expect(call.always).toEqual([filePath])
      expect(call.metadata.args).toMatchObject({ filePath })
    }
  })

  test("keeps notebook edits covered by the generic edit permission gate", async () => {
    const plugin = await VscodeBridgePlugin()
    const filePath = "F:\\project with spaces\\demo.ipynb"
    const stop = "generic edit denied"
    const calls: string[] = []

    await expect(
      plugin.tool.vscode_notebook_edit.execute(
        {
          filePath,
          cellId: "#VSC-12345678",
          editType: "edit",
          newCode: "print('changed')",
          language: "python",
        },
        {
          sessionID: "ses_test",
          messageID: "msg_test",
          agent: "build",
          directory: "F:\\project with spaces",
          worktree: "F:\\project with spaces",
          abort: new AbortController().signal,
          metadata: () => undefined,
          ask(input) {
            calls.push(input.permission)
            return input.permission === "edit" ? Effect.die(new Error(stop)) : Effect.void
          },
        },
      ),
    ).rejects.toThrow(stop)

    expect(calls).toEqual(["vscode_notebook_edit", "edit"])
  })

  test("returns notebook edit diff metadata from bridge before and after source", async () => {
    const plugin = await VscodeBridgePlugin()
    const filePath = "F:\\project with spaces\\analysis notebook.ipynb"
    const bridge = spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=edit at=3 num_cells=4->4 dirty=true.",
      data: {
        path: filePath,
        editType: "edit",
        cellCountBefore: 4,
        cellCountAfter: 4,
        anchorCellIndex: 2,
        dirty: true,
        kind: "code",
        language: "python",
        beforeSource: "old value\n",
        afterSource: "new value\nrendered diff line\n",
      },
    })

    const result = await plugin.tool.vscode_notebook_edit.execute(
      {
        filePath,
        cellId: "#VSC-12345678",
        editType: "edit",
        newCode: "RAW_ONLY_SHOULD_NOT_RENDER",
      },
      allowContext(filePath),
    )

    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ path: "/notebook/edit", filePath }))
    expect(result).toMatchObject({
      output: "Notebook edit: applied=true op=edit at=3 num_cells=4->4 dirty=true.",
      metadata: {
        endpoint: "/notebook/edit",
        vscodeNotebook: {
          view: "edit",
          path: filePath,
          cellLabel: "c3",
          editType: "edit",
          cellCountBefore: 4,
          cellCountAfter: 4,
          dirty: true,
          language: "python",
          added: 2,
          removed: 1,
        },
      },
    })
    if (typeof result === "string") throw new Error("expected structured notebook edit result")
    const metadata = result.metadata ?? (() => { throw new Error("expected notebook edit metadata") })()
    expect((metadata.vscodeNotebook as Record<string, string>).diff).toContain("-old value")
    expect((metadata.vscodeNotebook as Record<string, string>).diff).toContain("+rendered diff line")
  })

  test("keeps notebook output metadata compact by excluding full artifact text", async () => {
    const plugin = await VscodeBridgePlugin()
    const filePath = "F:\\project with spaces\\analysis notebook.ipynb"
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Cell c3 id=#VSC-12345678 existing outputs: text.",
      data: {
        path: filePath,
        dirty: false,
        runtime: "Python 3.11",
        cell: { i: 3, id: "#VSC-12345678", kind: "code", lang: "python", lines: 7, exec: "succeeded", existing_outs: ["text"], first: "df.head()" },
        artifacts: [
          {
            mime: "text/plain",
            bytes: 2048,
            preview: "short preview",
            text: "full text should not be persisted into metadata",
            artifactPath: ".opencode/cache/notebook-outputs/analysis-cell-2-output-0-item-0.txt",
          },
        ],
      },
    })

    const result = await plugin.tool.vscode_notebook_output.execute(
      { filePath, cellId: "#VSC-12345678" },
      allowContext(filePath),
    )

    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "output",
          path: filePath,
          artifacts: [
            {
              mime: "text/plain",
              bytes: 2048,
              preview: "short preview",
              artifactPath: ".opencode/cache/notebook-outputs/analysis-cell-2-output-0-item-0.txt",
            },
          ],
        },
      },
    })
    expect(JSON.stringify(typeof result === "string" ? result : result.metadata)).not.toContain("full text should not be persisted")
  })

  test("labels notebook insert diff with the inserted cell index", async () => {
    const plugin = await VscodeBridgePlugin()
    const filePath = "F:\\project with spaces\\analysis notebook.ipynb"
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=insert at=4 num_cells=3->4 dirty=true.",
      data: {
        path: filePath,
        editType: "insert",
        cellCountBefore: 3,
        cellCountAfter: 4,
        anchorCellIndex: 2,
        affectedCellIndex: 3,
        dirty: true,
        language: "python",
        beforeSource: "",
        afterSource: "print('new cell')\n",
      },
    })

    const result = await plugin.tool.vscode_notebook_edit.execute(
      { filePath, cellId: "#VSC-anchor", editType: "insert", newCode: "print('new cell')" },
      allowContext(filePath),
    )

    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "edit",
          cellLabel: "c4",
          added: 1,
          removed: 0,
        },
      },
    })
    if (typeof result === "string") throw new Error("expected structured notebook insert result")
    expect((result.metadata?.vscodeNotebook as Record<string, string>).diff).toContain("#c4")
  })

  test("omits oversized notebook edit diffs from persisted metadata", async () => {
    const plugin = await VscodeBridgePlugin()
    const filePath = "F:\\project with spaces\\large notebook.ipynb"
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=edit at=1 num_cells=1->1 dirty=true.",
      data: {
        path: filePath,
        editType: "edit",
        cellCountBefore: 1,
        cellCountAfter: 1,
        anchorCellIndex: 0,
        dirty: true,
        beforeSource: "old\n",
        afterSource: `${"new line\n".repeat(3000)}`,
      },
    })

    const result = await plugin.tool.vscode_notebook_edit.execute(
      { filePath, cellId: "#VSC-large", editType: "edit", newCode: "ignored in mock" },
      allowContext(filePath),
    )

    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "edit",
          cellLabel: "c1",
          diffOmitted: "too-large",
        },
      },
    })
    if (typeof result === "string") throw new Error("expected structured oversized notebook edit result")
    expect((result.metadata?.vscodeNotebook as Record<string, unknown>).diff).toBeUndefined()
    expect(JSON.stringify(result.metadata)).not.toContain("new line\nnew line\nnew line")
  })
})

function allowContext(filePath: string): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: "F:\\project with spaces",
    worktree: "F:\\project with spaces",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask(input) {
      expect(input.patterns).toEqual([filePath])
      return Effect.void
    },
  }
}

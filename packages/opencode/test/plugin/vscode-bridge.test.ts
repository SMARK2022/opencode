import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { VscodeBridgePlugin } from "@/plugin/vscode-bridge"

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
})

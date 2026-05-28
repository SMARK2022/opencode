import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { ToolContext, PluginInput } from "@opencode-ai/plugin"
import { VscodeBridgePlugin } from "@/plugin/vscode-bridge"
import * as VscodeBridge from "@/ide/vscode-bridge"

afterEach(() => {
  mock.restore()
})

// #223：V2 的 ToolContext.ask 返回 Promise<void>，替代 V1 的 Effect.runPromise。
// VscodeBridgePlugin 需要 PluginInput 参数，但函数体不使用 input，测试只验证
// tool 定义和 execute 行为，因此传入最小 mock。
const plugin = await VscodeBridgePlugin({} as unknown as PluginInput)
// #223：V2 Plugin.tool 为可选字段——测试依赖 tool map 存在，缺失即直接失败
const tools = plugin.tool
if (!tools) throw new Error("plugin did not register tools")

describe("vscode bridge plugin", () => {
  test("checks notebook mutation permissions before calling the VS Code bridge", async () => {
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
      async ask(input) {
        calls.push({
          permission: input.permission,
          patterns: [...input.patterns],
          always: [...input.always],
          metadata: input.metadata,
        })
        // #223：权限层拒绝后，工具必须停止在本地，不能继续进入真实的 127.0.0.1 VS Code bridge 调用。
        throw new Error(stop)
      },
    })

    await expect(
      tools.vscode_notebook_run.execute(
        {
          filePath,
          cellId: "#VSC-12345678",
          timeoutMs: 1_000,
        },
        context(),
      ),
    ).rejects.toThrow(stop)

    await expect(
      tools.vscode_notebook_edit.execute(
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
      tools.vscode_notebook_env.execute(
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
    const filePath = "F:\\project with spaces\\demo.ipynb"
    const stop = "generic edit denied"
    const calls: string[] = []

    await expect(
     tools.vscode_notebook_edit.execute(
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
          async ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) {
            calls.push(input.permission)
            // #223：vscode_notebook_edit 通过后才在 edit 门禁拒绝，验证双层权限顺序
            if (input.permission === "edit") throw new Error(stop)
          },
        },
      ),
    ).rejects.toThrow(stop)

    expect(calls).toEqual(["vscode_notebook_edit", "edit"])
  })

  test("keeps notebook save covered by the generic edit permission gate", async () => {
    // #252：save 是 env 的持久化分支——必须被通用 edit 门禁覆盖，防止绕过文件写入边界
    // Use shell-looking characters as literal path data. Permission matching must
    // receive the exact notebook path string and must not normalize, split, or
    // interpret quotes, environment-variable text, pipes, redirection, or
    // subcommand-looking fragments before the approval/deny boundary runs.
    const filePath = String.raw`F:\project with spaces\$(noop) '$HOME' | redirect > demo.ipynb`
    const stop = "generic edit denied for notebook save"
    const calls: string[] = []
    const bridge = spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: true,
      summary: "save should not be reached when generic edit is denied",
      data: { path: filePath, operation: "save", saved: true },
    })

    await expect(
      plugin.tool!.vscode_notebook_env.execute(
        {
          filePath,
          operation: "save",
          reason: "permission boundary regression test",
        },
        {
          sessionID: "ses_test",
          messageID: "msg_test",
          agent: "build",
          directory: "F:\\project with spaces",
          worktree: "F:\\project with spaces",
          abort: new AbortController().signal,
          metadata: () => undefined,
          async ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) {
            calls.push(input.permission)
            expect(input.patterns).toEqual([filePath])
            expect(input.always).toEqual([filePath])
            expect(input.metadata.args).toMatchObject({ filePath, operation: "save" })
            if (input.permission === "edit") throw new Error(stop)
          },
        },
      ),
    ).rejects.toThrow(stop)

    expect(calls).toEqual(["vscode_notebook_env", "edit"])
    expect(bridge).not.toHaveBeenCalled()
    // #252：edit 拒绝时 bridge 零调用——门禁在 IO 之前，拒绝路径无副作用
  })

  test("returns the next usable cell ID after notebook insert and type-change edits", async () => {
    // #252：句柄失效场景——metadata 必须同时给出新 cellId 与原 requestedCellId
    const filePath = "F:\\project with spaces\\analysis notebook.ipynb"
    const requestedCellId = "#VSC-oldcell"
    const updatedCellId = "#VSC-newcell"
    // The bridge data shape mirrors a VS Code replaceCells type-change result:
    // the originally requested #VSC handle is stale, and the renderer metadata
    // must surface the new handle as the next safe value for follow-up tools.
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=edit at=2 num_cells=3->3 dirty=true.",
      data: {
        path: filePath,
        editType: "edit",
        cellCountBefore: 3,
        cellCountAfter: 3,
        anchorCellIndex: 1,
        dirty: true,
        kind: "markdown",
        language: "markdown",
        updatedCellId,
        beforeSource: "print('converted')\n",
        afterSource: "print('converted')\n",
      },
    })

    const result = await plugin.tool!.vscode_notebook_edit.execute(
      { filePath, cellId: requestedCellId, editType: "edit", language: "markdown" },
      allowContext(filePath),
    )

    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "edit",
          cellId: updatedCellId,
          requestedCellId,
          // #252：双句柄并存是渲染器兼容的关键——只发新句柄会让审计锚丢失
    // #252：mock 形态取自真实 type-change 响应——字段缺一会静默退化成旧句柄
        },
      },
    })
  })

  // #224：验证 notebook edit 从 bridge 返回的 beforeSource/afterSource 生成 diff metadata
  // #224：notebookResult 从 bridge data 的 before/after 生成 unified diff 并写入 metadata
  test("returns notebook edit diff metadata from bridge before and after source", async () => {
    const filePath = "F:\\project with spaces\\analysis notebook.ipynb"
    // #224：mock callBridge 返回包含 beforeSource/afterSource 的 data，notebookResult 从中生成 diff
    // #224：anchorCellIndex=2 对应 c3（0-based index + 1）
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

    const result = await tools.vscode_notebook_edit.execute(
      {
        filePath,
        cellId: "#VSC-12345678",
        editType: "edit",
        newCode: "RAW_ONLY_SHOULD_NOT_RENDER",
      },
      allowContext(filePath),
    )

    // #224：bridge 被调用时路径和 endpoint 正确
    // #224：summary 从 bridge 返回的 summary 字段提取，不改变
    // #224：callBridge 的 path 参数是 /notebook/edit，filePath 是含空格的完整路径
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
    // #224：diff 内容包含 before/after 的关键行
    // #224：createTwoFilesPatch 生成 unified diff，- 行是 beforeSource，+ 行是 afterSource
    if (typeof result === "object" && result && "metadata" in result) {
      const metadata = result.metadata as Record<string, unknown>
      const nb = metadata.vscodeNotebook as Record<string, unknown>
      expect(nb.diff as string).toContain("-old value")
      expect(nb.diff as string).toContain("+rendered diff line")
    }
  })

  // #224：验证 notebook output metadata 不包含完整 artifact text
  // #224：artifact 的 text 字段可能是大 stdout，不复制进 session part metadata
  test("keeps notebook output metadata compact by excluding full artifact text", async () => {
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

    const result = await tools.vscode_notebook_output.execute(
      { filePath, cellId: "#VSC-12345678" },
      allowContext(filePath),
    )

    // #224：artifact 只保留 mime/bytes/preview/artifactPath，不包含 text
    // #224：compactArtifacts 过滤掉了 text 字段，只保留 TUI 展示需要的元信息
    // #224：artifactPath 指向 bridge 缓存的 artifact 文件，TUI 只展示路径不读内容
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
    // #224：序列化后的 metadata 不能包含完整 artifact text
    // #224：这验证 compactArtifacts 确实排除了 text，不只是 toMatchObject 不检查它
    // #224：JSON.stringify 会序列化整个 metadata，如果 text 泄漏会在这里被发现
    expect(JSON.stringify(typeof result === "object" && result ? result.metadata : result)).not.toContain("full text should not be persisted")
  })

  // #224：验证 notebook insert 的 diff 标签使用插入位置的 cell index
  // #224：insert 的 affectedCellIndex 从 0 开始，显示为 c4
  test("labels notebook insert diff with the inserted cell index", async () => {
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
        afterSource: "print('new cell')\n++ legal source prefix\n",
      },
    })

    const result = await tools.vscode_notebook_edit.execute(
      { filePath, cellId: "#VSC-anchor", editType: "insert", newCode: "print('new cell')" },
      allowContext(filePath),
    )

    // #224：insert 的 cellLabel 使用 affectedCellIndex（从 0 开始），显示为 c4
    // #224：insert 前 3 cells，插入后 4 cells，affectedCellIndex=3 对应 c4
    // #224：diff 路径中包含 #c4 标签，供语法高亮使用
    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "edit",
          cellLabel: "c4",
          added: 2,
          removed: 0,
        },
      },
    })
    if (typeof result === "object" && result && "metadata" in result) {
      const metadata = result.metadata as Record<string, unknown>
      const nb = metadata.vscodeNotebook as Record<string, unknown>
      expect(nb.diff as string).toContain("#c4")
      // #233：insertedSourcePreview 保留 ++ 前缀源码行——hunk 作用域 diffStats 计入而非按前缀过滤
      expect(nb.insertedSourcePreview as string).toContain("print('new cell')")
      expect(nb.insertedSourcePreview as string).toContain("++ legal source prefix")
    }
  })

  // #224：验证超过 16KB 的 diff 不持久化到 metadata，只保留 diffOmitted 标记
  // #224：NOTEBOOK_DIFF_METADATA_MAX_CHARS=16KB，超过后 diff 设为 undefined
  test("omits oversized notebook edit diffs from persisted metadata", async () => {
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

    const result = await tools.vscode_notebook_edit.execute(
      { filePath, cellId: "#VSC-large", editType: "edit", newCode: "ignored in mock" },
      allowContext(filePath),
    )

    // #224：大 diff 被省略，diffOmitted 标记为 "too-large"
    // #224：3000 行 newCode 生成的 diff 远超 16KB 限制
    // #224：cellLabel=c1 因为 anchorCellIndex=0 对应 c1（0-based + 1）
    expect(result).toMatchObject({
      metadata: {
        vscodeNotebook: {
          view: "edit",
          cellLabel: "c1",
          diffOmitted: "too-large",
        },
      },
    })
    if (typeof result === "object" && result && "metadata" in result) {
      const metadata = result.metadata as Record<string, unknown>
      const nb = metadata.vscodeNotebook as Record<string, unknown>
      expect(nb.diff).toBeUndefined()
      // #224：序列化后的 metadata 不能包含重复的大段源码
      // #224：这验证 afterSource 的内容没有被泄漏到 diffOmitted 的 metadata 中
      expect(JSON.stringify(metadata)).not.toContain("new line\nnew line\nnew line")
    }
  })

  // #233：目标 VscodeBridgePlugin 签名要求 PluginInput——空对象适配，函数体不使用
  // #233：超大 insert 有界预览可见但完整源码不持久化
  test("keeps oversized notebook insert previews visible without persisting the full cell source", async () => {
    const plugin = await VscodeBridgePlugin({} as unknown as PluginInput)
    const filePath = "F:\\project with spaces\\large notebook.ipynb"
    const inserted = ["import pandas as pd", "df = pd.read_csv('large file.csv')", "df.head()", ...Array.from({ length: 3000 }, (_, i) => `row_${i}`)].join("\n")
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=insert at=4 num_cells=3->4 dirty=true.",
      data: {
        path: filePath,
        editType: "insert",
        cellCountBefore: 3,
        cellCountAfter: 4,
        affectedCellIndex: 3,
        dirty: true,
        language: "python",
        beforeSource: "",
        afterSource: inserted,
      },
    })

    const result = await plugin.tool!.vscode_notebook_edit.execute(
      { filePath, cellId: "#VSC-anchor", editType: "insert", newCode: "ignored in mock" },
      allowContext(filePath),
    )

    if (typeof result === "string") throw new Error("expected structured oversized notebook insert result")
    const metadata = result.metadata?.vscodeNotebook as Record<string, unknown>
    expect(metadata).toMatchObject({ view: "edit", editType: "insert", cellLabel: "c4", diffOmitted: "too-large" })
    expect(metadata.insertedSourcePreview).toContain("import pandas as pd")
    expect(metadata.insertedSourcePreview).toContain("df.head()")
    expect(metadata.insertedSourcePreview).not.toContain("row_2999")
    expect(metadata.insertedSourcePreviewTruncated).toBe(true)
    expect(JSON.stringify(result.metadata)).not.toContain("row_2999")
  })

  // #233：单行超大 insert 预览有界且非空
  // #233：4KB 字符上限截断单行——预览保留前缀，完整内容仍走 source 工具
  test("keeps oversized single-line notebook insert previews bounded and non-empty", async () => {
    const plugin = await VscodeBridgePlugin({} as unknown as PluginInput)
    const filePath = "F:\\project with spaces\\wide notebook.ipynb"
    const inserted = `visible-prefix-${"x".repeat(20_000)}-hidden-suffix`
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=insert at=1 num_cells=0->1 dirty=true.",
      data: {
        path: filePath,
        editType: "insert",
        cellCountBefore: 0,
        cellCountAfter: 1,
        affectedCellIndex: 0,
        dirty: true,
        language: "python",
        beforeSource: "",
        afterSource: inserted,
      },
    })

    const result = await plugin.tool!.vscode_notebook_edit.execute(
      { filePath, cellId: "BOTTOM", editType: "insert", newCode: "ignored in mock" },
      allowContext(filePath),
    )

    if (typeof result === "string") throw new Error("expected structured wide notebook insert result")
    const preview = (result.metadata?.vscodeNotebook as Record<string, unknown>).insertedSourcePreview
    expect(preview).toBeString()
    expect(preview).toContain("visible-prefix")
    expect(preview).not.toContain("hidden-suffix")
    expect((result.metadata?.vscodeNotebook as Record<string, unknown>).insertedSourcePreviewTruncated).toBe(true)
  })

  // #233：恰好十行且末尾换行的 insert 预览不算截断（尾部空行被剥离）
  // #233：diff 构造补的换行不应触发 truncated——否则 10 行内的普通插入也标记截断
  test("does not mark exact ten-line notebook insert previews truncated because of the final newline", async () => {
    const plugin = await VscodeBridgePlugin({} as unknown as PluginInput)
    const filePath = "F:\\project with spaces\\ten-line notebook.ipynb"
    const inserted = `${Array.from({ length: 10 }, (_, i) => `line_${i + 1}`).join("\n")}\n`
    spyOn(VscodeBridge, "callBridge").mockResolvedValue({
      ran: false,
      summary: "Notebook edit: applied=true op=insert at=1 num_cells=0->1 dirty=true.",
      data: {
        path: filePath,
        editType: "insert",
        cellCountBefore: 0,
        cellCountAfter: 1,
        affectedCellIndex: 0,
        dirty: true,
        language: "python",
        beforeSource: "",
        afterSource: inserted,
      },
    })

    const result = await plugin.tool!.vscode_notebook_edit.execute(
      { filePath, cellId: "BOTTOM", editType: "insert", newCode: "ignored in mock" },
      allowContext(filePath),
    )

    if (typeof result === "string") throw new Error("expected structured ten-line notebook insert result")
    const metadata = result.metadata?.vscodeNotebook as Record<string, unknown>
    expect(metadata.insertedSourcePreview).toContain("line_10")
    expect(metadata.insertedSourcePreviewTruncated).toBe(false)
  })
})

// #224：allowContext 放行所有权限 ask——用于测试 notebookResult 输出而非权限顺序
// #224：V2 的 Hooks.tool 是可选属性，测试中用 ! 断言 plugin.tool 总是存在
function allowContext(filePath: string): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: "F:\\project with spaces",
    worktree: "F:\\project with spaces",
    abort: new AbortController().signal,
    metadata: () => undefined,
    // #224：V2 的 ask 返回 Promise<void>——放行后继续到 callBridge mock
    async ask(input) {
      expect(input.patterns).toEqual([filePath])
    },
  }
}

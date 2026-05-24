import { describe, expect, test } from "bun:test"
import type { ToolContext, PluginInput } from "@opencode-ai/plugin"
import { VscodeBridgePlugin } from "@/plugin/vscode-bridge"

// #223：V2 的 ToolContext.ask 返回 Promise<void>，替代 V1 的 Effect.runPromise。
// VscodeBridgePlugin 需要 PluginInput 参数，但函数体不使用 input，测试只验证
// tool 定义和 execute 行为，因此传入最小 mock。
// #223：插件在模块加载时就初始化 tool map——V2 的 tool() 工厂返回静态定义，
// 不依赖 Effect runtime，所以顶层 await 安全
// #223：V2 Plugin.tool 为可选字段——测试依赖 tool map 存在，缺失即直接失败
const plugin = await VscodeBridgePlugin({} as unknown as PluginInput)
const tools = plugin.tool
if (!tools) throw new Error("plugin did not register tools")

describe("vscode bridge plugin", () => {
  // #223：验证三个 notebook 变更工具在调用 bridge 前都经过各自专属权限 key；
  // 如果权限层拒绝，execute 必须在本地终止，不能继续发起到 127.0.0.1 的 HTTP 调用。
  test("checks notebook mutation permissions before calling the VS Code bridge", async () => {
    const calls: Array<{ permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }> = []
    const stop = "stopped after permission check"
    const filePath = "F:\\project with spaces\\demo.ipynb"

    // #223：mock context 的 ask 记录每次权限调用的 key/patterns/always/metadata，
    // 然后立即抛错阻止 execute 继续执行——这样测试只验证权限顺序，不依赖真实 bridge。
    // #223：directory/worktree 设为含空格的 Windows 路径，验证 patterns 不被分词
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

    // #223：run 工具先经过 vscode_notebook_run 权限——这是 #178 已有的 ask，
    // 测试中 ask 立即抛错，所以 execute 不会到达 call("/notebook/run", ...)
    // #223：timeoutMs 设为 1_000 确保即使 ask 意外放行，bridge 调用也快速超时
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

    // #223：edit 工具先经过 vscode_notebook_edit 专属权限，再经过通用 edit 权限；
    // 专属 ask 抛错后不会到达 edit ask，验证专属门禁的优先级
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

    // #223：env 工具经过 vscode_notebook_env 专属权限——configure/restart/save
    // 都会改变 Jupyter/VS Code 状态，不能用通用 edit 覆盖
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

    // #223：三个工具各自只触发一个 ask（第一个 ask 就抛错），验证专属权限 key 顺序
    expect(calls.map((call) => call.permission)).toEqual([
      "vscode_notebook_run",
      "vscode_notebook_edit",
      "vscode_notebook_env",
    ])
    // #223：patterns/always 绑定到 filePath——含空格的 Windows 路径也必须原样传递，
    // 不能被 shell 分词或 URL 编码破坏
    for (const call of calls) {
      expect(call.patterns).toEqual([filePath])
      expect(call.always).toEqual([filePath])
      // #223：metadata.args 保留原始参数，供权限 UI 展示操作详情
      // #223：含空格路径不会被截断——patterns 和 metadata 同时验证
      expect(call.metadata.args).toMatchObject({ filePath })
    }
  })

  // #223：验证 notebook edit 的双层权限顺序——先 vscode_notebook_edit 后 edit；
  // 如果 agent 配置只 deny 了 edit 而允许 vscode_notebook_edit，执行仍会在 edit 门禁停止
  test("keeps notebook edits covered by the generic edit permission gate", async () => {
    const filePath = "F:\\project with spaces\\demo.ipynb"
    const stop = "generic edit denied"
    const calls: string[] = []

    // #223：mock ask 只在 permission === "edit" 时抛错，vscode_notebook_edit 放行；
    // 这样可以验证两个 ask 都被调用，且顺序是先专属后通用
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
          async ask(input) {
            calls.push(input.permission)
            // #223：vscode_notebook_edit 通过后才在 edit 门禁拒绝，验证双层权限顺序
            if (input.permission === "edit") throw new Error(stop)
          },
        },
      ),
    ).rejects.toThrow(stop)

    // #223：calls 必须精确匹配 ["vscode_notebook_edit", "edit"]——先专属后通用
    expect(calls).toEqual(["vscode_notebook_edit", "edit"])
  })
})
// #223：文件末尾——两个测试覆盖 notebook 变更工具的权限专属化和双层 edit 门禁顺序

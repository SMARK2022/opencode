import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { NotebookTools } from "@opencode-ai/core/tool/notebook"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)

it.live("registers Notebook tools through the real bridge and preserves native results", () => Effect.gen(function* () {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    tmp => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  // 真实文件只参与客户端stat与workspace选择，不导入原生处理器或启动内核。
  const filePath = path.join(tmp.path, "fixture.ipynb")
  yield* Effect.promise(() => fs.writeFile(filePath, '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
  const names = ["OPENCODE_IDE_REGISTRY_DIR", "OPENCODE_VSCODE_BRIDGE_PORT", "OPENCODE_VSCODE_BRIDGE_TOKEN", "OPENCODE_VSCODE_BRIDGE_HOST"] as const
  const before = Object.fromEntries(names.map(name => [name, process.env[name]] as const))
  // 只切换本测试进程的发现输入，退出恢复，不能让别的用例继承假编辑器端口。
  yield* Effect.addFinalizer(() => Effect.sync(() => names.forEach(name => {
    const value = before[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })))
  // 强制走临时registry，父进程已有的VS Code凭证不能成为测试的第二数据源。
  names.forEach(name => { delete process.env[name] })
  const directory = path.join(tmp.path, "registry")
  yield* Effect.promise(() => fs.mkdir(directory))
  process.env.OPENCODE_IDE_REGISTRY_DIR = directory
  const received: Array<{ path: string; method: string; auth: string | null; body: unknown }> = []
  const permissions: PermissionV2.AssertInput[] = []
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const queued = Promise.withResolvers<void>()
  // 原生响应保留nested数据，不能只断言被summaryOnly压平后的短文本。
  const envResult = { ran: false, summary: "env", data: { operation: "info", runtime: { path: "fixture-python", version: "3" }, saved_metadata: { language_info: { name: "python" } } }, note: "saved metadata kept separate" }
  const responses: Record<string, typeof NotebookTools.Output.Type> = {
    "/notebook/summary": { ran: false, summary: "summary", data: { path: filePath, dirty: false, cells: [{ i: 1, id: "#VSC-a", kind: "code" }], runtime: null } },
    "/notebook/source": { ran: false, summary: "source", data: { path: filePath, target: "cell", cellId: "#VSC-a", globalStart: 3, limit: 20, returned: 2, totalLines: 12, truncated: false } },
    // completed、原生状态和artifact各自保留，不能从summary推断执行成功。
    "/notebook/run": { ran: true, summary: "run", data: { completed: true, cells: [{ id: "#VSC-a", execution: { status: "succeeded", provenance: "current" }, artifacts: [{ mime: "image/png", bytes: 12, artifactURI: "vscode-remote://fixture/plot.png" }] }] } },
    "/notebook/output": { ran: false, summary: "output", data: { artifacts: [{ mime: "application/json", bytes: 7, text: '{"x":1}', artifactPath: path.join(tmp.path, "output.json") }] } },
    "/notebook/edit": { ran: false, summary: "edit", data: { applied: true, editType: "edit", dirty: true, affectedCellIndex: 0 } },
    "/notebook/env": envResult,
  }
  // 四操作响应各有原生状态与诊断，测试保真而不把ran当成功证明。
  const environments: Record<string, typeof NotebookTools.Output.Type> = {
    info: envResult,
    configure: { ran: true, summary: "configure", data: { path: filePath, operation: "configure", jupyterFound: true, jupyterActive: true, selectKernelAvailable: true, dirty: true } },
    restart: { ran: true, summary: "restart", data: { path: filePath, operation: "restart", requested: true, askForKernelRestartOriginal: true, askForKernelRestartSuppressed: true } },
    save: { ran: true, summary: "save", data: { path: filePath, operation: "save", saved: true, beforeDirty: true, afterDirty: false, beforeVersion: 1, afterVersion: 2, saveReturned: true }, note: "Save only on user request" },
  }
  // 唯一监听只绑定回环随机端口；release也进入最终清理，失败断言不会留下等待请求。
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const endpoint = new URL(request.url).pathname
        if (endpoint === "/health") return Response.json({ ok: true })
        if (!responses[endpoint]) return new Response("Not found", { status: 404 })
        // 保存真正收到的body/header，期望不从Schema或当前返回值反算。
        const body: unknown = await request.json()
        received.push({ path: endpoint, method: request.method, auth: request.headers.get("authorization"), body })
        if (endpoint === "/notebook/run") { started.resolve(); await release.promise }
        if (endpoint === "/notebook/env" && body && typeof body === "object" && "operation" in body && typeof body.operation === "string") return Response.json(environments[body.operation])
        return Response.json(responses[endpoint])
      },
    })),
    server => Effect.promise(async () => { release.resolve(); await server.stop(true) }),
  )
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "fixture.json"), JSON.stringify({
    schema: 1, id: "fixture", pid: process.pid, host: "127.0.0.1", port: server.port, token: "fixture-token",
    transport: "http", ideKind: "vscode", ideName: "fixture", createdAt: Date.now(), updatedAt: Date.now(),
    workspaceFolders: [{ name: "fixture", fsPath: tmp.path, uri: pathToFileURL(tmp.path).href }],
  })))
  // 真实canonical registry与fetch均执行，只替换审批交互和Location输入。
  yield* Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    let calls = 0
    const invoke = (name: string, input: Record<string, unknown>) => settleTool(registry, {
      sessionID: SessionV2.ID.make("ses_notebook_fixture"), ...toolIdentity,
      call: { type: "tool-call", id: `call-${++calls}`, name, input },
    })
    // 名字必须来自实际注册，通用edit禁令还要过滤Notebook别名。
    const definitions = yield* toolDefinitions(registry)
    expect(definitions.map(item => item.name).toSorted()).toEqual(["vscode_notebook_edit", "vscode_notebook_env", "vscode_notebook_output", "vscode_notebook_run", "vscode_notebook_source", "vscode_notebook_summary"])
    expect(definitions.find(item => item.name === "vscode_notebook_run")?.description).toContain("Explicit cell requires endpoints resolving to the same cell")
    // 检查实际广告的输入Schema，不能只更新V1插件而漏掉V2模型参数说明。
    expect(JSON.stringify(definitions.find(item => item.name === "vscode_notebook_run"))).toContain("Also supports TOP and BOTTOM")
    expect((yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).map(item => item.name)).not.toContain("vscode_notebook_edit")
    // 参数解码发生在RPC/审批之前，不用后端接收坏分页后再伪造错误。
    expect((yield* invoke("vscode_notebook_source", { filePath, limit: 1001 })).result.type).toBe("error")
    expect(received).toEqual([])
    expect(permissions).toEqual([])
    // 文本和structured分别比较，避免仅名称可用却遗失原生格或artifact信息。
    for (const [name, input, endpoint] of [
      ["vscode_notebook_summary", { filePath }, "/notebook/summary"],
      ["vscode_notebook_source", { filePath, cellId: "#VSC-a", offset: 3, limit: 20 }, "/notebook/source"],
    ] as const) {
      const result = yield* invoke(name, input)
      expect(result.result.type).toBe("text")
      expect(result.output?.structured).toEqual(responses[endpoint])
      expect(result.output?.content).toEqual([{ type: "text", text: responses[endpoint]?.summary }])
    }
    let completed = false
    // 运行必须等待真实HTTP结果，不能提前返回队列接收即当执行完成。
    const running = yield* invoke("vscode_notebook_run", { filePath, cellId: "#VSC-a", endCellId: "#VSC-b" }).pipe(
      Effect.tap(() => Effect.sync(() => { completed = true })), Effect.forkChild,
    )
    yield* Effect.promise(() => started.promise)
    expect(completed).toBe(false)
    // 排队的编辑取消后不能在前一个run释放时迟到写入。
    const cancelled = yield* invoke("vscode_notebook_edit", { filePath, cellId: "#VSC-a", editType: "edit", newCode: "never" }).pipe(Effect.forkChild)
    yield* Effect.promise(() => queued.promise)
    yield* Fiber.interrupt(cancelled)
    release.resolve()
    const run = yield* Fiber.join(running)
    expect(completed).toBe(true)
    expect(run.output?.structured).toEqual(responses["/notebook/run"])
    expect(run.output?.content).toEqual([{ type: "text", text: "run" }])
    // 四操作推进同一队列，重启不再拥有第二个工具或HTTP入口。
    for (const [name, input, endpoint] of [
      ["vscode_notebook_output", { filePath, cellId: "#VSC-a" }, "/notebook/output"],
      ["vscode_notebook_edit", { filePath, cellId: "#VSC-a", editType: "edit", newCode: ["x = 1"] }, "/notebook/edit"],
      ["vscode_notebook_env", { filePath, operation: "info" }, "/notebook/env"],
      ["vscode_notebook_env", { filePath, operation: "configure", reason: "fixture-configure" }, "/notebook/env"],
      ["vscode_notebook_env", { filePath, operation: "restart", reason: "fixture-restart" }, "/notebook/env"],
      ["vscode_notebook_env", { filePath, operation: "save", reason: "fixture-save" }, "/notebook/env"],
    ] as const) {
      const result = yield* invoke(name, input)
      const expected = "operation" in input ? environments[input.operation] : responses[endpoint]
      expect(result.result.type).toBe("text")
      expect(result.output?.structured).toEqual(expected)
      expect(result.output?.content).toEqual([{ type: "text", text: expected?.summary }])
    }
    // 最大期限也经实际canonical执行和序列化验证，默认300000的原请求断言继续保留。
    const maximum = yield* invoke("vscode_notebook_run", { filePath, cellId: "#VSC-a", timeoutMs: 3_000_000 })
    expect(maximum.result.type).toBe("text")
    expect(maximum.output?.structured).toEqual(responses["/notebook/run"])
    expect(maximum.output?.content).toEqual([{ type: "text", text: "run" }])
    // 鉴权、方法和端点均检查实际请求，不能用mock客户端绕过发现与序列化。
    expect(received.map(item => ({ path: item.path, method: item.method, auth: item.auth }))).toEqual(
      ["/notebook/summary", "/notebook/source", "/notebook/run", "/notebook/output", "/notebook/edit", "/notebook/env", "/notebook/env", "/notebook/env", "/notebook/env", "/notebook/run"].map(path => ({ path, method: "POST", auth: "Bearer fixture-token" })),
    )
    // 仅run补source规定的期限；未传oldCode/language等字段不能变为空值。
    expect(received.map(item => item.body)).toEqual([
      { filePath }, { filePath, cellId: "#VSC-a", offset: 3, limit: 20 }, { filePath, cellId: "#VSC-a", endCellId: "#VSC-b", timeoutMs: 300_000 },
      { filePath, cellId: "#VSC-a" }, { filePath, cellId: "#VSC-a", editType: "edit", newCode: ["x = 1"] }, { filePath, operation: "info" },
      { filePath, operation: "configure", reason: "fixture-configure" }, { filePath, operation: "restart", reason: "fixture-restart" }, { filePath, operation: "save", reason: "fixture-save" },
      { filePath, cellId: "#VSC-a", timeoutMs: 3_000_000 },
    ])
    // 缺操作、非法操作/原因与超上限期限都在RPC和审批前拒绝。
    expect((yield* invoke("vscode_notebook_env", { filePath })).result.type).toBe("error")
    expect((yield* invoke("vscode_notebook_env", { filePath, operation: "unknown" })).result.type).toBe("error")
    expect((yield* invoke("vscode_notebook_env", { filePath, operation: "info", reason: 123 })).result.type).toBe("error")
    expect((yield* invoke("vscode_notebook_run", { filePath, cellId: "#VSC-a", timeoutMs: 3_000_001 })).result.type).toBe("error")
    expect(received).toHaveLength(10)
    // 审批来自各自真实调用ID；被取消编辑不丢失已发生的审批事实。
    expect(permissions).toMatchObject([
      { action: "vscode_notebook_run", resources: [filePath], source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-4" } },
      { action: "edit", resources: [filePath], source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-5" } },
      { action: "edit", resources: [filePath], source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-7" } },
      { action: "vscode_notebook_run", resources: [filePath], source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-12" } },
    ])
    // 只验证原生五态响应穿过真实CLI，不在fixture重演或伪造内核判态算法。
    for (const [status, data] of [
      ["configured", { preCheck: { hasKernel: true, configured: true, probeSucceeded: true } }],
      ["selected", { selectKernel: { invoked: true, result: true, accepted: true }, probe: { postSelect: { hasKernel: false, configured: false } } }],
      ["needs-selection", { selectKernel: { invoked: true, result: false, rejectedOrCancelled: true } }],
      ["selection-requested", { selectKernel: { invoked: true } }],
      ["failed", { selectKernel: { invoked: false, error: "fixture selection failure" } }],
    ] as const) {
      const response = { ran: true, summary: `Operation: configure\nStatus: ${status}`, data: { path: filePath, operation: "configure", status, ...data }, note: "Public-API configure." }
      environments.configure = response
      const result = yield* invoke("vscode_notebook_env", { filePath, operation: "configure", reason: status })
      expect(result.result.type).toBe("text")
      expect(result.output?.structured).toEqual(response)
      expect(result.output?.content).toEqual([{ type: "text", text: response.summary }])
    }
    expect(received).toHaveLength(15)
    expect(received.slice(-5).map(item => item.body)).toEqual(["configured", "selected", "needs-selection", "selection-requested", "failed"].map(reason => ({ filePath, operation: "configure", reason })))
    expect(permissions).toHaveLength(4)
  }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, NotebookTools.node]), [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })))],
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: input => Effect.sync(() => { permissions.push(input); if (input.action === "edit") queued.resolve() }) })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])))
}))

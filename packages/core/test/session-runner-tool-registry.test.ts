import { describe, expect } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutput } from "@opencode-ai/llm"
import { adjust } from "effect/testing/TestClock"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaGetter, SchemaIssue, Scope } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import { ChildProcessSpawner } from "effect/unstable/process"
import { McpConnection } from "@opencode-ai/core/mcp/connection"
import { McpOAuthCallback } from "@opencode-ai/core/mcp/oauth-callback"
import { McpAuth } from "@opencode-ai/core/mcp/auth"
import { McpBrowser } from "@opencode-ai/core/mcp/browser"
import { McpRuntime } from "@opencode-ai/core/mcp"
import { McpTools } from "@opencode-ai/core/mcp/tools"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Tools } from "@opencode-ai/core/tool/tools"
import { testEffect } from "./lib/effect"

const bounds: ToolOutputStore.BoundInput[] = []
const retentionFailure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("disk full") })
const outputStore = Layer.mock(ToolOutputStore.Service, {
  // 本 fixture 的工具不采集原始流，无暂存文件时 discard 与真实 store 一样无操作。
  discard: () => Effect.void,
  bound: (input) => {
    if (input.toolCallID === "call-retention-failure") return Effect.fail(retentionFailure)
    return Effect.sync(() => bounds.push(input)).pipe(
      Effect.as(
        input.toolCallID === "call-bounded"
          ? {
              output: { structured: {}, content: [{ type: "text" as const, text: "bounded reference" }] },
              outputPaths: ["/managed/generic"],
            }
          : { output: input.output, outputPaths: [] },
      ),
    )
  },
})
const registryLayer = AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]])
const it = testEffect(registryLayer)
const integrated = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node]), [
    [ToolOutputStore.node, outputStore],
  ]),
)
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = SessionV2.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (permission?: string) => {
  const tool = Tool.make({
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
  return permission ? Tool.withPermission(tool, permission) : tool
}

describe("ToolRegistry", () => {
  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        question: make(),
        bash: make(),
        edit: make("edit"),
        write: make("edit"),
        apply_patch: make("edit"),
      })
      const names = (rules: Parameters<ToolRegistry.Interface["materialize"]>[0], selection?: Parameters<ToolRegistry.Interface["materialize"]>[1]) =>
        service.materialize(rules, selection).pipe(Effect.map(({ definitions }) => definitions.map((tool) => tool.name)))

      expect(yield* names([{ action: "question", resource: "*", effect: "deny" }])).toEqual([
        "bash",
        "edit",
        "write",
        "apply_patch",
      ])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "question", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["question"])
      expect(
        yield* names([
          { action: "question", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["question", "bash"])
      // 单独关闭write不能误关共享edit权限的其他工具，ask与局部资源也不等于关闭。
      expect(yield* names([], [{ action: "write", resource: "*", effect: "deny" }])).toEqual(["question", "bash", "edit", "apply_patch"])
      expect(yield* names([], [{ action: "write", resource: "*", effect: "ask" }])).toEqual(["question", "bash", "edit", "write", "apply_patch"])
      expect(yield* names([], [{ action: "write", resource: "private", effect: "deny" }])).toEqual(["question", "bash", "edit", "write", "apply_patch"])
      expect(yield* names([], [
        { action: "*", resource: "*", effect: "deny" },
        { action: "write", resource: "*", effect: "allow" },
      ])).toEqual(["write"])
      expect(yield* names([], [
        { action: "write", resource: "*", effect: "allow" },
        { action: "*", resource: "*", effect: "deny" },
      ])).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }], [
        { action: "write", resource: "*", effect: "allow" },
      ])).toEqual(["question", "bash"])
      // 内部支持工具保留；被关闭的定义不进入该快照的结算集合。
      yield* service.register({ StructuredOutput: make() })
      expect(yield* names([], [{ action: "*", resource: "*", effect: "deny" }])).toEqual(["StructuredOutput"])
      const selected = yield* service.materialize([], [{ action: "write", resource: "*", effect: "deny" }])
      expect(yield* selected.settle(call("write"))).toEqual({ result: { type: "error", value: "Unknown tool: write" } })
      expect(yield* selected.settle(call("edit"))).toMatchObject({ result: { type: "text", value: "edit" } })
      // 后续materialization重新读取选择，不把一次关闭缓存成永久注销。
      const restored = yield* service.materialize([], [{ action: "write", resource: "*", effect: "allow" }])
      expect(yield* restored.settle(call("write"))).toMatchObject({ result: { type: "text", value: "write" } })
    }),
  )

  it.effect("keeps permission decoration isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const shared = make()
      yield* service.register({ first: shared })
      yield* service.register({ second: Tool.withPermission(shared, "edit") })
      Tool.withPermission(shared, "question")

      expect(
        (yield* toolDefinitions(service, [{ action: "edit", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual(["first"])
    }),
  )

  it.effect("reuses model definitions across provider turns", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const first = yield* toolDefinitions(service)
      const second = yield* toolDefinitions(service)

      expect(second[0]).toBe(first[0])
      // 使用真实SDK协议和内存传输；不启动进程、HTTP/OAuth listener或产品宿主。
      const started = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const changed = yield* Deferred.make<void>()
      const state = { connections: 0, closes: 0, deny: false, calls: [] as CallToolRequest["params"][], permissions: [] as PermissionV2.AssertInput[] }
      const rawSchema = { type: "object" as const, properties: { mode: { type: "string" } }, not: { required: ["forbidden"] }, additionalProperties: true }
      const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: "Use the fixture tools exactly as described." })
      let description = "Original MCP description"
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo.tool", description, inputSchema: rawSchema }] }))
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        state.calls.push(request.params)
        expect(request.params.name).toBe("echo.tool")
        const token = request.params._meta?.progressToken
        expect(token).toBeDefined()
        if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1 } })
        if (request.params.arguments?.mode === "wait") {
          return await new Promise<never>((_resolve, reject) => {
            extra.signal.addEventListener("abort", () => {
              Effect.runFork(Deferred.succeed(cancelled, undefined))
              reject(new Error("cancelled fixture request"))
            }, { once: true })
            // 先安装取消监听再发布ready，避免fixture丢失同步送达的真实SDK取消通知。
            Effect.runFork(Deferred.succeed(started, undefined))
          })
        }
        if (request.params.arguments?.mode === "error") return { isError: true, content: [{ type: "text", text: "fixture rejected the request" }] }
        if (request.params.arguments?.mode === "structured") return { content: [], structuredContent: { ok: true } }
        return { structuredContent: { ok: true }, content: [
          { type: "text", text: "MCP text" },
          { type: "image", data: "AQI=", mimeType: "image/png" },
          { type: "resource", resource: { uri: "fixture://pdf", blob: "AQI=", mimeType: "application/pdf" } },
          { type: "resource", resource: { uri: "fixture://zip", blob: "AQI=", mimeType: "application/zip" } },
        ] }
      })
      server.setRequestHandler(ListResourcesRequestSchema, async request => request.params?.cursor
        ? { resources: [{ name: "second", uri: "fixture://second" }] }
        : { resources: [{ name: "first", uri: "fixture://first" }], nextCursor: "next" })
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ name: "template", uriTemplate: "fixture://{name}" }] }))
      server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ uri: request.params.uri, text: "resource body", mimeType: "text/plain" }] }))
      class MemoryClient extends Client {
        override async connect(..._transport: Parameters<Client["connect"]>) {
          state.connections++
          const pair = InMemoryTransport.createLinkedPair()
          await server.connect(pair[1])
          await super.connect(pair[0])
        }
        override async close() {
          state.closes++
          await super.close()
        }
      }
      const connection = yield* McpConnection.make({
        directory: process.cwd(), Client: MemoryClient,
        config: () => Effect.succeed(ConfigMCP.resolve([
          ConfigMigrateV1.mcp({ mcp: { fixture: { type: "remote", url: "https://mcp.fixture.invalid", oauth: false, enabled: false, timeout: 5000 } } }) ?? {},
          ConfigMigrateV1.mcp({ mcp: { fixture: { enabled: true } } }) ?? {},
        ])),
        notify: notice => notice.type === "tools_changed" ? Deferred.succeed(changed, undefined).pipe(Effect.asVoid) : Effect.void,
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(McpAuth.Service, {}), Layer.mock(McpBrowser.Service, {}), Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}))))
      const disabledConnection = yield* McpConnection.make({
        directory: process.cwd(), Client: MemoryClient,
        config: () => Effect.succeed(ConfigMCP.resolve([
          ConfigMigrateV1.mcp({ mcp: { fixture: { type: "remote", url: "https://mcp.fixture.invalid", oauth: false } } }) ?? {},
          ConfigMigrateV1.mcp({ mcp: { fixture: { enabled: false } } }) ?? {},
        ])),
        notify: () => Effect.void,
      }).pipe(Effect.provide(Layer.mergeAll(Layer.mock(McpAuth.Service, {}), Layer.mock(McpBrowser.Service, {}), Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}))))
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
      expect(yield* disabledConnection.status()).toEqual({ fixture: { status: "disabled" } })
      expect(state.connections).toBe(0)
      const permission = Layer.mock(PermissionV2.Service, { assert: input => {
        state.permissions.push(input)
        return state.deny ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "permission refused" })) : Effect.void
      } })
      const context = yield* Layer.build(McpTools.layer.pipe(
        Layer.provide(Layer.succeed(McpRuntime.Service, connection)),
        Layer.provide(Layer.succeed(Tools.Service, { register: service.register })),
        Layer.provide(permission),
      ))
      const native = Context.get(context, McpTools.Service)
      const contextFor = yield* native.prepare()
      expect(state.connections).toBe(1)
      const snapshot = yield* service.materialize()
      const definition = snapshot.definitions.find(tool => tool.name === "fixture_echo_tool")
      expect(definition?.description).toBe(description)
      expect(definition?.inputSchema).toEqual(rawSchema)
      expect(snapshot.definitions.map(tool => tool.name)).toContain("list_mcp_resources")
      expect((yield* SystemContext.initialize(contextFor(snapshot.definitions.map(tool => tool.name)))).baseline).toContain("Use the fixture tools exactly as described.")
      expect((yield* SystemContext.initialize(contextFor([]))).baseline).toBe("")
      yield* Effect.all([native.prepare(), native.prepare()], { concurrency: "unbounded" })
      expect((yield* service.materialize()).definitions.find(tool => tool.name === "fixture_echo_tool")).toBe(definition)
      const invoke = (name: string, input: Record<string, unknown>, id = "call-mcp") => snapshot.settle({ sessionID, ...identity, call: { type: "tool-call", name, id, input } })
      const media = yield* invoke("fixture_echo_tool", { mode: "media", literal: "$&" })
      expect(media.output?.structured).toEqual({ ok: true })
      expect(media.output?.content).toEqual([
        { type: "text", text: "MCP text\n\n[Binary MCP resource omitted: fixture://zip (application/zip, 2 B) is not a supported attachment type]" },
        { type: "file", uri: "data:image/png;base64,AQI=", mime: "image/png", name: undefined },
        { type: "file", uri: "data:application/pdf;base64,AQI=", mime: "application/pdf", name: "fixture://pdf" },
      ])
      expect(state.calls.at(-1)?.arguments).toEqual({ mode: "media", literal: "$&" })
      expect(state.permissions.at(-1)).toMatchObject({ action: "fixture_echo_tool", sessionID, source: { messageID: identity.assistantMessageID, callID: "call-mcp" } })
      expect((yield* invoke("fixture_echo_tool", { mode: "structured" })).result).toEqual({ type: "text", value: '{"ok":true}' })
      expect((yield* invoke("fixture_echo_tool", { mode: "error" })).result).toEqual({ type: "error", value: "fixture rejected the request" })
      const count = state.calls.length
      state.deny = true
      expect((yield* invoke("fixture_echo_tool", { mode: "media" })).result).toEqual({ type: "error", value: "permission refused" })
      expect(state.calls).toHaveLength(count)
      state.deny = false
      expect((yield* invoke("list_mcp_resources", {})).output?.structured).toMatchObject({ resources: [{ name: "first", server: "fixture" }, { name: "second", server: "fixture" }] })
      expect((yield* invoke("list_mcp_resource_templates", {})).output?.structured).toMatchObject({ resourceTemplates: [{ uriTemplate: "fixture://{name}", server: "fixture" }] })
      expect((yield* invoke("read_mcp_resource", { server: "fixture", uri: "fixture://first" })).result).toEqual({ type: "text", value: "Resource: fixture://first\nMIME: text/plain\nresource body" })
      expect(state.permissions.at(-1)).toMatchObject({ action: "read", resources: ["mcp:fixture:fixture://first"], save: ["mcp:fixture:*"] })
      // 真实SDK取消通知终止单次调用，共享client仍可继续结算下一次请求。
      const running = yield* invoke("fixture_echo_tool", { mode: "wait" }, "call-mcp-cancel").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(running)
      yield* Deferred.await(cancelled)
      expect(state.closes).toBe(0)
      expect((yield* invoke("fixture_echo_tool", { mode: "structured" })).output?.structured).toEqual({ ok: true })
      description = "Updated MCP description"
      yield* Effect.promise(() => server.sendToolListChanged())
      yield* Deferred.await(changed)
      yield* native.prepare()
      expect((yield* service.materialize()).definitions.find(tool => tool.name === "fixture_echo_tool")?.description).toBe(description)
      expect((yield* invoke("fixture_echo_tool", { mode: "structured" })).result).toEqual({ type: "error", value: "Stale tool call: fixture_echo_tool" })
      const hidden = yield* service.materialize([], [{ action: "fixture_echo_tool", resource: "*", effect: "deny" }])
      expect(hidden.definitions.map(tool => tool.name)).not.toContain("fixture_echo_tool")
      expect((yield* hidden.settle({ sessionID, ...identity, call: { type: "tool-call", name: "fixture_echo_tool", id: "disabled-mcp", input: {} } })).result).toEqual({ type: "error", value: "Unknown tool: fixture_echo_tool" })
      yield* connection.disconnect("fixture")
      yield* native.prepare()
      expect((yield* service.materialize()).definitions.map(tool => tool.name)).toEqual(["echo"])
      expect(state.closes).toBe(1)
      // 数字前缀与长合成名保持原身份；已关闭的定义不能先阻断整个Native turn。
      for (const serverName of ["1fixture", "fixture".repeat(10)]) {
        yield* connection.add(serverName, { type: "remote", url: "https://mcp.fixture.invalid", oauth: false })
        yield* native.prepare()
        const materialized = yield* service.materialize()
        const name = `${serverName}_echo_tool`
        expect(materialized.definitions.map(tool => tool.name)).toContain(name)
        const result = yield* materialized.settle({ sessionID, ...identity, call: { type: "tool-call", name, id: "named-mcp", input: { mode: "structured" } } })
        expect(result.result).toEqual({ type: "text", value: '{"ok":true}' })
        const disabled = yield* service.materialize([], [{ action: "*", resource: "*", effect: "deny" }])
        expect(disabled.definitions).toEqual([])
        expect((yield* disabled.settle({ sessionID, ...identity, call: { type: "tool-call", name, id: "disabled-named-mcp", input: {} } })).result).toEqual({ type: "error", value: `Unknown tool: ${name}` })
        yield* connection.disconnect(serverName)
        yield* native.prepare()
        expect((yield* service.materialize()).definitions.map(tool => tool.name)).toEqual(["echo"])
      }
      expect(state.closes).toBe(3)
    }),
  )

  it.live("McpConnection cleans partial clients and retries interrupted initialization", () =>
    Effect.gen(function* () {
      const watchInstalled = yield* Deferred.make<void>()
      const hangingStarted = yield* Deferred.make<void>()
      const server = new Server({ name: "fixture", version: "1" }, { capabilities: {} })
      let constructions = 0
      let fastCloses = 0
      let healthy = false
      // id=1 建立完整连接，id=2 永久挂起，构造部分成功后被中断的真实连接池。
      class MemoryClient extends Client {
        id = ++constructions
        override async connect(..._args: Parameters<Client["connect"]>) {
          if (this.id === 2) {
            await Effect.runPromise(Deferred.succeed(hangingStarted, undefined))
            return new Promise<never>(() => {})
          }
          const pair = InMemoryTransport.createLinkedPair()
          await server.connect(pair[1])
          await super.connect(pair[0])
        }
        // watch 在客户端入库后安装 handler，该信号比固定 sleep 更准确地表示可以发起中断。
        override setNotificationHandler(...args: Parameters<Client["setNotificationHandler"]>) {
          const result = super.setNotificationHandler(...args)
          if (this.id === 1) Effect.runFork(Deferred.succeed(watchInstalled, undefined))
          return result
        }
        // 只统计首个 fast client，避免重试成功后的新连接混淆资源泄漏断言。
        override async close() {
          if (this.id === 1) fastCloses++
          await super.close()
        }
      }
      const connection = yield* McpConnection.make({
        directory: process.cwd(),
        Client: MemoryClient,
        // retry 仅禁用 hanging server，验证新配置会重新求值，同时不访问真实网络。
        config: () => Effect.succeed(ConfigMCP.resolve([ConfigMigrateV1.mcp({ mcp: {
          fast: { type: "remote", url: "https://fast.fixture.invalid", oauth: false, timeout: 60000 },
          hanging: { type: "remote", url: "https://hanging.fixture.invalid", oauth: false, enabled: !healthy, timeout: 60000 },
        } }) ?? {}])),
        notify: () => Effect.void,
      }).pipe(Effect.provide(Layer.mergeAll(
        Layer.mock(McpAuth.Service, {}),
        Layer.mock(McpBrowser.Service, {}),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
      )))
      // 测试 server 独立关闭，连接池是否履行清理仍由 fastCloses 单独判定。
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
      const first = yield* connection.status().pipe(Effect.forkChild)
      const waiting = yield* connection.status().pipe(Effect.forkChild)
      yield* Deferred.await(watchInstalled)
      yield* Deferred.await(hangingStarted)
      yield* Fiber.interrupt(first)
      const waitingExit = yield* Fiber.await(waiting)
      // 同代等待者收到原始中断；失败 generation 已创建的客户端必须立即清理。
      expect(Exit.isFailure(waitingExit) && Cause.hasInterrupts(waitingExit.cause)).toBe(true)
      expect(fastCloses).toBe(1)
      healthy = true
      const retried = yield* connection.status()
      expect(retried.fast?.status).toBe("connected")
      expect(retried.hanging?.status).toBe("disabled")
      const count = constructions
      yield* connection.status()
      // 重试成功后继续使用同一连接池，不能每次 status 都重连。
      expect(constructions).toBe(count)
    }),
  )

  it.live("McpConnection keeps failed dispose isolated from OAuth and clears it after success", () =>
    Effect.gen(function* () {
      // 内存 Auth 只响应流程调用，不读取或写入真实凭据。
      const deps = Layer.mergeAll(
        Layer.mock(McpAuth.Service, {
          get: () => Effect.succeed(undefined),
          getForUrl: () => Effect.succeed(undefined),
          set: () => Effect.void,
          updateOAuthState: () => Effect.void,
          updateCodeVerifier: () => Effect.void,
          clearOAuthState: () => Effect.void,
          clearCodeVerifier: () => Effect.void,
        }),
        Layer.mock(McpBrowser.Service, {}),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
      )
      // 本机 HTTP fixture 只通过公开 401、discovery 和 token 响应驱动 SDK OAuth。
      const oauthServer = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            // RFC 8414 元数据让 SDK 自己构造授权 URL，测试不读取 transport 私有字段。
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code"],
              code_challenge_methods_supported: ["S256"],
            })
          }
          if (url.pathname === "/token" && request.method === "POST") {
            // 公开 token 响应覆盖 finishAuth 的交换与 pending provider commit。
            return Response.json({ access_token: "fixture-token", token_type: "Bearer" })
          }
          if (url.pathname === "/mcp" && request.method === "POST") {
            return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fixture"' } })
          }
          return new Response("not found", { status: 404 })
        },
      })
      const base = `http://127.0.0.1:${oauthServer.port}`
      const pending = yield* McpConnection.make({
        directory: process.cwd(),
        Client,
        // disabled 阻止普通初始化提前连接；client_id 避免动态注册，流程只经过公开端点。
        config: () => Effect.succeed(ConfigMCP.resolve([ConfigMigrateV1.mcp({ mcp: {
          pending: { type: "remote", url: `${base}/mcp`, oauth: { clientId: "fixture-client" }, enabled: false },
        } }) ?? {}])),
        notify: () => Effect.void,
      }).pipe(Effect.provide(deps))
      // 回调服务只绑定测试端口，结束后显式释放，避免影响其他 OAuth 用例。
      yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()))
      // 本机 OAuth 与 callback 服务分别关闭，避免把 discovery 生命周期误认为连接池 owner 生命周期。
      yield* Effect.addFinalizer(() => Effect.promise(() => oauthServer.stop()))
      expect((yield* pending.startAuth("pending")).authorizationUrl).toContain("/authorize")

      const hangingStarted = yield* Deferred.make<void>()
      class HangingClient extends Client {
        override async connect(..._args: Parameters<Client["connect"]>) {
          // 永久挂起让状态 generation 保持未完成，才能覆盖失败后直接 dispose。
          await Effect.runPromise(Deferred.succeed(hangingStarted, undefined))
          return new Promise<never>(() => {})
        }
      }
      // 失败 owner 使用独立 Scope，避免测试宿主把成功与失败 finalizer 混在一起。
      const failedScope = yield* Scope.make()
      const failed = yield* McpConnection.make({
        directory: process.cwd(),
        Client: HangingClient,
        config: () => Effect.succeed(ConfigMCP.resolve([ConfigMigrateV1.mcp({ mcp: {
          hanging: { type: "remote", url: "https://hanging.fixture.invalid", oauth: false },
        } }) ?? {}])),
        notify: () => Effect.void,
      }).pipe(Effect.provide(deps), Scope.provide(failedScope))
      const waiting = yield* failed.status().pipe(Effect.forkChild)
      yield* Deferred.await(hangingStarted)
      yield* Fiber.interrupt(waiting)
      // 独立关闭失败 generation 的 owner Scope，不能清除其他连接的 OAuth pending。
      yield* Scope.close(failedScope, Exit.void)
      const survived = yield* Effect.exit(pending.finishAuth("pending", "code"))
      // finishAuth 成功说明 pending transport 仍存在，而不是仅检查一个内部布尔值。
      expect(Exit.isSuccess(survived)).toBe(true)

      // 第二份 pending 与第一份生命周期无关，专门验证成功 dispose 的清理合同。
      yield* pending.startAuth("pending")
      const server = new Server({ name: "oauth-success", version: "1" }, { capabilities: {} })
      let successCloses = 0
      class SuccessClient extends Client {
        override async connect(..._args: Parameters<Client["connect"]>) {
          const pair = InMemoryTransport.createLinkedPair()
          await server.connect(pair[1])
          await super.connect(pair[0])
        }
        override async close() {
          // 成功 owner 关闭时既要断开客户端，也要执行既有 OAuth 全局清理。
          successCloses++
          await super.close()
        }
      }
      const successScope = yield* Scope.make()
      const success = yield* McpConnection.make({
        directory: process.cwd(),
        Client: SuccessClient,
        config: () => Effect.succeed(ConfigMCP.resolve([ConfigMigrateV1.mcp({ mcp: {
          fast: { type: "remote", url: "https://fast.fixture.invalid", oauth: false },
        } }) ?? {}])),
        notify: () => Effect.void,
      }).pipe(Effect.provide(deps), Scope.provide(successScope))
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
      // 先形成成功 generation，后续 Scope 关闭验证的才是成功聚合 finalizer。
      expect((yield* success.status()).fast?.status).toBe("connected")
      // 成功 generation 的聚合 finalizer 必须在 owner Scope 关闭时完整执行。
      yield* Scope.close(successScope, Exit.void)
      expect(successCloses).toBe(1)
      const cleared = yield* Effect.exit(pending.finishAuth("pending", "code"))
      // 成功 dispose 后再次出现 No pending，证明旧全局清理没有被失败隔离逻辑误删。
      expect(Exit.isFailure(cleared) && Cause.pretty(cleared.cause)).toContain("No pending OAuth flow")
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* service
        .register({ echo: make() })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        failed: Tool.make({
          description: "Failed",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.fail(new Tool.Failure({ message: "Denied" })),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ type: "error", value: "Denied" })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({ type: "error", value: "Unknown tool: missing" })

      yield* service.register({
        defect: Tool.make({
          description: "Defect",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die("unexpected executor defect"),
        }),
      })
      expect(
        yield* service.materialize().pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: "defect", name: "defect", input: {} },
            }),
          ),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("propagates retention failures through settlement", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()
      const exit = yield* materialized.settle(call("echo", "call-retention-failure")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(retentionFailure)
      expect(retentionFailure.message).toBe("Failed to write tool output: disk full")
    }),
  )

  it.effect("exposes settlement only through materialization", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      expect("definitions" in service).toBe(false)
      expect("execute" in service).toBe(false)
      expect("settle" in service).toBe(false)
      expect(typeof service.materialize).toBe("function")
    }),
  )

  it.effect("passes complete invocation identity to the canonical handler", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* service.register({
        context: Tool.make({
          description: "Context",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: (_, context) => Effect.sync(() => contexts.push(context)).pipe(Effect.as({ ok: true })),
        }),
      })
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(contexts).toEqual([{ sessionID, ...identity, toolCallID: "call-context" }])
      // 用现成TestClock验证真实结算临界：纯JSON结果不能被长成功Notice替代。
      for (const elapsed of [119999, 120000]) {
        yield* service.register({ structured: Tool.make({
          description: "Structured", input: Schema.Struct({}), output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => adjust(elapsed).pipe(Effect.as({ ok: true })),
        }) })
        const settled = yield* settleTool(service, {
          sessionID, ...identity, call: { type: "tool-call", id: `structured-${elapsed}`, name: "structured", input: {} },
        })
        expect(settled.output?.structured).toEqual({ ok: true })
        if (elapsed < 120000) {
          expect(settled.result).toEqual({ type: "json", value: { ok: true } })
          continue
        }
        expect(settled.output?.content[0]).toEqual({ type: "text", text: '{"ok":true}' })
        expect(settled.output?.content[1]).toEqual({ type: "text", text: '<opencode_notice type="execution" source="tool" severity="info" reason="completed" elapsed_ms="120000" />' })
        expect(settled.result).toEqual(ToolOutput.toResultValue(settled.output!))
      }
    }),
  )

  it.effect("encodes output and applies generic settlement bounding", () =>
    Effect.gen(function* () {
      bounds.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ bounded: make() })
      expect(
        yield* settleTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-bounded", name: "bounded", input: { text: "complete" } },
        }),
      ).toEqual({
        result: { type: "text", value: "bounded reference" },
        output: { structured: {}, content: [{ type: "text", text: "bounded reference" }] },
        outputPaths: ["/managed/generic"],
      })
      expect(bounds).toHaveLength(1)
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* service.register({
        transformed: Tool.make({
          description: "Transform values",
          input: Schema.Struct({ value: Transformed }),
          output: Schema.Struct({ value: Transformed }),
          execute: ({ value }) => Effect.sync(() => executed.push(value)).pipe(Effect.as({ value })),
          toModelOutput: ({ output }) => [{ type: "text", text: String(output.value) }],
        }),
      })

      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({ type: "text", value: "true" })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(executed).toEqual(["yes"])

      yield* service.register({
        invalid_output: Tool.make({
          description: "Return invalid output",
          input: Schema.Struct({}),
          output: Schema.Struct({
            value: Schema.Boolean.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.transform((value) => String(value)),
                encode: SchemaGetter.transformOrFail((value) =>
                  value === "valid"
                    ? Effect.succeed(true)
                    : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: "invalid output" })),
                ),
              }),
            ),
          }),
          execute: () => Effect.succeed({ value: "invalid" }),
        }),
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("invalid value for its output schema") })
    }),
  )

  it.effect("executes the unchanged registration advertised for a provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const materialized = yield* service.materialize()

      expect((yield* materialized.settle(call("echo"))).result).toEqual({ type: "text", value: "echo" })
    }),
  )

  it.effect("rejects a call when its advertised registration was removed", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("rejects only the replaced name from a multi-tool provider turn", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ first: make(), second: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ first: make() })

      expect((yield* materialized.settle(call("first"))).result).toEqual({
        type: "error",
        value: "Stale tool call: first",
      })
      expect((yield* materialized.settle(call("second"))).result).toEqual({ type: "text", value: "second" })
    }),
  )

  it.effect("treats revealing a previous overlay as stale", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const overlay = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(overlay))
      const materialized = yield* service.materialize()
      yield* Scope.close(overlay, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects an application call after a Location override is registered", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const materialized = yield* service.materialize()
      yield* service.register({ echo: make() })

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  integrated.effect("rejects a Location call after removal reveals an application registration", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const service = yield* ToolRegistry.Service
      yield* applications.register({ echo: make() })
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }).pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)

      expect((yield* materialized.settle(call("echo"))).result).toEqual({
        type: "error",
        value: "Stale tool call: echo",
      })
    }),
  )

  it.effect("keeps captured execution running after registration mutation", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* service
        .register({
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text })),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          }),
        })
        .pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      const settlement = yield* materialized.settle(call("echo")).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      yield* service.register({ echo: make() })
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(settlement)).toMatchObject({ result: { type: "text", value: "echo" } })
    }),
  )
})

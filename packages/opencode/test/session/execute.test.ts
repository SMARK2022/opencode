import { expect, spyOn } from "bun:test"
// 从库的已发布描述取示例，避免宿主测试维护另一份提示词。
import { CodeMode } from "@opencode-ai/codemode"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { LLM } from "@/session/llm"
import { LLMEvent } from "@opencode-ai/llm"
import { MessageV2 } from "@/session/message-v2"
import { PermissionReviewer } from "@/permission/reviewer/service"
import { Question } from "@/question"
import { SessionSummary } from "@/session/summary"
import { SessionRevert } from "@/session/revert"
import { debugAgent } from "@/cli/cmd/debug/agent.handler"
import { SessionPrompt } from "@/session/prompt"
import { LLMRequestPrep } from "@/session/llm/request"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const provider = ProviderTest.fake()
// 使用本机真实方言，避免测试命令与 Shell 分类器观察到两种不同语言。
const shell = process.platform === "win32" ? Bun.which("pwsh") ?? Bun.which("powershell") : Bun.which("bash")
// 空 MCP 是产品入口的原始缺口，测试必须通过正常目录找到 execute。
const layer = (flags: Partial<RuntimeFlags.Info> = {}, http?: HttpClient.HttpClient) =>
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Agent.node,
      Session.node,
      SessionProcessor.node,
      SessionGoal.node,
      Plugin.node,
      Permission.node,
      MCP.node,
      Truncate.node,
      RuntimeFlags.node,
      SessionProjector.node,
      Question.node,
      SessionSummary.node,
      SessionRevert.node,
    ]),
    [
      [Provider.node, provider.layer],
      [
        Config.node,
        TestConfig.layer({
          // 普通工具配置 allow，组合路径仍要独立预检；动态升阶用例因此也验证 allow 无法越级。
          get: () => Effect.succeed({ permission: { "*": "allow" as const }, shell: shell ?? undefined }),
          directories: () =>
            InstanceState.directory.pipe(Effect.map((directory) => [path.join(directory, ".opencode")])),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ client: "cli", ...flags })],
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          // 空连接是正常产品状态，而非网络失败替身，native execute 应在这个状态直接工作。
          tools: () => Effect.succeed({}),
          clients: () => Effect.succeed({}),
        }),
      ],
      [
        LLM.node,
        Layer.mock(LLM.Service, {
          // 仅替换外部模型：真实 processor 消费事件并登记父调用，工具仍由 SessionTools 执行。
          stream: (input) =>
            Stream.scoped(
              Stream.unwrap(
                Effect.gen(function* () {
                  const controller = yield* Effect.acquireRelease(
                    Effect.sync(() => new AbortController()),
                    (controller) => Effect.sync(() => controller.abort()),
                  )
                  // 事件负责建立父 Part，工具结果仍经真实 processor 结算，测试不自行写入成功状态。
                  const code = input.system[0]
                  const execute = input.tools.execute?.execute
                  if (code === undefined || !execute) return yield* Effect.die("Missing execute model fixture")
                  // 超时用例通过真实模型参数进入宿主，父 Part 与执行器须看到同一份输入。
                  // 保留模型显式选择的环境；省略时仍通过生产入口分配新状态，不由夹具猜测上一个 ID。
                  const args = {
                    code,
                    ...(input.system[1] ? { timeout: Number(input.system[1]) } : {}),
                    ...(input.system[2] !== undefined ? { environmentID: input.system[2] } : {}),
                  }
                  return Stream.concat(
                    Stream.concat(
                      // 注册事件先进入 processor，保证失败回执能通过同一个真实父身份持久化。
                      Stream.make(
                        LLMEvent.stepStart({ index: 0 }),
                        LLMEvent.toolInputStart({ id: "execute-stream", name: "execute" }),
                        LLMEvent.toolInputEnd({ id: "execute-stream", name: "execute" }),
                        LLMEvent.toolCall({ id: "execute-stream", name: "execute", input: args }),
                      ),
                      Stream.fromEffect(
                        Effect.tryPromise({
                          try: () =>
                            Promise.resolve(
                              execute(args, {
                                toolCallId: "execute-stream",
                                abortSignal: controller.signal,
                                messages: input.messages,
                              }),
                            ),
                          catch: (error) => error,
                        }).pipe(
                          Effect.match({
                            onSuccess: (value) =>
                              LLMEvent.toolResult({
                                id: "execute-stream",
                                name: "execute",
                                result: { type: "json", value },
                              }),
                            // 失败仍由 toolResult 事件进入 processor，父 Part 的 error 状态不能由夹具直接写入数据库。
                            onFailure: (error) =>
                              LLMEvent.toolResult({
                                id: "execute-stream",
                                name: "execute",
                                result: {
                                  type: "error",
                                  value: error instanceof Error ? error.message : String(error),
                                },
                              }),
                          }),
                        ),
                      ),
                    ),
                    // 只有工具 Promise 结算后才发送 stop；若提前结束流，测试会用模型取消掩盖宿主自己的清理行为。
                    Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" })),
                  )
                }),
              ),
            ),
        }),
      ],
      [httpClient, http ? Layer.succeed(HttpClient.HttpClient, http) : httpClient],
    ],
  )
const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

// 模型文本的 ID 与 metadata 必须一致；去掉已验证的包裹后继续保持既有业务值精确断言。
function scriptResult(result: unknown) {
  if (
    !isRecord(result) ||
    typeof result.output !== "string" ||
    !isRecord(result.metadata) ||
    typeof result.metadata.environmentID !== "string"
  )
    throw new Error("Expected execute result")
  expect(result.metadata.environmentID).toMatch(/^env_/)
  const prefix = `Environment: ${result.metadata.environmentID}\n\n`
  expect(result.output.startsWith(prefix)).toBe(true)
  // 显式保留已验证的 metadata 类型，不能让对象 spread 的索引签名抹掉恢复身份。
  return { ...result, metadata: result.metadata, output: result.output.slice(prefix.length) }
}

it.instance("debug execute uses the same native tool host", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "debug.txt"), "debug host"))
    // 仅捕获CLI输出；目录、读取、权限和解释器仍走实际入口。
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => spyOn(process.stdout, "write").mockReturnValue(true)),
      (spy) => Effect.sync(() => spy.mockRestore()),
    )
    yield* debugAgent({
      name: "build",
      tool: "execute",
      params: JSON.stringify({
        code: 'return (await tools.$opencode.read({filePath:"debug.txt"})).content;',
      }),
    }).pipe(Effect.provide(Layer.merge(provider.layer, Layer.mock(SessionPrompt.Service, {}))))
    // CLI 输出也携带同一环境句柄，业务正文仍须保持原读取结果。
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"output": "Environment: env_'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('\\n\\ndebug host"'))
  }),
)

const resolveTools = Effect.fn("TestExecute.resolveTools")(function* (
  model = provider.model,
  userTools?: Record<string, boolean>,
  promptOps?: TaskPromptOps,
  sessionID?: SessionID,
) {
  // 每例隔离 Session 与临时项目，避免审批缓存、指令 claims 或旧读记录干扰预期。
  const instance = yield* TestInstance
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const processors = yield* SessionProcessor.Service
  const goalSvc = yield* SessionGoal.Service
  // 后续模型轮次重建工具/权限/processor，但显式复用原 Session，不能靠 resolve 局部缓存伪造持久环境。
  const session = sessionID ? yield* sessions.get(sessionID) : yield* sessions.create()
  const agent = yield* agents.get("build")
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { modelID: model.id, providerID: model.providerID },
    time: { created: Date.now() },
  })
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    path: { cwd: instance.directory, root: instance.directory },
    modelID: model.id,
    providerID: model.providerID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const processor = yield* processors.create({ assistantMessage: message, sessionID: session.id, model })
  const tools = yield* SessionTools.resolve({
    agent,
    model,
    session,
    processor,
    goalSvc,
    userTools,
    bypassAgentCheck: false,
    messages: [],
    loadGoalTurn: Effect.succeed({ id: user.id, userInitiated: true }),
    // 默认夹具将意外模型调用暴露为错误；Task成功用例显式提供原promptOps边界。
    promptOps: promptOps ?? {
      cancel: () => Effect.die("Unexpected child Session cancellation"),
      resolvePromptParts: () => Effect.die("Unexpected prompt expansion"),
      // Task 恢复用例在已创建子 Session 之后失败，验证身份而不额外发起模型请求。
      prompt: () => Effect.die("Unexpected provider turn"),
    },
  })
  return { tools: tools.tools, instructions: tools.instructions, sessions, session, processor, user, agent }
})

// 用真实 native 调用和持久 child 入参证明适配发生在原权限/执行链前，而不是只放宽目录展示。
it.instance("native scalar shortcuts keep canonical object inputs and current permissions", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "scalar.txt"), "hello scalar"))
    const fixture = yield* resolveTools()
    yield* fixture.processor.process({
      user: fixture.user,
      sessionID: fixture.session.id,
      model: provider.model,
      agent: fixture.agent,
      system: [
        'const found = await tools.$opencode.glob("*.txt"); const page = await tools.$opencode.read(found.files[0].path); const hits = await tools.$opencode.grep("hello"); return {text:page.content,hits:hits.matches.length};',
      ],
      messages: [],
      tools: fixture.tools,
    })
    const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id }))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool")
    const parent = parts.find((part) => part.tool === "execute")
    if (!parent || parent.state.status !== "completed")
      throw new Error("Scalar native call failed: " + JSON.stringify(parent))
    expect(scriptResult({ output: parent.state.output, metadata: parent.state.metadata }).output).toBe(
      JSON.stringify({ text: "hello scalar", hits: 1 }, null, 2),
    )
    expect(parts.find((part) => part.tool === "glob")?.state.input).toEqual({ pattern: "*.txt" })
    expect(parts.find((part) => part.tool === "read")?.state.input).toEqual({
      filePath: path.join(instance.directory, "scalar.txt"),
    })
    expect(parts.find((part) => part.tool === "grep")?.state.input).toEqual({ pattern: "hello" })
    // 同一 shortcut 在下一轮仍服从新 deny；不能把第一轮映射或批准当成持久权限。
    const denied = yield* resolveTools(provider.model, undefined, undefined, fixture.session.id)
    yield* fixture.sessions.setPermission({
      sessionID: fixture.session.id,
      permission: [{ permission: "read", pattern: "*", action: "deny" }],
    })
    yield* denied.processor.process({
      user: denied.user,
      sessionID: denied.session.id,
      model: provider.model,
      agent: denied.agent,
      system: ['try { await tools.$opencode.read("scalar.txt") } catch { return "bypassed" }'],
      messages: [],
      tools: denied.tools,
    })
    const latest = (yield* denied.sessions.messages({ sessionID: denied.session.id }))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "execute")
      .at(-1)
    // 第二轮用 catch 尝试吞掉 deny，仍须留下真实父错误；缺失 Part 不能被当作拒绝成功。
    expect(latest?.type === "tool" && latest.state.status).toBe("error")
  }),
)

it.instance("execute catalog reaches final system and OAuth instructions with upstream invocation guidance", () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const model = { ...provider.model, api: { ...provider.model.api, id: "gpt-6-astra" } }
    // 用真实registry生成目录，再走两种provider共同的最终请求准备，避免仅证明TXT存在。
    for (const enabled of [true, false]) {
      const fixture = yield* resolveTools(model, { execute: enabled })
      if (fixture.user.role !== "user") throw new Error("Expected user fixture")
      for (const oauth of [false, true]) {
        const prepared = yield* LLMRequestPrep.prepare({
          user: { ...fixture.user, system: "User-provided instruction." },
          sessionID: fixture.session.id,
          model,
          agent: fixture.agent,
          tools: fixture.tools,
          system: ["Project instruction.", ...fixture.instructions],
          messages: [{ role: "user", content: "Inspect files" }],
          provider: provider.info,
          plugin,
          flags,
          isWorkflow: false,
          auth: oauth ? { type: "oauth", access: "test", refresh: "test", expires: 0 } : undefined,
        })
        // OAuth只使用instructions，普通请求只使用system消息；目录不能重复或漏送。
        const system = oauth
          ? String(prepared.params.options.instructions)
          : prepared.messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n")
        expect(system).toContain("Project instruction.")
        expect(system).toContain("User-provided instruction.")
        expect(system).toContain("For direct tool calls, use multi_tool_use.parallel")
        expect(prepared.messages.filter((message) => message.role === "system")).toHaveLength(oauth ? 0 : 1)
        expect(system.match(/^# Code Mode$/gm) ?? []).toHaveLength(enabled ? 1 : 0)
        if (!enabled) {
          expect(prepared.tools.execute).toBeUndefined()
          continue
        }
        // execute是附加入口；默认开启时V1直接工具仍必须进入最终provider请求。
        expect(prepared.tools.read).toBeDefined()
        expect(prepared.tools.bash).toBeDefined()
        expect(prepared.tools.execute.description).toContain("Await work whose completion matters")
        expect(prepared.tools.execute.description).toContain("Promise.allSettled")
        // 工具说明承载发现示例，动态目录承载本轮精确签名；两种 provider 出口均须保留各自职责。
        expect(system).toContain(
          "Call these tools as JavaScript inside `execute`; call tools outside this catalog directly.",
        )
        expect(system).toContain("The catalog is complete.")
        expect(system).toContain("tools.$opencode.read(input: { filePath: string;")
        expect(prepared.tools.execute.description).toContain(
          'return search({ query: "glob read", namespace: "$opencode", limit: 2 })',
        )
        expect(prepared.tools.execute.description).toContain("If a needed file tool is not shown, discover it with")
        expect(prepared.tools.execute.description).toContain("Use the exact namespaced paths and argument shapes")
        expect(system).not.toContain("search(input:")
      }
    }
  }),
)

it.instance("next provider turn resumes helpers and aliases without mutating retained state in preflight", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "saved.txt"), "current tool result"))
    const first = yield* resolveTools()
    yield* first.processor.process({
      user: first.user,
      sessionID: first.session.id,
      model: provider.model,
      agent: first.agent,
      system: ['let count = 0; const bump = () => ++count; const read = tools.$opencode.read; return "created";'],
      messages: [],
      tools: first.tools,
    })
    const firstParts = (yield* first.sessions.messages({ sessionID: first.session.id })).flatMap(
      (message) => message.parts,
    )
    const parent = firstParts.find((part) => part.type === "tool" && part.tool === "execute")
    // ID 必须来自实际父回执；只在夹具中复用 Interpreter 无法证明下一轮模型可继续调用。
    if (parent?.type !== "tool" || parent.state.status !== "completed")
      throw new Error("Expected completed creation cell")
    const environmentID = parent.state.metadata.environmentID
    expect(environmentID).toBeString()
    if (typeof environmentID !== "string") throw new Error("Missing environment handle")
    // 同一Session的新provider轮次重建宿主对象，只有词法状态能跨轮保留，旧能力不能靠闭包偷渡。
    expect(parent.state.output).toBe(`Environment: ${environmentID}\n\ncreated`)
    const second = yield* resolveTools(provider.model, undefined, undefined, first.session.id)
    yield* second.processor.process({
      user: second.user,
      sessionID: second.session.id,
      model: provider.model,
      agent: second.agent,
      system: [
        'count++; return {count: bump(), text: (await read({filePath:"saved.txt"})).content};',
        "",
        environmentID,
      ],
      messages: [],
      tools: second.tools,
    })
    const messages = yield* second.sessions.messages({ sessionID: second.session.id })
    const completed = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "execute")
    // 如果 advisory probe 接入保留状态，count 会被提前加两次；必须仍只有真实 cell 的两次修改。
    expect(completed).toHaveLength(2)
    expect(completed.at(-1)).toMatchObject({
      state: {
        status: "completed",
        metadata: { environmentID },
        output: `Environment: ${environmentID}\n\n${JSON.stringify({ count: 2, text: "current tool result" }, null, 2)}`,
      },
    })
    // 历史投影是下一轮模型实际收到的信息；数据库 metadata 存着 ID 并不等于模型能继续环境。
    expect(JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))).toContain(environmentID)
  }),
)

for (const restriction of ["permission", "catalog"] as const)
  it.instance(`saved helper obeys ${restriction} changes on a later provider turn`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "private.txt"), "must not be read"))
      const first = yield* resolveTools()
      yield* first.processor.process({
        user: first.user,
        sessionID: first.session.id,
        model: provider.model,
        agent: first.agent,
        system: [
          'const read = tools.$opencode.read; function saved() { return read({filePath:"private.txt"}) }; return "saved";',
        ],
        messages: [],
        tools: first.tools,
      })
      const parents = (yield* first.sessions.messages({ sessionID: first.session.id })).flatMap(
        (message) => message.parts,
      )
      const parent = parents.find((part) => part.type === "tool" && part.tool === "execute")
      if (parent?.type !== "tool" || parent.state.status !== "completed") throw new Error("Expected creation cell")
      const environmentID = parent.state.metadata.environmentID
      if (typeof environmentID !== "string") throw new Error("Missing environment handle")
      // catalog分支在建目录前隐藏read，permission分支建目录后拒绝read，分别覆盖发现与实际接纳。
      const second = yield* resolveTools(
        provider.model,
        restriction === "catalog" ? { read: false } : undefined,
        undefined,
        first.session.id,
      )
      // 权限在新目录已生成后收紧，强制 saved helper 到真实 leaf 接纳处再检验，不只依赖静态隐藏。
      if (restriction === "permission")
        yield* second.sessions.setPermission({
          sessionID: second.session.id,
          permission: [{ permission: "read", pattern: "*", action: "deny" }],
        })
      // permission 分支的 catch 会写入标记文件，把“普通异常可恢复”与“权限拒绝必须终止”区分开。
      const patch = "*** Begin Patch\n*** Add File: bypassed.txt\n+should not run\n*** End Patch"
      const code =
        restriction === "catalog"
          ? "await saved(); return 'bypassed';"
          : `try { await saved() } catch { await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch)}}) }; return "bypassed";`
      yield* second.processor.process({
        user: second.user,
        sessionID: second.session.id,
        model: provider.model,
        agent: second.agent,
        system: [code, "", environmentID],
        messages: [],
        tools: second.tools,
      })
      const messages = yield* second.sessions.messages({ sessionID: second.session.id })
      const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
      expect(parts.filter((part) => part.tool === "execute").at(-1)).toMatchObject({
        state: { status: "error", metadata: { environmentID } },
      })
      // 没有恢复旧目录/批准/回调，也不能把真正拒绝转为 catch 后继续写入的普通异常。
      // 检查全部历史中的 leaf，而非只看最终父错误，避免叶子已经执行后才报告拒绝。
      expect(parts.some((part) => part.tool === "read" || part.tool === "apply_patch")).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "bypassed.txt")).exists())).toBe(false)
      expect(JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))).toContain(environmentID)
    }),
  )

it.instance("cancelled cell preserves its handle through child progress and resumes only terminal state", () =>
  Effect.gen(function* () {
    const first = yield* resolveTools()
    const question = yield* Question.Service
    const pending = yield* first.processor
      .process({
        user: first.user,
        sessionID: first.session.id,
        model: provider.model,
        agent: first.agent,
        system: [
          'let n = 1; const pending = tools.$opencode.question({questions:[{question:"Cancel cell",header:"Test",options:[]}]}); await pending; n = 2;',
        ],
        messages: [],
        tools: first.tools,
      })
      .pipe(Effect.forkScoped)
    const request = yield* pollWithTimeout(
      question.list().pipe(Effect.map((items) => items.find((item) => item.questions[0]?.question === "Cancel cell"))),
      "cell question missing",
    )
    const running = (yield* first.sessions.messages({ sessionID: first.session.id }))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "execute")
    if (running?.type !== "tool" || running.state.status !== "running") throw new Error("Expected running cell")
    // 此时 child 的 running 进度已替换过父 metadata，ID 不能仅存在于最初的空进度中。
    const environmentID = running.state.metadata?.environmentID
    expect(environmentID).toBeString()
    if (typeof environmentID !== "string") throw new Error("Missing active environment handle")
    // 通过实际问题队列拒绝正在等待的 child，让取消、父进度与 Promise 终态走原服务接线。
    yield* question.reject(request.id)
    yield* awaitWithTimeout(Fiber.join(pending), "cancelled cell did not clean up")
    const messages = yield* first.sessions.messages({ sessionID: first.session.id })
    const parent = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "execute")
    // 单独检查原始字段，避免嵌套非对称 matcher 改写待送入真实模型投影的对象。
    if (parent?.type !== "tool" || parent.state.status !== "error") throw new Error("Expected cancelled cell")
    expect(parent.state.metadata?.environmentID).toBe(environmentID)
    expect(parent.state.metadata?.output).toContain(`Environment: ${environmentID}`)
    expect(JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))).toContain(
      `Environment: ${environmentID}`,
    )
    // 先确认旧交互已撤销再恢复环境，后续 allSettled 只能消费旧拒绝值，不能续接悬挂问题。
    expect(yield* question.list()).toEqual([])
    const second = yield* resolveTools(provider.model, undefined, undefined, first.session.id)
    yield* second.processor.process({
      user: second.user,
      sessionID: second.session.id,
      model: provider.model,
      agent: second.agent,
      system: [
        "const outcomes = await Promise.allSettled([pending]); return {n, status:outcomes[0].status};",
        "",
        environmentID,
      ],
      messages: [],
      tools: second.tools,
    })
    // 只取最新父回执，避免第一轮失败状态被第二轮历史查询误当成恢复结果。
    const resumed = (yield* second.sessions.messages({ sessionID: second.session.id }))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "execute")
      .at(-1)
    // 已修改的 n 保留，未执行的赋值不生效；旧 Promise 只是拒绝值，不能重开问题或中断下一轮。
    expect(resumed).toMatchObject({
      state: {
        status: "completed",
        metadata: { environmentID },
        output: `Environment: ${environmentID}\n\n${JSON.stringify({ n: 1, status: "rejected" }, null, 2)}`,
      },
    })
    expect(yield* question.list()).toEqual([])
  }),
)

it.instance("execute composes native glob and read with no MCP server", () =>
  Effect.gen(function* () {
    // 用上一步返回的路径消费下一步结果，固定路径的两个独立调用证明不了工具组合。
    // 第二次 read 专门覆盖模型 stub 与 JS 数据接收者的差异。
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "note.txt"), "hello execute"))
    const { tools } = yield* resolveTools()
    expect(tools.execute).toBeDefined()
    expect(tools.read).toBeDefined()
    const execute = tools.execute?.execute
    if (!execute) throw new Error("Native execute is absent from the resolved tool inventory")
    const result = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          {
            code: `
      const found = await tools.$opencode.glob({pattern:"*.txt"});
      const file = await tools.$opencode.read({filePath:found.files[0].path});
      const again = await tools.$opencode.read({filePath:found.files[0].path});
      const matched = await tools.$opencode.grep({pattern:"hello", path:found.files[0].path});
      const empty = await tools.$opencode.grep({pattern:"absent", path:found.files[0].path});
      const catalog = await search({query:"glob", namespace:"$opencode"});
      return {files:found, file, again:again.content, matched, empty, signature:catalog.items[0].signature};
    `,
          },
          { toolCallId: "execute-files", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    )
    if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected a model tool receipt")
    // 环境句柄不能混入业务 JSON；组合结果仍逐项验证原生工具的真实输出。
    const data = JSON.parse(scriptResult(result).output)
    expect(data.files).toEqual({
      files: [{ path: path.join(instance.directory, "note.txt"), type: "file" }],
      truncated: false,
      partial: false,
    })
    expect(data.again).toBe("hello execute")
    // 完整程序视图恰有正文与分页事实；预览、版本证明和宿主metadata留在原通道。
    expect(data.file).toEqual({
      type: "text-page",
      path: path.join(instance.directory, "note.txt"),
      content: "hello execute",
      mime: "text/plain",
      offset: 1,
      totalLines: 1,
      totalLinesExact: true,
      truncated: false,
    })
    // 搜索使用模型实际可取得的目录，验证返回字段已经进入提示而非只存在于TS类型。
    expect(data.signature).toContain("files: Array<")
    expect(data.signature).toContain("path: string")
    // R15保留完整性信息，并统一正文与定位字段；偏移仍来自真实搜索。
    expect(data.matched).toEqual({
      matches: [
        {
          path: path.join(instance.directory, "note.txt"),
          line: 1,
          offset: 0,
          content: "hello execute",
          submatches: [{ content: "hello", start: 0, end: 5 }],
        },
      ],
      totalMatches: 1,
      truncated: false,
      partial: false,
      timedOut: false,
    })
    expect(data.empty).toEqual({ matches: [], totalMatches: 0, truncated: false, partial: false, timedOut: false })
  }),
)

background.instance("execute composes structured todos, answers and resumable task results", () => Effect.gen(function* () {
  // 同一业务流覆盖原数组和任务身份；替换外部模型边界，真实工具与子Session继续执行。
  const instance = yield* TestInstance
  const sessions = yield* Session.Service
  const question = yield* Question.Service
  const fixture = yield* resolveTools(provider.model, undefined, {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{type:"text", text}]),
    prompt: (input) => Effect.gen(function* () {
      const info = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: input.sessionID, role: "assistant", parentID: input.messageID ?? MessageID.ascending(),
        agent: "general", mode: "general", path: {cwd:instance.directory, root:instance.directory},
        modelID: provider.model.id, providerID: provider.model.providerID,
        cost: 0, tokens: {input:0, output:0, reasoning:0, cache:{read:0, write:0}}, time: {created:Date.now()},
      })
      const part = yield* sessions.updatePart({id:PartID.ascending(), sessionID:info.sessionID, messageID:info.id, type:"text", text:"child reply"})
      return { info, parts: [part] }
    }),
  })
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const pending = yield* Effect.promise(() => Promise.resolve(execute({code: `
    const todos = await tools.$opencode.todowrite({todos:[{content:"inspect",status:"in_progress",priority:"high"}]});
    const answers = await tools.$opencode.question({questions:[{question:"Continue?",header:"Test",options:[]}]});
    const task = await tools.$opencode.task({description:"typed foreground",prompt:"reply",subagent_type:"general"});
    const background = await tools.$opencode.task({description:"typed background",prompt:"reply",subagent_type:"general",background:true});
    return {todos,answers,task,background};
  `}, {toolCallId:"execute-values", abortSignal:new AbortController().signal, messages:[]}))).pipe(Effect.forkScoped)
  // 使用原问题队列作为就绪信号，答案数组和任务续跑在同一JS调用中观察。
  const request = yield* pollWithTimeout(question.list().pipe(Effect.map((items) => items[0])), "question not presented")
  yield* question.reply({requestID:request.id, answers:[["continue"]]})
  const result = yield* Fiber.join(pending)
  if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected values receipt")
  // 可恢复 Task 身份与结构化 todo/question 数据仍属于脚本结果，不从环境 metadata 代取。
  const data = JSON.parse(scriptResult(result).output)
  expect(data.todos).toEqual({ todos: [{ content: "inspect", status: "in_progress", priority: "high" }] })
  expect(data.answers).toEqual({answers:[["continue"]]})
  expect(data.task.status).toBe("completed")
  expect(data.task.content).toBe("child reply")
  expect(data.background.status).toBe("running")
  // 恢复身份必须与真实子调用一致，不能靠另造一个看似有效的字符串满足输出schema。
  const ids = (yield* sessions.messages({sessionID:fixture.session.id})).flatMap((message) => message.parts)
    .flatMap((part) => part.type === "tool" && part.tool === "task" && part.state.status === "completed" ? [part.state.metadata.sessionId] : [])
  expect(ids).toEqual([data.task.sessionID, data.background.sessionID])
}))

testEffect(layer({ experimentalPlanMode: true, enableExa: true }, HttpClient.make((request) => Effect.sync(() => {
  // 只替换网络边界，真实请求构造、解析、工具和返回decoder都继续运行。
  expect(request.method).toBe("POST")
  return HttpClientResponse.fromWeb(request, Response.json({ result: { content: [{ type: "text", text: "source search content" }] } }))
})))).instance("execute returns websearch content and the approved plan identity", () => Effect.gen(function* () {
  const instance = yield* InstanceState.context
  const fixture = yield* resolveTools()
  const question = yield* Question.Service
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const pending = yield* Effect.promise(() => Promise.resolve(execute({ code: `
    const search = await tools.$opencode.websearch({query:"fixture"});
    const plan = await tools.$opencode.plan_exit(); return {search,plan};
  ` }, { toolCallId: "execute-plan", abortSignal: new AbortController().signal, messages: [] }))).pipe(Effect.forkScoped)
  // 原审批队列是就绪信号；回复前不制造批准，回复后检查真实Session切换。
  const request = yield* pollWithTimeout(question.list().pipe(Effect.map((items) => items[0])), "plan approval not presented")
  yield* question.reply({ requestID: request.id, answers: [["Yes"]] })
  const result = yield* Fiber.join(pending)
  if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected plan receipt")
  // 去掉已核验的环境行后继续校验搜索及计划工具的结构化业务字段。
  expect(JSON.parse(scriptResult(result).output)).toEqual({
    search: { content: "source search content" },
    plan: { approved: true, agent: "build", path: Session.plan(fixture.session, instance) },
  })
  expect(
    (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).findLast(
      (message) => message.info.role === "user",
    )?.info.agent,
  ).toBe("build")
}))

it.instance("execute delivers read instructions and skill context even when code returns a scalar", () => Effect.gen(function* () {
  // 目录规则放在子目录，确保来自 read 的按需加载，而非项目根 system prompt。
  // 技能目录走原发现流程；返回标量刻意让脚本丢弃两个工具的普通输出。
  const instance = yield* TestInstance
  const nested = path.join(instance.directory, "nested")
  const skill = path.join(instance.directory, ".opencode", "skills", "execute-fixture")
  yield* Effect.promise(() => mkdir(nested, { recursive: true }))
  yield* Effect.promise(() => mkdir(skill, { recursive: true }))
  yield* Effect.promise(() => Bun.write(path.join(nested, "AGENTS.md"), "Keep the execute instruction marker."))
  yield* Effect.promise(() => Bun.write(path.join(nested, "note.txt"), "private file data"))
  yield* Effect.promise(() => Bun.write(path.join(skill, "SKILL.md"), "---\nname: execute-fixture\ndescription: execute test\n---\nKeep the execute skill marker."))
  const fixture = yield* resolveTools()
  yield* fixture.processor.process({
    user: fixture.user, sessionID: fixture.session.id, model: provider.model, agent: fixture.agent,
    system: ['await tools.$opencode.read({filePath:"nested/note.txt"}); await tools.$opencode.skill({name:"execute-fixture"}); return 1;'],
    messages: [], tools: fixture.tools,
  })
  const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
  const parent = messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "execute")
  if (parent?.type !== "tool" || parent.state.status !== "completed") throw new Error("Expected completed execute")
  // 脚本摘要可丢弃数据，却不能丢弃刚加载的约束；模型投影验证最终可见性。
  expect(parent.state.metadata.loaded).toEqual([path.join(nested, "AGENTS.md")])
  expect(parent.state.metadata.skills).toEqual(["execute-fixture"])
  const projected = JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))
  expect(projected).toContain("Keep the execute instruction marker.")
  expect(projected).toContain("Keep the execute skill marker.")
  expect(projected).not.toContain("private file data")
}))

const resolveMcp = Effect.fn("TestExecute.resolveMcp")(function* (serverName = "fixtures", userTools?: Record<string, boolean>) {
  // 保留真实 MCP 协议传输；替换的仅是连接发现，SessionTools 和子记录均实际执行。
  const transport = yield* Effect.acquireRelease(Effect.promise(async () => {
    // SDK 两端真实交换请求，结构化与附件断言不能由宿主测试直接返回目标对象凑绿。
    const server = new Server({ name: "execute-fixtures", version: "1" }, { capabilities: { tools: {}, resources: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: {type: "number"}, b: {type: "number"} }, required: ["a", "b"] },
      outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] },
    }, { name: "image", description: "Return image", inputSchema: { type: "object" } }] }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => request.params.name === "image" ? {
      // 最小有效 PNG 只由远端返回，检查程序是否看见 base64 时有独立的来源。
      content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }],
    } : ({
      content: [], structuredContent: { sum: Number(request.params.arguments?.a) + Number(request.params.arguments?.b) },
    }))
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ name: "note", uri: "fixture://note", mimeType: "text/plain" }] }))
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ name: "notes", uriTemplate: "fixture://{name}" }] }))
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "actual resource content" }] }))
    const client = new Client({ name: "execute-tests", version: "1" })
    const [local, remote] = InMemoryTransport.createLinkedPair()
    await server.connect(remote)
    await client.connect(local)
    return { client, server }
  }), (transport) => Effect.promise(async () => { await transport.client.close(); await transport.server.close() }))
  // discovery 来自实际 ListTools，避免模型 schema 与远端执行者的参数契约分叉。
  const mcp = yield* MCP.Service
  const definitions = yield* Effect.promise(() => transport.client.listTools())
  const entries = Object.fromEntries(definitions.tools.map((def) => [McpCatalog.toolName(serverName, def.name), { def, client: transport.client }]))
  const fixture = yield* resolveTools(provider.model, userTools).pipe(Effect.provideService(MCP.Service, {
    ...mcp, tools: () => Effect.succeed(entries), clients: () => Effect.succeed({ [serverName]: transport.client }),
    resources: () => Effect.promise(async () => Object.fromEntries((await transport.client.listResources()).resources.map((resource) => [resource.uri, { ...resource, client: serverName }]))),
    resourceTemplates: () => Effect.promise(async () => Object.fromEntries((await transport.client.listResourceTemplates()).resourceTemplates.map((resource) => [resource.uriTemplate, { ...resource, client: serverName }]))),
    readResource: (_server, uri) => Effect.promise(() => transport.client.readResource({ uri })),
  }))
  // 模拟连接目录更新，只控制外部 discovery；接纳和拒绝仍走真实 Host。
  return { ...fixture, removeTools: Effect.sync(() => { for (const key of Object.keys(entries)) delete entries[key] }) }
})

it.instance("execute fetch uses the host permission path and never sends its preflight requests", () => Effect.gen(function* () {
  const requests: string[] = []
  const ready = Promise.withResolvers<void>()
  // 第二个真实请求到达才释放响应，证明全局fetch确实并发且预跑没有网络副作用。
  const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ port: 0, fetch: async (request) => {
    requests.push(new URL(request.url).pathname)
    if (requests.length === 2) ready.resolve()
    await ready.promise
    return Response.json({ path: new URL(request.url).pathname, method: request.method, body: await request.text(), repeated: request.headers.get("x-repeat") })
  } })), (server) => Effect.sync(() => server.stop(true)))
  const fixture = yield* resolveTools()
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const result = yield* Effect.promise(() => Promise.resolve(execute({ code: `
    const values = await Promise.allSettled([fetch(${JSON.stringify(new URL("a", server.url).href)}), fetch(${JSON.stringify(new URL("b", server.url).href)}, {method:"POST",body:"payload",headers:[["x-repeat","first"],["x-repeat","second"]]})]);
    const first = values[0].value; const second = values[1].value;
    return {first:await first.json(),second:await second.json(),status:second.status,header:second.headers.get("Content-Type"),hasHeader:second.headers.has("content-type"),bytes:(await first.bytes()).length};
  ` }, { toolCallId: "execute-fetch", abortSignal: new AbortController().signal, messages: [] })))
  if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected fetch receipt")
  // HTTP 正文、状态、重复头与字节读取保持原合同，环境行不参与响应解析。
  expect(JSON.parse(scriptResult(result).output)).toMatchObject({
    first: { path: "/a", method: "GET", body: "" },
    second: { path: "/b", method: "POST", body: "payload", repeated: "first, second" },
    status: 200,
    header: expect.stringContaining("application/json"),
    hasHeader: true,
  })
  expect(JSON.parse(scriptResult(result).output).bytes).toBeGreaterThan(0)
  // 服务器收件清单独立于脚本返回值，预跑若真发过请求，即使最后值正确也会多出记录。
  expect(requests.toSorted()).toEqual(["/a", "/b"])
  // 成功POST之后再失败，下一轮模型必须知道该操作已经完成，不能把它当待重试工作。
  const url = new URL("committed", server.url).href
  yield* fixture.processor.process({ user: fixture.user, sessionID: fixture.session.id, model: provider.model, agent: fixture.agent,
    system: [`await fetch(${JSON.stringify(url)}, {method:"POST"}); throw new Error("after-http");`], messages: [], tools: fixture.tools,
  })
  const messages = yield* fixture.sessions.messages({sessionID:fixture.session.id})
  const parent = messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "execute")
  if (parent?.type !== "tool" || parent.state.status !== "error") throw new Error("Expected failed execute receipt")
  const receipt = String(parent.state.metadata?.output)
  expect(receipt).toContain('"tool":"$codemode.fetch","status":"completed","input":{"method":"POST","url":' + JSON.stringify(url))
  const projected = yield* MessageV2.toModelMessagesEffect(messages, provider.model)
  // 仅检查错误结果正文，调用参数里的URL不能冒充完成事实已交付。
  const errors = projected.flatMap((message) => typeof message.content === "string" ? [] : message.content.flatMap((part) =>
    part.type === "tool-result" && part.output.type === "error-text" ? [part.output.value] : []))
  expect(errors.join("\n")).toContain(receipt)
  expect(requests.filter((path) => path === "/committed")).toHaveLength(1)
}))

it.instance("saved fetch alias uses the next turn permission without replaying old requests", () =>
  Effect.gen(function* () {
    const requests: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            requests.push(new URL(request.url).pathname)
            return new Response("allowed")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const first = yield* resolveTools()
    const url = JSON.stringify(new URL("saved", server.url).href)
    // 先通过真实 HTTP 成功调用别名，证明后续拒绝不是不支持保存 fetch 的假阳性。
    yield* first.processor.process({
      user: first.user,
      sessionID: first.session.id,
      model: provider.model,
      agent: first.agent,
      system: [`const savedFetch = fetch; return await (await savedFetch(${url})).text();`],
      messages: [],
      tools: first.tools,
    })
    const created = (yield* first.sessions.messages({ sessionID: first.session.id }))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "execute")
    if (created?.type !== "tool" || created.state.status !== "completed")
      throw new Error("Expected saved HTTP capability")
    const environmentID = created.state.metadata.environmentID
    if (typeof environmentID !== "string") throw new Error("Missing fetch environment")
    expect(created.state.output).toBe(`Environment: ${environmentID}\n\nallowed`)
    const second = yield* resolveTools(provider.model, undefined, undefined, first.session.id)
    yield* second.sessions.setPermission({
      sessionID: second.session.id,
      permission: [{ permission: "webfetch", pattern: "*", action: "deny" }],
    })
    // 使用新 turn 的权限，真实拒绝须穿透 JS catch，不能恢复上轮批准或继续第二次网络调用。
    yield* second.processor.process({
      user: second.user,
      sessionID: second.session.id,
      model: provider.model,
      agent: second.agent,
      system: [`try { await savedFetch(${url}) } catch { await fetch(${url}) }; return "bypassed";`, "", environmentID],
      messages: [],
      tools: second.tools,
    })
    const messages = yield* second.sessions.messages({ sessionID: second.session.id })
    const denied = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "execute")
      .at(-1)
    expect(denied).toMatchObject({ state: { status: "error", metadata: { environmentID } } })
    // 独立服务器只应收到首轮请求，能发现别名沿用旧权限或 catch 发起第二次网络调用。
    expect(requests).toEqual(["/saved"])
    expect(JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))).toContain(
      `Environment: ${environmentID}`,
    )
  }),
)

it.instance("execute shares native lifecycle for a real MCP structured call", () =>
  Effect.gen(function* () {
    // 返回值来自远端求和；数据库断言另行证明同一次调用经过原 native 子记录生命周期。
    // 两个观察面并用，防止仅返回正确聚合值却丢失文件审计归属。
    const fixture = yield* resolveMcp()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const result = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          {
            code: "const result = await tools.fixtures.add({a:2,b:3}); return result.sum;",
          },
          { toolCallId: "execute-mcp", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    )
    // 实际 MCP 返回仍是数字求和值；环境前缀不可改变远端结果类型。
    expect(scriptResult(result)).toMatchObject({ output: "5" })
    const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
    // 从公开 Session 历史确认一次真实子调用，结果来自结构化返回而非文本再解析。
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toMatchObject([
      {
        tool: "fixtures_add",
        metadata: { executeParent: "execute-mcp" },
        state: { status: "completed", input: { a: 2, b: 3 } },
      },
    ])
  }),
)

it.instance("MCP media stays out of JS data while the parent returns its attachment", () =>
  Effect.gen(function* () {
    // 模型的文本与附件分开断言，传回 marker 不能以丢失实际图片为代价。
    const fixture = yield* resolveMcp()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const result = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          { code: "const image = await tools.fixtures.image({}); return {image};" },
          { toolCallId: "execute-media", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    )
    if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected media receipt")
    // 环境包装不得把图片字节送回脚本；原生附件通道仍独立交付。
    expect(scriptResult(result).output).not.toContain("iVBOR")
    expect(scriptResult(result)).toMatchObject({
      output: expect.stringContaining("1 image attached"),
      attachments: [{ mime: "image/png", url: expect.stringContaining("data:image/png;base64,") }],
    })
  }),
)

it.instance("truncated parent context retains a recovery path and clears delivery claims", () => Effect.gen(function* () {
  // 文件正文保持很短，只让按需规则超过原 Truncate 限额，定位父上下文的交付边界。
  // 读取恢复文件证明完整内容有去处，而非仅设置 truncated 标志。
  const instance = yield* TestInstance
  const nested = path.join(instance.directory, "nested")
  yield* Effect.promise(() => mkdir(nested, { recursive: true }))
  const instructions = "Required execute instruction.\n".repeat(3000)
  yield* Effect.promise(() => Bun.write(path.join(nested, "AGENTS.md"), instructions))
  yield* Effect.promise(() => Bun.write(path.join(nested, "note.txt"), "data"))
  const fixture = yield* resolveTools()
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const result = yield* Effect.promise(() => Promise.resolve(execute({ code: 'await tools.$opencode.read({filePath:"nested/note.txt"}); return 1;' },
    { toolCallId: "execute-truncated", abortSignal: new AbortController().signal, messages: [] })))
  if (!isRecord(result) || !isRecord(result.metadata) || typeof result.metadata.outputPath !== "string") throw new Error("Expected recoverable truncated output")
  const outputPath = result.metadata.outputPath
  // 原 Truncate 服务保存完整正文；父回执的 loaded/skills 只表示已完整送入模型的规则。
  expect(result.metadata.truncated).toBe(true)
  expect(result.metadata.loaded).toEqual([])
  expect(result.metadata.skills).toEqual([])
  expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toContain(instructions)
}))

it.instance("disabling execute keeps MCP directly callable and removes disabled native tools", () => Effect.gen(function* () {
  // 用户关闭编排入口后，远端能力仍从既有直接工具入口提供，调用不会触发另一套执行器。
  // 同时关闭 read，检验 user.tools 对 native 与 execute 采用同一筛选路径。
  const fixture = yield* resolveMcp("fixtures", { execute: false, read: false })
  expect(fixture.tools.execute).toBeUndefined()
  expect(fixture.tools.read).toBeUndefined()
  const add = fixture.tools.fixtures_add?.execute
  if (!add) throw new Error("Expected direct MCP tool")
  expect(yield* Effect.promise(() => Promise.resolve(add({ a: 2, b: 3 }, {
    toolCallId: "direct-mcp", abortSignal: new AbortController().signal, messages: [],
  })))).toMatchObject({ output: '{"sum":5}' })
}))

it.instance("MCP removal during an awaited question blocks its next invocation", () => Effect.gen(function* () {
  // 问题提供可观察的暂停点；目录先已广告成功，再更新连接发现，才能验证实时接纳。
  // 拒绝后检查真实 Session 中没有 MCP child，区分拒绝接纳与远端执行后报错。
  const fixture = yield* resolveMcp()
  const question = yield* Question.Service
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  // 别名来自前一单元，恢复它不能复活已经从当前 MCP discovery 移除的客户端。
  const created = yield* Effect.promise(() =>
    Promise.resolve(
      execute(
        { code: 'const remote = tools.fixtures.add; return "saved";' },
        { toolCallId: "execute-save-mcp", abortSignal: new AbortController().signal, messages: [] },
      ),
    ),
  )
  if (!isRecord(created) || !isRecord(created.metadata) || typeof created.metadata.environmentID !== "string")
    throw new Error("Missing MCP environment")
  // 回调只捕获已验证的不可变 ID，不依赖跨异步闭包失效的嵌套属性收窄。
  const environmentID = created.metadata.environmentID
  const pending = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        execute(
          {
            environmentID,
            code: 'await tools.$opencode.question({questions:[{question:"Ready?",header:"Test",options:[]}]}); try {return await remote({a:1,b:2});} catch {return "bypassed";}',
          },
          { toolCallId: "execute-disconnect", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    catch: (error) => error,
  }).pipe(Effect.exit, Effect.forkScoped)
  const request = yield* pollWithTimeout(question.list().pipe(Effect.map((items) => items[0])), "question not presented")
  // 先移除 discovery 再释放问题，确保保存的别名在继续时面对已失效的远端工具。
  yield* fixture.removeTools
  yield* question.reply({ requestID: request.id, answers: [["continue"]] })
  expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
  const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).flatMap((message) => message.parts)
  expect(parts.some((part) => part.type === "tool" && part.tool === "fixtures_add")).toBe(false)
}))

it.instance("execute composes MCP resource listing, templates and reading", () =>
  Effect.gen(function* () {
    // resource 入口原本独立于工具目录；通过同一 execute 验证其权限和结果适配也已汇合。
    // 模板与普通资源同时存在，防止仅为 list 增加特殊入口而遗漏另外两个操作。
    const fixture = yield* resolveMcp()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    // 读取 URI 来自真实列表结果，验证依赖调用而非三个互不关联的固定请求。
    const result = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          {
            code: `
    const listed = await tools.$opencode.list_mcp_resources({});
    const first = listed.resources[0];
    const templates = await tools.$opencode.list_mcp_resource_templates({});
    const read = await tools.$opencode.read_mcp_resource({server:first.server, uri:first.path});
    return {text:read.contents[0].content, templates:templates.templates.map(item => item.pathTemplate), listedTemplates:listed.templates};
  `,
          },
          { toolCallId: "execute-resources", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    )
    if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected resource receipt")
    // 资源正文与模板目录继续来自真实 MCP 协议，不能被环境恢复信息替代。
    expect(JSON.parse(scriptResult(result).output)).toEqual({
      text: "actual resource content",
      templates: ["fixture://{name}"],
      listedTemplates: [{ server: "fixtures", name: "notes", pathTemplate: "fixture://{name}" }],
    })
  }),
)

it.instance("custom tools use their existing argument validator before body effects", () => Effect.gen(function* () {
  // 插件脚本实际从磁盘加载，参数拒绝必须发生在原 body 的写盘动作之前。
  // 合法调用先建立正向对照，排除工具根本没有加载导致的假阳性。
  const instance = yield* TestInstance
  const directory = path.join(instance.directory, ".opencode", "tool")
  yield* Effect.promise(() => mkdir(directory, { recursive: true }))
  yield* Effect.promise(() => Bun.write(path.join(directory, "probe.ts"), `
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    export default {
      description: "Validated custom fixture", args: { value: z.number() },
      async execute(args) {
        await Bun.write(new URL("body.txt", import.meta.url), String(args.value));
        return {output:String(args.value),metadata:{_syncInput:{internal:true},_formattedContent:"host-only"}};
      }
    };
    export const structured = {
      description: "Structured fixture", args: {value:z.number()}, output:z.object({value:z.number()}),
      async execute(args) { return {output:"display only",program:{value:{value:args.value}}}; }
    };
  `))
  const fixture = yield* resolveTools()
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const result = yield* Effect.promise(() => Promise.resolve(execute({ code: `
    const valid = await tools.$opencode.probe({value:3});
    const structured = await tools.$opencode.probe_structured({value:4});
    const catalog = await tools.$codemode.search({query:"probe", namespace:"$opencode"});
    try { await tools.$opencode.probe({value:"bad"}); }
    catch (error) { return {valid, structured, invalid:error.message, signature:catalog.items.find(item => item.path === "tools.$opencode.probe").signature}; }
  ` }, { toolCallId: "execute-custom", abortSignal: new AbortController().signal, messages: [] })))
  if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected custom receipt")
  // 校验错误已被 catch 处理，正文保留原 JSON；metadata 仍记录成功与失败的完整终态。
  expect(result).toMatchObject({
    metadata: {
      toolCalls: [
        { tool: "$opencode.probe", status: "completed" },
        { tool: "$opencode.probe_structured", status: "completed" },
        { tool: "$codemode.search", status: "completed" },
        { tool: "$opencode.probe", status: "error" },
      ],
    },
  })
  const data = JSON.parse(scriptResult(result).output)
  expect(data).toMatchObject({ valid: "3", invalid: expect.stringContaining("invalid arguments") })
  // 同一注册入口同时覆盖旧文本插件与显式结构化插件，不能把所有插件统一改成对象。
  expect(data.structured).toEqual({ value: 4 })
  // 原文本准确描述为string；宿主临时字段没有变成程序对象的额外属性。
  expect(data.signature).toContain("Promise<string>")
  // 合法调用先建立独立磁盘证据，随后以文件仍为 3 证明校验位于副作用之前。
  expect(yield* Effect.promise(() => Bun.file(path.join(directory, "body.txt")).text())).toBe("3")
}))

// 预跑可见与运行时才可见的风险走各自真实权限链；围栏规范化由宿主入口测试覆盖。
for (const dynamic of [false, true])
  it.instance(`${dynamic ? "runtime" : "preflight"} forbidden stops mutations at its first observable boundary`, () =>
    Effect.gen(function* () {
      // 相同脚本分别使用字面命令和真实读取结果，区分预跑可见与运行时才可见的风险。
      const instance = yield* TestInstance
      const fixture = yield* resolveTools()
      const execute = fixture.tools.execute?.execute
      if (!execute) throw new Error("execute is missing")
      expect(shell).toBeString()
      const patch = (name: string) => `*** Begin Patch\n*** Add File: ${name}\n+before\n*** End Patch`
      // 对照先证明真实 patch 可执行，避免把工具加载或路径故障误认为权限拒绝。
      yield* Effect.promise(() =>
        Promise.resolve(
          execute(
            {
              code: `return await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch("control.txt"))}});`,
            },
            {
              toolCallId: "execute-control",
              abortSignal: new AbortController().signal,
              messages: [],
            },
          ),
        ),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "control.txt")).exists())).toBe(true)
      // Shell 中使用恒假分支，分类器仍识别潜在 forbidden，测试本身也具备物理执行隔离。
      const command =
        process.platform === "win32"
          ? "if ($false) { Remove-Item -Recurse -Force 'C:\\' }"
          : "if false; then rm -rf /; fi"
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "command.txt"), command))
      // 读取结果使风险延后到真实执行；前后写入标记拒绝实际发生的位置。
      const body = `const command = ${dynamic ? '(await tools.$opencode.read({filePath:"command.txt"})).content' : JSON.stringify(command)};
    await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch("before.txt"))}});
    try { await tools.$opencode.bash({command}); }
    catch { await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch("bypassed.txt"))}}); }
    await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch("after.txt"))}});`
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            execute(
              { code: body },
              { toolCallId: "execute-preflight", abortSignal: new AbortController().signal, messages: [] },
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.exit)
      // before 文件只在动态风险场景出现：预跑能看见命令时整段阻止，读文件后才发现时保留已完成写入。
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "before.txt")).exists())).toBe(dynamic)
      // forbidden 穿透脚本 catch，拒绝后任何一个分支都不能继续写入。
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "bypassed.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "after.txt")).exists())).toBe(false)
    }),
  )

it.instance("computed workdir is created by an earlier shell and consumed by the next shell", () =>
  Effect.gen(function* () {
    // 创建操作由原 Shell 承担，覆盖字符串求值、实际目录就绪和工作目录传递三个边界。
    // 第二个进程报告自己的 cwd，而非测试根据输入重算一个期望路径。
    const instance = yield* TestInstance
    const fixture = yield* resolveTools()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const create =
      process.platform === "win32"
        ? "New-Item -ItemType Directory -Path 'generated-cwd' | Out-Null"
        : "mkdir generated-cwd"
    const where = process.platform === "win32" ? "(Get-Location).Path" : "pwd"
    // 目录名由 JS 表达式产生，真实 Shell 负责创建；第二次调用验证实际进程 cwd。
    const result = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          {
            code: `
    const directory = "generated" + "-cwd";
    await tools.$opencode.bash({command:${JSON.stringify(create)}});
    return (await tools.$opencode.bash({command:${JSON.stringify(where)}, workdir:directory})).content;
  `,
          },
          { toolCallId: "execute-directory", abortSignal: new AbortController().signal, messages: [] },
        ),
      ),
    )
    if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected directory receipt")
    // 第二个 shell 仍须消费前一步创建的真实工作目录，不能只匹配环境输出。
    expect(scriptResult(result).output.replaceAll("\\", "/")).toContain(
      path.join(instance.directory, "generated-cwd").replaceAll("\\", "/"),
    )
  }),
)

it.instance("model history replays the parent receipt while child records retain audit evidence", () => Effect.gen(function* () {
  // 同时观察持久化与模型投影：全局隐藏 child 虽能省 token，却会破坏 Summary/Revert。
  // 中间正文使用独立标记，模型最终摘要即使正确也不能掩盖重复上传。
  const instance = yield* TestInstance
  yield* Effect.promise(() => Bun.write(path.join(instance.directory, "note.txt"), "intermediate body"))
  const fixture = yield* resolveTools()
  yield* fixture.processor.process({
    user: fixture.user, sessionID: fixture.session.id, model: provider.model, agent: fixture.agent,
    system: ['await tools.$opencode.read({filePath:"note.txt"}); return "aggregate";'], messages: [], tools: fixture.tools,
  })
  const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
  const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
  expect(parts.find((part) => part.tool === "execute")?.state.status).toBe("completed")
  expect(parts.filter((part) => part.metadata?.executeParent)).toHaveLength(1)
  expect(JSON.stringify(parts)).toContain("intermediate body")
  // 数据库子记录保留供归因使用；模型输入只含 provider 真正发出的父调用。
  const projected = yield* MessageV2.toModelMessagesEffect(messages, provider.model)
  const calls = projected.flatMap((message) => typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "tool-call").map((part) => part.toolName))
  expect(calls).toEqual(["execute"])
  expect(JSON.stringify(projected)).toContain("aggregate")
  expect(JSON.stringify(projected)).not.toContain("intermediate body")
}))

it.instance("failed execute exposes the actual child Task identity in its error receipt", () => Effect.gen(function* () {
  // 恢复 ID 从真实 Task 的已保存 metadata 取得，避免让父摘要用猜测值满足断言。
  // 模型转换器必须保留 error 状态，同时交付继续处理已有子会话所需的信息。
  const fixture = yield* resolveTools()
  // Task 已创建真实子 Session 后，模型边界 fixture 主动失败；身份须随父错误交付。
  yield* fixture.processor.process({
    user: fixture.user, sessionID: fixture.session.id, model: provider.model, agent: fixture.agent,
    system: ['await tools.$opencode.task({description:"recovery fixture", prompt:"fixture", subagent_type:"general"});'],
    messages: [], tools: fixture.tools,
  })
  const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
  const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
  const child = parts.find((part) => part.tool === "task")
  const parent = parts.find((part) => part.tool === "execute")
  expect(child?.state.status).toBe("error")
  if (child?.state.status !== "error") throw new Error("Expected failed Task with persisted identity")
  const sessionId = child.state.metadata?.sessionId
  expect(typeof sessionId).toBe("string")
  expect(parent?.state.status).toBe("error")
  const projected = yield* MessageV2.toModelMessagesEffect(messages, provider.model)
  expect(JSON.stringify(projected)).toContain(sessionId)
  expect(JSON.stringify(projected)).toContain("Partial execution")
}))

// 用审查门闩比较审批时机，再核对批准后的两个进程结果与保留的 JS 状态。
for (const dynamic of [false, true])
  it.instance(`${dynamic ? "runtime" : "preflight"} parallel calls share approval and preserve JS state`, () =>
    Effect.gen(function* () {
      // 分别覆盖可预跑的表达式和实际读取依赖，观察真实执行前/执行中的两种审批时机。
      // 外部审查用 Deferred 控制，断言在批准之前完成，避免用睡眠碰运气。
      const reviewing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const reviews: string[] = []
      // 条件恒假的 git push 保留分类风险，却让意外执行也只打印测试结果。
      const command =
        process.platform === "win32"
          ? "if ($false) { git push origin main }; Write-Output done"
          : "if false; then git push origin main; fi; echo done"
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "command.txt"), command))
      const code = `const n = 41; const command = ${dynamic ? '(await tools.$opencode.read({filePath:"command.txt"})).content' : JSON.stringify(command)} + ""; const results = await Promise.all([1,2].map(() => tools.$opencode.bash({command}))); return {state:n + 1, results};`
      const reviewer: PermissionReviewer.Interface = {
        review: (request) =>
          Effect.gen(function* () {
            reviews.push(request.precheck.level)
            expect(request.permission).toBe("execute")
            // 审查收到整段原程序而非两个 leaf 的拼接摘要，批准才能与随后继续的同一段代码对应。
            expect(request.metadata.code).toBe(code)
            yield* Deferred.succeed(reviewing, undefined)
            yield* Deferred.await(release)
            return {
              action: "allow" as const,
              reason: "fixture approved",
              reviewID: request.reviewID,
              risk_level: "medium" as const,
              user_authorization: "high" as const,
            }
          }),
      }
      yield* Effect.gen(function* () {
        const fixture = yield* resolveTools()
        const execute = fixture.tools.execute?.execute
        if (!execute) throw new Error("execute is missing")
        // 审查挂起后读取持久子调用状态，再批准并验证原程序续跑。
        const pending = yield* Effect.promise(() =>
          Promise.resolve(
            execute(
              { code },
              { toolCallId: "execute-dynamic", abortSignal: new AbortController().signal, messages: [] },
            ),
          ),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(reviewing)
        // some(completed) 只区分动态读取已完成与预跑尚无完成记录，不证明两个 Shell 均未启动。
        const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
        expect(parts.some((part) => part.state.status === "completed")).toBe(dynamic)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(pending)
        if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected execute receipt")
        // 聚合结果同时核验暂停续跑后的词法状态和两个真实进程的输出。
        const data = JSON.parse(scriptResult(result).output)
        expect(data.state).toBe(42)
        // 与暂停续跑共用真实进程场景，验证程序可按退出码和完整性判断后续动作。
        expect(data.results).toHaveLength(2)
        for (const item of data.results) {
          expect(item).toMatchObject({
            exit: 0,
            truncated: false,
            timedOut: false,
            content: expect.stringContaining("done"),
          })
          expect(item.metadata).toBeUndefined()
        }
        // 两个并行 Shell 共用一次整段 cautious 审查，列表长度能发现每个 child 重复升阶。
        expect(reviews).toEqual(["cautious"])
      }).pipe(Effect.provideService(PermissionReviewer.Service, reviewer))
    }),
  )

it.instance("runtime toggle stops a catalogued tool even inside JS catch", () =>
  Effect.gen(function* () {
    // 开关在第一个工具的 after hook 更新，此时原目录已经构造，下一调用才会消费新规则。
    // catch 返回特定成功值，若取消被普通错误处理吞掉，最终 Exit 就会暴露越权续跑。
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "note.txt"), "ready"))
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service
    const fixture = yield* resolveTools().pipe(
      Effect.provideService(Plugin.Service, {
        ...plugin,
        trigger: (name, input, output) =>
          Effect.gen(function* () {
            if (
              name === "tool.execute.after" &&
              isRecord(input) &&
              input.tool === "read" &&
              typeof input.sessionID === "string"
            ) {
              yield* sessions.setPermission({
                sessionID: SessionID.make(input.sessionID),
                permission: [{ permission: "apply_patch", pattern: "*", action: "deny" }],
              })
            }
            return output
          }),
      }),
    )
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const patch = "*** Begin Patch\n*** Add File: toggled.txt\n+forbidden after toggle\n*** End Patch"
    const result = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          execute(
            {
              code: `await tools.$opencode.read({filePath:"note.txt"}); try { await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch)}}); } catch {} return "bypassed";`,
            },
            { toolCallId: "execute-toggle", abortSignal: new AbortController().signal, messages: [] },
          ),
        ),
      catch: (error) => error,
    }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "toggled.txt")).exists())).toBe(false)
  }),
)

it.instance("hook-modified shell input is checked before the process starts", () => Effect.gen(function* () {
  // before hook 是真实可变输入边界，不能以模型最初传来的安全字符串替代执行参数授权。
  const instance = yield* TestInstance
  const plugin = yield* Plugin.Service
  const fixture = yield* resolveTools().pipe(Effect.provideService(Plugin.Service, { ...plugin,
    trigger: (name, input, output) => Effect.sync(() => {
      if (name === "tool.execute.before" && isRecord(input) && input.tool === "bash" && isRecord(output) && isRecord(output.args)) {
        output.args.command = process.platform === "win32" ? "if ($false) { Remove-Item -Recurse -Force 'C:\\' }" : "if false; then rm -rf /; fi"
      }
      return output
    }),
  }))
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const patch = "*** Begin Patch\n*** Add File: hook-bypass.txt\n+bypass\n*** End Patch"
  // 静态脚本只有安全命令；before hook 改参后必须按真实输入拒绝，catch 也停止。
  const result = yield* Effect.tryPromise({
    try: () => Promise.resolve(execute({ code: `try {await tools.$opencode.bash({command:"echo safe"});} catch {await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch)}});} return 1;` },
      { toolCallId: "execute-hook-risk", abortSignal: new AbortController().signal, messages: [] })), catch: (error) => error,
  }).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "hook-bypass.txt")).exists())).toBe(false)
}))

it.instance("abort during whole-script review releases the reviewer without tool effects", () => Effect.gen(function* () {
  // 前置审查先于真实 child；取消释放 reviewer，且整段调用以失败结算。
  const reviewing = yield* Deferred.make<void>()
  const controller = new AbortController()
  let cleaned = false
  yield* Effect.gen(function* () {
    const fixture = yield* resolveTools()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const command = process.platform === "win32" ? "if ($false) { git push origin main }" : "if false; then git push origin main; fi"
    const pending = yield* Effect.tryPromise({ try: () => Promise.resolve(execute({ code: `await tools.$opencode.bash({command:${JSON.stringify(command)}});` },
      { toolCallId: "execute-review-abort", abortSignal: controller.signal, messages: [] })), catch: (error) => error }).pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(reviewing)
    controller.abort()
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
    expect(cleaned).toBe(true)
    const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).flatMap((message) => message.parts)
    const children = parts.filter((part) => part.type === "tool")
    expect(children).toEqual([])
  }).pipe(Effect.provideService(PermissionReviewer.Service, {
    // 用真实审批等待位置同步取消，清理标志验证外部 reviewer fiber 已经结束。
    review: () => Deferred.succeed(reviewing, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => { cleaned = true }))),
  }))
}))

for (const waiting of ["shell", "permission"])
  it.instance(`execute exit cleans a ${waiting} race member after later tools`, () =>
    Effect.gen(function* () {
      // race 后仍可调用其它工具；最终终态在 Execute 返回之后断言，不归因于 race 自身。
      const fixture = yield* resolveTools()
      const question = yield* Question.Service
      const permission = yield* Permission.Service
      const instance = yield* TestInstance
      // 权限分支把 read 改为 ask，制造真实待批资源；与运行中的 Shell 共用相同根退出检查。
      if (waiting === "permission") {
        yield* Effect.promise(() => Bun.write(path.join(instance.directory, "waiting.txt"), "waiting"))
        yield* fixture.sessions.setPermission({
          sessionID: fixture.session.id,
          permission: [{ permission: "read", pattern: "*", action: "ask" }],
        })
      }
      const execute = fixture.tools.execute?.execute
      if (!execute) throw new Error("execute is missing")
      const controller = new AbortController()
      const command =
        process.platform === "win32" ? "Write-Output RACE_READY; Start-Sleep -Seconds 30" : "echo RACE_READY; sleep 30"
      const code = `const process = ${waiting === "permission" ? 'tools.$opencode.read({filePath:"waiting.txt"})' : `tools.$opencode.bash({command:${JSON.stringify(command)}})`};
    await tools.$opencode.question({questions:[{question:"Race now?",header:"Test",options:[]}]});
    const result = await Promise.race([process, "done"]); await tools.$opencode.glob({pattern:"*"}); return result;`
      const pending = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            execute(
              { code },
              {
                toolCallId: "execute-shell-race",
                abortSignal: controller.signal,
                messages: [],
              },
            ),
          ),
        catch: (error) => error,
      }).pipe(Effect.forkScoped)
      // 等实际进程输出或权限请求出现后才释放问题，确保取消确实发生在宿主等待期间。
      yield* pollWithTimeout(
        waiting === "permission"
          ? permission.list().pipe(Effect.map((items) => items.length > 0 || undefined))
          : fixture.sessions
              .messages({ sessionID: fixture.session.id })
              .pipe(
                Effect.map(
                  (messages) =>
                    messages
                      .flatMap((message) => message.parts)
                      .some(
                        (part) =>
                          part.type === "tool" &&
                          part.tool === "bash" &&
                          part.state.status === "running" &&
                          String(part.state.metadata?.output).includes("RACE_READY"),
                      ) || undefined,
                ),
              ),
        "race shell did not start",
        "10 seconds",
      )
      const request = yield* pollWithTimeout(
        question.list().pipe(Effect.map((items) => items[0])),
        "race question not presented",
      )
      yield* question.reply({ requestID: request.id, answers: [["continue"]] })
      const result = yield* awaitWithTimeout(
        Fiber.join(pending),
        "race shell cleanup did not finish",
        "10 seconds",
      ).pipe(Effect.ensuring(Effect.sync(() => controller.abort())))
      // 未观察的 race 成员在根作用域结束时取消；正文提醒一次，metadata 保留逐项终态。
      expect(scriptResult(result)).toMatchObject({
        output:
          "Some asynchronous work failed or was interrupted without the script observing its outcome." +
          "\n\nScript result:\ndone",
        metadata: {
          toolCalls: [
            { tool: `$opencode.${waiting === "permission" ? "read" : "bash"}`, status: "error" },
            { tool: "$opencode.question", status: "completed" },
            { tool: "$opencode.glob", status: "completed" },
          ],
        },
      })
      const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
      // glob 已在 race 之后完成，而所有 child 此时才要求终态，能区分 race 结算与根作用域清理。
      expect(parts.some((part) => part.state.status === "running" || part.state.status === "pending")).toBe(false)
      expect(parts.find((part) => part.tool === "glob")?.state.status).toBe("completed")
      expect(yield* permission.list()).toEqual([])
    }),
  )


for (const ending of ["await", "return", "abort"])
  it.instance(`async race member follows ${ending} at the real host boundary`, () =>
    Effect.gen(function* () {
      // 使用真实 SessionTools、权限与 Question 服务；双问题门闩区分 race 结束和 Execute 结束。
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "before.txt"), "completed evidence"))
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "after.txt"), "later continuation"))
      const fixture = yield* resolveTools()
      const question = yield* Question.Service
      const execute = fixture.tools.execute?.execute
      if (!execute) throw new Error("execute is missing")
      const controller = new AbortController()
      const code = `const child = (async () => {
      await tools.$opencode.read({filePath:"before.txt"});
      await tools.$opencode.question({questions:[{question:"Child",header:"Test",options:[]}]});
      await tools.$opencode.read({filePath:"after.txt"}); return "finished";
    })();
    await tools.$opencode.question({questions:[{question:"Race now",header:"Test",options:[]}]});
    const winner = await Promise.race([child, "first"]);
    await tools.$opencode.question({questions:[{question:"After race",header:"Test",options:[]}]});
    return ${ending === "await" ? "[winner, await child]" : "winner"};`
      const pending = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            execute({ code }, { toolCallId: "execute-async-lifetime", abortSignal: controller.signal, messages: [] }),
          ),
        catch: (error) => error,
      }).pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.gen(function* () {
        // 先确认 async 已完成首个读取并挂起，再允许 race 开始，不靠任意延时猜调度顺序。
        const ready = yield* pollWithTimeout(
          question
            .list()
            .pipe(
              Effect.map(
                (items) =>
                  (items.some((item) => item.questions[0]?.question === "Child") &&
                    items.find((item) => item.questions[0]?.question === "Race now")) ||
                  undefined,
              ),
            ),
          "async child did not reach its host gate",
        )
        yield* question.reply({ requestID: ready.id, answers: [["continue"]] })
        const after = yield* pollWithTimeout(
          question
            .list()
            .pipe(Effect.map((items) => items.find((item) => item.questions[0]?.question === "After race"))),
          "race did not release the caller",
        )
        // After race出现才检查Child，证明观察发生在选出赢家之后，而非race尚未开始时。
        const child = (yield* question.list()).find((item) => item.questions[0]?.question === "Child")
        // 宿主交互仍存在不代表 async 包装存活；后续显式 await 的结果还必须证明包装未被提前取消。
        expect(child).toBeDefined()
        if (!child) throw new Error("race canceled its still-needed child")
        // 此时 Child 与 After race 都在等待；abort 应取消两者，return 只留下 Child 待清理。
        if (ending === "abort") controller.abort()
        if (ending !== "abort") yield* question.reply({ requestID: after.id, answers: [["continue"]] })
        // 只有显式 await 分支释放 Child，随后第二次 read 才可能完成，排除误靠根退出推进子任务。
        if (ending === "await") yield* question.reply({ requestID: child.id, answers: [["finish"]] })
        const exit = yield* awaitWithTimeout(Fiber.join(pending), "async host cleanup did not finish")
        expect(exit._tag).toBe(ending === "abort" ? "Failure" : "Success")
        if (Exit.isSuccess(exit)) {
          // 显式等待的全成功输出保持原字节；提前 return 只提醒未观察的取消，不改变 winner。
          expect(scriptResult(exit.value)).toMatchObject({
            output:
              ending === "await"
                ? JSON.stringify(["first", "finished"], null, 2)
                : "Some asynchronous work failed or was interrupted without the script observing its outcome." +
                  "\n\nScript result:\nfirst",
          })
          // 父回执必须已结算所有调用；取消只影响未完成的问题，已完成读取与交互保留。
          expect(exit.value).toMatchObject({
            metadata: {
              toolCalls: [
                { tool: "$opencode.read", status: "completed" },
                { tool: "$opencode.question", status: "completed" },
                { tool: "$opencode.question", status: ending === "await" ? "completed" : "error" },
                { tool: "$opencode.question", status: "completed" },
                ...(ending === "await" ? [{ tool: "$opencode.read", status: "completed" }] : []),
              ],
            },
          })
        }
        expect(yield* question.list()).toEqual([])
        const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
        // 已完成读取在 return/abort 后仍然保留；后续读取仅在显式等待正常完成时允许发生。
        expect(parts.filter((part) => part.tool === "read" && part.state.status === "completed")).toHaveLength(
          ending === "await" ? 2 : 1,
        )
        // Question队列清空与持久child终态分别约束交互资源和审计记录，不能只清UI却留下running。
        expect(parts.some((part) => part.state.status === "running" || part.state.status === "pending")).toBe(false)
        // 错误数量来自仍未回答的问题：await 为零，return 留一个，abort 在两个门闩等待时发生。
        expect(parts.filter((part) => part.tool === "question" && part.state.status === "error")).toHaveLength(
          ending === "await" ? 0 : ending === "return" ? 1 : 2,
        )
      }).pipe(Effect.ensuring(Effect.sync(() => controller.abort())))
    }),
  )

it.instance("execute timeout settles real children and preserves completed mutation evidence", () =>
  Effect.gen(function* () {
    // 真实计时覆盖 SessionTools 的子调用与父错误投影；虚拟时钟用例另行验证精确十分钟默认值。
    const instance = yield* TestInstance
    const fixture = yield* resolveTools()
    const question = yield* Question.Service
    const first = "*** Begin Patch\n*** Add File: before-timeout.txt\n+completed\n*** End Patch"
    const later = "*** Begin Patch\n*** Add File: after-timeout.txt\n+unreachable\n*** End Patch"
    const pending = yield* fixture.processor
      .process({
        user: fixture.user,
        sessionID: fixture.session.id,
        model: provider.model,
        agent: fixture.agent,
        system: [
          `await tools.$opencode.apply_patch({patchText:${JSON.stringify(first)}});
      await tools.$opencode.question({questions:[{question:"Timeout gate",header:"Test",options:[]}]});
      await tools.$opencode.apply_patch({patchText:${JSON.stringify(later)}});`,
          "1000",
        ],
        messages: [],
        tools: fixture.tools,
      })
      .pipe(Effect.forkScoped)
    // 已公开问题才等待超时，证明预算终止的是实际工具等待，而非初始化或预跑。
    yield* pollWithTimeout(
      question.list().pipe(Effect.map((items) => items.find((item) => item.questions[0]?.question === "Timeout gate"))),
      "timeout child never started",
    )
    yield* awaitWithTimeout(Fiber.join(pending), "execute timeout did not settle its parent")
    const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
    const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    const parent = parts.find((part) => part.tool === "execute")
    expect(parent?.state.status).toBe("error")
    if (parent?.state.status !== "error") throw new Error("Expected timeout error receipt")
    // 确认父错误就是执行预算到期，避免问题被拒绝或 fixture 故障也以 error 状态假通过。
    expect(parent.state.error).toContain("timed out")
    // 父超时不是事务回滚；已完成的写入和 child 记录必须仍能被模型及审计消费者看见。
    expect(parts.filter((part) => part.tool === "apply_patch")).toMatchObject([{ state: { status: "completed" } }])
    expect(parts.find((part) => part.tool === "question")?.state.status).toBe("error")
    expect(parts.some((part) => part.state.status === "running" || part.state.status === "pending")).toBe(false)
    expect(yield* question.list()).toEqual([])
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "before-timeout.txt")).text())).toBe(
      "completed\n",
    )
    // 后续文件不存在验证超时后脚本停止；只检查 child 终态会漏掉清理后又继续执行的写入。
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "after-timeout.txt")).exists())).toBe(
      false,
    )
    const projected = JSON.stringify(yield* MessageV2.toModelMessagesEffect(messages, provider.model))
    // 模型历史只靠父回执恢复完成事实，不能用仍在数据库的隐藏 child 替代这项断言。
    expect(projected).toContain("Partial execution")
    expect(projected).toContain("before-timeout.txt")
    expect(projected).toContain("completed")
  }),
)

it.instance("dismissed question terminates execute rather than entering its catch mutation", () =>
  Effect.gen(function* () {
    // 使用 Question 服务的公开拒绝操作，区分用户关闭交互与普通工具异常。
    // catch 里放置真实文件操作，能捕获把 QuestionRejectedError 错当普通 JS 错误的回归。
    const instance = yield* TestInstance
    const question = yield* Question.Service
    const fixture = yield* resolveTools()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const patch = "*** Begin Patch\n*** Add File: after-dismiss.txt\n+unwanted\n*** End Patch"
    const code = `try { await tools.$opencode.question({questions:[{question:"Proceed?",header:"Test",options:[{label:"Yes",description:"Proceed"}]}]}); } catch { await tools.$opencode.apply_patch({patchText:${JSON.stringify(patch)}}); } return "bypassed";`
    const pending = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          execute(
            { code },
            { toolCallId: "execute-question", abortSignal: new AbortController().signal, messages: [] },
          ),
        ),
      catch: (error) => error,
    }).pipe(Effect.exit, Effect.forkScoped)
    const request = yield* pollWithTimeout(
      question.list().pipe(Effect.map((items) => items[0])),
      "question not presented",
    )
    yield* question.reject(request.id)
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "after-dismiss.txt")).exists())).toBe(
      false,
    )
    expect(yield* question.list()).toEqual([])
  }),
)

it.instance("user abort waits for shell cleanup and retains its partial child output", () => Effect.gen(function* () {
  // 长等待只作为被取消的实际进程，不用它作为测试同步手段。
  // Promise 返回后再检查终态，防止父层提前返回却把运行中 child 留在后台。
  const fixture = yield* resolveTools()
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const controller = new AbortController()
  const command = process.platform === "win32" ? 'Write-Output EXECUTE_READY; Start-Sleep -Seconds 30' : 'echo EXECUTE_READY; sleep 30'
  const pending = yield* Effect.tryPromise({
    try: () => Promise.resolve(execute({ code: `await tools.$opencode.bash({command:${JSON.stringify(command)}}); return "unreachable";` },
      { toolCallId: "execute-abort", abortSignal: controller.signal, messages: [] })), catch: (error) => error,
  }).pipe(Effect.exit, Effect.forkScoped)
  // 实际进程发布输出才取消，保证覆盖已启动 Shell 的 kill/drain 路径。
  yield* pollWithTimeout(fixture.sessions.messages({ sessionID: fixture.session.id }).pipe(Effect.map((messages) =>
    messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash" &&
      part.state.status === "running" && String(part.state.metadata?.output).includes("EXECUTE_READY")),
  )), "shell readiness was not published", "10 seconds")
  controller.abort()
  expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
  const child = (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).flatMap((message) => message.parts)
    .find((part) => part.type === "tool" && part.tool === "bash")
  if (child?.type !== "tool") throw new Error("Expected shell child")
  // 进程可能在取消竞争中先完成，因此接受两种终态；运行中状态和丢失已产出正文都不能通过。
  expect(["completed", "error"]).toContain(child.state.status)
  if ("metadata" in child.state) expect(child.state.metadata?.output).toContain("EXECUTE_READY")
}))

it.instance("MCP child hooks run once and persist the actual hook-modified input", () => Effect.gen(function* () {
  // 带下划线的 server 名也通过真实宿主分组，单元夹具的目录构造无法代替此断言。
  // 第一项 hook 失败、第二项改参成功，共同验证普通错误可恢复且没有重复执行。
  const plugin = yield* Plugin.Service
  const calls: string[] = []
  const outputs: unknown[] = []
  const fixture = yield* resolveMcp("my_server").pipe(Effect.provideService(Plugin.Service, { ...plugin,
    trigger: (name, input, output) => Effect.sync(() => {
      if ((name === "tool.execute.before" || name === "tool.execute.after") && isRecord(input)) {
        calls.push(`${name}:${input.tool}:${input.callID}`)
        if (input.tool === "my_server_add" && name === "tool.execute.before" && isRecord(output) && isRecord(output.args)) {
          if (output.args.a === -1) throw new Error("hook refused")
          output.args.a = 3
        }
        if (input.tool === "my_server_add" && name === "tool.execute.after") outputs.push(output)
      }
      return output
    }),
  }))
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  expect(fixture.instructions.join("\n")).toContain("tools.my_server.add(")
  const result = yield* Effect.promise(() => Promise.resolve(execute({ code: `let failed; try {await tools.my_server.add({a:-1,b:0});} catch(e) {failed=e.message;} const result=await tools.my_server.add({a:2,b:4}); return {failed,sum:result.sum};` },
    { toolCallId: "execute-hooks", abortSignal: new AbortController().signal, messages: [] })))
  if (!isRecord(result) || typeof result.output !== "string") throw new Error("Expected execute receipt")
  // hook 失败已被 catch 处理，正文只含脚本结果；metadata 与持久化 child 仍保留失败事实。
  expect(scriptResult(result)).toMatchObject({
    output: JSON.stringify({ failed: "hook refused", sum: 7 }, null, 2),
    metadata: {
      toolCalls: [
        { tool: "my_server.add", status: "error" },
        { tool: "my_server.add", status: "completed" },
      ],
    },
  })
  expect(calls).toEqual([
    "tool.execute.before:execute:execute-hooks",
    "tool.execute.before:my_server_add:execute-hooks/1",
    "tool.execute.before:my_server_add:execute-hooks/2",
    "tool.execute.after:my_server_add:execute-hooks/2",
    "tool.execute.after:execute:execute-hooks",
  ])
  // after hook 同时看到展示文本与程序对象，二者都必须由改参后的远端结果生成。
  expect(outputs).toMatchObject([{ content: [{ type: "text", text: '{"sum":7}' }], program: { value: { sum: 7 } } }])
  const parts = (yield* fixture.sessions.messages({ sessionID: fixture.session.id })).flatMap((message) => message.parts).filter((part) => part.type === "tool")
  expect(parts).toMatchObject([{ state: { status: "error" } }, { state: { status: "completed", input: { a: 3, b: 4 } } }])
}))

for (const reply of ["once", "reject"] as const) {
  // 两种决定经过同一个真实待审请求；拒绝须终止解释器，批准则继续原调用。
  it.instance(`MCP explicit permission ${reply} uses child identity and terminal scope`, () => Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fixture = yield* resolveMcp()
    yield* fixture.sessions.setPermission({ sessionID: fixture.session.id, permission: [{ permission: "fixtures_add", pattern: "*", action: "ask" }] })
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const pending = yield* Effect.tryPromise({
      try: () => Promise.resolve(execute({ code: 'try { return (await tools.fixtures.add({a:1,b:2})).sum; } catch { return "bypassed"; }' },
        { toolCallId: "execute-mcp-ask", abortSignal: new AbortController().signal, messages: [] })), catch: (error) => error,
    }).pipe(Effect.exit, Effect.forkScoped)
    const request = yield* pollWithTimeout(permission.list().pipe(Effect.map((items) => items[0])), "MCP permission not presented")
    expect(request.permission).toBe("fixtures_add")
    // 审批必须归到真实child而非父execute，否则一次许可可能错误覆盖整段程序。
    expect(request.tool?.callID).toBe("execute-mcp-ask/1")
    yield* permission.reply({ requestID: request.id, reply })
    const result = yield* Fiber.join(pending)
    expect(Exit.isSuccess(result)).toBe(reply === "once")
    // 允许后仍验证脚本值；拒绝分支保持中断，不能由环境句柄掩盖。
    if (Exit.isSuccess(result)) expect(scriptResult(result.value)).toMatchObject({ output: "3" })
    expect(yield* permission.list()).toEqual([])
  }))
}

it.instance("goal read and complete share the trusted turn inside execute", () => Effect.gen(function* () {
  // 先尝试未经 read 的 complete，确认新增入口仍保留 Goal 原门禁。
  // 最后检查 SessionGoal 权威状态，防止测试只验证工具返回了成功措辞。
  const fixture = yield* resolveTools()
  const goal = yield* SessionGoal.Service
  yield* goal.set(fixture.session.id, { objective: "fixture goal" })
  const execute = fixture.tools.execute?.execute
  if (!execute) throw new Error("execute is missing")
  const result = yield* Effect.promise(() => Promise.resolve(execute({ code: `let gate; try {await tools.$opencode.goal({operate:"complete",reason:"premature"});} catch(e) {gate=e.message;} await tools.$opencode.goal({operate:"read"}); await tools.$opencode.goal({operate:"complete",reason:"verified"}); return gate;` },
    { toolCallId: "execute-goal", abortSignal: new AbortController().signal, messages: [] })))
  // Goal 的受信快照错误仍在业务正文中，状态复用不能绕过当前 turn 检查。
  expect(scriptResult(result)).toMatchObject({ output: expect.stringContaining("before changing the goal") })
  const current = yield* goal.get(fixture.session.id)
  expect(Option.isSome(current) && current.value.status).toBe("complete")
}))

it.instance("patch deletion is prechecked before preceding writes", () => Effect.gen(function* () {
  // 文件删除的风险由既有 structured files 分类，而非仅凭 edit 权限名决定。
  const instance = yield* TestInstance
  yield* Effect.promise(() => Bun.write(path.join(instance.directory, "delete-me.txt"), "keep"))
  yield* Effect.gen(function* () {
    const fixture = yield* resolveTools()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("execute is missing")
    const first = "*** Begin Patch\n*** Add File: before-delete.txt\n+before\n*** End Patch"
    const last = "*** Begin Patch\n*** Delete File: delete-me.txt\n*** End Patch"
    const result = yield* Effect.tryPromise({
      try: () => Promise.resolve(execute({ code: `await tools.$opencode.apply_patch({patchText:${JSON.stringify(first)}}); await tools.$opencode.apply_patch({patchText:${JSON.stringify(last)}});` },
        { toolCallId: "execute-delete", abortSignal: new AbortController().signal, messages: [] })), catch: (error) => error,
    }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    // 复用补丁解析器即可发现后继删除，整段拒绝发生在前序写入之前。
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "before-delete.txt")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "delete-me.txt")).text())).toBe("keep")
  }).pipe(Effect.provideService(PermissionReviewer.Service, { review: (input) => Effect.succeed({
    action: "deny", reason: "fixture deletion denied", reviewID: input.reviewID, risk_level: "medium", user_authorization: "low",
  }) }))
}))

for (const tool of ["apply_patch", "edit"]) {
  // 两种模型的编辑工具分别进入相同 child 接线，父失败不改变已经完成的文件事实。
  it.instance(`failed parent retains ${tool} file ownership for Summary and Revert`, () => Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "owned.txt"), "old\n"))
    const model = tool === "apply_patch" ? provider.model : ProviderTest.model({ api: { ...provider.model.api, id: "claude-test" } })
    const fixture = yield* resolveTools(model)
    yield* fixture.sessions.updatePart({ id: PartID.ascending(), messageID: fixture.user.id, sessionID: fixture.session.id, type: "text", text: "change owned.txt" })
    const args = tool === "apply_patch" ? { patchText: "*** Begin Patch\n*** Update File: owned.txt\n@@\n-old\n+new\n*** End Patch" }
      : { filePath: "owned.txt", edits: [{ oldString: "old", newString: "new" }] }
    yield* fixture.processor.process({ user: fixture.user, sessionID: fixture.session.id, model, agent: fixture.agent,
      system: [`await tools.$opencode.read({filePath:${JSON.stringify(path.join(instance.directory, "owned.txt"))}}); await tools.$opencode.${tool}(${JSON.stringify(args)}); throw new Error("parent failed");`], messages: [], tools: fixture.tools })
    const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
    const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(parts.find((part) => part.tool === "execute")?.state.status).toBe("error")
    expect(parts.find((part) => part.tool === tool)).toMatchObject({ state: { status: "completed" } })
    expect(parts.find((part) => part.tool === tool)?.metadata?.worktree).toBe("declared")
    expect(parts.find((part) => part.tool === "execute")?.metadata?.worktree).not.toBe("ambient")
    const summary = yield* SessionSummary.Service
    // 使用原 Summary owner 计算 diff；如果必须修改其算法才通过，说明 child 归属接线有误。
    expect((yield* summary.computeDiff({ messages })).map((item) => item.file)).toEqual(["owned.txt"])
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "owned.txt")).text())).toBe("new\n")
    // 父脚本失败不会抹掉真实 child 的文件权属；撤回只恢复其文件，保留其它写者的新文件。
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "unrelated.txt"), "keep"))
    const revert = yield* SessionRevert.Service
    // 通过真实用户轮次边界撤回，覆盖 Snapshot 与 declared authority 的完整消费路径。
    yield* revert.revert({ sessionID: fixture.session.id, messageID: fixture.user.id })
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "owned.txt")).text())).toBe("old\n")
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "unrelated.txt")).text())).toBe("keep")
  }), { git: true })
}

// 从实际模型说明提取发现式；未来文案改错字段时，这条生产路径回归必须失败。

it.instance("published discovery example returns complete file tool signatures", () =>
  Effect.gen(function* () {
    const code = CodeMode.description.match(/`(return search\([^`]+\))`/)?.[1]
    if (!code) throw new Error("Revised discovery expression missing")
    const fixture = yield* resolveTools()
    const execute = fixture.tools.execute?.execute
    if (!execute) throw new Error("Execute missing")
    const discovered = yield* Effect.promise(() =>
      Promise.resolve(
        execute(
          { code },
          {
            toolCallId: "r9-discover-limit2",
            abortSignal: new AbortController().signal,
            messages: [],
          },
        ),
      ),
    )
    const parsed = scriptResult(discovered)
    if (!isRecord(parsed.metadata)) throw new Error("Discovery metadata missing")
    expect(parsed.metadata.truncated).toBe(false)
    // 完整解析证明宿主未截断；仅 contains 两条路径不能证明发现结果可读。
    const result = JSON.parse(parsed.output)
    // 顺序和两项路径来自说明中的 query、namespace 和 limit，不能用任意包含文件工具的结果替代示例。
    expect(result.items.map((item: { path: string }) => item.path)).toEqual([
      "tools.$opencode.glob",
      "tools.$opencode.read",
    ])
    // 签名保留脚本依赖的真实 files 对象与行数边界，不猜测字符串路径。
    expect(result.items[0].signature).toContain("files: Array<")
    expect(result.items[0].signature).toContain("partial: boolean")
    expect(result.items[1].signature).toContain("totalLinesExact: boolean")
    expect(result.items[1].signature).toContain("limit?: number")
    expect(parsed.output).not.toContain('<opencode_notice type="output_truncated"')
  }),
)

// 分别覆盖筛选、八文件上限、glob 截断和 read 有界计数，不把抽样描述为全量分析。
for (const scenario of ["mixed", "bounded", "truncated", "inexact"] as const)
  it.instance(`published file example preserves ${scenario}`, () =>
    Effect.gen(function* () {
      const code = CodeMode.description.match(/```js\n([\s\S]*?)\n```/)?.[1]
      if (!code) throw new Error("Published file example missing")
      const instance = yield* TestInstance
      const directory = path.join(instance.directory, "src")
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      // 12个文件只触发示例的八项采样，101个还触发glob自身截断，两者不能共用一个完整性标志。
      const count = scenario === "mixed" ? 2 : scenario === "bounded" ? 12 : scenario === "truncated" ? 101 : 1
      for (let index = 0; index < count; index++) {
        const lines = scenario === "mixed" ? (index === 0 ? 20 : 250) : scenario === "inexact" ? 600 : 240
        // 宽行超出真实 read 计数字节预算，不能 stub 一个不可信的 inexact 标志。
        const line = scenario === "inexact" ? "//" + "x".repeat(1022) : "// fixture"
        yield* Effect.promise(() =>
          Bun.write(path.join(directory, `fixture-${index}.ts`), Array.from({ length: lines }, () => line).join("\n")),
        )
      }
      const fixture = yield* resolveTools()
      // 生产说明原文直接进入 provider 事件与 SessionTools；不得为通过断言暗改示例。
      yield* fixture.processor.process({
        user: fixture.user,
        sessionID: fixture.session.id,
        model: provider.model,
        agent: fixture.agent,
        system: [code],
        messages: [],
        tools: fixture.tools,
      })
      const messages = yield* fixture.sessions.messages({ sessionID: fixture.session.id })
      const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
      const parent = parts.find((part) => part.tool === "execute")
      if (!parent || parent.state.status !== "completed") throw new Error("Candidate failed: " + JSON.stringify(parent))
      const result = JSON.parse(scriptResult(parent.state).output)
      const reads = parts.filter((part) => part.tool === "read")
      const glob = parts.find((part) => part.tool === "glob")
      if (!glob || glob.state.status !== "completed") throw new Error("Real glob missing")
      // 检查真实 child 次数与 limit，不能只相信脚本返回 inspected 的声明。
      expect(reads).toHaveLength(Math.min(count, 8))
      expect(reads.every((part) => part.state.status === "completed" && part.state.input.limit === 1)).toBe(true)
      // inspected 必须等于真实 read 次数，脚本不能用 glob 候选数冒充实际检查数。
      expect(result.inspected).toBe(reads.length)
      expect(result.truncated).toBe(scenario === "truncated")
      expect(result.partial).toBe(false)
      // listing 标志属于 glob 枚举边界，八文件抽样不能被理解为完整扫描。
      expect(result.truncated).toBe(glob.state.metadata.truncated ?? false)
      expect(result.partial).toBe(glob.state.metadata.partial ?? false)
      expect(result.files.every((file: { lines: number }) => file.lines > 200)).toBe(true)
      expect(result.files).toHaveLength(scenario === "mixed" ? 1 : Math.min(count, 8))
      // 宽行场景之外都未触发行数预算，exact 应保持真，防止实现把所有行数都降格成下界。
      if (scenario === "inexact") {
        // 下界与 exact=false 均须传出，既不谎报精确 600 行，也不丢弃已知超过 200 的事实。
        expect(result.files[0].exact).toBe(false)
        expect(result.files[0].lines).toBeLessThan(600)
        expect(reads[0].state.status === "completed" && reads[0].state.metadata.read.totalExact).toBe(false)
      } else expect(result.files.every((file: { exact: boolean }) => file.exact)).toBe(true)
      if (scenario === "mixed") expect(result.files[0].lines).toBe(250)
    }),
  )

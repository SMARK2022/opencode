import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
// #485：Image.Service 供 resizer 不可用环境注入
import { Image } from "@/image/image"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMClient, LLMEvent } from "@opencode-ai/llm"
import { Plugin } from "../../src/plugin"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string, options: Record<string, unknown> = {}) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          ...options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

// 只有续轮用例需要完整 Prompt 图，其余 Processor 测试不额外启动该依赖链。
const continuationIt = testEffect(LayerNode.compile(
  LayerNode.group([root, SessionPrompt.node, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
))

// 原生执行器先交付 tool-call 再实际 execute；与 SDK 的相反顺序共同约束同一登记入口。
const nativeIt = testEffect(LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: true })],
    // 只脚本化 Provider 运输，原生 dispatch、真实 execute 与持久化仍走生产路径。
    [LayerNodePlatform.llmClient, Layer.succeed(LLMClient.Service, LLMClient.Service.of({
      prepare: () => Effect.die("unused"),
      generate: () => Effect.die("unused"),
      stream: () => Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call_1", name: "lookup", input: { query: "weather" }, providerMetadata: { openai: { itemId: "fc_1" } } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ),
    }))],
  ],
))

// #485：resizer 不可用环境——Image.Service 注入必然失败的 normalize，验证 fail-closed 省略语义
const failingImageLayer = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const unavailableEnv = LayerNode.compile(
  // TestLLMServer必须保留在环境中：工具循环仍需要一次完整的provider往返。
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [...replacements, [Image.node, failingImageLayer]],
)
const unavailable = testEffect(unavailableEnv)
// #568：生产默认是 v1 projector 路径（experimentalEventSystem 关闭时坏行曾真实入库）；
// 工具 input 形状测试必须在 v1-only env 下观察持久化边界，不能依赖 v2 decoder 拦截。
const v1Env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: false })],
  ] as const,
)
const v1It = testEffect(v1Env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

// [local-smark] 脚本化 LLM：同一响应内多个独立 ID 的 text blocks 无法经 OpenAI-compatible
// 测试端点表达；在 LLM.Service 公开接口上重放固定事件序列，SessionProcessor.process 仍是真实被测单元。
const scriptedLlmRunner = (events: LLMEvent[]) => {
  let streamCalls = 0
  return {
    // calls 取差值而非绝对值：module 级 runner 会被同进程多次运行复用。
    calls: () => streamCalls,
    it: testEffect(
      LayerNode.compile(
        LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
        [
          ...replacements,
          [
            LLM.node,
            Layer.succeed(
              LLM.Service,
              LLM.Service.of({
                stream: () => {
                  streamCalls++
                  return Stream.fromIterable(events)
                },
              }),
            ),
          ] as const,
        ],
      ),
    ),
  }
}

// 两个独立 ID 的 text Part 各 40 KiB / 25 KiB+1，合计 66,561 > 64 KiB：
// 任一 Part 单独都在旧逐 Part 语义下合法，只有 attempt 级累计预算能拦截。
const cumulativeScript = scriptedLlmRunner([
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "txt-cum-a" }),
  LLMEvent.textDelta({ id: "txt-cum-a", text: "a".repeat(40 * 1024) }),
  LLMEvent.textEnd({ id: "txt-cum-a" }),
  LLMEvent.textStart({ id: "txt-cum-b" }),
  LLMEvent.textDelta({ id: "txt-cum-b", text: "b".repeat(25 * 1024 + 1) }),
])

// 真实tool-call及结算之后超限必须立即终态，不能把仅开始输入误当作已发生调用。
// providerExecuted脚本只提供事件，不注册或执行本地bash工具。
const toolBearingScript = scriptedLlmRunner([
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolInputStart({ id: "call-tb", name: "bash" }),
  LLMEvent.toolCall({ id: "call-tb", name: "bash", input: {}, providerExecuted: true }),
  LLMEvent.toolResult({ id: "call-tb", name: "bash", result: { type: "error", value: "tool settled before output limit" }, providerExecuted: true }),
  LLMEvent.textStart({ id: "txt-tb" }),
  LLMEvent.textDelta({ id: "txt-tb", text: "x".repeat(65_537) }),
])

// #582：experimental.text.complete 是 delta guard 之后仍可扩大正文的 reachable public hook；
// 只扩张第一次完成，让 retry 后的 attempt 保留原文，同一用例内同时验证终值复检与恢复路径。
let textCompleteExpanded = false
const expandingTextPlugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
    if (name !== "experimental.text.complete" || typeof output !== "object" || output === null) return Effect.succeed(output)
    const text = Reflect.get(output, "text")
    // module 级一次性扩张标记必须在用例内重置，否则重跑时第二次扩张缺失。
    if (typeof text !== "string" || textCompleteExpanded) return Effect.succeed(output)
    return Effect.sync(() => {
      textCompleteExpanded = true
      return { ...output, text: text + "y".repeat(65_537) }
    })
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
// 走真实 TestLLMServer 响应（reply()），仅替换 Plugin 层注入终值扩张；
// 不脚本化 LLM，保证 processor 到 provider 的完整链路与生产一致。
const pluginIt = testEffect(
  // Plugin.node 替换在 LayerNode.compile 层完成，与 registry.test.ts 同模式。
  LayerNode.compile(
    LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
    [...replacements, [Plugin.node, expandingTextPlugin] as const],
  ),
)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        // 此 fixture 验证最终失败投影；普通未标记流错误现在由共享策略持续恢复。
        LLMEvent.providerError({ message: "provider boom", retryable: false }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})
// ---------------------------------------------------------------------------
// consecutive-error breaker 测试工具
// ---------------------------------------------------------------------------

// [local-smark] 测试用 failing tool：execute 抛出错误后 AI SDK v6 会捕获
// 并发出 tool-error 事件（executeToolCall catch block → { type: "tool-error" }）。
// streamText 默认 stopWhen=stepCountIs(1)，单步执行工具——一个 process() 调用
// 内的所有并行 tool-error 共享同一 ctx.assistantMessage.id。
// 返回类型标注 Promise<{ output: string }> 满足 AI SDK v6 tool() 的类型推断：
// execute 总是 throw 时 OUTPUT 会被推断为 never，导致 inputSchema 类型不匹配。
const failingRead = tool({
  description: "read",
  inputSchema: z.object({ path: z.string() }),
  execute: async (): Promise<{ output: string }> => {
    throw new Error("File not found")
  },
})

// #485：携带图片附件的 read 工具工厂——附件携带完整 FilePart 三 ID，
// 与生产 session/tools.ts 注册适配器同形；否则会被 processor 的 Schema 过滤丢弃，
// 使 omitted 分支不可达（回归测试空转）。
const makeImageRead = (sessionID: SessionID, messageID: MessageID) =>
  tool({
    description: "image read",
    inputSchema: z.object({ path: z.string() }),
    execute: async (): Promise<{ output: string; attachments: Array<Record<string, string>> }> => ({
      output: "tool output",
      attachments: [
        {
          id: PartID.ascending(),
          sessionID,
          messageID,
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,AA==",
        },
      ],
    }),
  })

// [local-smark] 构造并行工具调用的 SSE chunks。
// reply().tool() 硬编码 index=0（llm-server.ts toolStartLine），无法脚本并行调用——
// OpenAI Chat protocol 用 tool.index 作为 stream key（openai-chat.ts:334），
// 相同 index 会被 ToolStream.appendOrStart 合并为单个 tool call。
// 必须用 raw() 手工构造不同 index 的 chunks。
function parallelToolCalls(calls: Array<{ id: string; name: string; args: string }>) {
  const head: unknown[] = [
    { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
  ]
  for (let i = 0; i < calls.length; i++) {
    head.push(
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: i, id: calls[i].id, type: "function", function: { name: calls[i].name, arguments: "" } },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: calls[i].args } }] } }],
      },
    )
  }
  return raw({
    head,
    tail: [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
  })
}

// [local-smark] doom_loop=deny 的测试配置：触发时 permission.ask 抛 DeniedError，
// halt 设置 ctx.assistantMessage.error，process() 返回 "stop"。
// 未触发时 process() 返回 "continue"且 error 为 undefined。
// 通过 config.permission.doom_loop 覆盖 agent 默认的 "ask"（agent.ts:118）。
function denyDoomLoopConfig(url: string) {
  return { ...providerCfg(url), permission: { doom_loop: "deny" as const } }
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// #568：工具 input 形状守卫：agent 权限 `* deny` + 白名单，AI SDK 对非法 JSON 参数
// 的解析失败会走 invalid dynamic tool-call 兜底，input 可能是原始字符串。
// tools 中不注册 invalid 时 repair 必然失败，processor 必须把非 object input
// 归一化（目标上游实现为 {value: 原始值} 包装），否则坏 schema 会进入持久化并在
// 冷存储扫描时抛 corruption。该测试只断言持久化 Part 的公开状态，不检查内部 helper。
const denyAgent = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
  ],
})

// execute 不抛错：本组用例关注 input 形状而非执行失败，错误必须来自 SDK 解析路径。
const bashTool = tool({
  description: "bash",
  inputSchema: z.object({ command: z.string() }),
  execute: async (): Promise<{ output: string }> => ({ output: "" }),
})

// #568：镜像 src/tool/invalid.ts 的 repair 目标：schema 只接受 {tool, error}。
const invalidRepairTool = tool({
  description: "Do not use",
  inputSchema: z.object({ tool: z.string(), error: z.string() }),
  execute: async (): Promise<{ output: string }> => ({
    output: "The arguments provided to the tool are invalid",
  }),
})
// output 文案与生产 invalid 工具一致：修复后的调用对模型呈现相同回执语义。

// #568：非法 JSON arguments 必须用 raw SSE 手工构造：reply().tool() 会 stringify 成合法 JSON，
// 无法触发 AI SDK 的 InvalidToolInputError 修复路径。
function malformedToolCall(id: string, name: string, args: string) {
  // head 三帧：role → tool_calls 开帧（空 args）→ 参数帧；args 原样透传不 validate。
  return raw({
    head: [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }],
      },
    ],
    tail: [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
  })
}

// #568：修复目标缺失（repair 工具未注册）时，非法调用必须以 error 落库且 input 归一化，
// 证明归一化不依赖 invalid 注册这一可选前置；目标上游把原始值包为 {value:...} 保留原值。
v1It.live("normalizes raw-string tool input when the repair tool is unavailable", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        yield* llm.push(malformedToolCall("call_malformed", "bash", '{"command": "ls"'))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run bash")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: denyAgent(),
          system: [],
          messages: [{ role: "user", content: "run bash" }],
          tools: { bash: bashTool },
        })
        const part = (yield* MessageV2.parts(msg.id)).find((item): item is MessageV2.ToolPart => item.type === "tool")
        expect(result).toBe("continue")
        expect(part?.state.status).toBe("error")
        // #568：原始非法参数字符串不得裸进持久化 ToolState.input——目标上游契约为 {value: 原始串} 包装。
        expect(part?.state.input).toEqual({ value: '{"command": "ls"' })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// #568：valid JSON array 会被 AI SDK 解析成非 object input；仍需在 processor 持久化边界归一化，
// 证明保护的是 ToolState schema，而不只是 malformed string 的特殊形态。
v1It.live("normalizes parsed array tool input when the repair tool is unavailable", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        // `[]` 是合法 JSON 但违反 bash object schema，可区分 safeParseJSON 成功后的 array
        // 与上一用例的 malformed string 分支，确保两条 SDK 输入路径都经过同一持久化守卫。
        yield* llm.push(malformedToolCall("call_array", "bash", "[]"))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run bash")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: denyAgent(),
          system: [],
          messages: [{ role: "user", content: "run bash" }],
          tools: { bash: bashTool },
        })
        const part = (yield* MessageV2.parts(msg.id)).find((item): item is MessageV2.ToolPart => item.type === "tool")
        expect(result).toBe("continue")
        expect(part?.state.status).toBe("error")
        // #568：array 同样被上游包装为 {value: []}——非法形状不裸入，但原值可追溯。
        expect(part?.state.input).toEqual({ value: [] })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// #568：与上一用例对照：即使 user.tools 显式禁用 invalid，内部 repair 路径仍可达，
// 调用被修复为合法的 invalid 工具调用并执行，落库 status=completed、input 为 {tool, error} 对象。
// 修复前（任一用户禁用边界过滤 invalid）该场景只会得到 error 状态，因此是 Fix A 的回归哨兵。
v1It.live("repairs an unavailable tool call into the invalid tool with object input", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        yield* llm.push(malformedToolCall("call_malformed", "bash", '{"command": "ls"'))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run bash")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            // user.tools 显式禁用 invalid：Fix A 必须绕过该禁用保留 repair 注册。
            tools: { invalid: false },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: denyAgent(),
          system: [],
          messages: [{ role: "user", content: "run bash" }],
          tools: { bash: bashTool, invalid: invalidRepairTool },
        })
        const part = (yield* MessageV2.parts(msg.id)).find((item): item is MessageV2.ToolPart => item.type === "tool")
        expect(result).toBe("continue")
        // #568：invalid repair 目标保留注册时，AI SDK 把非法调用修复为合法 invalid 调用并执行。
        expect(part?.state.status).toBe("completed")
        if (part?.state.status === "completed") {
          expect(part.state.input).toMatchObject({ tool: "bash" })
          expect(typeof (part.state.input as { error?: unknown }).error).toBe("string")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        // 估算允许发出请求，随后由provider确认的超限用量触发压缩，区分prepared预检分支。
        yield* llm.text("after", { usage: { input: 30_000, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20_000, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: ["fixture-instructions".repeat(40)],
          inputSections: [{ kind: "instructions", text: "fixture-instructions".repeat(40) }],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
        const finish = parts.find((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
        expect(finish?.inputChars).toBe(handle.message.inputEstimate?.bodyChars)
        expect(finish?.inputBreakdown?.instructions).toBe(800)
        const prepared = (yield* session.get(chat.id)).request?.inputEstimate
        expect(prepared?.confirmed).toBe(true)
        expect(prepared?.charsPerToken).toBe(4)
        expect(prepared?.inputBreakdown).toEqual(finish?.inputBreakdown)
        // 800字符指令仍归属原桶，公开账本使用provider确认的30000输入而非prepared估算。
        expect((yield* session.get(chat.id)).request?.input).toBe(30_000)
        expect(yield* llm.calls).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const broken = defer<void>()
        yield* llm.push(reply().reason("one").wait(broken.promise).reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const events = yield* EventV2Bridge.Service
        // 已消费失败前缀后才断开，确保测试能发现持久化残留，而非恰好没收到首块。
        const unsubscribe = yield* events.listen(event => Effect.sync(() => {
          if (event.type !== MessageV2.Event.PartDelta.type) return
          const data = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.data)(event.data)
          if (data.messageID === msg.id && data.delta === "one") broken.resolve()
        }))
        yield* Effect.addFinalizer(() => unsubscribe)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const value = yield* handle.process({ user: parent, sessionID: chat.id, model: mdl, agent: agent(),
          system: [], messages: [{ role: "user", content: "reason" }], tools: {} })
        const parts = yield* MessageV2.parts(msg.id)
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.filter(part => part.type === "reasoning").map(part => part.text)).toEqual(["two"])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor retries a real first-progress timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const gate = defer<void>()
        const retry = defer<{ attempt: number; message: string }>()
        // 失败与中断也释放 headers 前的唯一 gate，避免 fixture 的 handler 逃逸当前 scope。
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve(undefined)))

        // 闸门停在 HTTP headers 之前；若没有 dispatch deadline，503 只能在释放后触发重试。
        // 第二项仍是同一 Provider 的成功响应，不改变既有 retry 分类和 backoff。
        yield* llm.push(httpError(503, { error: { message: "delayed" } }, gate.promise))
        // 成功响应显式 repeat；后续 retry 仍消费同一 Provider 结果，不借 queue-miss 默认值自证恢复。
        // #525：repeat 响应必须携带 stop——无 Tool 的 other/unknown finish 是可重试 incomplete，
        // 只有显式 stop 才代表恢复成功并沿既有 other 重试合同终止。
        yield* llm.pushRepeat(reply().text("after").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "first progress")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const bridge = yield* EventV2Bridge.Service
        const off = yield* bridge.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== chat.id || data.status.type !== "retry") return Effect.void
          retry.resolve({ attempt: data.status.attempt, message: data.status.message })
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        // 监听真实 Status bus，而不是读取 processor 内部 retry counter，保护用户可见的行为契约。
        // 订阅在 process fork 前建立，避免 retry event 已发布后测试才开始等待。
        // retry Status 的 attempt/message 是用户可见合同，不把观察信号改成内部重试计数。
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const scope = yield* Scope.Scope
        const fiber = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "first progress" }],
            tools: {},
          })
          .pipe(Effect.forkIn(scope, { startImmediately: true }))

        // request、Status 和恢复完成共用失败边界；成功仍由真实信号及消息内容决定。
        const { observed, result } = yield* awaitWithTimeout(
          Effect.gen(function* () {
            yield* llm.wait(1)
            const observed = yield* Effect.promise(() => retry.promise)
            gate.resolve(undefined)
            return { observed, result: yield* Fiber.join(fiber) }
          }),
          "first-progress timeout did not publish retry status and recover",
          "20 seconds",
        )
        const parts = yield* MessageV2.parts(msg.id)

        expect(observed?.attempt).toBe(1)
        // message 必须来自真实 Provider progress producer，不能由测试手工构造 APIError 冒充。
        expect(observed?.message).toBe("SSE read timed out")
        // 最终文本而非固定请求次数证明恢复，生产 retry 的上限与退避策略不变。
        expect(result).toBe("continue")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
      }),
    // source 的 500ms 保留 loopback 后续响应调度余量；首次响应仍被 gate 阻塞至真实 deadline 触发。
    { git: true, config: (url) => providerCfg(url, { chunkTimeout: 500 }) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

nativeIt.live("session.processor preserves successful tool metadata while recording real execution", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ProviderV2.ID.make("opencode-fixture"), ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(handle.message.error).toBeUndefined()
        expect(value).toBe("continue")
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        // 调用事件携带的 itemId 仍须原样保存；只有失败收尾才可剥离它。
        expect(call.metadata).toMatchObject({ openai: { itemId: "fc_1" } })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => {
      const config = providerCfg(url)
      // 使用原生支持的 provider 前缀，避免该顺序回归悄悄落回 SDK 路径。
      return { ...config, provider: { "opencode-fixture": { ...config.provider.test, id: "opencode-fixture", npm: "@ai-sdk/openai" } } }
    } },
  ),
)

continuationIt.live("session.processor waits for a real tool after SSE disconnect without cancelling it", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const { processors, session, provider } = yield* boot()
    const started = defer<void>()
    const release = defer<void>()
    const effects: string[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
    const frame = reply().tool("lookup", { query: "weather" }).item()
    if (frame.type !== "sse") return yield* Effect.die("Expected SSE tool fixture")
    // 完整工具请求先交付，真实 execute 就绪后断连接；工具完成另受独立闸门控制。
    yield* llm.push({ ...frame, wait: started.promise, reset: true })
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "tool")
    const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
    const run = yield* handle.process({ user: parent, sessionID: chat.id, model: mdl, agent: agent(),
      system: [], messages: [{ role: "user", content: "tool" }], tools: {
        lookup: tool({ description: "Look up information", inputSchema: z.object({ query: z.string() }),
          execute: async (_, options) => {
            started.resolve()
            await release.promise
            if (options.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError")
            effects.push("proof")
            return { title: "lookup", output: "tool-proof", metadata: {} }
          },
        }),
      } }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Effect.promise(() => started.promise), "tool never started")
    // 此窗口只让已触发的 socket 故障传播，不用于猜测工具是否启动。
    yield* Effect.sleep("50 millis")
    const pending = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
    expect(pending.info.role === "assistant" ? pending.info.time.completed : false).toBeUndefined()
    const call = pending.parts.find(part => part.type === "tool")
    if (!call) return yield* Effect.die("Expected running tool")
    // 在同一持久 Part 注入 Provider 续接身份，验证失败收尾和真正下一请求都不回放它。
    yield* session.updatePart({ ...call, metadata: { ...call.metadata, openai: { itemId: "failed-tool-item" } } })
    release.resolve()
    expect(yield* Fiber.join(run)).toBe("continue")
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
    expect(effects).toEqual(["proof"])
    expect(stored.info).toMatchObject({ id: msg.id, role: "assistant", finish: "unknown" })
    expect(stored.info.role === "assistant" ? stored.info.error : undefined).toBeUndefined()
    expect(stored.parts.filter(part => part.type === "tool")).toMatchObject([
      { callID: "call_1", state: { status: "completed", output: "tool-proof" } },
    ])
    // 同时检查持久化和 wire，避免某个适配器忽略 metadata 使清理断言失去敏感性。
    expect(JSON.stringify(stored.parts)).not.toContain("failed-tool-item")
    yield* llm.text("continued with the original result")
    const prompt = yield* SessionPrompt.Service
    const continued = yield* prompt.loop({ sessionID: chat.id })
    // 真正 Prompt 循环创建新助手，并把已执行调用与原结果交给下一次 HTTP 请求。
    expect(continued.info.id).not.toBe(msg.id)
    expect(continued.parts).toContainEqual(expect.objectContaining({ type: "text", text: "continued with the original result" }))
    const next = JSON.stringify((yield* llm.inputs).at(-1))
    expect(next).toContain("call_1")
    expect(next).toContain("tool-proof")
    expect(next).not.toContain("failed-tool-item")
    expect(effects).toEqual(["proof"])
  }), { config: url => providerCfg(url) }),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        // 使用真实数据库账本与已持久化用户身份，不复制结算逻辑或猜测最新请求。
        const usage = SessionRequestUsage.make(database.db)
        yield* usage.begin({
          sessionID: chat.id, requestID: parent.id, source: "prompt", agent: "build",
          providerID: ref.providerID, modelID: ref.modelID,
        })
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        // 在真实 event owner 观察 raw；此时数据库仍是初始 pending，不允许每片都写 PartUpdated。
        let observedRaw = ""
        let durableRaw: string | undefined
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) => Effect.gen(function* () {
          if (event.type !== MessageV2.Event.PartDelta.type) return
          const data = Schema.decodeUnknownSync(MessageV2.Event.PartDelta.data)(event.data)
          if (data.messageID !== msg.id || data.field !== "raw") return
          const part = yield* session.getPart({ sessionID: chat.id, messageID: msg.id, partID: data.partID })
          if (part?.type === "tool" && part.state.status === "pending") durableRaw = part.state.raw
          observedRaw += data.delta
        }))
        yield* Effect.addFinalizer(() => unsubscribe)

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          // 显式提供可选账本服务，使 cleanup 的生产者实际执行持久化结算。
          .pipe(Effect.provideService(SessionRequestUsage.Service, usage), Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        // fixture 发送半段参数后挂起；等待真实 delta 再取消，避免只测到空 pending 的 cleanup。
        yield* waitFor(Effect.sync(() => observedRaw === '{"cmd"' ? true : undefined), "tool input delta not observed")
        expect(observedRaw).toBe('{"cmd"')
        expect(durableRaw).toBe("")

        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          // [local-smark] 新 abort 记录携带 server-owned executionElapsedMs marker
          expect(call.state.metadata?.executionElapsedMs).toBeDefined()
          expect(typeof call.state.metadata?.executionElapsedMs).toBe("number")
          // 查询编码后的持久化 error，而非 callback 内存对象；raw 必须跨 schema 边界保留。
          expect(call.state.metadata?.raw).toBe('{"cmd"')
          expect(call.state.time.end).toBeDefined()
        }
        // Fiber 退出后读取编码后的助手终态，协调信号完成不能代替消息落盘。
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect(stored.info).toMatchObject({
          id: msg.id, parentID: parent.id, role: "assistant",
          error: { name: "MessageAbortedError" }, time: { completed: expect.any(Number) },
        })
        // 没有 step-finish 的取消仍须闭合请求；未解析工具输入不能被当作 provider 用量。
        expect(yield* usage.get({ sessionID: chat.id, requestID: parent.id })).toMatchObject({
          rootRequestID: parent.id, status: "aborted", assistantCount: 1, stepCount: 0,
          cost: 0, tokens: { total: 0 }, time: { completed: expect.any(Number) },
        })
        // 明细身份固定为本次助手与调用者请求，拒绝错属或只修改内存的假结算。
        expect(yield* usage.assistants({ sessionID: chat.id, requestID: parent.id })).toMatchObject([
          { assistantMessageID: msg.id, rootRequestID: parent.id, status: "aborted", stepCount: 0, cost: 0 },
        ])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

for (const retry of [false, true]) it.live(`session.processor records aborted errors during ${retry ? "retry" : "stream"}`, () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        if (retry) yield* llm.error(429, { error: { message: "rate limited" } })
        if (!retry) yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        // 等已发布的 retry 状态再取消，覆盖没有活跃 Provider 的退避阶段。
        if (retry) yield* waitFor(sts.get(chat.id).pipe(Effect.map(state => state.type === "retry" ? true : undefined)), "retry never started")
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

// #508：保护：并行探索多个不同 path 时即使全部失败也不应 doom_loop（input 不等 → AND 失败）。
// 若误用「同 tool 名计数到 3」会在单 step 内误杀合法多文件读取。
it.live("doom_loop AND: same-batch parallel different-input errors do not trigger", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "read 3 files")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(
          parallelToolCalls([
            { id: "call_1", name: "read", args: JSON.stringify({ path: "A" }) },
            { id: "call_2", name: "read", args: JSON.stringify({ path: "B" }) },
            { id: "call_3", name: "read", args: JSON.stringify({ path: "C" }) },
          ]),
        )

        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "read 3 files" }],
          tools: { read: failingRead },
        })

        // AND 判定下 input 互不相同，窗口永远不满足，不触发 ask
        expect(result).toBe("continue")
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// ---------------------------------------------------------------------------
// [local-smark] provider 空完成检测测试
// ---------------------------------------------------------------------------
// GLM-5.2 等 provider 在大上下文 + thinking + tool_stream 组合下可能返回
// HTTP 200 + SSE 正常关闭，但 finish_reason 为未识别值（AI SDK 归一化为 "unknown"），
// 无 content/reasoning/tool delta，无 usage。processor 必须检测这种空完成并抛出
// retryable APIError，而不是静默写成 completed 后被 goal continuation 无限循环。

// 空完成 SSE：只有 role chunk + finish_reason="unknown"，无内容 delta
// 注：v1.18 ai-sdk 桥接层对 raw network_error 无条件抛 ResponseStreamError（上游更强语义），
// 故用 "unknown" 代表同一未知 finish 族，直达 processor 的空完成检测逻辑。
function emptyCompletionSse() {
  return raw({
    head: [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    ],
    tail: [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "unknown" }] },
    ],
  })
}

it.live("session.processor empty completion with finish_reason=other throws retryable error then recovers", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 第一次请求：空完成（finish_reason=unknown），应抛 retryable APIError
        // 第二次请求：正常文本响应，retry 后应成功
        yield* llm.push(emptyCompletionSse(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "empty then recover")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "empty then recover" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // retry 成功后 process 返回 "continue"
        expect(value).toBe("continue")
        // 第一次空完成触发 retry，第二次正常响应 → 2 次 HTTP 调用
        expect(yield* llm.calls).toBe(2)
        // retry 成功后 error 被清除
        expect(handle.message.error).toBeUndefined()
        // 正常文本被持久化
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor partial output with finish_reason=other retries and recovers", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 第一次有 text delta 但 finish_reason=unknown（归一化路径同 "other" 家族），
        // 第二次返回可识别的 stop，验证 partial output 也进入现有 retry。
        yield* llm.push(
          raw({
            head: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { content: "partial" } }] },
            ],
            tail: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "unknown" }] },
            ],
          }),
          reply().text("recovered").stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "partial output")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "partial output" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // partial unknown 先被转换为 retryable APIError，再由第二次 stop 恢复。
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        expect(parts.some((part) => part.type === "text" && part.text === "partial")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        // V1 无原生 Step.Ended；持久确认点只能留下恢复后的 stop，不能只看最终消息字段。
        expect(parts.filter((part) => part.type === "step-finish").map((part) => part.reason)).toEqual(["stop"])
        expect(handle.message.finish).toBe("stop")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor over-limit output retries once and recovers", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 首次响应单 delta 超过 64 KiB 累计预算，应转为既有 retryable APIError；
        // 65,537 = 64 KiB + 1，覆盖单 chunk 跨过边界的形态。第二次正常恢复。
        yield* llm.push(reply().text("x".repeat(65_537)).stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "over-limit then recover")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "over-limit then recover" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 首次超限进入既有 retry，第二次恢复后 continue。
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        // 超限正文不得以任何前缀形式残留（crossing delta 必须在发布前被拒）。
        expect(parts.some((part) => part.type === "text" && part.text.length > 64 * 1024)).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor repeated over-limit output terminates with MessageOutputLengthError", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 两次响应都超限：首次进入既有 retry，第二次必须终态，
        // 否则确定性 provider 失败会在无上限 retry policy 下无限循环。
        yield* llm.push(
          reply().text("x".repeat(65_537)).stop(),
          reply().text("y".repeat(65_537)).stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "repeated over-limit")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "repeated over-limit" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 两次调用后终态：不再发起第三次请求，错误为既有空 data 合同的命名错误。
        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error?.name).toBe("MessageOutputLengthError")
        expect(parts.filter((part) => part.type === "text").length).toBe(0)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

cumulativeScript.it.live("session.processor cumulative multi-part text budget breaches across parts", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const callsBefore = cumulativeScript.calls()
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "cumulative parts")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "cumulative parts" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 首次累计超限 retry，重放同一脚本后再次超限 → 终态；两个 Part 都不得残留。
        expect(value).toBe("stop")
        expect(cumulativeScript.calls() - callsBefore).toBe(2)
        expect(handle.message.error?.name).toBe("MessageOutputLengthError")
        expect(parts.filter((part) => part.type === "text").length).toBe(0)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

toolBearingScript.it.live("session.processor tool-bearing over-limit output terminates without replay", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const callsBefore = toolBearingScript.calls()
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool bearing over-limit")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool bearing over-limit" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 一次真实调用后不再请求provider；已结算Tool保留，超限Text全部撤回。
        expect(value).toBe("stop")
        expect(toolBearingScript.calls() - callsBefore).toBe(1)
        expect(handle.message.error?.name).toBe("MessageOutputLengthError")
        expect(parts.some((part) => part.type === "text")).toBe(false)
        expect(parts.some((part) => part.type === "tool" && part.state.status === "error")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

pluginIt.live("session.processor plugin-expanded text.complete final value is re-checked against the limit", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        // module 级一次性扩张标记必须在用例内重置，否则重跑时第二次扩张缺失。
        textCompleteExpanded = false
        const { processors, session, provider } = yield* boot()

        // 第一次响应本身在预算内，但 plugin 终值扩张后超限；第二次同一响应不再扩张，
        // 应完成恢复。两个响应都显式排入，避免空队列自动 "ok" 干扰。
        yield* llm.push(reply().text("small").stop(), reply().text("small").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "plugin expansion")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "plugin expansion" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 断言终值复检而非首检：扩张后的文本必须被拒并回退到 retry，
        // 验证的是 text-end 后 pluginGrowth 复检路径而非 delta 预算。
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        expect(parts.some((part) => part.type === "text" && part.text.length > 64 * 1024)).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "small")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor reasoning-only finish_reason=other retries and recovers", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // reasoning-only 与 text fixture 独立，直接覆盖数据库中最常见的 partial-thinking 形态。
        // 第二个响应使用固定字面量，expected 不复制 production 的 finish 判断。
        yield* llm.push(
          raw({
            head: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { reasoning_content: "partial thinking" } }] },
            ],
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "network_error" }],
              },
            ],
          }),
          reply().text("recovered").stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning only" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        // 断言用户可观察的恢复结果和失败前缀消失，不依赖 processor 内部追踪字段。
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        // 旧 reasoning Part 若未撤回会与 recovered text 共存，因此该断言能捕获 attempt cleanup 缺失。
        expect(parts.some((part) => part.type === "reasoning" && part.text === "partial thinking")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor empty stop (no content, finish=stop) does not throw", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // finish_reason=stop 但无 content delta
        // finishReason !== "other" → 不触发空完成检测
        yield* llm.push(
          raw({
            head: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
            ],
            tail: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "empty stop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "empty stop" }],
          tools: {},
        })

        // finish_reason=stop 不触发空完成检测 → 正常完成（即使无内容）
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// #508：保护：跨 turn 换参重试（A/B/C 不同 path）是合理探索，仅连续失败不得拦截。
// 这是用户明确否定的旧 consecutiveErrorMap 语义；期望全程 continue。
it.live("doom_loop AND: cross-turn different-input errors do not trigger", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(
          reply().tool("read", { path: "A" }),
          reply().tool("read", { path: "B" }),
          reply().tool("read", { path: "C" }),
        )

        for (let turn = 0; turn < 3; turn++) {
          const parent = yield* user(chat.id, `turn ${turn}`)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: `turn ${turn}` }],
            tools: { read: failingRead },
          })

          // 不同 input 的连续失败不满足 AND，全程 continue
          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// #508：核心：生产默认每 step 新 assistant、每 turn 1 tool；同 path 三次 error 必须在第 3 次 stop。
// 覆盖 multi-assistant tail 深度；禁止用「单 assistant 堆 3 条 tool」冒充此形状。
// #553：两个 visible failure 加一个 hidden current Tool 仍不足三次；tombstone 不能触发 doom-loop。
// 使用真实 Processor seam，避免只测试筛选 helper 而漏掉 current-message 合并顺序。
it.live("doom_loop AND: hidden current Tool does not satisfy the threshold", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(reply().tool("read", { path: "same" }), reply().tool("read", { path: "same" }))

        for (let turn = 0; turn < 2; turn++) {
          const parent = yield* user(chat.id, `same ${turn}`)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })
          if (turn === 1) {
            // #553：current message 追加 hidden error Tool——不计入连续失败阈值。
            yield* session.updatePart({
              id: PartID.ascending(), messageID: msg.id, sessionID: chat.id,
              type: "tool", callID: "hidden", tool: "read", hidden: { time: Date.now(), reason: "undo" },
              state: { status: "error", input: { path: "same" }, error: "hidden", time: { start: 0, end: 1 } },
            })
          }

          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "same" }],
            tools: { read: failingRead },
          })

          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

it.live("doom_loop AND: cross-turn same-input errors trigger", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(
          reply().tool("read", { path: "same" }),
          reply().tool("read", { path: "same" }),
          reply().tool("read", { path: "same" }),
        )

        for (let turn = 0; turn < 3; turn++) {
          const parent = yield* user(chat.id, `same ${turn}`)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: `same ${turn}` }],
            tools: { read: failingRead },
          })

          if (turn < 2) {
            expect(result).toBe("continue")
            expect(handle.message.error).toBeUndefined()
          } else {
            // 第 3 次同 input error：AND 满足 → ask → DeniedError → stop
            expect(result).toBe("stop")
            expect(handle.message.error).toBeDefined()
          }
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// #508：保护：相同 input 的成功重复调用（缓存/重读）不得再走旧 tool-call 相同输入预检。
// deny 配置下若仍 stop，说明错误地在 tool-call 或 completed 状态触发了 doom_loop。
const successRead = tool({
  description: "read",
  inputSchema: z.object({ path: z.string() }),
  execute: async (): Promise<{ output: string }> => ({ output: "ok" }),
})

it.live("doom_loop AND: identical successful calls do not trigger", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(
          reply().tool("read", { path: "same" }),
          reply().tool("read", { path: "same" }),
          reply().tool("read", { path: "same" }),
        )

        for (let turn = 0; turn < 3; turn++) {
          const parent = yield* user(chat.id, `ok ${turn}`)
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const result = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: `ok ${turn}` }],
            tools: { read: successRead },
          })

          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

// #485：resizer 不可用时图片附件被省略（fail-closed），工具文本保留且不回退原图
unavailable.live("omits an image attachment when normalization is unavailable", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        yield* llm.push(reply().tool("image_read", { path: "image.png" }))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "read image")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "read image" }],
          tools: { image_read: makeImageRead(chat.id, msg.id) },
        })
        const part = (yield* MessageV2.parts(msg.id)).find((item): item is MessageV2.ToolPart => item.type === "tool")
        expect(result).toBe("continue")
        // fail-closed不能把工具执行也取消：循环仍继续，工具part按正常completed落库
        expect(part?.state.status).toBe("completed")
        if (part?.state.status === "completed") {
          // 失败图片不能回到 provider，但工具文本仍需保留，且必须携带省略说明——
          // 该断言钉住 omitted 分支真实可达（附件已过 FilePart Schema 过滤）
          expect(part.state.attachments).toBeUndefined()
          expect(part.state.output).toContain("tool output")
          expect(part.state.output).toContain(
            "[1 image omitted: could not be decoded or resized within the image size limit.]",
          )
          // #509：raw AI tool 可不返回 title；上游 toolResultOutput 在 producer 层已把缺省 title 归一为
          // 工具名（string），completed 终态持久化后 ColdStorage.freeze/status 全库扫描不会遇到 undefined。
          expect(part.state.title).toBe("image_read")
        }
        // 直接回读MessageV2而不是相信内存结果，确认附件确实未随part持久化
        const stored = yield* MessageV2.parts(msg.id)
        expect(stored.some((item) => item.type === "file")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// #534：direct completion（abort adapter 等直达 completeToolCall 的路径）也必须经过统一准备边界；
// hanging pendingTool 让 part 停在 running，测试侧用公开 Handle API 直达 completion（prepared=false 路径）。
it.live("prepares malformed image attachments on direct tool completion", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        yield* llm.push(reply().pendingTool("direct", { path: "image.png" }).hang())
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "direct completion")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const scope = yield* Scope.Scope
        const fiber = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "run direct completion" }],
            tools: {},
          })
          .pipe(Effect.forkIn(scope, { startImmediately: true }))
        // 等待 pending part 真实发布——以已发布信号为准，不用固定 sleep 猜调度。
        yield* llm.wait(1)
        const pending = yield* awaitWithTimeout(
          Effect.gen(function* () {
            while (true) {
              const found = (yield* MessageV2.parts(msg.id)).find(
                (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "direct",
              )
              if (found) return found
              yield* Effect.sleep(20)
            }
          }),
          "pending direct tool call was not published",
          "10 seconds",
        )
        // 直达 completion 前先把 part 推进到 running——completeToolCall 只接受 running 终态写入。
        yield* handle.updateToolCall(pending.callID, (part) => ({
          ...part,
          state: {
            status: "running",
            input: pending.state.input,
            time: { start: Date.now() },
          },
        }))
        // callID 与 tools.ts 五处直达调用点同一稳定标识；此处复现 abort adapter 的外部写入形态。
        // 直达 completion：坏图片附件必须先过 prepareToolOutput，且 Tool 终态仍是 completed。
        yield* handle.completeToolCall(pending.callID, {
          title: "direct",
          metadata: {},
          output: "direct output",
          attachments: [
            {
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: chat.id,
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,AA==",
            },
          ],
        })
        const tool = (yield* MessageV2.parts(msg.id)).find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "direct",
        )
        // 图片内容失败不改变 Tool 成功完成的终态语义；
        // attachment 缺失与 omission 同时检查，防止只追加诊断文本却仍把坏 bytes 落库。
        expect(tool?.state.status).toBe("completed")
        if (tool?.state.status !== "completed") return
        expect(tool.state.output).toContain("direct output")
        expect(tool.state.output).toContain(
          "[1 image omitted: could not be decoded or resized within the image size limit.]",
        )
        expect(tool.state.attachments).toBeUndefined()
        yield* Fiber.interrupt(fiber)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
  30_000,
)

// #534：ordinary tool-result 与事件/落库消费同一 prepared snapshot——
// 目标 V1 的 updatePart 单源写让 parity 由构造保证，测试锁定 DB 终态 + PartUpdated 事件真实发布。
it.live("publishes and persists the same prepared ordinary tool output", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bridge = yield* EventV2Bridge.Service
        const seen: string[] = []
        const off = yield* bridge.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        // 订阅在 process 前建立：PartUpdated 若末发布则说明事件分支被旁路，而不是错过监听窗口。
        yield* Effect.addFinalizer(() => off)
        yield* llm.push(reply().tool("ordinary", { path: "bad.png" }))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "ordinary result")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        // #509：execute 返回的 attachments 会过 FilePart Schema；缺 id/messageID/sessionID 的原始对象被丢弃，
        // 必须补全持久化字段才能真实进入 #534 的 prepare 边界。
        const ordinary = tool({
          description: "ordinary image result",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => ({
            title: "ordinary",
            metadata: {},
            output: "ordinary output",
            attachments: [
              {
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: chat.id,
                type: "file" as const,
                mime: "image/png",
                url: "data:image/png;base64,AA==",
              },
            ],
          }),
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "ordinary result" }],
          tools: { ordinary },
        })
        const completed = (yield* MessageV2.parts(msg.id)).find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "ordinary",
        )
        // 事件与 SQLite 同源：omission 文案只拼接一次，durable state 不存在未处理原始 payload。
        expect(completed?.state.status).toBe("completed")
        if (completed?.state.status !== "completed") return
        expect(completed.state.output).toBe(
          "ordinary output\n\n[1 image omitted: could not be decoded or resized within the image size limit.]",
        )
        expect(completed.state.attachments).toBeUndefined()
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
  30_000,
)

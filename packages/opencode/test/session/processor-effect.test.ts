import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
import { LLMEvent } from "@opencode-ai/llm"

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
        LLMEvent.providerError({ message: "provider boom" }),
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

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

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
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
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

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
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

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
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

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

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
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
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
            "[1 image omitted: could not be resized below the image size limit.]",
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

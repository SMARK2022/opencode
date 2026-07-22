import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { tool as aiTool } from "ai"
import z from "zod"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
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
  const msg: MessageV2.Assistant = {
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)
const unavailableEnv = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(
      Layer.succeed(
        Image.Service,
        Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
      ),
    ),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)
const unavailable = testEffect(unavailableEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "read image" }],
          tools: { image_read: imageRead },
        })
        const part = MessageV2.parts(msg.id).find((item): item is MessageV2.ToolPart => item.type === "tool")
        expect(result).toBe("continue")
        expect(part?.state.status).toBe("completed")
        if (part?.state.status === "completed") {
          // 失败图片不能回到provider，但工具文本仍需保留，避免丢失非图片结果。
          expect(part.state.attachments).toBeUndefined()
          expect(part.state.output).toContain("image omitted")
          // raw AI tool 可不返回 title；completed 终态必须持久化为 string，空串合法，
          // 否则 JSON 省略 title 后 ColdStorage.freeze/status 会在全库扫描时报 corruption。
          expect(part.state.title).toBe("")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// consecutive-error breaker 测试工具
// ---------------------------------------------------------------------------

// [local-smark] 测试用 failing tool：execute 抛出错误后 AI SDK v6 会捕获
// 并发出 tool-error 事件（executeToolCall catch block → { type: "tool-error" }）。
// streamText 默认 stopWhen=stepCountIs(1)，单步执行工具——一个 process() 调用
// 内的所有并行 tool-error 共享同一 ctx.assistantMessage.id。
// 返回类型标注 Promise<{ output: string }> 满足 AI SDK v6 tool() 的类型推断：
// execute 总是 throw 时 OUTPUT 会被推断为 never，导致 inputSchema 类型不匹配。
const failingRead = aiTool({
  description: "read",
  inputSchema: z.object({ path: z.string() }),
  execute: async (): Promise<{ output: string }> => {
    throw new Error("File not found")
  },
})
const imageRead = aiTool({
  description: "image read",
  inputSchema: z.object({ path: z.string() }),
  execute: async (): Promise<{ output: string; attachments: Array<{ type: "file"; mime: string; url: string }> }> => ({
    output: "tool output",
    attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
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
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          Effect.sync(() => MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })
        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { git: true, config: (url) => providerCfg(url) },
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
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
          } satisfies MessageV2.User,
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
    { git: true, config: (url) => providerCfg(url) },
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor retries a real first-progress timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const gate = defer<void>()
        const retry = defer<{ attempt: number; message: string }>()
        // gate属于测试夹具；内部失败边界关闭scope时必须释放仍在等待的HTTP handler。
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve(undefined)))

        // 闸门让首个HTTP response永远晚于500ms；只有Provider的dispatch deadline能先发布retry。
        // 延迟错误保持one-shot；repeat响应必须携带stop，才能沿现有other重试合同终止并证明恢复。
        // 这条顺序把 first-progress timeout 放在真实 HTTP producer 与现有 retry consumer 之间验证。
        // 503 仍保留原有服务器错误形状，只有新增的 progress deadline 改变 failure 的产生时机。
        yield* llm.push(httpError(503, { error: "delayed" }, gate.promise))
        yield* llm.pushRepeat(reply().text("after").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "first progress")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* (yield* Bus.Service).subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id || evt.properties.status.type !== "retry") return
          retry.resolve({ attempt: evt.properties.status.attempt, message: evt.properties.status.message })
        })
        yield* Effect.addFinalizer(() => Effect.sync(off))
        // 监听真实 Status bus，而不是读取 processor 内部 retry counter，保护用户可见的行为契约。
        // 订阅在 process fork 前建立，避免 retry event 已发布后测试才开始等待。
        // retry Status 的 attempt/message 是 Session 用户可见合同，也是没有 retry cap 的可观测边界。
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

        // request、Status与Message决定正向结果；20秒边界只在行为缺失时失败并触发scope清理。
        const { observed, result } = yield* awaitWithTimeout(
          Effect.gen(function* () {
            yield* llm.wait(1)
            const observed = yield* Effect.promise(() => retry.promise)
            gate.resolve(undefined)
            const result = yield* Fiber.join(fiber)
            return { observed, result }
          }),
          "first-progress timeout did not publish retry status and recover",
          "20 seconds",
        )
        // gate 只释放服务器 fixture；SessionRetry 的既有 backoff 和 retryable 分类保持真实执行。
        // 后续响应沿着同一processor成功完成，不把恢复错误绑定到某个固定retry次数。
        const parts = MessageV2.parts(msg.id)

        expect(observed?.attempt).toBe(1)
        // message 必须来自真实 Provider progress producer，不能由测试手工构造 APIError 冒充。
        expect(observed?.message).toBe("SSE read timed out")
        expect(result).toBe("continue")
        // 显式响应内容证明Session已恢复，避免把无上限retry误写成固定HTTP调用次数。
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
      }),
    {
      git: true,
      // 首次响应由gate持续阻塞；500ms只触发被测超时，并为后续loopback成功保留调度余量。
      config: (url) => providerCfg(url, { chunkTimeout: 500 }),
    },
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
          } satisfies MessageV2.User,
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
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
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
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          Effect.sync(() => MessageV2.parts(msg.id).find((part): part is MessageV2.ToolPart => part.type === "tool")),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

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
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
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
            } satisfies MessageV2.User,
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
        off()

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
    { git: true, config: (url) => providerCfg(url) },
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
            } satisfies MessageV2.User,
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
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// 保护：并行探索多个不同 path 时即使全部失败也不应 doom_loop（input 不等 → AND 失败）。
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "read 3 files" }],
          tools: { read: failingRead },
        })

        expect(result).toBe("continue")
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// 保护：跨 turn 换参重试（A/B/C 不同 path）是合理探索，仅连续失败不得拦截。
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
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: `turn ${turn}` }],
            tools: { read: failingRead },
          })

          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// 核心：生产默认每 step 新 assistant、每 turn 1 tool；同 path 三次 error 必须在第 3 次 stop。
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
            } satisfies MessageV2.User,
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
            expect(result).toBe("stop")
            expect(handle.message.error).toBeDefined()
          }
        }
      }),
    { git: true, config: (url) => denyDoomLoopConfig(url) },
  ),
)

// 保护：相同 input 的成功重复调用（缓存/重读）不得再走旧 tool-call 相同输入预检。
// deny 配置下若仍 stop，说明错误地在 tool-call 或 completed 状态触发了 doom_loop。
const successRead = aiTool({
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
            } satisfies MessageV2.User,
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

// ---------------------------------------------------------------------------
// [local-smark] provider 空完成检测测试
// ---------------------------------------------------------------------------
// GLM-5.2 等 provider 在大上下文 + thinking + tool_stream 组合下可能返回
// HTTP 200 + SSE 正常关闭，但 finish_reason="network_error"（AI SDK 映射为 "other"），
// 无 content/reasoning/tool delta，无 usage。processor 必须检测这种空完成并抛出
// retryable APIError，而不是静默写成 completed 后被 goal continuation 无限循环。

// 空完成 SSE：只有 role chunk + finish_reason="network_error"（→ AI SDK "other"），无内容 delta
function emptyCompletionSse() {
  return raw({
    head: [{ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] }],
    tail: [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "network_error" }],
      },
    ],
  })
}

it.live("session.processor empty completion with finish_reason=other throws retryable error then recovers", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 第一次请求：空完成（finish_reason=network_error → AI SDK "other"），应抛 retryable APIError
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
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "empty then recover" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

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

        // 第一次有 text delta 但 finish_reason=network_error（→ "other"），
        // 第二次返回可识别的 stop，验证 partial output 也进入现有 retry。
        yield* llm.push(
          raw({
            head: [
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
              { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { content: "partial" } }] },
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
        const parent = yield* user(chat.id, "partial output")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const ended: string[] = []
        const unsubscribe = yield* (yield* EventV2.Service).sync((event) => {
          if (Schema.is(SessionEvent.Step.Ended)(event)) ended.push(event.data.finish)
          return Effect.void
        })

        const value = yield* handle.process({
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
          messages: [{ role: "user", content: "partial output" }],
          tools: {},
        })
        yield* unsubscribe

        const parts = MessageV2.parts(msg.id)

        // partial other 先被转换为 retryable APIError，再由第二次 stop 恢复。
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        expect(parts.some((part) => part.type === "text" && part.text === "partial")).toBe(false)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        // 失败的 other 不得先发布成功态，事件流只应看到恢复后的 stop。
        expect(ended).toEqual(["stop"])
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
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
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
          messages: [{ role: "user", content: "reasoning only" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

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
          } satisfies MessageV2.User,
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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Stream } from "effect"
import z from "zod"
import { makeRuntime } from "../../src/effect/run-service"
import { InstanceRef } from "../../src/effect/instance-ref"
import { LLM } from "../../src/session/llm"
import type { InstanceContext } from "../../src/project/instance-context"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@opencode-ai/core/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "@/util/filesystem"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

async function getModel(providerID: ProviderID, modelID: ModelID, ctx: InstanceContext) {
  const effect = Effect.gen(function* () {
    const provider = yield* Provider.Service
    return yield* provider.getModel(providerID, modelID)
  })
  return AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
}

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function drain(input: LLM.StreamInput, ctx: InstanceContext) {
  return llm.runPromise((svc) => {
    const effect = svc.stream(input).pipe(Stream.runDrain)
    return effect.pipe(Effect.provideService(InstanceRef, ctx))
  })
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response | Promise<Response>)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(
  pathname: string,
  response: Response | ((req: Request, capture: Capture) => Response | Promise<Response>),
) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

async function readLogUntil(file: string, ready: (content: string) => boolean) {
  let content = ""
  for (let i = 0; i < 50; i++) {
    content = await Bun.file(file)
      .text()
      .catch(() => "")
    if (ready(content)) return content
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return content
}

async function withInfoLog<T>(fn: (file: string) => Promise<T>) {
  const previous = Global.Path.log
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false, dev: false, level: "INFO" })
  try {
    return await fn(Log.file())
  } finally {
    Global.Path.log = previous
    await Log.init({ print: false, dev: true, level: "DEBUG" })
  }
}

function providerFetchEvents(content: string) {
  return content
    .split("\n")
    .filter((line) => line.includes("service=provider.fetch"))
    .map((line) => Object.fromEntries(Array.from(line.matchAll(/([A-Za-z.]+)=([^\s]+)/g), (match) => [match[1], match[2]])))
}

function waitStreamingRequest(pathname: string, firstChunkDelayMs = 0) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            if (firstChunkDelayMs > 0) await Bun.sleep(firstChunkDelayMs)
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string, delayMs = 0) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (delayMs <= 0) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
        return
      }

      // 总流时长故意超过 timeout，但每个 raw chunk 间隔都小于 timeout，锁定“不累计、每块重置”。
      // 若实现把 gap 累加成总时长，后续 chunk 会在最后一个 payload 到达前触发 abort。
      // 每一块都经过同一 ReadableStream body，避免测试只模拟 semantic text delta。
      for (const line of payload.split("\n\n").filter(Boolean)) {
        controller.enqueue(encoder.encode(`${line}\n\n`))
        await Bun.sleep(delayMs)
      }
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function configModel(model: ModelsDev.Model) {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function createStalledEventResponse() {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\n"))
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}

describe("session.llm.stream", () => {
  test("logs provider response and first raw SSE chunk when chunk timeout is enabled", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "timed-openai-compatible"
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello", 20), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [providerID],
          provider: {
            [providerID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Timed Provider",
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1`, chunkTimeout: 50 },
              models: { "gpt-test": { name: "GPT Test", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const model = await getModel(ProviderID.make(providerID), ModelID.make("gpt-test"), ctx)
          const sessionID = SessionID.make("session-provider-fetch-timing")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          await drain(
            {
              user: {
                id: MessageID.make("msg_user-provider-fetch-timing"),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: ProviderID.make(providerID), modelID: model.id },
              },
              sessionID,
              model,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            },
            ctx,
          )
        },
      })

      await request
      const events = providerFetchEvents(await readLogUntil(logFile, (content) => content.includes("phase=sse.end")))
      expect(events.map((event) => event.phase)).toEqual([
        "fetch.start",
        "fetch.response",
        "sse.first_chunk",
        "sse.end",
      ])
      expect(events.find((event) => event.phase === "fetch.response")?.status).toBe("200")
      expect(events.find((event) => event.phase === "fetch.response")?.isSSE).toBe("true")
      expect(Number(events.find((event) => event.phase === "sse.first_chunk")?.bytes)).toBeGreaterThan(0)
      expect(Number(events.find((event) => event.phase === "sse.end")?.chunkCount)).toBeGreaterThan(0)
    })
  })

  test("bounds stream error logs without changing the error event", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const requestMarker = "REQUEST_BODY_SECRET_MARKER_7f5c"
    const providerID = "bounded-error-" + "p".repeat(3_000)
    const modelID = "gpt-" + "m".repeat(3_000)
    const request = waitRequest(
      "/chat/completions",
      new Response(JSON.stringify({ error: { message: requestMarker + "R".repeat(12_000) } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [providerID],
          provider: {
            [providerID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Bounded Error Provider",
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
              models: { [modelID]: { name: "GPT Test", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const model = await getModel(ProviderID.make(providerID), ModelID.make(modelID), ctx)
          const sessionID = SessionID.make("session-bounded-stream-error")
          const agent = {
            name: "a".repeat(3_000),
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const events = await llm.runPromise((svc) =>
            svc
              .stream({
                user: {
                  id: MessageID.make("msg_user-bounded-stream-error"),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: agent.name,
                  model: { providerID: ProviderID.make(providerID), modelID: model.id },
                },
                sessionID,
                model,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: requestMarker + "X".repeat(64_000) }],
                tools: {},
              })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) => [...chunk]),
                Effect.provideService(InstanceRef, ctx),
              ),
          )
          // runCollect 正常返回证明底层 Effect 没有被日志 callback 改成 failure；error event 仍单独可见。
          const event = events.find((item) => item.type === "error")
          if (!event || event.type !== "error") throw new Error("Provider error event was not preserved")
          // 日志丢弃敏感请求，但 event 保留原始 error，避免越权改变 processor 的分类输入。
          expect(JSON.stringify(event.error)).toContain("requestBodyValues")
          expect(JSON.stringify(event.error)).toContain(requestMarker)
        },
      })

      await request
      const content = await readLogUntil(logFile, (text) => text.includes("stream error"))
      const lines = content.split("\n").filter((item) => item.includes("service=llm"))
      // 检查该隔离日志目录中的全部 LLM 行，防止 INFO extra 或 ERROR response echo 绕过边界。
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line).not.toContain("requestBodyValues")
        expect(line).not.toContain(requestMarker)
        expect(Buffer.byteLength(line + "\n", "utf8")).toBeLessThanOrEqual(8_192)
      }
    })
  })

  test("times out before delayed provider headers at the configured chunk boundary", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "delayed-header-openai-compatible"
    const responseReady = deferred<void>()
    const requestAborted = deferred<void>()
    let events: ReturnType<typeof providerFetchEvents> = []
    const request = waitRequest("/chat/completions", async (req) => {
      // 请求已到达但 headers 延迟 100ms；这与“工具完成后首个 chunk 长时间静默”的边界一致。
      // responseReady 用于等待 server handler 收束，避免测试在 client abort 后留下未完成 fixture。
      // abort listener 必须挂在同一个 Request.signal 上，才能证明 Provider deadline 到达了真实 transport。
      // handler 返回迟到 Response 后仍由 client 继续消费，正好覆盖 custom adapter 忽略 signal 的边界。
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      responseReady.resolve()
      return new Response(createChatStream("late"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    })

    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [providerID],
          provider: {
            [providerID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Delayed Header Provider",
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1`, chunkTimeout: 25 },
              models: { "gpt-test": { name: "GPT Test", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const model = await getModel(ProviderID.make(providerID), ModelID.make("gpt-test"), ctx)
          const sessionID = SessionID.make("session-provider-delayed-header")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info

          await drain(
            {
              user: {
                id: MessageID.make("msg_user-provider-delayed-header"),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: ProviderID.make(providerID), modelID: model.id },
              },
              sessionID,
              model,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            },
            ctx,
          )
          await request
          await responseReady.promise
          await requestAborted.promise
          events = providerFetchEvents(await readLogUntil(logFile, (content) => content.includes("phase=sse.timeout")))
        },
      })
    })

    // 首个 raw chunk 尚未到达时也必须记录同一个 no-progress 失败，不能退回 Bun 的五分钟 idle timeout。
    expect(events.map((event) => event.phase)).toContain("sse.timeout")
    // LLM 层可以收束 stream，但 transport abort 和稳定的 sse.timeout milestone 仍必须可观察。
    // retryable classification 由下一层 Processor vertical test 验证，这里只锁定 Provider owner 的 raw 行为。
    // chunkCount=0 区分 headers 前超时与首 chunk 后 stall，防止测试误通过已有 post-response 覆盖。
    // chunkTimeoutMs 断言配置 provenance，确保超时不是 Bun 的固定 idle timeout。
    // 未等待 semantic text 的原因是首个 raw progress contract 发生在 AI SDK 解析之前。
    expect(events.find((event) => event.phase === "sse.timeout")?.chunkCount).toBe("0")
    expect(events.find((event) => event.phase === "sse.timeout")?.chunkTimeoutMs).toBe("25")
  })

  test("logs SSE timeout when a streaming response stalls after the first raw chunk", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "stalled-openai-compatible"
    const request = waitRequest("/chat/completions", createStalledEventResponse())

    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [providerID],
          provider: {
            [providerID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Stalled Provider",
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1`, chunkTimeout: 25 },
              models: { "gpt-test": { name: "GPT Test", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const model = await getModel(ProviderID.make(providerID), ModelID.make("gpt-test"), ctx)
          const sessionID = SessionID.make("session-provider-fetch-timeout")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          await expect(
            drain(
              {
                user: {
                  id: MessageID.make("msg_user-provider-fetch-timeout"),
                  sessionID,
                  role: "user",
                  time: { created: Date.now() },
                  agent: agent.name,
                  model: { providerID: ProviderID.make(providerID), modelID: model.id },
                },
                sessionID,
                model,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              },
              ctx,
            ),
          ).rejects.toThrow()
        },
      })

      await request
      const events = providerFetchEvents(await readLogUntil(logFile, (content) => content.includes("phase=sse.timeout")))
      expect(events.map((event) => event.phase)).toContain("fetch.response")
      expect(events.map((event) => event.phase)).toContain("sse.timeout")
      expect(events.find((event) => event.phase === "sse.timeout")?.chunkCount).toBe("1")
      expect(events.find((event) => event.phase === "sse.timeout")?.chunkTimeoutMs).toBe("25")
      expect(Number(events.find((event) => event.phase === "sse.timeout")?.idleMs)).toBeGreaterThanOrEqual(25)
    })
  })

  test("applies default overall and chunk timeouts when neither is configured", async () => {
    // 行为级验证:用户未配置 timeout / chunkTimeout 时,provider 必须回退到默认值——
    // 整请求绝对超时 600000ms(10 分钟)、chunk 空闲超时 180000ms(3 分钟)。
    // 通过 fetch.start 诊断事件里的 timeoutMs / chunkTimeoutMs 字段断言默认值,无需真正等待超时;
    // 同时断言 sse.end 出现,证明默认 chunk 超时已启用 wrapSSE(此前未配置时不启用)。
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "default-timeout-openai-compatible"
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [providerID],
          provider: {
            [providerID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Default Timeout Provider",
              // 故意不设置 timeout / chunkTimeout,触发默认回退路径
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
              models: { "gpt-test": { name: "GPT Test", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const model = await getModel(ProviderID.make(providerID), ModelID.make("gpt-test"), ctx)
          const sessionID = SessionID.make("session-provider-default-timeout")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          // drain 走真实 provider→custom fetch→wrapSSE 链路(非 mock),故 SSE 里程碑能反映默认配置是否生效
          await drain(
            {
              user: {
                id: MessageID.make("msg_user-provider-default-timeout"),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: ProviderID.make(providerID), modelID: model.id },
              },
              sessionID,
              model,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            },
            ctx,
          )
        },
      })

      // 默认超时仅作安全上限:快路径流式毫秒级完成,不会真正触发 10 分钟/3 分钟死线
      await request
      const events = providerFetchEvents(await readLogUntil(logFile, (content) => content.includes("phase=sse.end")))
      // 默认 chunk 超时启用 wrapSSE,故完整 SSE 里程碑都会出现
      expect(events.map((event) => event.phase)).toEqual([
        "fetch.start",
        "fetch.response",
        "sse.first_chunk",
        "sse.end",
      ])
      // 默认整请求绝对超时 10 分钟(从请求发起计时的硬死线)
      expect(events.find((event) => event.phase === "fetch.start")?.timeoutMs).toBe("600000")
      // 默认 chunk 空闲超时 3 分钟(两个 SSE 字节之间无数据才触发)
      expect(events.find((event) => event.phase === "fetch.start")?.chunkTimeoutMs).toBe("180000")
    })
  })

  for (const item of [
    { name: "options.headers.User-Agent", options: { headers: { "User-Agent": "codex_cli_rs/0.2333" } } },
    { name: "options.header-ua", options: { "header-ua": "codex_cli_rs/0.2333" } },
  ]) {
    test(`uses configured provider ${item.name} for request user agent`, async () => {
      const server = state.server
      if (!server) throw new Error("Server not initialized")

      const providerID = `daxiao-codex-${item.name.includes("headers") ? "headers" : "shortcut"}`
      const request = waitRequest(
        "/chat/completions",
        new Response(createChatStream("Hello"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      )

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: [providerID],
              provider: {
                [providerID]: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "DaXiao Codex",
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                    ...item.options,
                  },
                  models: {
                    "gpt-5.5": {
                      name: "GPT-5.5",
                      limit: {
                        context: 400000,
                        input: 272000,
                        output: 128000,
                      },
                      modalities: {
                        input: ["text", "image"],
                        output: ["text"],
                      },
                    },
                  },
                },
              },
            }),
          )
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const resolved = await getModel(ProviderID.make(providerID), ModelID.make("gpt-5.5"), ctx)
          const sessionID = SessionID.make(`session-test-${providerID}`)
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const user = {
            id: MessageID.make(`msg_user-${providerID}`),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          } satisfies MessageV2.User

          await drain(
            {
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            },
            ctx,
          )

          expect((await request).headers.get("user-agent")).toBe("codex_cli_rs/0.2333")
        },
      })
    })
  }

  test("uses configured provider User-Agent for OpenAI alias providers", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "daxiao-codex-openai"
    const request = waitRequest(
      "/responses",
      createEventResponse(
        [
          {
            type: "response.created",
            response: {
              id: "resp-1",
              created_at: Math.floor(Date.now() / 1000),
              model: "gpt-5.5",
              service_tier: null,
            },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-1",
            delta: "Hello",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ],
        true,
      ),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                extends: "openai",
                npm: "@ai-sdk/openai",
                name: "DaXiao Codex",
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                  headers: {
                    "User-Agent": "codex_cli_rs/0.2333",
                  },
                },
                models: {
                  "gpt-5.5": {
                    name: "GPT-5.5",
                    limit: {
                      context: 400000,
                      input: 272000,
                      output: 128000,
                    },
                    modalities: {
                      input: ["text", "image"],
                      output: ["text"],
                    },
                  },
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make("gpt-5.5"), ctx)
        const sessionID = SessionID.make("session-test-daxiao-codex-openai")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-daxiao-codex-openai"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
          ctx,
        )

        expect((await request).headers.get("user-agent")).toBe("codex_cli_rs/0.2333")
      },
    })
  })

  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "vivgrid"
    const modelID = "gemini-3.1-pro-preview"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
          ctx,
        )

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("service stream cancellation before first progress cancels the deadline promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    // 延迟首个 raw chunk，确保 user abort 发生在 headers/first-progress deadline 仍在等待时。
    const pending = waitStreamingRequest("/chat/completions", 100)

    await withInfoLog(async (logFile) => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: [providerID],
              provider: {
                [providerID]: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                    chunkTimeout: 25,
                  },
                },
              },
            }),
          )
        },
      })

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id), ctx)
          const sessionID = SessionID.make("session-test-service-abort")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const user = {
            id: MessageID.make("msg_user-service-abort"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          } satisfies MessageV2.User

          const ctrl = new AbortController()
          const run = llm.runPromiseExit(
            (svc) =>
              svc
                .stream({
                  user,
                  sessionID,
                  model: resolved,
                  agent,
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain, Effect.provideService(InstanceRef, ctx)),
            { signal: ctrl.signal },
          )

          await pending.request
          ctrl.abort()

          await Promise.race([pending.responseCanceled, timeout(500)])
          const exit = await run
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          }
          await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
        },
      })

      // 用户 abort 已先于 25ms progress expiry，之后不能再出现 SSE_READ_TIMEOUT 诊断。
      await Bun.sleep(100)
      const events = providerFetchEvents(await Bun.file(logFile).text())
      expect(events.some((event) => event.phase === "sse.timeout")).toBe(false)
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            permission: [{ permission: "question", pattern: "*", action: "allow" }],
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {
              question: tool({
                description: "Ask a question",
                inputSchema: z.object({}),
                execute: async () => ({ output: "" }),
              }),
            },
          },
          ctx,
        )

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: configModel(model),
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
          ctx,
        )

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      },
    })
  })

  test("accepts user image attachments as data URLs for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-data-url",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-data-url",
        delta: "Looks good",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))
    const image = `data:image/png;base64,${Buffer.from(
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
    ).toString("base64")}`

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: configModel(model),
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this image" },
                  {
                    type: "file",
                    mediaType: "image/png",
                    filename: "large-image.png",
                    data: image,
                  },
                ],
              },
            ] as ModelMessage[],
            tools: {},
          },
          ctx,
        )

        const capture = await request
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  })

  test("sends messages API payload for Anthropic Compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "minimax"
    const modelID = "MiniMax-M2.5"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("minimax"), modelID: ModelID.make("MiniMax-M2.5") },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
          ctx,
        )

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends anthropic tool_use blocks with tool_result immediately after them", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("anthropic", "claude-opus-4-6")
    const model = source.model
    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-tool-order",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                name: "Anthropic",
                env: ["ANTHROPIC_API_KEY"],
                npm: "@ai-sdk/anthropic",
                api: "https://api.anthropic.com/v1",
                models: {
                  [model.id]: configModel(model),
                },
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make("anthropic"), ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies MessageV2.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: [],
            messages: await MessageV2.toModelMessages(input as any, resolved),
            tools: {
              read: tool({
                description: "Stub read tool",
                inputSchema: z.object({
                  filePath: z.string(),
                }),
                execute: async () => ({ output: "stub" }),
              }),
              glob: tool({
                description: "Stub glob tool",
                inputSchema: z.object({
                  pattern: z.string(),
                  path: z.string().optional(),
                }),
                execute: async () => ({ output: "stub" }),
              }),
            },
          },
          ctx,
        )

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.messages).toStrictEqual([
          {
            role: "user",
            content: [{ type: "text", text: "Can you check whether there are any PDF files in my home directory?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
              },
              {
                type: "tool_use",
                id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                name: "read",
                input: { filePath: "/root" },
              },
              {
                type: "tool_use",
                id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                name: "glob",
                input: { pattern: "**/*.pdf", path: "/root" },
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                content: "<path>/root</path>",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                content: "No files found",
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
        ])
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id), ctx)
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain(
          {
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
          ctx,
        )

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})

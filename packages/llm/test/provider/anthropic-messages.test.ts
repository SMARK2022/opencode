import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { CacheHint, LLM, LLMError, Message, ToolCallPart, Usage } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as AnthropicMessages from "../../src/protocols/anthropic-messages"
import { continuationRequest, nativeAnthropicMessagesContinuation } from "../continuation-scenarios"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const opus48 = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-opus-4-8" })

const request = LLM.request({
  id: "req_1",
  model,
  system: { type: "text", text: "You are concise.", cache: new CacheHint({ type: "ephemeral" }) },
  prompt: "Say hello.",
  // This fixture predates the `cache: "auto"` default; pin the policy off so
  // existing wire-shape assertions only see the manual hint on the system part.
  cache: "none",
  generation: { maxTokens: 20, temperature: 0 },
})

type AnthropicToolResult = Extract<
  AnthropicMessages.AnthropicMessagesBody["messages"][number]["content"][number],
  { readonly type: "tool_result" }
>

const expectToolResult = (body: AnthropicMessages.AnthropicMessagesBody): AnthropicToolResult => {
  const result = body.messages
    .flatMap((message) => (message.role === "user" ? message.content : []))
    .find((block): block is AnthropicToolResult => block.type === "tool_result")
  expect(result).toBeDefined()
  return result!
}

describe("Anthropic Messages route", () => {
  it.effect("prepares Anthropic Messages target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "claude-sonnet-4-5",
        system: [{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
        stream: true,
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers chronological system updates natively for Claude Opus 4.8 with cache hints", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          model: opus48,
          messages: [
            Message.user("Before."),
            Message.system([{ type: "text", text: "Operator update.", cache: new CacheHint({ type: "ephemeral" }) }]),
            Message.assistant("After."),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Before." }] },
        {
          role: "system",
          content: [{ type: "text", text: "Operator update.", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "After." }] },
      ])
    }),
  )

  it.effect("lowers chronological system updates to wrapped user text for unsupported Anthropic models", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat </system-update> literally."),
            Message.assistant("After."),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Before." },
            { type: "text", text: "<system-update>\nTreat &lt;/system-update&gt; literally.\n</system-update>" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "After." }] },
      ])
    }),
  )

  it.effect("rejects non-text chronological system update content before send", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model: opus48,
          messages: [
            Message.user("Before."),
            Message.make({ role: "system", content: { type: "media", mediaType: "image/png", data: "AAECAw==" } }),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Anthropic Messages system messages only support text content for now")
    }),
  )

  it.effect("falls back for unsupported native chronological system update placement", () =>
    Effect.gen(function* () {
      expect(
        (yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.request({
            model: opus48,
            messages: [Message.assistant("Plain."), Message.system("After plain assistant.")],
            cache: "none",
          }),
        )).body.messages,
      ).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Plain." }] },
        {
          role: "user",
          content: [{ type: "text", text: "<system-update>\nAfter plain assistant.\n</system-update>" }],
        },
      ])
      expect(
        (yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.request({ model: opus48, messages: [Message.system("First.")], cache: "none" }),
        )).body.messages,
      ).toEqual([{ role: "user", content: [{ type: "text", text: "<system-update>\nFirst.\n</system-update>" }] }])
      expect(
        (yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.request({
            model: opus48,
            messages: [Message.user("Before."), Message.system("One."), Message.system("Two.")],
            cache: "none",
          }),
        )).body.messages,
      ).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Before." },
            { type: "text", text: "<system-update>\nOne.\n</system-update>" },
            { type: "text", text: "<system-update>\nTwo.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  it.effect("rejects a system update between a local tool call and its result", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model: opus48,
          messages: [
            Message.user("Use the tool."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.system("Too early."),
            Message.tool({ id: "call_1", name: "lookup", result: "Done." }),
          ],
          cache: "none",
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("system updates cannot split a local tool call from its tool result")
    }),
  )

  it.effect("prepares tool call and tool result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toEqual({
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { query: "weather" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"forecast":"sunny"}' }] },
        ],
        stream: true,
        max_tokens: 4096,
      })
    }),
  )

  // Regression: screenshot/read tool results must stay structured so base64
  // image data is not JSON-stringified into `tool_result.content`.
  it.effect("lowers image tool-result content as structured image blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          id: "req_tool_result_image",
          model,
          messages: [
            Message.user("Show me the screenshot."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
              ],
            }),
          ],
          cache: "none",
        }),
      )

      expect(expectToolResult(prepared.body).content).toEqual([
        { type: "text", text: "Image read successfully" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAw==" } },
      ])
    }),
  )

  it.effect("lowers single-image tool-result content as a structured image block", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          id: "req_tool_result_image_only",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "screenshot",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/jpeg;base64,/9j/AA==", mime: "image/jpeg" }],
            }),
          ],
          cache: "none",
        }),
      )

      expect(expectToolResult(prepared.body).content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AA==" } },
      ])
    }),
  )

  it.effect("rejects non-image media in tool-result content with a clear error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result_unsupported_media",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [{ type: "file", uri: "data:audio/mpeg;base64,AAECAw==", mime: "audio/mpeg" }],
            }),
          ],
          cache: "none",
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Anthropic Messages")
      expect(error.message).toContain("audio/mpeg")
    }),
  )

  it.effect("prepares the composed native continuation request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        continuationRequest({
          id: "req_native_continuation_anthropic",
          model,
          features: nativeAnthropicMessagesContinuation,
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "You are concise. Continue from the provided history." }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is shown here?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAw==" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I inspected the previous turn.", signature: "sig_continuation_1" },
              { type: "text", text: "It shows a small test image." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "Check the weather in Paris before continuing." }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_weather_1", name: "get_weather", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_weather_1", content: '{"temperature":22}' }],
          },
          { role: "assistant", content: [{ type: "text", text: "Paris is 22 degrees." }] },
          { role: "user", content: [{ type: "text", text: "Continue from this conversation in one short sentence." }] },
        ],
      })
      expect(prepared.body.tools).toEqual([expect.objectContaining({ name: "get_weather" })])
    }),
  )

  it.effect("lowers preserved Anthropic reasoning signature metadata", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "thinking", providerMetadata: { anthropic: { signature: "sig_1" } } },
            ]),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "thinking", signature: "sig_1" }] }],
      })
    }),
  )

  it.effect("parses text, reasoning, and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "thinking" } },
        { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig_1" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: "\n\nHuman:" },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.text).toBe("Hello!")
      expect(response.reasoning).toBe("thinking")
      expect(response.usage).toMatchObject({
        inputTokens: 6,
        outputTokens: 2,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: 1,
        totalTokens: 8,
      })
      expect(response.events.find((event) => event.type === "reasoning-end")).toMatchObject({
        providerMetadata: { anthropic: { signature: "sig_1" } },
      })
      expect(response.message.content).toEqual([
        { type: "text", text: "Hello!" },
        { type: "reasoning", text: "thinking", providerMetadata: { anthropic: { signature: "sig_1" } } },
      ])
      expect(response.events.at(-1)).toMatchObject({
        type: "finish",
        reason: "stop",
        providerMetadata: { anthropic: { stopSequence: "\n\nHuman:" } },
      })
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "lookup" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query"' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"weather"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        cacheWriteInputTokens: undefined,
        totalTokens: 6,
        providerMetadata: { anthropic: { input_tokens: 5, output_tokens: 1 } },
      })

      expect(response.toolCalls).toEqual([
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
      ])
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup" },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
        { type: "tool-input-end", id: "call_1", name: "lookup", providerMetadata: undefined },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "tool-calls",
          providerMetadata: undefined,
          usage,
        },
      ])
    }),
  )

  it.effect("emits provider-error events for mid-stream provider errors", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(sseEvents({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
        ),
      )

      // Prefix the error type so consumers can distinguish overloads, rate
      // limits, and quota errors without parsing the message string.
      expect(response.events).toEqual([{ type: "provider-error", message: "overloaded_error: Overloaded" }])
    }),
  )

  it.effect("classifies prompt-too-long provider errors", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens" },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "invalid_request_error: prompt is too long: 210000 tokens",
          classification: "context-overflow",
        },
      ])
    }),
  )

  it.effect("falls back to error type when no message is present", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", error: { type: "overloaded_error", message: "" } }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "overloaded_error" }])
    }),
  )

  it.effect("falls back to a stable default when error payload is absent", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "Anthropic Messages stream error" }])
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )

  it.effect("decodes server_tool_use + web_search_tool_result as provider-executed events", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "srvtoolu_abc", name: "web_search" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query":"effect 4"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_abc",
            content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
          },
        },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Found it." } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "web_search", description: "Web search", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      const toolCall = response.events.find((event) => event.type === "tool-call")
      expect(toolCall).toEqual({
        type: "tool-call",
        id: "srvtoolu_abc",
        name: "web_search",
        input: { query: "effect 4" },
        providerExecuted: true,
      })
      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toEqual({
        type: "tool-result",
        id: "srvtoolu_abc",
        name: "web_search",
        result: { type: "json", value: [{ type: "web_search_result", url: "https://example.com", title: "Example" }] },
        providerExecuted: true,
        providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
      })
      expect(response.text).toBe("Found it.")
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect("decodes web_search_tool_result_error as provider-executed error result", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "srvtoolu_x", name: "web_search" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"q"}' } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_x",
            content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
          },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "web_search", description: "Web search", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toMatchObject({
        type: "tool-result",
        id: "srvtoolu_x",
        name: "web_search",
        result: { type: "error" },
        providerExecuted: true,
      })
    }),
  )

  it.effect("round-trips provider-executed assistant content into server tool blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_round_trip",
          model,
          messages: [
            Message.user("Search for something."),
            Message.assistant([
              {
                type: "tool-call",
                id: "srvtoolu_abc",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
              },
              {
                type: "tool-result",
                id: "srvtoolu_abc",
                name: "web_search",
                result: { type: "json", value: [{ url: "https://example.com" }] },
                providerExecuted: true,
              },
              { type: "text", text: "Found it." },
            ]),
            Message.user("Thanks."),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ type: "text", text: "Search for something." }] },
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srvtoolu_abc", name: "web_search", input: { query: "effect 4" } },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_abc",
                content: [{ url: "https://example.com" }],
              },
              { type: "text", text: "Found it." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "Thanks." }] },
        ],
      })
    }),
  )

  it.effect("rejects round-trip for unknown server tool names", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_unknown_server_tool",
          model,
          messages: [
            Message.assistant([
              {
                type: "tool-result",
                id: "srvtoolu_abc",
                name: "future_server_tool",
                result: { type: "json", value: {} },
                providerExecuted: true,
              },
            ]),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("future_server_tool")
    }),
  )

  it.effect("continues a conversation with user image content", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_media",
          model,
          messages: [
            Message.user([
              { type: "text", text: "What is in this image?" },
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
            ]),
          ],
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(yield* Effect.promise(() => web.json())).toMatchObject({
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "What is in this image?" },
                      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAw==" } },
                    ],
                  },
                ],
              })
              return input.respond(
                sseEvents(
                  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "An image." } },
                  { type: "content_block_stop", index: 0 },
                  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
                  { type: "message_stop" },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("An image.")
    }),
  )

  it.effect("maps ttlSeconds >= 3600 to cache_control ttl: '1h'", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          system: { type: "text", text: "system", cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }) },
          prompt: "hi",
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
      })
    }),
  )

  it.effect("emits cache_control on tool definitions and tool-result blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          tools: [
            {
              name: "lookup",
              description: "lookup tool",
              inputSchema: { type: "object", properties: {} },
              cache: new CacheHint({ type: "ephemeral" }),
            },
          ],
          messages: [
            Message.user("What's the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "lookup",
              result: { temp: 72 },
              cache: new CacheHint({ type: "ephemeral" }),
            }),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "lookup", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup" }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", cache_control: { type: "ephemeral" } }],
          },
        ],
      })
    }),
  )

  it.effect("drops cache_control breakpoints past the 4-per-request cap", () =>
    Effect.gen(function* () {
      const hint = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          system: [
            { type: "text", text: "a", cache: hint },
            { type: "text", text: "b", cache: hint },
            { type: "text", text: "c", cache: hint },
            { type: "text", text: "d", cache: hint },
            { type: "text", text: "e", cache: hint },
            { type: "text", text: "f", cache: hint },
          ],
          prompt: "hi",
        }),
      )

      const system = (prepared.body as { system: Array<{ cache_control?: unknown }> }).system
      const marked = system.filter((part) => part.cache_control !== undefined)
      expect(marked).toHaveLength(4)
      expect(system[4]?.cache_control).toBeUndefined()
      expect(system[5]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("spends breakpoint budget on tools before system before messages", () =>
    Effect.gen(function* () {
      const hint = new CacheHint({ type: "ephemeral" })
      const input = LLM.request({
          model,
          tools: [
            {
              name: "t1",
              description: "t1",
              inputSchema: { type: "object", properties: {} },
              cache: hint,
            },
            {
              name: "t2",
              description: "t2",
              inputSchema: { type: "object", properties: {} },
              cache: hint,
            },
            {
              name: "t3",
              description: "t3",
              inputSchema: { type: "object", properties: {} },
              cache: hint,
            },
            {
              name: "t4",
              description: "t4",
              inputSchema: { type: "object", properties: {} },
              cache: hint,
            },
          ],
          system: [{ type: "text", text: "system-tail", cache: hint }],
          messages: [Message.user([{ type: "text", text: "message-tail", cache: hint }])],
        })
      const prepared = yield* LLMClient.prepare(input)

      const body = prepared.body as {
        tools: Array<{ cache_control?: unknown }>
        system: Array<{ cache_control?: unknown }>
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.tools.every((t) => t.cache_control !== undefined)).toBe(true)
      expect(body.system[0]?.cache_control).toBeUndefined()
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()

      // 复用同一真实请求，仅替换 provider；不能重造缓存输入或绕过原生 prepare owner。
      const claude = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(input, { model: model.route.with({ provider: "claudecode" }).model({ id: model.id }) }),
      )
      // 独立列出四个工具名，确保身份预算不会让最后两个上游标记悄然丢失。
      expect(claude.body.tools?.filter((tool) => tool.cache_control !== undefined).map((tool) => tool.name)).toEqual(["t1", "t2", "t3", "t4"])
      // 四名额已由工具用完；system 与 history 保持原有裁剪，身份不额外发出第五个标记。
      expect(claude.body.system?.filter((block) => block.cache_control !== undefined)).toEqual([])
      expect(claude.body.messages.every((message) => message.content.every((block) => !("cache_control" in block) || block.cache_control === undefined))).toBe(true)
      // 24 只恢复计费首块，上游 system-tail 与四个工具缓存保持原有顺序和预算。
      expect(claude.body.system?.map((block) => block.text)).toEqual([
        expect.stringMatching(/^x-anthropic-billing-header: cc_version=2\.1\.117\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/),
        "system-tail",
      ])

      // 首次接纳必须在13成立：缺省才 enabled，普通 Anthropic 不共享专用默认。
      expect(claude.body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
      // 原生请求头也必须真正发出 redact；保持同一 prepare 输入和 disabled/adaptive 验证。
      const wire = yield* AnthropicMessages.route.prepareTransport(claude.body, LLM.updateRequest(input, { model: claude.model }))
      const web = yield* HttpClientRequest.toWeb(wire.request).pipe(Effect.orDie)
      expect(web.headers.get("anthropic-beta")).toContain("redact-thinking-2026-02-12")
      expect(prepared.body).toHaveProperty("thinking", undefined)
      for (const thinking of [
        { type: "disabled" },
        { type: "adaptive" },
        { type: "adaptive", display: "summarized" },
        { type: "adaptive", display: "omitted" },
        { type: "enabled", budget_tokens: 1024 },
      ] as const) {
        // 同一真实 prepare/Schema 路径比较独立输入，不能靠后续15或只检查原始 options 自证。
        const explicit = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.updateRequest(input, { model: claude.model, providerOptions: { anthropic: { thinking } } }),
        )
        expect(explicit.body.thinking).toEqual(thinking)
      }
    }),
  )
  it.effect("preserves raw ClaudeCode system and fixed zero CCH on the wire", () =>
    Effect.forEach([undefined, "2.1.200"], (version) => Effect.gen(function* () {
      const route = AnthropicMessages.route.with({ provider: "claudecode" })
      // 原始 5m/1h 显式 TTL 与 0/3/4 个工具标记组合，均经过真实 Schema/prepare。
      for (const raw of ["原始字符串", [
        { type: "text", text: "原始数组", cache_control: { type: "ephemeral", ttl: "5m" }, source: "retained" },
        { type: "text", text: "第二块", cache_control: { type: "ephemeral", ttl: "1h" }, source: "second" },
      ]]) {
        for (const count of [0, 3, 4]) {
          const input = LLM.request({ model: route.model({ id: "claude-sonnet-4-5" }), cache: "none",
            system: "Session system", messages: [Message.user([{ type: "text", text: "abcdefghijklmnopqrstuv", cache: new CacheHint({ type: "ephemeral" }) }])],
            // 四工具的优先级在所有 system 之前，history 只能领取 system 之后的剩余预算。
            tools: ["t1", "t2", "t3", "t4"].slice(0, count).map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, cache: new CacheHint({ type: "ephemeral" }) })),
            providerOptions: { anthropic: { version, system: raw, metadata: { retained: "yes" }, thinking: { type: "disabled" }, output_config: { effort: "high" } } },
            http: { body: { extra: "中文 cch=00000;" } },
          })
          const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(input)
          // 手工列出原始块预期，额外属性和缓存标记不能被 typed 编码剥离。
          expect(prepared.body.system?.slice(1)).toEqual(typeof raw === "string"
            ? [{ type: "text", text: "Session system" }, { type: "text", text: "原始字符串" }]
            : [{ type: "text", text: "Session system" },
              { type: "text", text: "原始数组", cache_control: count < 4 ? { type: "ephemeral", ttl: "5m" } : undefined, source: "retained" },
              { type: "text", text: "第二块", cache_control: count < 3 ? { type: "ephemeral", ttl: "1h" } : undefined, source: "second" },
            ])
          // 显式 raw 标记必须先消耗预算，不能先给 history 标记再凑数删 system。
          expect(prepared.body.messages[0]?.content[0]?.cache_control).toEqual(count === 0 || (count === 3 && typeof raw === "string") ? { type: "ephemeral" } : undefined)
          expect(prepared.body.system?.[0]?.cache_control).toBeUndefined()
          expect(prepared.body.metadata).toMatchObject({ retained: "yes" })
          expect(prepared.body.thinking).toEqual({ type: "disabled" })
          expect(prepared.body.output_config).toEqual({ effort: "high" })
          expect(prepared.body.tools?.map((tool) => tool.name)).toEqual([...(["t1", "t2", "t3", "t4"].slice(0, count)), "Read"])
          expect(prepared.body.tools?.filter((tool) => tool.cache_control !== undefined)).toHaveLength(count)
          const wire = yield* route.prepareTransport(prepared.body, input)
          const web = yield* HttpClientRequest.toWeb(wire.request).pipe(Effect.orDie)
          const text = yield* Effect.promise(() => web.text())
          // 固定样本的采样字符为 e/h/u；预期输入独立于生产采样代码。
          const fp = createHash("sha256").update(`59cf53e54c78ehu${version ?? "2.1.117"}`).digest("hex").slice(0, 3)
          const prefix = `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=${version ?? "2.1.117"}.${fp}; cc_entrypoint=cli; cch=`
          // 断言真实发包前缀固定五位零；raw/cache/metadata 的既有矩阵继续执行。
          expect(text.startsWith(`${prefix}00000;`)).toBe(true)
          expect(text).toContain("中文 cch=00000;")
          expect(text).not.toContain("You are Claude Code")
          expect(web.headers.get("anthropic-beta")).toContain("redact-thinking-2026-02-12")
          expect(web.headers.get("user-agent")).toBe(`claude-cli/${version ?? "2.1.117"} (external, cli)`)
          expect(text).not.toContain('"version":')
        }
      }
    })),
  )
})

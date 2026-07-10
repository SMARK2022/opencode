import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Token } from "@opencode-ai/core/util/token"
import { createXai } from "@ai-sdk/xai"
import { APICallError, generateText } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"

import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

// [local-smark] fromError 透传测试：已分类的 APIError 实例不应被降级为 UnknownError。
// 触发场景：processor.ts finish-step 检测到 provider 空完成时直接抛出 APIError，
// fromError 必须保持其分类（name=APIError, isRetryable=true），否则 retry 机制无法识别。
describe("session.message-v2.fromError APIError passthrough", () => {
  test("passes through already-classified APIError without degrading to Unknown", () => {
    const apiError = new SessionV1.APIError({
      message: "Provider returned empty completion",
      isRetryable: true,
    })
    const result = MessageV2.fromError(apiError, { providerID })

    // 必须保持 APIError 分类，不能被降级为 UnknownError
    expect(result.name).toBe("APIError")
    // isRetryable 必须保留，否则 retry 机制不会重试
    expect((result.data as { isRetryable: boolean }).isRetryable).toBe(true)
  })

  test("passes through APIError with metadata intact", () => {
    const apiError = new SessionV1.APIError({
      message: "Provider returned empty completion (finish_reason: other)",
      isRetryable: true,
      metadata: { finishReason: "other" },
    })
    const result = MessageV2.fromError(apiError, { providerID })

    expect(result.name).toBe("APIError")
    expect((result.data as { message: string }).message).toBe(
      "Provider returned empty completion (finish_reason: other)",
    )
    expect((result.data as { metadata: Record<string, string> }).metadata.finishReason).toBe("other")
  })
})
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: SessionV1.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): SessionV1.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

describe("session.message-v2.toModelMessage", () => {

  // [local-smark] 新 generic interrupted 记录携带 executionElapsedMs marker：
  // 模型回放时追加 user_abort + elapsed_ms Notice，使模型能看到取消原因和耗时
  test("appends abort notice for new generic interrupted with elapsed marker", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const partialOutput = "partial result line"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/tmp/test" },
              error: "Tool execution aborted",
              // 新记录：server 写入了 executionElapsedMs
              metadata: { interrupted: true, executionElapsedMs: 152744, output: partialOutput },
              time: { start: 0, end: 152744 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const toolResult = result[2]?.content?.[0] as { type: string; output?: { type: string; value: string } }
    // 有 partial output 时走 output-available，输出末尾追加 abort Notice
    expect(toolResult.output!.type).toBe("text")
    expect(toolResult.output!.value).toContain(partialOutput)
    expect(toolResult.output!.value).toContain('reason="user_abort"')
    expect(toolResult.output!.value).toContain('elapsed_ms="152744"')
    expect(toolResult.output!.value).toContain('source="tool"')
  })

  // [local-smark] 无 partial output 的新 interrupted 记录：errorText 后追加 abort Notice
  test("appends abort notice for new generic interrupted without partial output", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/tmp/test" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, executionElapsedMs: 5000 },
              time: { start: 0, end: 5000 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const toolResult = result[2]?.content?.[0] as { type: string; output?: { type: string; value: string } }
    expect(toolResult.output!.type).toBe("error-text")
    expect(toolResult.output!.value).toContain("Tool execution aborted")
    expect(toolResult.output!.value).toContain('reason="user_abort"')
    expect(toolResult.output!.value).toContain('elapsed_ms="5000"')
  })

  // [local-smark] 旧记录无 executionElapsedMs：保持原样，不追溯伪造 elapsed
  test("old interrupted without marker stays unchanged", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = "old partial"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/tmp/test" },
              error: "Tool execution aborted",
              // 旧记录：只有 interrupted=true，没有 executionElapsedMs
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const toolResult = result[2]?.content?.[0] as { type: string; output?: { type: string; value: string } }
    // 旧记录不追加 abort Notice
    expect(toolResult.output!.value).toBe(output)
    expect(toolResult.output!.value).not.toContain("opencode_notice")
  })

  // [local-smark] NaN/Infinity/负值 marker 被忽略，不输出畸形属性
  test("invalid elapsed marker is ignored", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    for (const badValue of [NaN, Infinity, -1, "abc"]) {
      const input: MessageV2.WithParts[] = [
        {
          info: userInfo(userID),
          parts: [{ ...basePart(userID, "u1"), type: "text", text: "run" }] as MessageV2.Part[],
        },
        {
          info: assistantInfo(assistantID, userID),
          parts: [
            {
              ...basePart(assistantID, "a1"),
              type: "tool",
              callID: "call-1",
              tool: "read",
              state: {
                status: "error",
                input: { filePath: "/tmp/test" },
                error: "Tool execution aborted",
                metadata: { interrupted: true, executionElapsedMs: badValue as number },
                time: { start: 0, end: 1 },
              },
            },
          ] as MessageV2.Part[],
        },
      ]
      const result = await MessageV2.toModelMessages(input, model)
      const toolResult = result[2]?.content?.[0] as { type: string; output?: { type: string; value: string } }
      expect(toolResult.output!.value).toBe("Tool execution aborted")
    }
  })
  test("filters out messages with no parts", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
            metadata: { kind: "compaction_evidence_handoff", version: 1 },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "i".repeat(4000),
            ignored: true,
          },
          { ...basePart(messageID, "file-text"), type: "text", synthetic: true, text: "f".repeat(800) },
          { ...basePart(messageID, "editor"), type: "text", synthetic: true, text: "e".repeat(800) },
          { ...basePart(messageID, "mcp"), type: "text", synthetic: true, text: "m".repeat(800) },
          { ...basePart(messageID, "data-text"), type: "file", mime: "text/plain", url: `data:text/plain;base64,${"x".repeat(800)}` },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as SessionV1.Part[],
      },
    ]

    const messages = await MessageV2.toModelMessages(input, model)
    expect(messages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "f".repeat(800) },
          { type: "text", text: "e".repeat(800) },
          { type: "text", text: "m".repeat(800) },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
    expect(Token.estimateRequest({ system: [], messages, tools: [] }, [])).toEqual({ input: 697, bodyChars: 2789, confirmed: false })
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderV2.ID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("sends tool-result images to xai responses as input_image", async () => {
    const xaiModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("grok-4.7"),
      providerID: ProviderV2.ID.make("xai"),
      api: {
        id: "grok-4.7",
        url: "https://api.x.ai/v1",
        npm: "@ai-sdk/xai",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
        },
      },
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    const userID = "m-user-xai"
    const assistantID = "m-assistant-xai"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-xai"),
            type: "text",
            text: "describe the diagram",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-xai"),
            type: "tool",
            callID: "call-xai-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/diagram.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-xai-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "diagram.png",
                  url: `data:image/png;base64,${png}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const bodies: Record<string, unknown>[] = []
    const xai = createXai({
      apiKey: "test",
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(await new Request(url, init).json())
          return new Response("{}", { status: 400 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    await generateText({
      model: xai.responses(xaiModel.api.id),
      messages: ProviderTransform.message(await MessageV2.toModelMessages(input, xaiModel), xaiModel, {}),
      providerOptions: { xai: { promptCacheKey: "session", reasoningEffort: "xhigh" } },
      maxRetries: 0,
    }).catch(() => undefined)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].prompt_cache_key).toBe("session")
    expect(bodies[0].reasoning).toEqual({ effort: "xhigh" })
    expect(bodies[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-xai-1",
      output: [
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: `data:image/png;base64,${png}` },
      ],
    })
  })

  test("drops tool-result images xai rejects but keeps png and webp", async () => {
    const xaiModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("grok-4.7"),
      providerID: ProviderV2.ID.make("xai"),
      api: {
        id: "grok-4.7",
        url: "https://api.x.ai/v1",
        npm: "@ai-sdk/xai",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
        },
      },
    }
    const images = [
      { mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
      { mime: "image/gif", data: Buffer.from("GIF89a").toString("base64") },
      { mime: "image/webp", data: Buffer.from("RIFFWEBP").toString("base64") },
    ]
    const userID = "m-user-xai-gif"
    const assistantID = "m-assistant-xai-gif"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-xai-gif"),
            type: "text",
            text: "describe the images",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-xai-gif"),
            type: "tool",
            callID: "call-xai-gif",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/images" },
              output: "Images read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: images.map((image, index) => ({
                ...basePart(assistantID, `file-xai-gif-${index}`),
                type: "file" as const,
                mime: image.mime,
                filename: `image-${index}`,
                url: `data:${image.mime};base64,${image.data}`,
              })),
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const bodies: Record<string, unknown>[] = []
    const xai = createXai({
      apiKey: "test",
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(await new Request(url, init).json())
          return new Response("{}", { status: 400 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    await generateText({
      model: xai.responses(xaiModel.api.id),
      messages: ProviderTransform.message(await MessageV2.toModelMessages(input, xaiModel), xaiModel, {}),
      maxRetries: 0,
    }).catch(() => undefined)

    expect(bodies).toHaveLength(1)
    expect(bodies[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-xai-gif",
      output: [
        { type: "input_text", text: "Images read successfully" },
        { type: "input_image", image_url: `data:image/png;base64,${images[0].data}` },
        { type: "input_image", image_url: `data:image/webp;base64,${images[2].data}` },
      ],
    })
    expect(JSON.stringify(bodies[0])).not.toContain("image/gif")
  })

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderV2.ID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "example.pdf",
            data: `data:application/pdf;base64,${pdf}`,
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "text", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: '<opencode_notice type="compaction_cleared" source="tool_output" reason="old_result_pruned" />',
            },
          },
        ],
      },
    ])
  })

  // head+tail 双向截断：tool 工具层截断 notice 位于输出末尾（head 方向），
  // shell 工具层截断 notice 位于输出开头（tail 方向）。旧的单边 head 截断会把
  // 末尾的 tool notice 整段丢弃，导致模型压缩后丢失恢复文件路径。这里改用
  // head+tail 同时保留两端，并断言中间被省略的字符数。
  test("truncates tool output with head+tail when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // head=2 tail=2：10 字符输入，省略中间 6 字符，两端各保 2 字符
    expect(await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 2, tail: 2 } })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "ab\n[... compaction truncated 6 chars ...]\nij",
    // #328：head/tail 用例族——每个用例独立构造超长输出，避免共享 fixture 掩盖单侧回归。
    // #328：测试用独立的小型对称预算（如 2/2、50/200）——用 head/tail 两段内容断言锁定方向，不依赖生产常量本身。
            },
          },
        ],
      },
    ])
  })
  // 等长边界：输入恰好等于 head+tail 时不应触发截断，也不应插入 marker
  test("does not truncate when text fits within head+tail budget", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcd",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // 4 字符输入恰好等于 head+tail=2+2，原样返回，无任何 marker
    expect(await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 2, tail: 2 } })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "abcd",
            },
          },
        ],
      },
    ])
  })

  // 兼容回归：标题生成 / decide / 正常 prompt / estimate 路径都不传
  // toolOutputTruncation，此时必须原样返回，不能因 undefined 触发 NaN 污染。
  test("passes tool output through untouched when no truncation option is given", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            // 故意使用远超截断阈值的输出，验证不传 option 时绝不截断
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "x".repeat(10_000),
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    // user=0, assistant=1, tool-result=2
    const toolResult = result[2]!.content[0] as { type: string; output: { type: string; value: string } }
    expect(toolResult.output.value).toBe("x".repeat(10_000))
  })

  // 行为复现：tool 工具层的截断 notice 在输出末尾（head 方向），必须被 tail
  // 段完整保留。这是本次修复的核心目标——旧实现从头部截断会丢掉末尾 notice
  // 中的恢复文件路径。
  test("preserves tool-truncation notice at tail via head+tail truncation", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    // 模拟 tool.ts 截断后的真实形态：preview + "\n\n" + notice(path 在末尾)
    const noticePath = "/data/tool-output/tool_abc123"
    const notice = `<opencode_notice type="output_truncated" source="tool" total="500L/40000B" shown="head 1000L/16000B" path="${noticePath}" guidance="use grep on path first" />`
    const output = "PREVIEW_LINE\n".repeat(100) + "\n\n" + notice

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/some/file" },
              output,
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // head=50 tail=200：tail 段必须完整含 notice 与 path 属性
    const result = await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 50, tail: 200 } })
    // user=0, assistant=1, tool-result=2
    const toolResult = result[2]!.content[0] as { type: string; output: { type: string; value: string } }
    expect(toolResult.output.value).toContain(noticePath)
    expect(toolResult.output.value).toContain(notice)
    expect(toolResult.output.value).toContain("[... compaction truncated")
  })

  // 行为复现：shell 工具层 notice 在输出开头（tail 方向），必须被 head 段保留。
  test("preserves shell-truncation notice at head via head+tail truncation", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    // 模拟 shell.ts 截断后的真实形态：notice(path 在开头) + "\n\n" + output + 末尾 execution notice
    const noticePath = "/data/tool-output/tool_shell456"
    const truncNotice = `<opencode_notice type="output_truncated" source="shell" total="800L/60000B" shown="tail 1000L/16000B" path="${noticePath}" guidance="use grep on path first" />`
    const execNotice = '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="1" />'
    const output = truncNotice + "\n\n" + "TAIL_LINE\n".repeat(100) + "\n\n" + execNotice

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output,
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // head=200 tail=120：head 段保 shell 截断 notice 的 path；
    // tail=120 足以容纳末尾 execution notice（约 90 字符），tail 段保 execution notice
    const result = await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 200, tail: 120 } })
    // user=0, assistant=1, tool-result=2
    const toolResult = result[2]!.content[0] as { type: string; output: { type: string; value: string } }
    expect(toolResult.output.value).toContain(noticePath)
    expect(toolResult.output.value).toContain(execNotice)
    expect(toolResult.output.value).toContain("[... compaction truncated")
  })

  // 退化边界：head=0 时只保留尾部，marker 在开头不含多余空行；
  // tail=0 时只保留头部，marker 在末尾不含多余空行。真实调用方恒传 400/2000，
  // 这两个用例闭合单边退化分支的防御性代码验证。
  test("degrades to tail-only when head is 0", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // head=0 tail=3：只保留末尾 3 字符 "hij"，marker 在开头，不应有前导空行
    expect(await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 0, tail: 3 } })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[... compaction truncated 7 chars ...]\nhij" },
          },
        ],
      },
    ])
  })

  test("degrades to head-only when tail is 0", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "run tool" }] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    // head=3 tail=0：只保留开头 3 字符 "abc"，marker 在末尾，不应有尾随空行
    expect(await MessageV2.toModelMessages(input, model, { toolOutputTruncation: { head: 3, tail: 0 } })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "abc\n[... compaction truncated 7 chars]" },
          },
        ],
      },
    ])
  })


  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      '<opencode_notice type="execution" source="shell" severity="warning" reason="user_abort" />',
    ].join("\n")

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new SessionV1.APIError({ message: "boom", isRetryable: true }).toObject() as SessionV1.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new SessionV1.AbortedError({
      message: "aborted",
    }).toObject() as SessionV1.Assistant["error"]

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderV2.ID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under 'bedrock' namespace", async () => {
    // Bedrock signed reasoning is preserved as reasoning metadata, but unlike the
    // direct Anthropic path we do not preserve empty text separators for Bedrock.
    const assistantID = "m-assistant-bedrock"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "tokens in request more than max tokens allowed",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect((result as SessionV1.APIError).data.isRetryable).toBe(true)
    expect((result as SessionV1.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: SessionV1.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as SessionV1.Part[],
  }

  const overflowAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const compactionUser: SessionV1.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as SessionV1.Part[],
  }

  const summaryAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const continueUser: SessionV1.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as SessionV1.Part[],
  }

  test("selects latest messages by creation time when IDs are nonmonotonic", () => {
    const oldUser = { ...userInfo("msg_z_user"), time: { created: 100 } }
    const newUser = { ...userInfo("msg_a_user"), time: { created: 200 } }
    const oldAssistant = {
      ...assistantInfo("msg_z_assistant", oldUser.id),
      time: { created: 300 },
      finish: "stop",
    } as SessionV1.Assistant
    const newAssistant = {
      ...assistantInfo("msg_a_assistant", newUser.id),
      time: { created: 400 },
      finish: "stop",
    } as SessionV1.Assistant

    const state = MessageV2.latest([
      { info: newAssistant, parts: [] },
      { info: oldUser, parts: [] },
      { info: oldAssistant, parts: [] },
      { info: newUser, parts: [] },
    ])

    expect(state.user?.id).toBe(newUser.id)
    expect(state.assistant?.id).toBe(newAssistant.id)
    expect(state.finished?.id).toBe(newAssistant.id)
  })

  test("uses ID as a deterministic tie-breaker for equal creation times", () => {
    const lower = { ...userInfo("msg_a_user"), time: { created: 100 } }
    const higher = { ...userInfo("msg_z_user"), time: { created: 100 } }

    const state = MessageV2.latest([
      { info: higher, parts: [] },
      { info: lower, parts: [] },
    ])

    expect(state.user?.id).toBe(higher.id)
  })

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary is not replayed as a task", () => {
    const newCompactionUser: SessionV1.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    // #269：compaction 不再是可重放 task（#242）——tasks 只剩 subtask，故期望空列表
    expect(state.tasks).toEqual([])
  })

  test("selects compaction and subtask work after the finished boundary by creation time", () => {
    const finished = {
      ...assistantInfo("msg_z_finished", "msg_parent"),
      time: { created: 200 },
      finish: "stop",
    } as SessionV1.Assistant
    const oldTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_z_old"), time: { created: 100 } },
      parts: [{ ...basePart("msg_z_old", "old"), type: "compaction", auto: true }] as SessionV1.Part[],
    }
    const newTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_a_new"), time: { created: 300 } },
      parts: [
        {
          ...basePart("msg_a_new", "new"),
          type: "subtask",
          prompt: "inspect",
          description: "inspect ordering",
          agent: "general",
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([newTask, { info: finished, parts: [] }, oldTask])

    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "subtask", prompt: "inspect" })
  })
})

describe("session.message-v2.filterCompacted", () => {
  // #204：ID 刻意单调递增，镜像生产环境 MessageID.ascending() 的持久化顺序，复现真实压缩 transcript 失败模式
  const OLD_USER = MessageID.make("msg_filter_001")
  const OLD_ASSISTANT = MessageID.make("msg_filter_002")
  const TAIL_USER = MessageID.make("msg_filter_003")
  const TAIL_ASSISTANT = MessageID.make("msg_filter_004")
  const COMPACTION_USER = MessageID.make("msg_filter_005")
  const SUMMARY_ASSISTANT = MessageID.make("msg_filter_006")
  const CONTINUE_USER = MessageID.make("msg_filter_007")

  // #204：旧历史用户消息，应被 summary 排除在压缩窗口之外
  const oldUser: SessionV1.WithParts = {
    info: userInfo(OLD_USER),
    parts: [{ ...basePart(OLD_USER, "filter-old-user"), type: "text", text: "old request" }] as SessionV1.Part[],
  }

  // #204：旧历史 assistant 回复，与 oldUser 同属被 summary 排除的历史
  const oldAssistant: SessionV1.WithParts = {
    info: assistantInfo(OLD_ASSISTANT, OLD_USER),
    parts: [{ ...basePart(OLD_ASSISTANT, "filter-old-assistant"), type: "text", text: "old answer" }] as SessionV1.Part[],
  }

  // #204：retained tail——压缩边界保留的最近轮次，须在窗口内可见以维持上下文连续
  const tailUser: SessionV1.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "filter-tail-user"), type: "text", text: "retained request" }] as SessionV1.Part[],
  }

  const tailAssistant: SessionV1.WithParts = {
    info: assistantInfo(TAIL_ASSISTANT, TAIL_USER),
    parts: [
      { ...basePart(TAIL_ASSISTANT, "filter-tail-assistant"), type: "text", text: "retained answer" },
    ] as SessionV1.Part[],
  }

  // #204：compaction user 携带 tail_start_id 指向 retained tail 起点
  const compactionUser: SessionV1.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "filter-compaction"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as SessionV1.Part[],
  }

  // #204：summary assistant 标记 summary=true 且 finish，使其 parent compaction 进入 completed
  const summaryAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
    } as SessionV1.Assistant,
    parts: [
      { ...basePart(SUMMARY_ASSISTANT, "filter-summary"), type: "text", text: "summary of old work" },
    ] as SessionV1.Part[],
  }

  // #204：summary 之后的续作用户消息，须出现在压缩窗口末尾
  const continueUser: SessionV1.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      { ...basePart(CONTINUE_USER, "filter-continue"), type: "text", text: "continue from summary" },
    ] as SessionV1.Part[],
  }

  // #204：期望窗口顺序——compaction、summary、retained tail、continue（旧历史被排除）
  const expected = [COMPACTION_USER, SUMMARY_ASSISTANT, TAIL_USER, TAIL_ASSISTANT, CONTINUE_USER]

  // #204：newest-first 输入（流式顺序）须保持压缩窗口不变
  test("keeps the compacted summary and retained tail without reviving older history", () => {
    // #204：输入按 newest-first（continue 在前），与流式 stream 顺序一致
    expect(
      MessageV2.filterCompacted([
        continueUser,
        summaryAssistant,
        compactionUser,
        tailAssistant,
        tailUser,
        oldAssistant,
        oldUser,
      ]).map((message) => message.info.id),
    ).toStrictEqual(expected)
  })

  // #204：按时序输入（最旧在前）经排序归一化后须得到同一窗口——证明输入顺序无关
  test("keeps the same compacted window when callers provide chronological history", () => {
    // #204：输入按时序（old 在前），排序归一化后须与上例同窗口
    expect(
      MessageV2.filterCompacted([
        oldUser,
        oldAssistant,
        tailUser,
        tailAssistant,
        compactionUser,
        summaryAssistant,
        continueUser,
      ]).map((message) => message.info.id),
    ).toStrictEqual(expected)
    // 导入summary的ID可以较小，仍应按创建时间找到同一压缩边界。
    const importedID = MessageID.make("msg_filter_000")
    const importedSummary = {
      ...summaryAssistant,
      info: { ...summaryAssistant.info, id: importedID },
      parts: summaryAssistant.parts.map((part) => ({ ...part, messageID: importedID })),
    }
    const history = [oldUser, oldAssistant, tailUser, tailAssistant, compactionUser, importedSummary, continueUser].map((message, index) => ({
      ...message, info: { ...message.info, time: { ...message.info.time, created: index + 1 } },
    }))
    expect(MessageV2.filterCompacted(history).map((message) => message.info.id)).toStrictEqual([COMPACTION_USER, importedID, TAIL_USER, TAIL_ASSISTANT, CONTINUE_USER])
    expect(MessageV2.filterCompacted(history.toReversed()).map((message) => message.info.id)).toStrictEqual([COMPACTION_USER, importedID, TAIL_USER, TAIL_ASSISTANT, CONTINUE_USER])
  })
})

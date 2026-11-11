import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
// SDK 的定义 schema 用于验证 discovery 原值，避免测试用类型断言假定输出声明存在。
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

// 候选标记只是 transport 后的明确投影策略；不能把多个片段、资源或声明结果猜成 JSON。
test("program projection marks only successful schema-less single text candidates", () => {
  const raw = ' {"items":[1]} '
  const text = { type: "text" as const, text: raw }
  expect(McpCatalog.programResult({ content: [text] })).toMatchObject({ value: raw, rawText: raw })
  expect(
    McpCatalog.programResult({ content: [text, { type: "image", mimeType: "image/png", data: "AAAA" }] }),
  ).toMatchObject({ value: raw, rawText: raw, attachments: [{ mime: "image/png" }] })
  // structuredContent 和明确输出声明继续拥有返回类型，rawText 不能作为逃过 schema 的后门。
  for (const result of [
    { content: [text], structuredContent: { items: [2] } },
    { content: [text], isError: true },
    { content: [text, text] },
    { content: [text, { type: "resource" as const, resource: { uri: "fixture://note", text: "extra" } }] },
    { content: [text, { type: "resource_link" as const, uri: "fixture://note", name: "note" }] },
  ])
    expect(McpCatalog.programResult(result).rawText).toBeUndefined()
  expect(McpCatalog.programResult({ content: [text] }, { type: "object" }).rawText).toBeUndefined()
})

// 真正的 SDK Client 缓存输出 schema；原始 RPC 夹具不能证明声明校验仍先于候选投影。
test("SDK output validation still owns declared results before JSON text projection", async () => {
  const server = new Server({ name: "projection", version: "1.0.0" }, { capabilities: { tools: {} } })
  const outputSchema = { type: "object" as const, properties: { value: { type: "number" } }, required: ["value"] }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["plain", "missing", "invalid", "valid", "failed"].map((name) => ({
      name,
      inputSchema: { type: "object" as const },
      ...(name === "plain" ? {} : { outputSchema }),
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: "text" as const, text: '{"value":1}' }],
    ...(params.name === "invalid" ? { structuredContent: { value: "wrong" } } : {}),
    ...(params.name === "valid" ? { structuredContent: { value: 1 } } : {}),
    ...(params.name === "failed" ? { isError: true } : {}),
  }))
  const client = new Client({ name: "projection-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const definitions = await Effect.runPromise(McpCatalog.defs(client))
    const invoke = async (name: string) => {
      const def = definitions?.find((item) => item.name === name)
      if (!def) throw new Error("Missing fixture definition")
      // discovery 的旧静态投影未列出 outputSchema；用真实 SDK schema 验证整份定义而非断言强转。
      const definition = ToolSchema.parse(def)
      const result = await McpCatalog.callTool({ def: definition, client }, {})
      return McpCatalog.programResult(result, definition.outputSchema)
    }
    // 合法的无声明文本才携带候选标记；不能把 text 中的 JSON 当作声明结构的替代品。
    expect(await invoke("plain")).toMatchObject({ value: '{"value":1}', rawText: '{"value":1}' })
    expect(await invoke("valid")).toEqual({ value: { value: 1 }, attachments: [] })
    // 等待真实 SDK Promise 结算后检查原错误，不依赖 Bun matcher 的同步返回类型。
    // isError 保留业务失败而非尝试解析文本后变成成功，错误出口与直接 MCP 一致。
    for (const [name, message] of [
      ["missing", "structured content"],
      ["invalid", "output schema"],
      ["failed", '{"value":1}'],
    ]) {
      const failure = await invoke(name).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain(message)
    }
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

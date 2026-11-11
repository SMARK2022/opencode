import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CodeModeTool, describeCatalog, type CatalogEntry } from "@/tool/code-mode"
// 线协议调用共享真实环境注册表，测试结束由同一所有者释放。
import { ExecuteEnvironments } from "@/tool/execute-environments"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Layer } from "effect"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const SERVER = "fixtures"
// MCP 连接与解释器环境同寿命，初始化返回后不能提前关闭真实 registry。
const environments = ExecuteEnvironments.makeRegistry()
afterAll(() => Effect.runPromise(environments.close()))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code-mode-int"),
  messageID: MessageID.make("msg_code-mode-int"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode_int",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// Avoid the SDK Client here; other MCP tests mock it process-globally.
class RawJsonRpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(private transport: InMemoryTransport) {}

  async connect() {
    this.transport.onmessage = (message) => {
      const msg = message as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) return
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
    await this.transport.start()
    await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    })
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    void this.transport.send({ jsonrpc: "2.0", id, method, params } as never)
    return result
  }

  listTools() {
    return this.request("tools/list", {})
  }

  callTool(params: { name: string; arguments?: Record<string, unknown> }, _schema?: unknown, _options?: unknown) {
    return this.request("tools/call", params)
  }
}

const TOOL_DEFS: MCPToolDef[] = [
  // 无输出声明的 JSON 文本经真实 wire 进入解释器；媒体附件不能被混进候选字符串。
  {
    name: "json",
    description: "Return JSON text and an image",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_text",
    description: "Greet someone and return the greeting as text",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "add",
    description: "Add two numbers and return the structured sum",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] },
  },
  {
    name: "screenshot",
    description: "Capture a screenshot and return it as an image",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "A tool that always fails",
    inputSchema: { type: "object", properties: {} },
  },
] as MCPToolDef[]

function handleCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    // 保留外层空白以证明 String(value) 来自原文本，而非重新序列化的近似文本。
    case "json":
      return {
        content: [
          { type: "text", text: ' [ {"value":3} ] ' },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      }
    case "get_text":
      return { content: [{ type: "text", text: `hello ${args.name}` }] }
    case "add": {
      const sum = (args.a as number) + (args.b as number)
      return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } }
    }
    case "screenshot":
      return { content: [{ type: "image", data: PNG, mimeType: "image/png" }] }
    case "boom":
      return { content: [{ type: "text", text: "kaboom" }], isError: true }
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true }
  }
}

let tool: Awaited<ReturnType<typeof buildTool>>["tool"]
let description: string

async function buildTool() {
  const server = new Server({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCall(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new RawJsonRpcClient(clientTransport)
  await client.connect()

  // 目录取自传输返回的 tools/list，声明和真实调用共享远端定义，避免测试另造一份目录。
  const listed = (await client.listTools()).tools as MCPToolDef[]
  const mcpTools: Record<string, MCP.McpTool> = {}
  for (const def of listed) {
    mcpTools[McpCatalog.toolName(SERVER, def.name)] = { def, client: client as unknown as Client }
  }

  const layer = Layer.mergeAll(
    // 仅提供明确的夹具 owner；状态分配、续用和关闭仍走生产引擎。
    Layer.succeed(ExecuteEnvironments.Service, {
      use: (sessionID, id, run) => environments.use({ sessionID, directory: "/mcp-fixture" }, id, run),
    }),
    // 本组只隔离磁盘截断，限额仍取生产常量；图片分离和正文投影由真实宿主处理。
    Layer.mock(Truncate.Service, {
      limits: () => Effect.succeed({ maxBytes: Truncate.MAX_BYTES, maxLines: Truncate.MAX_LINES }),
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "primary" as const, options: {}, permission: [] }),
    }),
  )
  const catalog: CatalogEntry[] = Object.entries(mcpTools).map(([id, entry]) => ({
    id, path: [SERVER, entry.def.name], description: entry.def.description ?? "",
    inputSchema: McpCatalog.schemas(entry.def).input, outputSchema: McpCatalog.schemas(entry.def).output,
  }))
  const definition = await Effect.runPromise(CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(layer)))
  return {
    // Session 权限与 child 归属由 session/execute 的真实集成覆盖；本组保留真实 MCP wire/result 回归。
    tool: {
      ...definition,
      execute: (params: { code: string }, ctx: Tool.Context) =>
        definition.execute(params, {
          ...ctx,
          codeMode: {
            catalog,
            signal: ctx.abort,
            begin: () => Effect.void,
            invoke: (id, args) =>
              Effect.gen(function* () {
                const result = yield* Effect.promise(() => McpCatalog.callTool(mcpTools[id], args, ctx.abort))
                // 测试与 SessionTools 一样传递声明，避免夹具误把已声明文本当成候选。
                return {
                  title: id,
                  output: "",
                  metadata: {},
                  program: McpCatalog.programResult(result, mcpTools[id].def.outputSchema),
                }
              }),
          },
        }),
    },
    description: await Effect.runPromise(describeCatalog(catalog)),
  }
}

const run = (code: string) => Effect.runPromise(tool.execute({ code }, ctx))
// 断言真实 MCP 业务值之前先校验 ID 前缀，避免以宽松 contains 丢掉原协议精度。
function scriptOutput(result: { output: string; metadata: { environmentID: string } }) {
  expect(result.metadata.environmentID).toMatch(/^env_/)
  const prefix = `Environment: ${result.metadata.environmentID}\n\n`
  expect(result.output.startsWith(prefix)).toBe(true)
  return result.output.slice(prefix.length)
}

const runFailed = async (code: string) => {
  const exit = await Effect.runPromise(tool.execute({ code }, ctx).pipe(Effect.exit))
  if (Exit.isSuccess(exit)) throw new Error("expected the tool to fail")
  return Cause.squash(exit.cause) as Error
}

beforeAll(async () => {
  const built = await buildTool()
  tool = built.tool
  description = built.description
})

describe("code mode integration (real MCP server)", () => {
  // 真实 MCP 的类型和精确路径经紧凑目录交付，不能靠重写传输 schema 达成展示变化。
  test("the appended catalog inlines compact signatures with real MCP schemas", () => {
    expect(description).toContain("The catalog is complete.")
    expect(description).toContain("- fixtures (5 tools)")
    expect(description).toContain("tools.fixtures.add(input: { a: number; b: number }): Promise<{ sum: number }>")
    expect(description).toContain("tools.fixtures.get_text(input: { name: string }): Promise<unknown>")
    expect(description).toContain("// Add two numbers and return the structured sum")
    expect(description).not.toContain("$codemode")
    expect(description).toContain("## Code Mode tools")
    expect(description).toContain("Other tools shown in the conversation can be called directly.")
    expect(description).not.toContain("total_count")
  })

  test("calls a text tool and receives its text as the native result", async () => {
    const out = await run("const r = await tools.fixtures.get_text({ name: 'world' }); return r")
    expect(scriptOutput(out)).toBe("hello world")
    expect(out.metadata.toolCalls).toEqual([
      { tool: "fixtures.get_text", status: "completed", input: { name: "world" } },
    ])
    expect(out.attachments).toBeUndefined()
  })

  // 真正的传输候选要同时保留可遍历数组、原文与附件，不能只证明某个本地 JSON helper。
  test("schema-less wire JSON exposes data with original text and separate attachments", async () => {
    const out = await run(
      "const value = await tools.fixtures.json({}); return {sum:value.map(item => item.value).reduce((a,b)=>a+b,0), source:String(value), array:Array.isArray(value)}",
    )
    expect(JSON.parse(scriptOutput(out))).toEqual({ sum: 3, source: ' [ {"value":3} ] ', array: true })
    expect(out.attachments).toEqual([{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG}` }])
    // 无参数签名省略空输入的既有回执形状不变；JSON 投影只影响程序返回值。
    expect(out.metadata.toolCalls).toEqual([{ tool: "fixtures.json", status: "completed" }])
  })

  test("exposes structured data natively from a tool with an outputSchema", async () => {
    const out = await run("const r = await tools.fixtures.add({ a: 2, b: 3 }); return r.sum")
    // 远端同时返回文本 5 和对象 { sum: 5 }；脚本读取 sum，能区分结构化优先与误用展示文本。
    expect(scriptOutput(out)).toBe("5")
  })

  test("composes multiple structured calls and returns a plain object", async () => {
    const out = await run(`
      const first = await tools.fixtures.add({ a: 1, b: 2 })
      const second = await tools.fixtures.add({ a: first.sum, b: 10 })
      return { total: second.sum }
    `)
    // 前次远端结果继续参与下一次参数计算，不能以句柄成功代替业务验证。
    expect(JSON.parse(scriptOutput(out))).toEqual({ total: 13 })
    expect(out.metadata.toolCalls).toEqual([
      { tool: "fixtures.add", status: "completed", input: { a: 1, b: 2 } },
      { tool: "fixtures.add", status: "completed", input: { a: 3, b: 10 } },
    ])
  })

  test("an image result becomes an execute attachment and a marker in the sandbox", async () => {
    const out = await run("return await tools.fixtures.screenshot({})")
    // 图片仍由附件通道交付，脚本只接收原有可读占位文本。
    expect(scriptOutput(out)).toBe("[1 image attached to the result]")
    expect(out.attachments).toEqual([{ type: "file", mime: "image/png", url: `data:image/png;base64,${PNG}` }])
  })

  test("image bytes never enter the sandbox or the model-facing output", async () => {
    const out = await run(`
      const shot = await tools.fixtures.screenshot({})
      return { sawMarker: typeof shot === 'string' && shot.includes('attached'), value: shot }
    `)
    // sawMarker 由解释器内的 typeof/includes 算出，证明剥离发生在脚本消费图片结果之前。
    expect(JSON.parse(scriptOutput(out))).toEqual({
      sawMarker: true,
      value: "[1 image attached to the result]",
    })
    expect(scriptOutput(out)).not.toContain(PNG)
    expect(out.attachments).toHaveLength(1)
  })

  test("attachments accumulate even when the program returns something else", async () => {
    const out = await run("await tools.fixtures.screenshot({}); return 'captured'")
    expect(scriptOutput(out)).toBe("captured")
    expect(out.attachments).toHaveLength(1)
  })

  test("runs calls in parallel and accumulates every attachment", async () => {
    const out = await run(`
      const both = await Promise.all([tools.fixtures.screenshot({}), tools.fixtures.screenshot({})])
      return 'two shots: ' + both.length
    `)
    expect(scriptOutput(out)).toBe("two shots: 2")
    // 两次返回的图片字节相同，仍是两个独立调用的附件，不能按内容去重。
    expect(out.attachments).toHaveLength(2)
    expect(out.metadata.toolCalls.map((c) => c.tool)).toEqual(["fixtures.screenshot", "fixtures.screenshot"])
  })

  test("propagates an MCP isError into the program as a catchable error", async () => {
    const out = await run("try { await tools.fixtures.boom({}) } catch (e) { return 'caught: ' + e.message }")
    // 真实 MCP isError 已由 catch 观察，正文无额外警告，失败 child 仍保留在最终 metadata。
    expect(scriptOutput(out)).toBe("caught: kaboom")
    expect(out.metadata.error).toBeUndefined()
    expect(out.metadata.toolCalls).toEqual([{ tool: "fixtures.boom", status: "error" }])
  })

  test("an uncaught MCP error surfaces as a failed execution", async () => {
    const error = await runFailed("await tools.fixtures.boom({}); return 'unreachable'")
    expect(error.message).toContain("kaboom")
  })

  test("console output is captured and appended as a Logs section after the result", async () => {
    const out = await run(`
      console.log("looking up", { name: "world" })
      const r = await tools.fixtures.get_text({ name: "world" })
      console.warn("got", r)
      return r
    `)
    // 日志顺序及格式保持不变，环境行不能吞掉真实 console 输出。
    expect(scriptOutput(out)).toBe('hello world\n\nLogs:\nlooking up {"name":"world"}\n[warn] got hello world')
    expect(out.metadata.error).toBeUndefined()
  })

  test("console output is preserved on the error path", async () => {
    const error = await runFailed(`
      console.log("before the throw")
      await tools.fixtures.boom({})
      return "unreachable"
    `)
    expect(error.message).toContain("kaboom")
    expect(error.message).toContain("Logs:\nbefore the throw")
  })

  test("a program that logs nothing gets no Logs section", async () => {
    const out = await run("return 'quiet'")
    // 无日志时不制造 Logs 段；有日志时继续保留不同级别的原文本。
    expect(scriptOutput(out)).toBe("quiet")
    expect(scriptOutput(out)).not.toContain("Logs:")
  })

  test("console does not consume the tool-call metadata (logging is not a tool call)", async () => {
    const out = await run("console.log('hi'); console.error('bye'); return 'ok'")
    expect(scriptOutput(out)).toBe("ok\n\nLogs:\nhi\n[error] bye")
    expect(out.metadata.toolCalls).toEqual([])
  })

  test("streams real transport progress and returns complete child terminal metadata", async () => {
    // 进度样本与真实替换载荷同形，句柄和模型可见前缀都是必要字段。
    const snapshots: Array<{
      environmentID: string
      output: string
      toolCalls: { tool: string; status: string; input?: Record<string, unknown> }[]
    }> = []
    const recordingCtx: Tool.Context = {
      ...ctx,
      metadata: (val: any) => Effect.sync(() => void snapshots.push(val.metadata)),
    }
    const out = await Effect.runPromise(
      tool.execute({ code: "await tools.fixtures.add({ a: 1, b: 2 }); return 'done'" }, recordingCtx),
    )
    // 实际发送的进度仍带句柄；completed 可被合并，最终结果必须有完整状态。
    expect(scriptOutput(out)).toBe("done")
    expect(snapshots).toContainEqual({
      environmentID: out.metadata.environmentID,
      output: `Environment: ${out.metadata.environmentID}`,
      toolCalls: [{ tool: "fixtures.add", status: "running", input: { a: 1, b: 2 } }],
    })
    expect(out.metadata.toolCalls).toEqual([{ tool: "fixtures.add", status: "completed", input: { a: 1, b: 2 } }])
    // 逐次进度都复用最终句柄，防止真实传输的后续状态更新用缺字段的对象覆盖恢复信息。
    expect(snapshots.every((snapshot) => snapshot.environmentID === out.metadata.environmentID)).toBe(true)
  })
})

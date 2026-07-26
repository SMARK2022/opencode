export * as McpTools from "./tools"

import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ToolDefinition } from "@opencode-ai/llm"
import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { McpRuntime } from "../mcp"
import { PermissionV2 } from "../permission"
import { SystemContext } from "../system-context"
import { Tool } from "../tool/tool"
import { ToolRegistry } from "../tool/registry"
import { Tools } from "../tool/tools"
import { McpConnection } from "./connection"

export interface Interface {
  readonly prepare: () => Effect.Effect<(visibleNames: readonly string[]) => SystemContext.SystemContext>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpTools") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const mcp = yield* McpRuntime.Service
  const tools = yield* Tools.Service
  const permission = yield* PermissionV2.Service
  const owner = yield* Scope.Scope
  const lock = yield* Semaphore.make(1)
  const active = new Map<string, { readonly entry: McpConnection.McpTool; readonly scope: Scope.Closeable }>()
  const resources = resourceTools(mcp, permission)
  let resourceScope: Scope.Closeable | undefined
  return Service.of({
    prepare: Effect.fn("McpTools.prepare")(() => lock.withPermit(Effect.gen(function* () {
      // 观察和注册共用窄锁，较早快照不能在另一Session刷新后反向覆盖新定义。
      const snapshot = yield* mcp.snapshot()
      const changed = Object.entries(snapshot.tools).flatMap(([name, entry]) => {
        const previous = active.get(name)?.entry
        if (previous?.def === entry.def && previous.client === entry.client && previous.timeout === entry.timeout) return []
        return [{ name, entry: { def: entry.def, client: entry.client, timeout: entry.timeout }, tool: adapt(name, entry, permission) }]
      })
      yield* Effect.forEach(changed, item => Tool.validateName(item.name), { discard: true }).pipe(Effect.orDie)
      // 只保护同步的注册交接；SDK请求及权限等待始终可以被调用方取消。
      yield* Effect.uninterruptible(Effect.gen(function* () {
        for (const item of changed) {
          const scope = yield* Scope.fork(owner)
          yield* tools.register({ [item.name]: item.tool }).pipe(
            Scope.provide(scope),
            Effect.onExit(exit => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void),
            Effect.orDie,
          )
          const previous = active.get(item.name)
          active.set(item.name, { entry: item.entry, scope })
          // 新注册先入栈；关闭旧scope仅撤销自己的token，不会移除新定义。
          if (previous) yield* Scope.close(previous.scope, Exit.void)
        }
        for (const [name, previous] of active) {
          if (Object.hasOwn(snapshot.tools, name)) continue
          active.delete(name)
          yield* Scope.close(previous.scope, Exit.void)
        }
        const hasResources = Object.values(snapshot.clients).some(client => !!client.getServerCapabilities()?.resources)
        // 三个资源工具只在真实连接声明resources时存在，不能固定广告不可用能力。
        if (hasResources && !resourceScope) {
          resourceScope = yield* Scope.fork(owner)
          yield* tools.register(resources).pipe(Scope.provide(resourceScope), Effect.orDie)
        }
        if (!hasResources && resourceScope) {
          yield* Scope.close(resourceScope, Exit.void)
          resourceScope = undefined
        }
      }))
      return instructionsContext(snapshot.instructions)
    }))),
  })
}))

export const node = makeLocationNode({
  service: Service, layer,
  deps: [McpRuntime.node, ToolRegistry.toolsNode, PermissionV2.node],
})

const Projection = Schema.Struct({
  structured: Schema.Unknown,
  content: Schema.Array(Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("file"), data: Schema.String, mime: Schema.String, name: Schema.optional(Schema.String) }),
  ])),
})

function adapt(name: string, entry: McpConnection.McpTool, permission: PermissionV2.Interface) {
  const def = entry.def
  const client = entry.client
  const timeout = entry.timeout
  return Tool.make({
    // 仅远端Tool调用视为ambient；下面的resource list/read仍是只读none。
    worktree: "ambient",
    description: def.description ?? "",
    // 对象参数保留原样，完整MCP schema直接用于广告，不经不完整的schema反向转换。
    input: Schema.Record(Schema.String, Schema.Unknown),
    inputSchema: Schema.decodeUnknownSync(ToolDefinition.fields.inputSchema)(structuredClone(def.inputSchema)),
    output: Projection,
    structured: Schema.Unknown,
    toStructuredOutput: ({ output }) => output.structured,
    toModelOutput: ({ output }) => output.content,
    execute: (args, context) => Effect.gen(function* () {
      yield* permission.assert({
        sessionID: context.sessionID, agent: context.agent,
        action: name, resources: ["*"], save: ["*"], metadata: {},
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      }).pipe(Effect.mapError(error => new Tool.Failure({ message: error._tag === "PermissionV2.CorrectedError" ? error.feedback : error.message || error._tag })))
      const result = yield* Effect.tryPromise({
        // 公开名只负责广告/权限；服务器接收未经重命名的原始def.name。
        try: signal => client.callTool({ name: def.name, arguments: args }, CallToolResultSchema, {
          signal, timeout, resetTimeoutOnProgress: true,
          // 回调存在时SDK才发送progress token，保留原调用超时续期语义。
          onprogress() {},
        }),
        catch: error => new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
      })
      if (result.isError) return yield* new Tool.Failure({
        message: result.content.flatMap(item => item.type === "text" ? [item.text] : []).filter(text => text.trim()).join("\n\n") || "MCP tool returned an error",
      })
      return project(result)
    }),
  })
}

function resourceTools(mcp: McpConnection.Interface, permission: PermissionV2.Interface) {
  const authorize = Effect.fnUntraced(function* (context: Tool.Context, server?: string, uri?: string) {
    const clients = yield* mcp.clients()
    const servers = Object.keys(clients).filter(name => !!clients[name].getServerCapabilities()?.resources).toSorted()
    if (server && !servers.includes(server)) return yield* new Tool.Failure({ message: servers.length
      ? `MCP server "${server}" does not support resources. Available resource servers: ${servers.join(", ")}`
      : `MCP server "${server}" does not support resources` })
    const patterns = server ? [`mcp:${server}:${uri ?? "*"}`] : servers.map(name => `mcp:${name}:*`)
    yield* permission.assert({
      sessionID: context.sessionID, agent: context.agent, action: "read", resources: patterns,
      save: server ? [`mcp:${server}:*`] : patterns, metadata: { ...(server ? { server } : {}), ...(uri ? { uri } : {}) },
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    }).pipe(Effect.mapError(error => new Tool.Failure({ message: error._tag === "PermissionV2.CorrectedError" ? error.feedback : error.message || error._tag })))
  })
  const list = (templates: boolean) => Tool.withPermission(Tool.make({
    description: templates
      ? "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template."
      : "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
    input: Schema.Struct({ server: Schema.optional(Schema.String.annotate({ description: templates
      ? "Optional MCP server name. When omitted, lists resource templates from every connected server."
      : "Optional MCP server name. When omitted, lists resources from every connected server." })) }),
    output: Projection, structured: Schema.Unknown,
    toStructuredOutput: ({ output }) => output.structured,
    toModelOutput: ({ output }) => output.content,
    execute: ({ server }, context) => Effect.gen(function* () {
      yield* authorize(context, server)
      const entries = templates ? yield* mcp.resourceTemplates(server) : yield* mcp.resources(server)
      const values = Object.values(entries).filter(item => !server || item.client === server)
        .toSorted((a, b) => (a.client + "\0" + a.name).localeCompare(b.client + "\0" + b.name))
        .map(item => ({ ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== "client")), server: item.client }))
      const structured = { [templates ? "resourceTemplates" : "resources"]: values }
      return { structured, content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }] }
    }),
  }), "read")
  return {
    list_mcp_resources: list(false),
    list_mcp_resource_templates: list(true),
    read_mcp_resource: Tool.withPermission(Tool.make({
      description: "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      input: Schema.Struct({
        server: Schema.NonEmptyString.annotate({ description: "MCP server name exactly as returned by list_mcp_resources." }),
        uri: Schema.NonEmptyString.annotate({ description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources." }),
      }),
      output: Projection, structured: Schema.Unknown,
      toStructuredOutput: ({ output }) => output.structured,
      toModelOutput: ({ output }) => output.content,
      execute: ({ server, uri }, context) => Effect.gen(function* () {
        yield* authorize(context, server, uri)
        const result = yield* mcp.readResource(server, uri)
        if (!result) return yield* new Tool.Failure({ message: `Failed to read MCP resource: ${server}/${uri}` })
        const text: string[] = []
        const files: Tool.Content[] = []
        for (const item of result.contents) {
          const mime = item.mimeType ?? "application/octet-stream"
          if ("text" in item && typeof item.text === "string") {
            text.push(`Resource: ${item.uri}\nMIME: ${mime}\n${item.text}`)
            continue
          }
          if ("blob" in item && typeof item.blob === "string") {
            const part = resourceBlob(item.uri, mime, item.blob)
            if (part.type === "text") text.push(part.text)
            if (part.type === "file") {
              text.push(`[Binary MCP resource attached: ${item.uri} (${mime})]`)
              files.push(part)
            }
            continue
          }
          text.push(`[MCP resource content without text or blob: ${item.uri}]`)
        }
        return { structured: { server, uri, contents: result.contents.length, attachments: files.length }, content: [
          { type: "text" as const, text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.` }, ...files,
        ] }
      }),
    }), "read"),
  }
}

const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"])

function project(result: CallToolResult): typeof Projection.Type {
  const text: string[] = []
  const files: Tool.Content[] = []
  // structured-only结果同V1补可见文本；有content时不重复序列化整个结果及媒体。
  if (result.content.length === 0 && result.structuredContent != null) text.push(JSON.stringify(result.structuredContent))
  for (const item of result.content) {
    if (item.type === "text") {
      text.push(item.text)
      continue
    }
    if (item.type === "image") {
      files.push({ type: "file", data: item.data, mime: item.mimeType })
      continue
    }
    if (item.type !== "resource") continue
    const resource = item.resource
    if ("text" in resource) text.push(resource.text)
    if ("blob" in resource) {
      const part = resourceBlob(resource.uri, resource.mimeType ?? "application/octet-stream", resource.blob)
      if (part.type === "text") text.push(part.text)
      if (part.type === "file") files.push(part)
    }
  }
  return {
    structured: result.structuredContent ?? {},
    content: [...(text.length ? [{ type: "text" as const, text: text.join("\n\n") }] : []), ...files],
  }
}

function resourceBlob(uri: string, mime: string, data: string): Tool.Content {
  const size = base64Size(data)
  // 只对嵌入blob沿用V1附件边界，不扩大为直接image输出的新限制。
  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) return {
    type: "text", text: `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
  }
  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) return {
    type: "text", text: `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
  }
  return { type: "file", data, mime, name: uri }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor(trimmed.length * 3 / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

const Instruction = Schema.Struct({ name: Schema.String, instructions: Schema.String })
function renderInstructions(items: readonly (typeof Instruction.Type)[]) {
  return ["<mcp_instructions>", ...items.flatMap(item => [
    `  <server name="${item.name}">`, ...item.instructions.split("\n").map(line => `    ${line}`), "  </server>",
  ]), "</mcp_instructions>"].join("\n")
}

function instructionsContext(instructions: readonly McpConnection.ServerInstructions[]) {
  const captured = instructions.map(item => ({ ...item, tools: [...item.tools] }))
  return (visibleNames: readonly string[]) => {
    const visible = new Set(visibleNames)
    // 可见性属于这一轮，不存成Location上会被另一Session覆盖的“最近列表”。
    const current = captured.filter(item => item.tools.length === 0 || item.tools.some(name => visible.has(name)))
      .map(item => ({ name: item.name, instructions: item.instructions })).toSorted((a, b) => a.name.localeCompare(b.name))
    if (current.length === 0) return SystemContext.empty
    return SystemContext.make({
      key: SystemContext.Key.make("core/mcp-instructions"),
      codec: Schema.toCodecJson(Schema.Array(Instruction)),
      load: Effect.succeed(current),
      baseline: renderInstructions,
      update: (_previous, value) => ["MCP server instructions have changed. The following instructions supersede the previous MCP server instructions.", renderInstructions(value)].join("\n"),
      removed: () => "MCP server instructions are no longer available. Do not follow previously supplied MCP server instructions.",
    })
  }
}

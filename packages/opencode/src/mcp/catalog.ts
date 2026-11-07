import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7 } from "ai"
import type { Tool } from "@/tool/tool"
import type { MCP } from "@/mcp"

export { paginate, defs, fetch, sanitize, toolName, prompts, resources, resourceTemplates } from "@opencode-ai/core/mcp/catalog"

// 两个宿主入口共享原 MCP schema 投影，目录形状与 transport 的参数保持一致。
export function schemas(mcpTool: MCP.McpTool["def"]): { input: JSONSchema7; output?: JSONSchema7 } {
  return {
    input: {
      ...(mcpTool.inputSchema as JSONSchema7),
      type: "object",
      properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    },
    // 原 CodeMode 的 MCP schema 投影移到协议 owner，运行时仍由宿主/服务端校验。
    output: mcpTool.outputSchema as JSONSchema7 | undefined,
  }
}

export function convertTool(mcpTool: MCP.McpTool["def"], client: Client, timeout?: number): import("ai").Tool {
  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schemas(mcpTool).input),
    execute: (args, options) => callTool({ def: mcpTool, client, timeout }, args, options.abortSignal),
  })
}

export async function callTool(entry: MCP.McpTool, args: unknown, signal?: AbortSignal) {
      // 直接 MCP 与嵌套调用都经过同一 SDK 请求，不能为程序值再次请求远端。
      const result = await entry.client.callTool(
        { name: entry.def.name, arguments: (args || {}) as Record<string, unknown> },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal,
          timeout: entry.timeout,
          // SDK仅在存在回调时发送progress token，保留原超时续期语义。
          onprogress: () => {},
        },
      )
      if (result.isError)
        // MCP 的 isError 是工具失败而非协议成功，交给脚本的普通错误处理保留原消息。
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
}

// 同一次 transport 的程序投影保留结构化值；媒体留在宿主，避免字节进入解释器。
export function programResult(result: CallToolResult): NonNullable<Tool.ExecuteResult["program"]> {
  // 原 structuredContent 优先级保持不变，文本格式化不能把原生对象变成待解析 JSON。
  const text: string[] = []
  const attachments: NonNullable<Tool.ExecuteResult["attachments"]> = []
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        // 媒体只记录宿主附件，解释器拿到 marker 而非可复制到模型历史的 base64。
        attachments.push({ type: "file", mime: block.mimeType, url: `data:${block.mimeType};base64,${block.data}` })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        // 内嵌 resource 属于返回内容；resource_link 则只是引用，二者继续使用不同投影。
        attachments.push({
          type: "file", mime, url: `data:${mime};base64,${block.resource.blob}`,
          filename: block.resource.uri.replace(/[?#].*$/s, "").replace(/\/+$/, "").split("/").at(-1) || undefined,
        })
        break
      }
      case "resource_link":
        // 链接只作为引用交付；这里沿用原协议，不发起隐式下载。
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }
  const noun = attachments.every((item) => item.mime.startsWith("image/")) ? "image" : "file"
  // 媒体专用结果也返回可组合的普通值，让脚本知道调用成功而无需接触字节。
  const value = result.structuredContent ?? (text.length > 0 ? text.join("\n")
    : attachments.length > 0 ? `[${attachments.length} ${noun}${attachments.length === 1 ? "" : "s"} attached to the result]` : null)
  return { value, attachments }
}

export * as McpCatalog from "./catalog"

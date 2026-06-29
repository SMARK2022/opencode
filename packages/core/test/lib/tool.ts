import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Schema } from "effect"

export const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
) => registry.materialize(permissions).pipe(Effect.map((materialized) => materialized.definitions))

export const settleTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  registry.materialize().pipe(Effect.flatMap((materialized) => materialized.settle(input)))

export const executeTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  settleTool(registry, input).pipe(Effect.map((settlement) => settlement.result))

// 仅为显式测试场景提供完成态历史；调用工具本身不会自动制造此前已读的证明。
export const toolHistory = (path: string, tool = "read") => [
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: "msg_prior", type: "assistant", agent: "build",
    model: { id: "test", providerID: "test" },
    time: { created: 0, completed: 1 },
    content: [{
      type: "tool", id: "prior", name: tool, time: { created: 0, completed: 1 },
      state: { status: "completed", input: { path }, structured: {}, content: [] },
    }],
  }),
]

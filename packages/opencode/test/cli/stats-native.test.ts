import { expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "../../src/session/session"
import { aggregateStats } from "../../src/cli/cmd/stats-data"
import { renderOverview } from "../../src/cli/cmd/stats-render"
import { testEffect } from "../lib/effect"

// 独立内存库、真实事件投影和查询服务，不靠手造 StatsReport 证明原生统计。
const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, Database.node, EventV2.node, SessionProjector.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

it.effect("stats counts native and mixed transcripts without duplicate projections", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projectID = ProjectV2.ID.make("stats-native")
    const sessionID = SessionSchema.ID.make("ses_stats_native")
    const directory = AbsolutePath.make(process.cwd())
    const now = Date.now()
    const timestamp = DateTime.makeUnsafe(now)
    const model = { id: ModelV2.ID.make("native-model"), providerID: ProviderV2.ID.make("native-provider") }
    const tokens = { input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } }
    yield* database.db.insert(ProjectTable).values({ id: projectID, worktree: directory, sandboxes: [] }).run()
    yield* database.db.insert(SessionTable).values({
      id: sessionID, project_id: projectID, directory, slug: "native", title: "native", version: "test",
      time_created: now, time_updated: now,
    }).run()
    const userID = SessionMessage.ID.make("msg_stats_native_user")
    const assistantMessageID = SessionMessage.ID.make("msg_stats_native_assistant")
    // 同一工具的输入、调用、进度和完成只能在最终工具榜贡献一次。
    yield* events.publish(SessionEvent.Prompted, { sessionID, messageID: userID, timestamp, prompt: Prompt.make({ text: "hello" }), delivery: "steer" })
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp, agent: "build", model })
    const call = { sessionID, assistantMessageID, timestamp, callID: "stats-call" }
    yield* events.publish(SessionEvent.Tool.Input.Started, { ...call, name: "echo" })
    yield* events.publish(SessionEvent.Tool.Called, { ...call, tool: "echo", input: {}, provider: { executed: false } })
    yield* events.publish(SessionEvent.Tool.Progress, { ...call, structured: {}, content: [{ type: "text", text: "progress" }] })
    yield* events.publish(SessionEvent.Tool.Success, { ...call, structured: {}, content: [{ type: "text", text: "done" }], provider: { executed: false } })
    yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, timestamp, finish: "stop", cost: 0.5, tokens })
    const native = yield* aggregateStats({ projectFilter: projectID })
    expect(native.totalMessages).toBe(2)
    expect(native.totalTools).toBe(1)
    expect(native.toolUsage.map(tool => ({ id: tool.id, count: tool.count }))).toEqual([{ id: "echo", count: 1 }])
    expect(native.toolUsage[0]).toMatchObject({ inputChars: 2, outputChars: 4 })
    expect(native.total).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
    expect(native.sessions[0]).toMatchObject({ messages: 2, tools: 1 })
    // 同 ID 的迁移副本不双计；另一个旧消息仍进入全历史统计，但不进入最近一天。
    for (const item of [
      { id: SessionV1.MessageID.make(assistantMessageID), tool: "echo", time: now },
      { id: SessionV1.MessageID.make("msg_stats_legacy"), tool: "legacy-tool", time: now - 2 * 86400000 },
    ]) {
      const info: SessionV1.Assistant = {
        id: item.id, sessionID, role: "assistant", parentID: SessionV1.MessageID.make(userID),
        agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        path: { cwd: directory, root: directory }, cost: 0, tokens: { ...tokens, input: 0, output: 0, reasoning: 0 },
        time: { created: item.time, completed: item.time },
      }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID, time: item.time, part: {
          id: SessionV1.PartID.ascending(), sessionID, messageID: info.id,
          type: "tool", callID: item.tool, tool: item.tool,
          state: { status: "completed", input: {}, output: "done", title: item.tool, metadata: {}, time: { start: item.time, end: item.time } },
        },
      })
    }
    const mixed = yield* aggregateStats({ projectFilter: projectID })
    expect(mixed.totalMessages).toBe(3)
    expect(mixed.totalTools).toBe(2)
    expect(mixed.toolUsage.map(tool => ({ id: tool.id, count: tool.count }))).toEqual(expect.arrayContaining([{ id: "echo", count: 1 }, { id: "legacy-tool", count: 1 }]))
    expect(mixed.total).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
    const recent = yield* aggregateStats({ projectFilter: projectID, days: 1 })
    expect(recent.totalMessages).toBe(2)
    expect(recent.totalTools).toBe(1)
    expect(recent.toolUsage.map(tool => ({ id: tool.id, count: tool.count }))).toEqual([{ id: "echo", count: 1 }])
    expect(renderOverview(mixed)).toContain("messages=3 tools=2")
    expect(native.models.find(group => group.id === model.id)).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
  }),
)

import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import {
  ColdStorageTable,
  MessageTable,
  PartTable,
  SessionTable,
  SessionMessageTable,
} from "@opencode-ai/core/session/sql"
import { ColdMaintain } from "@opencode-ai/core/storage/cold-maintain"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Session } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { aggregateStats } from "../../src/cli/cmd/stats-data"
import { renderBreakdown, renderTimeline } from "../../src/cli/cmd/stats-render"
import { testEffect } from "../lib/effect"

// #176：只构建实际查询所需服务，独立内存连接随 testEffect scope 释放。
const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

it.effect("stats merges mixed history after noReply without double counting ledger usage", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessionID = SessionID.descending()
    const projectID = ProjectV2.ID.make("stats-mixed-history")
    const directory = AbsolutePath.make(process.cwd())
    const now = Date.now()
    const old = now - 3 * 24 * 60 * 60 * 1000
    yield* database.db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: directory,
        sandboxes: [],
        time_created: old,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    // 持久 Session 累计故意与事件不同，防止 all-time 又引入第二份用量权威。
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        directory,
        slug: "mixed-history",
        title: "mixed history",
        version: "test",
        agent: "history-agent",
        cost: 0.875,
        tokens_input: 111,
        time_created: old,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    const messages = [
      { model: "legacy-model", provider: "legacy-provider", input: 10, cost: 0.125, time: old },
      { model: "tracked-model", provider: "tracked-provider", input: 999, cost: 99, time: now },
      { model: "fallback-model", provider: "fallback-provider", input: 30, cost: 0.375, time: now },
    ].map((message) => ({
      id: MessageID.ascending(),
      sessionID,
      parentID: MessageID.ascending(),
      role: "assistant" as const,
      time: { created: message.time, completed: message.time },
      agent: "history-agent",
      mode: "build",
      providerID: ProviderV2.ID.make(message.provider),
      modelID: ModelV2.ID.make(message.model),
      path: { cwd: directory, root: directory },
      cost: message.cost,
      tokens: { input: message.input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    const rows = messages.map(({ id, sessionID, ...data }) => ({
      id,
      session_id: sessionID,
      time_created: data.time.created,
      time_updated: now,
      data,
    }))
    yield* database.db.insert(MessageTable).values(rows.slice(0, 1)).run().pipe(Effect.orDie)
    yield* database.db
      .insert(PartTable)
      .values([
        {
          id: PartID.ascending(),
          message_id: messages[0].id,
          session_id: sessionID,
          time_created: old,
          time_updated: now,
          data: {
            type: "step-finish",
            reason: "stop",
            cost: 0.125,
            tokens: messages[0].tokens,
            inputChars: 10,
            inputBreakdown: {
              system: 4,
              instructions: 0,
              skills: 0,
              tools: 0,
              messages: {
                userText: 3,
                assistantText: 0,
                reasoning: 0,
                toolInput: 2,
                toolOutput: 1,
                attachments: 0,
                total: 6,
              },
            },
          } as Omit<SessionV1.StepFinishPart, "id" | "messageID" | "sessionID">,
        },
        {
          id: PartID.ascending(),
          message_id: messages[0].id,
          session_id: sessionID,
          time_created: old,
          time_updated: now,
          data: {
            type: "tool",
            callID: "old-call",
            tool: "historical-tool",
            state: {
              status: "completed",
              input: {},
              output: "x",
              title: "history",
              metadata: {},
              time: { start: old, end: old },
            },
          } as Omit<SessionV1.ToolPart, "id" | "messageID" | "sessionID">,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    expect(
      (yield* aggregateStats({ projectFilter: projectID })).models.find((row) => row.id === "legacy-model")?.tokens
        .total,
    ).toBe(10)
    // #176：先复现旧会话新增零用量 noReply，再加入已跟踪助手与请求汇总兜底。
    const requests = SessionRequestUsage.make(database.db)
    const noReplyID = MessageID.ascending()
    yield* requests.begin({
      sessionID,
      requestID: noReplyID,
      source: "prompt",
      agent: "build",
      providerID: "new-provider",
      modelID: "no-reply-model",
      timeCreated: now,
    })
    yield* requests.complete({ sessionID, requestID: noReplyID, timeCompleted: now })
    const upgraded = yield* aggregateStats({ projectFilter: projectID })
    expect(upgraded.models.find((row) => row.id === "legacy-model")).toMatchObject({
      tokens: { total: 10 },
      cost: 0.125,
    })
    expect(upgraded.total.requests).toBe(1)

    yield* database.db.insert(MessageTable).values(rows.slice(1)).run().pipe(Effect.orDie)
    yield* requests.begin({
      sessionID,
      requestID: messages[1].parentID,
      source: "command",
      agent: "ledger-agent",
      providerID: messages[1].providerID,
      modelID: messages[1].modelID,
      timeCreated: now,
    })
    yield* requests.recordAssistant({
      sessionID,
      requestID: messages[1].parentID,
      assistant: messages[1],
      usage: { count: 1, tokens: { ...messages[1].tokens, input: 20, total: 20 }, costMicros: 250_000 },
    })
    // #176：确认过的请求汇总与同 parentID 消息并存且缺少助手行，必须只计一次。
    yield* database.db
      .insert(RequestUsageTable)
      .values({
        session_id: sessionID,
        request_id: messages[2].parentID,
        root_request_id: messages[2].parentID,
        source: "prompt",
        status: "completed",
        agent: "fallback-agent",
        provider_id: messages[2].providerID,
        model_id: messages[2].modelID,
        assistant_count: 1,
        step_count: 1,
        tokens_input: 30,
        tokens_total: 30,
        cost_micros: 375_000,
        time_created: now,
        time_updated: now,
        time_completed: now,
      })
      .run()
      .pipe(Effect.orDie)

    const report = yield* aggregateStats({ projectFilter: projectID })
    expect(report.models.find((row) => row.id === "legacy-model")).toMatchObject({
      tokens: { total: 10 },
      cost: 0.125,
      assistantCalls: 1,
    })
    expect(report.models.find((row) => row.id === "tracked-model")).toMatchObject({
      tokens: { total: 20 },
      cost: 0.25,
      assistantCalls: 1,
    })
    expect(report.models.find((row) => row.id === "fallback-model")).toMatchObject({
      tokens: { total: 30 },
      cost: 0.375,
      assistantCalls: 1,
    })
    expect(report.providers.find((row) => row.id === "legacy-provider")).toMatchObject({
      tokens: { total: 10 },
      cost: 0.125,
    })
    expect(report.modelSeries.find((row) => row.id === "legacy-model")?.tokens.total).toBe(10)
    expect(report.sessions[0]?.models).toContain("legacy-model")
    // 10 个历史 Token、20 个账本 Token、30 个 request 汇总只各计一次；零流量请求不遮蔽历史。
    expect(report.total).toMatchObject({ tokens: { total: 60 }, cost: 0.75, requests: 3, assistantCalls: 4 })
    expect(report.sessions[0]).toMatchObject({ tokens: { total: 60 }, cost: 0.75, requests: 3 })
    expect(report.daily.reduce((total, day) => total + day.tokens.total, 0)).toBe(60)
    expect(report.daily.reduce((total, day) => total + day.cost, 0)).toBe(0.75)
    // 各透视共享已过滤事件，而不是 renderer 另行改分母来掩盖错误总量。
    expect(report.models.reduce((total, row) => total + row.tokens.total, 0)).toBe(60)
    expect(report.sessions.reduce((total, row) => total + row.cost, 0)).toBe(0.75)
    expect(report.toolUsage.find((tool) => tool.id === "historical-tool")).toMatchObject({ count: 1, contextTokens: 3 })
    // 十类输入中的 tool calls 属于输入估算，不能与实际 ToolPart 调用数混用。
    expect(renderBreakdown(report, { by: "source", color: "never" })).toContain("tool calls 20.0% · tool results 10.0%")
    expect(renderBreakdown(report, { by: "agent", color: "never" })).toContain("Agent workload")
    expect(renderTimeline(report, { color: "never" })).toContain("Requests 3")

    const legacy = yield* aggregateStats({
      projectFilter: projectID,
      modelFilter: "legacy-model",
      providerFilter: "legacy-provider",
      sourceFilter: "legacy-message",
    })
    expect(legacy.total).toMatchObject({
      tokens: { total: 10 },
      cost: 0.125,
      requests: 0,
      assistantCalls: 1,
      components: { system: 4 },
    })
    const tracked = yield* aggregateStats({
      projectFilter: projectID,
      sourceFilter: "command",
      agentFilter: "ledger-agent",
      statusFilter: "completed",
    })
    expect(tracked.total).toMatchObject({ tokens: { total: 20 }, cost: 0.25, requests: 1, assistantCalls: 1 })
    const recent = yield* aggregateStats({ projectFilter: projectID, days: 1 })
    expect(recent.models.some((row) => row.id === "legacy-model")).toBe(false)
    expect(recent.total).toMatchObject({ tokens: { total: 50 }, cost: 0.625, requests: 3 })
    // 原生助手只写入 session_message；账本计量与工具/组件历史必须仍能精确合并。
    const native = {
      ...messages[1],
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      cost: 0.5,
      tokens: { ...messages[1].tokens, input: 40 },
    }
    yield* requests.begin({
      sessionID,
      requestID: native.parentID,
      source: "prompt",
      agent: "native-agent",
      providerID: native.providerID,
      modelID: native.modelID,
      timeCreated: now,
    })
    yield* requests.recordAssistant({
      sessionID,
      requestID: native.parentID,
      assistant: native,
      usage: { count: 1, tokens: { ...native.tokens, total: 40 }, costMicros: 500_000 },
    })
    const data = {
      agent: "native-agent",
      model: { id: native.modelID, providerID: native.providerID },
      time: { created: now, completed: now },
      cost: 0.5,
      tokens: native.tokens,
      inputEstimate: {
        input: 40,
        bodyChars: 40,
        confirmed: true,
        inputBreakdown: {
          system: 20,
          instructions: 0,
          skills: 0,
          tools: 0,
          messages: {
            userText: 0,
            assistantText: 0,
            reasoning: 0,
            toolInput: 10,
            toolOutput: 10,
            attachments: 0,
            total: 20,
          },
        },
      },
      content: [
        {
          id: "native-tool-call",
          type: "tool",
          name: "native-tool",
          time: { created: now, completed: now },
          state: { status: "completed", input: {}, content: [{ type: "text", text: "native output" }], structured: {} },
        },
      ],
    }
    yield* database.db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(native.id),
        session_id: SessionSchema.ID.make(sessionID),
        type: "assistant",
        seq: 1,
        time_created: now,
        time_updated: now,
        data,
      })
      .run()
      .pipe(Effect.orDie)
    const withNative = yield* aggregateStats({ projectFilter: projectID, toolFilter: "native-tool" })
    expect(withNative.sessions).toHaveLength(1)
    expect(withNative.toolUsage.find((tool) => tool.id === "native-tool")).toMatchObject({
      count: 1,
      inputChars: 2,
      outputChars: 13,
    })
    expect(withNative.toolUsage.find((tool) => tool.id === "native-tool")?.contextTokens).toBeGreaterThan(0)
    const nativeAgent = yield* aggregateStats({ projectFilter: projectID, agentFilter: "native-agent" })
    expect(nativeAgent.total).toMatchObject({
      tokens: { total: 40 },
      cost: 0.5,
      components: { system: 20, toolCalls: 10, toolResults: 10 },
    })
    // 非零组件、旧历史补计和多维过滤在两代归档后必须保持同一完整报表。
    const filters = [
      { projectFilter: projectID },
      { projectFilter: projectID, days: 1 },
      {
        projectFilter: projectID,
        modelFilter: "legacy-model",
        providerFilter: "legacy-provider",
        sourceFilter: "legacy-message",
      },
      { projectFilter: projectID, sourceFilter: "command", agentFilter: "ledger-agent", statusFilter: "completed" },
      { projectFilter: projectID, agentFilter: "native-agent" },
      { projectFilter: projectID, toolFilter: "native-tool" },
    ]
    const hot = yield* Effect.forEach(filters, (filter) => aggregateStats(filter))
    yield* Effect.promise(() =>
      ColdMaintain.maintain(
        database.db.sync,
        ColdMaintain.prepareMaintenance({
          operation: "compress",
          sessionID,
          olderThanMs: 0,
          batchSize: 2,
        }),
        {
          lease: { assertOwned() {} },
          checkpoint: async () => {},
          run: <A>(body: () => A) => Effect.runPromise(Database.withSync(database, body)),
        },
      ),
    )
    const stored = Effect.all([
      database.db.select().from(MessageTable).all(),
      database.db.select().from(PartTable).all(),
      database.db.select().from(SessionMessageTable).all(),
      database.db.select().from(ColdStorageTable).all(),
      database.db.select().from(RequestUsageTable).all(),
      database.db.select().from(RequestUsageAssistantTable).all(),
    ])
    const before = yield* stored
    expect(before[1].some((row) => row.cold_key)).toBe(true)
    expect(before[2].some((row) => row.cold_key)).toBe(true)
    for (const [index, filter] of filters.entries()) {
      expect(yield* aggregateStats(filter)).toEqual(hot[index])
    }
    expect(yield* stored).toEqual(before)
  }),
)

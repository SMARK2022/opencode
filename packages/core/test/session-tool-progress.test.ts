import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }]

describe("Tool.Progress", () => {
  it.effect("projects durable progress and keeps final settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string, name = "bash", input: Record<string, unknown> = { command: "pwd" }) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name,
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: name,
            input,
            provider: { executed: false },
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })

      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: { phase: "checkpoint" }, content: content("saved") },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "error",
          structured: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)
      // 从真实 durable success 投影到数据库，下一轮工具调用记忆必须采用 formatter 的落盘真值。
      yield* start("call-formatted", "write", { path: "x.ts", content: "const n=2" })
      yield* service.publish(SessionEvent.Tool.Success, {
        sessionID, timestamp, assistantMessageID, callID: "call-formatted",
        structured: { formattedContent: "const n = 2;\n", formattedDiff: "-const n=2\n+const n = 2;\n" },
        content: content("Wrote file successfully.\nFormatted changes"), provider: { executed: false },
      })
      expect((yield* readAssistant).content[2]).toMatchObject({
        name: "write",
        state: { status: "completed", input: { path: "x.ts", content: "const n = 2;\n" }, structured: { formattedDiff: "-const n=2\n+const n = 2;\n" } },
      })
      const formattedTool = (yield* readAssistant).content[2]
      expect(formattedTool?.type).toBe("tool")
      if (formattedTool?.type === "tool" && formattedTool.state.status === "completed")
        expect(formattedTool.state.structured).not.toHaveProperty("formattedContent")

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Failed.type, 1))
    }),
  )
})

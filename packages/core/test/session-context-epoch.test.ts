import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

it.effect("persists actual source attribution with the original epoch and decodes legacy snapshots", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const sessionID = SessionSchema.ID.make("ses_context_attribution")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "context",
        directory: "/project",
        title: "context",
        version: "test",
      })
      .run()
    const calls = { load: 0, render: 0 }
    // 身份使用生产capture识别的领域key，普通正文中出现相同标题不能冒充instructions或skills来源。
    const context = (instructions: string) =>
      Effect.succeed(
        SystemContext.combine(
          [["core/instructions", instructions] as const, ["core/skill-guidance", "skills"] as const].map(
            ([key, text]) =>
              SystemContext.make({
                key: SystemContext.Key.make(key),
                codec: Schema.toCodecJson(Schema.String),
                load: Effect.sync(() => {
                  calls.load++
                  return text
                }),
                baseline: (value) => {
                  calls.render++
                  return value
                },
                update: (_previous, value) => {
                  calls.render++
                  return value
                },
                removed: () => "removed",
              }),
          ),
        ),
      )
    const initial = yield* SessionContextEpoch.initialize(db, context("old"), sessionID)
    // initialize 在已有 epoch 时返回 undefined；此 fixture 的首次建立和 reset 后建立都必须产生快照。
    if (initial === undefined) return yield* Effect.die("首次初始化必须创建 epoch 快照")
    // 尚无Session事件时baseline_seq为-1，建立归属元数据不能先发布隐含事件改变历史选取起点。
    expect(initial).toEqual({
      baseline: "old\n\nskills",
      baselineSeq: -1,
      sections: [
        { kind: "instructions", text: "old" },
        { kind: "skills", text: "skills" },
      ],
    })
    expect(calls).toEqual({ load: 2, render: 2 })
    const updated = yield* SessionContextEpoch.prepare(db, events, context("new"), sessionID)
    expect(updated.baseline).toBe(initial.baseline)
    // 新指令以历史更新追加，旧baseline仍发送；来源证明必须保留old并追加new，不能只剩当前文件版本。
    expect(updated.sections).toEqual([...initial.sections, { kind: "instructions", text: "new" }])
    expect(calls).toEqual({ load: 4, render: 3 })
    // 查询持久列而非内存返回值，验证source比较状态和片段证明已随ContextUpdated的commit一起保存。
    expect(
      (yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get())?.snapshot,
    ).toMatchObject({ sources: { "core/instructions": { value: "new" } }, sections: updated.sections })
    const again = yield* SessionContextEpoch.prepare(db, events, context("new"), sessionID)
    expect(again).toEqual(updated)
    expect(calls).toEqual({ load: 6, render: 3 })
    // 旧裸快照有比较值却没有渲染证明，必须保留存储baseline并留空归属，不能重读source伪造历史片段。
    yield* db
      .update(SessionContextEpochTable)
      .set({
        snapshot: {
          "core/instructions": { value: "new", removed: "removed" },
          "core/skill-guidance": { value: "skills", removed: "removed" },
        },
      })
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .run()
    const legacy = yield* SessionContextEpoch.prepare(db, events, context("new"), sessionID)
    expect(legacy.baseline).toBe(initial.baseline)
    expect(legacy.sections).toEqual([])
    yield* SessionContextEpoch.reset(db, sessionID)
    const reset = yield* SessionContextEpoch.initialize(db, context("reset"), sessionID)
    if (reset === undefined) return yield* Effect.die("reset 后初始化必须创建 epoch 快照")
    expect(reset.sections).toEqual([
      { kind: "instructions", text: "reset" },
      { kind: "skills", text: "skills" },
    ])
  }),
)

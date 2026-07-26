import { expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { SessionRevert } from "../src/session/revert"
import { SessionSchema } from "../src/session/schema"
import { SessionMessageTable, SessionTable } from "../src/session/sql"
import { Snapshot } from "../src/snapshot"
import { testEffect } from "./lib/effect"

// 使用真实内存表和事件发布，只替换磁盘恢复；本用例不执行工具、Git或应用宿主。
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [[Database.node, Database.layerFromPath(":memory:")]]))
it.effect("native undo intersects snapshot files with completed tool declarations", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const root = AbsolutePath.make(path.resolve("native-revert-fixture"))
    const directory = AbsolutePath.make(path.join(root, "scope"))
    const projectID = ProjectV2.ID.make("native-revert-test")
    const session = Schema.decodeUnknownSync(SessionSchema.Info)({
      id: "ses_native_revert", projectID, title: "undo", location: { directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    })
    yield* db.insert(ProjectTable).values({ id: projectID, worktree: root, sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({
      id: session.id, project_id: projectID, slug: "undo", title: "undo", version: "test", directory,
    }).run().pipe(Effect.orDie)
    const restored: string[][] = []
    const baselines: string[][] = []
    const snapshots = Layer.mock(Snapshot.Service, {
      capture: () => Effect.succeed(Snapshot.ID.make("original")),
      diff: () => Effect.succeed([]),
      restore: ({ files }) => Effect.sync(() => { restored.push([...files.keys()]); baselines.push([...files.values()]) }),
    })
    const location = Layer.mock(Location.Service, { directory, project: { id: projectID, directory: root } })
    const cases = [
      { name: "read", output: {} },
      { name: "write", output: { target: path.join(directory, "owned.txt"), diff: "+owned\n" } },
      { name: "edit", output: { files: [{ file: "owned.txt" }] } },
      { name: "apply_patch", output: { files: [{ file: "owned.txt" }] } },
      { name: "read", output: {} },
      { name: "bash", output: {}, worktree: "ambient" as const },
    ]
    for (const [index, item] of cases.entries()) {
      const boundary = SessionMessage.ID.create()
      yield* db.insert(SessionMessageTable).values({
        id: boundary, session_id: session.id, type: "user", seq: index * 3,
        data: Schema.encodeSync(SessionMessage.User)(Schema.decodeUnknownSync(SessionMessage.User)({
          id: boundary, type: "user", text: "undo", files: [], agents: [], time: { created: 0 },
        })),
      }).run().pipe(Effect.orDie)
      // 前一个助手没有声明，后续工具即使认领同名文件也不能借它的baseline恢复。
      const unrelated = SessionMessage.ID.create()
      yield* db.insert(SessionMessageTable).values({
        id: unrelated, session_id: session.id, type: "assistant", seq: index * 3 + 1,
        data: Schema.encodeSync(SessionMessage.Assistant)(Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: unrelated, type: "assistant", agent: "default", model: { id: "test", providerID: "test" },
          time: { created: 0 }, snapshot: { start: "unrelated", files: ["scope/owned.txt"] }, content: [],
        })),
      }).run().pipe(Effect.orDie)
      const assistant = SessionMessage.ID.create()
      // 每个边界后的快照同时包含工具文件与ambient；不能靠空快照通过排除断言。
      const data = Schema.encodeSync(SessionMessage.Assistant)(Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: assistant, type: "assistant", agent: "default", model: { id: "test", providerID: "test" },
        time: { created: 0 }, snapshot: { start: "before", end: "after", files: ["scope/owned.txt", "scope/ambient.md"],
          ...("worktree" in item ? { worktree: item.worktree } : {}) },
        content: [{ type: "tool", id: "call", name: item.name, time: { created: 0 },
          state: { status: "completed", input: {}, structured: item.output, content: [] } }],
      }))
      yield* db.insert(SessionMessageTable).values({
        id: assistant, session_id: session.id, type: "assistant", seq: index * 3 + 2, data,
      }).run().pipe(Effect.orDie)
      const before = restored.length
      const result = yield* SessionRevert.stage({ session, messageID: boundary }).pipe(
        Effect.provide(Layer.mergeAll(snapshots, location)),
      )
      expect(result.messageID).toBe(boundary)
      // 空声明不触盘；声明只放行交集，不恢复同轮ambient，也不借用更早turn的声明。
      expect(restored.length - before).toBe(item.name === "read" ? 0 : 1)
      if (item.name !== "read") {
        const paths = item.name === "bash" ? ["scope/owned.txt", "scope/ambient.md"] : ["scope/owned.txt"]
        expect(restored.at(-1)).toEqual(paths)
        expect(baselines.at(-1)).toEqual(paths.map(() => "before"))
      }
    }
  }),
)

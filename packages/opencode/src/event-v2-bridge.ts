// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { eq } from "drizzle-orm"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        // EventV2 在提交 Core projector 后才通知 listener，读到的是已落盘的步骤变化。
        if (
          // raw/text 的流式更新不改变已确认用量，不为每个 delta 读取 Session。
          (event.type === SessionV1.Event.PartUpdated.type &&
            Schema.decodeUnknownSync(SessionV1.Event.PartUpdated.data)(event.data).part.type === "step-finish") ||
          event.type === SessionV1.Event.PartRemoved.type ||
          event.type === SessionV1.Event.MessageRemoved.type ||
          // native 结算和 revert 提交都通知同一存储行，不转交 V1 执行器或建立另一份累计。
          event.type === SessionEvent.Step.Ended.type ||
          event.type === SessionEvent.RevertEvent.Committed.type
        ) {
          const data = Schema.decodeUnknownSync(Schema.Struct({ sessionID: SessionV1.SessionInfo.fields.id }))(event.data)
          const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, data.sessionID)).get().pipe(Effect.orDie)
          // 会话删除后不制造幽灵快照；原始 part/message 事件仍照常转发。
          if (row) {
            // 只依赖 Core 的纯兼容映射；导入 Session service 会让 Layer 推断形成反向闭环。
            // Core 已维护五项步骤累计；这里只投影同一行，不能再扫描 parts 建第二个计数 owner。
            const info = SessionV1.fromRow(row)
            // 只发读投影，不重发 durable Updated，防止旧快照覆盖并发写入的 Session 行。
            GlobalBus.emit("event", {
              directory: event.location?.directory ?? ctx?.directory,
              project: ctx?.project.id,
              workspace: workspaceID,
              payload: { type: "session.updated", properties: { sessionID: row.id, info } },
            })
          }
        }
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

// 查询依赖显式入图；不能从主工作区隐式借用数据库服务。
export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node, Database.node] })

export * as EventV2Bridge from "./event-v2-bridge"

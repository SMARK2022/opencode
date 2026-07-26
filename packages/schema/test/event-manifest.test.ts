import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // 本项新增可公开的Native快照事件，兼容集合也增加同一个定义。
    expect(EventManifest.ServerDefinitions.length).toBe(70)
    expect(EventManifest.Definitions.length).toBe(102)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Forked,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.PartProgress,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(102)
    expect(EventManifest.Durable.size).toBe(42)
    // V1 展示事件只扩展兼容通道，不能进入当前协议或变成逐 tick 的持久事件。
    expect(EventManifest.ServerDefinitions.some((event) => event.type === "message.part.progress")).toBe(false)
    expect(EventManifest.Durable.has("message.part.progress")).toBe(false)
    expect(EventManifest.ServerDefinitions.some((event) => event.type === "session.forked")).toBe(false)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    // 隐藏是当前Session可重放事件，必须同时进入实时与durable契约。
    expect(EventManifest.Latest.get("session.next.messages.hidden")).toBe(SessionEvent.MessagesHidden)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Definitions.slice(50, 54)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.PartProgress,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.get("session.next.messages.hidden.1")).toBe(SessionEvent.MessagesHidden)
    // 快照更新必须沿同一持久定义重放，而不是仅增加一个计数。
    expect(EventManifest.Durable.get("session.next.step.snapshot.updated.1")).toBe(SessionEvent.Step.SnapshotUpdated)
  })
})

import { expect, test } from "bun:test"
import { Event } from "@opencode-ai/schema/event"
import { EventManifest } from "@opencode-ai/schema/event-manifest"
import { PermissionV1 } from "@opencode-ai/schema/permission-v1"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Schema } from "effect"
import { OpenCodeEvent } from "../src/groups/event"

test("shared permission review events preserve the native event stream", () => {
  const events = [
    {
      id: Event.ID.create(),
      type: "permission.review.started",
      data: {
        sessionID: SessionID.make("ses_test"),
        reviewID: "review",
        permission: "bash",
        patterns: ["git push"],
        precheck: { level: "cautious", reason: "publish" },
      },
    },
    {
      id: Event.ID.create(),
      type: "permission.review.completed",
      data: {
        sessionID: SessionID.make("ses_test"),
        reviewID: "review",
        outcome: "allow",
        rationale: "bounded action",
      },
    },
    {
      id: Event.ID.create(),
      type: "permission.review.failed",
      data: { sessionID: SessionID.make("ses_test"), reviewID: "review", reason: "provider unavailable" },
    },
    {
      id: Event.ID.create(),
      type: "permission.review.circuit_broken",
      data: { sessionID: SessionID.make("ses_test"), consecutive: 3, recent: 3 },
    },
    { id: Event.ID.create(), type: "server.connected", data: {} },
  ] as const
  // 与 SSE handler 使用同一编码器；任一观察事件不匹配都会阻止后续帧交付。
  const encoded = events.map((event) => Schema.encodeUnknownSync(OpenCodeEvent)(event))
  expect(encoded.map((event) => event.type)).toEqual(events.map((event) => event.type))
  expect(Schema.decodeUnknownSync(OpenCodeEvent)(encoded[0])).toEqual(events[0])
  // 双端共享规范对象，不另造同名 Schema 来通过编码。
  expect(EventManifest.ServerDefinitions.find((event) => event.type === "permission.review.completed")).toBe(
    PermissionV1.Event.ReviewCompleted,
  )
})

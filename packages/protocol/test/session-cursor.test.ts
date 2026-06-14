import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionHistoryQuery, SessionsCursor, SessionsQuery } from "../src/groups/session"
import { Session } from "@opencode-ai/schema/session"

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = {
      workspace: undefined,
      start: 1000,
      search: "protocol",
      order: "desc" as const,
      anchor: { id: Session.ID.make("ses_test"), time: 1, direction: "next" as const },
    }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
    // 新窗口随cursor往返，旧cursor缺省仍合法；公开负数输入保持标准Query失败。
    const { start, ...previous } = input
    expect(await Effect.runPromise(SessionsCursor.parse(SessionsCursor.make(previous)))).toEqual(previous)
    expect(Schema.decodeUnknownSync(SessionsQuery)({ start: "1000" }).start).toBe(start)
    expect(Schema.decodeUnknownExit(SessionsQuery)({ start: "-1" })._tag).toBe("Failure")
  })
})

describe("SessionHistoryQuery", () => {
  test("decodes numeric paging inputs", async () => {
    const query = await Effect.runPromise(Schema.decodeUnknownEffect(SessionHistoryQuery)({ after: "3", limit: "10" }))

    expect(query).toEqual({ after: 3, limit: 10 })
  })
})

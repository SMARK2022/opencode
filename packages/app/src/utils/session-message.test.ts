import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { normalizeSessionMessages } from "./session-message"
import { Schema } from "effect"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { createV2SessionReducer } from "../context/server-session-v2-reducer"

describe("normalizeSessionMessages", () => {
  test("renders native goal objectives through the same snapshot and live turn projection", () => {
    const text =
      "<session-goal-continuation>\n<objective>\n A &amp; B\n&lt;tag&gt; &amp;lt; \n</objective>\nprivate budget\n</session-goal-continuation>"
    const goal = { id: "msg_goal", type: "synthetic" as const, time: { created: 1 }, ...{ sessionID: "ses_1", text } }
    const source = [
      {
        id: "msg_internal",
        type: "synthetic",
        time: { created: 0 },
        ...{ sessionID: "ses_1", text: "<objective>not a goal</objective>" },
      },
      goal,
      {
        id: "msg_after_goal",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "test" },
        content: [],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const snapshot = normalizeSessionMessages("ses_1", source)
    expect(snapshot.messages.map((message) => message.id)).toEqual(["msg_goal", "msg_after_goal"])
    expect(snapshot.messages[1]).toMatchObject({ parentID: "msg_goal" })
    // 只把objective作为可见DTO；源XML与synthetic身份保持原样，字面实体沿用源解码顺序。
    expect(snapshot.parts.get("msg_goal")?.[0]).toMatchObject({ text: "A & B\n<tag> <", synthetic: false })
    expect(goal).toMatchObject({ type: "synthetic", text })
    const event = Schema.decodeUnknownSync(Schema.toEncoded(SessionEvent.All))({
      id: "evt_goal",
      type: "session.next.synthetic",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", messageID: "msg_goal", timestamp: 1, text },
    })
    const live = createV2SessionReducer().reduce([], event)
    expect(live?.missing).toBeUndefined()
    expect(normalizeSessionMessages("ses_1", live?.messages ?? []).parts.get("msg_goal")).toEqual(
      snapshot.parts.get("msg_goal"),
    )
    expect(live?.messages[0]).toMatchObject({ type: "synthetic", text })
    // Reviewer优先于Goal识别；合法hidden仍隐藏，未标记内部消息仍不展示。
    const reviewer = { ...goal, metadata: { permissionReviewerRequest: true } }
    expect(normalizeSessionMessages("ses_1", [reviewer]).parts.get("msg_goal")?.[0]).toMatchObject({
      text,
      synthetic: false,
      metadata: { permissionReviewerRequest: true },
    })
    expect(
      normalizeSessionMessages("ses_1", [
        { ...goal, metadata: { hidden: { time: 0, reason: "permission-reviewer-protocol-retry" } } },
      ]).messages,
    ).toEqual([])
    expect(
      normalizeSessionMessages("ses_1", [
        { ...goal, ...{ text: "internal", description: "existing description" } },
      ]).parts.get("msg_goal")?.[0],
    ).toMatchObject({ text: "existing description", synthetic: true })
  })

  test("projects current turns into stable legacy rendering records", () => {
    const source = [
      { id: "msg_1", type: "agent-switched", agent: "build", time: { created: 1 } },
      {
        id: "msg_2",
        type: "model-switched",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        time: { created: 2 },
      },
      {
        id: "msg_3",
        type: "user",
        text: "inspect @src/client.ts",
        files: [
          {
            data: "aGVsbG8=",
            mime: "text/plain",
            name: "note.txt",
            source: { type: "inline" },
          },
          {
            data: "ZXhwb3J0IHt9",
            mime: "text/plain",
            name: "client.ts",
            source: { type: "inline" },
            mention: { text: "@src/client.ts", start: 8, end: 22 },
          },
        ],
        agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
        time: { created: 3 },
      },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        content: [
          { type: "reasoning", text: "Thinking", time: { created: 4, completed: 5 } },
          { type: "text", text: "Result" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "note.txt" },
              metadata: { title: "note.txt" },
              content: [{ type: "text", text: "hello" }],
            },
            time: { created: 5, ran: 6, completed: 7 },
          },
        ],
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        time: { created: 4, completed: 7 },
      },
      {
        id: "msg_5",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 8 },
      },
      {
        id: "msg_internal",
        type: "synthetic",
        time: { created: 8 },
        ...{ sessionID: "ses_1", text: "INTERNAL CONTEXT" },
      },
      {
        id: "msg_review_request",
        type: "synthetic",
        time: { created: 9 },
        ...{
          sessionID: "ses_1",
          text: "system: exact policy\nuser: exact evidence",
          metadata: { permissionReviewerRequest: true, reviewID: "review_1" },
        },
      },
      {
        id: "msg_review_answer",
        type: "assistant",
        agent: "permission-reviewer",
        model: { id: "review", providerID: "test" },
        time: { created: 10, completed: 11 },
        content: [
          { type: "reasoning", text: "Actual reviewer reasoning" },
          { type: "text", text: "Actual reviewer explanation" },
          {
            type: "tool",
            id: "decision",
            name: "permission_review_decision",
            state: {
              status: "completed",
              input: { outcome: "deny" },
              content: [{ type: "text", text: "Exact decision" }],
              ...{
                structured: {
                  reviewID: "review_1",
                  outcome: "deny",
                  risk_level: "high",
                  user_authorization: "unknown",
                  rationale: "Exact rationale",
                },
              },
            },
            time: { created: 10, ran: 10, completed: 11 },
          },
        ],
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toHaveLength(4)
    expect(result.messages[0]).toMatchObject({
      id: "msg_3",
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude", variant: "high" },
    })
    expect(result.messages[1]).toMatchObject({ id: "msg_4", role: "assistant", parentID: "msg_3", cost: 0.1 })
    expect(result.parts.get("msg_3")?.map((part) => part.id)).toEqual([
      "msg_3:text:0",
      "msg_3:file:0",
      "msg_3:file:1",
      "msg_3:agent:0",
      "msg_5:compaction",
    ])
    expect(result.parts.get("msg_3")?.[2]).toMatchObject({
      type: "file",
      source: {
        type: "file",
        path: "src/client.ts",
        text: { value: "@src/client.ts", start: 8, end: 22 },
      },
    })
    expect(result.parts.get("msg_4")?.map((part) => part.id)).toEqual(["msg_4:reasoning:0", "msg_4:text:0", "call_1"])
    expect(result.parts.get("msg_4")?.[2]).toMatchObject({
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "hello" },
    })
    expect(result.messages.map((message) => message.id)).toEqual([
      "msg_3",
      "msg_4",
      "msg_review_request",
      "msg_review_answer",
    ])
    expect(result.parts.get("msg_review_request")?.[0]).toMatchObject({
      text: "system: exact policy\nuser: exact evidence",
      synthetic: false,
      metadata: { permissionReviewerRequest: true },
    })
    expect(result.messages[3]).toMatchObject({ role: "assistant", parentID: "msg_review_request" })
    expect(result.parts.get("msg_review_answer")?.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])
    expect(result.parts.get("msg_review_answer")?.[2]).toMatchObject({
      state: { status: "completed", metadata: { reviewID: "review_1", outcome: "deny", rationale: "Exact rationale" } },
    })
  })

  test("does not invent a parent for an assistant-only page", () => {
    const source = [
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "orphan" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    expect(normalizeSessionMessages("ses_1", source).messages).toEqual([])
  })

  test("projects a current shell message into a renderable standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "printf hello",
        status: "exited",
        exit: 0,
        output: { output: "hello", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "msg_shell", role: "user" }),
      expect.objectContaining({ id: "msg_shell:assistant", role: "assistant", parentID: "msg_shell" }),
    ])
    expect(result.parts.get("msg_shell")).toEqual([expect.objectContaining({ type: "text", text: "printf hello" })])
    expect(result.parts.get("msg_shell:assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "bash",
        state: expect.objectContaining({
          status: "completed",
          input: { command: "printf hello" },
          output: "hello",
          title: "Shell",
        }),
      }),
    ])
  })

  test("adapts current edit fields for the legacy edit renderer", () => {
    const source = [
      // 已持久化摘要进入原有每prompt修改列表，不能只在单工具面板看见diff。
      {
        id: "msg_user",
        type: "user",
        text: "edit it",
        time: { created: 1 },
        ...{
          summary: {
            diffs: [
              {
                file: "README.md",
                patch: "@@ -1 +1 @@\n-old\n+new",
                additions: 1,
                deletions: 1,
                status: "modified" as const,
              },
            ],
          },
        },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_edit",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "/repo/README.md", oldString: "old", newString: "new" },
              content: [{ type: "text", text: "Edited file successfully" }],
              metadata: {
                files: [
                  {
                    file: "README.md",
                    patch: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
                replacements: 1,
              },
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        time: { created: 2, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)
    expect(result.messages[0]).toMatchObject({
      summary: { diffs: [{ file: "README.md", additions: 1, deletions: 1 }] },
    })

    expect(result.parts.get("msg_assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "edit",
        state: expect.objectContaining({
          status: "completed",
          input: expect.objectContaining({ path: "/repo/README.md", filePath: "/repo/README.md" }),
          metadata: expect.objectContaining({
            filediff: {
              file: "README.md",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
          }),
        }),
      }),
    ])
  })
})

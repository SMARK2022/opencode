import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode-ai/client/promise"
import { createV2SessionReducer } from "./server-session-v2-reducer"
import { Schema } from "effect"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import type { NativeSessionEvent } from "./native-session-event"
import { normalizeSessionMessages } from "../utils/session-message"

const event = (input: object) => input as OpenCodeEvent
const base = { created: 1, location: { directory: "/repo" }, durable: { aggregateID: "ses_1", seq: 1, version: 1 } }

describe("v2 session reducer", () => {
  test("projects promoted input and streaming assistant content", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_admitted",
      type: "session.input.admitted",
      data: {
        sessionID: "ses_1",
        inputID: "msg_user",
        input: { type: "user", delivery: "steer", data: { text: "hello" } },
      },
    })
    apply({
      ...base,
      id: "evt_promoted",
      type: "session.input.promoted",
      data: { sessionID: "ses_1", inputID: "msg_user" },
    })
    apply({
      ...base,
      id: "evt_step",
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0 },
    })
    apply({
      ...base,
      id: "evt_text_delta",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, delta: "hel" },
    })
    apply({
      ...base,
      id: "evt_text_end",
      type: "session.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, text: "hello" },
    })

    expect(messages[0]).toMatchObject({ id: "msg_user", type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      id: "msg_assistant",
      type: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
  })

  test("folds tool, retry, and completion events", () => {
    const reducer = createV2SessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
    }

    apply({
      ...base,
      id: "evt_step",
      type: "session.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", name: "bash" },
    })
    apply({
      ...base,
      id: "evt_tool_delta",
      type: "session.tool.input.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", delta: "{}" },
    })
    apply({
      ...base,
      id: "evt_tool_called",
      type: "session.tool.called",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", callID: "call_1", input: {}, executed: true },
    })
    apply({
      ...base,
      id: "evt_tool_success",
      type: "session.tool.success",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        callID: "call_1",
        metadata: {},
        content: [{ type: "text", text: "done" }],
        executed: true,
      },
    })
    apply({
      ...base,
      id: "evt_retry",
      type: "session.retry.scheduled",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        attempt: 2,
        at: 10,
        error: { type: "ProviderError", message: "retry" },
      },
    })
    apply({ ...base, id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_1" } })

    expect(messages[0]).toMatchObject({
      type: "assistant",
      retry: undefined,
      content: [{ type: "tool", id: "call_1", state: { status: "completed", content: [{ text: "done" }] } }],
    })
  })

  test("requests hydration when promotion admission was missed", () => {
    const result = createV2SessionReducer().reduce(
      [],
      event({
        ...base,
        id: "evt_promoted",
        type: "session.input.promoted",
        data: { sessionID: "ses_1", inputID: "msg_user" },
      }),
    )

    expect(result).toMatchObject({ sessionID: "ses_1", missing: "msg_user", touched: [] })
  })
})

test("projects canonical live reviewer events into the same visible turns and terminal envelopes", () => {
  const reducer = createV2SessionReducer()
  const store = new Map<string, SessionMessageInfo[]>()
  const decode = Schema.decodeUnknownSync(Schema.toEncoded(SessionEvent.All))
  let seq = 0
  // 用真实wire Schema校验事件，不再用旧client类型断言掩盖类型名/身份/字段错位。
  const wire = (sessionID: string, type: NativeSessionEvent["type"], data: Record<string, unknown>, metadata?: Record<string, unknown>) => decode({
    id: `evt_native_${++seq}`, type, ...(metadata ? { metadata } : {}), data: { sessionID, timestamp: seq, ...data },
    ...(type.endsWith(".delta") ? {} : { durable: { aggregateID: sessionID, seq, version: type === "session.next.step.ended" || type === "session.next.step.failed" ? 2 : 1 } }),
  })
  const apply = (sessionID: string, type: NativeSessionEvent["type"], data: Record<string, unknown>, metadata?: Record<string, unknown>) => {
    const result = reducer.reduce(store.get(sessionID) ?? [], wire(sessionID, type, data, metadata))
    expect(result?.missing).toBeUndefined()
    if (result) store.set(sessionID, result.messages)
  }
  const model = { id: "review", providerID: "test" }
  const assessment = { outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "Exact final rationale" }
  const review = { reviewID: "review_1", sessionID: "ses_child", status: "reviewing", precheck: { level: "cautious", reason: "bounded action" } }
  apply("ses_parent", "session.next.prompted", { messageID: "msg_user", prompt: { text: "git add ." }, delivery: "steer" })
  apply("ses_parent", "session.next.step.started", { assistantMessageID: "msg_parent", agent: "build", model })
  const parent = { assistantMessageID: "msg_parent", callID: "command" }
  apply("ses_parent", "session.next.tool.input.started", { ...parent, name: "bash" })
  apply("ses_parent", "session.next.tool.called", { ...parent, tool: "bash", input: { command: "git add ." }, provider: { executed: false } })
  apply("ses_parent", "session.next.tool.progress", { ...parent, structured: { autoReview: review }, content: [] })
  apply("ses_child", "session.next.synthetic", { messageID: "msg_request", text: "system: exact policy\nuser: exact evidence" }, { permissionReviewerRequest: true, reviewID: "review_1" })
  // 两请求先到，助手后到；不能按最近请求分组或互相提前结束。
  apply("ses_child", "session.next.synthetic", { messageID: "msg_request_b", text: "system: review B" }, { permissionReviewerRequest: true, reviewID: "review_b" })
  const child = { assistantMessageID: "msg_answer" }
  apply("ses_child", "session.next.step.started", { ...child, agent: "permission-reviewer", model }, { permissionReviewerRequestID: "msg_request", reviewID: "review_1" })
  apply("ses_child", "session.next.step.started", { assistantMessageID: "msg_answer_b", agent: "permission-reviewer", model }, { permissionReviewerRequestID: "msg_request_b", reviewID: "review_b" })
  apply("ses_child", "session.next.reasoning.started", { ...child, reasoningID: "thought_1" })
  apply("ses_child", "session.next.reasoning.delta", { ...child, reasoningID: "thought_1", delta: "First real reasoning" })
  apply("ses_child", "session.next.reasoning.ended", { ...child, reasoningID: "thought_1", text: "First real reasoning" })
  apply("ses_child", "session.next.text.started", { ...child, textID: "text_1" })
  apply("ses_child", "session.next.text.delta", { ...child, textID: "text_1", delta: "Actual explanation" })
  apply("ses_child", "session.next.text.ended", { ...child, textID: "text_1", text: "Actual explanation" })
  // 决策尚未返回时，原工具状态、请求原文和真实解释已经能被实际normalizer消费。
  const live = normalizeSessionMessages("ses_child", store.get("ses_child") ?? [])
  expect(live.messages.map((message) => message.id)).toEqual(["msg_request", "msg_request_b", "msg_answer", "msg_answer_b"])
  expect(live.messages.find((message) => message.id === "msg_answer")).toMatchObject({ parentID: "msg_request" })
  expect(live.messages.filter((message) => message.role === "assistant").every((message) => message.time.completed === undefined)).toBe(true)
  expect(live.parts.get("msg_request")?.[0]).toMatchObject({ text: "system: exact policy\nuser: exact evidence", synthetic: false })
  expect(live.parts.get("msg_answer")?.map((part) => part.type)).toEqual(["reasoning", "text"])
  expect(normalizeSessionMessages("ses_parent", store.get("ses_parent") ?? []).parts.get("msg_parent")?.[0]).toMatchObject({ state: { metadata: { autoReview: review } } })
  apply("ses_child", "session.next.reasoning.started", { ...child, reasoningID: "thought_2" })
  apply("ses_child", "session.next.reasoning.delta", { ...child, reasoningID: "thought_2", delta: "Second real reasoning" })
  const decision = { ...child, callID: "decision" }
  apply("ses_child", "session.next.tool.input.started", { ...decision, name: "permission_review_decision" })
  apply("ses_child", "session.next.tool.input.delta", { ...decision, delta: JSON.stringify(assessment) })
  apply("ses_child", "session.next.tool.input.ended", { ...decision, text: JSON.stringify(assessment) })
  apply("ses_child", "session.next.tool.called", { ...decision, tool: "permission_review_decision", input: assessment, provider: { executed: false } })
  apply("ses_child", "session.next.tool.success", { ...decision, structured: { ...assessment, reviewID: "review_1" }, content: [{ type: "text", text: JSON.stringify(assessment) }], provider: { executed: false } })
  apply("ses_child", "session.next.step.ended", { ...child, finish: "tool-calls", cost: 0, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } } })
  apply("ses_parent", "session.next.tool.progress", { ...parent, structured: { autoReview: { ...review, status: "allowed", result: assessment } }, content: [] })
  apply("ses_parent", "session.next.tool.progress", { ...parent, structured: { output: "real output" }, content: [{ type: "text", text: "real output" }] })
  apply("ses_parent", "session.next.tool.success", { ...parent, structured: {}, content: [{ type: "text", text: "real output" }], provider: { executed: false } })
  const complete = normalizeSessionMessages("ses_child", store.get("ses_child") ?? [])
  expect(complete.parts.get("msg_answer")?.[2]).toMatchObject({ type: "reasoning", text: "Second real reasoning" })
  expect(complete.parts.get("msg_answer")?.[3]).toMatchObject({ type: "tool", state: { status: "completed", metadata: { ...assessment, reviewID: "review_1" } } })
  expect(complete.messages.some((message) => message.role === "assistant" && message.id === "msg_answer_b" && message.time.completed === undefined)).toBe(true)
  expect(normalizeSessionMessages("ses_parent", store.get("ses_parent") ?? []).parts.get("msg_parent")?.[0]).toMatchObject({ state: { status: "completed", output: "real output", metadata: { autoReview: { status: "allowed", sessionID: "ses_child" } } } })
  // 空正文仍是零输出；失败保留此前进度和审查，迟到用量不能把取消改成成功。
  const empty = { assistantMessageID: "msg_parent", callID: "empty" }
  apply("ses_parent", "session.next.tool.input.started", { ...empty, name: "bash" })
  apply("ses_parent", "session.next.tool.called", { ...empty, tool: "bash", input: {}, provider: { executed: false } })
  apply("ses_parent", "session.next.tool.success", { ...empty, structured: { empty: true }, content: [], provider: { executed: false } })
  expect(normalizeSessionMessages("ses_parent", store.get("ses_parent") ?? []).parts.get("msg_parent")?.[1]).toMatchObject({ state: { status: "completed", output: "", metadata: { empty: true } } })
  const denied = { assistantMessageID: "msg_parent", callID: "denied" }
  apply("ses_parent", "session.next.tool.input.started", { ...denied, name: "bash" })
  apply("ses_parent", "session.next.tool.called", { ...denied, tool: "bash", input: {}, provider: { executed: false } })
  apply("ses_parent", "session.next.tool.progress", { ...denied, structured: { autoReview: { ...review, status: "denied" } }, content: [{ type: "text", text: "partial result" }] })
  apply("ses_parent", "session.next.tool.failed", { ...denied, error: { type: "unknown", message: "review denied" }, provider: { executed: false } })
  const failed = normalizeSessionMessages("ses_parent", store.get("ses_parent") ?? [])
  expect(failed.parts.get("msg_parent")?.[2]).toMatchObject({ state: { status: "error", metadata: { autoReview: { status: "denied", sessionID: "ses_child" } } } })
  expect(store.get("ses_parent")?.find((message) => message.type === "assistant")).toMatchObject({ content: [{}, {}, { state: { content: [{ type: "text", text: "partial result" }] } }] })
  apply("ses_parent", "session.next.step.failed", { assistantMessageID: "msg_parent", aborted: true, error: { type: "unknown", message: "cancelled" } })
  apply("ses_parent", "session.next.step.ended", { assistantMessageID: "msg_parent", finish: "stop", cost: 1, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } } })
  expect(normalizeSessionMessages("ses_parent", store.get("ses_parent") ?? []).messages.find((message) => message.id === "msg_parent")).toMatchObject({ finish: "error", error: { name: "MessageAbortedError" }, cost: 1 })
  // 重新打开的源快照仍按实际片段ID更新；缺失身份只请求原有hydration，不猜ordinal。
  const restored = createV2SessionReducer()
  const amended = restored.reduce(store.get("ses_child") ?? [], wire("ses_child", "session.next.reasoning.ended", { ...child, reasoningID: "thought_2", text: "Complete second reasoning" }))
  expect(amended?.missing).toBeUndefined()
  expect(normalizeSessionMessages("ses_child", amended?.messages ?? []).parts.get("msg_answer")?.[2]).toMatchObject({ text: "Complete second reasoning" })
  expect(restored.reduce([], wire("ses_missing", "session.next.text.delta", { assistantMessageID: "msg_absent", textID: "text_missing", delta: "never misplaced" }))).toMatchObject({ missing: "msg_absent", touched: [] })
  apply("ses_child", "session.next.step.failed", { assistantMessageID: "msg_answer_b", aborted: true, error: { type: "unknown", message: "cancel B" } })
  expect(normalizeSessionMessages("ses_child", store.get("ses_child") ?? []).messages.find((message) => message.id === "msg_answer_b")).toMatchObject({ parentID: "msg_request_b", finish: "error", error: { name: "MessageAbortedError" } })
  expect(normalizeSessionMessages("ses_child", store.get("ses_child") ?? []).messages.find((message) => message.id === "msg_answer")).toMatchObject({ parentID: "msg_request", finish: "tool-calls" })
})

import { describe, expect, test } from "bun:test"
import Notifications from "@/cli/cmd/tui/feature-plugins/system/notifications"
import type { Event, PermissionRequest, QuestionRequest, Session, AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import type { TuiAttentionNotifyInput } from "@opencode-ai/plugin/tui"
import { createTuiPluginApi } from "../../../fixture/tui-plugin"

// 构造已完成的 assistant message，用于模拟正常完成路径
function completedAssistant(sessionID: string): AssistantMessage {
  return {
    id: "a1",
    sessionID,
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "u1",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

// 构造未完成的 assistant message，用于模拟 abort 路径
function pendingAssistant(sessionID: string): AssistantMessage {
  return {
    ...completedAssistant(sessionID),
    time: { created: 1 },
  }
}

async function setup(messages?: (sessionID: string) => Message[]) {
  const notifications: TuiAttentionNotifyInput[] = []
  const handlers = new Map<Event["type"], ((event: Event) => void)[]>()
  const session = (id: string, title: string, parentID?: string): Session => ({
    id,
    title,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    ...(parentID && { parentID }),
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  })
  const sessions: Record<string, Session> = {
    session: session("session", "Demo session"),
    subagent: session("subagent", "Subagent session", "session"),
    abort: session("abort", "Abort session"),
    timeout: session("timeout", "Timeout session"),
  }

  // 默认返回 user + 已完成的 assistant，模拟正常完成路径
  const defaultMessages = (sessionID: string) => [
    { id: "u1", sessionID, role: "user" as const, time: { created: 0 }, agent: "build", model: { providerID: "p", modelID: "m" }, tools: {}, parts: [] },
    completedAssistant(sessionID),
  ]

  await Notifications.tui(
    createTuiPluginApi({
      attention: {
        async notify(input) {
          notifications.push(input)
          return { ok: true, notification: true, sound: true }
        },
      },
      event: {
        on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => {
          const list = handlers.get(type) ?? []
          const wrapped = handler as (event: Event) => void
          list.push(wrapped)
          handlers.set(type, list)
          return () => {
            handlers.set(
              type,
              (handlers.get(type) ?? []).filter((item) => item !== wrapped),
            )
          }
        },
      },
      state: {
        session: {
          get: (sessionID: string) => sessions[sessionID],
          messages: messages ?? defaultMessages,
        },
      },
    }),
    undefined,
    {} as never,
  )

  return {
    notifications,
    emit(event: Event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
  }
}

function question(id: string, sessionID = "session"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [],
  }
}

function permission(id: string, sessionID = "session"): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

describe("internal notifications TUI plugin", () => {
  test("question and permission play their semantic sounds", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "permission.asked", properties: permission("permission-1") })

    // question/permission 需要用户输入：视觉通知 + 语义音效
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Question needs input",
        notification: { when: "blurred" },
        sound: { name: "question", when: "always" },
      },
      {
        title: "Demo session",
        message: "Permission needs input",
        notification: { when: "blurred" },
        sound: { name: "permission", when: "always" },
      },
    ])
  })

  test("dedupes pending questions and permissions until they are resolved", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", type: "question.asked", properties: question("question-1") })
    harness.emit({ id: "event-2", type: "question.asked", properties: question("question-1") })
    harness.emit({
      id: "event-3",
      type: "question.replied",
      properties: { sessionID: "session", requestID: "question-1", answers: [] },
    })
    harness.emit({ id: "event-4", type: "question.asked", properties: question("question-1") })

    harness.emit({ id: "event-5", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({ id: "event-6", type: "permission.asked", properties: permission("permission-1") })
    harness.emit({
      id: "event-7",
      type: "permission.replied",
      properties: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-8", type: "permission.asked", properties: permission("permission-1") })

    expect(harness.notifications).toHaveLength(4)
    expect(harness.notifications.map((n) => n.sound)).toEqual([
      { name: "question", when: "always" },
      { name: "question", when: "always" },
      { name: "permission", when: "always" },
      { name: "permission", when: "always" },
    ])
  })

  test("notifies done when an active session completes with a finished assistant", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("suppresses no-op idle without a preceding busy", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([])
  })

  test("subagent completion is silent", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "subagent", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.status",
      properties: { sessionID: "subagent", status: { type: "idle" } },
    })

    // subagent 完成不触发通知和音效
    expect(harness.notifications).toEqual([])
  })

  test("abort plays error not done: idle arrives before error due to Runner cancel ordering", async () => {
    // 模拟真实 abort 事件顺序：
    // Runner.cancel 先发 idle（assistant 尚未终态化），再 Fiber.interrupt 触发 halt 发 error
    const harness = await setup(() => [
      { id: "u1", sessionID: "abort", role: "user" as const, time: { created: 0 }, agent: "build", model: { providerID: "p", modelID: "m" }, tools: {}, parts: [] },
      pendingAssistant("abort"),
    ])

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "abort", status: { type: "busy" } },
    })
    // 第一个 idle：assistant 未 completed → 不消费 active，不播放 done
    harness.emit({
      id: "event-2",
      type: "session.status",
      properties: { sessionID: "abort", status: { type: "idle" } },
    })
    // session.error 到达：消费 active，播放 error
    harness.emit({
      id: "event-3",
      type: "session.error",
      properties: { sessionID: "abort", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
    })
    // 第二个 idle（halt 产生）：active 已被消费，忽略
    harness.emit({
      id: "event-4",
      type: "session.status",
      properties: { sessionID: "abort", status: { type: "idle" } },
    })

    // abort 完全静音：用户主动取消，不播放任何声音
    expect(harness.notifications).toEqual([
      {
        title: "Abort session",
        message: "Session aborted",
        notification: { when: "blurred" },
        sound: false,
      },
    ])
  })

  test("model error before idle plays error and suppresses done", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "session", error: { name: "UnknownError", data: { message: "boom" } } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    })

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session error",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("special-cases aborts and model response timeouts", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "abort", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "abort", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
    })
    harness.emit({
      id: "event-3",
      type: "session.status",
      properties: { sessionID: "timeout", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-4",
      type: "session.error",
      properties: { sessionID: "timeout", error: { name: "UnknownError", data: { message: "SSE read timed out" } } },
    })

    // abort 静音，timeout 仍播放 error
    expect(harness.notifications).toEqual([
      {
        title: "Abort session",
        message: "Session aborted",
        notification: { when: "blurred" },
        sound: false,
      },
      {
        title: "Timeout session",
        message: "Model stopped responding",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })

  test("duplicate session.error does not produce duplicate notifications", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    })
    harness.emit({
      id: "event-2",
      type: "session.error",
      properties: { sessionID: "session", error: { name: "UnknownError", data: { message: "boom" } } },
    })
    // 第二个 error：active 已被消费，不重复播放
    harness.emit({
      id: "event-3",
      type: "session.error",
      properties: { sessionID: "session", error: { name: "UnknownError", data: { message: "boom again" } } },
    })

    expect(harness.notifications).toHaveLength(1)
  })
})

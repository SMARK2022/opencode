import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(
  SessionNs.Service.use((svc) => svc.create({})),
  (session) => SessionNs.Service.use((svc) => svc.remove(session.id)).pipe(Effect.ignore),
)

// 创建一条用户消息 + 一个 text part；text 可省略表示无 text part
const createUserMessage = Effect.fn("SessionPreviewTest.createUserMessage")(function* (
  sessionID: SessionID,
  text: string | undefined,
  opts?: {
    time?: number
    hidden?: boolean
    synthetic?: boolean
    ignored?: boolean
    secondText?: string
  },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  const time = opts?.time ?? Date.now()

  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "test",
    model,
    tools: {},
    // hidden 消息应被预览端点排除，模拟用户撤销场景
    ...(opts?.hidden ? { hidden: { time, reason: "undo" as const } } : {}),
  } satisfies MessageV2.User)

  if (text !== undefined) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
      // synthetic/ignored part 不是用户可见内容，预览不应包含
      ...(opts?.synthetic ? { synthetic: true } : {}),
      ...(opts?.ignored ? { ignored: true } : {}),
    } satisfies MessageV2.TextPart)
  }

  // 同一消息可以有多个 text part，预览需按 part.id 顺序拼接
  if (opts?.secondText !== undefined) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: opts.secondText,
    } satisfies MessageV2.TextPart)
  }

  return id
})

// POST /session/preview 并解析 JSON 响应
function postPreview(body: unknown) {
  return Effect.promise(() =>
    Promise.resolve(
      Server.Default().app.request("/session/preview", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      Effect.promise(() => res.json() as Promise<Record<string, string[]>>).pipe(
        Effect.map((json) => ({ status: res.status, json })),
      ),
    ),
  )
}

describe("session preview endpoint", () => {
  it.instance(
    "returns preview lines for multiple sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const sessionA = yield* sessionScoped
        const sessionB = yield* sessionScoped

        // sessionA: 2 条用户消息
        yield* createUserMessage(sessionA.id, "hello world", { time: 1000 })
        yield* createUserMessage(sessionA.id, "second message", { time: 2000 })

        // sessionB: 1 条用户消息
        yield* createUserMessage(sessionB.id, "b message", { time: 3000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [sessionA.id, sessionB.id],
          limit: 2,
        })

        expect(status).toBe(200)
        // sessionA 应返回 2 条预览，正序（旧→新）：hello world(time=1000) 在前
        expect(json[sessionA.id]).toHaveLength(2)
        expect(json[sessionA.id][0]).toBe("hello world")
        expect(json[sessionA.id][1]).toBe("second message")
        // sessionB 应返回 1 条预览
        expect(json[sessionB.id]).toHaveLength(1)
        expect(json[sessionB.id][0]).toBe("b message")
      }),
    ),
    { git: true },
  )

  it.instance(
    "respects limit parameter",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "first", { time: 1000 })
        yield* createUserMessage(session.id, "second", { time: 2000 })
        yield* createUserMessage(session.id, "third", { time: 3000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 1,
        })

        expect(status).toBe(200)
        // limit=1 时只返回最近 1 条
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("third")
      }),
    ),
    { git: true },
  )

  it.instance(
    "excludes hidden user messages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // hidden 消息不应出现在预览中
        yield* createUserMessage(session.id, "hidden msg", { time: 1000, hidden: true })
        yield* createUserMessage(session.id, "visible msg", { time: 2000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("visible msg")
      }),
    ),
    { git: true },
  )

  it.instance(
    "excludes synthetic and ignored text parts",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "synthetic text", { time: 1000, synthetic: true })
        yield* createUserMessage(session.id, "ignored text", { time: 2000, ignored: true })
        yield* createUserMessage(session.id, "normal text", { time: 3000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        // synthetic 和 ignored 的消息不产出预览，只返回正常消息
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("normal text")
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns empty object for empty sessionIDs",
    withoutWatcher(
      Effect.gen(function* () {
        const { status, json } = yield* postPreview({ sessionIDs: [], limit: 2 })

        expect(status).toBe(200)
        expect(Object.keys(json)).toHaveLength(0)
      }),
    ),
    { git: true },
  )

  it.instance(
    "silently omits non-existent sessionIDs",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "exists", { time: 1000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id, "ses_nonexistent123"],
          limit: 2,
        })

        expect(status).toBe(200)
        // 存在的 session 正常返回，不存在的静默省略
        expect(json[session.id]).toEqual(["exists"])
        expect(json["ses_nonexistent123"]).toBeUndefined()
      }),
    ),
    { git: true },
  )

  it.instance(
    "joins multiple text parts with space",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 同一消息包含 2 个 text part，预览应拼接
        yield* createUserMessage(session.id, "part1", { time: 1000, secondText: "part2" })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("part1 part2")
      }),
    ),
    { git: true },
  )

  it.instance(
    "normalizes whitespace in preview text",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 包含换行和多余空格的文本应被归一化
        yield* createUserMessage(session.id, "  hello\n\n  world   ", { time: 1000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("hello world")
      }),
    ),
    { git: true },
  )

  it.instance(
    "skips user messages without text parts and continues scanning",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 第一条用户消息无 text part（只有 role=user）
        yield* createUserMessage(session.id, undefined, { time: 1000 })
        // 第二条有 text part
        yield* createUserMessage(session.id, "has text", { time: 2000 })
        // 第三条也有 text part
        yield* createUserMessage(session.id, "also has text", { time: 3000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        // 无 text part 的消息被跳过，返回最近 2 条有文本的消息，正序（旧→新）
        expect(json[session.id]).toHaveLength(2)
        expect(json[session.id][0]).toBe("has text")
        expect(json[session.id][1]).toBe("also has text")
      }),
    ),
    { git: true },
  )

  it.instance(
    "omits sessions with no user messages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 不创建任何用户消息

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        // 无用户消息的 session 不包含在响应中
        expect(json[session.id]).toBeUndefined()
      }),
    ),
    { git: true },
  )

  it.instance(
    "excludes hidden text parts from otherwise visible messages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 消息本身不 hidden，但 text part 被 hidden（模拟 part 级撤销）
        const msgId = MessageID.ascending()
        yield* SessionNs.Service.use((svc) =>
          svc.updateMessage({
            id: msgId,
            sessionID: session.id,
            role: "user",
            time: { created: 1000 },
            agent: "test",
            model,
            tools: {},
          } satisfies MessageV2.User),
        )
        // hidden text part：消息可见但此 part 不可见，应被排除
        yield* SessionNs.Service.use((svc) =>
          svc.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: msgId,
            type: "text",
            text: "hidden part text",
            hidden: { time: 1000, reason: "undo" },
          } satisfies MessageV2.TextPart),
        )
        // 正常 text part
        yield* createUserMessage(session.id, "visible text", { time: 2000 })

        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
          limit: 2,
        })

        expect(status).toBe(200)
        // hidden part 的消息不产出预览（EXISTS 子查询要求至少 1 个可见 text part）
        expect(json[session.id]).toHaveLength(1)
        expect(json[session.id][0]).toBe("visible text")
      }),
    ),
    { git: true },
  )

  it.instance(
    "defaults limit to 2 when not provided",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "first", { time: 1000 })
        yield* createUserMessage(session.id, "second", { time: 2000 })
        yield* createUserMessage(session.id, "third", { time: 3000 })

        // 不传 limit，handler 应回退到默认值 2
        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
        })

        expect(status).toBe(200)
        // 正序（旧→新）：second(time=2000) 在前，third(time=3000) 在后
        expect(json[session.id]).toHaveLength(2)
        expect(json[session.id][0]).toBe("second")
        expect(json[session.id][1]).toBe("third")
      }),
    ),
    { git: true },
  )
})

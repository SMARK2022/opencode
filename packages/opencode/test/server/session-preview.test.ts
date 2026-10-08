import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"

import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// #366：预览端点测试走生产 HttpApi 路由树 + 进程内 Node HTTP server，
// 与 session-messages.test.ts 同构：先经 SessionNs.node 写入 V1 消息行，
// 再由 HTTP 端点读取，验证 SQL 窗口函数查询与消息读取路径等价。
// [local-smark] 测试矩阵：写入 N 个 session × 多条用户/助手消息后调用预览端点，
// 覆盖排序（新→旧）、hidden/synthetic 过滤、limit 截断、空 session 省略四个契约。
const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

// [local-smark] Windows 下 file watcher 与测试写库竞争会放大用例时延，
// 仅在 win32 禁用 watcher——Linux/macOS CI 保持默认接线以覆盖真实路径。
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

const sessionScoped = Effect.acquireRelease(SessionNs.Service.use((svc) => svc.create({})), (session) =>
  SessionNs.Service.use((svc) => svc.remove(session.id)).pipe(Effect.ignore),
)

// 创建一条用户消息 + 一个 text part；text 可省略表示无 text part。
// opts 控制 hidden/synthetic/ignored/secondText 特征，覆盖预览过滤全部分支：
// - hidden 消息体与 hidden part 都应被 SQL EXISTS/谓词排除
// - synthetic/ignored part 不是用户可见内容，预览不应包含
// - secondText 模拟同一消息多个 text part，验证 part.id 顺序拼接
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
  } satisfies SessionV1.User)

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
    } satisfies SessionV1.TextPart)
  }

  // 同一消息可以有多个 text part，预览需按 part.id 顺序拼接
  if (opts?.secondText !== undefined) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: opts.secondText,
    } satisfies SessionV1.TextPart)
  }

  return id
})

// POST /session/preview 并解析 JSON 响应；directory 头由 requestInDirectory
// 注入，使 workspace routing 中间件把请求路由到当前测试实例，与
// session-messages.test.ts 的 requestInDirectory 用法保持一致。
function postPreview(body: unknown) {
  return TestInstance.pipe(
    Effect.flatMap((test) =>
      requestInDirectory("/session/preview", test.directory, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
    Effect.flatMap((res) =>
      res.json.pipe(
        Effect.map((json) => ({ status: res.status, json: json as Record<string, string[]> })),
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
        // [local-smark] sessionA 应返回 2 条预览，正序（旧→新）
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
        // hidden 消息不应出现在预览中（json_type(data,'$.hidden') IS NULL 排除）
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
        // synthetic 和 ignored 的消息不产出预览（EXISTS/join 谓词双重排除），
        // 只返回正常消息
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
        // handler 对空数组提前短路，不执行 SQL 直接返回空对象
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
        // 存在的 session 正常返回；IN 子句对不存在的 id 无匹配行，静默省略
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
        // 同一消息包含 2 个 text part，预览应拼成 "part1 part2"；
        // SQL 侧用子查询 ORDER BY part_id 喂入 group_concat 保证顺序
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
        // 包含换行和多余空格的文本应被归一化，与 textFromUserMessage 对齐
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
        // 第一条用户消息无 text part（只有 role=user）：EXISTS 子查询
        // 不产出排名行，后续有文本的消息仍按序占位（与旧分页扫描行为一致）
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
        // 无 text part 的消息被跳过；正序返回最近 2 条有文本的消息
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
        // 无用户消息的 session 不在响应中（结果按 session_id 分组聚合）
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
        // 消息本身不 hidden，但 text part 被 hidden（模拟 part 级撤销）：
        // EXISTS 要求至少一个可见 text part，全部 part 隐藏时整条消息跳过
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
          } satisfies SessionV1.User),
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
          } satisfies SessionV1.TextPart),
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

  // 等价护栏：钉住「time_created 相同由 message.id 定序」的既有排序合同，
  // 防止预览 SQL 重写后等时消息顺序漂移（与既有修复的三元组排序一致）
  it.instance(
    "orders equal-timestamp messages by id and returns old-to-new",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        // 等时戳：id 大者更新；输出保持旧→新
        yield* createUserMessage(session.id, "older same-time", { time: 1000 })
        yield* createUserMessage(session.id, "newer same-time", { time: 1000 })

        const { status, json } = yield* postPreview({ sessionIDs: [session.id], limit: 2 })

        expect(status).toBe(200)
        expect(json[session.id]).toEqual(["older same-time", "newer same-time"])
      }),
    ),
    { git: true },
  )

  // 等价护栏：text part 的拼接顺序由 part.id 决定而非插入顺序；
  // 逆序插入时仍按 id 升序拼接
  it.instance(
    "joins text parts by part id even when inserted in reverse order",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const svc = yield* SessionNs.Service
        const msgId = MessageID.ascending()
        yield* svc.updateMessage({
          id: msgId,
          sessionID: session.id,
          role: "user",
          time: { created: 1000 },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        // 先生成两个有序 PartID，再逆序落库
        const first = PartID.ascending()
        const second = PartID.ascending()
        yield* svc.updatePart({
          id: second,
          sessionID: session.id,
          messageID: msgId,
          type: "text",
          text: "second-by-id",
        } satisfies SessionV1.TextPart)
        yield* svc.updatePart({
          id: first,
          sessionID: session.id,
          messageID: msgId,
          type: "text",
          text: "first-by-id",
        } satisfies SessionV1.TextPart)

        const { status, json } = yield* postPreview({ sessionIDs: [session.id], limit: 2 })

        expect(status).toBe(200)
        expect(json[session.id]).toEqual(["first-by-id second-by-id"])
      }),
    ),
    { git: true },
  )

  // 等价护栏：最新 user 消息不可见（hidden）时，limit 作用于过滤后的可见序列，
  // 必须回退到更早的可见消息而不是返回空
  it.instance(
    "falls back to an earlier visible message when the latest is hidden",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "visible earlier", { time: 1000 })
        yield* createUserMessage(session.id, "hidden latest", { time: 2000, hidden: true })

        const { status, json } = yield* postPreview({ sessionIDs: [session.id], limit: 1 })

        expect(status).toBe(200)
        expect(json[session.id]).toEqual(["visible earlier"])
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

        // 不传 limit，handler 应回退到默认值 2（与 TUI 预览行数一致）
        const { status, json } = yield* postPreview({
          sessionIDs: [session.id],
        })

        expect(status).toBe(200)
        expect(json[session.id]).toHaveLength(2)
        // [local-smark] 正序：旧→新
        expect(json[session.id][0]).toBe("second")
        expect(json[session.id][1]).toBe("third")
      }),
    ),
    { git: true },
  )

  // 输入域护栏：公开 PreviewPayload 的 sessionIDs 是普通字符串数组（无唯一性约束），
  // 旧窗口 SQL 的 IN 查询对重复 ID 是集合语义；逐 session 循环必须保持同一语义，
  // 否则同一 session 的预览被重复追加且可突破 limit
  it.instance(
    "deduplicates repeated sessionIDs like the legacy IN query",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "first", { time: 1000 })
        yield* createUserMessage(session.id, "second", { time: 2000 })

        const repeated = yield* postPreview({
          sessionIDs: [session.id, session.id],
          limit: 1,
        })
        const single = yield* postPreview({
          sessionIDs: [session.id],
          limit: 1,
        })

        expect(repeated.status).toBe(200)
        // 集合语义：重复 ID 与单 ID 响应一致，每条消息只出现一次且不超过 limit
        expect(repeated.json).toEqual(single.json)
        expect(repeated.json[session.id]).toEqual(["second"])
      }),
    ),
    { git: true },
  )

  // 输入域护栏：schema 接受 [1,10] 内 Number（含 1.5）；旧实现 msg_rn <= limit
  // 对非整数取 floor 行数（整数排名），新实现必须保持同一已接受输入语义
  it.instance(
    "treats a fractional limit with the floor semantics of msg_rn <= limit",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* createUserMessage(session.id, "first", { time: 1000 })
        yield* createUserMessage(session.id, "second", { time: 2000 })

        const fractional = yield* postPreview({ sessionIDs: [session.id], limit: 1.5 })
        const floored = yield* postPreview({ sessionIDs: [session.id], limit: 1 })

        expect(fractional.status).toBe(200)
        expect(fractional.json).toEqual(floored.json)
        expect(fractional.json[session.id]).toEqual(["second"])
      }),
    ),
    { git: true },
  )
})
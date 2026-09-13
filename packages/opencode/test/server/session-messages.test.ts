import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import type { Snapshot } from "@/snapshot"
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Storage.node 需显式入组：httpapi 的 diff 读取与测试写入共用同一 storage 实例；
// Database.node 供 cold 探针直接读取 cold_ref（freezeOwner 消费同层 sync 事务）。
const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([SessionNs.node, Storage.node, Database.node])), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
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

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
  parts = true,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        // 纯条数边界不需要逐条Part；其他用例默认仍构建完整消息/部件。
        if (!parts) return id
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

function request(path: string, init?: RequestInit) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory, init)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const database = yield* Database.Service
        const created = Date.now()
        // 本例只测分页边界：一次预约建立520条真实投影行，不让逐条事件写入耗尽原30秒预算。
        yield* Database.withSync(database, (sync) => sync.insert(MessageTable).values(
          Array.from({ length: 520 }, (_, index) => ({
            id: MessageID.ascending(), session_id: session.id, time_created: created + index, time_updated: created + index,
            data: { role: "user" as const, time: { created: created + index }, agent: "test", model, tools: {} },
          })),
        ).run())

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )

  it.instance(
    "caps TUI diffs without changing the complete diff contract",
    withoutWatcher(
      Effect.gen(function* () {
        // 请求经 requestInDirectory 携带实例目录；viewer 请求只是同一 transport 的更浅投影。
        const session = yield* sessionScoped
        const visible = Array.from({ length: 101 }, (_, index) => ({
          file: `file-${index}.ts`,
          patch: `patch-${index}`,
          additions: index + 1,
          deletions: index,
          status: "modified" as const,
        }))
        // legacy/imported 项可缺 file；默认合同必须保留它，但 TUI totals/cap 只能统计真正可显示的文件行。
        // 将它放在首项可证明 viewer 在 slice 前归一化，而不是截断后依赖 plugin 再过滤。
        // 900/800 是独立干扰值；若隐藏项误入 totals，worked values 5151/5050 会立即失配。
        const diffs: Snapshot.FileDiff[] = [{ additions: 900, deletions: 800 }, ...visible]
        yield* Storage.Service.use((storage) => storage.write(["session_diff", session.id], diffs))

        const complete = yield* request(`/session/${session.id}/diff`)
        // 默认请求不带 viewer header：完整 102 项含 legacy 项与 patch 是不变合同。
        expect(complete.status).toBe(200)
        const completeBody = yield* json<Snapshot.FileDiff[]>(complete)
        expect(completeBody).toHaveLength(102)
        expect(completeBody[0]).toEqual({ additions: 900, deletions: 800 })

        const projected = yield* request(`/session/${session.id}/diff`, {
          headers: { "x-opencode-tui-message-projection": "viewer" },
        })
        expect(projected.status).toBe(200)
        // HttpClientResponse headers 是小写 record；与 fetch Response.get 不同，用括号访问。
        expect(projected.headers["x-opencode-tui-total-files"]).toBe("101")
        expect(projected.headers["x-opencode-tui-total-additions"]).toBe("5151")
        expect(projected.headers["x-opencode-tui-total-deletions"]).toBe("5050")
        const body = yield* json<Snapshot.FileDiff[]>(projected)
        expect(body).toHaveLength(100)
        expect(body.at(-1)).toEqual({ file: "file-99.ts", additions: 100, deletions: 99, status: "modified" })
        expect(body.every((item) => item.file !== undefined)).toBe(true)
        expect(body.some((item) => item.patch !== undefined)).toBe(false)
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps cold user summaries out of TUI message pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const svc = yield* SessionNs.Service
        const messageID = MessageID.ascending()
        const patch = "+" + "large-summary-line\n".repeat(512)
        yield* svc.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model,
          tools: {},
          summary: {
            title: "large turn",
            body: "summary body",
            diffs: [{ file: "large.txt", patch, additions: 512, deletions: 0, status: "modified" }],
          },
        } satisfies SessionV1.User)
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "text",
          text: "visible message",
        } satisfies SessionV1.TextPart)

        const { db, sync } = yield* Database.Service
        // 真实 cold owner 让测试区分“跳过 Message thaw”和“完整 thaw 后仅删除响应字段”。
        // 同步冷事务也需预约驱动连接，不能与Effect reader在同一连接上交错执行。
        const outcome = yield* Database.withSync({ db, sync }, () =>
          ColdStorage.freezeOwner(sync, { type: "message", id: messageID, now: Date.now() + 1, olderThanMs: 0 }),
        )
        expect(outcome.type).toBe("frozen")
        const readColdRef = Effect.gen(function* () {
          // cold_ref 只读探针经同一 Effect db seam；不引入第二数据源。
          const row = yield* db
            .select({ value: MessageTable.cold_ref })
            .from(MessageTable)
            .where(eq(MessageTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
          return row?.value
        })
        const frozen = yield* readColdRef
        expect(frozen).toBeTruthy()

        const projected = yield* request(`/session/${session.id}/message?limit=1`, {
          headers: { "x-opencode-tui-message-projection": "viewer" },
        })
        expect(projected.status).toBe(200)
        const projectedBody = yield* json<SessionV1.WithParts[]>(projected)
        expect(projectedBody).toHaveLength(1)
        expect(projectedBody[0]?.info.role === "user" ? projectedBody[0].info.summary : undefined).toBeUndefined()
        expect(projectedBody[0]?.parts).toMatchObject([{ type: "text", text: "visible message" }])
        expect(yield* readColdRef).toBe(frozen)

        // 默认 bounded API 是 Web App/SDK 的完整合同；它必须返回并 thaw 同一份 summary。
        const complete = yield* request(`/session/${session.id}/message?limit=1`)
        expect(complete.status).toBe(200)
        const completeBody = yield* json<SessionV1.WithParts[]>(complete)
        expect(completeBody[0]?.info.role === "user" ? completeBody[0].info.summary : undefined).toMatchObject({
          title: "large turn",
          body: "summary body",
          diffs: [{ file: "large.txt", patch, additions: 512, deletions: 0, status: "modified" }],
        })
        expect(yield* readColdRef).toBeNull()
      }),
    ),
    { git: true },
  )

  it.instance(
    "viewer message pages drop duplicate tool patch fields without touching the complete contract",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const svc = yield* SessionNs.Service
        const messageID = MessageID.ascending()
        yield* svc.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        // [0624] 与 diff 逐字相同的 filediff.patch 是 viewer 投影唯一允许删除的重复字段。
        const patch = "+duplicate patch line\n".repeat(64)
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: "call_1",
          tool: "edit",
          state: {
            status: "completed",
            input: { filePath: "a.ts" },
            output: "Edit applied successfully.",
            title: "a.ts",
            metadata: { diff: patch, filediff: { file: "a.ts", patch, additions: 64, deletions: 0 }, diagnostics: {} },
            time: { start: 1, end: 2 },
          },
        } as never)

        const viewer = yield* request(`/session/${session.id}/message?limit=1`, {
          headers: { "x-opencode-tui-message-projection": "viewer" },
        })
        const viewerBody = yield* json<SessionV1.WithParts[]>(viewer)
        const viewerPart = viewerBody[0]?.parts[0]
        // viewer 只剪掉与 diff 逐字重复的 patch；diff、input、output 与轻量元数据必须保留。
        expect(
          viewerPart?.type === "tool" && viewerPart.state.status === "completed" ? viewerPart.state.metadata : undefined,
        ).toEqual({
          diff: patch,
          filediff: { file: "a.ts", additions: 64, deletions: 0 },
          diagnostics: {},
        })

        // 默认完整合同保持原样：同一份数据两份字段都在。
        const complete = yield* request(`/session/${session.id}/message?limit=1`)
        const completeBody = yield* json<SessionV1.WithParts[]>(complete)
        const completePart = completeBody[0]?.parts[0]
        expect(
          completePart?.type === "tool" && completePart.state.status === "completed"
            ? (completePart.state.metadata as { filediff?: { patch?: unknown } }).filediff?.patch
            : undefined,
        ).toBe(patch)
      }),
    ),
    { git: true },
  )
})

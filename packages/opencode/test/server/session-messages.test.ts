import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import type { Snapshot } from "@/snapshot"
import { ColdStorage } from "@/storage/cold"
import { Database } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { MessageTable } from "@/session/session.sql"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Storage.defaultLayer))

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

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
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
        } satisfies MessageV2.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies MessageV2.TextPart)
        return id
      }),
  )
})

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, init)))
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("session messages endpoint", () => {
  it.instance(
    "caps TUI diffs without changing the complete diff contract",
    withoutWatcher(
      Effect.gen(function* () {
        const test = yield* TestInstance
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
        const headers = { "x-opencode-directory": test.directory }

        const complete = yield* request(`/session/${session.id}/diff`, { headers })
        expect(complete.status).toBe(200)
        const completeBody = yield* json<Snapshot.FileDiff[]>(complete)
        expect(completeBody).toHaveLength(102)
        expect(completeBody[0]).toEqual({ additions: 900, deletions: 800 })

        const projected = yield* request(`/session/${session.id}/diff`, {
          headers: { ...headers, "x-opencode-tui-message-projection": "viewer" },
        })
        expect(projected.status).toBe(200)
        expect(projected.headers.get("x-opencode-tui-total-files")).toBe("101")
        expect(projected.headers.get("x-opencode-tui-total-additions")).toBe("5151")
        expect(projected.headers.get("x-opencode-tui-total-deletions")).toBe("5050")
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
        } satisfies MessageV2.User)
        yield* svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "text",
          text: "visible message",
        } satisfies MessageV2.TextPart)

        // 真实 cold owner 让测试区分“跳过 Message thaw”和“完整 thaw 后仅删除响应字段”。
        expect(
          ColdStorage.freezeOwner({ type: "message", id: messageID, now: Date.now() + 1, olderThanMs: 0 }).type,
        ).toBe("frozen")
        const coldRef = () =>
          Database.use(
            (db) =>
              db
                .select({ value: MessageTable.cold_ref })
                .from(MessageTable)
                .where(Database.eq(MessageTable.id, messageID))
                .get()?.value,
          )
        const frozen = coldRef()
        expect(frozen).toBeTruthy()

        const projected = yield* request(`/session/${session.id}/message?limit=1`, {
          headers: { "x-opencode-tui-message-projection": "viewer" },
        })
        expect(projected.status).toBe(200)
        const projectedBody = yield* json<MessageV2.WithParts[]>(projected)
        expect(projectedBody).toHaveLength(1)
        expect(projectedBody[0]?.info.role === "user" ? projectedBody[0].info.summary : undefined).toBeUndefined()
        expect(projectedBody[0]?.parts).toMatchObject([{ type: "text", text: "visible message" }])
        expect(coldRef()).toBe(frozen)

        // 默认 bounded API 是 Web App/SDK 的完整合同；它必须返回并 thaw 同一份 summary。
        const complete = yield* request(`/session/${session.id}/message?limit=1`)
        expect(complete.status).toBe(200)
        const completeBody = yield* json<MessageV2.WithParts[]>(complete)
        expect(completeBody[0]?.info.role === "user" ? completeBody[0].info.summary : undefined).toEqual({
          title: "large turn",
          body: "summary body",
          diffs: [{ file: "large.txt", patch, additions: 512, deletions: 0, status: "modified" }],
        })
        expect(coldRef()).toBeNull()
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<MessageV2.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(a.headers.get("link")).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<MessageV2.WithParts[]>(b)
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
        const body = yield* json<MessageV2.WithParts[]>(res)
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
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(res)
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
})

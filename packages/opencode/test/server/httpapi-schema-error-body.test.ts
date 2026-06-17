import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { PartTable } from "@opencode-ai/core/session/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { SchemaErrorMiddleware, schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

const projectedSessionLayer = Layer.mergeAll(Session.layer, SessionProjector.layer).pipe(
  Layer.provideMerge(Database.defaultLayer),
  Layer.provide(EventV2Bridge.layer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)
const CorruptSessionApi = HttpApi.make("corrupt-session").add(
  HttpApiGroup.make("corrupt-session").add(
    HttpApiEndpoint.get("messages", "/corrupt/session/:sessionID/message", {
      params: { sessionID: SessionID },
      success: Schema.Array(MessageV2.WithParts),
      error: HttpApiError.BadRequest,
    }),
  ),
).middleware(SchemaErrorMiddleware)
const corruptSessionHandlers = HttpApiBuilder.group(CorruptSessionApi, "corrupt-session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return handlers.handle("messages", (ctx) =>
      session.page({ sessionID: ctx.params.sessionID, limit: 80 }).pipe(
        Effect.map((page) => page.items),
        Effect.orDie,
      ),
    )
  }),
)
const corruptHttpLayer = HttpRouter.serve(
  HttpApiBuilder.layer(CorruptSessionApi).pipe(Layer.provide(corruptSessionHandlers), Layer.provide(schemaErrorLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provide(projectedSessionLayer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const itCorrupt = testEffect(Layer.mergeAll(projectedSessionLayer, corruptHttpLayer))

const text = (response: HttpClientResponse.HttpClientResponse) => response.text

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const seedCorruptStepFinishPart = Effect.gen(function* () {
  const session = yield* Session.Service
  const info = yield* session.create({})
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: info.id,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
  const partID = PartID.ascending()
  yield* session.updatePart({
    id: partID,
    sessionID: info.id,
    messageID: message.id,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  // Persist an impossible token value to mirror the corrupt row class that broke
  // session loading in the OMO/Windows bug. The response schema must reject it.
  const { db } = yield* Database.Service
  yield* db
    .update(PartTable)
    .set({
      data: {
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: null, reasoning: 0, cache: { read: 0, write: 0 } },
      } as never, // drizzle's .set() can't narrow the discriminated union
    })
    .where(eq(PartTable.id, partID))
    .run()
    .pipe(Effect.orDie)
  return info.id
})

describe("schema-rejection wire shape", () => {
  it.instance(
    "Payload schema rejection returns NamedError-shaped JSON, not empty",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory(SyncPaths.history, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aggregate: -1 }),
        })
        const body = yield* text(res)
        expect(res.status).toBe(400)
        expect(res.headers["content-type"] ?? "").toContain("application/json")
        const parsed = JSON.parse(body)
        expect(parsed).toMatchObject({
          name: "BadRequest",
          data: { kind: expect.stringMatching(/^(Body|Payload)$/) },
        })
        expect(parsed.data.message).toEqual(expect.any(String))
        expect(parsed.data.message.length).toBeGreaterThan(0)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "Query schema rejection returns NamedError-shaped JSON",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // /find/file?limit=999999 violates the limit constraint check.
        const url = `/find/file?query=foo&limit=999999&directory=${encodeURIComponent(test.directory)}`
        const res = yield* requestInDirectory(url, test.directory)
        const body = yield* text(res)
        expect(res.status).toBe(400)
        const parsed = JSON.parse(body)
        expect(parsed).toMatchObject({ name: "BadRequest", data: { kind: "Query" } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "v2 query schema rejection returns InvalidRequestError JSON",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory("/api/session?limit=0", test.directory)
        const parsed = JSON.parse(yield* text(res))
        expect(res.status).toBe(400)
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "Query" })
        expect(parsed.message).toEqual(expect.any(String))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejected request body never echoes back unbounded — message is capped",
    // Defense against DoS-amplification + secret-echo: Effect's Issue formatter
    // dumps the rejected `actual` verbatim. A multi-MB invalid array would
    // become a multi-MB 400 response and log line. Cap kicks in around 1KB.
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const huge = "X".repeat(50_000)
        const res = yield* requestInDirectory(SyncPaths.history, test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aggregate: huge }),
        })
        const body = yield* text(res)
        expect(res.status).toBe(400)
        // 1 KB cap + small JSON envelope ≈ <2 KB — never tens of KB.
        expect(body.length).toBeLessThan(2 * 1024)
        const parsed = JSON.parse(body)
        expect(parsed.data.message).not.toContain(huge)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  itCorrupt.instance(
    "response-encode failure: corrupted stored row returns NamedError-shaped JSON with field path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = yield* seedCorruptStepFinishPart
        const res = yield* requestInDirectory(`/corrupt/session/${sessionID}/message`, test.directory)
        const body = yield* text(res)
        expect(res.status).toBe(400)
        expect(res.headers["content-type"] ?? "").toContain("application/json")
        const parsed = JSON.parse(body)
        expect(parsed).toMatchObject({ name: "BadRequest", data: { kind: "Body" } })
        // Field path in data.message — what made this PR worth shipping.
        expect(parsed.data.message).toMatch(/output/)
      }),
    { config: { formatter: false, lsp: false } },
  )
})

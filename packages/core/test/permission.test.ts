import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { PermissionV1 } from "@opencode-ai/schema/permission-v1"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Config } from "@opencode-ai/core/config"
import { ConfigAutoReview } from "@opencode-ai/core/config/auto-review"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { PermissionReviewerSchema } from "@opencode-ai/core/permission/reviewer/schema"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

let reviewSettings = new Config.Info({})
let assessment: typeof PermissionReviewerSchema.Assessment.Type = { outcome: "allow", rationale: "bounded requested change", risk_level: "low", user_authorization: "high" }
const reviewRequests: LLMRequest[] = []
let reviewGate: Deferred.Deferred<void> | undefined
let reviewStarted: Deferred.Deferred<void> | undefined
let malformed = false
let reviewBeforeStream: Deferred.Deferred<void> | undefined
let reviewArrivals: Deferred.Deferred<void> | undefined
const reviewClient = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
  prepare: () => Effect.die("unused"),
  generate: () => Effect.die("reviewer must consume the actual provider stream"),
  stream: (request) => Stream.unwrap(Effect.gen(function* () {
    reviewRequests.push(request)
    if (reviewBeforeStream) {
      if (reviewArrivals && reviewRequests.length === 2) yield* Deferred.succeed(reviewArrivals, undefined)
      yield* Deferred.await(reviewBeforeStream)
    }
    // 在决策gate之前交付真实事件，断言中途投影而不是伪造最终助手对象。
    return Stream.make(
      LLMEvent.reasoningStart({ id: "review-reason" }),
      LLMEvent.reasoningDelta({ id: "review-reason", text: "Actual reviewer reasoning before decision." }),
      LLMEvent.reasoningEnd({ id: "review-reason" }),
      LLMEvent.textStart({ id: "review-text" }),
      LLMEvent.textDelta({ id: "review-text", text: "Checking the requested change." }),
      LLMEvent.textEnd({ id: "review-text" }),
    ).pipe(Stream.concat(Stream.unwrap(Effect.gen(function* () {
      if (reviewStarted) yield* Deferred.succeed(reviewStarted, undefined)
      if (reviewGate) yield* Deferred.await(reviewGate)
      return malformed ? Stream.empty : Stream.make(
        LLMEvent.toolCall({ id: "review", name: "permission_review_decision", input: assessment }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      )
    }))))
  })),
}))
const reviewModel = SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id: "review", provider: "test", route: OpenAIChat.route })))
const reviewConfig = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info: reviewSettings })]) }))

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current], [Config.node, reviewConfig],
      // 只替换模型与运输边界；Permission、reviewer、Schema 和事件仍使用真实实现。
      [SessionRunnerModel.node, reviewModel], [LayerNodePlatform.llmClient, reviewClient],
    ],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
  it.effect("routes native auto permissions through the isolated reviewer", () => Effect.gen(function* () {
    reviewSettings = new Config.Info({})
    reviewRequests.length = 0
    malformed = false
    reviewGate = undefined
    reviewStarted = undefined
    yield* setup([{ action: "*", resource: "*", effect: "auto" }])
    const service = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const progress: { type: string; reviewID: string }[] = []
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
      if (Schema.is(PermissionV1.Event.ReviewStarted)(event) || Schema.is(PermissionV1.Event.ReviewCompleted)(event)) progress.push({ type: event.type, reviewID: event.data.reviewID })
    }))
    yield* Effect.addFinalizer(() => unsubscribe)
    const evidence = yield* Database.Service
    const evidenceRows = [
      ...Array.from({ length: 45 }, (_, index) => ({
        id: SessionMessage.ID.make(`msg_evidence_${index}`), session_id: SessionV2.ID.make("ses_test"), type: "user" as const, seq: index + 1,
        data: { time: { created: index + 1 }, text: index === 0 ? "FIRST AUTHORIZATION" : `Follow-up ${index}` },
      })),
      {
        id: SessionMessage.ID.make("msg_evidence_assistant"), session_id: SessionV2.ID.make("ses_test"), type: "assistant" as const, seq: 46,
        data: { time: { created: 46 }, agent: "test", model: { id: "review", providerID: "test" },
          content: [{ type: "reasoning", id: "thought", text: "PRIVATE REASONING" }, { type: "text", id: "visible", text: "x".repeat(1100) }] },
      },
      { id: SessionMessage.ID.make("msg_evidence_synthetic"), session_id: SessionV2.ID.make("ses_test"), type: "synthetic" as const, seq: 47, data: { sessionID: SessionV2.ID.make("ses_test"), time: { created: 47 }, text: "SYNTHETIC AUTHORIZATION" } },
    ]
    yield* evidence.db.insert(SessionMessageTable).values(evidenceRows).run().pipe(Effect.orDie)
    const before = yield* sessions.context(SessionV2.ID.make("ses_test"))
    // 未启用 reviewer 的未知命令进入原生人工队列，已知只读操作仍走快速路径。
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => draft.update(AgentV2.ID.make("Auto"), (item) => { item.permissions = [{ action: "*", resource: "*", effect: "auto" }] }))
    const automatic = assertion({ agent: AgentV2.ID.make("Auto"), action: "bash", resources: ["git add ."], metadata: { command: "git add ." } })
    expect(yield* service.ask(automatic)).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
    expect(progress.map((event) => event.type)).toEqual(["permission.review.started", "permission.review.completed"])
    expect(progress[0]?.reviewID).toBeDefined()
    expect(progress[0]?.reviewID).toBe(progress[1]?.reviewID)
    const reviewDb = (yield* Database.Service).db
    const children = yield* reviewDb.select().from(SessionTable).where(eq(SessionTable.parent_id, automatic.sessionID)).all().pipe(Effect.orDie)
    expect(children).toHaveLength(1)
    const child = children[0]
    if (!child) return yield* Effect.die("Expected a durable reviewer child")
    const audit = yield* sessions.context(SessionV2.ID.make(child.id))
    expect(audit.some((message) => message.type === "synthetic" && message.text.includes(String(progress[0]?.reviewID)) && message.text.includes("FIRST AUTHORIZATION"))).toBe(true)
    // 审查助手明确引用真实请求，不能由同一child中消息的到达顺序推断。
    expect(audit.find((message) => message.type === "assistant")).toMatchObject({ metadata: { permissionReviewerRequestID: audit.find((message) => message.type === "synthetic")?.id, reviewID: progress[0]?.reviewID } })
    const decision = audit.flatMap((message) => message.type === "assistant" ? message.content : []).find((part) => part.type === "tool")
    expect(decision).toMatchObject({ name: "permission_review_decision", state: { status: "completed", input: assessment, structured: assessment } })
    const reviewText = JSON.stringify(reviewRequests[0]?.messages)
    expect(reviewText).toContain("FIRST AUTHORIZATION")
    expect(reviewText).toContain("Follow-up 44")
    expect(reviewText).toContain("shortened")
    expect(reviewText).not.toContain("PRIVATE REASONING")
    expect(reviewText).not.toContain("SYNTHETIC AUTHORIZATION")
    // 外部目录复用同一shell预检，不再为相同命令调用第二次模型。
    expect(yield* service.ask({ ...automatic, action: "external_directory", resources: ["/outside"], metadata: { action_kind: "shell", command: "git add ." } })).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
    reviewSettings = new Config.Info({ approvals_reviewer: "user" })
    const user = yield* service.ask({ ...automatic, metadata: { command: "git commit" } })
    expect(user.effect).toBe("ask")
    yield* service.reply({ requestID: user.id, reply: "once" })
    reviewRequests.length = 0
    reviewSettings = new Config.Info({})
    expect(yield* service.ask(assertion({ action: "bash", resources: ["git status"], metadata: { command: "git status" } }))).toMatchObject({ effect: "allow" })
    const pending = yield* service.ask(assertion({ action: "bash", resources: ["git add ."], metadata: { command: "git add ." } }))
    expect(pending.effect).toBe("ask")
    yield* service.reply({ requestID: pending.id, reply: "once" })
    expect(reviewRequests).toHaveLength(0)
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true }) })
    // 危险组合不等待模型，也不会产生可被用户误批准的 pending。
    const denied = yield* service.assert(assertion({ action: "bash", resources: ["git status", "rm -rf /"], metadata: { command: "git status && rm -rf /" } })).pipe(Effect.flip)
    expect(denied).toBeInstanceOf(PermissionV2.BlockedError)
    expect(denied.message).toContain("Do not retry the same outcome")
    expect(denied.message).toContain("Use a materially safer approach, or ask the user for explicit confirmation before attempting a risky operation.")
    expect(PermissionV2.autoDeniedMessage(denied)).toBe(denied.message)
    expect(reviewRequests).toHaveLength(0)
    const edit = assertion({ action: "edit", resources: ["src/a.ts"], metadata: { filepath: "/project/src/a.ts", diff: "-old\n+new" } })
    expect(yield* service.ask(edit)).toMatchObject({ effect: "allow" })
    expect(yield* service.ask(edit)).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
    expect(JSON.stringify(reviewRequests[0]?.tools)).toContain("permission_review_decision")
    expect(JSON.stringify(reviewRequests[0]?.tools)).not.toContain('"bash"')
    expect(JSON.stringify(reviewRequests[0]?.messages)).toContain("-old")
    // 同一路径的新编辑计划不能复用旧裁决；另一个 Session 也不能共享审批。
    expect(yield* service.ask({ ...edit, metadata: { ...edit.metadata, diff: "-old\n+other" } })).toMatchObject({ effect: "allow" })
    const database = yield* Database.Service
    yield* database.db.insert(SessionTable).values({ id: SessionV2.ID.make("ses_other"), project_id: Project.ID.global, slug: "other", directory: "/project", title: "other", version: "test", agent: "test" }).run().pipe(Effect.orDie)
    expect(yield* service.ask({ ...edit, sessionID: SessionV2.ID.make("ses_other") })).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(3)
    yield* setRules([{ action: "edit", resource: "*", effect: "deny" }])
    expect(yield* service.ask(edit)).toMatchObject({ effect: "deny" })
    expect(reviewRequests).toHaveLength(3)
    yield* setRules([{ action: "edit", resource: "*", effect: "auto" }, { action: "edit", resource: "manual", effect: "ask" }])
    const mixed = yield* service.ask({ ...edit, resources: ["src/a.ts", "manual"] })
    expect(mixed.effect).toBe("ask")
    yield* service.reply({ requestID: mixed.id, reply: "reject" })
    expect(yield* service.list()).toEqual([])
    // strict 强制只读操作也审查；结构错误按配置分别拒绝或交回人工。
    yield* setRules([{ action: "*", resource: "*", effect: "auto" }])
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true }) })
    expect(yield* service.ask(assertion({ action: "bash", resources: ["git status"], metadata: { command: "git status" } }))).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(5)
    malformed = true
    expect(yield* service.ask({ ...edit, metadata: { diff: "malformed" } })).toMatchObject({ effect: "deny" })
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true, fallback: "user" }) })
    const fallback = yield* service.ask(edit)
    expect(fallback.effect).toBe("ask")
    yield* service.reply({ requestID: fallback.id, reply: "reject" })
    malformed = false
    assessment = { ...assessment, outcome: "allow", risk_level: "critical" }
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true }) })
    expect(yield* service.ask({ ...edit, metadata: { diff: "critical" } })).toMatchObject({ effect: "deny" })
    assessment = { ...assessment, risk_level: "low" }
    // 完全相同的工具门禁也必须重复审查，空字符串写入同样携带有效负载。
    const external = { ...edit, action: "external_directory", resources: ["/outside/*"], metadata: { action_kind: "tool", tool: "write", operation: "write", content: "" } }
    const reviews = reviewRequests.length
    expect(yield* service.ask(external)).toMatchObject({ effect: "allow" })
    expect(yield* service.ask(external)).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(reviews + 2)
    expect(reviewRequests.at(-1)?.messages.flatMap((message) => message.content).filter((part) => part.type === "text").map((part) => part.text).join("\n")).toContain('"operation": "write"')
    const pathOnly = yield* service.ask({ ...external, metadata: { action_kind: "tool" } })
    expect(pathOnly.effect).toBe("ask")
    yield* service.reply({ requestID: pathOnly.id, reply: "reject" })
    // 取消终止模型且不创建pending；审计请求留在子会话，不污染父会话历史。
    reviewGate = yield* Deferred.make<void>()
    reviewStarted = yield* Deferred.make<void>()
    const fiber = yield* service.assert({ ...edit, metadata: { diff: "cancel" } }).pipe(Effect.forkScoped)
    yield* Deferred.await(reviewStarted)
    expect(progress.at(-1)?.type).toBe("permission.review.started")
    yield* Fiber.interrupt(fiber)
    reviewGate = undefined
    reviewStarted = undefined
    expect(yield* service.list()).toEqual([])
    expect(yield* sessions.context(SessionV2.ID.make("ses_test"))).toEqual(before)
    reviewSettings = new Config.Info({})
  }))

  // 真实事件驱动审查、原工具和终态投影，验证收益在模型返回前后都可观察。
  it.effect("persists live native review traces and keeps outcomes through tool settlement", () => Effect.gen(function* () {
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review" })
    assessment = { outcome: "allow", rationale: "bounded requested change", risk_level: "low", user_authorization: "high" }
    reviewRequests.length = 0
    reviewGate = yield* Deferred.make<void>()
    reviewStarted = yield* Deferred.make<void>()
    yield* setup([{ action: "*", resource: "*", effect: "auto" }])
    const service = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const publisher = createLLMEventPublisher(events, { sessionID: SessionV2.ID.make("ses_test"), agent: "test", model: { id: ModelV2.ID.make("review"), providerID: ProviderV2.ID.make("test") } })
    // 父工具来自真实publisher，审批引用与后续结果引用同一assistant/call身份。
    yield* publisher.publish(LLMEvent.toolCall({ id: "parent", name: "bash", input: { command: "git add ." } }))
    const assistantMessageID = yield* publisher.assistantMessageID("parent")
    const request = assertion({ action: "bash", resources: ["git add ."], metadata: { command: "git add ." }, source: { type: "tool", messageID: assistantMessageID, callID: "parent" } })
    const fiber = yield* service.ask(request).pipe(Effect.forkScoped)
    yield* Deferred.await(reviewStarted)
    const child = yield* database.db.select().from(SessionTable).where(eq(SessionTable.parent_id, request.sessionID)).get().pipe(Effect.orDie)
    expect(child).toBeDefined()
    if (!child) return yield* Effect.die("Expected durable reviewer child")
    const context = yield* sessions.context(SessionV2.ID.make(child.id))
    expect(context.some((message) => message.type === "synthetic" && message.metadata?.permissionReviewerRequest === true)).toBe(true)
    const parts = context.flatMap((message) => message.type === "assistant" ? message.content : [])
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", text: "Actual reviewer reasoning before decision." }),
      expect.objectContaining({ type: "text", text: "Checking the requested change." }),
    ]))
    expect((yield* sessions.message(assistantMessageID))?.message).toMatchObject({ content: [{ state: { status: "running", structured: { autoReview: { status: "reviewing", sessionID: child.id } } } }] })
    // 中途普通工具进度和最终结果都不得擦除审批，审批本身不等于工具执行结果。
    yield* Deferred.succeed(reviewGate, undefined)
    expect(yield* Fiber.join(fiber)).toMatchObject({ effect: "allow" })
    yield* events.publish(SessionEvent.Tool.Progress, {
      sessionID: request.sessionID, assistantMessageID, callID: "parent", timestamp: yield* DateTime.now,
      structured: { progress: "after-review" }, content: [],
    })
    expect((yield* sessions.message(assistantMessageID))?.message).toMatchObject({ content: [{ state: { structured: { autoReview: { status: "allowed", result: assessment } } } }] })
    yield* publisher.publish(LLMEvent.toolResult({
      id: "parent", name: "bash", result: { type: "text", value: "completed" },
      output: { structured: { actualOutput: true }, content: [{ type: "text", text: "completed" }] },
    }))
    expect((yield* sessions.message(assistantMessageID))?.message).toMatchObject({ content: [{ state: { status: "completed", structured: { actualOutput: true, autoReview: { status: "allowed", sessionID: child.id } } } }] })
    // 取消第二次审查保留真实残片和失败身份，不留永久reviewing或假成功。
    reviewGate = yield* Deferred.make<void>()
    reviewStarted = yield* Deferred.make<void>()
    yield* publisher.publish(LLMEvent.toolCall({ id: "parent-cancel", name: "bash", input: { command: "git commit -m test" } }))
    const cancel = yield* service.assert({ ...request, id: PermissionV2.ID.create(), resources: ["git commit -m test"], metadata: { command: "git commit -m test" }, source: { type: "tool", messageID: assistantMessageID, callID: "parent-cancel" } }).pipe(Effect.forkScoped)
    yield* Deferred.await(reviewStarted)
    yield* Fiber.interrupt(cancel)
    expect((yield* sessions.context(SessionV2.ID.make(child.id))).at(-1)).toMatchObject({ type: "assistant", finish: "error" })
    expect((yield* sessions.message(assistantMessageID))?.message).toMatchObject({ content: [{ state: { status: "completed" } }, { state: { status: "running", structured: { autoReview: { status: "failed", sessionID: child.id } } } }] })
    yield* publisher.failUnsettledTools("Tool execution interrupted", false, true)
    expect((yield* sessions.message(assistantMessageID))?.message).toMatchObject({ content: [{ state: { status: "completed" } }, { state: { status: "error", structured: { autoReview: { status: "failed" } } } }] })
    // 两个请求先写入，再同时交付解释，固定复现共享child下的交错。
    reviewRequests.length = 0
    reviewBeforeStream = yield* Deferred.make<void>()
    reviewArrivals = yield* Deferred.make<void>()
    reviewGate = yield* Deferred.make<void>()
    const visible = new Set<string>()
    const bothVisible = yield* Deferred.make<void>()
    const stop = yield* events.listen((event) => Effect.gen(function* () {
      if (!Schema.is(SessionEvent.Text.Ended)(event) || event.data.sessionID !== child.id) return
      visible.add(event.data.assistantMessageID)
      if (visible.size === 2) yield* Deferred.succeed(bothVisible, undefined)
    }))
    yield* Effect.addFinalizer(() => stop)
    for (const callID of ["parallel-a", "parallel-b"]) {
      yield* publisher.publish(LLMEvent.toolCall({ id: callID, name: "bash", input: { command: `git add ${callID}` } }))
    }
    const concurrentA = yield* service.ask({ ...request, id: PermissionV2.ID.create(), resources: ["git add parallel-a"], metadata: { command: "git add parallel-a" }, source: { type: "tool", messageID: assistantMessageID, callID: "parallel-a" } }).pipe(Effect.forkScoped)
    const concurrentB = yield* service.ask({ ...request, id: PermissionV2.ID.create(), resources: ["git add parallel-b"], metadata: { command: "git add parallel-b" }, source: { type: "tool", messageID: assistantMessageID, callID: "parallel-b" } }).pipe(Effect.forkScoped)
    yield* Deferred.await(reviewArrivals)
    const requests = (yield* sessions.context(SessionV2.ID.make(child.id))).filter((message) => message.type === "synthetic").slice(-2)
    expect(requests).toHaveLength(2)
    yield* Deferred.succeed(reviewBeforeStream, undefined)
    yield* Deferred.await(bothVisible)
    const active = (yield* sessions.context(SessionV2.ID.make(child.id))).filter((message) => message.type === "assistant" && !message.time.completed)
    expect(active).toHaveLength(2)
    expect(active.map((message) => message.metadata?.permissionReviewerRequestID).sort()).toEqual(requests.map((message) => message.id).sort())
    const requestA = requests.find((message) => message.text.includes('"callID":"parallel-a"'))
    const answerA = active.find((message) => message.metadata?.permissionReviewerRequestID === requestA?.id)
    const answerB = active.find((message) => message.id !== answerA?.id)
    expect(answerA).toBeDefined()
    expect(answerB).toBeDefined()
    // 取消A不关闭B；两者的终态都必须写回各自助手。
    yield* Fiber.interrupt(concurrentA)
    const cancelled = yield* sessions.context(SessionV2.ID.make(child.id))
    expect(cancelled.find((message) => message.id === answerA?.id)).toMatchObject({ finish: "error" })
    expect(cancelled.some((message) => message.type === "assistant" && message.id === answerB?.id && message.time.completed === undefined)).toBe(true)
    yield* Deferred.succeed(reviewGate, undefined)
    expect(yield* Fiber.join(concurrentB)).toMatchObject({ effect: "allow" })
    const settled = yield* sessions.context(SessionV2.ID.make(child.id))
    expect(settled.find((message) => message.id === answerA?.id)).toMatchObject({ finish: "error" })
    expect(settled.find((message) => message.id === answerB?.id)).toMatchObject({ finish: "tool-calls" })
    expect(yield* database.db.select().from(SessionTable).where(eq(SessionTable.parent_id, request.sessionID)).all().pipe(Effect.orDie)).toHaveLength(1)
    yield* publisher.failUnsettledTools("Test parent execution finished")
    reviewBeforeStream = undefined
    reviewArrivals = undefined
    reviewGate = undefined
    reviewStarted = undefined
    reviewSettings = new Config.Info({})
  }))
})

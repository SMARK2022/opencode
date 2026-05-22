import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
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
import { LLMClient, LLMEvent, LLMRequest, LLMResponse, Message, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { PermissionReviewerSchema } from "@opencode-ai/core/permission/reviewer/schema"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

let reviewSettings = new Config.Info({})
let assessment: typeof PermissionReviewerSchema.Assessment.Type = { outcome: "allow", rationale: "bounded requested change", risk_level: "low", user_authorization: "high" }
const reviewRequests: LLMRequest[] = []
let reviewGate: Deferred.Deferred<void> | undefined
let reviewStarted: Deferred.Deferred<void> | undefined
let malformed = false
const reviewClient = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
  prepare: () => Effect.die("unused"),
  stream: () => { throw new Error("review must not start a Session stream") },
  generate: (request) => Effect.gen(function* () {
    reviewRequests.push(request)
    if (reviewStarted) yield* Deferred.succeed(reviewStarted, undefined)
    if (reviewGate) yield* Deferred.await(reviewGate)
    return new LLMResponse({ message: Message.assistant([]), finishReason: "tool-calls", events: malformed ? [] : [
      LLMEvent.toolCall({ id: "review", name: "generate_object", input: assessment }),
    ] })
  }),
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
    const before = yield* sessions.context(SessionV2.ID.make("ses_test"))
    // 未启用 reviewer 的未知命令进入原生人工队列，已知只读操作仍走快速路径。
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => draft.update(AgentV2.ID.make("Auto"), (item) => { item.permissions = [{ action: "*", resource: "*", effect: "auto" }] }))
    const automatic = assertion({ agent: AgentV2.ID.make("Auto"), action: "bash", resources: ["git add ."], metadata: { command: "git add ." } })
    expect(yield* service.ask(automatic)).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
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
    expect(JSON.stringify(reviewRequests[0]?.tools)).toContain("generate_object")
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
    // 取消终止尚未完成的模型审查，不创建 pending，也不写入隐藏会话消息。
    reviewGate = yield* Deferred.make<void>()
    reviewStarted = yield* Deferred.make<void>()
    const fiber = yield* service.assert({ ...edit, metadata: { diff: "cancel" } }).pipe(Effect.forkScoped)
    yield* Deferred.await(reviewStarted)
    yield* Fiber.interrupt(fiber)
    reviewGate = undefined
    reviewStarted = undefined
    expect(yield* service.list()).toEqual([])
    expect(yield* sessions.context(SessionV2.ID.make("ses_test"))).toEqual(before)
    reviewSettings = new Config.Info({})
  }))
})

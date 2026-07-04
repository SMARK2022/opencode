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
import { SubagentPermissions } from "@opencode-ai/core/permission/subagent"
import { Config } from "@opencode-ai/core/config"
import { ConfigAutoReview } from "@opencode-ai/core/config/auto-review"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLMClient, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { Auth } from "@opencode-ai/llm/route"
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
import { eq, sql } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

let reviewSettings = new Config.Info({})
let assessment: typeof PermissionReviewerSchema.Assessment.Type = { outcome: "allow", rationale: "bounded requested change", risk_level: "low", user_authorization: "high" }
const reviewRequests: LLMRequest[] = []
const reviewModels: unknown[] = []
let reviewGate: Deferred.Deferred<void> | undefined
let reviewStarted: Deferred.Deferred<void> | undefined
let malformed = false
let reviewBeforeStream: Deferred.Deferred<void> | undefined
let reviewArrivals: Deferred.Deferred<void> | undefined
let reviewScript: Stream.Stream<LLMEvent>[] | undefined
let reviewOAuth = false
const reviewBodies: unknown[] = []
const reviewClient = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
  prepare: () => Effect.die("unused"),
  generate: () => Effect.die("reviewer must consume the actual provider stream"),
  stream: (request, onPrepared) => Stream.unwrap(Effect.gen(function* () {
    reviewRequests.push(request)
    // 真实协议lowering但不执行运输，分类必须观察与生产相同的prepared正文。
    const prepared = yield* LLMClient.prepare(request)
    reviewBodies.push(prepared.body)
    if (onPrepared) yield* onPrepared(prepared.body)
    // 只脚本化模型运输边界，协议、落盘、隐藏和权限裁决均执行真实实现。
    if (reviewScript) {
      const next = reviewScript.shift()
      if (!next) return yield* Effect.die("Unexpected reviewer retry")
      return next
    }
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
const reviewModel = Layer.succeed(SessionRunnerModel.Service, SessionRunnerModel.Service.of({ resolve: (session) => {
  reviewModels.push(session.model)
  // 真实reviewer仍执行，只在模型目录边界模拟已删除条目；默认解析及合法显式模型保持成功。
  if (session.model?.id === "removed-model") return Effect.fail(new SessionRunnerModel.ModelUnavailableError({
    providerID: session.model.providerID, modelID: session.model.id,
  }))
  return Effect.succeed({
    model: Model.make({ id: "review", provider: "test", route: reviewOAuth ? OpenAIResponses.route.with({ auth: Auth.none }) : OpenAIChat.route }),
    pricing: [{ input: 1, output: 2, cache: { read: 0.5, write: 1 } }],
    openaiOAuth: reviewOAuth,
  })
} }))
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
      // 通过真实Native转换和求值核对共享算法，不在测试内复制权限推导。
      const child: PermissionV2.Ruleset = [
        { action: "bash", resource: "*", effect: "allow" },
        { action: "bash", resource: "git push *", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "ask" },
        { action: "external_directory", resource: "/shared/*", effect: "allow" },
      ]
      const parent: PermissionV2.Ruleset = [
        { action: "bash", resource: "*", effect: "auto" },
        { action: "edit", resource: "*", effect: "auto" },
        { action: "external_directory", resource: "*", effect: "auto" },
        { action: "external_directory", resource: "/shared/*", effect: "allow" },
      ]
      const overlay = SubagentPermissions.derive({ parentAgentPermission: parent, parentSessionPermission: [], subagentPermission: child })
      expect(PermissionV2.evaluate("bash", "git status", child, overlay).effect).toBe("auto")
      expect(PermissionV2.evaluate("bash", "git push origin dev", child, overlay).effect).toBe("deny")
      expect(PermissionV2.evaluate("edit", "src/a.ts", child, overlay).effect).toBe("deny")
      expect(PermissionV2.evaluate("external_directory", "/shared/a", child, overlay).effect).toBe("allow")
      expect(PermissionV2.evaluate("external_directory", "/outside/a", child, overlay).effect).toBe("auto")
      const nested = SubagentPermissions.derive({ parentAgentPermission: child, parentSessionPermission: overlay, subagentPermission: child })
      expect(PermissionV2.evaluate("bash", "git status", child, nested).effect).toBe("auto")
      expect(PermissionV2.evaluate("bash", "git push origin dev", child, nested).effect).toBe("deny")
      // 通配关闭后的窄allow只被收紧；父会话grant不能反向放宽子ask。
      const narrow: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "deny" }, { action: "bash", resource: "git status", effect: "allow" }]
      const narrowed = SubagentPermissions.derive({ parentAgentPermission: parent, parentSessionPermission: [], subagentPermission: narrow })
      expect(PermissionV2.evaluate("bash", "git status", narrow, narrowed).effect).toBe("auto")
      expect(PermissionV2.evaluate("bash", "git push origin dev", narrow, narrowed).effect).toBe("deny")
      const manual: PermissionV2.Ruleset = [{ action: "read", resource: "*", effect: "ask" }]
      const grants = SubagentPermissions.derive({ parentAgentPermission: [], parentSessionPermission: [{ action: "read", resource: "*", effect: "allow" }], subagentPermission: manual })
      expect(PermissionV2.evaluate("read", "a", manual, grants).effect).toBe("ask")
      expect(PermissionV2.evaluate("task", "general", child, overlay).effect).toBe("deny")
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
      // 旧raw审批仍可使用；canonical规则和原始凭证deny都保持实际裁决权。
      const command = "GITHUB_TOKEN=x git push --force"
      const bash = assertion({ action: "bash", resources: [command], save: [command], metadata: {
        command, canonical_patterns: ["git push --force"], raw_patterns: [command],
      } })
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: [command] })
      yield* setRules([])
      expect(yield* service.ask(bash)).toMatchObject({ effect: "allow" })
      for (const effect of ["allow", "auto", "ask"] as const) {
        yield* setRules([{ action: "bash", resource: "GITHUB_TOKEN=*", effect: "deny" }, { action: "bash", resource: "*", effect }])
        expect(yield* service.ask(bash)).toMatchObject({ effect: "deny" })
      }
      yield* setRules([{ action: "bash", resource: "*", effect: "allow" }, { action: "bash", resource: "git push --force*", effect: "deny" }])
      expect(yield* service.ask(bash)).toMatchObject({ effect: "deny" })
      // 原始证据不参与普通allow/ask匹配；这些仍按canonical规则last-match-wins。
      const fresh = { ...bash, resources: ["CI=true git push --force"], metadata: { command: "CI=true git push --force", canonical_patterns: ["git push --force"], raw_patterns: ["CI=true git push --force"] } }
      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }, { action: "bash", resource: "git push --force*", effect: "allow" }])
      expect(yield* service.ask(fresh)).toMatchObject({ effect: "allow" })
      yield* setRules([{ action: "bash", resource: "git push --force*", effect: "ask" }])
      expect(yield* service.ask(fresh)).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: PermissionV2.ID.create("per_test"), reply: "once" })
      reviewSettings = new Config.Info({})
      reviewRequests.length = 0
      malformed = false
      reviewGate = undefined
      reviewStarted = undefined
      yield* setRules([{ action: "bash", resource: "git push --force*", effect: "auto" }])
      expect(yield* service.ask(fresh)).toMatchObject({ effect: "allow" })
      expect(reviewRequests).toHaveLength(1)
      expect(JSON.stringify(reviewRequests[0])).toContain("force push requires explicit approval")
      expect(yield* service.list()).toEqual([])
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
      // always只释放仍然有效的批准：挂起后新增raw硬拒不能被同一次保存的通配授权跨过。
      const command = "GITHUB_TOKEN=x git push --force"
      const permit = PermissionV2.ID.create("per_bash_permit")
      const blocked = PermissionV2.ID.create("per_bash_blocked")
      const plain = PermissionV2.ID.create("per_bash_plain")
      yield* setRules([])
      expect(yield* service.ask(assertion({ id: permit, action: "bash", resources: ["pwd"], save: ["*"] }))).toMatchObject({ effect: "ask" })
      expect(yield* service.ask(assertion({ id: blocked, action: "bash", resources: [command], metadata: {
        command, canonical_patterns: ["git push --force"], raw_patterns: [command],
      } }))).toMatchObject({ effect: "ask" })
      expect(yield* service.ask(assertion({ id: plain, action: "bash", resources: ["git status"] }))).toMatchObject({ effect: "ask" })
      yield* setRules([{ action: "bash", resource: "GITHUB_TOKEN=*", effect: "deny" }, { action: "bash", resource: "*", effect: "allow" }])
      yield* service.reply({ requestID: permit, reply: "always" })
      expect((yield* service.list()).map((request) => request.id)).toEqual([blocked])
      expect(yield* service.get(plain)).toBeUndefined()
      yield* service.reply({ requestID: blocked, reply: "reject" })
      expect(yield* service.list()).toEqual([])
    }),
  )
  it.effect("routes native auto permissions through the isolated reviewer", () => Effect.gen(function* () {
    reviewSettings = new Config.Info({})
    reviewRequests.length = 0
    reviewModels.length = 0
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
    // 验证的是实际 reviewer 到 resolver 的输入，不能用固定返回模型掩盖来源漂移。
    yield* evidence.db.update(SessionTable).set({ model: {
      id: ModelV2.ID.make("parent-model"), providerID: ProviderV2.ID.make("parent-provider"),
    } }).where(eq(SessionTable.id, SessionV2.ID.make("ses_test"))).run().pipe(Effect.orDie)
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
    // auto准入进入同一隔离审查，显式user与已知只读快速路径仍分别保留。
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => draft.update(AgentV2.ID.make("auto"), (item) => { item.permissions = [{ action: "*", resource: "*", effect: "auto" }] }))
    const automatic = assertion({ agent: AgentV2.ID.make("auto"), action: "bash", resources: ["git add ."], metadata: { command: "git add ." } })
    expect(yield* service.ask(automatic)).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
    expect(reviewModels[0]).toMatchObject({ id: "parent-model", providerID: "parent-provider" })
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
    // 外部目录成为独立谨慎边界，即使同一命令已审查也要评估该路径访问。
    // 显式配置仍覆盖父模型；只改变模型来源，不改变外部目录审批语义。
    reviewSettings = new Config.Info({ auto_review: new ConfigAutoReview.Info({ model: "override/reviewer" }) })
    expect(yield* service.ask({ ...automatic, action: "external_directory", resources: ["/outside"], metadata: { action_kind: "shell", command: "git add ." } })).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(2)
    expect(reviewModels[1]).toMatchObject({ id: "reviewer", providerID: "override" })
    const stale = { id: ModelV2.ID.make("removed-model"), providerID: ProviderV2.ID.make("parent-provider") }
    yield* evidence.db.update(SessionTable).set({ model: stale }).where(eq(SessionTable.id, SessionV2.ID.make("ses_test"))).run().pipe(Effect.orDie)
    reviewSettings = new Config.Info({ auto_review: new ConfigAutoReview.Info({ fallback: "deny" }) })
    const staleRequest = { ...automatic, action: "external_directory", resources: ["/stale"], metadata: { action_kind: "shell", command: "git add ." } }
    expect(yield* service.ask(staleRequest)).toMatchObject({ effect: "allow" })
    expect(reviewModels.at(-2)).toEqual({ ...stale, variant: "default" })
    expect(reviewModels.at(-1)).toBeUndefined()
    // 同样的不存在模型若来自显式配置就必须失败，不能悄悄改用默认提供者。
    reviewSettings = new Config.Info({ auto_review: new ConfigAutoReview.Info({ model: "parent-provider/removed-model", fallback: "deny" }) })
    expect(yield* service.ask({ ...staleRequest, resources: ["/explicit-stale"] })).toMatchObject({ effect: "deny" })
    expect(reviewRequests).toHaveLength(3)
    yield* evidence.db.update(SessionTable).set({ model: { id: ModelV2.ID.make("parent-model"), providerID: ProviderV2.ID.make("parent-provider") } }).where(eq(SessionTable.id, SessionV2.ID.make("ses_test"))).run().pipe(Effect.orDie)
    reviewSettings = new Config.Info({ approvals_reviewer: "user" })
    const user = yield* service.ask({ ...automatic, metadata: { command: "git commit" } })
    expect(user.effect).toBe("ask")
    yield* service.reply({ requestID: user.id, reply: "once" })
    reviewRequests.length = 0
    reviewSettings = new Config.Info({})
    expect(yield* service.ask(assertion({ action: "bash", resources: ["git status"], metadata: { command: "git status" } }))).toMatchObject({ effect: "allow" })
    // 普通edit有general快速路径；strict使本断言真实到达reviewer而非仅得到allow。
    reviewSettings = new Config.Info({ auto_review: new ConfigAutoReview.Info({ strict: true }) })
    yield* agents.transform(draft => draft.update(AgentV2.ID.make("reviewer_parent"), item => { item.permissions = [{ action: "edit", resource: "*", effect: "auto" }] }))
    const implicit = yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer_parent"), action: "edit", resources: ["src/implicit.ts"], metadata: { filepath: "/project/src/implicit.ts", diff: "-before\n+after" } }))
    expect(implicit.effect).toBe("allow")
    expect(yield* service.list()).toEqual([])
    expect(reviewRequests).toHaveLength(1)
    expect(JSON.stringify(reviewRequests[0]?.messages)).toContain("reviewer_parent")
    expect(yield* sessions.context(SessionV2.ID.make("ses_test"))).toEqual(before)
    // 普通代理的实际auto请求已完成；后续严格/失败回归仍从独立计数开始。
    reviewRequests.length = 0
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
    // 默认基础设施失败留给人工审批，显式deny仍终止；两者都不能直接执行工具。
    const defaultFallback = yield* service.ask({ ...edit, metadata: { diff: "malformed" } })
    expect(defaultFallback.effect).toBe("ask")
    yield* service.reply({ requestID: defaultFallback.id, reply: "reject" })
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true, fallback: "deny" }) })
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
    // 仅含路径的外部访问也进入同一reviewer，结果来自审查而非general直接放行。
    const pathOnly = yield* service.ask({ ...external, metadata: { action_kind: "tool" } })
    expect(pathOnly.effect).toBe("allow")
    expect(reviewRequests).toHaveLength(reviews + 3)
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
  it.effect("persists native reviewer prepared input breakdown and provider usage", () => Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "auto" }])
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review" })
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      reviewOAuth = false
      reviewScript = undefined
      reviewSettings = new Config.Info({})
    }))
    const permissions = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const database = yield* Database.Service
    for (const oauth of [false, true]) {
      reviewOAuth = oauth
      reviewRequests.length = 0
      reviewBodies.length = 0
      reviewScript = [Stream.make(
        LLMEvent.toolCall({ id: "review", name: "permission_review_decision", input: assessment }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: { inputTokens: 12, nonCachedInputTokens: 7, outputTokens: 7, reasoningTokens: 3, cacheReadInputTokens: 5 } }),
        LLMEvent.finish({ reason: "tool-calls" }),
      )]
      expect(yield* permissions.ask(assertion({ action: "bash", resources: [`git add usage-${oauth}.ts`], metadata: { command: `git add usage-${oauth}.ts` } }))).toMatchObject({ effect: "allow" })
      expect(reviewRequests).toHaveLength(1)
      const child = yield* database.db.select().from(SessionTable).where(eq(SessionTable.parent_id, SessionV2.ID.make("ses_test"))).get().pipe(Effect.orDie)
      if (!child) return yield* Effect.die("Expected durable reviewer child")
      const answer = (yield* sessions.context(SessionV2.ID.make(child.id))).findLast(message => message.type === "assistant")
      if (!answer || answer.type !== "assistant" || !answer.inputEstimate?.inputBreakdown) return yield* Effect.die("Expected persisted reviewer breakdown")
      // 验证同一助手中的确认快照和真实缓存/推理分栏，不能用估算值覆盖provider用量。
      expect(answer.tokens).toEqual({ input: 7, output: 4, reasoning: 3, cache: { read: 5, write: 0 } })
      expect(answer.cost).toBeCloseTo(23.5 / 1_000_000, 12)
      expect(answer.inputEstimate.confirmed).toBe(true)
      expect(answer.inputEstimate.bodyChars).toBe(JSON.stringify(reviewBodies[0]).length)
      const breakdown = answer.inputEstimate.inputBreakdown
      expect(breakdown.tools).toBeGreaterThan(0)
      expect(breakdown.messages.userText).toBeGreaterThan(0)
      expect(breakdown.messages.assistantText).toBe(0)
      // OAuth的策略正文只计instructions；JSON包装开销仍沿共享估算器分配。
      if (oauth) expect(breakdown.instructions).toBeGreaterThan(0)
      if (!oauth) {
        expect(breakdown.system).toBeGreaterThan(0)
        expect(breakdown.instructions).toBe(0)
      }
    }
  }))

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
    // 只拒绝父工具展示更新，审查子会话和真实deny仍完整落库。
    yield* publisher.publish(LLMEvent.toolCall({ id: "display-failure", name: "bash", input: { command: "git add display-failure" } }))
    assessment = { ...assessment, outcome: "deny" }
    yield* database.db.run(sql`CREATE TRIGGER reject_review_display BEFORE UPDATE ON session_message WHEN OLD.session_id = 'ses_test' BEGIN SELECT RAISE(ABORT, 'review display failure'); END`).pipe(Effect.orDie)
    yield* Effect.gen(function* () {
      const before = reviewRequests.length
      // 展示故障不能把有效拒绝变成人工pending，也不能触发额外模型重试。
      expect(yield* service.ask({ ...request, id: PermissionV2.ID.create(), resources: ["git add display-failure"], metadata: { command: "git add display-failure" }, source: { type: "tool", messageID: assistantMessageID, callID: "display-failure" } })).toMatchObject({ effect: "deny" })
      expect(reviewRequests).toHaveLength(before + 1)
      expect(yield* service.list()).toEqual([])
    }).pipe(Effect.ensuring(
      database.db.run(sql`DROP TRIGGER reject_review_display`).pipe(
        Effect.orDie,
        // 故障注入随本次检查释放，不污染后续协议和取消回归。
        Effect.andThen(Effect.sync(() => { assessment = { ...assessment, outcome: "allow" } })),
      ),
    ))

    reviewSettings = new Config.Info({})
  }))

  it.effect("repairs native reviewer protocol once while preserving hidden audit and usage", () => Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "auto" }])
    // 本例锁定协议重试及终局失败，默认人工回退已由上一真实权限用例覆盖。
    reviewSettings = new Config.Info({ approvals_reviewer: "auto_review", auto_review: new ConfigAutoReview.Info({ strict: true, fallback: "deny" }) })
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      reviewScript = undefined
      reviewSettings = new Config.Info({})
    }))
    const service = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const hiddenIDs: SessionMessage.ID[] = []
    const unsubscribe = yield* events.listen((event) => Schema.is(SessionEvent.MessagesHidden)(event)
      ? Effect.sync(() => { hiddenIDs.push(...event.data.messageIDs) }) : Effect.void)
    yield* Effect.addFinalizer(() => unsubscribe)
    const accepted = { outcome: "allow", rationale: "bounded protocol fixture", risk_level: "low", user_authorization: "high" }
    const text = (value: string) => Stream.make(
      LLMEvent.textStart({ id: "reply" }), LLMEvent.textDelta({ id: "reply", text: value }), LLMEvent.textEnd({ id: "reply" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { nonCachedInputTokens: 2, outputTokens: 1 } }),
      LLMEvent.finish({ reason: "stop" }),
    )
    const tool = (input: unknown) => Stream.make(
      LLMEvent.toolCall({ id: "decision", name: "permission_review_decision", input }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" }),
    )
    let sequence = 0
    const run = (script: Stream.Stream<LLMEvent>[]) => {
      reviewScript = script
      reviewRequests.length = 0
      return service.ask(assertion({ action: "edit", resources: ["src/protocol.ts"], metadata: { diff: `protocol-${++sequence}` } }))
    }
    expect(yield* run([text(JSON.stringify(accepted))])).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(1)
    const children = yield* database.db.select().from(SessionTable).where(eq(SessionTable.parent_id, SessionV2.ID.make("ses_test"))).all().pipe(Effect.orDie)
    expect(children).toHaveLength(1)
    const child = children[0]
    if (!child) return yield* Effect.die("Expected reviewer child")
    const childID = SessionV2.ID.make(child.id)
    const jsonAudit = yield* sessions.context(childID)
    expect(jsonAudit.flatMap((message) => message.type === "assistant" ? message.content : []).find((part) => part.type === "tool")).toMatchObject({
      name: "permission_review_decision", state: { status: "completed", structured: { ...accepted, source: "json_fallback" } },
    })
    // 合法deny不属于协议失败，不能以重试把拒绝变为放行。
    expect(yield* run([text(JSON.stringify({ ...accepted, outcome: "deny" }))])).toMatchObject({ effect: "deny" })
    expect(reviewRequests).toHaveLength(1)
    expect(hiddenIDs).toHaveLength(0)
    const malformedText = "I forgot to submit the decision tool."
    expect(yield* run([text(malformedText), tool(accepted)])).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(2)
    const prompts = reviewRequests.map((request) => request.messages.flatMap((message) => message.content).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"))
    expect(prompts[1]).toBe(`${prompts[0]}\n\nProtocol retry: the previous response did not submit the required permission_review_decision tool/function call. Reassess the same evidence and call permission_review_decision exactly once. Do not answer in prose or markdown.`)
    expect(hiddenIDs).toHaveLength(2)
    const hidden = yield* Effect.forEach(hiddenIDs, (id) => sessions.message(id))
    expect(hidden.map((record) => record?.message)).toMatchObject([
      { type: "synthetic", metadata: { permissionReviewerRequest: true, hidden: { reason: "permission-reviewer-protocol-retry" } } },
      { type: "assistant", finish: "error", tokens: { input: 2, output: 1 }, metadata: { permissionReviewerRequestID: hiddenIDs[0], hidden: { reason: "permission-reviewer-protocol-retry" } } },
    ])
    // 隐藏只影响普通历史；原始读取保留原文与已确认用量，runner也不能重放失败轮次。
    expect(JSON.stringify(hidden[1]?.message)).toContain(malformedText)
    expect((yield* sessions.context(childID)).some((message) => hiddenIDs.includes(message.id))).toBe(false)
    expect((yield* sessions.runnerContext(childID, 0)).some((message) => hiddenIDs.includes(message.id))).toBe(false)
    expect((yield* sessions.context(childID)).flatMap((message) => message.type === "assistant" ? message.content : []).some((part) => part.type === "tool" && part.state.status === "completed" && part.state.structured?.source === "tool_call")).toBe(true)
    expect(yield* run([tool({ outcome: "allow" }), tool(accepted)])).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(2)
    // 未完成参数的tool-error也须先闭合真实残片，再按同一协议修复一次。
    expect(yield* run([Stream.make(
      LLMEvent.toolInputStart({ id: "broken", name: "permission_review_decision" }),
      LLMEvent.toolInputDelta({ id: "broken", name: "permission_review_decision", text: "{bad" }),
      LLMEvent.toolError({ id: "broken", name: "permission_review_decision", message: "malformed input" }),
    ), tool(accepted)])).toMatchObject({ effect: "allow" })
    expect(reviewRequests).toHaveLength(2)
    // Markdown中的合法对象仍不是整段JSON；第二次畸形保持可见且不发起第三次。
    const hiddenBeforeFailure = hiddenIDs.length
    expect(yield* run([text(`\`\`\`json\n${JSON.stringify(accepted)}\n\`\`\``), text("second malformed reply")])).toMatchObject({ effect: "deny" })
    expect(reviewRequests).toHaveLength(2)
    expect(hiddenIDs).toHaveLength(hiddenBeforeFailure + 2)
    const visible = JSON.stringify(yield* sessions.context(childID))
    expect(visible).not.toContain("```json")
    expect(visible).toContain("second malformed reply")
    const hiddenBeforeProviderFailure = hiddenIDs.length
    expect(yield* run([Stream.make(LLMEvent.providerError({ message: "provider unavailable" }))])).toMatchObject({ effect: "deny" })
    expect(reviewRequests).toHaveLength(1)
    expect(hiddenIDs).toHaveLength(hiddenBeforeProviderFailure)
    // 取消第二次真实流仍由退出owner收尾，不产生第三次尝试或人工pending。
    const retryStarted = yield* Deferred.make<void>()
    const cancelled = yield* run([text("cancel before repair"), Stream.unwrap(Deferred.succeed(retryStarted, undefined).pipe(Effect.as(Stream.never)))]).pipe(Effect.forkScoped)
    yield* Deferred.await(retryStarted)
    yield* Fiber.interrupt(cancelled)
    expect((yield* sessions.context(childID)).at(-1)).toMatchObject({ type: "assistant", finish: "error" })
    expect(reviewRequests).toHaveLength(2)
    expect(hiddenIDs).toHaveLength(hiddenBeforeProviderFailure + 2)
    expect(yield* service.list()).toEqual([])
  }))
})

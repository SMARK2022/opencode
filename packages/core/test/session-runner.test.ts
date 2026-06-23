import { describe, expect, spyOn } from "bun:test"
import { McpTools } from "@opencode-ai/core/mcp/tools"
import {
  LLM,
  LLMClient,
  LLMError,
  Message,
  LLMEvent,
  Model,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ContextSnapshotDecodeError } from "@opencode-ai/core/session/error"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Catalog } from "@opencode-ai/core/catalog"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { toDecideMessages } from "../src/session/runner/to-llm-message"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Tool } from "@opencode-ai/core/tool/tool"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, ConfigProvider, DateTime, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, References, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import PROMPT_DEFAULT from "../src/system-context/prompt/default.txt"
import PROMPT_MINIMAX from "../src/system-context/prompt/minimax.txt"
import PROMPT_DEEPSEEK from "../src/system-context/prompt/deepseek.txt"
import PROMPT_ANTHROPIC from "../src/system-context/prompt/anthropic.txt"
import PROMPT_CODEX from "../src/system-context/prompt/codex.txt"
import PROMPT_META from "../src/system-context/prompt/meta.txt"
import PROMPT_TRINITY from "../src/system-context/prompt/trinity.txt"
import PROMPT_KIMI from "../src/system-context/prompt/kimi.txt"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Global } from "@opencode-ai/core/global"
import { SessionPrompts } from "@opencode-ai/core/system-context/prompts"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"

const environment = { ...process.env, OPENCODE_EXPERIMENTAL_PLAN_MODE: "false" }
const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
// echo/defect 只产生通用指引；独立全文期望防止生产 formatter 自证或虚构专用工具能力。
const expectedToolGuidance = `# Using your tools
Do NOT use the bash tool when a dedicated tool is available.
Using dedicated tools lets the user review and track your work:
 - Reserve bash for system commands and terminal operations requiring shell execution

PARALLELIZE tool calls whenever possible, especially independent file reads, searches, and status checks.
THINK FIRST before using tools. Decide the FULL first batch of independent reads, searches, directory listings, and status checks you already know you need.
BATCH independent calls in the SAME response. Do not issue one discovery call at a time when several are already obvious.
After the first batch returns, identify newly relevant files and directories and issue the next independent batch together.
Never chain bash commands with separators like \`echo "====";\` to simulate grouped output, because it renders poorly for the user.
Parallel writes are only appropriate when target files or edit ranges cannot conflict.
For multiple changes in one file, prefer one edit/patch containing all non-overlapping changes.
Sequential calls are ONLY for true dependencies, conflicts, or when the next target cannot be known without the previous result. Use bash only when dedicated tools are insufficient or real terminal execution is required.`
// 全文期望检查真实 request.system，echo-only fixture 的空文件能力不能因公共指引扩展而获得 read/edit/write 广告。
// 身份固定到 fixture 的真实 provider/id；未知型号没有 cutoff，不能从持久 baseline 或显示名拼造。
const expectedModelIdentity = "You are powered by the model named fake-model. The exact model ID is fake/fake-model"
const expectedReplacementIdentity = "You are powered by the model named replacement. The exact model ID is fake/replacement"

const authorizations: Tool.Context[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
// Hook 保留生产 resolver 的 typed error，不把不可用选择转换成成功模型。
let modelResolveHook: Effect.Effect<void, SessionRunnerModel.Error> = Effect.void
let currentModel = model
const pricing: ModelV2.Info["cost"][number][] = []
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel)),
  pricing,
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
let runnerMcp: McpTools.Interface | undefined
const runnerLayer = AppNodeBuilder.build(LayerNode.group([SessionRunnerLLM.node, McpTools.node]), [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    runnerMcp = yield* McpTools.Service
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force, maintenance) => sessionRunner.run({ sessionID, force, maintenance }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolOutputStore.node,
      ToolRegistry.toolsNode,
      echoNode,
      Catalog.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      FSUtil.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ).pipe(Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)))),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  environment.OPENCODE_EXPERIMENTAL_PLAN_MODE = "false"
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  pricing.length = 0
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [fixture.expectedContent],
      },
    ])
    const db = (yield* Database.Service).db
    const usage = SessionRequestUsage.make(db)
    const original = (yield* usage.list({ sessionID }))[0]
    expect(original).toMatchObject({ status: "error", assistantCount: 1, stepCount: 0, cost: 0, tokens: { total: 0 } })
    // 同一 partial fixture 改为正常 EOF；raw stream 成功不代表已开始的助手完成。
    const eofFixture = fragmentFixture(kind, fragmentID(kind, "eof"), ["Partial EOF"])
    const eofPrompt = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `EOF after ${kind}` }), resume: false })
    const queuedID = SessionMessage.ID.create()
    responseStream = Stream.concat(
      Stream.fromIterable(eofFixture.partialEvents),
      Stream.fromEffect(session.prompt({ id: queuedID, sessionID, prompt: Prompt.make({ text: "Later queued" }), delivery: "queue", resume: false }).pipe(Effect.orDie)).pipe(Stream.drain),
    )
    const events = yield* EventV2.Service
    // 默认 observer 必须看到真实 EOF 残片结束，再看到后续助手失败；不声明 finalizerSafe。
    const observed: EventV2.Payload[] = []
    const off = yield* events.listen(event => Effect.gen(function* () {
      if (event.type === SessionEvent.Text.Ended.type || event.type === SessionEvent.Reasoning.Ended.type || event.type === SessionEvent.Tool.Input.Ended.type) {
        observed.push(event)
        return
      }
      if (event.type !== SessionEvent.Step.Failed.type) return
      observed.push(event)
      // 真实失败提交时 queue 尚未提升；成功 drain 随后可以按原契约消费它。
      expect((yield* SessionInput.find(db, queuedID))?.promotedSeq).toBeUndefined()
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queuedID) })).toMatchObject({ rootRequestID: queuedID, status: "running", assistantCount: 0, tokens: { total: 0 } })
      responseStream = undefined
      response = []
    }))
    yield* session.resume(sessionID)
    yield* off
    // 三类 fixture 各有一个 Ended，原片段身份和内容必须先于 Step.Failed 且仅交付一次。
    expect(observed).toHaveLength(2)
    expect(observed).toMatchObject([
      { type: kind === "text" ? SessionEvent.Text.Ended.type : kind === "reasoning" ? SessionEvent.Reasoning.Ended.type : SessionEvent.Tool.Input.Ended.type,
        data: { text: "Partial EOF", ...(kind === "text" ? { textID: fragmentID(kind, "eof") } : kind === "reasoning" ? { reasoningID: fragmentID(kind, "eof") } : { callID: fragmentID(kind, "eof") }) },
      },
      { type: SessionEvent.Step.Failed.type, data: { aborted: false } },
    ])
    expect((yield* session.context(sessionID)).findLast(message => message.type === "assistant")).toMatchObject({ type: "assistant", finish: "error", content: [eofFixture.expectedContent] })
    const eofID = SessionV1.MessageID.make(eofPrompt.id)
    const terminal = { rootRequestID: eofID, status: "error", assistantCount: 1, stepCount: 0, cost: 0, tokens: { total: 0 }, time: { completed: expect.any(Number) } }
    expect(yield* usage.get({ sessionID, requestID: eofID })).toMatchObject(terminal)
    expect(yield* usage.assistants({ sessionID, requestID: eofID })).toMatchObject([{ status: "error", stepCount: 0, tokens: { total: 0 }, time: { completed: expect.any(Number) } }])
    // 删除账本后真实重放；文本和本地 pending raw input 不被工具失败清理覆盖。
    yield* db.delete(RequestUsageTable).where(eq(RequestUsageTable.session_id, sessionID)).run().pipe(Effect.orDie)
    yield* replaySessionProjection(sessionID)
    expect((yield* session.context(sessionID)).findLast(message => message.type === "assistant")).toMatchObject({ type: "assistant", finish: "error", content: [eofFixture.expectedContent] })
    expect(yield* usage.get({ sessionID, requestID: eofID })).toMatchObject(terminal)
    // queue 的空成功有自己的终态，不能覆盖前一个 partial EOF 请求的 error。
    expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queuedID) })).toMatchObject({ rootRequestID: queuedID, status: "completed", assistantCount: 0, tokens: { total: 0 } })
    const saved = yield* usage.get({ sessionID, requestID: eofID })
    responseStream = undefined
    response = fragmentFixture("text", "text-after-eof", ["After EOF"]).completeEvents
    const next = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Next real turn" }), resume: false })
    yield* session.resume(sessionID)
    // 下一次真实 Step.Started 只认领新输入，旧失败请求和原 typed failure 的根保持。
    expect(yield* usage.get({ sessionID, requestID: eofID })).toEqual(saved)
    expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(next.id) })).toMatchObject({ rootRequestID: next.id, status: "completed", assistantCount: 1 })
    if (original) expect(yield* usage.get({ sessionID, requestID: original.requestID })).toMatchObject({ rootRequestID: original.rootRequestID, status: "error" })
    yield* replaySessionProjection(sessionID)
    expect(yield* usage.get({ sessionID, requestID: eofID })).toMatchObject(terminal)
    expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(next.id) })).toMatchObject({ rootRequestID: next.id, status: "completed", assistantCount: 1 })
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  it.effect("records Native stream and tool milestones without logging payloads", () =>
    Effect.gen(function* () {
      yield* setup
      // 复用真实runner与内存投影；局部Logger不依赖协调器先前创建的fork context。
      yield* Effect.addFinalizer(() => Effect.sync(() => { requests.length = 0 }))
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run timing check" }), resume: false })
      const secret = "payload-not-for-timing"
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "timing-reasoning" }),
          LLMEvent.reasoningDelta({ id: "timing-reasoning", text: secret }),
          LLMEvent.reasoningEnd({ id: "timing-reasoning" }),
          LLMEvent.toolInputStart({ id: "timing-call", name: "echo" }),
          LLMEvent.toolInputDelta({ id: "timing-call", name: "echo", text: JSON.stringify({ text: secret }) }),
          LLMEvent.toolInputEnd({ id: "timing-call", name: "echo" }),
          LLMEvent.toolCall({ id: "timing-call", name: "echo", input: { text: secret } }),
          LLMEvent.textStart({ id: "timing-text" }),
          LLMEvent.textDelta({ id: "timing-text", text: secret }),
          LLMEvent.textDelta({ id: "timing-text", text: " tail" }),
          LLMEvent.textEnd({ id: "timing-text" }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      const logs: string[] = []
      // 局部真实Effect Logger验证实际埋点，不添加生产捕获数组或另写模拟执行器。
      yield* runner.run({ sessionID, force: true }).pipe(
        Effect.provide(Logger.layer([Logger.make((entry) => { logs.push(JSON.stringify(entry.message)) })])),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      )
      const timing = logs.filter((line) => line.includes(" timing")).join("\n")
      for (const phase of ["processor.start", "ai.first_event", "part.start", "part.first_delta", "processor.end", "tool.start", "tool.end"]) {
        expect(timing).toContain(`"phase":"${phase}"`)
      }
      expect(logs.filter((line) => line.includes('"phase":"part.first_delta"'))).toHaveLength(3)
      expect(timing).not.toContain(secret)
      expect(executions).toContain(secret)
    }),
  )

  it.effect("bounds active provider streams by total timeout and respects explicit timeout or false", () =>
    Effect.gen(function* () {
      // 后续原用例读取 requests[0]；本用例的模块级捕获须随现有测试 scope 清空。
      yield* Effect.addFinalizer(() => Effect.sync(() => { requests.length = 0 }))
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      for (const timeout of [undefined, 120_000, false] as const) {
        yield* setup
        // 使用真实 resolver 的既有 settings 边界，正文同名字段不能变成运输期限。
        currentModel = yield* SessionRunnerModel.resolve(yield* session.get(sessionID), ModelV2.Info.make({
          id: ModelV2.ID.make("timed-model"),
          providerID: ProviderV2.ID.make("fake"),
          name: "Timed model",
          api: { type: "aisdk", package: "@ai-sdk/openai", id: ModelV2.ID.make("timed-model"), settings: { timeout } },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { headers: {}, body: { timeout: 1 } },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 32_000 },
        }))
        expect(currentModel.route.defaults.http?.body).toHaveProperty("timeout", 1)
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Keep streaming" }), resume: false })
        requests.length = 0
        const waiting = yield* Queue.unbounded<void>()
        let chunks = 0
        let stopped = false
        responseStream = Stream.concat(
          Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "timed-text" })]),
          Stream.unfold(0, (index) => Effect.gen(function* () {
            // 每次推进前等真实 pull 注册，避免虚拟时间越过尚未启动的生产者。
            yield* Queue.offer(waiting, undefined)
            yield* Effect.sleep("1 minute")
            chunks++
            return [LLMEvent.textDelta({ id: "timed-text", text: "." }), index + 1] as const
          })),
        ).pipe(Stream.ensuring(Effect.sync(() => { stopped = true })))
        const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
        const minutes = timeout === false ? 7 : (timeout ?? 300_000) / 60_000
        for (let minute = 0; minute < minutes; minute++) {
          yield* Queue.take(waiting)
          yield* TestClock.adjust("1 minute")
        }
        expect(chunks).toBeGreaterThanOrEqual(minutes - 1)
        expect(requests).toHaveLength(1)
        if (timeout === false) {
          expect(stopped).toBe(false)
          yield* Fiber.interrupt(fiber)
          expect(stopped).toBe(true)
          continue
        }
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("Provider deadline unexpectedly succeeded")
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "LLM.Error", reason: { kind: "timeout" } })
        expect(stopped).toBe(true)
        // 到期仍经原 owner 结算失败和已收到的文本，不把 partial 数据当成功 EOF。
        expect((yield* session.context(sessionID)).findLast((message) => message.type === "assistant")).toMatchObject({
          finish: "error",
          error: { message: "Provider request timed out" },
          content: [expect.objectContaining({ type: "text", text: expect.stringContaining(".") })],
        })
      }
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.live("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      // 空成功的真实 finalizer 遇到普通阻塞 observer，resume 仍完成且 typed 流收到原 cohort。
      const events = yield* EventV2.Service
      const release = yield* Deferred.make<void>()
      const off = yield* events.listen(event => event.type === SessionEvent.PromptCompleted.type ? Deferred.await(release) : Effect.void)
      yield* Effect.addFinalizer(() => off.pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.asVoid))
      const delivered = yield* events.subscribe(SessionEvent.PromptCompleted).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      yield* session.resume(sessionID).pipe(Effect.timeout("1 second"))
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(rescue)
      yield* off
      expect(Array.from(yield* Fiber.join(delivered).pipe(Effect.timeout("1 second")))).toMatchObject([{ data: { messageID: second.id, requestIDs: [first.id, second.id] } }])

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
      const db = (yield* Database.Service).db
      const usage = SessionRequestUsage.make(db)
      const empty = { rootRequestID: second.id, status: "completed", assistantCount: 0, stepCount: 0, cost: 0, tokens: { total: 0 }, time: { completed: expect.any(Number) } }
      // 空成功没有助手；已提升 cohort 持久完成，同批零消费只属于第二个根。
      for (const id of [first.id, second.id]) {
        expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(id) })).toMatchObject(empty)
        expect(yield* usage.assistants({ sessionID, requestID: SessionV1.MessageID.make(id) })).toEqual([])
      }
      expect((yield* session.history({ sessionID, limit: 100 })).events).toContainEqual(expect.objectContaining({ type: SessionEvent.PromptCompleted.type, data: expect.objectContaining({ messageID: second.id, requestIDs: [first.id, second.id] }) }))
      // 请求终态必须由 durable event 重建，不能依赖内存或遗留账本行。
      yield* db.delete(RequestUsageTable).where(eq(RequestUsageTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* replaySessionProjection(sessionID)
      for (const id of [first.id, second.id]) expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(id) })).toMatchObject(empty)
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
      response = fragmentFixture("text", "text-after-empty", ["After empty"]).completeEvents
      const next = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
      // 真正新助手不能重绑已完成的旧 self-root 或把空请求计入它的消费。
      for (const id of [first.id, second.id]) expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(id) })).toMatchObject(empty)
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(next.id) })).toMatchObject({ rootRequestID: next.id, status: "completed", assistantCount: 1 })
      yield* replaySessionProjection(sessionID)
      for (const id of [first.id, second.id]) expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(id) })).toMatchObject(empty)
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(next.id) })).toMatchObject({ rootRequestID: next.id, status: "completed", assistantCount: 1 })
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      // 工具指引前置不改变持久 baseline；生产者变化仍只追加到 chronological messages。
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
      ])
      // echo/defect 的真实请求不广告 bash，完整 system 不能从宿主默认 shell 泄漏 Git 政策。
      expect(requests[0]?.system.map((part) => part.text).join("\n")).not.toContain("# Git repository state changes")
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.live("executes and resumes canonical task sessions with durable results and scoped permissions", () => Effect.gen(function* () {
    yield* setup
    const registry = yield* ToolRegistry.Service
    const sessions = yield* SessionV2.Service
    const store = yield* SessionStore.Service
    const agents = yield* AgentV2.Service
    const db = (yield* Database.Service).db
    // 会话仍是build；存储grant与实际调用的plan限制冲突，不能从旧身份推导继承规则。
    yield* db.update(SessionTable).set({ permission: [{ permission: "external_directory", pattern: "/approved/*", action: "allow" }] })
      .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    yield* agents.transform(draft => draft.update(AgentV2.ID.make("plan"), parent => {
      parent.mode = "primary"
      parent.permissions = [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "/approved/*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
      ]
    }))
    const taskAssertions: PermissionV2.AssertInput[] = []
    yield* agents.transform(draft => draft.update(AgentV2.ID.make("research"), agent => {
      agent.mode = "subagent"
      agent.description = "Research with the registered echo tool"
      agent.system = "Research identity"
      agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
    }))
    const parentModel = { providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("fake-model") }
    yield* sessions.switchModel({ sessionID, model: parentModel })
    yield* agents.transform(draft => draft.update(AgentV2.ID.make("reviewer"), agent => {
      agent.mode = "subagent"
      agent.system = "Reviewer identity"
      agent.model = { providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("replacement") }
      agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
    }))
    // 在真实Session/registry/runner图中注册leaf；fake模型只替代provider边界，不替代子会话执行。
    yield* Layer.build(TaskTool.layer.pipe(Layer.provide(Layer.mock(PermissionV2.Service, {
      assert: input => Effect.sync(() => { taskAssertions.push(input) }),
    })), Layer.provide(Layer.succeed(Location.Service, {
      directory: AbsolutePath.make("/project"), project: { id: Project.ID.global, directory: AbsolutePath.make("/project") },
    }))))
    const definitions = (yield* registry.materialize()).definitions
    expect(definitions.map(tool => tool.name)).toContain("task")
    expect(definitions.find(tool => tool.name === "task")?.description).toContain("Prompting rules")
    response = fragmentFixture("text", "task-first", ["Research result"]).completeEvents
    const invoke = (task_id?: string, subagent_type = "research") => registry.materialize().pipe(Effect.flatMap(tools => tools.settle({
      sessionID, agent: AgentV2.ID.make("plan"), assistantMessageID: SessionMessage.ID.make("msg_task_parent"),
      call: { type: "tool-call", id: task_id ? "call-task-resume" : "call-task-first", name: "task",
        input: { description: "Research scoped implementation", prompt: "Inspect the requested module", subagent_type, ...(task_id ? { task_id } : {}) } },
    })))
    const first = yield* invoke()
    expect(first.result.type).toBe("text")
    expect(taskAssertions).toMatchObject([{ action: "task", resources: ["research"], sessionID,
      agent: "plan", source: { type: "tool", messageID: "msg_task_parent", callID: "call-task-first" } }])
    const output = Schema.decodeUnknownSync(TaskTool.Output)(first.output?.structured)
    const childID = output.task_id
    if (typeof childID !== "string") throw new Error("expected durable child task ID")
    const child = yield* sessions.get(SessionV2.ID.make(childID))
    expect(child.parentID).toBe(sessionID)
    expect(child.agent).toBe(AgentV2.ID.make("research"))
    expect(child.title).toBe("Research scoped implementation (@research subagent)")
    expect(first.output?.content).toEqual([{ type: "text", text: `task_id: ${childID}\n<task_result>\nResearch result\n</task_result>` }])
    const inherited = yield* store.permissions(child.id)
    expect(inherited).toEqual([
      { action: "external_directory", resource: "/approved/*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "/approved/*", effect: "ask" },
      { action: "todowrite", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
    ])
    // 固定结果由真实求值器检查；父allow没有下放，有序ask仍覆盖较早deny及会话allow。
    expect(PermissionV2.evaluate("edit", "/file.ts", inherited).effect).toBe("deny")
    expect(PermissionV2.evaluate("external_directory", "/other/file", inherited).effect).toBe("deny")
    expect(PermissionV2.evaluate("external_directory", "/approved/file", inherited).effect).toBe("ask")
    const actual = requests.at(-1)
    expect(actual?.tools.map(tool => tool.name).toSorted()).toEqual(["defect", "echo"])
    expect(userTexts(actual!)).toContain("Inspect the requested module")
    // 同一task_id恢复同一durable子会话；第一次正文与第二次结果均保留在真实历史中。
    response = fragmentFixture("text", "task-second", ["Continued result"]).completeEvents
    const resumed = yield* invoke(childID)
    expect(resumed.output?.structured).toMatchObject({ task_id: childID, state: "completed" })
    expect(resumed.output?.content[0]).toEqual({ type: "text", text: `task_id: ${childID}\n<task_result>\nContinued result\n</task_result>` })
    expect((yield* sessions.context(child.id)).filter(message => message.type === "user")).toHaveLength(2)
    expect(yield* store.permissions(child.id)).toEqual(inherited)
    const rows = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all().pipe(Effect.orDie)
    expect(rows).toEqual([{ id: child.id }])
    // 另一个父会话不能恢复这个任务，失败不会创建或推进子会话。
    yield* insertSession(otherSessionID)
    const foreign = yield* registry.materialize().pipe(Effect.flatMap(tools => tools.settle({
      sessionID: otherSessionID, agent: AgentV2.ID.make("build"), assistantMessageID: SessionMessage.ID.make("msg_foreign"),
      call: { type: "tool-call", id: "call-foreign-task", name: "task", input: { description: "Foreign resume", prompt: "Continue", subagent_type: "research", task_id: childID } },
    })))
    expect(foreign.result.type).toBe("error")
    expect(foreign.result).toMatchObject({ value: `Unknown task_id: ${childID}` })
    expect((yield* sessions.context(child.id)).filter(message => message.type === "user")).toHaveLength(2)
    // 提升现有前台job触发同一后台通知入口，不修改全局实验开关。
    const jobs = yield* BackgroundJob.Service
    const events = yield* EventV2.Service
    const notified = yield* Deferred.make<void>()
    const unsubscribe = yield* events.listen(event => {
      if (event.type !== SessionEvent.PromptAdmitted.type || !Schema.is(Schema.Struct({ sessionID: Schema.String, prompt: Prompt }))(event.data)) return Effect.void
      return event.data.sessionID === sessionID && event.data.prompt.text.includes(`<task id="${childID}"`)
        ? Deferred.succeed(notified, undefined).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    streamGate = yield* Deferred.make<void>()
    streamStarted = yield* Deferred.make<void>()
    response = fragmentFixture("text", "task-background", ["Background result"]).completeEvents
    const requestStart = requests.length
    const waiting = yield* invoke(childID).pipe(Effect.forkChild)
    yield* Deferred.await(streamStarted)
    yield* jobs.promote(childID)
    const promoted = yield* Fiber.join(waiting)
    expect(promoted.output?.structured).toMatchObject({ task_id: childID, state: "running" })
    expect(promoted.output?.content[0]).toMatchObject({ text: expect.stringContaining("DO NOT sleep, poll") })
    // A尚在provider中时排入B再A；审批立即发生，持久身份只能在各段实际开始时更新。
    expect((yield* invoke(childID, "reviewer")).output?.structured).toMatchObject({ task_id: childID, state: "running" })
    expect((yield* invoke(childID, "research")).output?.structured).toMatchObject({ task_id: childID, state: "running" })
    expect(taskAssertions.slice(-2).map(item => item.resources)).toEqual([["reviewer"], ["research"]])
    expect((yield* sessions.get(child.id)).agent).toBe(AgentV2.ID.make("research"))
    expect((yield* sessions.get(child.id)).model).toMatchObject(parentModel)
    const release = streamGate
    streamGate = undefined
    streamStarted = undefined
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(notified).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("background result was not admitted") }))
    const admitted = yield* db.select({ prompt: SessionInputTable.prompt }).from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie)
    expect(admitted.some(row => row.prompt.text.includes("Background result"))).toBe(true)
    // 等待已排入父Session的完成通知实际drain结束，避免下一次门控接管上一轮provider。
    yield* sessions.resume(sessionID)
    const delegated = requests.slice(requestStart).filter(request => request.system.some(part => /Research identity|Reviewer identity/.test(part.text)))
    expect(delegated.map(request => request.system.some(part => part.text.includes("Reviewer identity")) ? "reviewer" : "research")).toEqual(["research", "reviewer", "research"])
    expect(delegated.map(request => request.model.id)).toEqual([model.id, replacementModel.id, model.id])
    const final = yield* sessions.get(child.id)
    expect(final.agent).toBe(AgentV2.ID.make("research"))
    expect(final.model).toMatchObject(parentModel)
    const assistants = (yield* sessions.context(child.id)).filter(message => message.type === "assistant")
    expect(assistants.slice(-3).map(message => message.agent)).toEqual(["research", "reviewer", "research"].map(value => AgentV2.ID.make(value)))
    // 取消另一次前台等待使原job和子Session停止，不把旧完成结果返回为新成功。
    streamGate = yield* Deferred.make<void>()
    streamStarted = yield* Deferred.make<void>()
    const cancelled = yield* invoke(childID).pipe(Effect.forkChild)
    yield* Deferred.await(streamStarted)
    yield* Fiber.interrupt(cancelled)
    expect((yield* jobs.get(childID))?.status).toBe("cancelled")
    expect(yield* sessions.active).not.toContain(child.id)
    streamGate = undefined
    streamStarted = undefined
  }).pipe(Effect.provide(Layer.effect(BackgroundJob.Service, BackgroundJob.make))))

  it.live("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          // 使用真实选中的 agent 验证覆盖，不能只检查 defaults 里有一个字段。
          agent.request.body.parallelToolCalls = false
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([expectedToolGuidance, "Build agent instructions", "Initial context", expectedModelIdentity])
      // false 仍进入实际 turn；自定义 agent 紧随工具指引，不被默认族提示重复或替换。
      expect(requests.at(-1)?.providerOptions?.openai?.parallelToolCalls).toBe(false)
      const db = (yield* Database.Service).db
      const row = yield* db.select({ created: SessionTable.time_created, slug: SessionTable.slug }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row) throw new Error("expected persisted Session")
      const file = path.join(Global.Path.data, "plans", `${row.created}-${row.slug}.md`)
      environment.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true"
      const resume = () => session.resume(sessionID)
      yield* agent.transform(editor => editor.update(AgentV2.ID.make("plan"), item => { item.mode = "primary" }))
      yield* session.switchAgent({ sessionID, agent: "plan" })
      yield* session.prompt({ sessionID, prompt: { text: "Plan the requested change" }, resume: false })
      requests.length = 0
      response = fragmentFixture("text", "text-plan", ["Planned"]).completeEvents
      yield* resume()
      const planning = SessionPrompts.planMode.replace("${planInfo}", () => `No plan file exists yet. You should create your plan at ${file} using the write tool.`)
      expect(requests.map(userTexts).at(-1)).toContain(planning)
      const synthetic = () => session.context(sessionID).pipe(Effect.map(history => history.filter(message => message.type === "synthetic")))
      expect((yield* synthetic()).map(message => message.text)).toEqual([planning])
      // 续轮读取持久synthetic，不产生额外用户输入或每轮重复记录同一提醒。
      yield* resume()
      expect(requests.map(userTexts).at(-1)?.filter(text => text === planning)).toHaveLength(1)
      expect(yield* synthetic()).toHaveLength(1)
      yield* Effect.promise(() => Bun.write(file, "# Accepted plan"))
      yield* session.switchAgent({ sessionID, agent: "build" })
      yield* session.prompt({ sessionID, prompt: { text: "Implement the plan" }, resume: false })
      response = fragmentFixture("text", "text-build-plan", ["Built"]).completeEvents
      yield* resume()
      const building = `${SessionPrompts.buildSwitch}\n\nA plan file exists at ${file}. You should execute on the plan defined within it`
      expect(requests.map(userTexts).at(-1)).toContain(building)
      expect((yield* synthetic()).map(message => message.text)).toEqual([planning, building])
      yield* resume()
      expect(requests.map(userTexts).at(-1)?.filter(text => text === building)).toHaveLength(1)
      expect(yield* synthetic()).toHaveLength(2)
      expect(requests).toHaveLength(4)
      const admitted = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(admitted).toHaveLength(3)
      // 旧阶段相同正文不能压住当前模式；不仅检查出现过，还检查本轮模型与durable尾部。
      const existingPlan = SessionPrompts.planMode.replace("${planInfo}", () => `A plan file already exists at ${file}. You can read it and make incremental edits using the edit tool.`)
      for (const mode of ["plan", "build", "plan", "build"]) {
        yield* session.switchAgent({ sessionID, agent: mode })
        yield* session.prompt({ sessionID, prompt: { text: `Switch to ${mode} again` }, resume: false })
        yield* resume()
        const expected = mode === "plan" ? existingPlan : building
        expect(requests.map(userTexts).at(-1)?.at(-1)).toBe(expected)
        expect((yield* synthetic()).at(-1)?.text).toBe(expected)
      }
      expect(yield* synthetic()).toHaveLength(6)
      expect(requests).toHaveLength(8)
      const repeated = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(repeated).toHaveLength(7)
    }),
  )

  it.effect("refreshes model-family guidance without changing the durable context or inventing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      // 同一 Session 的多次真实 resume 检验 per-turn 生成，不能只调用 formatter。
      const samples = [
        ["MiniMax-M2", "moonshotai", PROMPT_MINIMAX],
        ["mini-max-M2", "gateway", PROMPT_MINIMAX],
        ["deepseek-v4", "gateway", PROMPT_DEEPSEEK],
        ["claude-opus-4-6", "anthropic", PROMPT_ANTHROPIC],
        ["gpt-5-codex", "openai", PROMPT_CODEX],
        ["muse-deepseek", "meta", PROMPT_META.replaceAll("{{MODEL_NAME}}", "Muse Spark")],
        ["trinity-deepseek", "gateway", PROMPT_TRINITY],
        ["other-model", "moonshotai", PROMPT_KIMI],
        ["other-model", "gateway", PROMPT_DEFAULT],
      ] as const
      yield* Effect.forEach(samples, ([id, provider, prompt]) => Effect.gen(function* () {
        currentModel = Model.make({ id, provider, route: OpenAIChat.route })
        response = []
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: id }), resume: false })
        yield* session.resume(sessionID)
        const parts = requests.at(-1)?.system.map((part) => part.text) ?? []
        // 稳定 baseline 仍仅出现一次；族提示与真实模型身份都不进入持久 source。
        expect(parts.filter((part) => part === "Initial context")).toHaveLength(1)
        // 正文逐字比较独立资产，不能用生产selector同时生成期望来隐藏选错族。
        expect(parts).toEqual([expectedToolGuidance, prompt, "Initial context",
          `You are powered by the model named ${id}. The exact model ID is ${provider}/${id}${id === "claude-opus-4-6" ? "\nKnowledge cutoff: May 2025" : ""}`])
        // 完整正文保留工作流文字，实际能力广告与执行表仍只属于本轮materialization。
        expect(parts[0]).not.toMatch(/webfetch|todowrite|task tool|multi_tool_use\.parallel/)
        expect(requests.at(-1)?.tools.map(tool => tool.name).toSorted()).toEqual(["defect", "echo"])
      }))
      const db = (yield* Database.Service).db
      // 在同一持久Session切换工具，核对真实请求与调用结果而不是只测selector。
      for (const action of ["deny", "allow"] as const) {
        yield* db.update(SessionTable).set({ permission: [{ permission: "echo", pattern: "*", action }] })
          .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Set echo ${action}` }), resume: false })
        requests.length = 0
        executions.length = 0
        responses = [[
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-${action}`, name: "echo", input: { text: action } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ], []]
        yield* session.resume(sessionID)
        expect(requests[0]?.tools.map(tool => tool.name).toSorted()).toEqual(action === "deny" ? ["defect"] : ["defect", "echo"])
        expect(executions).toEqual(action === "deny" ? [] : ["allow"])
        const parts = requests[0]?.system.map(part => part.text) ?? []
        expect(parts.filter(part => part === "Initial context")).toHaveLength(1)
        expect(parts[0]).toBe(expectedToolGuidance)
        const messages = yield* session.context(sessionID)
        const tools = messages.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : [])
        expect(tools.find(tool => tool.id === `call-${action}`)?.state.status).toBe(action === "deny" ? "error" : "completed")
      }
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([expectedToolGuidance, "Reviewer instructions", "Initial context", expectedModelIdentity])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([expectedToolGuidance, "Reviewer instructions", "Initial context", expectedModelIdentity])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("decide bounds recent context and preserves durable tool history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) => draft.update(AgentV2.ID.make("decide"), (agent) => { agent.mode = "primary" }))
      skillBaselines.set(AgentV2.ID.make("build"), "Build-only skill instructions")
      yield* session.switchAgent({ sessionID, agent: "build" })
      // 先用实际 runner 生成历史，再切换决定模式；不向投影表伪造工具结果。
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "old-marker " + "x".repeat(80_000) }), resume: false })
      yield* session.resume(sessionID)
      if (!runnerMcp) throw new Error("expected runner MCP service")
      // 首次drain已创建实际Location服务；观察真实prepare，再用普通轮证明观察有效。
      const prepare = spyOn(runnerMcp, "prepare")
      yield* Effect.addFinalizer(() => Effect.sync(() => prepare.mockRestore()))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "recent-marker" }), resume: false })
      const reasoning = "prefix-" + "a".repeat(193) + "-middle-" + "z".repeat(193) + "-suffix"
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "decide-reasoning" }),
        LLMEvent.reasoningDelta({ id: "decide-reasoning", text: reasoning }),
        LLMEvent.reasoningEnd({ id: "decide-reasoning" }),
        LLMEvent.toolCall({ id: "decide-history", name: "echo", input: { text: "history" }, providerExecuted: true }),
        LLMEvent.toolResult({ id: "decide-history", name: "echo", result: { type: "content", value: [{ type: "text", text: "tail output" }] }, providerExecuted: true }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(1), agent: "decide",
      })
      expect(prepare).toHaveBeenCalled()
      prepare.mockClear()
      skillBaselines.set(AgentV2.ID.make("decide"), "Must not load decide skills")
      currentModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route.with({ limits: { context: 20_000, input: 10_000, output: 1_000 } }) })
      response = fragmentFixture("text", "decide-answer", ["Decision"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "decide now" }), resume: false })
      requests.length = 0
      executions.length = 0
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      const request = requests[0]
      if (!request) throw new Error("expected decide request")
      expect(request.tools).toEqual([])
      expect(request.toolChoice).toMatchObject({ type: "none" })
      const system = request.system.map((part) => part.text).join("\n")
      expect(system).toContain("Decide mode is active")
      expect(system).toContain("Previously supplied MCP server instructions and skill guidance")
      expect(system).toContain("Build-only skill instructions")
      const serialized = JSON.stringify(request.messages)
      expect(serialized).toContain("recent-marker")
      expect(serialized).not.toContain("old-marker")
      expect(serialized).toContain("tail output")
      expect(serialized).toContain("prefix-")
      expect(serialized).toContain("-suffix")
      expect(serialized).not.toContain("-middle-")
      expect(serialized).not.toContain('"role":"tool"')
      expect(serialized).not.toContain('"type":"tool-call"')
      expect(serialized).not.toContain("Must not load decide skills")
      expect(executions).toEqual([])
      // 下一决定轮即使裁掉一次撤销消息，仍逐轮停用旧指导且不准备MCP。
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "confirm the decision" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(requests[1]?.system.map((part) => part.text).join("\n")).toContain("Previously supplied MCP server instructions and skill guidance")
      expect(prepare).not.toHaveBeenCalled()
      // 发送窗口的裁剪不能删除历史，也不能让原生投影中的工具变成文本。
      const history = yield* session.context(sessionID)
      expect(history.some((message) => message.type === "user" && message.text.startsWith("old-marker"))).toBe(true)
      expect(history.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"))).toBe(true)
      expect(history.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "reasoning" && part.text === reasoning))).toBe(true)
      const budgetModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route.with({ limits: { context: 100_000, input: 80_000, output: 0 } }) })
      const learned = history.map((message) => message.type === "user" && message.text.startsWith("old-marker")
        ? { ...message, text: "old-marker " + "x".repeat(400_000) }
        : message.type !== "assistant" ? message : {
          ...message, inputEstimate: { bodyChars: 827_111, input: 128_159, confirmed: true },
          tokens: { input: 128_159, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      // 同一400k历史在学习密度下可保留；清掉确认标记后才按默认/4收缩。
      expect(JSON.stringify(toDecideMessages(learned, budgetModel, "system", 0))).toContain("old-marker")
      expect(JSON.stringify(toDecideMessages(learned.map((message) => message.type !== "assistant" ? message
        : { ...message, inputEstimate: undefined }), budgetModel, "system", 0))).not.toContain("old-marker")
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context\n\nBuild skills", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context\n\nBuild skills", expectedModelIdentity],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context\n\nBuild skills", expectedModelIdentity],
      ])
    }),
  )

  it.live("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      // 通过真实 public 选择/接纳/提升，再调用生产 variant resolver，不直接制造账本终态。
      yield* insertSession(otherSessionID)
      const unavailableModel = ModelV2.Info.make({
        id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake"), name: "Unavailable variant",
        api: { id: ModelV2.ID.make("fake-model"), type: "aisdk", package: "@ai-sdk/openai" },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        request: { headers: {}, body: {} }, variants: [], time: { released: 0 },
        cost: [], status: "active", enabled: true, limit: { context: 100, output: 20 },
      })
      yield* session.switchModel({ sessionID: otherSessionID, model: {
        id: unavailableModel.id, providerID: unavailableModel.providerID, variant: ModelV2.VariantID.make("unknown"),
      } })
      const first = yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "First unavailable steer" }), resume: false })
      const failed = yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Second unavailable steer" }), resume: false })
      const queued = yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Wait after failure" }), delivery: "queue", resume: false })
      const duringID = SessionMessage.ID.create()
      // 在 resolve 内接纳更晚 queue，专门检测 finalizer 是否误读最新 admission。
      modelResolveHook = Effect.gen(function* () {
        yield* session.prompt({ sessionID: otherSessionID, id: duringID, prompt: Prompt.make({ text: "Later admission" }), delivery: "queue", resume: false }).pipe(Effect.orDie)
        return yield* SessionRunnerModel.resolve(yield* session.get(otherSessionID).pipe(Effect.orDie), unavailableModel).pipe(Effect.asVoid)
      })
      // typed 失败与 public interrupt 共用普通阻塞 terminal observer，safe typed fanout 仍需交付。
      const release = yield* Deferred.make<void>()
      const off = yield* events.listen(event => event.type === SessionEvent.PromptFailed.type ? Deferred.await(release) : Effect.void)
      yield* Effect.addFinalizer(() => off.pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.asVoid))
      const delivered = yield* events.subscribe(SessionEvent.PromptFailed).pipe(Stream.filter(event => event.data.sessionID === otherSessionID), Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const resumeRescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      requests.length = 0
      const unavailableExit = yield* session.resume(otherSessionID).pipe(Effect.timeout("1 second"), Effect.exit)
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(resumeRescue)
      expect(unavailableExit._tag).toBe("Failure")
      if (unavailableExit._tag !== "Failure") return yield* Effect.die("Expected unavailable variant")
      // 类型化 cause 原样传播，provider 未执行，因此成本、tokens、step 与助手数均为零。
      expect(Cause.squash(unavailableExit.cause)).toBeInstanceOf(SessionRunnerModel.VariantUnavailableError)
      expect(requests).toHaveLength(0)
      const db = (yield* Database.Service).db
      const usage = SessionRequestUsage.make(db)
      const zero = { assistantCount: 0, stepCount: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 } }
      const terminal = { ...zero, status: "error" as const, error: "Variant unavailable for fake/fake-model: unknown", rootRequestID: SessionV1.MessageID.make(failed.id), time: { completed: expect.any(Number) } }
      // 同批真实请求都闭合；不存在助手就不能用 fake Step.Started 补账。
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(first.id) })).toMatchObject(terminal)
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(failed.id) })).toMatchObject(terminal)
      expect(yield* usage.assistants({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(failed.id) })).toEqual([])
      expect((yield* session.messages({ sessionID: otherSessionID })).filter(message => message.type === "assistant")).toEqual([])
      expect((yield* SessionInput.find(db, first.id))?.promotedSeq).toBeDefined()
      expect((yield* SessionInput.find(db, failed.id))?.promotedSeq).toBeDefined()
      // 未提升的早/晚 queue 都仍可由未来显式执行消费，没有被失败批次结算。
      for (const id of [queued.id, duringID]) {
        expect((yield* SessionInput.find(db, id))?.promotedSeq).toBeUndefined()
        expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(id) })).toMatchObject({ ...zero, status: "running" })
        expect((yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(id) }))?.time.completed).toBeUndefined()
      }
      // durable payload 固定原批次身份，replay 不需要 resolver 或当前最新输入。
      const failedEvent = (yield* session.history({ sessionID: otherSessionID, limit: 100 })).events.find(event => event.type === SessionEvent.PromptFailed.type)
      expect(failedEvent).toMatchObject({ data: { messageID: failed.id, requestIDs: [first.id, failed.id], aborted: false } })
      // 同一真实准备边界被中断时只消费第一条 queue，并持久化 aborted 而非 error。
      const ready = yield* Deferred.make<void>()
      modelResolveHook = Deferred.succeed(ready, void 0).pipe(Effect.andThen(Effect.never))
      const interrupted = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      // 局部救援仅防旧退出实现挂死；取消必须在 rescue release 之前返回。
      const interruptRescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      yield* session.interrupt(otherSessionID).pipe(Effect.timeout("1 second"))
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(interruptRescue)
      yield* off
      expect(Array.from(yield* Fiber.join(delivered).pipe(Effect.timeout("1 second")))).toMatchObject([{ data: { requestIDs: [first.id, failed.id], aborted: false } }, { data: { requestIDs: [queued.id], aborted: true } }])
      const interruptedExit = yield* Fiber.await(interrupted)
      expect(interruptedExit._tag).toBe("Failure")
      if (interruptedExit._tag === "Failure") expect(Cause.hasInterruptsOnly(interruptedExit.cause)).toBe(true)
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({ ...zero, status: "aborted", time: { completed: expect.any(Number) } })
      expect((yield* SessionInput.find(db, queued.id))?.promotedSeq).toBeDefined()
      expect((yield* SessionInput.find(db, duringID))?.promotedSeq).toBeUndefined()
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(duringID) })).toMatchObject({ ...zero, status: "running" })
      expect(requests).toHaveLength(0)
      // 删除真实账本再重放 durable events，验证零助手失败能重建而不是依赖残留行。
      yield* db.delete(RequestUsageTable).where(eq(RequestUsageTable.session_id, otherSessionID)).run().pipe(Effect.orDie)
      yield* replaySessionProjection(otherSessionID)
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(first.id) })).toMatchObject(terminal)
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(failed.id) })).toMatchObject(terminal)
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({ ...zero, status: "aborted", time: { completed: expect.any(Number) } })
      expect(yield* usage.get({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(duringID) })).toMatchObject({ ...zero, status: "running" })
      expect((yield* SessionInput.find(db, duringID))?.promotedSeq).toBeUndefined()
      expect(yield* usage.assistants({ sessionID: otherSessionID, requestID: SessionV1.MessageID.make(failed.id) })).toEqual([])
      modelResolveHook = Effect.void
      // 保留既有 sampled-model 场景及其精确期望，以上失败不能改变另一个 Session。
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      // resolve 期间切换只影响后续 turn；当前身份必须与已采样 model 一致，而非重读选择。
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([[expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity]])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      // 持久 baseline 不随模型替换，但第三轮身份必须更新；chronological updates 仍由 messages 断言。
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedReplacementIdentity],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedReplacementIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedReplacementIdentity],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      // 压缩重建的是上下文，不是模型切换；Replacement context 仍配原 fake-model 身份。
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Replacement context", expectedModelIdentity],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.live("manual compaction stops after summarizing retained tool tail", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: model.id, provider: model.provider, route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_096 } }) })
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "manual-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "manual-tail", name: "echo", input: { text: "tail output" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "manual-tail-done", ["Done"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Keep recent tool turn" }), resume: false })
      yield* session.resume(sessionID)
      requests.length = 0
      executions.length = 0
      const pending = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Later queued request" }), delivery: "queue", resume: false })
      responses = undefined
      response = fragmentFixture("text", "manual-summary", ["Summary"]).completeEvents
      yield* session.compact({ sessionID })
      expect(requests).toHaveLength(1)
      expect(requests[0].tools).toEqual([])
      const context = yield* session.context(sessionID)
      expect(context).toHaveLength(1)
      expect(context[0]).toMatchObject({ type: "compaction", summary: "Summary" })
      if (context[0].type !== "compaction") return yield* Effect.die("Missing manual summary")
      expect(context[0].recent).toContain("[User]: Keep recent tool turn")
      // 原话通过真实Ended与SQL投影保存；排队但尚未promote的用户输入不进入交接。
      expect(context[0].recent_user_messages?.map(message => message.text)).toEqual(["Earlier question", "Keep recent tool turn"])
      expect(context[0].recent).toContain("[Tool result]: tail output")
      expect(executions).toHaveLength(0)
      const db = (yield* Database.Service).db
      expect(yield* db.select({ promoted: SessionInputTable.promoted_seq }).from(SessionInputTable).where(eq(SessionInputTable.id, pending.id)).get().pipe(Effect.orDie)).toEqual({ promoted: null })
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toEqual(context)
      const history = yield* session.history({ sessionID, limit: 100 })
      expect(history.events.filter(event => event.type === SessionEvent.Compaction.Ended.type).map(event => event.data)).toMatchObject([{ reason: "manual", text: "Summary", recent_user_messages: context[0].recent_user_messages }])
      response = fragmentFixture("text", "manual-later", ["Later answer"]).completeEvents
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]).join("\n")).toContain("<summary>\nSummary\n</summary>")
      expect(executions).toHaveLength(0)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.MessagesHidden, {
        sessionID, timestamp: yield* DateTime.now, messageIDs: [SessionMessage.ID.make(pending.id)],
        hidden: { time: Date.now(), reason: "permission-reviewer-protocol-retry" },
      })
      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, text: "Synthetic context must not enter memento" })
      requests.length = 0
      response = fragmentFixture("text", "manual-summary-2", ["Second summary"]).completeEvents
      yield* session.compact({ sessionID })
      const second = yield* session.context(sessionID)
      const checkpoint = second.find(message => message.type === "compaction")
      if (!checkpoint || checkpoint.type !== "compaction") return yield* Effect.die("Missing second compaction")
      // 第二次摘要故意不含旧原话；只能由真实raw-user查询跨越首次边界保存，hidden与synthetic不得混入。
      expect(checkpoint.recent_user_messages?.map(message => message.text)).toEqual(["Earlier question", "Keep recent tool turn"])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toEqual(second)
      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, text: "Continue after replay" })
      requests.length = 0
      const failure = providerUnavailable()
      streamFailure = failure
      expect(yield* session.compact({ sessionID }).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).some(message => message.type === "compaction" && message.summary === "Second summary")).toBe(true)
    }),
  )

  it.live("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      const events = yield* EventV2.Service
      // 通过真实模型选择事件采样 variant，压缩身份必须来自 runner producer 而非测试直发 Started。
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now,
        model: { id: ModelV2.ID.make(compactModel.id), providerID: ProviderV2.ID.make(compactModel.provider), variant: ModelV2.VariantID.make("high") },
      })
      currentModel = compactModel
      // 摘要和随后普通 turn 都经真实结算；缓存计入上下文阶梯，但不能按普通输入重复收费。
      pricing.push(
        { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
        { input: 3, output: 5, cache: { read: 2, write: 4 }, tier: { type: "context", size: 10 } },
      )
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ].map(events => events.map(event => LLMEvent.is.stepFinish(event)
        ? LLMEvent.stepFinish({ ...event, usage: { inputTokens: 13, nonCachedInputTokens: 8, cacheReadInputTokens: 2, cacheWriteInputTokens: 3, outputTokens: 3, reasoningTokens: 1 } }) : event))
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.http?.headers)).toEqual([
        {
          "x-opencode-session-id": sessionID,
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
        {
          "x-opencode-session-id": sessionID,
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
        },
      ])
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the task",
      })
      const usage = SessionRequestUsage.make((yield* Database.Service).db)
      // 查询真实 summary stream 的请求和助手账本，直接 projector fixture 不能证明 producer 携带 variant。
      const compacted = (yield* usage.list({ sessionID, source: "system_compaction" }))[0]
      if (!compacted) return yield* Effect.die("Missing compaction usage")
      expect(compacted).toMatchObject({ status: "completed", model: { variant: "high" }, cost: 0.000055 })
      expect(yield* usage.assistants({ sessionID, requestID: compacted.requestID })).toMatchObject([{ model: { variant: "high" }, cost: 0.000055 }])
      expect(context[1]).toMatchObject({ type: "assistant", cost: 0.000055 })
      expect((yield* usage.list({ sessionID, source: "prompt" })).some(row => row.cost === 0.000055)).toBe(true)
      expect((yield* session.get(sessionID)).cost).toBeCloseTo(0.00011, 10)

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<prior-summary>\n## Objective\n- Preserve the task\n</prior-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the updated task",
      })
      const db = (yield* Database.Service).db
      const settled = (yield* usage.list({ sessionID, source: "system_compaction" })).map(row => ({
        requestID: row.requestID, rootRequestID: row.rootRequestID, status: row.status, model: row.model, cost: row.cost, tokens: row.tokens, stepCount: row.stepCount,
      }))
      const ready = yield* Deferred.make<void>()
      // Started 通知可中断，普通 Failed observer 即使阻塞也不能被退出 owner 重新等待。
      const release = yield* Deferred.make<void>()
      const terminalOff = yield* events.listen(event => event.type === SessionEvent.Compaction.Failed.type || event.type === SessionEvent.PromptFailed.type ? Deferred.await(release) : Effect.void)
      yield* Effect.addFinalizer(() => terminalOff.pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.asVoid))
      const delivered = yield* events.all().pipe(Stream.filter(event => event.type === SessionEvent.Compaction.Failed.type || event.type === SessionEvent.PromptFailed.type), Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      // 真实 Started 已提交但 publish 尚阻塞于 listener，不能用 stream gate 代替这个窗口。
      const off = yield* events.listen(event => event.type === SessionEvent.Compaction.Started.type
        ? Deferred.succeed(ready, void 0).pipe(Effect.andThen(Effect.never))
        : Effect.void)
      const interruptedPrompt = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt committed compaction ".repeat(180) }), resume: false })
      requests.length = 0
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      const started = (yield* session.history({ sessionID, limit: 100 })).events.findLast(event => event.type === SessionEvent.Compaction.Started.type)
      if (!started || started.type !== SessionEvent.Compaction.Started.type) return yield* Effect.die("Missing durable compaction Started")
      // 从公开 durable history 读取身份证明 commit；summary provider 还未被调用。
      expect(started.durable).toBeDefined()
      expect(requests).toHaveLength(0)
      const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      yield* session.interrupt(sessionID).pipe(Effect.timeout("1 second"))
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(rescue)
      yield* terminalOff
      expect(Array.from(yield* Fiber.join(delivered).pipe(Effect.timeout("1 second")))).toMatchObject([{ type: SessionEvent.Compaction.Failed.type, data: { messageID: started.data.messageID, aborted: true } }, { type: SessionEvent.PromptFailed.type, data: { messageID: interruptedPrompt.id, aborted: true } }])
      const exit = yield* Fiber.await(run)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      yield* off
      const compactID = SessionV1.MessageID.make(started.data.messageID)
      const promptID = SessionV1.MessageID.make(interruptedPrompt.id)
      const zero = { cost: 0, stepCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 } }
      // 外层 prompt 与独立压缩分别终结；Started 冻结的 variant 及原确认消费不能丢失。
      const aborted = { ...zero, source: "system_compaction" as const, status: "aborted" as const, rootRequestID: promptID, model: { variant: "high" } }
      expect(yield* usage.get({ sessionID, requestID: compactID })).toMatchObject(aborted)
      expect(yield* usage.get({ sessionID, requestID: promptID })).toMatchObject({ ...zero, source: "prompt", status: "aborted" })
      for (const prior of settled) expect(yield* usage.get({ sessionID, requestID: prior.requestID })).toMatchObject(prior)
      const history = yield* session.history({ sessionID, limit: 100 })
      expect(history.events.filter(event => event.type === SessionEvent.Compaction.Failed.type && event.data.messageID === started.data.messageID)).toHaveLength(1)
      expect(history.events.filter(event => event.type === SessionEvent.Compaction.Ended.type && event.data.messageID === started.data.messageID)).toHaveLength(0)
      // 重建消息时会话总额也从零重建；真实 durable Failed 只能结算自己的压缩身份。
      const totals = db.select({ cost: SessionTable.cost, input: SessionTable.tokens_input, output: SessionTable.tokens_output,
        reasoning: SessionTable.tokens_reasoning, read: SessionTable.tokens_cache_read, write: SessionTable.tokens_cache_write })
        .from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      const billed = yield* totals
      yield* db.update(SessionTable).set({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0 })
        .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      // 全量重建同时清空账本投影；保留旧账本却清零总额会把已确认压缩用量抵消两次。
      yield* db.delete(RequestUsageAssistantTable).where(eq(RequestUsageAssistantTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db.delete(RequestUsageTable).where(eq(RequestUsageTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* replaySessionProjection(sessionID)
      expect(yield* totals).toEqual(billed)
      expect(yield* usage.get({ sessionID, requestID: compactID })).toMatchObject(aborted)
      expect(yield* usage.get({ sessionID, requestID: promptID })).toMatchObject({ ...zero, source: "prompt", status: "aborted" })
      for (const prior of settled) expect(yield* usage.get({ sessionID, requestID: prior.requestID })).toMatchObject(prior)
      // Started projector 真正回滚时没有独立请求，不允许 owner 伪造 Failed。
      const before = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)
      const defect = new Error("Compaction Started rolled back")
      let rollbackStarted = false
      yield* events.project(SessionEvent.Compaction.Started, () => Effect.sync(() => { rollbackStarted = true }).pipe(Effect.andThen(Effect.die(defect))))
      // 中断保留的长历史已触发 auto；新增短输入让摘要仍可装入 context-output 预算。
      const uncommittedPrompt = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reject uncommitted compaction " }), resume: false })
      requests.length = 0
      const rollback = yield* session.resume(sessionID).pipe(Effect.exit)
      // 必须实际进入 Started 的事务 projector，普通 turn 的失败不能充当回滚证据。
      expect(rollbackStarted).toBe(true)
      expect(rollback._tag).toBe("Failure")
      if (rollback._tag === "Failure") expect(Cause.squash(rollback.cause)).toBe(defect)
      expect(requests).toHaveLength(0)
      const after = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)
      for (const definition of [SessionEvent.Compaction.Started, SessionEvent.Compaction.Ended, SessionEvent.Compaction.Failed]) {
        if (!definition.durable) return yield* Effect.die("Missing durable compaction definition")
        const type = EventV2.versionedType(definition.type, definition.durable.version)
        expect(after.filter(row => row.type === type)).toHaveLength(before.filter(row => row.type === type).length)
      }
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(uncommittedPrompt.id) })).toMatchObject({ ...zero, source: "prompt", status: "error" })
      expect(yield* usage.list({ sessionID, source: "system_compaction" })).toHaveLength(settled.length + 1)
    }),
  )

  it.effect("retains only complete serialized messages during compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const earlier = `EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`
      const recent = `RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: earlier }), resume: false })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: recent }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/EARLIER_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(`EARLIER_BOUNDARY ${"a".repeat(3_000)} EARLIER_END`)
      expect(summary).not.toContain("RECENT_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_BOUNDARY")
      expect(continuation).not.toContain("EARLIER_END")
      expect(continuation).toContain("<recent-context>\n[Assistant]: Earlier answer")
      expect(continuation).toContain(`RECENT_BOUNDARY ${"b".repeat(3_000)} RECENT_END`)
      // 延伸已有真实压缩用例，注册 Catalog 输入上限并走 resolve，而非复制预算函数充当 oracle。
      const catalog = yield* Catalog.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const info = yield* store.get(sessionID)
      const fileSystem = yield* FSUtil.Service
      if (!info) return yield* Effect.die("Missing Session for catalog input budget")
      const entries = yield* SessionHistory.entriesForRunner(database.db, sessionID, 0)
      const outputs = yield* ToolOutputStore.Service
      const bounded = yield* outputs.bound({
        sessionID, toolCallID: "recovery-proof",
        output: { structured: {}, content: [{ type: "text", text: "head".repeat(6_000) + "RECOVERY_TAIL" }] },
      })
      expect(bounded.outputPaths).toHaveLength(1)
      // 使用真实16KiB投影确认恢复路径在中部，再检查摘要请求而非复制截断算法。
      const preview = bounded.output.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
      expect(preview.indexOf(bounded.outputPaths.join(""))).toBeGreaterThan(2_000)
      expect(preview.indexOf(bounded.outputPaths.join(""))).toBeLessThan(preview.length - 2_000)
      const recoveryEntry = {
        seq: -1,
        message: SessionMessage.Assistant.make({
          id: SessionMessage.ID.create(), type: "assistant", agent: "build",
          model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
          time: { created: info.time.created },
          content: [{
            type: "tool", id: "recovery-proof", name: "fixture", time: { created: info.time.created },
            state: { status: "completed", input: {}, structured: {}, content: [{ type: "text", text: preview }], outputPaths: bounded.outputPaths },
          }],
        }),
      }
      const providerID = ProviderV2.ID.make("input-budget")
      const modelID = ModelV2.ID.make("input-budget")
      // 68k 保留原 floor 余量；69k 越过 68700，可同时识别丢 input 与重复扣 output 两种回归。
      for (const [limit, output, buffer, size, expected] of [
        [73_700, undefined, undefined, 68_000, false],
        [73_700, undefined, undefined, 69_000, true],
        // 显式零和自定义 buffer 不被默认 floor 替代，保留 Core 配置优先级。
        [73_700, undefined, 0, 72_000, false],
        [73_700, undefined, 10_000, 63_000, false],
        [73_700, undefined, 10_000, 65_000, true],
        [73_700, undefined, 3_000, 70_000, false],
        [73_700, undefined, 3_000, 71_500, true],
        // 请求输出预算仍可能成为更紧的总窗口约束，不能一律只看 input-floor。
        [73_700, 140_000, undefined, 64_000, false],
        [73_700, 140_000, undefined, 66_000, true],
        // 未提供 input 或 catalog 用零表示未知时，继续沿既有 context/output 预算。
        [undefined, undefined, undefined, 80_000, false],
        [0, undefined, undefined, 80_000, false],
        // 摘要本身装不进输入上限时不得调用 provider，不能靠压缩隐藏另一次溢出。
        [1, undefined, undefined, 69_000, false],
      ] as const) {
        const registration = yield* catalog.transform((draft) => draft.model.update(providerID, modelID, (model) => {
          model.api = { id: modelID, type: "aisdk", package: "@ai-sdk/openai" }
          model.enabled = true
          model.limit = { context: 204_800, input: limit, output: 20_000 }
        }))
        const selected = yield* catalog.model.get(providerID, modelID)
        if (!selected) return yield* Effect.die("Missing registered Catalog model")
        const resolved = yield* SessionRunnerModel.resolve(info, selected)
        expect(resolved.route.defaults.limits?.input).toBe(limit)
        let streams = 0
        let estimated: SessionMessage.InputEstimate | undefined
        let compactRequestID: string | undefined
        const compaction = SessionCompaction.make({
          db: database.db, events, fs: fileSystem, worktree: "/project",
          // 仅用本地完成事件测试实际 durable 压缩，绝不向解析出的 provider URL 发送请求。
          llm: { stream: (summaryRequest, onPrepared) => {
            streams++
            expect(userTexts(summaryRequest)[0]).toContain(bounded.outputPaths.join(""))
            return Stream.unwrap(Effect.gen(function* () {
              yield* (onPrepared?.({ messages: summaryRequest.messages }) ?? Effect.void)
              const pending = yield* store.get(sessionID)
              estimated = pending?.request?.inputEstimate
              compactRequestID = pending?.request?.messageID
              expect(estimated?.bodyChars).toBeGreaterThan(0)
              expect(estimated?.confirmed).toBe(false)
              return Stream.fromIterable(fragmentFixture("text", "input-budget-summary", ["## Objective\n- Keep input budget"]).completeEvents)
            }))
          } },
          config: [new Config.Document({ type: "document", info: new Config.Info({
            compaction: new ConfigCompaction.Info({ buffer, keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
          }) })],
        })
        const request = LLM.request({ model: resolved, messages: [Message.user("x".repeat(size * 4))], generation: { maxTokens: output } })
        expect(yield* compaction.compactIfNeeded({ sessionID, entries: [recoveryEntry, ...entries], model: resolved, pricing: selected.cost, request })).toBe(expected)
        // 阈值触发只产生现有一次 summary turn；未触发和摘要预算拒绝都保持零 provider 调用。
        expect(streams).toBe(expected ? 1 : 0)
        if (limit === 73_700 && size === 68_000) {
          // 同样的真实预检入口应把大图算成媒体，避免无谓摘要请求与历史替换。
          const mediaRequest = LLM.request({ model: resolved, messages: [Message.user([
            { type: "text", text: "x".repeat(50_000) }, { type: "media", mediaType: "image/png", data: `data:image/png;base64,${"a".repeat(400_000)}` },
          ])] })
          expect(yield* compaction.compactIfNeeded({ sessionID, entries, model: resolved, pricing: selected.cost, request: mediaRequest })).toBe(false)
          const learnedEntries = [recoveryEntry, ...entries].map((entry) => entry.message.type !== "assistant" ? entry : { ...entry, message: {
            ...entry.message, model: { id: modelID, providerID },
            inputEstimate: { bodyChars: 827_111, input: 128_159, confirmed: true },
            tokens: { input: 128_159, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } })
          const learnedRequest = LLM.request({ model: resolved, messages: [Message.user("x".repeat(400_000))] })
          // 实际压缩owner应在读取provider前使用确认密度；缺样本对照则触发一次摘要。
          expect(yield* compaction.compactIfNeeded({ sessionID, entries: learnedEntries, model: resolved, pricing: selected.cost, request: learnedRequest })).toBe(false)
          expect(streams).toBe(0)
          expect(yield* compaction.compactIfNeeded({ sessionID, entries: [recoveryEntry, ...entries], model: resolved, pricing: selected.cost, request: learnedRequest })).toBe(true)
          expect(streams).toBe(1)
          expect(yield* compaction.compact({ sessionID, entries: learnedEntries, model: resolved, pricing: selected.cost, request: learnedRequest })).toBe(true)
          expect(estimated?.charsPerToken).toBeCloseTo(6.45, 1)
          expect((yield* store.get(sessionID))?.request?.messageID).not.toBe(compactRequestID)
        }
        yield* registration.dispose
      }
      // 实际summary上传与持久recent证明缺省扩大；显式8K/零不能被新缺省覆盖。
      const expanded = Model.make({ id: "expanded", provider: "fake", route: OpenAIChat.route.with({ limits: { context: 204_800, output: 4096 } }) })
      const head = "OLD_HEAD " + "h".repeat(80_000)
      const retained = "RECENT_FULL " + "r".repeat(40_000) + " RECENT_END"
      const history = [head, retained, "Newest exact request"].map((text, index) => ({ seq: index + 1, message: SessionMessage.User.make({ type: "user", id: SessionMessage.ID.create(), text, time: { created: DateTime.makeUnsafe(index) } }) }))
      for (const keep of [undefined, 8_000, 0]) {
        let upload = ""
        const compaction = SessionCompaction.make({ db: database.db, events, fs: fileSystem, worktree: "/project",
          config: keep === undefined ? [] : [new Config.Document({ type: "document", info: new Config.Info({ compaction: new ConfigCompaction.Info({ keep: new ConfigCompaction.Keep({ tokens: keep }) }) }) })],
          llm: { stream: request => {
            upload = userTexts(request)[0] ?? ""
            return Stream.fromIterable(fragmentFixture("text", "tail-budget", ["Budget summary"]).completeEvents)
          } },
        })
        expect(yield* compaction.compact({ sessionID, entries: history, model: expanded, pricing: [], request: LLM.request({ model: expanded, prompt: "Summarize" }) })).toBe(true)
        const latest = (yield* store.context(sessionID)).find(message => message.type === "compaction")
        if (!latest || latest.type !== "compaction") return yield* Effect.die("Missing real compaction projection")
        expect(upload).toContain("OLD_HEAD")
        expect(upload.includes("RECENT_FULL")).toBe(keep !== undefined)
        expect(latest.recent.includes(retained)).toBe(keep === undefined)
        expect(latest.recent.includes("Newest exact request")).toBe(keep !== 0)
        if (keep === 0) expect(latest.recent).toBe("")
      }
    }),
  )

  it.effect("summarizes an oversized newest message without retaining a fragment", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Earlier question" }), resume: false })
      yield* session.resume(sessionID)

      const oversized = `OVERSIZED_BOUNDARY ${"x".repeat(4_500)} OVERSIZED_END`
      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: oversized }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0])[0]
      const continuation = userTexts(requests[1])[0]
      expect(summary.match(/OVERSIZED_BOUNDARY/g)).toHaveLength(1)
      expect(summary).toContain(oversized)
      // 整段recent仍不留片段；独立memento按source预算保留用户原话前缀。
      expect(continuation).toContain("OVERSIZED_BOUNDARY")
      expect(continuation).toContain("...[truncated for compaction memento]")
      expect(continuation.indexOf("<recent-user-messages>")).toBeLessThan(continuation.indexOf("<conversation-checkpoint>"))
      expect(continuation.match(/OVERSIZED_BOUNDARY/g)).toHaveLength(1)
      expect(continuation).not.toContain("OVERSIZED_END")
      expect(continuation).toContain("<recent-context>\n\n</recent-context>")
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const events = yield* EventV2.Service
      // overflow 分支走另一个调用边界，必须独立验证仍传同一 turn 的选择。
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now,
        model: { id: ModelV2.ID.make(recoveryModel.id), providerID: ProviderV2.ID.make(recoveryModel.provider), variant: ModelV2.VariantID.make("medium") },
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      const usage = SessionRequestUsage.make((yield* Database.Service).db)
      // 恢复用量结算保留 Started 冻结的 variant，后续 retry 不能回写其他选择。
      const compacted = (yield* usage.list({ sessionID, source: "system_compaction" }))[0]
      if (!compacted) return yield* Effect.die("Missing overflow compaction usage")
      expect(compacted).toMatchObject({ status: "completed", model: { variant: "medium" } })
      expect(yield* usage.assistants({ sessionID, requestID: compacted.requestID })).toMatchObject([{ model: { variant: "medium" } }])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Objective\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedModelIdentity],
        [expectedToolGuidance, PROMPT_DEFAULT, "Initial context", expectedReplacementIdentity],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          // 最后 queue 的非零结算与前面的零用量 steer 区分，不能只检查模型请求顺序。
          LLMEvent.stepFinish({ index: 0, reason: "stop",
            usage: { inputTokens: 10, nonCachedInputTokens: 8, outputTokens: 4, reasoningTokens: 1, cacheReadInputTokens: 2 } }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      const queued = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      const steer = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      // gate 内的新 admission 尚未提升，必须有独立零请求，不能显示 Queue first 的回复。
      expect((yield* session.get(sessionID)).request).toMatchObject({ messageID: steer.id, input: 0, output: 0, cost: 0 })
      expect((yield* session.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* session.get(sessionID)).request?.model).toBeUndefined()
      // 放开边界后先提升 steers，再提升早接纳的 Queue second；最终身份按可见顺序。
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
      const messages = yield* session.messages({ sessionID, order: "asc" })
      const lastAssistant = messages.findLast((message) => message.type === "assistant")
      // 上方第四轮 provider request 证明 queue 最后执行；消息只检查存在性，助手按 durable 序列取最后一步。
      expect(messages.some((message) => message.type === "user" && message.id === queued.id)).toBe(true)
      expect(lastAssistant).toBeDefined()
      expect((yield* session.get(sessionID)).request).toMatchObject({
        messageID: queued.id, assistantID: lastAssistant?.id, input: 10, output: 4, cost: 0,
      })
    }),
  )

  it.effect("selects mixed entry requests by durable visibility and admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      requests.length = 0
      const queued = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "mixed native queue" }), delivery: "queue", resume: false })
      // V1 noReply 保存用户后返回；直接使用它真实的 MessageUpdated 持久边界，不模拟第二个时钟。
      const legacy = { id: SessionV1.MessageID.ascending(), sessionID, role: "user" as const, time: { created: DateTime.toEpochMillis(queued.timeCreated) + 1 },
        agent: "build", model: { providerID: ProviderV2.ID.make("fake"), modelID: ModelV2.ID.make("fake-model") } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: legacy })
      expect((yield* session.get(sessionID)).request).toMatchObject({ messageID: legacy.id, input: 0, output: 0, cost: 0 })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop",
          usage: { inputTokens: 10, nonCachedInputTokens: 8, outputTokens: 4, reasoningTokens: 1, cacheReadInputTokens: 2 } }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      // 真实 resume 提升早接纳的 queue；V1 创建时间刻意晚于 admission，旧 UNION 时间排序会误选零值。
      yield* session.resume(sessionID)
      expect(userTexts(requests.at(-1)!)).toEqual(["mixed native queue"])
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.some((message) => message.type === "user" && message.id === queued.id)).toBe(true)
      expect((yield* session.get(sessionID)).request).toMatchObject({
        messageID: queued.id, assistantID: messages.findLast((message) => message.type === "assistant")?.id, input: 10, output: 4, cost: 0,
        // 混合入口最后提升的 queue 同时拥有 step 和请求累计，V1 noReply 不能使 step 归零。
        stepInput: 10, stepOutput: 4,
      })
      // 旧 V1 用户再次更新不是新请求，不能用最后 MessageUpdated 序号压过 native promotion。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...legacy, agent: "edited" } })
      expect((yield* session.get(sessionID)).request).toMatchObject({ messageID: queued.id, input: 10, output: 4, cost: 0 })
      const nextLegacyID = SessionV1.MessageID.ascending()
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...legacy, id: nextLegacyID, time: { created: legacy.time.created + 1 } } })
      expect((yield* session.get(sessionID)).request).toMatchObject({ messageID: nextLegacyID, input: 0, output: 0, cost: 0 })
      // 混合入口之后的新 admission 仍是独立零值，不能固定 native 优先或永远保留 V1 候选。
      const waiting = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "mixed waiting" }), delivery: "queue", resume: false })
      expect((yield* session.get(sessionID)).request).toMatchObject({ messageID: waiting.id, input: 0, output: 0, cost: 0 })
      // 再接纳等待请求后 step 也清零，不能借用刚完成的 native step。
      expect((yield* session.get(sessionID)).request).toMatchObject({ stepInput: 0, stepOutput: 0 })
      expect((yield* session.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* session.get(sessionID)).request?.model).toBeUndefined()
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
        { type: "assistant", finish: "stop" },
      ])
      const db = (yield* Database.Service).db
      const usage = SessionRequestUsage.make(db)
      const assistants = yield* db.select().from(RequestUsageAssistantTable).all()
      // 未确认 provider 用量的旧助手只补完成状态，工具中断不能伪造助手 Error 或计费 step。
      expect(assistants.find(row => row.step_count === 0)).toMatchObject({
        assistant_message_id: assistantMessageID, status: "completed", time_completed: 0, cost_micros: 0, tokens_total: 0,
      })
      expect(assistants).toHaveLength(2)
      const stale = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant" && message.id === assistantMessageID,
      )
      expect(stale?.time.completed).toBeDefined()
      expect(stale?.finish).toBeUndefined()
      expect(stale?.error).toBeUndefined()
      // 同请求的旧明细不再 running，新助手完成后原请求聚合才能真正到达 completed。
      expect(yield* usage.list({ sessionID })).toMatchObject([
        { status: "completed", assistantCount: 2, stepCount: 1, cost: 0, tokens: { total: 0 } },
      ])
      // 重放真实 durable 历史验证同一助手快照覆盖，不靠第二次手工写账本模拟幂等。
      yield* replaySessionProjection(sessionID)
      expect(yield* usage.list({ sessionID })).toMatchObject([{ status: "completed", assistantCount: 2, stepCount: 1, cost: 0 }])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toHaveLength(2)
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("adds session correlation headers to model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run correlated request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-opencode-session-id": sessionID,
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
      })
    }),
  )

  it.effect("adds the parent session header to child model requests", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const parentID = SessionV2.ID.make("ses_runner_parent")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ parent_id: parentID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run child request" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-opencode-session-id": sessionID,
        "x-opencode-parent-session-id": parentID,
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
        "x-parent-session-id": parentID,
      })
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider turn interrupted" },
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const db = (yield* Database.Service).db
      // 拒绝不是可续轮工具错误；助手和请求都须结束，已收到的零用量 step 仍计一次。
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([
        { status: "aborted", assistantCount: 1, stepCount: 1, cost: 0 },
      ])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toMatchObject([{ status: "aborted", step_count: 1 }])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider turn interrupted" },
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const db = (yield* Database.Service).db
      // 真实 Question.reject 产生 RejectedError，与权限拒绝共享同一 durable 中断结算。
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([
        { status: "aborted", assistantCount: 1, stepCount: 1, cost: 0 },
      ])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toMatchObject([{ status: "aborted", step_count: 1 }])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.live("retains interrupted Bash output across settlement and durable replay", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const outputStore = yield* ToolOutputStore.Service
      const contexts = yield* SystemContextRegistry.Service
      const events = yield* EventV2.Service
      const db = (yield* Database.Service).db
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      // 小输出和超过采集窗口的输出都经过真实 Bash/decoder/store；仅替换外部进程和 provider。
      for (const size of [16, BashTool.MAX_CAPTURE_BYTES + 16]) {
        const id = SessionV2.ID.make(`ses_cancel_bash_${size}`)
        const callID = `call-cancel-bash-${size}`
        yield* insertSession(id)
        const ready = yield* Deferred.make<void>()
        let processClosed = false
        const raw = `READY\n${"x".repeat(size)}\nFINAL_RESULT=42\u0007\u001b[31m\n完成\u001b[0m\r\n`
        const processLayer = Layer.mock(AppProcess.Service, {
          run: (_command, options) => Effect.gen(function* () {
            if (!options?.onOutput) return yield* Effect.die("Bash must observe the process stream")
            const bytes = Buffer.from(raw)
            // 跨块 Unicode 的尾字节在取消前交齐，恢复原文和直接预览均不得产生替换字符。
            yield* options.onOutput(bytes.subarray(0, bytes.length - 2))
            yield* options.onOutput(bytes.subarray(bytes.length - 2))
            yield* Deferred.succeed(ready, undefined)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Effect.sync(() => { processClosed = true }))),
        })
        const bash = AppNodeBuilder.build(BashTool.node, [
          [ToolRegistry.node, Layer.merge(Layer.succeed(ToolRegistry.Service, registry), Layer.succeed(Tools.Service, Tools.Service.of({ register: registry.register })))],
          [ToolOutputStore.node, Layer.succeed(ToolOutputStore.Service, outputStore)],
          [Location.node, Location.boundNode({ directory: AbsolutePath.make(tmp.path) })],
          [SystemContextRegistry.node, Layer.succeed(SystemContextRegistry.Service, contexts)],
          [Config.node, config],
          [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
          [AppProcess.node, processLayer],
        ])
        yield* Effect.gen(function* () {
          yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Run then interrupt" }), resume: false })
          responseStream = Stream.concat(Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: callID, name: "bash", input: { command: "echo ready", compress_output: false } }),
          ]), Stream.never)
          const release = yield* Deferred.make<void>()
          const off = yield* events.listen((event) => event.type === SessionEvent.Tool.Progress.type ? Deferred.await(release) : Effect.void)
          yield* Effect.addFinalizer(() => off.pipe(Effect.andThen(Deferred.succeed(release, undefined)), Effect.asVoid))
          const run = yield* session.resume(id).pipe(Effect.forkChild)
          yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"))
          // 普通监听器故意阻塞；取消末尾的 durable progress 必须使用退出安全通知。
          const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, undefined)), Effect.forkChild)
          yield* session.interrupt(id).pipe(Effect.timeout("1 second"))
          expect(yield* Deferred.isDone(release)).toBe(false)
          yield* Fiber.interrupt(rescue)
          yield* off
          yield* Deferred.succeed(release, undefined)
          const exit = yield* Fiber.await(run)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(processClosed).toBe(true)
          const messages = yield* session.context(id)
          const tool = messages.flatMap((message) => message.type === "assistant" ? message.content : []).find((part) => part.type === "tool")
          if (tool?.type !== "tool" || tool.state.status !== "error") return yield* Effect.die("Expected an interrupted tool, never Success")
          expect(tool.state.structured).toMatchObject({ interrupted: true, truncated: size > BashTool.MAX_CAPTURE_BYTES })
          expect(tool.state.structured).not.toHaveProperty("exit")
          expect(tool.state.structured).not.toHaveProperty("timeout")
          const text = tool.state.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
          expect(text).toContain("FINAL_RESULT=42")
          expect(text).toContain("FINAL_RESULT=42\\x07")
          expect(text).not.toContain("\u0007")
          expect(text).not.toContain("\u001b")
          expect(text).toContain("完成")
          expect(text).toContain('reason="user_abort"')
          expect(text).not.toContain("�")
          if (size === 16) expect(text).toContain("READY")
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
          const retained = /(?:captured raw output saved to |path=")(.+?)(?: \.\.\.|" \/>)/.exec(text)?.[1]
          if (!retained) return yield* Effect.die("Expected the canonical raw recovery marker")
          // 进程与 capture 已退出后仍能恢复全部原文，不能只检查一个会被 cleanup 删除的路径。
          expect(Buffer.from(yield* Effect.promise(() => Bun.file(retained).arrayBuffer()))).toEqual(Buffer.from(raw))
          const recorded = yield* db.select({ type: EventTable.type }).from(EventTable).where(eq(EventTable.aggregate_id, id)).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
          const types = recorded.map((row) => row.type)
          const progress = EventV2.versionedType(SessionEvent.Tool.Progress.type, 1)
          const failed = EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)
          expect(types.filter((type) => type === progress)).toHaveLength(1)
          expect(types.filter((type) => type === failed)).toHaveLength(1)
          expect(types.indexOf(progress)).toBeLessThan(types.indexOf(failed))
          expect(types).not.toContain(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))
          yield* replaySessionProjection(id)
          expect(yield* session.context(id)).toEqual(messages)
          expect(Buffer.from(yield* Effect.promise(() => Bun.file(retained).arrayBuffer()))).toEqual(Buffer.from(raw))
          // 真实下一轮 request 必须同时携带失败状态和保留下来的正文，不用手工拼装 model messages 自证。
          requests.length = 0
          responseStream = undefined
          response = []
          yield* session.resume(id)
          const result = requests[0]?.messages.find((message) => message.role === "tool")
          expect(result).toBeDefined()
          expect(JSON.stringify(result)).toContain("FINAL_RESULT=42")
          expect(JSON.stringify(result)).toContain(JSON.stringify(retained).slice(1, -1))
          expect(JSON.stringify(result)).toContain("Tool execution interrupted")
        }).pipe(Effect.provide(bash))
      }
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.live("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls",
          usage: { inputTokens: 10, nonCachedInputTokens: 8, outputTokens: 4, reasoningTokens: 1, cacheReadInputTokens: 2 } }),
      ]
      const providerFinished = yield* Deferred.make<void>()
      // 明确等到 step-finish 被 publisher 接收，再中断仍阻塞的工具，避免测试只覆盖流中断。
      responseStream = Stream.concat(
        Stream.fromIterable(response),
        Stream.fromEffect(Deferred.succeed(providerFinished, undefined).pipe(Effect.as(LLMEvent.finish({ reason: "tool-calls" })))),
      )

      // public Coordinator 取消也须跨过 Tool.Failed/Step.Failed/已确认 Step.Ended 的普通阻塞通知。
      const events = yield* EventV2.Service
      const release = yield* Deferred.make<void>()
      const off = yield* events.listen(event => event.type === SessionEvent.Tool.Failed.type || event.type === SessionEvent.Step.Failed.type || event.type === SessionEvent.Step.Ended.type ? Deferred.await(release) : Effect.void)
      yield* Effect.addFinalizer(() => off.pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.asVoid))
      const delivered = yield* events.subscribe(SessionEvent.Step.Ended).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(providerFinished)
      while (executions.length === 0) yield* Effect.yieldNow
      const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      yield* session.interrupt(sessionID).pipe(Effect.timeout("1 second"))
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(rescue)
      yield* off
      expect(Array.from(yield* Fiber.join(delivered).pipe(Effect.timeout("1 second")))).toMatchObject([{ data: { tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2 } } } }])
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider turn interrupted" },
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const db = (yield* Database.Service).db
      // 固定 provider 用量作为 oracle：失败不退款，也不把 Failed 与 Ended 算成两步。
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([
        { status: "aborted", assistantCount: 1, stepCount: 1, cost: 0,
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 }, total: 14 } },
      ])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toMatchObject([{ status: "aborted", step_count: 1 }])
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0, tokens_input: 8, tokens_output: 3, tokens_reasoning: 1, tokens_cache_read: 2 })
      expect(requests).toHaveLength(1)
      // 从真实 durable events 重建消息，账本快照 upsert 必须继续保留 aborted，不能重复计费。
      // helper 删除所有消息，因此会话累计也从零重建；助手账本保留以验证快照覆盖。
      yield* db.update(SessionTable).set({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0,
        tokens_cache_read: 0, tokens_cache_write: 0 }).where(eq(SessionTable.id, sessionID)).run()
      yield* replaySessionProjection(sessionID)
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([{ status: "aborted", stepCount: 1, tokens: { total: 14 } }])
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0, tokens_input: 8, tokens_output: 3 })
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      // 最后一步没有工具，即使静态族正文提到工具也必须明确覆盖。
      expect(requests[1]?.system.map(part => part.text).join("\n")).toContain("NO tools are currently available")
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      // provider-error 可能晚于确认 usage；providerFailed 不能抹掉已发生的消耗。
      response = [LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { nonCachedInputTokens: 8 } }),
        LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", tokens: { input: 8 }, error: { type: "unknown", message: "Provider unavailable" } },
      ])
      const db = (yield* Database.Service).db
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([
        { status: "error", assistantCount: 1, stepCount: 1, tokens: { input: 8, total: 8 } },
      ])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toMatchObject([{ status: "error", step_count: 1 }])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail malformed stream" }), resume: false })
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
      // stream 缺陷保留原失败 cause，但已开始助手仍要终结；未收到 step-finish 不虚构用量。
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" }, { type: "assistant", finish: "error", error: { message: "Duplicate text start: text-1" } },
      ])
      const db = (yield* Database.Service).db
      expect(yield* SessionRequestUsage.make(db).list({ sessionID })).toMatchObject([
        { status: "error", assistantCount: 1, stepCount: 0, tokens: { total: 0 } },
      ])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toMatchObject([{ status: "error", step_count: 0 }])
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )
})

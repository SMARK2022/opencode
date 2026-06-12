import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Logging } from "@opencode-ai/core/observability/logging"
import { Logger, References } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionReviewer } from "@/permission/reviewer/service"
import { PermissionSessionCache } from "@/permission/cache/session-cache"
import { PermissionCircuitBreaker } from "@/permission/reviewer/circuit-breaker"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      native: () => Effect.die("unexpected Native MCP connection in prompt-effect tests"),
      snapshot: () => Effect.succeed({ tools: {}, clients: {}, instructions }),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  // #209：reviewer/cache/circuit 必须与 Permission 并列声明——LayerNode.compile 用
  // #209：Layer.provide 丢弃未被静态需求的服务层；Permission 用 serviceOption 查询，
  // #209：仅靠 Permission.node deps 隐式提供时 reviewer 运行时不可达，集成测试失败。
  PermissionReviewer.node,
  PermissionSessionCache.node,
  PermissionCircuitBreaker.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  // 测试与 prompt/processor 共用同一个全局 Database 账本，不能只断言完成后的消息投影。
  SessionRequestUsage.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking"; plugin?: Layer.Layer<Plugin.Service>; database?: Layer.Layer<Database.Service> }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    ...(input?.database ? [[Database.node, input.database] as const] : []),
    ...(input?.plugin ? [[Plugin.node, input.plugin] as const] : []),
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

// #159：收紧 context/input，迫使 decide 窗口裁掉超大历史轮
function limitedDecideProviderCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    compaction: { reserved: 0 },
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        models: {
          "test-model": {
            ...base.provider.test.models["test-model"],
            limit: { context: 20_000, input: 10_000, output: 1_000 },
          },
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
// #227：文本 JSON 与工具输入 schema 同构——回退解析依赖严格结构而非自由文本
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

// Permission prompts are asynchronous tool side effects. Poll the public
// Permission.Service list so tests observe the same pending request that a UI
// would render, without depending on private prompt-loop scheduling details.
const waitForPermission = Effect.fn("test.waitForPermission")(function* (count: number) {
  const permission = yield* Permission.Service
  return yield* pollWithTimeout(
    Effect.gen(function* () {
      const pending = yield* permission.list()
      return pending.length === count ? pending : undefined
    }),
    `permission request count never reached ${count}`,
  )
})


const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addCompletedTool = (sessionID: SessionID, messageID: MessageID) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    // #137：构造已完成 tool 尾，验证手动压缩后 loop 不再二次 build
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      callID: crypto.randomUUID(),
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "printf tail" },
        output: "tail output",
        title: "done",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    })
  })

// #159：写入 reasoning 供 decide 截断首尾校验
const addReasoning = (sessionID: SessionID, messageID: MessageID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "reasoning",
      text,
      time: { start: Date.now(), end: Date.now() },
    })
  })

const addStepFinish = (sessionID: SessionID, messageID: MessageID, inputChars: number, inputTokens: number) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    // #140：写入 step-finish 输入侧样本，供 chars/token 校准
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      inputChars,
    })
  })

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
// #227：JSON 回退测试会话——auto 规则使 bash 请求进入 reviewer 而非用户审批
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
// #227：测试一——模型只回纯文本 JSON 而不调用工具，验证 json_fallback 合成路径
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

// #159：decide 无工具 + 历史 tool/reasoning 消毒
// 断言：WITHOUT tools、无 tool role、reasoning 中段被截断
it.instance("decide sends no tools and sanitizes historical tool and reasoning context", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Decide" })
    // 上一轮 stop 后追加 tool/reasoning，供消毒路径消费
    const previous = yield* seed(session.id, { finish: "stop" })
    // 首尾各 200 字符锚点，中段应被 truncateThinking 去掉
    const keepHead = "prefix-" + "a".repeat(193)
    const keepTail = "z".repeat(193) + "-suffix"

    yield* addCompletedTool(session.id, previous.assistant.id)
    yield* addReasoning(session.id, previous.assistant.id, keepHead + "-middle-" + "m".repeat(80) + keepTail)
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "decide",
      noReply: true,
      parts: [{ type: "text", text: "decide now" }],
    })
    yield* llm.text("decision")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const inputs = yield* llm.inputs
    const body = inputs.at(-1)
    expect(body).toBeDefined()
    if (!body) return

    const serialized = JSON.stringify(body)
    expect(serialized).toContain("# WITHOUT any tools")
    expect(serialized).not.toContain("# Using your tools")
    // 空工具表：未定义或空对象均可
    expect(body.tools === undefined || Object.keys(body.tools as object).length === 0).toBe(true)
    expect(JSON.stringify(body.messages)).not.toContain('"role":"tool"')
    expect(JSON.stringify(body.messages)).not.toContain("tool-call")
    expect(JSON.stringify(body.messages)).toContain("tail output")
    expect(serialized).toContain(keepHead)
    expect(serialized).toContain(keepTail)
    expect(serialized).not.toContain("-middle-")
  }),
)

// #159：旧轮过大时 decide 窗口从最新 user 起
// limitedDecideProviderCfg 压低 input limit，迫使 selectDecideMessages 裁剪
it.instance("decide starts context at latest user prompt when older turn would overflow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(limitedDecideProviderCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Decide context" })
    // 超大旧 user：tokenEstimate 后必超 usable
    const old = yield* user(session.id, "old-marker " + "x".repeat(80_000))
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: old.id,
      sessionID: session.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    }
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: session.id,
      type: "text",
      text: "old answer",
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "decide",
      noReply: true,
      parts: [{ type: "text", text: "current-marker decide now" }],
    })
    yield* llm.text("decision")
    yield* prompt.loop({ sessionID: session.id })

    const inputs = yield* llm.inputs
    const body = inputs.at(-1)
    expect(body).toBeDefined()
    if (!body) return
    expect(JSON.stringify(body.messages)).toContain("current-marker")
    expect(JSON.stringify(body.messages)).not.toContain("old-marker")
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)


// #150：running task tool 取消必须传播到子会话 idle（异步 settle）
// #150：tip harness 必须 user()+prompt.loop，禁止单独 prompt fiber（否则 task 不会 running）

// #173：无 runner 时 cancel 仍须把 running/pending tool 标 interrupted
// #173：seed 后不启动 loop，专门覆盖 stale tool 收口
it.instance(
  "cancel finalizes stale running tool parts without an active runner",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const { assistant } = yield* seed(chat.id)
      const started = Date.now()

      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "call_running",
        tool: "read",
        state: {
          status: "running",
          input: { filePath: "README.md" },
          title: "Read README.md",
          metadata: { source: "stale-test" },
          time: { start: started },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "call_pending",
        tool: "bash",
        state: {
          status: "pending",
          input: { command: "sleep 30" },
          raw: '{"command":"sleep 30"}',
        },
      })

      // #173：cancel 后断言 tool error+interrupted，而非仍 pending
      yield* prompt.cancel(chat.id)

      const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })
      const tools = stored.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
      expect(tools.length).toBe(2)
      for (const tool of tools) {
        expect(tool.state.status).toBe("error")
        if (tool.state.status === "error") {
          expect(tool.state.error).toBe("Tool execution aborted")
          expect(tool.state.metadata?.interrupted).toBe(true)
        }
      }
    }),
  30_000,
)

it.instance(
  "cancel propagates from running task tool to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // #150：用 task tool 拉起真实子会话，覆盖 cancel 传播入口
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "run a subagent")
      // #150：fork loop fiber（与 preserves-metadata / slash-cancel 同入口）
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // #150：等到 task running 且带 child sessionId
      const childID = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.parts.some((part) => part.type === "tool" && part.tool === "task"))
          const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
          if (tool?.state.status !== "running") return undefined
          const sessionID = tool.state.metadata?.sessionId
          if (typeof sessionID !== "string") return undefined
          return SessionID.make(sessionID)
        }),
        "running task tool never exposed child session id",
        "10 seconds",
      )
      // #150：先等到 child busy，再 cancel，避免未启动竞态
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* status.get(childID)
          return s.type === "busy" ? (true as const) : undefined
        }),
        `child ${childID} never became busy`,
        "5 seconds",
      )

      // 单次 cancel 触发全量清理，验证不依赖多次调用
    yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      // #150：父会话 cancel 后必须 idle
      expect((yield* status.get(chat.id)).type).toBe("idle")
      // #150：子会话 idle 需 wait/poll，禁止瞬时 get
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* status.get(childID)
          return s.type === "idle" ? (true as const) : undefined
        }),
        `child ${childID} never became idle after task cancel`,
        "5 seconds",
      )
    }),
  { config: cfg },
  30_000,
)


it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const usage = yield* SessionRequestUsage.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").usage({ input: 8, output: 3 }).contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
      // 同一已确认 step 的 tokens/cost 保留，最后追加的错误必须同时出现在助手和请求账本。
      expect(stored.info.finish).toBe("content-filter")
      const settled = { status: "error", stepCount: 1, cost: result.info.cost, tokens: { input: 8, output: 3, total: 11 }, error: expected.data.message }
      expect(result.info.tokens).toMatchObject({ input: 8, output: 3 })
      expect(stored.info.tokens).toMatchObject({ input: 8, output: 3 })
      expect(yield* usage.get({ sessionID: chat.id, requestID: result.info.parentID })).toMatchObject({ ...settled, assistantCount: 1 })
      expect(yield* usage.assistants({ sessionID: chat.id, requestID: result.info.parentID })).toMatchObject([{ ...settled, assistantMessageID: result.info.id }])
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
    // 同一既有进程内用例覆盖另一条终验分支，不依赖外部 structured-output live API。
    const structuredChat = yield* sessions.create({ title: "Missing structured output" })
    yield* prompt.prompt({
      sessionID: structuredChat.id, agent: "build", noReply: true,
      format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "object" }, retryCount: 0 }),
      parts: [{ type: "text", text: "Return structured output" }],
    })
    yield* llm.push(reply().text("plain response").usage({ input: 5, output: 2 }).stop())
    const structuredResult = yield* prompt.loop({ sessionID: structuredChat.id })
    const structuredStored = yield* MessageV2.get({ sessionID: structuredChat.id, messageID: structuredResult.info.id })
    if (structuredResult.info.role !== "assistant" || structuredStored.info.role !== "assistant") return yield* Effect.die("Expected structured-output assistant")
    const structuredError = { name: "StructuredOutputError" as const, data: { message: "Model did not produce structured output", retries: 0 } }
    expect(structuredResult.info.finish).toBe("stop")
    expect(structuredResult.info.error).toEqual(structuredError)
    expect(structuredStored.info.error).toEqual(structuredResult.info.error)
    expect(structuredResult.info.tokens).toMatchObject({ input: 5, output: 2 })
    expect(structuredStored.info.tokens).toMatchObject({ input: 5, output: 2 })
    // 格式失败也只修订同一助手快照，不能丢确认用量或把第二次记录计成两步。
    const structuredSettled = { status: "error", stepCount: 1, cost: structuredResult.info.cost, tokens: { input: 5, output: 2, total: 7 }, error: structuredError.data.message }
    expect(yield* usage.get({ sessionID: structuredChat.id, requestID: structuredResult.info.parentID })).toMatchObject({ ...structuredSettled, assistantCount: 1 })
    expect(yield* usage.assistants({ sessionID: structuredChat.id, requestID: structuredResult.info.parentID })).toMatchObject([{ ...structuredSettled, assistantMessageID: structuredResult.info.id }])
    expect(yield* llm.hits).toHaveLength(2)
    // 合法持久化选择不保证 catalog 存在；真实 prompt 在助手创建前失败也必须闭合账本。
    const failedChat = yield* sessions.create({ title: "Missing catalog model" })
    const failedID = MessageID.ascending()
    const missingModel = { providerID: ref.providerID, modelID: ModelV2.ID.make("missing-catalog-model") }
    const failedExit = yield* prompt.prompt({
      sessionID: failedChat.id, messageID: failedID, agent: "build", model: missingModel,
      parts: [{ type: "text", text: "Use the unavailable catalog model" }],
    }).pipe(Effect.exit)
    expect(Exit.isFailure(failedExit)).toBe(true)
    if (!Exit.isFailure(failedExit)) return yield* Effect.die("Expected catalog preparation failure")
    const failure = Cause.squash(failedExit.cause)
    if (!ProviderSvc.ModelNotFoundError.isInstance(failure)) return yield* Effect.die("Expected original model-not-found cause")
    expect(failure).toMatchObject({ providerID: missingModel.providerID, modelID: missingModel.modelID })
    const failedMessages = yield* sessions.messages({ sessionID: failedChat.id })
    expect(failedMessages).toHaveLength(1)
    expect(failedMessages[0]?.info).toMatchObject({ id: failedID, role: "user", model: missingModel })
    expect(yield* sessions.get(failedChat.id)).toMatchObject({ model: { providerID: missingModel.providerID, id: missingModel.modelID } })
    const status = yield* SessionStatus.Service
    expect((yield* status.get(failedChat.id)).type).toBe("idle")
    // 零助手失败不虚构 provider 消费，公开明细必须为空并有真实完成时间。
    const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }
    expect(yield* usage.get({ sessionID: failedChat.id, requestID: failedID })).toMatchObject({ rootRequestID: failedID, status: "error", assistantCount: 0, stepCount: 0, cost: 0, tokens: zero, time: { completed: expect.any(Number) }, error: failure.message })
    expect(yield* usage.assistants({ sessionID: failedChat.id, requestID: failedID })).toEqual([])
    expect(yield* llm.hits).toHaveLength(2)
    // 两条真实后处理分支都在已提交错误的 listener 中阻塞，取消不能被通知屏蔽。
    for (const format of ["text", "json_schema"] as const) {
      const blockedChat = yield* sessions.create({ title: `Blocked ${format} error notification` })
      const userID = MessageID.ascending()
      const ready = yield* Deferred.make<MessageID>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, void 0).pipe(Effect.asVoid))
      const blockedOff = yield* events.listen(event => Effect.gen(function* () {
        if (event.type !== MessageV2.Event.Updated.type) return
        const data = Schema.decodeUnknownSync(Schema.toType(MessageV2.Event.Updated.data))(event.data)
        if (data.sessionID !== blockedChat.id || data.info.role !== "assistant" || !data.info.error) return
        yield* Deferred.succeed(ready, data.info.id)
        yield* Deferred.await(release)
      }))
      yield* Effect.addFinalizer(() => blockedOff)
      const response = reply().text("blocked error response").usage({ input: 7, output: 4 })
      yield* llm.push(format === "json_schema" ? response.stop() : response.contentFilter())
      const run = yield* prompt.prompt({
        sessionID: blockedChat.id, messageID: userID, agent: "build", model: ref, parts: [{ type: "text", text: "Trigger postprocessing error" }],
        ...(format === "json_schema" ? { format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "object" }, retryCount: 0 }) } : {}),
      }).pipe(Effect.forkChild)
      const assistantID = yield* awaitWithTimeout(Deferred.await(ready), "Postprocessing error listener was not reached")
      const durable = yield* MessageV2.get({ sessionID: blockedChat.id, messageID: assistantID })
      if (durable.info.role !== "assistant") return yield* Effect.die("Expected committed postprocessing assistant")
      const blockedError = format === "json_schema" ? structuredError : expected
      expect(durable.info.error).toEqual(blockedError)
      expect(durable.info.parentID).toBe(userID)
      const terminal = { status: "error", stepCount: 1, cost: durable.info.cost, tokens: { input: 7, output: 4, total: 11 }, error: blockedError.data.message }
      // 通知尚未返回，账本已与实际错误消息一起提交，不能等待 cancel finalizer 才修正。
      expect(yield* usage.get({ sessionID: blockedChat.id, requestID: userID })).toMatchObject({ ...terminal, assistantCount: 1 })
      // 救援只防旧不可中断代码挂死；正常取消必须在 release 触发之前完成。
      const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
      yield* prompt.cancel(blockedChat.id)
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* Fiber.interrupt(rescue)
      const cancelled = yield* Fiber.join(run)
      yield* blockedOff
      expect(cancelled.info).toMatchObject({ id: assistantID, error: blockedError })
      const final = yield* MessageV2.get({ sessionID: blockedChat.id, messageID: assistantID })
      expect(final.info).toEqual(durable.info)
      expect((yield* status.get(blockedChat.id)).type).toBe("idle")
      expect(yield* usage.get({ sessionID: blockedChat.id, requestID: userID })).toMatchObject({ ...terminal, assistantCount: 1 })
      expect(yield* usage.assistants({ sessionID: blockedChat.id, requestID: userID })).toMatchObject([{ ...terminal, assistantMessageID: assistantID }])
    }
    expect(yield* llm.hits).toHaveLength(4)
    // 首次助手提交后的 listener 故意拦截所有修订，退出 owner 不能重入该 listener。
    const startingChat = yield* sessions.create({ title: "Cancel initial assistant publication" })
    const startingID = MessageID.ascending()
    const startingReady = yield* Deferred.make<MessageID>()
    const startingRelease = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(startingRelease, void 0).pipe(Effect.asVoid))
    let notifications = 0
    const startingOff = yield* events.listen(event => Effect.gen(function* () {
      if (event.type !== MessageV2.Event.Updated.type) return
      const data = Schema.decodeUnknownSync(Schema.toType(MessageV2.Event.Updated.data))(event.data)
      if (data.sessionID !== startingChat.id || data.info.role !== "assistant") return
      notifications++
      yield* Deferred.succeed(startingReady, data.info.id)
      yield* Deferred.await(startingRelease)
    }))
    yield* Effect.addFinalizer(() => startingOff)
    // 退出终态必须同时进入 typed/all 实时流，不能只在数据库中可见。
    const typedTerminal = yield* events.subscribe(MessageV2.Event.Updated).pipe(Stream.filter(event => event.data.sessionID === startingChat.id && event.data.info.role === "assistant" && event.data.info.time.completed !== undefined), Stream.take(1), Stream.runCollect, Effect.forkChild)
    const allTerminal = yield* events.all().pipe(Stream.filter(event => {
      if (event.type !== MessageV2.Event.Updated.type) return false
      const data = Schema.decodeUnknownSync(Schema.toType(MessageV2.Event.Updated.data))(event.data)
      return data.sessionID === startingChat.id && data.info.role === "assistant" && data.info.time.completed !== undefined
    }), Stream.take(1), Stream.runCollect, Effect.forkChild)
    yield* Effect.yieldNow
    const starting = yield* prompt.prompt({ sessionID: startingChat.id, messageID: startingID, agent: "build", model: ref, parts: [{ type: "text", text: "Cancel before processor setup" }] }).pipe(Effect.forkChild)
    const startingAssistant = yield* awaitWithTimeout(Deferred.await(startingReady), "Initial assistant was not committed")
    expect(yield* usage.get({ sessionID: startingChat.id, requestID: startingID })).toMatchObject({ status: "running", assistantCount: 1, stepCount: 0, cost: 0, tokens: zero })
    const startingRescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(startingRelease, void 0)), Effect.forkChild)
    yield* prompt.cancel(startingChat.id)
    expect(yield* Deferred.isDone(startingRelease)).toBe(false)
    yield* Fiber.interrupt(startingRescue)
    const startingResult = yield* Fiber.join(starting)
    yield* startingOff
    expect(notifications).toBe(1)
    expect(Array.from(yield* awaitWithTimeout(Fiber.join(typedTerminal), "Typed terminal was not delivered"))).toMatchObject([{ data: { info: { id: startingAssistant, error: { name: "MessageAbortedError" } } } }])
    expect(Array.from(yield* awaitWithTimeout(Fiber.join(allTerminal), "All-event terminal was not delivered"))).toMatchObject([{ data: { info: { id: startingAssistant, error: { name: "MessageAbortedError" } } } }])
    expect(startingResult.info).toMatchObject({ id: startingAssistant, role: "assistant", error: { name: "MessageAbortedError" }, time: { completed: expect.any(Number) } })
    expect(yield* usage.get({ sessionID: startingChat.id, requestID: startingID })).toMatchObject({ rootRequestID: startingID, status: "aborted", assistantCount: 1, stepCount: 0, cost: 0, tokens: zero })
    expect((yield* status.get(startingChat.id)).type).toBe("idle")
    expect(yield* llm.hits).toHaveLength(4)
    // 普通预处理缺陷走相同 owner，原 defect identity 必须继续返回给真实 prompt 调用方。
    const transformFailure = new Error("Prompt message transform failed")
    let transformCalls = 0
    // fresh 只重建执行依赖；InstanceRef 的 project 与终态账本必须共用原真实数据库。
    const database = yield* Database.Service
    // 独立目录先写配置；完整图 fresh 重建捕获 Plugin 的 prompt，不能只替换叶服务。
    yield* provideTmpdirInstance(() => Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const usage = yield* SessionRequestUsage.Service
      const chat = yield* sessions.create({ title: "Fail actual message transform" })
      const id = MessageID.ascending()
      const exit = yield* prompt.prompt({ sessionID: chat.id, messageID: id, agent: "build", model: ref, parts: [{ type: "text", text: "Fail before handle.process" }] }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return yield* Effect.die("Expected preprocess defect")
      expect(Cause.squash(exit.cause)).toBe(transformFailure)
      expect(transformCalls).toBe(1)
      const assistant = (yield* sessions.messages({ sessionID: chat.id })).find(message => message.info.role === "assistant")
      if (!assistant || assistant.info.role !== "assistant") return yield* Effect.die("Missing owned assistant")
      expect(assistant.info).toMatchObject({ parentID: id, error: { name: "UnknownError", data: { message: transformFailure.message } }, time: { completed: expect.any(Number) } })
      expect(yield* usage.get({ sessionID: chat.id, requestID: id })).toMatchObject({ rootRequestID: id, status: "error", assistantCount: 1, stepCount: 0, cost: 0, tokens: zero, error: transformFailure.message })
      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }).pipe(Effect.provide(Layer.fresh(makePrompt({ database: Layer.succeed(Database.Service, database), plugin: Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => name === "experimental.chat.messages.transform" ? Effect.sync(() => { transformCalls++ }).pipe(Effect.andThen(Effect.die(transformFailure))) : Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }) })))), { config: providerCfg(llm.url) })
    expect(yield* llm.hits).toHaveLength(4)
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

// #137：手动压缩后只应有一次摘要 LLM 调用，不得把 retained tool tail 当新 build
it.instance("manual compaction stops after summarizing retained tool tail", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { tail_turns: 1 },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    // #137：显式 auto:false 走手动压缩终态分支
    const compact = yield* SessionCompaction.Service
    const chat = yield* sessions.create({
      title: "Manual compact",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* seed(chat.id, { finish: "stop" })
    const keep = yield* seed(chat.id, { finish: "stop" })
    yield* addCompletedTool(chat.id, keep.assistant.id)
    // #137：仅排队一次摘要响应，用于断言 hits===1
    yield* llm.text("summary")

    // #242：loop 的 compaction task 分支已移除——手动压缩经 compact 直调生产者，
    // 持久化 marker 只作为已完成边界，不再成为 loop 可拾取的排队命令
    const result = yield* prompt.compact({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      auto: false,
    })
    const filtered = yield* MessageV2.filterCompactedEffect(chat.id)

    // #137：核心断言——手动压缩后 provider 只调用一次
    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    // #137：返回摘要 assistant，而非新 build 回合
    if (result.info.role === "assistant") expect(result.info.summary).toBe(true)
    // #137：retained tail 仍可见，但不得二次 provider 调用
    expect(filtered.map((msg) => msg.info.id)).toContain(keep.user.id)
    expect(filtered.map((msg) => msg.info.id)).toContain(keep.assistant.id)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

// #140：auto compact 后不得因 retained 旧 tail 用量再次压缩
it.instance("auto compaction resumes without compacting retained old tail usage again", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { tail_turns: 1 },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const compact = yield* SessionCompaction.Service
    const chat = yield* sessions.create({
      title: "Auto compact",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* seed(chat.id, { finish: "stop" })
    const old = yield* seed(chat.id, { finish: "tool-calls" })
    // #140：旧 assistant 巨量 tokens 模拟 retained tail
    old.assistant.tokens = { input: 300_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    yield* sessions.updateMessage(old.assistant)
    yield* addCompletedTool(chat.id, old.assistant.id)
    yield* addStepFinish(chat.id, old.assistant.id, 12_000, 3_000)
    // #242: run consumes the summary immediately; markers are not replayable work.
    yield* llm.text("summary")
    yield* llm.text("resumed")
    const compacted = yield* compact.run({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      auto: true,
    })

    expect(compacted).toBe("continue")
    const filtered = yield* MessageV2.filterCompactedEffect(chat.id)
    expect(filtered.map((msg) => msg.info.id)).toContain(old.user.id)
    expect(filtered.map((msg) => msg.info.id)).toContain(old.assistant.id)
    expect(filtered.some(msg => msg.info.role === "user" && msg.parts.some(part => part.type === "text" && part.metadata?.compaction_continue === true))).toBe(true)

    const result = yield* prompt.loop({ sessionID: chat.id })
    if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
    const all = yield* sessions.messages({ sessionID: chat.id })
    const compactions = all.flatMap((msg) => msg.parts).filter((part) => part.type === "compaction")

    // #140：摘要 + 恢复共 2 次 LLM；仅 1 个 compaction part
    expect(yield* llm.hits).toHaveLength(2)
    expect(compactions).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.agent).toBe("build")
      expect(result.parts.some((part) => part.type === "text" && part.text === "resumed")).toBe(true)
    }
  }),
)


it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
// #227：第二次调用是修复格式的协议 nudge 重试——证据与请求上下文不变
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    // Install the real file logger locally; closing its scope flushes before the assertions.
    const result = yield* prompt.loop({ sessionID: session.id }).pipe(
      Effect.provide(
        Logger.layer([Logging.fileLogger(path.join(dir, "timing.log"))]).pipe(
          Layer.provide(NodeFileSystem.layer),
          Layer.orDie,
        ),
      ),
      Effect.provideService(References.MinimumLogLevel, "Info"),
    )
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)

    // 行为断言读取测试局部的真实 Effect file log：必须能串起 processor/tool timing，
    // 同时确认诊断日志没有泄漏工具输入 pattern 或工具输出路径。
    const timing = yield* pollWithTimeout(
      Effect.promise(() => Bun.file(path.join(dir, "timing.log")).text().catch(() => "")).pipe(
        Effect.map((content) => {
          const lines = content.split("\n").filter((line) => line.includes(`${session.id}`) && line.includes(" timing"))
          return lines.some((line) => line.includes("phase=processor.end")) &&
          lines.some((line) => line.includes("phase=tool.end") && line.includes("status=completed"))
            ? lines.join("\n")
            : undefined
        }),
      ),
      "timing logs never reached the daemon log",
    )
    expect(timing).toContain("phase=ai.first_event")
    expect(timing).toContain("phase=part.first_delta")
    expect(timing).not.toContain("**/*.txt")
    expect(timing).not.toContain(file)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

// #139：真实 Promise hook 拒绝不能阻断已完成 command 的总结续跑。
it.instance("subtask after hook defects preserve terminal state and command continuation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    const plugin = yield* Plugin.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const task = (yield* registry.named()).task
    const execute = task.execute
    task.execute = () =>
      Effect.succeed({
        title: "subtask",
        metadata: { parentSessionId: chat.id, sessionId: SessionID.make("ses_after_hook"), model: ref },
        output: "subtask done",
      })
    yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = execute)))
    const calls: string[] = []
    const hook = {
      "tool.execute.after": async (input: { tool: string; sessionID: string }) => {
        if (input.tool !== "task" || input.sessionID !== chat.id) return
        calls.push(input.tool)
        throw new Error("after hook defect")
      },
    }
    const hooks = yield* plugin.list()
    hooks.push(hook)
    yield* Effect.addFinalizer(() => Effect.sync(() => void hooks.splice(hooks.indexOf(hook), 1)))
    yield* llm.text("continued")
    const msg = yield* user(chat.id, "hello")
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: chat.id,
      type: "subtask",
      prompt: "inspect the cache key path",
      description: "inspect bug",
      agent: "general",
      model: ref,
      command: "inspect",
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(calls).toEqual(["task"])
    expect(yield* llm.calls).toBe(1)
    expect(result.parts.some((part) => part.type === "text" && part.text === "continued")).toBe(true)
    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") throw new Error("missing subtask assistant")
    expect(taskMsg.info.finish).toBe("tool-calls")
    expect(taskMsg.info.time.completed).toBeNumber()
    expect(completedTool(taskMsg.parts)?.state.output).toBe("subtask done")
    expect(
      msgs.some((item) =>
        item.parts.some(
          (part) =>
            part.type === "text" &&
            part.synthetic &&
            part.text === "Summarize the task tool output above and continue with your task.",
        ),
      ),
    ).toBe(true)
  }),
)

// #139：等待 after hook 时取消仍中断续跑，已提交终态保持完成。
it.instance(
  "cancel during subtask after hook preserves terminal state without command continuation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const registry = yield* ToolRegistry.Service
      const plugin = yield* Plugin.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const task = (yield* registry.named()).task
      const execute = task.execute
      task.execute = () =>
        Effect.succeed({
          title: "subtask",
          metadata: { parentSessionId: chat.id, sessionId: SessionID.make("ses_after_hook"), model: ref },
          output: "subtask done",
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = execute)))
      const ready = defer<void>()
      const stopped = defer<void>()
      const hook = {
        "tool.execute.after": async (input: { tool: string; sessionID: string }) => {
          if (input.tool !== "task" || input.sessionID !== chat.id) return
          ready.resolve()
          await stopped.promise
        },
      }
      const hooks = yield* plugin.list()
      hooks.push(hook)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopped.resolve()
          hooks.splice(hooks.indexOf(hook), 1)
        }),
      )
      yield* llm.text("unexpected continuation")
      const msg = yield* user(chat.id, "hello")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "subtask",
        prompt: "inspect the cache key path",
        description: "inspect bug",
        agent: "general",
        model: ref,
        command: "inspect",
      })

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Effect.promise(() => ready.promise), "after hook never started", "10 seconds")
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect(yield* llm.calls).toBe(0)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") throw new Error("missing subtask assistant")
      expect(taskMsg.info.finish).toBeDefined()
      expect(taskMsg.info.time.completed).toBeNumber()
      expect(completedTool(taskMsg.parts)?.state.output).toBe("subtask done")
      expect(
        msgs.some((item) =>
          item.parts.some(
            (part) =>
              part.type === "text" &&
              part.synthetic &&
              part.text === "Summarize the task tool output above and continue with your task.",
          ),
        ),
      ).toBe(false)
    }),
  15_000,
)

// #209：验证 reviewer streaming 持久化真实 reasoning 和 decision tool part
// #209：端到端测试——mock LLM 返回 reasoning + permission_review_decision tool call，验证子会话持久化了各 part
it.instance(
  "auto permission reviewer persists real reasoning and decision tool parts",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer stream" })
      const command = String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa"`
      // #209：mock LLM 响应先发 reasoning 再调用 decision tool——模拟真实 reviewer 的推理-决策两阶段流
      yield* llm.push(
        reply()
          .reason("Checking whether the user explicitly authorized private key disclosure.")
          .tool("permission_review_decision", {
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "private key read was not explicitly authorized",
          })
          .item(),
      )

      // #209：触发 auto 权限审查——ruleset 设为 auto 使敏感读取进入 reviewer 流程
      // #209：Effect.flip 因为 reviewer deny 会使 ask 失败——flip 把失败转为成功值以继续断言持久化结果
      yield* permissions
        .ask({
          sessionID: chat.id,
          permission: "bash",
          patterns: [command],
          // #225：测试 metadata.agent 用小写 auto
          metadata: { command, agent: "auto" },
          always: ["*"],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        })
        .pipe(Effect.flip)

      // #209：reviewer 子会话作为父会话的 child 创建——find by agent 验证子会话已建立
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      // #209：从 reviewer 子会话拉取持久化消息——streamText 的 part 应已写入数据库
      const msgs = yield* MessageV2.filterCompactedEffect(reviewer.id)
      // #209：inputs 捕获发送给 provider 的请求——验证 tool_choice、tools、max_tokens 等 streamText 参数
      const inputs = yield* llm.inputs
      // #209：streamText 不强制 tool_choice=required——部分 provider 拒绝 forced tool_choice
      expect(inputs[0].tool_choice).not.toBe("required")
      expect(JSON.stringify(inputs[0].tools)).toContain("permission_review_decision")
      expect(inputs[0].tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: "permission_review_decision",
              parameters: expect.objectContaining({ type: "object" }),
            }),
          }),
        ]),
      )
      // #209：maxOutputTokens 返回 model.limit.output=10000
      expect(inputs[0].max_tokens).toBe(10000)
      // #214：reviewID 从父工具 autoReview metadata mirror 到 reviewer 子会话 request part
      const requestPart = msgs
        .flatMap((msg) => msg.parts)
        .find((part) => part.type === "text" && (part as { metadata?: Record<string, unknown> }).metadata?.permissionReviewerRequest === true)
      const requestID = (requestPart as { metadata?: Record<string, unknown> })?.metadata?.reviewID
      // #214：reviewID 是审计 join key——UI/导出代码可按逻辑审查定位精确请求，无需解析 prompt 文本
      expect(typeof requestID).toBe("string")
      // #209：reviewer 请求 cell 带 permissionReviewerRequest metadata
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true),
        ),
      ).toBe(true)
      // #209：streaming 持久化 reasoning part
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "reasoning" && part.text.includes("explicitly authorized")),
        ),
      ).toBe(true)
      // #209：streaming 持久化 decision tool part——验证 tool-call 事件把 assessment 写入 completed tool part
      // #209：tool part 的 metadata.rationale 必须与 mock LLM 返回的一致——证明 Schema.decode 未丢失字段
      expect(
        msgs.some((msg) =>
          msg.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "permission_review_decision" &&
              part.state.status === "completed" &&
              // #214：决策 part metadata mirror reviewID——子会话可按逻辑审查搜索/导出
              part.state.metadata?.reviewID === requestID &&
              part.state.metadata?.rationale === "private key read was not explicitly authorized",
          ),
        ),
      ).toBe(true)
    }),
  { git: true },
)

it.instance(
  "auto permission reviewer accepts structured JSON text decisions",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer JSON fallback" })
      const command = String.raw`rsync -av "/Volumes/My Passport/Calibration/" Sensetimex4:~/project/Calibration/`
// #227：远程传输命令需要高权限评估——仅作 reviewer 输入，测试环境不会真正执行
      yield* llm.push(
        reply()
          .text(
            JSON.stringify({
              outcome: "allow",
              risk_level: "high",
              user_authorization: "high",
              rationale: "user explicitly authorized the bounded remote transfer",
            }),
          )
          .stop()
          .item(),
      )

      yield* permissions.ask({
// #227：触发一次权限评估——断言 llm.calls=1 证明纯文本回退不消耗第二次 provider 调用
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      expect(yield* llm.calls).toBe(1)
// #227：无协议错误时单次调用——JSON 回退是解析层兜底，不是重试
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const reviewerParts = (yield* MessageV2.filterCompactedEffect(reviewer.id)).flatMap((msg) => msg.parts)
// #227：从 reviewer 子会话读取 parts——断言合成 part 带 json_fallback 来源标记
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.source === "json_fallback" &&
// #227：审计形状与工具调用路径一致——消费者靠 source 区分回退与真实工具调用
            part.state.metadata?.rationale === "user explicitly authorized the bounded remote transfer",
        ),
      ).toBe(true)
    }),
  { git: true },
)

it.instance(
  "auto permission reviewer hides malformed protocol attempts before retrying",
// #227：测试二——首次回复是散文而非工具调用，验证协议错误触发隐藏+重试
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer protocol retry" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      const malformed = "I can allow this request, but I forgot to submit the decision tool."
// #227：畸形输出不含工具调用——isReviewerDecisionProtocolError 识别后进入重试
      yield* llm.push(
        reply().text(malformed).stop().item(),
// #227：第一次 provider 回复畸形——重试前该尝试必须被隐藏
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "user explicitly authorized the bounded deletion",
          })
          .item(),
      )

      yield* permissions.ask({
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      expect(yield* llm.calls).toBe(2)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const visible = yield* MessageV2.filterCompactedEffect(reviewer.id)
// #227：过滤隐藏消息后断言——畸形尝试不可见，只留最终合法决策
      expect(
        visible.flatMap((msg) => msg.parts).filter((part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true),
      ).toHaveLength(1)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes(malformed)))).toBe(false)
// #227：畸形文本必须被隐藏——用户不应把散文答案误读为已批准
      expect(
        visible.some((msg) =>
          msg.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "permission_review_decision" &&
              part.state.status === "completed" &&
              part.state.metadata?.source === "tool_call" &&
              part.state.metadata?.rationale === "user explicitly authorized the bounded deletion",
          ),
        ),
      ).toBe(true)

      const allMessages = (yield* MessageV2.page({ sessionID: reviewer.id, limit: 20, includeHidden: true })).items
      expect(
        allMessages.filter(
          (msg) => msg.info.hidden && msg.parts.some((part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true),
        ),
      ).toHaveLength(1)
      expect(
        allMessages.filter(
          (msg) => msg.info.hidden && msg.parts.some((part) => part.type === "text" && part.text.includes(malformed)),
        ),
      ).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "auto permission reviewer fails closed after one malformed protocol retry",
  () =>
    Effect.gen(function* () {
      // #269：显式deny锁定协议耗尽的拒绝路径，默认人工回退由权限集成测试覆盖。
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { auto_review: { fallback: "deny" } },
      }))
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer protocol retry failure" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      // #227：两次畸形响应使协议重试耗尽——第二次失败后必须确定性拒绝而非放宽为允许
      yield* llm.push(
        reply().text("first malformed reviewer response").stop().item(),
        reply().text("second malformed reviewer response").stop().item(),
      )

      const exit = yield* permissions
        .ask({
          sessionID: chat.id,
          permission: "bash",
          patterns: [command],
          metadata: { command, agent: "auto" },
          always: ["*"],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      // #227：协议重试耗尽后必须确定性失败——AutoDeniedError 使调用方只能拒绝，不存在静默放行分支
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.AutoDeniedError)
      // #227：协议输出仅修复一次格式——重试一次后仍畸形即按拒绝退出，不追加更多模型调用
      expect(yield* llm.calls).toBe(2)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const visible = yield* MessageV2.filterCompactedEffect(reviewer.id)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("first malformed")))).toBe(false)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("second malformed")))).toBe(true)
    }),
  { git: true },
)

it.instance(
  "auto permission reviewer retries malformed decision tool input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer malformed tool retry" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      // #227：两次畸形响应使协议重试耗尽——第二次失败后必须确定性拒绝而非放宽为允许
      yield* llm.push(
        reply().tool("permission_review_decision", { outcome: "allow" }).item(),
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "user explicitly authorized the bounded deletion after malformed tool input",
          })
          .item(),
      )

      yield* permissions.ask({
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      expect(yield* llm.calls).toBe(2)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const visible = yield* MessageV2.filterCompactedEffect(reviewer.id)
      expect(
        visible.some((msg) =>
          msg.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "permission_review_decision" &&
              part.state.status === "completed" &&
              part.state.metadata?.source === "tool_call" &&
              part.state.metadata?.rationale === "user explicitly authorized the bounded deletion after malformed tool input",
          ),
        ),
      ).toBe(true)
    }),
  { git: true },
)

// #214：reviewer 子代理流重试瞬时 provider 故障后记录决策
it.instance(
  "auto permission reviewer retries transient provider failures before recording the decision",
  () =>
    Effect.gen(function* () {

      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer retry" })
      const command = "cat ~/.ssh/id_rsa"
      // #214：先推一个 503 错误模拟瞬时 reviewer 故障
      yield* llm.error(503, { error: "temporary reviewer outage" })
      yield* llm.push(
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "retry recovered and found explicit authorization",
          })
          .item(),
      )

      yield* permissions.ask({
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const msgs = yield* MessageV2.filterCompactedEffect(reviewer.id)
      // #214：重试后 provider 被调用 2 次——第一次 503，第二次成功
      expect(yield* llm.calls).toBe(2)
      expect(
        msgs.some((msg) =>
          msg.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "permission_review_decision" &&
              part.state.status === "completed" &&
              part.state.metadata?.rationale === "retry recovered and found explicit authorization",
          ),
        ),
      ).toBe(true)
    }),
  { git: true },
  10_000,
)

// #214：shell autoReview metadata 在实时输出更新和完成时存活
it.instance(
  "shell auto review metadata survives live output updates and completion",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        // 本例验证权限与工具metadata，独立关闭不相关的Git快照采集。
        snapshot: false,
        permission: { approvals_reviewer: "auto_review" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Shell review metadata",
        permission: [
          { permission: "bash", pattern: "*", action: "auto" },
          // #214：此测试针对 bash 审查包络——敏感路径会创建单独的 external_directory prompt 并阻止 shell
          { permission: "external_directory", pattern: "*", action: "allow" },
        ],
      })
      const key = path.join(chat.directory, ".ssh", "id_rsa")
      yield* Effect.promise(() => Bun.write(key, "fixture-key"))
      const command = process.platform === "win32" ? `Get-Content -LiteralPath "${key}"` : `cat "${key}"`
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "read the key" }],
      })
      yield* llm.push(
        reply().tool("bash", { command, description: "Read SSH private key via shell" }).item(),
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "user explicitly asked for this key read",
          })
          .item(),
        reply().text("done").stop().item(),
      )

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const shell = msgs
        .flatMap((msg) => msg.parts)
        .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
      expect(shell?.state.status).toBe("completed")
      if (shell?.state.status !== "completed") return
      // #214：shell 流式输出反复覆盖自身 output 预览 metadata——审查包络必须存活
      // #214：最终卡片仍链接到 reviewer 子会话而非静默丢失审计状态
      expect(shell.state.metadata?.output).toBeDefined()
      expect(shell.state.metadata?.autoReview?.status).toBe("allowed")
      expect(shell.state.metadata?.autoReview?.result?.rationale).toBe("user explicitly asked for this key read")
      const reviewID = shell.state.metadata?.autoReview?.reviewID
      expect(typeof reviewID).toBe("string")

      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const reviewerParts = (yield* MessageV2.filterCompactedEffect(reviewer.id)).flatMap((msg) => msg.parts)
      // #214：断言完整 parent-tool-to-child-transcript join——每次审查轮次需带父 autoReview.reviewID
      expect(
        reviewerParts.some(
          (part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true && part.metadata.reviewID === reviewID,
        ),
      ).toBe(true)
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.reviewID === reviewID,
        ),
      ).toBe(true)
    }),
  { git: true },
  15_000,
)

// #216：cancel 在 auto-review 进行中触发——验证中止状态正确传播到工具和 reviewer 子会话

it.instance(
  "auto agent tool permission requests carry auto agent evidence before approval",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        // 本例只验证权限身份传递，不让Git快照冷启动占用状态等待窗口。
        snapshot: false,
      }))
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Auto metadata permission gate",
        permission: [{ permission: "todowrite", pattern: "*", action: "ask" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "auto",
        noReply: true,
        parts: [{ type: "text", text: "track the work" }],
      })
      yield* llm.push(
        reply()
          .tool("todowrite", {
            todos: [{ content: "check permission metadata", status: "pending", priority: "high" }],
          })
          .item(),
      )
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
      yield* llm.wait(1)
      const [request] = yield* waitForPermission(1)
      expect(request.permission).toBe("todowrite")
      // Tool implementations should not each remember to copy ctx.agent into
      // metadata. The prompt adapter owns that permission fact so native auto can
      // enable reviewer consistently for every non-shell tool request.
      expect(request.metadata.agent).toBe("auto")
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      yield* Fiber.await(fiber)
    }),
  { git: true },
  10_000,
)

it.instance(
  "cancel aborts an in-flight shell auto review",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        // 审批中止不验证Git快照；隔离真实Windows快照I/O，确保进入目标审查边界。
        snapshot: false,
        permission: { approvals_reviewer: "auto_review" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      // #216：gate 控制 permission_review_decision 的推送——cancel 必须在 reviewer 响应前到达
      const gate = defer<void>()
      // #216：bash auto 权限触发 auto-review——cancel 须在 reviewer 审查期间到达
      const chat = yield* sessions.create({
        title: "Shell review cancel",
        permission: [{ permission: "bash", pattern: "*", action: "auto" }],
      })
      const command = "cat id_rsa"
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "review then cancel" }],
      })
      // #216：三段回复——bash 工具调用、gate 阻塞的审查决策、最终文本
      yield* llm.push(
        reply().tool("bash", { command, description: "Read SSH private key via shell" }).item(),
        reply()
          .wait(gate.promise)
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "this decision must not be recorded after cancel",
          })
          .item(),
        reply().text("done").stop().item(),
      )

      // #216：fork loop 使 cancel 可在 review 进行中并发触发
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      // 以真实请求到达作为就绪信号，短状态轮询不承担首次模型准备的等待。
      yield* llm.wait(2)

      // #216：等待 shell 工具进入 reviewing 状态——确认 auto-review 已启动
      const reviewing = yield* pollWithTimeout(
        Effect.gen(function* () {
          const part = (yield* MessageV2.filterCompactedEffect(chat.id))
            .flatMap((msg) => msg.parts)
            .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
          // 审查前已失败时直接呈现真实工具错误，不能用轮询超时掩盖入口故障。
          if (part?.state.status === "error") return yield* Effect.die(new Error(JSON.stringify(part)))
          if (part?.state.status === "running" && part.state.metadata?.autoReview?.status === "reviewing") return part
        }),
        "shell auto review never started",
      )
      const reviewID = reviewing.state.status === "running" ? reviewing.state.metadata?.autoReview?.reviewID : undefined
      expect(typeof reviewID).toBe("string")
      // #216：等待 reviewer 子会话出现——确认 permission-reviewer 已被创建
      const reviewer = yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
        }),
        "reviewer child session never started",
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* MessageV2.filterCompactedEffect(reviewer.id)).find(
            (msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } =>
              msg.info.role === "assistant" && !msg.info.time.completed,
          )
        }),
        "reviewer child assistant never started",
      )

      // #216：cancel 后再释放 gate——确保 reviewer 响应不晚于 cancel 写入
      yield* prompt.cancel(chat.id)
      gate.resolve()
      yield* awaitWithTimeout(Fiber.await(fiber), "session did not stop after review cancel", "5 seconds").pipe(Effect.ignore)

      const shell = yield* pollWithTimeout(
        Effect.gen(function* () {
          const part = (yield* MessageV2.filterCompactedEffect(chat.id))
            .flatMap((msg) => msg.parts)
            .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
          return part?.state.status === "error" ? part : undefined
        }),
        "shell tool never recorded the review cancellation",
      )
      expect(shell.state.status).toBe("error")
      if (shell.state.status !== "error") return
      // Cancel happens while the tool is still waiting for reviewer approval. The
      // parent tool must therefore expose one terminal abort state instead of a
      // stale "reviewing" line that looks live after the command has stopped.
      // #216：中止后 shell 工具必须终态化为 error 且携带 aborted 审查状态
      expect(shell.state.error).toBe("Tool execution aborted")
      expect(shell.state.metadata?.interrupted).toBe(true)
      expect(shell.state.metadata?.autoReview?.status).toBe("aborted")
      expect(shell.state.metadata?.autoReview?.error).toBe("Tool execution aborted")

      const reviewerMessages = yield* pollWithTimeout(
        Effect.gen(function* () {
          const messages = yield* MessageV2.filterCompactedEffect(reviewer.id)
          const assistants = messages.filter(
            (msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } => msg.info.role === "assistant",
          )
          return assistants.every((msg) => msg.info.time.completed) ? messages : undefined
        }),
        "reviewer child assistant remained active after cancellation",
      )
      const reviewerParts = reviewerMessages.flatMap((msg) => msg.parts)
      // #216：reviewer 的 permission_review_decision 不得在 cancel 后完成——中止须阻止延迟到达的审查决策
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.reviewID === reviewID,
        ),
      ).toBe(false)
      // #216：reviewer 不应执行 bash——中止阻止了 reviewer 代理执行被审查的命令
      expect(
        reviewerParts.some((part) => part.type === "tool" && part.tool === "bash"),
      ).toBe(false)
    }),
  { git: true },
  15_000,
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits directory grant beneath executing parent ask", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const agent = yield* AgentSvc.Service
    const general = yield* agent.get("general")
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = Permission.merge(general.permission, child.permission ?? [])
    expect(child.permission ?? []).not.toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    // 父 grant 不属于双方共同 allow 的边界，最终仍受执行父代理的 ask 限制。
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("ask")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

it.instance("cancel aborts all visible unfinished assistants", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const first = yield* user(chat.id, "first")
    const firstAssistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: first.id,
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    }
    // 第一个 assistant 带 text part（可见未完成），第二个为空体（应被 repair 隐藏）
    yield* sessions.updateMessage(firstAssistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: firstAssistant.id,
      sessionID: chat.id,
      type: "text",
      text: "partial",
    })

    const second = yield* user(chat.id, "second")
    // 复用同一 providerID/modelID，排除与取消语义无关的字段差异
    const secondAssistant: SessionV1.Assistant = {
      ...firstAssistant,
      id: MessageID.ascending(),
      parentID: second.id,
      time: { created: Date.now() },
    }
    yield* sessions.updateMessage(secondAssistant)

    yield* prompt.cancel(chat.id)

    // #153：cancel 覆盖全部未完成 assistant；空体者额外标记 repair 隐藏
    // stream 为 newest-first，reverse 后与创建顺序一致，便于按下标断言
    const msgs = (yield* MessageV2.stream(chat.id, { includeHidden: true })).slice().reverse()
    const aborted = msgs.filter(
      (msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } => msg.info.role === "assistant",
    )
    // 长度断言确保 cancel 恰好覆盖两条可见未完成 assistant，无遗漏无重复
    expect(aborted).toHaveLength(2)
    expect(aborted[0]?.info.time.completed).toBeDefined()
    expect(aborted[0]?.info.error?.name).toBe("MessageAbortedError")
    expect(aborted[1]?.info.time.completed).toBeDefined()
    expect(aborted[1]?.info.error?.name).toBe("MessageAbortedError")
    expect(aborted[1]?.info.hidden?.reason).toBe("repair-empty-dangling-assistant")
  }),
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      // #173：并发双 cancel——fork 的 cancel 与串行 cancel 竞争同一 per-session 锁，验证排队不丢弃
      const cancel = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(cancel)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      // #150：cancel 后 child idle 可能异步 settle，deadline poll 替代瞬时断言
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* status.get(childID)
          return s.type === "idle" ? (true as const) : undefined
        }),
        `child ${childID} never became idle after cancel`,
        "5 seconds",
      )
    }),
  15_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
        // 同一 ID 不代表已收尾，两个等待者都必须得到中止错误和完成时间，不能只比较旧快照身份。
        expect(exitA.value.info.role).toBe("assistant")
        expect(exitB.value.info.role).toBe("assistant")
        if (exitA.value.info.role === "assistant" && exitB.value.info.role === "assistant") {
          expect(exitA.value.info.error?.name).toBe("MessageAbortedError")
          expect(exitB.value.info.error?.name).toBe("MessageAbortedError")
          expect(exitA.value.info.time.completed).toBeNumber()
          expect(exitB.value.info.time.completed).toBeNumber()
        }
      }
    }),
  { git: true },
  // Windows Git fixture 和模型准备也计入用例预算，取消断言仍完整保留。
  30_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
  15_000,
)

it.instance(
  "compact rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt
        .compact({ sessionID: chat.id, agent: "build", model: ref })
        .pipe(Effect.timeout("250 millis"), Effect.exit)
      const messages = yield* sessions.messages({ sessionID: chat.id })

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }
      expect(messages.some((msg) => msg.parts.some((part) => part.type === "compaction"))).toBe(false)

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  { git: true },
  // #242：V2 cancel-processor cleanup 链在 Windows 实测 4-12s——超时放宽到 15s，断言语义不变
  15_000,
  )

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain('reason="user_abort"')
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain('reason="user_abort"')
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toContain('<opencode_notice type="output_truncated" source="shell"')
      expect(tool.state.output).toContain(`path="${tool.state.metadata.outputPath}`)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain('reason="user_abort"')
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 10" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

// #175：大图 preflight media.tokens=1600 且 inputTokens<90000
it.instance(
  "preflight estimates image attachments as media tokens",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => {
        const base = providerCfg(url)
        return {
          ...base,
          compaction: { reserved: 1_000 },
          provider: {
            test: {
              ...base.provider.test,
              models: {
                "test-model": {
                  ...base.provider.test.models["test-model"],
                  attachment: true,
                  modalities: { input: ["text", "image"], output: ["text"] },
                  limit: { context: 100_000, output: 10_000 },
                },
              },
            },
          },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const payload = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
        ),
      ).toString("base64")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "describe this image" },
          { type: "file", mime: "image/png", filename: "large-image.png", url: `data:image/png;base64,${payload}` },
        ],
      })
      yield* llm.text("image accepted", { usage: { input: 1_700, output: 1 } })
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.parts.some((p) => p.type === "text" && p.text === "image accepted"), JSON.stringify(result.info)).toBe(true)
      // #175：若仍按 base64/4，inputTokens 会远超 90k
      expect(result.info.inputEstimate?.input).toBeLessThan(90_000)
      // #175：large-image 夹紧上限 1600
      expect(result.info.inputEstimate?.inputBreakdown?.media?.tokens).toBe(1_600)
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

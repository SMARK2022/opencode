import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
// #517：progress gate 等价目录探测用 symlink 构造 canonical 等价搜索路径
import { symlink } from "fs/promises"
import { Logging } from "@opencode-ai/core/observability/logging"
import { Logger, References } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
// #557：observedSnapshot decorator 的 Snapshot 基础层依赖（AppProcess）。
import { AppProcess } from "@opencode-ai/core/process"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Auth } from "@/auth"
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
import { MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionGoal } from "../../src/session/goal"
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
import { provideTmpdirInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
// 跨目录caller必须共享原Session的运行结果与取消入口。
import { InstanceRef } from "@/effect/instance-ref"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
// 原生事件fixture复用目标已导入的Schema/Stream，不重复引入旧AI SDK流类型。
import { LLMEvent } from "@opencode-ai/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
// #557：summary stub 的 computeDiff 使用真实纯计算。
import { SummaryCache } from "../../src/session/summary-cache"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    // #557：computeDiff 走真实纯计算（SummaryCache）——Revert ownership 依赖 tool metadata 派生文件。
    computeDiff: (input) =>
      InstanceRef.pipe(
        Effect.map((ctx) => {
          if (!ctx) throw new Error("Missing prompt fixture Instance")
          const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
          return SummaryCache.collectToolDiffs(SummaryCache.toToolDiffMessages(input.messages), base)
        }),
      ),
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

// #315：短会话用例在 Windows CI 上冷启动开销大；win32 放宽到 15s，其他平台保持 3s 快速反馈。
const shortSessionTimeout = process.platform === "win32" ? 15_000 : 3_000

// 审查取消的内层观察保留平台余量，所属用例显式设置 Windows 30s / 其他平台 15s 硬顶。
// 已有队列 30s 与 Snapshot 120s 不收紧，单次等待小于硬顶也不代表顺序等待总量必然满足。
const reviewPollBudget = process.platform === "win32" ? "12 seconds" : "5 seconds"

function shortShellDelayCommand() {
  // Windows 的默认 shell 会把 `sleep 0.2` 解析成 PowerShell 命令，CI 冷启动时足以吃掉 3s 用例预算。
  // 这里使用测试进程已依赖的 PATH 内 `bun` 执行短延迟脚本，避免 PowerShell 对引号路径需要 `&` 的差异。
  return `bun -e "setTimeout(process.exit, 200)"`
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

// #557：MCP 开关模拟同 daemon 内连接态变化，Message cache 不得冻结其 Tool surface。
// 目标 MCP seam 是原生 McpTool {def, client}——fake client 的 callTool 落盘 mutation 文件。
let mcpMutationFile = ""
let mcpEnabled = true
const mutatingMcpTools = (): ReturnType<MCP.Interface["tools"]> => Effect.succeed(
  mcpEnabled ? {
    mcp_mutate: {
      def: { name: "mcp_mutate", description: "mutate one test file", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } },
      client: { callTool: () => Bun.write(mcpMutationFile, "mcp").then(() => ({ content: [{ type: "text", text: "mutated" }] })) } as never,
    },
  } : ({} as Record<string, never>),
)
const mutatingMcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    native: () => Effect.die("unexpected Native MCP connection in prompt-effect tests"),
    // 同一fake工具快照服务两条既有读取入口，不创建真实连接或另一份动态工具数据。
    snapshot: () => mutatingMcpTools().pipe(Effect.map(tools => ({ tools, clients: {}, instructions: [] }))),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: mutatingMcpTools,
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

// #557：observer 包装真实 Snapshot node——计数含 before/after，不用伪造成功值。
// decorator 的基础层经 Layer.provide 内联（同标签 dep 会形成 node 图自环）。
const snapshotTracks = new Map<string, number>()
// #557：observer node——track 计数含 before/after 两次真实 git 扫描。
const observedSnapshot = LayerNode.make({
  service: Snapshot.Service,
  layer: Layer.effect(
    Snapshot.Service,
    Effect.gen(function* () {
      const base = yield* Snapshot.Service
      return Snapshot.Service.of({
        ...base,
        // track 计数发生在真实调用之前，晚 capture 和重复 capture 都能被断言观察。
        track: () =>
          InstanceRef.pipe(
            Effect.map(ctx => { if (!ctx) throw new Error("Missing prompt fixture Instance"); return ctx.directory }),
            Effect.tap((dir) => Effect.sync(() => snapshotTracks.set(dir, (snapshotTracks.get(dir) ?? 0) + 1))),
            Effect.andThen(base.track()),
          ),
      })
    }),
  ).pipe(Layer.provide(Snapshot.node.implementation as Layer.Layer<Snapshot.Service>)),
  deps: [FSUtil.node, AppProcess.node, Config.node],
})
// 观察公开LLM调用入口，准备预算不混入目标新增的wire估算与持久账本结算。
const llmDispatchTimes = new Map<string, number>()
const measuredLLM = LayerNode.make({
  service: LLM.Service,
  layer: Layer.effect(
    LLM.Service,
    Effect.gen(function* () {
      const base = yield* LLM.Service
      return LLM.Service.of({
        stream: (input) => {
          // 小模型后台任务不属于被测用户请求，仍原样转交真实实现。
          if (!input.small) llmDispatchTimes.set(input.sessionID, performance.now())
          return base.stream(input)
        },
      })
    }),
  ).pipe(Layer.provide(LLM.node.implementation as Layer.Layer<LLM.Service>)),
  deps: [Auth.node, Config.node, ProviderSvc.node, Plugin.node, Permission.node, EventV2Bridge.node, llmClient, RuntimeFlags.node],
})

const providerUsage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
} as const
// #557：providerExecuted 事件绕过本地 Tool adapter，专门保护「远端 Tool 不建本地 baseline」。
// #557：providerExecuted 流——远端 Tool 无本地 execute，零 track 是正确归因。
const providerExecutedLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      Stream.unwrap(
        // fixture也履行prepared交接，不能让工具Part早于父Message而测到无关的外键失败。
        (input.onRequestPrepared?.({ messages: input.messages }) ?? Effect.void).pipe(Effect.as(Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "provider-call", name: "provider_search" }),
        LLMEvent.toolCall({ id: "provider-call", name: "provider_search", input: {}, providerExecuted: true }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: providerUsage }),
        LLMEvent.finish({ reason: "stop", usage: providerUsage }),
        ))),
      ),
  }),
)

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

// #557：pre-dispatch transform defect——验证 typed Assistant 单次持久化与 0 次 Provider 调用。
const failingMessageTransform = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (name, _input, output) =>
      name === "experimental.chat.messages.transform"
        ? Effect.die(new Error("pre-dispatch transform failed"))
        : Effect.succeed(output),
    list: () => Effect.succeed([{ "experimental.chat.messages.transform": () => Promise.resolve() }]),
    init: () => Effect.void,
  }),
)
let transformedHistoryText = ""
let toolDefinitionVersion = ""
const transformingHistory = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (name, _input, output) =>
      Effect.sync(() => {
        if (name === "tool.definition" && typeof output === "object" && output !== null) {
          // description 和 schema 使用同一版本，第二 step 可同时检测 definition 两种输出是否 fresh。
          Reflect.set(output, "description", `dynamic tool ${toolDefinitionVersion}`)
          Reflect.set(output, "jsonSchema", { type: "object", properties: { version: { const: toolDefinitionVersion } } })
          return output
        }
        if (name !== "experimental.chat.messages.transform") return output
        if (typeof output !== "object" || output === null) return output
        const messages = Reflect.get(output, "messages")
        if (!Array.isArray(messages)) return output
        // 改写最早历史 Part 可检测错误的 converted-prefix 复用，改 latest 不足以区分 suffix 路径。
        const text = messages
          .flatMap((message) => Reflect.get(message, "parts") ?? [])
          .find((part) => Reflect.get(part, "type") === "text")
        if (text) Reflect.set(text, "text", transformedHistoryText)
        return output
      }),
    list: () => Effect.succeed([{ "experimental.chat.messages.transform": () => Promise.resolve() }]),
    init: () => Effect.void,
  }),
)
const failingToolPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    // hook 在真实 Tool implementation 之前失败，用于验证 baseline 已先建立且文件未写入。
    trigger: (name, _input, output) =>
      name === "tool.execute.before" ? Effect.die(new Error("Tool rejected before implementation")) : Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
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
  SessionGoal.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking"; plugin?: Layer.Layer<Plugin.Service>; database?: Layer.Layer<Database.Service>; runState?: Layer.Layer<SessionRunState.Service> }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    ...(input?.database ? [[Database.node, input.database] as const] : []),
    ...(input?.plugin ? [[Plugin.node, input.plugin] as const] : []),
    ...(input?.runState ? [[SessionRunState.node, input.runState] as const] : []),
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  image?: "unavailable" | "counting"
  plugin?: "mutate" | "fail-transform" | "transform-history" | "fail-tool"
  snapshot?: "observe"
  mcp?: "mutating"
  llm?: "provider-executed" | "measure-preflight"
}) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  // #485：resizer 不可用注入——normalize 必然失败，验证 prompt 在持久化前 fail-closed
  const unavailableImage = Layer.succeed(
    Image.Service,
    Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
  )
  // #534：counting 注入——normalize 仅记录 URL 后原样返回，证明单次 decode 与 proof 消费。
  const countingImage = Layer.succeed(
    Image.Service,
    Image.Service.of({
      normalize: (input) => Effect.sync(() => imageNormalizations.push(input.url)).pipe(Effect.as(input)),
    }),
  )
  // #534：真实 chat.message hook 在 final normalization 前改写 URL；旧 proof 必须失效并再处理一次。
  const mutatingPlugin = Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: (name, _input, output) =>
        Effect.sync(() => {
          if (typeof output !== "object" || output === null) return output
          // #553：plugin-hidden history——transform 是第二个 producer，验证 prompt wire 的 visible 收敛。
          if (name === "experimental.chat.messages.transform") {
            const messages = Reflect.get(output, "messages")
            if (!Array.isArray(messages)) return output
            const target = messages.find((message) =>
              message.parts.some((part: MessageV2.Part) => part.type === "text" && part.text.includes("plugin-hidden-history")),
            )
            if (target) Reflect.set(target.info, "hidden", { time: Date.now(), reason: "plugin" })
            return output
          }
          if (name !== "chat.message") return output
          const parts = Reflect.get(output, "parts")
          if (!Array.isArray(parts)) return output
          const file = parts.find(
            (part) => typeof part === "object" && part !== null && Reflect.get(part, "type") === "file",
          )
          if (file) Reflect.set(file, "url", "data:image/png;base64,AQ==")
          return output
        }),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
  )
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    ...(input?.image === "unavailable" ? [[Image.node, unavailableImage] as const] : []),
    ...(input?.image === "counting" ? [[Image.node, countingImage] as const] : []),
    ...(input?.plugin === "mutate" ? [[Plugin.node, mutatingPlugin] as const] : []),
    // #557：动态面 fixtures——transform 失败/版本化 transform/拒绝 hook 三种 plugin 形态。
    ...(input?.plugin === "fail-transform" ? [[Plugin.node, failingMessageTransform] as const] : []),
    ...(input?.plugin === "transform-history" ? [[Plugin.node, transformingHistory] as const] : []),
    ...(input?.plugin === "fail-tool" ? [[Plugin.node, failingToolPlugin] as const] : []),
    // #557：Snapshot 计数 observer 与 providerExecuted LLM 流。
    ...(input?.snapshot === "observe" ? [[Snapshot.node, observedSnapshot] as const] : []),
    ...(input?.llm === "provider-executed" ? [[LLM.node, providerExecutedLLM] as const] : []),
    ...(input?.llm === "measure-preflight" ? [[LLM.node, measuredLLM] as const] : []),
    ...(input?.mcp === "mutating" ? [[MCP.node, mutatingMcp] as const] : []),
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
// #557：动态面/observer 环境。
// #557：fail-transform 环境——pre-dispatch 失败路径的独立 fixture 组合。
const failingTransform = testEffect(makeHttp({ plugin: "fail-transform" }))
const dynamicSurfaces = testEffect(makeHttp({ plugin: "transform-history", mcp: "mutating" }))
const observed = testEffect(makeHttp({ snapshot: "observe" }))
const observedProvider = testEffect(makeHttp({ snapshot: "observe", llm: "provider-executed" }))
const observedDenied = testEffect(makeHttp({ snapshot: "observe", plugin: "fail-tool" }))
const measuredPreflight = testEffect(makeHttp({ llm: "measure-preflight" }))
// #534：resizer 不可用环境——坏图片降级为 synthetic omission text，消息仍原子落库
const unavailable = testEffect(makeHttp({ image: "unavailable" }))
// #534：counting 环境——记录每次 normalize URL，锁定单次 decode 与 proof 消费/失效。
const imageNormalizations: string[] = []
const oneShotImage = testEffect(makeHttp({ image: "counting" }))
const mutatedImage = testEffect(makeHttp({ image: "counting", plugin: "mutate" }))
// #534：合法 1x1 PNG 与双帧 GIF fixture——损坏变异只用副本，不污染合法向量。
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
const twoFrameGif = "R0lGODlhBAAEAIAAAExpcUxpcSH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAAAAACwAAAAABAAEAAACBIyPGQUAIfkEBQAAAAAsAAAAAAQABACATGlx/wAAAgSMjxkFADs="
unavailable.instance(
  "replaces an undecodable image with a synthetic omission text part",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
      })
      // #534：失败降级为可持久化文本——坏 bytes 不进 provider 请求，后续消息仍可继续；
      // 消息本身原子落库（不再 #485 的整体失败），且不保留 filename/url 摘要避免复制坏 data URL。
      const stored = yield* MessageV2.filterCompactedEffect(chat.id)
      const textPart = stored
        .flatMap((message) => message.parts)
        .find((part) => part.type === "text" && part.text.startsWith("[Image omitted:"))
      expect(textPart).toBeDefined()
      if (textPart?.type !== "text") return
      expect(textPart.text).toBe("[Image omitted: could not be decoded or resized within the image size limit.]")
      expect((textPart as { synthetic?: boolean }).synthetic).toBe(true)
      expect(result).toBeDefined()
    }),
  { git: true },
)

// #534：metadata 完整但像素损坏的直发图——decoder 失败后只能留下 omission 文本，
// 原始坏 data URL 不得进入持久化或后续 provider 请求。
it.instance(
  "replaces a pixel-corrupt direct image with a persisted omission",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Malformed image" })
      const png = Buffer.from(tinyPng, "base64")
      // IDAT 翻转保持 IHDR/尺寸有效——与结构门禁向量区分，专门锁定真像素 decode 失败路径。
      const idat = png.indexOf(Buffer.from("IDAT"))
      png[idat + 4] ^= 0xff

      const result = yield* Effect.exit(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${png.toString("base64")}` }],
        }),
      )
      expect(Exit.isSuccess(result)).toBe(true)
      const parts = (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((item) => item.parts)
      expect(parts.some((part) => part.type === "file")).toBe(false)
      const omission = parts.find((part) => part.type === "text" && part.text.includes("Image omitted"))
      expect((omission as { synthetic?: boolean } | undefined)?.synthetic).toBe(true)
    }),
  { git: true },
)

// #534：禁用缩放且仅允许1字节时，坏像素仍须先归属decode失败；
// metadata-only 顺序会先报 SizeError，真实像素损坏必须拥有更早的 DecodeError。
it.instance(
  "decodes before reporting size when the token budget is minimal",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig((url) => ({
        ...providerCfg(url),
        attachment: { image: { auto_resize: false, max_base64_bytes: 1 } },
      }))
      const image = yield* Image.Service
      const png = Buffer.from(tinyPng, "base64")
      const idat = png.indexOf(Buffer.from("IDAT"))
      png[idat + 4] ^= 0xff
      const pngResult = yield* image
        .normalize(
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: SessionID.make("ses_decode_before_size"),
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${png.toString("base64")}`,
          },
          // 配置的1字节上限小于样本；若实现先拒绝尺寸，这里会得到SizeError而非DecodeError。
          { tokenBudget: 1 },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(pngResult)).toBe(true)
      if (Exit.isFailure(pngResult)) {
        expect(Cause.squash(pngResult.cause)).toBeInstanceOf(Image.DecodeError)
      }
      // 后帧损坏必须由全页解码拒绝，不能因首帧可读或预算判断而成功透传。
      const gif = Buffer.from(twoFrameGif, "base64")
      gif[89] = 0
      const gifResult = yield* image
        .normalize(
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: SessionID.make("ses_all_pages_before_size"),
            type: "file",
            mime: "image/gif",
            url: `data:image/gif;base64,${gif.toString("base64")}`,
          },
          { tokenBudget: 1 },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(gifResult)).toBe(true)
      if (Exit.isFailure(gifResult)) expect(Cause.squash(gifResult.cause)).toBeInstanceOf(Image.DecodeError)
    }),
  { git: true },
)

// #534：@image 的 Read producer 完成一次 normalize；final consumer 只消费匹配 proof，不重复调用 owner。
// 最终持久化 file 仍保持图片 MIME，证明跳过的是重复 decode 而不是整个附件处理。
oneShotImage.instance(
  "normalizes a ReadTool image once and strips transient proof before persistence",
  () =>
    Effect.gen(function* () {
      imageNormalizations.length = 0
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "One shot image",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const target = path.join(dir, "one-shot.png")
      yield* Effect.promise(() => Bun.write(target, Buffer.from(tinyPng, "base64")))
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "inspect @one-shot.png" },
          {
            type: "file",
            mime: "text/plain",
            filename: "one-shot.png",
            url: pathToFileURL(target).href,
            source: { type: "file", path: target, text: { value: "@one-shot.png", start: 8, end: 21 } },
          },
        ],
      })
      const files = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((item) => item.parts)
        .filter((part) => part.type === "file" && (part as { mime?: string }).mime?.startsWith("image/"))
      expect(imageNormalizations).toHaveLength(1)
      // 持久化 file 保持图片 MIME：跳过的是重复 decode，不是整个附件处理链。
      expect(files).toHaveLength(1)
      // transient proof Symbol 在持久化前必须被剥离，防止数据库层复制不可枚举标记。
      expect(Object.getOwnPropertySymbols(files[0] ?? {})).toHaveLength(0)
    }),
  { git: true },
)

// #534：ReadTool 先处理文件，真实 chat.message hook 改写后 final consumer 必须针对新 URL 再处理一次；
// hook 返回后才消费 proof，锁定 plugin 边界顺序，防止未来把验证提前到插件之前。
mutatedImage.instance(
  "invalidates file-reference proof after a chat.message plugin changes the URL",
  () =>
    Effect.gen(function* () {
      imageNormalizations.length = 0
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Changed image" })
      const target = path.join(dir, "plugin-image.png")
      yield* Effect.promise(() => Bun.write(target, Buffer.from(tinyPng, "base64")))
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            filename: "plugin-image.png",
            url: pathToFileURL(target).href,
            source: { type: "file", path: target, text: { value: "@plugin-image.png", start: 0, end: 17 } },
          },
        ],
      })
      // 第一次计数属于原文件；第二次必须精确绑定 hook 写入的新 data URL，不能只按 part identity 复用。
      expect(imageNormalizations).toHaveLength(2)
      // 计数为 2 排除“proof 提前失效重读原文件”的变体：那会让第 2 次仍是 file: URL。
      expect(imageNormalizations[1]).toBe("data:image/png;base64,AQ==")
      const files = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((item) => item.parts)
        .filter((part) => part.type === "file")
      expect(files).toHaveLength(1)
      expect(Object.getOwnPropertySymbols(files[0] ?? {})).toHaveLength(0)
      yield* user(chat.id, `plugin-hidden-history ${"x".repeat(120_000)}`)
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "current" }] })
      yield* llm.text("reply")
      yield* prompt.loop({ sessionID: chat.id })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistant = messages.findLast((message) => message.info.role === "assistant")
      if (assistant?.info.role !== "assistant") throw new Error("Expected assistant snapshot")
      // #553：persisted snapshot 与 wire 一起排除 plugin-hidden history；userText 以显式上界锁死 120K 原文不进入估算，
      // 且 raw 120K 文本也不能触发 Compaction（无 summary 落盘）。
      const wireExcludes = JSON.stringify((yield* llm.inputs).at(-1)?.messages).includes("plugin-hidden-history")
      expect(wireExcludes).toBe(false)
      expect(assistant.info.inputEstimate?.inputBreakdown?.messages.userText).toBeLessThan(1_000)
      expect(messages.some((message) => message.info.summary)).toBe(false)
    }),
  { git: true },
)

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

// #557：同一 response 的并发 Tool 必须拥有独立 OpenAI stream index，否则 AI SDK 把后调用覆盖到 index 0。
// #557：并发 Tool fixture——独立 stream index 防止 AI SDK 覆盖到 index 0。
function concurrentToolReply(calls: Array<{ name: string; input: unknown }>) {
  const item = calls.reduce((value, call) => value.tool(call.name, call.input), reply()).item()
  if (item.type !== "sse") throw new Error("Expected SSE Tool reply")
  let index = -1
  // 每个 Tool 的参数 delta 必须沿用其 start delta index；这里只修 fixture 协议索引，不改 Tool 参数/时序/并发模型。
  for (const line of [
    ...item.head,
    ...item.tail,
  ] as Array<{ choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; function?: { name?: string } }> } }> }>) {
    const call = line.choices?.[0]?.delta?.tool_calls?.[0]
    if (!call) continue
    if (call.function?.name) index++
    call.index = index
  }
  return item
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (
  sessionID: SessionID,
  text: string,
  options?: {
    id?: MessageID
    created?: number
    goalTurnID?: MessageID
    synthetic?: boolean
    goalContinuation?: boolean
    compaction?: boolean
  },
) {
  // 可选 chronology/lineage 都通过公开 Session persistence 写入，测试不调用 private classifier；
  // 同一 fixture 因而能表达 real、technical、Goal continuation 与 legacy marker 四种 producer。
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: options?.id ?? MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    ...(options?.goalTurnID ? { goalTurnID: options.goalTurnID } : {}),
    time: { created: options?.created ?? Date.now() },
  })
  if (options?.compaction) {
    // legacy marker 故意只有 compaction part 且没有 goalTurnID，复现升级前持久化形状；
    // 若同时写 text part，它会被 classifier 当成真实用户，无法验证 fail-closed 兼容。
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "compaction",
      auto: true,
    })
    return msg
  }
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
    ...(options?.synthetic ? { synthetic: true } : {}),
    ...(options?.goalContinuation ? { metadata: { goal_continuation: true } } : {}),
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

// #557：text turn——真实 prompt.loop + provider 往返的最小完整轮。
// #557：textTurn 封装完整 provider 往返——cache 测试的最小 admitted 轮次单元。
const textTurn = Effect.fn("test.textTurn")(function* (sessionID: SessionID, input: string, output: string) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const userMessage = yield* user(sessionID, input)
  yield* llm.text(output)
  return { user: userMessage, result: yield* prompt.loop({ sessionID }) }
})

// #557：断言面是 Provider 实际请求体，不是 cache 内部状态。
const lastProviderInput = Effect.fn("test.lastProviderInput")(function* () {
  const llm = yield* TestLLMServer
  return (yield* llm.inputs).at(-1)
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
      // prepared之前失败只结算已admit的请求；原cause与零消费不能靠空助手占位证明。
      expect((yield* sessions.messages({ sessionID: chat.id })).filter(message => message.info.role === "assistant")).toHaveLength(0)
      expect(yield* usage.get({ sessionID: chat.id, requestID: id })).toMatchObject({ rootRequestID: id, status: "error", assistantCount: 0, stepCount: 0, cost: 0, tokens: zero, error: transformFailure.message, time: { completed: expect.any(Number) } })
      expect(yield* usage.assistants({ sessionID: chat.id, requestID: id })).toEqual([])
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


// #390：超时中断后重试——第一次 hang 触发 per-attempt 超时，重试后成功；
// 同时锁定被中断的子会话 assistant 消息写入终态（error + completed）不悬挂
it.instance(
  "auto permission reviewer retries on timeout before falling back to user",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { auto_review: { timeout_ms: 500 } },
      }))
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer timeout retry" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      // 第一次 hang → 超时中断 → 重试；第二次正常返回 tool call
      yield* llm.hang
      yield* llm.push(
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "retry after timeout succeeded",
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

      // 超时后重试成功：共 2 次 provider 调用
      expect(yield* llm.calls).toBe(2)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const msgs = yield* MessageV2.page({ sessionID: reviewer.id, limit: 20, includeHidden: true })
      const assistants = msgs.items.filter((m) => m.info.role === "assistant")
      expect(assistants.length).toBeGreaterThanOrEqual(2)
      const interrupted = assistants[0].info as SessionV1.Assistant
      expect(interrupted.time.completed).toBeDefined()
      expect(interrupted.error).toBeDefined()
    }),
  { git: true },
  30_000,
)

// #390：prose 前缀的 JSON 提取——旧实现只接受纯 JSON；修复后括号深度扫描
// 提取第一个 {...} 块并以 json_fallback 落决策，Schema/策略守卫不削弱
it.instance(
  "auto permission reviewer extracts JSON from prose-prefixed text",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer JSON extraction" })
      const command = String.raw`rsync -av "/Volumes/My Passport/Calibration/" Sensetimex4:~/project/Calibration/`
      yield* llm.push(
        reply()
          .text(
            `Based on my analysis:
${JSON.stringify({
              outcome: "allow",
              risk_level: "high",
              user_authorization: "high",
              rationale: "user explicitly authorized the bounded remote transfer",
            })}`,
          )
          .stop()
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
      const reviewerParts = (yield* MessageV2.filterCompactedEffect(reviewer.id)).flatMap((msg) => msg.parts)
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.source === "json_fallback" &&
            part.state.metadata?.rationale === "user explicitly authorized the bounded remote transfer",
        ),
      ).toBe(true)
    }),
  { git: true },
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
      // [local-smark] 596 INV-02 反转：reviewer 请求现在必须在 API 层强制决策工具
      // （toolChoice:"required"），与 reviewer-service 的 wire 断言同源；该测试
      // 单 push 即 reviewer 请求，inputs[0] 就是 reviewer 的 wire body。
      expect(inputs[0].tool_choice).toBe("required")
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
      // [local-smark] 596 R-REQ-4：第 2 次请求携带 avoid-xxx 防御纵深 nudge（阻断
      // 反问/自认无能力形态），并显式给出裸 JSON 逃生口（生产 DB 证据：漂移场景
      // 下 json_fallback 是实测可救回路径）。
      const retryInputs = yield* llm.inputs
      const retryInputText = JSON.stringify(retryInputs[1])
      expect(retryInputText).toContain("Protocol retry")
      expect(retryInputText).toContain("Avoid prose, questions")
      expect(retryInputText).toContain("\"risk_level\"")
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
  "auto permission reviewer fails closed after two malformed protocol retries",
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
      // 三次畸形响应耗尽初始加两次补试，仍须拒绝而非放宽为允许。
      yield* llm.push(
        reply().text("first malformed reviewer response").stop().item(),
        reply().text("second malformed reviewer response").stop().item(),
        reply().text("third malformed reviewer response").stop().item(),
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
      // #227：3 次尝试全部协议错误后 fail closed——AutoDeniedError 使调用方只能拒绝
      expect(yield* llm.calls).toBe(3)
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
      const test = yield* TestInstance
      const chat = yield* sessions.create({
        title: "Shell review metadata",
        permission: [{ permission: "bash", pattern: "*", action: "auto" }],
      })
      // 本用例只需要触发 SSH 私钥名的 cautious 预审并产生 shell 输出；
      // 使用项目内文件避免 Windows runner 上家目录路径和缺失文件错误拖慢到 15s 超时边界。
      const key = path.join(test.directory, "id_rsa")
      yield* Effect.promise(() => Bun.write(key, "review-output\n"))
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
  // 这是 shell 执行、auto reviewer 子会话和审计回链的完整集成链路；
  // Windows CI 慢机曾在 15s 边界取消，30s 仍保持有限等待且不会放宽任何行为断言。
  30_000,
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
        // #590：平台化内层预算，严格小于注册硬顶（win32 12s<30s / 其余 5s<15s）。
        reviewPollBudget,
      )
      const reviewID = reviewing.state.status === "running" ? reviewing.state.metadata?.autoReview?.reviewID : undefined
      expect(typeof reviewID).toBe("string")
      // #216：等待 reviewer 子会话出现——确认 permission-reviewer 已被创建
      const reviewer = yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
        }),
        "reviewer child session never started",
        reviewPollBudget,
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* MessageV2.filterCompactedEffect(reviewer.id)).find(
            (msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } =>
              msg.info.role === "assistant" && !msg.info.time.completed,
          )
        }),
        "reviewer child assistant never started",
        reviewPollBudget,
      )

      // 取消完成后才释放 reviewer 回复，验证迟到决定不能落盘。
      yield* prompt.cancel(chat.id)
      gate.resolve()
      yield* awaitWithTimeout(Fiber.await(fiber), "session did not stop after review cancel", reviewPollBudget).pipe(Effect.ignore)

      const shell = yield* pollWithTimeout(
        Effect.gen(function* () {
          const part = (yield* MessageV2.filterCompactedEffect(chat.id))
            .flatMap((msg) => msg.parts)
            .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
          return part?.state.status === "error" ? part : undefined
        }),
        "shell tool never recorded the review cancellation",
        reviewPollBudget,
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
        reviewPollBudget,
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
  // 显式注册预算不会被默认 live/instance 预算覆盖；仅为本取消用例保留平台余量。
  process.platform === "win32" ? 30_000 : 15_000,
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
    // 0337 SMARK 语义：tool override 追加而非替换整体 ruleset——保住 TaskTool 派生的
    // 子会话 auto ceiling。两次 prompt 的 rules 以 last-match-wins 累积：bash deny 保留，read allow 生效。
    expect(reloaded.permission).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ])
    // 0337 融合语义：bash deny 经 last-match-wins 累积保留，不随第二次 prompt 消失
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("deny")
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
  shortSessionTimeout,
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
  "settles admitted requests without an assistant when cancelled before processor creation completes",
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
      const usage = yield* SessionRequestUsage.Service
      const status = yield* SessionStatus.Service
      const ids = [MessageID.ascending(), MessageID.ascending()]
      // 两次真实admission分别进入阻塞create；不复用已被noReply结算的请求冒充取消。
      for (const [index, messageID] of ids.entries()) {
        const ready = defer<void>()
        processorCreateStarted.push(ready.resolve)
        const run = yield* prompt.prompt({
          sessionID: chat.id, messageID, agent: "build", parts: [{ type: "text", text: index === 0 ? "first" : "second" }],
        }).pipe(Effect.forkChild)
        yield* Effect.promise(() => ready.promise)
        // create始终不返回，因此尚未进入LLM；取消由真实请求owner闭合，而不是构造助手。
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(run)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value.info).toMatchObject({ id: messageID, role: "user" })
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.filter(message => message.info.role === "assistant")).toHaveLength(0)
        expect(messages.filter(message => message.info.role === "user").map(message => message.info.id)).toEqual(ids.slice(0, index + 1))
        expect(yield* usage.get({ sessionID: chat.id, requestID: messageID })).toMatchObject({
          rootRequestID: messageID, status: "aborted", assistantCount: 0, stepCount: 0, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
          error: expect.stringMatching(/interrupt|abort/i), time: { completed: expect.any(Number) },
        })
        expect(yield* usage.assistants({ sessionID: chat.id, requestID: messageID })).toEqual([])
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }
    }),
  { config: cfg },
  shortSessionTimeout,
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
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      // #499：T 侧目录的 InstanceRef——第二个 caller 经 T 目录提交，控制面必须仍命中 D 的同一 Runner。
      const source = yield* InstanceRef
      if (!source) return yield* Effect.die(new Error("InstanceRef not provided"))
      const target = { ...source, directory: path.join(source.directory, "target") }
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.provideService(InstanceRef, target), Effect.forkChild)
      yield* Effect.sleep(50)

      // #499：T 的 join、busy 与 cancel 必须命中 D 的同一 Runner，不能按目录再建控制面。
      expect(Exit.isFailure(yield* run.assertNotBusy(chat.id).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
      yield* prompt.cancel(chat.id).pipe(Effect.provideService(InstanceRef, target))
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

      // #496：这里只断言并发 loop 共享结果；包级 timeout 仅防进程挂死，不构成 3 秒性能契约。
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

it.instance(
  "coalesces direct shell progress without changing final output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const durable: SessionV1.ToolPart[] = []
      const live: SessionV1.ToolPart[] = []
      // GlobalBus 是 bridge listen 的下游同步总线；用纯回调观察，避免把订阅
      // fiber 的环境需求泛化成 unknown 而破坏测试体类型。
      const onEvent = (evt: { payload?: { type: string; properties?: { part?: SessionV1.Part } } }) => {
        const p = evt.payload
        if (!p || (p.type !== "message.part.updated" && p.type !== "message.part.progress")) return
        const part = p.properties?.part
        if (part?.type !== "tool" || part.sessionID !== chat.id || part.tool !== "bash") return
        if (p.type === "message.part.updated") durable.push(structuredClone(part))
        else live.push(structuredClone(part))
      }
      GlobalBus.on("event", onEvent)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

      // 每次写入之间的真实 10ms 间隔让 child stream 产生持续 progress；测试只观察
      // 公开 Session 事件，不依赖 chunk 数、timer 或 coordinator 私有状态。
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command:
          "bun -e \"for(let i=1;i<=40;i++){process.stdout.write('DIRECT_PROGRESS_'+i+'\\r');await Bun.sleep(10)}\"",
      })
      yield* pollWithTimeout(
        Effect.sync(() => durable.some((part) => part.state.status === "completed") || undefined),
        "timed out waiting for direct shell terminal event",
      )

      // 40 个 CR 帧短于 durable 窗口，能在不改变 raw output 的前提下覆盖 leading/trailing budget。
      // 只有 running Part 属于重连 checkpoint 预算；completed 是权威终态，不能为了满足上限而删除。
      const running = durable.filter((part) => part.state.status === "running")
      const tool = completedTool(result.parts)
      expect(running.length).toBeLessThanOrEqual(3)
      expect(running[0]?.state.status === "running" ? running[0].state.metadata?.progressVersion : undefined).toBe(0)
      expect(live.some((part) => part.state.status === "running")).toBe(true)
      if (tool) {
        expect(tool.state.output).toContain("DIRECT_PROGRESS_1")
        expect(tool.state.output).toContain("DIRECT_PROGRESS_40")
        yield* run.assertNotBusy(chat.id)
      }
    }),
  30_000,
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
      // #536：用户面板不携带模型侧 notice/诊断散文——两侧只共享真实命令字节。
      expect(tool.state.metadata.output).not.toContain("opencode_notice")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

// #536：空成功的用户面板是精确占位符——不是空串，也不携带任何 exit notice。
unixNoLLMServer(
  "shell empty success keeps user panel placeholder free of notices",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "true",
      })

      const tool = completedTool(result.parts)
      if (!tool) return
      expect(tool.state.metadata.output).toBe("(no output)")
      expect(tool.state.metadata.output).not.toContain("opencode_notice")
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
        .shell({ sessionID: chat.id, agent: "build", command: shortShellDelayCommand() })
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
  // Windows冷启动还包含Git与LLM测试服务，保留完整断言并使用有界集成预算。
  30_000,
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
        .shell({ sessionID: chat.id, agent: "build", command: shortShellDelayCommand() })
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
  // 两个等待者仍须共享同一结果，延长预算不改变并发排队契约。
  30_000,
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
            // #536：取消路径的 notice 只进模型面板；用户面板保持 raw（空输出为精确占位）。
            expect(tool.state.metadata.output).not.toContain("opencode_notice")
            expect(tool.state.metadata.output).toBe("(no output)")
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

// handleSubtask 路径必须把父会话当前 agent 名传给 TaskTool.execute，
// 而不是 SubtaskPart.agent（子 agent 名）。否则 task.ts 会用子 agent
// 的 permission 作为 parentAgent 解析 ceiling，导致 auto 父会话的
// external_directory/bash/edit auto 规则丢失，子会话访问外部目录时
// 落到 ask 弹窗而非 auto reviewer。
it.instance(
  "subtask from auto parent inherits auto ceilings in child session permission",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "auto subtask" })
      // 创建 agent 为 auto 的 user message，模拟 auto 主会话场景
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "auto",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: chat.id,
        type: "text",
        text: "review the implementation",
      })
      // 注入 SubtaskPart 走 handleSubtask 路径
      yield* addSubtask(chat.id, msg.id)
      // 子会话返回后父模型仍需消费工具结果，为两次实际调用分别提供响应。
      yield* llm.push(reply().text("review done").stop().item())
      yield* llm.push(reply().text("review summarized").stop().item())

      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.hits).toHaveLength(2)

      // 找到 task 工具 part 拿到子会话 ID
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      // 目标 helper：completedTool 断言 completed 并收窄类型
      const taskTool = completedTool(taskMsg?.parts ?? [])
      // task 工具完成后 state 为 completed，metadata 含子会话 ID
      const childSessionID = taskTool?.state.metadata?.sessionId
      expect(typeof childSessionID).toBe("string")
      if (typeof childSessionID !== "string") return

      // 子会话 stored permission 必须含父 auto agent 的 external_directory auto ceiling
      const child = yield* sessions.get(SessionID.make(childSessionID))
      const hasExtAuto = child.permission?.some(
        (r) => r.permission === "external_directory" && r.action === "auto",
      )
      const hasBashAuto = child.permission?.some(
        (r) => r.permission === "bash" && r.action === "auto",
      )
      // 修复前：parentAgent 被解析为 general（子 agent 名），ceilings 为空，
      // child.permission 只有 [task deny]，两个断言都会失败
      expect(hasExtAuto).toBe(true)
      expect(hasBashAuto).toBe(true)
    }),
  { git: true },
  15_000,
)
it.instance(
  "cancel does not abort assistant messages from a subsequently submitted prompt",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cancel race" })
      yield* seed(chat.id)

      // 第一轮：hang 住 LLM，让 agent loop 卡住
      yield* llm.hang
      yield* user(chat.id, "first")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // 取消当前 agent loop（fork 让 cancel 在后台执行）
      const cancelling = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      const status = yield* SessionStatus.Service
      // 等旧runner释放后才能创建新轮，不能把ensureRunning的join误当新模型执行。
      yield* pollWithTimeout(status.get(chat.id).pipe(Effect.map((value) => value.type === "idle" ? true : undefined)), "Old runner did not release")

      // 立即提交新命令——在 cancel 的 abortPendingAssistants 执行前
      yield* llm.push(reply().text("second response").stop().item())
      yield* user(chat.id, "second")
      const fiber2 = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // 等待第二个 loop 完成
      const exit2 = yield* Fiber.await(fiber2).pipe(Effect.timeout("10 seconds"))
      expect(Exit.isSuccess(exit2)).toBe(true)

      // 验证第二个 assistant 消息没有被 abort
      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const assistants = messages.filter((m) => m.info.role === "assistant")
      // 至少有两个 assistant：第一个被 cancel 终态化，第二个正常完成
      const lastAssistant = assistants.at(-1)
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastAssistant?.info.role === "assistant") {
        // 关键断言：新命令的 assistant 不应有 AbortedError
        expect(lastAssistant.info.error?.name).not.toBe("MessageAbortedError")
      }
      expect(lastAssistant?.parts.some((part) => part.type === "text" && part.text === "second response")).toBe(true)
      expect(yield* llm.calls).toBe(2)
      yield* Fiber.join(cancelling)

      // 清理第一个 fiber
      yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"), Effect.ignore)
    }),
  { git: true },
  30_000,
)

// [local-smark] GOAL 错误后续跑测试：验证 continueOnError 策略控制
// 终止型错误后是否自动创建新的 GOAL continuation turn
it.instance(
  "goal error continuation disabled by default — terminal APIError stops loop",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service

      const chat = yield* sessions.create({})
      // 设置 GOAL 但不开启 continueOnError（默认 false）
      yield* goalSvc.set(chat.id, { objective: "complete the task" })
      yield* user(chat.id, "start working")

      // 推入一个 400 错误（APIError，非重试）
      yield* llm.error(400, { error: { message: "bad request" } })

      yield* prompt.loop({ sessionID: chat.id })

      // 默认 false：错误后不创建 continuation
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const continuations = msgs.filter(
        (m) =>
          m.info.role === "user" &&
          m.parts.some(
            (p) => p.type === "text" && (p as any).synthetic === true && p.text?.includes("<session-goal-continuation>"),
          ),
      )
      expect(continuations.length).toBe(0)

      // 非空且可见的历史错误仍走0398守卫，不把零输出修复行为混入本回归。
      const last = msgs.findLast((message) => message.info.role === "assistant")?.info
      if (last?.role !== "assistant") throw new Error("expected failed assistant")
      const historical = { ...last, id: MessageID.ascending(), finish: "stop", hidden: undefined, time: { created: Date.now(), completed: Date.now() } }
      yield* sessions.updateMessage(historical)
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: chat.id, messageID: historical.id, type: "text", text: "partial provider output" })
      const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: historical.id })
      expect(stored.info).toMatchObject({ finish: "stop", error: expect.anything() })
      expect(stored.info.hidden).toBeUndefined()
      yield* llm.error(400, { error: { message: "unexpected historical retry" } })
      const calls = yield* llm.calls
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(calls)
    }),
  { git: true },
  30_000,
)

it.instance(
  "goal error continuation enabled — terminal APIError triggers one system_continue",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service

      const chat = yield* sessions.create({})
      // 开启错误续跑策略
      yield* goalSvc.set(chat.id, { objective: "complete the task", continueOnError: true })
      yield* user(chat.id, "start working")

      // 第一次 400 触发 terminal-error → 错误续跑；第二次 400 时
      // goalTurns=1 >= maxGoalTurns=1 → pause + break。400 非重试
      yield* llm.error(400, { error: { message: "bad request" } })
      yield* llm.error(400, { error: { message: "bad request" } })

      yield* prompt.loop({ sessionID: chat.id })

      // source 字段被 schema decoder 剥离，改为检查 synthetic continuation 标记
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const continuations = msgs.filter(
        (m) =>
          m.info.role === "user" &&
          m.parts.some(
            (p) => p.type === "text" && (p as any).synthetic === true && p.text?.includes("<session-goal-continuation>"),
          ),
      )
      // [local-smark] goal_max_turns=1：错误续跑一次后到达上限，GOAL paused
      expect(continuations.length).toBe(1)

      // 续跑 prompt 不包含错误消息内容
      // #520：TextPart type guard 通过公开 Part shape 取 metadata，避免测试依赖 any 或私有存储表示。
      const continueText = continuations[0].parts.find(
        (p): p is SessionV1.TextPart => p.type === "text" && p.text.includes("<session-goal-continuation>"),
      )
      expect(continueText?.text).not.toContain("bad request")
      // #520：错误原因已由上一条 assistant error 展示，continuation 不增加第二套 error mode。
      // literal continue/1/1 直接证明 producer 没有根据 APIError 生成额外展示状态。
      expect(continueText?.metadata).toMatchObject({
        goal_continuation_mode: "continue",
        goal_continuation_turn: 1,
        goal_continuation_max_turns: 1,
      })
    }),
  { git: true },
  30_000,
)

it.instance(
  "goal blocked pending continuation stores block check",
  () =>
    Effect.gen(function* () {
      // #520：四个排队回复分别覆盖 read、blocked、完成当前 step 和挂起下一轮，不依赖内部调用次数 mock。
      // 第一轮 blocked 只保持 Goal active；第二个 provider 请求挂起，保留下一条 continuation 供断言。
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 2 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "blocked check presentation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "finish the blocked check presentation" })
      yield* user(chat.id, "start the Goal")

      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }),
        reply().text("pending recorded").stop(),
        reply().hang().item(),
      )
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
      // llm.wait(4) 是 server 发布的请求信号，慢机上也不会用固定 sleep 猜测 continuation 已落库。
      yield* llm.wait(4)

      const parts = continuationParts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(parts).toHaveLength(1)
      // #520：BLOCK CHECK 必须来自结构化 Tool 结果，而不是 title/output 文案或当前 Goal status。
      expect(parts[0]?.metadata).toMatchObject({
        goal_continuation_mode: "block-check",
        goal_continuation_turn: 1,
        goal_continuation_max_turns: 2,
      })
      const goal = yield* goalSvc.get(chat.id)
      expect(goal._tag).toBe("Some")
      // active 断言区分 pending 复查与 terminal blocked，防止展示 metadata 改写 Goal 生命周期。
      if (goal._tag === "Some") expect(goal.value.status).toBe("active")
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
  30_000,
)
// #482：手动压缩标题行为的端到端验证——summary 持有 Run state 期间提交的 queued user
// 必须经 ShellThenRun 无 Idle 空窗地移交到下一次 Agent run，而不是被旧 revert 边界隐藏
it.instance(
  "manual compact hands a prompt submitted during summary to the next agent run",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const run = yield* SessionRunState.Service
      const sessionStatus = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const history = yield* user(chat.id, "history to compact")
      // active revert 必须先由 compact 的 exclusive cleanup 消费，queued user 不能被旧边界再次隐藏；
      // 这同时验证 HTTP 层移除重复 cleanup 后，领域边界仍完整承担 revert 清理职责
      yield* sessions.setRevert({
        sessionID: chat.id,
        revert: { messageID: history.id },
        summary: { additions: 0, deletions: 0, files: 0 },
      })

      // summary 保持流式未完成，确保后续 prompt 确实在 manual compact 持有 Run state 时提交
      yield* llm.hold("summary", deferredAsPromise(gate))
      yield* llm.text("queued reply")
      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      // exclusive maintenance 必须阻止 explicit revert 并发修改同一 Session，但普通 prompt 仍可排队；
      // 这一不对称正是 exclusive 语义的核心：维护拒绝写入者，不拒绝排队者
      const revertExit = yield* run.beginRevert(chat.id).pipe(Effect.exit)
      if (Exit.isSuccess(revertExit)) yield* run.endRevert(chat.id)
      expect(Exit.isFailure(revertExit)).toBe(true)

      // 固定 queuedID 后再 fork prompt：最终 assistant 必须显式绑定该 ID 而不是 compaction marker
      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "answer this after compact" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) => (messages.some((message) => message.info.id === queuedID) ? true : undefined)),
          ),
        "queued prompt was not persisted during manual compact",
      )

      // summary 完成会结束 maintenance caller，但 ShellThenRun 必须无 Idle 空窗地接管 queued caller；
      // 分别等待两个 fiber 可以证明它们没有误共享 summary 结果
      yield* Deferred.succeed(gate, undefined)
      const [compactExit, queuedExit] = yield* Effect.all([Fiber.await(compact), Fiber.await(queued)])

      expect(Exit.isSuccess(compactExit)).toBe(true)
      expect(Exit.isSuccess(queuedExit)).toBe(true)
      if (Exit.isSuccess(compactExit) && compactExit.value.info.role === "assistant") {
        // summary 标记证明 compact caller 拿到的是维护结果而非被误共享的普通回复
        expect(compactExit.value.info.summary).toBe(true)
      }
      if (Exit.isSuccess(queuedExit) && queuedExit.value.info.role === "assistant") {
        expect(queuedExit.value.info.summary).not.toBe(true)
        expect(queuedExit.value.info.parentID).toBe(queuedID)
        expect(queuedExit.value.parts.some((part) => part.type === "text" && part.text === "queued reply")).toBe(true)
      }
      // 可见消息断言保护 active revert 场景：陈旧 cleanup 不得把 handoff 后的 user 重新隐藏；
      // 两次 Provider 调用与最终 Idle 共同证明续跑只发生一次且 Run state 已完整释放
      const visible = yield* sessions.messages({ sessionID: chat.id })
      expect(visible.some((message) => message.info.id === queuedID)).toBe(true)
      // llm.calls 是 handoff 次数的下界审计：重试/重复移交都会推高它
      expect(yield* llm.calls).toBe(2)
      // Idle 是 Run state 完整释放的外部可观测事实：悬挂 finalizer 会让状态停在 busy
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

// #482：summary assistant 只回答自己的 parent——持久化关系是归属的结构事实，
// 消息创建顺序不能替代；merged 请求不得被 summary 伪完成
it.instance(
  "summary assistant does not complete a newer user with a different parent",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history")

      // create 只建立真实 compaction marker；后续手工插入顺序用于确定性覆盖极窄竞态，
      // 不依赖 wall-clock 延迟，慢 CI 上也能稳定复现旧 ID 判断缺陷
      const marker = yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      // real user 在 marker 后、summary 前落库；单看 ID 会误以为后创建的 summary 已回答它
      // queued user 在 marker 后落库：ID 更大但 parent 不同——这正是旧 ID 判断的盲区
      const queued = yield* user(chat.id, "still needs an answer")
      const summaryID = MessageID.ascending()
      // finished summary 模拟 Compaction 成功边界；parent 固定为 marker 保留真实持久化关系
      yield* sessions.updateMessage({
        id: summaryID,
        role: "assistant",
        parentID: marker.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryID,
        sessionID: chat.id,
        type: "text",
        text: "summary",
      })
      // summary 文本只证明维护结果存在，不能被当作 queued user 的业务回答
      yield* llm.text("handled after summary")

      // 公共 loop 应读取持久化关系并产生普通 assistant，而不是直接返回 ID 更大的 summary；
      // Provider 调用次数为 1，排除测试构造意外触发第二次 Compaction 的可能
      const result = yield* prompt.loop({ sessionID: chat.id })

      // parentID 是归属的结构事实：summary marker 的 ID 更大也不构成回答关系
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(queued.id)
      expect(result.parts.some((part) => part.type === "text" && part.text === "handled after summary")).toBe(true)
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  shortSessionTimeout,
)

// #482：summary Provider 失败不改变移交语义——Runner finalizer 仍须无 Idle 空窗地启动 queued run；
// compact caller 保留原始错误 summary，queued 请求的 RequestUsage 必须以 completed 正常闭合
it.instance(
  "manual compact provider error still hands a queued prompt to the next agent run",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const usage = yield* SessionRequestUsage.Service
      const sessionStatus = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history whose summary will fail")

      // 先记录 Provider 命中再延迟失败响应，使 queued prompt 确定落在失败中的 maintenance 边界内
      yield* llm.push(httpError(400, { error: { message: "summary rejected" } }, deferredAsPromise(gate)))
      yield* llm.text("reply after failed summary")
      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // 固定 ID 同时建立 assistant 归属与 RequestUsage 主键，避免只凭返回文本判断 handoff
      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "continue despite summary failure" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) => (messages.some((message) => message.info.id === queuedID) ? true : undefined)),
          ),
        "queued prompt was not persisted before the summary error",
      )

      // Provider 错误只结束 summary 请求；queued caller 不能误共享错误或永久停留 running
      yield* Deferred.succeed(gate, undefined)
      const [compactExit, queuedExit] = yield* Effect.all([Fiber.await(compact), Fiber.await(queued)])
      const request = yield* usage.get({ sessionID: chat.id, requestID: queuedID })

      expect(Exit.isSuccess(compactExit)).toBe(true)
      if (Exit.isSuccess(compactExit) && compactExit.value.info.role === "assistant") {
        expect(compactExit.value.info.summary).toBe(true)
        expect(compactExit.value.info.error).toBeDefined()
      }
      expect(Exit.isSuccess(queuedExit)).toBe(true)
      if (Exit.isSuccess(queuedExit) && queuedExit.value.info.role === "assistant") {
        expect(queuedExit.value.info.parentID).toBe(queuedID)
        expect(queuedExit.value.info.summary).not.toBe(true)
        expect(queuedExit.value.parts.some((part) => part.type === "text" && part.text === "reply after failed summary")).toBe(
          true,
        )
      }
      expect(request?.status).toBe("completed")
      // RequestUsage 主键断言防止“queued run 实际失败但测试只看返回文本”的隐藏成功
      expect(request?.assistantCount).toBe(1)
      // 两次 Provider 调用且最终 Idle：排除错误重试、重复 handoff 与悬挂 Runner 三类回归
      expect(yield* llm.calls).toBe(2)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

// #482：合并归属——更早的 queued request 已进入同一次模型输入，但只有最新 user
// 成为最终 assistant 的 parent；middle 必须零计费终态化而不是重复计费
it.instance(
  "coalesced queued prompt reaches a zero-cost terminal usage state",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const usage = yield* SessionRequestUsage.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      // 第一条 Provider 回复保持未完成，使后续两个 prompt 都落在同一个活跃 Run state 内；
      // 第二条回复只服务最大 MessageID 对应的 user，验证既有 coalescing 语义；
      // hold 与 text 的顺序构成“进行中任务 + 待处理队列”的最小复现
      yield* llm.hold("first reply", deferredAsPromise(gate))
      yield* llm.text("latest reply")

      const first = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      // caller ID 故意让较早 middle 的字典序高于 latest；时间先后由后面的持久化屏障建立。
      const middleID = MessageID.make("msg_z-middle")
      const latestID = MessageID.make("msg_a-latest")
      const middle = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: middleID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "middle queued intent" }],
        })
        .pipe(Effect.forkChild)
      const persistedMiddle = yield* pollWithTimeout(
        sessions.messages({ sessionID: chat.id }).pipe(Effect.map((messages) => messages.find((message) => message.info.id === middleID))),
        "middle prompt was not persisted",
      )
      // 观察真实写入及毫秒分辨率边界，再接纳 latest；不靠 ID 或 fiber 调度猜测先后。
      yield* pollWithTimeout(
        Effect.sync(() => Date.now() > persistedMiddle.info.time.created ? true : undefined),
        "clock did not advance beyond the persisted middle prompt",
      )
      const latest = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: latestID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "latest queued intent" }],
        })
        .pipe(Effect.forkChild)
      // 释放首轮前先确认两条消息都已落库，避免把调度偶然性误当成 queue 行为
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) =>
              messages.some((message) => message.info.id === middleID) && messages.some((message) => message.info.id === latestID)
                ? true
                : undefined,
            ),
          ),
        "queued prompts were not both persisted",
      )

      yield* Deferred.succeed(gate, undefined)
      const [, middleExit, latestExit] = yield* Effect.all([Fiber.await(first), Fiber.await(middle), Fiber.await(latest)])
      const middleUsage = yield* usage.get({ sessionID: chat.id, requestID: middleID })
      const latestUsage = yield* usage.get({ sessionID: chat.id, requestID: latestID })

      // 较早 queued request 已进入模型输入但没有独立 assistant：零计费终态化；
      // 这三条断言共同排除“合并后仍计费”与“合并后残留 running”两类回归
      expect(middleUsage?.status).toBe("completed")
      expect(middleUsage?.assistantCount).toBe(0)
      expect(middleUsage?.tokens.total).toBe(0)
      // 最新 user 是唯一 parent；两个 caller 共享这次真实回复，不重复记录 assistant 费用
      expect(Exit.isSuccess(middleExit)).toBe(true)
      expect(Exit.isSuccess(latestExit)).toBe(true)
      if (Exit.isSuccess(middleExit) && middleExit.value.info.role === "assistant") {
        expect(middleExit.value.info.parentID).toBe(latestID)
      }
      if (Exit.isSuccess(latestExit) && latestExit.value.info.role === "assistant") {
        // middleExit 也指向 latestID：两个 caller 消费同一个 runLoop 的同一份输出
        expect(latestExit.value.info.parentID).toBe(latestID)
      }
      expect(latestUsage?.status).toBe("completed")
      expect(latestUsage?.assistantCount).toBe(1)
      expect(yield* llm.calls).toBe(2)
    }),
  { git: true },
  shortSessionTimeout,
)

// #482：与 S1 的反向检查组合——revert 先取得所有权时 compact 必须原子失败，
// 且 Busy 拒绝不能留下 scratch compaction（否则普通 loop 可能重放无主维护命令）
it.instance(
  "manual compact rejects while explicit revert owns the session",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history")

      // beginRevert 模拟已取得文件/消息修改权；compact 必须在任何 marker 副作用前失败
      const exit = yield* Effect.acquireUseRelease(
        run.beginRevert(chat.id),
        () => prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.exit),
        () => run.endRevert(chat.id),
      )
      const messages = yield* sessions.messages({ sessionID: chat.id })

      expect(Exit.isFailure(exit)).toBe(true)
      // BusyError 类型断言确保失败来自互斥而非其它意外错误
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      // 无 scratch compaction：被拒的 compact 不得留下可被后续 loop 重放的维护命令
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    }),
  { git: true },
)

// #482：cancel 是明确终止边界——不启动第二次 LLM，不留下可见 scratch compaction；
// queued 请求终态化为 aborted（保留用户主动终止语义）且零 assistant 计费
it.instance(
  "cancel aborts a prompt queued behind manual compact",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const usage = yield* SessionRequestUsage.Service
      const sessionStatus = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history to compact")
      // 未释放 gate 让 summary 持续 streaming；不预置第二条回复，可直接证明 cancel 没有错误启动 pending run；
      // cancel 的前提是 maintenance 与 pending 同时存在，只测一半无法暴露 Deferred 泄漏
      yield* llm.hold("unfinished summary", deferredAsPromise(gate))

      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // queued prompt 先完成持久化与 RequestUsage.begin，随后才等待 ShellThenRun 的 Deferred
      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "do not run after cancel" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) => (messages.some((message) => message.info.id === queuedID) ? true : undefined)),
          ),
        "queued prompt was not persisted before cancel",
      )
      // 让 queued caller 进入 Run state；取消必须同时终止 maintenance 与尚未启动的 pending run
      yield* Effect.yieldNow
      yield* prompt.cancel(chat.id)

      // 两个 caller 都必须在超时边界内终止；任一悬挂都表示 Deferred 未被完整结算
      yield* Effect.all([
        awaitWithTimeout(Fiber.await(compact), "manual compact did not stop after cancel"),
        awaitWithTimeout(Fiber.await(queued), "queued prompt did not stop after cancel"),
      ])
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const request = yield* usage.get({ sessionID: chat.id, requestID: queuedID })

      expect(yield* llm.calls).toBe(1)
      // 无 scratch compaction + 无 summary assistant：cancel 同时回收了两种维护产物
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
      expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
      // aborted 而非 completed：保留用户主动终止的语义
      expect(request?.status).toBe("aborted")
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

// #482：manual compact 仍是维护终点——没有 queued loop 时不能恢复 retained tail 或 Goal；
// summary 返回值与 Idle 状态锁定旧调用合同，避免 handoff 修复改变普通 compact 体验
it.instance(
  "manual compact without a queued prompt stops after the summary",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const sessionStatus = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history only")
      // 只准备一条 summary 响应；若实现无条件续跑，测试服务器会暴露额外 Provider 调用
      yield* llm.text("summary only")

      const result = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref })

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.summary).toBe(true)
      expect(result.parts.some((part) => part.type === "text" && part.text === "summary only")).toBe(true)
      // calls=1 锁定“无排队不续跑”：无条件续跑会让测试服务器暴露额外 Provider 调用
      expect(yield* llm.calls).toBe(1)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)


// 保留 hidden 旧回归，另让两个同毫秒 eligible turn 同时可见，真正经过 Goal tie-break。
for (const hidePrevious of [true, false]) {
it.instance(
  hidePrevious ? "late technical Message cannot rewind blocked continuity past a newer real user" : "same-time visible Unicode Goal turns follow persisted chronology",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 0 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const suffix = crypto.randomUUID().replaceAll("-", "")

      // B 的 caller-selected ID 故意大于后到的 C；Goal turn 顺序必须来自 persisted chronology。
      const b = yield* user(chat.id, "first Goal turn", {
        id: MessageID.make(hidePrevious ? `msg_b${suffix}` : "msg_\uE000"),
        created: 1_000,
      })
      yield* goalSvc.set(chat.id, { objective: "finish the Goal" })
      // 目标 llm API：每次 push 一个完整 provider turn（tool call + stop），
      // 随后 llm.text 提供下一 turn 的文本回复
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }).stop())
      yield* llm.text("pending recorded")
      yield* prompt.loop({ sessionID: chat.id })
      // #553：B 被 undo 隐藏——hidden user 不能回灌 chronology 参与 Goal 排序。
      if (hidePrevious) yield* sessions.updateMessage({ ...b, hidden: { time: Date.now(), reason: "undo" } })

      // C 刻意不调用 blocked：它必须打断 B 的 pending adjacency；
      // 后落盘的 S 虽指向 B，也只能传递 lineage，不能把 B 移回 current。
      yield* user(chat.id, "newer real user turn without a blocked attempt", {
        // 可见分支固定同毫秒 Unicode 顺序，hidden 分支仍保持原始两个时间点。
        id: MessageID.make(hidePrevious ? `msg_a${suffix}` : "msg_\u{10000}"),
        created: hidePrevious ? 2_000 : 1_000,
      })

      yield* user(chat.id, "late technical summary for B", {
        goalTurnID: b.id,
        created: 3_000,
        synthetic: true,
      })

      yield* user(chat.id, "continue the Goal", {
        created: 4_000,
        synthetic: true,
        goalContinuation: true,
      })

      // D 经真实 Prompt/GoalTool path 再次使用同 reason；若 chronology 被 S rewind，
      // 这里会错误成为 attempt 2 并把 Goal 终态化，因此最终 active 是行为级信号。
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }).stop())
      yield* llm.text("second pending recorded")
      yield* prompt.loop({ sessionID: chat.id })

      // C 是 D 的 previous eligible turn；late S(B) 不能把 B 重新排到 C 之后。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("active")
    }),
  { git: true },
  60_000,
)
}

it.instance(
  "legacy compaction marker without lineage does not create a Goal turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 0 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const b = yield* user(chat.id, "first Goal turn")
      const goal = yield* goalSvc.set(chat.id, { objective: "finish the Goal" })
      yield* goalSvc.modelTransition(chat.id, {
        snapshot: { goalID: goal.id, generation: goal.generation, status: "active" },
        turnID: b.id,
        userInitiated: true,
        status: "blocked",
        reason: "persistent blocker",
      })

      // marker 没有 lineage 是历史兼容输入；compaction part 本身必须足以排除其 turn 资格，
      // 同时后续明确标记的 Goal continuation 仍应作为新的 eligible turn。
      yield* user(chat.id, "legacy compaction", { created: Date.now() + 1, compaction: true })
      yield* user(chat.id, "continue the Goal", {
        created: Date.now() + 2,
        synthetic: true,
        goalContinuation: true,
      })
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }).stop())
      yield* llm.text("blocked recorded")
      // [local-smark] 阻塞式 loop：断言依赖 loop 完成后的 Goal 终态（blocked-pending 两次确认），
      // fork 竞态会在终态落盘前读取，确定性破坏验证
      yield* prompt.loop({ sessionID: chat.id })

      // 旧 marker 没有 lineage，但 compaction part 足以证明它是 technical；
      // D 的 previous 仍是 B，所以相同 reason 的第二次确认应真正 terminal。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("blocked")
    }),
  { git: true },
  60_000,
)

it.instance(
  "only a later real user Goal turn authorizes model terminal recovery",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 0 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const terminalTurn = yield* user(chat.id, "finish now", { created: 1_000 })
      yield* goalSvc.set(chat.id, { objective: "finish the Goal" })
      // [local-smark] E2E 先 read 建立快照再 operate 终态转换——必填 schema 下旧空调用会被 decode 拒绝，
      // read→complete 配对同时锁定 trusted-read 前置条件
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "complete", reason: "all work verified" }).stop())
      yield* llm.text("complete recorded")
      yield* prompt.loop({ sessionID: chat.id })

      // 先通过真实 Tool 写入 model terminal，确保 terminal_turn_id 来自 production transition；
      // 直接调用 user set 会产生不同 ownership，不能证明 recovery actor classifier。
      yield* user(chat.id, "technical replay", {
        goalTurnID: terminalTurn.id,
        created: 2_000,
        synthetic: true,
      })
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "active" }).stop())
      yield* llm.text("technical recovery rejected")
      yield* prompt.loop({ sessionID: chat.id })
      const afterTechnical = yield* goalSvc.get(chat.id)
      if (afterTechnical._tag === "Some") expect(afterTechnical.value.status).toBe("complete")

      // technical replay 与 Goal continuation 分别验证 lineage 和 userInitiated 两道拒绝；
      // 只有最后的非 synthetic user Message 才能赋予 later-real-user recovery 授权。
      yield* user(chat.id, "Goal continuation", {
        created: 3_000,
        synthetic: true,
        goalContinuation: true,
      })
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "active" }).stop())
      yield* llm.text("continuation recovery rejected")
      yield* prompt.loop({ sessionID: chat.id })
      const afterContinuation = yield* goalSvc.get(chat.id)
      if (afterContinuation._tag === "Some") expect(afterContinuation.value.status).toBe("complete")

      yield* user(chat.id, "please continue", { created: 4_000 })
      yield* llm.push(reply().tool("goal", { operate: "read" }).stop())
      yield* llm.push(reply().tool("goal", { operate: "active" }).stop())
      yield* llm.text("recovery accepted")
      yield* prompt.loop({ sessionID: chat.id })

      // technical/continuation 只验证拒绝；真正的新用户 Goal turn 才拥有恢复授权。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("active")
    }),
  { git: true },
  60_000,
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

// 在真实外层cancel与RunState间固定窗口，不依赖task忽略中断或2秒计时巧合。
noLLMServer.instance(
  "overlapping cancels share single-flight and do not retarget replacement loop",
  () =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const database = yield* Database.Service
      yield* Effect.forEach([false, true], (failing) => Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const nextStarted = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const failure = new Error("cancel failure")
        let cancels = 0
        let replacementAborted = false
        const runState = Layer.succeed(SessionRunState.Service, { ...state,
          cancel: (id) => Effect.gen(function* () {
            const call = ++cancels
            yield* state.cancel(id)
            if (call !== 1) return
            yield* Deferred.succeed(stopped, undefined)
            yield* Deferred.await(release)
            if (failing) return yield* Effect.die(failure)
          }),
        })
        yield* Effect.addFinalizer(() => Effect.all([Deferred.succeed(release, undefined), Deferred.succeed(finish, undefined)], { discard: true }))
        yield* Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Overlap cancel" })
          const first = yield* seed(chat.id)
          const old = yield* MessageV2.get({ sessionID: chat.id, messageID: first.assistant.id })
          const original = yield* state.ensureRunning(chat.id, Effect.succeed(old), Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const leader = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
          yield* Deferred.await(stopped)
          // 新运行和消息均在旧取消快照之后创建，重叠join不能重新扫描它们。
          const replacement = yield* seed(chat.id)
          const next = yield* MessageV2.get({ sessionID: chat.id, messageID: replacement.assistant.id })
          const running = yield* state.ensureRunning(chat.id, Effect.succeed(next), Deferred.succeed(nextStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finish)), Effect.as(next),
            Effect.onInterrupt(() => Effect.sync(() => { replacementAborted = true })),
          )).pipe(Effect.forkChild)
          yield* Deferred.await(nextStarted)
          const joiner = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(cancels).toBe(1)
          yield* Deferred.succeed(release, undefined)
          const firstExit = yield* Fiber.await(leader)
          const joinedExit = yield* Fiber.await(joiner)
          expect(Exit.isFailure(firstExit)).toBe(failing)
          expect(Exit.isFailure(joinedExit)).toBe(failing)
          if (Exit.isFailure(firstExit) && Exit.isFailure(joinedExit)) {
            expect(Cause.squash(firstExit.cause)).toBe(failure)
            expect(Cause.squash(joinedExit.cause)).toBe(failure)
            // 共享完整Cause而非只比较squash后的同一个Error对象。
            expect(joinedExit.cause).toEqual(firstExit.cause)
          }
          expect(cancels).toBe(1)
          expect(replacementAborted).toBe(false)
          expect(Exit.isFailure(yield* state.assertNotBusy(chat.id).pipe(Effect.exit))).toBe(true)
          const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: next.info.id })
          expect(stored.info.role === "assistant" && stored.info.error).toBeUndefined()
          yield* Deferred.succeed(finish, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
          yield* Fiber.await(original)
          // 上一flight无论成功或失败都必须释放，后续显式取消仍能独立执行。
          yield* prompt.cancel(chat.id)
          expect(cancels).toBe(2)
        }).pipe(Effect.provide(Layer.fresh(makePrompt({ database: Layer.succeed(Database.Service, database), runState }))))
      }))
    }),
  // 单飞只依赖会话和runner，fixture无需Git初始化或本地配置写入。
  { git: false },
  30_000,
)
// #517：只提取持久化 synthetic user Part，避免把 provider 的普通 user/tool 文本误当续跑结果。
// #520：返回完整 TextPart 让行为测试读取公开 metadata，同时保留旧 helper 对正文的既有断言。
function continuationParts(msgs: MessageV2.WithParts[]) {
  return msgs.flatMap((m) =>
    m.info.role === "user"
      ? m.parts.flatMap((p) =>
          p.type === "text" && p.synthetic === true && p.text.includes("<session-goal-continuation>") ? [p] : [],
        )
      : [],
  )
}

function continuationTexts(msgs: MessageV2.WithParts[]) {
  return continuationParts(msgs).map((part) => part.text)
}

// #517：progress gate——两轮无 structured 证据后，下一条 continuation 必须进入 BFS replan。
it.instance(
  "goal progress gate switches to replan after two no-evidence completions",
  () =>
    Effect.gen(function* () {
      // max=2 只允许写入 re-plan continuation；第三个 completion 由 hang 保持未完成。
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 2 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress gate",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "finish the Goal without stalling" })
      yield* user(chat.id, "start the Goal")

      // 两轮仅 text 完成：第二轮完成后注入 replan，第三个 completion 只用于观察前的 hang。
      yield* llm.push(reply().text("turn1 no tools").stop())
      yield* llm.push(reply().text("turn2 no tools").stop())
      yield* llm.push(reply().hang().item())
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
      yield* llm.wait(3)

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(2)
      // 第一轮无证据仍 ordinary；第二轮无证据后下一条 continuation 进入 replan。
      expect(texts[0]).not.toContain("<strategy-switch")
      expect(texts[1]).toContain('mode="breadth-first-replan"')
      expect(texts[1]).toContain("Explore breadth-first")
      // #520：重新读取 persisted Parts，避免复用上方正文数组而把同一实现复制成 expected metadata。
      const parts = continuationParts(yield* MessageV2.filterCompactedEffect(chat.id))
      // 1/2 与 2/2 锁定 run-local 递增和同一 max 快照，独立于 Message 在数组中的索引。
      expect(parts[0]?.metadata).toMatchObject({
        goal_continuation: true,
        goal_continuation_mode: "continue",
        goal_continuation_turn: 1,
        goal_continuation_max_turns: 2,
      })
      expect(parts[1]?.metadata).toMatchObject({
        goal_continuation: true,
        goal_continuation_mode: "replan",
        goal_continuation_turn: 2,
        goal_continuation_max_turns: 2,
      })

      // 在第三 completion 尚未结束前，只有 re-plan 已发生，Goal 必须仍是 active。
      const goal = yield* goalSvc.get(chat.id)
      expect(goal._tag).toBe("Some")
      if (goal._tag === "Some") expect(goal.value.status).toBe("active")
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
  60_000,
)

// ============================================================
// #557：零 token 首写移除 + 懒快照 + 前缀缓存 + worktree 归因矩阵
// ============================================================

it.instance(
  "publishes the estimated Assistant as the first durable attempt state",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const events = yield* EventV2Bridge.Service
      const seen: SessionV1.Assistant[] = []
      const off = yield* events.listen(event => {
        if (event.type !== MessageV2.Event.Updated.type) return Effect.void
        const data = event.data as typeof MessageV2.Event.Updated.data.Type
        if (data.info.sessionID === chat.id && data.info.role === "assistant") seen.push(structuredClone(data.info))
        return Effect.void
      })
      yield* textTurn(chat.id, "estimate this request", "estimated")
      yield* off
      // EventV2在commit后通知；保存独立快照，不能让后续usage更新伪装成首次估算。
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.inputEstimate?.input).toBeGreaterThan(0)
      expect(seen[0]?.inputEstimate?.bodyChars).toBeGreaterThan(0)
      expect(seen[0]?.inputEstimate?.inputBreakdown?.messages.userText).toBeGreaterThan(0)
      expect(seen[0]?.inputEstimate?.confirmed).not.toBe(true)
      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (message) => message.info.role === "assistant",
      )
      expect(assistants).toHaveLength(1)
      const first = assistants[0]?.info
      if (first?.role !== "assistant") throw new Error("Expected assistant")
      expect(first.inputEstimate?.input).toBeGreaterThan(0)
      expect(first.inputEstimate?.inputBreakdown?.messages.userText).toBeGreaterThan(0)
    }),
  { git: true },
)

failingTransform.instance(
  "settles pre-dispatch failure without publishing a zero-estimate Assistant",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const usage = yield* SessionRequestUsage.Service
      const requestID = MessageID.ascending()
      const exit = yield* prompt.prompt({
        sessionID: chat.id, messageID: requestID, agent: "build", parts: [{ type: "text", text: "fail before dispatch" }],
      }).pipe(Effect.exit)

      // transform defect 位于 estimate publication 前，Provider 绝不能收到请求。
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* llm.calls).toBe(0)
      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (message) => message.info.role === "assistant",
      )
      // 目标已有零助手请求终态；保留错误和完成语义，不为兼容旧测试制造幽灵助手。
      expect(assistants).toHaveLength(0)
      const request = yield* usage.get({ sessionID: chat.id, requestID })
      expect(request?.status).toBe("error")
      expect(request?.error).toContain("pre-dispatch transform failed")
      expect(request?.assistantCount).toBe(0)
    }),
  { git: true },
)

it.instance(
  "contracts a retained suffix after public Revert cleanup",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const revert = yield* SessionRevert.Service
      const chat = yield* sessions.create({ title: "Deleted suffix" })
      // 第一次 loop 必须先形成 full hit 候选，删除前不能只测试 cold rebuild。
      const removed = yield* textTurn(chat.id, "delete cached user", "delete cached assistant")
      // 真实 cleanup 写 hidden mutation，不依赖直接删除提供不同的 proof 形状。
      yield* revert.revert({ sessionID: chat.id, messageID: removed.user.id })
      yield* revert.cleanup(yield* sessions.get(chat.id))
      // replacement 保证当前 proof 仍有合法 suffix，cache 不能因删除返回空窗口。
      const replacement = yield* textTurn(chat.id, "surviving replacement", "replacement")
      const body = JSON.stringify((yield* lastProviderInput())?.messages)
      // Provider body 而非 cache 内部长度证明 deleted rows 没有被重播。
      expect(body).toContain("surviving replacement")
      expect(body).not.toContain("delete cached assistant")
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .find((message) => message.info.id === replacement.user.id)
        ?.parts.find((item): item is SessionV1.TextPart => item.type === "text")
      if (!part) throw new Error("Expected replacement text Part")
      // 同 Message ID 原位增长必须从 mismatch inclusive 重载，不能只比较 ID 前缀。
      yield* sessions.updatePart({ ...part, text: "grown part text" })
      yield* textTurn(chat.id, "continue after growth", "done")
      expect(JSON.stringify((yield* lastProviderInput())?.messages)).toContain("grown part text")
    }),
  { git: true },
)

dynamicSurfaces.instance(
  "refreshes queued Permission, Tool definition and MCP in one continuation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Queued cache",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "deny" },
        ],
      })
      const file = path.join(dir, "queued-read.txt")
      const bashFile = path.join(dir, "queued-bash.txt")
      yield* Effect.promise(() => Bun.write(file, "queued"))
      transformedHistoryText = "message transform v1"
      toolDefinitionVersion = "v1"
      mcpEnabled = true
      // 三个动态 producer 在 step1 共享同一可观察版本，避免跨 runLoop 刷新伪通过。
      mcpMutationFile = path.join(dir, "unused-mcp.txt")
      yield* Effect.addFinalizer(() => Effect.sync(() => (mcpEnabled = true)))
      yield* textTurn(chat.id, "establish cache", "first")
      const gate = defer<void>()
      // Provider gate 让 queued user 确定落在 step 1 已 admit 之后、step 2 proof 之前。
      yield* user(chat.id, "start tool step")
      yield* llm.push(
        reply().wait(gate.promise).tool("read", { filePath: file }).item(),
        reply()
          .tool("bash", { command: `echo allowed > ${JSON.stringify(bashFile)}`, description: "fresh permission" })
          .item(),
        reply().text("after queue").stop().item(),
      )
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(2)
      const firstTools = JSON.stringify((yield* lastProviderInput())?.tools)
      // step1 body 固定变更前基线，后续「不含 v1」断言才有独立 expected value。
      expect(firstTools).toContain("dynamic tool v1")
      expect(firstTools).toContain("mcp_mutate")
      // 新 user row 只追加到 canonical suffix，wrapper 本身仍必须是 request-only 改写。
      // readiness 来自真实 HTTP call 计数，不使用固定 sleep 制造时序。
      transformedHistoryText = "message transform v2"
      toolDefinitionVersion = "v2"
      mcpEnabled = false
      // 状态切换发生在同一 runLoop 尚未释放 Provider gate 时，不允许重建 runLoop 规避刷新。
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        tools: { bash: true },
        parts: [{ type: "text", text: "queued during provider call" }],
      })
      gate.resolve()
      yield* Fiber.join(run)
      const latest = (yield* llm.inputs).at(-2)
      const body = JSON.stringify(latest?.messages)
      const tools = JSON.stringify(latest?.tools)
      // transform v2 命中证明 definition/messages 两个动态面都在 continuation 内刷新。
      expect(body).toContain("queued during provider call")
      expect(body).toContain("message transform v2")
      expect(body).not.toContain("message transform v1")
      expect(tools).toContain("dynamic tool v2")
      expect(tools).not.toContain("dynamic tool v1")
      expect(tools).not.toContain("mcp_mutate")
      // #557：文件落盘证明 bash 不仅重新出现在 schema，还通过最新 Permission 进入真实 implementation。
      const bashPart = (yield* sessions.messages({ sessionID: chat.id })).flatMap((m) => m.parts).find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "bash")
      expect(bashPart?.state.status).toBe("completed")
      expect(bashPart && bashPart.state.status === "completed" && "error" in bashPart.state ? bashPart.state.error : undefined).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(bashFile).exists())).toBe(true)
    }),
  { git: true },
)

it.instance(
  "invalidates a retained window after successful Compaction",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Compaction cache" })
      yield* textTurn(chat.id, "history before compaction", "first response")
      yield* llm.text("canonical compacted summary")
      // compaction.run 写入真实 marker/summary/tail boundary，不直接操纵 cache entry。
      expect(yield* compaction.run({ sessionID: chat.id, agent: "build", model: ref, auto: true })).toBe("continue")
      // tools:false 与新 user 一起落盘，但不改变 summary boundary 的 admission 结果。
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        tools: { bash: false },
        parts: [{ type: "text", text: "after compaction" }],
      })
      yield* llm.text("final response")
      yield* prompt.loop({ sessionID: chat.id })
      // summary 进入 body 证明 boundary identity 变化触发 full window rebuild。
      expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("canonical compacted summary")
      // 同次 warm 请求的 Tool 开关证明 Tool surface 未进入 Message cache。
      expect(JSON.stringify((yield* llm.inputs).at(-1)?.tools)).not.toContain('"bash"')
    }),
  { git: true },
)

it.instance(
  "sanitizes cached Tool history for a decide request",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Decide cache",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "decide-cache.txt")
      yield* user(chat.id, "build history")
      yield* llm.tool("write", { filePath: file, content: "tool output" })
      // build 请求先让 raw Tool Part 进入 retained history，decide 随后必须重新 sanitise。
      yield* llm.text("built")
      yield* prompt.loop({ sessionID: chat.id })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "decide",
        noReply: true,
        parts: [{ type: "text", text: "make the decision" }],
      })
      // decide mode 强制 tools 为空，旧 build Tool schema 也不能从 warm entry 复现。
      yield* llm.text("decision")
      yield* prompt.loop({ sessionID: chat.id })
      const body = JSON.stringify((yield* llm.inputs).at(-1)?.messages)
      // synthetic tool-context 证明 decide 走完整 selected history conversion，而非普通 cached chunk。
      // body 是 JSON.stringify 产物——引号以转义形式出现。
      expect(body).toContain('tool-context tool=' + String.raw`\"write\"`)
      // 原 AI tool role 缺失防止 unsanitized Tool protocol 泄漏给 decide 模型。
      expect(body).not.toContain('"role":"tool"')
    }),
  { git: true },
)

measuredPreflight.instance(
  "reuses a 2048-turn prefix before Provider dispatch",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Large retained prefix" })
      // 计时对象是读取及转换；造数不经逐条事件fanout，避免把账本维护成本当成缓存回归。
      const database = yield* Database.Service
      // 历史早于后续真实输入，保持2048个闭合turn的创建顺序而不依赖ID比较。
      const created = Date.now() - 4_096
      const rows = Array.from({ length: 2_048 }, (_, index) => {
        const id = MessageID.ascending()
        const assistantID = MessageID.ascending()
        return [
          { id, session_id: chat.id, time_created: created + index * 2,
            data: { role: "user" as const, agent: "build", model: ref,
              time: { created: created + index * 2 } } },
          // 与seed保持同一stop、父消息及零usage形状；本fixture不伪造确认样本。
          { id: assistantID, session_id: chat.id, time_created: created + index * 2 + 1,
            data: { role: "assistant" as const, parentID: id, mode: "build", agent: "build", cost: 0, finish: "stop",
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID, providerID: ref.providerID, time: { created: created + index * 2 + 1 } } },
        ]
      }).flat()
      // 分批限制SQLite参数数量，单事务只负责建立本次hot历史，不改变产品写入owner。
      yield* Database.withSync(database, (sync) => sync.transaction((tx) => {
        for (let offset = 0; offset < rows.length; offset += 250) {
          const batch = rows.slice(offset, offset + 250)
          tx.insert(MessageTable).values(batch).run()
          // 每条Message保留与原seed一致的单个文本Part，后续混合样本仍独立比较真实converter。
          tx.insert(PartTable).values(batch.map((row) => ({
            id: PartID.ascending(), session_id: chat.id, message_id: row.id,
            data: { type: "text" as const, text: row.data.role === "user" ? "hello" : "hi there" },
          }))).run()
        }
      }))
      const providers = yield* ProviderSvc.Service
      const model = yield* providers.getModel(ref.providerID, ref.modelID)
      const history = yield* MessageV2.filterCompactedEffect(chat.id)
      const full = yield* MessageV2.toModelMessagesEffect(history, model)
      const chunks = yield* MessageV2.toModelMessageChunksEffect(history, model)
      // cache 只改变转换分块，不允许改变 Provider body 的 role/content/tool 顺序。
      expect(chunks.flat()).toEqual(full)
      const shaped = structuredClone(history.slice(0, 2))
      // 不改持久性能样本；混合Part必须与完整converter保持同一字面结果。
      const shapeUser = shaped.find((message) => message.info.role === "user")
      const shapeAssistant = shaped.find((message) => message.info.role === "assistant")
      if (!shapeUser || !shapeAssistant) throw new Error("Expected shape pair")
      shapeUser.parts.push(
        { id: PartID.ascending(), messageID: shapeUser.info.id, sessionID: chat.id, type: "file", mime: "image/png", url: `data:image/png;base64,${tinyPng}` },
        { id: PartID.ascending(), messageID: shapeUser.info.id, sessionID: chat.id, type: "compaction", auto: true },
      )
      shapeAssistant.parts.push(
        { id: PartID.ascending(), messageID: shapeAssistant.info.id, sessionID: chat.id, type: "tool", tool: "shape", callID: "completed", state: { status: "completed", input: {}, output: "tool output", title: "", metadata: {}, time: { start: 0, end: 1 } } },
        { id: PartID.ascending(), messageID: shapeAssistant.info.id, sessionID: chat.id, type: "tool", tool: "shape", callID: "error", state: { status: "error", input: {}, error: "tool error", metadata: {}, time: { start: 0, end: 1 } } },
      )
      // 覆盖completed/error、媒体和压缩标记，不复制转换算法构造expected。
      // 每条Message的工具调用及结果不得因分块改变角色或顺序。
      const shapeFull = yield* MessageV2.toModelMessagesEffect(shaped, model)
      expect((yield* MessageV2.toModelMessageChunksEffect(shaped, model)).flat()).toEqual(shapeFull)

      yield* user(chat.id, "cold suffix")
      yield* llm.text("cold response")
      const coldStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      // cold 样本包含首次 hydrate 与 chunk construction，是原始回归基线。
      const cold = performance.now() - coldStarted

      yield* user(chat.id, "warm suffix")
      yield* llm.text("warm response")
      const warmStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      // warm 仍包含 Provider HTTP 与 durable Assistant 写入，不是 private helper 计时。
      const warm = performance.now() - warmStarted
      const dispatchedAt = llmDispatchTimes.get(chat.id)
      if (dispatchedAt === undefined) throw new Error("Expected public LLM dispatch")
      // 整轮保持冷暖对比；1秒约束消息准备至公开入口，prepared估算和确认账本仍走真实路径。
      expect(warm).toBeLessThan(cold)
      expect(dispatchedAt).toBeGreaterThanOrEqual(warmStarted)
      expect(dispatchedAt - warmStarted).toBeLessThan(1_000)

      // 首次无新消息调用先 admit 刚完成的 Assistant；第二次才是 proof 完全不变的 exact full hit。
      yield* prompt.loop({ sessionID: chat.id })
      const hitStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      const fullHit = performance.now() - hitStarted
      const other = yield* sessions.create({ title: "Evict sole Message entry" })
      yield* seed(other.id, { finish: "stop" })
      yield* prompt.loop({ sessionID: other.id })
      // 另一 Session 只负责替换唯一 entry，不修改原 2048-turn proof 或可见历史。
      const rebuildStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      const rebuild = performance.now() - rebuildStarted
      // 两条路径均不 dispatch Provider，时间差只来自 admission/hydration/conversion。
      // 沿用本轮起点既有120ms跨架构余量；无缓存整段重载仍会违反0.65比例。
      expect(fullHit).toBeLessThan(rebuild * 0.65 + 120)
      expect(yield* llm.calls).toBe(2)
    }),
  { git: true },
  120_000,
)

observedDenied.instance(
  "captures before a non-none Tool rejected by a pre-execution hook",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      snapshotTracks.delete(dir)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Rejected Tool",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "rejected-tool.txt")
      // bash 是 ambient；hook 拒绝后仍应留下 policy marker 而无文件副作用。
      yield* user(chat.id, "reject before implementation")
      yield* llm.tool("bash", { command: `printf rejected > ${JSON.stringify(file)}`, description: "reject" })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: chat.id })
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .find((item): item is SessionV1.ToolPart => item.type === "tool" && item.tool === "bash")
      // before+after 各一次证明 capture 位于 hook 前，error step 仍完成 Snapshot 边界。
      expect(snapshotTracks.get(dir)).toBe(2)
      expect(part?.state.status).toBe("error")
      // error replacement 不能擦除 prepare 阶段写入的 top-level authority。
      expect(part?.metadata?.worktree).toBe("ambient")
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
    }),
  { git: true },
)

observedProvider.instance(
  "does not snapshot a Provider-executed Tool",
  () =>
    Effect.gen(function* () {
      const { dir } = yield* useServerConfig(providerCfg)
      snapshotTracks.delete(dir)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Provider Tool" })
      // providerExecuted stream 没有本地 execute callback，任何 track 都属于错误归因。
      yield* user(chat.id, "provider executes remotely")
      yield* prompt.loop({ sessionID: chat.id })
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .find((item): item is SessionV1.ToolPart => item.type === "tool")
      expect(snapshotTracks.get(dir) ?? 0).toBe(0)
      // provider marker 保留用于展示，但不得被映射成 ambient 或 declared。
      expect(part?.metadata?.providerExecuted).toBe(true)
      expect(part?.metadata?.worktree).toBeUndefined()
    }),
  { git: true },
)

observed.instance(
  "enforces Snapshot and Revert worktree authority matrix",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const snapshots = yield* Snapshot.Service
      const revert = yield* SessionRevert.Service
      snapshotTracks.delete(dir)
      const readChat = yield* sessions.create({ title: "None policy", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const readFile = path.join(dir, "read-only.txt")
      yield* Effect.promise(() => Bun.write(readFile, "read only"))
      yield* user(readChat.id, "read without side effects")
      // Read 经过真实 local adapter 和 terminal lifecycle，0 计数不能由「没有 Tool」偶然满足。
      yield* llm.tool("read", { filePath: readFile })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: readChat.id })
      expect(snapshotTracks.get(dir) ?? 0).toBe(0)

      const shared = yield* sessions.create({ title: "Shared Snapshot", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* user(shared.id, "run both tools")
      yield* llm.push(
        concurrentToolReply([
          { name: "write", input: { filePath: path.join(dir, "declared-concurrent.txt"), content: "declared" } },
          { name: "bash", input: { command: `printf ambient > ${JSON.stringify(path.join(dir, "ambient-concurrent.txt"))}`, description: "ambient write" } },
        ]),
        reply().tool("bash", { command: `printf next > ${JSON.stringify(path.join(dir, "ambient-next-step.txt"))}`, description: "next step" }).item(),
        reply().text("done").stop().item(),
      )
      yield* prompt.loop({ sessionID: shared.id })
      const policies = (yield* sessions.messages({ sessionID: shared.id })).flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool").map((part) => part.metadata?.worktree).sort()
      // 首轮并发共享 before/after；新 Assistant 续轮建立另一组，重复 capture 会使总数超过 4。
      expect(snapshotTracks.get(dir)).toBe(4)
      expect(policies).toEqual(["ambient", "ambient", "declared"])

      const chat = yield* sessions.create({ title: "Revert authority" })
      const turn = yield* seed(chat.id, { finish: "stop" })
      const before = yield* snapshots.track()
      // baseline 早于两个文件写入，使一个 Patch 同时覆盖 declared 和 none 候选。
      if (!before) throw new Error("Expected Snapshot baseline")
      const noneFile = path.join(dir, "none-owned.txt")
      const declaredFile = path.join(dir, "declared-owned.txt")
      yield* Effect.promise(() => Promise.all([Bun.write(noneFile, "none"), Bun.write(declaredFile, "declared")]))
      const patch = yield* snapshots.patch(before)
      // result metadata 形状刻意相同，唯一 authority 差异是 top-level policy。
      // #557：computeDiff 以 worktree 相对路径拼接——fixture 供 basename，与 #545 口径一致。
      const completed = (filepath: string) => ({
        status: "completed" as const,
        input: {},
        output: "done",
        title: path.basename(filepath),
        metadata: { filepath: path.basename(filepath), diff: "changed" },
        time: { start: 0, end: 1 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "custom_none", callID: "none", state: completed(noneFile),
      } as never)
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "edit", callID: "declared", metadata: { worktree: "declared" }, state: completed(declaredFile),
      } as never)
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "patch",
        hash: patch.hash, files: patch.files,
      })
      const ambientTurn = yield* seed(chat.id, { finish: "stop" })
      // 第二 Assistant 修改同一 none 文件，专门复现 range 级全局 Set 的反向授权缺陷。
      const ambientBefore = yield* snapshots.track()
      if (!ambientBefore) throw new Error("Expected ambient baseline")
      yield* Effect.promise(() => Bun.write(noneFile, "ambient"))
      const ambientPatch = yield* snapshots.patch(ambientBefore)
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: ambientTurn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "bash", callID: "ambient", metadata: { worktree: "ambient" }, state: completed(noneFile),
      } as never)
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: ambientTurn.assistant.id, sessionID: chat.id, type: "patch",
        hash: ambientPatch.hash, files: ambientPatch.files,
      })

      yield* revert.revert({ sessionID: chat.id, messageID: turn.user.id })
      // 后 Assistant 的 ambient 只能恢复到 none 写入后的状态，不能反向授权更早 Patch。
      expect(yield* Effect.promise(() => Bun.file(noneFile).text())).toBe("none")
      // declared 文件撤回证明修复没有关闭既有精确归因路径。
      expect(yield* Effect.promise(() => Bun.file(declaredFile).exists())).toBe(false)
    }),
  { git: true },
  120_000,
)

// #517：replan 中 exploration（read）不能退出 replan；advancement（write）才能回到 ordinary。
it.instance(
  "goal progress gate keeps replan on read exploration and clears on effective write",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 6 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress evidence",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "inspect and then change the file" })
      yield* user(chat.id, "start")
      const target = path.join(dir, "gate-note.txt")
      yield* writeText(target, "seed\n")

      // turn1/turn2：无证据 -> 进入 replan
      yield* llm.push(reply().text("idle 1").stop())
      yield* llm.push(reply().text("idle 2").stop())
      // turn3：新 read 仅 exploration，仍 replan
      yield* llm.push(
        reply().tool("read", { filePath: target }),
        reply().text("read done").stop(),
      )
      // turn4：有效 write 是 advancement，下一条 ordinary
      yield* llm.push(
        reply().tool("write", { filePath: target, content: "changed by progress gate\n" }),
        reply().text("write done").stop(),
      )
      // turn5：再 idle 一次，下一条 ordinary（计数已清零）
      yield* llm.push(reply().text("after advance idle").stop())
      yield* llm.push(reply().text("final").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      // 索引：0=after t1 ordinary, 1=after t2 replan next, 2=after read still replan,
      // 3=after write ordinary, 4=after later idle ordinary
      expect(texts.length).toBeGreaterThanOrEqual(5)
      expect(texts[1]).toContain('mode="breadth-first-replan"')
      expect(texts[2]).toContain('mode="breadth-first-replan"')
      expect(texts[3]).not.toContain("<strategy-switch")
      expect(texts[4]).not.toContain("<strategy-switch")
    }),
  { git: true },
  45_000,
)

// #517：read identity——新版本/range 必须能启动或重置 raw count，重复同一 read 不能伪造 exploration。
it.instance(
  "goal progress gate observes read identity and range boundaries",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 9 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress read identity",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "distinguish read versions and ranges" })
      yield* user(chat.id, "start")
      const target = path.join(dir, "read-identity.txt")
      yield* writeText(target, "first\nsecond\n")
      const firstRead = { filePath: target, offset: 0, limit: 1 }
      // ReadTool 的 offset 是 1-based；offset=2 才会发布与 firstRead 不同的 start/end。
      const secondRange = { filePath: target, offset: 2, limit: 1 }

      yield* llm.push(reply().text("idle").stop())
      yield* llm.push(reply().tool("read", firstRead).item(), reply().text("read first").stop())
      // 相同 path/version/range 的第二次 read 必须复用 identity，不清掉下一个 idle 的停滞计数。
      yield* llm.push(reply().tool("read", firstRead).item(), reply().text("read duplicate").stop())
      yield* llm.push(reply().text("read boundary").stop())
      yield* llm.push(reply().tool("write", { filePath: target, content: "changed\nsecond\n" }).item(), reply().text("advance").stop())
      yield* llm.push(reply().text("range idle").stop())
      // range 改变即使文件版本不变也必须形成新的 evidence node。
      yield* llm.push(reply().tool("read", secondRange).item(), reply().text("read second range").stop())
      yield* llm.push(reply().text("range boundary").stop())
      yield* llm.push(reply().text("final boundary").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(9)
      expect(texts[1]).not.toContain("<strategy-switch")
      expect(texts[2]).not.toContain("<strategy-switch")
      expect(texts[3]).toContain('mode="breadth-first-replan"')
      expect(texts[6]).not.toContain("<strategy-switch")
      expect(texts[8]).toContain('mode="breadth-first-replan"')
    }),
  { git: true },
  60_000,
)

// #517：normalized search/command signatures——重复输入不应伪造新探索；无效 edit 也不应成为 advancement。
it.instance(
  "goal progress gate ignores duplicate normalized searches and no-op edits",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 9 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress duplicate evidence",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "distinguish new evidence from duplicate activity" })
      yield* user(chat.id, "start")
      const target = path.join(dir, "gate-search.txt")
      yield* writeText(target, "needle\n")

      // grep 的 include/exclude 顺序属于 provider 表示差异，不应改变 semantic scope。
      const grep = {
        pattern: "needle",
        include: ["gate-search.txt", "other.txt"],
        exclude: ["dist/**", "node_modules/**"],
      }
      const repeatedGrep = {
        ...grep,
        path: ".",
        include: ["other.txt", "gate-search.txt"],
        exclude: ["node_modules/**", "dist/**"],
      }
      const glob = { pattern: "gate-search.txt" }
      const repeatedGlob = { ...glob, path: "." }

      // 新 grep/glob/command 各自只清 raw count；相同 normalized signature 不应清 count。
      yield* llm.push(reply().text("idle").stop())
      yield* llm.push(reply().tool("grep", grep).item(), reply().text("grep").stop())
      // 第一次搜索建立 normalized baseline，下一次仅改变 path spelling 和数组顺序。
      yield* llm.push(reply().tool("grep", repeatedGrep).item(), reply().text("duplicate grep").stop())
      yield* llm.push(reply().tool("glob", glob).item(), reply().text("glob").stop())
      // glob 同样验证缺省目录与显式当前目录的 producer-equivalent identity。
      yield* llm.push(reply().tool("glob", repeatedGlob).item(), reply().text("duplicate glob").stop())
      yield* llm.push(
        reply().tool("bash", { command: `bun -e "process.stdout.write('stable')"`, description: "stable generic command" }).item(),
        reply().text("command").stop(),
      )
      yield* llm.push(
        reply().tool("bash", { command: `bun -e "process.stdout.write('stable')"`, description: "same generic command" }).item(),
        reply().text("duplicate command").stop(),
      )
      yield* llm.push(
        reply().tool("edit", {
          filePath: target,
          edits: [{ oldString: "needle", newString: "needle" }],
        }).item(),
        reply().text("no-op edit").stop(),
      )
      yield* llm.push(reply().text("final").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(8)
      // 首次 grep/glob/command 都应保持 ordinary，说明它们是 exploration 而非 advancement。
      expect(texts[1]).not.toContain("<strategy-switch")
      expect(texts[3]).not.toContain("<strategy-switch")
      expect(texts[5]).not.toContain("<strategy-switch")
      // no-op edit 后累计两轮无证据，说明重复搜索/command 没有错误地重置 gate。
      expect(texts[7]).toContain('mode="breadth-first-replan"')
    }),
  { git: true },
  60_000,
)

// #517：duplicate probes must be observed before a later write can reset the gate;
// otherwise unconditional exploration counting would pass the same assertions.
it.instance(
  "goal progress gate suppresses duplicate normalized grep glob and command probes",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 15 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress normalized probes",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "deduplicate equivalent evidence probes" })
      yield* user(chat.id, "start")
      const target = path.join(dir, "normalized-probe.txt")
      yield* writeText(target, "needle\n")
      const linkedDir = path.join(dir, "normalized-link")
      if (process.platform !== "win32") yield* Effect.promise(() => symlink(dir, linkedDir, "dir"))
      const equivalentDirectory = process.platform === "win32" ? "." : linkedDir
      const grep = { pattern: "needle", include: ["normalized-probe.txt", "other.txt"], exclude: ["dist/**"] }
      const repeatedGrep = { ...grep, path: equivalentDirectory, include: ["other.txt", "normalized-probe.txt"] }
      const glob = { pattern: "*.txt" }
      const repeatedGlob = { ...glob, path: equivalentDirectory }
      const command = `bun -e "process.stdout.write('stable')"`

      // 每个 duplicate 后立即接 boundary idle；后续 write 只用于清除前一阶段的 re-plan。
      yield* llm.push(reply().text("idle").stop())
      yield* llm.push(reply().tool("grep", grep).item(), reply().text("grep").stop())
      yield* llm.push(reply().tool("grep", repeatedGrep).item(), reply().text("duplicate grep").stop())
      yield* llm.push(reply().text("grep boundary").stop())
      // write 只作为独立 advancement，不能替 duplicate search 隐藏其前一轮判断。
      yield* llm.push(reply().tool("write", { filePath: target, content: "glob\n" }).item(), reply().text("advance").stop())
      yield* llm.push(reply().text("glob idle").stop())
      yield* llm.push(reply().tool("glob", glob).item(), reply().text("glob").stop())
      yield* llm.push(reply().tool("glob", repeatedGlob).item(), reply().text("duplicate glob").stop())
      yield* llm.push(reply().text("glob boundary").stop())
      // glob 阶段重复同一 pattern/scope，随后 boundary idle 必须重新触发 re-plan。
      yield* llm.push(reply().tool("write", { filePath: target, content: "command\n" }).item(), reply().text("advance again").stop())
      yield* llm.push(reply().text("command idle").stop())
      yield* llm.push(reply().tool("bash", { command, description: "stable command" }).item(), reply().text("command").stop())
      // description 不进入 signature；相同 command/output 仍然是 duplicate generic evidence。
      yield* llm.push(reply().tool("bash", { command, description: "duplicate command" }).item(), reply().text("duplicate command").stop())
      yield* llm.push(reply().text("command boundary").stop())
      yield* llm.push(reply().text("final").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(14)
      expect(texts[2]).not.toContain("<strategy-switch")
      expect(texts[3]).toContain('mode="breadth-first-replan"')
      expect(texts[7]).not.toContain("<strategy-switch")
      expect(texts[8]).toContain('mode="breadth-first-replan"')
      expect(texts[12]).not.toContain("<strategy-switch")
      expect(texts[13]).toContain('mode="breadth-first-replan"')
    }),
  { git: true },
  90_000,
)

// #517：verification signature——首次结果只算 exploration，same result 不算新证据，结果改变才算 advancement。
it.instance(
  "goal progress gate distinguishes first and changed verification results",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 8 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress verification evidence",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "verify changing external state" })
      yield* user(chat.id, "start")

      // #525：状态放在 Project 外；否则 generic mutation 会被 Snapshot 误记为 Patch advancement。
      const stateDir = yield* tmpdirScoped()
      const statusPath = path.join(stateDir, "verification-status.txt")
      const fixturePath = path.join(dir, "verification.test.ts")
      const changePath = path.join(dir, "verification-change.ts")
      // #525：输出日志被 gitignore；命令重定向到文件而不是 /dev/null（Windows shell 解析差异）。
      yield* writeText(path.join(dir, ".gitignore"), "verification-output.log\n")
      yield* writeText(statusPath, "one\n")
      yield* writeText(
        fixturePath,
        [
          'import { expect, test } from "bun:test"',
          `test("status", async () => expect(await Bun.file(${JSON.stringify(statusPath)}).text()).toBe("one\\n"))`,
        ].join("\n"),
      )
      // #525：mutation 落盘为不可变相对脚本；外部绝对路径只出现在 Bun 字面量内，不进入 Shell 解析。
      yield* writeText(changePath, `await Bun.write(${JSON.stringify(statusPath)}, "two\\n")`)
      const verify = "bun test --timeout 30000 verification.test.ts > verification-output.log 2>&1"
      const change = "bun verification-change.ts"

      // 忽略输出文件使同一 verification 的 signature 只由 exit/result 改变，不受耗时噪声或 Patch 影响。
      yield* llm.push(reply().text("idle 1").stop())
      yield* llm.push(reply().text("idle 2").stop())
      yield* llm.push(reply().tool("bash", { command: verify, description: "verification one" }).item(), reply().text("verified").stop())
      // 第二次调用使用同一 command，必须复用 baseline 而不是制造 changed result。
      yield* llm.push(reply().tool("bash", { command: verify, description: "verification repeat" }).item(), reply().text("same verification").stop())
      yield* llm.push(reply().tool("bash", { command: change, description: "change verification fixture" }).item(), reply().text("fixture changed").stop())
      // #525：generic mutation 只改变外部状态，不提供 Patch 或 verification advancement。
      yield* llm.push(reply().tool("bash", { command: verify, description: "verification changed" }).item(), reply().text("verification changed").stop())
      // 相同 command 的 exit 从 0 变 1，才是允许离开 re-plan 的 advancement。
      yield* llm.push(reply().text("after changed verification").stop())
      yield* llm.push(reply().text("final").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(6)
      // first result establishes baseline and identical repeat is still no new evidence;
      // only the later changed result may clear the persisted re-plan mode.
      expect(texts[2]).toContain("<strategy-switch")
      expect(texts[3]).toContain("<strategy-switch")
      // #525：generic mutation 只能改变外部验证状态；它不能绕过 re-plan 的 advancement 门槛。
      expect(texts[4]).toContain("<strategy-switch")
      // changed verification 是 advancement；若只算 exploration，下一轮 idle 就会错误进入 replan。
      expect(texts[5]).not.toContain("<strategy-switch")
    }),
  { git: true },
  150_000,
)

// #517：Todo/no-op contract——新完成 Todo 才能推进，重复快照和 no-op edit 都不能推进。
it.instance(
  "goal progress gate treats completed Todo as advancement and repeated no-op as stagnation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), goal_max_turns: 5 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goalSvc = yield* SessionGoal.Service
      const chat = yield* sessions.create({
        title: "progress todo evidence",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* goalSvc.set(chat.id, { objective: "finish a structured todo" })
      yield* user(chat.id, "start")
      const target = path.join(dir, "todo-note.txt")
      yield* writeText(target, "same\n")
      const todos = [{ content: "inspect the note", status: "completed", priority: "high" }]

      // 首个 completed Todo 推进，重复 snapshot 和 no-op edit 必须留下两个无证据 turn。
      // 末尾 assertion 同时保护 Todo identity 去重和空 diff 过滤，不能只验证其中一条。
      yield* llm.push(reply().text("idle").stop())
      yield* llm.push(reply().tool("todowrite", { todos }).item(), reply().text("todo complete").stop())
      // 同一内容/priority 的第二个 completed snapshot 不代表新增完成事项。
      yield* llm.push(reply().tool("todowrite", { todos }).item(), reply().text("same todo snapshot").stop())
      yield* llm.push(
        reply().tool("edit", {
          filePath: target,
          edits: [{ oldString: "same", newString: "same" }],
        }).item(),
        reply().text("no-op edit").stop(),
      )
      yield* llm.push(reply().text("final").stop())
      yield* prompt.loop({ sessionID: chat.id })

      const texts = continuationTexts(yield* MessageV2.filterCompactedEffect(chat.id))
      expect(texts.length).toBeGreaterThanOrEqual(4)
      expect(texts[1]).not.toContain("<strategy-switch")
      expect(texts[3]).toContain('mode="breadth-first-replan"')
    }),
  { git: true },
  60_000,
)


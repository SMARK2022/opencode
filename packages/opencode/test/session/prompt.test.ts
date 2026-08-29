import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { symlink } from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionGoal } from "../../src/session/goal"
import { SessionRequestUsage } from "../../src/session/request-usage"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { tool as aiTool } from "ai"
import { z } from "zod"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { SessionMessage } from "@opencode-ai/core/session-message"
import * as DateTime from "effect/DateTime"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const shortSessionTimeout = process.platform === "win32" ? 15_000 : 3_000
// 负载敏感集成用例的平台化预算（先例：shortSessionTimeout 与 shell.test.ts timeoutMs）：
// 本机退化态实测 pwsh 冷启 + fsmonitor 后台占用使固定 10s/15s/5s 预算顶格（对照实验
// 证明与代码版本无关）；预算只放宽等待时长，不改变任何断言。内层 wait 预算必须
// 严格小于所属用例的注册硬顶（reviewPollBudget < heavyLoopBudget，两平台均成立）。
const heavyLoopBudget = process.platform === "win32" ? 30_000 : 12_000
const reviewPollBudget = process.platform === "win32" ? "12 seconds" : "5 seconds"
const snapshotMatrixBudget = process.platform === "win32" ? 90_000 : 40_000
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
const twoFrameGif = "R0lGODlhBAAEAIAAAExpcUxpcSH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAAAAACwAAAAABAAEAAACBIyPGQUAIfkEBQAAAAAsAAAAAAQABACATGlx/wAAAgSMjxkFADs="

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

function shortShellDelayCommand() {
  // Windows 的默认 shell 会把 `sleep 0.2` 解析成 PowerShell 命令，CI 冷启动时足以吃掉 3s 用例预算。
  // 这里使用测试进程已依赖的 PATH 内 `bun` 执行短延迟脚本，避免 PowerShell 对引号路径需要 `&` 的差异。
  return `bun -e "setTimeout(process.exit, 200)"`
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
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
let mcpMutationFile = ""
let mcpEnabled = true
// MCP开关模拟同daemon内连接态变化，Message cache不得冻结其Tool surface。
const mcpMutationTool = tool({
  description: "mutate one test file",
  inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  execute: () => Bun.write(mcpMutationFile, "mcp").then(() => "mutated"),
})
const mutatingMcp = Layer.mock(MCP.Service, {
  // partial mock只暴露Prompt真实消费的tools seam，意外调用其他方法会直接红测。
  tools: () => Effect.succeed<Record<string, AITool>>(mcpEnabled ? { mcp_mutate: mcpMutationTool } : {}),
})

const snapshotTracks = new Map<string, number>()
// observer包装真实Snapshot Service，因此计数包含before和after，而非伪造成功值。
const observedSnapshot = Layer.effect(
  Snapshot.Service,
  Effect.gen(function* () {
    const base = yield* Snapshot.Service
    return Snapshot.Service.of({
      ...base,
      // track计数发生在真实调用之前，晚capture和重复capture都能被断言观察。
      track: () =>
        InstanceState.directory.pipe(
          Effect.tap((dir) => Effect.sync(() => snapshotTracks.set(dir, (snapshotTracks.get(dir) ?? 0) + 1))),
          Effect.andThen(base.track()),
        ),
    })
  }),
).pipe(Layer.provide(Snapshot.defaultLayer))
const providerUsage = {
  inputTokens: 1, outputTokens: 1, totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
}
// providerExecuted事件绕过本地Tool adapter，专门保护“远端Tool不建本地baseline”。
const providerExecutedLLM = Layer.mock(LLM.Service, {
  stream: () =>
    Stream.make(
      { type: "tool-input-start", id: "provider-call", toolName: "provider_search", providerExecuted: true } satisfies LLM.Event,
      // tool-call仍进入Processor生命周期，但没有任何本地execute回调可触发Snapshot。
      { type: "tool-call", toolCallId: "provider-call", toolName: "provider_search", input: {}, providerExecuted: true } satisfies LLM.Event,
      { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", response: { id: "provider-response", modelId: "test-model", timestamp: new Date() }, providerMetadata: undefined, usage: providerUsage } satisfies LLM.Event,
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: providerUsage } satisfies LLM.Event,
    ),
})

const lspDirectories: string[] = []
const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => InstanceState.directory.pipe(Effect.tap((directory) => Effect.sync(() => lspDirectories.push(directory))), Effect.asVoid),
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
// The registry path only needs ReadTool construction here; image normalization itself is exercised separately.
const registryImage = Layer.succeed(
  Image.Service,
  Image.Service.of({
    normalize: (input) => Effect.succeed(input),
  }),
)
const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const imageNormalizations: string[] = []
const countingImage = Layer.succeed(
  Image.Service,
  Image.Service.of({
    normalize: (input) => Effect.sync(() => imageNormalizations.push(input.url)).pipe(Effect.as(input)),
  }),
)
const mutatingPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (name, _input, output) =>
      Effect.sync(() => {
        if (typeof output !== "object" || output === null) return output
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
        const file = parts.find((part) => typeof part === "object" && part !== null && Reflect.get(part, "type") === "file")
        // 真实 hook 在 final normalization 前改写 URL；旧 proof 必须失效并让 counting Image owner 再执行一次。
        if (file) Reflect.set(file, "url", "data:image/png;base64,AQ==")
        return output
      }),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)
const failingMessageTransform = Layer.mock(Plugin.Service, {
  trigger: (name, _input, output) =>
    name === "experimental.chat.messages.transform"
      ? Effect.die(new Error("pre-dispatch transform failed"))
      : Effect.succeed(output),
  list: () => Effect.succeed([{ "experimental.chat.messages.transform": () => Promise.resolve() }]),
})
let transformedHistoryText = ""
let toolDefinitionVersion = ""
const transformingHistory = Layer.mock(Plugin.Service, {
  trigger: (name, _input, output) =>
    Effect.sync(() => {
      if (name === "tool.definition" && typeof output === "object" && output !== null) {
        // description和schema使用同一版本，第二step可同时检测definition两种输出是否fresh。
        Reflect.set(output, "description", `dynamic tool ${toolDefinitionVersion}`)
        Reflect.set(output, "jsonSchema", { type: "object", properties: { version: { const: toolDefinitionVersion } } })
        return output
      }
      if (name !== "experimental.chat.messages.transform") return output
      if (typeof output !== "object" || output === null) return output
      const messages = Reflect.get(output, "messages")
      if (!Array.isArray(messages)) return output
      // 改写最早历史Part可检测错误的converted-prefix复用，改latest不足以区分suffix路径。
      const text = messages
        .flatMap((message) => Reflect.get(message, "parts") ?? [])
        .find((part) => Reflect.get(part, "type") === "text")
      if (text) Reflect.set(text, "text", transformedHistoryText)
      // mutation只作用working clone；下一run仍须从persisted原文重新应用当前版本。
      return output
    }),
  list: () => Effect.succeed([{ "experimental.chat.messages.transform": () => Promise.resolve() }]),
})
const failingToolPlugin = Layer.mock(Plugin.Service, {
  // hook在真实Tool implementation之前失败，用于验证baseline已先建立且文件未写入。
  trigger: (name, _input, output) =>
    name === "tool.execute.before" ? Effect.die(new Error("Tool rejected before implementation")) : Effect.succeed(output),
  list: () => Effect.succeed([]),
})

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

function makeHttp(input?: {
  processor?: "blocking"
  usage?: boolean
  image?: "unavailable" | "counting"
  plugin?: "mutate" | "fail-transform" | "transform-history" | "fail-tool"
  snapshot?: "observe"
  mcp?: "mutating"
  llm?: "provider-executed"
}) {
  const imageLayer =
    input?.image === "unavailable" ? unavailableImage : input?.image === "counting" ? countingImage : Image.defaultLayer
  const registryImageLayer = input?.image === "counting" ? countingImage : registryImage
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    input?.snapshot === "observe" ? observedSnapshot : Snapshot.defaultLayer,
    input?.llm === "provider-executed" ? providerExecutedLLM : LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    input?.plugin === "mutate"
      ? mutatingPlugin
      : input?.plugin === "fail-transform"
        ? failingMessageTransform
        : input?.plugin === "transform-history"
          ? transformingHistory
          : input?.plugin === "fail-tool"
            ? failingToolPlugin
            : Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    input?.mcp === "mutating" ? mutatingMcp : mcp,
    AppFileSystem.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    EventV2Bridge.defaultLayer,
    // [local-smark] goal 功能依赖 SessionGoal.Service
    SessionGoal.defaultLayer,
    // 仅计费行为测试启用真实服务，避免改变整份 prompt 测试的可选依赖边界。
    ...(input?.usage ? [SessionRequestUsage.defaultLayer] : []),
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(registryImageLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(imageLayer),
          Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(SessionRevert.defaultLayer),
      Layer.provide(imageLayer),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const race = testEffect(makeHttp({ processor: "blocking" }))
const accounting = testEffect(makeHttp({ usage: true }))
const unavailable = testEffect(makeHttp({ image: "unavailable" }))
const oneShotImage = testEffect(makeHttp({ image: "counting" }))
const mutatedImage = testEffect(makeHttp({ image: "counting", plugin: "mutate" }))
const failingTransform = testEffect(makeHttp({ plugin: "fail-transform" }))
const dynamicSurfaces = testEffect(makeHttp({ plugin: "transform-history", mcp: "mutating" }))
const observed = testEffect(makeHttp({ snapshot: "observe" }))
const observedProvider = testEffect(makeHttp({ snapshot: "observe", llm: "provider-executed" }))
const observedDenied = testEffect(makeHttp({ snapshot: "observe", plugin: "fail-tool" }))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

unavailable.instance(
  "persists an omission instead of an image when the resizer is unavailable",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const result = yield* Effect.exit(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
        }),
      )
      expect(Exit.isSuccess(result)).toBe(true)
      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      // omission 作为 synthetic 诊断落库；失败附件不可残留在任何 part 中或参与真实用户消息分类。
      expect(messages.flatMap((item) => item.parts).some((part) => part.type === "file")).toBe(false)
      const omission = messages.flatMap((item) => item.parts).find(
        (part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Image omitted"),
      )
      expect(omission?.synthetic).toBe(true)
    }),
  { git: true },
)

it.instance(
  "replaces a pixel-corrupt direct image with a persisted omission",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Malformed image" })
      const png = Buffer.from(tinyPng, "base64")
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
      // decoder 失败后只能留下 omission 文本，原始坏 data URL 不得进入持久化或后续 provider 请求。
      expect(parts.some((part) => part.type === "file")).toBe(false)
      const omission = parts.find(
        (part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Image omitted"),
      )
      expect(omission?.synthetic).toBe(true)
    }),
  { git: true },
)

it.instance(
  "decodes before reporting size when auto resize is disabled",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig((url) => ({
        ...providerCfg(url),
        attachment: { image: { auto_resize: false, max_base64_bytes: 1 } },
      }))
      const png = Buffer.from(tinyPng, "base64")
      const idat = png.indexOf(Buffer.from("IDAT"))
      png[idat + 4] ^= 0xff
      const result = yield* Effect.gen(function* () {
        const image = yield* Image.Service
        return yield* image
          .normalize({ id: PartID.ascending(), messageID: MessageID.ascending(),
            sessionID: SessionID.make("ses_decode_before_size"), type: "file", mime: "image/png",
            url: `data:image/png;base64,${png.toString("base64")}` })
          .pipe(Effect.exit)
      }).pipe(Effect.provide(Image.defaultLayer))

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        // metadata-only 顺序会先产生 SizeError；真实像素损坏必须拥有更早且更准确的 DecodeError。
        expect(Cause.squash(result.cause)).toBeInstanceOf(Image.DecodeError)
      }
      const gif = Buffer.from(twoFrameGif, "base64")
      gif[89] = 0
      const gifResult = yield* Effect.gen(function* () {
        const image = yield* Image.Service
        return yield* image
          .normalize({ id: PartID.ascending(), messageID: MessageID.ascending(),
            sessionID: SessionID.make("ses_all_pages_before_size"), type: "file", mime: "image/gif",
            url: `data:image/gif;base64,${gif.toString("base64")}` })
          .pipe(Effect.exit)
      }).pipe(Effect.provide(Image.defaultLayer))
      expect(Exit.isFailure(gifResult)).toBe(true)
      if (Exit.isFailure(gifResult)) {
        // auto_resize:false 也不能只验证首帧后返回 SizeError；后续帧损坏仍应先归属 DecodeError。
        expect(Cause.squash(gifResult.cause)).toBeInstanceOf(Image.DecodeError)
      }
    }),
  { git: true },
)

oneShotImage.instance(
  "normalizes a ReadTool image once and strips transient proof before persistence",
  () =>
    Effect.gen(function* () {
      imageNormalizations.length = 0
      const { dir } = yield* useServerConfig(providerCfg)
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
          { type: "file", mime: "text/plain", filename: "one-shot.png", url: pathToFileURL(target).href,
            source: { type: "file", path: target, text: { value: "@one-shot.png", start: 8, end: 21 } } },
        ],
      })
      const files = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((item) => item.parts)
        .filter((part): part is MessageV2.FilePart => part.type === "file" && part.mime.startsWith("image/"))
      // @image 的 Read producer 完成一次 normalize；Prompt final consumer 只消费匹配 proof，不重复调用 owner。
      // 该输入使用真实 file: reference 而非手工构造 proof，因此会经过 Registry 中的 ReadTool producer。
      // 最终持久化 file 仍保持图片 MIME，证明跳过的是重复 decode，而不是跳过整个附件处理。
      expect(imageNormalizations).toHaveLength(1)
      expect(files).toHaveLength(1)
      expect(Object.getOwnPropertySymbols(files[0] ?? {})).toHaveLength(0)
    }),
  { git: true },
)

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
          { type: "file", mime: "text/plain", filename: "plugin-image.png", url: pathToFileURL(target).href,
            source: { type: "file", path: target, text: { value: "@plugin-image.png", start: 0, end: 17 } } },
        ],
      })
      // ReadTool 先处理文件，真实 chat.message hook 改写后 final consumer 必须针对新 URL 再处理一次。
      // 第一次计数属于原文件；第二次必须精确绑定 hook 写入的新 data URL，不能只按 part identity 复用。
      // hook 返回后才消费 proof，锁定 plugin 边界顺序，防止未来把验证提前到插件之前。
      expect(imageNormalizations).toHaveLength(2)
      expect(imageNormalizations[1]).toBe("data:image/png;base64,AQ==")
      const files = (yield* MessageV2.filterCompactedEffect(chat.id))
        .flatMap((item) => item.parts)
        .filter((item): item is MessageV2.FilePart => item.type === "file")
      expect(files).toHaveLength(1)
      expect(Object.getOwnPropertySymbols(files[0] ?? {})).toHaveLength(0)
      yield* user(chat.id, `plugin-hidden-history ${"x".repeat(120_000)}`)
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "current" }] })
      yield* llm.text("reply")
      yield* prompt.loop({ sessionID: chat.id })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const assistant = messages.findLast((message) => message.info.role === "assistant")
      if (assistant?.info.role !== "assistant") throw new Error("Expected assistant snapshot")
      // persisted snapshot 与 wire 一起排除 plugin-hidden history，raw 120K 文本也不能触发 Compaction。
      expect([JSON.stringify((yield* llm.inputs)[0]?.messages).includes("plugin-hidden-history"), assistant.info.inputBreakdown?.messages.userText, messages.some((message) => message.info.summary)]).toEqual([false, "current".length, false])
    }),
  { git: true },
)

it.instance(
  "prepares malformed image attachments on direct tool completion",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const processors = yield* SessionProcessor.Service
      const providers = yield* ProviderSvc.Service
      const agents = yield* AgentSvc.Service
      const chat = yield* sessions.create({ title: "Direct completion" })
      const seeded = yield* seed(chat.id)
      const model = yield* providers.getModel(ref.providerID, ref.modelID)
      const direct = aiTool({ description: "direct completion probe", inputSchema: z.object({ path: z.string() }) })
      yield* llm.push(reply().pendingTool("direct", { path: "image.png" }).hang())
      const handle = yield* processors.create({ assistantMessage: seeded.assistant, sessionID: chat.id, model })
      const fiber = yield* handle.process({
        user: { ...seeded.user, role: "user" }, sessionID: chat.id, model, agent: yield* agents.get("build"),
        system: [], messages: [{ role: "user", content: "run direct completion" }], tools: { direct },
      }).pipe(Effect.forkChild)
      const pending = yield* pollWithTimeout(
        Effect.sync(() =>
          MessageV2.parts(seeded.assistant.id).find(
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "direct",
          ),
        ),
        "pending direct tool call was not published",
      )
      yield* handle.updateToolCall(pending.callID, (part) => ({ ...part, state: {
        status: "running", input: pending.state.input, time: { start: Date.now() },
      } }))
      yield* handle.completeToolCall(pending.callID, {
        title: "direct",
        metadata: {},
        output: "direct output",
        attachments: [{ id: PartID.ascending(), messageID: seeded.assistant.id, sessionID: chat.id,
          type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
      })
      const tool = MessageV2.parts(seeded.assistant.id).find(
        (item): item is MessageV2.ToolPart => item.type === "tool" && item.tool === "direct",
      )
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status !== "completed") return
      // direct completion 必须先运行统一准备边界；随后到达的普通 tool-result 不得把 omission 终态覆盖回原始附件。
      // hanging pending call 保持 ctx.toolcalls 可达，随后只使用公开 Handle API 模拟 abort adapter 的直达写入。
      // 断言 completed 而非 error，证明图片内容失败不会改变 Tool 本身成功完成的终态语义。
      // attachment 缺失与 omission 同时检查，避免实现只追加诊断文字却仍把坏 bytes 落库。
      expect(tool.state.output).toContain("image omitted")
      expect(tool.state.attachments).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }),
  { git: true },
)

it.instance(
  "publishes and persists the same prepared ordinary tool output",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const processors = yield* SessionProcessor.Service
      const providers = yield* ProviderSvc.Service
      const agents = yield* AgentSvc.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Prepared parity" })
      const seeded = yield* seed(chat.id)
      const model = yield* providers.getModel(ref.providerID, ref.modelID)
      const successes: unknown[] = []
      const unsubscribe = yield* events.sync((event) => {
        if (event.type === SessionEvent.Tool.Success.type) successes.push(event.data)
        return Effect.void
      })
      const ordinary = aiTool({ description: "ordinary image result", inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ title: "ordinary", metadata: {}, output: "ordinary output",
          attachments: [{ type: "file" as const, mime: "image/png", url: "data:image/png;base64,AA==" }] }),
      })
      yield* llm.push(reply().tool("ordinary", { path: "bad.png" }))
      const handle = yield* processors.create({ assistantMessage: seeded.assistant, sessionID: chat.id, model })
      yield* handle.process({ user: { ...seeded.user, role: "user" }, sessionID: chat.id, model,
        agent: yield* agents.get("build"), system: [], messages: [{ role: "user", content: "ordinary result" }],
        tools: { ordinary } })
      yield* unsubscribe
      const tool = MessageV2.parts(seeded.assistant.id).find(
        (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "ordinary",
      )
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status !== "completed") return
      const event = successes[0]
      expect(typeof event).toBe("object")
      if (typeof event !== "object" || event === null) return
      // EventV2 和 SQLite 必须消费同一 prepared snapshot：同一 omission 文本，且两边都不存在 file content。
      // 事件订阅发生在 process 前，捕获真实 SessionEvent.Tool.Success，而不是从数据库反推事件形状。
      // content 深相等锁定 omission 文案和附件过滤在 publish 前只执行一次，禁止双分支各自处理。
      // durable state 再断言 attachments 为空，防止事件安全但 SQLite 仍保存未经处理的原始 payload。
      expect(Reflect.get(event, "content")).toEqual([{ type: "text", text: tool.state.output }])
      expect(tool.state.attachments).toBeUndefined()
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

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<Config.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<Config.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped to
// "busy" inside Runner.startShell's modifyEffect at the same moment the runner
// is registered, so this is a deterministic readiness signal — cancel can't
// no-op once we observe it.
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

function concurrentToolReply(calls: Array<{ name: string; input: unknown }>) {
  const item = calls.reduce((value, call) => value.tool(call.name, call.input), reply()).item()
  if (item.type !== "sse") throw new Error("Expected SSE Tool reply")
  let index = -1
  // 每个Tool的参数delta必须沿用其start delta index，否则AI SDK会把后调用覆盖到index 0。
  for (const line of [...item.head, ...item.tail] as Array<{ choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; function?: { name?: string } }> } }> }>) {
    const call = line.choices?.[0]?.delta?.tool_calls?.[0]
    if (!call) continue
    if (call.function?.name) index++
    // TestLLM默认固定index=0；同一response的后续call必须拥有独立OpenAI stream index。
    // 这里只修fixture协议索引，不改变Tool参数、时序或production并发模型。
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
  const assistant: MessageV2.Assistant = {
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

const textTurn = Effect.fn("test.textTurn")(function* (sessionID: SessionID, input: string, output: string) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const userMessage = yield* user(sessionID, input)
  yield* llm.text(output)
  return { user: userMessage, result: yield* prompt.loop({ sessionID }) }
})

const lastProviderInput = Effect.fn("test.lastProviderInput")(function* () { return (yield* (yield* TestLLMServer).inputs).at(-1) })

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

it.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
  { git: true },
)

it.instance(
  "loop calls LLM and returns assistant message",
  () =>
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
  { git: true },
)

it.instance(
  "publishes the estimated Assistant as the first durable attempt state",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const updates: MessageV2.Assistant[] = []
      // Bus snapshot 是 TUI 实际消费面，不能只检查最终数据库状态。
      const dispose = yield* bus.subscribeAllCallback((event) => {
        if (event.type !== MessageV2.Event.Updated.type) return
        const info = (event.properties as { info?: MessageV2.Info }).info
        if (info?.role !== "assistant" || info.sessionID !== chat.id) return
        updates.push(structuredClone(info))
      })
      yield* Effect.addFinalizer(() => Effect.sync(dispose))

      yield* textTurn(chat.id, "estimate this request", "estimated")

      // 第一条公开 Assistant 快照就是 TUI 可见边界，不能先闪现构造期的全零对象。
      expect(updates[0]?.tokens.input).toBeGreaterThan(0)
      expect(updates[0]?.inputBreakdown?.messages.userText).toBeGreaterThan(0)
    }),
  { git: true },
)

failingTransform.instance(
  "persists one typed Assistant when pre-dispatch assembly fails",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "fail before dispatch")

      const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
      // transform defect 位于 estimate publication 前，Provider 绝不能收到请求。
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* llm.calls).toBe(0)
      const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
        (message) => message.info.role === "assistant",
      )
      expect(assistants).toHaveLength(1)
      const assistant = assistants[0]?.info
      // failure owner 复用 MessageV2 error 分类；不能为了移除零写而留下 dangling user。
      expect(assistant?.role === "assistant" ? assistant.error?.name : undefined).toBe("UnknownError")
      expect(assistant?.role === "assistant" ? assistant.time.completed : undefined).toBeNumber()
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
      // 第一次loop必须先形成full hit候选，删除前不能只测试cold rebuild。
      const removed = yield* textTurn(chat.id, "delete cached user", "delete cached assistant")
      // 真实cleanup写hidden mutation，不能依赖直接删除提供不同的proof形状。
      // revert先建立公开boundary，cleanup再执行production使用的hide流程。
      yield* revert.revert({ sessionID: chat.id, messageID: removed.user.id })
      yield* revert.cleanup(yield* sessions.get(chat.id))
      // replacement保证当前proof仍有合法suffix，cache不能因删除返回空窗口。
      const replacement = yield* textTurn(chat.id, "surviving replacement", "replacement")
      const body = JSON.stringify((yield* lastProviderInput())?.messages)
      // Provider body而非cache内部长度证明deleted rows没有被重播。
      expect(body).toContain("surviving replacement")
      expect(body).not.toContain("delete cached assistant")
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .find((message) => message.info.id === replacement.user.id)
        ?.parts.find((item): item is MessageV2.TextPart => item.type === "text")
      if (!part) throw new Error("Expected replacement text Part")
      // 同Message ID原位增长必须从mismatch inclusive重载，不能只比较ID前缀。
      yield* sessions.updatePart({ ...part, text: "grown part text" })
      yield* textTurn(chat.id, "continue after growth", "done")
      // 第二次mutation继续复用删除后的stable prefix，同时替换增长Message自身。
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
      // 三个动态producer在step1共享同一可观察版本，避免跨runLoop刷新伪通过。
      mcpMutationFile = path.join(dir, "unused-mcp.txt")
      yield* Effect.addFinalizer(() => Effect.sync(() => (mcpEnabled = true)))
      yield* textTurn(chat.id, "establish cache", "first")
      const gate = defer<void>()
      // Provider gate让queued user确定落在step 1已admit之后、step 2 proof之前。
      yield* user(chat.id, "start tool step")
      yield* llm.push(
        reply().wait(gate.promise).tool("read", { filePath: file }).item(),
        reply()
          // 跨平台写盘：单引号字面量在 POSIX sh 与 pwsh 下语义一致；bun 在测试进程
          // PATH 内（shortShellDelayCommand 先例）；Bun.write 接受正斜杠 Windows 路径，
          // 规避 printf 仅 POSIX 的平台分叉。
          .tool("bash", {
            command: `bun -e 'await Bun.write(${JSON.stringify(bashFile.replaceAll("\\", "/"))}, "allowed")'`,
            description: "fresh permission",
          })
          .item(),
        reply().text("after queue").stop().item(),
      )
      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(2)
      const firstTools = JSON.stringify((yield* lastProviderInput())?.tools)
      // step1 body固定变更前基线，后续“不含v1”断言才有独立expected value。
      expect(firstTools).toContain("dynamic tool v1")
      expect(firstTools).toContain("mcp_mutate")
      // 新user row只追加到canonical suffix，wrapper本身仍必须是request-only改写。
      // readiness来自真实HTTP call计数，不使用固定sleep制造时序。
      transformedHistoryText = "message transform v2"
      toolDefinitionVersion = "v2"
      mcpEnabled = false
      // 状态切换发生在同一runLoop尚未释放Provider gate时，不允许重建runLoop规避刷新。
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
      // reminder文案存在证明conversionDirty下移到queued Message，而非复用未包装chunk。
      expect(body).toContain("queued during provider call")
      expect(body).toContain("Please address this message and continue with your tasks.")
      expect(body).toContain("message transform v2")
      expect(body).not.toContain("message transform v1")
      expect(tools).toContain("dynamic tool v2")
      expect(tools).not.toContain("dynamic tool v1")
      expect(tools).not.toContain("mcp_mutate")
      // 文件落盘证明bash不仅重新出现在schema，还通过最新Permission进入真实implementation。
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
      // compaction.run写入真实marker/summary/tail boundary，不直接操纵cache entry。
      expect(yield* compaction.run({ sessionID: chat.id, agent: "build", model: ref, auto: true })).toBe("continue")
      // tools:false与新user一起落盘，但不应改变summary boundary的admission结果。
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        tools: { bash: false },
        parts: [{ type: "text", text: "after compaction" }],
      })
      yield* llm.text("final response")
      yield* prompt.loop({ sessionID: chat.id })
      // summary进入body证明boundary identity变化触发full window rebuild。
      expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("canonical compacted summary")
      // 同次warm请求的Tool开关证明Tool surface未进入Message cache。
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
      // build请求先让raw Tool Part进入retained history，decide随后必须重新sanitise。
      yield* llm.text("built")
      yield* prompt.loop({ sessionID: chat.id })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "decide",
        noReply: true,
        parts: [{ type: "text", text: "make the decision" }],
      })
      // decide mode强制tools为空，旧build Tool schema也不能从warm entry复现。
      yield* llm.text("decision")
      yield* prompt.loop({ sessionID: chat.id })
      const body = JSON.stringify((yield* llm.inputs).at(-1)?.messages)
      // synthetic tool-context证明decide走完整selected history conversion，而非普通cached chunk。
      expect(body).toContain("<tool-context tool=\\\"write\\\"")
      // 原AI tool role缺失防止unsanitized Tool protocol泄漏给decide模型。
      expect(body).not.toContain('"role":"tool"')
    }),
  { git: true },
)

it.instance(
  "reuses a 2048-turn prefix before Provider dispatch",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Large retained prefix" })
      yield* Effect.forEach(Array.from({ length: 2_048 }), () => seed(chat.id, { finish: "stop" }), {
        concurrency: 1,
        discard: true,
      })
      const providers = yield* ProviderSvc.Service
      const model = yield* providers.getModel(ref.providerID, ref.modelID)
      const history = yield* MessageV2.filterCompactedEffect(chat.id)
      const full = yield* MessageV2.toModelMessagesEffect(history, model)
      const chunks = yield* MessageV2.toModelMessageChunksEffect(history, model)
      // cache 只改变转换分块，不允许改变 Provider body 的 role/content/tool 顺序。
      // 2048 turns让等价断言覆盖真实大前缀，而非只验证两条text fixture。
      expect(chunks.flat()).toEqual(full)
      const shaped = structuredClone(history.slice(0, 2))
      // shaped history不写数据库，避免测试fixture本身改变2048-turn cache性能样本。
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
      // Tool completed/error、media与Compaction都必须保持full converter的literal形状。
      // 同一断言比较公开converter输出，不复制role/tool/media转换算法到expected value。
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
      // 因此阈值失败可定位整体pre-dispatch回归，而非微型helper benchmark波动。
      const warm = performance.now() - warmStarted

      // 阈值覆盖用户报告的约 1 秒准备窗口；相对断言证明命中而非单纯机器更快。
      expect(warm).toBeLessThan(cold)
      expect(warm).toBeLessThan(1_000)
      // 首次无新消息调用先admit刚完成的Assistant；第二次才是proof完全不变的exact full hit。
      yield* prompt.loop({ sessionID: chat.id })
      const hitStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      const fullHit = performance.now() - hitStarted
      const other = yield* sessions.create({ title: "Evict sole Message entry" })
      yield* seed(other.id, { finish: "stop" })
      yield* prompt.loop({ sessionID: other.id })
      // 另一Session只负责替换唯一entry，不修改原2048-turn proof或可见历史。
      const rebuildStarted = performance.now()
      yield* prompt.loop({ sessionID: chat.id })
      const rebuild = performance.now() - rebuildStarted
      // 切换Session只替换唯一entry；原Session未变，rebuild与full hit具有相同可见历史。
      // 两条路径均不dispatch Provider，时间差只来自admission/hydration/conversion。
      expect(fullHit).toBeLessThan(rebuild * 0.65 + 40)
      expect(yield* llm.calls).toBe(2)
    }),
  { git: true },
  120_000,
)

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
      expect(result.parts.some((p) => p.type === "text" && p.text === "image accepted")).toBe(true)
      expect(result.info.inputTokens).toBeLessThan(90_000)
      expect(result.info.inputBreakdown?.media?.tokens).toBe(1_600)
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
)

it.instance(
  "prompt emits v2 prompted and synthetic events",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
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
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { git: true },
)

it.instance(
  "v2 projection routes rollover compaction deltas to the chronologically newest row",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "v2 compaction rollover" })
      // 直接持久化回绕前旧 compaction 行：ID 字典序更高（evt_z 前缀）但 time_created 更早，
      // 复现回绕后旧行 ID 大于新事件 ascending ID 的持久形态。若 getCurrentCompaction 仍按
      // raw id DESC 排序，后续 delta/ended 会合入这旧行而不是新纪元行。
      Database.use((db) =>
        db
          .insert(SessionMessageTable)
          .values([
            {
              id: SessionMessage.ID.make("evt_z_old_compaction"),
              session_id: chat.id,
              type: "compaction",
              time_created: 1_000,
              time_updated: 1_000,
              data: { reason: "auto", summary: "old epoch summary", time: { created: 1_000 } } as NonNullable<
                (typeof SessionMessageTable.$inferInsert)["data"]
              >,
            },
          ])
          .run(),
      )

      // 真实 EventV2 发布第二轮 compaction；delta/ended 由 SQLite adapter 的
      // getCurrentCompaction 定位目标行，必须选中时间最新行而非字典序最大行。
      const events = yield* EventV2Bridge.Service
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID: chat.id,
        timestamp: DateTime.makeUnsafe(2_000),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID: chat.id,
        timestamp: DateTime.makeUnsafe(3_000),
        text: "partial ",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID: chat.id,
        timestamp: DateTime.makeUnsafe(4_000),
        text: "new epoch summary",
      })

      const rows = Database.use((db) =>
        db
          .select({ id: SessionMessageTable.id, time: SessionMessageTable.time_created, data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(Database.and(Database.eq(SessionMessageTable.session_id, chat.id), Database.eq(SessionMessageTable.type, "compaction")))
          .orderBy(SessionMessageTable.time_created)
          .all(),
      )
      expect(rows).toHaveLength(2)
      // 行数断言锁住“新轮建新行”而非“合入旧行”：两条 compaction 必须同时存在。
      // 旧行必须保持原样：delta/ended 不得合入回绕前的字典序最大行。
      expect((rows[0]?.data as { summary?: string }).summary).toBe("old epoch summary")
      expect(String(rows[0]?.id)).toBe("evt_z_old_compaction")
      // 新行由 started 创建并承载新一轮 summary。
      expect((rows[1]?.data as { summary?: string }).summary).toBe("new epoch summary")

      // V2Session.context 的 compaction 边界也必须选中时间最新行；
      // context 本身已是 tuple 查询，此断言锁定两个 owner 不再分叉。
      const context = yield* SessionV2.Service.use((svc) => svc.context(chat.id)).pipe(
        Effect.provide(SessionV2.layer),
      )
      const compaction = context.filter((message) => message.type === "compaction").at(-1)
      expect(compaction).toMatchObject({ type: "compaction", summary: "new epoch summary" })
    }),
)

it.instance(
  "static loop returns assistant text through local provider",
  () =>
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
  { git: true },
)

it.instance(
  "static loop consumes queued replies across turns",
  () =>
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
  { git: true },
)

it.instance(
  "loop continues when finish is tool-calls",
  () =>
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
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
  { git: true },
)

it.instance(
  "glob tool keeps instance context during prompt runs",
  () =>
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

      const result = yield* prompt.loop({ sessionID: session.id })
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

      // 行为断言读取真实 daemon log：必须能串起 processor/tool timing，
      // 同时确认诊断日志没有泄漏工具输入 pattern 或工具输出路径。
      const timing = yield* pollWithTimeout(
        Effect.promise(() => Bun.file(Log.file()).text().catch(() => "")).pipe(
          Effect.map((content) => {
            const lines = content.split("\n").filter((line) => line.includes(`sessionID=${session.id}`) && line.includes(" timing"))
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
  { git: true },
  10_000,
)

it.instance(
  "loop continues when finish is stop but assistant has tool parts",
  () =>
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
  { git: true },
)

it.instance(
  "auto permission reviewer persists real reasoning and decision tool parts",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer stream" })
      const command = String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa"`
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

      yield* permissions
        .ask({
          sessionID: chat.id,
          permission: "bash",
          patterns: [command],
          metadata: { command, agent: "auto" },
          always: ["*"],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        })
        .pipe(Effect.flip)

      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const msgs = yield* MessageV2.filterCompactedEffect(reviewer.id)
      const inputs = yield* llm.inputs
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
      expect(inputs[0].max_tokens).toBe(10000)
      const requestPart = msgs
        .flatMap((msg) => msg.parts)
        .find((part): part is MessageV2.TextPart => part.type === "text" && part.metadata?.permissionReviewerRequest === true)
      const requestID = requestPart?.metadata?.reviewID
      // The parent tool already stores the same review id; mirroring it into the
      // reviewer child transcript is the observable audit link that lets future
      // UI/export code identify the exact request without parsing prompt text.
      expect(typeof requestID).toBe("string")
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true),
        ),
      ).toBe(true)
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "reasoning" && part.text.includes("explicitly authorized")),
        ),
      ).toBe(true)
      expect(
        msgs.some((msg) =>
          msg.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "permission_review_decision" &&
              part.state.status === "completed" &&
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
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      expect(yield* llm.calls).toBe(1)
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

it.instance(
  "auto permission reviewer hides malformed protocol attempts before retrying",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer protocol retry" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      const malformed = "I can allow this request, but I forgot to submit the decision tool."
      yield* llm.push(
        reply().text(malformed).stop().item(),
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
      expect(
        visible.flatMap((msg) => msg.parts).filter((part) => part.type === "text" && part.metadata?.permissionReviewerRequest === true),
      ).toHaveLength(1)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes(malformed)))).toBe(false)
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
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { auto_review: { fallback: "deny" } },
      }))
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer protocol retry failure" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      // reviewer 最多 3 次尝试（1 初始 + 2 重试），每次都输出 prose 而非 tool call
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
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.AutoDeniedError)
      // 3 次尝试全部协议错误后 fail closed
      expect(yield* llm.calls).toBe(3)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const visible = yield* MessageV2.filterCompactedEffect(reviewer.id)
      // 第一次尝试被隐藏（hideProtocolFailure=true），后续可见
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

it.instance(
  "auto permission reviewer retries transient provider failures before recording the decision",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer retry" })
      const command = "cat ~/.ssh/id_rsa"
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

it.instance(
  "auto permission reviewer retries on timeout before falling back to user",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        // 极短超时使 hang 快速触发，验证超时后重试而非直接 unavailable
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
      // 被超时中断的 assistant 消息应有终态（error + completed），不悬挂
      const msgs = yield* MessageV2.page({ sessionID: reviewer.id, limit: 20, includeHidden: true })
      const assistants = msgs.items.filter((m) => m.info.role === "assistant")
      expect(assistants.length).toBeGreaterThanOrEqual(2)
      // page 返回联合类型，需要断言为 Assistant 才能访问 time.completed / error
      const interrupted = assistants[0].info as MessageV2.Assistant
      expect(interrupted.time.completed).toBeDefined()
      expect(interrupted.error).toBeDefined()
    }),
  { git: true },
  30_000,
)

it.instance(
  "auto permission reviewer extracts JSON from prose-prefixed text",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer JSON extraction" })
      const command = String.raw`rsync -av "/Volumes/My Passport/Calibration/" Sensetimex4:~/project/Calibration/`
      // 模型在 JSON 前附加 prose，旧实现只接受纯 JSON 会失败；修复后应提取第一个 {...} 块
      yield* llm.push(
        reply()
          .text(
            `Based on my analysis:\n${JSON.stringify({
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
      // prose 前缀的 JSON 被提取并接受为 json_fallback 决策
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

it.instance(
  "shell auto review metadata survives live output updates and completion",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { approvals_reviewer: "auto_review" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const test = yield* TestInstance
      const chat = yield* sessions.create({
        title: "Shell review metadata",
        permission: [
          { permission: "bash", pattern: "*", action: "auto" },
        ],
      })
      // 本用例只需要触发 SSH 私钥名的 cautious 预审并产生 shell 输出；
      // 使用项目内文件避免 Windows runner 上家目录路径和缺失文件错误拖慢到 15s 超时边界。
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "id_rsa"), "review-output\n"))
      const command = "cat id_rsa"
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
        .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "bash")
      expect(shell?.state.status).toBe("completed")
      if (shell?.state.status !== "completed") return
      // Shell streams overwrite its own output preview metadata repeatedly; the
      // review envelope must survive those updates so the final card still links
      // back to the reviewer child session instead of silently losing audit state.
      expect(shell.state.metadata?.output).toBeDefined()
      expect(shell.state.metadata?.autoReview?.status).toBe("allowed")
      expect(shell.state.metadata?.autoReview?.result?.rationale).toBe("user explicitly asked for this key read")
      const reviewID = shell.state.metadata?.autoReview?.reviewID
      expect(typeof reviewID).toBe("string")

      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const reviewerParts = (yield* MessageV2.filterCompactedEffect(reviewer.id)).flatMap((msg) => msg.parts)
      // This asserts the full parent-tool-to-child-transcript join, not just the
      // child transcript's internal consistency. One reviewer child session can
      // contain many review turns, so every persisted request/decision turn needs
      // the exact parent autoReview.reviewID for unambiguous audit navigation.
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

it.instance(
  "auto agent tool permission requests carry auto agent evidence before approval",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
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
        permission: { approvals_reviewer: "auto_review" },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const gate = defer<void>()
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

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const reviewing = yield* pollWithTimeout(
        Effect.gen(function* () {
          const part = (yield* MessageV2.filterCompactedEffect(chat.id))
            .flatMap((msg) => msg.parts)
            .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "bash")
          if (part?.state.status === "running" && part.state.metadata?.autoReview?.status === "reviewing") return part
        }),
        "shell auto review never started",
        reviewPollBudget,
      )
      const reviewID = reviewing.state.status === "running" ? reviewing.state.metadata?.autoReview?.reviewID : undefined
      expect(typeof reviewID).toBe("string")
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
            (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              msg.info.role === "assistant" && !msg.info.time.completed,
          )
        }),
        "reviewer child assistant never started",
        reviewPollBudget,
      )

      yield* prompt.cancel(chat.id)
      gate.resolve()
      yield* awaitWithTimeout(Fiber.await(fiber), "session did not stop after review cancel", reviewPollBudget).pipe(Effect.ignore)

      const shell = yield* pollWithTimeout(
        Effect.gen(function* () {
          const part = (yield* MessageV2.filterCompactedEffect(chat.id))
            .flatMap((msg) => msg.parts)
            .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "bash")
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
      expect(shell.state.error).toBe("Tool execution aborted")
      expect(shell.state.metadata?.interrupted).toBe(true)
      expect(shell.state.metadata?.autoReview?.status).toBe("aborted")
      expect(shell.state.metadata?.autoReview?.error).toBe("Tool execution aborted")

      const reviewerMessages = yield* pollWithTimeout(
        Effect.gen(function* () {
          const messages = yield* MessageV2.filterCompactedEffect(reviewer.id)
          const assistants = messages.filter(
            (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => msg.info.role === "assistant",
          )
          return assistants.every((msg) => msg.info.time.completed) ? messages : undefined
        }),
        "reviewer child assistant remained active after cancellation",
        reviewPollBudget,
      )
      const reviewerParts = reviewerMessages.flatMap((msg) => msg.parts)
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.reviewID === reviewID,
        ),
      ).toBe(false)
      expect(
        reviewerParts.some((part) => part.type === "tool" && part.tool === "bash"),
      ).toBe(false)
    }),
  { git: true },
  // 注册硬顶与体内 reviewPollBudget 保持连贯（内层严格小于外层，两平台均成立）。
  heavyLoopBudget,
)

it.instance(
  "failed subtask preserves metadata on error tool state",
  () =>
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
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
  { git: true },
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
          const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
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
  { git: true },
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
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
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
  { git: true },
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
  { git: true },
  shortSessionTimeout,
)

// Cancel semantics

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
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
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  { git: true },
  shortSessionTimeout,
)

it.instance(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
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
  { git: true },
  shortSessionTimeout,
)

race.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
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
  { git: true },
  shortSessionTimeout,
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
      yield* prompt.cancel(chat.id).pipe(Effect.forkChild)

      // 立即提交新命令——在 cancel 的 abortPendingAssistants 执行前
      yield* llm.push(reply().text("second response").stop().item())
      yield* user(chat.id, "second")
      const fiber2 = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // 等待第二个 loop 完成
      const exit2 = yield* Fiber.await(fiber2).pipe(Effect.timeout("10 seconds"))
      expect(Exit.isSuccess(exit2 ?? Exit.void)).toBe(true)

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

      // 清理第一个 fiber
      yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"), Effect.ignore)
    }),
  { git: true },
  30_000,
)

// [local-smark] 验证重叠 cancel 共享同一个操作：第二个 cancel join 第一个的
// Deferred，不会在第一个完成后重新执行 state.cancel 误伤 replacement loop。
// 旧 semaphore 实现下，第二个 cancel 排队等待第一个完成，然后重新调用
// state.cancel 取消已经启动的 replacement Runner。single-flight 修复后，
// 两个 cancel 共享同一 Exit，replacement 安全。
// 使用 task 工具挂起控制 cancel 耗时：task.execute 用 Effect.callback 永不 resume，
// cancel 的 Fiber.interrupt 等待 Processor cleanup 的 2s settle 超时，
// 这段时间内第二个 cancel 能 join 第一个的 Deferred。
it.instance(
  "overlapping cancels share single-flight and do not retarget replacement loop",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const chat = yield* sessions.create({ title: "Overlap cancel" })
      yield* seed(chat.id)

      // 修改 task.execute 使其永不返回（Effect.callback 不调用 resume），
      // cancel 时 Processor cleanup 需等待 2s settle 超时才能终态化。
      const taskReady = yield* Deferred.make<void>()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          succeedVoid(taskReady)
          return Effect.sync(() => {})
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      // 让 LLM 正常回复（不含工具调用），然后用 addSubtask 触发 task 工具
      yield* llm.push(reply().text("thinking").stop().item())
      yield* llm.hang
      const msg = yield* user(chat.id, "first")
      yield* addSubtask(chat.id, msg.id)
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // 等待 task 工具开始执行
      yield* awaitWithTimeout(Deferred.await(taskReady), "task tool never started", "10 seconds")

      // Fork 第一个 cancel——task 工具永不返回，Fiber.interrupt 需等待 2s settle
      yield* prompt.cancel(chat.id).pipe(Effect.forkChild)

      // 等待 session 变 idle（Runner.cancel 已执行 idleIfCurrent，Fiber.interrupt 仍在进行）
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = yield* status.get(chat.id)
          return s.type === "idle" ? (true as const) : undefined
        }),
        "session never became idle after first cancel",
      )

      // 立即提交 replacement 和第二个 cancel
      yield* llm.push(reply().text("replacement response").stop().item())
      yield* user(chat.id, "second")
      const fiber2 = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      // 第二个 cancel——single-flight 下 join 第一个的 Deferred，不重新执行 state.cancel
      yield* prompt.cancel(chat.id).pipe(Effect.forkChild)

      // 等待 replacement loop 完成
      const exit2 = yield* Fiber.await(fiber2).pipe(Effect.timeout("15 seconds"))
      expect(Exit.isSuccess(exit2 ?? Exit.void)).toBe(true)

      // 关键断言：replacement assistant 不应有 AbortedError
      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      const assistants = messages.filter((m) => m.info.role === "assistant")
      const lastAssistant = assistants.at(-1)
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.error?.name).not.toBe("MessageAbortedError")
      }

      // 清理
      yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"), Effect.ignore)
    }),
  { git: true },
  60_000,
)

it.instance(
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
  { git: true, config: cfg },
  30_000,
)

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

      yield* prompt.cancel(chat.id)

      const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: assistant.id })
      const tools = stored.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(stored.info.role).toBe("assistant")
      if (stored.info.role !== "assistant") return
      expect(stored.info.time.completed).toBeNumber()
      expect(stored.info.error?.name).toBe("MessageAbortedError")
      expect(tools).toHaveLength(2)
      for (const tool of tools) {
        expect(tool.state.status).toBe("error")
        if (tool.state.status !== "error") continue
        expect(tool.state.error).toBe("Tool execution aborted")
        expect(tool.state.metadata?.interrupted).toBe(true)
        expect(tool.state.time.end).toBeGreaterThanOrEqual(tool.state.time.start)
      }
    }),
  { git: true },
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

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  { git: true },
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
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

      // T 的 join、busy 与 cancel 必须命中 D 的同一 Runner，不能按目录再建控制面。
      expect(Exit.isFailure(yield* run.assertNotBusy(chat.id).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
      yield* prompt.cancel(chat.id).pipe(Effect.provideService(InstanceRef, target))
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

it.instance(
  "concurrent loop callers get same result",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const offset = lspDirectories.length
      yield* seed(chat.id, { finish: "stop" })

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })

      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
      // 两个并发 caller 共享一个 Running work；若 admission 也推进 generation，
      // 同一次真实 agent run 会错误触发两次 LSP ownership refresh。
      expect(lspDirectories.slice(offset)).toHaveLength(1)
      yield* prompt.loop({ sessionID: chat.id })
      expect(lspDirectories.slice(offset)).toHaveLength(2)
      yield* run.assertNotBusy(chat.id)
    }),
  { git: true },
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      // 这里只断言并发loop共享结果；包级timeout仅防进程挂死，不构成3秒性能契约。
      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  { git: true },
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
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
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
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
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  { git: true },
  shortSessionTimeout,
)

accounting.instance(
  "coalesced queued prompt reaches a zero-cost terminal usage state",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const usage = yield* SessionRequestUsage.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      // 第一条Provider回复保持未完成，使后续两个prompt都落在同一个活跃Run state内。
      // 第二条回复只服务最大MessageID对应的user，用来验证既有coalescing语义。
      yield* llm.hold("first reply", deferredAsPromise(gate))
      yield* llm.text("latest reply")

      const first = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      // caller-supplied ID 故意让较早 middle 的字典序高于较新的 latest，复现回绕后 raw-ID 判断失效。
      // 两条 user Message 仍按真实写入时间形成 chronology，只有 latest 允许成为最终 assistant parent。
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
      const latest = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: latestID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "latest queued intent" }],
        })
        .pipe(Effect.forkChild)
      // 释放首轮前先观察两条消息都已落库，避免把调度偶然性误当成queue行为。
      // 这里走Session公共读取接口，不窥探Runner内部pending结构。
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) =>
              messages.some((message) => message.info.id === middleID) &&
              messages.some((message) => message.info.id === latestID)
                ? true
                : undefined,
            ),
          ),
        "queued prompts were not both persisted",
      )

      // gate释放后，同一runLoop应先完成first，再把middle/latest合并到下一次Provider输入。
      // 三个caller都等待该Run state的最终结果，因此完成后再读取usage不会观察到中间态。
      yield* Deferred.succeed(gate, undefined)
      const [, middleExit, latestExit] = yield* Effect.all([
        Fiber.await(first),
        Fiber.await(middle),
        Fiber.await(latest),
      ])
      const middleUsage = yield* usage.get({ sessionID: chat.id, requestID: middleID })
      const latestUsage = yield* usage.get({ sessionID: chat.id, requestID: latestID })

      // 较早 queued request 已进入同一次模型输入，但没有独立 assistant，必须零计费终态化。
      expect(middleUsage?.status).toBe("completed")
      expect(middleUsage?.assistantCount).toBe(0)
      expect(middleUsage?.tokens.total).toBe(0)
      // 最新 user 是唯一 parent；两个 caller共享这次真实回复，不能重复记录 assistant 费用。
      expect(Exit.isSuccess(middleExit)).toBe(true)
      expect(Exit.isSuccess(latestExit)).toBe(true)
      if (Exit.isSuccess(middleExit) && middleExit.value.info.role === "assistant") {
        expect(middleExit.value.info.parentID).toBe(latestID)
      }
      if (Exit.isSuccess(latestExit) && latestExit.value.info.role === "assistant") {
        expect(latestExit.value.info.parentID).toBe(latestID)
      }
      expect(latestUsage?.status).toBe("completed")
      expect(latestUsage?.assistantCount).toBe(1)
      expect(yield* llm.calls).toBe(2)
    }),
  { git: true },
  shortSessionTimeout,
)

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
      // active revert 必须先由 compact 的 exclusive cleanup 消费，queued user不能被旧边界再次隐藏。
      // 这同时验证HTTP层移除重复cleanup后，领域边界仍完整承担Revert清理职责。
      yield* sessions.setRevert({
        sessionID: chat.id,
        revert: { messageID: history.id },
        summary: { additions: 0, deletions: 0, files: 0 },
      })

      // summary 保持流式未完成，确保后续 prompt 确实在 manual compact 持有 Run state 时提交。
      // queued reply预先入队；只有原子handoff成功时它才会成为第二次Provider调用。
      yield* llm.hold("summary", deferredAsPromise(gate))
      yield* llm.text("queued reply")
      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      // exclusive maintenance必须阻止explicit revert并发修改同一Session，但普通prompt仍可继续排队。
      const revertExit = yield* run.beginRevert(chat.id).pipe(Effect.exit)
      if (Exit.isSuccess(revertExit)) yield* run.endRevert(chat.id)
      expect(Exit.isFailure(revertExit)).toBe(true)

      // 固定queuedID后再fork prompt，最终assistant必须显式绑定该ID而不是compaction marker。
      // prompt持久化发生在loop前，正是用户在TUI中看到QUEUED的真实生产顺序。
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

      // summary完成会结束maintenance caller，但ShellThenRun必须无Idle空窗地接管queued caller。
      // 同时等待两个fiber，可以区分各自返回值并证明它们没有误共享summary结果。
      yield* Deferred.succeed(gate, undefined)
      const [compactExit, queuedExit] = yield* Effect.all([Fiber.await(compact), Fiber.await(queued)])

      // compact caller保持原有summary结果；queued caller必须得到独立普通assistant，而不是误复用summary。
      expect(Exit.isSuccess(compactExit)).toBe(true)
      expect(Exit.isSuccess(queuedExit)).toBe(true)
      if (Exit.isSuccess(compactExit) && compactExit.value.info.role === "assistant") {
        expect(compactExit.value.info.summary).toBe(true)
      }
      if (Exit.isSuccess(queuedExit) && queuedExit.value.info.role === "assistant") {
        expect(queuedExit.value.info.summary).not.toBe(true)
        expect(queuedExit.value.info.parentID).toBe(queuedID)
        expect(queuedExit.value.parts.some((part) => part.type === "text" && part.text === "queued reply")).toBe(true)
      }
      // 可见消息断言保护active revert场景，确保陈旧cleanup不会把handoff后的user重新隐藏。
      // 两次Provider调用与最终Idle共同证明续跑只发生一次且Run state已完整释放。
      const visible = yield* sessions.messages({ sessionID: chat.id })
      expect(visible.some((message) => message.info.id === queuedID)).toBe(true)
      expect(yield* llm.calls).toBe(2)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

accounting.instance(
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

      // 先记录Provider命中再延迟400响应，使queued prompt确定落在失败中的maintenance边界内。
      yield* llm.push(
        httpError(400, { error: { message: "summary rejected" } }, deferredAsPromise(gate)),
      )
      yield* llm.text("reply after failed summary")
      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // 固定ID同时建立assistant归属与RequestUsage主键，避免只凭返回文本判断handoff。
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

      // Provider错误只结束summary请求；Runner finalizer仍须无Idle空窗地启动queued run。
      yield* Deferred.succeed(gate, undefined)
      const [compactExit, queuedExit] = yield* Effect.all([Fiber.await(compact), Fiber.await(queued)])
      const request = yield* usage.get({ sessionID: chat.id, requestID: queuedID })

      // compact caller保留原始错误summary，queued caller不能误共享它或永久停留running。
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
      expect(request?.assistantCount).toBe(1)
      // 两次Provider调用且最终Idle排除错误重试、重复handoff和悬挂Runner三类回归。
      expect(yield* llm.calls).toBe(2)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

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

      // create只建立真实compaction marker，后续手工插入顺序用于确定性覆盖极窄竞态。
      // 该测试不依赖wall-clock延迟，因此在慢CI上也能稳定复现旧ID判断缺陷。
      const marker = yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      // real user 在 marker 后、summary 前落库；单看 ID 会误以为后创建的 summary 已回答它。
      // user并非summary的parent，所以即使summary完成也仍需要一次普通Agent回复。
      const queued = yield* user(chat.id, "still needs an answer")
      const summaryID = MessageID.ascending()
      // finished summary模拟Compaction成功边界；parent固定为marker以保留真实持久化关系。
      // summary文本只证明维护结果存在，不能被当作queued user的业务回答。
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
      yield* llm.text("handled after summary")

      // 公共loop应读取持久化关系并产生普通assistant，而不是直接返回ID更大的summary。
      // Provider调用次数为1，排除测试构造意外触发第二次Compaction的可能。
      const result = yield* prompt.loop({ sessionID: chat.id })

      // parentID 是回答归属的结构事实；消息创建顺序不能替代这个关系。
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(queued.id)
      expect(result.parts.some((part) => part.type === "text" && part.text === "handled after summary")).toBe(true)
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  shortSessionTimeout,
)

it.instance(
  "manual compact rejects while explicit revert owns the session",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* user(chat.id, "history")

      // beginRevert模拟已取得文件/消息修改权；compact必须在任何marker副作用前原子失败。
      const exit = yield* Effect.acquireUseRelease(
        run.beginRevert(chat.id),
        () => prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.exit),
        () => run.endRevert(chat.id),
      )
      const messages = yield* sessions.messages({ sessionID: chat.id })

      // 与前一用例的反向检查组合，证明revert/exclusive无论谁先取得所有权都只有一个winner。
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      // Busy拒绝不能留下scratch compaction，否则后续普通loop可能重放无主维护命令。
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    }),
  { git: true },
)

accounting.instance(
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
      // 未释放gate让summary持续streaming，确保cancel发生在maintenance仍占有Run state时。
      // 不预置第二条Provider回复，可直接证明cancel没有错误启动pending run。
      yield* llm.hold("unfinished summary", deferredAsPromise(gate))

      const compact = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // queued prompt先完成持久化和RequestUsage.begin，随后才会等待ShellThenRun的Deferred。
      // 因此cancel必须同时处理消息执行权和没有assistant child的running usage。
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
      // 让 queued caller 进入 Run state；取消必须同时终止 maintenance 与尚未启动的 pending run。
      // yieldNow只让出协作式调度，不依赖任意毫秒延迟或机器速度。
      yield* Effect.yieldNow
      yield* prompt.cancel(chat.id)

      // 两个caller都必须在既有超时边界内终止；任一悬挂都表示Deferred没有被完整结算。
      // cancel返回后再读取Session，可确保hideIncomplete finalizer已经执行完毕。
      yield* Effect.all([
        awaitWithTimeout(Fiber.await(compact), "manual compact did not stop after cancel"),
        awaitWithTimeout(Fiber.await(queued), "queued prompt did not stop after cancel"),
      ])
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const request = yield* usage.get({ sessionID: chat.id, requestID: queuedID })

      // cancel 是明确终止边界：不启动第二次LLM，也不留下可见scratch compaction或running usage。
      // aborted而非completed保留用户主动终止的语义，同时零assistant计费保持不变。
      expect(yield* llm.calls).toBe(1)
      expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
      expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
      expect(request?.status).toBe("aborted")
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

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
      // 只准备一条summary响应；若实现无条件续跑，测试服务器会暴露额外Provider调用。
      // Pinned标题避免后台title请求干扰对Compaction调用次数的判断。
      yield* llm.text("summary only")

      const result = yield* prompt.compact({ sessionID: chat.id, agent: "build", model: ref })

      // manual compact 仍是维护终点；没有 queued loop 时不能恢复 retained tail 或 Goal。
      // summary返回值和Idle状态共同锁定旧调用合同，避免handoff修复改变普通compact体验。
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.summary).toBe(true)
      expect(result.parts.some((part) => part.type === "text" && part.text === "summary only")).toBe(true)
      expect(yield* llm.calls).toBe(1)
      expect((yield* sessionStatus.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  shortSessionTimeout,
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
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

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  { git: true },
  shortSessionTimeout,
)

it.instance(
  "assertNotBusy succeeds when idle",
  () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service

      const chat = yield* sessions.create({})
      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  { git: true },
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
  shortSessionTimeout,
)

// Shell semantics

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
      // bash是ambient；hook拒绝后仍应留下policy marker而无文件副作用。
      yield* user(chat.id, "reject before implementation")
      yield* llm.tool("bash", { command: `printf rejected > ${JSON.stringify(file)}`, description: "reject" })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: chat.id })
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .find((item): item is MessageV2.ToolPart => item.type === "tool" && item.tool === "bash")
      expect(snapshotTracks.get(dir)).toBe(2)
      // before+after各一次证明capture位于hook前，error step仍完成Snapshot边界。
      // 文件不存在则证明被拒Tool没有在baseline之后越过hook执行实现。
      expect(part?.state.status).toBe("error")
      // error replacement不能擦除prepare阶段写入的top-level authority。
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
      // providerExecuted stream没有local execute callback，任何track都属于错误归因。
      yield* user(chat.id, "provider executes remotely")
      yield* prompt.loop({ sessionID: chat.id })
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .find((item): item is MessageV2.ToolPart => item.type === "tool")
      expect(snapshotTracks.get(dir) ?? 0).toBe(0)
      // provider marker保留用于展示，但不得被映射成ambient或declared。
      // worktree缺失还保护Revert不会把远端Tool当成本地文件owner。
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
      // Read经过真实local adapter和terminal lifecycle，0计数不能由“没有Tool”偶然满足。
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
        .filter((part): part is MessageV2.ToolPart => part.type === "tool").map((part) => part.metadata?.worktree).sort()
      // 首轮并发共享before/after；新Assistant续轮建立另一组，重复capture会使总数超过4。
      expect(snapshotTracks.get(dir)).toBe(4)
      expect(policies).toEqual(["ambient", "ambient", "declared"])

      const chat = yield* sessions.create({ title: "Revert authority" })
      const turn = yield* seed(chat.id, { finish: "stop" })
      const before = yield* snapshots.track()
      // baseline早于两个文件写入，使一个Patch同时覆盖declared和none候选。
      if (!before) throw new Error("Expected Snapshot baseline")
      const noneFile = path.join(dir, "none-owned.txt")
      const declaredFile = path.join(dir, "declared-owned.txt")
      yield* Effect.promise(() => Promise.all([Bun.write(noneFile, "none"), Bun.write(declaredFile, "declared")]))
      const patch = yield* snapshots.patch(before)
      // result metadata形状刻意相同，唯一authority差异是top-level policy。
      const completed = (filepath: string) => ({
        status: "completed" as const,
        input: {},
        output: "done",
        title: path.basename(filepath),
        metadata: { filepath, diff: "changed" },
        time: { start: 0, end: 1 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "custom_none", callID: "none", state: completed(noneFile),
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "edit", callID: "declared", metadata: { worktree: "declared" }, state: completed(declaredFile),
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: turn.assistant.id, sessionID: chat.id, type: "patch",
        hash: patch.hash, files: patch.files,
      })
      const ambientTurn = yield* seed(chat.id, { finish: "stop" })
      // 第二Assistant修改同一none文件，专门复现range级全局Set的反向授权缺陷。
      const ambientBefore = yield* snapshots.track()
      if (!ambientBefore) throw new Error("Expected ambient baseline")
      yield* Effect.promise(() => Bun.write(noneFile, "ambient"))
      const ambientPatch = yield* snapshots.patch(ambientBefore)
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: ambientTurn.assistant.id, sessionID: chat.id, type: "tool",
        tool: "bash", callID: "ambient", metadata: { worktree: "ambient" }, state: completed(noneFile),
      })
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: ambientTurn.assistant.id, sessionID: chat.id, type: "patch",
        hash: ambientPatch.hash, files: ambientPatch.files,
      })

      yield* revert.revert({ sessionID: chat.id, messageID: turn.user.id })
      // 后Assistant的ambient只能恢复到none写入后的状态，不能反向授权更早Patch。
      expect(yield* Effect.promise(() => Bun.file(noneFile).text())).toBe("none")
      // declared文件撤回证明修复没有关闭既有精确归因路径。
      expect(yield* Effect.promise(() => Bun.file(declaredFile).exists())).toBe(false)
    }),
  { git: true },
  // 该用例含 3 个会话多轮 loop + git snapshot/revert，是最重用例；平台化预算给足余量。
  snapshotMatrixBudget,
)

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  { git: true },
  shortSessionTimeout,
)

unix(
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
      // 有输出时用户面板仍是 raw 终端正文，不得混入 opencode_notice
      expect(tool.state.metadata.output).not.toContain("opencode_notice")
      yield* run.assertNotBusy(chat.id)
    }),
  { git: true, config: cfg },
)

unix(
  "shell empty success keeps user panel placeholder without model harness",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      // true 无 stdout/stderr，验证空用户面板必须是 (no output) 而不是空白
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
  { git: true, config: cfg },
)

it.instance(
  "coalesces direct shell progress without changing final output",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const bus = yield* Bus.Service
      const durable: MessageV2.ToolPart[] = []
      const live: MessageV2.ToolPart[] = []
      const dispose = yield* bus.subscribeAllCallback((event) => {
        if (event.type !== MessageV2.Event.PartUpdated.type && event.type !== "message.part.progress") return
        const part = (event.properties as { part?: MessageV2.Part }).part
        if (part?.type !== "tool" || part.sessionID !== chat.id || part.tool !== "bash") return
        if (event.type === MessageV2.Event.PartUpdated.type) durable.push(structuredClone(part))
        else live.push(structuredClone(part))
      })
      yield* Effect.addFinalizer(() => Effect.sync(dispose))

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
      // 最后的 literal 检查保证 cadence 优化没有把 direct shell 的累积输出换成 TerminalDisplay。
      // 只有 running Part 属于重连 checkpoint 预算；completed 是权威终态，不能
      // 为了满足上限而从统计或生产路径中删除。
      const running = durable.filter((part) => part.state.status === "running")
      const tool = completedTool(result.parts)
      expect(running.length).toBeLessThanOrEqual(3)
      expect(running[0]?.state.status === "running" ? running[0].state.metadata?.progressVersion : undefined).toBe(0)
      expect(live.some((part) => part.state.status === "running")).toBe(true)
      expect(tool?.state.output).toContain("DIRECT_PROGRESS_1")
      expect(tool?.state.output).toContain("DIRECT_PROGRESS_40")
    }),
  { git: true, config: cfg },
  30_000,
)

unix(
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
  { git: true, config: cfg },
)

unix(
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
  { git: true, config: { ...cfg, shell: "bash" } },
  30_000,
)

unix(
  "shell commands can change directory after startup",
  () =>
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
  { git: true, config: cfg },
)

unix(
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
  { git: true, config: cfg },
)

unix(
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
  { git: true, config: cfg },
)

unix(
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
  { git: true, config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const target = yield* tmpdirScoped({ git: true })
      yield* writeConfig(target, providerCfg(llm.url))
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: shortShellDelayCommand() })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const offset = lspDirectories.length
      const loop = yield* provideInstance(target)(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
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
      // queued Prompt 的 Effect 最终由 D shell fiber 启动，但 admission 必须保留
      // 提交方 T 的 InstanceRef；否则 Read/LSP 会重新归属旧目录 D。
      expect(lspDirectories.slice(offset)).toEqual([target])
    }),
  { git: true },
  // shell 进程与测试 LLM 首次请求都有冷启动开销；平台化预算兼顾负载余量与死锁
  // 检测时延（win32 30s / 其余 12s），断言与并发语义不变。
  heavyLoopBudget,
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
  // 该用例断言两个 loop 调用共享 shell 完成后的同一次结果；放宽预算不改变并发语义断言。
  heavyLoopBudget,
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
  { git: true },
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

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
            // 取消 notice 只进模型侧；用户面板不得回灌 harness
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
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* AppFileSystem.Service
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
      const afs = yield* AppFileSystem.Service
      const ready = path.join(dir, ".bash-output-ready")
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
        // marker 位于完整输出循环之后，发布时已满足 truncation 的输入前提，
        // 不再用 runner 调度速度推测 Tool 的 producer 进度。
        command: `i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; touch "${ready}"; sleep 30`,
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      // 只观察命令公开的文件信号，避免把固定 wall-clock 当成输出完成保证。
      yield* pollWithTimeout(
        afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? true : undefined))),
        "bash output loop did not publish its readiness marker",
      )
      const cancel = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(cancel)

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

unix(
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

unix(
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

it.instance(
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
  { git: true, config: cfg },
  30_000,
)

it.instance(
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
  { git: true, config: cfg },
  30_000,
)

// Missing file handling

it.instance(
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
  { git: true, config: cfg },
)

it.instance(
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
  { git: true, config: cfg },
)

it.instance(
  "resolves configured reference mentions before workspace paths and agents",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const references = parts.filter(
        (part): part is MessageV2.TextPartInput =>
          part.type === "text" && part.synthetic === true && part.text.startsWith("Referenced configured reference "),
      )
      const files = parts.filter((part): part is MessageV2.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is MessageV2.AgentPartInput => part.type === "agent")
      const bare = references.find((part) => part.text.includes("@docs."))
      const missing = references.find((part) => part.text.includes("@docs/missing.md"))
      const guide = files.find((part) => part.filename === "docs/guide")

      expect(references.length).toBe(2)
      expect(bare?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
      })
      expect(missing?.text).toContain("Path does not exist inside configured reference @docs")
      expect(missing?.metadata?.reference).toMatchObject({
        target: "missing.md",
        targetPath: path.join(docs, "missing.md"),
      })

      expect(files.length).toBe(2)
      expect(files.map((file) => fileURLToPath(file.url)).sort()).toEqual(
        [path.join(docs, "README.md"), path.join(docs, "guide")].sort(),
      )
      expect(guide?.mime).toBe("application/x-directory")
      expect(agents.map((agent) => agent.name)).toEqual(["build"])
    }),
  {
    git: true,
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

it.instance(
  "injects metadata for bare configured reference mentions",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: yield* prompt.resolvePromptParts("Use @docs for context"),
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) => part.text.startsWith("Referenced configured reference @docs."))

      expect(reference?.metadata?.reference).toMatchObject({ name: "docs", kind: "local", path: docs })
      expect(synthetic.some((part) => part.text.includes(`Reference root: ${docs}`))).toBe(true)
      expect(synthetic.some((part) => part.text.includes("subagent scout"))).toBe(true)

      yield* sessions.remove(session.id)
    }),
  {
    git: true,
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

it.instance(
  "injects metadata for configured reference file attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      const readme = path.join(docs, "README.md")
      yield* ensureDir(docs)
      yield* writeText(readme, "reference readme")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "Read @docs/README.md" },
          {
            type: "file",
            mime: "text/plain",
            filename: "docs/README.md",
            url: pathToFileURL(readme).href,
            source: {
              type: "file",
              path: "docs/README.md",
              text: { value: "@docs/README.md", start: 5, end: 20 },
            },
          },
        ],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) =>
        part.text.startsWith("Referenced configured reference @docs/README.md."),
      )

      expect(reference?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
        target: "README.md",
        targetPath: readme,
        source: { value: "@docs/README.md", start: 5, end: 20 },
      })
      expect(synthetic.findIndex((part) => part === reference)).toBeLessThan(
        synthetic.findIndex((part) => part.text.startsWith("Called the Read tool with the following input:")),
      )

      yield* sessions.remove(session.id)
    }),
  {
    git: true,
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

it.instance(
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

it.instance(
  "does not loop empty assistant turns for a simple reply",
  () =>
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
  { git: true },
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
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
  { git: true },
  shortSessionTimeout,
)

// Agent variant

it.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
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
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
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
    git: true,
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

it.instance(
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
  { git: true },
  30_000,
)

it.instance(
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
  { git: true },
  30_000,
)

it.instance(
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
  { git: true },
  30_000,
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
      // 子会话只需要返回文本即可完成
      yield* llm.push(reply().text("review done").stop().item())

      yield* prompt.loop({ sessionID: chat.id })

      // 找到 task 工具 part 拿到子会话 ID
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const taskTool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
      // task 工具完成后 state 为 completed，metadata 含子会话 ID
      const childSessionID =
        taskTool?.state.status === "completed" ? taskTool.state.metadata?.sessionId : undefined
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
  "same-time Unicode Goal turns follow persisted chronology despite a late technical Message",
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
      // 同毫秒下 U+E000 的 UTF-8 bytes 小于 U+10000，但 localeCompare 给出相反顺序。
      // B/C 因而必须由 SQLite BINARY-compatible tie-break 决定，不能依赖运行时 locale。
      const b = yield* user(chat.id, "first Goal turn", {
        id: MessageID.make("msg_\uE000"),
        created: 1_000,
      })
      yield* goalSvc.set(chat.id, { objective: "finish the Goal" })
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }),
        reply().text("pending recorded").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })
      yield* sessions.updateMessage({ ...b, hidden: { time: Date.now(), reason: "undo" } })

      // C 刻意不调用 blocked：它必须打断 B 的 pending adjacency；
      // 后落盘的 S 虽指向 B，也只能传递 lineage，不能把 B 移回 current。
      yield* user(chat.id, "newer real user turn without a blocked attempt", {
        id: MessageID.make("msg_𐀀"),
        created: 1_000,
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
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }),
        reply().text("second pending recorded").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })

      // C 是 D 的 previous eligible turn；late S(B) 不能把 B 重新排到 C 之后。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("active")
    }),
  { git: true },
  20_000,
)

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
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "blocked", reason: "persistent blocker" }),
        reply().text("blocked recorded").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })

      // 旧 marker 没有 lineage，但 compaction part 足以证明它是 technical；
      // D 的 previous 仍是 B，所以相同 reason 的第二次确认应真正 terminal。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("blocked")
    }),
  { git: true },
  20_000,
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
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "complete", reason: "all work verified" }),
        reply().text("complete recorded").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })

      // 先通过真实 Tool 写入 model terminal，确保 terminal_turn_id 来自 production transition；
      // 直接调用 user set 会产生不同 ownership，不能证明 recovery actor classifier。
      yield* user(chat.id, "technical replay", {
        goalTurnID: terminalTurn.id,
        created: 2_000,
        synthetic: true,
      })
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "active" }),
        reply().text("technical recovery rejected").stop(),
      )
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
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "active" }),
        reply().text("continuation recovery rejected").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })
      const afterContinuation = yield* goalSvc.get(chat.id)
      if (afterContinuation._tag === "Some") expect(afterContinuation.value.status).toBe("complete")

      yield* user(chat.id, "please continue", { created: 4_000 })
      yield* llm.push(
        reply().tool("goal", { operate: "read" }),
        reply().tool("goal", { operate: "active" }),
        reply().text("recovery accepted").stop(),
      )
      yield* prompt.loop({ sessionID: chat.id })

      // technical/continuation 只验证拒绝；真正的新用户 Goal turn 才拥有恢复授权。
      const result = yield* goalSvc.get(chat.id)
      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(result.value.status).toBe("active")
    }),
  { git: true },
  20_000,
)

// [local-smark] GOAL 错误后续跑测试：验证 continueOnError 策略控制
// 终止型错误后是否自动创建新的 GOAL continuation turn。

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

      // 默认 false：错误后不创建 continuation。验证不存在 synthetic continuation 消息
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const continuations = msgs.filter(
        (m) =>
          m.info.role === "user" &&
          m.parts.some(
            (p) => p.type === "text" && (p as any).synthetic === true && p.text?.includes("<session-goal-continuation>"),
          ),
      )
      expect(continuations.length).toBe(0)
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

      // 第一次：400 错误（APIError），触发 terminal-error → 错误续跑
      // 第二次：续跑后再次 400 错误 → goalTurns=1 >= maxGoalTurns=1 → pause + break
      // 注意：400 非重试，AI SDK 不重试，SessionRetry 也不重试
      yield* llm.error(400, { error: { message: "bad request" } })
      yield* llm.error(400, { error: { message: "bad request" } })

      yield* prompt.loop({ sessionID: chat.id })

      // 验证存在 system_continue 消息：source 字段被 schema decoder 剥离，
      // 改为检查 synthetic text part 中的 continuation prompt 标记
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
      // TextPart type guard 通过公开 Part shape 取 metadata，避免测试依赖 any 或私有存储表示。
      const continueText = continuations[0].parts.find(
        (p): p is MessageV2.TextPart => p.type === "text" && p.text.includes("<session-goal-continuation>"),
      )
      expect(continueText?.text).not.toContain("bad request")
      // 错误原因已由上一条 assistant error 展示，continuation 不增加第二套 error mode。
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

function continuationParts(msgs: MessageV2.WithParts[]) {
  // 只提取持久化 synthetic user Part，避免把 provider 的普通 user/tool 文本误当续跑结果。
  // 返回完整 TextPart 让行为测试读取公开 metadata，同时保留旧 helper 对正文的既有断言。
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

it.instance(
  "goal blocked pending continuation stores block check",
  () =>
    Effect.gen(function* () {
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

      // 四个排队回复分别覆盖 read、blocked、完成当前 step 和挂起下一轮，不依赖内部调用次数 mock。
      // 第一轮 blocked 只保持 Goal active；第二个 provider 请求挂起，保留下一条 continuation 供断言。
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
      // BLOCK CHECK 必须来自结构化 Tool 结果，而不是 title/output 文案或当前 Goal status。
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

// progress gate：两轮无 structured 证据后，下一条 continuation 必须进入 BFS replan。
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
      // 重新读取 persisted Parts，避免复用上方正文数组而把同一实现复制成 expected metadata。
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
  30_000,
)

// replan 中 exploration（read）不能退出 replan；advancement（write）才能回到 ordinary。
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

// read identity：新版本/range 必须能启动或重置 raw count，重复同一 read 不能伪造 exploration。
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

// normalized search/command signatures：重复输入不应伪造新探索；无效 edit 也不应成为 advancement。
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

// duplicate probes must be observed before a later write can reset the gate;
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
      // grep 阶段检验缺省 path 与 `.` 的 canonical equivalence 以及数组顺序归一化。
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

// verification signature：首次结果只算 exploration，same result 不算新证据，结果改变才算 advancement。
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

      // 状态放在 Project 外；否则 generic mutation 会被 Snapshot 误记为 Patch advancement。
      const stateDir = yield* tmpdirScoped()
      const statusPath = path.join(stateDir, "verification-status.txt")
      const fixturePath = path.join(dir, "verification.test.ts")
      const changePath = path.join(dir, "verification-change.ts")
      yield* writeText(path.join(dir, ".gitignore"), "verification-output.log\n")
      yield* writeText(statusPath, "one\n")
      yield* writeText(
        fixturePath,
        [
          'import { expect, test } from "bun:test"',
          `test("status", async () => expect(await Bun.file(${JSON.stringify(statusPath)}).text()).toBe("one\\n"))`,
        ].join("\n"),
      )
      yield* writeText(changePath, `await Bun.write(${JSON.stringify(statusPath)}, "two\\n")`)
      // 命令只引用预先存在的相对脚本；外部路径留在 Bun 字面量内，避免进入 Shell 的 Windows 解析。
      const verify = "bun test --timeout 30000 verification.test.ts > verification-output.log 2>&1"
      const change = "bun verification-change.ts"

      // 忽略输出文件使同一 verification 的 signature 只由 exit/result 改变，不受耗时噪声或 Patch 影响。
      // 第一次相同结果只启动 verification baseline，第二次相同结果必须保持旧 baseline。
      yield* llm.push(reply().text("idle 1").stop())
      yield* llm.push(reply().text("idle 2").stop())
      yield* llm.push(reply().tool("bash", { command: verify, description: "verification one" }).item(), reply().text("verified").stop())
      // 第二次调用使用同一 command，必须复用 baseline 而不是制造 changed result。
      yield* llm.push(reply().tool("bash", { command: verify, description: "verification repeat" }).item(), reply().text("same verification").stop())
      yield* llm.push(reply().tool("bash", { command: change, description: "change verification fixture" }).item(), reply().text("fixture changed").stop())
      // generic mutation 只改变外部状态，不提供 Patch 或 verification advancement。
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
      // generic mutation 只能改变外部验证状态；它不能绕过 re-plan 的 advancement 门槛。
      expect(texts[4]).toContain("<strategy-switch")
      // changed verification 是 advancement；若只算 exploration，下一轮 idle 就会错误进入 replan。
      expect(texts[5]).not.toContain("<strategy-switch")
    }),
  { git: true },
  60_000,
)

// Todo/no-op contract：新完成 Todo 才能推进，重复快照和 no-op edit 都不能推进。
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

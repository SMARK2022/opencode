import { afterEach, describe, expect, mock, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { usable } from "../../src/session/overflow"
import { TokenEstimate } from "@/token/estimate"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Snapshot } from "../../src/snapshot"
import fs from "fs/promises"
import path from "path"

import { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

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

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

const basicUsage = () => usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}
// #194：source 集成测试辅助——写入 step-finish 样本供学习密度
function addStepFinish(sessionID: SessionID, messageID: MessageID, inputChars: number, inputTokens: number) {
  return SessionNs.Service.use((ssn) =>
    ssn.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      inputChars,
    }),
  )
}


function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function createCompactionMarker(sessionID: SessionID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
      })
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, compaction }) }))
}

const defaultProvider = wide()
const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  SessionRequestUsage.node,
  Todo.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const env = AppNodeBuilder.build(compactionTestNode, [
  [Provider.node, defaultProvider.layer],
  [SessionProcessorModule.SessionProcessor.node, processorLayer("continue")],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
])

const it = testEffect(env)

const compactionEnv = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, SessionRequestUsage.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const itCompaction = testEffect(compactionEnv)

type CompactionProcessOptions = {
  result?: "continue" | "compact"
  llm?: Layer.Layer<LLM.Service>
  plugin?: Layer.Layer<Plugin.Service>
  snapshot?: Layer.Layer<Snapshot.Service>
  database?: Layer.Layer<Database.Service>
  provider?: ReturnType<typeof wide>
  config?: Layer.Layer<Config.Service>
}

function withCompaction(options?: CompactionProcessOptions) {
  return Effect.provide(compactionProcessLayer(options))
}

function compactionProcessLayer(options?: CompactionProcessOptions) {
  const replacements: LayerNode.Replacements = [
    [Provider.node, (options?.provider ?? wide()).layer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [SessionSummary.node, summary],
    ...(options?.database ? [[Database.node, options.database] as const] : []),
    ...(options?.snapshot ? [[Snapshot.node, options.snapshot] as const] : []),
  ]
  if (!options?.llm) {
    return AppNodeBuilder.build(compactionTestNode, [
      ...replacements,
      [SessionProcessorModule.SessionProcessor.node, processorLayer(options?.result ?? "continue")],
      ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
      ...(options?.config ? ([[Config.node, options.config]] as const) : []),
    ])
  }
  return AppNodeBuilder.build(compactionTestNode, [
    ...replacements,
    [LLM.node, options.llm],
    ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
    ...(options?.config ? ([[Config.node, options.config]] as const) : []),
  ])
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.at(-2)?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)) {
      queue.push(stream)
    },
    llmLayer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: basicUsage(),
      }),
      LLMEvent.finish({
        reason: "stop",
        usage: basicUsage(),
      }),
    )
  }
}

function plugin(ready: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.as(output),
      )
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function compactionContext(context: string) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { context: string[] }).context.push(context)
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

itCompaction.instance("uses current disk state for inspected file freshness", () => {
  const stub = llm()
  stub.push(reply("summary"))
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({})
    // 真实 Todo 表快照与摘要同一次执行读取，不用伪造 todowrite 输出替代持久 owner。
    const todo = yield* Todo.Service
    yield* todo.update({ sessionID: session.id, todos: [
      { content: "Read forensic report", status: "completed", priority: "high" },
      { content: "Design P0 evidence handoff", status: "in_progress", priority: "high" },
      { content: "Add compaction tests", status: "pending", priority: "medium" },
      { content: "Discard obsolete sketch", status: "cancelled", priority: "low" },
    ] })
    const user = yield* createUserMessage(session.id, "check inspected freshness")
    const assistant = yield* createAssistantMessage(session.id, user.id, test.directory)
    const names = ["unchanged file", "changed", "deleted", "missing-metadata"] as const
    for (const [index, name] of names.entries()) {
      const file = path.join(test.directory, `${name}.ts`)
      const modifiedMs = new Date(2026, 4, 18, index + 1).getTime()
      // 真实落盘和mtime固定后再记录读取凭证，覆盖带外变更而非伪造工具事件。
      yield* Effect.promise(async () => {
        await fs.writeFile(file, "x".repeat(20))
        await fs.utimes(file, new Date(modifiedMs), new Date(modifiedMs))
      })
      yield* ssn.updatePart({
        id: PartID.ascending(), sessionID: session.id, messageID: assistant.id,
        type: "tool", tool: "read", callID: `read_${index}`,
        state: { status: "completed", input: { filePath: file }, output: "file", title: "read",
          time: { start: 1, end: 2 }, metadata: { read: {
            path: file, canonicalPath: file, start: 1, end: 20, total: 20,
            modified: "previous read", ...(index === 3 ? {} : { size: 20, modifiedMs }),
          } } },
      })
      // 同一路径的重叠读取必须合并，版本判断仍由真实磁盘负责。
      if (index === 0) yield* ssn.updatePart({
        id: PartID.ascending(), sessionID: session.id, messageID: assistant.id,
        type: "tool", tool: "read", callID: "read_overlap",
        state: { status: "completed", input: { filePath: file }, output: "file", title: "read",
          time: { start: 1, end: 2 }, metadata: { read: {
            path: file, canonicalPath: file, start: 19, end: 20, total: 20,
            modified: "previous read", size: 20, modifiedMs,
          } } },
      })
    }
    // 只有磁盘变化使凭证过期：write元数据本身不会让未变的文件失效。
    yield* ssn.updatePart({
      id: PartID.ascending(), sessionID: session.id, messageID: assistant.id,
      type: "tool", tool: "write", callID: "metadata_only",
      state: { status: "completed", input: {}, output: "", title: "write",
        time: { start: 2, end: 3 }, metadata: { filepath: path.join(test.directory, "unchanged file.ts") } },
    })
    yield* Effect.promise(async () => {
      const changed = path.join(test.directory, "changed.ts")
      await fs.writeFile(changed, "changed on disk")
      const time = new Date(2026, 4, 18, 5)
      await fs.utimes(changed, time, time)
      // 移动后的旧路径也必须标 deleted，不能只依赖工具 mutation 元数据。
      await fs.rename(path.join(test.directory, "deleted.ts"), path.join(test.directory, "moved.ts"))
    })
    yield* createSummaryCompaction(session.id)
    const messages = yield* ssn.messages({ sessionID: session.id })
    yield* SessionCompaction.use.process({
      parentID: messages.at(-1)!.info.id, messages, sessionID: session.id, auto: false,
    })
    const compacted = (yield* ssn.messages({ sessionID: session.id }))
      .findLast((message) => message.info.role === "assistant" && message.info.summary)
    const text = compacted?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
    expect(text).toContain("summary")
    expect(text).toContain("## Evidence Handoff")
    expect(text?.match(/## Evidence Handoff/g)).toHaveLength(1)
    expect(text).toContain("| completed | high | Read forensic report |")
    expect(text).toContain("| in_progress | high | Design P0 evidence handoff |")
    expect(text).toContain("| pending | medium | Add compaction tests |")
    expect(text).toContain("| cancelled | low | Discard obsolete sketch |")
    expect(text).toContain("- Older raw tool outputs were compacted.")
    expect(text).toContain("| unchanged file.ts | 1-20 | 20 | 2026-05-18 01:00:00 | current |")
    expect(text).toContain("| changed.ts | 1-20 | 20 | 2026-05-18 05:00:00 | stale |")
    expect(text).toContain("| deleted.ts | 1-20 | 20 | - | deleted |")
    expect(text).toContain("| missing-metadata.ts | 1-20 | 20 | 2026-05-18 04:00:00 | stale |")
  }).pipe(withCompaction({ llm: stub.llmLayer }))
}, { git: true }, 20_000)

describe("session.compaction.isOverflow", () => {
  test("preserves conditional V1 usable budgets and explicit reserves", () => {
    const model = createModel({ context: 204_800, input: 73_700, output: 20_000 })
    // 单一真实 runtime 入口验证 floor，不能在测试中复制预算公式作为 oracle。
    expect(usable({ cfg: {}, model })).toBe(68_700)
    // 显式零不回退，显式大预留也不能绕过非负输入边界。
    expect(usable({ cfg: { compaction: { reserved: 0 } }, model })).toBe(73_700)
    expect(usable({ cfg: { compaction: { reserved: 9_000 } }, model })).toBe(64_700)
    expect(usable({ cfg: { compaction: { reserved: 80_000 } }, model })).toBe(0)
    // 差额抵消尚未触及 floor 的中间分支，避免把所有模型都硬编码成 5000。
    expect(usable({ cfg: {}, model: createModel({ context: 100_000, input: 90_000, output: 100 }) })).toBe(80_000)
    // 没有 catalog 输入上限时仍扣有效输出，explicit reserved 不能偷偷切换分支。
    const withoutInput = createModel({ context: 100_000, output: 20_000 })
    expect(usable({ cfg: { compaction: { reserved: 0 } }, model: withoutInput })).toBe(80_000)
    // caller 的输出 cap 继续参与无 input 预算，不丢失 outputTokenMax 扩展。
    expect(usable({ cfg: {}, model: withoutInput, outputTokenMax: 7_000 })).toBe(93_000)
    // 输出为零沿 transform fallback，不把未知输出当作完全无需预留。
    expect(usable({ cfg: {}, model: createModel({ context: 100_000, output: 0 }), outputTokenMax: 7_000 })).toBe(93_000)
    // 未知窗口不猜预算，即使附有输入上限或显式预留也保持零。
    expect(usable({ cfg: {}, model: createModel({ context: 0, input: 73_700, output: 20_000 }) })).toBe(0)
  })

  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  it.live(
    "BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "BUG: without limit.input, same token count correctly triggers compaction",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = yield* compact.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      }),
    ),
  )

  it.live(
    "BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = yield* compact.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      }),
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )

  it.live(
    "inherits the latest canonical Goal turn on the compaction marker",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const source = yield* createUserMessage(session.id, "continue this Goal")
        // 先构造继承 source 的 technical wrapper，再让 create 读取“最新 user”；
        // 这能区分正确的 lineage flattening 与错误地复制 wrapper 自身 ID。
        const technical = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          goalTurnID: source.id,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: technical.id,
          sessionID: session.id,
          type: "text",
          text: "technical continuation",
          synthetic: true,
        })

        const marker = yield* compact.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: true,
        })

        // 最新 user 本身也是 technical，但 lineage 必须继续指向原 canonical source；
        // 若改用 wrapper ID，连续 Compaction 会不断伪造新的 Goal turn。
        expect(marker.goalTurnID).toBe(source.id)
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )
})

describe("session.compaction.process", () => {
  it.instance(
    "throws when parent is not a user message",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const reply = yield* createAssistantMessage(session.id, msg.id, test.directory)
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: reply.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain(`Compaction parent must be a user message: ${reply.id}`)
        }
      }
    }),
  )

  it.instance(
    "publishes compacted event on continue",
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const done = yield* Deferred.make<void, Error>()
      const seen: string[] = []
      const unsub = yield* events.listen((evt) => {
        seen.push(evt.type)
        if (evt.type !== SessionCompaction.Event.Compacted.type) return Effect.void
        if ((evt.data as typeof SessionCompaction.Event.Compacted.data.Type).sessionID !== session.id)
          return Effect.void
        Deferred.doneUnsafe(done, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      yield* Deferred.await(done).pipe(Effect.timeout("500 millis"))
      expect(result).toBe("continue")
      expect(seen).toContain(SessionCompaction.Event.Compacted.type)
      expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
    }),
  )

  // #194：compaction summary 的 pending input 估算必须用确认密度，而非 raw /4
  itCompaction.instance(
    "summary assistant pending input estimate uses confirmed upload density",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const historical = yield* createUserMessage(session.id, "historical context")
      const historicalReply = yield* createAssistantMessage(session.id, historical.id, test.directory)
      yield* addStepFinish(session.id, historicalReply.id, 80_000, 10_000)
      const msg = yield* createUserMessage(session.id, "compact this session")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (item) => item.info.role === "assistant" && item.info.summary,
      )

      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role !== "assistant") return
      expect(summary.info.inputEstimate?.bodyChars).toBeGreaterThan(0)
      expect(summary.info.inputEstimate?.input).toBeLessThan(Math.round((summary.info.inputEstimate?.bodyChars ?? 0) / 6))
    }).pipe(withCompaction({
      // 仅替换 LLM 边界，执行真实 processor 与准备回调；整体 processor 替身不会产生估算。
      llm: Layer.succeed(LLM.Service, LLM.Service.of({
        stream: (input) => Stream.unwrap(
          (input.onRequestPrepared?.({ messages: input.messages }) ?? Effect.void).pipe(
            Effect.as(reply("summary")(input)),
          ),
        ),
      })),
    })),
  )

  itCompaction.instance(
    "stores pending input estimate on summary assistant before streaming",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const prepared = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* SessionCompaction.use.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false })
        .pipe(
          withCompaction({
            llm: Layer.succeed(LLM.Service, LLM.Service.of({
              stream: (input) => Stream.unwrap(
                (input.onRequestPrepared?.({ messages: input.messages }) ?? Effect.void).pipe(
                  Effect.andThen(Deferred.succeed(prepared, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Stream.concat(
                    Stream.make(LLMEvent.stepStart({ index: 0 })),
                    reply("summary")(input),
                  )),
                ),
              ),
            })),
          }),
          Effect.forkChild,
        )
      // 准备回调提交后仍阻塞首个流事件，数据库快照必须已包含摘要请求的估算。
      yield* Deferred.await(prepared).pipe(Effect.timeout("5 seconds"))
      const snapshot = yield* Effect.gen(function* () {
        const pending = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.role === "assistant" && item.info.summary)
        if (!pending || pending.info.role !== "assistant" || !pending.info.inputEstimate) return yield* Effect.die("Missing pending summary estimate")
        const estimate = pending.info.inputEstimate
        expect(estimate.input).toBeGreaterThan(0)
        expect(estimate.bodyChars).toBeGreaterThan(0)
        expect(estimate.inputBreakdown?.messages.total).toBeGreaterThan(0)
        // provisional 快照只供展示；确认 tokens 和账本不能提前计入估算。
        expect(pending.info.tokens.input).toBe(0)
        expect(estimate.confirmed).toBe(false)
        return estimate
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      yield* Fiber.join(fiber)
      const summary = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.role === "assistant" && item.info.summary)
      if (!summary || summary.info.role !== "assistant") return yield* Effect.die("Missing completed summary")
      // 流式部件沿同一准备快照交接，不能恢复旧inputChars/inputBreakdown可变旁路。
      expect(summary.parts.find((part) => part.type === "step-start")).toMatchObject({
        inputChars: snapshot.bodyChars,
        inputTokens: snapshot.input,
        inputBreakdown: snapshot.inputBreakdown,
      })
      expect(summary.parts.find((part) => part.type === "step-finish")).toMatchObject({ inputChars: snapshot.bodyChars, inputBreakdown: snapshot.inputBreakdown })
      expect(summary.info.inputEstimate).toMatchObject({ ...snapshot, confirmed: true })
      expect(summary.info.tokens.input).toBe(1)
      // 同一次provider确认只结算一次，pending展示不得增加摘要账单。
      const ledger = yield* SessionRequestUsage.Service
      expect(yield* ledger.get({ sessionID: session.id, requestID: msg.id })).toMatchObject({
        source: "system_compaction", assistantCount: 1, stepCount: 1, tokens: { input: 1, output: 1, total: 2 },
      })
    }),
  )

  itCompaction.instance(
    "marks summary message as errored on compact result",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (msg) => msg.info.role === "assistant" && msg.info.summary,
      )

      expect(result).toBe("stop")
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role === "assistant") {
        expect(summary.info.finish).toBe("error")
        expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
      }
      const ledger = yield* SessionRequestUsage.Service
      expect(yield* ledger.get({ sessionID: session.id, requestID: msg.id })).toMatchObject({ source: "system_compaction", rootRequestID: msg.id, status: "error", assistantCount: 1, stepCount: 0, cost: 0, tokens: { total: 0 } })
      // fresh 避开 fake processor/provider，但沿用 Project 所在的真实数据库确认用量和 overflow。
      const database = yield* Database.Service
      const stub = llm()
      stub.push(Stream.concat(
        Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop", usage: usage({ inputTokens: 8, outputTokens: 3, totalTokens: 11 }) })),
        Stream.fail(new APICallError({ message: "request entity too large", url: "https://example.com/v1/chat/completions", requestBodyValues: {}, statusCode: 413, responseBody: '{"error":"request entity too large"}', isRetryable: false })),
      ))
      yield* Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const ledger = yield* SessionRequestUsage.Service
        const chat = yield* ssn.create({ title: "Confirmed usage before summary overflow" })
        const parent = yield* createUserMessage(chat.id, "Overflow after a confirmed step")
        const result = yield* SessionCompaction.use.process({ parentID: parent.id, messages: yield* ssn.messages({ sessionID: chat.id }), sessionID: chat.id, auto: false })
        expect(result).toBe("stop")
        const summary = (yield* ssn.messages({ sessionID: chat.id })).find(message => message.info.role === "assistant" && message.info.summary)
        if (!summary || summary.info.role !== "assistant") return yield* Effect.die("Missing overflow summary")
        expect(summary.info.error?.name).toBe("ContextOverflowError")
        if (!SessionV1.ContextOverflowError.isInstance(summary.info.error)) return yield* Effect.die("Expected original overflow error")
        expect(summary.info.cost).toBeGreaterThan(0)
        expect(summary.info.tokens).toMatchObject({ input: 8, output: 3 })
        const settled = { status: "error", stepCount: 1, cost: summary.info.cost, tokens: { input: 8, output: 3, total: 11 }, error: summary.info.error.data.message }
        expect(yield* ledger.get({ sessionID: chat.id, requestID: parent.id })).toMatchObject({ ...settled, rootRequestID: parent.id, source: "system_compaction", assistantCount: 1 })
        expect(yield* ledger.assistants({ sessionID: chat.id, requestID: parent.id })).toMatchObject([{ ...settled, assistantMessageID: summary.info.id }])
      }).pipe(Effect.provide(Layer.fresh(compactionProcessLayer({ database: Layer.succeed(Database.Service, database), llm: stub.llmLayer, provider: ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000, cost: { input: 2, output: 4, cache: { read: 0, write: 0 } } }) }) }))))
    }).pipe(withCompaction({ result: "compact" })),
  )

  it.instance(
    "adds synthetic continue prompt when auto is enabled",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      })
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("Continue if you have next steps")
      }
    }),
  )

  itCompaction.instance(
    "persists tail_start_id for retained recent turns",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      const keep = yield* createUserMessage(session.id, "second")
      yield* createUserMessage(session.id, "third")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) })),
  )

  itCompaction.instance(
    "shrinks retained tail to fit preserve token budget",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      yield* createUserMessage(session.id, "x".repeat(2_000))
      const keep = yield* createUserMessage(session.id, "tiny")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 100 }) })),
  )

  itCompaction.instance(
    "falls back to full summary when a recent turn cannot be retained as a stable boundary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        const recent = yield* createUserMessage(session.id, "y".repeat(2_000))
        // #205：补一个未完成（无 finish）的 assistant 占据该轮，使 splitTurn 无法留作 tail_start_id
        // #205：迫使压缩回退到 full summary——验证不可重放边界不会被选为持久化锁点
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: recent.id,
          time: { created: Date.now() },
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("yyyy")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    // #256：小 tail 预算（20 token）强制 memento 承载最新指令——验证完整交接链
    "preserves recent user instructions in compacted context when the full tail is not retained",
    () => {
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        const latest = yield* createUserMessage(session.id, "latest user instruction to preserve")
        // #256：older context 先于最新指令写入——collect 从最新反向遍历，预算内两条都保留
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: latest.id,
          time: { created: Date.now() },
        })
        yield* createSummaryCompaction(session.id)
        // #256：create 只建立压缩标记边界——memento 采集发生在 process 内

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })
        // #256：auto:false 手动驱动 process——memento 在 select 之后写入 part

        const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        const modelMessages = yield* MessageV2.toModelMessagesEffect(filtered, createModel({ context: 100_000, output: 32_000 }))
        const compactedContext = JSON.stringify(modelMessages)

        expect(compactedContext).toContain("<recent-user-messages>")
        expect(compactedContext).toContain("latest user instruction to preserve")
        expect(compactedContext).toContain("What did we do so far?")
        // #256：memento 必须在历史压缩提示之前出现——模型先看到最新用户意图
        expect(compactedContext.indexOf("latest user instruction to preserve")).toBeLessThan(
          compactedContext.indexOf("What did we do so far?"),
        )
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
        // #256：tail_turns:1 + 20 token 预算使整轮尾部无法保留——强制 memento 成为唯一交接通道
    },
    { git: true },
  )

  itCompaction.instance(
    // #256：超长指令走二分截断——上限遵循模型窗口而非绝对 20K
    "bounds overlong recent user instructions in compacted context",
    () => {
      const stub = llm()
      const mementoModel = createModel({ context: 10_000, output: 8_000 })
        // #256：10K 小窗口——memento 预算按 usable 的 20% 收缩，远低于 20K 绝对上限
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const latest = yield* createUserMessage(
          session.id,
          `start of oversized instruction ${"x".repeat(100_000)} end of oversized instruction`,
        // #256：100K 字符远超任何预算——强制走到 truncateRecentUserMessage 二分路径
        )
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: latest.id,
          time: { created: Date.now() },
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const modelMessages = yield* MessageV2.toModelMessagesEffect(
          MessageV2.filterCompacted(yield* MessageV2.stream(session.id)),
          mementoModel,
        )
        const compactedContext = JSON.stringify(modelMessages)
        const compactionPart = yield* readCompactionPart(session.id)
        // #256：从持久化 part 读回 memento——验证截断结果已随压缩边界落库
        const recentUserMemento = MessageV2.formatRecentUserMemento(compactionPart?.recent_user_messages ?? [])

        expect(compactedContext).toContain("start of oversized instruction")
        expect(compactedContext).toContain("truncated for compaction memento")
        expect(compactedContext).not.toContain("end of oversized instruction")
        // #256：memento 上限必须跟随模型窗口的 20%，而不是绝对 20K——小窗口模型
        // 否则压缩重放后会立刻再次溢出（10K 窗口 → 20% = 2K 内的 400 估算）
        expect(TokenEstimate.estimateText(recentUserMemento)).toBeLessThanOrEqual(400)
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          provider: ProviderTest.fake({ model: mementoModel }),
          config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    // #256：synthetic/ignored 文本不得污染 memento——过滤按 part 粒度生效
    "preserves raw recent user instructions across repeated compactions",
    () => {
      const stub = llm()
      const mementoModel = createModel({ context: 10_000, output: 8_000 })
      stub.push(reply("first summary"))
      stub.push(reply("second summary"))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(
          session.id,
          `raw instruction before prior compaction ${"x".repeat(100_000)} end of raw instruction`,
        )
        yield* createSummaryCompaction(session.id)
        // #257：第一次压缩后 raw 指令被 summary 覆盖——第二次压缩仍从 rawHistory 找回它

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        // #257：第二次压缩基于第一次压缩后的尾部——memento 只携带尚未被压缩边界覆盖的原始指令
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const latest = yield* createUserMessage(session.id, "latest request after prior compaction")
        yield* createAssistantMessage(session.id, latest.id, test.directory)
        yield* createSummaryCompaction(session.id)

        msgs = yield* ssn.messages({ sessionID: session.id })
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const compactionPart = yield* readCompactionPart(session.id)
        // #257：readCompactionPart 读最近一次压缩边界——两次压缩后取第二次的 memento
        const recentUserMemento = MessageV2.formatRecentUserMemento(compactionPart?.recent_user_messages ?? [])

        // #257：核心不变量——首次压缩前的 raw 指令在第二次压缩后仍须完整出现在 memento 中
        expect(recentUserMemento).toContain("latest request after prior compaction")
        expect(recentUserMemento).toContain("raw instruction before prior compaction")
        expect(recentUserMemento).toContain("truncated for compaction memento")
        expect(recentUserMemento).not.toContain("end of raw instruction")
        expect(TokenEstimate.estimateText(recentUserMemento)).toBeLessThanOrEqual(400)
        // #257：10K 窗口 20% 预算——跨压缩截断仍须保持同一上限
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          provider: ProviderTest.fake({ model: mementoModel }),
          config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "keeps synthetic, ignored, and hidden user text out of recent user mementos",
    () => {
      const stub = llm()
      stub.push(reply("summary"))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const latest = yield* createUserMessage(session.id, "real instruction")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: latest.id,
          sessionID: session.id,
          type: "text",
          text: "synthetic editor context should not be preserved",
          synthetic: true,
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: latest.id,
          sessionID: session.id,
          type: "text",
          text: "ignored text should not be preserved",
          ignored: true,
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: latest.id,
          sessionID: session.id,
          type: "text",
          text: "hidden text part should not be preserved",
          hidden: { time: Date.now(), reason: "undo" },
        // #257：hidden 结构为 {time, reason}——撤销标记必须同时排除 part 与整条消息
        })
        const hiddenMsg = yield* createUserMessage(session.id, "hidden message should not be preserved")
        yield* ssn.updateMessage({
          ...hiddenMsg,
        // #257：对已创建消息二次更新打 hidden 标记——比创建时传参更接近真实撤销路径
          hidden: { time: Date.now(), reason: "undo" },
        })
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: latest.id,
          time: { created: Date.now() },
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const modelMessages = yield* MessageV2.toModelMessagesEffect(
          MessageV2.filterCompacted(yield* MessageV2.stream(session.id)),
          createModel({ context: 100_000, output: 32_000 }),
        )
        const compactedContext = JSON.stringify(modelMessages)

        expect(compactedContext).toContain("real instruction")
        // #257：synthetic/ignored/hidden 都按 part 粒度排除——hidden 消息整体跳过
        expect(compactedContext).not.toContain("synthetic editor context should not be preserved")
        expect(compactedContext).not.toContain("ignored text should not be preserved")
        expect(compactedContext).not.toContain("hidden text part should not be preserved")
        expect(compactedContext).not.toContain("hidden message should not be preserved")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "falls back to full summary when retained tail media exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent image turn")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("recent image turn")
        expect(captured).toContain("Attached image/png: big.png")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "retains a split turn suffix when a later message fits the preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent turn")
        const large = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(captured).toContain("zzzz")
        expect(captured).not.toContain("keep tail")

        const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(filtered.map((msg) => msg.info.id).slice(0, 3)).toEqual([parent!, expect.any(String), keep.id])
        expect(filtered[1]?.info.role).toBe("assistant")
        expect(filtered[1]?.info.role === "assistant" ? filtered[1].info.summary : false).toBe(true)
        expect(filtered.map((msg) => msg.info.id)).not.toContain(large.id)
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "allows plugins to disable synthetic continue prompt",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("assistant")
      expect(
        all.some(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        ),
      ).toBe(false)
    }).pipe(withCompaction({ plugin: autocontinue(false) })),
  )

  it.instance(
    "replays the prior user turn on overflow when earlier context exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "root")
      const replay = yield* createUserMessage(session.id, "image")
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: replay.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "cat.png",
        url: "https://example.com/cat.png",
      })
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
      ).toBe(true)
    }),
  )

  it.instance(
    "falls back to overflow guidance when no replayable turn exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "earlier")
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
      }
    }),
  )

  itCompaction.instance(
    "stops quickly when aborted during retry backoff",
    () => {
      const stub = llm()
      stub.push(
        Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              yield LLMEvent.stepStart({ index: 0 })
              throw new APICallError({
                message: "boom",
                url: "https://example.com/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10000" },
                responseBody: '{"error":"boom"}',
                isRetryable: true,
              })
            },
          },
          (err) => err,
        ),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const ready = yield* Deferred.make<void>()
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== session.id || data.status.type !== "retry") return Effect.void
          Deferred.doneUnsafe(ready, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        const fiber = yield* SessionCompaction.use
          .process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            auto: false,
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const start = Date.now()
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Date.now() - start).toBeLessThan(250)
        }
      }).pipe(withCompaction({
        llm: stub.llmLayer,
        // 此例计量重试取消，不将 Git 快照子进程收尾混入 250ms 预算。
        config: Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ snapshot: false }) })),
      }))
    },
    { git: true },
    { timeout: 10_000 },
  )

  itCompaction.instance(
    "does not leave a summary assistant when aborted before processor setup",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const msg = yield* createUserMessage(session.id, "hello")
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: msg.id,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
          const ledger = yield* SessionRequestUsage.Service
          expect(yield* ledger.get({ sessionID: session.id, requestID: msg.id })).toMatchObject({ rootRequestID: msg.id, status: "aborted", assistantCount: 0, stepCount: 0, tokens: { total: 0 } })
        }).pipe(withCompaction({ plugin: plugin(ready) }))
        // 同一取消 case 再覆盖 summary 已提交的通知与真实 snapshot.track 两个初始化窗口。
        for (const phase of ["publish", "snapshot"] as const) {
          const gate = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const stub = llm()
          let calls = 0
          stub.push(input => { calls++; return reply("unused")(input) })
          yield* Effect.gen(function* () {
            const ssn = yield* SessionNs.Service
            const events = yield* EventV2Bridge.Service
            const ledger = yield* SessionRequestUsage.Service
            const chat = yield* ssn.create({ title: `Cancel summary ${phase}` })
            const parent = yield* createUserMessage(chat.id, "Cancel summary initialization")
            yield* Effect.addFinalizer(() => Deferred.succeed(release, void 0).pipe(Effect.asVoid))
            const off = yield* events.listen(event => Effect.gen(function* () {
              if (phase !== "publish" || event.type !== MessageV2.Event.Updated.type) return
              const data = Schema.decodeUnknownSync(MessageV2.Event.Updated.data)(event.data)
              if (data.sessionID !== chat.id || data.info.role !== "assistant") return
              yield* Deferred.succeed(gate, void 0)
              yield* Deferred.await(release)
            }))
            yield* Effect.addFinalizer(() => off)
            const fiber = yield* SessionCompaction.use.process({ parentID: parent.id, messages: yield* ssn.messages({ sessionID: chat.id }), sessionID: chat.id, auto: false }).pipe(Effect.forkChild)
            yield* Deferred.await(gate).pipe(Effect.timeout("1 second"))
            const rescue = yield* Effect.sleep("2 seconds").pipe(Effect.andThen(Deferred.succeed(release, void 0)), Effect.forkChild)
            yield* Fiber.interrupt(fiber)
            expect(yield* Deferred.isDone(release)).toBe(false)
            yield* Fiber.interrupt(rescue)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            const summary = (yield* ssn.messages({ sessionID: chat.id })).find(message => message.info.role === "assistant" && message.info.summary)
            expect(summary?.info).toMatchObject({ parentID: parent.id, error: { name: "MessageAbortedError" }, time: { completed: expect.any(Number) } })
            expect(yield* ledger.get({ sessionID: chat.id, requestID: parent.id })).toMatchObject({ rootRequestID: parent.id, source: "system_compaction", status: "aborted", assistantCount: 1, stepCount: 0, cost: 0, tokens: { total: 0 } })
            expect(calls).toBe(0)
          }).pipe(withCompaction({ llm: stub.llmLayer, ...(phase === "snapshot" ? { snapshot: Layer.mock(Snapshot.Service)({ track: () => Deferred.succeed(gate, void 0).pipe(Effect.andThen(Effect.never)) }) } : {}) }))
        }
      }),
    { git: true },
  )


  // #242：run 直接把 compaction 执行为已完成边界——create 落 marker、process 收 continue
  // #242：latest.tasks 不再包含可重放 compact 任务（生产者直执，消费端只留边界）
  itCompaction.instance(
    "runs compaction as a completed boundary without a runnable task",
    () => {
      // summary 流断言降级：真实 processor+stub LLM 组合在目标测试设施下会不可中断地挂起
      // （probe 实证 timeout 无法打断），故用 processorLayer("continue") 验证 run 编排边界；
      // 摘要 assistant 落库由中断测试与 process 既有用例共同覆盖
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "hello")

        const result = yield* SessionCompaction.use.run({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        // V2：filterCompactedEffect 走 includeHidden 流，与 prompt 消费视角一致
        // V2 filterCompacted 会把 marker 消息从 prompt 视角剔除——marker 断言走原始 messages
        const all = yield* ssn.messages({ sessionID: session.id })
        const filtered = yield* MessageV2.filterCompactedEffect(session.id)
        const latest = MessageV2.latest(filtered)

        expect(result).toBe("continue")
        expect(
          all.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
        ).toBe(true)
        expect(latest.tasks).toEqual([])
      }).pipe(withCompaction())
    },
    { git: true }, 15_000,
  )

  // #242：中断发生在 scratch 标记可见后、摘要请求开始前——hideIncomplete 只隐藏
  // #242：这对未完成 compaction；已完成边界不被误清
  itCompaction.instance(
    "hides visible compaction state when interrupted before summary request starts",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          yield* createUserMessage(session.id, "hello")
          const fiber = yield* SessionCompaction.use
            .run({
              sessionID: session.id,
              agent: "build",
              model: ref,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.parts.some((part) => part.type === "compaction"))).toBe(false)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "silently drops reasoning-delta arriving without prior reasoning-start",
    () => {
      // Regression: PR initially auto-created a reasoning Part for orphan deltas (no preceding
      // reasoning-start). Reverted to match dev — drop silently. Pinned here so any future
      // change to processor.ts reasoning-delta handling triggers this test.
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.reasoningDelta({ id: "orphan-1", text: "stray reasoning" }),
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: "summary" }),
          LLMEvent.textEnd({ id: "txt-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
          LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )
        expect(summary?.parts.some((part) => part.type === "reasoning")).toBe(false)
        // Sanity: the text part still got through.
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "does not allow tool calls while generating the summary",
    () => {
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.toolCall({ id: "call-1", name: "_noop", input: {} }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: basicUsage(),
          }),
          LLMEvent.finish({
            reason: "tool-calls",
            usage: basicUsage(),
          }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )

        expect(summary?.info.role).toBe("assistant")
        expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes only the head while keeping recent tail out of summary input",
    () => {
      const stub = llm()
      let messages: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary", (input) => {
          messages = input.messages
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        // #255：tail 轮数翻倍后原三轮会吞掉 head——补两轮保证压缩输入仍含非空 head
        yield* createUserMessage(session.id, "third retained turn")
        yield* createUserMessage(session.id, "fourth retained turn")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const captured = JSON.stringify(messages)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.role).toBe("user")
        expect(captured).toContain("Here is the conversation so far:")
        expect(captured).toContain("<conversation>")
        expect(captured.indexOf("[User]: older context")).toBeLessThan(
          captured.indexOf("Create a new anchored summary"),
        )
        expect(captured).toContain("[User]: older context")
        expect(captured).not.toContain("keep this turn")
        expect(captured).not.toContain("and this one too")
        // #255：tail 轮数翻倍（config tail_turns:4）后第三/四轮也进入保留窗——压缩输入不得包含它们
        expect(captured).not.toContain("third retained turn")
        expect(captured).not.toContain("fourth retained turn")
        expect(captured).not.toContain("What did we do so far?")
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          // #255：窗口翻倍——tail_turns 2→4 与 source DEFAULT_TAIL_TURNS 2→4 对齐，四轮保留窗
          config: cfg({ tail_turns: 4, preserve_recent_tokens: 10_000 }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "anchors repeated compactions with the previous summary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary one"))
      stub.push(
        reply("summary two", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "latest turn")
        yield* createCompactionMarker(session.id)

        // #242：process 输入必须走原始 messages——filterCompacted 会剔除无 summary 的
        // dangling marker（visibleCompactions 语义），用它锚 parentID 会挂错父消息
        msgs = yield* ssn.messages({ sessionID: session.id })
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toContain("<prior-summary>")
        expect(captured).toContain("summary one")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured.indexOf("latest turn")).toBeLessThan(captured.indexOf("<prior-summary>"))
        expect(captured).toContain("summary of the conversation before the <conversation> above")
        expect(captured).toContain("## Important Details")
        expect(captured).toContain("## Work State")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "keeps plugin context outside the serialized conversation",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).toContain("Prioritize unresolved migration details")
        expect(captured.indexOf("</conversation>")).toBeLessThan(
          captured.indexOf("Prioritize unresolved migration details"),
        )
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          plugin: compactionContext("Prioritize unresolved migration details"),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "serializes repeated compaction history as one user message",
    () => {
      const stub = llm()
      let captured: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary two", (input) => {
          captured = input.messages
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const turn = yield* createUserMessage(session.id, "original request")
        const kept = yield* createAssistantMessage(session.id, turn.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: kept.id,
          sessionID: session.id,
          type: "tool",
          callID: "read-call",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/index.ts" },
            output: "file contents",
            title: "src/index.ts",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })

        const previous = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: previous.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
          tail_start_id: kept.id,
        })
        yield* createSummaryAssistantMessage(session.id, previous.id, test.directory, "summary one")
        yield* createCompactionMarker(session.id)

        // #242：同上——第二次 process 以原始 messages 锚定新 marker
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toHaveLength(1)
        expect(captured[0]?.role).toBe("user")
        expect(JSON.stringify(captured)).toContain('[Assistant tool call]: read({\\"filePath\\":\\"src/index.ts\\"})')
        expect(JSON.stringify(captured)).toContain("[Tool result]: file contents")
        expect(JSON.stringify(captured)).not.toContain('\\"role\\":\\"assistant\\"')
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 0 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "updates compacted summaries without replaying already summarized head",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("PREVIOUS SUMMARY"))
      stub.push(
        reply("UPDATED SUMMARY", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const old = yield* createUserMessage(session.id, "OLD_HEAD_USER_SHOULD_NOT_REAPPEAR")
        const oldReply = yield* createAssistantMessage(session.id, old.id, test.directory)
        // #251：旧 head 里的大 tool result 模拟真实会话中已被 summary 覆盖的工具历史；
        // 第二次压缩必须只基于 compacted active window 更新 summary，不能把这段
        // #328：预算注释同步更新——引用新常量名避免读者按旧单一预算理解断言。
        // 审计/恢复用的 raw 历史重新上传，否则每条工具输出会按 head/tail 预算
        // 再次截断并累计，重新膨胀本应被压缩的上下文。
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: oldReply.id,
          sessionID: session.id,
          type: "tool",
          callID: "old-call",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "print old head" },
            output: `OLD_HEAD_TOOL_OUTPUT_SHOULD_NOT_REAPPEAR ${"x".repeat(4_000)}`,
            title: "print old head",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        })
        const active = yield* createUserMessage(session.id, "ACTIVE_TAIL_SHOULD_REMAIN")
        const activeReply = yield* createAssistantMessage(session.id, active.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: activeReply.id,
          sessionID: session.id,
          type: "text",
          text: "ACTIVE_TAIL_REPLY_SHOULD_REMAIN",
        })
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "LATEST_TAIL_SHOULD_STAY_OUT_OF_SUMMARY")
        yield* createCompactionMarker(session.id)

        msgs = yield* ssn.messages({ sessionID: session.id })
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        // #251：双条目锁定 active window 语义——prior summary 与本轮 tail 都在，
        // 已总结 head 与未纳入 tail 的新消息都必须缺席
        expect(captured).toContain("<prior-summary>")
        expect(captured).toContain("PREVIOUS SUMMARY")
        // 公开附录可回放，但不得进入下轮 prior-summary 再被模型重复总结。
        expect(captured).not.toContain("## Evidence Handoff")
        expect(captured).toContain("ACTIVE_TAIL_SHOULD_REMAIN")
        expect(captured).toContain("ACTIVE_TAIL_REPLY_SHOULD_REMAIN")
        expect(captured).not.toContain("OLD_HEAD_USER_SHOULD_NOT_REAPPEAR")
        expect(captured).not.toContain("OLD_HEAD_TOOL_OUTPUT_SHOULD_NOT_REAPPEAR")
        expect(captured).not.toContain("LATEST_TAIL_SHOULD_STAY_OUT_OF_SUMMARY")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 10_000 }) }))
    },
    { git: true },
  )

  itCompaction.instance("keeps recent pre-compaction turns across repeated compactions", () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* createUserMessage(session.id, "one")
      const u2 = yield* createUserMessage(session.id, "two")
      const u3 = yield* createUserMessage(session.id, "three")
      yield* createCompactionMarker(session.id)

      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const u4 = yield* createUserMessage(session.id, "four")
      yield* createCompactionMarker(session.id)

      // #242：同上——u4 后的新 marker 只在原始 messages 可见
      // #251：第二次 process 传原始消息（时间正序，与生产调用同形状）
      // 过滤由 process 内部的 filterCompacted 统一承担（与生产上传路径同一语义）
      msgs = yield* ssn.messages({ sessionID: session.id })
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const ids = filtered.map((msg) => msg.info.id)

      expect(ids).not.toContain(u1.id)
      expect(ids).not.toContain(u2.id)
      expect(ids).toContain(u3.id)
      expect(ids).toContain(u4.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      expect(
        filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
      ).toBe(true)
    }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
  })

  itCompaction.instance(
    "ignores previous summaries when sizing the retained tail",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older")
      // #251：anchor 是跨轮次持久的 tail 边界——下个 hunk 用它显式持久化压缩边界
      const anchor = yield* createUserMessage(session.id, "existing retained anchor")
      const keep = yield* createUserMessage(session.id, "keep this turn")
      const keepReply = yield* createAssistantMessage(session.id, keep.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: keepReply.id,
        sessionID: session.id,
        type: "text",
        text: "keep reply",
      })

      yield* createCompactionMarker(session.id)
      const firstCompactionMsg = (yield* ssn.messages({ sessionID: session.id })).at(-1)
      const firstCompaction = firstCompactionMsg?.info.id
      expect(firstCompaction).toBeTruthy()
      const firstCompactionPart = firstCompactionMsg?.parts.find(
        (item): item is SessionV1.CompactionPart => item.type === "compaction",
      )
      expect(firstCompactionPart?.type).toBe("compaction")
      // #251：显式模拟已完成且可重放的 compacted boundary：anchor 是上一轮 summary
      // 后仍需保留的 tail 起点；previous summary 文本本身很长，但它只是锚点，
      // 不能挤掉这个已持久化的 tail 边界。
      yield* ssn.updatePart({ ...firstCompactionPart!, tail_start_id: anchor.id })
      yield* createSummaryAssistantMessage(session.id, firstCompaction!, test.directory, "summary ".repeat(800))

      const recent = yield* createUserMessage(session.id, "recent turn")
      const recentReply = yield* createAssistantMessage(session.id, recent.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: recentReply.id,
        sessionID: session.id,
        type: "text",
        text: "recent reply",
      })

      yield* createCompactionMarker(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 500 }) })),
  )
})

describe("TokenEstimate.estimateText", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(TokenEstimate.estimateText(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(TokenEstimate.estimateText(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(TokenEstimate.estimateText("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("ignores malformed cost fields", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    })
    Object.assign(model.cost, { input: {} })

    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(1.5)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})

import { describe, expect } from "bun:test"
import { Directory } from "@/acp/directory"
import { ServiceFailureError } from "@/acp/error"
import { Command } from "@/command"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { it } from "../lib/effect"

const command = (name: string): Command.Info => ({
  name,
  source: "command",
  template: `run ${name}`,
  hints: [],
})

const model = (providerID: ProviderV2.ID, id: string, variants?: Directory.ModelVariants): Provider.Model => ({
  id: ModelV2.ID.make(id),
  providerID,
  api: {
    id,
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: id,
  family: "test",
  capabilities: {
    temperature: true,
    reasoning: Boolean(variants),
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: {
    context: 128000,
    output: 4096,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  ...(variants ? { variants } : {}),
})

const snapshot = (directory: string) => {
  const providerID = ProviderV2.ID.make(`provider-${directory}`)
  const modelID = ModelV2.ID.make(`model-${directory}`)
  const providers = {
    [providerID]: {
      id: providerID,
      name: `Provider ${directory}`,
      source: "config",
      env: [],
      options: {},
      models: {
        [modelID]: model(providerID, modelID, {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        }),
        [ModelV2.ID.make(`plain-${directory}`)]: model(providerID, `plain-${directory}`),
      },
    },
  } satisfies Record<ProviderV2.ID, Provider.Info>

  return Directory.build({
    directory,
    providers,
    modes: [
      { id: "build", name: `build-${directory}` },
      { id: "plan", name: `plan-${directory}`, description: "plan first" },
    ],
    defaultModeID: "build",
    commands: [command(`init-${directory}`), command(`review-${directory}`)],
    defaultModel: { providerID, modelID },
  })
}

const fakeLayer = (calls: string[]) =>
  LayerNode.compile(Directory.node, [
    [
      Directory.loaderNode,
      Layer.succeed(
        Directory.Loader,
        Directory.Loader.of({
          load: (directory) =>
            Effect.sync(() => {
              calls.push(directory)
              return snapshot(directory)
            }),
        }),
      ),
    ],
  ])

describe("ACP directory snapshot", () => {
  it.effect("two concurrent callers share one load", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const [first, second] = yield* Effect.all([directory.get("alpha"), directory.get("alpha")], {
        concurrency: "unbounded",
      })

      expect(calls).toEqual(["alpha"])
      expect(first).toBe(second)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.effect("warm calls use cached data", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const first = yield* directory.get("alpha")
      const second = yield* directory.get("alpha")

      expect(calls).toEqual(["alpha"])
      expect(first).toBe(second)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.live("retries interrupted loads without changing failure or refresh semantics", () => {
    const started = Deferred.makeUnsafe<void>()
    const refreshStarted = Deferred.makeUnsafe<void>()
    const releaseRefresh = Deferred.makeUnsafe<void>()
    // 每个目录独立计数，才能分别证明中断、typed failure、defect 与 refresh 的加载次数。
    const calls = new Map<string, number>()
    const layer = LayerNode.compile(Directory.node, [[
      Directory.loaderNode,
      Layer.succeed(Directory.Loader, Directory.Loader.of({
        load: (directory) => Effect.gen(function* () {
          const count = (calls.get(directory) ?? 0) + 1
          calls.set(directory, count)
          if (directory === "alpha" && count === 1) {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }
          if (directory === "typed") {
            // 使用公开 ACP typed error，避免 fixture 自身的 TypeError 被误判为业务 defect。
            return yield* Effect.fail(new ServiceFailureError({ safeMessage: "invalid config" }))
          }
          if (directory === "defect") return yield* Effect.die("broken loader")
          if (directory === "refresh" && count === 2) {
            // 第二次加载先暂停，确保并发 get 确实发生在新 snapshot 尚未完成时。
            yield* Deferred.succeed(refreshStarted, undefined)
            yield* Deferred.await(releaseRefresh)
          }
          return snapshot(directory)
        }),
      })),
    ]])
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const first = yield* directory.get("alpha").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)
      const recovered = yield* directory.get("alpha")
      expect(yield* directory.get("alpha")).toBe(recovered)
      expect(calls.get("alpha")).toBe(2)

      const typed1 = yield* Effect.exit(directory.get("typed"))
      const typed2 = yield* Effect.exit(directory.get("typed"))
      const defect1 = yield* Effect.exit(directory.get("defect"))
      const defect2 = yield* Effect.exit(directory.get("defect"))
      // typed failure 保持逐次重试，纯 defect 继续复用首次失败，不被统一清除。
      expect(Exit.isFailure(typed1) && Exit.isFailure(typed2)).toBe(true)
      expect(Exit.isFailure(defect1) && Exit.isFailure(defect2)).toBe(true)
      expect(calls.get("typed")).toBe(2)
      expect(calls.get("defect")).toBe(1)

      // 对象身份而非字段相等性用于证明 refresh 替换快照，后续 get 不读旧对象。
      const previous = yield* directory.get("refresh")
      const refreshing = yield* directory.refresh("refresh").pipe(Effect.forkChild)
      yield* Deferred.await(refreshStarted)
      const waiting = yield* directory.get("refresh").pipe(Effect.forkChild)
      yield* Deferred.succeed(releaseRefresh, undefined)
      const refreshed = yield* Fiber.join(refreshing)
      // refresh 期间的 get 必须加入新 generation，不能读取 refresh 前的快照。
      expect(yield* Fiber.join(waiting)).toBe(refreshed)
      expect(refreshed).not.toBe(previous)
      expect(calls.get("refresh")).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("different directories get different snapshots", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const [alpha, beta] = yield* Effect.all([directory.get("alpha"), directory.get("beta")], {
        concurrency: "unbounded",
      })

      expect(calls.toSorted()).toEqual(["alpha", "beta"])
      expect(alpha.directory).toBe("alpha")
      expect(beta.directory).toBe("beta")
      expect(alpha.defaultModel?.providerID).not.toBe(beta.defaultModel?.providerID)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.effect("model variant lookup works", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Service
      const alpha = yield* directory.get("alpha")
      const model = alpha.defaultModel!

      expect(directory.variants(alpha, model)).toEqual({
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      })
      expect(directory.variants(alpha, { ...model, modelID: ModelV2.ID.make("missing") })).toBeUndefined()
    }).pipe(Effect.provide(fakeLayer([]))),
  )

  it.effect("commands and modes are included", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Service
      const alpha = yield* directory.get("alpha")

      expect(alpha.availableCommands.map((item) => item.name)).toEqual(["init-alpha", "review-alpha"])
      expect(alpha.availableModes).toEqual([
        { id: "build", name: "build-alpha" },
        { id: "plan", name: "plan-alpha", description: "plan first" },
      ])
      expect(alpha.defaultModeID).toBe("build")
    }).pipe(Effect.provide(fakeLayer([]))),
  )

  it.effect("falls back when the default mode is not available", () =>
    Effect.sync(() => {
      expect(
        Directory.build({
          directory: "alpha",
          providers: {},
          modes: [
            { id: "build", name: "Build" },
            { id: "plan", name: "Plan" },
          ],
          defaultModeID: "hidden",
          commands: [],
        }).defaultModeID,
      ).toBe("build")
    }),
  )
})

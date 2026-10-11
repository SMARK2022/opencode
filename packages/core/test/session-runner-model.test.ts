import { describe, expect } from "bun:test"
import { LLM, ModelID } from "@opencode-ai/llm"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { DateTime, Effect, Schema, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { Token } from "@opencode-ai/core/util/token"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { CodexHeaders } from "@opencode-ai/core/plugin/provider/codex-headers"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ConfigProviderOptionsV1 } from "@opencode-ai/core/v1/config/provider-options"
import { it } from "./lib/effect"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
    },
    variants,
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

describe("SessionRunnerModel", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        // 与 Catalog 相同的真实 limit 进入 route.with/ModelLimits，避免只测手造 LLM Model。
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1", settings: { chunkTimeout: false } }),
          limit: { context: 204_800, input: 73_700, output: 20_000 },
        }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 204_800, input: 73_700, output: 20_000 },
          http: { body: { custom_extension: { enabled: true } }, chunkTimeout: false },
        },
      })
      // 不止断言 route defaults；真实 prepare 必须经过协议 Schema 发出 snake_case 字段。
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
      expect(prepared.body).toHaveProperty("parallel_tool_calls", true)
      // 关闭空闲期限只影响运输，不能作为OpenAI协议字段发出。
      expect(prepared.body).not.toHaveProperty("chunkTimeout")
      // request 的显式 false 位于 model 默认之后，不能被默认 true 再次覆盖。
      const serial = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello",
        providerOptions: { openai: { parallelToolCalls: false } },
      }))
      expect(serial.body).toHaveProperty("parallel_tool_calls", false)
      expect(serial.body).not.toHaveProperty("parallelToolCalls")
      // 上面的第三方路由保持原头；真实 OpenAI 的默认身份和显式 UA 均走同一 resolver。
      for (const userAgent of [undefined, "configured-agent"]) {
        const openai = yield* SessionRunnerModel.fromCatalogModel(ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          providerID: ProviderV2.ID.openai,
          request: {
            headers: Object.fromEntries([["x-custom", "kept"], ...(userAgent ? [["uSeR-aGeNt", userAgent]] : [])]),
            body: { apiKey: "secret" },
          },
        }))
        expect(openai.route.defaults.headers).toMatchObject({
          "content-type": "application/json",
          originator: "codex-tui",
          "user-agent": userAgent ?? CodexHeaders.USER_AGENT,
          "x-custom": "kept",
        })
        // 配置的身份不进入协议正文，也不会变成两个仅大小写不同的 UA 字段。
        expect(Object.keys(openai.route.defaults.headers ?? {}).filter(key => key.toLowerCase() === "user-agent")).toHaveLength(1)
        const prepared = yield* LLMClient.prepare(LLM.request({ model: openai, prompt: "Hello" }))
        expect(prepared.body).not.toHaveProperty("originator")
        expect(prepared.body).not.toHaveProperty("headers")
      }
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict", chunkTimeout: false },
          }),
          request: { headers: {}, body: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
      // 显式关闭能覆盖默认窗口，运输字段不能进入提供者 JSON。
      expect(resolved.route.defaults.http?.chunkTimeout).toBe(false)
      const compiled = yield* LLMClient.prepare(request)
      expect(compiled.body).not.toHaveProperty("chunkTimeout")
      const timed = yield* SessionRunnerModel.fromCatalogModel(model({
        type: "aisdk", package: "@ai-sdk/openai", settings: { chunkTimeout: 25 },
      }))
      expect(timed.route.defaults.http?.chunkTimeout).toBe(25)
      // 在唯一HTTP准备路径观察最终body，不把未合并HTTP扩展的protocol body当wire。
      const bodies: unknown[] = []
      for (const [provider, id, pkg, body] of [
        ["zai", "GLM-5.2", "@ai-sdk/openai-compatible", {}],
        ["zhipuai", "glm-5.2", "@ai-sdk/openai-compatible", { tool_stream: false }],
        ["zai", "glm-4", "@ai-sdk/openai-compatible", {}],
        ["other", "glm-5.2", "@ai-sdk/openai-compatible", {}],
        ["zai", "glm-5.2", "@ai-sdk/openai", {}],
      ] as const) {
        const fixture = model({ type: "aisdk", package: pkg, url: "https://compatible.example/v1" })
        const selected = yield* SessionRunnerModel.fromCatalogModel(ModelV2.Info.make({
          ...fixture, providerID: ProviderV2.ID.make(provider),
          api: { ...fixture.api, id: ModelV2.ID.make(id) },
          request: { ...fixture.request, body: { ...fixture.request.body, ...body } },
        }))
        const route = selected.route.with({ auth: selected.route.auth.andThen(Auth.custom(input => Effect.sync(() => {
          bodies.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(input.body))
          return input.headers
        }))) })
        yield* LLMClient.prepare(LLM.request({ model: route.model({ id: selected.id }), prompt: "Hello" }))
      }
      expect(bodies.slice(0, 2)).toMatchObject([{ model: "GLM-5.2", tool_stream: true }, { model: "glm-5.2", tool_stream: false }])
      // provider、API模型ID和包三个条件各自有效，目录别名不能误启用。
      for (const body of bodies.slice(2)) expect(body).not.toHaveProperty("tool_stream")
    }),
  )

  it.effect("overlays selected OpenAI Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {
            store: false,
            // variant 在模型解析前合并；关闭并行不能停留在 HTTP overlay。
            parallel_tool_calls: false,
            service_tier: "priority",
            temperature: 0.2,
            reasoning: { effort: "high" },
          },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        service_tier: "priority",
        temperature: 0.2,
        reasoning: { effort: "high" },
      })
      // 既有 HTTP body 全量断言保持，parallel 字段由新的 typed owner 负责发送。
      expect(resolved.route.defaults.providerOptions?.openai?.parallelToolCalls).toBe(false)
      expect(resolved.route.defaults.http?.body).not.toHaveProperty("parallel_tool_calls")
      // 原 fixture 仅保证 body 合并；执行时 temperature overlay 必须仍被 transport 拒绝。
      const rejected = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" })).pipe(Effect.flip)
      expect(rejected.reason).toMatchObject({ _tag: "InvalidRequest", message: "http.body cannot overlay protocol-owned field(s): temperature" })
      // 并行测试使用合法 variant；已知协议的温度改从 typed Generation 输入，不改生产解析器。
      const executable = yield* SessionRunnerModel.resolve(session,
        ModelV2.Info.make({ ...catalog,
          variants: catalog.variants.map((variant) => ({
            ...variant, body: Object.fromEntries(Object.entries(variant.body).filter(([key]) => key !== "temperature")),
          })),
        }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({
        model: executable, prompt: "Hello", generation: { temperature: 0.2 },
      }))
      expect(prepared.body).toHaveProperty("parallel_tool_calls", false)
      expect(prepared.body).toHaveProperty("temperature", 0.2)
      // 在唯一HTTP准备链观察最终body，prepare.body尚未合并合法的HTTP扩展。
      for (const serviceTier of ["ultrafast", "priority", undefined] as const) {
        const selected = yield* SessionRunnerModel.resolve(serviceTier === undefined ? SessionV2.Info.make({ ...session, model: { id: catalog.id, providerID: catalog.providerID } }) : session, ModelV2.Info.make({
          ...catalog, variants: catalog.variants.map(variant => ({
            ...variant, body: ConfigProviderOptionsV1.get("@ai-sdk/openai").request({ ...(serviceTier === undefined ? {} : { serviceTier }), reasoningEffort: "high" }),
          })),
        }))
        const route = selected.route.with({ auth: selected.route.auth.andThen(Auth.custom(input => Effect.sync(() => {
          const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(input.body)
          serviceTier === undefined
            ? expect(body).not.toHaveProperty("service_tier")
            : expect(body).toHaveProperty("service_tier", serviceTier)
          return input.headers
        }))) })
        yield* LLMClient.prepare(LLM.request({ model: route.model({ id: selected.id }), prompt: "Hello" }))
      }
    }),
  )

  it.effect("overlays selected OpenAI-compatible Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("rejects an explicit unavailable Session variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_unavailable"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const failure = yield* SessionRunnerModel.resolve(session, catalog).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("overlays selected Anthropic Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: { thinking: { type: "enabled", budget_tokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        thinking: { type: "enabled", budget_tokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret", metadata: { tenant: "work" } })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" } },
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("does not project OAuth account metadata into the request body", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("estimates each stream after catalog system defaults are lowered", () =>
    Effect.gen(function* () {
      const client = yield* LLMClient.Service
      const estimates: ReturnType<typeof Token.estimateRequest>[] = []
      const calls = { prepare: 0, frames: 0 }
      for (const raw of ["", "x".repeat(8000)]) {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(
          ModelV2.Info.make({
            ...model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
            providerID: ProviderV2.ID.make("claudecode"),
            request: { headers: {}, body: { apiKey: "fixture", system: raw } },
            limit: { context: 100_000, output: 20 },
          }),
        )
        expect(resolved.id).toBe(ModelID.make("api-test-model"))
        expect(resolved.route.defaults.limits?.context).toBe(100_000)
        const route = resolved.route.with({
          transport: {
            ...resolved.route.transport,
            prepare(input) {
              calls.prepare++
              return resolved.route.transport.prepare(input)
            },
            frames() {
              calls.frames++
              expect(estimates).toHaveLength(calls.frames)
              return Stream.empty
            },
          },
        })
        const input = LLM.request({
          model: route.model({ id: resolved.id }),
          http: { body: { metadata: { fixture: raw } } },
          system: "Session system", prompt: "hello", cache: "none",
          tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
          providerOptions: { anthropic: { thinking: { type: "disabled" } } },
        })
        expect(input.providerOptions?.anthropic?.system).toBeUndefined()
        yield* client.stream(input, (body) => Effect.sync(() => {
          estimates.push(Token.estimateRequest(body, [], [{ kind: "instructions", text: "Session system" }]))
          expect(body).toMatchObject({
            system: expect.arrayContaining([{ type: "text", text: "Session system" }, { type: "text", text: raw }]),
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            tools: expect.arrayContaining([{ name: "echo", description: "Echo", input_schema: { type: "object", properties: { text: { type: "string" } } } }]),
          })
          // metadata 与 system 同增 8000，估算仍只增长正文的 8000；运输附加字段不能再计一遍。
          expect(body).not.toHaveProperty("metadata.fixture")
        })).pipe(Stream.runDrain)
      }
      expect(calls).toEqual({ prepare: 2, frames: 2 })
      expect(estimates).toHaveLength(2)
      expect(Math.max(...estimates.map(item => item.bodyChars)) - Math.min(...estimates.map(item => item.bodyChars))).toBe(8000)
      expect(Math.max(...estimates.map(item => item.input)) - Math.min(...estimates.map(item => item.input))).toBe(2000)
      // 协议正文只增长模型默认system；8000增量与固定指令14分别归桶，运输metadata不参与。
      expect(estimates[1]?.inputBreakdown?.system).toBe((estimates[0]?.inputBreakdown?.system ?? 0) + 8000)
      expect(estimates.map(item => item.inputBreakdown?.instructions)).toEqual([14, 14])
      expect(estimates.map(item => item.charsPerToken)).toEqual([4, 4])
      expect(estimates.every(item => (item.inputBreakdown?.tools ?? 0) > 0)).toBe(true)
    }).pipe(
      Effect.provide(LLMClient.layer),
      Effect.provideService(RequestExecutor.Service, { execute: () => Effect.die("Prepared fixture must not send provider IO") }),
    ),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
      expect(failure.message).toBe("Unsupported API for test-provider/test-model: aisdk:@ai-sdk/google")
    }),
  )

  it.effect("reports whether a catalog model has a supported native route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )
})

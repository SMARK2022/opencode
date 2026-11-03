import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { Integration } from "@opencode-ai/core/integration"
import { Credential } from "@opencode-ai/core/credential"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLM, LLMClient, ModelID, ProviderID, type Model } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { AnthropicMessages } from "@opencode-ai/llm/protocols/anthropic-messages"
import { HttpClientRequest } from "effect/unstable/http"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { PermissionReviewer } from "@opencode-ai/core/permission/reviewer"
import { PermissionReviewerPrompt } from "@opencode-ai/core/permission/reviewer/prompt"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { AgentV2 } from "@opencode-ai/core/agent"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("binds native reviewer instructions to the selected OAuth identity and final wire body", () =>
    withEnv({ NATIVE_REVIEW_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const location = yield* Location.Service
        const agents = yield* AgentV2.Service
        let selected = "openai"
        let reviewing = true
        const id = ModelV2.ID.make("review-model")
        const methodID = Integration.MethodID.make("review-oauth")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  approvals_reviewer: "auto_review",
                  auto_review: { model: `${selected}/${id}`, policy: "TRUSTED_TENANT_POLICY" },
                  providers: {
                    "review-direct": { extends: "openai" },
                    "review-late": { extends: "openai" },
                    "review-nested": { extends: "review-direct" },
                    "review-switch": { extends: "openai" },
                  },
                }),
              }),
              // 后层只改名称不能清掉直接继承；明确换基础则必须改变资格。
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    "review-late": {
                      name: "Later",
                      api: {
                        settings: { codexApiEndpoint: "https://custom-codex.fixture.invalid/responses?tenant=fixture" },
                      },
                    },
                    "review-switch": { extends: "review-spoof" },
                  },
                }),
              }),
            ]),
        })
        yield* integrations.transform((draft) => {
          for (const provider of ["openai", "review-spoof"]) {
            const integrationID = Integration.ID.make(provider)
            draft.method.update({ integrationID, method: { type: "key", label: "Fixture key" } })
            draft.method.update({ integrationID, method: { type: "env", names: ["NATIVE_REVIEW_KEY"] } })
            draft.method.update({
              integrationID,
              method: { type: "oauth", id: methodID, label: "Fixture OAuth" },
              authorize: () => Effect.die("Fixture must not authorize"),
              refresh: () => Effect.die("Fixture must not refresh"),
            })
          }
        })
        yield* catalog.transform((draft) => {
          for (const provider of ["openai", "review-spoof"]) {
            const providerID = ProviderV2.ID.make(provider)
            draft.provider.update(providerID, (value) => {
              value.integrationID = Integration.ID.make(provider)
              value.api = { type: "aisdk", package: "@ai-sdk/openai", url: "https://api.openai.com/v1", settings: {} }
              value.request.body = { apiKey: "configured-key" }
            })
            draft.model.update(providerID, id, (value) => {
              value.api.id = ModelV2.ID.make("gpt-5")
              // 相同SDK、URL和身份头不能让自定义OAuth冒充OpenAI。
              value.request.headers = { originator: "codex-tui" }
              value.request.body = { instructions: "MODEL_RAW_POLICY", custom_extension: { kept: true } }
              value.request.variant = ModelV2.VariantID.make("review-variant")
              value.variants = [
                {
                  id: ModelV2.VariantID.make("review-variant"),
                  headers: {},
                  body: { instructions: "VARIANT_RAW_POLICY" },
                },
              ]
              value.capabilities.tools = true
              value.limit = { context: 128000, output: 4096 }
            })
          }
        })
        const plugin = yield* PluginV2.Service
        const host = yield* PluginHost.make(plugin)
        yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
        const Wire = Schema.Struct({
          instructions: Schema.optional(Schema.String),
          input: Schema.Array(Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.Unknown })),
          custom_extension: Schema.optional(Schema.Unknown),
        })
        const bodies: (typeof Wire.Type)[] = []
        const prepared: (typeof Wire.Type)[] = []
        const texts: string[] = []
        const auth: string[] = []
        const urls: string[] = []
        const accounts: (string | null)[] = []
        const accepted = {
          outcome: "allow",
          rationale: "bounded fixture",
          risk_level: "low",
          user_authorization: "high",
        }
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
              const text = yield* Effect.promise(() => web.text())
              bodies.push(Schema.decodeUnknownSync(Schema.fromJsonString(Wire))(text))
              texts.push(text)
              auth.push(web.headers.get("authorization") ?? "")
              urls.push(web.url)
              accounts.push(web.headers.get("chatgpt-account-id"))
              // 第一轮缺少裁决触发真实一次修复；第二轮经Responses解析真实tool call。
              const events = !reviewing
                ? [
                    { type: "response.created", response: { id: "resp_normal", created_at: 0, model: "gpt-5" } },
                    {
                      type: "response.output_text.delta",
                      item_id: "text",
                      output_index: 0,
                      content_index: 0,
                      delta: "NORMAL_WIRE_RESPONSE",
                    },
                    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
                  ]
                : bodies.length === 1
                  ? [
                      { type: "response.created", response: { id: "resp_first", created_at: 0, model: "gpt-5" } },
                      {
                        type: "response.output_text.delta",
                        item_id: "text",
                        output_index: 0,
                        content_index: 0,
                        delta: "Missing decision",
                      },
                      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
                    ]
                  : [
                      { type: "response.created", response: { id: "resp_second", created_at: 0, model: "gpt-5" } },
                      {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                          type: "function_call",
                          id: "fc_review",
                          call_id: "call_review",
                          name: "permission_review_decision",
                          arguments: "",
                        },
                      },
                      {
                        type: "response.function_call_arguments.delta",
                        item_id: "fc_review",
                        output_index: 0,
                        delta: JSON.stringify(accepted),
                      },
                      {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                          type: "function_call",
                          id: "fc_review",
                          call_id: "call_review",
                          name: "permission_review_decision",
                          arguments: JSON.stringify(accepted),
                          status: "completed",
                        },
                      },
                      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
                    ]
              return HttpClientResponse.fromWeb(
                request,
                new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                  headers: { "content-type": "text/event-stream" },
                }),
              )
            }),
          ),
        )
        const client = Layer.effect(
          LLMClient.Service,
          Effect.gen(function* () {
            const actual = yield* LLMClient.Service
            return LLMClient.Service.of({
              ...actual,
              stream: (request) =>
                actual.stream(request, (body) =>
                  Effect.sync(() => prepared.push(Schema.decodeUnknownSync(Wire)(body))),
                ),
            })
          }),
        ).pipe(Layer.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))))
        const graph = AppNodeBuilder.build(
          LayerNode.group([Database.node, SessionStore.node, PermissionReviewer.node, node]),
          [
            [Catalog.node, Layer.succeed(Catalog.Service, catalog)],
            [Integration.node, Layer.succeed(Integration.Service, integrations)],
            [Config.node, Layer.succeed(Config.Service, config)],
            [Location.node, Layer.succeed(Location.Service, location)],
            [LayerNodePlatform.llmClient, client],
            [AgentV2.node, Layer.succeed(AgentV2.Service, agents)],
            [Snapshot.node, Layer.mock(Snapshot.Service, { capture: () => Effect.succeed(undefined) })],
          ],
        )
        yield* Effect.gen(function* () {
          const database = yield* Database.Service
          const reviewer = yield* PermissionReviewer.Service
          const sessionID = SessionSchema.ID.make("ses_native_oauth_wire")
          yield* database.db
            .insert(ProjectTable)
            .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: ProjectV2.ID.global,
              slug: "fixture",
              directory: location.directory,
              title: "Fixture",
              version: "test",
              agent: "build",
              model: { id, providerID: "openai" },
            })
            .run()
            .pipe(Effect.orDie)
          const evidence = { time: { created: 1 }, text: "TRANSCRIPT_EVIDENCE" }
          yield* database.db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make("msg_native_oauth_evidence"),
              session_id: sessionID,
              type: "user",
              seq: 1,
              data: evidence,
            })
            .run()
            .pipe(Effect.orDie)
          const save = (provider: string, type: "key" | "oauth") =>
            credentials.create({
              integrationID: Integration.ID.make(provider),
              value:
                type === "key"
                  ? Credential.Key.make({ type: "key", key: `stored-key-${provider}` })
                  : Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access: `access-${provider}`,
                      refresh: "REFRESH_SECRET",
                      expires: Number.MAX_SAFE_INTEGER,
                      metadata: { accountID: `account-${provider}`, credential_marker: "OAUTH_METADATA" },
                    }),
            })
          const expected = PermissionReviewerPrompt.buildSystemPrompt(
            `${PermissionReviewerPrompt.DEFAULT_TENANT_POLICY}\n\nTRUSTED_TENANT_POLICY`,
          )
          const cases = [
            { provider: "openai", type: "oauth", promote: true },
            { provider: "openai", type: "key", promote: false },
            { provider: "openai", type: "env", promote: false },
            { provider: "openai", type: "config", promote: false },
            { provider: "review-spoof", type: "oauth", promote: false },
            // 基础和别名的凭据交叉，锁定本次实际选择，不能偷用基础账号。
            { provider: "review-direct", type: "oauth", base: "key", promote: true },
            { provider: "review-direct", type: "key", base: "oauth", promote: false },
            { provider: "review-late", type: "oauth", promote: true },
            { provider: "review-nested", type: "oauth", promote: false },
            { provider: "review-switch", type: "oauth", promote: false },
          ] as const
          for (const scenario of cases) {
            selected = scenario.provider
            if (scenario.type === "env") process.env.NATIVE_REVIEW_KEY = "environment-key"
            else delete process.env.NATIVE_REVIEW_KEY
            for (const value of yield* credentials.list(Integration.ID.make(selected)))
              yield* credentials.remove(value.id)
            if ("base" in scenario) yield* save("openai", scenario.base)
            if (scenario.type === "key" || scenario.type === "oauth") yield* save(selected, scenario.type)
            bodies.length = prepared.length = texts.length = auth.length = urls.length = accounts.length = 0
            expect(
              yield* reviewer.review({
                sessionID,
                reviewID: `review_${selected}_${scenario.type}`,
                permission: "bash",
                patterns: ["PLANNED_ACTION"],
                metadata: { command: "COMMAND_EVIDENCE $HOME > out", cwd: location.directory },
                precheck: { level: "cautious", reason: "PRECHECK_EVIDENCE" },
              }),
            ).toMatchObject({ action: "allow" })
            expect(bodies).toHaveLength(2)
            expect(prepared).toHaveLength(2)
            for (const [index, body] of bodies.entries()) {
              // 同时核对lowering与最终HTTP正文，禁止raw overlay重新抢回策略字段。
              expect(body.instructions).toBe(scenario.promote ? expected : "VARIANT_RAW_POLICY")
              expect(prepared[index]?.instructions).toBe(body.instructions)
              expect(body.input.some((item) => item.role === "system" || item.role === "developer")).toBe(
                !scenario.promote,
              )
              if (!scenario.promote)
                expect(
                  body.input
                    .filter((item) => item.role === "system" || item.role === "developer")
                    .map((item) => JSON.stringify(item.content))
                    .join("\n"),
                ).toContain("TRUSTED_TENANT_POLICY")
              const evidence = body.input
                .filter((item) => item.role === "user")
                .map((item) => JSON.stringify(item.content))
                .join("\n")
              for (const value of [
                "TRANSCRIPT_EVIDENCE",
                "PLANNED_ACTION",
                "COMMAND_EVIDENCE $HOME > out",
                "PRECHECK_EVIDENCE",
              ]) {
                expect(evidence).toContain(value)
                expect(body.instructions).not.toContain(value)
              }
              expect(evidence.includes(PermissionReviewerPrompt.PROTOCOL_RETRY_TEXT)).toBe(index === 1)
              expect(body.instructions).not.toContain(PermissionReviewerPrompt.PROTOCOL_RETRY_TEXT)
              expect(body.custom_extension).toEqual({ kept: true })
              expect(urls[index]).toBe(
                !scenario.promote
                  ? "https://api.openai.com/v1/responses"
                  : selected === "review-late"
                    ? "https://custom-codex.fixture.invalid/responses?tenant=fixture"
                    : "https://chatgpt.com/backend-api/codex/responses",
              )
              expect(accounts[index]).toBe(scenario.promote ? `account-${selected}` : null)
              // token只进入真实认证头；OAuth metadata与refresh绝不混进模型JSON。
              for (const secret of [
                "access-",
                "REFRESH_SECRET",
                "OAUTH_METADATA",
                "configured-key",
                "environment-key",
                "stored-key-",
              ])
                expect(texts[index]).not.toContain(secret)
              expect(auth[index]).toBe(
                `Bearer ${scenario.type === "oauth" ? `access-${selected}` : scenario.type === "key" ? `stored-key-${selected}` : scenario.type === "env" ? "environment-key" : "configured-key"}`,
              )
            }
          }
          // 同一真实resolver还服务普通turn和手动摘要，不能只认证审查器的专属请求。
          reviewing = false
          selected = "openai"
          yield* save(selected, "oauth")
          yield* agents.transform((draft) =>
            draft.update(AgentV2.ID.make("build"), (value) => {
              value.system = "NORMAL_SYSTEM_POLICY"
            }),
          )
          const runner = yield* SessionRunner.Service
          for (const maintenance of [undefined, "compact"] as const) {
            bodies.length = prepared.length = texts.length = auth.length = urls.length = accounts.length = 0
            yield* runner.run({ sessionID, force: true, ...(maintenance ? { maintenance } : {}) })
            expect(bodies).toHaveLength(1)
            expect(bodies[0]?.instructions).toContain("NORMAL_SYSTEM_POLICY")
            expect(bodies[0]?.instructions).not.toContain("TRANSCRIPT_EVIDENCE")
            expect(bodies[0]?.input.some((item) => item.role === "system" || item.role === "developer")).toBe(false)
            expect(urls[0]).toBe("https://chatgpt.com/backend-api/codex/responses")
            expect(accounts[0]).toBe("account-openai")
            expect(texts[0]).toContain(maintenance ? "NORMAL_WIRE_RESPONSE" : "TRANSCRIPT_EVIDENCE")
          }
        }).pipe(Effect.provide(graph))
      }),
    ),
  )
  it.effect("inherits alias authentication without sharing credentials or refresh ownership", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const base = Integration.ID.make("base-auth")
      const alternate = Integration.ID.make("alternate-auth")
      const first = Integration.ID.make("account-a")
      const second = Integration.ID.make("account-b")
      const only = Integration.ID.make("oauth-copy")
      const methodID = Integration.MethodID.make("account-oauth")
      yield* integrations.transform((draft) => {
        draft.method.update({ integrationID: base, method: { type: "key", label: "API key" } })
        draft.method.update({ integrationID: alternate, method: { type: "key", label: "Alternate key" } })
        for (const integrationID of [base, Integration.ID.make("oauth-only")]) {
          draft.method.update({
            integrationID,
            method: { type: "oauth", id: methodID, label: "Account OAuth" },
            authorize: () =>
              Effect.succeed({
                mode: "code" as const,
                url: "https://auth.example.test/authorize",
                instructions: "Paste the code",
                callback: (code: string) =>
                  Effect.succeed(
                    Credential.OAuth.make({ type: "oauth", methodID, access: code, refresh: "refresh", expires: 0 }),
                  ),
              }),
            refresh: (value) =>
              Effect.succeed(
                Credential.OAuth.make({
                  ...value,
                  access: `${value.access}-refreshed`,
                  expires: Number.MAX_SAFE_INTEGER,
                }),
              ),
          })
        }
      })
      // 测试只注册本地确定性方法，正式连接与刷新仍走真实服务，不调用外部授权。
      yield* integrations.connection.key({ integrationID: base, key: "base-key" })
      const baseCredentials = yield* credentials.list(base)
      yield* addPlugin(
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    "account-a": { extends: base, env: [] },
                    "account-b": { extends: base },
                    "oauth-copy": { extends: "oauth-only" },
                    switched: { extends: base },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({ providers: { switched: { extends: alternate } } }),
              }),
            ]),
        }),
      )
      for (const id of [first, second, only]) {
        const info = required(yield* integrations.get(id))
        expect(info.methods.filter((method) => method.type === "oauth").map((method) => method.id)).toEqual([methodID])
      }
      expect((yield* integrations.get(first))?.methods).toContainEqual({ type: "key", label: "API key" })
      expect((yield* integrations.get(first))?.methods).toContainEqual({ type: "env", names: [] })
      expect(
        (yield* integrations.get(Integration.ID.make("switched")))?.methods.filter((method) => method.type === "oauth"),
      ).toEqual([])
      // 空环境只禁用环境查找；两个别名分别通过正式 key 入口保存自身密钥。
      yield* integrations.connection.key({ integrationID: first, key: "first-key" })
      expect((yield* credentials.list(first))[0]?.value).toEqual(Credential.Key.make({ type: "key", key: "first-key" }))
      yield* integrations.connection.key({ integrationID: second, key: "second-key" })
      const secondCredentials = yield* credentials.list(second)
      // 完成与刷新都保留别名 ID 和 methodID，基础账号及另一别名保持原记录。
      const attempt = yield* integrations.connection.oauth({ integrationID: first, methodID, inputs: {} })
      yield* integrations.attempt.complete({ attemptID: attempt.attemptID, code: "first-access" })
      const before = required((yield* credentials.list(first))[0])
      expect(before.integrationID).toBe(first)
      const connection = required(yield* integrations.connection.active(first))
      expect(yield* integrations.connection.resolve(connection)).toMatchObject({
        type: "oauth",
        methodID,
        access: "first-access-refreshed",
      })
      expect((yield* credentials.list(first))[0]).toMatchObject({
        id: before.id,
        integrationID: first,
        value: { access: "first-access-refreshed" },
      })
      expect(yield* credentials.list(base)).toEqual(baseCredentials)
      expect(yield* credentials.list(second)).toEqual(secondCredentials)
      yield* integrations.reload()
      expect(
        (yield* integrations.get(first))?.methods
          .filter((method) => method.type === "oauth")
          .map((method) => method.id),
      ).toEqual([methodID])
    }),
  )

  it.effect("preserves configured API keys through availability and native authentication", () =>
    Effect.forEach([undefined, "2.1.200"], (version) =>
      Effect.forEach(["fallback-key", undefined], (cc) =>
        withEnv({ ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, CLAUDECODE_API_KEY: cc }, () =>
          Effect.gen(function* () {
            const catalog = yield* Catalog.Service
            const integrations = yield* Integration.Service
            // 同时覆盖未决 SDK 与显式 SDK 的继承配置，空连接不能掩盖凭据缺失。
            const providers = [
              ProviderV2.ID.anthropic,
              ...(cc === undefined ? [] : [ProviderV2.ID.make("claudecode")]),
              ProviderV2.ID.make("explicit-anthropic"),
              ProviderV2.ID.make("explicit-claudecode"),
              ProviderV2.ID.make("cubence"),
            ]
            const id = ModelV2.ID.make("configured")
            // 与 models.dev 一样保留无连接的 Integration，不能靠无认证记录绕过 available。
            yield* integrations.transform((draft) => {
              for (const provider of providers)
                draft.update(Integration.ID.make(provider), (value) => {
                  value.name = provider
                })
            })
            yield* catalog.transform((draft) => {
              draft.provider.remove(ProviderV2.ID.make("claudecode"))
              for (const provider of providers.filter((provider) => provider !== "cubence")) {
                draft.provider.update(provider, (value) => {
                  value.api = {
                    type: "aisdk",
                    package: "@ai-sdk/anthropic",
                    url: "https://configured.test/v1",
                    settings: {},
                  }
                })
                draft.model.update(provider, id, (value) => {
                  value.api.id = ModelV2.ID.make("claude-sonnet-4-5")
                  value.limit = { context: 200_000, output: 8192 }
                  value.cost = [{ input: 1, output: 2, cache: { read: 0.1, write: 1 } }]
                })
              }
            })
            const info = ConfigMigrateV1.migrate(
              Schema.decodeUnknownSync(ConfigV1.Info)({
                provider: Object.fromEntries(
                  providers.map((provider) => [
                    provider,
                    {
                      ...(provider.startsWith("explicit-")
                        ? { extends: provider.slice("explicit-".length), npm: "@ai-sdk/anthropic" }
                        : provider === "cubence"
                          ? { extends: "claudecode" }
                          : {}),
                      options: { apiKey: "configured-key", version },
                    },
                  ]),
                ),
              }),
            )
            const config = Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: decode(info) })]),
            })
            yield* addPlugin(config)
            if (cc === undefined) expect(yield* catalog.provider.get(ProviderV2.ID.make("claudecode"))).toBeUndefined()
            const resolver = yield* SessionRunnerModel.Service.pipe(
              Effect.provide(
                SessionRunnerModel.locationLayer.pipe(Layer.provide(Layer.succeed(Config.Service, config))),
              ),
            )
            for (const provider of providers) {
              const claudecode = ["claudecode", "explicit-claudecode", "cubence"].includes(provider)
              const inherited = required(yield* catalog.model.get(provider, id))
              expect(inherited.id).toBe(id)
              expect(inherited.providerID).toBe(provider)
              expect(inherited.api).toMatchObject({
                id: "claude-sonnet-4-5",
                type: "aisdk",
                package: "@ai-sdk/anthropic",
              })
              expect(inherited.api.settings?.version).toBe(version)
              expect(ProviderV2.isClaudeCode(inherited)).toBe(claudecode)
              expect((yield* integrations.get(Integration.ID.make(provider)))?.connections).toEqual([])
              expect(
                (yield* catalog.model.available()).some((model) => model.providerID === provider && model.id === id),
              ).toBe(true)
              const selection = yield* resolver.resolve(
                SessionSchema.Info.make({
                  id: SessionSchema.ID.make("ses_config_key"),
                  projectID: ProjectV2.ID.global,
                  title: "test",
                  cost: 0,
                  model: { providerID: provider, id },
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                  location: { directory: AbsolutePath.make("/project") },
                }),
              )
              const selected = selection.model
              expect(selected.id).toBe(ModelID.make("claude-sonnet-4-5"))
              expect(selected.provider).toBe(ProviderID.make(provider))
              expect(selected.route.id).toBe("anthropic-messages")
              expect(selected.route.defaults.providerOptions?.anthropic?.version).toBe(claudecode ? version : undefined)
              expect(selection.pricing).toEqual([{ input: 1, output: 2, cache: { read: 0.1, write: 1 } }])
              const input = LLM.request({
                model: selected,
                prompt: "hello",
                cache: "none",
                providerOptions: selected.route.defaults.providerOptions,
                http: { ...selected.route.defaults.http, headers: selected.route.defaults.headers },
              })
              const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(input).pipe(
                Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
              )
              const wire = yield* AnthropicMessages.route
                .with({ endpoint: selected.route.endpoint, auth: selected.route.auth })
                .prepareTransport(prepared.body, input)
              const web = yield* HttpClientRequest.toWeb(wire.request).pipe(Effect.orDie)
              expect(web.headers.get(claudecode ? "authorization" : "x-api-key")).toBe(
                claudecode ? `Bearer ${cc ?? "configured-key"}` : "configured-key",
              )
              expect(web.headers.has(claudecode ? "x-api-key" : "authorization")).toBe(false)
              // 检查真正编码的请求，内部可用性信号不能成为发送给模型的密钥正文。
              const body = yield* Effect.promise(() => web.text())
              expect(body).not.toContain("configured-key")
              expect(body).not.toContain("fallback-key")
              expect(body).not.toContain('"version":')
              if (claudecode) {
                expect(body).toContain(`cc_version=${version ?? "2.1.117"}.`)
                expect(web.headers.get("user-agent")).toBe(`claude-cli/${version ?? "2.1.117"} (external, cli)`)
              }
            }
          }),
        ),
      ),
    ),
  )

  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          // 基础模型的嵌套 metadata 和数组分别检验深合并与整体替换。
                          request: {
                            ...request({ first: "first", shared: "first" }, "retained"),
                            body: { metadata: { base: "keep", shared: "base" }, items: ["base"] },
                          },
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                    plain: {
                      request: { body: { nested: { first: true } } },
                      models: { chat: { request: { body: { metadata: { first: true } } } } },
                    },
                    // B 与 A 的模型集合不重叠，切换后必须删除 A 的自动继承模型。
                    "base-b": {
                      name: "Base B",
                      api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://base-b.test" },
                      models: { beta: { name: "Beta" } },
                    },
                    // 首次即无鉴权的派生不能创建空授权记录，须可被 Location resolver 使用。
                    guest: { extends: "base-b" },
                    "anthropic-base": {
                      api: { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.test/v1" },
                      models: { claude: { api: { id: "claude-sonnet-4-5" } } },
                    },
                    // 无显式 env 的派生先继承 A 的可用密钥，后层切到无 env 的 B 必须清除。
                    auto: { extends: "custom" },
                    switched: {
                      extends: "custom",
                      name: "Switched",
                      env: ["CUSTOM_API_KEY"],
                      // 显式模型、API、名称和 variant 是配置层，换基础后仍然有效。
                      models: {
                        kept: {
                          name: "Kept",
                          api: { id: "remote-kept", type: "aisdk", package: "kept-sdk", url: "https://kept.test" },
                          limit: { context: 500, output: 100 },
                          variants: [{ id: "retained", headers: { first: "yes" }, body: { first: true } }],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                    // 真实 V1 解码和迁移后再过 V2 schema，不能直接伪造 extends 的输出。
                    ...ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          mirror: {
                            extends: "custom",
                            npm: "@ai-sdk/openai-compatible",
                            api: "https://mirror.test",
                            options: { headers: { mirror: "yes" } },
                            models: {
                              // 模型专用 npm/URL 在后层 provider URL 更新后仍优先。
                              chat: {
                                provider: { npm: "@ai-sdk/anthropic", api: "https://model-only.test" },
                                options: { metadata: { child: "add", shared: "child" }, items: ["child"] },
                                variants: { fast: { model_flag: true } },
                              },
                              // 无 npm 的 URL-only 覆盖分别接纳新模型默认协议与已有模型别名。
                              urlonly: { provider: { api: "https://url-only.test" } },
                              alias: { id: "default", provider: { api: "https://alias-only.test" } },
                            },
                          },
                        },
                      }),
                    ).providers,
                    // provider/model 均不指定 npm，让迁移输入真正等到基础 Anthropic API 已知。
                    ...ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          "anthropic-copy": {
                            extends: "anthropic-base",
                            options: {
                              authToken: "old-token",
                              baseURL: "https://anthropic-low.test/v1",
                              region: "low",
                              headers: { "x-layer": "low" },
                              body: { extension: { base: "keep", shared: "low" }, items: ["low"] },
                            },
                            models: {
                              claude: {
                                options: { metadata: { base: "keep", userId: "model-user" } },
                                variants: { high: { metadata: { userId: "variant-user" } } },
                              },
                            },
                          },
                          "native-override": {
                            extends: "anthropic-base",
                            options: { baseURL: "https://low.test/v1", region: "low" },
                          },
                        },
                      }),
                    ).providers,
                    // 未使用的普通 native V1 配置必须保留 raw options/variants，不能阻断整个 catalog。
                    ...ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          // 同时覆盖文档延迟保留的凭据、模型选项与变体，检查最终消费者而非仅中间形状。
                          "unresolved-key": {
                            options: { apiKey: "secret" },
                            models: {
                              model: { options: { reasoningEffort: "high" }, variants: { fast: { temperature: 0.2 } } },
                            },
                          },
                          "ordinary-native": {
                            models: {
                              empty: { options: {} },
                              raw: {
                                options: { metadata: { userId: "ordinary-user" } },
                                variants: { high: { metadata: { userId: "ordinary-variant" } } },
                              },
                            },
                          },
                          "native-copy": {
                            extends: "ordinary-native",
                            models: {
                              raw: {
                                options: { metadata: { userId: "native-user" } },
                                variants: { high: { metadata: { userId: "native-variant" } } },
                              },
                            },
                          },
                        },
                      }),
                    ).providers,
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "switched/kept",
                  providers: {
                    custom: { name: "Renamed" },
                    plain: {
                      request: { body: { nested: { last: true } } },
                      models: { chat: { request: { body: { metadata: { last: true } } } } },
                    },
                    "native-override": {
                      api: {
                        type: "aisdk",
                        package: "@ai-sdk/anthropic",
                        url: "https://high.test/v1",
                        settings: { region: "high" },
                      },
                    },
                    // 后层名称覆盖不应重置之前继承的模型与环境方法。
                    mirror: {
                      name: "Mirror",
                      api: { url: "https://mirror-later.test" },
                      models: { urlonly: { api: { settings: { region: "override" } } } },
                    },
                    // 后层切到 B，并更新 provider URL；旧显式 API 与分层 variant 仍须保留。
                    switched: {
                      extends: "base-b",
                      api: { url: "https://base-b-later.test" },
                      models: {
                        kept: { variants: [{ id: "retained", headers: { last: "yes" }, body: { last: true } }] },
                      },
                    },
                    auto: { extends: "base-b" },
                    // 高层 V1 不重复 extends/npm，provider/model/variant 仍按有效 Anthropic API 转换。
                    ...ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          "anthropic-copy": {
                            options: {
                              authToken: "new-token",
                              baseURL: "https://anthropic-high.test/v1",
                              region: "high",
                              headers: { "x-layer": "high" },
                              body: { extension: { child: "add", shared: "high" }, items: ["high"] },
                            },
                            models: {
                              claude: {
                                options: { metadata: { userId: "later-model-user" } },
                                variants: { high: { metadata: { userId: "later-variant-user" } } },
                              },
                            },
                          },
                        },
                      }),
                    ).providers,
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("kept"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
        const mirror = required(yield* catalog.model.get(ProviderV2.ID.make("mirror"), modelID))
        // 独立预期同时覆盖重绑、实际 API ID、npm/URL 和保留的基础 variant。
        expect(mirror.providerID).toBe(ProviderV2.ID.make("mirror"))
        expect(mirror.api).toMatchObject({
          id: "api-chat",
          type: "aisdk",
          package: "@ai-sdk/anthropic",
          url: "https://model-only.test",
        })
        expect(mirror.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect((yield* catalog.provider.get(ProviderV2.ID.make("mirror")))?.name).toBe("Mirror")
        expect((yield* integrations.get(Integration.ID.make("mirror")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        // 基础对象仍是 custom-sdk；派生 API 覆盖不能污染原模型或默认模型选择。
        expect(model.api).toMatchObject({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(mirror.request.headers).toEqual({ first: "first", shared: "last", last: "last", mirror: "yes" })
        expect(mirror.enabled).toBe(false)
        expect(mirror.variants[0]?.body).toEqual({ model_flag: true })
        // 未指定模型 API 的继承模型仍领取最终 provider 覆盖，基础模型保持不变。
        expect((yield* catalog.model.get(ProviderV2.ID.make("mirror"), ModelV2.ID.make("default")))?.api).toMatchObject(
          { package: "@ai-sdk/openai-compatible", url: "https://mirror-later.test" },
        )
        const switched = ProviderV2.ID.make("switched")
        expect(
          (yield* catalog.model.all())
            .filter((model) => model.providerID === switched)
            .map((model) => model.id)
            .sort(),
        ).toEqual([ModelV2.ID.make("beta"), ModelV2.ID.make("kept")])
        expect(yield* catalog.model.get(switched, modelID)).toBeUndefined()
        expect(yield* catalog.model.get(switched, ModelV2.ID.make("default"))).toBeUndefined()
        const kept = required(yield* catalog.model.get(switched, ModelV2.ID.make("kept")))
        // 删除仅针对自动继承集合；显式配置的默认模型继续被 Catalog.default 选中。
        expect(kept.api).toMatchObject({
          id: "remote-kept",
          type: "aisdk",
          package: "kept-sdk",
          url: "https://kept.test",
        })
        expect(kept.name).toBe("Kept")
        expect(kept.limit).toEqual({ context: 500, output: 100 })
        expect(kept.variants).toEqual([
          {
            id: ModelV2.VariantID.make("retained"),
            headers: { first: "yes", last: "yes" },
            body: { first: true, last: true },
          },
        ])
        expect((yield* catalog.model.default())?.providerID).toBe(switched)
        expect((yield* catalog.model.get(switched, ModelV2.ID.make("beta")))?.api).toMatchObject({
          package: "@ai-sdk/openai-compatible",
          url: "https://base-b-later.test",
        })
        expect((yield* catalog.provider.get(switched))?.name).toBe("Switched")
        // 显式环境属于派生身份，基础 B 的名称/URL/环境方法不被子配置污染。
        expect((yield* integrations.get(Integration.ID.make("switched")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("base-b")))?.api).toMatchObject({
          package: "@ai-sdk/openai-compatible",
          url: "https://base-b.test",
        })
        expect(yield* integrations.get(Integration.ID.make("base-b"))).toBeUndefined()
        // A 的密钥仍实际可解析，切到 B 的 auto 却没有旧 env 方法或可解析连接。
        const baseConnection = required(yield* integrations.connection.active(Integration.ID.make("custom")))
        expect(yield* integrations.connection.resolve(baseConnection)).toMatchObject({ type: "key", key: "secret" })
        expect(yield* integrations.get(Integration.ID.make("auto"))).toBeUndefined()
        expect(yield* integrations.connection.active(Integration.ID.make("auto"))).toBeUndefined()
        expect((yield* catalog.model.get(ProviderV2.ID.make("auto"), ModelV2.ID.make("beta")))?.api).toMatchObject({
          package: "@ai-sdk/openai-compatible",
          url: "https://base-b.test",
        })
        // 独立列出合并结果与基础结果，覆盖后层覆盖、数组替换和基础隔离。
        expect(mirror.request.body).toEqual({
          metadata: { base: "keep", child: "add", shared: "child" },
          items: ["child"],
        })
        expect(model.request.body).toEqual({ metadata: { base: "keep", shared: "base" }, items: ["base"] })
        // 普通配置不保留被后层替换的嵌套键，与上游浅合并一致。
        expect((yield* catalog.model.get(ProviderV2.ID.make("plain"), ModelV2.ID.make("chat")))?.request.body).toEqual({
          nested: { last: true },
          metadata: { last: true },
        })
        // 独立预期覆盖真实选中 SDK 与 endpoint，不能只检查迁移中间对象。
        for (const expected of [
          { model: "urlonly", api: "urlonly", url: "https://url-only.test" },
          { model: "alias", api: "default", url: "https://alias-only.test" },
        ]) {
          const configured = required(
            yield* catalog.model.get(ProviderV2.ID.make("mirror"), ModelV2.ID.make(expected.model)),
          )
          expect(configured.api).toMatchObject({
            id: expected.api,
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: expected.url,
          })
          expect(configured.providerID).toBe(ProviderV2.ID.make("mirror"))
          const selected = yield* SessionRunnerModel.fromCatalogModel(configured)
          expect(selected.id).toBe(ModelID.make(expected.api))
          expect(selected.route.id).toBe("openai-compatible-chat")
          expect(selected.route.endpoint.baseURL).toBe(expected.url)
        }
        // 后层仅 settings 的覆盖保留前层模型 URL，与 provider URL 相互独立。
        expect(
          (yield* catalog.model.get(ProviderV2.ID.make("mirror"), ModelV2.ID.make("urlonly")))?.api.settings,
        ).toMatchObject({ region: "override" })
        const guest = ProviderV2.ID.make("guest")
        // 两种 native 域保持 raw 字段；可用 guest 与后续 Anthropic wire 仍继续被真实服务验证。
        const ordinary = required(
          yield* catalog.model.get(ProviderV2.ID.make("ordinary-native"), ModelV2.ID.make("raw")),
        )
        expect(
          (yield* catalog.model.get(ProviderV2.ID.make("ordinary-native"), ModelV2.ID.make("empty")))?.request.body,
        ).toEqual({})
        expect(ordinary.api.type).toBe("native")
        expect(ordinary.request.body).toEqual({ metadata: { userId: "ordinary-user" } })
        expect(ordinary.variants[0]?.body).toEqual({ metadata: { userId: "ordinary-variant" } })
        // 未知 SDK 的 raw 字段仍完整进入 Catalog，不把文档形状调整当成功能通过。
        expect((yield* catalog.provider.get(ProviderV2.ID.make("unresolved-key")))?.request.body).toEqual({
          apiKey: "secret",
        })
        const deferred = required(
          yield* catalog.model.get(ProviderV2.ID.make("unresolved-key"), ModelV2.ID.make("model")),
        )
        expect(deferred.request.body).toEqual({ apiKey: "secret", reasoningEffort: "high" })
        expect(deferred.variants.map((variant) => ({ id: variant.id, body: variant.body }))).toEqual([
          { id: ModelV2.VariantID.make("fast"), body: { temperature: 0.2 } },
        ])
        const native = required(yield* catalog.model.get(ProviderV2.ID.make("native-copy"), ModelV2.ID.make("raw")))
        expect(native.api.type).toBe("native")
        expect(native.request.body).toEqual({ metadata: { userId: "native-user" } })
        expect(native.variants[0]?.body).toEqual({ metadata: { userId: "native-variant" } })
        // available/default/Location resolve 全部走真实服务，不能用 catalog.get 绕过授权过滤。
        expect(yield* integrations.get(Integration.ID.make("guest"))).toBeUndefined()
        expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(guest)
        expect(
          (yield* catalog.model.available()).filter((model) => model.providerID === guest).map((model) => model.id),
        ).toEqual([ModelV2.ID.make("beta")])
        yield* catalog.transform((draft) => draft.model.default.set(guest, ModelV2.ID.make("beta")))
        expect((yield* catalog.model.default())?.providerID).toBe(guest)
        const session = SessionSchema.Info.make({
          id: SessionSchema.ID.make("ses_config_inherit"),
          projectID: ProjectV2.ID.global,
          title: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/project") },
        })
        const resolver = yield* SessionRunnerModel.Service.pipe(
          Effect.provide(SessionRunnerModel.locationLayer.pipe(Layer.provide(Layer.succeed(Config.Service, config)))),
        )
        const unauth = yield* resolver.resolve(session)
        expect(unauth.model.id).toBe(ModelID.make("beta"))
        expect(unauth.model.route.endpoint.baseURL).toBe("https://base-b.test")
        const anthropic = required(
          yield* catalog.model.get(ProviderV2.ID.make("anthropic-copy"), ModelV2.ID.make("claude")),
        )
        // 同一个已有 SDK lowerer 应同时转换模型与变体；中间配置和实际 wire 都无 camel userId。
        expect(anthropic.request.body).toEqual({
          extension: { base: "keep", child: "add", shared: "high" },
          items: ["high"],
          metadata: { base: "keep", user_id: "later-model-user" },
        })
        // 未声明输出窗口时不推断 enabled 预算，用户显式 high 变体的完整 metadata 继续保留。
        expect(anthropic.variants[0]?.body).toEqual({ metadata: { user_id: "later-variant-user" } })
        // authToken 不能困在 settings/body；基础不变，高层 URL/settings/headers 均独立覆盖。
        expect(anthropic.api).toMatchObject({
          type: "aisdk",
          package: "@ai-sdk/anthropic",
          url: "https://anthropic-high.test/v1",
          settings: { region: "high" },
        })
        expect(anthropic.api.settings).not.toHaveProperty("authToken")
        expect(anthropic.request.headers).toMatchObject({ Authorization: "Bearer new-token", "x-layer": "high" })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("anthropic-base")))?.api.url).toBe(
          "https://anthropic.test/v1",
        )
        // 低层 V1 延迟转换后，高层 V2 地址和 settings 仍须同时到达继承模型及真实路由。
        const override = required(
          yield* catalog.model.get(ProviderV2.ID.make("native-override"), ModelV2.ID.make("claude")),
        )
        expect(override.api).toMatchObject({ url: "https://high.test/v1", settings: { region: "high" } })
        expect((yield* SessionRunnerModel.fromCatalogModel(override)).route.endpoint.baseURL).toBe(
          "https://high.test/v1",
        )
        const llmLayer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))
        for (const variant of [undefined, ModelV2.VariantID.make("high")]) {
          const selected = yield* SessionRunnerModel.resolve(
            SessionSchema.Info.make({
              ...session,
              model: { providerID: anthropic.providerID, id: anthropic.id, variant },
            }),
            anthropic,
          )
          expect(selected.route.endpoint.baseURL).toBe("https://anthropic-high.test/v1")
          const input = LLM.request({
            model: selected,
            prompt: "hello",
            cache: "none",
            http: { ...selected.route.defaults.http, headers: selected.route.defaults.headers },
          })
          const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(input).pipe(
            Effect.provide(llmLayer),
          )
          // preview body 不携带 endpoint，typed transport 必须接续 resolver 已选定的 endpoint/auth。
          const wire = yield* AnthropicMessages.route
            .with({ endpoint: selected.route.endpoint, auth: selected.route.auth })
            .prepareTransport(prepared.body, input)
          const web = yield* HttpClientRequest.toWeb(wire.request).pipe(Effect.orDie)
          const text = yield* Effect.promise(() => web.text())
          const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
            text,
          )
          // 检查最终字节而非仅 Catalog 元数据，缺省上限必须来自协议且不能再携带负思考预算。
          expect(body.max_tokens).toBe(4096)
          expect(body).not.toHaveProperty("thinking")
          expect(body.metadata).toEqual(
            variant === undefined ? { base: "keep", user_id: "later-model-user" } : { user_id: "later-variant-user" },
          )
          expect(web.headers.get("authorization")).toBe("Bearer new-token")
          expect(web.url).toBe("https://anthropic-high.test/v1/messages")
          expect(text).toContain(
            variant === undefined ? '"user_id":"later-model-user"' : '"user_id":"later-variant-user"',
          )
          expect(text).not.toContain('"userId"')
          expect(text).not.toContain('"authToken"')
          expect(text).not.toContain("old-token")
        }
      }),
    ),
  )

  it.effect("compiles claudecode thinking variants through the inherited Location model resolver", () =>
    withEnv(
      {
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDECODE_API_KEY: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDECODE_BASE_URL: undefined,
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode(
                    ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          claudecode: {
                            options: { apiKey: "configured-key" },
                            models: {
                              "claude-opus-4-6": { name: "Claude Opus 4.6", limit: { context: 64000, output: 32000 } },
                              "claude-3-7-sonnet-20250219": {
                                reasoning: false,
                                limit: { context: 64000, output: 32000 },
                              },
                              "budget-base": {
                                id: "claude-3-7-sonnet",
                                reasoning: true,
                                limit: { context: 64000, output: 32000 },
                                variants: { high: { custom_extension: { source: "base" } } },
                              },
                            },
                          },
                          Cubence: {
                            extends: "claudecode",
                            options: { apiKey: "derived-key", baseURL: "https://api-dmit.cubence.com/v1" },
                            models: {
                              "opus-alias": {
                                id: "claude-opus-4-6",
                                variants: { low: { metadata: { userId: "explicit-variant" } } },
                              },
                              "disabled-alias": { id: "claude-3-7-sonnet-20250219" },
                            },
                          },
                          // 无 extends 的普通提供者刻意带同名设置，锁定专用身份必须来自真实继承证明。
                          ordinary: {
                            npm: "@ai-sdk/anthropic",
                            options: { apiKey: "ordinary-key", claudeCode: true },
                            models: {
                              "claude-4.7-opus": { reasoning: true, limit: { context: 64000, output: 32000 } },
                              deployment: { reasoning: true, limit: { context: 64000, output: 32000 } },
                              "claude-opus-4-6": { limit: { context: 64000, output: 32000 } },
                              "claude-sonnet-4-5": { limit: { context: 64000, output: 1024 } },
                              "claude-3-7-sonnet": {
                                limit: { context: 64000, output: 1025 },
                                variants: { high: { metadata: { userId: "small-window" } } },
                              },
                              lowered: {
                                id: "claude-3-7-sonnet",
                                reasoning: true,
                                limit: { context: 64000, output: 32000 },
                              },
                              off: {
                                id: "claude-3-7-sonnet",
                                reasoning: true,
                                limit: { context: 64000, output: 32000 },
                                variants: { manual: { custom_extension: { source: "first" } } },
                              },
                            },
                          },
                          "sdk-switch": { extends: "claudecode" },
                        },
                      }),
                    ),
                  ),
                }),
                new Config.Document({
                  type: "document",
                  // 后层不重述基础配置，预算、能力和协议必须共同按最终状态推断，不能消费上一层的默认表。
                  info: decode(
                    ConfigMigrateV1.migrate(
                      Schema.decodeUnknownSync(ConfigV1.Info)({
                        provider: {
                          ordinary: {
                            models: {
                              lowered: { limit: { context: 64000, output: 2048 } },
                              off: {
                                reasoning: false,
                                variants: { manual: { custom_extension: { source: "later" } } },
                              },
                            },
                          },
                          "sdk-switch": {
                            npm: "@ai-sdk/openai",
                            options: { apiKey: "sdk-key", baseURL: "https://openai.test/v1" },
                            models: { "budget-base": { id: "gpt-4.1" } },
                          },
                        },
                      }),
                    ),
                  ),
                }),
              ]),
          })
          yield* addPlugin(config)
          const compile = <Body = AnthropicMessages.AnthropicMessagesBody>(model: Model) =>
            Effect.gen(function* () {
              const requests: HttpClientRequest.HttpClientRequest[] = []
              const route = model.route.with({
                transport: {
                  ...model.route.transport,
                  prepare: (input) =>
                    model.route.transport
                      .prepare(input)
                      .pipe(Effect.tap((prepared) => Effect.sync(() => requests.push(prepared.request)))),
                },
              })
              const prepared = yield* LLMClient.prepare<Body>(
                LLM.request({ model: route.model({ id: model.id }), prompt: "hello", cache: "none" }),
              )
              // 截获同一次 compile 的真实请求，计数拦住重复 prepare，fixture 永不进入发送或 frames。
              expect(requests).toHaveLength(1)
              return {
                body: prepared.body,
                web: yield* HttpClientRequest.toWeb(required(requests[0])).pipe(Effect.orDie),
              }
            })
          const providerID = ProviderV2.ID.make("Cubence")
          const alias = required(yield* catalog.model.get(providerID, ModelV2.ID.make("opus-alias")))
          expect(alias.providerID).toBe(providerID)
          expect(alias.id).toBe(ModelV2.ID.make("opus-alias"))
          expect(alias.api).toMatchObject({
            id: "claude-opus-4-6",
            type: "aisdk",
            package: "@ai-sdk/anthropic",
            url: "https://api-dmit.cubence.com/v1",
          })
          expect(alias.variants.map((variant) => variant.id)).toEqual(
            ["low", "medium", "high", "max"].map((id) => ModelV2.VariantID.make(id)),
          )
          // 完整低档 body 同时锁定默认 effort 与用户 metadata，部分匹配会漏掉合并丢项。
          expect(alias.variants.find((variant) => variant.id === "low")?.body).toEqual({
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
            metadata: { user_id: "explicit-variant" },
          })
          expect(
            (yield* catalog.model.get(ProviderV2.ID.make("claudecode"), ModelV2.ID.make("claude-3-7-sonnet-20250219")))
              ?.variants,
          ).toEqual([])
          const disabled = required(yield* catalog.model.get(providerID, ModelV2.ID.make("disabled-alias")))
          expect(disabled.variants).toEqual([])
          const disabledModel = yield* SessionRunnerModel.fromCatalogModel(disabled)
          expect((yield* compile(disabledModel)).body).not.toHaveProperty("__opencodeReasoning")
          expect(
            (yield* catalog.model.get(ProviderV2.ID.make("claudecode"), ModelV2.ID.make("claude-opus-4-6")))?.api.url,
          ).toBe("https://api.cubence.com")
          const session = SessionSchema.Info.make({
            id: SessionSchema.ID.make("ses_claudecode_inference"),
            projectID: ProjectV2.ID.global,
            title: "test",
            cost: 0,
            model: { providerID, id: alias.id, variant: ModelV2.VariantID.make("max") },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory: AbsolutePath.make("/project") },
          })
          const resolver = yield* SessionRunnerModel.Service.pipe(
            Effect.provide(SessionRunnerModel.locationLayer.pipe(Layer.provide(Layer.succeed(Config.Service, config)))),
          )
          const selected = (yield* resolver.resolve(session)).model
          // 真实 Location resolver 保留派生 provider 与 wire ID，冻结预算不随 Catalog 别名重写。
          expect(selected.provider).toBe(ProviderID.make(providerID))
          expect(selected.id).toBe(ModelID.make("claude-opus-4-6"))
          expect(selected.route.defaults.limits).toEqual({ context: 64000, input: undefined, output: 32000 })
          const prepared = yield* compile(selected)
          expect(prepared.body.thinking).toEqual({ type: "adaptive" })
          expect(prepared.body.output_config).toEqual({ effort: "max" })
          expect(prepared.body.system?.[0]?.text).toStartWith("x-anthropic-billing-header:")
          expect(prepared.web.url).toBe("https://api-dmit.cubence.com/v1/messages")
          expect(prepared.web.headers.get("authorization")).toBe("Bearer derived-key")
          expect(prepared.web.headers.has("x-api-key")).toBe(false)
          expect(prepared.web.headers.get("x-app")).toBe("cli")
          // 显式能力支持新版命名和自定义部署，不能再次被缺省型号推断否决。
          for (const id of ["claude-4.7-opus", "deployment"]) {
            const explicit = required(yield* catalog.model.get(ProviderV2.ID.make("ordinary"), ModelV2.ID.make(id)))
            expect(explicit.variants.some((variant) => variant.id === "high")).toBe(true)
            const resolved = yield* SessionRunnerModel.resolve(
              SessionSchema.Info.make({
                ...session,
                model: { providerID: explicit.providerID, id: explicit.id, variant: ModelV2.VariantID.make("high") },
              }),
              explicit,
            )
            expect(resolved.route.defaults.http?.body).not.toHaveProperty("thinking")
            expect(resolved.route.defaults.http?.body).not.toHaveProperty("output_config")
            const request = yield* compile(resolved)
            expect(request.body.thinking?.type).toBe(id === "claude-4.7-opus" ? "adaptive" : "enabled")
            expect(request.body.max_tokens).toBeGreaterThan(0)
          }
          // 只准备请求而不发送，四种来源验证源优先级，保存凭据属于当前派生身份。
          for (const sample of [
            { token: "env-token", cc: "cc-token", saved: "saved-key", expected: "env-token" },
            { token: undefined, cc: "cc-token", saved: "saved-key", expected: "cc-token" },
            { token: undefined, cc: undefined, saved: "saved-key", expected: "saved-key" },
            { token: undefined, cc: undefined, saved: undefined, expected: "derived-key" },
          ])
            yield* withEnv({ ANTHROPIC_AUTH_TOKEN: sample.token, CLAUDECODE_API_KEY: sample.cc }, () =>
              Effect.gen(function* () {
                const resolved = yield* SessionRunnerModel.fromCatalogModel(
                  alias,
                  sample.saved === undefined ? undefined : Credential.Key.make({ type: "key", key: sample.saved }),
                )
                const prepared = yield* compile(resolved)
                expect(prepared.web.headers.get("authorization")).toBe(`Bearer ${sample.expected}`)
                expect(prepared.web.headers.has("x-api-key")).toBe(false)
              }),
            )
          const ordinary = required(
            yield* catalog.model.get(ProviderV2.ID.make("ordinary"), ModelV2.ID.make("claude-opus-4-6")),
          )
          expect(ordinary.api.url).toBe("https://api.anthropic.com/v1")
          const normal = yield* SessionRunnerModel.resolve(
            SessionSchema.Info.make({
              ...session,
              model: { providerID: ordinary.providerID, id: ordinary.id, variant: ModelV2.VariantID.make("low") },
            }),
            ordinary,
          )
          const normalBody = yield* compile(normal)
          // 普通 Anthropic 仍有推断变体，绝不因为专用能力混入 ClaudeCode 的计费、占位工具或身份头。
          expect(normalBody.body.thinking).toEqual({ type: "adaptive" })
          expect(normalBody.body.output_config).toEqual({ effort: "low" })
          expect(normalBody.body.system).toBeUndefined()
          expect(normalBody.body.tools).toBeUndefined()
          expect(normalBody.web.headers.get("x-api-key")).toBe("ordinary-key")
          expect(normalBody.web.headers.has("x-app")).toBe(false)
          // 两个相邻窗口分别验证不能容纳思考与恰能容纳最低预算，显式变体 metadata 不能被默认表丢掉。
          for (const sample of [
            { id: "claude-sonnet-4-5", output: 1024 },
            { id: "claude-3-7-sonnet", output: 1025 },
          ]) {
            const edge = required(yield* catalog.model.get(ordinary.providerID, ModelV2.ID.make(sample.id)))
            expect(edge.variants).toEqual(
              sample.output === 1024
                ? []
                : [
                    {
                      id: ModelV2.VariantID.make("high"),
                      headers: {},
                      body: {
                        thinking: { type: "enabled", budget_tokens: 1024 },
                        metadata: { user_id: "small-window" },
                      },
                    },
                    {
                      id: ModelV2.VariantID.make("max"),
                      headers: {},
                      body: { thinking: { type: "enabled", budget_tokens: 1024 } },
                    },
                  ],
            )
            const resolved = yield* SessionRunnerModel.resolve(
              SessionSchema.Info.make({
                ...session,
                model: {
                  providerID: edge.providerID,
                  id: edge.id,
                  variant: sample.output === 1024 ? undefined : ModelV2.VariantID.make("high"),
                },
              }),
              edge,
            )
            const prepared = yield* compile(resolved)
            const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
              yield* Effect.promise(() => prepared.web.text()),
            )
            // wire 的 max_tokens 必须等于所选小窗口，1024 的思考预算只能出现在更大的 1025 窗口。
            expect(body.max_tokens).toBe(sample.output)
            expect(body.thinking).toEqual(sample.output === 1024 ? undefined : { type: "enabled", budget_tokens: 1024 })
            expect(body.metadata).toEqual(sample.output === 1024 ? undefined : { user_id: "small-window" })
            expect(prepared.web.headers.has("x-app")).toBe(false)
          }
          const lowered = required(yield* catalog.model.get(ordinary.providerID, ModelV2.ID.make("lowered")))
          // 两档精确预算锁定第二层 2048 上限，不能只测变体名字而漏掉首层 32000 的残留。
          expect(lowered.variants).toEqual([
            {
              id: ModelV2.VariantID.make("high"),
              headers: {},
              body: { thinking: { type: "enabled", budget_tokens: 1024 } },
            },
            {
              id: ModelV2.VariantID.make("max"),
              headers: {},
              body: { thinking: { type: "enabled", budget_tokens: 2047 } },
            },
          ])
          for (const variant of lowered.variants) {
            const resolved = yield* SessionRunnerModel.resolve(
              SessionSchema.Info.make({
                ...session,
                model: { providerID: lowered.providerID, id: lowered.id, variant: variant.id },
              }),
              lowered,
            )
            const prepared = yield* compile(resolved)
            const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
              yield* Effect.promise(() => prepared.web.text()),
            )
            expect(body.max_tokens).toBe(2048)
            expect(body.thinking).toEqual(variant.body.thinking)
          }
          const off = required(yield* catalog.model.get(ordinary.providerID, ModelV2.ID.make("off")))
          // false 只撤销自动推断，显式变体仍沿原分层流程接纳后层正文并继续可执行。
          expect(off.variants).toEqual([
            { id: ModelV2.VariantID.make("manual"), headers: {}, body: { custom_extension: { source: "later" } } },
          ])
          const offModel = yield* SessionRunnerModel.resolve(
            SessionSchema.Info.make({
              ...session,
              model: { providerID: off.providerID, id: off.id, variant: ModelV2.VariantID.make("manual") },
            }),
            off,
          )
          const offPrepared = yield* compile(offModel)
          const offBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
            yield* Effect.promise(() => offPrepared.web.text()),
          )
          expect(offBody).not.toHaveProperty("thinking")
          expect(offBody.custom_extension).toEqual({ source: "later" })
          const switched = required(
            yield* catalog.model.get(ProviderV2.ID.make("sdk-switch"), ModelV2.ID.make("budget-base")),
          )
          // SDK 切换后仍继承真实用户变体，首次推断的 Anthropic thinking 不得混进 Responses 的 HTTP overlay。
          expect(switched.variants).toEqual([
            { id: ModelV2.VariantID.make("high"), headers: {}, body: { custom_extension: { source: "base" } } },
          ])
          const switchedModel = yield* SessionRunnerModel.resolve(
            SessionSchema.Info.make({
              ...session,
              model: { providerID: switched.providerID, id: switched.id, variant: ModelV2.VariantID.make("high") },
            }),
            switched,
          )
          const switchedPrepared = yield* compile<Record<string, unknown>>(switchedModel)
          expect(switchedModel.route.id).toBe("openai-responses")
          const switchedBody = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(yield* Effect.promise(() => switchedPrepared.web.text()))
          expect(switchedBody.model).toBe("gpt-4.1")
          expect(switchedBody).not.toHaveProperty("thinking")
          expect(switchedBody.custom_extension).toEqual({ source: "base" })
        }),
    ),
  )
})

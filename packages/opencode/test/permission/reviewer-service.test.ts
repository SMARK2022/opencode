import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createOpenAI } from "@ai-sdk/openai"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { PermissionReviewer } from "../../src/permission/reviewer/service"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"

// 这个命令覆盖 reviewer 证据里最容易被回归破坏的 shell 形态：空格路径、引号、
// 环境变量、管道、重定向、子命令和危险删除意图都必须保留在 user evidence，
// 不能被提升到 OpenAI OAuth/Codex 的高优先级 instructions 中。
const COMMAND_EVIDENCE = `cd "/tmp/path with spaces" && printf '%s\n' "$HOME" | sed 's/a/b/' > "out file" && rm "$(pwd)/danger"`

// fake provider 返回一个真实 OpenAI Responses SSE 序列，而不是直接 mock reviewer
// 结果；这样测试覆盖的是 PermissionReviewer -> AI SDK -> provider wire body -> stream
// parser 的可观察行为，避免把断言绑在内部 helper 或源码结构上。
const REVIEWER_ASSESSMENT = {
  outcome: "allow",
  risk_level: "medium",
  user_authorization: "medium",
  rationale: "The user evidence bounds the shell command to the requested review fixture.",
}

type ReviewerRequestBody = {
  instructions?: unknown
  max_output_tokens?: unknown
  input: Array<{ role?: unknown; content?: unknown }>
}

type CapturedReviewerRequest = {
  body: ReviewerRequestBody
  headers: Headers
}

const OPENAI_PROVIDER_ID = ProviderV2.ID.make("openai")
const CUSTOM_PROVIDER_ID = ProviderV2.ID.make("custom-openai")
// This header is a test sentinel, not a production contract. It proves the
// reviewer path sends its provider request through the existing chat.headers
// compatibility seam without asserting on implementation structure or hook names
// outside the observable HTTP request produced by the provider SDK.
const REVIEWER_HOOK_HEADER = "x-reviewer-hook"
const sessionLayer = Layer.mock(Session.Service)({})

describe("permission reviewer service", () => {
  const oauthFixture = reviewerFixture(oauthAuth(), { requireInstructions: true })
  const apiKeyFixture = reviewerFixture({ type: "api", key: "test-key" }, { requireInstructions: false })
  // OAuth 凭据本身不是 Codex 契约；这个 fixture 防止未来把条件误放宽成
  // “任意 OAuth provider 都移除 system message 并写 instructions”。
  const customOauthFixture = reviewerFixture(oauthAuth(), { requireInstructions: false, providerID: CUSTOM_PROVIDER_ID })
  const oauthHookFixture = reviewerFixture(oauthAuth(), {
    requireInstructions: true,
    rejectMaxOutputTokens: true,
    plugin: pluginLayer({ clearMaxOutputTokens: true, header: REVIEWER_HOOK_HEADER }),
  })
  const implicitAutoFixture = reviewerFixture(
    { type: "api", key: "test-key" },
    {
      requireInstructions: false,
      permission: {
        auto_review: {
          model: `${OPENAI_PROVIDER_ID}/gpt-5`,
          policy: "Reviewer service test policy: allow only bounded auto requests.",
        },
      },
    },
  )
  const oauth = testEffect(oauthFixture.layer)
  const apiKey = testEffect(apiKeyFixture.layer)
  const customOauth = testEffect(customOauthFixture.layer)
  const oauthHook = testEffect(oauthHookFixture.layer)
  const implicitAuto = testEffect(implicitAutoFixture.layer)

  oauth.effect("sends reviewer policy as OpenAI OAuth instructions while keeping action evidence in user input", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_openai_oauth"))
      const body = oauthFixture.bodies[0]

      expect(decision).toMatchObject({
        action: "allow",
        reason: REVIEWER_ASSESSMENT.rationale,
        reviewID: "review_openai_oauth",
        risk_level: "medium",
        user_authorization: "medium",
      })
      expect(typeof body.instructions).toBe("string")
      expect(body.instructions).toContain("permission_review_decision")
      expect(JSON.stringify(body.instructions)).not.toContain(COMMAND_EVIDENCE)
      expect(hasSystemLikeInput(body)).toBe(false)
      expectPreservedShellEvidence(inputText(body))
    }),
  )

  apiKey.effect("preserves system-message reviewer prompting for non-OAuth OpenAI requests", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_openai_api_key"))
      const body = apiKeyFixture.bodies[0]

      expect(decision.action).toBe("allow")
      expect(body.instructions).toBeUndefined()
      expect(hasSystemLikeInput(body)).toBe(true)
      expectPreservedShellEvidence(inputText(body))
    }),
  )

  customOauth.effect("does not treat OAuth on non-OpenAI providers as Codex instructions mode", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_custom_oauth"))
      const body = customOauthFixture.bodies[0]

      expect(decision.action).toBe("allow")
      expect(body.instructions).toBeUndefined()
      expect(hasSystemLikeInput(body)).toBe(true)
      expectPreservedShellEvidence(inputText(body))
    }),
  )

  oauthHook.effect("applies chat provider hooks before sending OpenAI OAuth reviewer requests", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_openai_oauth_hooks"))
      const request = oauthHookFixture.requests[0]

      expect(decision.action).toBe("allow")
      expect(request.body.max_output_tokens).toBeUndefined()
      expect(request.headers.get(REVIEWER_HOOK_HEADER)).toBe("applied")
      expect(typeof request.body.instructions).toBe("string")
      expectPreservedShellEvidence(inputText(request.body))
    }),
  )

  implicitAuto.effect("enables reviewer for auto requests without depending on the executing agent name", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_general_agent_auto", {
          agent: "general",
        }),
      )
      const body = implicitAutoFixture.bodies[0]

      expect(decision.action).toBe("allow")
      expect(inputText(body)).toContain("general")
      expectPreservedShellEvidence(inputText(body))
    }),
  )
})

function reviewerFixture(
  authInfo: Auth.Info | undefined,
  options: {
    requireInstructions: boolean
    providerID?: ProviderV2.ID
    rejectMaxOutputTokens?: boolean
    plugin?: Layer.Layer<Plugin.Service>
    permission?: Config.Info["permission"]
  } = { requireInstructions: false },
) {
  const bodies: ReviewerRequestBody[] = []
  const requests: CapturedReviewerRequest[] = []
  const model = reviewerModel(options.providerID ?? OPENAI_PROVIDER_ID)
  // Bun 的 fetch 类型带 preconnect；测试只需要拦截真实请求体，因此用空实现满足
  // provider SDK 类型契约，不改变请求/响应行为，也不引入额外网络能力。
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      requests.push({ body, headers: new Headers(init?.headers) })

      // Codex OAuth 后端的 observable 契约是顶层 instructions 必填；这里用同样的
      // 400 形态复现生产问题，确保修复不是靠放宽 reviewer 错误处理而是改变请求形状。
      if (options.requireInstructions && typeof body.instructions !== "string") {
        return new Response(JSON.stringify({ detail: "Instructions are required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      // Codex's ChatGPT-backed Responses endpoint rejects `max_output_tokens` even
      // though the public OpenAI Responses API accepts it. This fixture fails at
      // the same HTTP boundary as production so the regression test proves the
      // reviewer request shape, not a private helper or source-code branch.
      if (options.rejectMaxOutputTokens && body.max_output_tokens !== undefined) {
        return new Response(JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      return new Response(openAIReviewDecisionStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ReviewerServiceTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })

  return {
    bodies,
    requests,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config(model.providerID, options.permission)) })),
      Layer.provide(provider.layer),
      Layer.provide(authLayer(authInfo)),
      Layer.provide(options.plugin ?? pluginLayer()),
      Layer.provide(sessionLayer),
      Layer.provide(Database.defaultLayer),
    ),
  }
}

function pluginLayer(options: { clearMaxOutputTokens?: boolean; header?: string } = {}) {
  return Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: (name, _input, output) =>
        Effect.sync(() => {
          // The reviewer should reuse the same provider-compatibility hooks that
          // main chat uses, but this test hook deliberately changes only request
          // transport shape. It must not inspect or mutate reviewer prompt evidence,
          // because command details are a permission-boundary input rather than a
          // plugin contract.
          if (name === "chat.params" && options.clearMaxOutputTokens && output && typeof output === "object") {
            ;(output as { maxOutputTokens?: number }).maxOutputTokens = undefined
          }
          if (name === "chat.headers" && options.header && output && typeof output === "object" && "headers" in output) {
            const headers = (output as { headers: Record<string, string> }).headers
            headers[options.header] = "applied"
          }
          return output
        }),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
  )
}

function reviewerModel(providerID: ProviderV2.ID) {
  return ProviderTest.model({
    id: ModelV2.ID.make("gpt-5"),
    providerID,
    api: { id: "gpt-5", url: "https://api.openai.test/v1", npm: "@ai-sdk/openai" },
  })
}

function hasSystemLikeInput(body: ReviewerRequestBody) {
  return body.input.some((item) => item.role === "system" || item.role === "developer")
}

function inputText(body: ReviewerRequestBody) {
  return body.input
    .flatMap((item) =>
      Array.isArray(item.content)
        ? item.content.flatMap((part) => (typeof part === "object" && part && "text" in part && typeof part.text === "string" ? [part.text] : []))
        : typeof item.content === "string"
          ? [item.content]
          : [],
    )
    .join("\n")
}

function expectPreservedShellEvidence(text: string) {
  expect(text).toContain("/tmp/path with spaces")
  expect(text).toContain("$HOME")
  expect(text).toContain("sed 's/a/b/'")
  expect(text).toContain(">")
  expect(text).toContain("out file")
  expect(text).toContain("rm")
  expect(text).toContain("$(pwd)/danger")
}

function reviewInput(reviewID: string, metadata?: Readonly<Record<string, unknown>>) {
  return {
    reviewID,
    permission: "bash",
    patterns: [COMMAND_EVIDENCE],
    metadata: { command: COMMAND_EVIDENCE, cwd: "/tmp/path with spaces", shell: "bash", ...metadata },
    precheck: { level: "cautious" as const, reason: "shell command combines redirection and deletion-like behavior" },
  }
}

function config(providerID: ProviderV2.ID, permission?: Config.Info["permission"]): Config.Info {
  return {
    permission: permission ?? {
      approvals_reviewer: "auto_review",
      auto_review: {
        model: `${providerID}/gpt-5`,
        policy: "Reviewer service test policy: allow only the bounded fixture command.",
      },
    },
  }
}

function authLayer(info: Auth.Info | undefined) {
  return Layer.mock(Auth.Service)({
    get: () => Effect.succeed(info),
  })
}

function oauthAuth(): Auth.Info {
  return { type: "oauth", refresh: "refresh-token", access: "access-token", expires: Date.now() + 60_000 }
}

function openAIReviewDecisionStream() {
  const args = JSON.stringify(REVIEWER_ASSESSMENT)
  return [
    { type: "response.created", response: { id: "resp_review", created_at: 0, model: "gpt-5", service_tier: null } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_review", call_id: "call_review", name: "permission_review_decision", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_review", output_index: 0, delta: args },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_review",
        call_id: "call_review",
        name: "permission_review_decision",
        arguments: args,
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null },
        service_tier: null,
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
}

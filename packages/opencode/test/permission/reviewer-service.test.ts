import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createOpenAI } from "@ai-sdk/openai"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "../../src/auth"
import { Database } from "@opencode-ai/core/database/database"
// #280：Config.Info 未导出，fixture 的权限字段沿用 TestConfig.get 使用的 core 配置类型
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "../../src/config/config"
import { PermissionReviewer } from "../../src/permission/reviewer/service"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"

// #250：目标树无 src/provider/schema——ID 品牌类型来自 core 的 ModelV2/ProviderV2，
// 与 test/fake/provider.ts 的既有用法一致
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
  // #261：捕获 max_output_tokens——验证 plugin hook 清理后该字段为 undefined
  max_output_tokens?: unknown
  input: Array<{ role?: unknown; content?: unknown }>
}

// #261：捕获完整请求——body + headers，验证 plugin hook 修改后的 wire 形状
type CapturedReviewerRequest = {
  body: ReviewerRequestBody
  headers: Headers
}

// #250：三个 provider/凭据组合覆盖判定矩阵——openai+oauth 提升instructions，
// openai+apiKey 与 custom+oauth 都不提升；判定错误方向任一都会被对应 fixture 抓住
const OPENAI_PROVIDER_ID = ProviderV2.ID.make("openai")
const CUSTOM_PROVIDER_ID = ProviderV2.ID.make("custom-openai")
// #261：测试哨兵 header——证明 reviewer 路径经过 chat.headers hook，非断言实现结构
const REVIEWER_HOOK_HEADER = "x-reviewer-hook"
const sessionLayer = Layer.mock(Session.Service)({})

describe("permission reviewer service", () => {
  const oauthFixture = reviewerFixture(oauthAuth(), { requireInstructions: true })
  const apiKeyFixture = reviewerFixture({ type: "api", key: "test-key" }, { requireInstructions: false })
  // OAuth 凭据本身不是 Codex 契约；这个 fixture 防止未来把条件误放宽成
  // “任意 OAuth provider 都移除 system message 并写 instructions”。
  const customOauthFixture = reviewerFixture(oauthAuth(), { requireInstructions: false, providerID: CUSTOM_PROVIDER_ID })
  // #261：OAuth + plugin hook fixture——验证 reviewer 复用 chat.params/chat.headers hook
  const oauthHookFixture = reviewerFixture(oauthAuth(), {
    requireInstructions: true,
    rejectMaxOutputTokens: true,
    plugin: pluginLayer({ clearMaxOutputTokens: true, header: REVIEWER_HOOK_HEADER }),
  })
  // #280：无 approvals_reviewer 配置——reviewer 启用由权限计算决定而非 agent 名称
  const implicitAutoFixture = reviewerFixture(
    { type: "api", key: "test-key" },
    {
      requireInstructions: false,
      permission: {
        // #280：省略 approvals_reviewer，显式 user 仍保留人工审批
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

  // #280：agent=general 的请求也进入 auto review——启用不再依赖执行 agent 名称
  implicitAuto.effect("enables reviewer for auto requests without depending on the executing agent name", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_general_agent_auto", {
          agent: "general",
        }),
      )
      // #280：bodies[0] 即本次 review 的唯一请求，无其他用例共享 fixture
      const body = implicitAutoFixture.bodies[0]

      // #280：decision allow 证明 reviewer 路径完整走通，而非被静默跳过
      expect(decision.action).toBe("allow")
      // #280：agent 证据进入 user input 而非 instructions——Codex 契约不因名称路径改变
      expect(inputText(body)).toContain("general")
      expectPreservedShellEvidence(inputText(body))
    }),
  )

  oauth.effect("sends reviewer policy as OpenAI OAuth instructions while keeping action evidence in user input", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_openai_oauth"))
      const body = oauthFixture.bodies[0]

      // #250：decision 形状锁定 Assessment→ReviewDecision 的映射不被 OAuth 分支改变
      expect(decision).toMatchObject({
        action: "allow",
        reason: REVIEWER_ASSESSMENT.rationale,
        reviewID: "review_openai_oauth",
        risk_level: "medium",
        user_authorization: "medium",
      })
      // #250：instructions 必须含 tool 定义（Codex 契约），但绝不能含 shell 证据
      expect(typeof body.instructions).toBe("string")
      expect(body.instructions).toContain("permission_review_decision")
      expect(JSON.stringify(body.instructions)).not.toContain(COMMAND_EVIDENCE)
      // #250：system/developer input item 必须被剔除——提升后残留会双重提交策略
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
      // #250：非 OAuth 路径 instructions 必须缺席——写入会改变普通 Responses 的语义
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

  // #261：验证 reviewer 路径经过 chat.params/chat.headers hook——max_output_tokens 被清理、header 被注入
  oauthHook.effect("applies chat provider hooks before sending OpenAI OAuth reviewer requests", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_openai_oauth_hooks"))
      const request = oauthHookFixture.requests[0]

      expect(decision.action).toBe("allow")
      // #261：plugin hook 清理 max_output_tokens 后应为 undefined
      expect(request.body.max_output_tokens).toBeUndefined()
      // #261：chat.headers hook 注入的哨兵 header 应存在
      expect(request.headers.get(REVIEWER_HOOK_HEADER)).toBe("applied")
      expect(typeof request.body.instructions).toBe("string")
      expectPreservedShellEvidence(inputText(request.body))
    }),
  )
})

function reviewerFixture(
  authInfo: Auth.Info | undefined,
  // #261：扩展 options 支持 plugin 层和 rejectMaxOutputTokens
  options: {
    requireInstructions: boolean
    providerID?: ProviderV2.ID
    rejectMaxOutputTokens?: boolean
    plugin?: Layer.Layer<Plugin.Service>
    // #280：注入自定义 permission 块（如无 approvals_reviewer 的隐式 auto 场景）
    permission?: ConfigV1.Info["permission"]
  } = { requireInstructions: false },
) {
  const bodies: ReviewerRequestBody[] = []
  // #261：捕获完整请求以验证 headers
  const requests: CapturedReviewerRequest[] = []
  const model = reviewerModel(options.providerID ?? OPENAI_PROVIDER_ID)
  // Bun 的 fetch 类型带 preconnect；测试只需要拦截真实请求体，因此用空实现满足
  // provider SDK 类型契约，不改变请求/响应行为，也不引入额外网络能力。
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      // #261：同时捕获 headers——验证 chat.headers hook 的修改
      requests.push({ body, headers: new Headers(init?.headers) })

      // Codex OAuth 后端的 observable 契约是顶层 instructions 必填；这里用同样的
      // 400 形态复现生产问题，确保修复不是靠放宽 reviewer 错误处理而是改变请求形状。
      if (options.requireInstructions && typeof body.instructions !== "string") {
        return new Response(JSON.stringify({ detail: "Instructions are required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      // #261：Codex 后端拒绝 max_output_tokens——即使公共 OpenAI Responses API 接受该参数
      // 这个 fixture 在同一 HTTP 边界复现生产问题，确保回归测试证明请求形状而非私有 helper
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
  // #250：getLanguage 覆盖返回真实 OpenAI Responses 客户端——fetch 拦截让请求
  // 落到本地断言而不出网
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ReviewerServiceTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })

  return {
    bodies,
    // #250：Layer.mock(Session) 不会被子会话路径触达（review 无 tool/sessionID 时
    // updateToolAutoReview 返回 Effect.void）——空实现即安全
    // #261：返回 requests 供测试验证 headers
    requests,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config(model.providerID, options.permission)) })),
      Layer.provide(provider.layer),
      Layer.provide(authLayer(authInfo)),
      // #261：提供 plugin 层——默认使用空 plugin，测试 fixture 可注入自定义 hook
      Layer.provide(options.plugin ?? pluginLayer()),
      Layer.provide(sessionLayer),
      // #250：Database 仅类型层需要——review 无 sessionID 时不触 transcript 查询
      Layer.provide(Layer.mock(Database.Service)({ db: undefined as never })),
    ),
  }
}

// #261：测试用 plugin 层——模拟 chat.params/chat.headers hook 的修改行为
function pluginLayer(options: { clearMaxOutputTokens?: boolean; header?: string } = {}) {
  return Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: (name, _input, output) =>
        Effect.sync(() => {
          // #261：hook 只修改请求传输形状，不检查或修改 reviewer prompt 证据
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
  // #250：system 与 developer 都算高优先级指令通道——Responses API 两者都会
  // 被 Codex 后端区别对待，漏检 developer 会让剔除逻辑半途而废
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
  // #250：逐 token 断言而非整串比较——证据格式变化不应掩盖丢失；rm/重定向/
  // 环境变量是最容易被提升逻辑误删的高危片段
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
    // #280：metadata 展开供 agent 名称类用例注入，不影响既有证据字段
    metadata: { command: COMMAND_EVIDENCE, cwd: "/tmp/path with spaces", shell: "bash", ...metadata },
    precheck: { level: "cautious" as const, reason: "shell command combines redirection and deletion-like behavior" },
  }
}

// #250：Config.Info 是 config 模块私有别名——测试直接用结构推断，避免依赖未导出类型
function config(providerID: ProviderV2.ID, permission?: ConfigV1.Info["permission"]) {
  return {
    // #280：permission 注入时完全替换默认块（隐式 auto 用例无 approvals_reviewer）
    permission: permission ?? {
      // #250：approvals_reviewer=auto_review 绕过禁用分支；model 字符串走
      // providerID/gpt-5 形态——与 fixture 的 provider id 严格对应
      approvals_reviewer: "auto_review" as const,
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
  // #250：expires 取未来时间——过期凭据类型仍为 oauth 但生产路径会先刷新，
  // 本测试只关心判定输入不关心刷新协议
  return { type: "oauth", refresh: "refresh-token", access: "access-token", expires: Date.now() + 60_000 }
}

function openAIReviewDecisionStream() {
  const args = JSON.stringify(REVIEWER_ASSESSMENT)
  // #250：事件序列复刻真实 Responses function-call 流——created/added/delta/done/
  // completed 缺一项 stream parser 都可能走不到 execute 分支
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

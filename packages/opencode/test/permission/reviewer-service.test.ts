import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
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
import { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Exit, Option } from "effect"
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
  // 596：捕获 tool_choice——验证强制决策工具与兼容重发去参
  tool_choice?: unknown
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
// #327：带 sessionID 的 review 会经 MessageV2.page 读 transcript——最小 drizzle 链 mock；
// 空消息窗 + 存在的 session 行让 reviewer 视为空历史并正常返回决策。
const emptyReviewerDb = (() => {
  const chain = {
    orderBy: () => ({ limit: () => ({ all: () => Effect.succeed([]) }) }),
    get: () => Effect.succeed({ id: SessionID.make("session_parent") }),
  }
  // #493：Interface 增加 sync（同一原生连接的同步 client）——空链 mock 同步补齐，测试不触真实库。
  return { db: { select: () => ({ from: () => ({ where: () => chain }) }) } as never, sync: undefined as never }
})()

// #497：closure 用例的 fixture 注册表——it 实例与 body 共享同一 fixture（单一实例，committed barrier 才可观测）。
const closureFixtures = new Map<"pending" | "completed" | "drain", ReturnType<typeof reviewerClosureFixture>>([
  ["pending", reviewerClosureFixture("pending")],
  ["completed", reviewerClosureFixture("completed")],
  ["drain", reviewerClosureFixture("drain")],
])

describe("permission reviewer service", () => {
  // #497：closure 三用例经真实 barrier 覆盖 commit→return 中断窗口、completed winner 保留与 drain 闭合。
  const pendingClosure = testEffect(closureFixtures.get("pending")!.layer)
  const completedClosure = testEffect(closureFixtures.get("completed")!.layer)
  const drainedClosure = testEffect(closureFixtures.get("drain")!.layer)
  // #546：timeout 共终态夹具——短 timeout_ms + 挂起 SSE（tool-input-start 后不关流）。
  // 覆盖生产路径：timeoutOrElse 中断 attempt，而非 drain incomplete。
  // 回归锁：decision tool 必须 error，assistant 必须 time.completed（INV-01/02）。
  // 不断言私有 toolParts map；只读 fixture 持久化 parts/messages 快照。
  const timeoutClosureFixture = reviewerTimeoutClosureFixture()
  const timeoutClosure = testEffect(timeoutClosureFixture.layer)
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
      // [local-smark] 596 INV-02：reviewer 请求必须在 API 层强制决策工具（先例
      // session/prompt.ts structured-output toolChoice:"required"）；prompt-only
      // 强制在生产 DB 有 6/6 prose 漂移失败尾部。
      expect(body.tool_choice).toBe("required")
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

  // [local-smark] 596 INV-03 兼容重发：provider 显式拒绝 tool_choice 时同次评审去参
  // 重发恰一次；Set 记忆使同 provider 后续评审不再付费 400。三个用例使用互不
  // 共享的 fixture 实例（Set 存活于层闭包，跨 it 共享会造成顺序耦合）。
  const toolChoiceResendFixture = reviewerFixture(
    { type: "api", key: "test-key" },
    { requireInstructions: false, rejectToolChoice: true },
  )
  const toolChoiceResend = testEffect(toolChoiceResendFixture.layer)

  toolChoiceResend.effect("resends once without tool_choice after the provider rejects the parameter", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(reviewInput("review_toolchoice_resend"))

      expect(decision.action).toBe("allow")
      expect(toolChoiceResendFixture.bodies.length).toBe(2)
      expect(toolChoiceResendFixture.bodies[0]!.tool_choice).toBe("required")
      // 重发不强制：SDK 未强制时默认 tool_choice:"auto"，语义断言锁定「不再 required」
      expect(toolChoiceResendFixture.bodies[1]!.tool_choice).not.toBe("required")
    }),
  )

  const toolChoiceMemoryFixture = reviewerFixture(
    { type: "api", key: "test-key" },
    { requireInstructions: false, rejectToolChoice: true },
  )
  const toolChoiceMemory = testEffect(toolChoiceMemoryFixture.layer)

  toolChoiceMemory.effect("skips forcing tool_choice for later reviews after a provider rejection is learned", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* reviewer.review(reviewInput("review_toolchoice_learn_1"))
      const before = toolChoiceMemoryFixture.bodies.length
      yield* reviewer.review(reviewInput("review_toolchoice_learn_2"))

      expect(toolChoiceMemoryFixture.bodies.length).toBe(before + 1)
      expect(toolChoiceMemoryFixture.bodies[before]!.tool_choice).not.toBe("required")
    }),
  )

  const toolChoiceUnrelatedFixture = reviewerFixture(
    { type: "api", key: "test-key" },
    { requireInstructions: false, rejectToolChoiceUnrelated: true },
  )
  const toolChoiceUnrelated = testEffect(toolChoiceUnrelatedFixture.layer)

  toolChoiceUnrelated.effect("does not strip tool_choice for unrelated 400 rejections", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const exit = yield* Effect.exit(reviewer.review(reviewInput("review_toolchoice_unrelated")))

      expect(Exit.isSuccess(exit)).toBe(false)
      // 回归锁：与 tool_choice 无关的 400 不去参重发，维持原样失败（INV-06）
      expect(toolChoiceUnrelatedFixture.bodies.length).toBe(1)
    }),
  )

  // [local-smark] 596 INV-03 persist 生产常规路径：带 sessionID 的评审走 runReviewerAgent
  // 的 persist 分支（child message 行先建、tapError/onInterrupt 在协商入口之外）。
  // fixture 复用 parentSessionModelFixture 已验证的 session mock 形态（persist 组
  // 绿灯证明足以走通 persist 分支），fetch 复现 provider 对强制 tool_choice 的 400
  // 拒绝；断言重发成功且复用的 message 行无伪 error 终态（首次 400 无事件落库）。
  const persistResendFixture = reviewerPersistResendFixture()
  const persistResend = testEffect(persistResendFixture.layer)

  persistResend.effect("resends without tool_choice on the persist path and completes the reused message row once", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_toolchoice_persist", undefined, SessionID.make("session_parent_persist")),
      )

      expect(decision.action).toBe("allow")
      expect(persistResendFixture.bodies.length).toBe(2)
      expect(persistResendFixture.bodies[0]!.tool_choice).toBe("required")
      expect(persistResendFixture.bodies[1]!.tool_choice).not.toBe("required")
      const assistantMessages = [...persistResendFixture.messages.values()].filter(
        (m): m is MessageV2.Assistant => m.role === "assistant",
      )
      expect(assistantMessages).toHaveLength(1)
      const child = assistantMessages[0]!
      expect(child.finish).toBe("tool-calls")
      expect(child.error).toBeUndefined()
      expect(child.time.completed).toBeGreaterThan(0)
    }),
  )


  // 以下测试验证：未配置 permission.auto_review.model 时，hidden reviewer 应当
  // 跟随父会话当前模型，而不是受全局 state/model.json recent 漂移到另一个 provider。
  // 这直接复现了 zhipuai/glm-5.2 401 → “身份验证失败。” 的根因。
  const parentModelFixture = parentSessionModelFixture()
  const parentModel = testEffect(parentModelFixture.layer)

  parentModel.effect("uses parent session model instead of global default when auto_review.model is not configured", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_parent_model", undefined, SessionID.make("session_parent")),
      )

      // 当前实现如果用 defaultModel() 会选到 zhipuai（未注册），导致 reviewer 失败。
      // 修复后应使用父会话模型 openai/gpt-5 并返回 allow。
      expect(decision.action).toBe("allow")
      expect(decision.reason).toBe(REVIEWER_ASSESSMENT.rationale)
      // 请求实际打到了父会话 provider，而不是 defaultModel 返回的 zhipuai
      expect(parentModelFixture.bodies.length).toBeGreaterThan(0)
    }),
  )

  // 显式 auto_review.model 应优先于父会话模型；使用独立 fixture 配置不同的 reviewer model
  const explicitOverrideFixture = explicitModelOverrideFixture()
  const explicitOverride = testEffect(explicitOverrideFixture.layer)

  explicitOverride.effect("explicit auto_review.model overrides parent session model", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_explicit_override", undefined, SessionID.make("session_parent")),
      )
      // 父会话模型是 openai/gpt-5，但 auto_review.model 显式指定了 openai/gpt-5
      // （同一 provider 但验证显式路径独立于 parentSessionModel）。如果实现错误地
      // 先走 parentSessionModel 再被 auto_review.model 覆盖，仍应返回 allow。
      expect(decision.action).toBe("allow")
      // 请求应使用显式配置的 model，而非父会话模型路径
      expect(explicitOverrideFixture.bodies.length).toBeGreaterThan(0)
    }),
  )

  // 隐式候选的 exact model 已从 provider 移除时，应回退到 defaultModel 而非永久失败
  const staleModelFixture = staleParentModelFixture()
  const staleModel = testEffect(staleModelFixture.layer)

  staleModel.effect("falls back to defaultModel when parent session model is no longer registered", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const decision = yield* reviewer.review(
        reviewInput("review_stale_model", undefined, SessionID.make("session_parent")),
      )
      // 父会话模型已从 provider 移除（ModelNotFoundError），应回退到 defaultModel
      // 并最终返回 allow，而非让 reviewer 永久不可用
      expect(decision.action).toBe("allow")
      expect(staleModelFixture.bodies.length).toBeGreaterThan(0)
    }),
  )
  // [local-smark] reviewer 默认模型来源回归结束
  // [local-smark] reviewer token/breakdown 持久化测试开始
  // 验证 finish-step handler 将 provider 真实 usage 和 inputBreakdown 持久化到
  // step-finish part，修复 reviewer session 的 input=0 和 /context breakdown 为空。
  const tokenFixture = reviewerTokenCaptureFixture({ type: "api", key: "[redacted]" })
  const tokenTest = testEffect(tokenFixture.layer)

  tokenTest.effect("persists reviewer token usage and input breakdown in step-finish part", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* reviewer.review(reviewInput("review_token", undefined, SessionID.make("session_parent")))

      // 真实 SSE 的缓存输入和推理输出必须拆分，避免普通 token 与费用被重复计算。
      const stepFinish = tokenFixture.parts.find((p) => p.type === "step-finish")
      expect(stepFinish).toBeDefined()
      if (!stepFinish) throw new Error("missing reviewer step-finish")
      const sf = stepFinish
      expect(sf.tokens).toEqual({
        total: 19,
        input: 7,
        output: 4,
        reasoning: 3,
        cache: { read: 5, write: 0 },
      })

      // inputBreakdown + inputChars 使 tokenAccounting 的 breakdown 分配非 null
      expect(sf.inputChars).toBeGreaterThan(0)
      expect(sf.inputBreakdown).toBeDefined()
      if (!sf.inputBreakdown) throw new Error("missing reviewer input breakdown")
      // 非 OAuth：system 保留为 system message，instructions 为 0
      expect(sf.inputBreakdown.system).toBeGreaterThan(0)
      expect(sf.inputBreakdown.instructions).toBe(0)
      // permission_review_decision 工具定义计入 tools
      expect(sf.inputBreakdown.tools).toBeGreaterThan(0)
      // transcript + planned action 计入 userText
      expect(sf.inputBreakdown.messages.userText).toBeGreaterThan(0)
      // reviewer 上下文无历史 assistant 消息
      expect(sf.inputBreakdown.messages.assistantText).toBe(0)
    }),
  )

  // OAuth 路径：system message 被提取为顶层 instructions，breakdown 的
  // system/instructions 分区必须反映这一路由差异
  const oauthTokenFixture = reviewerTokenCaptureFixture(oauthAuth())
  const oauthTokenTest = testEffect(oauthTokenFixture.layer)

  oauthTokenTest.effect("routes system chars to instructions breakdown for OAuth reviewer", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* reviewer.review(reviewInput("review_token_oauth", undefined, SessionID.make("session_parent")))

      const stepFinish = oauthTokenFixture.parts.find((p) => p.type === "step-finish")
      expect(stepFinish).toBeDefined()
      if (!stepFinish) throw new Error("missing reviewer step-finish")
      const sf = stepFinish
      expect(sf.inputBreakdown).toBeDefined()
      if (!sf.inputBreakdown) throw new Error("missing reviewer input breakdown")
      // OAuth：system 内容被提取为 instructions，system 分区为 0
      expect(sf.inputBreakdown.system).toBe(0)
      expect(sf.inputBreakdown.instructions).toBeGreaterThan(0)
      expect(sf.inputBreakdown.messages.userText).toBeGreaterThan(0)
    }),
  )

  // non-persist 路径（无 sessionID）：不写任何 part，验证 finish-step handler
  // 的 persist guard 不会在无 session 场景产生副作用
  const noSessionTokenFixture = reviewerTokenCaptureFixture({ type: "api", key: "[redacted]" })
  const noSessionTokenTest = testEffect(noSessionTokenFixture.layer)

  noSessionTokenTest.effect("writes no step-finish part when reviewer has no session", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      // 不传 sessionID → reviewerSession=undefined → non-persist 路径
      yield* reviewer.review(reviewInput("review_token_nosession"))
      expect(noSessionTokenFixture.parts.find((p) => p.type === "step-finish")).toBeUndefined()
    }),
  )
  // [local-smark] reviewer token/breakdown 持久化测试结束


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
  // #497：三个 closure 行为用例——durable Part identity 注册先于首次写、
  // completed winner 不被 cleanup 覆盖、协议失败前 drain 闭合 open tools。
  pendingClosure.live("closes a pending decision Tool committed before updatePart returns", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const fiber = yield* reviewer
        .review(reviewInput("review_pending_closure", undefined, SessionID.make("session_parent_closure")))
        .pipe(Effect.forkChild)

      // readiness 在 durable store 写入后、updatePart 返回前发布，精确覆盖 SQLite
      // 已提交但 attempt registry 尚不可见的生产窗口；固定 sleep 无法证明这一边界。
      const fixture = closureFixtures.get("pending")!
      yield* Effect.promise(() => fixture.committed.promise).pipe(Effect.timeout("2 seconds"))
      yield* Fiber.interrupt(fiber)

      // 断言读取独立持久化副本，而非被中断调用的返回值；只有 attempt cleanup
      // 通过稳定 Part identity 重读并写终态，才能把这里的 pending 改成 error。
      const decision = [...fixture.parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(decision?.state.status).toBe("error")
      if (decision?.state.status !== "error") return
      expect(decision.state.error).toBe("Tool execution aborted")
      expect(decision.state.metadata?.interrupted).toBe(true)
    }),
  )

  completedClosure.live("preserves a completed decision Tool committed before updatePart returns", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      const fiber = yield* reviewer
        .review(reviewInput("review_completed_winner", undefined, SessionID.make("session_parent_closure")))
        .pipe(Effect.forkChild)

      // 该 barrier 位于 completed durable write 与调用返回之间，正好与 pending 用例
      // 形成竞态两侧；中断 cleanup 若信任旧 snapshot 就会错误覆盖已提交 winner。
      const fixture = closureFixtures.get("completed")!
      yield* Effect.promise(() => fixture.committed.promise).pipe(Effect.timeout("2 seconds"))
      yield* Fiber.interrupt(fiber)

      const decision = [...fixture.parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      // completed 是协议决策的权威终态；cleanup 只能重读后跳过，不能为了统一
      // abort 外观把已经成功持久化的 allow/deny 降级成 error。
      expect(decision?.state.status).toBe("completed")
      if (decision?.state.status !== "completed") return
      expect(decision.state.metadata.reviewID).toBe("review_completed_winner")
      expect(decision.state.output).toBe(JSON.stringify(REVIEWER_ASSESSMENT))
    }),
  )

  drainedClosure.live("closes open decision Tools before an incomplete stream failure escapes", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      // 协议失败仍走既有 retry/fallback policy；这里忽略最终 Exit，只验证每个 attempt
      // 在把失败交给外层前，已经关闭自己持久化的 Tool lifecycle。
      yield* Effect.exit(
        reviewer.review(reviewInput("review_drained_closure", undefined, SessionID.make("session_parent_closure"))),
      )

      const fixture = closureFixtures.get("drain")!
      const decisions = [...fixture.parts.values()].filter((part): part is MessageV2.ToolPart => part.type === "tool")
      // 至少一个 Tool 证明测试确实越过 tool-input-start；开放集合为空才对应 TUI
      // spinner 的生产输入，不能用 reviewer 最终失败本身替代 Part 终态断言。
      expect(decisions.length).toBeGreaterThan(0)
      expect(decisions.filter((part) => part.state.status === "pending" || part.state.status === "running")).toEqual([])
      expect(decisions.every((part) => part.state.status === "error")).toBe(true)
    }),
  )

  // #546：用户症状——timeout 后 message 已 Aborted/completed，permission_review_decision 不得仍 pending。
  // 独立期望：error 文案与 SessionProcessor.TOOL_ABORTED_ERROR 一致；不依赖私有 map。
  timeoutClosure.live("timeout after tool-input-start closes decision Tools before message completes", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* Effect.exit(
        reviewer.review(reviewInput("review_timeout_closure", undefined, SessionID.make("session_parent_closure"))),
      )

      const decisions = [...timeoutClosureFixture.parts.values()].filter(
        (part): part is MessageV2.ToolPart => part.type === "tool",
      )
      expect(decisions.length).toBeGreaterThan(0)
      expect(decisions.filter((part) => part.state.status === "pending" || part.state.status === "running")).toEqual([])
      expect(decisions.every((part) => part.state.status === "error")).toBe(true)
      expect(
        decisions.every((part) => part.state.status === "error" && part.state.error === "Tool execution aborted"),
      ).toBe(true)

      const assistants = [...timeoutClosureFixture.messages.values()].filter(
        (message): message is MessageV2.Assistant => message.role === "assistant",
      )
      expect(assistants.length).toBeGreaterThan(0)
      // INV-02：message 终态与 tool 终态同收；生产僵尸是 completed + pending 的分裂。
      expect(assistants.every((message) => message.time.completed !== undefined)).toBe(true)
    }),
  )

  // #546：复现生产半写——stream finalize 写 error 首次失败时，不得只留下 completed message + pending tool。
  // 旧路径：单次 finalize + catch void → message 仍 completed、tool 仍 pending。
  // 修复后：ensuring / 外层 finalize-before-message 再扫一次，第二次写成功即共终态。
  // 期望字面量独立于实现：status=error 且 error==="Tool execution aborted"。
  const timeoutWriteFailFixture = reviewerTimeoutClosureFixture({ failErrorWrites: true })
  const timeoutWriteFail = testEffect(timeoutWriteFailFixture.layer)
  timeoutWriteFail.live("timeout still closes decision Tools when first error write fails", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* Effect.exit(
        reviewer.review(reviewInput("review_timeout_write_fail", undefined, SessionID.make("session_parent_closure"))),
      )

      const decisions = [...timeoutWriteFailFixture.parts.values()].filter(
        (part): part is MessageV2.ToolPart => part.type === "tool",
      )
      expect(decisions.length).toBeGreaterThan(0)
      expect(decisions.filter((part) => part.state.status === "pending" || part.state.status === "running")).toEqual([])
      expect(
        decisions.every((part) => part.state.status === "error" && part.state.error === "Tool execution aborted"),
      ).toBe(true)

      const assistants = [...timeoutWriteFailFixture.messages.values()].filter(
        (message): message is MessageV2.Assistant => message.role === "assistant",
      )
      expect(assistants.length).toBeGreaterThan(0)
      expect(assistants.every((message) => message.time.completed !== undefined)).toBe(true)
    }),
  )

  // #531：durable 必红夹具：session.messages 读到仍为 pending 的父 ToolPart 时，promote 必须用
  // metadata.command 写出可渲染的 input.command，不能停在历史 { raw } 形状。
  // 常见 tool-call-first 路径上 SessionPrompt 集成断言往往已绿，故此 fixture 才是 owner 级红测。
  // 夹具强制 pending-at-review：不依赖 AI SDK 调度竞态，稳定复现 reviewing 窗 raw-only 缺陷。
  const pendingCommandFixture = parentToolPartReviewFixture(
    parentToolPartSeedMessage("call_pending_command", "pending", "cat id_rsa"),
  )
  const structuredKeepFixture = parentToolPartReviewFixture(
    parentToolPartSeedMessage("call_structured_keep", "running", "git push origin dev"),
  )
  const pendingCommand = testEffect(pendingCommandFixture.layer)
  const structuredKeep = testEffect(structuredKeepFixture.layer)

  pendingCommand.effect("promotes pending parent ToolPart using metadata.command as structured input", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      // tool 字段必须带 messageID/callID，否则 updateToolAutoReview 直接 no-op。
      const decision = yield* reviewer.review({
        ...reviewInput("review_pending_command", { command: "cat id_rsa" }),
        sessionID: SessionID.make("session_parent_tool"),
        tool: { messageID: "msg_tool_seed", callID: "call_pending_command" },
      })
      // decision allow 证明 reviewer 全链走通，提升写不是被静默跳过
      expect(decision.action).toBe("allow")
      // 捕获数组含 reviewing 与 allowed 两次 durable 写——终态断言必须取最后一次
      const part = pendingCommandFixture.captured.findLast(
        (item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === "call_pending_command",
      )
      expect(part?.state.status).toBe("running")
      if (part?.state.status !== "running") return
      // 用户可观察不变量：reviewing/allowed envelope 写入后 command 必须可渲染。
      // 旧实现会得到 input.raw 而无 command，TUI 显示 Writing command...
      expect((part.state.input as { command?: string }).command).toBe("cat id_rsa")
      expect(part.state.metadata?.autoReview?.status).toBe("allowed")
    }),
  )

  // #531 regression：已 structured 的 running input 在 merge autoReview 时不得被 { raw } 覆盖。
  // 该序在旧代码上常已绿，仍锁定 INV-02，防止选择逻辑回退。
  structuredKeep.effect("keeps structured running input when merging autoReview status", () =>
    Effect.gen(function* () {
      const reviewer = yield* PermissionReviewer.Service
      yield* reviewer.review({
        ...reviewInput("review_structured_keep", { command: "git push origin dev" }),
        sessionID: SessionID.make("session_parent_tool"),
        tool: { messageID: "msg_tool_seed", callID: "call_structured_keep" },
      })
      // 捕获数组含 reviewing 与 allowed 两次 durable 写——终态断言必须取最后一次
      const part = structuredKeepFixture.captured.findLast(
        (item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === "call_structured_keep",
      )
      expect(part?.state.status).toBe("running")
      if (part?.state.status !== "running") return
      // description 来自既有 structured input，不得被仅含 command 的 metadata 提升抹掉。
      expect((part.state.input as { command?: string }).command).toBe("git push origin dev")
      expect((part.state.input as { description?: string }).description).toBe("Push branch")
      expect(part.state.metadata?.autoReview?.status).toBe("allowed")
    }),
  )
})

// [local-smark] parentSessionModelFixture 开始
// 这个 fixture 模拟真实 bug 的触发条件：全局 defaultModel 返回一个未注册的
// provider（zhipuai），而父会话实际使用的是 openai/gpt-5。当前实现会让
// reviewer 走 defaultModel → zhipuai → getModel 失败 → fallback user；
// 修复后 reviewer 应跟随父会话模型走 openai 路径。
function parentSessionModelFixture() {
  const bodies: ReviewerRequestBody[] = []
  const requests: CapturedReviewerRequest[] = []
  const parentModel = reviewerModel(OPENAI_PROVIDER_ID)
  // defaultModel 返回的坏 provider：模拟 global state/model.json recent 漂移
  const BAD_DEFAULT = {
    providerID: ProviderV2.ID.make("zhipuai"),
    modelID: ModelV2.ID.make("glm-5.2"),
  }
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      requests.push({ body, headers: new Headers(init?.headers) })
      return new Response(openAIReviewDecisionStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model: parentModel,
    info: ProviderTest.info({ id: parentModel.providerID, options: {} }, parentModel),
    // 关键：defaultModel 返回坏 provider，用来暴露当前实现的漂移缺陷
    defaultModel: Effect.fn("ParentModelTest.defaultModel")(() => Effect.succeed(BAD_DEFAULT)),
    // 不提供 small model，确保 reviewer 使用 exact parent model 而非 small 变体
    getSmallModel: Effect.fn("ParentModelTest.getSmallModel")(() => Effect.succeed(undefined)),
    getLanguage: Effect.fn("ParentModelTest.getLanguage")((model: Provider.Model) => {
      // 只有父会话 provider 的 getLanguage 才应被调用；如果 defaultModel 的
      // zhipuai 被错误选中，这里会 die 并暴露回归
      if (model.providerID === parentModel.providerID)
        return Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5"))
      return Effect.die(new Error(`unexpected provider selected: ${model.providerID}`))
    }),
  })
  // 父会话 mock：携带 openai/gpt-5 模型信息
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent"),
    slug: "test",
    projectID: ProjectV2.ID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    agent: "auto",
    model: { id: parentModel.id, providerID: parentModel.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  }
  // reviewer child session mock：getReviewerSession 会复用它
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const partStore = sessionPartStore()
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (msg) => Effect.succeed(msg),
    ...partStore,  // #497：getPart/updatePart 共享 durable store——生产代码新增权威读取边界
    // #327：resolveImplicitReviewerModel 会走 findMessage 找最近带 model 的 user message；
    // mock 返回 none 让其回退到 SessionTable.model（本 fixture 的主路径）
    findMessage: () => Effect.succeed(Option.none()),
  })
  return {
    bodies,
    requests,
    layer: PermissionReviewer.layer.pipe(
      // 不配置 auto_review.model，测试隐式模型选择跟随父会话
      Layer.provide(
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              permission: {
                approvals_reviewer: "auto_review",
                auto_review: { policy: "Reviewer service test policy: allow only bounded auto requests." },
              },
            }),
        }),
      ),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #327：reviewer layer 依赖 Database（#206 谱系）——与旧 fixture 相同的空 mock，测试不触真实库
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}
// [local-smark] parentSessionModelFixture 结束

// [local-smark] explicitModelOverrideFixture 开始
// 验证显式 auto_review.model 优先于父会话模型：配置 auto_review.model 指向
// openai/gpt-5，父会话模型也是 openai/gpt-5，但 config 路径独立于
// parentSessionModel，确保显式分支不被隐式逻辑覆盖。
function explicitModelOverrideFixture() {
  const bodies: ReviewerRequestBody[] = []
  const requests: CapturedReviewerRequest[] = []
  const parentModel = reviewerModel(OPENAI_PROVIDER_ID)
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      requests.push({ body, headers: new Headers(init?.headers) })
      return new Response(openAIReviewDecisionStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model: parentModel,
    info: ProviderTest.info({ id: parentModel.providerID, options: {} }, parentModel),
    getSmallModel: Effect.fn("ExplicitOverride.getSmallModel")(() => Effect.succeed(undefined)),
    getLanguage: Effect.fn("ExplicitOverride.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent"),
    slug: "test",
    projectID: ProjectV2.ID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    agent: "auto",
    model: { id: parentModel.id, providerID: parentModel.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const partStore = sessionPartStore()
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (msg) => Effect.succeed(msg),
    ...partStore,  // #497：getPart/updatePart 共享 durable store——生产代码新增权威读取边界
    // #327：resolveImplicitReviewerModel 会走 findMessage 找最近带 model 的 user message；
    // mock 返回 none 让其回退到 SessionTable.model（本 fixture 的主路径）
    findMessage: () => Effect.succeed(Option.none()),
  })
  return {
    bodies,
    requests,
    layer: PermissionReviewer.layer.pipe(
      // 显式配置 auto_review.model，验证它优先于父会话模型
      Layer.provide(
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              permission: {
                approvals_reviewer: "auto_review",
                auto_review: {
                  model: `${OPENAI_PROVIDER_ID}/gpt-5`,
                  policy: "Reviewer service test policy: allow only bounded auto requests.",
                },
              },
            }),
        }),
      ),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #327：reviewer layer 依赖 Database（#206 谱系）——与旧 fixture 相同的空 mock，测试不触真实库
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}
// [local-smark] explicitModelOverrideFixture 结束

// [local-smark] staleParentModelFixture 开始
// 验证隐式候选 exact model 已从 provider 移除时（ModelNotFoundError），
// reviewer 应回退到 defaultModel 而非永久失败。父会话模型指向一个
// getModel 会抛 ModelNotFoundError 的 provider，defaultModel 返回有效 provider。
function staleParentModelFixture() {
  const bodies: ReviewerRequestBody[] = []
  const requests: CapturedReviewerRequest[] = []
  const validModel = reviewerModel(OPENAI_PROVIDER_ID)
  // 父会话记录了一个已失效的 provider（模拟 provider 从配置中移除后的 stale session）
  const STALE_PROVIDER = ProviderV2.ID.make("stale-provider")
  const STALE_MODEL = ModelV2.ID.make("removed-model")
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      requests.push({ body, headers: new Headers(init?.headers) })
      return new Response(openAIReviewDecisionStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model: validModel,
    info: ProviderTest.info({ id: validModel.providerID, options: {} }, validModel),
    // defaultModel 返回有效 provider，作为 stale model 的回退目标
    defaultModel: Effect.fn("StaleModel.defaultModel")(() =>
      Effect.succeed({ providerID: validModel.providerID, modelID: validModel.id }),
    ),
    getSmallModel: Effect.fn("StaleModel.getSmallModel")(() => Effect.succeed(undefined)),
    // getModel 对 stale provider 抛 ModelNotFoundError，对 valid provider 正常返回
    getModel: Effect.fn("StaleModel.getModel")((providerID: ProviderV2.ID, modelID: ModelV2.ID) =>
      Effect.gen(function* () {
        if (providerID === STALE_PROVIDER)
          return yield* new Provider.ModelNotFoundError({ providerID: STALE_PROVIDER, modelID: STALE_MODEL })
        if (providerID === validModel.providerID && modelID === validModel.id) return validModel
        return yield* Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
      }),
    ),
    getLanguage: Effect.fn("StaleModel.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  // 父会话携带已失效的模型，触发 ModelNotFoundError 回退路径
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent"),
    slug: "test",
    projectID: ProjectV2.ID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    agent: "auto",
    model: { id: STALE_MODEL, providerID: STALE_PROVIDER },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const partStore = sessionPartStore()
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (msg) => Effect.succeed(msg),
    ...partStore,  // #497：getPart/updatePart 共享 durable store——生产代码新增权威读取边界
    // #327：resolveImplicitReviewerModel 会走 findMessage 找最近带 model 的 user message；
    // mock 返回 none 让其回退到 SessionTable.model（本 fixture 的主路径）
    findMessage: () => Effect.succeed(Option.none()),
  })
  return {
    bodies,
    requests,
    layer: PermissionReviewer.layer.pipe(
      // 不配置 auto_review.model，测试隐式候选回退
      Layer.provide(
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              permission: {
                approvals_reviewer: "auto_review",
                auto_review: { policy: "Reviewer service test policy: allow only bounded auto requests." },
              },
            }),
        }),
      ),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #327：reviewer layer 依赖 Database（#206 谱系）——与旧 fixture 相同的空 mock，测试不触真实库
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}
// [local-smark] staleParentModelFixture 结束
// [local-smark] reviewer token/breakdown 持久化验证 fixture
// 复用 parentSessionModelFixture 的 sessionID + Session.Service mock 结构，
// 但 updatePart 捕获所有写入的 part，用于断言 step-finish part 是否携带
// provider 真实 usage（tokens/cost）和 per-component inputBreakdown。
// 支持 API key 和 OAuth 两种 auth，以验证 system/instructions 路由差异。
function reviewerTokenCaptureFixture(authInfo: Auth.Info) {
  const parts: SessionV1.Part[] = []
  const model = reviewerModel(OPENAI_PROVIDER_ID)
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      // fake SSE 始终返回携带 usage 的 response.completed，使 AI SDK 发出
      // finish-step 事件——这是 handler 持久化真实 usage 的触发点
      new Response(openAIReviewDecisionStream({ input: 12, output: 7, cached: 5, reasoning: 3 }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ReviewerTokenTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent"),
    slug: "test",
    projectID: ProjectV2.ID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    agent: "auto",
    model: { id: model.id, providerID: model.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  }
  // reviewer child session mock：getReviewerSession 会复用它
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input?: any) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (msg) => Effect.succeed(msg),
    // #497：捕获仍推 parts 数组供断言；getPart/updatePart 共享同一 durable store——
    // 生产代码新增的权威读取边界（getPart）在该 fixture 同样生效。
    getPart: (input) =>
      Effect.succeed(
        [...parts].reverse().find((part) => part.id === input.partID),
      ),
    updatePart: (part) => {
      parts.push(part)
      return Effect.succeed(part)
    },
  })
  return {
    parts,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              permission: {
                approvals_reviewer: "auto_review",
                auto_review: {
                  model: `${OPENAI_PROVIDER_ID}/gpt-5`,
                  policy: "Reviewer token test policy.",
                },
              },
            }),
        }),
      ),
      Layer.provide(provider.layer),
      Layer.provide(authLayer(authInfo)),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #261 谱系：PermissionReviewer.layer 依赖 Database（session 表读取），
      // 空链 mock 闭合 R=Service（同 emptyReviewerDb 先例）。
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}

// [local-smark] 596 persist 路径重发夹具：session mock 形态复用 parentSessionModelFixture
// （get/children/create/updateMessage + sessionPartStore），updateMessage 额外捕获
// child assistant 终态供「重发复用同一 message 行且无伪 error 终态」断言。
function reviewerPersistResendFixture() {
  const bodies: ReviewerRequestBody[] = []
  const messages = new Map<string, MessageV2.Assistant | MessageV2.User>()
  const parts = new Map<string, MessageV2.Part>()
  const model = reviewerModel(OPENAI_PROVIDER_ID)
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ReviewerRequestBody
      bodies.push(body)
      if (body.tool_choice === "required") {
        return new Response(JSON.stringify({ detail: "Unsupported parameter: tool_choice" }), {
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
    getLanguage: Effect.fn("ReviewerPersistResendTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent_persist"),
    slug: "parent-persist",
    projectID: ProjectV2.ID.make("project_reviewer_persist"),
    directory: "/tmp",
    title: "Parent persist",
    model: { id: model.id, providerID: model.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer_persist"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (message) =>
      Effect.sync(() => {
        messages.set(message.id, structuredClone(message))
        return message
      }),
    getPart: (input) => Effect.succeed(parts.get(input.partID)),
    updatePart: (part) =>
      Effect.sync(() => {
        parts.set(part.id, structuredClone(part))
        return part
      }),
    findMessage: () => Effect.succeed(Option.none()),
  })
  return {
    bodies,
    messages,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config(model.providerID)) })),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // 596：reviewer layer 依赖 Database（#206 谱系）——空 mock 闭合，persist 路径不触真实库
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}

function reviewerFixture(
  authInfo: Auth.Info | undefined,
  // #261：扩展 options 支持 plugin 层和 rejectMaxOutputTokens
  options: {
    requireInstructions: boolean
    providerID?: ProviderV2.ID
    rejectMaxOutputTokens?: boolean
    // [local-smark] 596：rejectToolChoice 复现生产 provider 拒绝 tool_choice 的 400
    // 形态（报文含 "tool_choice"）；rejectToolChoiceUnrelated 复现报文不含该词的
    // 无关 400，验证窄匹配不会把其它参数错误误解成需要去参重发（INV-06）。
    rejectToolChoice?: boolean
    rejectToolChoiceUnrelated?: boolean
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
      // [local-smark] 596：两种 400 形态只在请求携带强制 tool_choice==="required" 时触发；
      // SDK 在未强制时默认发 tool_choice:"auto"（今日生产请求同形且被 provider 接受），
      // 与生产一致，400 发生在任何 stream 事件之前。
      if ((options.rejectToolChoice || options.rejectToolChoiceUnrelated) && body.tool_choice === "required") {
        const detail = options.rejectToolChoice
          ? "Unsupported parameter: tool_choice"
          : "Instructions are required"
        return new Response(JSON.stringify({ detail }), {
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
      // #493：sync 字段随 Interface 一同 mock——review 路径不触冷存储同步 client。
      Layer.provide(Layer.mock(Database.Service)({ db: undefined as never, sync: undefined as never })),
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

function reviewInput(
  reviewID: string,
  metadata?: Readonly<Record<string, unknown>>,
  sessionID?: SessionID,
) {
  return {
    reviewID,
    // 传入 sessionID 时，reviewer 可以读取父会话当前模型；不传时保持原有行为
    ...(sessionID ? { sessionID } : {}),
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

function openAIReviewDecisionStream(usage?: { input: number; output: number; cached: number; reasoning: number }) {
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
        usage: {
          input_tokens: usage?.input ?? 1,
          input_tokens_details: usage ? { cached_tokens: usage.cached } : null,
          output_tokens: usage?.output ?? 1,
          output_tokens_details: usage ? { reasoning_tokens: usage.reasoning } : null,
        },
        service_tier: null,
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
}


// #546：timeout 共终态夹具——SSE 发出 tool-input-start 后永不关流，per-attempt timeout_ms=80
// 触发 timeoutOrElse 中断（而非 drain incomplete）；messages/parts 内存快照供终态断言。
function reviewerTimeoutClosureFixture(options: { failErrorWrites?: boolean } = {}) {
  const parts = new Map<string, MessageV2.Part>()
  const messages = new Map<string, MessageV2.Assistant>()
  let errorWriteFailures = 0
  const model = reviewerModel(OPENAI_PROVIDER_ID)
  // 挂起 body 命中中断路径：与「有限 Response 立刻 drain」不同，保持连接挂起才对应
  // 生产僵尸 lag≈90s 的 timeout 窗口（timeoutOrElse interrupt 而非 incomplete finalize）。
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // 只发工具开始和未完成参数；不能复用含response.completed的drain夹具来伪装timeout。
          const events = [
            { type: "response.created", response: { id: "resp_timeout", created_at: 0, model: "gpt-5", service_tier: null } },
            { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_timeout", call_id: "call_timeout", name: "permission_review_decision", arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_timeout", output_index: 0, delta: "{" },
          ]
          controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")))
        },
        cancel() {},
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ReviewerTimeoutClosureTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent_closure"),
    slug: "parent-closure",
    projectID: ProjectV2.ID.make("project_reviewer_closure"),
    directory: "/tmp",
    title: "Parent closure",
    model: { id: model.id, providerID: model.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer_closure"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    // 父级transcript读取不伪造消息；durable补扫走精确Part读取，不借用最近消息窗口。
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (message) =>
      Effect.sync(() => {
        // 在写入完成消息的当刻检查tool，不能仅凭最终快照证明先tool后message。
        if (message.role === "assistant" && message.time.completed !== undefined) expect([...parts.values()].filter((part) => part.messageID === message.id && part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))).toEqual([])
        messages.set(message.id, structuredClone(message) as MessageV2.Assistant)
        return message
      }),
    findMessage: () => Effect.succeed(Option.none()),
    getPart: (input) => Effect.succeed(parts.get(input.partID)),
    // #546：failErrorWrites——首次 error 终态写以 defect 失败，对应旧实现 catch void 后
    // message 仍 completed、tool 仍 pending 的半写；计数器只失败一次，验证二次 finalize 写成功。
    updatePart: (part) =>
      Effect.sync(() => {
        if (
          options.failErrorWrites &&
          part.type === "tool" &&
          part.state.status === "error" &&
          errorWriteFailures < 1
        ) {
          errorWriteFailures += 1
          throw new Error("simulated terminal tool write failure")
        }
        parts.set(part.id, structuredClone(part))
        return part
      }),
  })
  return {
    parts,
    messages,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(
        TestConfig.layer({
          get: () =>
            Effect.succeed(
              config(model.providerID, {
                approvals_reviewer: "auto_review",
                auto_review: {
                  model: `${model.providerID}/gpt-5`,
                  // 三次 attempt × 80ms 仍远小于默认 90s；测的是退出共终态，不是重试策略本身。
                  // 重试次数保持生产默认，避免为测速改写 MAX_REVIEWER_ATTEMPTS。
                  timeout_ms: 80,
                  policy: "Reviewer service test policy: allow only the bounded fixture command.",
                },
              }),
            ),
        }),
      ),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #497：reviewer layer 依赖 Database（#206 谱系）——空链 mock 闭合 R。
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}

function reviewerClosureFixture(block: "pending" | "completed" | "drain") {
  const parts = new Map<string, MessageV2.Part>()
  const committed = Promise.withResolvers<void>()
  const model = reviewerModel(OPENAI_PROVIDER_ID)
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(block === "completed" ? openAIReviewDecisionStream() : openAIReviewPendingStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ReviewerClosureTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent_closure"),
    slug: "parent-closure",
    projectID: ProjectV2.ID.make("project_reviewer_closure"),
    directory: "/tmp",
    title: "Parent closure",
    model: { id: model.id, providerID: model.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer_closure"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  // #497：review 带 sessionID 时 resolveImplicitReviewerModel 会走 findMessage——mock none。
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    messages: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (message) => Effect.succeed(message),
    findMessage: () => Effect.succeed(Option.none()),
    getPart: (input) => Effect.succeed(parts.get(input.partID)),
    updatePart: (part) =>
      Effect.gen(function* () {
        // structuredClone 模拟 projector 的持久化快照，防止生产代码随后修改同一引用
        // 让测试误以为发生了第二次 durable write。
        parts.set(part.id, structuredClone(part))
        // pending barrier 验证 cleanup 能发现"已提交、未返回"的新 Part；completed barrier
        // 验证同一窗口内的 terminal winner 不会被 registry 中的旧阶段覆盖。
        if (
          part.type === "tool" &&
          ((block === "pending" && part.state.status === "pending") ||
            (block === "completed" && part.state.status === "completed"))
        ) {
          committed.resolve()
          // 事务已经提交；这里模拟 EventV2 后续可中断的 notify/return 边界。
          return yield* Effect.never
        }
        return part
      }),
  })
  return {
    parts,
    committed,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config(model.providerID)) })),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #497：reviewer layer 依赖 Database（#206 谱系）——空链 mock 闭合 R。
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}

// #531：种子消息构造——messages mock 的返回形状与生产 session.messages 一致（info+parts），
// info 只需满足 updateToolAutoReview 的 m.info.id 匹配，最小对象即可。
function parentToolPartSeedMessage(callID: string, status: "pending" | "running", command: string) {
  const seedPart = {
    id: "part_tool_seed",
    sessionID: SessionID.make("session_parent_tool"),
    messageID: "msg_tool_seed",
    type: "tool",
    callID,
    tool: "bash",
    state:
      status === "pending"
        ? { status, input: {}, raw: JSON.stringify({ command, description: "Read key" }) }
        : { status, input: { command, description: "Push branch" }, time: { start: 1 } },
  } as MessageV2.ToolPart
  return {
    info: { id: "msg_tool_seed", sessionID: seedPart.sessionID, role: "assistant", time: { created: 1 } },
    parts: [seedPart],
  } as unknown as MessageV2.WithParts
}

// #531：durable 提升夹具——session.messages 种子父 ToolPart（pending 或 running），
// updatePart 经 sessionPartStore 捕获；updateToolAutoReview 的真实选择逻辑全链可测。
function parentToolPartReviewFixture(seed: MessageV2.WithParts) {
  const model = reviewerModel(OPENAI_PROVIDER_ID)
  const captured: MessageV2.Part[] = []
  const fetch = Object.assign(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(openAIReviewDecisionStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    { preconnect: () => {} },
  )
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ id: model.providerID, options: {} }, model),
    getLanguage: Effect.fn("ParentToolPartReviewTest.getLanguage")(() =>
      Effect.succeed(createOpenAI({ apiKey: "test", fetch }).responses("gpt-5")),
    ),
  })
  const parentSession: Session.Info = {
    id: SessionID.make("session_parent_tool"),
    slug: "parent-tool",
    projectID: ProjectV2.ID.make("project_reviewer_tool"),
    directory: "/tmp",
    title: "Parent tool part",
    model: { id: model.id, providerID: model.providerID },
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const childSession: Session.Info = {
    ...parentSession,
    id: SessionID.make("session_reviewer_tool"),
    parentID: parentSession.id,
    agent: "permission-reviewer",
    title: "Auto permission review",
  }
  const sessionLayer = Layer.mock(Session.Service)({
    get: () => Effect.succeed(parentSession),
    // #531：messages 必须真正返回种子消息——updateToolAutoReview 经 #208 的
    // session.messages 读父 ToolPart；返回空数组会让提升 no-op，测试沦为双绿空洞。
    messages: () => Effect.succeed([seed]),
    children: () => Effect.succeed([]),
    create: (input) => Effect.succeed({ ...childSession, ...input } as Session.Info),
    updateMessage: (message) => Effect.succeed(message),
    findMessage: () => Effect.succeed(Option.none()),
    ...sessionPartStore(captured),
  })
  return {
    captured,
    layer: PermissionReviewer.layer.pipe(
      Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config(model.providerID)) })),
      Layer.provide(provider.layer),
      Layer.provide(authLayer({ type: "api", key: "test-key" })),
      Layer.provide(pluginLayer()),
      Layer.provide(sessionLayer),
      // #497：reviewer layer 依赖 Database（#206 谱系）——空链 mock 闭合 R。
      Layer.provide(Layer.succeed(Database.Service, emptyReviewerDb)),
    ),
  }
}

// #497：既有 fixture 的 durable store 语义 retrofit——getPart 与 updatePart 共享同一 store，
// 保证旧测试也经过生产新增的权威读取边界；若仍只回显 update 参数，completed 测试会绕过
// 本次修复真正依赖的持久化语义。
function sessionPartStore(captured?: MessageV2.Part[]) {
  const parts = new Map<string, MessageV2.Part>()
  const getPart: Session.Interface["getPart"] = (input) => Effect.succeed(parts.get(input.partID))
  const updatePart: Session.Interface["updatePart"] = (part) =>
    Effect.sync(() => {
      // reviewer 的生产路径现在以 durable Part 为权威；通用 fixture 同时实现读写合同，
      // 避免旧 mock 只回显参数而掩盖 pending -> completed 的真实持久化转换。
      parts.set(part.id, structuredClone(part))
      captured?.push(part)
      return part
    })
  return { getPart, updatePart }
}

// #497：pending-only 流保留目标 decision 事件骨架及合法 JSON，但参数不满足 Assessment。
// 目标 SDK 能发布 tool 事件，业务决策仍失败；开放 Part 必须由本 attempt 闭合。
function openAIReviewPendingStream() {
  return [
    { type: "response.created", response: { id: "resp_pending", created_at: 0, model: "gpt-5", service_tier: null } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_pending", call_id: "call_pending", name: "permission_review_decision", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_pending", output_index: 0, delta: JSON.stringify({ outcome: "bogus", rationale: 42 }).slice(0, 12) },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_pending",
        call_id: "call_pending",
        name: "permission_review_decision",
        arguments: JSON.stringify({ outcome: "bogus", rationale: 42 }),
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

import { Effect } from "effect"
import { PermissionPrecheck } from "./precheck"

// #202：自动决策类型——allow/ask/deny 三态，source 追踪决策来源（precheck 或 reviewer）
// #202：ask 的 source 扩展为 precheck | reviewer_unavailable：general 层级在 strict 关闭时直接回退用户审批
export type Decision =
  | { action: "allow"; reason: string; source: "precheck" | "reviewer"; reviewID?: string; precheckLevel?: PermissionPrecheck.Level }
  | { action: "ask"; reason: string; source: "precheck" | "reviewer_unavailable" }
  | { action: "deny"; reason: string; source: "precheck" | "reviewer"; reviewID?: string }

// #198：reviewer 输出比 Decision 更窄——到达 review 边界后模型必须决定 allow/deny，用户回退由 reviewer 错误表示而非第三种 outcome，使策略失败和 reviewer 不可用保持可区分
export type ReviewDecision =
  | {
      action: "allow"
      reason: string
      reviewID: string
      risk_level: "low" | "medium" | "high" | "critical"
      user_authorization: "unknown" | "low" | "medium" | "high"
    }
  | {
      action: "deny"
      reason: string
      reviewID: string
      risk_level: "low" | "medium" | "high" | "critical"
      user_authorization: "unknown" | "low" | "medium" | "high"
    }

export interface ReviewInput {
  // #208：reviewID 在 auto.ts mint 后传递给 reviewer——UI 和审计事件可引用同一逻辑审查即使模型超时
  readonly reviewID: string
  readonly sessionID?: string
  readonly permission: string
  readonly patterns: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  // #208：tool 可选绑定——reviewer 标记工具状态为 reviewing 供 UI 展示进度
  // #208：messageID 用 string 而非 MessageID brand——PermissionV1.Request.tool 用 Schema.String
  readonly tool?: { readonly messageID: string; readonly callID: string }
  // #202：precheck 以 level（safe/general/cautious/dangerous）而非 action 传递给 reviewer，避免把确定性风险分层误解成最终执行决策
  readonly precheck: { readonly level: PermissionPrecheck.Level; readonly reason: string }
}

// #198：reviewer 通过注入而非构造——确定性路由可在无 provider/session 层时测试。
  // #264：缺失 reviewer wiring 时遵循与运行时 reviewer 失败相同的显式 fallback 策略
export interface Reviewer {
  readonly review: (input: ReviewInput) => Effect.Effect<ReviewDecision, unknown>
}

export function evaluate(
  input: {
    permission: string
    patterns: readonly string[]
    metadata: Readonly<Record<string, unknown>>
    tool?: { readonly messageID: string; readonly callID: string }
    strict?: boolean
    // #264：布尔 reviewerDisabled 改为显式枚举——策略语义（deny/user）由调用方声明而非隐含在布尔里
    reviewerFailureFallback?: "deny" | "user"
  },
  reviewer?: Reviewer,
  // #208：onReviewStart 在 reviewer 调用前回调——发布 ReviewStarted 事件供 UI 展示进度
  onReviewStart?: (input: {
    readonly reviewID: string
    readonly precheck: { readonly level: PermissionPrecheck.Level; readonly reason: string }
  }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    // 等待共享grammar取得原level/reason，后续审批与授权政策保持原分支。
    const precheck = yield* Effect.promise(() => PermissionPrecheck.evaluate(input))
    // 五级路由：forbidden终审拒绝；cautious/dangerous进入既有reviewer及失败回退。
    // safe/general默认直过，strict仍保留低风险也审的用户配置，不新增权限执行owner。
    if (precheck.level === "forbidden") return { action: "deny", reason: precheck.reason, source: "precheck" } satisfies Decision
    if (precheck.level === "safe" && !input.strict) {
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    if (precheck.level === "general" && !input.strict) {
      // #232：general 是"未知但未命中 cautious/dangerous"的确定性 allow 边界；reviewer
      // #232：只承接 cautious。这样普通 edit/add/update 和未知 shell 不会消耗 LLM 或
      // #232：回到可点击 ask，真正敏感的 delete/external-directory 会先被 precheck 提升。
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }

    // #203：cautious 是 review 边界——确定性 precheck 发现可见风险但非立即禁止，reviewer 必须显式返回 allow/deny
    // #203：原生 auto 不能在 reviewer 缺失时降级回可点击的用户 ask；fail closed 防止敏感 shell 输出因点 Allow 暴露
    // #264：reviewer 基础设施失败不同于策略 deny：默认回到用户审批边界
    const fallbackToUser = input.reviewerFailureFallback !== "deny"
    if (!reviewer) {
      // #264：无 reviewer 时默认回到用户 ask；fallback=deny 保留 terminal fail-closed
      if (fallbackToUser) return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision
      return { action: "deny", reason: `auto reviewer unavailable: ${precheck.reason}`, source: "reviewer" } satisfies Decision
    }

    // #208：reviewID 在模型调用前 mint——进度 UI 和最终审计事件可引用同一逻辑审查即使模型超时或失败
    const reviewID = crypto.randomUUID()
    // #208：onReviewStart 在 reviewer 调用前回调——发布 ReviewStarted 事件供 UI 展示进度
    if (onReviewStart) {
      yield* onReviewStart({ reviewID, precheck })
    }

    // #202：reviewer 调用——precheck.level 传递实际层级使 reviewer 契约一致，strict 模式在 reason 中标注以供审计
    return yield* reviewer.review({
      ...input,
      reviewID,
      precheck: {
        level: precheck.level,
        // #202：strict 模式保留穿越边界的原因——safe/general 经 strict 送审时标注，cautious 保持原 reason
        reason: input.strict && precheck.level !== "cautious" ? `strict auto review required: ${precheck.reason}` : precheck.reason,
      },
    }).pipe(
      // #264：defect 不应绕过权限边界，视为 reviewer 不可用以达到 ask fallback
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.match({
        onFailure: (error) => {
          // #264：所有 reviewer 服务和 provider 失败都是基础设施问题，非策略 deny
          if (fallbackToUser) {
            return { action: "ask", reason: errorMessage(error), source: "reviewer_unavailable" } satisfies Decision
          }
          // #264：fallback=deny 下重试耗尽仍终竭拒绝——基础设施工具故障不得放行
          return { action: "deny", reason: reviewerFailureMessage(error), source: "reviewer", reviewID } satisfies Decision
        },
        onSuccess: (reviewed) => {
          // #198：硬护栏——矛盾模型输出转为 deny，防止 malformed allow 削弱确定性 precheck 或租户策略
          const invalid = invalidReviewContract(reviewed)
          // #198：合约校验失败时 deny——空 rationale、critical+allow、非低风险+allow+unknown authorization 均为矛盾输出
          if (invalid) return { action: "deny", reason: invalid, source: "reviewer", reviewID: reviewed.reviewID } satisfies Decision
          // #198：合约校验通过时透传 reviewer 决策——allow/deny 和风险等级由模型基于 transcript 和策略判定
          return {
            action: reviewed.action,
            reason: reviewed.reason,
            source: "reviewer",
            reviewID: reviewed.reviewID,
            // 两代消费点据实际层级禁止缓存dangerous批准，不能把一次授权放大到后续同形请求。
            ...(reviewed.action === "allow" ? { precheckLevel: precheck.level } : {}),
          } satisfies Decision
        },
      }),
    )
  })
}

// #198：提取 _tag——TaggedErrorClass 暴露 _tag，但测试可能用普通对象断言路由行为
function errorTag(error: unknown) {
  return error && typeof error === "object" && "_tag" in error && typeof error._tag === "string" ? error._tag : undefined
}

// #198：提取错误消息——provider/model 错误在 deny reason 中暴露用于诊断，但 AutoDeniedError 仍阻止鼓励绕过策略的重试建议
// #232：tool-origin 证据校验整体移除——external_directory 边界统一 cautious，
// #232：不再需要逐工具 operation/payload 证据判定是否进入 reviewer。
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function reviewerFailureMessage(error: unknown) {
  const tag = errorTag(error)
  // #198：超时使用稳定 reason——常见运维故障应与 reviewer 策略 deny 清晰区分
  if (tag === "PermissionReviewerTimedOut") return "auto reviewer timed out; failing closed without executing the tool call"
  return `auto reviewer failed closed: ${errorMessage(error)}`
}

// #198：合约校验——重复 prompt 的 outcome 策略但不尝试评分每个答案，仅捕获将 reviewer 变成安全降级的矛盾
function invalidReviewContract(reviewed: ReviewDecision) {
  // #198：空 rationale 拒绝——模型必须解释决策依据，无理由的 allow 无法审计
  if (!reviewed.reason.trim()) return "auto reviewer returned an empty rationale; failing closed"
  // #198：critical 风险 + allow 矛盾——critical 表示不可逆损害，模型不应在无防护下放行
  if (reviewed.action === "allow" && reviewed.risk_level === "critical") {
    return "auto reviewer returned allow for critical risk; failing closed"
  }
  // #198：非低风险 + allow + unknown authorization 矛盾——非低风险需明确授权证据，无授权时 deny
  if (reviewed.action === "allow" && reviewed.risk_level !== "low" && reviewed.user_authorization === "unknown") {
    return "auto reviewer allowed a non-low-risk request without user authorization evidence; failing closed"
  }
}

export * as PermissionAuto from "./auto"

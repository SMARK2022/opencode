import { Effect } from "effect"
import { PermissionPrecheck } from "./precheck"

// #198：自动决策类型——allow/ask/deny 三态，source 追踪决策来源（precheck 或 reviewer），ask 表示 reviewer 不可用时回退到用户审批
export type Decision =
  | { action: "allow"; reason: string; source: "precheck" | "reviewer"; reviewID?: string }
  | { action: "ask"; reason: string; source: "reviewer_unavailable" }
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
  readonly sessionID?: string
  readonly permission: string
  readonly patterns: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly precheck: { readonly action: "prompt"; readonly reason: string }
}

// #198：reviewer 通过注入而非构造——确定性路由可在无 provider/session 层时测试，且在小型运行时无 reviewer 时 fail closed
export interface Reviewer {
  readonly review: (input: ReviewInput) => Effect.Effect<ReviewDecision, unknown>
}

export function evaluate(
  input: { permission: string; patterns: readonly string[]; metadata: Readonly<Record<string, unknown>>; strict?: boolean },
  reviewer?: Reviewer,
) {
  return Effect.gen(function* () {
    // #198：路由顺序：precheck 先于 reviewer——确定性层拦截已知安全/危险命令，仅 prompt 命令才消耗 reviewer 配额
    const precheck = PermissionPrecheck.evaluate(input)
    // #198：fast-path allow 保留无提示行为——strict 仅禁用此快速路径，critical deny 仍在 reviewer 前生效，危险载荷永不成为模型决策
    if (precheck.action === "allow" && !input.strict) {
      // #198：precheck allow 直接放行——这些命令已通过只读不变量验证，无需 reviewer 审查
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    // #198：precheck deny 直接拒绝——危险载荷在 reviewer 前拦截，防止模型被说服放行已知危险命令
    if (precheck.action === "deny") return { action: "deny", reason: precheck.reason, source: "precheck" } satisfies Decision

    // #198：prompt 是 review 边界——确定性 precheck 无法安全决定时，reviewer 必须显式返回 allow/deny；无 reviewer 时回退到用户审批
    // #198：无 reviewer 注入时回退到 ask——保持原有用户审批路径，不因缺少 reviewer 而阻断
    if (!reviewer) return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision

    // #198：reviewer 调用——precheck.action 固定为 prompt 使 reviewer 契约一致，strict 模式在 reason 中标注以供审计
    return yield* reviewer.review({
      ...input,
      precheck: {
        action: "prompt",
        // #198：strict 模式复用同一 reviewer 契约（precheck.action 始终为 prompt），但保留穿越边界的原因供审计日志区分
        reason: input.strict && precheck.action === "allow" ? `strict auto review required: ${precheck.reason}` : precheck.reason,
      },
    }).pipe(
      Effect.match({
        onFailure: (error) => {
          const tag = errorTag(error)
          // #198：Disabled/FallbackToUser 是显式服务信号，回退到用户审批；其他失败（provider 错误、schema 错误、超时）fail closed
          // #198：Disabled 表示服务未启用，FallbackToUser 表示配置了 fallback=user——两者都不代表危险，回退到用户审批
          if (tag === "PermissionReviewerDisabled" || tag === "PermissionReviewerFallbackToUser") {
            return { action: "ask", reason: errorMessage(error), source: "reviewer_unavailable" } satisfies Decision
          }
          // #198：其他失败 fail closed——超时/provider 错误/schema 错误时拒绝而非放行，防止不透明的 reviewer 故障打开安全缺口
          return { action: "deny", reason: reviewerFailureMessage(error), source: "reviewer" } satisfies Decision
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

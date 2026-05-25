import { Effect } from "effect"
import { PermissionPrecheck } from "./precheck"

// #202：自动决策类型——allow/ask/deny 三态，source 追踪决策来源（precheck 或 reviewer）
// #202：ask 的 source 扩展为 precheck | reviewer_unavailable：general 层级在 strict 关闭时直接回退用户审批
export type Decision =
  | { action: "allow"; reason: string; source: "precheck" | "reviewer"; reviewID?: string }
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

// #198：reviewer 通过注入而非构造——确定性路由可在无 provider/session 层时测试，且在小型运行时无 reviewer 时 fail closed
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
    reviewerDisabled?: boolean
  },
  reviewer?: Reviewer,
  // #208：onReviewStart 在 reviewer 调用前回调——发布 ReviewStarted 事件供 UI 展示进度
  onReviewStart?: (input: {
    readonly reviewID: string
    readonly precheck: { readonly level: PermissionPrecheck.Level; readonly reason: string }
  }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    // #203：路由顺序：precheck 先于 reviewer——确定性层按四级分层拦截
    const precheck = PermissionPrecheck.evaluate(input)
    const isShell = input.permission === "bash"
    const isShellExternalDirectory = input.permission === "external_directory" && input.metadata.action_kind === "shell"
    // #210：tool-origin external_directory 携带 action_kind/tool/operation 证据——仅凭路径不构成授权上下文
    const isToolExternalDirectory = input.permission === "external_directory" && hasToolExternalDirectoryEvidence(input.metadata)
    // #203：四级预审路由——safe 直接允许；开发期 shell general 也直接允许，避免 auto shell
    // #203：回到人工确认；非 shell general 和 cautious 进入 reviewer/user fallback；dangerous 直接拒绝
    // #203：strict 是用户显式配置的例外，保留原本"低风险也审"的能力
    if (precheck.level === "dangerous") return { action: "deny", reason: precheck.reason, source: "precheck" } satisfies Decision
    if (isShellExternalDirectory) {
      // #203：shell-origin external_directory 只负责让项目外路径参与同一条命令的确定性预审，
      // #203：不能再单独调用 reviewer；否则一次 bash 会在 external_directory 和 bash 两个权限点
      // #203：重复消耗 LLM。非 dangerous 情况放行给后续 bash auto
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    if (input.permission === "external_directory" && !isToolExternalDirectory) {
      // #210：无来源证据的 external_directory 仍走人工审批。只有 shell/tool gate 能进入
      // #210：auto：shell 在上方复用同一条命令预审；tool 必须显式携带 action_kind/tool
      // #210：metadata，避免只凭路径就让 reviewer 替后续读写内容作授权判断
      return { action: "ask", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    if (precheck.level === "safe" && !input.strict) {
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    if (precheck.level === "general" && isShell && !input.strict) {
      // #203：开发测试期要求 auto shell 不弹人工确认：未命中 dangerous/cautious 的命令先放行；
      // #203：非 shell general 继续走 reviewer
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }

    // #203：cautious 是 review 边界——确定性 precheck 发现可见风险但非立即禁止，reviewer 必须显式返回 allow/deny
    // #203：原生 auto 不能在 reviewer 缺失时降级回可点击的用户 ask；fail closed 防止敏感 shell 输出因点 Allow 暴露
    if (!reviewer) {
      // #203：显式 user reviewer 配置强于原生 auto fail-closed 默认——保留小型/自定义运行时
      // #203：无 reviewer service 但有意保留用户审批作为 review 边界的场景
      if (input.reviewerDisabled) return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision
      // #225：metadata.agent 与 agent key 同为小写 auto——大小写敏感比较在此对齐
      if (input.metadata.agent === "auto") {
        return { action: "deny", reason: `auto reviewer unavailable: ${precheck.reason}`, source: "reviewer" } satisfies Decision
      }
      return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision
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
      Effect.match({
        onFailure: (error) => {
          const tag = errorTag(error)
          // #198：Disabled/FallbackToUser 是显式服务信号，回退到用户审批；其他失败（provider 错误、schema 错误、超时）fail closed
          // #198：Disabled 表示服务未启用，FallbackToUser 表示配置了 fallback=user——两者都不代表危险，回退到用户审批
          if (tag === "PermissionReviewerDisabled" || tag === "PermissionReviewerFallbackToUser") {
            return { action: "ask", reason: errorMessage(error), source: "reviewer_unavailable" } satisfies Decision
          }
          // #198：其他失败 fail closed——超时/provider 错误/schema 错误时拒绝而非放行，防止不透明的 reviewer 故障打开安全缺口
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

// #210：tool-origin 证据校验——action_kind 是 caller 可控 metadata，需同时携带已知 tool 及其 operation/payload，
// #210：仅凭路径的请求仍回退人工审批，防止 reviewer 替路径授权后续读写内容
function hasToolExternalDirectoryEvidence(metadata: Readonly<Record<string, unknown>>) {
  if (metadata.action_kind !== "tool") return false
  if (metadata.tool === "read") return metadata.operation === "read"
  // 空字符串也是有效写入负载；缺少content的纯路径请求才继续人工审批。
  if (metadata.tool === "write") return metadata.operation === "write" && typeof metadata.content === "string"
  if (metadata.tool === "edit") {
    return (
      (metadata.operation === "edit" || metadata.operation === "create") &&
      typeof metadata.oldString === "string" &&
      typeof metadata.newString === "string"
    )
  }
  if (metadata.tool === "apply_patch") {
    // #210：apply_patch 需匹配 hunk.type（add/update/delete/move）并携带 patchText 证据
    return (
      (metadata.operation === "add" || metadata.operation === "update" || metadata.operation === "delete" || metadata.operation === "move") &&
      typeof metadata.patchText === "string"
    )
  }
  return false
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

export * as ConfigPermissionV1 from "./permission"

import { Schema, SchemaGetter } from "effect"

// #196：`auto` 是 permission action 而非审批策略，表示请求进入确定性 precheck
// #196：并在需要时交给配置的 reviewer，最后才回退到用户审批。与 allow/ask/deny 共用
// #196：同一 union，确保 permission map 和 SDK 类型使用统一的 action 词汇表。
export const Action = Schema.Literals(["ask", "allow", "deny", "auto"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const ApprovalsReviewer = Schema.Literals(["user", "auto_review"]).annotate({
  identifier: "ApprovalsReviewer",
  description: "Choose whether prompt-risk permission requests go to the user or the automatic reviewer.",
})
export type ApprovalsReviewer = Schema.Schema.Type<typeof ApprovalsReviewer>

export const AutoReview = Schema.Struct({
  // #196：reviewer 配置与 permission rules 并列，控制 `action: "auto"` 的解析方式，
  // #196：但这些字段本身不是 rules，Permission.fromConfig 会跳过它们。
  // #196：model 指定 reviewer 使用的模型；timeout_ms 默认 90 秒。
  model: Schema.optional(Schema.String).annotate({ description: "Reviewer model in provider/model form." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({ description: "Reviewer timeout in milliseconds. Defaults to 90000." }),
  // #196：policy_path 和 policy 追加到默认 tenant policy 之后。
  policy_path: Schema.optional(Schema.String).annotate({ description: "Markdown policy file appended to the default tenant policy." }),
  policy: Schema.optional(Schema.String).annotate({ description: "Inline markdown policy appended to the reviewer policy prompt." }),
  // #196：fallback 控制 reviewer 失败时的行为：deny（默认）或回退到用户审批。
  fallback: Schema.optional(Schema.Literals(["deny", "user"])).annotate({
    description: "On reviewer failure, either fail closed or fall back to user approval. Defaults to deny.",
  }),
  // #196：strict 为 true 时即使 precheck 判定 allow 也强制经过 reviewer。
  strict: Schema.optional(Schema.Boolean).annotate({ description: "Route even low-risk precheck allows through reviewer." }),
  // #196：熔断器阈值，连续或滑动窗口内拒绝次数超限后中断 reviewer。
  max_consecutive_denials: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker consecutive denial threshold." }),
  max_recent_denials: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker recent denial threshold." }),
  recent_denial_window: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker recent decision window." }),
}).annotate({ identifier: "AutoReviewConfig" })
export type AutoReview = Schema.Schema.Type<typeof AutoReview>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

// #196：StructWithRest 会通过 rest schema 校验 control 字段，所以 rest value union
// #196：必须足够宽以容纳下面的显式 control 字段。InputObject 之后的 filter 再将其收窄：
// #196：只有命名的 control 字段可以使用 control 形态的值，而任意 permission name 必须是 rule。
const InputValue = Schema.Union([Rule, ApprovalsReviewer, AutoReview])

const controlsOnlyOnControlKeys = Schema.makeFilter<Record<string, unknown>>((data) => {
  for (const [key, value] of globalThis.Object.entries(data)) {
    if (key === "approvals_reviewer" || key === "auto_review") continue
    if (isRuleValue(value)) continue
    return `Unsupported permission control "${key}".`
  }
})

// #196：已知 permission key 在 schema 中有显式类型，用于生成文档/类型；只有显式的
// #196：`approvals_reviewer` 和 `auto_review` 字段接受 control 值。未知 key 被视为普通
// #196：permission name 且必须是 rule，这样拼错的 control 不会先解析再在
// #196：Permission.fromConfig 中消失。运行时解析使用 `propertyOrder: "original"` 保留用户顺序。
const InputObjectBase = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
    approvals_reviewer: Schema.optional(ApprovalsReviewer),
    auto_review: Schema.optional(AutoReview),
  }),
  [Schema.Record(Schema.String, InputValue)],
)

// 按键构造合法随机配置，避免宽控制值与可选 undefined 使整体拒绝采样停滞。
const InputObject = InputObjectBase.check(controlsOnlyOnControlKeys).annotate({
  toArbitrary: () => (fc) =>
    fc.tuple(
      Schema.toArbitrary(InputObjectBase.schema),
      Schema.toArbitrary(Schema.Record(Schema.String, Rule)),
    ).map(([known, extra]) => ({
      ...globalThis.Object.fromEntries(
        globalThis.Object.entries(extra).filter(
          ([key]) => !InputObjectBase.ast.propertySignatures.some((property) => property.name === key),
        ),
      ),
      ...globalThis.Object.fromEntries(globalThis.Object.entries(known).filter(([, value]) => value !== undefined)),
    })),
})

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

// #196：isRuleValue 判断值是否为合法 permission rule——单个 action 字符串或
// #196：全部值都是 action 字符串的对象。controlsOnlyOnControlKeys 用此过滤。
function isRuleValue(value: unknown): value is Rule {
  if (isActionValue(value)) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return globalThis.Object.values(value).every(isActionValue)
}

// #196：isActionValue 覆盖四种 action，包括新增的 auto。
function isActionValue(value: unknown): value is Action {
  return value === "ask" || value === "allow" || value === "deny" || value === "auto"
}

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
export type Info = {
  // #196：schema 保留了用户 key 顺序以维持 permission 优先级，但 StructWithRest 生成的
  // #196：TypeScript 类型在 control 字段与任意 permission name 混合时过于狭窄。保持此手写
  // #196：结构类型与 InputObject 和 fromConfig 的运行时 guard 对齐。
  read?: Rule
  edit?: Rule
  glob?: Rule
  grep?: Rule
  list?: Rule
  bash?: Rule
  task?: Rule
  external_directory?: Rule
  todowrite?: Action
  question?: Action
  webfetch?: Action
  websearch?: Action
  lsp?: Rule
  doom_loop?: Action
  skill?: Rule
  approvals_reviewer?: ApprovalsReviewer
  auto_review?: AutoReview
  [key: string]: Rule | Action | ApprovalsReviewer | AutoReview | undefined
}

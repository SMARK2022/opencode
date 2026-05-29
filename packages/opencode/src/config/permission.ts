export * as ConfigPermission from "./permission"
import { Schema, SchemaGetter } from "effect"

// `auto` is a permission action, not an approval policy. It means the request
// enters deterministic precheck and, when needed, the configured reviewer before
// falling back to user approval. Keep it in the same union as allow/ask/deny so
// existing permission maps and generated SDK types use one action vocabulary.
export const Action = Schema.Literals(["ask", "allow", "deny", "auto"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const ApprovalsReviewer = Schema.Literals(["user", "auto_review"]).annotate({
  identifier: "ApprovalsReviewer",
  description: "Choose whether prompt-risk permission requests go to the user or the automatic reviewer.",
})
export type ApprovalsReviewer = Schema.Schema.Type<typeof ApprovalsReviewer>

export const AutoReview = Schema.Struct({
  // Reviewer configuration lives beside permission rules because it controls how
  // `action: "auto"` is resolved, but these fields are not themselves rules and
  // are skipped by Permission.fromConfig.
  model: Schema.optional(Schema.String).annotate({ description: "Reviewer model in provider/model form." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({ description: "Reviewer timeout in milliseconds. Defaults to 90000." }),
  policy_path: Schema.optional(Schema.String).annotate({ description: "Markdown policy file appended to the default tenant policy." }),
  policy: Schema.optional(Schema.String).annotate({ description: "Inline markdown policy appended to the reviewer policy prompt." }),
  fallback: Schema.optional(Schema.Literals(["deny", "user"])).annotate({
    description: "On reviewer failure after retry, either fail closed or fall back to user approval. Defaults to user.",
  }),
  strict: Schema.optional(Schema.Boolean).annotate({ description: "Route even low-risk precheck allows through reviewer." }),
  max_consecutive_denials: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker consecutive denial threshold." }),
  max_recent_denials: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker recent denial threshold." }),
  recent_denial_window: Schema.optional(Schema.Number).annotate({ description: "Circuit breaker recent decision window." }),
}).annotate({ identifier: "AutoReviewConfig" })
export type AutoReview = Schema.Schema.Type<typeof AutoReview>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

// StructWithRest validates control fields through the rest schema too, so the
// rest value union must be wide enough for the explicit controls below. The
// filter after InputObject narrows that back down: only named control fields can
// use control-shaped values, while arbitrary permission names must be rules.
const InputValue = Schema.Union([Rule, ApprovalsReviewer, AutoReview])

const controlsOnlyOnControlKeys = Schema.makeFilter<Record<string, unknown>>((data) => {
  for (const [key, value] of globalThis.Object.entries(data)) {
    if (key === "approvals_reviewer" || key === "auto_review") continue
    if (isRuleValue(value)) continue
    return `Unsupported permission control "${key}".`
  }
})

// Known permission keys get explicit types in the Effect schema for generated
// docs/types, while only the explicit `approvals_reviewer` and `auto_review`
// fields accept control values. Unknown keys are treated as ordinary permission
// names and must be rules, so typoed/unsupported controls do not parse and then
// disappear during Permission.fromConfig. Runtime parsing uses Effect's
// `propertyOrder: "original"` option so user key order is preserved.
const InputObject = Schema.StructWithRest(
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
    repo_clone: Schema.optional(Rule),
    repo_overview: Schema.optional(Rule),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
    approvals_reviewer: Schema.optional(ApprovalsReviewer),
    auto_review: Schema.optional(AutoReview),
  }),
  [Schema.Record(Schema.String, InputValue)],
).check(controlsOnlyOnControlKeys)

// Input the user writes in config: either a single Action (shorthand for "*")
// or an object of per-target rules.
const InputSchema = Schema.Union([Action, InputObject])

// Normalise the Action shorthand into `{ "*": action }`. Object inputs pass
// through untouched.
const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

function isRuleValue(value: unknown): value is Rule {
  if (isActionValue(value)) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return globalThis.Object.values(value).every(isActionValue)
}

function isActionValue(value: unknown): value is Action {
  return value === "ask" || value === "allow" || value === "deny" || value === "auto"
}

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    // Not perfectly invertible (we lose whether the user originally typed an
    // Action shorthand), but the object form is always a valid representation
    // of the same rules.
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
export type Info = {
  // The schema above preserves user key order for permission precedence, but the
  // generated TypeScript type from StructWithRest is too narrow once control
  // fields are mixed with arbitrary permission names. Keep this hand-written
  // structural type aligned with InputObject and fromConfig's runtime guards.
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
  repo_clone?: Rule
  repo_overview?: Rule
  lsp?: Rule
  doom_loop?: Action
  skill?: Rule
  approvals_reviewer?: ApprovalsReviewer
  auto_review?: AutoReview
  [key: string]: Rule | Action | ApprovalsReviewer | AutoReview | undefined
}

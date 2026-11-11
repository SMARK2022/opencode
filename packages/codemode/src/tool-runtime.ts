// 参数形式、来源快照与宿主限流各守自己的边界，不向解释器引入宿主策略。
import { normalizeInput } from "./input-forms.js"
import { rawText, withRawText } from "./raw-text.js"
import { TOOL_CALL_CONCURRENCY } from "./stdlib/promise.js"
import { Cause, Effect, Schema, Semaphore } from "effect"
import DESCRIPTION from "./code-mode.txt" with { type: "text" }
import { ToolError, toolError } from "./tool-error.js"
import {
  decodeInput as decodeToolInput,
  decodeOutput as decodeToolOutput,
  identifierSegment,
  inputProperties,
  inputTypeScript,
  outputTypeScript,
} from "./tool-schema.js"
import { isDefinition as isToolDefinition, type Definition } from "./tool.js"
import {
  // 内部复制复用同一值品牌集合，避免新增支持类型时遗漏另一份枚举。
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "./values.js"

const estimateTokens = (input: string) => Math.max(0, Math.round(input.length / 4))

// Section markers are file structure, not model instructions; retain the upstream text verbatim.
const prompt = Object.fromEntries(
  DESCRIPTION.trimEnd().split(/\r?\n(?=@@ )/).map((block) => {
    const lines = block.split(/\r?\n/)
    return [lines[0].slice(3), lines.slice(1).join("\n")] as const
  }),
)

export const description = prompt.description

export type HostTool<R = never> = (...args: Array<unknown>) => Effect.Effect<unknown, unknown, R>

export type HostTools<R = never> = {
  [name: string]: HostTool<R> | Definition<R> | HostTools<R>
}

export type Services<Tools> = ServicesOf<Tools, []>

type ServicesOf<Tools, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : Tools extends (...args: Array<unknown>) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : Tools extends {
          readonly _tag: "CodeModeTool"
          readonly run: (input: unknown) => Effect.Effect<unknown, unknown, infer R>
        }
      ? R
      : Tools extends object
        ? string extends keyof Tools
          ? ServicesOf<Tools[string], [...Depth, unknown]>
          : ServicesOf<Tools[keyof Tools], [...Depth, unknown]>
        : never

/** Minimal audit record retained for each admitted tool call. */
export type ToolCall = {
  readonly name: string
}

/** Decoded tool call observed immediately before tool execution. */
export type ToolCallStarted = {
  readonly index: number
  readonly name: string
  readonly input: unknown
}

/** Completed tool call observed immediately after tool execution settles. */
export type ToolCallEnded = {
  readonly index: number
  readonly name: string
  readonly input: unknown
  readonly durationMs: number
  readonly outcome: "success" | "failure"
  /** Model-safe failure message; present only when `outcome` is `"failure"`. */
  readonly message?: string
}

/** Non-throwing observation hooks fired around each admitted tool call. */
export type ToolCallHooks<R = never> = {
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined
}

/** Model-visible description of one schema-backed tool. */
export type ToolDescription = {
  readonly path: string
  readonly description: string
  readonly signature: string
}

export type SafeObject = Record<string, unknown>

const reservedNamespace = "$codemode"
const defaultCatalogBudget = 2_000
const defaultSearchLimit = 10
// 误调用只补一小段完整签名；大命名空间不能把一次失败扩成整份工具目录。
const namespaceSignatureBudget = 2_000
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  offset: Schema.optionalKey(NonNegativeInt),
})
const SearchItem = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  signature: Schema.String,
  // 详情保留 schema 元数据；不可表示的侧用标记说明，不能拖垮整页发现。
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optionalKey(Schema.Unknown),
  schemaUnavailable: Schema.optionalKey(Schema.Array(Schema.Literals(["input", "output"]))),
})
const SearchOutput = Schema.Struct({
  items: Schema.Array(SearchItem),
  remaining: NonNegativeInt,
  next: Schema.NullOr(Schema.Struct({ offset: NonNegativeInt })),
})
const toolExpression = (path: string) =>
  "tools" +
  path
    .split(".")
    .map((segment) => (identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`))
    .join("")

export class ToolReference {
  constructor(readonly path: ReadonlyArray<string>) {}
}

/**
 * Maximum nesting depth for values crossing a data boundary. Fixed (not a configurable
 * limit) purely because it produces a clearer diagnostic than a native stack-overflow
 * RangeError would.
 */
const MAX_VALUE_DEPTH = 32

export class ToolRuntimeError extends Error {
  constructor(
    readonly kind:
      | "UnknownTool"
      | "InvalidToolInput"
      | "InvalidToolOutput"
      | "InvalidDataValue"
      | "ToolCallLimitExceeded",
    message: string,
    readonly suggestions: ReadonlyArray<string> = [],
  ) {
    super(message)
    this.name = "ToolRuntimeError"
  }
}

const isDefinition = <R>(value: HostTool<R> | Definition<R> | HostTools<R>): value is Definition<R> =>
  isToolDefinition<R>(value)

const runHost = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ToolError, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(error instanceof ToolError ? error : toolError("Tool execution failed", error))
    }),
  )

const blockedMemberNames = new Set(["__proto__", "constructor", "prototype"])

export const isBlockedMember = (name: string): boolean => blockedMemberNames.has(name)

/**
 * Validates and copies a value against the plain-data contract (depth, circularity, plain
 * objects only, blocked properties, data-only leaves).
 *
 * Two modes share the walk:
 * - **Boundary** (`preserveSandboxValues` false, the default): the host<->sandbox boundary -
 *   final results, tool-call arguments, `JSON.stringify`. Sandbox value types serialize
 *   exactly as JSON.stringify would: Date/URL -> strings, the remaining value types -> {}.
 * - **Intra-sandbox checkpoint** (`preserveSandboxValues` true; see `boundedData` in
 *   codemode.ts): standard-library value instances pass through untouched (treated as leaves,
 *   contents not walked), so values flowing through `Object.*` helpers, coercion inputs, and
 *   other in-sandbox checkpoints stay fully usable (`.getTime()`, `.has()`, ...).
 *
 * Both modes reject un-awaited promises with an await-hinting diagnostic.
 */
export const copyIn = (value: unknown, label: string, preserveSandboxValues = false): unknown =>
  copyBounded(value, label, 0, new Set(), preserveSandboxValues)

const copyBounded = (
  value: unknown,
  label: string,
  depth: number,
  seen: Set<object>,
  preserveSandboxValues: boolean,
): unknown => {
  if (depth > MAX_VALUE_DEPTH) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}.`)
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    // NaN/Infinity are allowed to exist as in-sandbox intermediates (matching real JS and a real
    // engine) so defensive guards like `Number.isNaN(x)` / `parseInt(x) || 0` can run. They are
    // normalized to `null` when the value leaves the sandbox - see copyOut - exactly as
    // JSON.stringify already does at any tool boundary.
    typeof value === "number"
  ) {
    return value
  }

  if (typeof value !== "object") {
    throw new ToolRuntimeError("InvalidDataValue", `${label} must contain data only.`)
  }

  // An un-awaited promise never crosses a data checkpoint as `{}`; the diagnostic tells the
  // model exactly how to fix the program instead.
  if (value instanceof SandboxPromise) {
    throw new ToolRuntimeError(
      "InvalidDataValue",
      `${label} contains an un-awaited Promise; await tool calls (e.g. \`const result = await tools.ns.tool(...)\`) before using their results.`,
    )
  }

  if (preserveSandboxValues) {
    // 内部检查点保留已有沙箱对象身份；成员在修改处校验，真正的跨界仍走下方序列化。
    if (isSandboxValue(value)) return value
    // Host instances cannot normally reach an intra-sandbox checkpoint (tool results cross
    // the boundary first), but wrap them defensively rather than degrading to JSON forms.
    if (value instanceof Date) return new SandboxDate(value.getTime())
    if (value instanceof RegExp) return new SandboxRegExp(value.source, value.flags)
    if (value instanceof Map) {
      const wrapped = new SandboxMap()
      for (const [key, item] of value.entries()) {
        wrapped.map.set(copyBounded(key, label, depth + 1, seen, true), copyBounded(item, label, depth + 1, seen, true))
      }
      return wrapped
    }
    if (value instanceof Set) {
      const wrapped = new SandboxSet()
      for (const item of value.values()) wrapped.set.add(copyBounded(item, label, depth + 1, seen, true))
      return wrapped
    }
    if (value instanceof URL) return new SandboxURL(new URL(value.href))
    if (value instanceof URLSearchParams) return new SandboxURLSearchParams(new URLSearchParams(value))
  }

  // Sandbox value types (and their host counterparts, which a host tool may legitimately
  // return) serialize exactly as JSON.stringify would at the data boundary: Date/URL use
  // toJSON(), while RegExp/Map/Set/URLSearchParams have no JSON form beyond {}.
  if (value instanceof SandboxDate) {
    return Number.isFinite(value.time) ? new Date(value.time).toISOString() : null
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null
  }
  if (value instanceof SandboxURL) return value.url.href
  if (value instanceof URL) return value.href
  if (
    value instanceof SandboxRegExp ||
    value instanceof SandboxMap ||
    value instanceof SandboxSet ||
    value instanceof SandboxURLSearchParams ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof URLSearchParams
  ) {
    return Object.create(null) as SafeObject
  }

  if (seen.has(value)) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} contains a circular value.`)
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const copied = value.map((item) => copyBounded(item, label, depth + 1, seen, preserveSandboxValues))
    seen.delete(value)
    // 数组内部复制保留来源快照，但 map/spread 新建根值不会凭内容继承来源。
    return withRawText(copied, rawText(value), true)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} must contain plain objects only.`)
  }

  const copied: SafeObject = Object.create(null) as SafeObject
  for (const [key, item] of Object.entries(value)) {
    if (isBlockedMember(key)) {
      throw new ToolRuntimeError("InvalidDataValue", `${label} contains blocked property '${key}'.`)
    }
    copied[key] = copyBounded(item, label, depth + 1, seen, preserveSandboxValues)
  }
  seen.delete(value)
  // 普通对象副本此时才暴露只读 text；copyOut 仍仅遍历业务可枚举字段。
  return withRawText(copied, rawText(value), true)
}

export const copyOut = (value: unknown, undefinedAsNull = false): unknown => {
  if (value === undefined && undefinedAsNull) return null
  // Normalize non-finite numbers to null as the value crosses out of the sandbox (final return
  // and tool-call arguments both funnel through here), matching JSON semantics - NaN/Infinity
  // have no JSON representation, so JSON.stringify would produce null anyway.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyOut(item, undefinedAsNull))
  }

  if (value !== null && typeof value === "object" && !(value instanceof ToolReference)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyOut(item, undefinedAsNull)]))
  }

  return value
}

const definitions = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string> = [],
): Array<{ path: string; definition: Definition<R> }> => {
  const entries: Array<{ path: string; definition: Definition<R> }> = []
  for (const [name, value] of Object.entries(tools)) {
    const next = [...path, name]
    if (isDefinition(value)) entries.push({ path: next.join("."), definition: value })
    else if (typeof value !== "function") entries.push(...definitions(value, next))
  }
  return entries
}

const describeDefinition = <R>(path: string, definition: Definition<R>): ToolDescription => {
  // 所有模型界面复用唯一紧凑签名；字段说明仍作为搜索索引，不再生成第二种展示。
  const input = inputTypeScript(definition)
  // 沿官方调用示例显示对象参数；空对象签名对应运行时的零参规范化。
  return {
    path,
    description: definition.description,
    signature: `${toolExpression(path)}(${input === "{}" ? "" : `input: ${input}`}): Promise<${outputTypeScript(definition)}>`,
  }
}

const visibleDefinitions = <R>(tools: HostTools<R>) =>
  definitions(tools).sort((left, right) => compareText(left.path, right.path)).map(({ path, definition }) => ({
    path,
    definition,
    description: describeDefinition(path, definition),
  }))

export const catalog = <R>(tools: HostTools<R>): ReadonlyArray<ToolDescription> =>
  visibleDefinitions(tools).map(({ description }) => description)

export type DiscoveryPlan = {
  readonly catalog: ReadonlyArray<ToolDescription>
  readonly instructions: string
  readonly searchIndex: ReadonlyArray<SearchEntry>
}

export type SearchEntry = {
  readonly description: ToolDescription
  // 索引只保存原合同引用，命中时才生成详情，完整目录不预先承受序列化成本。
  readonly inputContract: Definition["inputContract"]
  readonly outputContract: Definition["output"]
  readonly pathWords: ReadonlyArray<string>
  /** Lowercased path + description + input property names/descriptions, for substring matching. */
  readonly searchText: string
}

/**
 * Split a query into lowercased search terms. camelCase boundaries are split
 * (`resolveLibrary` -> `resolve library`) and every non-alphanumeric character is a
 * separator, so `resolve-library-id`, `resolveLibraryId`, and `resolve library id` all
 * tokenize alike. Empties and the `*` wildcard are dropped.
 */
const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

/**
 * A term plus its naive singular variants (trailing "s"/"es" stripped), so a plural
 * query term ("issues") still matches indexed text that only carries the singular
 * ("issue"). Matching is one-directional substring containment, so the variants are
 * needed only on the query side; scoring weights are unchanged - each field check
 * passes when ANY form matches.
 */
const termForms = (term: string): Array<string> => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

// 搜索与拼写恢复共用官方排序；完整路径词优先于偶然的子串命中。
const rank = (entries: ReadonlyArray<SearchEntry>, query: string): Array<SearchEntry> => {
  const terms = tokenize(query).map(termForms)
  return entries.map((entry) => {
    const path = entry.description.path.toLowerCase()
    const description = entry.description.description.toLowerCase()
    const score = terms.reduce((total, forms) => total +
      (forms.some((form) => path === form || path.endsWith(`.${form}`)) ? 20 : 0) +
      (forms.some((form) => entry.pathWords.includes(form)) ? 12 : 0) +
      (forms.some((form) => path.includes(form)) ? 8 : 0) +
      (forms.some((form) => description.includes(form)) ? 4 : 0) +
      (forms.some((form) => entry.searchText.includes(form)) ? 2 : 0), 0)
    return { entry, score }
  }).filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || compareText(left.entry.description.path, right.entry.description.path))
    .map(({ entry }) => entry)
}

const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition => ({
  _tag: "CodeModeTool",
  description: "Search available tools",
  inputContract: SearchInput,
  input: SearchInput,
  output: SearchOutput,
  // 搜索只读取冻结的当前索引，不调用真实工具，也不占宿主并发槽位。
  run: (input) =>
    Effect.sync(() => {
      const request = input as typeof SearchInput.Type
      const query = request.query ?? ""
      const offset = request.offset ?? 0
      // tools前缀属于模型看到的调用表达式；仅在目录自身未占用该名字时剥离。
      const namespace = request.namespace !== undefined && !searchIndex.some((entry) => entry.description.path.startsWith("tools."))
        ? request.namespace === "tools" ? undefined : request.namespace.replace(/^tools\./, "")
        : request.namespace
      const scoped =
        namespace === undefined
          ? searchIndex
          : searchIndex.filter((entry) => entry.description.path === namespace || entry.description.path.startsWith(`${namespace}.`))
      // A query that names one tool path exactly (canonical path or rendered JavaScript
      // expression) is a lookup, not a search: return that tool alone.
      const trimmed = query.trim()
      const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed
      const exact =
        pathQuery === ""
          ? undefined
          : scoped.find(
              (entry) => entry.description.path === pathQuery || toolExpression(entry.description.path) === trimmed,
            )
      const ranked = exact !== undefined ? [exact] : rank(scoped, query)
      const items: Array<typeof SearchItem.Type> = []
      // 每加入完整工具后重新计算续页位置，页大小由字符预算或条数上限先达到者决定。
      const response = () => {
        const remaining = Math.max(0, ranked.length - offset - items.length)
        return { items, remaining, next: remaining > 0 ? { offset: offset + items.length } : null }
      }
      for (const { description, inputContract, outputContract } of ranked.slice(
        offset,
        offset + (request.limit ?? defaultSearchLimit),
      )) {
        // 诊断按条目局部保存，前一个工具不可描述不会污染后一个工具的状态。
        const schemaUnavailable: Array<"input" | "output"> = []
        // 合法 Effect 合同不一定能发射 JSON Schema；只标记失败侧，不丢同页工具。
        const describeSchema = (schema: Definition["inputContract"], side: "input" | "output") => {
          try {
            // 现成 JSON Schema 已是调用合同，不再重新发射或删改其字段元数据。
            if (!Schema.isSchema(schema)) return schema
            // 输入展示调用者提交的 encoded 域；输出展示 decoder 交给脚本的 decoded 域。
            const document = Schema.toJsonSchemaDocument(side === "output" ? Schema.toType(schema) : schema)
            return {
              ...document.schema,
              // 发射器把定义分开放置；接回 $defs 后，字段里的本地引用才可独立解析。
              ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
            }
          } catch {
            // null 明确表示本侧无法描述，空对象会被误读成一个无约束合同。
            schemaUnavailable.push(side)
            return null
          }
        }
        items.push({
          ...description,
          path: toolExpression(description.path),
          inputSchema: describeSchema(inputContract, "input"),
          // 未声明输出时省略字段；声明存在但发射失败时才返回 null，两种状态不能合并。
          ...(outputContract === undefined ? {} : { outputSchema: describeSchema(outputContract, "output") }),
          ...(schemaUnavailable.length === 0 ? {} : { schemaUnavailable }),
        })
        // 完整条目跨过16K后结束本页，单项超长仍可读，下一页从后项继续。
        // remaining/next 也算入整页长度；这里使用 JS 字符单位，与日志的 UTF-8 预算不同。
        if (JSON.stringify(response()).length >= 16 * 1024) break
      }
      return response()
    }),
})

// search只查询当前内存目录，签名和实际返回均为同步对象；真实工具仍返回Promise。
const searchSignature = `search(input: ${inputTypeScript(makeSearchTool([]))}): ${outputTypeScript(makeSearchTool([]))}`

const catalogLine = (tool: ToolDescription) => {
  // 目录按用途与签名计费；search 保留完整用途、同源签名及可发射的输入/输出 Schema。
  const line = tool.description.split("\n", 1)[0]!.trim()
  const description = line.length > 120 ? line.slice(0, 117) + "..." : line
  return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}`
}

const toSearchEntry = <R>(path: string, definition: Definition<R>, description: ToolDescription): SearchEntry => ({
  description,
  // 搜索直接保留真实合同，不从紧凑签名反推默认值和字段限制。
  inputContract: definition.inputContract,
  outputContract: definition.output,
  pathWords: tokenize(path),
  searchText: [
    path,
    definition.description,
    ...inputProperties(definition).flatMap(({ name, description: property }) =>
      property === undefined ? [name] : [name, property],
    ),
  ]
    .join("\n")
    .toLowerCase(),
})

/** The runtime search index over every described tool. Search is always registered. */
export const searchIndex = <R>(tools: HostTools<R>): ReadonlyArray<SearchEntry> =>
  visibleDefinitions(tools).map(({ path, definition, description }) => toSearchEntry(path, definition, description))

export const assertValidTools = <R>(tools: HostTools<R>): void => {
  if (Object.hasOwn(tools, reservedNamespace)) {
    throw new Error(`Tool namespace '${reservedNamespace}' is reserved for CodeMode discovery tools.`)
  }
}

// 优先级只是宿主给出的当前路径；目录预算不会增加实际工具或绕过过滤。
export const prepare = <R>(
  tools: HostTools<R>,
  catalogBudget = defaultCatalogBudget,
  priority: ReadonlyArray<string> = [],
): DiscoveryPlan => {
  if (!Number.isSafeInteger(catalogBudget) || catalogBudget < 0) {
    throw new RangeError("discovery.catalogBudget must be a non-negative safe integer")
  }
  const visible = visibleDefinitions(tools)
  const index = visible.map(({ path, definition, description }) => toSearchEntry(path, definition, description))
  const described = index.map((entry) => entry.description)

  const namespaces = new Map<string, Array<ToolDescription>>()
  // namespace 标题始终存在；零预算也能说明未展示工具数量。
  for (const entry of index) {
    const tool = entry.description
    const [namespace = tool.path] = tool.path.split(".")
    const group = namespaces.get(namespace) ?? []
    group.push(tool)
    namespaces.set(namespace, group)
  }
  const ordered = [...namespaces].sort(([left], [right]) => compareText(left, right))

  // 核心路径先选，其余按签名长度与路径稳定排序；过长条目跳过而不阻塞后续工具。
  const preferred = new Set(priority)
  // 此排序只选内联项；search 仍按自身相关性排序，分页顺序不随目录预算改变。
  const queue = [...described].sort(
    (left, right) =>
      Number(preferred.has(right.path)) - Number(preferred.has(left.path)) ||
      left.signature.length - right.signature.length ||
      compareText(left.path, right.path),
  )
  const picked = new Set<ToolDescription>()
  // 固定标题费用沿用原预算；再高的优先级也不能保证超预算签名必定出现。
  let used = ordered.reduce((total, [namespace, group]) => total +
    estimateTokens(`- ${namespace} (${group.length} tool${group.length === 1 ? "" : "s"}, none shown)`), 0)
  for (const tool of queue) {
    const cost = estimateTokens(catalogLine(tool))
    if (used + cost > catalogBudget) continue
    picked.add(tool)
    used += cost
  }
  // 选择集合只控制提示展示；完整 catalog 与搜索索引不随预算删除工具。
  const totalShown = picked.size
  const complete = totalShown === described.length

  const empty = described.length === 0

  const intro = prompt[empty ? "intro.empty" : complete ? "intro.complete" : "intro.partial"]
    .replace("{{searchSignature}}", searchSignature).split("\n")

  const toolSection: Array<string> = empty ? [] : [""]
  if (!empty) {
    for (const [namespace, group] of ordered) {
      const selected = group.filter((tool) => picked.has(tool))
      const count = `${group.length} tool${group.length === 1 ? "" : "s"}`
      // Annotate only when a namespace is not fully shown, so a comprehensive
      // namespace reads cleanly and a truncated one is unambiguous.
      const label =
        selected.length === group.length
          ? count
          : selected.length === 0
            ? `${count}, none shown`
            : `${count}, ${selected.length} shown`
      toolSection.push(`- ${namespace} (${label})`)
      for (const tool of selected) toolSection.push(catalogLine(tool))
    }
  }

  const lines = [...intro, ...toolSection]
  return {
    catalog: described,
    instructions: lines.join("\n"),
    // 返回未裁剪索引，目录放不下的工具仍可被同一 search 精确发现。
    searchIndex: index,
  }
}

/**
 * The enumerable names at one node of the callable tool tree - namespace names at the root,
 * tool/namespace names below - powering `Object.keys(tools)` and `for...in` over tool
 * references. A callable tool is a leaf and enumerates as `[]` (like `Object.keys` of a
 * function in JS). An unknown path is an `UnknownTool` error pointing at the working
 * discovery idioms, mirroring how calling an unknown tool fails.
 */
const namespaceKeys = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): ReadonlyArray<string> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools
  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === "function" ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError("UnknownTool", `Unknown tool namespace '${path.join(".")}'.`, [
        "Use search to find available tools.",
      ])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }
  if (typeof value === "function" || isDefinition(value)) return []
  return Object.keys(value)
}

const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>, index: ReadonlyArray<SearchEntry>): HostTool<R> | Definition<R> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools

  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === "function" ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      const name = path.join(".")
      const namespace = path.length > 1 && Object.hasOwn(tools, path[0]!) ? path[0] : undefined
      // 仅推荐同一当前目录中的路径，不猜造别名，也不自动执行推荐项。
      const closest = rank(namespace ? index.filter((entry) => entry.description.path.startsWith(`${namespace}.`)) : index,
        namespace ? path.slice(1).join(" ") : name)[0]
      throw new ToolRuntimeError("UnknownTool", closest
        ? `Unknown tool '${name}'. Did you mean ${toolExpression(closest.description.path)}?`
        : `Unknown tool '${name}'.`, ["Use search to find available tools."])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }

  if (typeof value !== "function" && !isDefinition(value)) {
    const namespace = path.join(".")
    const entries = index.filter((entry) => !namespace || entry.description.path.startsWith(`${namespace}.`))
    const signatures: string[] = []
    let used = 0
    // 只呈现当前分组的整条签名；即使只有一个成员，也不把误调用转成真实执行。
    for (const entry of entries) {
      if (used + entry.description.signature.length + 1 > namespaceSignatureBudget) continue
      signatures.push(entry.description.signature)
      used += entry.description.signature.length + 1
    }
    throw new ToolRuntimeError("UnknownTool", `Tool '${namespace}' is not callable.`, [
      ...signatures,
      // 省略是展示预算而非能力删除；显式计数避免把有限清单误称完整目录。
      ...(signatures.length < entries.length
        ? [`${entries.length - signatures.length} more functions; use search for full details.`]
        : []),
    ])
  }

  return value
}

export type ToolRuntime<R = never> = {
  readonly root: ToolReference
  readonly calls: Array<ToolCall>
  readonly invoke: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  /** Enumerable namespace/tool names at one node of the callable tool tree; see `namespaceKeys`. */
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
}

export const make = <R>(
  tools: HostTools<R>,
  /** Undefined means unlimited tool calls. */
  maxToolCalls: number | undefined,
  searchIndex: ReadonlyArray<SearchEntry>,
  hooks?: ToolCallHooks<R>,
  fetch?: HostTool<R>,
): ToolRuntime<R> => {
  // 一个执行中的所有工具与 fetch 共用这组许可，函数帧和组合器不各建队列。
  const permits = Semaphore.makeUnsafe(TOOL_CALL_CONCURRENCY)
  const calls: Array<ToolCall> = []
  const callableTools = {
    ...tools,
    [reservedNamespace]: { search: makeSearchTool(searchIndex), ...(fetch ? { fetch } : {}) },
  }

  // 所有终态在原观察出口交付；取消仍向外传播，父进度不能停留在running。
  const observeEnd = <A, E>(effect: Effect.Effect<A, E, R>, call: ToolCallStarted): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd
    if (onEnd === undefined) return effect
    const startedAt = Date.now()
    return effect.pipe(
      Effect.tap(() => onEnd({ ...call, durationMs: Date.now() - startedAt, outcome: "success" })),
      Effect.tapError((error) => {
        const message =
          error instanceof ToolError || error instanceof ToolRuntimeError ? error.message : "Tool execution failed"
        return onEnd({
          ...call,
          durationMs: Date.now() - startedAt,
          outcome: "failure",
          message,
        })
      }),
      Effect.onInterrupt(() => onEnd({
        ...call, durationMs: Date.now() - startedAt, outcome: "failure", message: "Tool execution interrupted",
      })),
    )
  }

  const decodeOutput = (value: unknown, name: string) =>
    Effect.try({
      try: () => copyIn(value, `Result from tool '${name}'`),
      catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),
    })

  const recordCall = (call: ToolCall): void => {
    if (maxToolCalls !== undefined && calls.length >= maxToolCalls) {
      throw new ToolRuntimeError("ToolCallLimitExceeded", `Execution exceeded its tool-call limit of ${maxToolCalls}.`)
    }
    calls.push(call)
  }

  return {
    root: new ToolReference([]),
    calls,
    keys: (path) => namespaceKeys(callableTools, path),
    invoke: (path, args) =>
      Effect.gen(function* () {
        const name = path.join(".")
        const externalArgs = args.map((arg) => copyOut(copyIn(arg, `Arguments for tool '${name}'`)))
        const call = { name }
        const recordAndObserve = (input: unknown) =>
          Effect.sync(() => {
            recordCall(call)
            return calls.length - 1
          }).pipe(Effect.tap((index) => hooks?.onToolCallStart?.({ index, name, input }) ?? Effect.void))
        const tool = resolve(callableTools, path, searchIndex)
        let describedInput: unknown
        if (isDefinition(tool)) {
          if (externalArgs.length > 1)
            throw new ToolRuntimeError("InvalidToolInput", `Tool '${name}' expects at most one input object.`)
          // 零参沿上游按{}进入原decoder，必填字段仍在执行前拒绝；显式undefined不替换。
          describedInput = yield* Effect.try({
            // 新构造的键仍须过同一数据边界，禁止危险字段绕过入口检查。
            try: () =>
              decodeToolInput(
                tool,
                copyOut(
                  copyIn(
                    normalizeInput(tool.inputForms, externalArgs.length === 0 ? {} : externalArgs[0]),
                    `Arguments for tool '${name}'`,
                  ),
                ),
              ),
            catch: (cause) =>
              new ToolRuntimeError("InvalidToolInput", `Invalid input for tool '${name}': ${String(cause)}`),
          })
        }
        const input = isDefinition(tool) ? describedInput : externalArgs
        const index = yield* recordAndObserve(input)
        const currentCall = { index, name, input }
        if (isDefinition(tool)) {
          return yield* observeEnd(
            Effect.gen(function* () {
              const raw = yield* runHost(Effect.suspend(() => tool.run(describedInput)))
              const result = yield* Effect.try({
                try: () => decodeToolOutput(tool, raw),
                catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),
              })
              // 先验证业务输出，再把原始文本来源带入沙箱副本；别名不污染可选字段。
              return yield* decodeOutput(withRawText(result, rawText(raw)), name)
            }),
            currentCall,
          )
        }
        return yield* observeEnd(
          Effect.gen(function* () {
            return yield* decodeOutput(yield* runHost(Effect.suspend(() => tool(...externalArgs))), name)
          }),
          currentCall,
        )
      }).pipe(
        // 准入后才计数和发布 running；排队取消不启动宿主调用，叶子超时也从实际调用开始。
        // 只有同步内存 search 不占槽位；fetch 和宿主工具共用八槽，排队仍消耗整段预算。
        path.length === 2 && path[0] === reservedNamespace && path[1] === "search"
          ? (effect) => effect
          : permits.withPermits(1),
      ),
  }
}

export * as ToolRuntime from "./tool-runtime.js"

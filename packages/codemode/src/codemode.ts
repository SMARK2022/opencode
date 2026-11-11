import { withRawText } from "./raw-text.js"
import { Effect, Schema } from "effect"
import { executeWithLimits } from "./interpreter/runtime.js"
import { Environment } from "./interpreter/model.js"
import { type HostTool, type HostTools, type Services, type ToolDescription, ToolRuntime } from "./tool-runtime.js"
import type { Definition } from "./tool.js"

/** A tool call admitted during an execution. */
export type { ToolCall, ToolCallEnded, ToolCallHooks, ToolCallStarted, ToolDescription } from "./tool-runtime.js"

// 只导出环境身份与工厂；词法内容由解释器拥有，宿主负责串行使用和释放。
export type { Environment } from "./interpreter/model.js"
export const createEnvironment = (): Environment => new Environment()

/** Resource budgets enforced independently during each CodeMode program execution. */
export type ExecutionLimits = {
  /** Maximum wall-clock execution time in milliseconds. No default: absent means no timeout. */
  readonly timeoutMs?: number
  /** Maximum number of tool calls admitted by the runtime. No default: absent means unlimited. */
  readonly maxToolCalls?: number
  /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */
  readonly maxOutputBytes?: number
}

/** Controls how much of the tool catalog is inlined in agent instructions. */
export type DiscoveryOptions = {
  /** Approximate token budget (chars/4, default 2000) for full catalog entries. */
  readonly catalogBudget?: number
  // 宿主提供已筛选的规范路径；库不按工具名字推断核心身份。
  readonly priority?: ReadonlyArray<string>
}

type ToolTree<R = never> = {
  readonly [name: string]: Definition<R> | ToolTree<R>
}

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
}

/** Options for one CodeMode execution. */
export type ExecuteOptions<Tools extends Record<string, unknown> = {}> = {
  /** Source for one program in the supported JavaScript subset. */
  code: string
  /** 仅复用词法状态；缺省仍逐次隔离，工具、取消与预算始终属于当前调用。 */
  environment?: Environment
  /** Explicit tool tree exposed to the program as `tools`. */
  tools?: Tools & ToolTree<Services<Tools>>
  /** HTTP由宿主显式提供；未提供时沙箱没有环境网络权限。 */
  fetch?: HostTool<Services<Tools>>
  /** Per-execution overrides for the default resource limits. */
  limits?: ExecutionLimits
  /** Observes decoded tool input immediately before tool execution. */
  onToolCallStart?: (call: ToolRuntime.ToolCallStarted) => Effect.Effect<void, never, Services<Tools>>
  /** Observes each admitted tool call as it settles, with outcome and duration. */
  onToolCallEnd?: (call: ToolRuntime.ToolCallEnded) => Effect.Effect<void, never, Services<Tools>>
}

/** A JSON value that can cross the confined interpreter boundary. */
export type DataValue = Schema.Json

/** Configuration shared by `CodeMode.make` and `CodeMode.execute`. */
export type Options<Tools extends Record<string, unknown> = {}> = Omit<ExecuteOptions<Tools>, "code"> & {
  /** Progressive-disclosure configuration for the agent-facing tool catalog. */
  readonly discovery?: DiscoveryOptions
}

/** Schema for a host tool input containing CodeMode source. */
export const Input = Schema.Struct({ code: Schema.String })
export const description = ToolRuntime.description
export type Input = typeof Input.Type

export const DiagnosticKind = Schema.Literals([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "ToolFailure",
  "ExecutionFailure",
])
/** Stable categories produced by program, schema, tool, and limit failures. */
export type DiagnosticKind = typeof DiagnosticKind.Type

export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  message: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number })),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A normalized program diagnostic safe to return across an agent tool boundary. */
export type Diagnostic = typeof Diagnostic.Type

const ToolCallSchema = Schema.Struct({ name: Schema.String })
export const Success = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Json,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Successful execution after the result has crossed the plain-data boundary. */
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Diagnostic,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Failed execution with calls admitted before the diagnostic was produced. */
export type Failure = typeof Failure.Type

/** Schema for the structured success or diagnostic returned by CodeMode execution. */
export const Result = Schema.Union([Success, Failure])
/** Result of executing a CodeMode program. Program failures are data, not Effect failures. */
export type Result = typeof Result.Type

/** Reusable confined runtime over one explicit tool tree. */
export type Runtime<R = never> = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly instructions: () => string
  readonly execute: (code: string) => Effect.Effect<Result, never, R>
}

const validateLimit = <Value extends number | undefined>(
  name: keyof ExecutionLimits,
  value: Value,
  minimum: number,
): Value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
})

/** Executes one Effect-native CodeMode program without constructing a reusable runtime. */
export const execute = <const Tools extends Record<string, unknown>>(
  options: ExecuteOptions<Tools>,
): Effect.Effect<Result, never, Services<Tools>> => {
  const tools = (options.tools ?? {}) as HostTools<Services<Tools>>
  ToolRuntime.assertValidTools(tools)
  return executeWithLimits(options, resolveExecutionLimits(options.limits), ToolRuntime.searchIndex(tools))
}

/** Creates an Effect-native runtime over explicit, schema-described tools. */
export const make = <const Tools extends Record<string, unknown> = {}>(
  options: Options<Tools> = {} as Options<Tools>,
): Runtime<Services<Tools>> => {
  const tools = (options.tools ?? {}) as HostTools<Services<Tools>>
  ToolRuntime.assertValidTools(tools)
  const limits = resolveExecutionLimits(options.limits)
  // 仅当前目录参与优先选择；重建 runtime 时重新计算，不缓存旧能力。
  const prepared = ToolRuntime.prepare(tools, options.discovery?.catalogBudget, options.discovery?.priority)

  return {
    catalog: () => prepared.catalog,
    instructions: () => prepared.instructions,
    execute: (code) => executeWithLimits<Tools>({ ...options, code }, limits, prepared.searchIndex),
  }
}

// 仅供宿主显式选择的无类型文本；声明字符串和普通工具结果不会自动进入此路径。
export const fromJsonText = (text: string): unknown => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text, (_key, value: unknown) => {
      // JSON 数字溢出无法保持普通数据的数值意义；不改变现有沙箱 Infinity 语义。
      if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("JSON numeric overflow")
      return value
    })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return text
    throw error
  }
  if (parsed === null || typeof parsed !== "object") return text
  try {
    // 复用既有深度、危险键和普通对象边界，不引入第二套可表示性规则。
    return withRawText(ToolRuntime.copyIn(parsed, "JSON tool result"), text)
  } catch (error) {
    // 已知不可表示的文本仍是成功文本；内部意外错误不能伪装成格式选择。
    if (error instanceof ToolRuntime.ToolRuntimeError && error.kind === "InvalidDataValue") return text
    throw error
  }
}

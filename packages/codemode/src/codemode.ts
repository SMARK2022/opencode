import { withRawText } from "./values.js"
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
  /** Total explicit loop-body entries across this execution. Absent means unlimited. */
  readonly maxLoopIterations?: number
  /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */
  readonly maxOutputBytes?: number
  /** 日志按 UTF-8 字节限制留存；业务返回值仍受独立的 maxOutputBytes 控制。 */
  readonly maxLogBytes?: number
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
  readonly maxLoopIterations: number | undefined
  readonly maxOutputBytes: number | undefined
  readonly maxLogBytes: number | undefined
}

/** Options for one CodeMode execution. */
export type ExecuteOptions<Tools extends Record<string, unknown> = {}> = {
  /** Source for one program in the supported JavaScript subset. */
  code: string
  /** 仅复用词法状态；缺省仍逐次隔离，工具、取消与预算始终属于当前调用。 */
  environment?: Environment
  /** 预跑只用副本；复制失败即结束本次预跑，不能退回真实环境继续执行。 */
  snapshotEnvironment?: boolean
  /** 宿主选择 sleep 的等待效果；执行期限仍由独立根预算决定。 */
  sleep?: (milliseconds: number) => Effect.Effect<void>
  /** Explicit tool tree exposed to the program as `tools`. */
  tools?: Tools & ToolTree<Services<Tools>>
  /** HTTP由宿主显式提供；未提供时沙箱没有环境网络权限。 */
  fetch?: HostTool<Services<Tools>>
  /** Host timer may exclude time spent awaiting external input. */
  waitForTimeout?: (milliseconds: number) => Effect.Effect<void>
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
  "LoopIterationLimitExceeded",
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
  // 脚本成功不代表所有后台调用成功；仅暴露尚未观察的失败事实。
  unobservedFailure: Schema.optionalKey(Schema.Boolean),
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
  maximum = Number.MAX_SAFE_INTEGER,
): Value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  // Effect 的计时器只支持有符号32位毫秒；超界不能悄悄变成无期限执行。
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1, 2_147_483_647),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxLoopIterations: validateLimit("maxLoopIterations", limits?.maxLoopIterations, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
  // 零预算表示只记录省略数；不能按真值把它当成无限额。
  maxLogBytes: validateLimit("maxLogBytes", limits?.maxLogBytes, 0),
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
  // Schema.Json 保证有限数值；危险键和深度仍由下方唯一数据边界判定。
  const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(text)
  // 只有容器需要结构化访问；解析失败与标量文本均保留原格式。
  if (parsed._tag === "Failure" || parsed.success === null || typeof parsed.success !== "object") return text
  try {
    // 复用既有深度、危险键和普通对象边界，不引入第二套可表示性规则。
    return withRawText(ToolRuntime.copyIn(parsed.success, "JSON tool result"), text)
  } catch (error) {
    // 已知不可表示的文本仍是成功文本；内部意外错误不能伪装成格式选择。
    if (error instanceof ToolRuntime.ToolRuntimeError && error.kind === "InvalidDataValue") return text
    throw error
  }
}

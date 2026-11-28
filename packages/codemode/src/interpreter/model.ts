import type { SafeObject } from "../tool-runtime.js"
import type { SandboxURL } from "../values.js"

export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

export type Binding = {
  mutable: boolean
  value: unknown
  initialized?: boolean
}

// 宿主只持有不透明词法状态；工具回调、执行 Scope 和权限均不属于可复用环境。
export class Environment {
  // 两个根分开后，用户可以遮蔽内建名称；刷新能力不会删除用户变量。
  private readonly roots = {
    globals: new Map<string, Binding>(),
    bindings: new Map<string, Binding>(),
  }

  static scopes(environment: Environment) {
    return environment.roots
  }
}

export type StatementResult =
  | { kind: "none" }
  | { kind: "value"; value: unknown }
  | { kind: "return"; value: unknown }
  | { kind: "break" }
  | { kind: "continue" }

export type MemberReference = {
  target: SafeObject | Array<unknown> | SandboxURL
  key: string | number
}

export class CodeModeFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
    // 保留语法身份，所有调用入口才能共享返回 Promise 的语义。
    readonly async = false,
  ) {}
}

export class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

export class ComputedValue {
  constructor(readonly value: unknown) {}
}

export class PromiseNamespace {}

export type PromiseMethodName = "all" | "allSettled" | "race" | "resolve" | "reject"

export class PromiseMethodReference {
  constructor(readonly name: PromiseMethodName) {}
}

export type GlobalNamespaceName =
  | "Object"
  | "Math"
  | "JSON"
  | "Array"
  | "console"
  | "Date"
  | "RegExp"
  | "Map"
  | "Set"
  | "URL"
  | "URLSearchParams"

export class GlobalNamespace {
  constructor(readonly name: GlobalNamespaceName) {}
}

export class GlobalMethodReference {
  constructor(
    // 私有内建类别不暴露命名空间或执行上下文，保留别名只能指向当前单元。
    readonly namespace: GlobalNamespaceName | "Number" | "String" | "$builtin",
    readonly name: string,
  ) {}
}

export class CoercionFunction {
  constructor(readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat") {}
}

export class UriFunction {
  constructor(readonly name: "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent") {}
}

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class ErrorConstructorReference {
  constructor(readonly name: string) {}
}

export type DiagnosticKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded"
  | "LoopIterationLimitExceeded"
  | "TimeoutExceeded"
  | "ToolFailure"
  | "ExecutionFailure"

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit")

// 诊断与实际调用面一致，不能再把已支持的链式方法说成禁用。
export const supportedSyntaxMessage =
  "Supported orchestration syntax: tools.* calls (they return promises - resolve them with await), data literals, destructuring, optional chaining, template literals, conditionals, switch, loops (incl. for...of and for...in over object/array/tools keys), arrow functions, supported builtins as callbacks, spread, try/catch, Array construction and Array.from mapping, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods (incl. match/matchAll/replace/split with regular expressions), Date/RegExp/Map/Set/URL/URLSearchParams, URI encoding helpers, Object/Math/JSON helpers, captured console.log/warn/error/dir/table, and Promise.all/allSettled/race/resolve/reject over arrays mixing promises and plain values for parallel tool calls (Promise .then/.catch/.finally accept collection callbacks and adopt returned promises)."

export class InterpreterRuntimeError extends Error {
  readonly node?: AstNode
  errorName: string = "Error"

  constructor(
    message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = "ExecutionFailure",
    readonly suggestions?: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = "InterpreterRuntimeError"
    if (node) this.node = node
  }

  as(errorName: string): this {
    this.errorName = errorName
    return this
  }
}

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported in CodeMode. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
  )

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const asNode = (value: unknown, context: string): AstNode => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`)
  }
  return value as AstNode
}

export const getArray = (node: AstNode, key: string): Array<unknown> => {
  const value = node[key]
  if (!Array.isArray(value)) throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node)
  return value
}

export const getString = (node: AstNode, key: string): string => {
  const value = node[key]
  if (typeof value !== "string") throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node)
  return value
}

export const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key]
  if (typeof value !== "boolean") throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node)
  return value
}

export const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  if (value === undefined || value === null) return undefined
  return asNode(value, key)
}

export const getNode = (node: AstNode, key: string): AstNode => asNode(node[key], key)

export const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return ""
  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}

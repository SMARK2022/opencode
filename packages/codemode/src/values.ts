import type { Exit, Fiber } from "effect"

// 来源元数据不写入业务对象，避免输出解码器把便利字段当成真实数据。
// 弱引用随值回收，不为 Notebook 或单次执行增加独立生命周期。
const sources = new WeakMap<object, string>()

export const rawText = (value: unknown): string | undefined =>
  value !== null && typeof value === "object" ? sources.get(value) : undefined

export const withRawText = <T>(value: T, text: string | undefined, exposeAlias = false): T => {
  if (text === undefined || value === null || typeof value !== "object") return value
  // 原始快照只能登记一次；后续业务修改不能改写源文本。
  if (!sources.has(value)) sources.set(value, text)
  // 仅解释器内副本暴露只读别名；同名业务字段优先且保留原有可写语义。
  // 不可枚举保证键遍历与 JSON 出口只包含业务数据。
  if (exposeAlias && !Object.hasOwn(value, "text"))
    Object.defineProperty(value, "text", { value: sources.get(value), enumerable: false })
  return value
}

// 在途 Fiber 只属于当前执行；收尾后改存终态，闭包不能借 Promise 保活旧宿主上下文。
export class SandboxPromise {
  // 只表示某次观察已收到终态；它不能证明脚本捕获或补救了失败。
  observed = false
  constructor(public state: { fiber: Fiber.Fiber<unknown, unknown> } | { exit: Exit.Exit<unknown, unknown> }) {}
}

export class SandboxDate {
  constructor(readonly time: number) {}
}

export class SandboxRegExp {
  readonly regex: RegExp
  constructor(pattern: string, flags: string) {
    this.regex = new RegExp(pattern, flags)
  }
}

export class SandboxMap {
  readonly map = new Map<unknown, unknown>()
}

export class SandboxSet {
  readonly set = new Set<unknown>()
}

export class SandboxURLSearchParams {
  // 绑定视图保留原 URL 的归属，使反序遍历的快照仍能重建同一内部槽。
  constructor(
    readonly params: URLSearchParams,
    readonly owner?: URL,
  ) {}
}

export class SandboxURL {
  readonly searchParams: SandboxURLSearchParams
  constructor(readonly url: URL) {
    this.searchParams = new SandboxURLSearchParams(url.searchParams, url)
  }
}

export const isSandboxValue = (
  value: unknown,
): value is SandboxDate | SandboxRegExp | SandboxMap | SandboxSet | SandboxURL | SandboxURLSearchParams =>
  value instanceof SandboxDate ||
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURL ||
  value instanceof SandboxURLSearchParams

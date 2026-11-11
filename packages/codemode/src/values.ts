import type { Exit, Fiber } from "effect"

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
  constructor(readonly params: URLSearchParams) {}
}

export class SandboxURL {
  readonly searchParams: SandboxURLSearchParams
  constructor(readonly url: URL) {
    this.searchParams = new SandboxURLSearchParams(url.searchParams)
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

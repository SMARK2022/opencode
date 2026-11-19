// 计数型性能预算：不量墙钟时间，量“做了多少工作”。结果与机器快慢无关，可作为必过测试。
import { Database } from "bun:sqlite"

type Counters = { statements: number; rowsRead: number; bytesRead: number }

const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
let active: Counters | undefined
const wrapped = new WeakSet<object>()

for (const method of ["query", "prepare"] as const) {
  const original = proto[method]
  proto[method] = function (this: Database, ...args: unknown[]) {
    const stmt = original.apply(this, args) as Record<string, (...a: unknown[]) => unknown>
    if (wrapped.has(stmt)) return stmt
    wrapped.add(stmt)
    for (const run of ["all", "get", "values", "run", "iterate"]) {
      const exec = stmt[run]
      if (typeof exec !== "function") continue
      stmt[run] = (...p: unknown[]) => {
        const out = exec.apply(stmt, p)
        if (active) {
          active.statements++
          const rows = Array.isArray(out) ? out : out && run === "get" ? [out] : []
          active.rowsRead += rows.length
          active.bytesRead += rows.reduce<number>((n, r) => n + JSON.stringify(r).length, 0)
        }
        return out
      }
    }
    return stmt
  }
}

export async function measure<T>(fn: () => Promise<T> | T) {
  const counters: Counters = { statements: 0, rowsRead: 0, bytesRead: 0 }
  active = counters
  try {
    const result = await fn()
    return { result, ...counters }
  } finally {
    active = undefined
  }
}

// 规模不变性：同一操作在 n 与 10n 条数据下执行，语句数必须相同，读取量增长不得超过 maxGrowth 倍。
export async function expectScaleInvariant(
  seed: (n: number) => Promise<void> | void,
  op: () => Promise<unknown> | unknown,
  opts: { n: number; maxGrowth: number },
) {
  await seed(opts.n)
  const small = await measure(op)
  await seed(opts.n * 10)
  const large = await measure(op)
  if (large.statements !== small.statements)
    throw new Error(`语句数随数据量增长: ${small.statements} → ${large.statements}（N+1 或分页失效）`)
  if (large.bytesRead > small.bytesRead * opts.maxGrowth)
    throw new Error(`读取量增长 ${small.bytesRead} → ${large.bytesRead}，超过 ${opts.maxGrowth}x（缺少 LIMIT 或读取了历史正文）`)
  return { small, large }
}

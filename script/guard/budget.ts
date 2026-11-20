// 计数型性能预算：不量墙钟时间，量“做了多少工作”。结果与机器快慢无关，可作为必过测试。
import { Database } from "bun:sqlite"
import { AsyncLocalStorage } from "node:async_hooks"

type Counters = { statements: number; rowsRead: number; bytesRead: number }

const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
const active = new AsyncLocalStorage<Counters>()
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
        if (run === "iterate") {
          return (function* () {
            const counters = active.getStore()
            if (counters) counters.statements++
            for (const row of out as Iterable<unknown>) {
              recordRows(counters, [row])
              yield row
            }
          })()
        }
        const counters = active.getStore()
        if (counters) counters.statements++
        recordRows(counters, Array.isArray(out) ? out : out && run === "get" ? [out] : [])
        return out
      }
    }
    return stmt
  }
}

for (const method of ["run", "exec"] as const) {
  const original = proto[method]
  proto[method] = function (this: Database, ...args: unknown[]) {
    const result = original.apply(this, args)
    const counters = active.getStore()
    if (counters) counters.statements++
    return result
  }
}

function recordRows(counters: Counters | undefined, rows: unknown[]) {
  if (!counters) return
  counters.rowsRead += rows.length
  counters.bytesRead += rows.reduce<number>(
    (n, row) =>
      n + Buffer.byteLength(JSON.stringify(row, (_, value) => (typeof value === "bigint" ? String(value) : value))),
    0,
  )
}

export async function measure<T>(fn: () => Promise<T> | T) {
  const counters: Counters = { statements: 0, rowsRead: 0, bytesRead: 0 }
  return active.run(counters, async () => {
    const result = await fn()
    return { result, ...counters }
  })
}

// 规模不变性：同一操作在 n 与 10n 条数据下执行，语句数必须相同，读取量增长不得超过 maxGrowth 倍。
export async function expectScaleInvariant(
  seed: (n: number) => Promise<void> | void,
  op: () => Promise<unknown> | unknown,
  opts: { n: number; maxGrowth: number },
) {
  if (!Number.isSafeInteger(opts.n) || opts.n < 1 || !Number.isFinite(opts.maxGrowth) || opts.maxGrowth < 1)
    throw new Error("规模预算需要正整数 n 和至少为 1 的有限 maxGrowth")
  await seed(opts.n)
  const small = await measure(op)
  await seed(opts.n * 10)
  const large = await measure(op)
  if (!small.statements || !large.statements) throw new Error("规模预算未观察到 SQL 执行")
  if (large.statements !== small.statements)
    throw new Error(`语句数随数据量增长: ${small.statements} → ${large.statements}（N+1 或分页失效）`)
  if (large.bytesRead > small.bytesRead * opts.maxGrowth)
    throw new Error(
      `读取量增长 ${small.bytesRead} → ${large.bytesRead}，超过 ${opts.maxGrowth}x（缺少 LIMIT 或读取了历史正文）`,
    )
  return { small, large }
}

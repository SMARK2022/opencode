// 端到端基准的通用部件：启动被测进程、外部健康探针、CPU 与内存采样、A/B 统计判定。
// 所有度量都从进程外部取得，被测代码不需要任何“仅供测试”的代码。
import os from "node:os"

export type Sample = {
  startupMs: number // 启动到健康检查首次成功
  wallMs: number // 场景墙钟时间
  cpuMs: number // 场景期间被测进程消耗的 CPU 时间（比墙钟稳定）
  maxBlockMs: number // 探针最长响应时间：事件循环被卡住的上限
  p50Ms: number
  p95Ms: number
  p99Ms: number
  probeErrorRate: number // 探针失败（超时、拒绝连接、非 2xx）占比
  maxOutageMs: number // 最长连续不可用时长
  peakRssMb: number
  rssGrowthMb: number // 场景结束时相对开始时的常驻内存增量
  crashed: number // 场景期间进程退出 = 1
}
export type Target = { label: string; start: (port: number) => Bun.Subprocess; healthPath: string }
export const METRICS: (keyof Sample)[] = [
  "startupMs", "wallMs", "cpuMs", "maxBlockMs", "p50Ms", "p95Ms", "p99Ms", "probeErrorRate", "maxOutageMs", "peakRssMb", "rssGrowthMb", "crashed",
]

export async function waitHealthy(url: string, timeoutMs = 60_000, proc?: Bun.Subprocess) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    if (proc && proc.exitCode !== null) throw new Error(`进程在就绪前退出（exit ${proc.exitCode}）`)
    const ok = await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false)
    if (ok) return performance.now() - t0
    await Bun.sleep(20)
  }
  throw new Error(`${timeoutMs}ms 内未就绪：${url}`)
}

// 健康探针：固定节奏请求轻量端点，每次 1 秒超时。失败不再被吞掉：它们计入失败率与掉线时长。
export function startProbe(url: string, intervalMs = 50, timeoutMs = 1000) {
  const lat: number[] = []
  let failures = 0
  let outageStart: number | undefined
  let maxOutage = 0
  let stop = false
  const loop = (async () => {
    while (!stop) {
      const t = performance.now()
      const ok = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.ok).catch(() => false)
      const now = performance.now()
      if (ok) {
        lat.push(now - t)
        if (outageStart !== undefined) maxOutage = Math.max(maxOutage, now - outageStart)
        outageStart = undefined
      } else {
        failures++
        lat.push(now - t)
        outageStart ??= t
      }
      await Bun.sleep(Math.max(0, intervalMs - (performance.now() - t)))
    }
  })()
  return async () => {
    stop = true
    await loop
    if (outageStart !== undefined) maxOutage = Math.max(maxOutage, performance.now() - outageStart)
    const s = lat.toSorted((a, b) => a - b)
    const q = (p: number) => s.at(Math.min(s.length - 1, Math.floor(s.length * p))) ?? 0
    return { max: s.at(-1) ?? 0, p50: q(0.5), p95: q(0.95), p99: q(0.99), errorRate: lat.length ? failures / lat.length : 0, maxOutage }
  }
}

const CLK_TCK = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim()) || 100

async function readRssMb(pid: number) {
  if (os.platform() === "linux") {
    const status = await Bun.file(`/proc/${pid}/status`).text().catch(() => "")
    return Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024
  }
  return Number(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim() || 0) / 1024
}

async function readCpuMs(pid: number) {
  if (os.platform() === "linux") {
    const stat = await Bun.file(`/proc/${pid}/stat`).text().catch(() => "")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return ((Number(fields[11]) + Number(fields[12])) / CLK_TCK) * 1000 || 0
  }
  const t = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)]).stdout.toString().trim()
  const parts = t.split(/[-:]/).map(Number).reverse()
  return ((parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400) * 1000
}

export function startRssSampler(pid: number, intervalMs = 50) {
  let peak = 0
  const timer = setInterval(async () => {
    peak = Math.max(peak, await readRssMb(pid))
  }, intervalMs)
  return async () => {
    clearInterval(timer)
    peak = Math.max(peak, await readRssMb(pid))
    return peak
  }
}

export async function runOnce(target: Target, scenario: (base: string) => Promise<void>): Promise<Sample & { error?: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const t0 = performance.now()
  const proc = target.start(port)
  const base = `http://127.0.0.1:${port}`
  try {
    const startupMs = await waitHealthy(base + target.healthPath, 60_000, proc).then(() => performance.now() - t0)
    const rss0 = await readRssMb(proc.pid)
    const cpu0 = await readCpuMs(proc.pid)
    const stopRss = startRssSampler(proc.pid)
    const stopProbe = startProbe(base + target.healthPath)
    const s0 = performance.now()
    let error: string | undefined
    await scenario(base).catch((e) => (error = e instanceof Error ? e.message : String(e)))
    const wallMs = performance.now() - s0
    const block = await stopProbe()
    const crashed = proc.exitCode !== null ? 1 : 0
    const cpuMs = crashed ? 0 : (await readCpuMs(proc.pid)) - cpu0
    const rss1 = crashed ? 0 : await readRssMb(proc.pid)
    return {
      startupMs, wallMs, cpuMs,
      maxBlockMs: block.max, p50Ms: block.p50, p95Ms: block.p95, p99Ms: block.p99,
      probeErrorRate: block.errorRate, maxOutageMs: block.maxOutage,
      peakRssMb: await stopRss(), rssGrowthMb: crashed ? 0 : rss1 - rss0, crashed,
      error: crashed ? `场景期间进程退出（exit ${proc.exitCode}）` : error,
    }
  } finally {
    proc.kill()
    await proc.exited
  }
}

// 交替执行 A、B（ABBA），抵消机器负载的漂移
export async function abRun(a: Target, b: Target, scenario: (base: string) => Promise<void>, rounds: number) {
  const res: Record<string, (Sample & { error?: string })[]> = { [a.label]: [], [b.label]: [] }
  for (let i = 0; i < rounds; i++) for (const t of i % 2 ? [b, a] : [a, b]) res[t.label].push(await runOnce(t, scenario))
  return res
}

// Mann-Whitney U，单侧：head 是否显著大于 base（精确分布，适合小样本）
export function mannWhitneyGreater(head: number[], base: number[]) {
  const n2 = base.length
  let u = 0
  for (const x of head) for (const y of base) u += x > y ? 1 : x === y ? 0.5 : 0
  const memo = new Map<string, Map<number, number>>()
  const ways = (m: number, n: number): Map<number, number> => {
    if (m === 0 || n === 0) return new Map([[0, 1]])
    const key = `${m},${n}`
    const hit = memo.get(key)
    if (hit) return hit
    const out = new Map<number, number>()
    for (const [k, v] of ways(m - 1, n)) out.set(k + n, (out.get(k + n) ?? 0) + v)
    for (const [k, v] of ways(m, n - 1)) out.set(k, (out.get(k) ?? 0) + v)
    memo.set(key, out)
    return out
  }
  const dist = ways(head.length, n2)
  const total = [...dist.values()].reduce((s, v) => s + v, 0)
  const tail = [...dist].filter(([k]) => k >= u).reduce((s, [, v]) => s + v, 0)
  return { u, p: tail / total }
}

export const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

export type Budget = { metric: keyof Sample; maxRatio: number; minAbs: number }
export type Verdict = { metric: string; base: number; head: number; ratio: number | null; p: number; regressed: boolean }

// 退化 = 中位数变差超过 maxRatio，且超过绝对噪声下限 minAbs，且统计显著；head 任何一次崩溃直接判退化
export function judge(head: Sample[], base: Sample[], budgets: Budget[]): Verdict[] {
  const out: Verdict[] = budgets.map((b) => {
    const h = head.map((s) => s[b.metric])
    const o = base.map((s) => s[b.metric])
    const mh = median(h)
    const mo = median(o)
    const { p } = mannWhitneyGreater(h, o)
    const regressed = mh > mo * (1 + b.maxRatio) && mh - mo > b.minAbs && p < 0.05
    return { metric: b.metric, base: round(mo), head: round(mh), ratio: mo > 0 ? round(mh / mo, 2) : null, p: round(p, 4), regressed }
  })
  const crashes = head.filter((s) => s.crashed).length
  out.push({ metric: "crashed", base: base.filter((s) => s.crashed).length, head: crashes, ratio: null, p: 0, regressed: crashes > 0 })
  return out
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

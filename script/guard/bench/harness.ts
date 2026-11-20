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
type ProcessMetrics = { rssMb: (pid: number) => Promise<number>; cpuMs: (pid: number) => Promise<number> }
export type Measurement = Sample & { error?: string }
export const METRICS: (keyof Sample)[] = [
  "startupMs",
  "wallMs",
  "cpuMs",
  "maxBlockMs",
  "p50Ms",
  "p95Ms",
  "p99Ms",
  "probeErrorRate",
  "maxOutageMs",
  "peakRssMb",
  "rssGrowthMb",
  "crashed",
]

export async function waitHealthy(url: string, timeoutMs = 60_000, proc?: Bun.Subprocess) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    if (proc && (proc.exitCode !== null || proc.signalCode !== null))
      throw new Error(`进程在就绪前退出（${proc.exitCode ?? proc.signalCode}）`)
    const ok = await fetch(url, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
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
      const ok = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        .then((r) => r.ok)
        .catch(() => false)
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
    return {
      max: s.at(-1) ?? 0,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      errorRate: lat.length ? failures / lat.length : 0,
      maxOutage,
    }
  }
}

const CLK_TCK =
  os.platform() === "linux" ? Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim()) || 100 : 100

async function readRssMb(pid: number) {
  if (os.platform() === "linux") {
    const status = await Bun.file(`/proc/${pid}/status`).text()
    const value = Number(status.match(/VmRSS:\s+(\d+)/)?.[1]) / 1024
    if (!Number.isFinite(value) || value <= 0) throw new Error(`无法读取进程 ${pid} 的 RSS`)
    return value
  }
  const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
  const value = Number(result.stdout.toString().trim()) / 1024
  if (!result.success || !Number.isFinite(value) || value <= 0) throw new Error(`无法读取进程 ${pid} 的 RSS`)
  return value
}

async function readCpuMs(pid: number) {
  if (os.platform() === "linux") {
    const stat = await Bun.file(`/proc/${pid}/stat`).text()
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const value = ((Number(fields[11]) + Number(fields[12])) / CLK_TCK) * 1000
    if (!Number.isFinite(value) || value < 0) throw new Error(`无法读取进程 ${pid} 的 CPU 时间`)
    return value
  }
  const result = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)])
  const t = result.stdout.toString().trim()
  if (!result.success || !/^\d+(?:[-:]\d+){1,3}(?:\.\d+)?$/.test(t)) throw new Error(`无法读取进程 ${pid} 的 CPU 时间`)
  const parts = t.split(/[-:]/).map(Number).reverse()
  return ((parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400) * 1000
}

export function startRssSampler(pid: number, intervalMs = 50, read = readRssMb) {
  let peak = 0
  let stop = false
  let error: Error | undefined
  const loop = (async () => {
    while (!stop) {
      peak = Math.max(peak, await read(pid))
      if (!stop) await Bun.sleep(intervalMs)
    }
  })().catch((cause: unknown) => {
    error = cause instanceof Error ? cause : new Error(String(cause))
  })
  let completed: Promise<number> | undefined
  return () =>
    (completed ??= (async () => {
      stop = true
      await loop
      if (error) throw error
      peak = Math.max(peak, await read(pid))
      return peak
    })())
}

export async function runOnce(
  target: Target,
  scenario: (base: string) => Promise<void>,
  timeoutMs = 60_000,
  metrics: ProcessMetrics = { rssMb: readRssMb, cpuMs: readCpuMs },
): Promise<Measurement> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const t0 = performance.now()
  const proc = target.start(port)
  const base = `http://127.0.0.1:${port}`
  let stopRss: ReturnType<typeof startRssSampler> | undefined
  let stopProbe: ReturnType<typeof startProbe> | undefined
  try {
    const startupMs = await waitHealthy(base + target.healthPath, 60_000, proc).then(() => performance.now() - t0)
    const rss0 = await metrics.rssMb(proc.pid)
    const cpu0 = await metrics.cpuMs(proc.pid)
    stopRss = startRssSampler(proc.pid, 50, async (pid) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return 0
      return metrics.rssMb(pid).catch((error: unknown) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return 0
        throw error
      })
    })
    stopProbe = startProbe(base + target.healthPath)
    const s0 = performance.now()
    let error: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`场景超过 ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      await Promise.race([scenario(base), expired]).catch((e) => (error = e instanceof Error ? e.message : String(e)))
    } finally {
      clearTimeout(timer)
    }
    const wallMs = performance.now() - s0
    const block = await stopProbe()
    const crashed = proc.exitCode !== null || proc.signalCode !== null ? 1 : 0
    const cpuMs = crashed ? 0 : (await metrics.cpuMs(proc.pid)) - cpu0
    const rss1 = crashed ? 0 : await metrics.rssMb(proc.pid)
    return {
      startupMs,
      wallMs,
      cpuMs,
      maxBlockMs: block.max,
      p50Ms: block.p50,
      p95Ms: block.p95,
      p99Ms: block.p99,
      probeErrorRate: block.errorRate,
      maxOutageMs: block.maxOutage,
      peakRssMb: await stopRss(),
      rssGrowthMb: crashed ? 0 : rss1 - rss0,
      crashed,
      error: crashed ? `场景期间进程退出（${proc.exitCode ?? proc.signalCode}）` : error,
    }
  } finally {
    try {
      await stopProbe?.()
      await stopRss?.()
    } finally {
      await stopTarget(proc)
    }
  }
}

export async function stopTarget(proc: Bun.Subprocess) {
  proc.kill()
  const force = setTimeout(() => proc.kill("SIGKILL"), 1000)
  try {
    await proc.exited
  } finally {
    clearTimeout(force)
  }
}

// 交替执行 A、B（ABBA），抵消机器负载的漂移
export async function abRun(a: Target, b: Target, scenario: (base: string) => Promise<void>, rounds: number) {
  validateRounds(rounds)
  if (a.label === b.label) throw new Error("A/B 目标必须使用不同的名称")
  const res: Record<string, Measurement[]> = { [a.label]: [], [b.label]: [] }
  for (let i = 0; i < rounds; i++)
    for (const t of i % 2 ? [b, a] : [a, b]) res[t.label].push(await runOnce(t, scenario))
  return res
}

// Mann-Whitney U，单侧：head 是否显著大于 base（精确分布，适合小样本）
export function mannWhitneyGreater(head: number[], base: number[]) {
  if (!head.length || !base.length || [...head, ...base].some((x) => !Number.isFinite(x)))
    throw new Error("Mann-Whitney 需要两组有限数值样本")
  let u = 0
  for (const x of head) for (const y of base) u += x > y ? 1 : x === y ? 0.5 : 0
  const sorted = [...head, ...base].toSorted((a, b) => a - b)
  const ranks: number[] = []
  for (let first = 0; first < sorted.length; ) {
    let end = first + 1
    while (end < sorted.length && sorted[end] === sorted[first]) end++
    for (let i = first; i < end; i++) ranks.push(first + end + 1)
    first = end
  }
  // 两倍平均秩保持整数；按观测值的实际并列秩求置换分布。
  const ways = Array.from({ length: head.length + 1 }, () => new Map<number, number>())
  ways[0].set(0, 1)
  for (const [i, rank] of ranks.entries()) {
    for (let n = Math.min(head.length, i + 1); n > 0; n--)
      for (const [sum, count] of ways[n - 1]) ways[n].set(sum + rank, (ways[n].get(sum + rank) ?? 0) + count)
  }
  const dist = ways[head.length]
  const observed = 2 * u + head.length * (head.length + 1)
  const total = [...dist.values()].reduce((s, v) => s + v, 0)
  const tail = [...dist].filter(([k]) => k >= observed).reduce((s, [, v]) => s + v, 0)
  return { u, p: tail / total }
}

export const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

export type Budget = { metric: keyof Sample; maxRatio: number; minAbs: number }
export type Verdict = {
  metric: string
  base: number
  head: number
  ratio: number | null
  p: number
  regressed: boolean
}

// 退化 = 中位数变差超过 maxRatio，且超过绝对噪声下限 minAbs，且统计显著；head 任何一次崩溃直接判退化
export function validateRounds(rounds: number) {
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 50)
    throw new Error("A/B 轮数必须为 4–50 的整数；少于 4 轮无法达到单侧 p < 0.05")
}

export function judge(head: Measurement[], base: Measurement[], budgets: Budget[]): Verdict[] {
  validateRounds(head.length)
  if (head.length !== base.length) throw new Error("A/B 样本数不一致")
  if (!budgets.length || new Set(budgets.map((b) => b.metric)).size !== budgets.length)
    throw new Error("性能预算必须非空且指标唯一")
  for (const b of budgets)
    if (
      !METRICS.includes(b.metric) ||
      !Number.isFinite(b.maxRatio) ||
      b.maxRatio < 0 ||
      !Number.isFinite(b.minAbs) ||
      b.minAbs < 0
    )
      throw new Error(`无效性能预算：${b.metric}`)
  for (const [label, samples] of [
    ["head", head],
    ["base", base],
  ] as const) {
    for (const [i, s] of samples.entries()) {
      if (
        METRICS.some((m) => !Number.isFinite(s[m]) || (m !== "rssGrowthMb" && s[m] < 0)) ||
        s.probeErrorRate > 1 ||
        ![0, 1].includes(s.crashed)
      )
        throw new Error(`${label} 第 ${i + 1} 轮指标无效`)
      if ((label === "base" && s.crashed) || (s.error !== undefined && !s.crashed))
        throw new Error(`${label} 第 ${i + 1} 轮未完成：${s.error ?? "进程退出"}`)
    }
  }
  const out: Verdict[] = budgets.map((b) => {
    const h = head.map((s) => s[b.metric])
    const o = base.map((s) => s[b.metric])
    const mh = median(h)
    const mo = median(o)
    const { p } = mannWhitneyGreater(h, o)
    const regressed = mh - mo > Math.abs(mo) * b.maxRatio && mh - mo > b.minAbs && p < 0.05
    const digits = b.metric === "probeErrorRate" ? 4 : 1
    return {
      metric: b.metric,
      base: round(mo, digits),
      head: round(mh, digits),
      ratio: mo > 0 ? round(mh / mo, 2) : null,
      p,
      regressed,
    }
  })
  const crashes = head.filter((s) => s.crashed).length
  out.push({
    metric: "crashed",
    base: base.filter((s) => s.crashed).length,
    head: crashes,
    ratio: null,
    p: 0,
    regressed: crashes > 0,
  })
  return out
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

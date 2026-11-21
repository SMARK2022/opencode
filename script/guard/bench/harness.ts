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
export type Target = {
  label: string
  prepare?: () => void
  release?: () => Promise<void>
  start: () => Bun.Subprocess
  healthPath: string
}
type ProcessMetrics = { rssMb: (pid: number) => Promise<number>; cpuMs: (pid: number) => Promise<number> }
export type Measurement = Sample & { error?: string; extra?: Record<string, number> }
export type Scenario<T extends Target> = (base: string, target: T) => Promise<void | Record<string, number>>
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

// 服务自己绑定端口；只接受该进程发布的回环地址，不能误探另一个进程。
export async function listening(proc: Bun.Subprocess, timeoutMs = 60_000) {
  const stream = proc.stdout
  if (!(stream instanceof ReadableStream)) throw new Error("启动协议需要 stdout 管道")
  const ready = Promise.withResolvers<string>()
  const decoder = new TextDecoder()
  let buffer = ""
  let announced = false
  const timer = setTimeout(() => ready.reject(new Error("等待服务监听地址超时")), timeoutMs)
  void stream.pipeTo(new WritableStream({
    write(bytes) {
      if (announced) return
      buffer += decoder.decode(bytes, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        const url = /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line.trim())?.[1]
        if (url) {
          announced = true
          ready.resolve(url)
          return
        }
      }
    },
    async close() {
      if (!announced) ready.reject(new Error(`进程未发布监听地址，退出码 ${await proc.exited}；见 stderr`))
    },
  })).catch(ready.reject)
  try {
    return await ready.promise
  } finally {
    clearTimeout(timer)
  }
}

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
  return async () => {
    stop = true
    await loop
    if (error) throw error
    return peak
  }
}

export async function runOnce<T extends Target>(
  target: T,
  scenario: Scenario<T>,
  timeoutMs = 60_000,
  metrics: ProcessMetrics = { rssMb: readRssMb, cpuMs: readCpuMs },
): Promise<Measurement> {
  target.prepare?.()
  const t0 = performance.now()
  const proc = target.start()
  let stopRss: ReturnType<typeof startRssSampler> | undefined
  let stopProbe: ReturnType<typeof startProbe> | undefined
  try {
    const base = await listening(proc)
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
    let extra: Record<string, number> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`场景超过 ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      extra = (await Promise.race([scenario(base, target), expired])) || undefined
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      clearTimeout(timer)
    }
    const wallMs = performance.now() - s0
    const running = proc.exitCode === null && proc.signalCode === null
    const [cpu1, rss1, peak, block] = await Promise.all([
      running ? metrics.cpuMs(proc.pid) : 0,
      running ? metrics.rssMb(proc.pid) : 0,
      stopRss(),
      stopProbe(),
    ])
    const crashed = proc.exitCode !== null || proc.signalCode !== null ? 1 : 0
    return {
      extra,
      startupMs,
      wallMs,
      cpuMs: crashed ? 0 : cpu1 - cpu0,
      maxBlockMs: block.max,
      p50Ms: block.p50,
      p95Ms: block.p95,
      p99Ms: block.p99,
      probeErrorRate: block.errorRate,
      maxOutageMs: block.maxOutage,
      peakRssMb: Math.max(rss0, peak, rss1),
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
      await target.release?.()
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
export async function abRun<T extends Target>(a: T, b: T, scenario: Scenario<T>, rounds: number, offset = 0) {
  validateRounds(rounds)
  if (a.label === b.label) throw new Error("A/B 目标必须使用不同的名称")
  const res: Record<string, Measurement[]> = { [a.label]: [], [b.label]: [] }
  for (let i = 0; i < rounds; i++)
    for (const t of (i + offset) % 2 ? [b, a] : [a, b]) res[t.label].push(await runOnce(t, scenario))
  return res
}

// 单侧配对 Wilcoxon：零差剔除，并列绝对差取平均秩；按符号翻转求精确尾概率。
export function signedRankP(head: number[], base: number[]) {
  if (!head.length || head.length !== base.length) throw new Error("A/B 配对样本数不一致")
  const delta = head.map((v, i) => v - base[i])
  if (delta.some((v) => !Number.isFinite(v))) throw new Error("配对差值必须有限")
  const sorted = delta.filter((v) => v !== 0).sort((a, b) => Math.abs(a) - Math.abs(b))
  const ways = [1]
  let observed = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1
    while (j < sorted.length && Math.abs(sorted[j]) === Math.abs(sorted[i])) j++
    const rank = i + j + 1 // 两倍秩，避免半整数下标
    for (; i < j; i++) {
      if (sorted[i] > 0) observed += rank
      for (let s = ways.length - 1; s >= 0; s--)
        if (ways[s]) ways[s + rank] = (ways[s + rank] ?? 0) + ways[s]
    }
  }
  return ways.slice(observed).reduce((sum, n) => sum + n, 0) / 2 ** sorted.length
}

export const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

export type Budget = { metric: string; maxRatio: number; minAbs: number }
export function valueOf(s: Measurement, metric: string): number {
  if (METRICS.includes(metric as keyof Sample)) return s[metric as keyof Sample]
  const v = s.extra?.[metric]
  if (v === undefined || !Number.isFinite(v) || v < 0) throw new Error(`缺少有效指标：${metric}`)
  return v
}
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
  if (!Number.isInteger(rounds) || rounds < 5 || rounds > 50)
    throw new Error("A/B 轮数必须为 5–50 的整数；少于 5 对无法达到单侧 p < 0.05")
}

export function judge(head: Measurement[], base: Measurement[], budgets: Budget[]): Verdict[] {
  if (!head.length) throw new Error("轮数为零")
  if (head.length !== base.length) throw new Error("A/B 样本数不一致")
  if (!budgets.length || new Set(budgets.map((b) => b.metric)).size !== budgets.length)
    throw new Error("性能预算必须非空且指标唯一")
  for (const b of budgets)
    if (
      !b.metric ||
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
  const crashes = head.filter((s) => s.crashed).length
  const out: Verdict[] = (crashes ? [] : budgets).map((b) => {
    const h = head.map((s) => valueOf(s, b.metric))
    const o = base.map((s) => valueOf(s, b.metric))
    const mh = median(h)
    const mo = median(o)
    const p = signedRankP(h, o)
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

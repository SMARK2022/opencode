// 端到端预算。maxRatio = 允许的相对变差；minAbs = 绝对噪声下限（与指标同单位）。只允许维护者修改。
import type { Budget } from "./harness"

const common: Budget[] = [
  { metric: "startupMs", maxRatio: 0.15, minAbs: 150 },
  { metric: "wallMs", maxRatio: 0.1, minAbs: 30 },
  { metric: "cpuMs", maxRatio: 0.1, minAbs: 50 },
  { metric: "maxBlockMs", maxRatio: 0.5, minAbs: 50 },
  { metric: "p99Ms", maxRatio: 0.5, minAbs: 20 },
  { metric: "probeErrorRate", maxRatio: 0, minAbs: 0.005 },
  { metric: "maxOutageMs", maxRatio: 0.5, minAbs: 200 },
  { metric: "peakRssMb", maxRatio: 0.1, minAbs: 20 },
  { metric: "rssGrowthMb", maxRatio: 0.5, minAbs: 15 },
]

export const SCENARIO_BUDGETS: Record<string, Budget[]> = {
  default: common,
  list: common,
  open: common,
  stream: common,
  abort: common.map((b) => (b.metric === "wallMs" ? { ...b, maxRatio: 0.2, minAbs: 50 } : b)),
}

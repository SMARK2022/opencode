// 端到端预算。maxRatio = 允许的相对变差；minAbs = 绝对噪声下限（与指标同单位）。只允许维护者修改。
import type { Budget } from "./harness"

const common: Budget[] = [
  { metric: "startupMs", maxRatio: 0.15, minAbs: 150 },
  { metric: "wallMs", maxRatio: 0.1, minAbs: 30 },
  { metric: "cpuMs", maxRatio: 0.1, minAbs: 50 },
  { metric: "maxBlockMs", maxRatio: 0.5, minAbs: 50 },
  { metric: "probeErrorRate", maxRatio: 0, minAbs: 0.005 },
  { metric: "maxOutageMs", maxRatio: 0.5, minAbs: 200 },
  { metric: "peakRssMb", maxRatio: 0.1, minAbs: 20 },
  { metric: "rssGrowthMb", maxRatio: 0.5, minAbs: 15 },
]

const ms = (metric: string, maxRatio: number, minAbs: number): Budget => ({ metric, maxRatio, minAbs })
const phases = [ms("prepMs", 0.15, 30), ms("finishMs", 0.15, 30)]

export const GROUPS: Record<string, Record<string, Budget[]>> = {
  basic: {
    list: common,
    open: common,
    stream: [...common, ...phases],
    abort: common.map((b) => (b.metric === "wallMs" ? { ...b, maxRatio: 0.2, minAbs: 50 } : b)),
    continue: [...common, ...phases],
  },
  extended: {
    tools: common,
    compact: [...common.filter((b) => b.metric !== "wallMs"), ms("compactMs", 0.2, 50)],
    revert: [
      ...common.filter((b) => ["wallMs", "cpuMs", "maxBlockMs", "peakRssMb"].includes(b.metric)),
      ms("revertMs", 0.2, 50), ms("unrevertMs", 0.2, 50),
    ],
    tui: [
      ms("tuiFirstPaintMs", 0.15, 50), ms("tuiFullMs", 0.15, 50), ms("tuiInputMs", 0.3, 16),
      ms("scrollFrameP95Ms", 0.2, 2), ms("scrollFrameMaxMs", 0.5, 16),
      ms("streamFrameP95Ms", 0.2, 2), ms("streamFrameMaxMs", 0.5, 16),
    ],
  },
}

export const SCENARIO_BUDGETS: Record<string, Budget[]> = Object.assign({}, ...Object.values(GROUPS))

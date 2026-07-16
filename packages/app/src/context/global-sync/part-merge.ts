import type { Part, ToolPart } from "@opencode-ai/sdk/v2/client"

type RunningToolState = Extract<ToolPart["state"], { status: "running" }>

function progressVersion(state: RunningToolState) {
  const value = state.metadata?.progressVersion
  // metadata 是旧 SQLite JSON 的开放记录；缺失、非有限、fraction 和负数统一为
  // legacy v0。归一化只发生在 client store boundary，不迁移或回写历史数据。
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return 0
  return value
}

export function mergePartSnapshot(existing: Part | undefined, incoming: Part): Part {
  // 无本地候选时直接接受 incoming，legacy v0 才能完成首次重连恢复。
  if (!existing) return incoming
  if (existing.type !== "tool" || incoming.type !== "tool") return incoming
  // 不同 ID 不属于同一状态机，不能用版本或 terminal 规则互相比较。
  if (existing.id !== incoming.id) return incoming
  // incoming terminal 没有 progressVersion，也必须先于所有 running 比较直接胜出。
  if (incoming.state.status === "completed" || incoming.state.status === "error") return incoming

  // HTTP page 与 SSE 独立到达；一旦本地已有 terminal，任何 running snapshot
  // 都不能恢复执行中。非 shell Tool 保持原有后到覆盖语义。
  if (
    (existing.state.status === "completed" || existing.state.status === "error") &&
    incoming.state.status === "running"
  ) {
    return existing
  }
  if (
    // 非 bash Tool 没有本任务定义的 cadence/version，保持原有后到覆盖行为。
    existing.tool !== "bash" ||
    incoming.tool !== "bash" ||
    existing.state.status !== "running" ||
    incoming.state.status !== "running"
  ) {
    return incoming
  }

  // running shell 只有严格更高版本才能前进；相等版本也保留 existing，避免同一
  // checkpoint 的 stale HTTP copy 覆盖更早到达、内容相同版本的 live store 对象。
  // 两个 state 已在上方收窄为 running，helper 不需要为不可达 terminal 再造默认值。
  return progressVersion(incoming.state) > progressVersion(existing.state) ? incoming : existing
}

export function mergePartSnapshots(existing: readonly Part[] | undefined, incoming: readonly Part[]): Part[] {
  if (!existing) return incoming.slice()
  // HTTP page 保持 server 顺序，只按 ID 查找本地候选并复用单 Part 合同。
  return incoming.map((part) => mergePartSnapshot(existing.find((item) => item.id === part.id), part))
}

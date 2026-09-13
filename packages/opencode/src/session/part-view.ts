// TUI viewer 专用纯投影：删除与同 Part 其他字段逐字重复的大字段，减少 wire/store 的重复驻留。
// 当前唯一覆盖 edit 类工具的 metadata.filediff.patch（与 metadata.diff 是同一 patch 字符串）。
// 完整 SDK、Provider、daemon SummaryCache 都走原数据路径，不经过这里；
// 不同值、未知工具与非重复字段必须原样保留。

// 结构最小约束：daemon 的 MessageV2.Part 与 TUI 的 SDK Part 共用同一 wire 形状，
// 但品牌 ID 类型不同；投影只读 type/status/metadata，不改写其余字段。
type Projectable = {
  type: string
  state?: {
    status: string
    metadata?: Record<string, unknown>
  }
}

export function project<T extends Projectable>(part: T): T {
  if (part.type !== "tool") return part
  if (part.state?.status !== "completed") return part
  const metadata = part.state.metadata
  if (!metadata) return part
  const diff = metadata["diff"]
  const filediff = metadata["filediff"]
  if (typeof diff !== "string") return part
  if (typeof filediff !== "object" || filediff === null || Array.isArray(filediff)) return part
  // 上行已排除 null/数组/非对象；Record 收窄只为索引读取，不改写值。
  const record = filediff as Record<string, unknown>
  if (record["patch"] !== diff) return part
  const rest = { ...record }
  delete rest["patch"]
  // 展开保留输入的完整形状；唯一变化是 filediff 失去与 diff 逐字相同的 patch。
  return { ...part, state: { ...part.state, metadata: { ...metadata, filediff: rest } } } as T
}

export * as PartView from "./part-view"

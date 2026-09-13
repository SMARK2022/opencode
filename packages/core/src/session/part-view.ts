export * as PartView from "./part-view"

// viewer连接与TUI共用纯投影；只剪同一工具内逐字重复的patch，完整SDK/Provider路径不调用。

// 结构最小约束：daemon 的 MessageV2.Part 与 TUI 的 SDK Part 共用同一 wire 形状，
// 但品牌 ID 类型不同；投影只读 type/status/metadata，不改写其余字段。
type Projectable = {
  type: string
  state?: {
    status: string
    metadata?: Record<string, unknown>
    structured?: Record<string, unknown>
  }
}

export function project<T extends Projectable>(part: T): T {
  if (part.type !== "tool") return part
  if (part.state?.status !== "completed") return part
  const metadata = projectFields(part.state.metadata)
  const structured = projectFields(part.state.structured)
  if (metadata === part.state.metadata && structured === part.state.structured) return part
  return { ...part, state: { ...part.state, ...(metadata !== part.state.metadata ? { metadata } : {}), ...(structured !== part.state.structured ? { structured } : {}) } }
}

export function projectFields<T>(fields: T): T {
  if (typeof fields !== "object" || fields === null || !("diff" in fields) || !("filediff" in fields)) return fields
  const filediff = fields.filediff
  if (typeof fields.diff !== "string" || typeof filediff !== "object" || filediff === null || Array.isArray(filediff)) return fields
  if (!("patch" in filediff) || filediff.patch !== fields.diff) return fields
  // V1 metadata与native structured只在正式viewer边界调用；共享事件及存储原对象始终不改写。
  const rest: Record<string, unknown> = { ...filediff }
  delete rest.patch
  return { ...fields, filediff: rest }
}

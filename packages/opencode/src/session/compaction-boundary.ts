import { and, desc, eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { MessageTable, PartTable } from "./session.sql"
import { MessageID, SessionID } from "./schema"

export type Info = {
  markerID: MessageID
  summaryID: MessageID
  tailStartID?: MessageID
}

// 只有已完成且无 error 的 summary assistant 与真实 compaction Part 配对后才形成边界。
// 查询只读取 Message hot info 和 Part discriminator/tail_start_id；recent memento 等冷字段不会被 decode。
// 这里是 prompt filter、cold eligibility 和 prune 共用的唯一边界权威。
export function latest(sessionID: SessionID): Info | undefined {
  return Database.use((db) => {
    // consumer 不自行扫描 marker/summary，避免同一 Session 得到冲突的冷热范围。
    // summary flag 还不够；finish/error 联合排除中断或失败的压缩尝试。
    const summaries = db
      .select()
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          sql`json_extract(${MessageTable.data}, '$.summary') = 1`,
          sql`coalesce(json_extract(${MessageTable.data}, '$.finish'), '') != ''`,
          sql`coalesce(json_type(${MessageTable.data}, '$.error'), 'null') = 'null'`,
        ),
      )
      // 单调 MessageID newest-first，不依赖 wall-clock 精度或平台 timestamp 舍入。
      .orderBy(desc(MessageTable.id))
      .all()

    // 最新失败候选不会遮挡更早仍合法的 completed boundary。
    for (const summary of summaries) {
      if (summary.data.role !== "assistant") continue
      // parent 必须定位同 Session 的 user marker，跨 Session ID 无法形成边界。
      const marker = db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, sessionID), eq(MessageTable.id, summary.data.parentID)))
        .get()
      if (!marker || marker.data.role !== "user") continue
      // 普通 user/assistant 对不能仅凭字段形似采用，marker 下还要有真实 Compaction Part。
      const part = db
        .select({ data: PartTable.data })
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, sessionID),
            eq(PartTable.message_id, marker.id),
            sql`json_extract(${PartTable.data}, '$.type') = 'compaction'`,
          ),
        )
        .orderBy(PartTable.id)
        .limit(1)
        .get()
      // 损坏或缺失配对继续寻找更早合法边界，不让一次失败尝试导致全部历史回热。
      if (!part || part.data.type !== "compaction") continue
      // routine prompt/Goal/eligibility 只经过 hot 投影查询，不会为边界判断持久 thaw。
      // 只返回 ID，调用方不能借 boundary seam 读取 transcript 或冷 memento 内容。
      return {
        markerID: marker.id,
        summaryID: summary.id,
        // tail_start_id 缋失时 consumer 使用 markerID 作为 shipped compatibility cutoff。
        tailStartID: part.data.tail_start_id,
      }
    }
    // undefined 表示没有可证明 boundary；完整历史仍是正常支持域，不是错误 fallback。
  })
}

export * as CompactionBoundary from "./compaction-boundary"

export * as SessionPreview from "./preview"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"

export const load = Effect.fn("SessionPreview.load")(function* (
  db: Database.Interface["db"],
  input: { sessionIDs: readonly string[]; limit?: number },
  version: "v1" | "native" = "native",
) {
  const result: Record<string, string[]> = {}
  // 空请求保持源端点的空映射语义，不生成IN ()或逐会话补查。
  if (input.sessionIDs.length === 0) return result
  const limit = input.limit ?? 2
  // ID始终作为绑定值；两代查询只读各自存储，不把另一代历史当fallback。
  const ids = sql.join(input.sessionIDs.map(id => sql`${id}`), sql`, `)
  const rows = yield* db.all<{ session_id: string; joined_text: string | null }>(
    version === "v1" ? sql`
      WITH ranked_messages AS (
        SELECT ${MessageTable.id} as message_id, ${MessageTable.session_id},
          ROW_NUMBER() OVER (
            PARTITION BY ${MessageTable.session_id}
            ORDER BY ${MessageTable.time_created} DESC, ${MessageTable.id} DESC
          ) as msg_rn
        FROM ${MessageTable}
        WHERE json_extract(${MessageTable.data}, '$.role') = 'user'
          AND json_type(${MessageTable.data}, '$.hidden') IS NULL
          AND ${MessageTable.session_id} IN (${ids})
          AND EXISTS (
            SELECT 1 FROM ${PartTable}
            WHERE ${PartTable.message_id} = ${MessageTable.id}
              AND json_extract(${PartTable.data}, '$.type') = 'text'
              AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
              AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
              AND json_type(${PartTable.data}, '$.hidden') IS NULL
          )
      ),
      preview_parts AS (
        SELECT rm.session_id, rm.msg_rn, ${PartTable.id} as part_id,
          json_extract(${PartTable.data}, '$.text') as text
        FROM ranked_messages rm
        INNER JOIN ${PartTable} ON ${PartTable.message_id} = rm.message_id
          AND json_extract(${PartTable.data}, '$.type') = 'text'
          AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
          AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
          AND json_type(${PartTable.data}, '$.hidden') IS NULL
        WHERE rm.msg_rn <= ${limit}
      )
      SELECT session_id, group_concat(text, ' ') as joined_text
      -- 多part先按ID排序再聚合；无可见text的消息不占窗口名额。
      FROM (SELECT * FROM preview_parts ORDER BY part_id)
      GROUP BY session_id, msg_rn
      -- 排名1是最新消息；选最近N条后反转排名，返回旧到新而不改变part顺序。
      ORDER BY session_id, msg_rn DESC
    ` : sql`
      WITH ranked_messages AS (
        SELECT ${SessionMessageTable.session_id} as session_id,
          json_extract(${SessionMessageTable.data}, '$.text') as joined_text,
          ROW_NUMBER() OVER (
            PARTITION BY ${SessionMessageTable.session_id}
            ORDER BY ${SessionMessageTable.seq} DESC
          ) as msg_rn
        FROM ${SessionMessageTable}
        -- 只读已提升user；synthetic、摘要及尚在inbox的输入不会混入预览。
        WHERE ${SessionMessageTable.type} = 'user'
          AND ${SessionMessageTable.session_id} IN (${ids})
          AND json_extract(${SessionMessageTable.data}, '$.text') <> ''
          -- 与Native Hidden合同一致：false或不完整metadata不构成隐藏标记。
          AND coalesce(
            json_extract(${SessionMessageTable.data}, '$.metadata.hidden.reason') = 'permission-reviewer-protocol-retry'
            AND json_type(${SessionMessageTable.data}, '$.metadata.hidden.time') IN ('integer', 'real')
            AND json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time') >= 0
            AND json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time') <= 9007199254740991
            AND CAST(json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time') AS INTEGER)
              = json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time'), 0
          ) = 0
      )
      -- 不经SessionHistory的压缩边界：最近用户正文来自完整durable历史。
      SELECT session_id, joined_text FROM ranked_messages
      WHERE msg_rn <= ${limit}
      -- Native按seq倒序选窗，再按排名倒序输出，保持与V1相同的对话时间方向。
      ORDER BY session_id, msg_rn DESC
    `,
  ).pipe(Effect.orDie)
  // 沿用源端点的截断后空白归一化；空白消息可能少展示一行，不另加扫描fallback。
  for (const row of rows) {
    const text = (row.joined_text ?? "").replace(/\s+/g, " ").trim()
    if (!text) continue
    if (!result[row.session_id]) result[row.session_id] = []
    result[row.session_id].push(text)
  }
  return result
})

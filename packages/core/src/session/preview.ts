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
  const limit = Math.floor(input.limit ?? 2)
  // 旧IN为集合且整数排名隐含floor；逐会话查询保持同一输入域，不重复追加。
  for (const sessionID of new Set(input.sessionIDs)) {
    // 两代各沿现有索引早停，不给另一代历史或冷正文增加补查路径。
    const rows = yield* db.all<{ joined_text: string | null }>(
      version === "v1" ? sql`
        SELECT joined_text FROM (
          SELECT ${MessageTable.id} as message_id, ${MessageTable.time_created} as time_created,
            (
              SELECT group_concat(text, ' ') FROM (
                SELECT json_extract(${PartTable.data}, '$.text') as text
                FROM ${PartTable}
                WHERE ${PartTable.message_id} = ${MessageTable.id}
                  AND json_extract(${PartTable.data}, '$.type') = 'text'
                  AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
                  AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
                  AND json_type(${PartTable.data}, '$.hidden') IS NULL
                -- 聚合前按part.id排序，插入顺序不能改变同一消息正文。
                ORDER BY ${PartTable.id}
              )
            ) as joined_text
          FROM ${MessageTable}
          WHERE json_extract(${MessageTable.data}, '$.role') = 'user'
            AND json_type(${MessageTable.data}, '$.hidden') IS NULL
            AND ${MessageTable.session_id} = ${sessionID}
            AND EXISTS (
              SELECT 1 FROM ${PartTable}
              WHERE ${PartTable.message_id} = ${MessageTable.id}
                AND json_extract(${PartTable.data}, '$.type') = 'text'
                AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
                AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
                AND json_type(${PartTable.data}, '$.hidden') IS NULL
            )
          ORDER BY ${MessageTable.time_created} DESC, ${MessageTable.id} DESC
          LIMIT ${limit}
        )
        -- 先选最新N条再反转，等时戳仍以message.id决定方向。
        ORDER BY time_created ASC, message_id ASC
      ` : sql`
        SELECT joined_text FROM (
          SELECT ${SessionMessageTable.seq} as seq, json_extract(${SessionMessageTable.data}, '$.text') as joined_text
          FROM ${SessionMessageTable}
          -- 只读已提升user；synthetic、摘要及尚在inbox的输入不会混入预览。
          WHERE ${SessionMessageTable.type} = 'user'
            AND ${SessionMessageTable.session_id} = ${sessionID}
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
          ORDER BY ${SessionMessageTable.seq} DESC
          LIMIT ${limit}
        )
        -- Native保自己的durable seq顺序，不套V1时间排名或压缩后的历史边界。
        ORDER BY seq ASC
      `,
    ).pipe(Effect.orDie)
    // LIMIT后归一化并丢弃空白，不为凑满行数再扫描更早正文。
    for (const row of rows) {
      const text = (row.joined_text ?? "").replace(/\s+/g, " ").trim()
      if (!text) continue
      if (!result[sessionID]) result[sessionID] = []
      result[sessionID].push(text)
    }
  }
  return result
})

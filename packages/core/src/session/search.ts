import { sql, type SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"

// #121：会话搜索条件——标题或消息正文（非 LIKE 通配）
// 范围：SessionTable.title + Part/Message JSON + SessionMessageTable.data
// 空白 search 返回 undefined，避免 instr(text,"") 匹配全表
export function searchCondition(search: string): SQL | undefined {
  const needle = search.trim().toLowerCase()
  if (!needle) return

  // #121：instr(lower(...)) 做大小写无关子串匹配，规避 SQLite LIKE 的 %/_ 语义
  return sql`(
    instr(lower(${SessionTable.title}), ${needle}) > 0
    or exists (
      select 1
      from ${PartTable}
      inner join ${MessageTable}
        on ${MessageTable.id} = ${PartTable.message_id}
       and ${MessageTable.session_id} = ${PartTable.session_id}
      where ${PartTable.session_id} = ${SessionTable.id}
        and json_type(${MessageTable.data}, '$.hidden') is null
        and json_type(${PartTable.data}, '$.hidden') is null
        and instr(lower(${PartTable.data}), ${needle}) > 0
      limit 1
    )
    or exists (
      select 1
      from ${SessionMessageTable}
      where ${SessionMessageTable.session_id} = ${SessionTable.id}
        and instr(lower(${SessionMessageTable.data}), ${needle}) > 0
      limit 1
    )
  )`
}

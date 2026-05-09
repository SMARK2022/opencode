import { sql, type SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./session.sql"

/**
 * Build a SQL condition that searches sessions by title or message content.
 *
 * Search scope:
 * - session.title
 * - MessageV2 part data (PartTable.data), excluding hidden messages/parts
 * - V2 session message data (SessionMessageTable.data)
 *
 * Uses `instr(lower(...))` for case-insensitive exact substring matching,
 * avoiding SQLite LIKE's % / _ wildcard semantics.
 *
 * Returns undefined when search string is blank, preventing `instr(text, "")`
 * from matching every row.
 */
export function searchCondition(search: string): SQL | undefined {
  const needle = search.trim().toLowerCase()
  if (!needle) return

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

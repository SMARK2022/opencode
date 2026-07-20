import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930100001_native_cold_storage_pack_v2",
  up(tx) {
    return Effect.gen(function* () {
      // V1旧完成标记只覆盖message/part；Native的pack定位与统计投影另行升级。
      const columns = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_message')`)
      // 已部署目标版本可能已有这两列；各列只补一次，原冷引用与正文保持不变。
      if (!columns.some((column) => column.name === "cold_key"))
        yield* tx.run(`ALTER TABLE \`session_message\` ADD \`cold_key\` blob;`)
      if (!columns.some((column) => column.name === "cold_stats"))
        yield* tx.run(`ALTER TABLE \`session_message\` ADD \`cold_stats\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

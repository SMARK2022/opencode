import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260717035627_native_cold_storage",
  up(tx) {
    return Effect.gen(function* () {
      // V1旧账本已完成冷库迁移，但尚未承载Native列，必须独立登记这次扩展。
      const columns = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_message')`)
      // 早期目标版本已随V1建列；保留其已部署结构和数据，不重复ALTER。
      if (columns.some((column) => column.name === "cold_ref")) return
      yield* tx.run(`ALTER TABLE \`session_message\` ADD \`cold_ref\` text REFERENCES cold_storage(hash);`)
      yield* tx.run(`CREATE INDEX \`session_message_cold_ref_idx\` ON \`session_message\` (\`cold_ref\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

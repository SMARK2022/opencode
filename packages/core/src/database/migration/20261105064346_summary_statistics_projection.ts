import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261105064346_summary_statistics_projection",
  up(tx) {
    return Effect.gen(function* () {
      // 旧行保留 NULL，使用时再补投影，避免迁移阶段解压整个历史库。
      yield* tx.run(`ALTER TABLE \`cold_storage\` ADD \`summary_stats\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration

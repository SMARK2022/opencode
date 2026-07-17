import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
// #493：cold_storage 表 + message/part.cold_ref 引用列。
// 一个 envelope 按 canonical hash 去重共享；RESTRICT FK 防止计数错误时误删仍被引用的 payload。
export default {
  id: "20260717035626_cold_storage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`cold_storage\` (
	\`hash\` text PRIMARY KEY,
	\`kind\` text NOT NULL,
	\`codec\` text NOT NULL,
	\`payload\` blob NOT NULL,
	\`raw_bytes\` integer NOT NULL,
	\`compressed_bytes\` integer NOT NULL,
	\`ref_count\` integer DEFAULT 0 NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL
);`)
      // #493：RESTRICT 而非 CASCADE——payload 生命周期由引用计数管理，owner row 删除走 release 路径。
      yield* tx.run(`ALTER TABLE \`message\` ADD \`cold_ref\` text REFERENCES cold_storage(hash);`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`cold_ref\` text REFERENCES cold_storage(hash);`)
      yield* tx.run(`CREATE INDEX \`cold_storage_ref_count_idx\` ON \`cold_storage\` (\`ref_count\`);`)
      yield* tx.run(`CREATE INDEX \`message_cold_ref_idx\` ON \`message\` (\`cold_ref\`);`)
      yield* tx.run(`CREATE INDEX \`part_cold_ref_idx\` ON \`part\` (\`cold_ref\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

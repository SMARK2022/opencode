import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
// #364：session goal 表——持久化会话目标、状态与用量。
// 一个 session 最多一个 current goal（session_id 主键），
// FK cascade 保证删除 session 时 goal 自动清理。
export default {
  id: "20260726100000_session_goal",
  // 已部署Goal表沿用source完成身份，保留用户目标而非重复建表。
  legacy: ["20260704053848_session_goal"],
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`session_goal\` (
	\`session_id\` text PRIMARY KEY,
	\`id\` text NOT NULL,
	\`objective\` text NOT NULL,
	\`status\` text NOT NULL,
	\`token_budget\` integer,
	\`tokens_used\` integer DEFAULT 0 NOT NULL,
	\`time_used_seconds\` integer DEFAULT 0 NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);`)
      yield* tx.run(`CREATE INDEX \`session_goal_status_idx\` ON \`session_goal\` (\`session_id\`,\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

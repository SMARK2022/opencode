import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
// [local-smark] GOAL 生命周期完整性：generation 代际 CAS、terminal reason、
// blocked 连续审计（reason/streak/last_turn_id）与 terminal_turn_id 溯源。
// 旧行默认 generation=1、streak=0，保证升级后旧 GOAL 行为不变
export default {
  id: "20260901100000_session_goal_integrity",
  // 已完成的source完整性迁移保留真实terminal reason，不再次回填旧标记。
  legacy: ["20260714083829_session-goal-integrity"],
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`generation\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`reason\` text;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`blocked_reason\` text;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`blocked_streak\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`blocked_last_turn_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`terminal_turn_id\` text;`)
      // 旧 terminal 行的 reason 无法恢复，写入诚实兼容标记而非 null 或伪造理由。
      // active/paused 行的 reason 保持 null（默认值），不触碰
      yield* tx.run(
        `UPDATE \`session_goal\` SET \`reason\` = 'Legacy terminal transition (reason unavailable)' WHERE \`status\` IN ('complete', 'blocked');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

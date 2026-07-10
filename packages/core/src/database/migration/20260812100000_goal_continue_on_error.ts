import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
// [local-smark] session_goal 增加 continue_on_error 列：错误后续跑策略。
// NOT NULL DEFAULT false 保证升级后旧 GOAL 行为不变（终止型错误后停止）
export default {
  id: "20260812100000_goal_continue_on_error",
  // 已有列与用户策略值由旧迁移建立，不重复ALTER或重置默认值。
  legacy: ["20260710195446_goal_continue_on_error"],
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`continue_on_error\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration

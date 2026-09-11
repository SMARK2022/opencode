import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911173121_session_context_epoch",
  // 旧Session保持NULL，首次环境准备才采集；不新增表或回写公开metadata。
  up: (tx) => tx.run("ALTER TABLE `session` ADD `context_epoch` text;").pipe(Effect.asVoid),
} satisfies DatabaseMigration.Migration

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import type { SessionSchema } from "./schema"
import { Timestamps } from "../database/schema.sql"

// #364：goal 状态枚举：只有 active 会触发自动续跑；
// paused/blocked/complete 均为停止态，loop 正常退出不续跑。
export const GOAL_STATUSES = ["active", "paused", "complete", "blocked"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

// #364：session_id 做主键 → 一个 session 最多一个 current goal。
// FK cascade delete 确保删除 session 时 goal 自动清理，
// 与 request_usage/todo 表的级联模式一致。
export const SessionGoalTable = sqliteTable(
  "session_goal",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    id: text().notNull(),
    objective: text().notNull(),
    status: text().$type<GoalStatus>().notNull(),
    // null 表示无预算限制（unbounded）；
    // 正数表示 token 上限，达到后状态自动切 budget_limited（未来扩展）。
    token_budget: integer(),
    tokens_used: integer().notNull().default(0),
    time_used_seconds: integer().notNull().default(0),
    // [local-smark] 错误后续跑策略：false=终止型错误后停止（默认），
    // true=允许 GOAL continuation 在 eligible 错误后继续。
    // 默认 false 保证升级后旧 GOAL 行为不变
    continue_on_error: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [index("session_goal_status_idx").on(table.session_id, table.status)],
)

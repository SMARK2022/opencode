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
    // [local-smark] objective 代际：从 1 开始，仅当 trimmed objective 值真正改变时递增。
    // 用于检测旧模型 turn 的 stale 终态写入和隔离旧 provider 请求的 usage 归属
    generation: integer().notNull().default(1),
    // 当前 terminal 状态的理由（complete/blocked 时非空）；active/paused 时为 null
    reason: text(),
    // 待确认的 blocked 理由：模型提出 blocked 但尚未达到两轮阈值时暂存（不公开为 API 字段）
    blocked_reason: text(),
    // 连续 eligible turns 中相同 trimmed reason 的有效 blocked 次数；两轮确认才写 blocked
    blocked_streak: integer().notNull().default(0),
    // 最近一次有效 blocked attempt 的 eligible user MessageID（防同 turn 伪造）
    blocked_last_turn_id: text(),
    // 产生当前 terminal 状态的 eligible user MessageID（model active recovery 校验用）
    terminal_turn_id: text(),
    ...Timestamps,
  },
  (table) => [index("session_goal_status_idx").on(table.session_id, table.status)],
)

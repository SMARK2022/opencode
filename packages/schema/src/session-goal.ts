export * as SessionGoal from "./session-goal"
import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"
import { SessionID } from "./session-id"

// 客户端预检与服务端校验共用静态上限，不能从界面导入持久化服务层。
export const MAX_OBJECTIVE_CHARS = 4000

// [local-smark] goal 状态机：active 为唯一续跑态；paused/complete/blocked 均为停止态，
// 由 tool 或用户显式切换——loop 不自动迁移状态，避免与用户意图冲突。
export const Status = Schema.Literals(["active", "paused", "complete", "blocked"] as const)
export type Status = Schema.Schema.Type<typeof Status>

// #364：持久化会话目标：一个 session 最多一个 current goal。
// tokenBudget 为 null 表示无预算限制（unbounded）。
export const Goal = Schema.Struct({
  sessionID: SessionID,
  id: Schema.String,
  objective: Schema.String,
  status: Status,
  // tokenBudget 三态：缺省=不改、null=unbounded、正数=预算上限
  tokenBudget: optional(Schema.NullOr(Schema.Number)),
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
}).annotate({ identifier: "SessionGoal" })
export interface Goal extends Schema.Schema.Type<typeof Goal> {}

// [local-smark] goal.updated 事件：TUI sidebar 与 footer 依赖此事件实时刷新 goal 面板；
// 事件载荷携带完整 Goal 快照，消费方无需二次查询。
const Updated = define({
  type: "session.goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Goal,
  },
})
// [local-smark] goal.cleared 事件：清除后 sidebar 隐藏 goal 区块；
// 事件仅带 sessionID——goal 数据已物理删除，无需携带快照。
const Cleared = define({
  type: "session.goal.cleared",
  schema: {
    sessionID: SessionID,
  },
})
export const Event = { Updated, Cleared, Definitions: inventory(Updated, Cleared) }

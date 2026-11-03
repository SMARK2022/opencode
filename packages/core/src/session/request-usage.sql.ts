import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import { Timestamps } from "../database/schema.sql"
import type { MessageID } from "../v1/session"
import type { SessionSchema } from "./schema"
import type { Source, Status } from "./request-usage"

// 请求表保存助手快照的汇总，不承担 Session 的完整历史累计。
export const RequestUsageTable = sqliteTable(
  "request_usage",
  {
    // 外键必须在 Drizzle owner 声明，官方生成与升级迁移才能一致地级联删除。
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // V1/V2 都持久化 message 身份，品牌转换留在投影适配边界，不另造请求 ID。
    request_id: text().$type<MessageID>().notNull(),
    // 根身份仅用于因果过滤；独立压缩请求不能据此与普通请求合并主键。
    root_request_id: text().$type<MessageID>().notNull(),
    // 来源是闭合词汇，旧缺失 begin 的计费仍可记录 source 已有的 unknown 值。
    source: text().$type<Source>().notNull(),
    // 状态不能由是否有 tokens 推断，零用量 shell/noReply 也能合法完成。
    status: text().$type<Status>().notNull(),
    // source/agent/model 是来源与当前执行描述，费用仍由独立助手明细提供。
    agent: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    assistant_count: integer().default(0).notNull(),
    step_count: integer().default(0).notNull(),
    tokens_input: integer().default(0).notNull(),
    tokens_output: integer().default(0).notNull(),
    tokens_reasoning: integer().default(0).notNull(),
    tokens_cache_read: integer().default(0).notNull(),
    tokens_cache_write: integer().default(0).notNull(),
    tokens_total: integer().default(0).notNull(),
    cost_micros: integer().default(0).notNull(),
    time_completed: integer(),
    error_message: text(),
    // 分页按创建时间而非更新时间，重试只更新后者而不改变已有行的游标位置。
    ...Timestamps,
  },
  (table) => [
    // 主键同时包含 Session 与用户输入身份，不能把多个工具续轮建成独立请求。
    primaryKey({ columns: [table.session_id, table.request_id] }),
    index("request_usage_session_time_created_idx").on(table.session_id, table.time_created),
    index("request_usage_session_root_idx").on(table.session_id, table.root_request_id),
    index("request_usage_session_status_updated_idx").on(table.session_id, table.status, table.time_updated),
  ],
)

export const RequestUsageAssistantTable = sqliteTable(
  "request_usage_assistant",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().$type<MessageID>().notNull(),
    assistant_message_id: text().$type<MessageID>().notNull(),
    root_request_id: text().$type<MessageID>().notNull(),
    status: text().$type<Status>().notNull(),
    // provider/model/variant 随明细保存，多模型请求不能只读请求行的最后模型。
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    step_count: integer().default(0).notNull(),
    tokens_input: integer().default(0).notNull(),
    tokens_output: integer().default(0).notNull(),
    tokens_reasoning: integer().default(0).notNull(),
    tokens_cache_read: integer().default(0).notNull(),
    tokens_cache_write: integer().default(0).notNull(),
    tokens_total: integer().default(0).notNull(),
    cost_micros: integer().default(0).notNull(),
    time_completed: integer(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.assistant_message_id] }),
    index("request_usage_assistant_session_request_idx").on(table.session_id, table.request_id),
    index("request_usage_assistant_session_root_idx").on(table.session_id, table.root_request_id),
    index("request_usage_assistant_session_status_updated_idx").on(table.session_id, table.status, table.time_updated),
  ],
)

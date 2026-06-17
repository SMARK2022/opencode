import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { MessageID, SessionID } from "./schema"
import { Timestamps } from "@opencode-ai/core/database/schema.sql"

export const RequestUsageTable = sqliteTable(
  "request_usage",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().$type<MessageID>().notNull(),
    root_request_id: text().$type<MessageID>().notNull(),
    source: text().notNull(),
    status: text().notNull(),
    agent: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    assistant_count: integer().notNull().default(0),
    step_count: integer().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    tokens_total: integer().notNull().default(0),
    cost_micros: integer().notNull().default(0),
    time_completed: integer(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
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
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().$type<MessageID>().notNull(),
    assistant_message_id: text().$type<MessageID>().notNull(),
    root_request_id: text().$type<MessageID>().notNull(),
    status: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    step_count: integer().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    tokens_total: integer().notNull().default(0),
    cost_micros: integer().notNull().default(0),
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

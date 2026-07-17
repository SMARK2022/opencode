import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex, blob } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import type { SessionContextEpoch } from "./context-epoch"
import { AgentV2 } from "../agent"
import type { Revert } from "@opencode-ai/schema/revert"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

// #493：StoredInfoData 把可外移字段放宽为 unknown，hot/cold row 都可持久化，但 raw row 不能冒充完整业务 Info。
// 只有 cold-aware decoder 在恢复并通过业务 Schema 后才能跨越该静态边界。
type StoredInfoData<T extends SessionV1.Info = SessionV1.Info> = T extends SessionV1.User
  ? Omit<T, "id" | "sessionID" | "summary"> & {
      summary?: Omit<NonNullable<T["summary"]>, "diffs"> & { diffs: unknown[] }
    }
  : Omit<T, "id" | "sessionID">

// #493：StoredPartData 只放宽 tool output、attachment URL、reasoning text 与 file data URI 四类冷字段。
// discriminator 和其余热结构保持精确，使 search/usage/eligibility 无需把 projection 强转为完整 Part。
type StoredPartData<T extends SessionV1.Part = SessionV1.Part> = T extends SessionV1.ToolPart
  ? Omit<T, "id" | "sessionID" | "messageID" | "state"> & {
      state:
        | Exclude<T["state"], { status: "completed" }>
        | (Omit<Extract<T["state"], { status: "completed" }>, "output" | "attachments"> & {
            output: unknown
            attachments?: Array<
              Omit<NonNullable<Extract<T["state"], { status: "completed" }>["attachments"]>[number], "url"> & {
                url: unknown
              }
            >
          })
    }
  : T extends SessionV1.ReasoningPart
    ? Omit<T, "id" | "sessionID" | "messageID" | "text"> & { text: unknown }
    : T extends SessionV1.FilePart
      ? Omit<T, "id" | "sessionID" | "messageID" | "url"> & { url: unknown }
      : Omit<T, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

// #493：cold_storage 只保存可由 owner row 引用的字段 envelope；它不是第二份 Session 数据库。
// hash 针对未压缩 canonical bytes，因而 codec 或压缩级别变化不会破坏内容去重身份。
// ref_count 是正常事务路径的快速计数，verify 仍会用 message/part 的真实引用反算一致性。
export const ColdStorageTable = sqliteTable(
  "cold_storage",
  {
    hash: text().primaryKey(),
    kind: text().$type<"message" | "part" | "session_message">().notNull(),
    codec: text().$type<"zstd">().notNull(),
    payload: blob({ mode: "buffer" }).notNull(),
    raw_bytes: integer().notNull(),
    compressed_bytes: integer().notNull(),
    ref_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("cold_storage_ref_count_idx").on(table.ref_count)],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<StoredInfoData>(),
    // #493：cold_ref 非空时 data 是类型安全的热 projection；业务读取必须先经过 cold-aware decoder。
    // RESTRICT 防止计数错误时误删仍被 Message 引用的唯一 payload。
    cold_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
  },
  (table) => [
    index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("message_cold_ref_idx").on(table.cold_ref),
  ],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    // #493：Part projection 只清空获准的 output/text/data-URI 字段；tool input、类型和结构元数据常驻主表。
    // 这样 search、usage 与 compact boundary 可在不触碰 blob 的情况下继续工作。
    data: text({ mode: "json" }).notNull().$type<StoredPartData>(),
    cold_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
    index("part_cold_ref_idx").on(table.cold_ref),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
    // Native投影与V1共用payload表，seq、身份和审批所需热字段不外移。
    cold_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
    index("session_message_cold_ref_idx").on(table.cold_ref),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot | SessionContextEpoch.State>(),
  baseline_seq: integer().notNull(),
})

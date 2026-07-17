import { sqliteTable, text, integer, index, primaryKey, real, blob } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "@opencode-ai/core/session-message"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import { Timestamps } from "../storage/schema.sql"

type PartData<T extends MessageV2.Part = MessageV2.Part> = T extends unknown
  ? Omit<T, "id" | "sessionID" | "messageID">
  : never
type InfoData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown ? Omit<T, "id" | "sessionID"> : never
type StoredInfoData<T extends MessageV2.Info = MessageV2.Info> = T extends MessageV2.User
  ? Omit<InfoData<T>, "summary"> & {
      summary?: Omit<NonNullable<InfoData<T>["summary"]>, "diffs"> & { diffs: unknown[] }
    }
  : InfoData<T>
type StoredPartData<T extends MessageV2.Part = MessageV2.Part> = T extends MessageV2.ToolPart
  ? Omit<PartData<T>, "state"> & {
      state:
        | Exclude<PartData<T>["state"], { status: "completed" }>
        | (Omit<Extract<PartData<T>["state"], { status: "completed" }>, "output" | "attachments"> & {
            output: unknown
            attachments?: Array<
              Omit<NonNullable<Extract<PartData<T>["state"], { status: "completed" }>["attachments"]>[number], "url"> & {
                url: unknown
              }
            >
          })
    }
  : T extends MessageV2.ReasoningPart
    ? Omit<PartData<T>, "text"> & { text: unknown }
    : T extends MessageV2.FilePart
      ? Omit<PartData<T>, "url"> & { url: unknown }
      : PartData<T>
type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string; files?: string[] }>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
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

// cold_storage 只保存可由 owner row 引用的字段 envelope；它不是第二份 Session 数据库。
// hash 针对未压缩 canonical bytes，因而 codec 或压缩级别变化不会破坏内容去重身份。
// ref_count 是正常事务路径的快速计数，verify 仍会用 message/part 的真实引用反算一致性。
export const ColdStorageTable = sqliteTable(
  "cold_storage",
  {
    hash: text().primaryKey(),
    kind: text().$type<"message" | "part">().notNull(),
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
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    // StoredInfoData 把可外移字段放宽为 unknown，hot/cold row 都可持久化，但 raw row 不能冒充完整业务 Info。
    // 只有 cold-aware decoder 在恢复并通过业务 Schema 后才能跨越该静态边界。
    data: text({ mode: "json" }).notNull().$type<StoredInfoData>(),
    // cold_ref 非空时 data 是类型安全的热 projection；业务读取必须先经过 cold-aware decoder。
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
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    // StoredPartData 只放宽 tool output、attachment URL、reasoning text 与 file data URI 四类冷字段。
    // discriminator 和其余热结构保持精确，使 search/usage/eligibility 无需把 projection 强转为完整 Part。
    data: text({ mode: "json" }).notNull().$type<StoredPartData>(),
    // Part projection 只清空获准的 output/text/data-URI 字段；tool input、类型和结构元数据常驻主表。
    // 这样 search、usage 与 compact boundary 可在不触碰 blob 的情况下继续工作。
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
      .$type<SessionID>()
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
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    index("session_message_session_idx").on(table.session_id),
    index("session_message_session_type_idx").on(table.session_id, table.type),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})

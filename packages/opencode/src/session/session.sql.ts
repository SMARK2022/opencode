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
type StoredToolState =
  | (Omit<MessageV2.ToolStatePending, "input"> & { input: unknown })
  | (Omit<MessageV2.ToolStateRunning, "input" | "title" | "metadata"> & {
      input: unknown
      title?: unknown
      metadata?: unknown
    })
  | (Omit<MessageV2.ToolStateCompleted, "input" | "output" | "title" | "metadata" | "attachments"> & {
      input: unknown
      output: unknown
      title: unknown
      metadata: unknown
      attachments?: Array<Omit<MessageV2.FilePart, "url"> & { url: unknown }>
    })
  | (Omit<MessageV2.ToolStateError, "input" | "error" | "metadata"> & {
      input: unknown
      error: unknown
      metadata?: unknown
    })
type StoredPartData<T extends MessageV2.Part = MessageV2.Part> = T extends MessageV2.ToolPart
  ? Omit<PartData<T>, "state" | "metadata"> & { state: StoredToolState; metadata?: unknown }
  : T extends MessageV2.ReasoningPart
    ? Omit<PartData<T>, "text" | "metadata"> & { text: unknown; metadata?: unknown }
    : T extends MessageV2.FilePart
      ? Omit<PartData<T>, "url"> & { url: unknown }
      : T extends MessageV2.CompactionPart
        ? Omit<PartData<T>, "recent_user_messages"> & { recent_user_messages?: unknown }
        : T extends MessageV2.StepStartPart
          ? Omit<PartData<T>, "snapshot" | "inputChars" | "inputTokens" | "inputBreakdown"> & {
              snapshot?: unknown
              inputChars?: unknown
              inputTokens?: unknown
              inputBreakdown?: unknown
            }
          : T extends MessageV2.StepFinishPart
            ? Omit<PartData<T>, "snapshot" | "inputChars" | "inputBreakdown"> & {
                snapshot?: unknown
                inputChars?: unknown
                inputBreakdown?: unknown
              }
            : PartData<T>
type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">

// 该联合是持久 schema，不是 CLI report；version/type 共同决定唯一解码形状。
// exact shape 仍由 ColdStorage runtime 校验，Drizzle 静态类型不能替代持久边界验证。
// 所有数字由完整 Part 在 freeze 前计算，不能从清空后的 skeleton 反向猜测。
export type PartColdStats =
  // Tool 只保存两个字符标量，name/status/time 留在 hot projection 避免双份权威。
  // v1 owner 没有该值并走只读 inspect；v2 缺失值属于 corruption 而非兼容输入。
  | { version: 1; type: "tool"; inputChars: number; outputChars: number }
  | {
      version: 1
      type: "step-finish"
      // Step 只保存已分摊的十项 token，不复制 inputBreakdown 或完整请求 body。
      // verify 会从 pack 恢复完整 Part 后重算，能够发现合法外形但数值漂移。
      components: {
        // 字段名与公开 InputComponentTotals 对齐，aggregate 不维护第二套 rename 映射。
        system: number
        instructions: number
        skills: number
        toolSchemas: number
        userMessages: number
        assistantText: number
        reasoning: number
        toolCalls: number
        toolResults: number
        // fork 复制同行标量和 immutable pack 引用，无需解码 payload 重新计算。
        attachments: number
      }
    }

// cold_storage 在 SessionTable 之前声明，使 Session summary 与 Message/Part 共享同一 RESTRICT 外键。
// kind 由读取器校验而不是 SQLite CHECK 约束限制，旧数据库可通过同一迁移直接扩展到 v2 owner union。
export const ColdStorageTable = sqliteTable(
  "cold_storage",
  {
    hash: text().primaryKey(),
    kind: text().$type<"message" | "part" | "message-pack" | "part-pack" | "session-summary">().notNull(),
    codec: text().$type<"zstd">().notNull(),
    payload: blob({ mode: "buffer" }).notNull(),
    raw_bytes: integer().notNull(),
    compressed_bytes: integer().notNull(),
    ref_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("cold_storage_ref_count_idx").on(table.ref_count)],
)

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
    // summary_ref/cursor 是 DB 权威聚合的唯一 cache 状态；外部 session_diff 只可作为兼容镜像。
    // initialized 区分首次兼容导入与失效后重建，避免清理 mirror 后再次导入旧派生结果。
    summary_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
    summary_cursor: text().$type<string>(),
    summary_initialized: integer({ mode: "boolean" }).notNull().default(false),
    // init_dirty 只记录 claim 期间覆盖历史被修改；崩溃后下一次初始化仍会拒绝陈旧 mirror。
    summary_init_dirty: integer({ mode: "boolean" }).notNull().default(false),
    // seed 仅在无 ref 状态暂存不可重建前缀，正常读取会重新压入 payload。
    summary_seed: text({ mode: "json" }).$type<{ cursor: string; diffs: Snapshot.FileDiff[] }>(),
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
    index("session_summary_ref_idx").on(table.summary_ref),
  ],
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
    // v2 key 只在 pack row 内定位该 owner；v1 owner 保持 NULL，读取器按状态选择唯一 decoder。
    cold_key: blob({ mode: "buffer" }),
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
    // Part projection 只清空获准的 Tool payload、reasoning text 与 data-URI；discriminator 和可见身份常驻主表。
    // 这样 search、usage 与 compact boundary 可在不触碰 blob 的情况下继续工作。
    cold_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
    // 与 Message 对称保存 pack entry key；(cold_ref=NULL,cold_key!=NULL) 是损坏状态而非 hot row。
    cold_key: blob({ mode: "buffer" }),
    // cold_stats 是同一 Part owner 的精确只读投影；它只在 v2 Tool/StepFinish 冷态存在。
    // Stats 可据此完成全量聚合而不解码 pack，thaw/update 必须与 ref/key 一起清空。
    // hot row 始终为 NULL，完整 replacement/thaw 不允许保留过期派生统计。
    cold_stats: text({ mode: "json" }).$type<PartColdStats>(),
  },
  // cold_stats 故意不建索引；Stats 已按 Session/Part type 扫描同行小 JSON。
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

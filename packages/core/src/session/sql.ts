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

// #0500：该联合是持久 schema，不是 CLI report；version/type 共同决定唯一解码形状。
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

// Native每个content槽位只保留字符标量；身份、状态和用量仍来自原消息及精确账本。
export type SessionMessageColdStats = {
  version: 1
  tools: Record<string, { inputChars: number; outputChars: number }>
}

// #0500：cold_storage 在 SessionTable 之前声明，使 Session summary 与 Message/Part 共享同一 RESTRICT 外键。
// kind 由读取器校验而不是 SQLite CHECK 约束限制，旧数据库可通过同一迁移直接扩展到 v2 owner union。
export const ColdStorageTable = sqliteTable(
  "cold_storage",
  {
    hash: text().primaryKey(),
    kind: text().$type<"message" | "part" | "session_message" | "message-pack" | "part-pack" | "session-message-pack" | "session-summary">().notNull(),
    codec: text().$type<"zstd">().notNull(),
    payload: blob({ mode: "buffer" }).notNull(),
    raw_bytes: integer().notNull(),
    compressed_bytes: integer().notNull(),
    ref_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("cold_storage_ref_count_idx").on(table.ref_count)],
)

type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

// #493：StoredInfoData 把可外移字段放宽为 unknown，hot/cold row 都可持久化，但 raw row 不能冒充完整业务 Info。
// 只有 cold-aware decoder 在恢复并通过业务 Schema 后才能跨越该静态边界。
type StoredInfoData<T extends SessionV1.Info = SessionV1.Info> = T extends SessionV1.User
  ? Omit<T, "id" | "sessionID" | "summary"> & {
      summary?: Omit<NonNullable<T["summary"]>, "diffs"> & { diffs: unknown[] }
    }
  : Omit<T, "id" | "sessionID">

// #0500：v2 放宽面扩大——pending 之后的 tool state、metadata/title 与 step/compaction 冷字段都可外移。
type StoredToolState =
  | (Omit<SessionV1.ToolStatePending, "input"> & { input: unknown })
  | (Omit<SessionV1.ToolStateRunning, "input" | "title" | "metadata"> & {
      input: unknown
      title?: unknown
      metadata?: unknown
    })
  | (Omit<SessionV1.ToolStateCompleted, "input" | "output" | "title" | "metadata" | "attachments"> & {
      input: unknown
      output: unknown
      title: unknown
      metadata: unknown
      attachments?: Array<Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID" | "url"> & { url: unknown }>
    })
  | (Omit<SessionV1.ToolStateError, "input" | "error" | "metadata"> & {
      input: unknown
      error: unknown
      metadata?: unknown
    })

// #0500：StoredPartData 只保留 discriminator 与可见身份；tool/step/compaction 的可外移冷字段全部放宽。
// discriminator 和其余热结构保持精确，使 search/usage/eligibility 无需把 projection 强转为完整 Part。
type StoredPartData<T extends SessionV1.Part = SessionV1.Part> = T extends SessionV1.ToolPart
  ? Omit<T, "id" | "sessionID" | "messageID" | "state" | "metadata"> & { state: StoredToolState; metadata?: unknown }
  : T extends SessionV1.ReasoningPart
    ? Omit<T, "id" | "sessionID" | "messageID" | "text" | "metadata"> & { text: unknown; metadata?: unknown }
    : T extends SessionV1.FilePart
      ? Omit<T, "id" | "sessionID" | "messageID" | "url"> & { url: unknown }
      : T extends SessionV1.CompactionPart
        ? Omit<T, "id" | "sessionID" | "messageID" | "recent_user_messages"> & { recent_user_messages?: unknown }
        : T extends SessionV1.StepStartPart
          ? Omit<T, "id" | "sessionID" | "messageID" | "snapshot" | "inputChars" | "inputTokens" | "inputBreakdown"> & {
              snapshot?: unknown
              inputChars?: unknown
              inputTokens?: unknown
              inputBreakdown?: unknown
            }
          : T extends SessionV1.StepFinishPart
            ? Omit<T, "id" | "sessionID" | "messageID" | "snapshot" | "inputChars" | "inputBreakdown"> & {
                snapshot?: unknown
                inputChars?: unknown
                inputBreakdown?: unknown
              }
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
    // #0500：summary_ref/cursor 是 DB 权威聚合的唯一 cache 状态；外部 session_diff 只可作为兼容镜像。
    // initialized 区分首次兼容导入与失效后重建，避免清理 mirror 后再次导入旧派生结果。
    summary_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
    summary_cursor: text().$type<string>(),
    summary_initialized: integer({ mode: "boolean" }).notNull().default(false),
    // #0500：init_dirty 只记录 claim 期间覆盖历史被修改；崩溃后下一次初始化仍会拒绝陈旧 mirror。
    summary_init_dirty: integer({ mode: "boolean" }).notNull().default(false),
    // #0500：seed 仅在无 ref 状态暂存不可重建前缀，正常读取会重新压入 payload。
    summary_seed: text({ mode: "json" }).$type<{ cursor: string; diffs: Snapshot.LegacyFileDiff[] }>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    // V1私有epoch不进入公开Session映射；V2继续使用既有session_context_epoch表。
    context_epoch: text({ mode: "json" }).$type<unknown>(),
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
    index("session_summary_ref_idx").on(table.summary_ref),
  ],
)

// #493/#0500：cold_storage 的完整语义见上方表定义；hash 针对未压缩 canonical bytes，
// codec/压缩级别变化不会破坏内容去重身份，ref_count 由 verify 反算真实引用。


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
    // #0500：v2 key 只在 pack row 内定位该 owner；v1 owner 保持 NULL，读取器按状态选择唯一 decoder。
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
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    // #493：Part projection 只清空获准的 Tool payload、reasoning text 与 data-URI；discriminator 和可见身份常驻主表。
    // 这样 search、usage 与 compact boundary 可在不触碰 blob 的情况下继续工作。
    data: text({ mode: "json" }).notNull().$type<StoredPartData>(),
    cold_ref: text().references(() => ColdStorageTable.hash, { onDelete: "restrict" }),
    // #0500：与 Message 对称保存 pack entry key；(cold_ref=NULL,cold_key!=NULL) 是损坏状态而非 hot row。
    cold_key: blob({ mode: "buffer" }),
    // #0500：cold_stats 是同一 Part owner 的精确只读投影；它只在 v2 Tool/StepFinish 冷态存在。
    // Stats 可据此完成全量聚合而不解码 pack，thaw/update 必须与 ref/key 一起清空。
    // hot row 始终为 NULL，完整 replacement/thaw 不允许保留过期派生统计。
    cold_stats: text({ mode: "json" }).$type<PartColdStats>(),
  },
  // #0500：cold_stats 故意不建索引；Stats 已按 Session/Part type 扫描同行小 JSON。
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
    // Native与旧消息共用pack协议，统计只读取本owner的精确标量而不展开消息。
    cold_key: blob({ mode: "buffer" }),
    cold_stats: text({ mode: "json" }).$type<SessionMessageColdStats>(),
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

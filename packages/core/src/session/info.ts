import { DateTime, Schema } from "effect"
import { getTableColumns, sql } from "drizzle-orm"
import { Session } from "@opencode-ai/schema/session"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionMessage } from "./message"
import { Snapshot } from "../snapshot"

// HTTP、列表和事件共用现有 Session SELECT 的请求投影，避免各视图重复扫描历史或另建账本。
export const selection = {
  ...getTableColumns(SessionTable),
  request: sql<string | null>`(
    -- 修订、移除和 revert 直接反映存储行，无需额外 replay 去重标记。
    -- 单表 SELECT 会剥离 Column 限定名；关联外层必须固定使用 "session"."id"。
    WITH v1_request AS (
      -- V1 身份取完整持久用户消息，窗口淘汰不会触发新请求零值。
      SELECT id, time_created, NULL AS promoted_seq, 'v1' AS kind
      FROM message WHERE session_id = "session"."id" AND json_extract(data, '$.role') = 'user'
      ORDER BY time_created DESC, id DESC LIMIT 1
    ), native_request AS (
      -- native 身份取持久化 admission，不依赖显示窗口。
      -- 两种序号同属 Session durable 序列；旧 queue 后提升要覆盖较新 steer 的 admission。
      SELECT id, time_created, promoted_seq, 'native' AS kind, coalesce(promoted_seq, admitted_seq) AS position
      FROM session_input WHERE session_id = "session"."id"
      ORDER BY coalesce(promoted_seq, admitted_seq) DESC LIMIT 1
    ), current_request AS (
      -- V1 首次用户写入与 native admission/promotion 共用 Session event 序列，修订不重新接管身份。
      -- 迁移清过 event/input/native message 而保留 V1 message；无事件的旧用户属于序列开始前。
      SELECT * FROM (
        SELECT v.*, coalesce(min(e.seq), -1) AS position
        FROM v1_request v LEFT JOIN event e
          ON e.aggregate_id = "session"."id" AND e.type = 'message.updated.1'
          AND json_extract(e.data, '$.info.id') = v.id AND json_extract(e.data, '$.info.role') = 'user'
        GROUP BY v.id
        UNION ALL SELECT * FROM native_request)
      -- admission 或 promotion 决定最新身份；新 admission 等待时不能借用旧轮次。
      ORDER BY position DESC, time_created DESC, id DESC LIMIT 1
    ), assistants AS (
      -- V1 明确 parentID 归属，不能只按最后助手或时间范围猜测请求。
      SELECT m.id, m.data, m.time_created AS position, 'v1' AS kind
      FROM message m JOIN current_request r ON r.kind = 'v1'
      WHERE m.session_id = "session"."id" AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.parentID') = r.id
      UNION ALL
      SELECT m.id, m.data, m.seq AS position, 'native' AS kind
      FROM session_message m JOIN current_request r ON r.kind = 'native'
      -- native 用 promoted 序列划分每个请求区间，不伪造旧协议 parentID。
      WHERE m.session_id = "session"."id" AND m.type = 'assistant'
        AND r.promoted_seq IS NOT NULL AND m.seq > r.promoted_seq
        AND NOT EXISTS (
          SELECT 1 FROM session_input i WHERE i.session_id = m.session_id
            AND i.promoted_seq > r.promoted_seq AND i.promoted_seq < m.seq
        )
    ), settled AS (
      -- V1 所有 step-finish 与 native 每步助手结算互斥，避免重复累计。
      SELECT p.data FROM part p JOIN assistants a ON a.kind = 'v1' AND a.id = p.message_id
      WHERE p.session_id = "session"."id" AND json_extract(p.data, '$.type') = 'step-finish'
      UNION ALL
      SELECT data FROM assistants WHERE kind = 'native'
    ), last_assistant AS (
      -- 最后助手与模型随请求读出，用户被窗口淘汰后仍能锁定同一请求尾部。
      SELECT * FROM assistants ORDER BY position DESC, id DESC LIMIT 1
    )
    SELECT json_object(
      'messageID', r.id,
      'input', coalesce((SELECT sum(coalesce(json_extract(data, '$.tokens.input'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.read'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.write'), 0)) FROM settled), 0),
      'output', coalesce((SELECT sum(coalesce(json_extract(data, '$.tokens.output'), 0)
        + coalesce(json_extract(data, '$.tokens.reasoning'), 0)) FROM settled), 0),
      -- 请求费用忠实取助手 cost，不拿全局 cost 或 token 价格反推替代。
      'cost', coalesce((SELECT sum(json_extract(data, '$.cost')) FROM assistants), 0),
      'assistantID', (SELECT id FROM last_assistant),
      'model', json((SELECT json_object(
        'providerID', coalesce(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')),
        'modelID', coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.id'))
      ) FROM last_assistant))
    ) FROM current_request r
  )`.mapWith((value) => {
    // SQL 没有请求时返回 null；空请求有身份且所有累计为零，两者不能混淆。
    if (value === null) return undefined
    const parsed = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value)
    // SQLite json_object 的缺省键是 null，转成契约的省略属性再校验。
    const fields = Schema.decodeUnknownSync(Schema.Struct({
      messageID: Schema.String, input: Schema.Finite, output: Schema.Finite, cost: Schema.Finite,
      assistantID: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
    }))(parsed)
    return Session.RequestUsage.make({
      ...fields,
      assistantID: fields.assistantID ?? undefined,
      model: fields.model ?? undefined,
    })
  }),
}

export function fromRow(row: typeof SessionTable.$inferSelect & { request?: Session.RequestUsage }): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: ProjectV2.ID.make(row.project_id),
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    agent: row.agent ? AgentV2.ID.make(row.agent) : undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: ModelV2.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: row.cost,
    request: row.request ?? undefined,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    revert: row.revert ? { ...row.revert, messageID: SessionMessage.ID.make(row.revert.messageID) } : undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}

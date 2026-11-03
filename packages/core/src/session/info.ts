import { DateTime, Effect, Schema } from "effect"
import { eq, getTableColumns, sql } from "drizzle-orm"
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
import type { Database } from "../database/database"

// HTTP、列表和事件共用现有 Session SELECT 的请求投影，避免各视图重复扫描历史或另建账本。
export const selection = (sessionID: SessionSchema.ID) => ({
  ...getTableColumns(SessionTable),
  request: sql<string | null>`(
    -- 修订、移除和 revert 直接反映存储行，无需额外 replay 去重标记。
    -- 绑定身份让CTE在一次请求投影内复用，避免按每个标量字段反复展开相关历史查询。
    WITH v1_request AS (
      -- 优先最新助手的父用户，跳过无回复输入；首次输入仍有独立零值投影。
      -- 按父ID点查后再取最新用户，避免为每个用户排序重查同一助手；保留缺失父行时的原投影。
      SELECT m.id, m.time_created, NULL AS promoted_seq, 'v1' AS kind
      FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user'
      AND m.id = coalesce((
        SELECT u.id FROM message u
        WHERE u.session_id = ${sessionID} AND json_extract(u.data, '$.role') = 'user'
          AND u.id = (
            SELECT json_extract(a.data, '$.parentID') FROM message a
            WHERE a.session_id = ${sessionID} AND json_extract(a.data, '$.role') = 'assistant'
            ORDER BY a.time_created DESC, a.id DESC LIMIT 1
          )
      ), (
        SELECT u.id FROM message u
        WHERE u.session_id = ${sessionID} AND json_extract(u.data, '$.role') = 'user'
        ORDER BY u.time_created DESC, u.id DESC LIMIT 1
      ))
    ), native_request AS (
      -- native 身份取持久化 admission，不依赖显示窗口。
      -- 两种序号同属 Session durable 序列；旧 queue 后提升要覆盖较新 steer 的 admission。
      SELECT id, time_created, promoted_seq, 'native' AS kind, coalesce(promoted_seq, admitted_seq) AS position
      FROM session_input WHERE session_id = ${sessionID}
      -- 未提升的queue/steer不能接管当前轮；没有提升记录时仍显示首次admission。
      ORDER BY (promoted_seq IS NOT NULL) DESC, coalesce(promoted_seq, admitted_seq) DESC LIMIT 1
    ), active_compaction AS (
      -- 复用压缩独立身份，仅在其真实生命周期内显示prepared估算，不冒用用户admission。
      SELECT json_extract(e.data, '$.messageID') AS id, json_extract(e.data, '$.timestamp') AS time_created,
        NULL AS promoted_seq, 'compaction' AS kind, e.seq AS position
      FROM event e WHERE e.aggregate_id = ${sessionID} AND e.type = 'session.next.compaction.started.1'
        AND NOT EXISTS (
          SELECT 1 FROM event terminal WHERE terminal.aggregate_id = e.aggregate_id
            AND terminal.seq > e.seq AND json_extract(terminal.data, '$.messageID') = json_extract(e.data, '$.messageID')
            AND terminal.type IN ('session.next.compaction.ended.1', 'session.next.compaction.failed.1'))
      ORDER BY e.seq DESC LIMIT 1
    ), current_request AS (
      -- V1 首次用户写入与 native admission/promotion 共用 Session event 序列，修订不重新接管身份。
      -- 迁移清过 event/input/native message 而保留 V1 message；无事件的旧用户属于序列开始前。
      SELECT * FROM (
        SELECT v.*, coalesce(min(e.seq), -1) AS position
        FROM v1_request v LEFT JOIN event e
          ON e.aggregate_id = ${sessionID} AND e.type = 'message.updated.1'
          AND json_extract(e.data, '$.info.id') = v.id AND json_extract(e.data, '$.info.role') = 'user'
        GROUP BY v.id
        UNION ALL SELECT * FROM native_request UNION ALL SELECT * FROM active_compaction) candidates
      -- 混合入口同样优先已开始的请求；无回复V1输入不能压过正在执行的native轮次。
      -- 活跃压缩拥有真实独立估算，继续以其durable位置参与最新执行请求选择。
      ORDER BY CASE WHEN kind = 'compaction' THEN 1 WHEN kind = 'native' THEN promoted_seq IS NOT NULL ELSE EXISTS (
        SELECT 1 FROM message a WHERE a.session_id = ${sessionID}
          AND json_extract(a.data, '$.role') = 'assistant'
          AND json_extract(a.data, '$.parentID') = candidates.id
      ) END DESC, position DESC, time_created DESC, id DESC LIMIT 1
    ), assistants AS (
      -- V1 明确 parentID 归属，不能只按最后助手或时间范围猜测请求。
      SELECT m.id, m.data, m.time_created AS position, 'v1' AS kind
      FROM message m JOIN current_request r ON r.kind = 'v1'
      WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.parentID') = r.id
      UNION ALL
      SELECT m.id, m.data, m.seq AS position, 'native' AS kind
      FROM session_message m JOIN current_request r ON r.kind = 'native'
      -- native 用 promoted 序列划分每个请求区间，不伪造旧协议 parentID。
      WHERE m.session_id = ${sessionID} AND m.type = 'assistant'
        AND r.promoted_seq IS NOT NULL AND m.seq > r.promoted_seq
        AND NOT EXISTS (
          SELECT 1 FROM session_input i WHERE i.session_id = m.session_id
            AND i.promoted_seq > r.promoted_seq AND i.promoted_seq < m.seq
        )
    ), settled AS (
      -- V1 所有 step-finish 与 native 每步助手结算互斥，避免重复累计。
      SELECT p.id, p.data, a.position, a.id AS assistant_id FROM part p JOIN assistants a ON a.kind = 'v1' AND a.id = p.message_id
      WHERE p.session_id = ${sessionID} AND json_extract(p.data, '$.type') = 'step-finish'
      UNION ALL
      SELECT id, data, position, id FROM assistants
      WHERE kind = 'native' AND json_extract(data, '$.tokens') IS NOT NULL
    ), last_usage AS (
      -- 请求已按 parentID 或 promotion 划界；只取末次确认上下文，未结算 native 行不能覆盖它。
      SELECT data FROM settled
      ORDER BY position DESC, assistant_id DESC, id DESC LIMIT 1
    ), last_assistant AS (
      -- 最后助手与模型随请求读出，用户被窗口淘汰后仍能锁定同一请求尾部。
      SELECT * FROM assistants ORDER BY position DESC, id DESC LIMIT 1
    ), native_estimate AS (
      -- 复用 durable event 保存首包前估算；请求身份仍属于原 current_request。
      SELECT e.seq, e.data FROM event e JOIN current_request r ON r.kind IN ('native', 'compaction')
      WHERE e.aggregate_id = ${sessionID} AND e.type = 'session.next.request.estimated.1'
        AND json_extract(e.data, '$.messageID') = r.id
        AND NOT EXISTS (SELECT 1 FROM event terminal WHERE terminal.aggregate_id = e.aggregate_id
          AND terminal.seq > e.seq AND json_extract(terminal.data, '$.messageID') = r.id
          AND terminal.type IN ('session.next.prompt.completed.1', 'session.next.prompt.failed.1'))
      ORDER BY e.seq DESC LIMIT 1
    ), last_step AS (
      -- V1 parts 按 ID 排序，最后 step-finish 不等于最后一个任意 part。
      SELECT p.id, p.data FROM part p JOIN last_assistant a ON a.kind = 'v1' AND a.id = p.message_id
      WHERE p.session_id = ${sessionID} AND json_extract(p.data, '$.type') = 'step-finish'
      ORDER BY p.id DESC LIMIT 1
    ), step AS (
      -- native 每个助手就是一轮；V1 未完成且还有尾部时不能沿用旧 step 确认值。
      SELECT CASE WHEN a.kind = 'native' AND coalesce((SELECT seq FROM native_estimate), -1) > a.position THEN '{}'
        -- 估算已替换旧 step，但既有 settled 请求累计保持原值。
        WHEN a.kind = 'native' THEN a.data
        WHEN json_extract(a.data, '$.time.completed') IS NULL AND (
          (json_extract(a.data, '$.inputEstimate.confirmed') = 0
            AND coalesce((SELECT id FROM last_step), '') <= coalesce(json_extract(a.data, '$.inputEstimate.afterPartID'), ''))
          OR EXISTS (
          SELECT 1 FROM part p WHERE p.message_id = a.id AND p.session_id = ${sessionID}
            AND p.id > coalesce((SELECT id FROM last_step), '')
        )) THEN '{}' ELSE coalesce((SELECT data FROM last_step), '{}') END AS data
      FROM last_assistant a
    )
    SELECT json_object(
      'messageID', r.id,
      'input', coalesce((SELECT sum(coalesce(json_extract(data, '$.tokens.input'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.read'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.write'), 0)) FROM settled), 0),
      'output', coalesce((SELECT sum(coalesce(json_extract(data, '$.tokens.output'), 0)
        + coalesce(json_extract(data, '$.tokens.reasoning'), 0)) FROM settled), 0),
      -- 费用仍取完整请求的助手 cost，当前 step 的展示变化不缩窄费用范围或反推价格。
      'cost', coalesce((SELECT sum(json_extract(data, '$.cost')) FROM assistants), 0),
      'assistantID', (SELECT id FROM last_assistant
        WHERE kind = 'v1' OR position >= coalesce((SELECT seq FROM native_estimate), -1)),
      -- 首包前不冒用上一助手，确认后仍返回真实的最后助手身份。
      'stepInput', coalesce((SELECT coalesce(json_extract(data, '$.tokens.input'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.read'), 0)
        + coalesce(json_extract(data, '$.tokens.cache.write'), 0) FROM step), 0),
      'stepOutput', coalesce((SELECT coalesce(json_extract(data, '$.tokens.output'), 0)
        + coalesce(json_extract(data, '$.tokens.reasoning'), 0) FROM step), 0),
      -- 未确认条件复用当前 step 投影；完成或零确认后不得补入上一轮上下文。
      'pendingInput', (SELECT coalesce(json_extract(u.data, '$.tokens.input'), 0)
        + coalesce(json_extract(u.data, '$.tokens.cache.read'), 0)
        + coalesce(json_extract(u.data, '$.tokens.cache.write'), 0)
        + coalesce(json_extract(u.data, '$.tokens.output'), 0) + coalesce(json_extract(u.data, '$.tokens.reasoning'), 0)
        FROM last_usage u, last_assistant a, step s
        WHERE json_extract(a.data, '$.time.completed') IS NULL
          AND json_extract(s.data, '$.tokens') IS NULL),
      -- 只投影当前助手未确认的请求体估算，不从累计或旧用户恢复 bootstrap。
      -- native tokens 存在（包括全零）或 V1 新 step-finish 到达时立即停止估算。
      'estimatedInput', coalesce((SELECT json_extract(e.data, '$.inputEstimate.input') FROM native_estimate e
        WHERE e.seq > coalesce((SELECT position FROM last_assistant), -1)),
        (SELECT json_extract(a.data, '$.inputEstimate.input') FROM last_assistant a
        WHERE json_extract(a.data, '$.time.completed') IS NULL
          AND json_extract(a.data, '$.inputEstimate.confirmed') = 0
          AND (a.kind = 'v1' OR json_extract(a.data, '$.tokens') IS NULL)
          AND NOT EXISTS (SELECT 1 FROM last_step p WHERE a.kind = 'v1'
            AND p.id > coalesce(json_extract(a.data, '$.inputEstimate.afterPartID'), '')))),
      -- 准备元数据跟随相同请求/助手边界；确认后保留细分，不能借用更旧请求的历史样本。
      'inputEstimate', json(coalesce((SELECT json_extract(e.data, '$.inputEstimate') FROM native_estimate e
        WHERE e.seq > coalesce((SELECT position FROM last_assistant), -1)),
        (SELECT json_extract(data, '$.inputEstimate') FROM last_assistant))),
      -- 没有助手时两项为零且 assistantID 缺省，与已有未结算助手区分。
      'model', json(coalesce((SELECT json_object(
        'providerID', json_extract(data, '$.model.providerID'), 'modelID', json_extract(data, '$.model.id'),
        'contextLimit', coalesce(json_extract(data, '$.inputEstimate.contextLimit'), 0)) FROM native_estimate
        WHERE seq > coalesce((SELECT position FROM last_assistant), -1)), (SELECT json_object(
        'providerID', coalesce(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')),
        'modelID', coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')),
        'contextLimit', CASE WHEN kind = 'native' THEN coalesce(json_extract(data, '$.inputEstimate.contextLimit'), 0)
          ELSE json_extract(data, '$.inputEstimate.contextLimit') END
      ) FROM last_assistant)))
    ) FROM current_request r
  )`.mapWith((value) => {
    // SQL 没有请求时返回 null；空请求有身份且所有累计为零，两者不能混淆。
    if (value === null) return undefined
    const parsed = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value)
    // SQLite json_object 的缺省键是 null，转成契约的省略属性再校验。
    const fields = Schema.decodeUnknownSync(
      Schema.Struct({
        messageID: Schema.String,
        input: Schema.Finite,
        output: Schema.Finite,
        cost: Schema.Finite,
        assistantID: Schema.NullOr(Schema.String),
        stepInput: Schema.Finite,
        stepOutput: Schema.Finite,
        pendingInput: Schema.NullOr(Schema.Finite),
        estimatedInput: Schema.NullOr(Schema.Finite),
        inputEstimate: Schema.NullOr(SessionMessage.InputEstimate),
        model: Schema.NullOr(
          Schema.Struct({
            providerID: Schema.String,
            modelID: Schema.String,
            contextLimit: Schema.NullOr(Schema.Finite),
          }),
        ),
      }),
    )(parsed)
    return Session.RequestUsage.make({
      ...fields,
      assistantID: fields.assistantID ?? undefined,
      pendingInput: fields.pendingInput ?? undefined,
      estimatedInput: fields.estimatedInput ?? undefined,
      inputEstimate: fields.inputEstimate ?? undefined,
      model: fields.model ? { ...fields.model, contextLimit: fields.model.contextLimit ?? undefined } : undefined,
    })
  }),
})

// 调用者在同一读事务内先固定页面，再复用同一参数化投影，不丢请求字段或解冻历史。
export function withRequests(db: Database.Interface["db"], rows: (typeof SessionTable.$inferSelect)[]) {
  return Effect.forEach(rows, (row) =>
    db
      .select({ request: selection(row.id).request })
      .from(SessionTable)
      .where(eq(SessionTable.id, row.id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((projection) => ({ ...row, request: projection?.request })),
      ),
  )
}

export function fromRow(
  row: typeof SessionTable.$inferSelect & { request?: Session.RequestUsage },
): SessionSchema.Info {
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

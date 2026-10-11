import { SessionID, MessageID, PartID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"

// [local-smark] 测试与 prompt.ts 通过 MessageV2 命名空间引用 WithParts/Part；
// 显式 re-export 让命名空间自导出携带这两个类型（SessionV1 为唯一来源）
export type { WithParts, Part, User, Assistant, ToolPart } from "@opencode-ai/core/v1/session"
import { SessionMemento } from "@opencode-ai/core/session/compaction-memento"
import { TokenEstimate } from "@/token/estimate"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@opencode-ai/core/v1/session"

import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm"
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
// #0500：boundary-first 读取的权威——compaction 边界决定 hydrate 范围，message-v2 不得自行扫描 marker。
import { CompactionBoundary } from "@opencode-ai/core/session/compaction-boundary"
import { PartView } from "@opencode-ai/core/session/part-view"
import { encodeProofKey } from "@opencode-ai/core/session/history-proof"
import { Option } from "effect"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import { ensureTaskResumeVisible, formatCompactionClearedNotice, formatExecutionNotice, truncateForCompaction } from "@/util/output-notice"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

// #191：仅限 transport 层瞬时故障；provider/status 错误和非法 payload 必须走各自非重试分支
// #191：码集合覆盖 Node/undici/TLS 常见瞬时故障；ECONNRESET 由既有 switch case 处理故不在此列
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ConnectionClosed",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "SSE_READ_TIMEOUT",
  // #191：SSE_READ_TIMEOUT 是自研超时码，与其他 Node/undici 网络码同属 transport 层重试类
])
  // #191：ECONNRESET 被排除在集合外，由 fromError 顶层 case 按嵌套深度单独判定，避免双重分类


export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, headChars?: number, tailChars?: number) {
  // 非压缩调用未提供完整双向预算时不截断；首尾与省略标记由两代共享owner维护。
  if (headChars === undefined || tailChars === undefined) return text
  return truncateForCompaction(text, headChars, tailChars)
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  // 进度快照与 PartDelta 同为纯广播事件，不参与持久化。
  PartProgress: SessionV1.Event.PartProgress,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

// #557：time.created 来自持久 row，不借助进程内事件到达顺序；ID 只解决同毫秒冲突。
// 同毫秒按 UTF-8 字节序与 SQLite BINARY 对齐，避免内存与 SQL 对同一边界分歧。
export function compareChronology(
  a: { id: MessageID; time: { created: number } },
  b: { id: MessageID; time: { created: number } },
) {
  return a.time.created - b.time.created || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
}

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

// user diff 与 assistant path 必须先恢复，再跨越 storage 到完整 Info 的类型边界。
// 这里不能重跑完整 Info Schema：既有数据库允许 fractional time，新增冷存储不得收紧无关历史读取合同。
type StoredInfo = (typeof MessageTable.$inferSelect)["data"] & Pick<Info, "id" | "sessionID">

function isInfo(value: StoredInfo): value is Info {
  return value.role === "assistant"
    ? value.path !== undefined
    : value.summary === undefined || Array.isArray(value.summary.diffs)
}

// HotInfo 只用于定位，类型中排除 assistant 诊断字段及 user diff 正文。
// 返回完整 Message 的 consumer 仍必须在匹配后经过 hydrate，不能把该类型扩展成业务读取捷径。
export type HotInfo =
  | Omit<Assistant, "path">
  | (Omit<User, "summary"> & { summary?: Omit<NonNullable<User["summary"]>, "diffs"> })

// #0500：Goal chronology 只依赖 hot 定位字段——Tool output、Reasoning、附件与 summary.diffs 不进入 JS。
export type ChronologyPart = {
  type: string
  synthetic?: true
  metadata?: { goal_continuation?: true }
}

export type ChronologyMessage = {
  info: HotInfo
  parts: ChronologyPart[]
}

// #493：StoredPartData 只把四类冷字符串放宽为 unknown；decoder 只验证差异字段即可恢复业务类型。
// 不重跑整个 Part Schema，既保留历史宽容性，也避免普通热分页重复校验大对象。
type StoredPart = (typeof PartTable.$inferSelect)["data"] & Pick<Part, "id" | "sessionID" | "messageID">

function isPart(value: StoredPart): value is Part {
  if (value.type === "tool" && value.state.status === "completed") {
    return (
      typeof value.state.output === "string" &&
      (value.state.attachments?.every((attachment) => typeof attachment.url === "string") ?? true)
    )
  }
  if (value.type === "reasoning") return typeof value.text === "string"
  if (value.type === "file") return typeof value.url === "string"
  return true
}

const info = (db: ColdStorage.TxOrDb, row: typeof MessageTable.$inferSelect) => {
  // 单条读取与分页采用相同 inspect 合同，避免详情入口偷偷改变冷态。
  const restored = ColdStorage.inspectMessageRows(db, [row])[0]
  if (!restored) throw new Error(`Message row disappeared during thaw: ${row.id}`)
  const value = {
    ...restored.data,
    id: restored.id,
    sessionID: restored.session_id,
  }
  if (!isInfo(value)) throw new Error(`Message row failed schema validation after thaw: ${row.id}`)
  return value
}

const infoFromRestored = (row: typeof MessageTable.$inferSelect) => {
  const value = {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }
  if (!isInfo(value)) throw new Error(`Message row failed schema validation after thaw: ${row.id}`)
  return value
}

// #493：单 Part decoder 是所有 direct read 的共同 cold-aware seam；调用方不能直接 spread raw projection row。
const part = (db: ColdStorage.TxOrDb, row: typeof PartTable.$inferSelect) => {
  // 普通业务读取只恢复返回值；执行窗口和显式 expand 才负责持久预热。
  const restored = ColdStorage.inspectPartRows(db, [row])[0]
  if (!restored) throw new Error(`Part row disappeared during thaw: ${row.id}`)
  const value = {
    ...restored.data,
    id: restored.id,
    sessionID: restored.session_id,
    messageID: restored.message_id,
  }
  if (!isPart(value)) throw new Error(`Part row failed schema validation after thaw: ${row.id}`)
  return value
}

const partFromRestored = (row: typeof PartTable.$inferSelect) => {
  const value = {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }
  if (!isPart(value)) throw new Error(`Part row failed schema validation after thaw: ${row.id}`)
  return value
}

function hotInfo(row: typeof MessageTable.$inferSelect): HotInfo {
  // #0500：HotInfo 不访问 payload，批量 chronology 可线性扫描大型 Session 而不持久 thaw。
  // cold_ref/key 不暴露给 consumer，前端和 session logic 不判断 owner storage version。
  // #493：user summary 只保留热字段（title/body），diffs 不进入定位扫描类型面。
  if (row.data.role === "assistant") {
    // 生命周期字段保热，谓词查找无需为 path 或输入明细展开整页内容。
    return { ...row.data, id: row.id, sessionID: row.session_id }
  }
  const summary = row.data.summary
    ? {
        ...(row.data.summary.title !== undefined ? { title: row.data.summary.title } : {}),
        ...(row.data.summary.body !== undefined ? { body: row.data.summary.body } : {}),
      }
    : undefined
  return {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    summary,
  }
}

function viewerInfo(row: typeof MessageTable.$inferSelect): Info {
  const value = hotInfo(row)
  // assistant 已由 hydrate 按包恢复，viewer 不另造一个缺字段的公开对象。
  if (value.role === "assistant") return infoFromRestored(row)
  // TUI 没有 user summary 消费者；省略整个 optional 字段才能保持合法 Info，
  // 同时阻止 cold diffs 在普通查看路径被解压、持久预热并进入 wire。
  const { summary: _, ...info } = value
  return info
}

// #0500：Goal chronology 只读取 Message hot info 与三个 Part locator 字段；Tool output、Reasoning、附件和 summary.diffs
// 不会进入 JS，也不会触发持久 thaw。排序继续使用 persisted time，再以 MessageID 处理同毫秒 tie。
// #557：Goal Tool 只消费 current/previous；technical user 不应迫使普通 Provider step 扫描整段历史。
// 只查 user 行（goalTurnID 空、非 hidden），16/页反向分页，跳过 compaction-only 技术 user，凑 2 即停。
export const goalChronology = Effect.fn("MessageV2.goalChronology")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const result: ChronologyMessage[] = []
  let before: Cursor | undefined
  const size = 16
  while (result.length < 2) {
    // #557：用户行限定 + hidden 排除在 SQL 层完成，Goal classifier 不读 tombstone 旧资格。
    const base = and(
      eq(MessageTable.session_id, sessionID),
      sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
      sql`json_extract(${MessageTable.data}, '$.goalTurnID') is null`,
      sql`json_type(${MessageTable.data}, '$.hidden') is null`,
    )
    const rows = yield* db
      .select()
      .from(MessageTable)
      .where(before ? and(base, older(before)) : base)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(size)
      .all()
      .pipe(Effect.orDie)
    if (!rows.length) break

    const parts = yield* db
      .select({
        messageID: PartTable.message_id,
        type: sql<string>`json_extract(${PartTable.data}, '$.type')`,
        synthetic: sql<number | null>`json_extract(${PartTable.data}, '$.synthetic')`,
        goalContinuation: sql<number | null>`json_extract(${PartTable.data}, '$.metadata.goal_continuation')`,
        hidden: sql<string | null>`json_type(${PartTable.data}, '$.hidden')`,
      })
      .from(PartTable)
      .where(inArray(PartTable.message_id, rows.map((row) => row.id)))
      .orderBy(PartTable.message_id, PartTable.id)
      .all()
      .pipe(Effect.orDie)
    const byMessage = new Map<MessageID, ChronologyPart[]>()
    for (const item of parts) {
      if (item.hidden !== null) continue
      const value: ChronologyPart = {
        type: item.type,
        ...(item.synthetic === 1 ? { synthetic: true } : {}),
        ...(item.goalContinuation === 1 ? { metadata: { goal_continuation: true as const } } : {}),
      }
      const list = byMessage.get(item.messageID)
      if (list) list.push(value)
      else byMessage.set(item.messageID, [value])
    }

    for (const row of rows) {
      const message = { info: hotInfo(row), parts: byMessage.get(row.id) ?? [] }
      const continuation = message.parts.some(
        (part) => part.type === "text" && part.synthetic && part.metadata?.goal_continuation === true,
      )
      const userInitiated = message.parts.some(
        (part) => part.type !== "compaction" && part.synthetic !== true,
      )
      // compaction-only user rows 是技术标记，不消耗 Goal slot。
      if (continuation || userInitiated) result.push(message)
      if (result.length === 2) break
    }

    const last = rows.at(-1)
    if (!last || rows.length < size) break
    // persisted tuple 保持同毫秒行的稳定扫描窗口。
    before = { id: last.id, time: last.time_created }
  }
  return result.toSorted((a, b) => compareChronology(a.info, b.info))
})

// 授权定位只选择全史可见user文本与相关工具行，不hydrate整史输出。
// 快照24000字符/400条与60条决定分别限额，超顶按source明示省略。
export interface ReviewerEvidenceUser {
  id: MessageID
  time: number
  text: string
}
export interface ReviewerEvidenceTool {
  id: PartID
  time: number
  tool: string
  stateStatus: string
  autoReviewStatus?: string
  autoReviewRationale?: string
  error?: string
  input?: string
  answers?: string
}
export interface ReviewerEvidence {
  user: ReviewerEvidenceUser[]
  userOmitted: boolean
  tools: ReviewerEvidenceTool[]
  decisionsOmitted: boolean
}

// user与QA共享24000字符/400条尾锚预算，决定独立60条、QA最多100条，均不占40条近期窗口。
const SNAPSHOT_CHAR_LIMIT = 24000
const SNAPSHOT_USER_LIMIT = 400
const SNAPSHOT_DECISION_LIMIT = 60
const SNAPSHOT_QA_LIMIT = 100
const SNAPSHOT_USER_PAGE = 32
// 精确重复的文本在渲染时折叠为约 50 字符的 identical 标记，走查按标记价计费：
// DB 实测长用户文本 21.9% 为重复（GOAL 块最多 24x），按全价计费会提前逐出有效证据。
const SNAPSHOT_DUP_COST = 50

export const reviewerEvidence = Effect.fn("MessageV2.reviewerEvidence")(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  return yield* Database.withSync(database, (db) => {
    // 子会话Text已可冷冻，全文授权和首条豁免都从同一只读恢复边界取得原文。
    const readTexts = (rows: (typeof PartTable.$inferSelect)[]) =>
      ColdStorage.inspectPartRows(db, rows).flatMap(row => {
        const value = partFromRestored(row)
        return value.type === "text" ? [{ messageID: row.message_id, text: value.text }] : []
      })

    // 冷包只恢复返回值，不thaw；input/答案/审查metadata不能从空skeleton猜测。
    const readTools = (rows: (typeof PartTable.$inferSelect)[]): ReviewerEvidenceTool[] =>
      ColdStorage.inspectPartRows(db, rows).flatMap(row => {
        const value = partFromRestored(row)
        if (value.type !== "tool" || value.state.status === "pending") return []
        const review: unknown = value.state.metadata?.autoReview
        const status = review && typeof review === "object" && "status" in review && typeof review.status === "string" ? review.status : undefined
        const result = review && typeof review === "object" && "result" in review ? review.result : undefined
        const rationale = result && typeof result === "object" && "rationale" in result && typeof result.rationale === "string" ? result.rationale : undefined
        return [{ id: row.id, time: row.time_created, tool: value.tool, stateStatus: value.state.status,
          ...(status ? { autoReviewStatus: status } : {}), ...(rationale ? { autoReviewRationale: rationale } : {}),
          ...(value.state.status === "error" ? { error: value.state.error } : {}), input: JSON.stringify(value.state.input),
          ...(value.state.status === "completed" && value.state.metadata.answers !== undefined ? { answers: JSON.stringify(value.state.metadata.answers) } : {}),
        }]
      })
    // QA 行与决定行分开取：两者配额独立，且决定行需要「最新 N 条」的尾锚语义。
    // N-03/N-04：timed_out/failed 等基础设施状态与 hidden 行在查询层排除。
    const qaRows = db
      .select({ row: PartTable })
      .from(PartTable)
      .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
      .where(and(
        eq(PartTable.session_id, sessionID),
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.tool') = 'question'`,
        sql`json_extract(${PartTable.data}, '$.state.status') = 'completed'`,
        sql`json_type(${PartTable.data}, '$.hidden') is null`,
        sql`json_type(${MessageTable.data}, '$.hidden') is null`,
      ))
      .orderBy(PartTable.time_created, PartTable.id)
      .limit(SNAPSHOT_QA_LIMIT + 1)
      .all()
    const qaOmitted = qaRows.length > SNAPSHOT_QA_LIMIT
    const qa = readTools(qaRows.slice(0, SNAPSHOT_QA_LIMIT).map(row => row.row))

    const decisionRows: ReviewerEvidenceTool[] = []
    let decisionBefore: { id: PartID; time: number } | undefined
    // 冷态metadata不在SQL热投影中，分批inspect候选并在真实决定达到配额后停止。
    while (decisionRows.length <= SNAPSHOT_DECISION_LIMIT) {
      const rows = db.select({ row: PartTable }).from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(and(eq(PartTable.session_id, sessionID),
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          sql`json_type(${PartTable.data}, '$.hidden') is null`, sql`json_type(${MessageTable.data}, '$.hidden') is null`,
          or(sql`${PartTable.cold_ref} is not null`,
            sql`json_extract(${PartTable.data}, '$.state.metadata.autoReview.status') in ('allowed', 'denied', 'fallback_user')`,
            sql`json_extract(${PartTable.data}, '$.state.error') like 'The user rejected permission%'`),
          decisionBefore ? or(lt(PartTable.time_created, decisionBefore.time),
            and(eq(PartTable.time_created, decisionBefore.time), lt(PartTable.id, decisionBefore.id))) : undefined,
        )).orderBy(desc(PartTable.time_created), desc(PartTable.id)).limit(64).all()
      if (!rows.length) break
      decisionRows.push(...readTools(rows.map(row => row.row)).filter(row =>
        ["allowed", "denied"].includes(row.autoReviewStatus ?? "") || row.autoReviewStatus === "fallback_user" && row.stateStatus === "completed" || row.error?.startsWith("The user rejected permission"))
        .slice(0, SNAPSHOT_DECISION_LIMIT + 1 - decisionRows.length))
      const last = rows.at(-1)?.row
      if (!last || rows.length < 64) break
      decisionBefore = { id: last.id, time: last.time_created }
    }
    const decisionsOmitted = decisionRows.length > SNAPSHOT_DECISION_LIMIT
    const decisions = decisionRows.slice(0, SNAPSHOT_DECISION_LIMIT).reverse()

    // user 文本尾锚走查：QA 的 JSON 长度从 24000 共享预算中扣除（含语法开销的
    // 保守估计，只会提前逐出不会超支）；从最新向最旧分页累计，重复文本按标记价。
    let budget = Math.max(0, SNAPSHOT_CHAR_LIMIT - qa.reduce((sum, row) => sum + (row.input?.length ?? 0) + (row.answers?.length ?? 0), 0))
    const seen = new Set<string>()
    const selected: ReviewerEvidenceUser[] = []
    let userOmitted = false
    let before: { id: MessageID; time: number } | undefined
    walk: while (selected.length < SNAPSHOT_USER_LIMIT) {
      const base = and(
        eq(MessageTable.session_id, sessionID),
        sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
        sql`json_type(${MessageTable.data}, '$.hidden') is null`,
      )
      const messages = db
        .select()
        .from(MessageTable)
        .where(before ? and(base, or(lt(MessageTable.time_created, before.time), and(eq(MessageTable.time_created, before.time), lt(MessageTable.id, before.id)))) : base)
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(SNAPSHOT_USER_PAGE)
        .all()
      if (!messages.length) break
      const texts = db
        .select()
        .from(PartTable)
        .where(and(
          inArray(PartTable.message_id, messages.map((row) => row.id)),
          sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
          sql`json_type(${PartTable.data}, '$.hidden') is null`,
        ))
        .orderBy(PartTable.id)
        .all()
      const byMessage = new Map<MessageID, string[]>()
      for (const row of readTexts(texts)) {
        if (!row.text?.trim()) continue
        const list = byMessage.get(row.messageID)
        if (list) list.push(row.text)
        else byMessage.set(row.messageID, [row.text])
      }
      for (const message of messages) {
        for (const text of byMessage.get(message.id) ?? []) {
          const cost = seen.has(text) ? SNAPSHOT_DUP_COST : text.length
          seen.add(text)
          if (cost > budget) {
            userOmitted = true
            break walk
          }
          budget -= cost
          selected.push({ id: message.id, time: message.time_created, text })
          if (selected.length >= SNAPSHOT_USER_LIMIT) {
            userOmitted = true
            break walk
          }
        }
      }
      const last = messages.at(-1)
      if (!last || messages.length < SNAPSHOT_USER_PAGE) break
      before = { id: last.id, time: last.time_created }
    }
    // 首条 user 豁免逐出：原始授权常在首条（Codex root conversation 同构）。
    // 追加在走查结果之后统一反转，反转后自然位于快照开头。
    if (userOmitted) {
      const first = db
        .select()
        .from(MessageTable)
        .where(and(
          eq(MessageTable.session_id, sessionID),
          sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
          sql`json_type(${MessageTable.data}, '$.hidden') is null`,
        ))
        .orderBy(MessageTable.time_created, MessageTable.id)
        .limit(1)
        .all()[0]
      if (first && !selected.some((row) => row.id === first.id)) {
        const firstTexts = db
          .select()
          .from(PartTable)
          .where(and(
            eq(PartTable.message_id, first.id),
            sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
            sql`json_type(${PartTable.data}, '$.hidden') is null`,
          ))
          .orderBy(PartTable.id)
          .all()
        for (const row of readTexts(firstTexts)) {
          if (row.text?.trim()) selected.push({ id: first.id, time: first.time_created, text: row.text })
        }
      }
    }
    selected.reverse()

    const tools = [...qa, ...decisions]
      .map((row) => ({
        id: row.id,
        time: row.time,
        tool: row.tool,
        stateStatus: row.stateStatus,
        ...("autoReviewStatus" in row && row.autoReviewStatus ? { autoReviewStatus: row.autoReviewStatus } : {}),
        ...("autoReviewRationale" in row && row.autoReviewRationale ? { autoReviewRationale: row.autoReviewRationale } : {}),
        ...("error" in row && row.error ? { error: row.error } : {}),
        ...(row.input ? { input: row.input } : {}),
        ...("answers" in row && row.answers ? { answers: row.answers } : {}),
      }))
      .sort((left, right) => left.time - right.time)
    // synthetic 不排除：GOAL continuation 块是 synthetic user 文本，恰是快照要保留
    // 的授权载体（去重规则在投影层折叠其重复）。空文本无证据价值，在组装时过滤。
    return { user: selected, userOmitted: userOmitted || qaOmitted, tools, decisionsOmitted }
  })
})

// #0500：cancel ownership 只依赖 Message parent/time hot fields。Parts 由 caller 仅为选中的 incomplete assistant
// 定点 hydrate，已完成 assistant 的冷 Tool history 不会因一次取消操作被扫描并预热。
export const cancelSnapshot = Effect.fn("MessageV2.cancelSnapshot")(function* (sessionID: SessionID, options?: { includeHidden?: boolean }) {
  const { db } = yield* Database.Service
  const messages = yield* db
    .select()
    .from(MessageTable)
    .where(and(
      eq(MessageTable.session_id, sessionID),
      options?.includeHidden ? undefined : sql`json_type(${MessageTable.data}, '$.hidden') is null`,
    ))
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
    .pipe(Effect.map((rows) => rows.map(hotInfo)), Effect.orDie)
  const parentIDs = new Set(
    messages.flatMap((message) => (message.role === "assistant" ? [message.parentID] : [])),
  )
  return {
    pendingAssistantIDs: messages.flatMap((message) =>
      message.role === "assistant" && !message.time.completed ? [message.id] : [],
    ),
    orphanUserIDs: messages.flatMap((message) =>
      message.role === "user" && !parentIDs.has(message.id) ? [message.id] : [],
    ),
  }
})

// #493：Session.getPart 与批量 hydrate 共享同一 row decoder，避免 direct read 绕过 cold projection。
export const decodeMessageRow = info
export const decodePartRow = part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))
// #557：older 的补——inclusive suffix 起点解析用，包含后来写入的 lexical-low ID。
// #557：inclusive suffix 谓词——later-written lexical-low ID 仍属同一窗口。
const atOrNewer = (row: Cursor) =>
  or(gt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), gte(MessageTable.id, row.id)))

function hydrate(
  db: Database.Interface["db"],
  sync: Database.Interface["sync"],
  rows: (typeof MessageTable.$inferSelect)[],
  includeHidden = false,
  messageProjection?: "viewer",
) {
  // #0500：hydrate 只恢复 page/get 已选定的 rows；显式 no-limit consumer 仍通过逐页调用保留完整历史合同。
  // 内存恢复由ColdStorage校验，此层不拥有引用生命周期。
  // Message与Parts按选中范围批量inspect，查看不写热历史。
  // 任一 Message corruption 让整个范围失败，不能返回半完整、半 skeleton 的 transcript。
  return Effect.gen(function* () {
    // 可见性先决定owner集合，隐藏父消息及其子Part都不能被业务读取恢复。
    const admitted = includeHidden ? rows : rows.filter((row) => !row.data.hidden)
    // viewer只省略user summary，assistant同包批量恢复而不逐条解压。
    const selected = messageProjection === "viewer" ? admitted.filter((row) => row.data.role === "assistant") : admitted
    const restored = new Map(
      (yield* Database.withSync({ db, sync }, () => ColdStorage.inspectMessageRows(sync, selected))).map((row) => [row.id, row]),
    )
    const infos = admitted.map((row) => {
      const complete = restored.get(row.id) ?? row
      return messageProjection === "viewer" ? viewerInfo(complete) : infoFromRestored(complete)
    })
    const ids = admitted.map((row) => row.id)
    const partByMessage = new Map<string, Part[]>()
    if (ids.length > 0) {
      // SELECT与冷读取在同一次连接预约和快照中完成，不能跨await携带已失效的cold locator。
      const restoredParts = yield* Database.withSync({ db, sync }, () => sync.transaction((tx) => {
        const partRows = tx.select().from(PartTable).where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id).all()
        const visible = includeHidden ? partRows : partRows.filter((row) => !row.data.hidden)
        // 普通SDK与viewer共享只读恢复，保留同连接查询快照和完整性检查。
        return ColdStorage.inspectPartRows(tx, visible)
      }, { behavior: "deferred" }))
      for (const row of restoredParts) {
        const next = partFromRestored(row)
        // [0624] viewer 路径再过一次 TUI 专用纯投影，剪掉同 Part 内逐字重复的大字段。
        const projected = messageProjection === "viewer" ? PartView.project(next) : next
        const list = partByMessage.get(row.message_id)
        if (list) list.push(projected)
        else partByMessage.set(row.message_id, [projected])
      }
    }

    // 只读恢复保留page与child顺序，不改变冷态或访问范围外历史。
    return infos.map((info) => ({
      info,
      parts: partByMessage.get(info.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  // 内部 primitive 标记不属于 providerOptions；保留对象 namespace 及自定义供应商签名。
  const rest = Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) =>
      key !== "providerExecuted" && typeof value === "object" && value !== null && !Array.isArray(value)),
  )
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputTruncation?: { head: number; tail: number } },
) {
  // #553：直接 Provider caller 不能假设上游已经完成 projection；这里是最终 wire trust seam。
  input = visible(input)
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") {
      if (!attachment.mime.startsWith("image/")) return false
      const id = model.api.id.toLowerCase()
      return id.includes("anthropic.") || id.includes("nova") || id.includes("llama4") || id.includes("llama-4")
    }
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  // xAI rejects any other image format (e.g. GIF) with invalid_image, failing the whole request.
  const rejectedByProvider = (attachment: { mime: string }) =>
    model.api.npm === "@ai-sdk/xai" &&
    attachment.mime.startsWith("image/") &&
    !["image/png", "image/jpeg", "image/webp"].includes(attachment.mime)

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          const recentUserMemento = formatRecentUserMemento(part.recent_user_messages ?? [])
          if (recentUserMemento) {
            userMessage.parts.push({
              type: "text",
              text: recentUserMemento,
            })
          }
          // #256：历史压缩提示保持在 memento 之后——既有摘要仍与同一用户边界配对，
          // 而更新的模型先看到最新保留的用户意图。
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      // reasoning_content 是可移植文本字段：GLM/Kimi 等兼容模型互切时保留结构化回放。
      const replaysForeignReasoning =
        model.api.npm === "@ai-sdk/openai-compatible" &&
        typeof model.capabilities.interleaved === "object" &&
        model.capabilities.interleaved.field === "reasoning_content"
      const replaysForeignOpenAIReasoning =
        // 加密续接状态属于账号域；历史只记录 Provider，因此不同 Provider 不共享密文。
        model.providerID === msg.info.providerID &&
        // 同 Provider 切换 GPT 模型仍可回放，避免把隔离边界扩大为每个模型独立。
        model.id.toLowerCase().startsWith("gpt") && msg.info.modelID.toLowerCase().startsWith("gpt")
      // 两端都检查，避免非 GPT 模型的签名因目标为 GPT 而被放行。
      // 此处保留语义信息；最终 wire 字段由目标协议适配器编码。
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          const providerMetadata = differentModel ? undefined : providerMeta(part.metadata)
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(providerMetadata ? { providerMetadata } : {}),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            // 剪枝占位与共享Search History一起保留partial，不能把无正文当作完整阴性。
            const outputText = part.state.time.compacted
              ? formatCompactionClearedNotice() + ((part.tool === "glob" || part.tool === "grep") && part.state.metadata.partial === true ? "\nSearch incomplete: some paths were inaccessible and skipped." : "")
              : truncateToolOutput(
                  part.state.output,
                  options?.toolOutputTruncation?.head,
                  options?.toolOutputTruncation?.tail,
                )
            const attachments =
              part.state.time.compacted || options?.stripMedia
                ? []
                : (part.state.attachments ?? []).filter((a) => !rejectedByProvider(a))

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const interrupted = part.state.metadata?.interrupted === true
            // [local-smark] 只有新记录携带 server 写入的 executionElapsedMs 才追加
            // abort Notice；旧记录无此字段，保持原样不追溯伪造 elapsed
            const rawElapsed = interrupted ? part.state.metadata?.executionElapsedMs : undefined
            const abortNotice = typeof rawElapsed === "number" && Number.isFinite(rawElapsed) && rawElapsed >= 0
              ? formatExecutionNotice({ source: "tool", severity: "warning", reason: "user_abort", elapsed_ms: Math.floor(rawElapsed) })
              : undefined
            const partialOutput = interrupted ? part.state.metadata?.output : undefined
            // Task创建后已保存真实子会话身份；即使没有partial也须交付恢复行，其他工具不变。
            // 恢复行先于既有abort notice，不把中断伪装为完成。
            const taskSessionId =
              part.tool === "task" && typeof part.state.metadata?.sessionId === "string" ? part.state.metadata.sessionId : undefined
            if (typeof partialOutput === "string") {
              const body = taskSessionId ? ensureTaskResumeVisible(partialOutput, taskSessionId) : partialOutput
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                // 有 marker 时追加 abort Notice，使模型能看到取消原因和耗时
                output: abortNotice ? body + "\n\n" + abortNotice : body,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              // #528：无 partial 时仍走 output-error，不把 abort 伪装成 completed（INV-04）
              const errorBody = taskSessionId ? ensureTaskResumeVisible(part.state.error, taskSessionId) : part.state.error
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: abortNotice ? errorBody + "\n\n" + abortNotice : errorBody,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running") {
            // #528：open task 在 running 态 metadata 里常已有 sessionId；投影 resume 行供后续 task 续跑。
            // pending 无 metadata 字段：无 sessionId 时保持原 interrupted 固定串（INV-03）。
            const openMeta = "metadata" in part.state ? part.state.metadata : undefined
            const openTaskSessionId =
              part.tool === "task" && typeof openMeta?.sessionId === "string" ? openMeta.sessionId : undefined
            const openBody = openTaskSessionId
              ? ensureTaskResumeVisible("[Tool execution was interrupted]", openTaskSessionId)
              : "[Tool execution was interrupted]"
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: openBody,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
        }
        if (part.type === "reasoning") {
          if (differentModel && !replaysForeignReasoning && !replaysForeignOpenAIReasoning) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          // #464：reasoning 的 providerMetadata 同样经 providerMeta 过滤 primitive 内部标记。
          const providerMetadata = providerMeta(part.metadata)
          // GPT 回放只允许携带 OpenAI 加密续接状态；Anthropic/Bedrock 源签名不能跨越该边界。
          // 只在投影副本去掉源ID；持久原件和同模型store引用均保持原样。
          const replayMetadata = differentModel
            ? replaysForeignOpenAIReasoning && providerMetadata?.openai
              ? { openai: Object.fromEntries(Object.entries(providerMetadata.openai).filter(([key]) => key !== "itemId")) }
              : undefined
            : providerMetadata
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            ...(differentModel && !replaysForeignOpenAIReasoning
              ? {}
              : replayMetadata
                ? { providerMetadata: replayMetadata }
                : {}),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputTruncation?: { head: number; tail: number } },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}
// #557：每个 persisted Message 自成转换块，prefix contraction 才能截断到任意命中点；
// concurrency 只并行纯转换，拼接仍服从 input 顺序。
export const toModelMessageChunksEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
) {
  return yield* Effect.forEach(input, (message) => toModelMessagesEffect([message], model), {
    concurrency: "unbounded",
  })
})

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
  // 显式审计读取保留隐藏内容，普通分页在 LIMIT 前筛选可见消息。
  includeHidden?: boolean
  fromMessageID?: MessageID
  messageProjection?: "viewer"
}) {
  // page 继续拥有 SQL range/cursor；viewer 只是同一 page 的合法 Info 投影，不能另建分页或备用读取路径。
  // projection 只由 handler 显式传入；内部 caller（Revert/Provider/export）一律完整 hydrate。
  const { db, sync } = yield* Database.Service
  if (input.limit === 0) {
    // #493：零范围只验证 Session existence，不读取 Message 探针，更不触发任何 thaw。
    const exists = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
    if (!exists) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${input.sessionID}` }))
    const items: WithParts[] = []
    return { items, more: false }
  }
  const before = input.before ? cursor.decode(input.before) : undefined
  const anchor = input.fromMessageID
    ? yield* db.select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable).where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.fromMessageID)))
        .get().pipe(Effect.orDie)
    : undefined
  // 导入及回绕ID不保证时间单调，范围必须与现有(time_created,id)分页顺序一致。
  const lower = input.fromMessageID
    ? anchor
      ? atOrNewer(anchor)
      : sql`0`
    : undefined
  const where = and(eq(MessageTable.session_id, input.sessionID), lower, before ? older(before) : undefined)
  // #98：隐藏消息在 LIMIT 前过滤，保留可见页容量和游标。
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(and(where, input.includeHidden ? undefined : sql`json_extract(${MessageTable.data}, '$.hidden') IS NULL`))
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    // #106：与 Session.get 一致用 Effect.fail，确保 Effect.flip 得到 NotFoundError 实例
    if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${input.sessionID}` }))
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  // #98：普通列表过滤隐藏部件，审计读取保留完整内容。
  // 协议重试隐藏畸形审查轮次，和撤回、空助手修复一样保留审计记录但不进入普通历史。
  const items = yield* hydrate(db, sync, slice, Boolean(input.includeHidden), input.messageProjection)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

// #493：findHot 的 page 扫描只构造 HotInfo，不查 Parts、不调用 thaw；首个匹配 row 才 hydrate。
// hidden Message 在SQL阶段排除，hidden Part在选中一条的thaw前过滤，避免预热不可见正文。
export const findHot = Effect.fn("MessageV2.findHot")(function* (input: {
  sessionID: SessionID
  predicate: (info: HotInfo) => boolean
}) {
  const { db, sync } = yield* Database.Service
  const exists = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  if (!exists) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${input.sessionID}` }))

  const size = 50
  let before: Cursor | undefined
  while (true) {
    const base = and(eq(MessageTable.session_id, input.sessionID), sql`json_type(${MessageTable.data}, '$.hidden') is null`)
    const where = before ? and(base, older(before)) : base
    const rows = yield* db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(size + 1)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return Option.none<WithParts>()
    const more = rows.length > size
    const slice = more ? rows.slice(0, size) : rows

    // predicate 只接收 HotInfo：扫描阶段不能意外读取 summary.diffs 或 Parts。
    for (const row of slice) {
      if (!input.predicate(hotInfo(row))) continue
      const found = (yield* hydrate(db, sync, [row], false))[0]
      if (!found) throw new Error(`Message row disappeared during find: ${row.id}`)
      return Option.some(found)
    }
    if (!more) return Option.none<WithParts>()
    const tail = slice.at(-1)
    if (!tail) return Option.none<WithParts>()
    before = { id: tail.id, time: tail.time_created }
  }
})

// #0500：自动 summary 只需要目标 user 与其 assistant children；按 throughMessageID 封住查询，
// 避免并发追加被部分计入 per-user diff，也避免为一个 turn hydrate 整个 Session。
export const targetWithAssistantChildren = Effect.fn("MessageV2.targetWithAssistantChildren")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  throughMessageID: MessageID
}) {
  const { db, sync } = yield* Database.Service
  // snapshot 上界先解析为同 Session 持久 tuple，不能用回绕后的 raw ID 排除旧轮或泄漏界后 Tool。
  const through = yield* db
    .select({ id: MessageTable.id, time: MessageTable.time_created })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.throughMessageID)))
    .get()
    .pipe(Effect.orDie)
  // #0584：封界行缺失是持久化一致性破坏：报错而不是回退全域或 raw-ID 过滤。
  if (!through) throw new Error(`Snapshot boundary is not resolvable: ${input.throughMessageID}`)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, input.sessionID),
        // 隐藏target不能留下孤立children，判定先于任何owner解压。
        sql`json_type(${MessageTable.data}, '$.hidden') is null`,
        // #0584：闭区间上界按 (time_created, BINARY id) tuple 切分，同毫秒时用 ID 字节序。
        or(
          lt(MessageTable.time_created, through.time),
          and(eq(MessageTable.time_created, through.time), lte(MessageTable.id, through.id)),
        ),
        or(
          eq(MessageTable.id, input.messageID),
          and(
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.parentID') = ${input.messageID}`,
          ),
        ),
      ),
    )
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
    .pipe(Effect.orDie)
  if (!rows.some((row) => row.id === input.messageID)) return [] as WithParts[]
  return yield* hydrate(db, sync, rows)
})

// #493：fork 只读取 raw storage rows，不经 decoder，不会把 source prefix 持久 thaw。
// messageID按同会话持久tuple定位exclusive前缀，显式缺失边界在创建子会话前拒绝。
export function rawForkRows(db: ColdStorage.TxOrDb, input: { sessionID: SessionID; messageID?: MessageID }) {
  const conditions = [eq(MessageTable.session_id, input.sessionID), sql`json_type(${MessageTable.data}, '$.hidden') is null`]
  const anchor = input.messageID ? db.select({ id: MessageTable.id, time: MessageTable.time_created }).from(MessageTable)
    .where(and(...conditions, eq(MessageTable.id, input.messageID))).get() : undefined
  // 保留同Session、hidden过滤和Part join；不能以缺失边界放大为全量复制。
  if (input.messageID && !anchor) return { messages: [], parts: [], missing: true as const }
  if (anchor) conditions.push(sql`(${MessageTable.time_created}, ${MessageTable.id}) < (${anchor.time}, ${anchor.id})`)
  const messages = db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(...conditions))
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
  const parts = messages.length
    ? db
        .select({ id: PartTable.id, message_id: PartTable.message_id })
        .from(PartTable)
        .innerJoin(MessageTable, and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)))
        .where(and(...conditions, eq(PartTable.session_id, input.sessionID), sql`json_type(${PartTable.data}, '$.hidden') is null`))
        .orderBy(MessageTable.time_created, MessageTable.id, PartTable.id)
        .all()
    : []
  return { messages, parts, missing: false as const }
}

// #98：stream 默认过滤 hidden；includeHidden 供审计/恢复读取
export function stream(sessionID: SessionID, opts?: { includeHidden?: boolean; fromMessageID?: MessageID }) {
  // includeHidden 默认 false：正常流不返回被撤销隐藏的消息和 part
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      // 已有 page 以 persisted time/ID 锚定边界，同时在 SQL 保留 hidden 过滤和范围外不预热。
      const next = yield* page({ sessionID, limit: size, before, includeHidden: opts?.includeHidden, fromMessageID: opts?.fromMessageID }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (!item) continue
        result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID, options?: { includeHidden?: boolean }) {
  return Effect.gen(function* () {
    const { db, sync } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(and(
        eq(PartTable.message_id, messageID),
        // 已知ID不能越过父级隐藏；过滤必须发生在cold decoder前。
        options?.includeHidden ? undefined : sql`json_type(${PartTable.data}, '$.hidden') is null`,
        options?.includeHidden ? undefined : sql`exists (
          select 1 from ${MessageTable} where ${MessageTable.id} = ${PartTable.message_id}
          and json_type(${MessageTable.data}, '$.hidden') is null
        )`,
      ))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    // 直接读保持冷态，恢复后仍按业务Schema复核差异字段。
    return yield* Database.withSync({ db, sync }, () => ColdStorage.inspectPartRows(sync, rows).map(partFromRestored))
  })
}

// 输入估算只恢复参与学习的统计样本，不能经完整历史接口加载工具正文。
export const inputEstimateHistory = Effect.fn("MessageV2.inputEstimateHistory")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  model: Pick<Provider.Model, "providerID" | "id">
}) {
  const database = yield* Database.Service
  // 定位、水位与样本共用只读快照，读取不修改 cold_ref、正文或时间戳。
  return yield* Database.withSync(database, sync => sync.transaction(tx => {
    const selected = new Map<MessageID, {
      info: Pick<Assistant, "id" | "time" | "role" | "providerID" | "modelID" | "tokens" | "inputEstimate">
      parts: Part[]
    }>()
    const collect = (modelOnly: boolean) => {
      let chars = 0
      let before: Cursor | undefined
      while (chars < TokenEstimate.INPUT_CHARS_HISTORY_LIMIT) {
        // 定位也按需读取；不能先加载全会话元数据，再在内存中挑最近样本。
        const row = tx.select({ id: MessageTable.id, time: MessageTable.time_created, data: MessageTable.data }).from(MessageTable)
          .where(and(eq(MessageTable.session_id, input.sessionID),
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_type(${MessageTable.data}, '$.hidden') is null`,
            before ? older(before) : undefined,
            modelOnly ? sql`json_extract(${MessageTable.data}, '$.providerID') = ${input.model.providerID} and json_extract(${MessageTable.data}, '$.modelID') = ${input.model.id}` : undefined,
            // 旧确认 carrier 与有用的 step 都保留；零 usage、隐藏和纯正文不触发解压。
            sql`(json_extract(${MessageTable.data}, '$.inputEstimate.confirmed') = 1 or exists (
              select 1 from ${PartTable} where ${PartTable.message_id} = ${MessageTable.id}
              and ${PartTable.session_id} = ${input.sessionID}
              and json_type(${PartTable.data}, '$.hidden') is null
              and json_extract(${PartTable.data}, '$.type') = 'step-finish'
              and coalesce(json_extract(${PartTable.data}, '$.tokens.input'), 0)
                + coalesce(json_extract(${PartTable.data}, '$.tokens.cache.read'), 0)
                + coalesce(json_extract(${PartTable.data}, '$.tokens.cache.write'), 0) > 0
              and (${PartTable.cold_ref} is not null or json_extract(${PartTable.data}, '$.inputChars') is not null)
            ))`))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id)).limit(1).get()
        if (!row) break
        before = { id: row.id, time: row.time }
        if (row.data.role !== "assistant") continue
        // StepFinish 的输入明细也可能在冷层；只为实际候选恢复统计，不回填历史。
        const message = selected.get(row.id) ?? {
          info: { id: row.id, time: { created: row.time }, role: row.data.role, providerID: row.data.providerID, modelID: row.data.modelID,
            tokens: row.data.tokens, inputEstimate: row.data.inputEstimate },
          parts: ColdStorage.inspectPartRows(tx, tx.select().from(PartTable)
            .where(and(eq(PartTable.message_id, row.id), eq(PartTable.session_id, input.sessionID),
              sql`json_type(${PartTable.data}, '$.hidden') is null`,
              sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`))
            .orderBy(PartTable.id).all()).map(partFromRestored),
        }
        selected.set(row.id, message)
        // 与学习器按完整消息累计到相同字符预算，不能任意截成最近若干条。
        for (const part of message.parts) {
          const sample = TokenEstimate.inputRatioSample(part)
          if (!sample) continue
          chars += sample.chars
        }
      }
    }
    // 同模型优先、会话样本回退沿用原算法；第二次选择复用已恢复的统计。
    const history = () => [...selected.values()].sort((a, b) => compareChronology(a.info, b.info))
    collect(true)
    if (!TokenEstimate.learnInputCharsPerToken({ messages: history(), model: input.model })) collect(false)
    // 水位仍取当前消息最后一个可见 Part，不能用最后一条统计代替。
    const last = tx.select({ id: PartTable.id }).from(PartTable)
      .where(and(eq(PartTable.session_id, input.sessionID), eq(PartTable.message_id, input.messageID),
        sql`json_type(${PartTable.data}, '$.hidden') is null`))
      .orderBy(desc(PartTable.id)).limit(1).get()
    return {
      history: history(),
      afterPartID: last?.id,
    }
  }, { behavior: "deferred" }))
})

// #493：usage 只需要 step-finish 热字段；专用 SQL 防止统计同 message 时 thaw tool/reasoning/file payload。
// discriminator 在 SQL 与 TS 双重确认，外部损坏 JSON 不会被静默当成 StepFinishPart。
export function stepFinishParts(messageID: MessageID, options?: { includeHidden?: boolean }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(and(
        eq(PartTable.message_id, messageID),
        sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`,
        // 计费owner采用原始热字段，其他调用仍遵守父子可见性。
        options?.includeHidden ? undefined : sql`json_type(${PartTable.data}, '$.hidden') is null`,
        options?.includeHidden ? undefined : sql`exists (
          select 1 from ${MessageTable} where ${MessageTable.id} = ${PartTable.message_id}
          and json_type(${MessageTable.data}, '$.hidden') is null
        )`,
      ))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.flatMap((row) => (row.data.type === "step-finish" ? [row.data] : []))
  })
}

// #508：doom-loop AND 窗口需要 cursor 之前、跨多个 visible assistant 的有界非 pending tool tail。
// 不变量：1-tool-per-step × N 时 limit=3 必须能凑满 3 条，否则 AND 永远不可达（旧单 previous 深度不足）。
// 每 step 新建 assistant 且常 1 tool/turn 时，只读「单个 previous assistant」窗口长度永远 < 3。
// 因此按 session join 倒序取 limit 条 tool part；hidden message/part 在 LIMIT 前过滤以免占配额。
// 只 thaw 最终选中的少量 rows，不 hydrate 全 transcript。
// 倒序 LIMIT 后再 reverse：调用方看到旧→新正序，与 transcript 时间线一致，AND 比较最近尾部。
export function previousAssistantToolTail(input: {
  sessionID: SessionID
  before: { id: MessageID; time: number }
  limit: number
}) {
  return Effect.gen(function* () {
    if (input.limit <= 0) return []
    const { db, sync } = yield* Database.Service
    const current = yield* db
      .select({ time: MessageTable.time_created })
      .from(MessageTable)
      .where(eq(MessageTable.id, input.before.id))
      .get()
      .pipe(Effect.orDie)
    // cursor 以 DB 已持久 time 为准；调用方 time 仅在 row 暂缺时兑底，避免与写入竞态错位。
    const cursorBound = { id: input.before.id, time: current?.time ?? input.before.time }
    const rows = yield* db
      .select({
        id: PartTable.id,
        message_id: PartTable.message_id,
        session_id: PartTable.session_id,
        time_created: PartTable.time_created,
        time_updated: PartTable.time_updated,
        data: PartTable.data,
        cold_ref: PartTable.cold_ref,
        cold_key: PartTable.cold_key,
        cold_stats: PartTable.cold_stats,
      })
      .from(PartTable)
      .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
      .where(
        and(
          eq(PartTable.session_id, input.sessionID),
          eq(MessageTable.session_id, input.sessionID),
          // 仅 assistant transcript 参与 doom 窗口；user/system 文本不得挤占 LIMIT。
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          sql`json_type(${MessageTable.data}, '$.hidden') is null`,
          older(cursorBound),
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          // pending 尚无终态，不能当作「脱扣」计入连续失败窗口。
          sql`json_extract(${PartTable.data}, '$.state.status') != 'pending'`,
          sql`json_type(${PartTable.data}, '$.hidden') is null`,
        ),
      )
      // 导入 part 的 ID 可跨消息逆序；先沿既有消息时间/ID，再取消息内末尾。
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id), desc(PartTable.id))
      .limit(input.limit)
      .all()
      .pipe(Effect.orDie)
    return yield* Database.withSync({ db, sync }, () => ColdStorage.thawPartRows(sync, rows).map(partFromRestored).reverse())
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID; includeHidden?: boolean }) {
  const { db, sync } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(
      eq(MessageTable.id, input.messageID),
      eq(MessageTable.session_id, input.sessionID),
      // 普通读取在owner查询返回NotFound，不先恢复隐藏正文再交调用方丢弃。
      input.includeHidden ? undefined : sql`json_type(${MessageTable.data}, '$.hidden') is null`,
    ))
    .get()
    .pipe(Effect.orDie)
  // #106：message 缺失同样 Effect.fail
  if (!row) return yield* Effect.fail(new NotFoundError({ message: `Message not found: ${input.messageID}` }))
  // #493：单条读取也走 cold-aware decoder（decodeMessageRow seam）
  return {
    info: yield* Database.withSync({ db, sync }, () => info(sync, row)),
    parts: yield* parts(input.messageID, { includeHidden: input.includeHidden }),
  }
})

// #553：visible 是 normal business projection；raw persistence、audit、fork 和 accounting 不经过这里。
// Message 与 Part 必须原子地过滤，避免 hidden 父记录或 tombstone 重新进入 Provider/output。
export function visible(messages: Iterable<WithParts>) {
  return Array.from(messages).flatMap((message) =>
    message.info.hidden ? [] : [{ ...message, parts: message.parts.filter((part) => !part.hidden) }],
  )
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  // #204：压缩标记须按 newest→oldest 扫描——summary assistant 先于 parent compaction user 出现，才能停止遍历并恢复 retained tail
  // #204：沿用分页的时间/ID顺序；导入消息的ID未必单调，不能覆盖它们真实的创建顺序。
  const ordered = Array.from(msgs).toSorted((a, b) => compareChronology(b.info, a.info))
  const result = [] as WithParts[]
  const completed = new Set<MessageID>()
  let retain: MessageID | undefined
  // 隐藏普通消息仍可定位有效tail；被撤销的Compaction不再拥有裁剪边界。
  // 配对证明先于visible投影，避免悬挂marker或summary复活旧压缩。
const visibleWindow = (items: SessionV1.WithParts[]) => visible(visibleCompactions(items))
  // #204：遍历 newest-first 序列，发现 summary→compaction 边界并锁定 retained tail
  for (const msg of ordered) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user") {
      // 候选资格由可见成功摘要建立，隐藏marker必须同时撤销候选。
      if (!completed.has(msg.info.id)) continue
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction" && !item.hidden)
      if (!part || msg.info.hidden) {
        completed.delete(msg.info.id)
        continue
      }
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "assistant" && !msg.info.hidden && msg.info.summary && msg.info.finish && !msg.info.error) {
      // summary自身隐藏时，不能再为marker证明结构边界。
      completed.add(msg.info.parentID)
    }
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      completed.has(msg.info.id) &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.finish &&
          !msg.info.error &&
          // 与SQL边界采用相同可见性合同，仍保留真实parentID配对。
          !msg.info.hidden &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return visibleWindow([
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ])
  }
  return visibleWindow(result)
}

function visibleCompactions(items: SessionV1.WithParts[]) {
  // #242：只有 user(compaction) 与已完成且无错的摘要 assistant 配对才是持久边界；
  // 悬挂标记/摘要是本地维护残渣——在 prompt 重放与 latest 任务检测看到它们之前剔除，
  // 否则会复活旧 compact 或把「What did we do so far?」注入后续 user prompt
  // #553：Map 携带 marker 本体——completed 配对时校验 hidden 一致与可见 Compaction Part。
  const compactions = new Map(
    items
      .filter((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"))
      .map((msg) => [msg.info.id, msg]),
  )
  const completed = new Set(
    items.flatMap((msg): MessageID[] => {
      if (msg.info.role !== "assistant") return []
      if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
      const marker = compactions.get(msg.info.parentID)
      // 任一侧隐藏，回放与裁剪同时失效；不能让两侧同为hidden反而重新合法。
      if (!marker || marker.info.hidden || msg.info.hidden || !marker.parts.some((part) => part.type === "compaction" && !part.hidden)) return []
      return [msg.info.parentID]
    }),
  )
  return items.filter((msg) => {
    if (msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")) {
      return completed.has(msg.info.id)
    }
    if (msg.info.role === "assistant" && msg.info.summary && compactions.has(msg.info.parentID)) {
      return completed.has(msg.info.parentID)
    }
    return true
  })
}

// 两代与预算估算共用同一信封，保留原话、顺序和截断标记，不复制提示词。
export const formatRecentUserMemento = SessionMemento.format

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  // #0500：cutoff 先于任何 business hydrate 决定；无 tail 时 marker 本身就是 head 终点，
  // 有 tail 时从原始 retained turn 开始读取，再由 filterCompacted 恢复 provider 顺序。
  // #205：压缩恢复需要 hidden 结构锚点作为边界；visible() 会从返回的 prompt 窗口剔除它们
  const database = yield* Database.Service
  const boundary = yield* Database.withSync(database, (sync) => CompactionBoundary.latest(sync, sessionID))
  const cutoff = boundary?.tailStartID ?? boundary?.markerID
  const messages = filterCompacted(yield* stream(sessionID, { includeHidden: true, fromMessageID: cutoff }))
  // 可见性和压缩排序完成后才预热，不扩大模型实际保留的上下文。
  yield* warmExecutionWindow(messages)
  return messages
})

export const warmExecutionWindow = Effect.fn("MessageV2.warmExecutionWindow")(function* (messages: WithParts[]) {
  if (!messages.length) return
  const database = yield* Database.Service
  yield* Database.withSync(database, (sync) => {
    const ids = messages.map((message) => message.info.id)
    // 已热owner不重复搬运正文，仍由ColdStorage管理实际引用和清理。
    ColdStorage.thawMessageRows(
      sync,
      sync.select().from(MessageTable)
        .where(and(inArray(MessageTable.id, ids), sql`${MessageTable.cold_ref} is not null`)).all(),
    )
    const parts = messages.flatMap((message) => message.parts.map((part) => part.id))
    // 最终窗口未选择的隐藏Part不随父Message预热。
    if (parts.length) ColdStorage.thawPartRows(
      sync,
      sync.select().from(PartTable)
        .where(and(inArray(PartTable.id, parts), sql`${PartTable.cold_ref} is not null`)).all(),
    )
  })
})

// #557：Prompt window 结构 proof——只读 SQLite 原始文本与 cold locator，不 thaw/hydrate；
// boundary identity 是 Provider window 的结构版本，成功 Compaction 改写 boundary 后必须完整 miss。
export type PromptWindowProof = {
  boundary: string
  messages: Array<{ id: MessageID; key: string }>
}

  // #557：proof 是 cache 唯一 admission 依据——不读 thaw 后的业务对象，避免自身成为预热源。
export const promptWindowProof = Effect.fn("MessageV2.promptWindowProof")(function* (sessionID: SessionID) {
  const { db, sync } = yield* Database.Service
  const boundary = yield* Database.withSync({ db, sync }, () => CompactionBoundary.latest(sync, sessionID))
  const cutoffID = boundary?.tailStartID ?? boundary?.markerID
  const cutoff = cutoffID
    ? yield* db
        .select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, sessionID), eq(MessageTable.id, cutoffID)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  // cutoff row 缺失时不猜测半个 Compaction window，boundary key 已迫使 caller miss。
  const messageRows = yield* db
    .select({
      id: MessageTable.id,
      timeCreated: MessageTable.time_created,
      timeUpdated: MessageTable.time_updated,
      data: sql<string>`cast(${MessageTable.data} as text)`,
      coldRef: MessageTable.cold_ref,
      coldKey: sql<string>`hex(${MessageTable.cold_key})`,
    })
    .from(MessageTable)
    .where(
      cutoff
        ? and(eq(MessageTable.session_id, sessionID), atOrNewer(cutoff))
        : eq(MessageTable.session_id, sessionID),
    )
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
    .pipe(Effect.orDie)
  // time_updated 覆盖同一 Message ID 的原位更新；time_created 决定 common-prefix 的 persisted 顺序。
  const partRows = yield* db
    .select({
      messageID: sql<MessageID>`${PartTable.message_id}`,
      id: sql<PartID>`${PartTable.id}`,
      timeCreated: sql<number>`${PartTable.time_created}`,
      timeUpdated: sql<number>`${PartTable.time_updated}`,
      data: sql<string>`cast(${PartTable.data} as text)`,
      coldRef: sql<string | null>`${PartTable.cold_ref}`,
      coldKey: sql<string>`hex(${PartTable.cold_key})`,
      coldStats: sql<string>`cast(${PartTable.cold_stats} as text)`,
    })
    // 无统计信息时 SQLite 会误选 session 索引，逐次扫描整段历史；沿已有消息索引只读窗口 Part。
    .from(sql`${PartTable} indexed by part_message_id_id_idx`)
    .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
    // 同一 join 同时承载完整历史与 cutoff 窗口，避免两个 proof 查询形状漂移。
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        eq(MessageTable.session_id, sessionID),
        ...(cutoff ? [atOrNewer(cutoff)] : []),
      ),
    )
    .orderBy(MessageTable.time_created, MessageTable.id, PartTable.id)
    .all()
    .pipe(Effect.orDie)
  const parts = new Map<MessageID, unknown[]>()
  for (const row of partRows) {
    // Part ID 顺序覆盖 pending→running→terminal 的同 row replacement；primitive worktree marker 变化也必须让对应 Message proof miss。
    const list = parts.get(row.messageID) ?? []
    list.push([row.id, row.timeCreated, row.timeUpdated, row.data, row.coldRef, row.coldKey, row.coldStats])
    parts.set(row.messageID, list)
  }
  return {
    // boundary 单独比较，row prefix 相同也不能跨 summary/tail 重排复用。
    boundary: JSON.stringify(boundary ?? null),
    // key 保存完整 tuple 而非 hash，避免 collision 成为错误 admission。
    messages: messageRows.map((row) => ({
      id: row.id,
      // zstd(level 1)转latin1无损保存完整tuple，保留exact相等且不让warm槽重复常驻原文。
      key: encodeProofKey(JSON.stringify([
        row.id,
        row.timeCreated,
        row.timeUpdated,
        row.data,
        row.coldRef,
        row.coldKey,
        parts.get(row.id) ?? [],
      ])),
    })),
  }
})

// #557：首个 mismatch 必须 inclusive hydrate，同一 Assistant 新增 Part 才会替换旧版本；
// hidden row 也进入 suffix，最终可见性仍由唯一 filterCompacted owner 决定。
  // #557：suffix loader 与 proof 同源——mismatch 点 inclusive，保证同 Message 原位更新可重载。
export function promptWindowSuffix(sessionID: SessionID, fromMessageID: MessageID) {
  return stream(sessionID, { fromMessageID, includeHidden: true })
}

// filterCompacted 会重排 Provider window，因此 latest 仍须比较每条 Message 的持久 chronology。
// #557：compareChronology 是唯一 comparator——time.created 主序，ID 只作同毫秒平局。
// #242：compaction 不再是可重放任务——生产者直接执行，消费端只保留已完成边界，
// 这防止旧 compact 标记重启压缩。tasks 因此只剩 subtask
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || compareChronology(info, user) > 0)) user = info
    if (info.role === "assistant" && (!assistant || compareChronology(info, assistant) > 0)) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || compareChronology(info, finished) > 0)) finished = info
  }
  // #557：tasks 只属于最新 completed Assistant 之后的 persisted chronology；Provider window 的重排位置不能改变这个消费边界。
  const tasks = msgs.flatMap((m) =>
    finished && compareChronology(m.info, finished) <= 0
      ? []
      : m.parts.filter((p): p is SubtaskPart => p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      // #192：statusless 非重试 APIError 的 cause 可能是 transport
        // #192：仅当无 statusCode 时才查 cause，4xx 有明确状态码不应被 cause 改写
      if (!parsed.isRetryable && parsed.statusCode === undefined) {
        const transport = transportError(e.cause)
          // #192：此处返回的是升级后的 APIError，重试性与 message 来自 transport 判定
        if (transport) return new APIError({ message: transport.message, isRetryable: true, metadata: transport.metadata }, { cause: e }).toObject()
      }
      return new APIError(
        { message: parsed.message, statusCode: parsed.statusCode, isRetryable: parsed.isRetryable, responseHeaders: parsed.responseHeaders, responseBody: parsed.responseBody, metadata: parsed.metadata },
        { cause: e },
      ).toObject()
    case !ctx.aborted && !APICallError.isInstance(e) && (() => {
      // #191：ctx.aborted 表示用户主动取消，不得转为可重试错误
      // #191：在 catch-all 之前检查 transport 层瞬时故障
      // #192：先解包 RetryError，再查 apiCallErrorCause/streamError/transportError
      if (retryErrorCause(e)) return true
      // #192：非 APICallError 的 cause 链中可能藏 APICallError，需优先解析
      if (apiCallErrorCause(e)) return true
      // #192：结构化 stream 错误（含 code/type）比 transport 判定更具体，优先采用，防 context_overflow 被误重试
      if (streamError(e)) return true
      // #191：transportError 命中时返回 true
      return Boolean(transportError(e))
    })():
      // #191：RetryError 解包后递归调用 fromError
      {
        const retried = retryErrorCause(e)
        if (retried) return fromError(retried, ctx)
        // #192：递归返回的 APICallError 作为新错误重走 fromError，保持分类一致
        const apiCall = apiCallErrorCause(e)
        if (apiCall) return fromError(apiCall, ctx)
        // #192：fromStreamError 用 parsed 结构构造 ContextOverflow/APIError，responseBody 完整透传，避免 overflow 误判为网络故障
        const stream = streamError(e)
        if (stream) return fromStreamError(e, stream)
        // #191：transport 层瞬时故障转为可重试 APIError
          // #191：isRetryable=true 是 retryable() 的入口契约，metadata 保留原始错误信息
        const transport = transportError(e)
        if (transport) {
          return new APIError(
            {
              message: transport.message,
              isRetryable: true,
              metadata: transport.metadata,
            },
            { cause: e },
          ).toObject()
        }
      }
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    case APIError.isInstance(e):
      // [local-smark] 已分类的 APIError 直接透传，避免被降级为 UnknownError。
      // 触发场景：processor.ts finish-step 检测到 provider 空完成时抛出 APIError，
      // fromError 必须保持其 isRetryable 分类，否则 SessionRetry 不会重试。
      return e.toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}


// #191：errorLike 统一 Error 与裸对象两种形态，使 cause 链检查覆盖非标准错误包装
type ErrorLike = {
  name?: unknown
  message?: unknown
  code?: unknown
  syscall?: unknown
  cause?: unknown
  lastError?: unknown
  errors?: unknown
}

// #191：安全提取 Error-like 属性，兼容 Error 和普通对象
// #191：非 Error 对象也可能有 code/cause，需兼容裸对象
function errorLike(value: unknown): ErrorLike | undefined {
  if (value instanceof Error) return value as ErrorLike
  if (typeof value === "object" && value !== null) return value as ErrorLike
  return undefined
}

// #191：stringValue 统一 code/name/syscall 为字符串比较，避免数字或符号混入判定
// #191：防止 number/undefined 混入 code 判定
function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// #191：解包 AI SDK RetryError，取 lastError 或 errors 末尾
// #191：只处理 AI_RetryError，其他包装错误不拆
// #191：lastError 是 AI SDK 记录的最终失败，优先于 errors 数组；两者都不存在时不拆
function retryErrorCause(value: unknown) {
  const error = errorLike(value)
  if (!error) return undefined
  if (stringValue(error.name) !== "AI_RetryError") return undefined
  if (error.lastError !== undefined && error.lastError !== value) return error.lastError
  if (!Array.isArray(error.errors)) return undefined
  const last = error.errors.at(-1)
  // #191：避免自引用死循环
  return last === value ? undefined : last
}

// #191：递归判定 transport 层瞬时故障，最多展开 2 层 cause
// #191：ECONNRESET 顶层 switch 已有专门 case，嵌套时才走 transport
function transportError(value: unknown, depth = 0): { message: string; metadata: Record<string, string> } | undefined {
  const error = errorLike(value)
  if (!error) return undefined

  const code = stringValue(error.code)
  // #191：code/name/message 三级判定：code 优先，其次 name，最后消息文本兜底
  const name = stringValue(error.name)
  const message = errorMessage(value)
  const syscall = stringValue(error.syscall)
  const retryCode = code
  // #191：ECONNRESET 仅在嵌套 cause 时视为可重试，顶层由既有 case 处理，避免重复分类
    ? code === "ECONNRESET" && depth > 0
      ? code
      : TRANSIENT_TRANSPORT_CODES.has(code)
        // #191：transport 码集合是跨 provider 的稳定性契约，新增码需同步测试
        ? code
        : undefined
    : name === "TimeoutError"
      ? "TimeoutError"
      : message === "SSE read timed out"
        // #191：消息兜底用于未携带 code 的 provider 超时错误，保证重试语义一致
        ? "SSE_READ_TIMEOUT"
        : undefined
  // #191：fetch failed / cannot connect 也视为可重试
  const retryable =
    retryCode !== undefined ||
    message === "fetch failed" ||
    message === "failed to fetch" ||
    message.startsWith("Cannot connect to API:") ||
    // 仅在无 code 时兜底匹配 socket close message；有 code 的 ECONNRESET 等
    // 由 fromError switch(true) 中的专用 case 处理，保持 "Connection reset by server" 消息
    !code && message.includes("socket connection was closed")
    // #191：fetch failed 是 Node/undici 网络层通用包装，Cannot connect 是代理层提示，二者均属瞬时故障

  if (retryable) {
    // #191：部分 provider 用裸消息而非错误码表达网络失败，因此消息匹配不可省略
    return {
      message,
      // #191：仅附加非空元数据
        // #191：metadata.message 恒存在供下游展示，code/name/syscall 仅在有值时附加
      metadata: {
        message,
        ...(retryCode ? { code: retryCode } : {}),
        ...(name ? { name } : {}),
        ...(syscall ? { syscall } : {}),
      },
    }
  }

  // #191：递归检查 cause 链，限制深度防死循环
  // #191：cause 链可能成环（错误对象互相引用），depth 上限 2 是防死循环的硬边界
  // #191：cause === value 直接截断自引用环，depth 上限兜底深链，保证判定必然终止
  if (depth >= 2 || error.cause === undefined || error.cause === value) return undefined
  return transportError(error.cause, depth + 1)
}

// #192：非 APICallError 的 cause 链中查找 APICallError，限制深度防环
// #192：外层 Error 可能包装了 APICallError——需递归解包才能正确分类
function apiCallErrorCause(value: unknown, depth = 0) {
  const error = errorLike(value)
  if (!error || depth >= 2) return undefined
  const cause = error.cause
  if (!cause || cause === value) return undefined
  if (APICallError.isInstance(cause)) return cause
  return apiCallErrorCause(cause, depth + 1)
}

// #192：structured stream error 检查——保留完整 ParsedStreamError（含 responseBody）
// #192：responseBody 是 provider 返回的诊断体，丢弃会导致 context_overflow/api_error 丢失关键信息
// #192：递归检查 cause 链——stream error 可能被 fetch wrapper 或 RetryError 包裹
// #192：返回完整 parsed 对象——fromStreamError 需要 responseBody 构造错误
function streamError(value: unknown): NonNullable<ReturnType<typeof ProviderError.parseStreamError>> | undefined {
  const parsed = ProviderError.parseStreamError(value)
  if (parsed) return parsed
  // #192：stream error 可能藏在多层 cause 中，递归一层即覆盖 fetch wrapper 包装
  const error = errorLike(value)
  if (error && error.cause !== undefined && error.cause !== value) {
    const causeParsed = ProviderError.parseStreamError(error.cause)
    if (causeParsed) return causeParsed
  }
  return undefined
}

// #192：从 stream error 构造——context_overflow 走专用类型，保留 responseBody 供诊断
// #192：ContextOverflowError 不可重试——与 transport 故障区分
// #192：APIError 的 isRetryable 来自 ParsedStreamError——仅 api_error 变体有此字段
function fromStreamError(e: unknown, parsed: NonNullable<ReturnType<typeof ProviderError.parseStreamError>>) {
  if (parsed.type === "context_overflow") {
    return new ContextOverflowError(
      { message: parsed.message, responseBody: parsed.responseBody },
      { cause: e },
    ).toObject()
  }
  return new APIError(
    { message: parsed.message, isRetryable: parsed.isRetryable, responseBody: parsed.responseBody },
    { cause: e },
  ).toObject()
}

export * as MessageV2 from "./message-v2" 
export const node = LayerNode.group([Database.node])

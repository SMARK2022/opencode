export * as ToolDiffs from "./tool-diffs"

import path from "path"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { Database } from "../database/database"
import { ColdStorage } from "../storage/cold-storage"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { RequestUsageAssistantTable } from "./request-usage.sql"
import { MessageID } from "../v1/session"

// 同一聚合器只接收已完成、未隐藏工具的真实结果；两代各自负责消息适配和路径基准。
export function collect(records: readonly Record<string, unknown>[], base: string, fromBase = base): FileDiff.Info[] {
  const byFile = new Map<string, FileDiff.Info>()
  const merge = (file: string, patch: string, additions: number, deletions: number, status?: string) => {
    const rel = path.relative(base, path.isAbsolute(file) ? file : path.resolve(fromBase, file)).replaceAll("\\", "/")
    const hit = byFile.get(rel)
    // 延续source的patch拼接、计数相加和新增/删除优先，不误称为重新计算磁盘净diff。
    byFile.set(rel, { file: rel, patch: (hit?.patch ?? "") + patch,
      additions: (hit?.additions ?? 0) + additions, deletions: (hit?.deletions ?? 0) + deletions,
      status: hit?.status === "added" || hit?.status === "deleted" ? hit.status
        : status === "add" || status === "added" ? "added"
        : status === "delete" || status === "deleted" ? "deleted"
        : status ? "modified" : deletions === 0 && additions > 0 ? "added"
        : additions === 0 && deletions > 0 ? "deleted" : "modified",
    })
  }
  for (const meta of records) {
    if (Array.isArray(meta.files) && meta.files.length) {
      for (const entry of meta.files) {
        if (!record(entry)) continue
        // relativePath/filePath属于V1，file属于Native；相对项由调用方显式指定来源根。
        const file = string(entry.relativePath) ?? string(entry.filePath) ?? string(entry.file)
        if (file) merge(file, string(entry.patch) ?? "", number(entry.additions), number(entry.deletions), string(entry.type) ?? string(entry.status))
      }
      continue
    }
    if (record(meta.filediff)) {
      const file = string(meta.filediff.file)
      if (file) merge(file, string(meta.filediff.patch) ?? "", number(meta.filediff.additions), number(meta.filediff.deletions))
      continue
    }
    const diff = string(meta.diff)
    const file = string(meta.filepath) ?? string(meta.target) ?? string(meta.resource)
    if (!diff || !file) continue
    // Write按最终回读patch统计，排除unified文件头；Native的新建状态由真实existed字段判定。
    const stats = diff.split("\n").reduce((sum, line) => ({
      additions: sum.additions + Number(line.startsWith("+") && !line.startsWith("+++")),
      deletions: sum.deletions + Number(line.startsWith("-") && !line.startsWith("---")),
    }), { additions: 0, deletions: 0 })
    merge(file, diff, stats.additions, stats.deletions, typeof meta.existed === "boolean" ? meta.existed ? "modified" : "added" : undefined)
  }
  return [...byFile.values()]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

const decode = Schema.decodeUnknownSync(SessionMessage.Message)
const hidden = Schema.is(SessionMessage.Hidden)

export const summarize = Effect.fn("ToolDiffs.summarize")(function* (db: Database.Interface["db"], input: {
  sessionID: SessionSchema.ID
  assistantMessageID: SessionMessage.ID
  directory: string
  worktree: string
}) {
  const owner = yield* db.select({ requestID: RequestUsageAssistantTable.request_id }).from(RequestUsageAssistantTable).where(and(
    eq(RequestUsageAssistantTable.session_id, input.sessionID), eq(RequestUsageAssistantTable.assistant_message_id, MessageID.make(input.assistantMessageID)),
  )).get().pipe(Effect.orDie)
  if (!owner) return
  const messageID = SessionMessage.ID.make(owner.requestID)
  const user = yield* db.select({ type: SessionMessageTable.type }).from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, messageID),
  )).get().pipe(Effect.orDie)
  // 归属使用已冻结的当前request，不把审查synthetic或同根压缩请求伪装成用户prompt。
  if (user?.type !== "user") return
  const rows = yield* db.select({ message: SessionMessageTable })
    .from(SessionMessageTable).innerJoin(RequestUsageAssistantTable, and(
      eq(RequestUsageAssistantTable.session_id, SessionMessageTable.session_id),
      eq(RequestUsageAssistantTable.assistant_message_id, SessionMessageTable.id),
    )).where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(RequestUsageAssistantTable.request_id, owner.requestID)))
    .orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  // 内部摘要按精确request/seq选集恢复内存副本，不把业务历史持久预热。
  const restored = yield* Database.withSync({ db, sync: db.sync }, sync =>
    ColdStorage.inspectSessionMessageRows(sync, rows.map(row => row.message).filter(row => !hidden(row.data.metadata?.hidden))),
  )
  const messages = restored.map(row => decode({ ...row.data, id: row.id, type: row.type }))
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant" && !hidden(message.metadata?.hidden))
  // Native与V1同样只消费当前请求的完成工具；整树快照既不参与归因，也不再吞错补成功。
  const byTool = collect(messages.flatMap(message => message.content.flatMap(part =>
    part.type === "tool" && part.state.status === "completed" ? [part.state.structured] : [],
  )), input.worktree, input.directory)
  return { messageID, diffs: byTool }
})

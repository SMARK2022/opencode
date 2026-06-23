import { SessionID, MessageID } from "./schema"
import { CompactionFileEvidence } from "./file-evidence"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionMemento } from "@opencode-ai/core/session/compaction-memento"
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
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import { formatCompactionClearedNotice, truncateForCompaction } from "@/util/output-notice"
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
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputTruncation?: { head: number; tail: number } },
) {
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
          assistantMessage.parts.push({
            type: "text",
            text,
            // 证据标记属于本地存储，不是 provider 参数；保留正文但不污染 SDK 的元数据契约。
            ...(differentModel || part.metadata?.kind === CompactionFileEvidence.kind ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? formatCompactionClearedNotice()
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
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
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

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
  // 显式审计读取保留隐藏内容，普通分页在 LIMIT 前筛选可见消息。
  includeHidden?: boolean
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
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
  const items = (yield* hydrate(db, slice)).map((item) =>
    input.includeHidden ? item : { ...item, parts: item.parts.filter((part) => !part.hidden) },
  )
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

// #98：stream 默认过滤 hidden；includeHidden 供审计/恢复读取
export function stream(sessionID: SessionID, opts?: { includeHidden?: boolean }) {
  // includeHidden 默认 false：正常流不返回被撤销隐藏的消息和 part
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before, includeHidden: opts?.includeHidden }).pipe(
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

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  // #106：message 缺失同样 Effect.fail
  if (!row) return yield* Effect.fail(new NotFoundError({ message: `Message not found: ${input.messageID}` }))
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  // #204：压缩标记须按 newest→oldest 扫描——summary assistant 先于 parent compaction user 出现，才能停止遍历并恢复 retained tail
  // #204：沿用分页的时间/ID顺序；导入消息的ID未必单调，不能覆盖它们真实的创建顺序。
  const ordered = Array.from(msgs).toSorted((a, b) => b.info.time.created - a.info.time.created || b.info.id.localeCompare(a.info.id))
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  // #205：hidden 消息仍可作结构压缩锚点，但 undo/repair 后绝不能重放给 provider
  // #205：边界遍历时保留它们，仅从返回的 prompt 窗口剔除
  // #242：悬挂 compaction 清理链在 #205 hidden 剔除之后执行——hidden 锚点参与边界遍历、
// 但与被取消的压缩标记一样绝不能出现在返回的 prompt 窗口
const visible = (items: SessionV1.WithParts[]) =>
  visibleCompactions(
    items
      .filter((msg) => !msg.info.hidden)
      .map((msg) => ({ ...msg, parts: msg.parts.filter((part) => !part.hidden) })),
  )
  // #204：遍历 newest-first 序列，发现 summary→compaction 边界并锁定 retained tail
  for (const msg of ordered) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
      completed.add(msg.info.parentID)
    }
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
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
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return visible([
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ])
  }
  return visible(result)
}

function visibleCompactions(items: SessionV1.WithParts[]) {
  // #242：只有 user(compaction) 与已完成且无错的摘要 assistant 配对才是持久边界；
  // 悬挂标记/摘要是本地维护残渣——在 prompt 重放与 latest 任务检测看到它们之前剔除，
  // 否则会复活旧 compact 或把「What did we do so far?」注入后续 user prompt
  const compactions = new Set(
    items
      .filter((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"))
      .map((msg) => msg.info.id),
  )
  const completed = new Set(
    items.flatMap((msg): MessageID[] => {
      if (msg.info.role !== "assistant") return []
      if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
      if (!compactions.has(msg.info.parentID)) return []
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
  // #205：压缩恢复需要 hidden 结构锚点作为边界；visible() 会从返回的 prompt 窗口剔除它们
  return filterCompacted(yield* stream(sessionID, { includeHidden: true }))
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. IDs are only a deterministic tie-breaker
// because imported messages do not necessarily have monotonic IDs.
// #242：compaction 不再是可重放任务——生产者直接执行，消费端只保留已完成边界，
// 这防止旧 compact 标记重启压缩。tasks 因此只剩 subtask
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && isAfter(info, user)) user = info
    if (info.role === "assistant" && isAfter(info, assistant)) assistant = info
    if (info.role === "assistant" && info.finish && isAfter(info, finished)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && !isAfter(m.info, finished)
      ? []
      : m.parts.filter((p): p is SubtaskPart => p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

function isAfter(info: Info, other?: Info) {
  if (!other) return true
  if (info.time.created !== other.time.created) return info.time.created > other.time.created
  return info.id > other.id
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
    message.startsWith("Cannot connect to API:")
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

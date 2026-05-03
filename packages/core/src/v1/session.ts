export * as SessionV1 from "./session"

import { Schema, Types } from "effect"
import { NonNegativeInt } from "../schema"
import { NamedError } from "../util/error"
import type { SessionTable } from "../session/sql"
import { MessageID, PartID, SessionInfo } from "@opencode-ai/schema/session-v1"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import type { Session } from "@opencode-ai/schema/session"

export {
  AgentPart,
  AgentPartInput,
  Assistant,
  CompactionPart,
  Event,
  FilePart,
  FilePartInput,
  FilePartSource,
  FileSource,
  Format,
  Info,
  MessageID,
  OutputFormatJsonSchema,
  OutputFormatText,
  Part,
  PartID,
  PatchPart,
  Range,
  ReasoningPart,
  ResourceSource,
  RetryPart,
  SessionInfo,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SubtaskPart,
  SubtaskPartInput,
  SymbolSource,
  TextPart,
  TextPartInput,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
  User,
  WithParts,
} from "@opencode-ai/schema/session-v1"

// 同一 V1 协议的 HTTP 与事件投影共用此映射，字段演进时只维护一处。
export function fromRow(row: typeof SessionTable.$inferSelect & { request?: Session.RequestUsage }): Types.DeepMutable<typeof SessionInfo.Type> {
  // summary_files 单独存在也代表有效摘要，不能只检查增删行数。
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  // 没有分享 URL 时省略整个对象，避免把未分享会话序列化成空链接。
  const share = row.share_url ? { url: row.share_url } : undefined
  // revert 的消息和 part ID 各有品牌，不能把两个字段当作同一种标识转换。
  const revert = row.revert
    ? {
        messageID: MessageID.make(row.revert.messageID),
        partID: row.revert.partID ? PartID.make(row.revert.partID) : undefined,
        snapshot: row.revert.snapshot,
        diff: row.revert.diff,
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    // 存储的 nullable placement 字段转换成 V1 可选属性，不把 null 带入旧 wire 契约。
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    // V1 的 variant 允许缺省；当前协议 mapper 补 default 会改变旧会话的模型选择。
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    // 缓存和分层模型价格不同，费用保留服务端账本，不能从 token 总数反推。
    cost: row.cost,
    // 复制请求快照供旧可变调用方使用；不能让插件改写查询结果的嵌套模型信息。
    // tokens 和 cost 仍是原有全局范围，request 只是并列的公开读投影。
    request: row.request ? {
      ...row.request, model: row.request.model ? { ...row.request.model } : undefined,
      // 兼容调用方可变；复制新细分对象，避免修改返回值时污染同一查询快照。
      inputEstimate: row.request.inputEstimate ? {
        ...row.request.inputEstimate,
        inputBreakdown: row.request.inputEstimate.inputBreakdown ? {
          ...row.request.inputEstimate.inputBreakdown,
          messages: { ...row.request.inputEstimate.inputBreakdown.messages },
        } : undefined,
      } : undefined,
    } : undefined,
    // cache 两项保持独立；消费方会加回输入流量，提前折入 input 会重复计数。
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    // metadata 的未知键也要 round-trip，不能因当前协议没有这些字段而丢掉插件信息。
    metadata: row.metadata ?? undefined,
    revert,
    // 旧调用方拿到可变权限数组；复制以免修改返回值时连带改变存储行的快照。
    permission: row.permission ? [...row.permission] : undefined,
    // 旧协议保持毫秒数；归档时间 0 也有效，不能用 truthy 判断或转成 DateTime。
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})
export const AuthError = NamedError.create("ProviderAuthError", { providerID: Schema.String, message: Schema.String })
export const AbortedError = NamedError.create("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = NamedError.create("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = NamedError.create("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = NamedError.create("ContentFilterError", { message: Schema.String })

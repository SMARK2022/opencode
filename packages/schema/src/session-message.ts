export * as SessionMessage from "./session-message"

import { Schema } from "effect"
import { FileDiff } from "./file-diff"
import { optional } from "./schema"
import { ProviderMetadata, ToolContent } from "./llm"
import { Model } from "./model"
import { FileAttachment, Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt, RelativePath, statics } from "./schema"
import { SessionID } from "./session-id"
import { ascending } from "./identifier"

export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("Session.Message.ID"),
  statics((schema) => ({ create: () => schema.make("msg_" + ascending()) })),
)
export type ID = typeof ID.Type

export interface UnknownError extends Schema.Schema.Type<typeof UnknownError> {}
export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
}).annotate({ identifier: "Session.Error.Unknown" })

// 协议修复只改变可见性，原文、错误及用量继续保存在原消息上。
export interface Hidden extends Schema.Schema.Type<typeof Hidden> {}
export const Hidden = Schema.Struct({
  time: NonNegativeInt,
  reason: Schema.Literal("permission-reviewer-protocol-retry"),
}).annotate({ identifier: "Session.Message.Hidden" })

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

export interface AgentSwitched extends Schema.Schema.Type<typeof AgentSwitched> {}
export const AgentSwitched = Schema.Struct({
  ...Base,
  type: Schema.Literal("agent-switched"),
  agent: Schema.String,
}).annotate({ identifier: "Session.Message.AgentSwitched" })

export interface ModelSwitched extends Schema.Schema.Type<typeof ModelSwitched> {}
export const ModelSwitched = Schema.Struct({
  ...Base,
  type: Schema.Literal("model-switched"),
  model: Model.Ref,
}).annotate({ identifier: "Session.Message.ModelSwitched" })

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  // 仅完成事件写入本prompt的改动；旧记录不携带时保持缺省，不从其它会话补值。
  summary: Schema.Struct({ diffs: Schema.Array(FileDiff.Info) }).pipe(optional),
  type: Schema.Literal("user"),
}).annotate({ identifier: "Session.Message.User" })

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({
  ...Base,
  sessionID: SessionID,
  text: Schema.String,
  type: Schema.Literal("synthetic"),
}).annotate({ identifier: "Session.Message.Synthetic" })

export interface System extends Schema.Schema.Type<typeof System> {}
export const System = Schema.Struct({
  ...Base,
  type: Schema.Literal("system"),
  text: Schema.String,
}).annotate({ identifier: "Session.Message.System" })

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  ...Base,
  type: Schema.Literal("shell"),
  callID: Schema.String,
  command: Schema.String,
  output: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Shell" })

export interface ToolStatePending extends Schema.Schema.Type<typeof ToolStatePending> {}
export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.String,
}).annotate({ identifier: "Session.Message.ToolState.Pending" })

export interface ToolStateRunning extends Schema.Schema.Type<typeof ToolStateRunning> {}
export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
}).annotate({ identifier: "Session.Message.ToolState.Running" })

export interface ToolStateCompleted extends Schema.Schema.Type<typeof ToolStateCompleted> {}
export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  attachments: FileAttachment.pipe(Schema.Array, optional),
  content: ToolContent.pipe(Schema.Array),
  outputPaths: Schema.Array(Schema.String).pipe(optional),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Completed" })

export interface ToolStateError extends Schema.Schema.Type<typeof ToolStateError> {}
export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  error: UnknownError,
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Error" })

export const ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTool extends Schema.Schema.Type<typeof AssistantTool> {}
export const AssistantTool = Schema.Struct({
  type: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  provider: Schema.Struct({
    executed: Schema.Boolean,
    metadata: ProviderMetadata.pipe(optional),
    resultMetadata: ProviderMetadata.pipe(optional),
  }).pipe(optional),
  state: ToolState,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    ran: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
    pruned: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant.Tool" })

export interface AssistantText extends Schema.Schema.Type<typeof AssistantText> {}
export const AssistantText = Schema.Struct({
  type: Schema.Literal("text"),
  id: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "Session.Message.Assistant.Text" })

export interface AssistantReasoning extends Schema.Schema.Type<typeof AssistantReasoning> {}
export const AssistantReasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  text: Schema.String,
  providerMetadata: ProviderMetadata.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Reasoning" })

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool

// 五类共享同一份 prepared JSON 字符基数；消息子项不包含已归系统的 system/developer 消息。
export interface InputBreakdown extends Schema.Schema.Type<typeof InputBreakdown> {}
export const InputBreakdown = Schema.Struct({
  system: NonNegativeInt,
  instructions: NonNegativeInt,
  skills: NonNegativeInt,
  tools: NonNegativeInt,
  messages: Schema.Struct({
    userText: NonNegativeInt,
    assistantText: NonNegativeInt,
    reasoning: NonNegativeInt,
    toolInput: NonNegativeInt,
    toolOutput: NonNegativeInt,
    attachments: NonNegativeInt,
    // 包含归属消息的 JSON 结构开销，六个子项之和就是 total。
    total: NonNegativeInt,
  }),
  // #175：media 与 messages 分列，避免 base64 污染文本密度
  // 未携带媒体的旧样本保持原字符口径，V1/V2 引用同一可选定义。
  media: optional(
    Schema.Struct({
      rawChars: NonNegativeInt,
      textChars: NonNegativeInt,
      tokens: NonNegativeInt,
      count: NonNegativeInt,
      imageTokens: NonNegativeInt,
      pdfTokens: NonNegativeInt,
      otherTokens: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "Session.Message.InputBreakdown" })

// 请求体估算与 provider tokens 分离；confirmed 只说明校准样本已经结算。
// bodyChars 保留实际请求体的字符基数，不能拿输出正文校准输入用量。
export interface InputEstimate extends Schema.Schema.Type<typeof InputEstimate> {}
export const InputEstimate = Schema.Struct({
  input: Schema.Finite,
  bodyChars: Schema.Finite,
  confirmed: Schema.Boolean,
  // 比率冻结在服务端准备时；客户端不再用被分页截断的历史重新校准。
  charsPerToken: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional),
  inputBreakdown: InputBreakdown.pipe(optional),
  afterPartID: Schema.String.pipe(optional),
  // 同轮解析出的显示预算独立于 token 校准样本，后续模型选择不能改写它。
  contextLimit: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Session.Message.InputEstimate" })

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  ...Base,
  type: Schema.Literal("assistant"),
  agent: Schema.String,
  model: Model.Ref,
  inputEstimate: InputEstimate.pipe(optional),
  content: AssistantContent.pipe(Schema.Array),
  snapshot: Schema.Struct({
    start: Schema.String.pipe(optional),
    end: Schema.String.pipe(optional),
    files: Schema.Array(RelativePath).pipe(optional),
  }).pipe(optional),
  finish: Schema.String.pipe(optional),
  cost: Schema.Finite.pipe(optional),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }).pipe(optional),
  error: UnknownError.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant" })

export interface Compaction extends Schema.Schema.Type<typeof Compaction> {}
export const Compaction = Schema.Struct({
  type: Schema.Literal("compaction"),
  reason: Schema.Literals(["auto", "manual"]),
  summary: Schema.String,
  recent: Schema.String,
  // 独立原话属于已完成的压缩边界；旧持久消息缺失时不制造新用户轮次。
  recent_user_messages: Schema.Array(Schema.Struct({
    id: ID, text: Schema.String, truncated: Schema.Boolean.pipe(optional),
  })).pipe(optional),
  // 只保存成功压缩时生成的确定性文件交接；旧消息缺失时保持原有回放。
  file_evidence: Schema.String.pipe(optional),
  ...Base,
}).annotate({ identifier: "Session.Message.Compaction" })

export const Message = Schema.Union([
  AgentSwitched,
  ModelSwitched,
  User,
  Synthetic,
  System,
  Shell,
  Assistant,
  Compaction,
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Message" })
export type Message = AgentSwitched | ModelSwitched | User | Synthetic | System | Shell | Assistant | Compaction
export type Type = Message["type"]

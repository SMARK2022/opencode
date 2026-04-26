export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { Revert } from "./revert"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

// 只公开当前请求的读投影；历史请求账本仍属于后续独立功能。
// messageID 标识用户请求，assistantID 标识最后一步，不能混用两种身份。
export interface RequestUsage extends Schema.Schema.Type<typeof RequestUsage> {}
export const RequestUsage = Schema.Struct({
  messageID: Schema.String,
  input: Schema.Finite,
  output: Schema.Finite,
  cost: Schema.Finite,
  assistantID: Schema.String.pipe(optional),
  // #14 才引入当前 step；请求累计 input/output 的范围保持不变。
  // 这两项来自最后一步确认值，不是从请求累计或会话累计反推。
  stepInput: Schema.Finite,
  stepOutput: Schema.Finite,
  // 未确认下一轮的上下文基数；缺省表示无在途估算，零表示已确认的零基数。
  pendingInput: Schema.Finite.pipe(optional),
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
  }).pipe(optional),
}).annotate({ identifier: "Session.RequestUsage" })

// 请求投影不替代 tokens；tokens 始终保留会话五项全量累计。
// 可选字段允许没有用户请求的会话容器和既有 wire 数据继续解码。
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  request: RequestUsage.pipe(optional),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}

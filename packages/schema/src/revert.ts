export * as Revert from "./revert"

import { Schema } from "effect"
import { optional } from "./schema"
import { NonNegativeInt, RelativePath } from "./schema"
import { SessionMessage } from "./session-message"

export const FileDiff = Schema.Struct({
  path: RelativePath,
  status: Schema.Literals(["added", "modified", "deleted"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  patch: Schema.String,
}).annotate({ identifier: "File.Diff" })
export interface FileDiff extends Schema.Schema.Type<typeof FileDiff> {}

export const State = Schema.Struct({
  messageID: SessionMessage.ID,
  partID: Schema.String.pipe(optional),
  snapshot: Schema.String.pipe(optional),
  diff: Schema.String.pipe(optional),
  files: Schema.Array(FileDiff).pipe(optional),
  // V1 revert 的精确恢复路径列表（绝对路径，opencode 侧 session revert 使用）；
  // 与 files（V2 FileDiff 语义）分键存储避免同键不同义。旧数据无此字段时
  // restore 退回 -- . 恢复整个目录。
  revertedPaths: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "Revert.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

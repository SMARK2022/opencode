export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  max_lines: PositiveInt.pipe(Schema.optional),
  // 描述默认而不填充默认值，避免上层缺省文档覆盖下层显式预算。
  max_bytes: PositiveInt.annotate({
    description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 24576)",
  }).pipe(Schema.optional),
  // 可选而非默认填充，分层合并时缺省值不能遮蔽较低层的显式 false。
  bash_compression: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable Bash output compression before truncation. Defaults to true. When enabled, repeated lines, repeated blocks, progress redraws, and obvious inline repeated patterns may be compacted while preserving the full raw output on disk.",
  }),
}) {}

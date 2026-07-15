export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

// models.dev's `reasoning_options`: OpenCode builds the model's reasoning variants from them.
const ReasoningOption = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Schema.NullOr(Schema.String)) }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  reasoning_options: Schema.optional(
    Schema.Array(ReasoningOption).annotate({
      description: "Reasoning controls the model accepts, used to build its variants",
    }),
  ),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  extends: Schema.optional(Schema.String).annotate({
    description: "Inherit models and defaults from an existing provider type",
  }),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        // #168：具名 headers，进入 JSON schema / 文档，而非仅 rest 透传
        headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
          description: "Additional HTTP headers to send to this provider.",
        }),
        // #168：header-ua 快捷键折叠为 User-Agent；显式 headers UA 优先
        "header-ua": Schema.optional(Schema.String).annotate({
          description: "Shortcut for setting the provider request User-Agent header.",
        }),
        // #147：自定义 provider（如 claudecode）客户端版本覆盖
        version: Schema.optional(Schema.String).annotate({
          description: "Provider-specific client version override, used by custom providers like claudecode",
        }),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            // [local-smark] 整请求绝对超时默认 10 分钟(600000):从 fetch 发起计时的硬死线,
            // 到点即中断(即使仍在持续来 chunk);显式数值/false 仍可覆盖。
            description: "Timeout in milliseconds for full requests to this provider. Default is 600000 (10 minutes). Set to false to disable timeout.",
          }),
        ).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Default is 600000 (10 minutes). Set to false to disable timeout.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds to wait for response headers (default: 300000). Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds to wait for response headers (default: 300000). Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              // [local-smark] chunk 空闲超时默认 3 分钟:挂起连接更早暴露;显式正值/false 仍可覆盖。
              // [local-smark] 文案与 progressDeadline 语义对齐：dispatch 起算、每块重置，
              // 旧文案只描述块间隔窗口，会误导 provider 集成方对超时行为的预期；false 禁用语义保留
              "Timeout in milliseconds from request dispatch to the first streamed SSE chunk and between subsequent chunks. Each received chunk resets the window. Default is 180000 (3 minutes). Set to false to disable timeout.",
          }),
        ).annotate({
          description:
              "Timeout in milliseconds from request dispatch to the first streamed SSE chunk and between subsequent chunks. Each received chunk resets the window. Default is 180000 (3 minutes). Set to false to disable timeout.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>

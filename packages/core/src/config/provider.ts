export * as ConfigProvider from "./provider"

import { Schema } from "effect"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

class Cache extends Schema.Class<Cache>("ConfigV2.Model.Cost.Cache")({
  read: Schema.Finite.pipe(Schema.optional),
  write: Schema.Finite.pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Cache.pipe(Schema.optional),
}) {}

class Limit extends Schema.Class<Limit>("ConfigV2.Model.Limit")({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
}) {}

const ModelApi = Schema.Union([
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.AISDK.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.Native.fields,
  }),
  Schema.Struct({
    // 模型 URL/settings 可独立覆盖基础协议，别名 ID 也不是必填。
    id: ModelV2.ID.pipe(Schema.optional),
    // 禁止部分表示接纳无效协议标签，避免完整 SDK 配置被静默降级。
    type: Schema.Never.pipe(Schema.optional),
    package: Schema.Never.pipe(Schema.optional),
    url: Schema.String.pipe(Schema.optional),
    settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  // 仅承接 V1 迁移未决的 SDK options，不作为 provider wire body 发出。
  v1: Schema.Struct({
    options: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    // variant 同模型等待实际基础 SDK，不能在 npm 缺省时提前按 raw 转换。
    variants: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).pipe(Schema.optional),
    // 显式 false 只抑制缺省变体推断，不把能力元数据改写成请求的 disabled thinking。
    reasoning: Schema.Boolean.pipe(Schema.optional),
  }).pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  // V2 文档和迁移后的 V1 文档共享直接继承入口，不回调旧运行时。
  extends: ProviderV2.ID.pipe(Schema.optional),
  // provider 与模型统一保留 npm 未决的原始输入，等有效 API 确定后再转换。
  v1: Schema.Struct({
    options: Schema.Record(Schema.String, Schema.Unknown),
  }).pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  // 只有 URL/settings 的覆盖不能被误编码成 native，从而丢掉基础 SDK。
  api: Schema.Union([
    ProviderV2.Api,
    Schema.Struct({
      // 部分覆盖不得吞掉无效的显式 type/package，完整协议仍由原 union 校验。
      type: Schema.Never.pipe(Schema.optional),
      package: Schema.Never.pipe(Schema.optional),
      url: Schema.String.pipe(Schema.optional),
      settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    }),
  ]).pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}

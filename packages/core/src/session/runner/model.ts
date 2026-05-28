export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Config } from "../../config"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { CodexHeaders } from "../../plugin/provider/codex-headers"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  // 期限仅在 Core resolver/runner 间携带，不进入公开 Model Schema 或 provider JSON。
  // 资格绑定本次实际凭据，仅供内部审查使用，不把token或身份标记发给模型。
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<{ readonly model: Model & { readonly timeout?: number | false }; readonly pricing: ModelV2.Info["cost"]; readonly openaiOAuth: boolean }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

// 测试和嵌入入口可显式提供价格；未配置价格的模型仍按免费模型处理。
export const layerWith = (
  resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>,
  pricing: ModelV2.Info["cost"] = [],
) => Layer.succeed(Service, Service.of({
  resolve: session => resolve(session).pipe(Effect.map(model => ({ model, pricing: [...pricing], openaiOAuth: false }))),
}))

export const cost = (pricing: ModelV2.Info["cost"], tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => {
  // 阶梯按完整输入上下文选择；非缓存输入和缓存读写仍按各自单价结算。
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const rate = pricing.filter(item => item.tier && context > item.tier.size)
    .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ?? pricing.find(item => !item.tier)
  if (!rate) return 0
  // 已分栏的 reasoning 与可见输出合并一次收费，不能再次扣减或重复计算。
  return Math.max(0, (tokens.input * rate.input + (tokens.output + tokens.reasoning) * rate.output
    + tokens.cache.read * rate.cache.read + tokens.cache.write * rate.cache.write) / 1_000_000)
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (ProviderV2.isClaudeCode(model)) {
    // V1 lowerer 把 apiKey 放进 x-api-key，只查 body/settings 会漏掉这份配置凭据。
    const configured = model.request.body.apiKey ?? model.api.settings?.apiKey ??
      Object.entries(model.request.headers).find(([key]) => key.toLowerCase() === "x-api-key")?.[1]
    // 已验证的派生身份沿源读取两类环境密钥、自己的保存凭据，最后才用配置 lowerer 的密钥。
    const value = process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDECODE_API_KEY ||
      (credential?.type === "key" ? credential.key : undefined) || (typeof configured === "string" && configured)
    // OAuth access 不是源补丁支持的 API key，不在这里偷偷增加另一种认证来源。
    return value ? Auth.value(value) : undefined
  }
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  // 只有专用 Anthropic 路由消费这些字段；其他协议的 body 投影不扩大本补丁范围。
  const claudecode = ProviderV2.isClaudeCode(model)
  const anthropic = model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic" &&
    (claudecode || body.__opencodeReasoning === true || ProviderV2.isAnthropicThinkingModel(model.api.id))
  // 源补丁按 provider ID 或 SDK package 识别 OpenAI 系列，不扩大普通兼容服务默认值。
  const parallel = model.providerID === "openai" || (model.api.type === "aisdk" &&
    ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/github-copilot"].includes(model.api.package))
  const responses = model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai"
  // model/variant 的并行参数进入 typed provider options，禁止 HTTP 后置 overlay 抢占协议字段。
  // 能力标志只服务配置继承，不能混入 72 观察的 prepared JSON 或实际提供者请求。
  // 推断的 thinking/effort 同样交给唯一 typed lowering，不能由 HTTP 后置覆盖协议字段。
  // Responses配置指令也只交给typed lowering；请求级可信策略自然覆盖默认值。
  const httpBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey" && key !== "__opencodeReasoning" &&
    (!responses || key !== "instructions") && (!parallel || !["parallelToolCalls", "parallel_tool_calls"].includes(key)) && (!anthropic || !["thinking", "output_config"].includes(key)) && (!claudecode || !["system", "metadata"].includes(key))))
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    // protocol-owned 字段在 typed lowering 中处理，不能从 http.body 绕过校验覆盖 system/thinking。
    // 固定身份仅适用真实 OpenAI provider；显式配置保留优先级，不污染兼容服务。
    headers: claudecode ? Object.fromEntries(Object.entries(model.request.headers).filter(([key]) =>
      !["anthropic-beta", "user-agent", "x-app", "x-claude-code-session-id"].includes(key.toLowerCase()))) :
      model.providerID === ProviderV2.ID.openai ? CodexHeaders.request(model.request.headers) : model.request.headers,
    http: { body: httpBody },
    ...(anthropic || parallel ? { providerOptions: {
      ...(anthropic ? { anthropic: {
        thinking: body.thinking,
        output_config: body.output_config,
        ...(claudecode ? {
          // 标记来自已验证的 Catalog 继承；保持真实 provider ID，校准与历史匹配不能改成父 ID。
          claudeCode: true,
          version: model.api.settings?.version,
          betas: Object.entries(model.request.headers).flatMap(([key, value]) => key.toLowerCase() === "anthropic-beta" ? value.split(",") : []),
          system: body.system,
          metadata: body.metadata,
        } : {}),
      } } : {}),
      // 两个命名空间独立合并，不能为 ClaudeCode 或 Anthropic 丢弃其他提供者的并行参数。
      ...(parallel ? { openai: {
        parallelToolCalls: body.parallelToolCalls ?? body.parallel_tool_calls ?? true,
        ...(responses ? { instructions: body.instructions } : {}),
      } } : {}),
    } } : {}),
    // Catalog 的输入边界随同一解析 Model 交给压缩 owner，不放入 provider 请求正文。
    // 零是 Catalog 的未声明值，eligible Anthropic 应由实际协议决定 max_tokens，不能把它发成零限额。
    limits: { context: model.limit.context, input: model.limit.input, output: anthropic && model.limit.output === 0 ? undefined : model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  // credential metadata 可补充请求参数，但不能反过来抢占 ClaudeCode 的显式配置密钥。
  const key = apiKey(ProviderV2.isClaudeCode(model) ? model : resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    // 仅在已经确认的 Anthropic API 分支配置 ClaudeCode，不按名称强改其他显式协议。
    const claudecode = ProviderV2.isClaudeCode(resolved)
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({
          // 源服务使用 Bearer；清除另一个认证头避免同一请求携带两份凭据。
          auth: key === undefined ? Auth.none : claudecode ? Auth.remove("x-api-key").andThen(Auth.bearer(key)) : Auth.header("x-api-key", key),
          // Endpoint 已拥有 /messages 路径，base URL 只补一次 /v1，不拼接完整消息地址。
          // URL 环境覆盖与 token 环境覆盖独立；不改变 model API ID 或显式 package。
          ...(claudecode ? { endpoint: { baseURL: `${(process.env.ANTHROPIC_BASE_URL || resolved.api.url || process.env.CLAUDECODE_BASE_URL || "https://api.cubence.com").replace(/\/+$/, "").replace(/\/v1$/, "")}/v1` } } : {}),
        })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((model) => fromCatalogModel(model, credential).pipe(
      Effect.map((resolved) => {
        // V1 lowerer 已把运输 timeout 放入 api.settings；request.body 保持独立协议语义。
        const timeout = model.api.settings?.timeout
        return Object.assign(resolved, { timeout: timeout === false || typeof timeout === "number" ? timeout : undefined } as const)
      }),
    )),
  )

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const config = yield* Config.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        // 认证与资格使用同一次active解析；别名不借用基础账号的凭据。
        const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
        const base = credential?.type === "oauth" && selected.providerID !== ProviderV2.ID.openai
          ? (yield* config.entries()).flatMap(entry => entry.type === "document" ? [entry.info.providers?.[selected.providerID]?.extends] : []).findLast(value => value !== undefined)
          : undefined
        const openaiOAuth = credential?.type === "oauth" && (selected.providerID === ProviderV2.ID.openai || base === "openai")
        const model = yield* resolve(session, selected, credential)
        // ChatGPT凭据属于Codex后端，不能仅加instructions后仍发往普通API。
        const endpoint = openaiOAuth ? new URL(typeof selected.api.settings?.codexApiEndpoint === "string"
          ? selected.api.settings.codexApiEndpoint : "https://chatgpt.com/backend-api/codex/responses") : undefined
        const accountID = credential?.type === "oauth" && typeof credential.metadata?.accountID === "string" ? credential.metadata.accountID : undefined
        return {
          model: !endpoint ? model : Object.assign(Model.update(model, { route: model.route.with({
            endpoint: { baseURL: endpoint.origin, path: endpoint.pathname, query: Object.fromEntries(endpoint.searchParams) },
            headers: CodexHeaders.request({ ...model.route.defaults.headers, ...(accountID ? { "ChatGPT-Account-Id": accountID } : {}) }),
            providerOptions: { openai: { store: false } },
          }) }), { timeout: model.timeout }),
          // 价格与执行模型来自同一个 Catalog 选择，完成时不重新解析已切换的 Session。
          pricing: selected.cost,
          // 仅直接OpenAI或最后明确的直接继承命中；SDK、URL和多级别名不证明身份。
          openaiOAuth,
        }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node, Config.node] })

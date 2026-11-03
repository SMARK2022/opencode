export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { mergeJsonRecords } from "@opencode-ai/llm"
import { Config } from "../../config"
import { ConfigProvider } from "../provider"
import { Integration } from "../../integration"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const registry = yield* Integration.Service
    yield* registry.transform(
      Effect.fn(function* (integrations) {
        // 上游 owner 的记录不可删除，保存凭据另由 registry 查询，不复制基础账号。
        const initial = new Set(integrations.list().map((integration) => integration.id))
        const originals = new Map<Integration.ID, Integration.Implementation[]>()
        // 只克隆方法描述，函数仍复用原实现；凭据和连接从不成为继承数据。
        const methods = (id: Integration.ID) =>
          integrations.method.list(id).flatMap<Integration.Implementation>((method) => {
            if (method.type === "oauth") {
              const implementation = integrations.method.get(id, method.id)
              return implementation ? [{ ...implementation, method: structuredClone(method) }] : []
            }
            if (method.type === "key") return [{ integrationID: id, method: structuredClone(method) }]
            return [{ integrationID: id, method: structuredClone(method) }]
          })
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined ? [] : [id],
            ),
          ),
        )
        // 环境和名称保留先前显式层，切换基础只替换没有显式覆盖的默认值。
        const configured = new Map<string, ConfigProvider.Info>()
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = Integration.ID.make(id)
            const previous = configured.get(id)
            const provider = {
              ...item,
              extends: item.extends ?? previous?.extends,
              env: item.env ?? previous?.env,
              name: item.name ?? previous?.name,
            }
            configured.set(id, provider)
            if (provider.extends !== undefined) {
              // 先捕获基础以兼容自继承；换基础时清理旧继承，但不删除原有自有方法。
              const inherited = methods(Integration.ID.make(provider.extends))
              const own = originals.get(integrationID) ?? methods(integrationID)
              originals.set(integrationID, own)
              for (const method of [...integrations.method.list(integrationID)])
                integrations.method.remove(integrationID, method)
              for (const implementation of [...inherited, ...own])
                integrations.method.update({ ...implementation, integrationID })
            }
            // 显式环境覆盖最后应用，env:[] 不得同时禁用独立 key/OAuth 登录。
            const env =
              provider.env ??
              (provider.extends === undefined
                ? undefined
                : (integrations.method
                    .list(Integration.ID.make(provider.extends))
                    .find((method) => method.type === "env")?.names ?? []))
            if (env === undefined && !configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            // 无鉴权基础不制造空 Integration；只清除本 owner 自动创建且无自有认证的记录。
            if (
              provider.env === undefined &&
              env?.length === 0 &&
              integrations.method.list(integrationID).every((method) => method.type === "env")
            ) {
              const method = integrations.method.list(integrationID).find((method) => method.type === "env")
              if (method) integrations.method.remove(integrationID, method)
              if (
                !initial.has(integrationID) &&
                integrations.method.list(integrationID).length === 0 &&
                (yield* registry.connection.active(integrationID))?.type !== "credential"
              )
                integrations.remove(integrationID)
              continue
            }
            integrations.update(integrationID, (integration) => {
              // 派生名称默认取新 ID，不能泄露基础提供者的显示名。
              integration.name = provider.name ?? (provider.extends === undefined ? integration.name : id)
            })
            if (env !== undefined) {
              integrations.method.update({
                integrationID,
                // 空数组也是显式覆盖，不能通过 truthy 判断恢复基础环境变量。
                method: { type: "env", names: [...env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        // 累积原始配置层而非继承结果，每次都从当前直接基础重建再重放显式覆盖。
        const configured = new Map<string, ConfigProvider.Info[]>()
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = id
            const overrides = [...(configured.get(id) ?? []), item]
            configured.set(id, overrides)
            const baseType = overrides.findLast((layer) => layer.extends !== undefined)?.extends
            // #147：缺少 claudecode 目录时继承 Anthropic 模型，派生身份仍由原配置决定。
            const base =
              baseType === undefined
                ? undefined
                : (catalog.provider.get(baseType) ??
                  (baseType === "claudecode" ? catalog.provider.get(ProviderV2.ID.anthropic) : undefined))
            // 删除派生记录前复制基础以支持 self extends；Draft.get 不投影，空 native 占位接纳基础 API，request 保持模型原值。
            const copy =
              base && baseType !== undefined
                ? {
                    provider: structuredClone(base.provider),
                    models: [...base.models.values()].map((model) => ({
                      ...structuredClone(model),
                      api: structuredClone(
                        model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
                          ? { ...base.provider.api, id: model.api.id }
                          : model.api,
                      ),
                    })),
                  }
                : undefined
            if (baseType !== undefined) catalog.provider.remove(providerID)
            if (copy) {
              // 删除旧模型集合后只克隆当前基础；A 独有模型不会在切到 B 后继续暴露。
              catalog.provider.update(providerID, (provider) => {
                Object.assign(provider, copy.provider, {
                  id: providerID,
                  name: item.name ?? id,
                  integrationID: copy.provider.integrationID === undefined ? undefined : id,
                })
              })
              for (const model of copy.models) {
                // Catalog.update 统一重绑 ID；api.id 仍是基础的实际服务端模型名。
                catalog.model.update(providerID, model.id, (draft) => Object.assign(draft, model))
              }
            }
            const layers = baseType === undefined ? [item] : overrides
            // 先应用所有 provider 层，再重放模型层，模型 URL/npm 始终高于 provider。
            for (const item of layers) {
              catalog.provider.update(providerID, (provider) => {
                if (item.name !== undefined) provider.name = item.name
                // 未指定协议的直接继承领取父类型的 SDK，部分 URL/settings 不能阻断缺省协议。
                if (
                  (baseType ?? providerID) === "claudecode" &&
                  item.api?.type === undefined &&
                  provider.api.type === "native"
                )
                  provider.api = {
                    type: "aisdk",
                    package: "@ai-sdk/anthropic",
                    url: provider.api.url,
                    settings: provider.api.settings,
                  }
                // 继承与部分 API 覆盖保留基础 settings；完整非继承配置仍保持上游替换语义。
                if (item.api !== undefined) {
                  const api = item.api.type === undefined ? provider.api : item.api
                  provider.api =
                    baseType !== undefined || item.api.type === undefined
                      ? {
                          ...api,
                          url: item.api.url ?? provider.api.url,
                          settings: mergeJsonRecords(provider.api.settings, item.api.settings) ?? {},
                        }
                      : { ...api }
                }
              })
              if (baseType !== undefined && item.api !== undefined) {
                // provider npm/URL 覆盖也必须到达继承模型，不能被旧模型 API 抢回。
                for (const model of catalog.provider.get(providerID)?.models.values() ?? []) {
                  catalog.model.update(providerID, model.id, (draft) => {
                    // 显式协议替换整份表示，不把旧 native/SDK 的判别字段混入新 API。
                    const api = item.api?.type === undefined ? draft.api : { ...item.api, id: draft.api.id }
                    draft.api = {
                      ...api,
                      url: item.api?.url ?? draft.api.url,
                      settings: mergeJsonRecords(draft.api.settings, item.api?.settings) ?? {},
                    }
                  })
                }
              }
            }
            // API 先完整定型，再按 host 层顺序转换 provider 输入，避免早期 package 烘焙进请求。
            for (const item of layers) {
              catalog.provider.update(providerID, (provider) => {
                const legacy =
                  item.v1 &&
                  ConfigProviderOptionsV1.get(
                    provider.api.type === "aisdk" ? provider.api.package : undefined,
                  ).provider({
                    ...item.v1.options,
                    // 同层显式 api URL 高于 options.baseURL，raw 域也沿现有 normalizeApi 处理。
                    ...(item.api?.url === undefined ? {} : { baseURL: item.api.url }),
                  })
                const url =
                  item.api?.url ??
                  legacy?.url ??
                  (typeof legacy?.body?.baseURL === "string" ? legacy.body.baseURL : undefined)
                if (url !== undefined) provider.api.url = url
                if (legacy?.settings !== undefined || item.api?.settings !== undefined)
                  provider.api.settings =
                    mergeJsonRecords(provider.api.settings, legacy?.settings, item.api?.settings) ?? {}
                // 既有 Catalog/resolver 以 body.apiKey 识别配置凭据，withDefaults 会在发送前剔除。
                if (typeof item.v1?.options.apiKey === "string") provider.request.body.apiKey = item.v1.options.apiKey
                Object.assign(provider.request.headers, legacy?.headers, item.request?.headers)
                // 只有继承合并基础默认值；普通配置继续按上游规则浅覆盖嵌套对象。
                Object.assign(
                  provider.request.body,
                  baseType === undefined
                    ? { ...legacy?.body, ...item.request?.body }
                    : mergeJsonRecords(provider.request.body, legacy?.body, item.request?.body),
                )
                if (baseType !== undefined && (legacy !== undefined || item.api !== undefined)) {
                  for (const model of catalog.provider.get(providerID)?.models.values() ?? []) {
                    catalog.model.update(providerID, model.id, (draft) => {
                      if (url !== undefined) draft.api.url = url
                      if (legacy?.settings !== undefined || item.api?.settings !== undefined)
                        draft.api.settings =
                          mergeJsonRecords(draft.api.settings, legacy?.settings, item.api?.settings) ?? {}
                    })
                  }
                }
              })
            }
            const claudeCode =
              providerID === "claudecode" ||
              baseType === "claudecode" ||
              (copy?.provider.api.type === "aisdk" &&
                copy.provider.api.package === "@ai-sdk/anthropic" &&
                copy.provider.api.settings?.claudeCode === true)
            catalog.provider.update(providerID, (provider) => {
              if (provider.api.type !== "aisdk" || provider.api.package !== "@ai-sdk/anthropic") return
              // 继承证明由此 owner 拥有，普通配置不能靠同名 settings 冒充 ClaudeCode。
              const settings = Object.fromEntries(
                Object.entries(provider.api.settings ?? {}).filter(([key]) => key !== "claudeCode"),
              )
              provider.api.settings = claudeCode ? { ...settings, claudeCode: true } : settings
            })
            // 模型层保留原顺序；未决转换读取最后显式 model API，否则使用已经定型的默认 API。
            const models = layers.flatMap((layer) => Object.entries(layer.models ?? {}))
            for (const [id, config] of models) {
              // 新别名从指定 api.id 的基础模型接纳默认值，再执行上游逐字段覆盖。
              const existing =
                baseType !== undefined && config.api?.id !== undefined
                  ? catalog.model.get(providerID, config.api.id)
                  : undefined
              if (existing && !catalog.model.get(providerID, id)) {
                // 独立副本保留 variant/cost/capabilities，不共享基础模型的可变数组。
                catalog.model.update(providerID, id, (model) => Object.assign(model, structuredClone(existing)))
              }
              catalog.model.update(providerID, id, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                if (config.api !== undefined) {
                  // 新模型的空 native 是占位；部分 URL 先接纳真实 provider API，再保留其 id/settings。
                  const providerApi = catalog.provider.get(providerID)?.provider.api
                  const api =
                    model.api.type === "native" &&
                    !model.api.url &&
                    Object.keys(model.api.settings).length === 0 &&
                    providerApi
                      ? { ...providerApi, id: model.api.id }
                      : model.api
                  model.api =
                    config.api.type === undefined
                      ? {
                          ...api,
                          id: config.api.id ?? api.id,
                          url: config.api.url ?? api.url,
                          settings: mergeJsonRecords(api.settings, config.api.settings) ?? {},
                        }
                      : { ...model.api, ...config.api }
                }
                // 仅有模型 ID/URL 的配置仍需继承 ClaudeCode 默认协议；显式 type/package 完整保留。
                if (
                  (baseType ?? providerID) === "claudecode" &&
                  item.api?.type === undefined &&
                  (config.api === undefined || config.api.type === undefined) &&
                  model.api.type === "native"
                )
                  model.api = {
                    type: "aisdk",
                    package: "@ai-sdk/anthropic",
                    id: model.api.id,
                    url: model.api.url,
                    settings: model.api.settings,
                  }
                // 模型专用设置也不能伪造继承证明，投影随后合并提供者的已验证标记。
                if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic")
                  model.api.settings = Object.fromEntries(
                    Object.entries(model.api.settings ?? {}).filter(([key]) => key !== "claudeCode"),
                  )
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                const v1 = config.v1
                // 仅复用纯 SDK lowerer；不猜 provider 名称，也不调用 V1 provider/session 执行器。
                const legacy =
                  v1 === undefined
                    ? undefined
                    : (() => {
                        const providerApi = catalog.provider.get(providerID)?.provider.api
                        const configuredApi = models.findLast(
                          ([modelID, model]) => modelID === id && model.api?.type !== undefined,
                        )?.[1].api
                        const api =
                          configuredApi ??
                          (model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
                            ? providerApi
                            : model.api)
                        // native 与未注册 SDK 的 raw 行为属于既有契约，执行支持性仍由 resolver 判断。
                        const lowerer = ConfigProviderOptionsV1.get(api?.type === "aisdk" ? api.package : undefined)
                        return {
                          body: v1.options && lowerer.request(v1.options),
                          variants: Object.entries(v1.variants ?? {}).map(([id, options]) => ({
                            id: ModelV2.VariantID.make(id),
                            headers: undefined,
                            body: lowerer.request(options),
                          })),
                        }
                      })()
                // 默认值先于迁移输入，随后原生 request 覆盖；兼容标记不进入 Catalog.Info。
                if (legacy?.body !== undefined)
                  Object.assign(
                    model.request.body,
                    baseType === undefined ? legacy.body : mergeJsonRecords(model.request.body, legacy.body),
                  )
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  // 非继承模型保持上游浅覆盖；继承模型才合并基础 options，variant 仍独立。
                  Object.assign(
                    model.request.body,
                    baseType === undefined
                      ? config.request.body
                      : mergeJsonRecords(model.request.body, config.request.body),
                  )
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                // 两种配置沿同一 variant 更新循环合并，保持原生显式变体的后层优先。
                const variants = [...(legacy?.variants ?? []), ...(config.variants ?? [])]
                if (variants.length > 0) {
                  for (const variant of variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, variant.body)
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    tier: cost.tier && { ...cost.tier },
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                // 显式能力跟随原模型层覆盖并参与继承，后层 false 不再等默认表生成后才补记。
                if (v1?.reasoning !== undefined) model.request.body.__opencodeReasoning = v1.reasoning
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })
            }
          }
        }
        // 全部文档和继承结算后只推断一次，此时 variants 只含真实显式配置，旧默认预算不能伪装成用户覆盖。
        for (const [providerID] of configured) {
          const record = catalog.provider.get(providerID)
          for (const model of record?.models.values() ?? []) {
            const id = model.id
            const providerApi = record?.provider.api
            const api =
              model.api.type === "native" &&
              !model.api.url &&
              Object.keys(model.api.settings).length === 0 &&
              providerApi
                ? providerApi
                : model.api
            const reasoning = model.request.body.__opencodeReasoning
            if (
              reasoning === false ||
              api.type !== "aisdk" ||
              api.package !== "@ai-sdk/anthropic" ||
              (reasoning !== true && !ProviderV2.isAnthropicThinkingModel(model.api.id))
            )
              continue
            const lowerer = ConfigProviderOptionsV1.get(api.package)
            const generated = Object.entries(
              ProviderV2.anthropicThinkingVariants({ apiID: model.api.id, providerID, output: model.limit.output }),
            ).map(([id, options]) => ({ id: ModelV2.VariantID.make(id), headers: {}, body: lowerer.request(options) }))
            catalog.model.update(providerID, id, (draft) => {
              const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
              draft.variants = [
                ...generated.map((variant) => ({
                  // 默认 body 推断不能丢弃显式变体的请求头，认证与路由覆盖仍由该变体拥有。
                  ...variant,
                  headers: { ...variant.headers, ...explicit.get(variant.id)?.headers },
                  // 同一 SDK 的原生 lowerer 和既有深合并同时保留用户覆盖，不另建配置解析器。
                  body: mergeJsonRecords(variant.body, explicit.get(variant.id)?.body) ?? {},
                })),
                // 没有默认同名项的用户变体仍属于完整配置集合，不能被推断表替换掉。
                ...draft.variants.filter((variant) => !generated.some((item) => item.id === variant.id)),
              ]
            })
          }
        }
      }),
    )
  }),
})

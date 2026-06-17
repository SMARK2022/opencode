import { Effect, Option } from "effect"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { PluginV2 } from "../../plugin"
import { ProviderV2 } from "../../provider"

function selectLanguage(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

export const AzurePlugin = PluginV2.define({
  id: PluginV2.ID.make("azure"),
  effect: Effect.gen(function* () {
    const credentials = Option.getOrUndefined(yield* Effect.serviceOption(Credential.Service))
    const accountResourceName = Effect.fnUntraced(function* () {
      if (!credentials) return undefined
      const account = (yield* credentials.list(Integration.ID.make("azure"))).at(-1)?.value
      return account?.metadata?.resourceName
    })
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const fromAccount = yield* accountResourceName()
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/azure") continue
          const configured = item.provider.request.body.resourceName
          const resourceName =
            typeof configured === "string" && configured.trim() !== ""
              ? configured
              : (fromAccount ?? process.env.AZURE_RESOURCE_NAME)
          if (!resourceName) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.resourceName = resourceName
          })
        }
      }),
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/azure") return
        if (evt.model.providerID === ProviderV2.ID.azure) {
          if (
            !evt.options.resourceName &&
            !evt.options.baseURL &&
            (evt.model.api.type !== "aisdk" || !evt.model.api.url)
          ) {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          }
        }
        const mod = yield* Effect.promise(() => import("@ai-sdk/azure"))
        evt.sdk = mod.createAzure(evt.options)
      }),
      "aisdk.language": Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.azure) return
        evt.language = selectLanguage(evt.sdk, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      }),
    }
  }),
})

export const AzureCognitiveServicesPlugin = PluginV2.define({
  id: PluginV2.ID.make("azure-cognitive-services"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const resourceName = process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME
        if (!resourceName) return
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (!item.provider.id.includes("azure-cognitive-services")) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.baseURL = `https://${resourceName}.cognitiveservices.azure.com/openai`
          })
        }
      }),
      "aisdk.language": Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("azure-cognitive-services")) return
        evt.language = selectLanguage(evt.sdk, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      }),
    }
  }),
})

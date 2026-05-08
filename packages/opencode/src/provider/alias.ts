import { AsyncLocalStorage } from "node:async_hooks"

export interface AliasContext {
  providerID: string
  baseProviderID: string
}

export const aliasContext = new AsyncLocalStorage<AliasContext>()

export function runWithAlias<T>(providerID: string, baseProviderID: string, fn: () => T): T {
  return aliasContext.run({ providerID, baseProviderID }, fn)
}

export function buildBaseProviderMap(
  configProviders: Record<string, { extends?: unknown }>,
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [id, provider] of Object.entries(configProviders)) {
    if (provider?.extends && typeof provider.extends === "string") {
      map[id] = provider.extends
    }
  }
  return map
}

export function resolveBaseProvider(providerID: string, baseProviderMap: Record<string, string>): string | undefined {
  return baseProviderMap[providerID]
}

export function isOpenaiOauthProvider(
  providerID: string,
  baseProviderMap: Record<string, string>,
): boolean {
  return providerID === "openai" || baseProviderMap[providerID] === "openai"
}

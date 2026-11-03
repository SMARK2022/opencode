import { AsyncLocalStorage } from "node:async_hooks"

// #114：别名 provider 运行时上下文（真实 alias ID vs extends 基类）
export interface AliasContext {
  // #114：真实配置中的别名 id（写入 auth 的目标）
  providerID: string
  // #114：extends 指向的基类 id（插件/hook 逻辑复用目标）
  baseProviderID: string
}

export const aliasContext = new AsyncLocalStorage<AliasContext>()

// #114：在别名 ALS 中执行 models/auth loader，隔离多账号
export function runWithAlias<T>(providerID: string, baseProviderID: string, fn: () => T): T {
  return aliasContext.run({ providerID, baseProviderID }, fn)
}

// #114：从 config.provider 构建 aliasID -> extends 基类映射
export function buildBaseProviderMap(configProviders: Record<string, { extends?: unknown }>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [id, provider] of Object.entries(configProviders)) {
    if (provider?.extends && typeof provider.extends === "string") {
      map[id] = provider.extends
    }
  }
  return map
}

// #114：查询别名对应的基类 id；未配置 extends 时返回 undefined
export function resolveBaseProvider(providerID: string, baseProviderMap: Record<string, string>): string | undefined {
  return baseProviderMap[providerID]
}

// #114：openai oauth 判定覆盖 extends: openai 的别名账号
export function isOpenaiOauthProvider(providerID: string, baseProviderMap: Record<string, string>): boolean {
  return providerID === "openai" || baseProviderMap[providerID] === "openai"
}

// #114：无 config map 时，用 npm=@ai-sdk/openai 识别 openai 别名 oauth
export function isOpenaiOauthByModelNpm(providerID: string, npm?: string): boolean {
  return providerID === "openai" || npm === "@ai-sdk/openai"
}

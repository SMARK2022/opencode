export * as ProviderV2 from "./provider"

import { Types } from "effect"
import { Provider } from "@opencode-ai/schema/provider"
import { AnthropicMessages } from "@opencode-ai/llm/protocols/anthropic-messages"
import { Gemini } from "@opencode-ai/llm/protocols/gemini"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK = Provider.AISDK

export const Native = Provider.Native

export const Api = Provider.Api
export type Api = Provider.Api
export type MutableApi<T extends Api = Api> = T extends Api
  ? Omit<Types.DeepMutable<T>, "settings"> & (undefined extends T["settings"] ? { settings?: any } : { settings: any })
  : never

export const Request = Provider.Request
export type Request = Provider.Request

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & { api: MutableApi }

// 默认地址复用实际协议的端点常量；显式 URL 即使为空也优先，不能被默认值覆盖。
const SDK_DEFAULT_API_URL = new Map([
  ["@ai-sdk/anthropic", AnthropicMessages.DEFAULT_BASE_URL],
  ["@ai-sdk/google", Gemini.DEFAULT_BASE_URL],
  ["@ai-sdk/openai", OpenAIResponses.DEFAULT_BASE_URL],
])

export function apiUrl(input: { npm?: string; api?: string }) {
  // 未知 SDK 保持地址未解析，避免借用另一协议的主机误导显示与探测。
  return input.api ?? (input.npm ? SDK_DEFAULT_API_URL.get(input.npm) : undefined) ?? ""
}

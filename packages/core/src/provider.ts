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

export function isAnthropicThinkingModel(modelID: string) {
  const id = modelID.toLowerCase()
  // 两个配置 owner 都检查实际 API ID，显示名或 Catalog 别名不授予模型能力。
  return id.includes("claude-3-7") || id.includes("claude-3.7") || /claude-(haiku|sonnet|opus)-4/.test(id)
}

export function anthropicThinkingEfforts(apiId: string): string[] | null {
  // 复用原 transform 的完整型号表，日期后缀不能被当作次版本号。
  const version = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i.exec(apiId)
  // 无法解析版本的 Claude 部署沿上游自适应策略，不能把有效部署名降成旧预算模式。
  if (apiId.toLowerCase().includes("claude-") && (!version || Number(version[1]) > 4 ||
    (Number(version[1]) === 4 && Number(version[2] ?? 0) >= 7)))
    return ["low", "medium", "high", "xhigh", "max"]
  if (
    ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"].some((v) =>
      apiId.includes(v),
    )
  ) {
    // 4.6 的四档不含 xhigh，复用型号表不能给旧部署添加服务端不接受的一档。
    return ["low", "medium", "high", "max"]
  }
  return null
}

export function anthropicThinkingVariants(model: { apiID: string; providerID: string; output: number }) {
  const efforts = anthropicThinkingEfforts(model.apiID)
  if (efforts) {
    // Copilot 的同名 Anthropic 部署有独立 effort 限额，不能直接暴露云端全档位。
    const supported = model.providerID === "github-copilot"
      ? model.apiID.includes("opus-4.7") ? ["medium"] : efforts.filter((id) => id !== "max" && id !== "xhigh")
      : efforts
    return Object.fromEntries(supported.map((effort) => [effort, {
      // 新自适应型号默认隐藏思考正文，保留 summarized 才能让既有 TUI 收到摘要。
      thinking: { type: "adaptive", ...(efforts.includes("xhigh") ? { display: "summarized" } : {}) },
      effort,
    }]))
  }
  // enabled thinking 必须低于输出上限，两档沿上游算法，不能借 64 的 contextLimit 计算。
  // Anthropic 的 enabled 预算至少 1024；未声明或不足以容纳它的输出窗口不制造缺省变体。
  if (model.output <= 1024) return {}
  const budgetTokens = Math.min(16_000, Math.max(1024, Math.floor(model.output / 2 - 1)))
  if (["opus-4-5", "opus-4.5"].some((id) => model.apiID.includes(id)))
    return Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, { thinking: { type: "enabled", budgetTokens }, effort }]))
  return {
    high: { thinking: { type: "enabled", budgetTokens } },
    max: { thinking: { type: "enabled", budgetTokens: Math.min(31_999, model.output - 1) } },
  }
}

export function isClaudeCode(model: { providerID: string; api: Api }) {
  // 派生标记只由配置 owner 沿真实继承关系产生，仍须同时命中实际 Anthropic 协议。
  return model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic" &&
    (model.providerID === "claudecode" || model.api.settings?.claudeCode === true)
}

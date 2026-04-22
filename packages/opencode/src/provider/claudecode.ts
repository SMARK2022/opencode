import { createHash, randomUUID } from "crypto"
import { xxh64 } from "@node-rs/xxhash"

// ============================================================================
// 常量与基础配置
// ============================================================================
export const VERSION = "2.1.117" // 当前最新的 Claude Code 版本号
const SALT = "59cf53e54c78"

// CLI 身份声明 Block
export const CLI_IDENTITY_BLOCK = {
  type: "text" as const,
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
  cache_control: { type: "ephemeral" as const },
}

// 主 System Prompt Block (这里仅为摘要仿真)
export const MAIN_SYSTEM_BLOCK = {
  type: "text" as const,
  text: [
    "You are an interactive agent that helps users with software engineering tasks.",
    "Use the instructions below and the tools available to you to assist the user.",
    "",
    "# System",
    " - All text you output outside of tool use is displayed to the user.",
    " - Tool results and user messages may include <system-reminder> tags.",
    " - The conversation has unlimited context through automatic summarization.",
  ].join("\n"),
  cache_control: { type: "ephemeral" as const },
}

// ============================================================================
// 会话状态管理
// 确保同一个进程生命周期内复用相同的 sessionId 和 deviceId
// ============================================================================
export interface CubenceSession {
  sessionId: string
  deviceId: string
  accountUuid: string
}

let sessionInstance: CubenceSession | null = null

export function getSession(opts?: { deviceId?: string }): CubenceSession {
  if (!sessionInstance) {
    sessionInstance = {
      sessionId: randomUUID(),
      deviceId: opts?.deviceId ?? randomUUID(),
      accountUuid: "",
    }
  }
  return sessionInstance
}

// ============================================================================
// 核心组装逻辑
// ============================================================================

/**
 * 计算 Fingerprint
 * 严格按照 Claude Code 逻辑：取第一条用户消息中**第一个** text block 的 index 4, 7, 20 字符
 * 然后做 SHA256 截取前 3 位 Hex
 */
export function computeFingerprint(messageText: string, version: string): string {
  const pick = (i: number) => (messageText.length > i ? messageText[i] : "0")
  const chars = pick(4) + pick(7) + pick(20)
  const input = `${SALT}${chars}${version}`
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 3)
}

/**
 * 构造 Billing Header 占位块
 * 发包前需要依赖这里的 cch=00000 作为标记，用于后续 xxHash 替换
 */
export function buildBillingHeaderBlock(fp: string) {
  return {
    type: "text" as const,
    text: [
      `x-anthropic-billing-header:`,
      ` cc_version=${VERSION}.${fp};`,
      ` cc_entrypoint=cli;`,
      ` cch=00000;`,
    ].join(""),
  }
}

/**
 * 构建必须的 System Blocks 组合
 */
export function buildSystemBlocks(fp: string) {
  return [buildBillingHeaderBlock(fp), CLI_IDENTITY_BLOCK, MAIN_SYSTEM_BLOCK]
}

/**
 * 构建紧凑的 User ID Metadata 字符串
 */
export function buildMetadataUserId(opts: { deviceId: string; sessionId: string; accountUuid?: string }) {
  return JSON.stringify({
    device_id: opts.deviceId,
    account_uuid: opts.accountUuid ?? "",
    session_id: opts.sessionId,
  })
}

/**
 * 构建请求头
 */
export function buildRequestHeaders(opts: { sessionId: string; modelId: string }): Record<string, string> {
  const betas = [
    "claude-code-20250219",
    "prompt-caching-scope-2026-01-05",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27"
  ]

  if (
    opts.modelId.includes("opus-4-7") ||
    opts.modelId.includes("opus-4-6") ||
    opts.modelId.includes("sonnet-4-6")
  ) {
    betas.push("context-1m-2025-08-07")
  }

  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betas.join(","),
    "x-app": "cli",
    "user-agent": `claude-cli/${VERSION} (external, cli)`,
    "x-claude-code-session-id": opts.sessionId,
  }
}

// ============================================================================
// cch (Cubence Hash) 计算与就地替换
// ============================================================================

/**
 * 计算 cch 值：对完整的 Body 字节串做 xxHash64，取低 20 位，转 5 位小写十六进制
 */
export function computeCch(bodyBytes: Uint8Array): string {
  const hash: bigint = xxh64(bodyBytes)
  const low20 = hash & BigInt(0xfffff)
  return low20.toString(16).padStart(5, "0")
}

/**
 * 局部替换 cch 占位符
 * 确保严格的文本级替换，不破坏原有的 JSON 序列化空格和字段顺序
 */
export function patchCch(bodyStr: string): string {
  const PLACEHOLDER = "cch=00000"

  const idx = bodyStr.indexOf(PLACEHOLDER)
  if (idx === -1) {
    console.warn("[claudecode] cch placeholder not found in body, skipping patch")
    return bodyStr
  }

  const bodyBytes = new TextEncoder().encode(bodyStr)
  const cch = computeCch(bodyBytes)

  return bodyStr.slice(0, idx + 4) + cch + bodyStr.slice(idx + 9)
}

// ============================================================================
// Fetch 拦截与重写包装器
// ============================================================================

export function createClaudeCodeFetch(opts: { session: CubenceSession; token: string; authMode: "bearer" | "x-api-key" }) {
  const { session, token, authMode } = opts

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()

    // 只拦截向 /v1/messages 发送的请求
    if (!url.includes("/v1/messages")) {
      return fetch(input, init)
    }

    const originalBody = init?.body
      ? JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      : {}

    // 1. 抽取 first user text（严格只取第一个 text block）
    const firstUserMessage = (originalBody.messages ?? []).find((m: { role: string }) => m.role === "user")
    const firstUserText = (() => {
      if (!firstUserMessage) return ""
      const content = firstUserMessage.content
      if (typeof content === "string") return content
      if (Array.isArray(content)) {
        const firstText = content.find((b: { type: string }) => b.type === "text")
        return firstText ? firstText.text : ""
      }
      return ""
    })()

    const fp = computeFingerprint(firstUserText, VERSION)

    // 2. 合并 System Blocks (将我们的 Block 插入到最前面，而不是直接覆盖)
    let newSystem = buildSystemBlocks(fp)
    if (originalBody.system) {
      if (Array.isArray(originalBody.system)) {
        newSystem = newSystem.concat(originalBody.system)
      } else {
        newSystem.push({ type: "text" as const, text: originalBody.system })
      }
    }

    // 3. 合并 Metadata (保留原有字段)
    const newMetadata = {
      ...originalBody.metadata,
      user_id: buildMetadataUserId({
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        accountUuid: session.accountUuid,
      }),
    }

    // 4. 动态分发 Thinking 与 Effort 策略
    const modelId = originalBody.model || ""
    const maxTokens = originalBody.max_tokens || 32000
    const originalThinking = originalBody.thinking

    let thinking = originalThinking

    if (originalThinking?.type === "disabled") {
      // 用户明确禁用 thinking，尊重它
      thinking = originalThinking
    } else if (
      modelId.includes("opus-4-7") ||
      modelId.includes("opus-4-6") ||
      modelId.includes("sonnet-4-6")
    ) {
      // 新模型走 adaptive
      thinking = { type: "adaptive" }
    } else if (modelId.includes("haiku")) {
      // Haiku 走 enabled + budget_tokens
      const defaultBudget = 32000
      const budgetTokens = Math.min(defaultBudget, Math.max(1, maxTokens - 1))
      thinking = { type: "enabled", budget_tokens: budgetTokens }
    } else {
      // 保底处理
      if (!thinking) {
        const defaultBudget = 32000
        const budgetTokens = Math.min(defaultBudget, Math.max(1, maxTokens - 1))
        thinking = { type: "enabled", budget_tokens: budgetTokens }
      }
    }

    // 5. 构造打补丁后的最终 Body
    const patchedBody = {
      ...originalBody,
      system: newSystem,
      metadata: newMetadata,
      ...(thinking ? { thinking } : {}),
      ...(originalBody.output_config ? { output_config: originalBody.output_config } : {}),
    }

    // 6. 占位符替换机制
    const bodyWithPlaceholder = JSON.stringify(patchedBody)
    const finalBodyStr = patchCch(bodyWithPlaceholder)

    // 7. 处理请求头与鉴权
    const customHeaders = buildRequestHeaders({ sessionId: session.sessionId, modelId })
    const requestHeaders = new Headers(init?.headers)

    // 合并自定义 Headers
    for (const [key, value] of Object.entries(customHeaders)) {
      requestHeaders.set(key, value)
    }

    // 判断鉴权方式：由外层透传的 authMode 决定
    if (authMode === "x-api-key") {
      requestHeaders.set("x-api-key", token)
      requestHeaders.delete("authorization")
    } else {
      requestHeaders.set("authorization", `Bearer ${token}`)
      requestHeaders.delete("x-api-key")
    }

    // 8. 透传所有 init 参数，只覆盖 body 和 headers，避免丢弃 signal / keepalive 等控制参数
    return fetch(input, {
      ...init,
      headers: requestHeaders,
      body: finalBodyStr,
    })
  }
}

// ============================================================================
// Provider 暴露点
// ============================================================================

export function createClaudeCodeProvider(token: string, baseUrl: string, authMode: "bearer" | "x-api-key") {
  const session = getSession()

  return {
    baseURL: baseUrl, // 官方逻辑中，由 SDK 负责补充 /v1/messages，这里只需原始 baseURL
    fetch: createClaudeCodeFetch({
      session,
      token,
      authMode,
    }),
    headers: {}, // 交给内部 fetch wrapper 控制，这里不污染
  }
}

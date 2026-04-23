import { createHash, randomUUID } from "crypto"

// ============================================================================
// 常量与基础配置
// ============================================================================
export const VERSION = "2.1.117" // 当前最新的 Claude Code 版本号
const SALT = "59cf53e54c78"

// // CLI 身份声明 Block
// export const CLI_IDENTITY_BLOCK = {
//   type: "text" as const,
//   text: "You are Claude Code, Anthropic's official CLI for Claude.",
//   cache_control: { type: "ephemeral" as const },
// }

// // 主 System Prompt Block (这里仅为摘要仿真)
// export const MAIN_SYSTEM_BLOCK = {
//   type: "text" as const,
//   text: [
//     "You are an interactive agent that helps users with software engineering tasks.",
//     "Use the instructions below and the tools available to you to assist the user.",
//     "",
//     "# System",
//     " - All text you output outside of tool use is displayed to the user.",
//     " - Tool results and user messages may include <system-reminder> tags.",
//     " - The conversation has unlimited context through automatic summarization.",
//   ].join("\n"),
//   cache_control: { type: "ephemeral" as const },
// }

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

// /**
//  * 构建必须的 System Blocks 组合
//  */
// export function buildSystemBlocks(fp: string) {
//   return [buildBillingHeaderBlock(fp), CLI_IDENTITY_BLOCK, MAIN_SYSTEM_BLOCK]
// }

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
const MASK_64 = 0xffff_ffff_ffff_ffffn
const PRIME64_1 = 0x9e37_79b1_85eb_ca87n
const PRIME64_2 = 0xc2b2_ae3d_27d4_eb4fn
const PRIME64_3 = 0x1656_67b1_9e37_79f9n
const PRIME64_4 = 0x85eb_ca77_c2b2_ae63n
const PRIME64_5 = 0x27d4_eb2f_1656_67c5n

const add64 = (a: bigint, b: bigint) => (a + b) & MASK_64
const mul64 = (a: bigint, b: bigint) => (a * b) & MASK_64
const rotl64 = (x: bigint, bits: number) => {
  const r = BigInt(bits)
  return ((x << r) | (x >> (64n - r))) & MASK_64
}

const readU32LE = (bytes: Uint8Array, offset: number) => {
  const b0 = bytes[offset] ?? 0
  const b1 = bytes[offset + 1] ?? 0
  const b2 = bytes[offset + 2] ?? 0
  const b3 = bytes[offset + 3] ?? 0
  return BigInt((b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000) >>> 0)
}

const readU64LE = (bytes: Uint8Array, offset: number) => readU32LE(bytes, offset) | (readU32LE(bytes, offset + 4) << 32n)

const round64 = (acc: bigint, lane: bigint) => mul64(rotl64(add64(acc, mul64(lane, PRIME64_2)), 31), PRIME64_1)

const mergeRound64 = (acc: bigint, lane: bigint) => {
  const merged = (acc ^ round64(0n, lane)) & MASK_64
  return add64(mul64(merged, PRIME64_1), PRIME64_4)
}

const avalanche64 = (value: bigint) => {
  let hash = value
  hash = (hash ^ (hash >> 33n)) & MASK_64
  hash = mul64(hash, PRIME64_2)
  hash = (hash ^ (hash >> 29n)) & MASK_64
  hash = mul64(hash, PRIME64_3)
  hash = (hash ^ (hash >> 32n)) & MASK_64
  return hash
}

export function xxh64(bodyBytes: Uint8Array, seed = 0n) {
  let offset = 0
  const len = bodyBytes.length
  let hash: bigint

  if (len >= 32) {
    let v1 = add64(add64(seed, PRIME64_1), PRIME64_2)
    let v2 = add64(seed, PRIME64_2)
    let v3 = seed & MASK_64
    let v4 = add64(seed, -PRIME64_1)

    const limit = len - 32
    while (offset <= limit) {
      v1 = round64(v1, readU64LE(bodyBytes, offset))
      v2 = round64(v2, readU64LE(bodyBytes, offset + 8))
      v3 = round64(v3, readU64LE(bodyBytes, offset + 16))
      v4 = round64(v4, readU64LE(bodyBytes, offset + 24))
      offset += 32
    }

    hash = add64(add64(rotl64(v1, 1), rotl64(v2, 7)), add64(rotl64(v3, 12), rotl64(v4, 18)))
    hash = mergeRound64(hash, v1)
    hash = mergeRound64(hash, v2)
    hash = mergeRound64(hash, v3)
    hash = mergeRound64(hash, v4)
  } else {
    hash = add64(seed, PRIME64_5)
  }

  hash = add64(hash, BigInt(len))

  while (offset + 8 <= len) {
    const lane = readU64LE(bodyBytes, offset)
    hash = (hash ^ round64(0n, lane)) & MASK_64
    hash = add64(mul64(rotl64(hash, 27), PRIME64_1), PRIME64_4)
    offset += 8
  }

  if (offset + 4 <= len) {
    hash = (hash ^ mul64(readU32LE(bodyBytes, offset), PRIME64_1)) & MASK_64
    hash = add64(mul64(rotl64(hash, 23), PRIME64_2), PRIME64_3)
    offset += 4
  }

  while (offset < len) {
    hash = (hash ^ mul64(BigInt(bodyBytes[offset]), PRIME64_5)) & MASK_64
    hash = mul64(rotl64(hash, 11), PRIME64_1)
    offset += 1
  }

  return avalanche64(hash)
}

export function computeCch(bodyBytes: Uint8Array): string {
  const low20 = xxh64(bodyBytes) & 0xfffffn
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

    // // 2. 合并 System Blocks (将我们的 Block 插入到最前面，而不是直接覆盖)
    // let newSystem = buildSystemBlocks(fp)
    // if (originalBody.system) {
    //   if (Array.isArray(originalBody.system)) {
    //     newSystem = newSystem.concat(originalBody.system)
    //   } else {
    //     newSystem.push({ type: "text" as const, text: originalBody.system })
    //   }
    // }

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
    const patchedTools = Array.isArray(originalBody.tools) ? [...originalBody.tools] : []
    if (!patchedTools.some((tool: { name?: string }) => tool?.name === "Read")) {
      patchedTools.push({
        name: "Read",
        description: "unsupported",
        input_schema: { type: "object", properties: {} },
      })
    }

    const patchedBody = {
      ...originalBody,
      // system: newSystem,
      metadata: newMetadata,
      tools: patchedTools,
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

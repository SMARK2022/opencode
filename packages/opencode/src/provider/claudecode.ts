import { createHash, randomUUID } from "crypto"

// CLI 版本在请求头和指纹中共同使用，两处变化必须同步以免网关识别到不同客户端。
export const VERSION = "2.1.117"
// 指纹盐值与 Claude Code 官方二进制一致，修改会导致计费头校验失败。
const SALT = "59cf53e54c78"
// 身份块放在主提示之前；20 会撤销该注入，不能提前删去补丁序列中的行为阶段。
export const CLI_IDENTITY_BLOCK = {
  type: "text" as const,
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
  // 身份块仅使用临时缓存，不能在网关侧声明跨账号共享的持久缓存身份。
  cache_control: { type: "ephemeral" as const },
}

// 主提示与计费身份分别建块，避免修改一段用户指令时连带改写身份声明。
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

// --- 会话状态管理 ---
// 随机设备与会话身份属于进程，不可按请求重建，否则同一次对话的 metadata 与 headers 会漂移。
export interface CubenceSession {
  sessionId: string
  deviceId: string
  accountUuid: string
}

let sessionInstance: CubenceSession | null = null

export function getSession(opts?: { deviceId?: string }): CubenceSession {
  // 仅首次调用接纳 deviceId；后续调用沿用已生成身份，不能中途改写请求的设备归属。
  if (!sessionInstance) {
    sessionInstance = {
      sessionId: randomUUID(),
      deviceId: opts?.deviceId ?? randomUUID(),
      accountUuid: "",
    }
  }
  return sessionInstance
}

export function computeFingerprint(messageText: string, version: string): string {
  // 位置按零起始 JavaScript 字符索引读取；短消息补字符零，不得省略缺少的位置。
  const pick = (i: number) => (messageText.length > i ? messageText[i] : "0")
  const chars = pick(4) + pick(7) + pick(20)
  // 指纹输入仅由首条用户消息和版本组成，不能把后续工具输出纳入同一计费身份。
  const input = `${SALT}${chars}${version}`
  // SHA-256 的三位 hex 是版本后缀而非完整摘要，与请求体的 xxHash 校验职责独立。
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 3)
}

// 校验前必须保留五位零占位符；缩短占位符会改变请求体长度与签名字节。
export function buildBillingHeaderBlock(fp: string) {
  return {
    type: "text" as const,
    text: [
      `x-anthropic-billing-header:`,
      ` cc_version=${VERSION}.${fp};`,
      ` cc_entrypoint=cli;`, // 分号属于计费头格式，不能因展示格式化而删除。
      ` cch=00000;`,
    ].join(""),
  }
}

// 组装完整的系统块列表：计费头 + CLI 身份 + 主系统提示
export function buildSystemBlocks(fp: string) {
  return [buildBillingHeaderBlock(fp), CLI_IDENTITY_BLOCK, MAIN_SYSTEM_BLOCK]
}

// user_id 是紧凑 JSON 字符串而非对象；空 account_uuid 仍需保留以符合网关格式。
export function buildMetadataUserId(opts: { deviceId: string; sessionId: string; accountUuid?: string }) {
  return JSON.stringify({
    device_id: opts.deviceId,
    account_uuid: opts.accountUuid ?? "",
    session_id: opts.sessionId,
  })
}

// 构建请求头，beta 特性按模型动态生成，鉴权由 fetch wrapper 处理
export function buildRequestHeaders(opts: { sessionId: string; modelId: string }): Record<string, string> {
  // 15 撤销 redact-thinking，按当前要求排除已弃用 interleaved；功能 beta 由后面的 SDK 合并保留。
  const betas = [
    "claude-code-20250219",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27"
  ]

  // 检查服务端实际 modelId 而非配置显示名，别名不应决定可用 context beta。
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

// CCH 使用 seed=0 的 UInt64 xxHash64 取低 20 位；Bun.hash 默认 wyhash 不符合此契约。
export function computeCch(bodyBytes: Uint8Array): string {
  const hash: bigint = Bun.hash.xxHash64(bodyBytes)
  const low20 = hash & BigInt(0xfffff)
  return low20.toString(16).padStart(5, "0")
}

// 替换保持五位定长，不重新解析 JSON，避免字段顺序和序列化形式被二次改写。
export function patchCch(bodyStr: string): string {
  // 自有 billing 固定在首字段首块；MCP URL/token 和用户文字不参与定位，也不重新解析 JSON。
  const prefix = `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=${VERSION}.`
  const suffix = "; cc_entrypoint=cli; cch="
  const idx = prefix.length + 3 + suffix.length

  if (!bodyStr.startsWith(prefix) || bodyStr.slice(prefix.length + 3, idx + 6) !== `${suffix}00000;`) {
    console.warn("[claudecode] owned billing layout not found in body, skipping patch")
    return bodyStr
  }

  const bodyBytes = new TextEncoder().encode(bodyStr)
  const cch = computeCch(bodyBytes)

  // offset 直接指向自有五位值，MCP 与其余字段的字节和字段顺序完全保留。
  return bodyStr.slice(0, idx) + cch + bodyStr.slice(idx + 5)
}

// --- Fetch 拦截与重写包装器 ---
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

    // 指纹只使用首个 text block；拼接附件后的文本会偏离源客户端的字符位置。
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

    // 计算消息指纹，用于计费头和 CCH 签名
    const fp = computeFingerprint(firstUserText, VERSION)

    // 接续 SDK 已 lowering 的 agent/user/project system，保留每个块的文字及协议属性。
    const system = Array.isArray(originalBody.system) ? originalBody.system : originalBody.system ? [{ type: "text" as const, text: originalBody.system }] : []
    // SDK 已共享四断点预算；原工具/system/history 标记优先，身份块只领取剩余名额。
    const cached = [
      ...(originalBody.tools ?? []),
      ...system,
      ...(originalBody.messages ?? []).flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : []),
    ].filter((block: { cache_control?: unknown }) => block.cache_control).length
    // 只省略无剩余预算的自有缓存属性，不能删除上游已有 cache_control 或禁用全部缓存。
    const newSystem = buildSystemBlocks(fp).map((block, index) =>
      index > 0 && cached + index > 4 ? { type: block.type, text: block.text } : block).concat(system)

    // 3. 合并 Metadata（保留原有字段，只覆盖 user_id）
    const newMetadata = {
      ...originalBody.metadata,
      user_id: buildMetadataUserId({
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        accountUuid: session.accountUuid,
      }),
    }

    // disabled 先于型号默认；只有源支持的新型号改为 adaptive，其余保留显式配置。
    const modelId = originalBody.model || ""
    const maxTokens = originalBody.max_tokens || 32000
    const originalThinking = originalBody.thinking

    let thinking = originalThinking

    if (originalThinking?.type === "disabled") {
      // 显式关闭思考同样是一份有效配置，不能用 truthy 判断重新启用默认预算。
      thinking = originalThinking
    } else if (
      modelId.includes("opus-4-7") ||
      modelId.includes("opus-4-6") ||
      modelId.includes("sonnet-4-6")
    ) {
      // SDK 已验证 adaptive 属性；保留 display/block_binding，避免 Opus4.7 默认为 omitted。
      thinking = { ...(originalThinking?.type === "adaptive" ? originalThinking : {}), type: "adaptive" }
    } else if (modelId.includes("haiku")) {
      const defaultBudget = 32000
      // Haiku 的预算必须小于 max_tokens，输出上限变化后不能继续使用固定 32000。
      const budgetTokens = Math.min(defaultBudget, Math.max(1, maxTokens - 1))
      thinking = { type: "enabled", budget_tokens: budgetTokens }
    } else {
      if (!thinking) {
        // 旧型号只有缺少配置时补默认，已有 enabled/budget_tokens 不被无条件替换。
        const defaultBudget = 32000
        const budgetTokens = Math.min(defaultBudget, Math.max(1, maxTokens - 1))
        thinking = { type: "enabled", budget_tokens: budgetTokens }
      }
    }

    // 5. 构造打补丁后的最终 Body，保留 output_config
    const patchedBody = {
      // system 首字段使 billing 定位独立于 SDK 的 MCP/container 字段；其余原字段逐项保留。
      system: newSystem,
      ...Object.fromEntries(Object.entries(originalBody).filter(([key]) => key !== "system")),
      metadata: newMetadata,
      ...(thinking ? { thinking } : {}),
      ...(originalBody.output_config ? { output_config: originalBody.output_config } : {}),
    }

    // 在合并全部字段之后计算校验值，metadata、thinking 与工具字段都属于签名字节。
    const bodyWithPlaceholder = JSON.stringify(patchedBody)
    const finalBodyStr = patchCch(bodyWithPlaceholder)

    // 从 init.headers 开始合并，保留调用方无关的 tracing、路由及缓存头。
    const customHeaders = buildRequestHeaders({ sessionId: session.sessionId, modelId })
    const requestHeaders = new Headers(init?.headers)

    for (const [key, value] of Object.entries(customHeaders)) {
      // SDK 的 MCP/task-budget/thinking-binding beta 与实际 body 配套，必须同源 beta 一起发送。
      // 仅撤销源明确移除和当前弃用的 beta，其余去重保留，不能丢掉对应 body 的功能开关。
      requestHeaders.set(key, key === "anthropic-beta"
        ? [...new Set([...(requestHeaders.get(key) ?? "").split(","), ...value.split(",")].map((beta) => beta.trim()).filter((beta) => beta && !["interleaved-thinking-2025-05-14", "redact-thinking-2026-02-12"].includes(beta)))].join(",")
        : value)
    }

    // 两种认证头互斥；删除 SDK 遗留头，避免 Bearer 与 x-api-key 指向不同账号。
    if (authMode === "x-api-key") {
      requestHeaders.set("x-api-key", token)
      requestHeaders.delete("authorization")
    } else {
      requestHeaders.set("authorization", `Bearer ${token}`)
      requestHeaders.delete("x-api-key")
    }

    // 8. 透传所有 init 参数，只覆盖 body 和 headers，避免丢弃 signal/keepalive
    return fetch(input, {
      ...init,
      headers: requestHeaders,
      body: finalBodyStr,
    })
  }
}

// --- Provider 暴露点 ---
// SDK 的 URL 构造与 fetch 的消息改写属于同一个 provider，不能把 wrapper 全局安装。
export function createClaudeCodeProvider(token: string, baseUrl: string, authMode: "bearer" | "x-api-key") {
  const session = getSession()
  // 根地址统一去除已有 /v1；SDK 的 /v1 和 wrapper 的 /v1/messages 共享此 root，避免重复拼接完整消息路径。
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")

  return {
    baseURL: `${root}/v1`,
    // SDK 在进入 fetch 前校验 apiKey；必须交付同一选中凭据，不能依赖 wrapper 补认证。
    apiKey: token,
    fetch: createClaudeCodeFetch({
      session,
      token,
      authMode,
    }),
    headers: {},
  }
}
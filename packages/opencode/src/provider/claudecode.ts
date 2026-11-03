import { createHash, randomUUID } from "crypto"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"

// CLI 版本在请求头和指纹中共同使用，两处变化必须同步以免网关识别到不同客户端。
export const VERSION = "2.1.117"
// 指纹盐值与 Claude Code 官方二进制一致，修改会导致计费头校验失败。
const SALT = "59cf53e54c78"

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

// cch 固定为五位零；完整 body hash 不能改写最早的计费 system 前缀。
export function buildBillingHeaderBlock(fp: string, version = VERSION) {
  return {
    type: "text" as const,
    text: [
      `x-anthropic-billing-header:`,
      // #147：billing cc_version 必须与 UA/指纹 version 同源
      ` cc_version=${version}.${fp};`,
      ` cc_entrypoint=cli;`, // 分号属于计费头格式，不能因展示格式化而删除。
      ` cch=00000;`,
    ].join(""),
  }
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
export function buildRequestHeaders(opts: {
  sessionId: string
  modelId: string
  version?: string
}): Record<string, string> {
  // #147：UA 版本与 billing/指纹共用 override
  const version = opts.version ?? VERSION
  // 23 恢复 redact beta；不改 15 的 disabled/adaptive 策略，也不恢复已弃用 interleaved。
  const betas = [
    "claude-code-20250219",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "redact-thinking-2026-02-12",
  ]

  // 检查服务端实际 modelId 而非配置显示名，别名不应决定可用 context beta。
  if (opts.modelId.includes("opus-4-7") || opts.modelId.includes("opus-4-6") || opts.modelId.includes("sonnet-4-6")) {
    betas.push("context-1m-2025-08-07")
  }

  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betas.join(","),
    "x-app": "cli",
    "user-agent": `claude-cli/${version} (external, cli)`,
    "x-claude-code-session-id": opts.sessionId,
  }
}

// --- Fetch 拦截与重写包装器 ---
export function createClaudeCodeFetch(opts: {
  session: CubenceSession
  token: string
  authMode: "bearer" | "x-api-key"
  version?: string
}) {
  const { session, token, authMode } = opts
  // #147：身份三元组（指纹/billing/UA）共用 version
  const version = opts.version ?? VERSION

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()

    // 只拦截向 /v1/messages 发送的请求
    if (!url.includes("/v1/messages")) {
      return NetworkProxy.fetch(input, { ...init, purpose: "provider" })
    }

    const originalBody = init?.body
      ? JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      : {}

    // 24 仅恢复计费消费者；首 user 的首 text 决定指纹，不拼接工具或附件文字。
    const content: unknown = (originalBody.messages ?? []).find(
      (message: { role?: string }) => message.role === "user",
    )?.content
    const firstText: unknown = Array.isArray(content) ? content.find((block) => block?.type === "text")?.text : content
    const fp = computeFingerprint(typeof firstText === "string" ? firstText : "", version)
    // 数组的缓存属性和附加字段原样保留，字符串包括空串也转换为 text block。
    const system: unknown = originalBody.system
    const newSystem: unknown[] = [
      buildBillingHeaderBlock(fp, version),
      ...(Array.isArray(system) ? system : typeof system === "string" ? [{ type: "text", text: system }] : []),
    ]
    // 不恢复 buildSystemBlocks 或两段身份；真正的 agent/project 指令仍来自原始 system。

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
    } else if (modelId.includes("opus-4-7") || modelId.includes("opus-4-6") || modelId.includes("sonnet-4-6")) {
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
    // Read 是 ClaudeCode wire 占位而非本地读文件实现，已有同名工具必须原样保留。
    const patchedTools = Array.isArray(originalBody.tools) ? [...originalBody.tools] : []
    if (!patchedTools.some((tool: { name?: string }) => tool?.name === "Read")) {
      patchedTools.push({
        name: "Read",
        description: "unsupported",
        input_schema: { type: "object", properties: {} },
      })
    }

    const patchedBody = {
      // 首字段首块固定为自有 billing，用户同名 cch 文字不能参与定位。
      system: newSystem,
      ...Object.fromEntries(Object.entries(originalBody).filter(([key]) => key !== "system")),
      metadata: newMetadata,
      tools: patchedTools,
      ...(thinking ? { thinking } : {}),
      ...(originalBody.output_config ? { output_config: originalBody.output_config } : {}),
    }

    // 合并 metadata/thinking/tools 后直接编码，固定零值不随本轮内容变化。
    const finalBodyStr = JSON.stringify(patchedBody)

    // 从 init.headers 开始合并，保留调用方无关的 tracing、路由及缓存头。
    const customHeaders = buildRequestHeaders({ sessionId: session.sessionId, modelId, version })
    const requestHeaders = new Headers(init?.headers)

    for (const [key, value] of Object.entries(customHeaders)) {
      // SDK beta 与实际 body 配套，合并时去重并仅排除弃用 interleaved，恢复的 redact 也必须发出。
      requestHeaders.set(
        key,
        key === "anthropic-beta"
          ? [
              ...new Set(
                [...(requestHeaders.get(key) ?? "").split(","), ...value.split(",")]
                  .map((beta) => beta.trim())
                  .filter((beta) => beta && beta !== "interleaved-thinking-2025-05-14"),
              ),
            ].join(",")
          : value,
      )
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
    return NetworkProxy.fetch(input, {
      ...init,
      purpose: "provider",
      headers: requestHeaders,
      body: finalBodyStr,
    })
  }
}

// --- Provider 暴露点 ---
// SDK 的 URL 构造与 fetch 的消息改写属于同一个 provider，不能把 wrapper 全局安装。
export function createClaudeCodeProvider(
  token: string,
  baseUrl: string,
  authMode: "bearer" | "x-api-key",
  opts?: { version?: string },
) {
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
      // #147：从 provider.options.version 注入客户端版本
      version: opts?.version,
    }),
    headers: {},
  }
}

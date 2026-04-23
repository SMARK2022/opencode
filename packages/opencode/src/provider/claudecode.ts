import { createHash, randomUUID } from "crypto"

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

// 保留源纯 TS 实现替换前项的 Bun 内置哈希，seed=0 的 CCH 字节契约保持一致。
const MASK_64 = 0xffff_ffff_ffff_ffffn
// 五个质数属于 xxHash64 规范，换成 xxHash32 常量会改变全部签名字节。
const PRIME64_1 = 0x9e37_79b1_85eb_ca87n
const PRIME64_2 = 0xc2b2_ae3d_27d4_eb4fn
const PRIME64_3 = 0x1656_67b1_9e37_79f9n
const PRIME64_4 = 0x85eb_ca77_c2b2_ae63n
const PRIME64_5 = 0x27d4_eb2f_1656_67c5n

// BigInt 不会溢出，必须显式按模 2^64 截断才能复现无符号机器运算。
const add64 = (a: bigint, b: bigint) => (a + b) & MASK_64
const mul64 = (a: bigint, b: bigint) => (a * b) & MASK_64
// 输入均已截断为非负值，右移才等价于规范的无符号循环移位。
const rotl64 = (x: bigint, bits: number) => {
  const r = BigInt(bits)
  return ((x << r) | (x >> (64n - r))) & MASK_64
}

// 小端高字节可能置位符号位；转 BigInt 前用 >>> 0 保留无符号 32 位值。
const readU32LE = (bytes: Uint8Array, offset: number) => {
  const b0 = bytes[offset] ?? 0
  const b1 = bytes[offset + 1] ?? 0
  const b2 = bytes[offset + 2] ?? 0
  const b3 = bytes[offset + 3] ?? 0
  return BigInt((b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000) >>> 0)
}

// 高低两段分别转 BigInt 后拼接，避免 Number 丢失 64 位整数精度。
const readU64LE = (bytes: Uint8Array, offset: number) => readU32LE(bytes, offset) | (readU32LE(bytes, offset + 4) << 32n)

// lane 先乘 PRIME64_2 再旋转，不能与尾部八字节的 hash 旋转步骤互换。
const round64 = (acc: bigint, lane: bigint) => mul64(rotl64(add64(acc, mul64(lane, PRIME64_2)), 31), PRIME64_1)

// 合并使用零种子的 round；直接异或累加器会遗漏规范要求的二次混合。
const mergeRound64 = (acc: bigint, lane: bigint) => {
  const merged = (acc ^ round64(0n, lane)) & MASK_64
  return add64(mul64(merged, PRIME64_1), PRIME64_4)
}

// 雪崩的三次右移与两次乘法顺序固定，中间结果也必须保持 64 位。
const avalanche64 = (value: bigint) => {
  let hash = value
  hash = (hash ^ (hash >> 33n)) & MASK_64
  hash = mul64(hash, PRIME64_2)
  hash = (hash ^ (hash >> 29n)) & MASK_64
  hash = mul64(hash, PRIME64_3)
  hash = (hash ^ (hash >> 32n)) & MASK_64
  return hash
}

// 接收已经编码的请求字节，字符串字符数不能替代 UTF-8 字节长度。
export function xxh64(bodyBytes: Uint8Array, seed = 0n) {
  let offset = 0
  const len = bodyBytes.length
  let hash: bigint

  if (len >= 32) {
    // 加法与负 PRIME64_1 都按模 2^64 归一化，负种子和超宽种子同样回绕。
    let v1 = add64(add64(seed, PRIME64_1), PRIME64_2)
    let v2 = add64(seed, PRIME64_2)
    let v3 = seed & MASK_64
    let v4 = add64(seed, -PRIME64_1)

    // 包含 offset == limit，恰好 32 字节及最后完整块都必须进入四 lane 分支。
    const limit = len - 32
    while (offset <= limit) {
      v1 = round64(v1, readU64LE(bodyBytes, offset))
      v2 = round64(v2, readU64LE(bodyBytes, offset + 8))
      v3 = round64(v3, readU64LE(bodyBytes, offset + 16))
      v4 = round64(v4, readU64LE(bodyBytes, offset + 24))
      offset += 32
    }

    // 四 lane 的旋转权重不同，合并顺序保持 v1 到 v4，不能按数值排序。
    hash = add64(add64(rotl64(v1, 1), rotl64(v2, 7)), add64(rotl64(v3, 12), rotl64(v4, 18)))
    hash = mergeRound64(hash, v1)
    hash = mergeRound64(hash, v2)
    hash = mergeRound64(hash, v3)
    hash = mergeRound64(hash, v4)
  } else {
    // 短输入没有四 lane 合并阶段，直接使用 seed + PRIME64_5 初始化。
    hash = add64(seed, PRIME64_5)
  }

  // 总字节长度在尾部混合前加入，不能改成剩余字节数。
  hash = add64(hash, BigInt(len))

  // 尾部按 8、4、1 字节顺序消费；调换顺序会对同一字节流产生不同哈希。
  while (offset + 8 <= len) {
    const lane = readU64LE(bodyBytes, offset)
    hash = (hash ^ round64(0n, lane)) & MASK_64
    hash = add64(mul64(rotl64(hash, 27), PRIME64_1), PRIME64_4)
    offset += 8
  }

  // 四字节尾块最多一次；等号保证恰好剩四字节时不会误走单字节分支。
  if (offset + 4 <= len) {
    hash = (hash ^ mul64(readU32LE(bodyBytes, offset), PRIME64_1)) & MASK_64
    hash = add64(mul64(rotl64(hash, 23), PRIME64_2), PRIME64_3)
    offset += 4
  }

  // 最后不足四字节逐字节混合，字节大于 127 也保持无符号值。
  while (offset < len) {
    hash = (hash ^ mul64(BigInt(bodyBytes[offset]), PRIME64_5)) & MASK_64
    hash = mul64(rotl64(hash, 11), PRIME64_1)
    offset += 1
  }

  // 所有尾字节消费后才雪崩，空输入也执行同一终结阶段。
  return avalanche64(hash)
}

export function computeCch(bodyBytes: Uint8Array): string {
  // 低 20 位对应五个小写 hex nibble；保留前导零以维持定长 CCH wire 格式。
  const low20 = xxh64(bodyBytes) & 0xfffffn
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
      // 撤销适配器身份及计费注入，完整保留 Session owner 组装的原始 system。
      ...originalBody,
      metadata: newMetadata,
      tools: patchedTools,
      ...(thinking ? { thinking } : {}),
      ...(originalBody.output_config ? { output_config: originalBody.output_config } : {}),
    }

    // billing block 已停止注入，没有 adapter 占位符可修补；用户的同名文本必须保持原样。
    const finalBodyStr = JSON.stringify(patchedBody)

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
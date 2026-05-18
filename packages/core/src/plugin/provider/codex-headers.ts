export * as CodexHeaders from "./codex-headers"

// 固定客户端身份不随本地发行版本或宿主平台变化，认证与模型请求必须同源。
export const USER_AGENT = "codex-tui/0.130.0 (Mac OS 15.7.2; arm64) Apple_Terminal/455.1 (codex-tui; 0.130.0)"
export const JSON_HEADERS = {
  "Content-Type": "application/json",
  originator: "codex-tui",
  "User-Agent": USER_AGENT,
}

// 令牌交换仍用表单编码，不能因复用身份改成 JSON 请求。
export const FORM_HEADERS = { ...JSON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }

export function request(overrides: Record<string, string> = {}) {
  const headers = new Headers(JSON_HEADERS)
  // 按字段覆盖而非追加，大小写不同的配置 UA 也只发送一个最终值。
  Object.entries(overrides).forEach(([key, value]) => headers.set(key, value))
  return Object.fromEntries(headers)
}

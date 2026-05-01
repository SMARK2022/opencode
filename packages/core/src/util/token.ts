export * as Token from "./token"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

export function estimateRequest(body: unknown, history: ReadonlyArray<{ bodyChars: number; input: number }>) {
  const sample = history.reduce((sum, item) => {
    // 调用方已筛选同模型确认样本，最近累计达到 16000 字符后不再接纳旧样本。
    if (sum.bodyChars >= 16000 || item.input <= 0 || item.bodyChars <= 0) return sum
    return { bodyChars: sum.bodyChars + item.bodyChars, input: sum.input + item.input }
  }, { bodyChars: 0, input: 0 })
  // 不足 500 字符或零确认不构成比率样本，首轮继续使用通用 /4。
  const ratio = sample.bodyChars > 500 && sample.input > 0 ? sample.bodyChars / sample.input : CHARS_PER_TOKEN
  // 两个请求 owner 共用 canonical JSON 字符口径，不另行解析 schema 或附件。
  const bodyChars = JSON.stringify(body).length
  return { input: Math.max(0, Math.round(bodyChars / ratio)), bodyChars, confirmed: false }
}

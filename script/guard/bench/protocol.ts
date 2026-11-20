// HTTP 200 仍可能携带模型失败；场景必须验证实际完成的回复或取消结果。
export function assertReply(value: unknown, aborted = false) {
  if (!value || typeof value !== "object" || !("info" in value) || !("parts" in value))
    throw new Error("场景未返回完整消息")
  const info = value.info
  if (
    !info ||
    typeof info !== "object" ||
    !("role" in info) ||
    info.role !== "assistant" ||
    !Array.isArray(value.parts)
  )
    throw new Error("场景未返回 assistant 消息")
  const error = "error" in info ? info.error : undefined
  if (aborted) {
    if (!error || typeof error !== "object" || !("name" in error) || error.name !== "MessageAbortedError")
      throw new Error("abort 场景未产生 MessageAbortedError")
    return
  }
  if (error !== undefined) throw new Error(`场景返回模型错误：${JSON.stringify(error)}`)
  if (
    !value.parts.some(
      (part: unknown) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string" &&
        part.text.length > 0,
    )
  )
    throw new Error("stream 场景未产生回复正文")
}

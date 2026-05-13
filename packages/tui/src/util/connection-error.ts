// #139：识别可恢复的网络/连接错误，供 SSE 重连静默吞掉
export namespace ConnectionError {
  export function isConnectionError(error: unknown): boolean {
    if (error == null) return false
    if (typeof error === "string") return matchMessage(error)
    if (typeof error !== "object") return false
    const err = error as { name?: string; message?: string; code?: string; cause?: unknown }
    // #139：中止视为可恢复连接中断
    if (err.name === "AbortError") return true
    if (typeof err.code === "string" && matchCode(err.code)) return true
    if (typeof err.message === "string" && matchMessage(err.message)) return true
    // #139：递归 cause 链
    if (err.cause) return isConnectionError(err.cause)
    return false
  }
}

function matchCode(code: string) {
  const c = code.toUpperCase()
  return (
    c === "ECONNRESET" ||
    c === "ECONNREFUSED" ||
    c === "ECONNABORTED" ||
    c === "ETIMEDOUT" ||
    c === "ENOTFOUND" ||
    c === "EAI_AGAIN" ||
    c === "EPIPE" ||
    c === "UND_ERR_CONNECT_TIMEOUT" ||
    c === "UND_ERR_SOCKET"
  )
}

function matchMessage(message: string) {
  const m = message.toLowerCase()
  // #139：message 关键字启发式
  return (
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("socket hang up") ||
    m.includes("aborted") ||
    m.includes("connection")
  )
}

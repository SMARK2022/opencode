// 每个 TUI 进程最多记住 512 个 message/part/field 诊断 key；超过后清空，
// 防止长会话常驻内存增长。清空只会让后续首 delta 再打一行日志，不影响 UI。
export const PART_DELTA_TIMING_LIMIT = 512

type AppLogClient = {
  app: {
    log(input: {
      service: string
      level: "info"
      message: string
      extra: Record<string, unknown>
    }): Promise<unknown>
  }
}

export function partDeltaTimingKey(input: { messageID: string; partID: string; field: string }) {
  // 使用 NUL 作为内存去重分隔符，避免 message/part/field 内部的常规字符
  // 影响 key 边界；这个 key 不写入日志、不持久化，只用于限制诊断行数。
  return `${input.messageID}\0${input.partID}\0${input.field}`
}

export function logPartDeltaTiming(input: {
  client: AppLogClient
  phase: "delta.receive" | "delta.apply" | "delta.drop"
  sessionID: string
  messageID: string
  partID: string
  field: string
  reason?: string
}) {
  // TUI 自身有本地日志，但这组埋点必须进入 daemon 的 opencode log，
  // 才能和 processor/tool 端时间戳放在同一条链路里排查。这里保持
  // fire-and-forget：/log 失败不能阻塞 SSE 分发、store reducer 或渲染。
  void input.client.app
    .log({
      service: "tui.stream",
      level: "info",
      message: "stream timing",
      extra: {
        phase: input.phase,
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        field: input.field,
        reason: input.reason,
      },
    })
    .catch(() => undefined)
}

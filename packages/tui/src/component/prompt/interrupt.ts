// #151：双击 Escape 确认窗口（毫秒）
// #151：5s 内保持 armed，窗口内可再次 abort 而无需重新武装
export const INTERRUPT_CONFIRMATION_MS = 5000

// #151：第二次 Escape 触发 abort；count 封顶 1，保持 armed 以便窗口内继续 abort
export function advanceInterruptCount(current: number) {
  const next = current + 1
  return {
    count: Math.min(next, 1),
    abort: next >= 2,
  }
}

// #151：有 sessionID 即可中断（status 可能 stale/idle 仍应可用）
export function canInterruptSession(sessionID: string | undefined) {
  return sessionID !== undefined
}

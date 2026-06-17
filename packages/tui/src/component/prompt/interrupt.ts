export const INTERRUPT_CONFIRMATION_MS = 5000

export function advanceInterruptCount(current: number) {
  const next = current + 1
  return {
    count: Math.min(next, 1),
    abort: next >= 2,
  }
}

export function canInterruptSession(sessionID: string | undefined) {
  return sessionID !== undefined
}

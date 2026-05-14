import { describe, expect, test } from "bun:test"
import {
  advanceInterruptCount,
  canInterruptSession,
  INTERRUPT_CONFIRMATION_MS,
} from "../../src/component/prompt/interrupt"

describe("advanceInterruptCount", () => {
  // #151：第一次按键武装，第二次 abort，且 count 保持 1
  test("keeps the prompt armed after abort", () => {
    expect(advanceInterruptCount(0)).toEqual({ count: 1, abort: false })
    expect(advanceInterruptCount(1)).toEqual({ count: 1, abort: true })
    expect(advanceInterruptCount(1)).toEqual({ count: 1, abort: true })
  })
})

describe("canInterruptSession", () => {
  test("allows interrupt when a session id is present", () => {
    expect(canInterruptSession("ses_1")).toBe(true)
    expect(canInterruptSession(undefined)).toBe(false)
  })
})

describe("INTERRUPT_CONFIRMATION_MS", () => {
  test("is five seconds", () => {
    expect(INTERRUPT_CONFIRMATION_MS).toBe(5000)
  })
})

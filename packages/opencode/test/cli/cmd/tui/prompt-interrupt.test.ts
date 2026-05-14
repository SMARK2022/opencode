import { describe, expect, test } from "bun:test"
import { advanceInterruptCount, canInterruptSession } from "../../../../src/cli/cmd/tui/component/prompt/interrupt"

describe("advanceInterruptCount", () => {
  test("keeps the prompt armed after abort so repeated escape keeps aborting", () => {
    const first = advanceInterruptCount(0)
    expect(first).toEqual({ count: 1, abort: false })

    const second = advanceInterruptCount(first.count)
    expect(second).toEqual({ count: 1, abort: true })

    const third = advanceInterruptCount(second.count)
    expect(third).toEqual({ count: 1, abort: true })
  })
})

describe("canInterruptSession", () => {
  test("keeps interrupt available even when status is stale or already idle", () => {
    expect(canInterruptSession("ses_123")).toBe(true)
    expect(canInterruptSession(undefined)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { durationClock, truncate, truncateMiddle } from "@/util/locale"

describe("Locale.durationClock", () => {
  test("formats ticking turn durations without decimal seconds", () => {
    // 运行中 footer 每秒刷新，但开始时间来自持久化 message timestamp，天然不会对齐到整秒。
    // 这些断言锁定“向下取整且不显示小数”的用户可见行为，避免出现 1.1s、2.1s 这类抖动感。
    expect(durationClock(999)).toBe("999ms")
    expect(durationClock(1_000)).toBe("1s")
    expect(durationClock(1_100)).toBe("1s")
    expect(durationClock(11_100)).toBe("11s")
    expect(durationClock(59_900)).toBe("59s")
  })

  test("keeps existing minute and larger duration shape", () => {
    // 超过一分钟后继续沿用 transcript footer 的 `1m 20s` 形态；本 formatter
    // 只移除一分钟以内的小数秒，不改变分钟、小时、天级展示结构。
    expect(durationClock(60_000)).toBe("1m 0s")
    expect(durationClock(80_000)).toBe("1m 20s")
    expect(durationClock(3_600_000)).toBe("1h 0m")
    expect(durationClock(90_000_000)).toBe("1d 1h")
  })
})

describe("Locale.truncate", () => {
  test("truncates ASCII string correctly", () => {
    expect(truncate("hello world", 5)).toBe("hell…")
    expect(truncate("hi", 5)).toBe("hi")
  })

  test("does not split surrogate pairs (emoji)", () => {
    // 😀 is U+1F600, encoded as surrogate pair \uD83D\uDE00 in UTF-16
    // "a😀b" has .length === 4 (a + high surrogate + low surrogate + b)
    // truncate to len=3 should NOT produce an orphan high surrogate
    const str = "a😀b"
    const result = truncate(str, 3)
    // Should not contain an isolated surrogate
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      // High surrogate without following low surrogate
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
      // Orphan low surrogate
      expect(code >= 0xdc00 && code <= 0xdfff && (i === 0 || !(result.charCodeAt(i - 1) >= 0xd800 && result.charCodeAt(i - 1) <= 0xdbff))).toBe(false)
    }
  })

  test("does not split surrogate pairs (CJK extension B)", () => {
    // 𠀀 is U+20000, a CJK Unified Ideograph Extension B character
    // encoded as surrogate pair \uD840\uDC00
    const str = "ab𠀀cd"
    // str.length === 6: a, b, \uD840, \uDC00, c, d
    // truncate to 4 means slice(0, 3) + "…"
    // slice(0, 3) = "ab\uD840" — orphan high surrogate!
    const result = truncate(str, 4)
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
    }
  })

  test("handles string of only emoji", () => {
    const str = "😀😁😂"
    // .length === 6
    const result = truncate(str, 3)
    // Should be valid unicode
    for (const char of result) {
      expect(char.codePointAt(0)).toBeGreaterThan(0)
    }
  })
})

describe("Locale.truncateMiddle", () => {
  test("truncates middle of ASCII string", () => {
    const result = truncateMiddle("abcdefghij", 7)
    expect(result.length).toBe(7)
    expect(result).toContain("…")
  })

  test("does not split surrogate pairs at start boundary", () => {
    // "😀😁😂😃😄" — 5 emoji, .length === 10
    const str = "😀😁😂😃😄"
    const result = truncateMiddle(str, 5)
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = result.charCodeAt(i - 1)
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true)
      }
    }
  })

  test("does not split surrogate pairs at end boundary", () => {
    const str = "path/to/😀😁😂/file.txt"
    const result = truncateMiddle(str, 15)
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = result.charCodeAt(i - 1)
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true)
      }
    }
  })
})

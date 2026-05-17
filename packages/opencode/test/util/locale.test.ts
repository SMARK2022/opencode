import { describe, expect, test } from "bun:test"
import { truncate, truncateMiddle } from "@/util/locale"

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

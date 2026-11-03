import { describe, expect, test } from "bun:test"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings, splitLines } from "../../src/util/line-ending"

// #131：行尾工具语义单测（CR/CRLF/LF）
describe("line-ending", () => {
  test("normalizeLineEndings collapses CRLF and CR to LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\n")).toBe("a\nb\nc\n")
  })

  test("detectLineEnding prefers CRLF then CR then LF", () => {
    expect(detectLineEnding("a\r\nb")).toBe("\r\n")
    expect(detectLineEnding("a\rb")).toBe("\r")
    expect(detectLineEnding("a\nb")).toBe("\n")
  })

  test("splitLines treats CR-only files as multiple logical lines", () => {
    expect(splitLines("Line 1\rLine 2\r")).toEqual(["Line 1", "Line 2", ""])
  })

  test("convertToLineEnding restores CR-only writeback", () => {
    expect(convertToLineEnding("Line 1\nLine 2\n", "\r")).toBe("Line 1\rLine 2\r")
  })

  test("convertToLineEnding restores CRLF writeback", () => {
    expect(convertToLineEnding("Line 1\nLine 2\n", "\r\n")).toBe("Line 1\r\nLine 2\r\n")
  })
})

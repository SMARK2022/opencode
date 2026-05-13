import { describe, expect, test } from "bun:test"
import { ConnectionError } from "../../src/util/connection-error"

describe("ConnectionError.isConnectionError", () => {
  // #139：AbortError 可恢复
  test("detects AbortError", () => {
    expect(ConnectionError.isConnectionError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true)
  })
  // #139：fetch failed 可恢复
  test("detects fetch failed message", () => {
    expect(ConnectionError.isConnectionError(new Error("fetch failed"))).toBe(true)
  })
  // #139：ECONNRESET code
  test("detects ECONNRESET code", () => {
    expect(ConnectionError.isConnectionError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true)
  })
  // #139：cause 链
  test("walks cause chain", () => {
    const root = Object.assign(new Error("wrap"), {
      cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }),
    })
    expect(ConnectionError.isConnectionError(root)).toBe(true)
  })
  test("rejects ordinary errors", () => {
    expect(ConnectionError.isConnectionError(new Error("validation failed"))).toBe(false)
  })
})

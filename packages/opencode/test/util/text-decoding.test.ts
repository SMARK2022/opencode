import { describe, expect, test } from "bun:test"
import { createAutoTextDecoder, decodeText, detectTextEncoding } from "@/util/text-decoding"

const bytes = (items: number[]) => new Uint8Array(items)

describe("text-decoding", () => {
  test("detects UTF-8", () => {
    const input = new TextEncoder().encode("默认分发")
    expect(detectTextEncoding(input)).toBe("utf-8")
    expect(decodeText(input).text).toBe("默认分发")
  })

  test("detects UTF-8 BOM", () => {
    const input = bytes([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")])
    expect(detectTextEncoding(input)).toBe("utf-8")
    expect(decodeText(input).text).toBe("hello")
  })

  test("detects UTF-16LE without BOM", () => {
    const input = Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")
    expect(detectTextEncoding(input)).toBe("utf-16le")
    expect(decodeText(input).text).toContain("默认分发")
  })

  test("detects UTF-16BE without BOM", () => {
    const le = Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")
    const input = bytes(Array.from(le, (_, i) => le[i ^ 1]))
    expect(detectTextEncoding(input)).toBe("utf-16be")
    expect(decodeText(input).text).toContain("默认分发")
  })

  test("falls back to gb18030 for Windows codepage bytes", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input, { fallback: "gb18030" }).text).toBe("中文")
  })

  test("streams UTF-8 across split multibyte chunks", () => {
    const input = new TextEncoder().encode("默认分发")
    const decoder = createAutoTextDecoder()
    const output = decoder.write(input.subarray(0, 2)) + decoder.write(input.subarray(2)) + decoder.end()
    expect(output).toBe("默认分发")
    expect(decoder.encoding()).toBe("utf-8")
  })

  test("streams UTF-16LE across split chunks", () => {
    const input = Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")
    const decoder = createAutoTextDecoder()
    const output = decoder.write(input.subarray(0, 5)) + decoder.write(input.subarray(5)) + decoder.end()
    expect(output).toContain("默认分发")
    expect(decoder.encoding()).toBe("utf-16le")
  })

  test("does not lock ASCII prefixes before Windows codepage bytes", () => {
    const decoder = createAutoTextDecoder({ fallback: "gb18030" })
    const output = decoder.write(new TextEncoder().encode("prefix ")) + decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4])) + decoder.end()
    expect(output).toBe("prefix 中文")
    expect(decoder.encoding()).toBe("gb18030")
  })
})

import { describe, expect, test } from "bun:test"
import { createAutoTextDecoder, decodeText, detectTextEncoding } from "@/util/text-decoding"

const bytes = (items: number[]) => new Uint8Array(items)
const utf8 = (text: string) => new TextEncoder().encode(text)

describe("text-decoding", () => {
  test("detects UTF-8", () => {
    const input = utf8("默认分发")
    expect(detectTextEncoding(input)).toBe("utf-8")
    expect(decodeText(input).text).toBe("默认分发")
  })

  test("keeps UTF-8 box drawing and punctuation", () => {
    const input = utf8("┌─ TARGET OUTPUT ──\n— delivered")
    const output = decodeText(input).text
    expect(output).toContain("┌─ TARGET OUTPUT")
    expect(output).toContain("— delivered")
    expect(output).not.toContain("鈹")
    expect(output).not.toContain("鈥")
  })

  test("detects UTF-8 BOM", () => {
    const input = bytes([0xef, 0xbb, 0xbf, ...utf8("hello")])
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

  test("falls back to gb18030 for legacy Windows codepage bytes", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input).text).toBe("中文")
  })

  test("honors explicit utf-8 without legacy fallback", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input, { encoding: "utf-8" }).text).toContain("�")
  })

  test("honors explicit gb18030", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input, { encoding: "gb18030" }).text).toBe("中文")
  })

  test("streams UTF-8 across split multibyte chunks", () => {
    const input = utf8("默认分发\n")
    const decoder = createAutoTextDecoder()
    const output = decoder.write(input.subarray(0, 2)) + decoder.write(input.subarray(2)) + decoder.end()
    expect(output).toBe("默认分发\n")
    expect(decoder.encoding()).toBe("utf-8")
  })

  test("streams UTF-16LE across split chunks", () => {
    const input = Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")
    const decoder = createAutoTextDecoder()
    const output = decoder.write(input.subarray(0, 5)) + decoder.write(input.subarray(5)) + decoder.end()
    expect(output).toContain("默认分发")
    expect(decoder.encoding()).toBe("utf-16le")
  })

  test("streams mixed GB18030, UTF-16LE, and UTF-8 segments", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4, 0x0a])) +
      decoder.write(Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")) +
      decoder.write(utf8("┌─ TARGET OUTPUT ──\n— delivered\n")) +
      decoder.end()
    expect(output).toContain("中文")
    expect(output).toContain("默认分发: Ubuntu-22.04")
    expect(output).toContain("┌─ TARGET OUTPUT")
    expect(output).toContain("— delivered")
    expect(output).not.toContain("鈹")
    expect(output).not.toContain("鈥")
  })

  test("does not let binary prefixes lock later UTF-8 into GB18030", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(bytes([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd])) +
      decoder.write(utf8("\n┌─ TARGET OUTPUT ──\n")) +
      decoder.end()
    expect(output).toContain("┌─ TARGET OUTPUT")
    expect(output).not.toContain("鈹")
  })

  test("does not lock ASCII prefixes before legacy codepage bytes", () => {
    const decoder = createAutoTextDecoder()
    const output = decoder.write(utf8("prefix ")) + decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4, 0x0a])) + decoder.end()
    expect(output).toBe("prefix 中文\n")
  })

  test("explicit gb18030 decoder locks entire stream", () => {
    const decoder = createAutoTextDecoder({ encoding: "gb18030" })
    const output = decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4])) + decoder.write(utf8(" — text")) + decoder.end()
    expect(output).toContain("中文")
    expect(decoder.encoding()).toBe("gb18030")
  })

  test("explicit utf-8 decoder never falls back to legacy", () => {
    const decoder = createAutoTextDecoder({ encoding: "utf-8" })
    const output = decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4])) + decoder.end()
    expect(output).toContain("�")
    expect(decoder.encoding()).toBe("utf-8")
  })
})

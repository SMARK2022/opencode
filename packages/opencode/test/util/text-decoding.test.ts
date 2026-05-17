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

  test("decodes javac-style CP936 diagnostics", () => {
    const input = bytes([
      ...utf8("H:\\FRCheck\\src\\verifycmd\\VerifyCommand.java:3: "),
      0xbe,
      0xaf,
      0xb8,
      0xe6,
      0x3a,
      0x20,
      0x44,
      0x4f,
      0x4d,
      0xca,
      0xc7,
      0xc4,
      0xda,
      0xb2,
      0xbf,
      0xd7,
      0xa8,
      0xd3,
      0xc3,
      0x20,
      0x41,
      0x50,
      0x49,
      0x0a,
    ])

    expect(decodeText(input).text).toContain("警告: DOM是内部专用 API")
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

  test("random high bytes without NUL should not produce garbled Chinese", () => {
    // Simulate a fragment of binary data that has no NUL bytes and no magic bytes
    // but is clearly not valid text in any encoding — e.g., random bytes from a
    // compiled binary or encrypted stream
    const input = bytes([
      0x80, 0x91, 0xa2, 0xb3, 0xc4, 0xd5, 0xe6, 0xf7,
      0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
      0x81, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8,
    ])
    const result = decodeText(input)
    // Should use UTF-8 with replacement characters, NOT produce random Chinese
    // The key assertion: if it falls back to gb18030, it would produce Chinese chars
    // like "€\u0091¢³ÄÕæ÷" or similar — we want UTF-8 replacement instead
    expect(result.encoding).toBe("utf-8")
  })

  test("mixed UTF-8 text with a few invalid bytes uses UTF-8 with replacement", () => {
    // Common scenario: mostly valid UTF-8 with a few corrupted bytes
    const input = new Uint8Array([
      ...utf8("hello "),
      0xff, 0xfe, // invalid UTF-8 bytes
      ...utf8(" world\n"),
    ])
    const result = decodeText(input)
    expect(result.encoding).toBe("utf-8")
    expect(result.text).toContain("hello")
    expect(result.text).toContain("world")
  })

  test("streaming: random binary bytes do not produce garbled Chinese", () => {
    const decoder = createAutoTextDecoder()
    const output = decoder.write(bytes([
      0x80, 0x91, 0xa2, 0xb3, 0xc4, 0xd5, 0xe6, 0xf7,
      0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ])) + decoder.end()
    // Should contain replacement characters, not Chinese
    expect(output).toContain("�")
    expect(decoder.encoding()).toBe("utf-8")
  })

  test("streaming: UTF-8 text followed by binary does not corrupt text", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(utf8("Build succeeded\n")) +
      decoder.write(bytes([0x80, 0x91, 0xa2, 0xb3, 0xff, 0xfe, 0xfd, 0x0a])) +
      decoder.write(utf8("Done.\n")) +
      decoder.end()
    expect(output).toContain("Build succeeded")
    expect(output).toContain("Done.")
    // The binary segment should use replacement chars, not Chinese
    expect(output).toContain("�")
  })

  test("Java class file bytes are detected as binary", () => {
    // Java class file magic: 0xCA 0xFE 0xBA 0xBE
    const input = bytes([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34])
    const result = decodeText(input)
    // Should NOT decode as GB18030 Chinese
    expect(result.encoding).toBe("utf-8")
  })

  test("valid GBK with stray byte falls back to UTF-8", () => {
    // 0xd6 0xd0 is valid GBK for "中", but 0x80 is not a valid GBK lead byte
    const input = bytes([0xd6, 0xd0, 0x80, 0xce, 0xc4])
    const result = decodeText(input)
    // The stray 0x80 means this is not clean GBK
    expect(result.encoding).toBe("utf-8")
  })

  test("pure valid GBK pairs still decode correctly", () => {
    // 0xd6 0xd0 = "中", 0xce 0xc4 = "文" — all valid GBK pairs
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    const result = decodeText(input)
    expect(result.encoding).toBe("gb18030")
    expect(result.text).toBe("中文")
  })
})

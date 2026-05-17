import { describe, expect, test } from "bun:test"
import { createAutoTextDecoder, decodeText, detectTextEncoding } from "@/util/text-decoding"
// #126/#128：编码检测、分段流式解码与显式锁定

const bytes = (items: number[]) => new Uint8Array(items)
const utf8 = (text: string) => new TextEncoder().encode(text)

describe("text-decoding", () => {
  // #126：中文 UTF-8 往返
  test("detects UTF-8", () => {
    const input = utf8("默认分发")
    expect(detectTextEncoding(input)).toBe("utf-8")
    expect(decodeText(input).text).toBe("默认分发")
  })

  // #126：BOM 优先于内容探测
  test("detects UTF-8 BOM", () => {
    const input = bytes([0xef, 0xbb, 0xbf, ...utf8("hello")])
    expect(detectTextEncoding(input)).toBe("utf-8")
    expect(decodeText(input).text).toBe("hello")
  })

  // #126：无 BOM 的 UTF-16LE 靠 NUL 模式
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

  // #128：legacy Windows 字节在 auto 下走 gb18030
  test("falls back to gb18030 for legacy Windows codepage bytes", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input).text).toBe("中文")
  })

  // #128：显式 utf-8 锁定，不回落 legacy
  test("honors explicit utf-8 without legacy fallback", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input, { encoding: "utf-8" }).text).toContain("\uFFFD")
  })

  // #128：显式 gb18030
  test("honors explicit gb18030", () => {
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeText(input, { encoding: "gb18030" }).text).toBe("中文")
  })

  // #126：多字节 UTF-8 跨 chunk 不能截断
  test("streams UTF-8 across split multibyte chunks", () => {
    // 同时穿过输入 chunk 与内部 8192 字节上限，中文和四字节码点必须完整保留。
    for (const text of ["默认分发", "中".repeat(3000) + "终结-END", "😀".repeat(3000) + "终结-END"]) {
      const input = utf8(text)
      for (const split of [2, 8191, 8192, 8193]) {
        const decoder = createAutoTextDecoder()
        const output = decoder.write(input.subarray(0, split)) + decoder.write(input.subarray(split)) + decoder.end()
        expect(output).toBe(text)
        expect(decoder.encoding()).toBe("utf-8")
      }
    }
  })

  // #126：UTF-16LE 跨奇数边界仍可恢复
  test("streams UTF-16LE across split chunks", () => {
    const input = Buffer.from("默认分发: Ubuntu-22.04\r\n", "utf16le")
    const decoder = createAutoTextDecoder()
    const output = decoder.write(input.subarray(0, 5)) + decoder.write(input.subarray(5)) + decoder.end()
    expect(output).toContain("默认分发")
    expect(decoder.encoding()).toBe("utf-16le")
  })

  // #128：ASCII 前缀不锁定编码，后续可切到 gb18030
  test("does not lock ASCII prefixes before Windows codepage bytes", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(utf8("prefix ")) +
      decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4, 0x0a])) +
      decoder.end()
    expect(output).toContain("prefix ")
    expect(output).toContain("中文")
  })

  // #128：GB18030 行后接 UTF-16LE 行，分段探测不互相污染
  test("segments mixed encodings across lines", () => {
    const decoder = createAutoTextDecoder()
    const gb = bytes([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    const u16 = Buffer.from("默认分发: Ubuntu\r\n", "utf16le")
    const output = decoder.write(gb) + decoder.write(new Uint8Array(u16)) + decoder.end()
    expect(output).toContain("中文")
    expect(output).toContain("Ubuntu")
  })

  // #128：显式 gb18030 锁定整段流
  test("explicit gb18030 decoder locks entire stream", () => {
    const decoder = createAutoTextDecoder({ encoding: "gb18030" })
    const output =
      decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4])) +
      decoder.write(utf8(" — text")) +
      decoder.end()
    expect(output).toContain("中文")
    expect(decoder.encoding()).toBe("gb18030")
  })

  // #128：显式 utf-8 流不回落
  test("explicit utf-8 decoder never falls back to legacy", () => {
    const decoder = createAutoTextDecoder({ encoding: "utf-8" })
    const output = decoder.write(bytes([0xd6, 0xd0, 0xce, 0xc4])) + decoder.end()
    expect(decoder.encoding()).toBe("utf-8")
    expect(output).toContain("\uFFFD")
  })
  // #128：UTF-8 盒线/标点不得被当成 legacy 破坏
  // #128：盒线字符必须走 UTF-8
  test("keeps UTF-8 box drawing and punctuation", () => {
    const input = new TextEncoder().encode("┌─ TARGET OUTPUT ──\n— delivered\n")
    expect(decodeText(input).text).toContain("TARGET OUTPUT")
    expect(decodeText(input).text).toContain("— delivered")
    expect(detectTextEncoding(input)).toBe("utf-8")
  })

  // #128：二进制前缀不得把后续 UTF-8 锁进 gb18030
  // #128：gzip 魔数后的 UTF-8 不得锁进 gb18030
  test("does not let binary prefixes lock later UTF-8 into GB18030", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfd])) +
      decoder.write(new TextEncoder().encode("\n┌─ TARGET OUTPUT ──\n")) +
      decoder.end()
    expect(output).toContain("TARGET OUTPUT")
    expect(decoder.encoding()).not.toBe("gb18030")
  })

  // #130：javac 风格 CP936 诊断字节应落 gb18030
  test("decodes javac-style CP936 diagnostics", () => {
    const input = new Uint8Array([
      ...new TextEncoder().encode("H:\\FRCheck\\src\\verifycmd\\VerifyCommand.java:3: "),
      0xbe, 0xaf, 0xb8, 0xe6, 0x3a, 0x20,
      0x44, 0x4f, 0x4d, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xd7, 0xa8, 0xd3, 0xc3, 0x20,
      0x41, 0x50, 0x49, 0x0a,
    ])
    expect(decodeText(input).text).toContain("警告: DOM是内部专用 API")
  })

  // #160：无 NUL/魔数的随机高位字节不得回落 gb18030 产生乱码中文
  test("random high bytes without NUL should not produce garbled Chinese", () => {
    // Simulate a fragment of binary data that has no NUL bytes and no magic bytes
    // but is clearly not valid text in any encoding — e.g., random bytes from a
    // compiled binary or encrypted stream
    // #160：随机高位字节样例（无 NUL、无已知魔数）
    const input = bytes([
      0x80, 0x91, 0xa2, 0xb3, 0xc4, 0xd5, 0xe6, 0xf7,
      0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
      0x81, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8,
    ])
    const result = decodeText(input)
    // #160：应走 UTF-8 替换，而非 gb18030 乱码中文
    expect(result.encoding).toBe("utf-8")
  })

  // #160：大体 UTF-8 + 少量坏字节仍优先 UTF-8 替换
  test("mixed UTF-8 text with a few invalid bytes uses UTF-8 with replacement", () => {
    // Common scenario: mostly valid UTF-8 with a few corrupted bytes
    const input = new Uint8Array([
      ...utf8("hello "),
      0xff, 0xfe, // invalid UTF-8 bytes
      ...utf8(" world\n"),
    ])
    const result = decodeText(input)
    // #160：期望编码保持 utf-8，文本仍可读
    expect(result.encoding).toBe("utf-8")
    expect(result.text).toContain("hello")
    expect(result.text).toContain("world")
  })

  // #160：流式随机二进制不得输出乱码中文
  test("streaming: random binary bytes do not produce garbled Chinese", () => {
    const decoder = createAutoTextDecoder()
    const output =
      decoder.write(
        bytes([0x80, 0x91, 0xa2, 0xb3, 0xc4, 0xd5, 0xe6, 0xf7, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      ) + decoder.end()
    // Should contain replacement characters, not Chinese
    expect(output).toContain("�")
    expect(decoder.encoding()).toBe("utf-8")
  })

  // #160：UTF-8 文本后接二进制段，前文不得被编码锁定污染
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

  // #160：Java class 魔数（#128 hasMagic）不得当中文解码
  test("Java class file bytes are detected as binary", () => {
    // Java class file magic: 0xCA 0xFE 0xBA 0xBE
    // #160：class 文件魔数 CAFEBABE 走 looksBinary
    const input = bytes([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34])
    const result = decodeText(input)
    // Should NOT decode as GB18030 Chinese
    expect(result.encoding).toBe("utf-8")
  })

  // #160：合法 GBK 对夹杂离散 0x80 时整体否决 gb18030
  test("valid GBK with stray byte falls back to UTF-8", () => {
    // 0xd6 0xd0 is valid GBK for "中", but 0x80 is not a valid GBK lead byte
    const input = bytes([0xd6, 0xd0, 0x80, 0xce, 0xc4])
    const result = decodeText(input)
    // The stray 0x80 means this is not clean GBK
    expect(result.encoding).toBe("utf-8")
  })

  // #160：纯合法 GBK 对仍正确回落 gb18030（与 #128/#130 兼容）
  test("pure valid GBK pairs still decode correctly", () => {
    // 0xd6 0xd0 = "中", 0xce 0xc4 = "文" — all valid GBK pairs
    const input = bytes([0xd6, 0xd0, 0xce, 0xc4])
    const result = decodeText(input)
    // #160：纯 GBK 中文对必须仍可解码
    expect(result.encoding).toBe("gb18030")
    expect(result.text).toBe("中文")
  })
})

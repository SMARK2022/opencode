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

})

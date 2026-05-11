import { TextDecoder } from "node:util"

// #126：自动文本解码支持的编码集合
export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030"

type Options = {
  fallback?: TextEncoding
}

const SAMPLE_BYTES = 64
const UTF16_NULL_RATIO = 0.2

// Windows legacy console output is usually GBK-compatible; gb18030 is the widest native decoder label.
// #126：无 BOM/高位特征时回落编码（Windows 默认 gb18030）
function fallback(options?: Options): TextEncoding {
  return options?.fallback ?? (process.platform === "win32" ? "gb18030" : "utf-8")
}

// BOMs are authoritative and avoid all heuristic guessing.
// #126：优先读 BOM 判定编码
function bom(bytes: Uint8Array): TextEncoding | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
}

// UTF-16 text without a BOM often exposes NUL bytes on every ASCII code unit.
// #126：无 BOM 的 UTF-16 常有周期性 NUL 字节
function utf16ByNulls(bytes: Uint8Array): TextEncoding | undefined {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let even = 0
  let odd = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue
    if (i % 2 === 0) even++
    else odd++
  }
  // #126：偶数位 NUL 比例偏高 → UTF-16BE 倾向
  const evenSlots = Math.ceil(sample.length / 2)
  // #126：奇数位 NUL 比例偏高 → UTF-16LE 倾向
  const oddSlots = Math.floor(sample.length / 2)
  // #126：奇数位主导且远强于偶数位
  if (odd >= 2 && odd / oddSlots > UTF16_NULL_RATIO && odd > even * 3) return "utf-16le"
  // #126：偶数位主导且远强于奇数位
  if (even >= 2 && even / evenSlots > UTF16_NULL_RATIO && even > odd * 3) return "utf-16be"
}

// Strict UTF-8 differentiates real UTF-8 from Windows codepage bytes without replacement characters.
// #126：fatal UTF-8 解码区分真 UTF-8 与 codepage 字节
function isUtf8(bytes: Uint8Array, stream = false) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream })
    return true
  } catch {
    return false
  }
}

// #126：是否含非 ASCII 高位字节
function hasHighBit(bytes: Uint8Array) {
  return bytes.some((byte) => byte >= 0x80)
}

// #126：纯 ASCII 可安全按 UTF-8 透传而不提交编码
function isAsciiText(bytes: Uint8Array) {
  return bytes.every((byte) => byte > 0 && byte < 0x80)
}

// #126：合并缓冲块供探测
function concat(chunks: Uint8Array[], size: number) {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// #126：综合 BOM/NUL/UTF-8/高位字节选择编码
function choose(bytes: Uint8Array, options: Options | undefined, final: boolean): TextEncoding | undefined {
  if (bytes.length === 0) return "utf-8"
  const certain = bom(bytes) ?? utf16ByNulls(bytes)
  if (certain) return certain
  if (isUtf8(bytes, !final)) return !hasHighBit(bytes) || final || bytes.length >= SAMPLE_BYTES ? "utf-8" : undefined
  return final || bytes.length >= SAMPLE_BYTES ? fallback(options) : undefined
}

// #126：一次性探测最终编码
// #126：探测失败时回落 fallback（Windows 常用 gb18030）
export function detectTextEncoding(bytes: Uint8Array, options?: Options): TextEncoding {
  return choose(bytes, options, true) ?? "utf-8"
}

// #126：整段解码并返回文本与选用编码
export function decodeText(bytes: Uint8Array, options?: Options) {
  const encoding = detectTextEncoding(bytes, options)
  return {
    encoding,
    text: new TextDecoder(encoding).decode(bytes),
  }
}

// #126：流式解码器：先缓冲再提交编码，避免把 ASCII 前缀锁死
export function createAutoTextDecoder(options?: Options) {
  let encoding: TextEncoding | undefined
  // #126：编码确定前 decoder 为空
  let decoder: TextDecoder | undefined
  let size = 0
  const pending: Uint8Array[] = []

  const flush = (final: boolean) => {
    if (decoder) return decoder.decode(undefined, { stream: !final })
    const bytes = concat(pending, size)
    encoding = choose(bytes, options, final)
    if (!encoding) return ""
    decoder = new TextDecoder(encoding)
    pending.length = 0
    size = 0
    return decoder.decode(bytes, { stream: !final })
  }

  return {
    write(chunk: Uint8Array) {
      if (decoder) return decoder.decode(chunk, { stream: true })
      // #126：ASCII 在 UTF-8 与 codepage 中相同，可暂不提交 decoder
      // ASCII bytes are identical in UTF-8 and Windows codepages, so emit them without committing the decoder.
      // #126：纯 ASCII 先 UTF-8 透传，不锁死最终编码
    if (pending.length === 0 && isAsciiText(chunk)) return new TextDecoder("utf-8").decode(chunk)
      pending.push(chunk)
      size += chunk.length
      return flush(false)
    },
    end() {
      return flush(true)
    },
    encoding() {
      return encoding
    },
  }
}

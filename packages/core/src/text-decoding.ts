import { TextDecoder } from "node:util"

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030"
// #128：auto 或显式锁定编码
export type TextEncodingMode = "auto" | TextEncoding

type Options = {
  encoding?: TextEncodingMode
}

const MAX_SEGMENT_BYTES = 8192
// #172：UTF-16 对齐探测窗口（至少 1 个 code unit + 样本）
const UTF16_PROBE_BYTES = 4
const UTF16_NULL_RATIO = 0.2
const EMPTY: Uint8Array<ArrayBuffer> = new Uint8Array(0)

// Return explicit encoding if set, undefined for auto mode.
// #128：显式 encoding 非 auto 时锁定整段流
function fixed(options?: Options): TextEncoding | undefined {
  const encoding = options?.encoding
  return encoding && encoding !== "auto" ? encoding : undefined
}

// BOMs are authoritative and avoid all heuristic guessing.
function bom(bytes: Uint8Array): TextEncoding | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
}

// UTF-16 text without a BOM often exposes NUL bytes on every ASCII code unit.
function utf16ByNulls(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let even = 0
  let odd = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue
    if (i % 2 === 0) even++
    else odd++
  }
  const evenSlots = Math.ceil(sample.length / 2)
  const oddSlots = Math.floor(sample.length / 2)
  if (odd >= 2 && odd / oddSlots > UTF16_NULL_RATIO && odd > even * 3) return "utf-16le"
  if (even >= 2 && even / evenSlots > UTF16_NULL_RATIO && even > odd * 3) return "utf-16be"
}

// #128：BOM 与 NUL 模式识别 Unicode
function unicode(bytes: Uint8Array): TextEncoding | undefined {
  return bom(bytes) ?? utf16ByNulls(bytes)
}

// Strict UTF-8 check: valid bytes pass, anything invalid fails without replacement.
// #128：fatal UTF-8 校验，失败则不认 UTF-8
function isUtf8(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

// Returns the number of leading ASCII bytes (0x01–0x7f) safe to emit without committing an encoding.
// #128：可安全透传的前缀 ASCII 长度
function asciiPrefixLength(bytes: Uint8Array) {
  let i = 0
  while (i < bytes.length && bytes[i] > 0 && bytes[i] < 0x80) i++
  return i
}

// #172：短 ASCII 可能是无 BOM UTF-16LE 的低字节，非 final 时先缓冲
function shouldBufferAsciiPrefix(bytes: Uint8Array, final: boolean) {
  // #172：final 必须冲刷，不能再等
  if (final) return false
  // #172：达段上限仍强制 emit，避免死等
  if (bytes.length >= MAX_SEGMENT_BYTES) return false
  return bytes.length < UTF16_PROBE_BYTES
}

// #128：按换行切段，避免一段编码污染下一段
function findLineEnd(bytes: Uint8Array) {
  const index = bytes.indexOf(0x0a)
  return index === -1 ? undefined : index + 1
}

// #128：UTF-16 换行边界（含 0x0a 00 / 00 0x0a）
function findUtf16LineEnd(bytes: Uint8Array, encoding: "utf-16le" | "utf-16be") {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (encoding === "utf-16le" && bytes[i] === 0x0a && bytes[i + 1] === 0x00) return i + 2
    if (encoding === "utf-16be" && bytes[i] === 0x00 && bytes[i + 1] === 0x0a) return i + 2
  }
}

// #128：UTF-16 按 2 字节对齐截断
function evenLength(length: number) {
  return length - (length % 2)
}

// Known binary magic bytes that should never be decoded as text.
// #128：已知二进制魔数，禁止当文本解码
// #128：二进制魔数命中时勿当文本
function hasMagic(bytes: Uint8Array) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true
  if (bytes[0] === 0xac && bytes[1] === 0xed && bytes[2] === 0x00 && bytes[3] === 0x05) return true
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return true
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) return true
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return true
  return false
}

// #128：允许的控制字节（TAB/LF/CR）
function isTextControl(byte: number) {
  return byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x1b
}

// Binary-looking data must not trigger GB18030 fallback because that pollutes later UTF-8.
// #128：控制字节密度启发式判定二进制
// #128：控制字节过多时按二进制处理
function looksBinary(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  if (hasMagic(bytes)) return true
  if (bytes.some((byte) => byte === 0)) return true
  let controls = 0
  for (const byte of bytes) {
    if (byte < 0x20 && !isTextControl(byte)) controls++
  }
  return controls >= 4 || controls / bytes.length > 0.05
}

/**
 * #160：校验非 ASCII 是否构成可信 GBK/GB18030 双字节序列。
 * 引导字节 0x81-0xFE，尾字节 0x40-0xFE（排除 0x7F）；任一离散高位字节即否决。
 */
function looksLikeGBK(bytes: Uint8Array) {
  // #160：短于双字节无法形成 GBK 对
  if (bytes.length < 2) return false
  let validPairs = 0
  let invalidBytes = 0
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    // #160：ASCII 单字节透传，不计入 GBK 对
    if (b < 0x80) {
      i++
      continue
    }
    // #160：GBK 引导字节区间；需成对消费尾字节
    if (b >= 0x81 && b <= 0xfe && i + 1 < bytes.length) {
      const trail = bytes[i + 1]
      // #160：尾字节合法区间且排除 0x7F 控制空洞
      if (trail >= 0x40 && trail <= 0xfe && trail !== 0x7f) {
        validPairs++
        i += 2
        continue
      }
    }
    // #160：无法落入 GBK 双字节则记为无效，整段不得回落 gb18030
    invalidBytes++
    i++
  }
  // #160：零合法对说明没有任何中文双字节证据
  if (validPairs === 0) return false
  // #160：要求全部非 ASCII 均成合法对，禁止夹杂离散高位字节
  return invalidBytes === 0
}

/**
 * #160：多数非 ASCII 已是合法 UTF-8 多字节时，优先 UTF-8 替换而非乱码中文。
 * 用于“大体 UTF-8 + 少量坏字节”场景，避免误判为 CP936。
 */
function mostlyUtf8(bytes: Uint8Array) {
  // #160：分别累计合法/非法 UTF-8 多字节，供多数表决
  let validMultibyte = 0
  let invalidMultibyte = 0
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    // #160：ASCII 不参与多数表决
    if (b < 0x80) {
      i++
      continue
    }
    // #160：2 字节 UTF-8（110xxxxx 10xxxxxx）
    if ((b & 0xe0) === 0xc0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
      validMultibyte++
      i += 2
      continue
    }
    // #160：3 字节 UTF-8（1110xxxx 10xxxxxx 10xxxxxx）
    if (
      (b & 0xf0) === 0xe0 &&
      i + 2 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80
    ) {
      validMultibyte++
      i += 3
      continue
    }
    // #160：4 字节 UTF-8（11110xxx + 三个续字节）
    if (
      (b & 0xf8) === 0xf0 &&
      i + 3 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80 &&
      (bytes[i + 3] & 0xc0) === 0x80
    ) {
      validMultibyte++
      i += 4
      continue
    }
    // #160：无法匹配 2/3/4 字节 UTF-8 形态则计为无效多字节
    invalidMultibyte++
    i++
  }
  const total = validMultibyte + invalidMultibyte
  // #160：全 ASCII 段不适用 mostlyUtf8 偏好
  if (total === 0) return false
  // #160：有效多字节序列多于无效时，判定为“大体 UTF-8”
  return validMultibyte > invalidMultibyte
}

// #128：固定编码解码并返回 {text,encoding}
function decodeWith(bytes: Uint8Array, encoding: TextEncoding) {
  return {
    encoding,
    text: new TextDecoder(encoding).decode(bytes),
  }
}

// Decode a single segment: UTF-16 preferred, then UTF-8, then GB18030 legacy fallback, then UTF-8 replacement.
// #128：单段自动探测：unicode → utf-8 → gb18030 → utf-8
// #160：gb18030 回落再与 looksLikeGBK / !mostlyUtf8 合取，保留 #128 魔数与控制密度门
function decodeAutoSegment(bytes: Uint8Array) {
  // #160：BOM/NUL 识别的 unicode 仍最优先
  const detected = unicode(bytes)
  if (detected) return decodeWith(bytes, detected)
  // #160：严格 UTF-8 通过则锁定 utf-8，跳过 legacy
  if (isUtf8(bytes)) return decodeWith(bytes, "utf-8")
  // #160：仅当非二进制、像真 GBK、且不像大体 UTF-8 时才回落 gb18030
  // #160：!looksBinary 保留 #128 魔数与控制密度启发式，不替换只合取
  if (!looksBinary(bytes) && looksLikeGBK(bytes) && !mostlyUtf8(bytes)) return decodeWith(bytes, "gb18030")
  // #160：默认 UTF-8 替换字符，避免二进制被译成中文
  return decodeWith(bytes, "utf-8")
}

// #128：对外导出：显式模式或 auto 探测结果
export function detectTextEncoding(bytes: Uint8Array, options?: Options): TextEncoding {
  const forced = fixed(options)
  if (forced) return forced
  return decodeAutoSegment(bytes).encoding
}

// #128：一次性解码整段字节
export function decodeText(bytes: Uint8Array, options?: Options) {
  const forced = fixed(options)
  if (forced) return decodeWith(bytes, forced)
  return decodeAutoSegment(bytes)
}

// Streaming decoder that segments output so one encoding segment does not pollute later ones.
// #128：分段流式解码，一段一种编码，避免污染后续输出
export function createAutoTextDecoder(options?: Options) {
  const forced = fixed(options)
  if (forced) {
    const decoder = new TextDecoder(forced)
    return {
      write(chunk: Uint8Array) {
        return decoder.decode(chunk, { stream: true })
      },
      end() {
        return decoder.decode()
      },
      encoding() {
        return forced
      },
    }
  }

  let pending: Uint8Array<ArrayBuffer> = EMPTY
  let lastEncoding: TextEncoding | undefined

  // #128：切出 pending 前缀并解码，记录 lastEncoding
  const emit = (length: number, encoding?: TextEncoding) => {
    const segment = pending.subarray(0, length) as Uint8Array<ArrayBuffer>
    pending = pending.subarray(length) as Uint8Array<ArrayBuffer>
    const decoded = encoding ? decodeWith(segment, encoding) : decodeAutoSegment(segment)
    lastEncoding = decoded.encoding
    return decoded.text
  }

  // Drain one UTF-16 segment (line, max-size, or final) using a locked encoding for this emission only.
  // #128：UTF-16 流按行/上限/final 分段 drain
  const drainUtf16 = (encoding: "utf-16le" | "utf-16be", final: boolean) => {
    const lineEnd = findUtf16LineEnd(pending, encoding)
    if (lineEnd) return emit(lineEnd, encoding)
    if (pending.length >= MAX_SEGMENT_BYTES) {
      const length = evenLength(Math.min(pending.length, MAX_SEGMENT_BYTES))
      return length > 0 ? emit(length, encoding) : ""
    }
    if (final) {
      const length = evenLength(pending.length)
      return length > 0 ? emit(length, encoding) : ""
    }
    return ""
  }

  const drain = (final: boolean) => {
    let output = ""
    while (pending.length > 0) {
      // UTF-16 detection: emit as much as possible at UTF-16 line boundaries.
      const uni = unicode(pending)
      if (uni === "utf-16le" || uni === "utf-16be") {
        const next = drainUtf16(uni, final)
        if (!next) break
        output += next
        continue
      }
      // #172：ASCII 对 UTF-8/GB 安全，但短前缀可能是无 BOM UTF-16LE 半 code unit
      const ascii = asciiPrefixLength(pending)
      if (ascii > 0) {
        if (shouldBufferAsciiPrefix(pending, final)) break
        output += emit(ascii, "utf-8")
        continue
      }
      // Emit at newline boundaries — most CLI output is line-oriented.
      const lineEnd = findLineEnd(pending)
      if (lineEnd) {
        output += emit(lineEnd)
        continue
      }
      // Avoid buffering indefinitely. Emit a segment when it grows too large.
      if (pending.length >= MAX_SEGMENT_BYTES) {
        // UTF-8 码点最多四字节；完整前缀留在同一探测路径，残缺尾部等下次字节。
        let length = MAX_SEGMENT_BYTES
        while (length > MAX_SEGMENT_BYTES - 3 && !isUtf8(pending.subarray(0, length))) length--
        output += emit(isUtf8(pending.subarray(0, length)) ? length : MAX_SEGMENT_BYTES)
        continue
      }
      // Flush everything on end().
      if (final) {
        output += emit(pending.length)
        continue
      }
      break
    }
    return output
  }

  return {
    write(chunk: Uint8Array) {
      pending = appendBuffer(pending, chunk)
      return drain(false)
    },
    end() {
      return drain(true)
    },
    encoding() {
      return lastEncoding
    },
  }
}

// #128：合并 pending 与新 chunk
function appendBuffer(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  if (left.length === 0) return right as Uint8Array<ArrayBuffer>
  if (right.length === 0) return left as Uint8Array<ArrayBuffer>
  const out = new Uint8Array(left.length + right.length) as Uint8Array<ArrayBuffer>
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

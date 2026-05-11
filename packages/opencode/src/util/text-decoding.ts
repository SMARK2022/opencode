export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030"
export type TextEncodingMode = "auto" | TextEncoding

type Options = {
  encoding?: TextEncodingMode
}

const MAX_SEGMENT_BYTES = 8192
const UTF16_NULL_RATIO = 0.2
const EMPTY: Uint8Array<ArrayBuffer> = new Uint8Array(0)

// Return explicit encoding if set, undefined for auto mode.
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

function unicode(bytes: Uint8Array): TextEncoding | undefined {
  return bom(bytes) ?? utf16ByNulls(bytes)
}

// Strict UTF-8 check: valid bytes pass, anything invalid fails without replacement.
function isUtf8(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

// Returns the number of leading ASCII bytes (0x01–0x7f) safe to emit without committing an encoding.
function asciiPrefixLength(bytes: Uint8Array) {
  let i = 0
  while (i < bytes.length && bytes[i] > 0 && bytes[i] < 0x80) i++
  return i
}

function findLineEnd(bytes: Uint8Array) {
  const index = bytes.indexOf(0x0a)
  return index === -1 ? undefined : index + 1
}

function findUtf16LineEnd(bytes: Uint8Array, encoding: "utf-16le" | "utf-16be") {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (encoding === "utf-16le" && bytes[i] === 0x0a && bytes[i + 1] === 0x00) return i + 2
    if (encoding === "utf-16be" && bytes[i] === 0x00 && bytes[i + 1] === 0x0a) return i + 2
  }
}

function evenLength(length: number) {
  return length - (length % 2)
}

// Known binary magic bytes that should never be decoded as text.
function hasMagic(bytes: Uint8Array) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true
  if (bytes[0] === 0xac && bytes[1] === 0xed && bytes[2] === 0x00 && bytes[3] === 0x05) return true
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return true
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) return true
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return true
  return false
}

function isTextControl(byte: number) {
  return byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x1b
}

// Binary-looking data must not trigger GB18030 fallback because that pollutes later UTF-8.
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

function decodeWith(bytes: Uint8Array, encoding: TextEncoding) {
  return {
    encoding,
    text: new TextDecoder(encoding).decode(bytes),
  }
}

// Decode a single segment: UTF-16 preferred, then UTF-8, then GB18030 legacy fallback, then UTF-8 replacement.
function decodeAutoSegment(bytes: Uint8Array) {
  const detected = unicode(bytes)
  if (detected) return decodeWith(bytes, detected)
  if (isUtf8(bytes)) return decodeWith(bytes, "utf-8")
  if (!looksBinary(bytes)) return decodeWith(bytes, "gb18030")
  return decodeWith(bytes, "utf-8")
}

export function detectTextEncoding(bytes: Uint8Array, options?: Options): TextEncoding {
  const forced = fixed(options)
  if (forced) return forced
  return decodeAutoSegment(bytes).encoding
}

export function decodeText(bytes: Uint8Array, options?: Options) {
  const forced = fixed(options)
  if (forced) return decodeWith(bytes, forced)
  return decodeAutoSegment(bytes)
}

// Streaming decoder that segments output so one encoding segment does not pollute later ones.
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

  const emit = (length: number, encoding?: TextEncoding) => {
    const segment = pending.subarray(0, length) as Uint8Array<ArrayBuffer>
    pending = pending.subarray(length) as Uint8Array<ArrayBuffer>
    const decoded = encoding ? decodeWith(segment, encoding) : decodeAutoSegment(segment)
    lastEncoding = decoded.encoding
    return decoded.text
  }

  // Drain one UTF-16 segment (line, max-size, or final) using a locked encoding for this emission only.
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
      // ASCII prefix is safe in both UTF-8 and GB18030 — emit immediately.
      const ascii = asciiPrefixLength(pending)
      if (ascii > 0) {
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
        output += emit(MAX_SEGMENT_BYTES)
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

function appendBuffer(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  if (left.length === 0) return right as Uint8Array<ArrayBuffer>
  if (right.length === 0) return left as Uint8Array<ArrayBuffer>
  const out = new Uint8Array(left.length + right.length) as Uint8Array<ArrayBuffer>
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

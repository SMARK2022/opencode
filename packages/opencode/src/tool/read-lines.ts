import { createReadStream } from "fs"

// 256 KiB 足以让常见小尾部保留精确 total，同时把多 MB 头读的重复 I/O 固定在较低上界。
export const AUXILIARY_SCAN_BYTES = 256 * 1024
// 读取按 16 KiB chunk 进行，因此物理上界允许最后一个已请求 chunk 越过逻辑额度。
export const AUXILIARY_READ_AHEAD_BYTES = 16 * 1024
const MAX_CONTENT_BYTES = 16 * 1024
// 辅助扫描只需保留足够识别 outline 的行首；超长行余部仅计数，避免恢复整行内存成本。
const MAX_AUXILIARY_LINE_CHARS = 4096

// 同一次 read execute 的 page accounting 与 outline 共用此对象，任何消费者都不能重置额度。
export type AuxiliaryBudget = {
  remaining: number
}

// 物理字节统计只服务于内部回归测试，不进入 Tool metadata、消息 schema 或持久化数据。
export type ReadPage = {
  raw: string[]
  count: number
  cut: boolean
  more: boolean
  offset: number
  physicalBytesRead: number
  postWindowBytes: number
}

type ReadTextPageOptions = {
  limit: number
  offset: number
  budget?: AuxiliaryBudget
  // outline 从首字节起就是辅助消费者，因此它的全部输入都计入共享额度。
  auxiliaryFromStart?: boolean
  // outline 只消费 callback，不复制扫描文本到 raw，避免第二份 3000 行缓冲。
  captureRaw?: boolean
  // page 使用固定 16 KiB；outline 传 Infinity 仅关闭返回窗口限制，仍受共享物理预算约束。
  contentBytesLimit?: number
  onLine?: (line: string, lineNumber: number) => boolean | void
}

export function createAuxiliaryBudget(): AuxiliaryBudget {
  return { remaining: AUXILIARY_SCAN_BYTES }
}

export async function readTextPage(filepath: string, opts: ReadTextPageOptions): Promise<ReadPage> {
  const budget = opts.budget ?? createAuxiliaryBudget()
  const captureRaw = opts.captureRaw ?? true
  const contentBytesLimit = opts.contentBytesLimit ?? MAX_CONTENT_BYTES
  const auxiliaryFromStart = opts.auxiliaryFromStart ?? false
  const stream = createReadStream(filepath, { highWaterMark: AUXILIARY_READ_AHEAD_BYTES })
  // 流式 decoder 保留跨 chunk 的 UTF-8 状态，不能按独立 Buffer 逐块解码。
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  const raw: string[] = []
  const start = opts.offset - 1
  let lineText = ""
  // 该计数按 Unicode code point 增量维护，必须与 Buffer.byteLength 的 UTF-8 结果一致。
  let lineEncodedBytes = 0
  // offset 前不保存 lineText，另用此位保证末尾未终止前缀行仍能在 EOF 时计数。
  let lineHasContent = false
  let contentBytes = 0
  let count = 0
  let returnedLines = 0
  let cut = false
  let more = false
  // content 模式负责可返回窗口；auxiliary 模式只改进 total 下界，绝不追加 raw。
  let mode: "content" | "auxiliary" = auxiliaryFromStart ? "auxiliary" : "content"
  // CR 必须延迟到看见下一字符后定性，才能同时兼容 CRLF 与孤立 CR。
  let pendingCR = false
  // 辅助边界可能截在未终止行中；该标记保证这条可观察行恰好计数一次。
  let auxiliaryLineObserved = false
  // 额度在 chunk 内耗尽时仍处理已读取 chunk，但不会请求普通后续 chunk。
  let stopAfterChunk = false
  // 唯一例外是边界恰好落在 CR 后：允许一个 chunk 判断后续是否为 LF。
  let resolveCRReadAhead = false
  let stopped = false
  let physicalBytesRead = 0
  let postWindowBytes = 0

  const markAuxiliaryLine = () => {
    // total 在早停时是下界；看到一条未返回行的首字符就足以将下界推进一行。
    if (auxiliaryLineObserved) return
    auxiliaryLineObserved = true
    count += 1
  }

  const chargeChunk = (size: number) => {
    if (mode !== "auxiliary") return
    // chunk 可能横跨窗口边界，整块扣费是保守上界，确保实际读取不会逃逸共享预算。
    postWindowBytes += size
    budget.remaining = Math.max(0, budget.remaining - size)
    if (budget.remaining === 0) stopAfterChunk = true
  }

  const enterAuxiliary = (size: number, lineAlreadyCounted = false) => {
    if (mode === "auxiliary") return
    mode = "auxiliary"
    // more 描述返回内容仍不完整；后续即使在额度内到达 EOF，也必须保持为 true。
    more = true
    auxiliaryLineObserved = lineAlreadyCounted
    markAuxiliaryLine()
    chargeChunk(size)
  }

  const resetLine = () => {
    lineText = ""
    lineEncodedBytes = 0
    lineHasContent = false
    auxiliaryLineObserved = false
  }

  const finishLine = () => {
    if (mode === "auxiliary") {
      // 空行只有分隔符没有正文，仍需在完成分隔符时建立一条行下界。
      markAuxiliaryLine()
      const callbackResult = opts.onLine?.(lineText, count)
      if (callbackResult === true) {
        more = true
        stopped = true
      }
      resetLine()
      return
    }

    count += 1
    const lineNumber = count
    // offset 之前是请求必需的前缀，不消耗返回内容预算，也不属于 post-window 预算。
    if (lineNumber <= start) {
      resetLine()
      return
    }

    const separatorBytes = returnedLines > 0 ? 1 : 0
    const candidateBytes = lineEncodedBytes
    // 行数窗口已满时，当前完整行只用于证明仍有内容，不能进入 raw。
    if (returnedLines >= opts.limit) {
      enterAuxiliary(0, true)
      resetLine()
      return
    }

    // 16 KiB 按最终 join 语义累计：后续行还要计一个换行分隔字节。
    if (contentBytes + separatorBytes + candidateBytes > contentBytesLimit) {
      cut = true
      enterAuxiliary(0, true)
      resetLine()
      return
    }

    if (captureRaw) raw.push(lineText)
    returnedLines += 1
    contentBytes += separatorBytes + candidateBytes
    const callbackResult = opts.onLine?.(lineText, lineNumber)
    if (callbackResult === true) {
      more = true
      stopped = true
    }
    resetLine()
  }

  const enterAuxiliaryIfWindowFilled = (chunkSize: number, characterBytes: number) => {
    if (mode === "auxiliary") return
    if (returnedLines >= opts.limit) {
      enterAuxiliary(chunkSize)
      return
    }
    if (Number.isFinite(contentBytesLimit) && count + 1 > start) {
      // 增量字节数避免每个字符重复编码整行，否则超长行会退化为平方复杂度。
      const candidateBytes = lineEncodedBytes + characterBytes
      const separatorBytes = returnedLines > 0 ? 1 : 0
      if (contentBytes + separatorBytes + candidateBytes > contentBytesLimit) {
        cut = true
        enterAuxiliary(chunkSize)
      }
    }
  }

  const appendCharacter = (character: string, characterBytes: number, chunkSize: number) => {
    lineHasContent = true
    // offset 前只需要行边界和计数，保留正文既无输出价值，也会放大高 offset 的 CPU 与内存成本。
    if (mode === "content" && count + 1 <= start) return
    enterAuxiliaryIfWindowFilled(chunkSize, characterBytes)
    if (mode === "auxiliary") {
      markAuxiliaryLine()
      // outline 只需要有限行首；page accounting 路径没有回调，因此丢弃余部不改变输出。
      if (lineText.length < MAX_AUXILIARY_LINE_CHARS) lineText += character
      return
    }
    lineText += character
    lineEncodedBytes += characterBytes
  }

  const processText = (text: string, chunkSize: number) => {
    let index = 0
    while (index < text.length && !stopped) {
      // 四字节 UTF-8 字符在 JS 中是 surrogate pair；拆成两个 code unit 会错误累计为 6 字节。
      const code = text.charCodeAt(index)
      const pair =
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      const character = pair ? text.slice(index, index + 2) : text[index]!
      const characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : pair ? 4 : 3

      if (auxiliaryFromStart && count >= opts.limit && !auxiliaryLineObserved) {
        // outline 的 3000 行上限在观察到下一行时才置 truncated，文件恰好结束则保持完整。
        more = true
        markAuxiliaryLine()
        stopped = true
        break
      }

      if (pendingCR) {
        pendingCR = false
        if (character === "\n") {
          // CRLF 是一个逻辑分隔符，消费 LF 后不能再产生空行。
          finishLine()
          index += character.length
          continue
        }
        // 非 LF 证明前一个 CR 是孤立分隔符；当前字符留给下一轮重新处理。
        finishLine()
        continue
      }

      if (character === "\r") {
        // chunk 末尾 CR 的归属未知，保留状态到下一 chunk 或物理 EOF。
        pendingCR = true
        if (mode === "auxiliary") markAuxiliaryLine()
        index += character.length
        continue
      }

      if (character === "\n") {
        finishLine()
        index += character.length
        continue
      }

      appendCharacter(character, characterBytes, chunkSize)
      index += character.length
    }
  }

  try {
    if (mode === "auxiliary" && budget.remaining === 0) stopped = true
    // physicalBytesRead 以真实 stream chunk 计量，使测试能发现任何重新引入的 EOF 全扫。
    for await (const chunk of stream) {
      if (stopped) break
      physicalBytesRead += chunk.byteLength
      if (resolveCRReadAhead) {
        // read-ahead 计入物理 post-window 统计，但不再扣减已经归零的逻辑额度。
        postWindowBytes += chunk.byteLength
        const text = decoder.decode(chunk, { stream: true })
        if (text.startsWith("\n")) {
          pendingCR = false
          finishLine()
          // 同一 read-ahead chunk 的 LF 后若仍有字节，至少还观察到下一条未返回行。
          if (text.length > 1) markAuxiliaryLine()
        } else {
          pendingCR = false
          finishLine()
          // 非 LF 首字符属于下一行；只推进下界，不继续解析整块文本。
          if (text.length > 0) markAuxiliaryLine()
        }
        break
      }
      if (mode === "auxiliary") chargeChunk(chunk.byteLength)
      const text = decoder.decode(chunk, { stream: true })
      processText(text, chunk.byteLength)
      if (stopAfterChunk) {
        // 普通预算停止发生在已读取 chunk 末尾；只有未决 CR 才授权下一次流读取。
        if (pendingCR) {
          resolveCRReadAhead = true
          stopAfterChunk = false
          continue
        }
        break
      }
    }

    if (!stopped && !stopAfterChunk) {
      // 仅在真实 EOF 刷出 decoder；预算早停时禁止把未读取余部误判为完整文件。
      processText(decoder.decode(), 0)
      if (pendingCR) {
        pendingCR = false
        // 物理 EOF 后的 CR 是孤立分隔符，且不会凭空创建额外尾随空行。
        finishLine()
      } else if (lineHasContent || auxiliaryLineObserved) {
        // 与 readline 一致，末尾没有分隔符的非空行仍计作一行。
        finishLine()
      }
    }
  } finally {
    stream.destroy()
  }

  // 任一辅助早停原因都证明扫描结果不是 EOF 证明，必须保留内容未完成信号。
  if (mode === "auxiliary" && (budget.remaining === 0 || stopAfterChunk || stopped)) more = true
  return { raw, count, cut, more, offset: opts.offset, physicalBytesRead, postWindowBytes }
}

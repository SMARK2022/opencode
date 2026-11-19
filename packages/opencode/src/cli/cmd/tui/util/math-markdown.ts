/*
Adapted from dsh-TUI src/terminal-utils/math.ts at 2d6c9a13fc30358913e88129c79640d50ca0c6db.
MIT License

Copyright (c) 2026, chimney (ccch1mneyyy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { MarkdownTokenizerExtension } from "@opentui/core"

type MathToken = {
  raw: string
  text: string
  pending?: boolean
}

export function makeMathExtensions(renderLatex: (source: string) => string | undefined) {
  // 连续反斜线按成对的字面量消去，只有剩余单个反斜线转义定界符。
  // 向前检查原始输入，避免先解码后丢失美元与反斜线的原有边界。
  function isEscaped(source: string, index: number): boolean {
    let backslashes = 0
    for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
      backslashes++
    }
    return backslashes % 2 === 1
  }

  // 被转义的闭合记号仍属于公式正文，搜索必须继续到下一个候选。
  // 搜索起点越过完整开记号，防止双美元开头同时被当成闭合。
  function findClosingDelimiter(source: string, closing: string, start: number): number {
    let index = source.indexOf(closing, start)
    while (index >= 0 && isEscaped(source, index)) {
      index = source.indexOf(closing, index + 1)
    }
    return index
  }

  // 缺少闭合的美元块还可能是金额段落，只对含数学迹象的正文保留待完成状态。
  // 完整闭合公式由正式定界符识别，不受这条流式启发式限制。
  function looksLikeMath(source: string): boolean {
    return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source)
  }

  // 美元也承担金额和shell变量语义，不能把所有成对美元都送入公式引擎。
  // 这里仅裁决美元记号，显式LaTeX括号仍使用自己的边界合同。
  function isDollarProse(body: string, after: string): boolean {
    if (/^\s|\s$/.test(body) || body.startsWith("{")) return true
    // 闭合美元后紧接英文或数字时保留原文，避免截断变量和金额组成的连续词。
    // 中文相邻文本允许结束公式，支持没有空格分隔的自然中文段落。
    if (/^[A-Za-z0-9]/.test(after)) return true
    // 内嵌反引号由Markdown代码语义拥有，美元识别不能跨过它重新解释代码。
    if (body.includes("`")) return true
    if (/^\d/.test(body) && !/[\\^_=+\-*/<>]/.test(body)) return true
    if (body.length > 1 && /^[A-Z]+$/.test(body)) return true
    return /^[A-Z_][A-Z0-9_]*[^A-Za-z0-9_\s]?$/.test(body) && /^[A-Za-z_]/.test(after)
  }

  // 双美元必须先于单美元匹配，否则长开记号会被短前缀抢占。
  // 显式括号也可出现在段落内，块级资格另由块tokenizer判断。
  const INLINE_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
    ["$$", "$$"],
    ["\\(", "\\)"],
    ["\\[", "\\]"],
    ["$", "$"],
  ]

  function tokenizeInlineMath(source: string): MathToken | undefined {
    const delimiter = INLINE_DELIMITERS.find(([opening]) => source.startsWith(opening))
    if (delimiter === undefined) return undefined
    const [opening, closing] = delimiter
    const closingIndex = findClosingDelimiter(source, closing, opening.length)
    if (closingIndex < 0) return undefined
    const text = source.slice(opening.length, closingIndex)
    // 行内替换必须保持同一文本行；跨行布局交给块级渲染。
    // 空公式保留定界符，避免用户尚未写完内容时出现无依据的删除。
    if (text.trim() === "" || text.includes("\n")) return undefined
    if (opening.startsWith("$") && isDollarProse(text, source.slice(closingIndex + closing.length))) {
      return undefined
    }
    return {
      raw: source.slice(0, closingIndex + closing.length),
      text,
    }
  }

  // 最多三格缩进沿用Markdown块起点，四格代码缩进继续归原解析器。
  const BLOCK_OPENER = /^ {0,3}(\$\$|\\\[)/

  // 只认参考实现约定的显示环境，其他begin语法继续作为原文。
  // 星号属于环境名的一部分，闭合时必须与开环境保持一致。
  const ENVIRONMENT_OPENER =
    /^ {0,3}\\begin\{((?:equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|aligned|gathered)\*?)\}/

  function tokenizeEnvironmentBlock(source: string, opener: RegExpExecArray): MathToken | undefined {
    const name = opener[1]!
    const begin = `\\begin{${name}}`
    const end = `\\end{${name}}`
    // 同名环境可嵌套，必须等最外层闭合后才结束当前块。
    // 计数仅追踪当前环境名，正文中的其他环境留给LaTeX渲染器解释。
    let depth = 0
    let index = opener[0].length - begin.length
    while (index < source.length) {
      const nextBegin = source.indexOf(begin, index)
      const nextEnd = source.indexOf(end, index)
      if (nextEnd < 0) break
      if (nextBegin >= 0 && nextBegin < nextEnd) {
        depth += 1
        index = nextBegin + begin.length
        continue
      }
      depth -= 1
      index = nextEnd + end.length
      if (depth > 0) continue
      // 闭合环境后的同行正文不属于独立公式块，交回原Markdown分词。
      // 吸收合法行尾使后续块从下一行开始，避免重复保留分隔符。
      const trailing = /^[ \t]*(?:\n|$)/.exec(source.slice(index))
      if (trailing === null) return undefined
      const raw = source.slice(0, index + trailing[0].length)
      return { raw, text: raw.trim() }
    }
    return {
      raw: source,
      text: source.trim(),

      pending: true,
    }
  }

  // Marked的块start探测可能收到去掉首字符的段落视图。
  // 保留本次lexer的完整视图，只用于恢复探测位置，不共享到其他lexer。
  let lastBlockSource = ""

  function tokenizeBlockMath(source: string): MathToken | undefined {
    lastBlockSource = source
    const environment = ENVIRONMENT_OPENER.exec(source)
    if (environment !== null) return tokenizeEnvironmentBlock(source, environment)
    const opener = BLOCK_OPENER.exec(source)
    if (opener === null) return undefined
    const dollar = opener[1] === "$$"
    const closing = dollar ? "$$" : "\\]"
    const closingIndex = findClosingDelimiter(source, closing, opener[0].length)
    if (closingIndex >= 0) {
      const end = closingIndex + closing.length
      const trailing = /^[ \t]*(?:\n|$)/.exec(source.slice(end))
      const text = source.slice(opener[0].length, closingIndex).trim()
      if (trailing === null || text === "") return undefined
      return {
        raw: source.slice(0, end + trailing[0].length),
        text,
      }
    }
    // 未闭合块消耗当前可见前缀，下一次流式更新会用完整新正文重新分词。
    // 正文仅去掉开记号后的可选换行，保留内部公式排版。
    const body = source.slice(opener[0].length).replace(/^[ \t]*\n?/, "")
    if (dollar && body.trim() !== "" && !looksLikeMath(body)) return undefined
    return {
      raw: source,
      text: body,

      pending: true,
    }
  }

  // 代码span按连续反引号的长度配对，不能把多反引号拆成单字符。
  // 被转义的run不是代码边界，仍保留给普通文本解析。
  function backtickRuns(text: string): string[] {
    const runs: string[] = []
    for (const match of text.matchAll(/`+/g)) {
      const start = match.index
      let backslashes = 0
      while (start - backslashes - 1 >= 0 && text[start - backslashes - 1] === "\\") backslashes++
      if (backslashes % 2 === 0) runs.push(match[0])
    }
    return runs
  }

  // 已配对的run整段跳过，代码正文内部不同长度的反引号不会成为新开口。
  // 未配对run只用于判断当前位置是否跨进真实代码span。
  function unmatchedBacktickRuns(text: string): number[] {
    const runs = backtickRuns(text)
    const unmatched: number[] = []
    for (let open = 0; open < runs.length; open++) {
      let close = open + 1
      while (close < runs.length && runs[close]!.length !== runs[open]!.length) close++
      if (close < runs.length) open = close
      else unmatched.push(runs[open]!.length)
    }
    return unmatched
  }

  function insideOpenCodeSpan(text: string, at: number): boolean {
    // 代码span的搜索受段落边界约束，空行后的反引号不能补闭上一段。
    // 同时检查当前位置之后的闭合run，单独悬空的反引号不应吞掉公式块。
    const paragraphStart = text.lastIndexOf("\n\n", at)
    const before = text.slice(paragraphStart < 0 ? 0 : paragraphStart + 2, at)
    const open = unmatchedBacktickRuns(before)
    if (open.length === 0) return false
    const rest = text.slice(at)
    const paragraphEnd = rest.search(/\n[ \t]*\n/)
    const after = paragraphEnd < 0 ? rest : rest.slice(0, paragraphEnd)
    const closers = new Set(backtickRuns(after).map((run) => run.length))
    return open.some((length) => closers.has(length))
  }

  const extensions: MarkdownTokenizerExtension[] = [
    {
      name: "mathBlock",
      level: "block",
      start(source) {
        // 还原探测切片的偏移后再检查代码span，保持下标属于同一原始段落。
        // 候选块可以从换行后开始，返回位置须指向公式而非前导换行。
        const paragraph = lastBlockSource.length === source.length + 1 ? lastBlockSource : source
        const offset = paragraph.length - source.length
        const opener = /(?:^|\n) {0,3}(?:\$\$|\\\[|\\begin\{)/g
        for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
          const index = match.index + (match[0].startsWith("\n") ? 1 : 0)
          if (!insideOpenCodeSpan(paragraph, index + offset)) return index
        }
        return undefined
      },
      tokenizer(source) {
        const token = tokenizeBlockMath(source)
        if (!token) return
        // 流式未闭合内容作为纯text token保留，阻止Markdown继续解释其内部符号。
        // raw同时保留所有定界符，使完成前缀仍能原样显示和复制。
        if (token.pending)
          return {
            type: "paragraph",
            raw: token.raw,
            text: token.raw,
            tokens: [{ type: "text", raw: token.raw, text: token.raw }],
          }
        return { type: "code", raw: token.raw, text: token.text, lang: "latex", math: true }
      },
    },
    {
      name: "math",
      level: "inline",
      start(source) {
        let first = -1
        for (const marker of ["$", "\\(", "\\["]) {
          const index = source.indexOf(marker)
          if (index >= 0 && (first < 0 || index < first)) first = index
        }
        return first >= 0 ? first : undefined
      },
      tokenizer(source) {
        // HTML raw块已有自己的字面量合同，公式扩展不能接管其中的美元。
        if (this.lexer.state.inRawBlock) return
        const token = tokenizeInlineMath(source)
        if (!token) return
        let text: string | undefined
        try {
          // 4096沿用所参考DSH的行内公式处理边界，超出时保持源文本。
          // 外部渲染器可能不支持某种语法，失败也应保留用户可读的原式。
          text = token.text.length <= 4096 ? renderLatex(token.text) : undefined
        } catch {}
        // 公式渲染得到多行时不能塞回行内位置，否则会破坏周围Markdown行结构。
        // raw 仍含原定界符，供 OpenTUI 比对稳定前缀；字形只交给绘制，不回写 Markdown。
        // 保留独立 token，Marked 不会把字形与后续普通文本合并。
        return text && !text.includes("\n")
          ? { type: "opencode_math_inline", raw: token.raw, text, math: true }
          : { type: "text", raw: token.raw, text: token.raw }
      },
    },
  ]
  return extensions
}

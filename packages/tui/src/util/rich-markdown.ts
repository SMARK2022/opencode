import {
  TextRenderable,
  type ColorInput,
  type MarkdownOptions,
  type MarkdownSyntax,
  type MarkdownCodeSpan,
  type RenderContext,
} from "@opentui/core"
import { render } from "lovely-mermaid"
import {
  renderLatex,
} from "@earendil-works/pi-tui"

/*
 * Adapted from ccch1mneyyy/dsh-TUI,
 * commit 2d6c9a13fc30358913e88129c79640d50ca0c6db,
 * terminal-utils/math.ts, mermaid.ts,
 * components/MermaidDiagram.tsx.
 * MIT License
 * Copyright (c) 2026, chimney
 * (ccch1mneyyy)
 *
 * Permission is hereby granted, free of charge,
 * to any person obtaining a copy of this
 * software and associated documentation files
 * (the "Software"), to deal in the Software
 * without restriction, including without
 * limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to
 * permit persons to whom the Software is
 * furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this
 * permission notice shall be included in all
 * copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT
 * SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE
 * OR OTHER DEALINGS IN THE SOFTWARE.
 */

export function richMarkdown(
  ctx: RenderContext,
  fg: () => ColorInput,
) {
  let last = ""
  const syntax: MarkdownSyntax = {
    extensions: [{
      name: "mathBlock",
      level: "block",
      start(source) {
        const paragraph = last.length ===
          source.length + 1 ? last : source
        const offset = paragraph.length -
          source.length
        const opener = /\n {0,3}\\\[/g
        for (const m of source.matchAll(opener)) {
          const index = m.index + 1
          if (!insideOpenCodeSpan(
            paragraph, index + offset,
            (text) => this.lexer.options
              .tokenizer?.codespan(text),
          )) return index
        }
      },
      tokenizer(source) {
        last = source
        const opener = /^ {0,3}\\\[/.exec(source)
        if (!opener) return
        const at = findClosingDelimiter(
          source, "\\]", opener[0].length,
        )
        if (at < 0) return {
          type: "mathBlock",
          raw: source,
          text: source.slice(opener[0].length),
          pending: true,
        }
        const end = at + 2
        const trailing = /^[ \t]*(?:\n|$)/
          .exec(source.slice(end))
        const text = source
          .slice(opener[0].length, at).trim()
        if (!trailing || !text) return
        return {
          type: "mathBlock",
          raw: source.slice(
            0, end + trailing[0].length,
          ),
          text,
        }
      },
    }, {
      name: "math",
      level: "inline",
      start(source) {
        const at = source.indexOf("\\(")
        return at < 0 ? undefined : at
      },
      tokenizer(source) {
        if (!source.startsWith("\\(")) return
        const at = findClosingDelimiter(
          source, "\\)", 2,
        )
        if (at < 0) return
        const text = source.slice(2, at)
        if (!text.trim() ||
          text.includes("\n")) return
        return {
          type: "math",
          raw: source.slice(0, at + 2),
          text,
        }
      },
    }],
    renderInline(token) {
      if (token.type !== "math") return
      const text = renderMath(token.text, false)
      return text && !text.includes("\n")
        ? text : token.raw
    },
    stablePrefix(tokens, source, code) {
      let offset = 0
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        offset += token.raw.length
        if (token.type === "paragraph" &&
          tokens[i + 1]?.type === "mathBlock" &&
          mayBecomeCodeSpan(
            token.raw, source.slice(offset),
            code,
          )) return i
      }
      return tokens.length
    },
  }
  const renderNode: MarkdownOptions["renderNode"] = (token) => {
    const math = token.type === "mathBlock"
    if (!math && token.type !== "code") return
    const lang = token.lang
      ?.trim()
      .split(/\s+/, 1)[0]
      ?.toLowerCase()
    if (!math && lang !== "mermaid") return
    const text = math
      ? token.pending ? undefined
        : renderMath(token.text, true)
      : renderMermaid(token.text)
    const raw = math ? token.raw : token.text
    return fitText(ctx, fg(), raw, text)
  }
  return { syntax, renderNode }
}

function fitText(
  ctx: RenderContext,
  fg: ColorInput,
  raw: string,
  text: string | undefined,
) {
  const node = new TextRenderable(ctx, {
    content: raw,
    fg,
    width: "100%",
    wrapMode: "word",
    flexShrink: 0,
  })
  if (text === undefined) return node
  const columns = Math.max(...text.split("\n")
    .map((line) => Bun.stringWidth(line)))
  let fitted = false
  node.on("line-info-change", () => {
    const fits = node.width >= columns
    if (fits === fitted) return
    fitted = fits
    node.wrapMode = fits ? "none" : "word"
    node.content = fits ? text : raw
  })
  return node
}

function renderMath(
  source: string,
  display: boolean,
) {
  if (source.length > 4096) return
  try {
    const text = renderLatex(source, { display })
    return text?.trim() ? text : undefined
  } catch {
    return undefined
  }
}

function renderMermaid(source: string) {
  if (source.length > 20_000) return
  try {
    return render(source)?.plain.join("\n")
  } catch {
    return undefined
  }
}

function isEscaped(text: string, at: number) {
  let count = 0
  while (at > 0 && text[--at] === "\\") count++
  return count % 2 === 1
}

function findClosingDelimiter(
  source: string,
  closing: string,
  start: number,
) {
  let at = source.indexOf(closing, start)
  while (at >= 0 && isEscaped(source, at)) {
    at = source.indexOf(closing, at + 1)
  }
  return at
}

function codeSpans(
  text: string,
  code: MarkdownCodeSpan,
) {
  const spans: [number, number][] = []
  let end = 0
  let open = false
  for (const match of text.matchAll(/`+/g)) {
    const at = match.index +
      Number(isEscaped(text, match.index))
    if (at < end || at === match.index + match[0].length) continue
    const token = code(text.slice(at))
    if (!token) {
      open = true
      continue
    }
    end = at + token.raw.length
    spans.push([at, end])
  }
  return { spans, open }
}

function insideOpenCodeSpan(
  text: string,
  at: number,
  code: MarkdownCodeSpan,
) {
  const start = text.lastIndexOf("\n\n", at)
  const rest = text.slice(at)
  const end = rest.search(/\n[ \t]*\n/)
  const offset = start < 0 ? 0 : start + 2
  const paragraph = text.slice(
    offset, end < 0 ? undefined : at + end,
  )
  return codeSpans(paragraph, code).spans
    .some(([left, right]) =>
      left <= at - offset && at - offset < right,
    )
}

function mayBecomeCodeSpan(
  paragraph: string,
  following: string,
  code: MarkdownCodeSpan,
) {
  if (/\n[ \t]*\n\s*$/.test(paragraph)) {
    return false
  }
  const at = paragraph.lastIndexOf("\n\n")
  const tail = at < 0 ? paragraph
    : paragraph.slice(at + 2)
  if (!codeSpans(tail, code).open) {
    return false
  }
  return !/\n[ \t]*\n/.test(following)
}

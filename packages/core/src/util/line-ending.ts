export type LineEnding = "\n" | "\r\n" | "\r"

// #131：比较前统一成 LF，避免 CRLF/CR 重写变成整文件 diff
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

// #131：写回时选择文件级行尾；优先 CRLF，再 CR，最后 LF
export function detectLineEnding(text: string): LineEnding {
  if (text.includes("\r\n")) return "\r\n"
  if (text.includes("\r")) return "\r"
  return "\n"
}

// #131：逻辑行分割；纯 CR 文件不能整段当一行
export function splitLines(text: string): string[] {
  return normalizeLineEndings(text).split("\n")
}

// #131：把逻辑行还原成目标文件级行尾
export function convertToLineEnding(text: string, ending: LineEnding): string {
  if (ending === "\n") return text
  return splitLines(text).join(ending)
}

export type LineEnding = "\n" | "\r\n" | "\r"

// Use LF for comparisons so CRLF/CR-only rewrites do not become full-file diffs.
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

// Pick one file-level style for write-back paths that rebuild logical lines.
export function detectLineEnding(text: string): LineEnding {
  if (text.includes("\r\n")) return "\r\n"
  if (text.includes("\r")) return "\r"
  return "\n"
}

// Split on logical lines; legacy CR-only files must not collapse into one line.
export function splitLines(text: string): string[] {
  return normalizeLineEndings(text).split("\n")
}

// Convert normalized logical lines back to the target file-level line ending.
export function convertToLineEnding(text: string, ending: LineEnding): string {
  if (ending === "\n") return text
  return splitLines(text).join(ending)
}

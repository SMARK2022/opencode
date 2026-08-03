// 折叠卡片已有footer提示；普通错误摘要仍沿用省略号策略，避免静默丢失溢出提示。
export function collapseToolOutput(output: string, maxLines: number, maxChars: number, ellipsis = true) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }

  const preview = lines.slice(0, maxLines).join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - (ellipsis ? 1 : 0)))
          .join("") + (ellipsis ? "…" : ""),
      overflow: true,
    }
  }

  return { output: ellipsis ? [preview, "…"].join("\n") : preview, overflow: true }
}

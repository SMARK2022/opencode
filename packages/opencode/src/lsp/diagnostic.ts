import * as LSPClient from "./client"

// [local-smark] 每文件诊断上限：5 条足以指示"有问题"，
// 超过 5 条通常意味着编辑不完整或方向错误，模型应重新审视策略而非逐条修复。
const MAX_PER_FILE = 5

export function pretty(diagnostic: LSPClient.Diagnostic) {
  const severityMap = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1

  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

// [local-smark] 诊断唯一标识：通过 message+行号+列号+code+source 匹配。
// 用于 reportDelta 判断某条错误是否在 baseline 中已存在。
// 已知局限：在错误位置上方增删行会导致行号漂移，预存错误可能被误报为"新错误"。
// 这严格优于现状（现状显示全部预存错误），属可接受容忍范围。
function diagKey(d: LSPClient.Diagnostic): string {
  return JSON.stringify({
    msg: d.message,
    line: d.range.start.line,
    col: d.range.start.character,
    code: d.code,
    source: d.source,
  })
}

export function report(file: string, issues: LSPClient.Diagnostic[]) {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, MAX_PER_FILE)
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}

// [local-smark] 增量诊断：只显示本次编辑新引入的错误（不在 baseline 中的）。
// 借鉴 Copilot "new errors introduced by a file edit" 语义，
// 避免重复展示预存错误导致模型误判"编辑失败"（opencode issue #9102）。
export function reportDelta(
  file: string,
  current: LSPClient.Diagnostic[],
  baseline: LSPClient.Diagnostic[] = [],
) {
  const newErrs = newErrors(current, baseline)
  if (newErrs.length === 0) return ""
  const limited = newErrs.slice(0, MAX_PER_FILE)
  const more = newErrs.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<new-diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</new-diagnostics>`
}

// [local-smark] 返回新错误数组（不在 baseline 中的 ERROR）。
// 供 metadata.diagnostics 存储给 TUI DiagnosticsDisplay 渲染。
// baseline 过滤逻辑与 reportDelta 完全一致（不预先过滤 baseline severity，
// 使同位置 warning→error 升级归为已存在而非新错误）。
export function newErrors(
  current: LSPClient.Diagnostic[],
  baseline: LSPClient.Diagnostic[] = [],
): LSPClient.Diagnostic[] {
  const baselineKeys = new Set(baseline.map(diagKey))
  return current.filter((d) => d.severity === 1).filter((d) => !baselineKeys.has(diagKey(d)))
}

// [local-smark] 增量诊断摘要：返回新错误数和已存在错误数，
// 供 metadata 传递给 TUI 渲染使用（不进入 model output）。
export function deltaSummary(
  current: LSPClient.Diagnostic[],
  baseline: LSPClient.Diagnostic[] = [],
): { newCount: number; existingCount: number } {
  const newErrs = newErrors(current, baseline)
  const allErrors = current.filter((d) => d.severity === 1)
  return {
    newCount: newErrs.length,
    existingCount: allErrors.length - newErrs.length,
  }
}

export function checkedMessage(summary: { newCount: number; existingCount: number }, scope: "file" | "changed-files") {
  if (summary.newCount > 0) return ""
  if (summary.existingCount > 0) {
    // 只暴露既有错误数量，不暴露详情，避免模型把历史问题误判为本次编辑失败。
    const noun = summary.existingCount === 1 ? "error" : "errors"
    return `LSP checked: no new errors introduced; ${summary.existingCount} existing ${noun} remain.`
  }
  // 只描述本次 VS Code 快照“未发现”，不承诺所有语言服务已经完成或以后不会更新。
  if (scope === "changed-files") return "LSP checked: no errors found in changed files."
  return "LSP checked: no errors found in this file."
}

export * as Diagnostic from "./diagnostic"

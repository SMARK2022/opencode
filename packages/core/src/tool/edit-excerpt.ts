import { diffLines, diffChars, type Change } from "diff"
import { closestWindow } from "../patch-match"

export function closestMatch(content: string, expected: string) {
  const closest = closestWindow(content, expected)
  if (!closest) return undefined
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const count = expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").length
  const fileExcerpt = lines.slice(closest.line - 1, closest.line - 1 + count).join("\n")
  // 短窗口保留source的实际原文；长窗口复用字符差异，避免截断真正的行末错误。
  return { line: closest.line, excerpt: fileExcerpt.length > 500 ? formatClosestMatchExcerpt(expected, fileExcerpt, closest.line) : closest.excerpt }
}

// 两代共用唯一候选及字符差异；诊断不参与真正替换或审批。
export function formatClosestMatchExcerpt(oldString: string, fileExcerpt: string, fileStartLine: number) {
  const diffExcerpt = formatClosestMatchDiff(oldString, fileExcerpt, fileStartLine, 500)
  return diffExcerpt || (fileExcerpt.length <= 500 ? fileExcerpt : fileExcerpt.slice(0, 200) + `\n...[${fileExcerpt.length - 400} chars omitted]...\n` + fileExcerpt.slice(-200))
}

// [local-smark] 字符级 diff：diffLines 定位差异行，diffChars 显示字符级差异。
// 解决长行场景下 .slice(0,500) 截断导致 ]; vs }; 不可见的问题。
// diffLines 的 change.value 可含多行，用 oneChangePerToken 确保每个 change 一行。
function formatClosestMatchDiff(
  oldString: string,
  fileExcerpt: string,
  fileStartLine: number,
  maxChars: number,
): string {
  // pendingRemoved 必须在函数内声明——跨调用持久化会导致配对错误
  const pendingRemoved: string[] = []
  const changes = diffLines(oldString, fileExcerpt, { oneChangePerToken: true })
  // 先统计差异行比例，决定是否回退
  let removedLines = 0
  let addedLines = 0
  let unchangedLines = 0
  for (const c of changes) {
    const lineCount = c.value.split("\n").filter((l) => l.length > 0).length
    if (c.removed) removedLines += lineCount
    else if (c.added) addedLines += lineCount
    else unchangedLines += lineCount
  }
  // [local-smark] 差异行比例：用 max(removed, added) 代表不匹配的行位置数，
  // 而非 removed+added（一个不匹配产生 1 removed + 1 added = 2，会膨胀比例）。
  // 总行数用 max(old, file) 行数，避免短 oldString 对长 fileExcerpt 时比例失真。
  const diffLineCount = Math.max(removedLines, addedLines)
  const totalLineCount = Math.max(removedLines, addedLines) + unchangedLines
  // 差异行 > 60% → 结构严重错位，回退 head+tail excerpt
  if (totalLineCount > 0 && diffLineCount / totalLineCount > 0.6) return ""

  const parts: string[] = []
  let newIdx = 0
  let totalChars = 0
  let omitted = 0
  for (const change of changes) {
    const lines = change.value.split("\n").filter((l) => l.length > 0)
    if (change.added) {
      // 文件中的行——与上一个 removed 行做 diffChars
      for (const line of lines) {
        const oldLine = pendingRemoved.shift()
        if (oldLine !== undefined) {
          const formatted = formatCharDiffLine(fileStartLine + newIdx, oldLine, line)
          if (formatted && totalChars + formatted.length < maxChars) {
            parts.push(formatted)
            totalChars += formatted.length + 1
          } else if (formatted) {
            omitted++
          }
        }
        newIdx++
      }
    } else if (change.removed) {
      // oldString 中的行——暂存，等待下一个 added 配对
      for (const line of lines) pendingRemoved.push(line)
    } else {
      // 未变化行——跳过（不占用预算），只推进行号
      newIdx += lines.length
    }
  }
  if (parts.length === 0) return ""
  // [local-smark] 截断标记：预算耗尽时告知模型还有更多差异
  if (omitted > 0) parts.push(`...(+${omitted} more diff lines)`)
  return parts.join("\n")
}

// [local-smark] 格式化单行字符级 diff：只输出变化点前后 30 字符的 context。
// 例：行末 }; vs ]; → line 41: "    };" → "    ];"
// 对 900 字符长行：只显示末尾 30 字符 + 差异，不显示公共前缀。
function formatCharDiffLine(lineNum: number, oldLine: string, newLine: string): string | undefined {
  const charDiff: Change[] = diffChars(oldLine, newLine)
  // 找到第一个变化位置
  let prefixLen = 0
  for (const c of charDiff) {
    if (c.added || c.removed) break
    prefixLen += c.value.length
  }
  // 无差异
  if (prefixLen >= oldLine.length && prefixLen >= newLine.length) return undefined
  // 提取变化部分
  let oldPart = ""
  let newPart = ""
  let suffix = ""
  let inChange = false
  for (const c of charDiff) {
    if (c.removed) { oldPart += c.value; inChange = true }
    else if (c.added) { newPart += c.value; inChange = true }
    else if (inChange) { suffix = c.value.slice(0, 20); break }
  }
  if (!oldPart && !newPart) return undefined
  // context：变化点前 30 字符 + 变化 + 变化后 20 字符
  const contextChars = 30
  const ctxStart = Math.max(0, prefixLen - contextChars)
  const ctx = oldLine.slice(ctxStart, prefixLen)
  // 截断过长的 context 和 suffix，控制总输出长度
  const truncate = (s: string, max: number) => s.length <= max ? s : s.slice(0, max) + "..."
  return `line ${lineNum}: "${truncate(ctx + oldPart + suffix, 80)}" → "${truncate(ctx + newPart + suffix, 80)}"`
}

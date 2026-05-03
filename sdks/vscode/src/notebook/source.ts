/**
 * vscode_notebook_source 将打开的格文档投影为一份虚拟文本，采用一基全局行号。
 * 单元格分隔格式为 --- cN kind/lang id=<complete canonical ID> lines=... ---；格头与空分隔行均计入虚拟行。
 * offset/limit 对该全局文档分页，使用 cellIndex 或 cellId 选定单格窗口时也保持此坐标系。
 * 身份解析归 resolve；读取不执行单元格、不保存文档，也不切换内核。
 * 行号描述本次源码投影；源码或结构编辑后应重新读取，不将偏移量当作单元格身份。
 */
import vscode from "vscode"
import { stringProp, numberProp } from "../util"
import { shortId, cellIdentifiers, cellKindLabel } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

/**
 * @param input filePath 可省略；cellIndex 或完整规范化 cellId 可限定全局窗口。
 * offset 默认 1；选中格默认从其全局起点读取，优先解释全局偏移，全局偏移不适用时保留源版本的格内相对偏移解释。
 * limit 默认 1000，并钳制为 1..1000 个虚拟行；超过 2000 字符的源码行会明确标为截短预览。
 * 12 KiB UTF-8 预算仅覆盖虚拟行内容，不含行号前缀或响应封装；首行可超出预算，以保证分页能够推进。
 * @returns ran=false、实际全局 offset/returned/totalLines 与续读提示；这些限制不承诺返回未截短的笔记本原始源码。
 */
export async function notebookSource(input: Record<string, unknown>) {
  // source 复用身份解析接口并独占虚拟行分页，读取源码不能调用 run 模块。
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const limit = Math.max(1, Math.min(numberProp(input, "limit") ?? 1000, 1000))
  // 行数预算与字节预算互补，大量空行或短行虽少占字节也不能无限占用提示版面。
  const offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const { lines, cellRanges } = buildVirtualLines(notebook)
  // cellId 通过共享格解析器选定窗口，虚拟行号仍是整个 notebook 的全局编号。
  const targetCellIndex = input.cellIndex !== undefined || input.cellId !== undefined ? resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId")).index : undefined

  let globalStart = 1
  let globalEnd = lines.length
  let warning = ""

  if (targetCellIndex !== undefined && cellRanges.has(targetCellIndex)) {
    // 单格窗口只限制读取终点，仍保留全局行号，不能将所选格的首行重新编号为一。
    const range = cellRanges.get(targetCellIndex)!
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        // 全局续读行号优先，避免同一数值也可作局部偏移时跳过上一页指定的继续位置。
        globalStart = offset
      } else if (range.start + offset - 1 >= range.start && range.start + offset - 1 <= range.end) {
        // 仅在全局解释不适用时保留源相对偏移契约，不能把既有读格调用改成无条件拒绝。
        globalStart = range.start + offset - 1
      } else {
        globalStart = range.start
        warning =
          "WARNING: Offset out of bounds for the specified cell! ALWAYS use GLOBAL document line numbers. Offset reset to default."
        // 两种解释都越界时显式警告并返回实际 offset，不能让调用方误以为错误位置已被采用。
      }
    } else {
      globalStart = range.start
    }
    globalEnd = range.end
  } else {
    if (input.offset !== undefined) {
      globalStart = offset
    }
  }

  // 空 notebook 的虚拟行数为零，起点仍须保持一；以零作上界会产生负数组索引，把正常 EOF 读成错误。
  globalStart = Math.max(1, Math.min(globalStart, lines.length > 0 ? lines.length : 1))

  const maxBytes = 12 * 1024
  // 12 KiB 预算只计虚拟行内容，行号前缀和响应封装另有开销，不能承诺完整 HTTP 响应的硬上限。
  let bytes = 0
  let cut = false
  const returnedLines: string[] = []
  let currentLineIndex = globalStart - 1

  while (currentLineIndex < globalEnd && currentLineIndex < lines.length && returnedLines.length < limit) {
    const line = lines[currentLineIndex]
    // byteLength 按 UTF-8 预算，中文源码的字符数不能替代网络字节数。
    const lineBytes = Buffer.byteLength(line, "utf8")
    // 首行允许进入空窗口以保证分页推进，单行截断由虚拟行构建器单独负责。
    if (bytes + lineBytes > maxBytes && returnedLines.length > 0) {
      cut = true
      break
    }
    returnedLines.push(`${currentLineIndex + 1}: ${line}`)
    bytes += lineBytes
    currentLineIndex++
  }

  const more = currentLineIndex < globalEnd && currentLineIndex < lines.length
  // cut 表示字节截断，more 表示仍有后续行；续读位置按实际消费行号计算。

  let output = warning ? `${warning}\n\n` : ""
  output +=
    [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join(
      "\n",
    ) + "\n"
  output += returnedLines.join("\n")

  if (cut) {
    output += `\n\n(Output capped at 12 KB. Showing lines ${globalStart}-${currentLineIndex}. Use offset=${currentLineIndex + 1} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${globalStart}-${currentLineIndex} of ${lines.length}. Use offset=${currentLineIndex + 1} to continue.)`
  } else {
    if (targetCellIndex !== undefined) {
      output += `\n\n(End of cell ${targetCellIndex})`
    } else {
      output += `\n\n(End of file - total ${lines.length} lines)`
    }
  }
  output += "\n</content>"

  return {
    ran: false,
    summary: output,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      target: targetCellIndex !== undefined ? `cell ${targetCellIndex}` : "all",
      offset: globalStart,
      limit,
      returned: returnedLines.length,
      totalLines: lines.length,
      truncated: cut || more,
    },
  }
}

function buildVirtualLines(notebook: vscode.NotebookDocument) {
  const lines: string[] = []
  // cellRanges 保留每格窗口的起止，不能按局部 lineCount 直接翻页。
  const cellRanges = new Map<number, { start: number; end: number }>()

  for (const cell of notebook.getCells()) {
    const start = lines.length + 1
    // ID 与 summary 同源，格头不能临时生成基于 index 的另一套身份。
    const id = shortId(cellIdentifiers(cell)[0] ?? cell.document.uri.toString())
    lines.push(
      `--- c${cell.index} ${cellKindLabel(cell.kind)}/${cell.document.languageId} id=${id} lines=${cell.document.lineCount} ---`,
    )
    // 即使源码为空也保留格头，读取结果才能区分空格与已删除的格。
    const sourceLines = cell.document
      // 使用打开格源码保留未保存编辑；CRLF/LF 都拆行，2000 字符截断明确标注为预览。
      .getText()
      .split(/\r?\n/)
      .map((line) => (line.length > 2000 ? line.substring(0, 2000) + "... (line truncated to 2000 chars)" : line))
    lines.push(...sourceLines)
    // 格头与空分隔行均计入一基虚拟行号，消费者须以全局 offset 续读。
    lines.push("")
    const end = lines.length
    cellRanges.set(cell.index, { start, end })
  }

  return { lines, cellRanges }
}

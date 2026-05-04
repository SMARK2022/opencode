/**
 * vscode_notebook_edit 经 WorkspaceEdit/NotebookEdit 插入、修改或删除格。
 * filePath、editType、cellId 必填；editType 为 insert | edit | delete。
 * insert 在 cellId 后插入，TOP/BOTTOM 指定文档边缘；newCode 必填。
 * edit 在语言不变时使用 TextEdit；改变语言时替换整个 NotebookCellData。
 * 仅修改语言可省略 newCode；显式空字符串仍表示清空源码。
 * language=markdown 对应 Markup，其余语言对应 Code。
 * oldCode/newCode 在目标格内匹配替换，不使用会随并行编辑漂移的行号。
 * 匹配顺序为 exact、line-trimmed、border-trimmed；仅精确匹配拒绝多处命中。
 * newCode 单独提供时替换整格；类型变更也可先匹配 oldCode。
 * Context 标注策略及编辑前的虚拟全局邻接行，Preview 展示替换片段。
 * Anchor 报告所选格，类型变更显示旧到新，删除显示删除线。
 * Affected 报告新插入格或移位格，cN 为一基显示编号。
 * save=true 仍是显式保存请求，dirty 文档保存失败沿原错误边界传播。
 * 返回 applyEdit 状态与差分，不隐式保存或回传完整笔记本。
 */
import vscode from "vscode"
import {
  stringProp,
  sourceProp,
  fullDocumentRange,
  documentEol,
  previewText,
} from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

// 白名单先于编辑副作用校验，未知 editType 不能被当作整格修改。
const EDIT_TYPES = new Set(["insert", "edit", "delete"])

export async function editNotebook(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  // 编辑的新契约要求明确文档，缺失路径不能沿 resolve 的只读缺省规则选中活动文件。
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const editType = stringProp(input, "editType")
  if (!editType || !EDIT_TYPES.has(editType)) {
    throw new Error(`Invalid editType: ${editType ?? "<missing>"}. Must be one of: insert, edit, delete`)
  }

  const cellId = stringProp(input, "cellId")
  // TOP/BOTTOM 的合法性归 insert；入口只排除缺失身份，不把其它操作猜作位置编辑。
  if (!cellId) throw new Error("cellId is required")

  // 结构编辑会改变 cellCount，差分基线必须在 applyEdit 前记录，不能在返回后反推原格数。
  const beforeCount = notebook.cellCount

  if (editType === "delete") return await handleDelete(notebook, cellId, beforeCount, input)
  if (editType === "insert") return await handleInsert(notebook, input, cellId, beforeCount)
  return await handleEdit(notebook, input, cellId, beforeCount)
}

async function handleDelete(notebook: vscode.NotebookDocument, cellId: string, beforeCount: number, input: Record<string, unknown>) {
  const targetCell = resolveNotebookCell(notebook, undefined, cellId)
  // 删除后 targetCell.index 可能为 -1，范围和删除摘要都使用这个提交前位置。
  const deletedIndex = targetCell.index
  // 打开的格文档可能 dirty，删除预览不能改读磁盘版本。
  const deletedPreview = targetCell.document.getText()
  const deletedLineCount = targetCell.document.lineCount
  // 首行裁剪只用于紧凑展示，完整 deletedPreview 不随 trim 或 50 字符限制改写。
  const deletedFirst = previewText((targetCell.document.getText().split("\n")[0] ?? "").trim(), 50)
  const deletedKind = cellTypeLabel(targetCell.kind)
  const deletedLang = targetCell.document.languageId
  const deletedId = copilotLikeCellId(targetCell)
  // 是否存在继任格取删除前边界；删除末格不能再 cellAt 已消失的槽位。
  const hasNext = deletedIndex < notebook.cellCount - 1

  const edit = new vscode.WorkspaceEdit()
  // NotebookRange 的终点排他，宽度一只删除已解析的格，不吞掉继任格。
  edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(deletedIndex, deletedIndex + 1))])
  const applied = await vscode.workspace.applyEdit(edit)

  let shiftedOldIdx: number | undefined
  let shiftedCell: vscode.NotebookCell | undefined
  // applyEdit=false 不产生移位，摘要不能把原槽位的格伪装成继任格。
  if (applied && hasNext) {
    shiftedOldIdx = deletedIndex + 1
    shiftedCell = notebook.cellAt(deletedIndex)
  }
  // 复用既有保存 owner，false 对 dirty 文档的错误不能被新版 handler 吞掉。
  if (input.save === true) await saveNotebook(notebook)

  return compactEditResult(notebook, {
    applied,
    editType: "delete",
    opIndex: `~~${deletedIndex + 1}~~`,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCell: targetCell,
    anchorCellIndex: deletedIndex,
    deletedCellIndex: deletedIndex,
    deletedKind,
    deletedLang,
    deletedId,
    deletedLineCount,
    deletedFirst,
    shiftedCell,
    shiftedOldIdx,
    sourcePreview: deletedPreview,
  })
}

async function handleInsert(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  const sourceRaw = sourceProp(input, "newCode", "\n")
  // 空字符串可插入空格，只有 undefined 表示没有提交 newCode。
  if (sourceRaw === undefined) throw new Error("newCode is required for insert")

  const language = stringProp(input, "language")
  const kind = kindFromLang(language)
  // 新格没有已有 languageId；仅缺省语言才按结构类型选择 markdown/python。
  const lang = language ?? (kind === vscode.NotebookCellKind.Markup ? "markdown" : "python")
  const source = kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  // 大小写转换仅识别位置哨兵；普通 ID 仍以原串交给完整身份解析器。
  const upperCellId = cellId.toUpperCase()
  let insertIndex: number
  let anchorCell: vscode.NotebookCell | undefined

  if (upperCellId === "TOP" || (upperCellId === "BOTTOM" && notebook.cellCount === 0)) {
    // 空文档的 BOTTOM 也是零位置，不读取不存在的首格或末格。
    insertIndex = 0
  } else if (upperCellId === "BOTTOM") {
    insertIndex = notebook.cellCount
  } else {
    anchorCell = resolveNotebookCell(notebook, undefined, cellId)
    // 锚点后的零宽范围才是插入，不能使用宽度一把所选格替换掉。
    insertIndex = anchorCell.index + 1
  }

  const newCell = new vscode.NotebookCellData(kind, source, lang)
  const anchorCellIndex = anchorCell?.index
  // 插入前的位置用于说明被推后一格的邻居；append 没有这个邻居。
  const shiftedOldIdx = insertIndex < notebook.cellCount ? insertIndex : undefined
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(insertIndex, insertIndex), [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  // 未应用时不能读取 index+1，特别是尾部附近的失败插入可能使它越界。
  const shiftedCell = applied && shiftedOldIdx !== undefined ? notebook.cellAt(shiftedOldIdx + 1) : undefined
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "insert", opIndex: String(insertIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, anchorCellIndex, affectedCellIndex: applied ? insertIndex : undefined, shiftedCell, shiftedOldIdx, kind: cellTypeLabel(kind), language: lang, sourcePreview: source })
}

async function handleEdit(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  const targetCell = resolveNotebookCell(notebook, undefined, cellId)
  const language = stringProp(input, "language")
  // oldCode 从格内文本定位，不接受仍可能随编辑漂移的 range 坐标。
  const oldCodeRaw = sourceProp(input, "oldCode")
  // python 到 javascript 也需要结构替换，即使二者的 NotebookCellKind 都是 Code。
  const typeChange = language !== undefined && language !== targetCell.document.languageId

  if (typeChange) {
    const newKind = kindFromLang(language!)
    // 旧语言和类型在替换前捕获，不能从新格反推转换箭头的左侧。
    const oldKind = cellTypeLabel(targetCell.kind)
    const oldLang = targetCell.document.languageId
    return await handleTypeChange(notebook, targetCell, input, newKind, language!, oldKind, oldLang, oldCodeRaw, beforeCount)
  }

  if (oldCodeRaw) {
    const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
    // 提供非空 oldCode 就必须配对 newCode，不能退回整格覆盖。
    if (sourceRaw === undefined) throw new Error("newCode is required with oldCode")
    return await handleStringEdit(notebook, targetCell, oldCodeRaw, sourceRaw, beforeCount, input)
  }

  const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
  // 未请求类型变更时缺少 newCode 是错误，不能将它解释为保留原文的成功编辑。
  if (sourceRaw === undefined) throw new Error("newCode is required for edit")
  const source = targetCell.kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  const edit = new vscode.WorkspaceEdit()
  // TextEdit 作用于格文档 URI，NotebookEdit 作用于 notebook URI，不能交换二者。
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
  const applied = await vscode.workspace.applyEdit(edit)
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, anchorCellIndex: targetCell.index, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: source })
}

async function handleTypeChange(
  notebook: vscode.NotebookDocument,
  targetCell: vscode.NotebookCell,
  input: Record<string, unknown>,
  newKind: vscode.NotebookCellKind,
  newLang: string,
  oldKind: string,
  oldLang: string,
  oldCode: string | undefined,
  beforeCount: number,
) {
  let newSource: string
  let contextSummary: string | undefined

  const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))

  if (oldCode) {
    // 先在旧源码完成匹配再更换语言，匹配失败不能留下半次类型修改。
    if (sourceRaw === undefined) throw new Error("newCode is required with oldCode")
    const result = matchAndReplace(targetCell, oldCode, sourceRaw)
    newSource = result.source
    contextSummary = buildContext(notebook, targetCell, result, sourceRaw)
  } else if (sourceRaw !== undefined) {
    // 只在整格 newCode 分支剥离围栏，片段替换须保留正文中的反引号。
    newSource = newKind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
  } else {
    // 类型修改保留打开文档的真实源码，不读取可能过时的 saved metadata。
    newSource = targetCell.document.getText()
  }

  // NotebookCellData 的结构替换会产生新 URI 身份，不能继续返回旧格 ID 作为编辑后目标。
  const newCell = new vscode.NotebookCellData(newKind, newSource, newLang)
  const anchorCellIndex = targetCell.index
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(anchorCellIndex, anchorCellIndex + 1), [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  // applyEdit=false 时原格仍是有效锚点，不能假造已经创建的新格。
  const anchorCell = applied ? notebook.cellAt(anchorCellIndex) : targetCell
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(anchorCellIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, anchorCellIndex, kind: cellTypeLabel(newKind), language: newLang, oldKind, oldLang, sourcePreview: newSource, contextSummary })
}

async function handleStringEdit(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, oldCode: string, newCode: string, beforeCount: number, input: Record<string, unknown>) {
  const result = matchAndReplace(targetCell, oldCode, newCode)
  // Context 在 applyEdit 前捕获，不能从修改后的文档反推旧邻接行。
  const contextSummary = buildContext(notebook, targetCell, result, newCode)

  const edit = new vscode.WorkspaceEdit()
  // result.source 已保留范围外的前后缀，整文档替换不会误丢邻接代码。
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), result.source)
  const applied = await vscode.workspace.applyEdit(edit)
  if (input.save === true) await saveNotebook(notebook)
  // Preview 只展示替换片段，完整合成源码由 TextEdit 写入而不塞进差分摘要。
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, anchorCellIndex: targetCell.index, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: newCode, contextSummary })
}

function matchAndReplace(targetCell: vscode.NotebookCell, oldCode: string, newCode: string) {
  const content = targetCell.document.getText()
  const eol = documentEol(targetCell.document)
  // 三种策略统一在 LF 坐标中匹配，不能把 CRLF 的额外字节计入索引。
  const normalize = (s: string) => s.replace(/\r\n/g, "\n")
  const src = normalize(content)
  const old = normalize(oldCode)
  const rep = normalize(newCode)

  let matchIdx = -1
  let matchLen = 0
  let strategy = ""

  matchIdx = src.indexOf(old)
  if (matchIdx !== -1) {
    matchLen = old.length
    strategy = "exact"
  }

  // 逐行策略要求整行对齐，不把包含相同词语的局部片段当作命中。
  if (matchIdx === -1) {
    const result = lineTrimmedMatch(src, old)
    if (result) {
      matchIdx = result.index
      matchLen = result.length
      strategy = "line-trimmed"
    }
  }

  // 只有前两阶均未命中才裁块边界，避免宽松规则掩盖精确匹配。
  if (matchIdx === -1) {
    const trimmedOld = old.trim()
    matchIdx = src.indexOf(trimmedOld)
    if (matchIdx !== -1) {
      // 替换跨度取裁剪后的实际长度，保留命中片段外的原始空白。
      matchLen = trimmedOld.length
      strategy = "border-trimmed"
    }
  }

  // 空白降级只可替换真实片段，零长命中会把未匹配请求误当成插入。
  if (matchIdx !== -1 && matchLen === 0 && strategy !== "exact") {
    throw new Error(`oldCode has no non-empty match after whitespace trimming in cell c${c1(targetCell)}. Try re-reading the source with vscode_notebook_source.`)
  }
  // 未命中在创建 WorkspaceEdit 前失败，不能静默转成整格替换。
  if (matchIdx === -1) {
    throw new Error(`oldCode not found in cell c${c1(targetCell)}. Try re-reading the source with vscode_notebook_source.`)
  }

  // 精确命中重复时直接报错，不能改走宽松策略选择任意位置。
  const secondIdx = src.indexOf(old, matchIdx + 1)
  if (secondIdx !== -1 && strategy === "exact") {
    throw new Error(`oldCode matches multiple locations in cell c${c1(targetCell)}. Provide more surrounding context to make the match unique.`)
  }

  // 拼接也使用 LF 索引，再恢复目标 EOL，避免在 CRLF 原文中切错前后缀。
  const source = (src.substring(0, matchIdx) + rep + src.substring(matchIdx + matchLen)).replace(/\n/g, eol)

  const preMatch = src.substring(0, matchIdx)
  const preLines = preMatch.split("\n")
  const matchStartLine = preLines.length
  // 行跨度取实际命中源码；边界裁剪后的空行不能仍计入 oldCode 的旧长度。
  const matchLines = src.substring(matchIdx, matchIdx + matchLen).split("\n")
  const matchEndLine = matchStartLine + matchLines.length - 1

  return { source, matchStartLine, matchEndLine, strategy }
}

function lineTrimmedMatch(src: string, old: string) {
  // 尾部换行仍是匹配结构的一部分，不能为了放宽定位删掉最后的空行。
  const oldLines = old.split("\n")
  const srcLines = src.split("\n")
  if (oldLines.length > srcLines.length) return undefined

  for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
    let matches = true
    // trim 只参与比较，不能将实际写回的源码也去掉缩进。
    for (let j = 0; j < oldLines.length; j++) {
      if (srcLines[i + j].trim() !== oldLines[j].trim()) {
        matches = false
        break
      }
    }
    if (matches) {
      // 起点包含命中首行的完整缩进，不能按 trim 后长度回推源偏移。
      let start = 0
      // 输入已归一为 LF，每条前置行只累计一个换行字符。
      for (let k = 0; k < i; k++) start += srcLines[k].length + 1
      let end = start
      // 只覆盖行间换行，最后一行之后的换行属于保留的后缀。
      for (let k = 0; k < oldLines.length; k++) {
        end += srcLines[i + k].length
        if (k < oldLines.length - 1) end += 1
      }
      // 保留原算法的首个宽松命中；多命中拒绝仅属于 exact 策略。
      return { index: start, length: end - start }
    }
  }
  return undefined
}

function buildContext(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, result: { matchStartLine: number; matchEndLine: number; strategy: string }, newCode: string) {
  const cellLines = targetCell.document.getText().split(/\r?\n/)
  const vr = computeVirtualRanges(notebook)
  // 共享虚拟起点包含前格正文和空分隔行，不能仅累计其它格的正文行数。
  const globalOffset = (vr.get(targetCell.index)?.start ?? 1) - 1
  const gStart = result.matchStartLine + globalOffset
  const gEnd = result.matchEndLine + globalOffset

  const ctxLines: string[] = []
  if (result.matchStartLine > 1) {
    ctxLines.push(`${gStart - 1}: ${cellLines[result.matchStartLine - 2]}`)
  } else {
    // 格边界没有正文行号，Context 的标记不能伪装成可编辑的源码行。
    ctxLines.push(`--: <cell_top> --- c${c1(targetCell)} ${cellTypeLabel(targetCell.kind)}/${targetCell.document.languageId}`)
  }

  const label = gStart === gEnd ? `${gStart}` : `${gStart}~${gEnd}`
  // 策略标签说明定位方式，不把宽松匹配伪装成 exact 或执行成功证据。
  ctxLines.push(`${label} (${result.strategy}): ${previewText(newCode, 50)}`)
  if (result.matchEndLine < cellLines.length) {
    ctxLines.push(`${gEnd + 1}: ${cellLines[result.matchEndLine]}`)
  } else {
    ctxLines.push(`--: <cell_end>`)
  }

  return ctxLines.join("\n")
}

// Markup 是 notebook 结构枚举，不接受语言 ID 或内核显示名作为额外结构类型。
function kindFromLang(language?: string) {
  return language === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code
}

// 仅剥离完整包围正文的围栏，源码中间的反引号或未闭合围栏不能被宽松搜索截掉。
function stripCodeFence(source: string) {
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}

async function saveNotebook(notebook: vscode.NotebookDocument) {
  // 捕获调用 save 前的 dirty 状态；clean 文档返回 false 代表无需写盘，不能误报失败。
  const dirty = notebook.isDirty
  // false 对 dirty 文档表示真实失败；拒绝或抛错自然沿现有 HTTP/palette 错误边界传播。
  if (!(await notebook.save()) && dirty) throw new Error(`Failed to save notebook: ${notebook.uri.toString()}`)
}

function compactEditResult(
  notebook: vscode.NotebookDocument,
  info: {
    applied: boolean
    editType: string
    opIndex: string
    beforeCount: number
    afterCount: number
    anchorCellIndex?: number
    anchorCell?: vscode.NotebookCell
    // 删除字段是提交前快照，旧格代理失效后不能再从 anchorCell 读取这些值。
    deletedCellIndex?: number
    affectedCellIndex?: number
    kind?: string
    language?: string
    oldKind?: string
    oldLang?: string
    deletedKind?: string
    deletedLang?: string
    deletedId?: string
    deletedLineCount?: number
    deletedFirst?: string
    // 移位邻居与新插入格是不同角色，不能把前者当成 Affected 的新格身份。
    shiftedCell?: vscode.NotebookCell
    shiftedOldIdx?: number
    sourcePreview?: string
    contextSummary?: string
  },
) {
  const target =
    // 删除后此位置可能是继任格，摘要只描述当前槽位，不能声称被删除的原格仍存在。
    info.affectedCellIndex !== undefined && info.affectedCellIndex >= 0 && info.affectedCellIndex < notebook.cellCount
      ? notebook.cellAt(info.affectedCellIndex)
      : undefined
  const lines: Array<string | undefined> = [
    `Notebook edit: applied=${info.applied} op=${info.editType} at=${info.opIndex} num_cells=${info.beforeCount}->${info.afterCount} dirty=${notebook.isDirty}.`,
  ]

  if (info.editType === "delete" && info.deletedId) {
    // 删除线展示被移除的原格，而不是删除后占据该槽位的邻居。
    const dIdx = (info.deletedCellIndex ?? 0) + 1
    lines.push(`Anchor: ~~c${dIdx} id=${info.deletedId} ${info.deletedKind}/${info.deletedLang} lines=${info.deletedLineCount} first=${JSON.stringify(info.deletedFirst)}~~`)
  } else if (info.anchorCell) {
    const displayIdx = info.deletedCellIndex !== undefined ? info.deletedCellIndex + 1 : c1(info.anchorCell)
    const anchorId = copilotLikeCellId(info.anchorCell)
    const typePart = info.oldKind
      ? `${info.oldKind}/${info.oldLang}->${info.kind}/${info.language}`
      : `${cellTypeLabel(info.anchorCell.kind)}/${info.anchorCell.document.languageId}`
    lines.push(`Anchor: c${displayIdx} id=${anchorId} ${typePart}.`)
  }

  // 插入后报告实际新格 ID，下一次 source/edit 必须能按它往返定位。
  if (info.editType === "insert" && target) {
    lines.push(`Affected: NEW->c${c1(target)} id=${copilotLikeCellId(target)} ${cellTypeLabel(target.kind)}/${target.document.languageId}.`)
  }
  // 移位邻居统一报告；insert 的新格仍由上方独立的 NEW 条目展示。
  if ((info.editType === "delete" || info.editType === "insert") && info.shiftedCell) {
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Affected: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  }

  if (info.contextSummary) {
    // 匹配上下文与 Preview 分开，消费者不能把紧凑源码预览解释成实际替换范围。
    lines.push(`Context:\n${info.contextSummary}`)
  }
  if (info.sourcePreview) {
    // 正文仅作 50 字符预览，完整新源码留在打开文档而非塞进操作差分。
    lines.push(`Preview: ${JSON.stringify(previewText(info.sourcePreview, 50))}`)
  }

  return {
    ran: false,
    summary: lines.join("\n"),
    data: {
      applied: info.applied,
      operation: info.editType,
      cellCountBefore: info.beforeCount,
      cellCountAfter: info.afterCount,
      anchorCellIndex: info.anchorCellIndex,
      affectedCellIndex: info.affectedCellIndex,
      dirty: notebook.isDirty,
      kind: info.kind,
      language: info.language,
    },
  }
}

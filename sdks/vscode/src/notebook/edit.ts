/**
 * vscode_notebook_edit 经 WorkspaceEdit/NotebookEdit 插入、修改或删除格。
 * filePath、editType、cellId 必填；editType 为 insert | edit | delete。
 * insert 在 cellId 后插入，TOP/BOTTOM 指定文档边缘；newCode 必填。
 * edit 在语言不变时使用 TextEdit；改变语言时替换整个 NotebookCellData。
 * 仅修改语言可省略 newCode；显式空字符串仍表示清空源码。
 * language=markdown 对应 Markup，其余语言对应 Code。
 * range 使用虚拟源码的一基闭区间，返回邻接行 Context；整格编辑不返回 Context。
 * Anchor 报告所选格，类型变更显示旧到新，删除显示删除线。
 * Affected 报告新插入格或移位格，cN 为一基显示编号。
 * save=true 仍是显式保存请求，dirty 文档保存失败沿原错误边界传播。
 * 返回 applyEdit 状态与差分，不隐式保存或回传完整笔记本。
 */
import vscode from "vscode"
import {
  isRecord,
  stringProp,
  numberProp,
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
  // range 与 source/summary 使用同一个虚拟全局坐标，不能解释为选中格的局部行号。
  const range = readLineRange(input)
  // python 到 javascript 也需要结构替换，即使二者的 NotebookCellKind 都是 Code。
  const typeChange = language !== undefined && language !== targetCell.document.languageId

  if (typeChange) {
    const newKind = kindFromLang(language!)
    // 旧语言和类型在替换前捕获，不能从新格反推转换箭头的左侧。
    const oldKind = cellTypeLabel(targetCell.kind)
    const oldLang = targetCell.document.languageId
    return await handleTypeChange(notebook, targetCell, input, range, newKind, language!, oldKind, oldLang, beforeCount)
  }

  // 不改语言的范围更新保持现有格身份，不能为了改源码重建 NotebookCellData。
  if (range) {
    return await handleTextEditSource(notebook, targetCell, input, range, beforeCount)
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
  range: { start: number; end: number } | undefined,
  newKind: vscode.NotebookCellKind,
  newLang: string,
  oldKind: string,
  oldLang: string,
  beforeCount: number,
) {
  let newSource: string
  let contextSummary: string | undefined

  if (range) {
    // 先计算完整新源码再构造结构编辑，不能先换语言而在范围计算失败后留下半次修改。
    const result = applyRangeEdit(notebook, targetCell, range, sourceProp(input, "newCode", documentEol(targetCell.document)))
    if (!result) throw new Error("newCode is required for edit with range")
    newSource = result.source
    contextSummary = result.context
  } else {
    const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
    // 显式空文本仍覆盖正文；只有省略 newCode 才是纯语言变更。
    if (sourceRaw !== undefined) {
      newSource = newKind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
    } else {
      // 类型修改保留打开文档的真实源码，不读取可能过时的 saved metadata。
      newSource = targetCell.document.getText()
    }
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

async function handleTextEditSource(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, input: Record<string, unknown>, range: { start: number; end: number }, beforeCount: number) {
  const result = applyRangeEdit(notebook, targetCell, range, sourceProp(input, "newCode", documentEol(targetCell.document)))
  // 范围路径必须真的提交源码，未提供正文不能伪报该范围已被修改。
  if (!result) throw new Error("newCode is required for edit with range")

  const edit = new vscode.WorkspaceEdit()
  // result.source 已保留范围外的前后缀，整文档替换不会误丢邻接代码。
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), result.source)
  const applied = await vscode.workspace.applyEdit(edit)
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, anchorCellIndex: targetCell.index, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: result.source, contextSummary: result.context })
}

function applyRangeEdit(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, range: { start: number; end: number }, newCode: string | undefined) {
  if (newCode === undefined) return undefined

  const vr = computeVirtualRanges(notebook)
  const cellRange = vr.get(targetCell.index)
  if (!cellRange) throw new Error(`Cell c${c1(targetCell)} has no virtual range`)

  const globalStart = Math.max(cellRange.start, range.start)
  const globalEnd = Math.min(cellRange.end, range.end)
  // 两个闭区间没有交集时拒绝修改，不把越界请求转为首行插入。
  if (globalStart > globalEnd) {
    throw new Error(`Global range [${range.start},${range.end}] out of bounds for cell c${c1(targetCell)}`)
  }

  // 先转换为格内一基闭区间，slice 再用 start-1 和排他终点保留范围外文本。
  const localStart = globalStart - cellRange.start + 1
  const localEnd = globalEnd - cellRange.start + 1
  const cellLines = targetCell.document.getText().split(/\r?\n/)

  // 上邻接行是 start 的前一行；索引负数表示格顶而非借用上一格的源码。
  const aboveIdx = localStart - 2
  const belowIdx = localEnd
  const aboveLine = aboveIdx >= 0 ? cellLines[aboveIdx] : undefined
  const belowLine = belowIdx < cellLines.length ? cellLines[belowIdx] : undefined

  const ctxLines: string[] = []
  if (aboveLine !== undefined) {
    ctxLines.push(`${globalStart - 1}: ${aboveLine}`)
  } else {
    // 格边界没有正文行号，Context 的标记不能伪装成可编辑的源码行。
    ctxLines.push(`--: <cell_top> --- c${c1(targetCell)} ${cellTypeLabel(targetCell.kind)}/${targetCell.document.languageId}`)
  }
  // 标签描述被替换的旧跨度；newCode 可含多行，不能按其长度重写旧范围证据。
  const modifiedLabel = globalStart === globalEnd ? `${globalStart}` : `${globalStart}~${globalEnd}`
  ctxLines.push(`${modifiedLabel}: ${previewText(newCode, 50)}`)
  if (belowLine !== undefined) {
    // 下邻接行仍引用编辑前的全局 end+1，不能把新正文的末行冒充邻接上下文。
    ctxLines.push(`${globalEnd + 1}: ${belowLine}`)
  } else {
    ctxLines.push(`--: <cell_end>`)
  }

  const eol = documentEol(targetCell.document)
  // 数组拼接保留目标文档 EOL，返回的 Context 则独立用 LF 作为展示分隔。
  const source = [...cellLines.slice(0, localStart - 1), newCode, ...cellLines.slice(localEnd)].join(eol)
  return { source, context: ctxLines.join("\n") }
}

// Markup 是 notebook 结构枚举，不接受语言 ID 或内核显示名作为额外结构类型。
function kindFromLang(language?: string) {
  return language === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code
}

function readLineRange(input: Record<string, unknown>) {
  const range = input.range
  // 只解释原 range.start/end 对象，不把 source 的 offset/limit 猜成编辑范围。
  if (!isRecord(range)) return undefined
  const start = numberProp(range, "start")
  const end = numberProp(range, "end")
  if (start === undefined || end === undefined) return undefined
  return { start, end }
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
  if (info.editType === "delete" && info.shiftedCell) {
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Affected: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  } else if (info.editType === "insert" && info.shiftedCell) {
    // 插入将旧编号推后一格；这个邻居的 ID 不因显示编号变化而重新生成。
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Affected: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  }

  if (info.contextSummary) {
    // 范围上下文与 Preview 分开，消费者不能把紧凑源码预览解释成实际替换范围。
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

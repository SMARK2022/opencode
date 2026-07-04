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
 * 编辑拒绝或同步超时沿错误边界传播；差分只来自已同步修改，不隐式保存。
 */
import vscode from "vscode"
import {
  stringProp,
  sourceProp,
  fullDocumentRange,
  documentEol,
  previewText,
  quoteForSummary,
} from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges, notebookHeader, cellRef } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

// 白名单先于编辑副作用校验，未知 editType 不能被当作整格修改。
const EDIT_TYPES = new Set(["insert", "edit", "delete"])
// 十秒仅约束编辑同步，不复用运行格的执行超时或取消内核。
const EDIT_SYNC_TIMEOUT_MS = 10_000
// after-source 预览的行数和字符上限：让 agent 能从 edit 响应中精确复制
// 前若干行作为下一次 oldCode，避免模型从记忆重建时字符漂移。
// 与 plugin 层 NOTEBOOK_INSERT_PREVIEW_LINES / MAX_CHARS 保持同一量级。
const AFTER_SOURCE_PREVIEW_LINES = 10
const AFTER_SOURCE_PREVIEW_MAX_CHARS = 4 * 1024

export async function editNotebook(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  // 编辑的新契约要求明确文档，缺失路径不能沿 resolve 的只读缺省规则选中活动文件。
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const editType = stringProp(input, "editType")
  if (!editType || !EDIT_TYPES.has(editType)) {
    throw new Error(`Invalid editType: ${editType ?? "<missing>"}. Expected one of: insert, edit, delete.`)
  }

  const cellId = stringProp(input, "cellId")
  // TOP/BOTTOM 的合法性归 insert；入口只排除缺失身份，不把其它操作猜作位置编辑。
  if (!cellId) throw new Error("cellId is required")

  // 空数组不能代表省略源码；在任何写入前拒绝，显式清空仍使用空字符串。
  rejectEmptySourceArray(input, "oldCode")
  rejectEmptySourceArray(input, "newCode")

  // 非字符串数组（如对象数组）必须在变更前拦截，防止 sourceProp 静默返回
  // undefined 后触发误导性 "newCode is required" 或静默 full-cell replace
  rejectNonStringSourceArray(input, "oldCode")
  rejectNonStringSourceArray(input, "newCode")

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
  // 删除后的槽位只在结构版本推进后读取，避免把旧格报告成继任格。
  const applied = await applyNotebookEditAndWait(notebook, edit)

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
    // #224：delete 的 before/after——deletedPreview 是删除前源码，after 为空
    // #224：notebookResult 用 before=deletedPreview, after="" 生成全删除 diff
    beforeSource: deletedPreview,
    afterSource: "",
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
  // 新格和移位邻居取已同步的结构，不能先按旧 cellCount 读取 index+1。
  const applied = await applyNotebookEditAndWait(notebook, edit)
  // 同步应用后才存在新格，Inserted行与结构化身份共用它，不改显式保存顺序。
  const insertedCell = applied ? notebook.cellAt(insertIndex) : undefined
  // 未应用时不能读取 index+1，特别是尾部附近的失败插入可能使它越界。
  const shiftedCell = applied && shiftedOldIdx !== undefined ? notebook.cellAt(shiftedOldIdx + 1) : undefined
  if (input.save === true) await saveNotebook(notebook)
  // 新格差分以空源码为起点；实际位置、身份与失败状态沿用结构编辑结果。
  return compactEditResult(notebook, { applied, editType: "insert", opIndex: String(insertIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, anchorCellIndex, insertedCell, affectedCellIndex: applied ? insertIndex : undefined, shiftedCell, shiftedOldIdx, kind: cellTypeLabel(kind), language: lang, sourcePreview: source, beforeSource: "", afterSource: source })
}

async function handleEdit(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  let targetCell: vscode.NotebookCell
  try {
    targetCell = resolveNotebookCell(notebook, undefined, cellId)
  } catch (resolveErr) {
    // #105：cellId 失效时用 oldCode 扫描候选，只提示不自动改写
    const oldCodeRaw = sourceProp(input, "oldCode")
    if (!oldCodeRaw) throw resolveErr
    const candidates = scanNotebookCellsForOldCode(notebook, oldCodeRaw)
    if (candidates.length === 0) throw resolveErr
    const parts = candidates.map((c) =>
      `c${c1(c)} id=${copilotLikeCellId(c)} ${cellTypeLabel(c.kind)}/${c.document.languageId} first=${JSON.stringify(previewText((c.document.getText().split("\n")[0] ?? ""), 40))}`,
    )
    throw new Error(
      `Cell not found: ${cellId}. ` +
      (candidates.length === 1
        ? `Did you mean ${parts[0]}? Retry with this cellId.`
        : `oldCode matches ${candidates.length} cells:\n  ${parts.join("\n  ")}\nSpecify the correct cellId.`),
    )
  }
  const language = stringProp(input, "language")
  // oldCode 从格内文本定位，不接受仍可能随编辑漂移的 range 坐标。
  const oldCodeRaw = sourceProp(input, "oldCode")
  // 语言与结构类型联合判定，Code格已有markdown语言时仍须转换为Markup。
  const newKind = language === undefined ? undefined : kindFromLang(language)
  const typeChange = language !== undefined && (language !== targetCell.document.languageId || newKind !== targetCell.kind)

  if (typeChange) {
    // 旧语言和类型在替换前捕获，不能从新格反推转换箭头的左侧。
    const oldKind = cellTypeLabel(targetCell.kind)
    const oldLang = targetCell.document.languageId
    return await handleTypeChange(notebook, targetCell, input, newKind!, language!, oldKind, oldLang, oldCodeRaw, beforeCount)
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
  // 应用前捕获完整源码，不能从修改后的文档反推差分左侧。
  const beforeSource = targetCell.document.getText()

  const edit = new vscode.WorkspaceEdit()
  // TextEdit 作用于格文档 URI，NotebookEdit 作用于 notebook URI，不能交换二者。
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
  // 内容不变的 TextEdit 不产生新版本，有效空操作不能等到同步超时。
  const applied = await applyTextEditAndWait(targetCell.document, edit, source !== targetCell.document.getText())
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, anchorCellIndex: targetCell.index, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: source, beforeSource, afterSource: source })
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
  // 类型替换产生新格身份，差分左侧必须在原格还可读取时捕获。
  const beforeSource = targetCell.document.getText()

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
  // #105：type change 保留原 metadata，避免丢失自定义键
  newCell.metadata = targetCell.metadata ? { ...targetCell.metadata } : undefined
  const anchorCellIndex = targetCell.index
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(anchorCellIndex, anchorCellIndex + 1), [newCell])])
  // 新身份锚点沿同步后的原槽位获取，不按失效 targetCell.index 重新定位。
  const applied = await applyNotebookEditAndWait(notebook, edit)
  // applyEdit=false 时原格仍是有效锚点，不能假造已经创建的新格。
  const anchorCell = applied ? notebook.cellAt(anchorCellIndex) : targetCell
  if (input.save === true) await saveNotebook(notebook)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(anchorCellIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, anchorCellIndex, kind: cellTypeLabel(newKind), language: newLang, oldKind, oldLang, sourcePreview: newSource, contextSummary, beforeSource, afterSource: newSource })
}

async function handleStringEdit(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, oldCode: string, newCode: string, beforeCount: number, input: Record<string, unknown>) {
  // 片段替换的差分仍比较完整源码，Preview不代替合成结果。
  const beforeSource = targetCell.document.getText()
  const result = matchAndReplace(targetCell, oldCode, newCode)
  // Context 在 applyEdit 前捕获，不能从修改后的文档反推旧邻接行。
  const contextSummary = buildContext(notebook, targetCell, result, newCode)

  const edit = new vscode.WorkspaceEdit()
  // result.source 已保留范围外的前后缀，整文档替换不会误丢邻接代码。
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), result.source)
  // 变化判断比较完整合成源码，Preview 片段不能作为文档版本应推进的证据。
  const applied = await applyTextEditAndWait(targetCell.document, edit, result.source !== targetCell.document.getText())
  if (input.save === true) await saveNotebook(notebook)
  // Preview 只展示替换片段，完整合成源码由 TextEdit 写入而不塞进差分摘要。
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, anchorCellIndex: targetCell.index, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: newCode, contextSummary, beforeSource, afterSource: result.source })
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
    // #105：空 trim 或与 old 相同则跳过，避免假匹配
    if (trimmedOld && trimmedOld !== old) {
      matchIdx = src.indexOf(trimmedOld)
      if (matchIdx !== -1) {
        if (src.indexOf(trimmedOld, matchIdx + 1) !== -1) {
          throw new Error(`oldCode matches multiple locations in cell c${c1(targetCell)}. Provide more surrounding context.`)
        }
        matchLen = trimmedOld.length
        strategy = "border-trimmed"
      }
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

  // #105：line/border 策略携带源缩进到 newCode
  let replacement = rep
  if (strategy !== "exact") {
    const matchedBlock = src.slice(matchIdx, matchIdx + matchLen)
    const srcIndent = baseIndent(matchedBlock)
    if (srcIndent) {
      const firstNewLine = rep.split("\n").find((l) => l.trim())
      if (firstNewLine && !firstNewLine.startsWith(srcIndent)) {
        replacement = migrateIndent(rep, srcIndent)
      }
    }
  }
  // 替换正文仍按 LF 坐标拼接后恢复原 EOL，缩进迁移不改变范围外内容。
  const source = (src.substring(0, matchIdx) + replacement + src.substring(matchIdx + matchLen)).replace(/\n/g, eol)

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

  let found: { index: number; length: number } | undefined
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
      // 行级宽松匹配也必须唯一，不能静默选择第一处。
      if (found) throw new Error("oldCode matches multiple locations (line-trimmed). Provide more surrounding context.")
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
      found = { index: start, length: end - start }
    }
  }
  return found
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

function rejectEmptySourceArray(input: Record<string, unknown>, key: "oldCode" | "newCode") {
  if (Array.isArray(input[key]) && input[key].length === 0) {
    throw new Error(`${key} cannot be an empty array. Omit ${key} for language-only edits, or pass an explicit empty string to clear source.`)
  }
}

// agent 偶尔把结构化对象数组（如 HTTP headers）传给 oldCode/newCode。
// sourceProp 对非字符串数组返回 undefined，导致 "newCode is required" 误导性错误，
// 或 oldCode 被静默忽略后执行 full-cell replacement 造成数据丢失。
// 在任何 notebook 变更前拦截，给出明确的类型错误。
function rejectNonStringSourceArray(input: Record<string, unknown>, key: "oldCode" | "newCode") {
  const value = input[key]
  if (Array.isArray(value) && !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string or an array of strings, but contains non-string items. Pass source code text, not structured objects.`)
  }
}

// 从 afterSource 中提取前 N 行作为 oldCode 锚点预览。
// CRLF 规范化为 LF：matchAndReplace 也会将两端的 CRLF 规范化为 LF 后匹配，
// 所以预览用 LF 不会引入匹配差异，同时减少 token 消耗。
function afterSourcePreview(source: string) {
  const rawLines = source.replace(/\r\n/g, "\n").split("\n")
  const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines
  const linePreview = lines.slice(0, AFTER_SOURCE_PREVIEW_LINES).join("\n")
  const text = linePreview.length > AFTER_SOURCE_PREVIEW_MAX_CHARS
    ? linePreview.slice(0, AFTER_SOURCE_PREVIEW_MAX_CHARS)
    : linePreview
  return {
    text,
    truncated: lines.length > AFTER_SOURCE_PREVIEW_LINES || text.length < linePreview.length,
    remainingLines: Math.max(0, lines.length - AFTER_SOURCE_PREVIEW_LINES),
  }
}


async function applyNotebookEditAndWait(notebook: vscode.NotebookDocument, edit: vscode.WorkspaceEdit) {
  // 提交前版本是本次修改的基线，不能在 applyEdit 的 await 返回后才采样。
  const beforeVersion = notebook.version
  const applied = await vscode.workspace.applyEdit(edit)
  // 拒绝应用直接终止，不能返回已修改差分或继续执行显式保存。
  if (!applied) throw new Error("VS Code notebook edit was not applied")
  await waitForNotebookVersionChange(notebook, beforeVersion, EDIT_SYNC_TIMEOUT_MS)
  return applied
}

async function applyTextEditAndWait(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, expectContentChange: boolean) {
  const beforeVersion = document.version
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) throw new Error("VS Code text edit was not applied")
  // 文本仅观察格文档版本，notebook 的其它输出更新不能满足源码同步。
  if (expectContentChange) await waitForTextDocumentVersionChange(document, beforeVersion, EDIT_SYNC_TIMEOUT_MS)
  return applied
}

async function waitForNotebookVersionChange(notebook: vscode.NotebookDocument, beforeVersion: number, timeoutMs: number) {
  // applyEdit 等待期间可能已收到事件，版本快检覆盖已经落地的结构修改。
  if (notebook.version !== beforeVersion) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      // 工作区广播包含其它文档，只有本 notebook 的版本可以解除结构等待。
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      // 同 URI 但仍为提交前版本的通知不能提前结束等待。
      if (event.notebook.version === beforeVersion) return
      finish()
    })
    const finish = (error?: Error) => {
      // 成功和超时共用释放路径，返回后不能遗留监听器或迟到计时器。
      if (timer) clearTimeout(timer)
      subscription.dispose()
      error ? reject(error) : resolve()
    }
    // applyEdit=true 只证明已接受修改，同步超时仍须拒绝而非发布旧结构摘要。
    timer = setTimeout(() => finish(new Error("Timed out waiting for VS Code notebook edit events to finish")), timeoutMs)
  })
}

async function waitForTextDocumentVersionChange(document: vscode.TextDocument, beforeVersion: number, timeoutMs: number) {
  if (document.version !== beforeVersion) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      // 文本事件按完整格 URI 过滤，邻格源码变更不能满足当前替换等待。
      if (event.document.uri.toString() !== document.uri.toString()) return
      if (event.document.version === beforeVersion) return
      finish()
    })
    const finish = (error?: Error) => {
      if (timer) clearTimeout(timer)
      subscription.dispose()
      error ? reject(error) : resolve()
    }
    timer = setTimeout(() => finish(new Error("Timed out waiting for VS Code cell text edit events to finish")), timeoutMs)
  })
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
    insertedCell?: vscode.NotebookCell
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
    // #224：before/after 源码供 opencode TUI 生成 diff card
    beforeSource?: string
    afterSource?: string
  },
) {
  // 插入区分锚点与新格，删除使用提交前快照，避免复用失效格代理。
  const target = info.editType === "insert" && info.anchorCell
    ? `after ${cellRef(info.anchorCell)}`
    : info.editType === "insert" && info.insertedCell
      ? `at ${cellRef(info.insertedCell)}`
      : info.editType === "delete" && info.deletedId
        ? `c${(info.deletedCellIndex ?? 0) + 1} id=${info.deletedId} ${info.deletedKind}/${info.deletedLang}`
        : info.anchorCell
          ? cellRef(info.anchorCell)
          : `index=${info.opIndex}`
  const lines: Array<string | undefined> = [
    ...notebookHeader(notebook, "Edit", [
      `op=${info.editType}`,
      `applied=${info.applied}`,
      `dirty=${notebook.isDirty}`,
      `cells=${info.beforeCount}->${info.afterCount}`,
      `target=${quoteForSummary(target)}`,
    ]),
  ]

  if (info.editType === "delete" && info.deletedId) {
    const dIdx = (info.deletedCellIndex ?? 0) + 1
    // Deleted标记失效的旧ID；存在继任格时由Shifted提供续接身份。
    lines.push(`Deleted: c${dIdx} id=${info.deletedId} ${info.deletedKind}/${info.deletedLang} lines=${info.deletedLineCount} first=${JSON.stringify(info.deletedFirst)}`)
  } else if (info.anchorCell) {
    const anchorId = copilotLikeCellId(info.anchorCell)
    const typePart = info.oldKind
      ? `${info.oldKind}/${info.oldLang}->${info.kind}/${info.language}`
      : `${cellTypeLabel(info.anchorCell.kind)}/${info.anchorCell.document.languageId}`
    lines.push(`Anchor: c${c1(info.anchorCell)} id=${anchorId} ${typePart}.`)
    if (info.oldKind) {
      lines.push(`NOTE: Type change replaced the cell. Use id=${anchorId} for subsequent operations on this cell.`)
    }
  }

  // Inserted单独标识新格，并在Shifted之前给出可续用ID。
  if (info.editType === "insert" && info.insertedCell) {
    lines.push(`Inserted: c${c1(info.insertedCell)} id=${copilotLikeCellId(info.insertedCell)} ${cellTypeLabel(info.insertedCell.kind)}/${info.insertedCell.document.languageId}.`)
  }
  // Shifted只描述邻居位置移动，不能冒充新插入格。
  if ((info.editType === "delete" || info.editType === "insert") && info.shiftedCell) {
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Shifted: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  }

  if (info.contextSummary) {
    // 匹配上下文与 Preview 分开，消费者不能把紧凑源码预览解释成实际替换范围。
    lines.push(`Context:\n${info.contextSummary}`)
  }
  if (info.sourcePreview) {
    // 正文仅作 50 字符预览，完整新源码留在打开文档而非塞进操作差分。
    lines.push(`Preview: ${JSON.stringify(previewText(info.sourcePreview, 50))}`)
  }
  // delete 操作的 afterSource 为空，不追加。
  if (info.afterSource && info.editType !== "delete") {
    const preview = afterSourcePreview(info.afterSource)
    lines.push(`AfterSource (first ${preview.text.split("\n").length} lines, use as oldCode for next edit):`)
    lines.push(preview.text)
    if (preview.truncated) {
      // 行数截断和字符截断是两种不同情况：行数超限时提示剩余行数；
      // 行数未超但字符超限时提示字符截断，避免出现 "(... 0 more lines)" 误导
      if (preview.remainingLines > 0) {
        lines.push(`(... ${preview.remainingLines} more lines, use vscode_notebook_source for full cell)`)
      } else {
        lines.push(`(... line content truncated at ${AFTER_SOURCE_PREVIEW_MAX_CHARS} chars, use vscode_notebook_source for full cell)`)
      }
    }
  }


  return {
    ran: false,
    summary: lines.join("\n"),
    data: {
      applied: info.applied,
      editType: info.editType,
      cellCountBefore: info.beforeCount,
      cellCountAfter: info.afterCount,
      anchorCellIndex: info.anchorCellIndex,
      // 新格索引和ID同源，既有anchorCellIndex仍保留提交前位置。
      insertedCellIndex: info.insertedCell?.index,
      insertedCellId: info.insertedCell ? copilotLikeCellId(info.insertedCell) : undefined,
      // 类型替换产生新格句柄，后续调用使用同步完成后捕获的anchorCell身份。
      updatedCellId: info.editType === "edit" && info.anchorCell ? copilotLikeCellId(info.anchorCell) : undefined,
      deletedCellIndex: info.deletedCellIndex,
      affectedCellIndex: info.affectedCellIndex,
      dirty: notebook.isDirty,
      kind: info.kind,
      language: info.language,
      // 桥接返回格级差分输入，插件仅持久化有界diff；模型summary保持原样。
      beforeSource: info.beforeSource,
      afterSource: info.afterSource,
    },
  }
}

// #105：cellId 失效时用 oldCode 扫描候选，提示正确 #VSC id（不自动改写）
// #105：仅扫描 contains(oldCode) 的 cell，供 Did-you-mean 提示
function scanNotebookCellsForOldCode(notebook: vscode.NotebookDocument, oldCode: string) {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n")
  const old = normalize(oldCode)
  return notebook.getCells().filter((c) => normalize(c.document.getText()).includes(old))
}

// #105：非 exact 策略时把 newCode 缩进迁移到源块缩进，避免错位写入
// #105：取非空行公共前导空白作为块缩进
function baseIndent(text: string) {
  const lines = text.split("\n").filter((l) => l.trim())
  if (!lines.length) return ""
  const indents = lines.map((l) => l.match(/^[ \t]*/)?.[0] ?? "")
  let prefix = indents[0]
  for (const indent of indents.slice(1)) {
    let i = 0
    while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) return ""
  }
  return prefix
}

// #105：把 newCode 相对缩进映射到 matched 源块缩进
function migrateIndent(newCode: string, targetIndent: string) {
  const lines = newCode.split("\n")
  const srcBase = baseIndent(newCode)
  return lines
    .map((line) => {
      if (!line.trim()) return line
      if (srcBase && line.startsWith(srcBase)) return targetIndent + line.slice(srcBase.length)
      return targetIndent + line.trimStart()
    })
    .join("\n")
}

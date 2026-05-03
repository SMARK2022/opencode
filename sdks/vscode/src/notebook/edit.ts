/**
 * vscode_notebook_edit 负责应用 WorkspaceEdit/NotebookEdit，以及执行显式请求的保存。
 * 操作列表：
 *   insert_before / insert_after - 在选中单元格的相对位置插入
 *   insert_top / insert_bottom   - 无需锚点单元格即可插入
 *   replace_source               - 通过 TextEdit 修改已有格文档，保留其单元格身份
 *   replace_cell                 - 以新的 NotebookCellData 进行结构替换
 *   delete                       - 删除选中单元格，报告其编辑前位置
 * 使用 cellIndex 或完整规范化 cellId 选择单元格；源契约允许省略 filePath。
 * source 接受字符串或按目标文档 EOL 拼接的 string[]；空输入可清空内容。
 * save=true 请求持久化；仅当保存前文档为 dirty 时，保存返回 false 才是错误。
 * 返回编辑差分与 applyEdit 结果，不返回整份笔记本；命令面板与 HTTP 共用此处理器。
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
import { cellKindLabel, runtimeLabel } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

const EDIT_OPERATIONS = new Set([
  "insert_before",
  "insert_after",
  "insert_top",
  "insert_bottom",
  "replace_source",
  "replace_cell",
  "delete",
])

export async function editNotebook(input: Record<string, unknown>) {
  // edit 模块独占 WorkspaceEdit 的构建和应用，路由只能提交参数，不能直接修改格。
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const operation = stringProp(input, "operation")

  // operation 白名单在构建 WorkspaceEdit 前校验，未知操作不得降级成插入。
  if (!operation || !EDIT_OPERATIONS.has(operation)) {
    throw new Error(`Invalid notebook edit operation: ${operation ?? "<missing>"}`)
  }

  // 结构编辑会改变 cellCount，差分基线必须在 applyEdit 前记录，不能在返回后反推原格数。
  const beforeCount = notebook.cellCount

  if (operation === "delete") {
    const cell = resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))
    // 删除后旧格 index 会变为 -1；编辑范围和结果必须共享删除前的位置。
    const affectedCellIndex = cell.index
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(affectedCellIndex, affectedCellIndex + 1))])
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) await saveNotebook(notebook)
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex,
    })
  }

  const targetCell =
    operation === "insert_top" || operation === "insert_bottom"
      ? undefined
      : resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))

  const kind = cellKindFromInput(input, targetCell)
  const language = cellLanguageFromInput(input, kind, targetCell)
  const sourceRaw = sourceProp(input, "source", targetCell ? documentEol(targetCell.document) : "\n")

  if (sourceRaw === undefined) {
    throw new Error(`source is required for ${operation}`)
  }

  const source = kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
  // 代码围栏只在 code 格剥离，markdown 格中的围栏是文档正文。

  if (operation === "replace_source") {
    if (!targetCell) throw new Error("replace_source requires a target cell")
    const edit = new vscode.WorkspaceEdit()
    // 源码替换作用于 cell 文档 URI；结构替换作用于 notebook URI，二者不可混用。
    edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) await saveNotebook(notebook)
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex: targetCell.index,
      kind: cellKindLabel(targetCell.kind),
      language: targetCell.document.languageId,
      sourcePreview: source,
    })
  }

  const insertIndex =
    operation === "insert_top"
      ? 0
      : operation === "insert_bottom"
        ? notebook.cellCount
        : operation === "insert_after"
          ? targetCell!.index + 1
          : targetCell!.index // insert_before or replace_cell

  // 结构替换会移除目标格；anchor 报告提交编辑时的位置，不读取失效格的动态索引。
  const anchorCellIndex = targetCell?.index
  const range =
    operation === "replace_cell"
      ? new vscode.NotebookRange(targetCell!.index, targetCell!.index + 1)
      : new vscode.NotebookRange(insertIndex, insertIndex)

  const newCell = new vscode.NotebookCellData(kind, source, language)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(range, [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  // save=true 是显式请求，默认编辑只改变打开文档；dirty 保存失败必须传播，不能伪报持久化成功。
  if (input.save === true) await saveNotebook(notebook)

  return compactEditResult(notebook, {
    // applyEdit 的布尔结果保持原响应语义，保存失败已由共享 owner 拒绝。
    applied,
    operation,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCellIndex,
    affectedCellIndex: insertIndex,
    kind: cellKindLabel(kind),
    language,
    sourcePreview: source,
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
    operation: string
    beforeCount: number
    afterCount: number
    anchorCellIndex?: number
    affectedCellIndex?: number
    kind?: string
    language?: string
    sourcePreview?: string
  },
) {
  const target =
    // 删除后此位置可能是继任格，摘要只描述当前槽位，不能声称被删除的原格仍存在。
    info.affectedCellIndex !== undefined && info.affectedCellIndex >= 0 && info.affectedCellIndex < notebook.cellCount
      ? notebook.cellAt(info.affectedCellIndex)
      : undefined

  const targetText = target
    ? `c${target.index} ${cellKindLabel(target.kind)}/${target.document.languageId} lines=${target.document.lineCount} first=${JSON.stringify(previewText((target.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120))}`
    : "none"

  return {
    ran: false,
    summary: [
      `Notebook edit: applied=${info.applied} op=${info.operation} cells=${info.beforeCount}->${info.afterCount} dirty=${notebook.isDirty}.`,
      info.anchorCellIndex !== undefined ? `Anchor: c${info.anchorCellIndex}.` : undefined,
      info.affectedCellIndex !== undefined ? `Affected: c${info.affectedCellIndex}. ${targetText}` : undefined,
      info.sourcePreview ? `Preview: ${JSON.stringify(info.sourcePreview.slice(0, 160))}` : undefined,
      `Next: use vscode_notebook_source for full cell source; use vscode_notebook_summary for full notebook state.`,
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      applied: info.applied,
      operation: info.operation,
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

function cellKindFromInput(input: Record<string, unknown>, existing?: vscode.NotebookCell) {
  const kind = stringProp(input, "kind")
  const language = stringProp(input, "language")
  // markdown 是结构类型并优先于 kind=code，否则按 markdown 语言请求的格会被当成可执行代码。
  if (kind === "markdown" || language === "markdown") return vscode.NotebookCellKind.Markup
  if (kind === "code") return vscode.NotebookCellKind.Code
  return existing?.kind ?? vscode.NotebookCellKind.Code
}

function cellLanguageFromInput(
  input: Record<string, unknown>,
  kind: vscode.NotebookCellKind,
  existing?: vscode.NotebookCell,
) {
  const language = stringProp(input, "language")
  // 非空显式语言允许有意修改语法模式，空字符串仍走原默认，不能成为有效 languageId。
  if (language) return language
  // Markup 默认语言不能沿用原代码格的 python；语言字段仅配置 cell，不切换解释器或内核。
  if (kind === vscode.NotebookCellKind.Markup) return "markdown"
  // Code 保留现有 languageId；无现有格才默认 python，避免意外改变语法模式。
  return existing?.document.languageId ?? "python"
}

function stripCodeFence(source: string) {
  // 仅剥离完整包围正文的围栏，源码中间的反引号或未闭合围栏不能被宽松搜索截掉。
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}

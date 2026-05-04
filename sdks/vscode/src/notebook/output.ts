// output 拥有 immutable artifact 导出；run 复用纯捕获与单 item 写入接口，不另建存储层。
import vscode from "vscode"
import path from "node:path"
import { randomUUID } from "node:crypto"
/** 输出主定位参数为 Copilot 风格的 cellId；原始字节保留在 notebook-outputs 导出文件中。 */
import {
  compactCell,
  runtimeLabel,
  isTextLikeMime,
  extensionForMime,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

export async function readNotebookCellOutput(filePath: string, cellIndex?: number, cellId?: string) {
  // output 先通过 resolve 确定文档和格，序列化边界不得重新选择另一份 notebook。
  const notebook = await resolveNotebook(filePath)
  // 混合参数优先验证 cellId，不能让数字位置绕过无效或歧义身份的拒绝。
  const cell = resolveNotebookCell(notebook, cellIndex, cellId)
  // 此端点只导出已有输出，不能为了补齐缺失输出而启动内核执行。
  return await serializeNotebookCellOutput(notebook, cell)
}

export function captureNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  // outputs 是原模型的可变列表，先复制层级，后续输出替换不能改变请求的 item 集合。
  // item.data 还可能原地改写，复制 Uint8Array 才能同时固定预览字节和 artifact 字节。
  const outputs = cell.outputs.map((output) => ({ items: output.items.map((item) => ({ mime: item.mime, data: Uint8Array.from(item.data) })) }))
  // 捕获函数没有 I/O；run 可以先完成全部目标的投影，再启动任一格的文件写入。
  return {
    // output 导出的快照只包含请求私有数据，跨模块消费者不能借它修改或重新定位 notebook。
    outputs,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      // runtime 是捕获时的元数据描述，不与文件写入完成时的内核标签重新拼接。
      runtime: runtimeLabel(notebook),
      // 捕获中没有 await，compactCell 已同步生成私有 MIME 列表，无需再投影一次。
      cell: compactCell(cell),
    },
  }
}

async function serializeNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  // path、dirty、runtime 与格状态在同一同步边界捕获，不能晚于输出字节选取。
  const snapshot = captureNotebookCellOutput(notebook, cell)
  const artifacts = (
    // 任一 item 写入失败都会拒绝整体导出，不能把缺失 artifact 隐藏在成功列表中。
    await Promise.all(
      // 每个 output 可含多个 MIME item，导出必须保留所有替代表示而非只取第一项。
      snapshot.outputs.flatMap((cellOutput, outputIndex) =>
        // 输出序号只定位快照；统一 serializer 以每次导出的 UUID 避免覆盖旧文件。
        cellOutput.items.map((item, itemIndex) =>
          serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex),
        ),
      ),
    )
  ).flat()

  // ID 与标题同取 I/O 前快照，导出期间插格或第二次运行不能改变本次输出身份。
  const cellId = snapshot.data.cell.id
  const summaryLines = [
    // 标题只读取快照格编号与 MIME，即使写入期间发生插格或第二次运行也保持 A 的描述。
    `Cell c${snapshot.data.cell.i} id=${cellId} existing outputs: ${snapshot.data.cell.existing_outs.join(", ") || "none"}.`,
    `ArtifactsRoot: .opencode/cache/notebook-outputs/`,
    "",
    "Artifacts:",
    // 文本摘要中的路径与 data.artifacts 指向同一次导出，不能返回尚未写入的文件。
    ...artifacts.map((a) => formatArtifactSummary(a)),
  ].join("\n")

  return {
    ran: false,
    summary: summaryLines,
    data: {
      // await 后只附加实际写入路径，不能重新 compactCell 将 B 的状态贴到 A 的输出上。
      ...snapshot.data,
      artifacts,
    },
  }
}

// 此导出函数是 run 与 output 的共同写入边界，两端共享快照身份和原始字节规则。
export async function serializeNotebookOutputItem(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  // 原始 data 用于 artifact，UTF-8 解码仅产生可选文本预览，不参与二进制写入。
  const text = outputItemText(item)
  // MIME、大小、预览及内联阈值也须早于写入 await，不能只固定文件中的字节。
  const data = {
    output: outputIndex,
    item: itemIndex,
    // MIME、字节数和输出序号一起返回，让消费者无需靠扩展名猜测真实内容。
    mime: item.mime,
    bytes: item.data.byteLength,
    // 预览保留原换行并裁剪 500 字符；该显示预算不能裁掉 writer 捕获的原始字节。
    preview: text !== undefined ? text.slice(0, 500) : `<${item.mime} ${item.data.byteLength} bytes>`,
    // 8192 字节只限制内联 text，超过上限或零字节输出仍须完整导出真实 artifact。
    text: text && item.data.byteLength <= 8_192 ? text : undefined,
  }
  // 同一格重跑可能替换 outputs；写入器在首次异步边界前复制当前 item 字节。
  const artifact = await writeArtifact(notebook, cell, item, outputIndex, itemIndex)
  return {
    ...data,
    artifactPath: artifact.fsPath,
    // 两个地址来自同一 writer；URI 保留远程 scheme/authority，path 继续供本地消费者使用。
    artifactURI: artifact.uri.toString(),
  }
}

function outputItemText(item: vscode.NotebookCellOutputItem) {
  // stdout、stderr 和 notebook error 使用 VS Code 专用 MIME，不能只检测 text/。
  if (isTextLikeMime(item.mime)) {
    // JSON 只解码展示，不格式化原字节；解码不赋予 current-run 来源，也不判定运行成功。
    return Buffer.from(item.data).toString("utf8")
  }
  // PNG 或未知 MIME 不进入 UTF-8 解码，摘要引用原始 artifact，避免乱码预览。
  return undefined
}

async function writeArtifact(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  const root = artifactRoot(notebook)
  const data = Uint8Array.from(item.data)
  // 原始字节在 filesystem await 前复制，后续输出变更不能改变已捕获快照。
  const filename =
    [
      // basename 经 ASCII 化并限长，非 ASCII 文件名不会撑过文件系统预算。
      path.basename(notebook.uri.fsPath || "untitled", path.extname(notebook.uri.fsPath || "untitled")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48),
      // 每个导出项已有独立 UUID，同名文档和重跑无需再叠加 URI 哈希来区分。
      randomUUID(),
      `cell-${cell.index}`,
      `output-${outputIndex}`,
      `item-${itemIndex}`,
    ].join("-") + extensionForMime(item.mime)
  const uri = vscode.Uri.joinPath(root, filename)
  // workspace.fs 保留 URI 的文件系统提供者，不能把远程工作区路径当成本地 Node 路径写。
  await vscode.workspace.fs.createDirectory(root)
  // 文件创建失败向上抛出；只有实际写入成功的 URI 才能出现在 artifactPath 中。
  await vscode.workspace.fs.writeFile(uri, data)
  return { uri, fsPath: uri.fsPath || uri.toString() }
}

function artifactRoot(notebook: vscode.NotebookDocument) {
  // 优先所属 workspace folder；无所属根保留源首根回退，导出项仍由 UUID 区分。
  const folder = vscode.workspace.getWorkspaceFolder(notebook.uri) ?? vscode.workspace.workspaceFolders?.[0]
  // 无工作区显式报错，不能擅自写到扩展安装目录或用户主目录。
  if (!folder) throw new Error("Notebook output artifacts require an open workspace folder")
  // joinPath 在 URI 层拼接，保留远程提供者的 scheme 与 authority。
  return vscode.Uri.joinPath(folder.uri, ".opencode", "cache", "notebook-outputs")
}

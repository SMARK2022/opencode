// format 提供共享的纯投影规则，不反向依赖执行或 artifact 写入模块。
import vscode from "vscode"
import {
  isRecord,
  stringProp,
  numberProp,
  nestedStringAt,
  firstString,
  previewText,
  formatBytes,
  quoteForSummary,
} from "../util"

export function shortMime(mime: string) {
  if (mime === "application/vnd.code.notebook.stdout") return "stdout"
  if (mime === "application/vnd.code.notebook.stderr") return "stderr"
  if (mime === "application/vnd.code.notebook.error") return "error"
  if (mime === "image/png") return "png"
  if (mime === "image/jpeg") return "jpeg"
  if (mime === "text/plain") return "text"
  if (mime === "text/html") return "html"
  if (mime === "text/markdown") return "markdown"
  if (mime === "application/json") return "json"
  if (mime.includes("datawrangler")) return "datawrangler"
  return mime.split("/").pop() ?? mime
}

export function extensionForMime(mime: string) {
  if (mime === "image/png") return ".png"
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/svg+xml") return ".svg"
  if (mime === "text/html") return ".html"
  if (mime === "application/json") return ".json"
  if (mime.startsWith("text/")) return ".txt"
  return ".bin"
}

// MIME 接口共同服务输出解码和摘要内联，两端必须复用同一集合，不能各增一套不一致的展示规则。
export function isTextLikeMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr" ||
    mime === "application/vnd.code.notebook.error" ||
    shortMime(mime) === "datawrangler"
  )
}

export function shortId(id: string) {
  // canonical ID 必须保留完整内容供摘要、源码与解析器往返，截短会混淆共享前缀的不同格。
  return `#VSC-${id.replace(/^#?VSC-/, "").replace(/^#/, "")}`
}

export function cellIdentifiers(cell: vscode.NotebookCell) {
  // URI 身份先于可被 serializer 改写的 metadata 别名；解析器仍检查全部别名并拒绝跨格冲突。
  return [
    cell.document.uri.fragment || cell.document.uri.toString(),
    stringProp(cell.metadata, "id"),
    stringProp(cell.metadata, "cellId"),
    nestedStringAt(cell.metadata, "vscode", "cellId"),
    nestedStringAt(cell.metadata, "custom", "id"),
  ].filter((value): value is string => !!value)
}

export function cellKindLabel(kind: vscode.NotebookCellKind) {
  return kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
}

export function existingOuts(cell: vscode.NotebookCell) {
  return [...new Set(cell.outputs.flatMap((cellOutput) => cellOutput.items.map((item) => shortMime(item.mime))))]
}

export function executionText(cell: vscode.NotebookCell) {
  const summary = cell.executionSummary
  if (!summary) {
    if (cell.outputs.length === 0) return "not-run"
    const saved = savedExecution(cell)
    // saved 保留历史时间，但成功仍未知，不能从保存的 MIME 推断。
    return `saved #${saved.order} ${saved.status}${saved.duration}${saved.ended}`
  }
  const state = executionState(cell).provenance
  const status = executionState(cell).status
  // executionOrder 为零也可能存在，不能用真值检查将其判为未运行。
  const order = summary.executionOrder ?? "?"
  // duration 的非负钳制只影响展示，不能让异常时序成为执行完成证据。
  const duration = summary.timing ? ` ${Math.max(0, summary.timing.endTime - summary.timing.startTime)}ms` : " ?ms"
  // 无 timing 明确保留未知结束时间，不拿导出时间充当内核结束时间。
  const ended = summary.timing ? ` ended=${new Date(summary.timing.endTime).toISOString()}` : " ended=?"
  return `${state} #${order} ${status}${duration}${ended}`
}

function savedExecution(cell: vscode.NotebookCell) {
  const outputMetadata = cell.outputs.map((output) => output.metadata).filter(isRecord)
  const endedRaw = firstString(
    // 整格结束时间优先于各输出 timestamp，避免将某一输出的写入时间优先当作整格结束。
    stringProp(cell.metadata, "execution_end_time"),
    stringProp(cell.metadata, "end_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringProp(metadata, "execution_end_time"),
      stringProp(metadata, "end_time"),
      stringProp(metadata, "timestamp"),
    ]),
  )
  const startedRaw = firstString(
    // 历史开始时间只取保存的 cell/output 字段，不能与本次导出开始时间拼成伪造的执行耗时。
    stringProp(cell.metadata, "execution_start_time"),
    stringProp(cell.metadata, "start_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringProp(metadata, "execution_start_time"),
      stringProp(metadata, "start_time"),
    ]),
  )
  return {
    order: numberProp(cell.metadata, "execution_count") ?? "?",
    // serializer 可在 metadata 写入自定义 status/success，但这些同名字段不具原生 executionSummary.success 的语义。
    status: "unknown",
    // 缺失或无法解析的时间保留问号，不补成当前时间或回写 metadata scope。
    duration: durationText(startedRaw, endedRaw),
    ended: endedRaw ? ` ended=${formatDate(endedRaw)}` : " ended=?",
  }
}

function durationText(startedRaw?: string, endedRaw?: string) {
  // 历史时间字段是可选字符串，缺少任一端点就不能计算可靠耗时。
  if (!startedRaw || !endedRaw) return " ?ms"
  const started = Date.parse(startedRaw)
  const ended = Date.parse(endedRaw)
  // 排除 Date.parse 的 NaN，问号表示证据缺失，不能用当前时间补齐旧执行。
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return " ?ms"
  // start/end 独立选取保存字段，可能来自不同输出时钟；负差钳零只是展示下限，不证明真实耗时为零。
  return ` ${Math.max(0, ended - started)}ms`
}

function formatDate(input: string) {
  const value = Date.parse(input)
  // 无法解析的历史值原样展示，不能补成当前时间或抛错使整个只读摘要不可用。
  return Number.isFinite(value) ? new Date(value).toISOString() : input
}

export function runtimeLabel(notebook: vscode.NotebookDocument) {
  // kernelspec/language_info 是文档元数据描述，不证明当前选中的解释器、内核进程或包版本。
  const kernelspec = isRecord(notebook.metadata.kernelspec) ? notebook.metadata.kernelspec : undefined
  const language = isRecord(notebook.metadata.language_info) ? notebook.metadata.language_info : undefined
  const kernelName = stringProp(kernelspec ?? {}, "display_name") ?? stringProp(kernelspec ?? {}, "name")
  const languageName = stringProp(language ?? {}, "name")
  const languageVersion = stringProp(language ?? {}, "version")
  if (kernelName && languageName && languageVersion) return `${kernelName} (${languageName} ${languageVersion})`
  if (kernelName) return kernelName
  if (languageName && languageVersion) return `${languageName} ${languageVersion}`
  return languageName ?? null
}

export function compactCell(cell: vscode.NotebookCell) {
  return {
    i: cell.index,
    // URI 兜底绑定格文档，不以会随插入删除漂移的索引生成摘要身份。
    id: shortId(cellIdentifiers(cell)[0] ?? cell.document.uri.toString()),
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    // 语言和行数来自实时 cell.document，不用保存 metadata 覆盖未保存编辑。
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    // execution 是机器可读状态，exec 仅保留人类可读的顺序、时间和来源文案。
    exec: executionText(cell),
    // existing_outs 列出 MIME 能力，不作为成功或失败的业务判定输入。
    existing_outs: existingOuts(cell),
    // 首行预览取真实源码后截短，不执行代码或剥离 markdown 正文。
    first: previewText((cell.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120),
    execution: executionState(cell),
  }
}

export function executionState(cell: vscode.NotebookCell) {
  return {
    // 状态只取原生 success 布尔值，输出存在或 MIME 名称都不能补成成功/失败证据。
    status: cell.executionSummary?.success === false ? "failed" : cell.executionSummary?.success === true ? "succeeded" : "unknown",
    // 摘要与 timing 可从磁盘恢复，缺少请求身份时来源仍为 unknown；无摘要的历史输出仅标 saved。
    provenance: cell.executionSummary ? "unknown" : cell.outputs.length > 0 ? "saved" : "unknown",
  }
}

function artifactName(p: string) {
  // basename 仅用于紧凑展示，不能作为读取地址；真实路径与远程 URI 保留在结构化 artifact 中。
  return p.replace(/\\/g, "/").split("/").pop() ?? p
}

type NotebookArtifact = {
  // 摘要接受 serializer 返回的标量结构，不直接读取可变 cell/output 代理来补齐字段。
  output: number
  item: number
  mime: string
  bytes: number
  preview?: string
  text?: string
  artifactPath: string
  // URI 不参与摘要 basename 提取，因此此字段可选；远程读取仍须使用 writer 返回的完整地址。
  artifactURI?: string
}

export function formatArtifactSummary(a: NotebookArtifact, cellIndex?: number) {
  // output/item 序号可在不同格内重复，多格 run 需要格前缀；单格导出已由标题绑定身份。
  const prefix = cellIndex !== undefined ? `c${cellIndex} ` : ""
  // MIME 短标签只用于显示，真实 MIME 和字节数仍保留在结构化数据中。
  const baseInfo = `${prefix}output=${a.output} item=${a.item} ${shortMime(a.mime)} ${formatBytes(a.bytes)}`

  // 1024 字符只控制内联展示，完整内容已写入 artifact，不能误作文件字节上限。
  if (isTextLikeMime(a.mime) && a.text !== undefined && a.text.length <= 1024) {
    if (a.text.includes("\n")) {
      // 多行展示保留真实换行便于读回，单行用 JSON 转义防止引号或控制字符破坏条目边界。
      return `${baseInfo}\n<content>\n${a.text}\n</content>`
    }
    return `${baseInfo} ${JSON.stringify(a.text)}`
  }

  if (isTextLikeMime(a.mime)) {
    // 缺省 text 的大输出只展示 preview，完整内容须读取返回路径。
    const content = a.text !== undefined ? a.text.slice(0, 1024) : a.preview
    return `${baseInfo} -> ${artifactName(a.artifactPath)}\n<content>\n${content}\n... (truncated, full output in the file)\n</content>`
  }

  return `${baseInfo} -> ${artifactName(a.artifactPath)}${a.preview ? ` ${quoteForSummary(a.preview)}` : ""}`
}

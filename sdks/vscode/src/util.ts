// util 只解释字段、URI 和文本，不保存 notebook、执行代码或拥有 transport 资源。
import vscode from "vscode"

export function isRecord(value: unknown): value is Record<string, unknown> {
  // 需对象参数的路由不能接受数组，否则按名取值会使 filePath/target 静默缺省并选中默认文档或格。
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function numberProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  // 执行位置和 timeout 只接受有限数字，不能把数字文本或非有限内部输入悄悄用作范围边界。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function stringAt(record: Record<string, unknown>, key: string) {
  return stringProp(record, key)
}

export function nestedStringAt(record: Record<string, unknown>, key: string, nestedKey: string) {
  const value = record[key]
  // 不同 notebook serializer 可省略或改变嵌套 metadata 形状，非对象应视为缺失而非使摘要崩溃。
  return isRecord(value) ? stringAt(value, nestedKey) : undefined
}

export function firstString(...values: Array<string | undefined>) {
  // 空白时间戳应继续寻找下一 metadata 来源，不能让首个空白字段遮住后续保存证据。
  return values.find((value) => value && value.trim())
}

export function sourceProp(record: Record<string, unknown>, key: string, eol = "\n") {
  const value = record[key]
  // 字符串原样保留换行；空字符串可清空内容，不能与未提供源码的 undefined 合并。
  if (typeof value === "string") return value
  // 数组中的每项都须为字符串，不能把对象或数字隐式转成代码文本。
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    // 空数组按零行输入解释为空源码，不能因数组长度为零拒绝显式清空。
    // 字符串数组只按调用方提供的文档 EOL 拼接，不能强制改为 LF。
    return value.join(eol)
  }
  // 非字符串输入拒绝；code/markdown 围栏处理归 editNotebook，本解析器不改写正文。
  return undefined
}

export function uriFromInput(input: string) {
  // Windows 路径的盘符冒号必须先于 scheme 检测，否则 C: 会被解析成 URI 协议。
  // 盘符判断必须带根斜杠，单字母冒号不足以判定文件路径，否则会把 x:cell 这类 URI 误交给文件提供者。
  if (/^[a-zA-Z]:[\\/]/.test(input)) return vscode.Uri.file(input)
  // Uri.file 负责文件路径编码，不能拼接 file:// 遗漏空格转义。
  if (input.startsWith("/")) return vscode.Uri.file(input)
  // 显式 scheme 保留 remote、untitled 的提供者及 authority/fragment，不能把完整定位缩成 fsPath。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return vscode.Uri.parse(input)
  // 普通相对路径继续交给 Uri.file，保持源版本对路径输入的既有解释。
  return vscode.Uri.file(input)
}

/** 将 Windows 路径改为 POSIX 正斜杠，减少 LLM 上下文中反斜杠转义的额外 token。 */
export function toPosixPath(p: string) {
  return p.replace(/\\/g, "/")
}

// quoteForSummary 仅转义短标签，不能用摘要中的转义表示替代原始源码。
export function quoteForSummary(s: string) {
  return `"${s.replace(/\n/g, "\\n")}"`
}

// max 是显示字符预算；完整源码与输出仍从原文档或 artifact 读取。
export function previewText(text: string, max = 500) {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

export function fullDocumentRange(document: vscode.TextDocument) {
  // 源码替换必须覆盖格文档的完整末端，不能借用活动编辑器的选区而残留旧源码。
  if (document.lineCount === 0) return new vscode.Range(0, 0, 0, 0)
  return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end)
}

export function documentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
}

export function extensionState(id: string) {
  const extension = vscode.extensions.getExtension(id)
  if (!extension) return "missing"
  return extension.isActive ? "active" : "installed"
}

export function extensionInfo(id: string) {
  // 只读取已公布的扩展状态与版本，不能为环境快照主动 activate 扩展并触发安装或内核副作用。
  const extension = vscode.extensions.getExtension(id)
  return extension
    ? { id: extension.id, isActive: extension.isActive, version: extension.packageJSON?.version }
    : undefined
}

export async function openJsonDocument(value: unknown) {
  const document = await vscode.workspace.openTextDocument({
    content: JSON.stringify(value, null, 2),
    language: "json",
  })
  await vscode.window.showTextDocument(document, { preview: false })
}

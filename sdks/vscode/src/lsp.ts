import * as vscode from "vscode"

// [local-smark] 给 hidden open 和本地 HTTP 返回预留 200ms，保证 OpenCode 外层 1s 总截止时间。
// 这是同一个总预算的内部切分，不是 800ms 之后再追加 1s。
const DIAGNOSTIC_TIMEOUT_MS = 800

// [local-smark] 只使用 hidden document 和 VS Code 诊断事件，不抢占用户编辑器。
// listener 必须先于 open 注册，否则快速 provider 可能在监听建立前完成首次发布。
async function collectDiagnostics(filePath: string): Promise<ReturnType<typeof formatDiag>[]> {
  const uri = vscode.Uri.file(filePath)
  return new Promise((resolve) => {
    let latest: vscode.Diagnostic[] = []
    let resolved = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (resolved) return
      resolved = true
      disposable.dispose()
      if (timer) clearTimeout(timer)
      resolve(latest.map((diagnostic) => formatDiag(diagnostic, uri.fsPath)))
    }
    const disposable = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((item) => item.toString() === uri.toString())) return
      latest = vscode.languages.getDiagnostics(uri)
      // 错误/警告等非空诊断立即返回；空结果按产品约定等到本次观察窗口结束。
      if (latest.length > 0) finish()
    })
    // deadline 只读取最新快照，不增加 quiet delay，也不会在响应后继续更新 Tool 输出。
    timer = setTimeout(finish, DIAGNOSTIC_TIMEOUT_MS)
    void vscode.workspace.openTextDocument(uri).then(
      () => {
        latest = vscode.languages.getDiagnostics(uri)
        if (latest.length > 0) finish()
      },
      () => finish(),
    )
  })
}

// [local-smark] 仅打开文档（不 showTextDocument），用于 hover/definition 等不需要诊断的操作
async function ensureOpenLight(filePath: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(filePath)
  await vscode.workspace.openTextDocument(uri)
  return uri
}

function formatRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

function formatDiag(d: vscode.Diagnostic, fsPath: string) {
  const severityMap = ["Error", "Warning", "Information", "Hint"]
  return {
    file: fsPath,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: severityMap[d.severity] ?? "Error",
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
  }
}

// [local-smark] 统一 VSCode API 返回类型：Location | Location[] | DefinitionLink[] → 标准数组
function normalizeLocations(result: unknown): Array<{ uri: string; range: ReturnType<typeof formatRange> }> {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap((item): Array<{ uri: string; range: ReturnType<typeof formatRange> }> => {
    if (!item || typeof item !== "object") return []
    if ("uri" in item && "range" in item) {
      const loc = item as vscode.Location
      return [{ uri: loc.uri.toString(), range: formatRange(loc.range) }]
    }
    if ("targetUri" in item && "targetRange" in item) {
      const link = item as vscode.DefinitionLink
      return [{ uri: link.targetUri.toString(), range: formatRange(link.targetRange) }]
    }
    return []
  })
}

function formatHover(hover: vscode.Hover) {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  const contentsStr = contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : String(c)))
  return {
    contents: contentsStr,
    ...(hover.range ? { range: formatRange(hover.range) } : {}),
  }
}

// [local-smark] touch: hidden open + request-local diagnostics observation
export async function lspTouch(args: { filePath: string }) {
  return { ok: true, diagnostics: await collectDiagnostics(args.filePath) }
}

// [local-smark] diagnostics: 只读取，不 ensureOpen，不等待（依赖之前 touch）
export async function lspDiagnostics(args: { filePath?: string }) {
  if (args.filePath) {
    const uri = vscode.Uri.file(args.filePath)
    const diags = vscode.languages.getDiagnostics(uri)
    return { diagnostics: diags.map((d) => formatDiag(d, uri.fsPath)) }
  }
  const all = vscode.languages.getDiagnostics()
  return {
    diagnostics: all.flatMap(([uri, diags]) => diags.map((d) => formatDiag(d, uri.fsPath))),
  }
}

export async function lspHover(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.Hover | vscode.Hover[] | undefined>(
    "vscode.executeHoverProvider", uri, new vscode.Position(args.line, args.character),
  )
  const hovers = result ? (Array.isArray(result) ? result : [result]) : []
  return { hovers: hovers.map(formatHover) }
}

export async function lspDefinition(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeDefinitionProvider", uri, new vscode.Position(args.line, args.character),
  )
  return { definitions: normalizeLocations(result) }
}

export async function lspReferences(args: { filePath: string; line: number; character: number }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<unknown>(
    "vscode.executeReferenceProvider", uri, new vscode.Position(args.line, args.character),
  )
  return { references: normalizeLocations(result) }
}

export async function lspDocumentSymbol(args: { filePath: string }) {
  const uri = await ensureOpenLight(args.filePath)
  const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
    "vscode.executeDocumentSymbolProvider", uri,
  )
  const symbols = result ?? []
  return {
    symbols: symbols.map((s) => {
      if ("selectionRange" in s) {
        const ds = s as vscode.DocumentSymbol
        return {
          name: ds.name, kind: ds.kind, range: formatRange(ds.range),
          selectionRange: formatRange(ds.selectionRange),
          ...(ds.detail ? { detail: ds.detail } : {}),
        }
      }
      const si = s as vscode.SymbolInformation
      return {
        name: si.name, kind: si.kind,
        location: { uri: si.location.uri.toString(), range: formatRange(si.location.range) },
        ...(si.containerName ? { containerName: si.containerName } : {}),
      }
    }),
  }
}

export async function lspWorkspaceSymbol(args: { query: string }) {
  const result = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    "vscode.executeWorkspaceSymbolProvider", args.query,
  )
  return {
    symbols: (result ?? []).slice(0, 10).map((s) => ({
      name: s.name, kind: s.kind,
      location: { uri: s.location.uri.toString(), range: formatRange(s.location.range) },
      ...(s.containerName ? { containerName: s.containerName } : {}),
    })),
  }
}

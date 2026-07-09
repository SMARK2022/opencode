import * as vscode from "vscode"

// [local-smark] showTextDocument 是触发 Pylance 等 LSP 扩展诊断计算的必需条件。
// openTextDocument 只在 VSCode 内部打开文档，不触发诊断计算。
// preview + preserveFocus 不抢占用户焦点。
async function ensureOpen(filePath: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(filePath)
  const doc = await vscode.workspace.openTextDocument(uri)
  try {
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
  } catch {
    // showTextDocument 失败时 openTextDocument 仍提供基本文档访问
  }
  return uri
}

// [local-smark] 等待 VSCode 为指定 uri 计算诊断。使用 onDidChangeDiagnostics 事件。
// 新文件约 0.5s 触发事件；已打开文件（诊断无变化）等满超时。
async function awaitDiagnosticsRefresh(uri: vscode.Uri, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      disposable.dispose()
      clearTimeout(timer)
      resolve()
    }
    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === uri.toString())) {
        setTimeout(finish, 50)
      }
    })
    const timer = setTimeout(finish, timeoutMs)
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

// [local-smark] touch: showTextDocument + awaitDiagnosticsRefresh — 触发诊断计算
export async function lspTouch(args: { filePath: string }) {
  const uri = await ensureOpen(args.filePath)
  await awaitDiagnosticsRefresh(uri)
  return { ok: true }
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

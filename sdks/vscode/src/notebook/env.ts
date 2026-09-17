/**
 * vscode_notebook_env 提供 info/configure/restart/save 环境操作。
 *
 * 运行时来源：Jupyter 稳定 API 的 api.kernels.getKernel(notebook.uri)，
 * 仅读取语言与状态，不向用户内核注入执行探针。
 *
 * 元数据来源：保存的 .ipynb 中 metadata.kernelspec / metadata.language_info。
 *
 * 未启动关联内核时报告 no-active-kernel，即使盘上 kernelspec 声明了 ML。
 * 保存的元数据不作为活动运行时的回退来源。
 */
import vscode from "vscode"
import { TextDecoder } from "node:util"
import { extensionState, extensionInfo, stringProp, quoteForSummary, uriFromInput } from "../util"
import { resolveNotebook } from "./resolve"
import { notebookHeader } from "./format"

interface KernelLike {
  readonly language: string
  // 稳定 API 的 status 可缺省，不能从 notebook 的保存状态补成 idle。
  readonly status?: string
}

type JupyterLike = {
  kernels?: {
    // 查询只能返回已启动且关联此 URI 的内核，不能为 env 报告另建一个内核。
    getKernel?(uri: vscode.Uri): Promise<KernelLike | undefined>
  }
}

type ActiveRuntime = {
  language: string
  kernelStatus: string
}

type SavedMetadata = {
  // display_name 与 name 都保留，用户标签不替代 kernelspec 的机器标识。
  kernelDisplayName: string | null
  kernelName: string | null
  language: string | null
  languageVersion: string | null
}

// selectKernel 打开内核选择器 UI 后可能无限期阻塞等待用户交互。
// 客户端 120s 超时会直接中止操作，agent 无法获得有用信息。
// 服务端在 15s 内超时并返回 selection-requested，让 agent 继续工作。
const SELECT_KERNEL_TIMEOUT_MS = 15_000
const decoder = new TextDecoder("utf-8")
const RESTART_CMD = "jupyter.restartkernel"
// 中断只停止当前格，保留内核变量；可访问性检查同样使用该扩展的公开API。
const INTERRUPT_CMD = "jupyter.interruptkernel"
const JUPYTER_ID = "ms-toolsai.jupyter"
const CONFIG_SECTION = "jupyter"
const CONFIG_KEY = "askForKernelRestart"
const SELECT_KERNEL_CMD = "notebook.selectKernel"

export async function notebookEnv(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const operation = stringProp(input, "operation") ?? "info"
  if (!["info", "configure", "restart", "save", "stop", "create"].includes(operation)) throw new Error(`Invalid operation "${operation}". Must be one of: info, configure, restart, save, stop, create.`)
  const reason = stringProp(input, "reason")
  // 创建不存在的文档必须先分流，不能走现有文档解析器。
  if (operation === "create") return await createNotebook(filePath, reason)
  const notebook = await resolveNotebook(filePath)
  // 路径无法打开时直接拒绝，不能把解析失败包装成 no-active-kernel 快照。
  switch (operation) {
    case "info":
      return await infoNotebook(notebook, reason)
    case "configure":
      return await configureNotebook(notebook, reason)
    case "restart":
      return await restartNotebookKernel(notebook, reason)
    case "save":
      return await saveNotebook(notebook, reason)
    case "stop":
      return await stopNotebookKernel(notebook, reason)
  }
}

// 未探测运行时的操作只标unknown，文档元数据不替代活动内核证据。
function envSummaryHeader(notebook: vscode.NotebookDocument, operation: "info" | "configure" | "restart" | "save" | "stop" | "create", status?: string, dirty = String(notebook.isDirty), runtime = "unknown") {
  return notebookHeader(notebook, "Env", [
    `operation=${operation}`,
    "target=notebook",
    status ? `status=${status}` : undefined,
    `dirty=${dirty}`,
    `runtime=${quoteForSummary(runtime)}`,
  ])
}

async function infoNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const activeRuntime = await getActiveRuntime(notebook.uri)
  const savedMetadata = await readSavedNotebookMetadata(notebook.uri)

  return {
    ran: false,
    summary: [
      // 头部复用本次活动内核探测结果，无内核时不回退到kernelspec。
      ...envSummaryHeader(notebook, "info", undefined, String(notebook.isDirty), activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"),
      `Notebook runtime: ${activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter" )}.`,
      `Notebook saved metadata: ${formatSavedMetadata(savedMetadata)}.`,
      activeRuntime
        ? "运行时来源：公开API可见的活动内核状态。"
        : "运行时来源：无；Jupyter 稳定 API 仅暴露至少执行过一个代码格后启动的内核。",
      reason ? `Reason: ${reason}` : undefined,
    ].filter(Boolean).join("\n"),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      operation: "info",
      reason,
      runtime: activeRuntime,
      saved_metadata: savedMetadata,
      // active_notebook 只记录 UI 焦点；路径解析失败或焦点指向别的文档时，不能拿它补齐本次目标的 runtime。
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo("ms-toolsai.jupyter"),
      },
    },
  }
}

async function configureNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()
  const notebookMeta = {
    uri: notebook.uri.toString(),
    cellCount: notebook.cellCount,
    notebookType: notebook.notebookType,
    isUntitled: notebook.isUntitled,
    isClosed: notebook.isClosed,
    metadataKernelSpec: (notebook.metadata as { kernelspec?: unknown }).kernelspec ?? null,
  }
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter")
  if (!jupyter) {
    return configureResult({
      notebook,
      path: primaryPath,
      reason,
      status: "failed",
      summary: "Jupyter extension is not installed. Install ms-toolsai.jupyter first.",
      data: { notebook: notebookMeta, jupyter: { found: false, active: false }, durationMs: Date.now() - startedAt },
    })
  }
  const jupActivateStart = Date.now()
  if (!jupyter.isActive) await jupyter.activate()
  const jupyterInfo = { ...extensionInfo("ms-toolsai.jupyter"), activationDurationMs: Date.now() - jupActivateStart }
  const pythonHeuristic = isPythonNotebookLike(notebook)
  const python = vscode.extensions.getExtension("ms-python.python")
  const pyActivateStart = Date.now()
  const pythonActivationError = pythonHeuristic.result && python && !python.isActive
    ? await Promise.resolve(python.activate()).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
    : undefined
  const pythonInfo = {
    ...extensionInfo("ms-python.python"),
    isPythonLike: pythonHeuristic.result,
    heuristic: pythonHeuristic.heuristic,
    activationError: pythonActivationError,
    activationDurationMs: Date.now() - pyActivateStart,
  }
  const visStart = Date.now()
  let showNotebookSucceeded = false
  try {
    await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false })
    showNotebookSucceeded = true
  } catch {
    // 显示失败不阻止已打开文档按 URI 选核。
  }
  const visibility = {
    showNotebookSucceeded,
    showNotebookDurationMs: Date.now() - visStart,
    visibleEditorCount: vscode.window.visibleNotebookEditors.length,
    activeNotebookUri: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
    targetNotebookActive: vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString(),
  }
  const preCheck = await probeConfigureRuntime(notebook.uri)
  if (preCheck.configured) {
    return configureResult({
      notebook,
      path: primaryPath,
      reason,
      status: "configured",
      summary: "Notebook already has an active kernel.",
      data: { notebook: notebookMeta, jupyter: jupyterInfo, python: pythonInfo, visibility, preCheck, durationMs: Date.now() - startedAt },
    })
  }
  const cmdStart = Date.now()
  const commandsPublic = await vscode.commands.getCommands(true)
  const commandsAll = await vscode.commands.getCommands(false)
  const commandInfo = {
    selectKernelListedPublic: commandsPublic.includes(SELECT_KERNEL_CMD),
    selectKernelListedAll: commandsAll.includes(SELECT_KERNEL_CMD),
    restartKernelListed: commandsAll.includes(RESTART_CMD),
    notebookCellExecuteListed: commandsAll.includes("notebook.cell.execute"),
    discoveryDurationMs: Date.now() - cmdStart,
  }
  const selStart = Date.now()
  // 命令列表只作诊断，是否接受或取消以实际调用结果为准。
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const selection = await Promise.race([
    Promise.resolve(vscode.commands.executeCommand(SELECT_KERNEL_CMD, {
      notebookUri: notebook.uri,
      skipIfAlreadySelected: true,
    })).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise<{ result: undefined; error: undefined }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ result: undefined, error: undefined }), SELECT_KERNEL_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  })
  const selectKernelInfo = {
    invoked: selection.error === undefined,
    result: selection.result,
    accepted: selection.result === true,
    rejectedOrCancelled: selection.result === false,
    error: selection.error,
    durationMs: Date.now() - selStart,
  }
  // 只探测一次；选核接受后尚未启动是正常状态，不能轮询等待首格执行。
  const postProbe = await probeConfigureRuntime(notebook.uri)
  const status = postProbe.configured
    ? "configured"
    : selection.result === true
      ? "selected"
      : selection.result === false
        ? "needs-selection"
        : selection.error !== undefined
          ? "failed"
          : "selection-requested"
  return configureResult({
    notebook,
    path: primaryPath,
    reason,
    status,
    summary: selection.error !== undefined ? `Kernel selection command failed: ${selection.error}.` : selection.result === undefined ? "Kernel selection was invoked without a confirmed command result." : "Kernel selection command completed.",
    data: {
      notebook: notebookMeta,
      jupyter: jupyterInfo,
      python: pythonInfo,
      visibility,
      probe: { preCheck, postSelect: postProbe },
      commands: { ...commandInfo, selectKernelExecuteSucceeded: selection.result === true },
      selectKernel: selectKernelInfo,
      durationMs: Date.now() - startedAt,
    },
  })
}

function configureResult(input: {
  notebook: vscode.NotebookDocument
  path: string
  reason?: string
  status: "configured" | "selected" | "needs-selection" | "selection-requested" | "failed"
  summary: string
  data: Record<string, unknown>
}) {
  const guidance = {
    configured: "Notebook is ready for cell execution.",
    selected: "Kernel selection was accepted. Proceed to run cells; the kernel will start on first execution.",
    "needs-selection": "No kernel was selected or accepted. Select a kernel manually from the notebook toolbar, then call configure to verify.",
    "selection-requested": "The kernel picker may still be open or the command returned no explicit result. Select a kernel manually from the notebook toolbar, then call configure to verify.",
    failed: "Check Jupyter/Python extensions and workspace trust.",
  }[input.status]
  return {
    ran: true,
    summary: [...envSummaryHeader(input.notebook, "configure", input.status), input.summary, guidance, input.reason ? `Reason: ${input.reason}` : undefined].filter(Boolean).join("\n"),
    data: { path: input.path, operation: "configure", reason: input.reason, status: input.status, ...input.data },
  }
}

async function probeConfigureRuntime(uri: vscode.Uri) {
  const startedAt = Date.now()
  const runtime = await getActiveRuntime(uri)
  // 读取失败原样传播；可见性代表已关联内核，冷启动仍由首格原生命令负责。
  const configured = runtime !== null
  return {
    hasKernel: Boolean(runtime),
    configured,
    kernelLanguage: runtime?.language,
    kernelStatus: runtime?.kernelStatus,
    elapsedMs: Date.now() - startedAt,
  }
}

function isPythonNotebookLike(notebook: vscode.NotebookDocument) {
  if (notebook.getCells().some((cell) => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === "python")) {
    return { result: true, heuristic: "cells" } as const
  }
  const meta = notebook.metadata as {
    kernelspec?: { language?: string; name?: string }
    language_info?: { name?: string }
  }
  const language = meta.language_info?.name ?? meta.kernelspec?.language ?? meta.kernelspec?.name
  return typeof language === "string" && language.toLowerCase().includes("python")
    ? { result: true, heuristic: "metadata" } as const
    : { result: false, heuristic: "none" } as const
}

async function restartNotebookKernel(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter")
  if (!jupyter) {
    return { ran: true, summary: [...envSummaryHeader(notebook, "restart", "failed"), "Jupyter extension is not installed. Install ms-toolsai.jupyter and select a kernel first."].join("\n"), data: { path: primaryPath, operation: "restart", reason, jupyterFound: false, durationMs: Date.now() - startedAt } }
  }
  if (!jupyter.isActive) await jupyter.activate()
  // Jupyter 可注册隐藏命令，查询面必须包含 executeCommand 能调用的完整列表。
  const allCommands = await vscode.commands.getCommands(false)
  if (!allCommands.includes(RESTART_CMD)) {
    return { ran: true, summary: [...envSummaryHeader(notebook, "restart", "failed"), "jupyter.restartkernel command is not registered."].join("\n"), data: { path: primaryPath, operation: "restart", reason, jupyterFound: true, jupyterActive: jupyter.isActive, restartCommandFound: false, durationMs: Date.now() - startedAt } }
  }
  // effective值可能来自文档作用域，写回Global既不能恢复原作用域，也会覆盖并发修改。
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, notebook.uri)
  const original = config.get<boolean>(CONFIG_KEY)
  // 尊重用户确认策略，不代答或暂时改写设置；显式请求未发送。
  if (original === true) {
    return {
      ran: false,
      summary: [...envSummaryHeader(notebook, "restart", "confirmation-required"), "Jupyter requires restart confirmation; no restart was requested and no settings were changed."].join("\n"),
      data: { path: primaryPath, operation: "restart", requested: false, verified: false, reason },
    }
  }
  try {
    // Jupyter 命令内部可能吞错，返回值只表示 requested。
    await vscode.commands.executeCommand(RESTART_CMD, { notebookEditor: { notebookUri: notebook.uri } })
    return {
      ran: true,
      summary: [...envSummaryHeader(notebook, "restart", "requested"), "Kernel restart requested; completion and state clearing have not been verified.", "Rerun setup or import cells before running dependent cells.", reason ? `Reason: ${reason}` : undefined].filter(Boolean).join("\n"),
      data: {
        path: primaryPath, operation: "restart", reason, requested: true,
        askForKernelRestartOriginal: original,
        // 可访问的旧内核不能证明已完成重启，保留requested而不虚报verified。
        verified: false,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ran: true, summary: [...envSummaryHeader(notebook, "restart", "failed"), `Kernel restart invocation failed: ${message}.`].join("\n"), data: { path: primaryPath, operation: "restart", reason, error: message, durationMs: Date.now() - startedAt } }
  }
}

// ===========================================================================
// stop — interrupt kernel, halt the currently executing cell
// ===========================================================================

// [0633] stop 不需要抑制确认弹窗：与 restart 不同，interrupt 是即发即收操作。
async function stopNotebookKernel(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()

  // interrupt 命令与 restart 一样由 Jupyter 扩展贡献，可能隐藏在公共列表之外
  const jupyter = vscode.extensions.getExtension(JUPYTER_ID)
  if (!jupyter) {
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "stop", "failed"),
        "Jupyter extension is not installed. Install ms-toolsai.jupyter first.",
      ].join("\n"),
      data: { path: primaryPath, operation: "stop", reason, jupyterFound: false, durationMs: Date.now() - startedAt },
    }
  }
  if (!jupyter.isActive) await jupyter.activate()

  const allCommands = await vscode.commands.getCommands(false)
  if (!allCommands.includes(INTERRUPT_CMD)) {
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "stop", "failed"),
        `${INTERRUPT_CMD} command is not registered. Check that the Jupyter extension is correctly installed.`,
      ].join("\n"),
      data: {
        path: primaryPath, operation: "stop", reason,
        jupyterFound: true, jupyterActive: jupyter.isActive,
        interruptCommandFound: false,
        requested: false,
        durationMs: Date.now() - startedAt,
      },
    }
  }

  // interrupt 不需要抑制确认弹窗（与 restart 不同，restart 需要抑制 askForKernelRestart）
  try {
    await vscode.commands.executeCommand(INTERRUPT_CMD, {
      notebookEditor: { notebookUri: notebook.uri },
    })

    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "stop", "requested"),
        "Kernel interrupt requested. The currently executing cell should stop.",
        // 无 kernel 运行时 interrupt 无害，但仍返回 requested 让 agent 知道操作已执行
        "If no cell was running, this operation is harmless.",
        "Use vscode_notebook_env operation=info to verify kernel status.",
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        path: primaryPath, operation: "stop", reason,
        requested: true,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "stop", "failed"),
        `Kernel interrupt failed: ${message}.`,
      ].join("\n"),
      data: { path: primaryPath, operation: "stop", reason, error: message, durationMs: Date.now() - startedAt },
    }
  }
}

// ===========================================================================
// create — create a new empty notebook file on disk
// ===========================================================================

async function createNotebook(filePath: string, reason?: string) {
  const uri = uriFromInput(filePath)
  const startedAt = Date.now()

  // 先检查 VS Code 是否已打开此 notebook（包括未保存的 untitled notebook）
  const existing = vscode.workspace.notebookDocuments.find(
    (nb) => nb.uri.fsPath === filePath || nb.uri.toString() === filePath,
  )
  if (existing) {
    return {
      ran: true,
      summary: [
        ...notebookHeader(existing, "Env", [`operation=create`, `status=already-exists`, `cells=${existing.cellCount}`]),
        `Notebook already exists and is open in VS Code. Use vscode_notebook_summary to inspect it.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: { path: filePath, operation: "create", created: false, alreadyExists: true, cellCount: existing.cellCount, durationMs: Date.now() - startedAt },
    }
  }

  // 再检查磁盘是否已存在（包括未在 VS Code 中打开的文件），防止静默覆盖用户数据
  try {
    await vscode.workspace.fs.stat(uri)
    return {
      ran: true,
      summary: [
        `Notebook: ${filePath}`,
        `Env: operation=create status=already-exists`,
        `Notebook file already exists on disk. Use vscode_notebook_summary to inspect it.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: { path: filePath, operation: "create", created: false, alreadyExists: true, durationMs: Date.now() - startedAt },
    }
  } catch {
    // stat 抛 ENOENT 是预期行为——文件不存在，继续创建
  }

  // 创建最小 .ipynb JSON（nbformat 4.5 标准）
  const minimalNotebook = JSON.stringify({
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2)

  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(minimalNotebook))
    const notebook = await vscode.workspace.openNotebookDocument(uri)
    return {
      ran: true,
      summary: [
        ...notebookHeader(notebook, "Env", [`operation=create`, `status=created`, `cells=0`]),
        `Notebook created successfully with empty cell list.`,
        `Use vscode_notebook_edit with editType=insert to add cells, or vscode_notebook_env with operation=configure to select a kernel.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        path: filePath, operation: "create", reason,
        created: true, cellCount: 0,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch (error) {
    // writeFile/openNotebookDocument 失败（目录不存在、权限不足等）返回结构化错误
    const message = error instanceof Error ? error.message : String(error)
    return {
      ran: true,
      summary: [
        `Notebook: ${filePath}`,
        `Env: operation=create status=failed`,
        `Notebook creation failed: ${message}.`,
        `Check that the parent directory exists and is writable.`,
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: { path: filePath, operation: "create", reason, created: false, error: message, durationMs: Date.now() - startedAt },
    }
  }
}


async function saveNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()
  if (notebook.isUntitled || notebook.uri.scheme === "untitled") {
    return {
      ran: true,
      summary: [
        // 跳过保存是因为文档未命名，与内核是否存在无关。
        ...envSummaryHeader(notebook, "save", "skipped", `${notebook.isDirty}->${notebook.isDirty}`),
        "Untitled notebook cannot be saved without a target path.",
        "Use a Save As / create-file workflow first, then save the named notebook.",
        reason ? `Reason: ${reason}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      data: {
        path: primaryPath,
        operation: "save",
        reason,
        saved: false,
        skipped: true,
        beforeDirty: notebook.isDirty,
        afterDirty: notebook.isDirty,
        durationMs: Date.now() - startedAt,
      },
    }
  }

  const beforeDirty = notebook.isDirty
  const beforeVersion = notebook.version
  try {
    await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: true })
  } catch {
    // save() works for open documents without being visible
  }

  let saveReturned = false
  let saveError: string | undefined
  try {
    saveReturned = await notebook.save()
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error)
  }

  // 序列化器可能在 save() 返回后才清除 dirty。
  await waitForDirtyStateToSettle(notebook, DIRTY_SETTLE_TIMEOUT_MS)
  const afterDirty = notebook.isDirty
  const afterVersion = notebook.version
  // save() 的 false 也可能表示无需保存，以最终 dirty 状态确认。
  const saved = !afterDirty

  return {
    ran: true,
    summary: [
      // 头部复用最终dirty判定及保存前后状态，不改写保存结果。
      ...envSummaryHeader(notebook, "save", saved ? "saved" : saveError ? "error" : "not-confirmed", `${beforeDirty}->${afterDirty}`),
      `Saved: ${saved ? "yes" : saveError ? "error" : "not confirmed"}`,
      `Dirty: ${beforeDirty} -> ${afterDirty}  Version: ${beforeVersion} -> ${afterVersion}`,
      saveError ? `Save error: ${saveError}` : undefined,
      saved
        ? "Notebook persisted to disk."
        : "Notebook may still have unsaved changes. Review the dirty state before git or disk operations.",
      reason ? `Reason: ${reason}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      path: primaryPath,
      operation: "save",
      reason,
      saved,
      beforeDirty,
      afterDirty,
      beforeVersion,
      afterVersion,
      saveReturned,
      saveError,
      durationMs: Date.now() - startedAt,
    },
    note: "Save should only be called when the user explicitly requests it. Do not save ipynb files unprompted — prefer to leave dirty notebooks for user review.",
  }
}

const DIRTY_SETTLE_TIMEOUT_MS = 10_000

async function waitForDirtyStateToSettle(notebook: vscode.NotebookDocument, timeoutMs: number) {
  if (!notebook.isDirty) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose()
      resolve()
    }, timeoutMs)
    const disposable = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (!event.notebook.isDirty) {
        clearTimeout(timer)
        disposable.dispose()
        resolve()
      }
    })
  })
}

// 只读公开内核状态；不注入代码、不吞查询错误，也不从保存元数据合成运行时。
async function getActiveRuntime(uri: vscode.Uri): Promise<ActiveRuntime | null> {
  const ext = vscode.extensions.getExtension(JUPYTER_ID)
  if (!ext) return null
  const api = (ext.isActive ? ext.exports : await ext.activate()) as JupyterLike | undefined
  const kernel = await api?.kernels?.getKernel?.(uri)
  return kernel ? { language: kernel.language, kernelStatus: kernel.status ?? "unknown" } : null
}

async function readSavedNotebookMetadata(uri: vscode.Uri): Promise<SavedMetadata | null> {
  try {
    // 盘上 .ipynb 读取保留源 file-scheme 约束，不把远程 URI 的 fsPath 当本地文件。
    if (uri.scheme !== "file") return null
    const raw = decoder.decode(await vscode.workspace.fs.readFile(uri))
    const json = JSON.parse(raw) as {
      metadata?: {
        kernelspec?: { display_name?: string; name?: string; language?: string }
        language_info?: { name?: string; version?: string }
      }
    }
    const kernelspec = json.metadata?.kernelspec
    const languageInfo = json.metadata?.language_info
    // 保存的 language_info 可以缺失，kernelspec.language 只补元数据描述，不补活动运行时。
    return {
      kernelDisplayName: kernelspec?.display_name ?? null,
      kernelName: kernelspec?.name ?? null,
      language: languageInfo?.name ?? kernelspec?.language ?? null,
      languageVersion: languageInfo?.version ?? null,
    }
  } catch {
    // 无文件、无效 JSON 或读取拒绝只影响 saved_metadata，不能使已取得的内核信息消失。
    return null
  }
}

function formatActiveRuntime(runtime: ActiveRuntime) {
  return `${runtime.language} kernelStatus=${runtime.kernelStatus}`
}

function formatSavedMetadata(meta: SavedMetadata | null) {
  // unavailable 表示未取得磁盘声明，不等同于活动内核不存在。
  if (!meta) return "unavailable"
  const kernel = meta.kernelDisplayName ?? meta.kernelName ?? "unknown"
  const language = meta.languageVersion
    ? `${meta.language ?? "unknown"} ${meta.languageVersion}`
    : meta.language ?? "unknown"
  return `${kernel} (${language}), kernelspec.name=${meta.kernelName ?? "unknown"}`
}

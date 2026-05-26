/**
 * `vscode_notebook_env` — notebook environment operations.
 *
 * Single tool with four operations selected via the `operation` field:
 *   "info"        — kernel / interpreter / saved metadata snapshot
 *   "configure"   — open notebook + trigger kernel selection
 *   "restart"     — restart Jupyter kernel, clear all runtime state
 *   "save"        — persist notebook document to disk
 *
 * All operations accept an optional `reason` string briefly shown to the user.
 *
 * Info probes the active Jupyter kernel via the stable public API
 * (api.kernels.getKernel + executeCode). Saved .ipynb metadata is reported
 * separately and is not treated as the active runtime.
 *
 * Configure probes the Jupyter public API (api.kernels.getKernel + executeCode)
 * before and after kernel selection to confirm readiness. A single probe after
 * notebook.selectKernel is sufficient — polling cannot detect a kernel that
 * only starts on first code-cell execution.
 *
 * Statuses:
 *   configured          — active kernel confirmed via executeCode probe
 *   selected            — selectKernel returned true, kernel not yet active
 *                          (expected before first code-cell execution)
 *   needs-selection     — selectKernel returned false or did not run;
 *                          user likely cancelled or no kernel accepted
 *   selection-requested — command ran but returned no clear boolean result
 *   failed              — extension missing or command threw an error
 *
 * Returns diagnostic data for each flow node: notebook metadata, extension
 * state, visibility, pre-/post-selection kernel probes, and poll results.
 *
 * Restart temporarily disables jupyter.askForKernelRestart to suppress the
 * Jupyter confirmation modal, calls the public jupyter.restartkernel command,
 * then restores the original setting.
 *
 * Save persists the notebook via NotebookDocument.save(). Since save() returns
 * false for both "not dirty" and "genuine failure", success is determined by
 * comparing before/after dirty state. Untitled notebooks are skipped.
 */
import * as vscode from "vscode"
import { TextDecoder } from "node:util"
import { extensionState, extensionInfo, stringProp, quoteForSummary } from "../util"
import { resolveNotebook } from "./resolve"
import { notebookHeader, runtimeLabel } from "./format"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KernelOutputItem = { mime: string; data: Uint8Array }
type KernelOutput = { items: KernelOutputItem[] }

interface KernelLike {
  readonly language: string
  readonly status?: string
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<KernelOutput>
}

type JupyterLike = {
  kernels?: {
    getKernel?(uri: vscode.Uri): Promise<KernelLike | undefined>
  }
}

type ActiveRuntime = {
  language: string
  kernelStatus: string
  python?: {
    version: string | null
    executable: string | null
    prefix: string | null
    basePrefix: string | null
    condaDefaultEnv: string | null
    virtualEnv: string | null
    envName: string | null
    platform: string | null
  }
}

type SavedMetadata = {
  kernelDisplayName: string | null
  kernelName: string | null
  language: string | null
  languageVersion: string | null
}

type Operation = "info" | "configure" | "restart" | "save"

type ConfigureStatus = "configured" | "selected" | "needs-selection" | "selection-requested" | "failed"

type ConfigureProbe = {
  hasKernel: boolean
  configured: boolean
  kernelLanguage?: string
  kernelStatus?: string
  probeSucceeded?: boolean
  probeError?: string
  probeDurationMs?: number
  elapsedMs: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUPYTER_ID = "ms-toolsai.jupyter"
const PYTHON_ID = "ms-python.python"
const RESTART_CMD = "jupyter.restartkernel"
const CONFIG_SECTION = "jupyter"
const CONFIG_KEY = "askForKernelRestart"
const PROBE_TIMEOUT_MS = 30_000
const DIRTY_SETTLE_TIMEOUT_MS = 10_000
const decoder = new TextDecoder("utf-8")

// ---------------------------------------------------------------------------
// Main entry — dispatched by operation
// ---------------------------------------------------------------------------

export async function notebookEnv(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")

  const operation = stringProp(input, "operation") ?? "info"
  if (!["info", "configure", "restart", "save"].includes(operation)) {
    throw new Error(
      `Invalid operation "${operation}". Must be one of: info, configure, restart, save.`,
    )
  }

  const notebook = await resolveNotebook(filePath)
  const reason = stringProp(input, "reason")

  switch (operation as Operation) {
    case "info":
      return await probeNotebookEnv(notebook, reason)
    case "configure":
      return await configureNotebook(notebook, reason)
    case "restart":
      return await restartNotebookKernel(notebook, reason)
    case "save":
      return await saveNotebook(notebook, reason)
  }
}

function envSummaryHeader(notebook: vscode.NotebookDocument, operation: Operation, status?: string, dirty = String(notebook.isDirty), runtime = runtimeLabel(notebook) ?? "unknown") {
  // Env operations all target notebook-level state rather than a cell. Keeping
  // target/dirty/runtime in the shared second line prevents failure branches
  // from losing the context needed for the model's next tool decision.
  return notebookHeader(notebook, "Env", [
    `operation=${operation}`,
    "target=notebook",
    status ? `status=${status}` : undefined,
    `dirty=${dirty}`,
    `runtime=${quoteForSummary(runtime)}`,
  ])
}

// ===========================================================================
// info — kernel / interpreter / metadata snapshot
// ===========================================================================

async function probeNotebookEnv(notebook: vscode.NotebookDocument, reason?: string) {
  const activeRuntime = await getActiveRuntime(notebook.uri)
  const savedMetadata = await readSavedNotebookMetadata(notebook.uri)
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()

  return {
    ran: false,
    summary: [
      ...envSummaryHeader(notebook, "info", undefined, String(notebook.isDirty), activeRuntime ? formatActiveRuntime(activeRuntime) : runtimeLabel(notebook) ?? "unknown"),
      `Notebook runtime: ${activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"}`,
      `Python/Jupyter extensions: ${extensionState(PYTHON_ID)}/${extensionState(JUPYTER_ID)}.`,
      `Notebook saved metadata: ${formatSavedMetadata(savedMetadata)}.`,
      activeRuntime
        ? "Runtime source: active kernel (api.kernels.getKernel + executeCode probe)."
        : "Runtime source: none. Jupyter public API only exposes kernels that have been started by executing at least one code cell.",
      activeRuntime?.python?.executable ? `Python executable: ${activeRuntime.python.executable}` : undefined,
      reason ? `Reason: ${reason}` : undefined,
    ].filter(Boolean).join("\n"),
    data: {
      path: primaryPath,
      operation: "info",
      reason,
      runtime: activeRuntime,
      saved_metadata: savedMetadata,
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo(PYTHON_ID),
        jupyter: extensionInfo(JUPYTER_ID),
      },
    },
    note:
      "Runtime is probed from the active kernel process; saved metadata is reported separately and is not treated as runtime fallback.",
  }
}

// ===========================================================================
// configure — verify / select / start kernel with full diagnostic output
// ===========================================================================

async function configureNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()

  // ---- node 1: notebook metadata ----
  const notebookMeta = {
    uri: notebook.uri.toString(),
    cellCount: notebook.cellCount,
    notebookType: notebook.notebookType,
    isUntitled: notebook.isUntitled,
    isClosed: notebook.isClosed,
    metadataKernelSpec: (notebook.metadata as { kernelspec?: unknown })?.kernelspec ?? null,
  }

  // ---- node 2: Jupyter extension ----
  const jupyter = vscode.extensions.getExtension(JUPYTER_ID)
  if (!jupyter) {
    return configureResult({
      notebook,
      path: primaryPath,
      reason,
      status: "failed",
      summary: "Jupyter extension is not installed. Install ms-toolsai.jupyter first.",
      data: {
        notebook: notebookMeta,
        jupyter: { found: false, active: false },
        durationMs: Date.now() - startedAt,
      },
    })
  }

  const jupActivateStart = Date.now()
  if (!jupyter.isActive) await jupyter.activate()
  const jupyterInfo = {
    found: true,
    active: jupyter.isActive,
    version: (jupyter.packageJSON as { version?: string })?.version,
    activationDurationMs: Date.now() - jupActivateStart,
  }

  // ---- node 3: Python extension (best-effort, non-fatal) ----
  const pythonHeuristic = isPythonNotebookLike(notebook)
  const python = vscode.extensions.getExtension(PYTHON_ID)
  let pythonInfo: Record<string, unknown> = { isPythonLike: pythonHeuristic.result, heuristic: pythonHeuristic.heuristic, found: false, active: false }

  if (pythonHeuristic.result && python) {
    const pyActivateStart = Date.now()
    try {
      if (!python.isActive) await python.activate()
      pythonInfo = {
        isPythonLike: pythonHeuristic.result,
        heuristic: pythonHeuristic.heuristic,
        found: true,
        active: python.isActive,
        version: (python.packageJSON as { version?: string })?.version,
        activationDurationMs: Date.now() - pyActivateStart,
      }
    } catch (error) {
      pythonInfo = {
        ...pythonInfo,
        found: true,
        activationError: error instanceof Error ? error.message : String(error),
        activationDurationMs: Date.now() - pyActivateStart,
      }
    }
  }

  // ---- node 4: show notebook ----
  const visStart = Date.now()
  let showNotebookSucceeded = false
  try {
    await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false })
    showNotebookSucceeded = true
  } catch {
    // non-fatal
  }
  const visibility = {
    showNotebookSucceeded,
    showNotebookDurationMs: Date.now() - visStart,
    visibleEditorCount: vscode.window.visibleNotebookEditors.length,
    activeNotebookUri: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
    targetNotebookActive: vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString(),
  }

  // ---- node 5: pre-check — probe kernel readiness ----
  const preCheck = await probeConfigureRuntime(notebook.uri, "preCheck")

  if (preCheck.configured) {
    return configureResult({
      notebook,
      path: primaryPath,
      reason,
      status: "configured",
      summary: "Notebook already has an active kernel — runtime probe via executeCode succeeded.",
      data: {
        notebook: notebookMeta,
        jupyter: jupyterInfo,
        python: pythonInfo,
        visibility,
        preCheck,
        commands: null as unknown,
        selectKernel: null as unknown,
        poll: null as unknown,
        durationMs: Date.now() - startedAt,
      },
    })
  }

  // ---- node 6: command discovery (diagnostic, not gating) ----
  const cmdStart = Date.now()
  const commandsPublic = await vscode.commands.getCommands(true)
  const commandsAll = await vscode.commands.getCommands(false)
  const commandInfo = {
    selectKernelListedPublic: commandsPublic.includes("notebook.selectKernel"),
    selectKernelListedAll: commandsAll.includes("notebook.selectKernel"),
    selectKernelExecuteSucceeded: false as boolean,
    restartKernelListed: commandsAll.includes(RESTART_CMD),
    notebookCellExecuteListed: commandsAll.includes("notebook.cell.execute"),
    discoveryDurationMs: Date.now() - cmdStart,
  }

  // ---- node 7: try notebook.selectKernel directly ----
  const selStart = Date.now()
  let selectKernelInvoked = false
  let selectKernelResult: unknown = undefined
  let selectKernelError: string | undefined

  try {
    selectKernelResult = await vscode.commands.executeCommand("notebook.selectKernel", {
      notebookUri: notebook.uri,
      skipIfAlreadySelected: true,
    })
    selectKernelInvoked = true
  } catch (error) {
    selectKernelError = error instanceof Error ? error.message : String(error)
  }

  const selectKernelAccepted = selectKernelResult === true
  const selectKernelRejected = selectKernelResult === false

  const selectKernelInfo = {
    invoked: selectKernelInvoked,
    result: selectKernelResult,
    accepted: selectKernelAccepted,
    rejectedOrCancelled: selectKernelRejected,
    resultKind: selectKernelAccepted
      ? "accepted"
      : selectKernelRejected
        ? "cancelled-or-not-selected"
        : selectKernelError
          ? "error"
          : selectKernelInvoked
            ? "unknown"
            : "not-invoked",
    error: selectKernelError,
    durationMs: Date.now() - selStart,
  }

  // ---- node 8: single post-selection probe (not a poll — kernel appears
  //      only on first cell execution, not after select alone) ----
  const postProbe = await probeConfigureRuntime(notebook.uri, "post-select")

  // Pair pre/post probes for diagnostic comparison
  const pairedProbe = {
    preCheck: {
      hasKernel: preCheck.hasKernel,
      configured: preCheck.configured,
      kernelLanguage: preCheck.kernelLanguage,
      kernelStatus: preCheck.kernelStatus,
      probeDurationMs: preCheck.probeDurationMs,
    },
    postSelect: {
      hasKernel: postProbe.hasKernel,
      configured: postProbe.configured,
      kernelLanguage: postProbe.kernelLanguage,
      kernelStatus: postProbe.kernelStatus,
      probeSucceeded: postProbe.probeSucceeded,
      probeError: postProbe.probeError,
      probeDurationMs: postProbe.probeDurationMs,
    },
  }

  // Backfill execute success into commandInfo
  commandInfo.selectKernelExecuteSucceeded = selectKernelAccepted

  // ---- node 9: status determination ----
  const { status, statusSummary } = resolveConfigureStatus(
    postProbe.configured,
    selectKernelInvoked,
    selectKernelAccepted,
    selectKernelRejected,
    selectKernelError,
  )

  // ---- node 10: construct response ----
  return configureResult({
    notebook,
    path: primaryPath,
    reason,
    status,
    summary: statusSummary,
    data: {
      notebook: notebookMeta,
      jupyter: jupyterInfo,
      python: pythonInfo,
      visibility,
      probe: pairedProbe,
      commands: commandInfo,
      selectKernel: selectKernelInfo,
      durationMs: Date.now() - startedAt,
    },
  })
}

// ---------------------------------------------------------------------------
// configure helpers
// ---------------------------------------------------------------------------

/**
 * Determines configure status from selectKernel outcome + post-selection probe.
 * The boolean value of selectKernelResult is the key discriminator:
 *   result=true  → selection was accepted (but kernel may not be active yet)
 *   result=false → selection was rejected, likely user cancellation
 */
function resolveConfigureStatus(
  postProbeConfigured: boolean,
  selectKernelInvoked: boolean,
  selectKernelAccepted: boolean,
  selectKernelRejected: boolean,
  selectKernelError?: string,
): { status: ConfigureStatus; statusSummary: string } {
  if (postProbeConfigured) {
    return {
      status: "configured",
      statusSummary: "Kernel is active — runtime probe via executeCode succeeded after selection.",
    }
  }

  if (selectKernelAccepted) {
    return {
      status: "selected",
      statusSummary: [
        "Kernel selection was accepted.",
        "The kernel will start on the first code-cell execution — no active kernel is visible through the public Jupyter API yet, which is expected.",
      ].join(" "),
    }
  }

  if (selectKernelRejected) {
    return {
      status: "needs-selection",
      statusSummary: [
        "Kernel selection was invoked, but no kernel was selected or accepted.",
        "The user may have cancelled the kernel picker or not chosen an environment.",
      ].join(" "),
    }
  }

  if (selectKernelError) {
    return {
      status: "failed",
      statusSummary: `Kernel selection command failed: ${selectKernelError}.`,
    }
  }

  if (selectKernelInvoked) {
    return {
      status: "selection-requested",
      statusSummary: [
        "Kernel selection command completed without an explicit boolean result.",
        "No active kernel was confirmed. Retry configure or select a kernel manually.",
      ].join(" "),
    }
  }

  return {
    status: "needs-selection",
    statusSummary: "Kernel selection could not be invoked automatically. Select a kernel manually from the notebook toolbar.",
  }
}

function configureResult(input: {
  notebook: vscode.NotebookDocument
  path: string
  reason?: string
  status: ConfigureStatus
  summary: string
  data: Record<string, unknown>
}) {
  const guidance = input.status === "configured"
    ? "Notebook is ready for cell execution."
    : input.status === "selected"
      ? "Proceed to run cells — the kernel will start on first execution."
      : input.status === "needs-selection"
        ? "Select a kernel manually from the notebook toolbar, then call configure to verify."
        : input.status === "selection-requested"
          ? "Retry configure or select a kernel manually."
          : "Check Jupyter/Python extensions and workspace trust."

  return {
    ran: true,
    summary: [
      ...envSummaryHeader(input.notebook, "configure", input.status),
      input.summary,
      guidance,
      input.reason ? `Reason: ${input.reason}` : "",
    ].filter(Boolean).join("\n"),
    data: {
      path: input.path,
      operation: "configure",
      reason: input.reason,
      status: input.status,
      ...input.data,
    },
    note:
      "Public-API configure. Uses api.kernels.getKernel + executeCode to confirm kernel readiness. Cannot access Jupyter internal controllerRegistration/kernelProvider.",
  }
}

/**
 * Probes kernel readiness through the Jupyter public API.
 * Uses getActiveRuntime which calls api.kernels.getKernel + optional executeCode.
 */
async function probeConfigureRuntime(uri: vscode.Uri, label?: string): Promise<ConfigureProbe> {
  const startedAt = Date.now()
  const result: ConfigureProbe = { hasKernel: false, configured: false, elapsedMs: 0 }

  try {
    const runtime = await getActiveRuntime(uri)
    result.elapsedMs = Date.now() - startedAt
    result.probeDurationMs = result.elapsedMs

    if (!runtime) {
      result.hasKernel = false
      return result
    }

    result.hasKernel = true
    result.kernelLanguage = runtime.language
    result.kernelStatus = runtime.kernelStatus
    result.probeSucceeded = true
    result.configured = true
  } catch (error) {
    result.elapsedMs = Date.now() - startedAt
    result.probeDurationMs = result.elapsedMs
    result.probeError = error instanceof Error ? error.message : String(error)
  }

  void label // caller may inject a label for diagnostic tracing
  return result
}

/** Detects whether a notebook is Python-like from cell language and metadata. */
function isPythonNotebookLike(notebook: vscode.NotebookDocument) {
  // Heuristic 1: any code cell with languageId "python"
  if (notebook.getCells().some(
    (c) => c.kind === vscode.NotebookCellKind.Code && c.document.languageId === "python",
  )) {
    return { result: true, heuristic: "cells" } as const
  }

  // Heuristic 2: metadata.kernelspec / language_info mentions "python"
  const meta = notebook.metadata as Record<string, unknown>
  const kernelspec = (meta as Record<string, unknown>)?.kernelspec as { language?: string; name?: string } | undefined
  const langInfo = (meta as Record<string, unknown>)?.language_info as { name?: string } | undefined
  const lang = langInfo?.name ?? kernelspec?.language ?? kernelspec?.name

  if (typeof lang === "string" && lang.toLowerCase().includes("python")) {
    return { result: true, heuristic: "metadata" } as const
  }

  return { result: false, heuristic: "none" } as const
}

// ===========================================================================
// restart — restart Jupyter kernel, clear all runtime state
// ===========================================================================

async function restartNotebookKernel(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()

  // Ensure Jupyter extension is active
  const jupyter = vscode.extensions.getExtension(JUPYTER_ID)
  if (!jupyter) {
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "restart", "failed"),
        "Jupyter extension is not installed. Install ms-toolsai.jupyter and select a kernel first.",
      ].join("\n"),
      data: { path: primaryPath, operation: "restart", reason, jupyterFound: false, durationMs: Date.now() - startedAt },
    }
  }
  if (!jupyter.isActive) await jupyter.activate()

  // Ensure the public restart command is registered
  const allCommands = await vscode.commands.getCommands(true)
  if (!allCommands.includes(RESTART_CMD)) {
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "restart", "failed"),
        "jupyter.restartkernel command is not registered. Check that the Jupyter extension is correctly installed.",
      ].join("\n"),
      data: {
        path: primaryPath,
        operation: "restart",
        reason,
        jupyterFound: true,
        jupyterActive: jupyter.isActive,
        restartCommandFound: false,
        durationMs: Date.now() - startedAt,
      },
    }
  }

  // Temporarily suppress Jupyter's built-in restart confirmation modal.
  // The public command internally reads jupyter.askForKernelRestart via
  // shouldAskForRestart(); setting it to false skips the modal.
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION)
  const original = config.get<boolean>(CONFIG_KEY)
  const needsRestore = original === true

  if (needsRestore) {
    await config.update(CONFIG_KEY, false, vscode.ConfigurationTarget.Global)
  }

  try {
    // The public command swallows errors internally (`.catch(noop)`), so
    // this invocation will not reject on kernel-level failures.
    await vscode.commands.executeCommand(RESTART_CMD, {
      notebookEditor: { notebookUri: notebook.uri },
    })

    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "restart", "requested"),
        "Kernel restart requested. All runtime state from previous cell executions should be cleared.",
        "Rerun setup or import cells before running dependent cells.",
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        path: primaryPath,
        operation: "restart",
        reason,
        requested: true,
        askForKernelRestartOriginal: original,
        askForKernelRestartSuppressed: needsRestore,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "restart", "failed"),
        `Kernel restart invocation failed: ${message}.`,
      ].join("\n"),
      data: { path: primaryPath, operation: "restart", reason, error: message, durationMs: Date.now() - startedAt },
    }
  } finally {
    // Restore the user's original setting so no permanent change is left behind
    if (needsRestore) {
      await config.update(CONFIG_KEY, original, vscode.ConfigurationTarget.Global)
    }
  }
}

// ===========================================================================
// save — persist notebook document to disk
// ===========================================================================

async function saveNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()

  // Untitled notebooks have no stable file path — skip without attempting save
  if (notebook.isUntitled || notebook.uri.scheme === "untitled") {
    return {
      ran: true,
      summary: [
        ...envSummaryHeader(notebook, "save", "skipped", `${notebook.isDirty}->${notebook.isDirty}`),
        "Saved: skipped — notebook is untitled and has no stable file path.",
        "Use a Save As / create-file workflow first, then save the named notebook.",
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
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

  // Make the target notebook visible (non-fatal)
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

  // Allow the dirty flag to settle — remote/large notebook serializers
  // may update the dirty state asynchronously after save() resolves
  await waitForDirtyStateToSettle(notebook, DIRTY_SETTLE_TIMEOUT_MS)

  const afterDirty = notebook.isDirty
  const afterVersion = notebook.version

  // save() returns false for both "not dirty" and "genuine failure", so
  // confirm success by checking that afterDirty is false
  const saved = !afterDirty

  return {
    ran: true,
    summary: [
      ...envSummaryHeader(notebook, "save", saved ? "saved" : saveError ? "error" : "not-confirmed", `${beforeDirty}->${afterDirty}`),
      `Saved: ${saved ? "yes" : saveError ? "error" : "not confirmed"}`,
      `Dirty: ${beforeDirty} -> ${afterDirty}  Version: ${beforeVersion} -> ${afterVersion}`,
      saveError ? `Save error: ${saveError}` : undefined,
      saved
        ? "Notebook persisted to disk. Git and disk operations will see the latest content."
        : "Notebook may still have unsaved changes. Review the dirty state before git or disk operations.",
      reason ? `Reason: ${reason}` : "",
    ].filter(Boolean).join("\n"),
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
    note:
      "Save should only be called when the user explicitly requests it. Do not save ipynb files unprompted — prefer to let the user review changes and save manually.",
  }
}

/**
 * Waits for the notebook's dirty bit to clear (up to timeoutMs).
 * Some notebook serializers update dirty state asynchronously after save().
 */
async function waitForDirtyStateToSettle(notebook: vscode.NotebookDocument, timeoutMs: number) {
  if (!notebook.isDirty) return

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose()
      resolve()
    }, timeoutMs)

    const sub = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (!event.notebook.isDirty) {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      }
    })
  })
}

// ===========================================================================
// info helpers — active runtime probe + metadata readers
// ===========================================================================

async function getActiveRuntime(uri: vscode.Uri): Promise<ActiveRuntime | null> {
  try {
    const ext = vscode.extensions.getExtension(JUPYTER_ID)
    if (!ext) return null

    const api = (ext.isActive ? ext.exports : await ext.activate()) as JupyterLike | undefined
    const kernel = await api?.kernels?.getKernel?.(uri)
    if (!kernel) return null

    const base: ActiveRuntime = {
      language: kernel.language,
      kernelStatus: kernel.status ?? "unknown",
    }

    if (kernel.language.toLowerCase() !== "python") return base

    const python = await probePythonRuntime(kernel).catch(() => null)
    return python ? { ...base, python } : base
  } catch {
    return null
  }
}

async function probePythonRuntime(kernel: KernelLike): Promise<ActiveRuntime["python"]> {
  const code = `
import os, sys, json, platform
conda_env = os.environ.get("CONDA_DEFAULT_ENV")
virtual_env = os.environ.get("VIRTUAL_ENV")
env_name = conda_env
if not env_name and virtual_env:
    env_name = os.path.basename(virtual_env)
if not env_name:
    parts = (sys.executable or "").replace("\\\\", "/").split("/")
    if "envs" in parts and parts.index("envs") + 1 < len(parts):
        env_name = parts[parts.index("envs") + 1]
    else:
        env_name = os.path.basename(os.path.dirname(sys.executable or "")) or None
print("__OPENCODE_RUNTIME_PROBE_START__")
print(json.dumps({
    "version": platform.python_version(),
    "executable": sys.executable,
    "prefix": sys.prefix,
    "basePrefix": getattr(sys, "base_prefix", None),
    "condaDefaultEnv": conda_env,
    "virtualEnv": virtual_env,
    "envName": env_name,
    "platform": platform.platform(),
}, ensure_ascii=False))
print("__OPENCODE_RUNTIME_PROBE_END__")
`.trim()

  const cts = new vscode.CancellationTokenSource()
  const timer = setTimeout(() => cts.cancel(), PROBE_TIMEOUT_MS)
  const chunks: string[] = []

  try {
    for await (const output of kernel.executeCode(code, cts.token)) {
      for (const item of output.items) {
        const text = decoder.decode(item.data)
        if (isErrorMime(item.mime)) throw new Error(text)
        if (isReadableMime(item.mime)) chunks.push(text)
      }
    }
  } finally {
    clearTimeout(timer)
    cts.dispose()
  }

  return JSON.parse(extractProbeJson(chunks.join("\n")))
}

async function readSavedNotebookMetadata(uri: vscode.Uri): Promise<SavedMetadata | null> {
  try {
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
    return {
      kernelDisplayName: kernelspec?.display_name ?? null,
      kernelName: kernelspec?.name ?? null,
      language: languageInfo?.name ?? kernelspec?.language ?? null,
      languageVersion: languageInfo?.version ?? null,
    }
  } catch {
    return null
  }
}

// ===========================================================================
// Format helpers
// ===========================================================================

function formatActiveRuntime(runtime: ActiveRuntime) {
  const p = runtime.python
  if (!p) return `${runtime.language} kernelStatus=${runtime.kernelStatus}`
  const env = p.envName ?? runtime.language
  const version = p.version ? `${runtime.language} ${p.version}` : runtime.language
  return `${env} (${version}) kernelStatus=${runtime.kernelStatus}`
}

function formatSavedMetadata(meta: SavedMetadata | null) {
  if (!meta) return "unavailable"
  const kernel = meta.kernelDisplayName ?? meta.kernelName ?? "unknown"
  const language = meta.languageVersion
    ? `${meta.language ?? "unknown"} ${meta.languageVersion}`
    : meta.language ?? "unknown"
  return `${kernel} (${language}), kernelspec.name=${meta.kernelName ?? "unknown"}`
}

function isReadableMime(mime: string) {
  return (
    mime === "text/plain" ||
    mime === "application/json" ||
    mime === "application/x.notebook.stream.stdout" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime.startsWith("text/")
  )
}

function isErrorMime(mime: string) {
  return mime === "application/vnd.code.notebook.error"
}

function extractProbeJson(text: string) {
  const startMarker = "__OPENCODE_RUNTIME_PROBE_START__"
  const endMarker = "__OPENCODE_RUNTIME_PROBE_END__"
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)

  const body = start >= 0 && end > start
    ? text.slice(start + startMarker.length, end)
    : text

  const jsonStart = body.indexOf("{")
  const jsonEnd = body.lastIndexOf("}")
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`Runtime probe returned no JSON: ${text.slice(0, 500)}`)
  }
  return body.slice(jsonStart, jsonEnd + 1)
}

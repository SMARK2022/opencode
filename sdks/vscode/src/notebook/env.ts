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
 * Configure is light-weight: it ensures Jupyter is active, makes the notebook
 * visible, and triggers kernel selection. It cannot read Jupyter's internal
 * controller registration — configure is best-effort, not a replacement for
 * Jupyter's built-in configure_notebook.
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
import { extensionState, extensionInfo, stringProp } from "../util"
import { resolveNotebook } from "./resolve"

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUPYTER_ID = "ms-toolsai.jupyter"
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
      `Operation: info`,
      `Notebook runtime: ${activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"}`,
      `Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState(JUPYTER_ID)}.`,
      `Notebook saved metadata: ${formatSavedMetadata(savedMetadata)}.`,
      activeRuntime
        ? "Runtime source: active kernel (api.kernels.getKernel + executeCode probe)."
        : "Runtime source: none. Jupyter public API exposes only started kernels for open notebooks.",
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
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo(JUPYTER_ID),
      },
    },
    note:
      "Runtime is probed from the active kernel process; saved metadata is reported separately and is not treated as runtime fallback.",
  }
}

// ===========================================================================
// configure — open notebook + trigger kernel selection
// ===========================================================================

async function configureNotebook(notebook: vscode.NotebookDocument, reason?: string) {
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()
  const startedAt = Date.now()

  // Ensure Jupyter extension is available
  const jupyter = vscode.extensions.getExtension(JUPYTER_ID)
  if (!jupyter) {
    return {
      ran: true,
      summary: "Jupyter extension is not installed. Install ms-toolsai.jupyter and select a kernel first.",
      data: { path: primaryPath, operation: "configure", reason, jupyterFound: false, durationMs: Date.now() - startedAt },
    }
  }
  if (!jupyter.isActive) await jupyter.activate()

  // Make the notebook visible so the kernel picker can render
  try {
    await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: true })
  } catch {
    // Non-fatal: selectKernel can still work for open notebooks
  }

  // Trigger kernel selection without prompting if a kernel is already attached
  const selectKernelAvailable = (await vscode.commands.getCommands(true)).includes("notebook.selectKernel")
  if (selectKernelAvailable) {
    await vscode.commands.executeCommand("notebook.selectKernel", {
      notebookUri: notebook.uri,
      skipIfAlreadySelected: true,
    })
  }

  return {
    ran: true,
    summary: [
      "Operation: configure",
      selectKernelAvailable
        ? "Kernel selection triggered. Choose a kernel if prompted; if a kernel was already selected, this is a no-op."
        : "notebook.selectKernel command is not registered. Select a kernel manually via the notebook toolbar.",
      "After kernel selection, kernel will start on first cell execution.",
      reason ? `Reason: ${reason}` : "",
    ].filter(Boolean).join("\n"),
    data: {
      path: primaryPath,
      operation: "configure",
      reason,
      jupyterFound: true,
      jupyterActive: jupyter.isActive,
      selectKernelAvailable,
      dirty: notebook.isDirty,
      durationMs: Date.now() - startedAt,
    },
    note: "Light-weight best-effort. Cannot read Jupyter's internal controller/kernel state.",
  }
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
      summary: "Jupyter extension is not installed. Install ms-toolsai.jupyter and select a kernel first.",
      data: { path: primaryPath, operation: "restart", reason, jupyterFound: false, durationMs: Date.now() - startedAt },
    }
  }
  if (!jupyter.isActive) await jupyter.activate()

  // Ensure the public restart command is registered
  const allCommands = await vscode.commands.getCommands(true)
  if (!allCommands.includes(RESTART_CMD)) {
    return {
      ran: true,
      summary: "jupyter.restartkernel command is not registered. Check that the Jupyter extension is correctly installed.",
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
        "Operation: restart",
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
      summary: `Kernel restart invocation failed: ${message}.`,
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
        "Operation: save",
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
      `Operation: save`,
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

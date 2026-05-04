/**
 * `vscode_notebook_env` — reports notebook runtime and saved metadata.
 *
 * Runtime source:
 *   active Jupyter kernel process via Jupyter stable API:
 *   api.kernels.getKernel(notebook.uri) + kernel.executeCode(probe).
 *
 * Metadata source:
 *   saved .ipynb file metadata.kernelspec / metadata.language_info.
 *
 * Important:
 *   saved metadata is NOT treated as active runtime. If no started kernel exists,
 *   runtime is reported as no-active-kernel even if metadata says "ML".
 */
import * as vscode from "vscode"
import { TextDecoder } from "node:util"
import { extensionState, extensionInfo } from "../util"
import { resolveNotebook } from "./resolve"

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

const PROBE_TIMEOUT_MS = 8_000
const decoder = new TextDecoder("utf-8")

export async function notebookEnv(filePath: string) {
  const notebook = await resolveNotebook(filePath)
  const activeRuntime = await getActiveRuntime(notebook.uri)
  const savedMetadata = await readSavedNotebookMetadata(notebook.uri)

  return {
    ran: false,
    summary: [
      `Notebook runtime: ${activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter" )}.`,
      `Notebook saved metadata: ${formatSavedMetadata(savedMetadata)}.`,
      activeRuntime
        ? "Runtime source: actual active Jupyter kernel process via api.kernels.getKernel + executeCode."
        : "Runtime source: none; Jupyter stable API exposes only started kernels associated with the open notebook.",
      activeRuntime?.python?.executable ? `Python executable: ${activeRuntime.python.executable}` : undefined,
    ].filter(Boolean).join("\n"),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      runtime: activeRuntime,
      saved_metadata: savedMetadata,
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo("ms-toolsai.jupyter"),
      },
    },
    note:
      "Runtime is probed from the active kernel process; saved metadata is reported separately and is not used as runtime fallback.",
  }
}

async function getActiveRuntime(uri: vscode.Uri): Promise<ActiveRuntime | null> {
  try {
    const ext = vscode.extensions.getExtension("ms-toolsai.jupyter")
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

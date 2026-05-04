/**
 * vscode_notebook_env 分别报告实际活动内核与保存的笔记本元数据。
 *
 * 运行时来源：Jupyter 稳定 API 的 api.kernels.getKernel(notebook.uri)，
 * Python 信息由该内核的 executeCode 探针取得。
 *
 * 元数据来源：保存的 .ipynb 中 metadata.kernelspec / metadata.language_info。
 *
 * 未启动关联内核时报告 no-active-kernel，即使盘上 kernelspec 声明了 ML。
 * 保存的元数据不作为活动运行时的回退来源。
 */
import vscode from "vscode"
import { TextDecoder } from "node:util"
import { extensionState, extensionInfo } from "../util"
import { resolveNotebook } from "./resolve"

type KernelOutputItem = { mime: string; data: Uint8Array }
type KernelOutput = { items: KernelOutputItem[] }

interface KernelLike {
  readonly language: string
  // 稳定 API 的 status 可缺省，不能从 notebook 的保存状态补成 idle。
  readonly status?: string
  // 探针消费异步内核输出流，CancellationToken 的所有权留在探针调用内。
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<KernelOutput>
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
  // R 等非 Python 内核仍返回 base，不能用主机 Python 信息填充这个字段。
  python?: {
    version: string | null
    executable: string | null
    prefix: string | null
    // basePrefix 与 prefix 分列，展示虚拟环境时不能把其基底解释器路径抹掉。
    basePrefix: string | null
    condaDefaultEnv: string | null
    virtualEnv: string | null
    // envName 是探针推导的显示标签，不能作为后续内核选择或解释器定位键。
    envName: string | null
    platform: string | null
  }
}

type SavedMetadata = {
  // display_name 与 name 都保留，用户标签不替代 kernelspec 的机器标识。
  kernelDisplayName: string | null
  kernelName: string | null
  language: string | null
  languageVersion: string | null
}

// 八秒到期只发送协作取消，finally 仍负责释放本次探针的 token 和计时器。
const PROBE_TIMEOUT_MS = 8_000
const decoder = new TextDecoder("utf-8")

export async function notebookEnv(filePath: string) {
  const notebook = await resolveNotebook(filePath)
  // 路径无法打开时直接拒绝，不能把解析失败包装成 no-active-kernel 快照。
  const activeRuntime = await getActiveRuntime(notebook.uri)
  const savedMetadata = await readSavedNotebookMetadata(notebook.uri)

  return {
    ran: false,
    summary: [
      `Notebook runtime: ${activeRuntime ? formatActiveRuntime(activeRuntime) : "no-active-kernel"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter" )}.`,
      `Notebook saved metadata: ${formatSavedMetadata(savedMetadata)}.`,
      activeRuntime
        ? "运行时来源：通过 api.kernels.getKernel 与 executeCode 查询实际活动的 Jupyter 内核进程。"
        : "运行时来源：无；Jupyter 稳定 API 仅暴露与打开笔记本关联且已启动的内核。",
      activeRuntime?.python?.executable ? `Python executable: ${activeRuntime.python.executable}` : undefined,
    ].filter(Boolean).join("\n"),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      runtime: activeRuntime,
      saved_metadata: savedMetadata,
      // active_notebook 只记录 UI 焦点；路径解析失败或焦点指向别的文档时，不能拿它补齐本次目标的 runtime。
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo("ms-toolsai.jupyter"),
      },
    },
    note:
      "运行时通过实际内核进程探测；保存的元数据单独报告，不作为运行时回退。",
  }
}

async function getActiveRuntime(uri: vscode.Uri): Promise<ActiveRuntime | null> {
  try {
    // 扩展缺失是无运行时证据，不能从 Python 扩展的安装状态猜出 Jupyter 内核。
    const ext = vscode.extensions.getExtension("ms-toolsai.jupyter")
    if (!ext) return null

    // 激活是源码本轮显式探测路径的副作用，只为读取此扩展自己的稳定 API。
    const api = (ext.isActive ? ext.exports : await ext.activate()) as JupyterLike | undefined
    const kernel = await api?.kernels?.getKernel?.(uri)
    // getKernel 不创建关联，未找到内核时不从盘上 kernelspec 合成 activeRuntime。
    if (!kernel) return null

    const base: ActiveRuntime = {
      language: kernel.language,
      // unknown 表示 API 没提供状态，不能把探针结束当成内核 idle 的证据。
      kernelStatus: kernel.status ?? "unknown",
    }

    // 只给 Python 内核提交 Python 代码，其它语言的活动状态仍保留在 base。
    if (kernel.language.toLowerCase() !== "python") return base

    // Python 探针失败只缺少详细环境字段，已找到的内核语言与状态不被改写成磁盘声明。
    const python = await probePythonRuntime(kernel).catch(() => null)
    return python ? { ...base, python } : base
  } catch {
    // 扩展激活或内核查询失败保持 env 的容错报告，不启动其它执行入口重试。
    return null
  }
}

async function probePythonRuntime(kernel: KernelLike): Promise<ActiveRuntime["python"]> {
  const code = `
import os, sys, json, platform
conda_env = os.environ.get("CONDA_DEFAULT_ENV")
virtual_env = os.environ.get("VIRTUAL_ENV")
env_name = conda_env
# 环境标签优先取内核进程的 conda 声明，其次才从激活的虚拟环境路径提取。
if not env_name and virtual_env:
    env_name = os.path.basename(virtual_env)
if not env_name:
    # 解释器路径只补显示名称，不把这个推断回写进保存的 kernelspec。
    parts = (sys.executable or "").replace("\\\\", "/").split("/")
    if "envs" in parts and parts.index("envs") + 1 < len(parts):
        env_name = parts[parts.index("envs") + 1]
    else:
        env_name = os.path.basename(os.path.dirname(sys.executable or "")) or None
print("__OPENCODE_RUNTIME_PROBE_START__")
# 标记界定本次探针的 JSON，避免内核已有输出或启动横幅混入环境对象。
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
  // 按输出顺序积累文本，不能让并发拼接打乱 JSON 或起止标记。
  const chunks: string[] = []

  try {
    for await (const output of kernel.executeCode(code, cts.token)) {
      for (const item of output.items) {
        const text = decoder.decode(item.data)
        // 内核错误 MIME 拒绝本次探针，不能把 traceback 中的花括号当成有效环境 JSON。
        if (isErrorMime(item.mime)) throw new Error(text)
        // 图片及其它二进制表示不参与 JSON 提取，只有文本 MIME 进入 chunks。
        if (isReadableMime(item.mime)) chunks.push(text)
      }
    }
  } finally {
    clearTimeout(timer)
    // 成功、内核错误和取消都走同一释放路径，已完成探针不能继续持有取消源。
    cts.dispose()
  }

  return JSON.parse(extractProbeJson(chunks.join("\n")))
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
  const p = runtime.python
  // 没有 Python 详情仍展示真实内核语言与状态，不能显示一个猜测的解释器版本。
  if (!p) return `${runtime.language} kernelStatus=${runtime.kernelStatus}`
  const env = p.envName ?? runtime.language
  const version = p.version ? `${runtime.language} ${p.version}` : runtime.language
  return `${env} (${version}) kernelStatus=${runtime.kernelStatus}`
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

  // 起止标记必须有序，截出的 JSON 仍由 JSON.parse 验证，不能以找到标记宣称探针成功。
  const body = start >= 0 && end > start
    ? text.slice(start + startMarker.length, end)
    : text

  const jsonStart = body.indexOf("{")
  const jsonEnd = body.lastIndexOf("}")
  // 没有完整花括号区间时保留真实探针诊断，禁止返回一个空对象冒充环境信息。
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`Runtime probe returned no JSON: ${text.slice(0, 500)}`)
  }
  return body.slice(jsonStart, jsonEnd + 1)
}
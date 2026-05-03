// env 只读取能力快照，不为检查环境执行探针或修改 VS Code 全局配置。
import vscode from "vscode"
import { extensionState, extensionInfo } from "../util"
import { runtimeLabel } from "./format"
import { resolveNotebook } from "./resolve"

export async function notebookEnv(filePath?: string) {
  // env 的模块接口只报告原生命令能力，不能为了返回环境信息调用执行模块的探针。
  const notebook = await resolveNotebook(filePath).catch(() => undefined)
  // 文档解析失败可返回未知环境，仍保留 Python/Jupyter 扩展的安装状态。
  // commands 表只说明命令已注册，不能据此推断命令调用会成功完成。
  const commands = await vscode.commands.getCommands(true)
  const names = [
    "notebook.cell.execute",
    "notebook.execute",
    "notebook.selectKernel",
    "notebook.kernel.restart",
    "jupyter.selectKernel",
    "jupyter.restartkernel",
    // Python 解释器命令与 notebook 内核命令分别报告，不把二者视为同一运行时。
    "python.setInterpreter",
  ]
  return {
    ran: false,
    summary: `Notebook runtime: ${notebook ? (runtimeLabel(notebook) ?? "unknown") : "unknown"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter")}.`,
    data: {
      path: notebook?.uri.fsPath || notebook?.uri.toString(),
      runtime: notebook ? runtimeLabel(notebook) : null,
      // active_notebook 只记录 UI 焦点；路径解析失败或焦点指向别的文档时，不能拿它补齐本次目标的 runtime。
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo("ms-toolsai.jupyter"),
      },
      commands: Object.fromEntries(names.map((name) => [name, commands.includes(name)])),
    },
    note: "Native public VS Code API does not expose full Jupyter kernel/package details; bridge can fallback to extension commands/tools when needed.",
  }
}

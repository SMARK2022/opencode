// run 只经原生命令执行给定文档的保留格，响应复用 output 的同一捕获与导出边界。
import vscode from "vscode"
import { isRecord, stringProp, numberProp, toPosixPath, quoteForSummary, formatBytes } from "../util"
import {
  shortId,
  cellIdentifiers,
  shortMime,
  existingOuts,
  executionText,
  executionState,
  runtimeLabel,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, notebookRange } from "./resolve"
import { captureNotebookCellOutput, serializeNotebookOutputItem } from "./output"
// run 依赖 output 的纯捕获和 item 导出接口；format 保持投影规则所有权，不反向依赖执行模块。

/**
 * 通过 notebook.cell.execute 执行保留的单元格，明确指定笔记本 URI 与半开区间。
 * @param input filePath 可省略；提供的路径或 URI 在等待编辑器、命令之前绑定目标文档。
 * target.type: all | range | cell；仅省略 type 时默认 cell，显式未知类型会被拒绝。
 * target.cellId/target.cellIndex: 优先以非空规范化 ID 解析选中格；否则仍按零基目标索引、顶层输入索引、0 的顺序使用原数字钳制。
 * target.start/target.end: 零基 [start,end) 区间；命令面板输入的包含式终点仅在进入处理器前转换一次。
 * timeoutMs: 可选的观察超时，单位毫秒，默认 60000；超时不取消内核执行。
 * @returns ran=true 与表示等待边界的 completed，不将它们作为执行成功判定。
 * 单元格 execution.status 使用原生 success 标志；缺少请求身份时 provenance 仍为 unknown/saved。
 * 所有保留格的元数据、MIME 投影和输出字节均在写入导出文件前捕获；同时返回规范化 ID 与不可变的 artifactURI/artifactPath。
 */
export async function runNotebook(input: Record<string, unknown>) {
  // 文档和范围先绑定到局部变量，所有 await 之后仍使用这一组目标。
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const target = isRecord(input.target) ? input.target : {}
  const range = notebookRange(notebook, target, typeof input.cellIndex === "number" ? input.cellIndex : undefined)
  const cells = notebook.getCells(range)
  // await 前保留目标格对象；其它格的源码或输出变化不应阻止本次执行。
  // showNotebookDocument 为官方 URI 解析提供已打开的编辑器，不把焦点当身份。
  const editor = await vscode.window.showNotebookDocument(notebook, { selections: [range] })

  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    // 原生执行入口只有 notebook.cell.execute，能力检测失败就直接报错。
    throw new Error("VS Code command notebook.cell.execute is not available")
  }
  // 所有界面与能力查询结束后再校验目标，结构漂移时不调用命令或更新旧选区。
  if (notebook.isClosed || cells.some((cell, index) => notebook.getCells()[range.start + index] !== cell)) {
    // 按原范围核对对象，目标移位、删除或替换仍拒绝；不要求整份文档版本保持不变。
    throw new Error("Notebook changed before execution; select the target cells again")
  }
  editor.selection = range
  editor.revealRange(range)

  const startedAt = Date.now()
  // 观察起点必须早于命令 await，快速执行可能在命令返回前结束，晚采样会误判为旧结果。
  // 半开 ranges 与完整 URI 对象交给官方解析器；autoReveal=false 不借自动聚焦改变已绑定的执行目标。
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: cells.map((cell) => ({ start: cell.index, end: cell.index + 1 })), document: notebook.uri, autoReveal: false })
  // 官方多格参数以 document 找编辑器，再按半开 ranges 取格；焦点切换不改变执行目标。
  const completed = await waitForExecution(notebook, cells, startedAt, numberProp(input, "timeoutMs") ?? 60_000)
  return await compactRunResult(notebook, range, completed, cells)
}

async function compactRunResult(notebook: vscode.NotebookDocument, range: vscode.NotebookRange, completed: boolean, targets: vscode.NotebookCell[]) {
  const info = {
    path: notebook.uri.fsPath || notebook.uri.toString(),
    // dirty 是发起导出时的文档状态，不在异步写入后重新查询或自动保存。
    dirty: notebook.isDirty,
    runtime: runtimeLabel(notebook),
    // target 是原请求范围的显示描述，结构编辑后须按 cells 的稳定 ID 重选，不能把旧范围字符串当新选择器。
    target: runTarget(range, notebook.cellCount),
  }
  // 多格请求先同步捕获全部格；逐格先写文件再捕获下一格会混合不同观察时刻。
  const snapshots = targets.map((cell) => captureNotebookCellOutput(notebook, cell))
  // 遍历保留格和全格快照，不能重新解析旧范围；所有 artifact 写入结束后才返回路径。
  const cells = await Promise.all(targets.map((cell, index) => compactRunCell(notebook, cell, snapshots[index])))
  // artifact 导出也有异步边界，目标在导出期间被删除或替换时明确拒绝返回完成结果。
  if (notebook.isClosed || targets.some((cell) => notebook.getCells()[cell.index] !== cell)) throw new Error("Notebook target cells changed during execution")
  // 此处读取原模型只用于身份失效判定，不用于刷新已经捕获的响应内容。
  return {
    ran: true,
    // 外层标题与 data 共用捕获值，不能在首格 I/O 后再查询文档描述。
    summary: runSummaryText(info, completed, cells),
    data: {
      ...info,
      // completed 只描述等待边界；超时仍提供已有输出供诊断，不偷换成单格 success。
      completed,
      cells,
    },
  }
}

async function compactRunCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell, snapshot: ReturnType<typeof captureNotebookCellOutput>) {
  return {
    // 当前 index 只用于解释范围和输出归属，插入删除后应重新读取 summary。
    i: snapshot.data.cell.i,
    // 返回 canonical ID 供后续 source/output/edit 回传，不能再生成截短的运行专用 ID。
    id: snapshot.data.cell.id,
    exec: snapshot.data.cell.exec,
    // 原生 success/provenance 已在同步捕获阶段投影，stdout、第二次运行或等待完成不能补写结果。
    execution: snapshot.data.cell.execution,
    // run 与 output 共用从复制 items 得到的 MIME 列表，不增设另一套输出状态观察器。
    existing_outs: snapshot.data.cell.existing_outs,
    artifacts: await Promise.all(
      // existing_outs 去重仅作能力列表；artifact 是输出序列，同 MIME 的重复输出也须逐项保留原顺序。
      // Promise.all 的拒绝不会撤销兄弟写入，失败响应后可能仍留有已写成的 artifact，不能按事务回滚理解。
      snapshot.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) =>
          serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex),
        ),
      ),
    ),
  }
}

function runSummaryText(
  // 四个文档字段都是捕获后的标量，格式化接口不再接收可变 NotebookDocument。
  info: { path: string; dirty: boolean; runtime: string | null; target: string },
  completed: boolean,
  cells: Array<Awaited<ReturnType<typeof compactRunCell>>>,
) {
  const artifactRoot = ".opencode/cache/notebook-outputs/"
  return [
    // summary 仅组合 info、完成标志及格快照，与 data 描述同一批已选取输出。
    `Notebook: ${toPosixPath(info.path)}`,
    `Run: target=${info.target} completed=${completed} dirty=${info.dirty} runtime=${info.runtime ?? "unknown"}`,
    `ArtifactsRoot: ${artifactRoot}`,
    "",
    "Cells:",
    ...cells.map(
      (c) =>
        `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`,
    ),
    "",
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

function runTarget(range: vscode.NotebookRange, cellCount: number) {
  if (range.start === 0 && range.end === cellCount) return "all"
  if (range.end === range.start + 1) return `cell ${range.start}`
  return `range ${range.start}-${range.end - 1}`
}

async function waitForExecution(
  notebook: vscode.NotebookDocument,
  cells: vscode.NotebookCell[],
  startedAt: number,
  timeoutMs: number,
) {
  // 此 waiter 只观察提交时保留的格对象，不把插入到旧范围内的新格当执行目标。
  const valid = () => !notebook.isClosed && cells.every((cell) => notebook.getCells()[cell.index] === cell)
  // 命令 await 期间已删除目标也必须报错，不能让空 code 列表的 every 伪报完成。
  if (!valid()) throw new Error("Notebook target cells changed during execution")
  const done = () =>
    cells
      // Markup 格没有执行时序，不能因缺少其 endTime 让纯文档范围永久等待。
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .every((cell) => {
        const timing = cell.executionSummary?.timing
        // code 格需要新于 startedAt 的结束时间，历史输出不能直接满足完成条件。
        return timing?.endTime !== undefined && timing.endTime >= startedAt
      })

  // 首次 done 检查覆盖命令返回前已完成的快速执行，避免漏掉早到事件。
  if (done()) return true

  return await new Promise<boolean>((resolve, reject) => {
  // 观察期限结束与目标失效分别返回 false 或拒绝，二者都清理现有订阅。
    const timer = setTimeout(() => {
      // 超时 dispose 后返回 false 只表示观察期限结束，不宣称已中断内核。
      subscription.dispose()
      if (!valid()) return reject(new Error("Notebook target cells changed during execution"))
      resolve(false)
    }, timeoutMs)
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      // 工作区事件来自所有 notebook，必须先匹配完整 URI 再检查本请求的格范围。
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (!valid()) {
        clearTimeout(timer)
        subscription.dispose()
        reject(new Error("Notebook target cells changed during execution"))
        return
      }
      if (!done()) return
      // 满足条件时同时 clearTimeout 和 dispose，不能让已返回请求继续持有监听器。
      clearTimeout(timer)
      subscription.dispose()
      resolve(true)
    })
  })
}

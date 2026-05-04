// run 只经原生命令执行给定文档的保留格，响应复用 output 的同一捕获与导出边界。
import vscode from "vscode"
import { stringProp, numberProp, toPosixPath, quoteForSummary } from "../util"
import {
  c1,
  copilotLikeCellId,
  existingOuts,
  executionState,
  runtimeLabel,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"
import { captureNotebookCellOutput, serializeNotebookOutputItem } from "./output"
// run 依赖 output 的纯捕获和 item 导出接口；format 保持投影规则所有权，不反向依赖执行模块。

/**
 * 通过 notebook.cell.execute 串行执行保留格，文档 URI 和半开 ranges 明确传给原生命令。
 * filePath 与 cellId 必填；可选 endCellId 指定包含两端的范围，不接受 all 或数字索引。
 * 顶层 type 可省略或为 cell | range；endCellId 是范围信号，不依赖 type 决定范围。
 * 每格观察超时默认为 300000 毫秒；超时停止后续格，但不取消正在运行的内核。
 * 首个原生失败停止后续执行，未执行格标为 skipped；历史输出标为 stale。
 * completed 表示等待边界，不补成 execution.status 的成功证据。
 * 每次执行后的元数据、MIME 和字节先同步捕获，再由 output owner 写入不可变 artifact。
 * summary 与 data 共享捕获值，并保留完整 artifactURI/artifactPath。
 */
export async function runNotebook(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const type = input.type
  // 显式非字符串、null 或未知类型仍按原严格边界拒绝，不能被 stringProp 隐去。
  if (type !== undefined && type !== "cell" && type !== "range") throw new Error(`Invalid run type: ${String(type)}. Expected one of: cell, range.`)
  const cellId = stringProp(input, "cellId")
  if (!cellId) throw new Error("cellId is required")
  const notebook = await resolveNotebook(filePath)
  // UI 等待前按共享 resolver 固定格对象，不能在每次执行时按漂移索引重新选格。
  const cells = resolveRunTarget(notebook, cellId, stringProp(input, "endCellId"))
  const positions = cells.map((cell) => cell.index)
  // await 前保留目标格对象；其它格的源码或输出变化不应阻止本次执行。
  // showNotebookDocument 为官方 URI 解析提供已打开的编辑器，不把焦点当身份。
  const editor = await vscode.window.showNotebookDocument(notebook, {
    selections: cells.map((cell) => new vscode.NotebookRange(cell.index, cell.index + 1)),
  })

  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    // 原生执行入口只有 notebook.cell.execute，能力检测失败就直接报错。
    throw new Error("VS Code command notebook.cell.execute is not available")
  }
  // 所有界面与能力查询结束后再校验目标，结构漂移时不调用命令或更新旧选区。
  if (notebook.isClosed || cells.some((cell, index) => notebook.getCells()[positions[index]] !== cell)) {
    // 按原范围核对对象，目标移位、删除或替换仍拒绝；不要求整份文档版本保持不变。
    throw new Error("Notebook changed before execution; select the target cells again")
  }
  // 超时按单格等待计算，不能把首格的耗时扣成下一格已经超时。
  const timeoutMs = numberProp(input, "timeoutMs") ?? 300_000
  const results: Array<Awaited<ReturnType<typeof compactRunCell>>> = []
  let stopped = false
  let failedIndex: number | undefined

  for (const cell of cells) {
    // Markup 保留在范围显示中，但不能提交给原生代码执行命令。
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      results.push({ i: c1(cell), id: copilotLikeCellId(cell), exec: "skipped (not code)", execution: executionState(cell), existing_outs: [], artifacts: [] })
      continue
    }
    if (stopped) {
      // 跳过格的已有 MIME 是历史证据，stale 标签不能被解释为本次执行输出。
      const outs = existingOuts(cell)
      results.push({ i: c1(cell), id: copilotLikeCellId(cell), exec: "skipped (previous cell failed)", execution: executionState(cell), existing_outs: outs.length > 0 ? [`stale:${outs.join(",")}`] : outs, artifacts: [] })
      continue
    }

    // 前一格的执行和导出都有 await，开始下一格前必须再次验证同一组保留对象。
    if (notebook.isClosed || cells.some((target) => notebook.getCells()[target.index] !== target)) throw new Error("Notebook target cells changed during execution")
    editor.selection = new vscode.NotebookRange(cell.index, cell.index + 1)
    editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1))

    // 提交前注册等待器，快速执行的完成事件不能落在命令 await 与订阅之间。
    const wait = waitForSingleCell(notebook, cell, timeoutMs)
    let executionSummary: vscode.NotebookCellExecutionSummary | undefined
    try {
      // 每格仍显式传文档 URI 和半开范围，UI 聚焦只能辅助显示，不能成为执行身份。
      await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [{ start: cell.index, end: cell.index + 1 }], document: notebook.uri, autoReveal: false })
      executionSummary = await wait.promise
      // 等待器因目标失效唤醒时仍由原身份守卫报错，不把它降级成超时结果。
      if (notebook.isClosed || cells.some((target) => notebook.getCells()[target.index] !== target)) throw new Error("Notebook target cells changed during execution")
    } finally {
      // 命令拒绝也释放预注册资源，不能只在正常完成或超时事件中清理。
      wait.dispose()
    }

    if (!executionSummary) {
      // 观察超时不能继续提交下一格；它也不证明当前内核执行已被取消。
      stopped = true
      failedIndex = cell.index
    } else if (executionSummary.success === false) {
      stopped = true
      failedIndex = cell.index
    }

    // 每次执行结算后先同步捕获字节与状态，文件 I/O 不能把第二次输出贴到这一格的结果上。
    const result = await compactRunCell(notebook, cell, captureNotebookCellOutput(notebook, cell))
    // 超时文案只改展示字段，原生执行状态及已捕获输出不能补成成功或取消。
    if (!executionSummary) result.exec = "timed out (may still be running, waiting for kernel selection, or failed to start)"
    results.push(result)
  }

  const targetDesc = describeRunTarget(cells)
  return await compactRunResult(notebook, targetDesc, !stopped, cells, results, failedIndex)
}

async function compactRunResult(notebook: vscode.NotebookDocument, target: string, completed: boolean, targets: vscode.NotebookCell[], results: Array<Awaited<ReturnType<typeof compactRunCell>>>, failedIndex?: number) {
  const info = {
    path: notebook.uri.fsPath || notebook.uri.toString(),
    // 串行各格分别捕获结果；整次响应只报告收敛时的文档状态，不刷新单格快照。
    dirty: notebook.isDirty,
    runtime: runtimeLabel(notebook),
    // target 是原请求范围的显示描述，结构编辑后须按 cells 的稳定 ID 重选，不能把旧范围字符串当新选择器。
    target,
  }
  // artifact 导出也有异步边界，目标在导出期间被删除或替换时明确拒绝返回完成结果。
  if (notebook.isClosed || targets.some((cell) => notebook.getCells()[cell.index] !== cell)) throw new Error("Notebook target cells changed during execution")
  // 身份判定不能重选目标或重采字节，results 已由每次实际执行后的快照固定。
  return {
    ran: true,
    // 标题与 data 同取这次 info；串行多格不声称来自一个同时刻的观察边界。
    summary: runSummaryText(info, completed, results),
    data: {
      ...info,
      // completed 只描述等待边界；超时仍提供已有输出供诊断，不偷换成单格 success。
      completed,
      // stoppedAt 保留源零基失败位置；不能由 skipped 的历史状态反推出失败格。
      stoppedAt: failedIndex,
      cells: results,
    },
  }
}

function resolveRunTarget(notebook: vscode.NotebookDocument, cellId: string, endCellId?: string) {
  // 两端都经完整别名解析器定位，同格的不同 ID 写法仍只选择同一格。
  const startCell = resolveNotebookCell(notebook, undefined, cellId)
  // endCellId 才是范围信号，省略它时即使提示 type=range 也沿源规则执行单格。
  if (!endCellId) return [startCell]
  const endCell = resolveNotebookCell(notebook, undefined, endCellId)
  // 逆序直接拒绝，不能让空 slice 被当作一次成功执行。
  if (endCell.index < startCell.index) throw new Error("endCellId must refer to the same cell or a later cell than cellId")
  return notebook.getCells().slice(startCell.index, endCell.index + 1)
}

function describeRunTarget(cells: vscode.NotebookCell[]) {
  // 覆盖全本的 ID 范围仍报告 range，不能重新引入已删除的 all 目标。
  if (cells.length === 1) return `cell ${c1(cells[0])}`
  const indices = cells.map((c) => c1(c))
  return `range ${indices[0]}-${indices[indices.length - 1]}`
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

function waitForSingleCell(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  timeoutMs: number,
) {
  // 此 waiter 只观察提交时保留的格对象，不把插入到旧范围内的新格当执行目标。
  const valid = () => !notebook.isClosed && notebook.getCells()[cell.index] === cell
  // 预注册前失效直接报错，不能为不存在的目标创建一个假完成等待器。
  if (!valid()) throw new Error("Notebook target cells changed during execution")
  // 预注册版本标定当前观察范围，不能把已存在的摘要当这次完成。
  const version = notebook.version
  let subscription: vscode.Disposable | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // 目标失效交由命令结算后守卫抛错，避免命令 pending 时产生悬空拒绝。
  const promise = new Promise<vscode.NotebookCellExecutionSummary | undefined>((resolve) => {
    timer = setTimeout(() => {
      // 超时只结束摘要观察，不证明内核取消，也不能把旧结果标成这次完成。
      subscription?.dispose()
      resolve(undefined)
    }, timeoutMs)
    subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      // 工作区事件来自所有 notebook，必须先匹配完整 URI 再检查本请求的格范围。
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (!valid()) {
        clearTimeout(timer)
        subscription?.dispose()
        resolve(undefined)
        return
      }
      if (event.notebook.version <= version) return
      for (const change of event.cellChanges) {
        // 匹配保留对象而非显示索引，结构替换后的同槽位事件不能结束旧请求。
        if (change.cell !== cell) continue
        // 摘要字段只在执行摘要变更时提供，输出事件不能借用 cell 的历史摘要。
        const summary = change.executionSummary
        if (!summary) continue
        // 时间戳不能证明执行成败，未知结果继续等待，不能推进后续代码格。
        if (typeof summary.success !== "boolean") continue
        // 满足条件时同时 clearTimeout 和 dispose，不能让已返回请求继续持有监听器。
        clearTimeout(timer)
        subscription?.dispose()
        // 保留原生成功或失败摘要，交由串行调用方决定是否继续。
        resolve(summary)
        return
      }
    })
  })
  return {
    promise,
    dispose() {
      if (timer) clearTimeout(timer)
      subscription?.dispose()
    },
  }
}

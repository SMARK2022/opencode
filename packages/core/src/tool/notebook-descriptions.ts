// 工具描述与参数 schema：对齐 VS Code notebook 桥接端点契约
// 工具描述常量：6 个 notebook 工具的用户可见描述，用于 opencode 的工具注册和 UI 展示
export const VscodeNotebookDescriptions = {
  summary: [
    "Inspect a VS Code notebook and return a compact cell map.",
    "Use this first for notebook work unless a fresh summary is already visible. filePath is required; the bridge never infers a notebook from VS Code focus or open documents.",
    "It returns #VSC cell IDs (stable within the current session for existing cells), display indexes, 1-based virtual source ranges, execution state, output MIME summaries, dirty state, and runtime metadata.",
    "Cell indexes cN are 1-based display indexes and can shift after insert/delete. Use #VSC cell IDs for source, edit, run, and output calls.",
    "After editing a notebook, cell IDs may change on type changes — the edit response shows the updated ID. Re-run summary when referencing cells not mentioned in edit responses.",
  ].join("\n"),

  source: [
    // 两代描述与同一 Notebook 源码分页预算同步，保留原有全局坐标续读契约。
    "Returned source is capped at 16 KB; use offset/limit to continue.",
    "Read notebook source as a paginated virtual text document with 1-based global line numbers.",
    "Use this instead of reading raw .ipynb JSON when source content is needed. filePath is required. Pass cellId=#VSC-xxx to focus one cell; use offset/limit to page through large notebooks.",
    "Line numbers are global virtual source lines across notebook cell sources. Headers and visual separators are unnumbered; line ranges are not per-cell local line numbers.",
    "Use the source text copied from this tool as oldCode when making precise string-match edits.",
  ].join("\n"),

  run: [
    "Execute notebook code cells in VS Code and return execution status plus artifact paths.",
    "Required fields: filePath and cellId. If endCellId is provided, the bridge runs from cellId through endCellId; otherwise it runs only cellId.",
    "type is optional. Explicit cell requires endpoints resolving to the same cell; otherwise endCellId selects a range. Use stable #VSC cell IDs from vscode_notebook_summary.",
    "Range execution includes both endpoint cells and does not use numeric cell indexes.",
    "Execution uses VS Code's native notebook.cell.execute path for each code cell, so VS Code/Jupyter handles kernel selection on the real run path; the bridge awaits the cell execution summary or per-cell timeout.",
    "Range targets run code cells sequentially and stop on the first failed or timed-out code cell.",
    "Use this after editing code cells when execution validation matters. Default timeout is 300000 ms per cell; maximum is 3000000 ms.",
  ].join("\n"),

  output: [
    "Read outputs for a notebook cell through VS Code and return artifact-first summaries.",
    "filePath is required. Use this after summary or run when a target cell has outputs. Prefer cellId=#VSC-xxx so inserts/deletes do not shift the target.",
    "Small text output may be inlined. Images, HTML, JSON, and large text are written under .opencode/cache/notebook-outputs/ and summarized by artifact path.",
    "Do not use this to inspect source code; use vscode_notebook_source for notebook source.",
  ].join("\n"),

  edit: [
    // 两代共用省略与空串的明确契约，语言变更不能意外清空源码。
    "Edit VS Code notebook cells with editType=insert, edit, or delete.",
    "For insert, cellId=TOP inserts at the top, cellId=BOTTOM appends, and cellId=#VSC-xxx inserts after that anchor cell. newCode is required.",
    "For edit, pass cellId=#VSC-xxx. Use oldCode/newCode for precise string-match replacement, or newCode without oldCode for full-cell replacement. A language-only edit changes the cell kind/language while preserving source only when oldCode and newCode are omitted entirely; empty strings mean explicit empty source.",
    "For delete, pass cellId=#VSC-xxx. Use language='markdown' for Markdown cells; other languages create or keep code cells, usually 'python'. Do not use this tool for ordinary text files.",
    // #105：edit 响应自带新 id，summary 文案改为引导读响应而非盲刷
    "The edit response includes the updated cell ID and shifted neighbor info.",
  ].join("\n"),

  env: [
    "Perform notebook environment operations selected via the `operation` field.",
    "filePath and operation are required. `reason` is an optional brief description shown to the user.",
    "Operations:",
    "  info      — probe the active kernel (available after at least one cell has run) and report saved .ipynb metadata. Use to confirm runtime after first execution or to check the Python environment path and version.",
    "  configure — select a kernel and verify readiness. Returns a status: configured (active kernel found), selected (accepted, kernel starts on first run — proceed directly to run), needs-selection (user cancelled picker), selection-requested (no explicit result), or failed (error). Use before the first run; no need to call info after selected.",
    "  restart   — restart the Jupyter kernel, clearing all variables and execution state. Rerun setup cells afterward. Only restart when strictly necessary (e.g. stuck kernel, corrupted state); prefer re-running cells over restarting when possible.",
    "  save      — persist the notebook document to disk on user request only. Do not save unprompted; let the user review changes first.",
    "  stop      — interrupt the currently executing cell without restarting the kernel. Variables and imports are preserved. Use after a run timeout or when a cell is stuck, instead of the heavier restart.",
    "  create    — create a new empty .ipynb file at the given filePath and open it. Use this instead of writing raw JSON with the write tool. After create, use vscode_notebook_edit with editType=insert to add cells, or operation=configure to select a kernel.",
  ].join("\n"),
}

export const VscodeNotebookDescriptions = {
  summary: [
    "Inspect a VS Code notebook and return a compact cell map.",
    "Use this first for notebook work unless a fresh summary is already visible. filePath is required; the bridge never infers a notebook from VS Code focus or open documents.",
    "It returns stable #VSC cell IDs, display indexes, 1-based virtual source ranges, execution state, output MIME summaries, dirty state, and runtime metadata.",
    "Cell indexes cN are 1-based display indexes and can shift after insert/delete. Use #VSC cell IDs for source, edit, run, and output calls.",
    "After editing a notebook, call this again before relying on cell indexes, virtual ranges, or output locations.",
  ].join("\n"),

  source: [
    "Read notebook source as a paginated virtual text document with 1-based global line numbers.",
    "Use this instead of reading raw .ipynb JSON when source content is needed. filePath is required. Pass cellId=#VSC-xxx to focus one cell; use offset/limit to page through large notebooks.",
    "Line numbers are global virtual source lines across notebook cell sources. Headers and visual separators are unnumbered; line ranges are not per-cell local line numbers.",
    "Use the source text copied from this tool as oldCode when making precise string-match edits.",
  ].join("\n"),

  run: [
    "Execute notebook code cells in VS Code and return execution status plus artifact paths.",
    "Required fields: filePath and cellId. If endCellId is provided, the bridge runs from cellId through endCellId; otherwise it runs only cellId.",
    "type is an optional hint only. endCellId is the actual range signal. cellId and endCellId are stable #VSC cell IDs from vscode_notebook_summary.",
    "Range execution includes both endpoint cells and does not use numeric cell indexes.",
    "Execution uses VS Code's native notebook.cell.execute path for each code cell, so VS Code/Jupyter handles kernel selection on the real run path; the bridge awaits the cell execution summary or per-cell timeout.",
    "Range targets run code cells sequentially and stop on the first failed or timed-out code cell.",
    "Use this after editing code cells when execution validation matters. Default timeout is 300000 ms per cell; maximum is 600000 ms.",
  ].join("\n"),

  output: [
    "Read outputs for a notebook cell through VS Code and return artifact-first summaries.",
    "filePath is required. Use this after summary or run when a target cell has outputs. Prefer cellId=#VSC-xxx so inserts/deletes do not shift the target.",
    "Small text output may be inlined. Images, HTML, JSON, and large text are written under .opencode/cache/notebook-outputs/ and summarized by artifact path.",
    "Do not use this to inspect source code; use vscode_notebook_source for notebook source.",
  ].join("\n"),

  edit: [
    "Edit VS Code notebook cells with editType=insert, edit, or delete.",
    "For insert, cellId=TOP inserts at the top, cellId=BOTTOM appends, and cellId=#VSC-xxx inserts after that anchor cell. newCode is required.",
    "For edit, pass cellId=#VSC-xxx. Use oldCode/newCode for precise string-match replacement, or newCode without oldCode for full-cell replacement. A language-only edit changes the cell kind/language while preserving source.",
    "For delete, pass cellId=#VSC-xxx. Use language='markdown' for Markdown cells; other languages create or keep code cells, usually 'python'. Do not use this tool for ordinary text files.",
    "After any successful edit, call vscode_notebook_summary again before further cell-index-sensitive operations.",
  ].join("\n"),

  env: [
    "Perform notebook environment operations selected via the `operation` field.",
    "filePath and operation are required. `reason` is an optional brief description shown to the user.",
    "",
    "Operations:",
    "  info      — probe the active kernel/interpreter and report saved .ipynb metadata",
    "  configure — open the notebook and trigger kernel selection (run before first execution)",
    "  restart   — restart the Jupyter kernel, clearing all variables and execution state. Rerun setup cells afterward.",
    "  save      — persist the notebook document to disk on user request only. Do not save unprompted; let the user review changes first.",
  ].join("\n"),
}

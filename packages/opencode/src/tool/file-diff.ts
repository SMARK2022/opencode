// 保留V1既有导入路径，真实实现归Core所有，原生V2不反向依赖应用包。
export {
  BINARY_SCAN_CHARS,
  MAX_DIFF_MIDDLE_CHARS,
  MAX_MERGED_PATCH_CHARS,
  boundMergedPatch,
  countPatchStats,
  renderFileDiff,
  type RenderedFileDiff,
} from "@opencode-ai/core/tool/file-diff"
export * as FileDiff from "./file-diff"

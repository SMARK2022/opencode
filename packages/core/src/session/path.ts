import path from "path"

// #132：全局 worktree 根
function isGlobalRoot(worktree: string) {
  return worktree === "/" || worktree === "\\"
}

export function relative(worktree: string, directory: string) {
  const resolvedDirectory = path.resolve(directory)
  // #132：Windows 全局会话保留盘符，避免跨盘相对路径碰撞
  if (process.platform === "win32" && isGlobalRoot(worktree)) return resolvedDirectory.replaceAll("\\", "/")

  const base = path.resolve(worktree)
  return path.relative(base, resolvedDirectory).replaceAll("\\", "/")
}

function windowsAbsolute(directory: string) {
  if (process.platform !== "win32") return
  const result = path.resolve(directory).replaceAll("\\", "/")
  return /^[A-Za-z]:\//.test(result) ? result : undefined
}

export function aliases(input: { path: string; directory?: string; global?: boolean }) {
  // #132：历史全局 path 可能无盘符；查询时同时匹配
  const absolute = input.global && input.directory ? windowsAbsolute(input.directory) : undefined
  const driveRelative = (absolute ?? input.path).replace(/^[A-Za-z]:\//, "")
  return [...new Set([input.path, absolute, driveRelative].filter((item): item is string => !!item))]
}

export * as SessionPath from "./path"

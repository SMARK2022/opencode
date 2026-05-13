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

// #143：Windows 盘符根可写成 F: 或 F:/
function isDriveQualified(value: string) {
  return /^[A-Za-z]:(?:\/|$)/.test(value)
}

// #143：path 祖先链，用于会话列表匹配父目录命名空间
export function ancestors(value: string, options?: { root?: boolean }) {
  const normalized = value.replace(/\/+$/, "")
  if (!normalized) return [""]
  const prefixes = normalized.split("/").flatMap((_, index, parts) => {
    const prefix = parts.slice(0, index + 1).join("/")
    // #143：Windows 驱动器根同时匹配 F: 与 F:/
    if (/^[A-Za-z]:$/.test(prefix)) return [prefix, `${prefix}/`]
    return [prefix]
  })
  // #143：root 选项注入空串祖先，匹配仓库根会话
  return [...new Set([...(options?.root && !isDriveQualified(normalized) ? [""] : []), ...prefixes])]
}

export function aliases(input: { path: string; directory?: string; global?: boolean }) {
  // #132：历史全局 path 可能无盘符；查询时同时匹配
  const absolute = input.global && input.directory ? windowsAbsolute(input.directory) : undefined
  const driveRelative = (absolute ?? input.path).replace(/^[A-Za-z]:\//, "")
  return [...new Set([input.path, absolute, driveRelative].filter((item): item is string => !!item))]
}

export * as SessionPath from "./path"

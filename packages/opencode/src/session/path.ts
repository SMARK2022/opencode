import path from "path"

function isGlobalRoot(worktree: string) {
  return worktree === "/" || worktree === "\\"
}

export function relative(worktree: string, directory: string) {
  const resolvedDirectory = path.resolve(directory)
  // On Windows, `path.resolve("/")` binds to the daemon's current drive. A
  // shared daemon can be started from C: while serving a request for F:, so use
  // a drive-qualified path for global sessions. Keeping the drive avoids
  // collisions between C:/repo and F:/repo that share the same drive-relative
  // suffix.
  if (process.platform === "win32" && isGlobalRoot(worktree)) return resolvedDirectory.replaceAll("\\", "/")

  const base = path.resolve(worktree)
  return path.relative(base, resolvedDirectory).replaceAll("\\", "/")
}

function windowsAbsolute(directory: string) {
  if (process.platform !== "win32") return
  const result = path.resolve(directory).replaceAll("\\", "/")
  return /^[A-Za-z]:\//.test(result) ? result : undefined
}

function isDriveQualified(value: string) {
  return /^[A-Za-z]:(?:\/|$)/.test(value)
}

export function ancestors(value: string, options?: { root?: boolean }) {
  const normalized = value.replace(/\/+$/, "")
  if (!normalized) return [""]

  const prefixes = normalized.split("/").flatMap((_, index, parts) => {
    const prefix = parts.slice(0, index + 1).join("/")
    // Windows drive roots may exist in old data as either `F:` or `F:/`.
    // Match both while still treating `F:/A` as the child namespace.
    if (/^[A-Za-z]:$/.test(prefix)) return [prefix, `${prefix}/`]
    return [prefix]
  })

  return [...new Set([...(options?.root && !isDriveQualified(normalized) ? [""] : []), ...prefixes])]
}

export function aliases(input: { path: string; directory?: string; global?: boolean }) {
  // Historical Windows global sessions used both `F:/...` and drive-relative
  // `...` forms depending on the daemon current drive. Query both spellings so
  // old rows remain visible while new writes keep the drive-qualified form.
  const absolute = input.global && input.directory ? windowsAbsolute(input.directory) : undefined
  const normalized = input.path.replaceAll("\\", "/")
  const driveRelative = (absolute ?? normalized).replace(/^[A-Za-z]:\//, "")
  return [...new Set([normalized, absolute, driveRelative].filter((item): item is string => !!item))]
}

export * as SessionPath from "./path"

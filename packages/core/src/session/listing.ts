export * as SessionListing from "./listing"

import path from "path"
import { and, eq, isNull, like, or, sql, type SQL } from "drizzle-orm"
import { ProjectV2 } from "../project"
import { SessionTable } from "./sql"
import { SessionPath } from "./path"

function relatedPath(input: { path: string; directory?: string; global?: boolean; root?: boolean }) {
  return or(...SessionPath.aliases(input).flatMap(item => {
    const prefix = item.replace(/\/+$/, "")
    return [
      ...SessionPath.ancestors(item, { root: input.root }).map(ancestor => eq(SessionTable.path, ancestor)),
      like(SessionTable.path, sql.param(prefix ? `${prefix}/%` : "%", SessionTable.path)),
    ]
  }))
}

function relatedDirectory(directory: string) {
  const column = sql<string>`replace(${SessionTable.directory}, ${"\\"}, "/")`
  const normalized = path.resolve(directory).replaceAll("\\", "/").replace(/\/+$/, "")
  const comparable = process.platform === "win32" ? sql<string>`lower(${column})` : column
  const value = process.platform === "win32" ? normalized.toLowerCase() : normalized
  return or(...SessionPath.ancestors(value).map(ancestor => eq(comparable, ancestor)), like(comparable, value ? `${value}/%` : "%"))
}

// 两代共用相关命名空间的唯一 SQL；调用者决定是否请求此语义，精确目录查询不隐式扩大。
export function related(input: { projectID: ProjectV2.ID; worktree: string; path: string; directory?: string }) {
  const isGlobal = input.projectID === ProjectV2.ID.global
  const projectPath = relatedPath({ ...input, global: isGlobal, root: true })
  const relative = input.directory === undefined ? undefined : SessionPath.relative(input.worktree, input.directory)
  const wanted = input.path.replaceAll("\\", "/")
  // directory/path 必须同源，才允许 global 与历史 directory 分支参与同一个查询。
  const sameLocation = relative !== undefined && (process.platform === "win32" ? relative.toLowerCase() === wanted.toLowerCase() : relative === wanted)
  const globalPath = sameLocation && input.directory ? relatedPath({
    path: SessionPath.relative("/", input.directory), directory: input.directory, global: true,
  }) : undefined
  const nullPath = input.directory ? and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory)) : undefined
  const branches = [
    and(eq(SessionTable.project_id, input.projectID), nullPath ? or(projectPath, nullPath) : projectPath),
    ...(globalPath && !isGlobal ? [and(eq(SessionTable.project_id, ProjectV2.ID.global), nullPath ? or(globalPath, nullPath) : globalPath)] : []),
    ...(sameLocation && input.directory ? [relatedDirectory(input.directory)] : []),
  ].filter((branch): branch is SQL => branch !== undefined)
  // 第一分支始终含 project_id；join 仅去掉 Drizzle 的可选条件类型，不引入第二次取数。
  return sql`(${sql.join(branches, sql` OR `)})`
}

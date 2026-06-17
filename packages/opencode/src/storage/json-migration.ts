import fs from "fs/promises"
import path from "path"
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Global } from "@opencode-ai/core/global"
import { SessionID } from "@/session/schema"

export type Stats = {
  projects: number
  sessions: number
  messages: number
  parts: number
  todos: number
  permissions: number
  shares: number
  errors: string[]
}

type Db = SQLiteBunDatabase

export async function run(db: Db): Promise<Stats> {
  const stats: Stats = { projects: 0, sessions: 0, messages: 0, parts: 0, todos: 0, permissions: 0, shares: 0, errors: [] }
  const root = path.join(Global.Path.data, "storage")
  if (!(await exists(root))) return stats

  await migrateProjects(db, root, stats)
  await migrateSessions(db, root, stats)
  await migrateMessages(db, root, stats)
  await migrateParts(db, root, stats)
  await migrateTodos(db, root, stats)
  await migratePermissions(db, root, stats)
  await migrateShares(db, root, stats)
  return stats
}

async function migrateProjects(db: Db, root: string, stats: Stats) {
  for (const file of await jsonFiles(path.join(root, "project"))) {
    const data = await readJson(file, stats)
    if (!data) continue
    const id = path.basename(file, ".json")
    await db
      .insert(ProjectTable)
      .values({
        id: Project.ID.make(id),
        worktree: AbsolutePath.make(string(data.worktree, "/")),
        vcs: typeof data.vcs === "string" ? data.vcs : undefined,
        name: typeof data.name === "string" ? data.name : undefined,
        time_created: time(data, "created"),
        time_updated: time(data, "updated"),
        sandboxes: stringArray(data.sandboxes).map((item) => AbsolutePath.make(item)),
        commands: record(data.commands) as { start?: string } | undefined,
      })
      .onConflictDoNothing()
      .run()
    stats.projects++
  }
}

async function migrateSessions(db: Db, root: string, stats: Stats) {
  for (const projectDir of await directories(path.join(root, "session"))) {
    const projectID = path.basename(projectDir)
    if (!(await hasProject(db, projectID))) continue
    for (const file of await jsonFiles(projectDir)) {
      const data = await readJson(file, stats)
      if (!data) continue
      const summary = record(data.summary)
      const share = record(data.share)
      await db
        .insert(SessionTable)
        .values({
          id: SessionID.make(path.basename(file, ".json")),
          project_id: Project.ID.make(projectID),
          slug: string(data.slug, ""),
          directory: string(data.directory, "/"),
          path: typeof data.path === "string" ? data.path : undefined,
          title: string(data.title, ""),
          version: string(data.version, ""),
          share_url: typeof share?.url === "string" ? share.url : undefined,
          summary_additions: number(summary?.additions),
          summary_deletions: number(summary?.deletions),
          summary_files: number(summary?.files),
          time_created: time(data, "created"),
          time_updated: time(data, "updated"),
        })
        .onConflictDoNothing()
        .run()
      stats.sessions++
    }
  }
}

async function migrateMessages(db: Db, root: string, stats: Stats) {
  for (const sessionDir of await directories(path.join(root, "message"))) {
    const sessionID = path.basename(sessionDir)
    if (!(await hasSession(db, sessionID))) continue
    for (const file of await jsonFiles(sessionDir)) {
      const data = await readJson(file, stats)
      if (!data) continue
      const row: typeof MessageTable.$inferInsert = {
        id: messageID(path.basename(file, ".json")),
        session_id: SessionID.make(sessionID),
        data: omit(data, ["id", "sessionID"]) as typeof MessageTable.$inferInsert.data,
        time_created: time(data, "created"),
        time_updated: time(data, "updated"),
      }
      await db
        .insert(MessageTable)
        .values(row)
        .onConflictDoNothing()
        .run()
      stats.messages++
    }
  }
}

async function migrateParts(db: Db, root: string, stats: Stats) {
  for (const messageDir of await directories(path.join(root, "part"))) {
    const legacyMessageID = path.basename(messageDir)
    const sessionID = await messageSession(db, legacyMessageID)
    if (!sessionID) continue
    for (const file of await jsonFiles(messageDir)) {
      const data = await readJson(file, stats)
      if (!data) continue
      const row: typeof PartTable.$inferInsert = {
        id: partID(path.basename(file, ".json")),
        message_id: messageID(legacyMessageID),
        session_id: SessionID.make(sessionID),
        data: omit(data, ["id", "messageID", "sessionID"]) as typeof PartTable.$inferInsert.data,
        time_created: time(data, "created"),
        time_updated: time(data, "updated"),
      }
      await db
        .insert(PartTable)
        .values(row)
        .onConflictDoNothing()
        .run()
      stats.parts++
    }
  }
}

async function migrateTodos(db: Db, root: string, stats: Stats) {
  for (const file of await jsonFiles(path.join(root, "todo"))) {
    const sessionID = path.basename(file, ".json")
    const data = await readJsonArray(file, stats)
    if (!(await hasSession(db, sessionID))) continue
    for (const [position, item] of data.entries()) {
      if (!record(item) || typeof item.content !== "string" || typeof item.status !== "string" || typeof item.priority !== "string") continue
      await db.insert(TodoTable).values({ session_id: SessionID.make(sessionID), content: item.content, status: item.status, priority: item.priority, position }).onConflictDoNothing().run()
      stats.todos++
    }
  }
}

async function migratePermissions(db: Db, root: string, stats: Stats) {
  for (const file of await jsonFiles(path.join(root, "permission"))) {
    const projectID = path.basename(file, ".json")
    const data = await readJsonArray(file, stats)
    if (!(await hasProject(db, projectID))) continue
    let count = 0
    for (const item of data) {
      if (!record(item) || typeof item.permission !== "string") continue
      await db.insert(PermissionTable).values({ id: PermissionSaved.ID.create(), project_id: Project.ID.make(projectID), action: item.permission, resource: string(item.pattern, "*") }).onConflictDoNothing().run()
      count++
    }
    if (count) stats.permissions++
  }
}

async function migrateShares(db: Db, root: string, stats: Stats) {
  for (const file of await jsonFiles(path.join(root, "session_share"))) {
    const sessionID = path.basename(file, ".json")
    const data = await readJson(file, stats)
    if (!(await hasSession(db, sessionID))) continue
    if (!data) continue
    await db.insert(SessionShareTable).values({ session_id: SessionID.make(sessionID), id: string(data.id, ""), secret: string(data.secret, ""), url: string(data.url, "") }).onConflictDoNothing().run()
    stats.shares++
  }
}

async function hasProject(db: Db, id: string) {
  return db.select().from(ProjectTable).all().some((row) => row.id === Project.ID.make(id))
}

async function hasSession(db: Db, id: string) {
  return db.select().from(SessionTable).all().some((row) => row.id === SessionID.make(id))
}

async function messageSession(db: Db, id: string) {
  return db.select().from(MessageTable).all().find((row) => row.id === messageID(id))?.session_id
}

function messageID(id: string) {
  return id as SessionV1.MessageID
}

function partID(id: string) {
  return id as SessionV1.PartID
}

async function jsonFiles(dir: string) {
  if (!(await exists(dir))) return []
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
}

async function directories(dir: string) {
  if (!(await exists(dir))) return []
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
}

async function exists(file: string) {
  return fs.stat(file).then(() => true, () => false)
}

async function readJson(file: string, stats: Stats) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"))
    return record(value)
  } catch (error) {
    stats.errors.push(`failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readJsonArray(file: string, stats: Stats) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"))
    return Array.isArray(value) ? value : []
  } catch (error) {
    stats.errors.push(`failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function omit(input: Record<string, unknown>, keys: string[]) {
  const output = { ...input }
  for (const key of keys) delete output[key]
  return output
}

function string(input: unknown, fallback: string) {
  return typeof input === "string" ? input : fallback
}

function number(input: unknown) {
  return typeof input === "number" ? input : undefined
}

function stringArray(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

function time(input: Record<string, unknown>, key: "created" | "updated") {
  const value = record(input.time)?.[key]
  return typeof value === "number" ? value : Date.now()
}

export const JsonMigration = { run }

import path from "path"
import { rename, rm } from "fs/promises"
import { randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Path as DatabasePath } from "@/storage/db"

export type ServerLock = {
  pid: number
  port: number
  token: string
  dbPath: string
  channel: string
  startedAt: string
  externalUrl?: string
}

// Overrideable for tests; undefined means use the default path.
let _lockPath: string | undefined
export function _setLockPath(p: string | undefined) {
  _lockPath = p
}

function getLockPath() {
  return _lockPath ?? process.env.OPENCODE_LOCK_PATH ?? path.join(Global.Path.state, "tui-server.json")
}

// Write the lock file atomically (tmp → rename) and return the new token so
// the caller can later use clearIfOwner() for safe deletion.
export async function write(port: number, externalUrl?: string): Promise<string> {
  const token = randomUUID()
  const lock: ServerLock = {
    pid: process.pid,
    port,
    token,
    dbPath: DatabasePath,
    channel: InstallationChannel,
    startedAt: new Date().toISOString(),
    ...(externalUrl ? { externalUrl } : {}),
  }
  const tmp = getLockPath() + ".tmp"
  await Bun.write(tmp, JSON.stringify(lock, null, 2))
  await rename(tmp, getLockPath())
  return token
}

export async function read(): Promise<ServerLock | undefined> {
  const raw = await Bun.file(getLockPath()).text().catch(() => undefined)
  if (!raw) return
  try {
    return JSON.parse(raw) as ServerLock
  } catch {
    return undefined
  }
}

export async function clear() {
  await rm(getLockPath(), { force: true }).catch(() => undefined)
}

// Only remove the lock if its token matches — prevents a slave TUI or a
// restarted server from deleting a lock it no longer owns.
export async function clearIfOwner(token: string) {
  const lock = await read()
  if (lock?.token !== token) return
  await clear()
}

// Works on all platforms:
// - ESRCH  → process does not exist → dead
// - EPERM  → no permission to signal but process exists (Windows) → alive
// - no err → process exists → alive
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code !== "ESRCH"
  }
}

export async function ping(port: number) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(500),
    })
    return resp.ok
  } catch {
    return false
  }
}

export * as ServerLock from "./server-lock"

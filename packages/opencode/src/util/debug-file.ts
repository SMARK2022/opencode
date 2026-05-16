import { appendFile, mkdir } from "fs/promises"
import path from "path"

// Keep debug output next to the command invocation instead of using a fixed
// machine-local path.  The daemon inherits the TUI cwd, so this is the user's
// project directory when opencode is launched normally.
const logPath = path.join(process.cwd(), "opencode.log")
let dirReady = false
let pending = ""
let scheduled = false

function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack }
    }
    if (typeof item === "string" && item.length > 2_000) return item.slice(0, 2_000) + `...<${item.length} chars>`
    return item
  })
}

function drain() {
  if (!pending) return
  const buf = pending
  pending = ""
  scheduled = false
  appendFile(logPath, buf, "utf8").catch(() => {})
}

export function debugLog(source: string, event: string, data?: unknown) {
  try {
    if (!dirReady) {
      dirReady = true
      mkdir(path.dirname(logPath), { recursive: true }).catch(() => {})
    }
    pending += json({ time: new Date().toISOString(), pid: process.pid, source, event, data }) + "\n"
    if (!scheduled) {
      scheduled = true
      queueMicrotask(drain)
    }
  } catch {
    // Debug logging must never affect product behavior.
  }
}

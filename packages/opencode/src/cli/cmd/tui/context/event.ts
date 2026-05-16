import type { Event } from "@opencode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import path from "path"

const normalizedDirectory = new Map<string, string>()

function normalizeDirectory(value: string) {
  const cached = normalizedDirectory.get(value)
  if (cached) return cached

  const resolved = path.resolve(AppFileSystem.windowsPath(value))
  const root = path.parse(resolved).root
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved
  // This runs for every streamed event, so keep it pure and cached. Calling
  // AppFileSystem.resolve() here would hit realpathSync on Windows and block
  // rendering during high-frequency message updates.
  const result = process.platform === "win32" ? trimmed.toLowerCase() : trimmed
  normalizedDirectory.set(value, result)
  return result
}

function sameDirectory(a?: string, b?: string) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    // Server events and TUI state can carry equivalent Windows paths with
    // different slash/case/realpath spelling. Normalize before filtering so
    // valid daemon updates are not dropped by a string-form mismatch.
    return normalizeDirectory(a) === normalizeDirectory(b)
  } catch {
    return a === b
  }
}

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      if (event.payload.type === "server.connected") {
        handler(event.payload)
        return
      }

      // Special hack for truly global events
      if (event.directory === "global") {
        handler(event.payload)
        return
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) handler(event.payload)
        return
      }

      if (sameDirectory(event.directory, project.instance.directory())) handler(event.payload)
    })
  }

  function on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void) {
    return subscribe((event) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>)
    })
  }

  return {
    subscribe,
    on,
  }
}

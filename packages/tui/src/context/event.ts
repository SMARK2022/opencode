import type { Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { useProject } from "./project"

const normalizedDirectory = new Map<string, string>()

function normalizeDirectory(value: string) {
  const cached = normalizedDirectory.get(value)
  if (cached) return cached

  const resolved = path.resolve(FSUtil.windowsPath(value))
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

type EventMetadata = {
  directory: string
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()
  const project = useProject()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // [local-smark] Handle server.connected event for daemon multi-instance
      if (event.payload.type === "server.connected") {
        handler(event.payload, { directory: event.directory ?? "global", workspace: event.workspace })
        return
      }

      if (event.directory === "global") {
        handler(event.payload, { directory: event.directory, workspace: event.workspace })
        return
      }

      if (event.project && project.project()) {
        if (event.project === project.project()) handler(event.payload, { directory: event.directory, workspace: event.workspace })
        return
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) handler(event.payload, { directory: event.directory, workspace: event.workspace })
        return
      }

      if (sameDirectory(event.directory, project.instance.directory())) {
        handler(event.payload, { directory: event.directory, workspace: event.workspace })
      }
    })
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    on,
  }
}

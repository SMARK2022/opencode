import type { Event } from "@opencode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

function sameDirectory(a?: string, b?: string) {
  if (!a || !b) return false
  try {
    // Server events and TUI state can carry equivalent Windows paths with
    // different slash/case/realpath spelling. Normalize before filtering so
    // valid daemon updates are not dropped by a string-form mismatch.
    const left = AppFileSystem.resolve(a)
    const right = AppFileSystem.resolve(b)
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
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
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) {
          handler(event.payload)
        }

        return
      }

      if (sameDirectory(event.directory, project.instance.directory())) {
        handler(event.payload)
      }
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

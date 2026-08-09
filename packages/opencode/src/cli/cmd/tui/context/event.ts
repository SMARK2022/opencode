import type { Event } from "@opencode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import path from "path"
import { useRoute } from "./route"

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

type EventMetadata = {
  workspace: string | undefined
}

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()
  const route = useRoute()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // [local-smark] Handle server.connected event for daemon multi-instance
      if (event.payload.type === "server.connected") {
        handler(event.payload, { workspace: event.workspace })
        return
      }

      if (event.directory === "global") {
        handler(event.payload, { workspace: event.workspace })
        return
      }

      // lsp.updated 只表示“当前 route 需要重拉”，不携带可渲染状态；跨 Project
      // 放行后仍由 SyncProvider 按 active Session 请求和过滤，不能在这里丢失通知。
      if (event.payload.type === "lsp.updated") {
        handler(event.payload, { workspace: event.workspace })
        return
      }

      if (event.project) {
        const activeSessionID = route.data.type === "session" ? route.data.sessionID : undefined
        const eventSessionID =
          "sessionID" in event.payload.properties ? event.payload.properties.sessionID : undefined
        // Session route 是当前可见运行的权威 owner；启动 Project 不能吞掉跨路径打开的 Session 事实。
        // 没有 Session ID 的 VCS/LSP 等事件继续保持原 Project 隔离，禁止把全局流无条件放宽。
        // 明确排除 undefined 相等，避免 home route 意外接收其他 Project 的非 Session 事件。
        // 该分支只负责 admission；消息、Part、Prompt 和 Revert 的实际状态仍由各自 projection owner处理。
        if (event.project === project.project() || (activeSessionID !== undefined && eventSessionID === activeSessionID))
          handler(event.payload, { workspace: event.workspace })
        return
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) handler(event.payload, { workspace: event.workspace })
        return
      }

      if (sameDirectory(event.directory, project.instance.directory())) handler(event.payload, { workspace: event.workspace })
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

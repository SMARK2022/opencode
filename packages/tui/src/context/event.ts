import type { Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import path from "path"

const normalizedDirectory = new Map<string, string>()

// 高频目录比较只做纯路径归一并缓存，不调用 realpath 阻塞流式渲染。
function normalizeDirectory(value: string) {
  const cached = normalizedDirectory.get(value)
  if (cached) return cached

  const resolved = path.resolve(value.replaceAll("/", path.sep))
  const root = path.parse(resolved).root
  // 保留盘符根，仅去掉普通目录多余的尾部分隔符。
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved
  const result = process.platform === "win32" ? trimmed.toLowerCase() : trimmed
  normalizedDirectory.set(value, result)
  return result
}

export function sameDirectory(a?: string, b?: string) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    // Windows 不区分大小写，其他平台保留原有大小写语义。
    return normalizeDirectory(a) === normalizeDirectory(b)
  } catch {
    return a === b
  }
}

// 保留源目录比较入口；当前广播不增加目录过滤，作用域仍由既有消费者处理。

type EventMetadata = {
  directory: string
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      handler(event.payload, { directory: event.directory, workspace: event.workspace })
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

import type { Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import { useProject } from "./project"
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


// #164：全局 directory 事件始终投递（重连/跨实例广播）
// #164/#165：显式 project 字段必须匹配当前项目，防止共享 daemon SSE 跨项目泄漏
export function shouldDeliverScopedEvent(
  event: { directory?: string; project?: string },
  currentProject?: string,
) {
  // #164：global 目录事件无条件放行
  if (event.directory === "global") return true
  // #165：有 project 时只匹配当前 project，不回退 workspace
  if (event.project) return event.project === currentProject
  return true
}

export function useEvent() {
  const sdk = useSDK()
  // 插件可在异步回调中订阅；在 hook 创建时捕获 context，投递时仍读取当前项目。
  const project = useProject()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // 重连通知始终投递，其余事件只在一次主分发前检查项目归属。
      if (event.payload.type !== "server.connected" && !shouldDeliverScopedEvent(
        { directory: event.directory, project: (event as { project?: string }).project },
        project.project(),
      )) return
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

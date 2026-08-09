import type { Event } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import { useProject } from "./project"
import { useRoute } from "./route"
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
// #570：活动 Session 是投递的第二权威 owner——project 不匹配但事件 sessionID 等于
// route 活动会话时仍投递；无 Session ID 的 VCS/LSP 等事件继续保持 Project 隔离，
// 禁止把全局流无条件放宽。该判定只管 admission，projection 仍由各自 owner 处理。
export function shouldDeliverScopedEvent(
  event: { directory?: string; project?: string; sessionID?: string },
  currentProject?: string,
  activeSessionID?: string,
) {
  // #164：global 目录事件无条件放行
  if (event.directory === "global") return true
  // #165：有 project 时只匹配当前 project，不回退 workspace
  if (event.project) {
    if (event.project === currentProject) return true
    // #570：明确排除 undefined 相等，避免 home route 意外接收其他 Project 的非 Session 事件。
    // 跨 Project 资格只由「活动会话 ID 与事件 sessionID 同时非空且相等」构成，无其它兑底分支。
    return activeSessionID !== undefined && event.sessionID === activeSessionID
  }
  return true
}

export function useEvent() {
  const sdk = useSDK()
  // 插件可在异步回调中订阅；在 hook 创建时捕获 context，投递时仍读取当前项目。
  const project = useProject()
  // #570：Session route 是当前可见运行的权威 owner；启动 Project 不能吞掉跨路径打开的 Session 事实。
  const route = useRoute()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // 重连通知始终投递，其余事件只在一次主分发前检查项目归属。
      const activeSessionID = route.data.type === "session" ? route.data.sessionID : undefined
      // 每次投递读取route与顶层Session ID，不缓存订阅时身份或猜测第二身份源。
      const eventSessionID = "sessionID" in event.payload.properties
        ? typeof event.payload.properties.sessionID === "string"
          ? event.payload.properties.sessionID
          : undefined
        : undefined
      if (event.payload.type !== "server.connected" && !shouldDeliverScopedEvent(
        { directory: event.directory, project: (event as { project?: string }).project, sessionID: eventSessionID },
        project.project(), activeSessionID,
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

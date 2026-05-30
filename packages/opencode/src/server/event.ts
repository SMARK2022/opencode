import { Schema } from "effect"
import { ServerEvent } from "@opencode-ai/schema/server-event"

// 主动停机与普通 dispose 共用事件，以原因字段通知客户端正常退出。
export const DisposedReason = {
  DaemonStop: "daemon-stop",
} as const

export const Event = ServerEvent

export const InstanceDisposed = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })

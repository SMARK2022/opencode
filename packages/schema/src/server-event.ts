export * as ServerEvent from "./server-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

export const Connected = Event.define({ type: "server.connected", schema: {} })
// 主动停机原因属于事件 wire 契约，普通 dispose 仍允许空载荷。
export const Disposed = Event.define({ type: "global.disposed", schema: { reason: optional(Schema.String) } })

export const Definitions = Event.inventory(Connected, Disposed)

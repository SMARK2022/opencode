import { SessionV2 } from "@/v2/session"
import { Effect, Layer } from "effect"
import { layer as v2LocationLayer } from "../groups/v2/location"
import { messageHandlers } from "./v2/message"
import { modelHandlers } from "./v2/model"
import { providerHandlers } from "./v2/provider"
import { sessionHandlers } from "./v2/session"

// v2 的服务依赖进共享应用图；handler/router 仍按 listener 本地构建。
// 动态 import 避免 handler 模块与 app-runtime 形成顶层模块循环。
const v2Services = Layer.unwrap(
  Effect.promise(async () => {
    const { sharedLayer } = await import("@/effect/app-runtime")
    return sharedLayer(Layer.mergeAll(v2LocationLayer, SessionV2.defaultLayer))
  }),
)

export const v2Handlers = Layer.mergeAll(sessionHandlers, messageHandlers, modelHandlers, providerHandlers).pipe(
  Layer.provide(v2Services),
)

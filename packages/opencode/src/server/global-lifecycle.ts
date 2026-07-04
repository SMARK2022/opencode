import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Event } from "./event"

const log = Log.create({ service: "server" })

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.warn("global disposal failed", { cause })
              }),
            ),
          )
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

// auth 变更后刷新所有实例的 Provider 缓存（不销毁实例、不杀会话）。
// 仅失效 Provider.Service 的 ScopedCache，不触碰 SessionRunState 等其他服务。
// 发 global.disposed 通知客户端刷新 provider 列表（空 properties，非 DaemonStop）。
// 失败仅告警不阻断——auth 已写入文件，下次访问会惰性重建。
export const refreshProviderCaches = Effect.fn("Server.refreshProviderCaches")(function* () {
  const provider = yield* Provider.Service
  yield* provider.invalidateAll().pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.warn("provider cache refresh failed", { cause })),
    ),
  )
  yield* emitGlobalDisposed
})

export * as GlobalLifecycle from "./global-lifecycle"

import { Context, Effect, Layer, Scope } from "effect"

export interface Interface {
  readonly acquire: Effect.Effect<void, never, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ServerEventClients") {}

// 一个 daemon 创建一次，再注入内部/外部 listener；计数不是模块全局状态。
export function make(onChange?: (count: number) => void): Interface {
  let count = 0
  return Service.of({
    // acquisition 延迟到流的 scope，构造 Response 本身不能被视为客户端连接。
    // 先登记 release 再通知 callback；通知抛错也不能泄漏刚计入的订阅。
    acquire: Effect.acquireRelease(
      Effect.sync(() => {
        count++
      }),
      () =>
        Effect.sync(() => {
          // 正常结束、编码失败与取消共用 finalizer，每次 acquisition 只减一次。
          count--
          onChange?.(count)
        }),
    ).pipe(Effect.tap(() => Effect.sync(() => onChange?.(count)))),
  })
}

// 普通 standalone server 也提供相同服务；无 daemon callback 时不改变退出策略。
export const layer = Layer.sync(Service, () => make())

// 服务由路由 Layer 提供，handler 不从 process 属性或隐式全局 registry 读取状态。
export * as EventClients from "./event-clients"

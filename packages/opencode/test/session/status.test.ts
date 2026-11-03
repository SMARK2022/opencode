import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// #554：SessionStatus 是 daemon 内按 Session ID 的全局观察注册表——LayerNode 组装其真实 node 依赖（EventV2Bridge）。
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

// 跨目录快照回归：producer 目录写入 busy，observer 目录（另一真实 InstanceRef）必须仍能观察到；
// idle 后全局快照删除该 entry。若 directory-local InstanceState 回归，observer 将看到假 idle。
it.instance("shares active status by session ID across directory contexts", () =>
  Effect.gen(function* () {
    const source = yield* TestInstance
    const observer = yield* tmpdirScoped()
    const status = yield* SessionStatus.Service
    const sessionID = SessionID.make("ses_cross_directory_status")

    yield* status.set(sessionID, { type: "busy" })

    // 两个真实 InstanceRef 模拟 producer 与新连接 TUI，验证观察身份不再由路径切分。
    const snapshot = yield* provideInstance(observer)(status.list())
    expect(snapshot.get(sessionID)).toEqual({ type: "busy" })
    expect(yield* provideInstance(observer)(status.get(sessionID))).toEqual({ type: "busy" })

    // retry与busy共享精确Session身份；list返回副本，调用方清空快照不能修改owner。
    yield* provideInstance(observer)(
      status.set(sessionID, { type: "retry", attempt: 2, next: Date.now() + 1000, message: "controlled retry" }),
    )
    expect(yield* provideInstance(source.directory)(status.get(sessionID))).toMatchObject({ type: "retry", attempt: 2 })
    snapshot.clear()
    expect((yield* status.list()).has(sessionID)).toBe(true)

    yield* provideInstance(source.directory)(status.set(sessionID, { type: "idle" }))
    // idle 必须删除 active entry，避免全局快照退化成历史 Session 表。
    expect((yield* provideInstance(observer)(status.list())).has(sessionID)).toBe(false)
  }),
)

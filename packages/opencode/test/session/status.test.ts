import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

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

    yield* provideInstance(source.directory)(status.set(sessionID, { type: "idle" }))
    // idle 必须删除 active entry，避免全局快照退化成历史 Session 表。
    expect((yield* provideInstance(observer)(status.list())).has(sessionID)).toBe(false)
  }),
)

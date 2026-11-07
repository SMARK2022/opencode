import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "@/permission"
import { PermissionReviewer } from "@/permission/reviewer/service"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { SessionID, MessageID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

const it = testEffect(LayerNode.compile(LayerNode.group([
  Permission.node, EventV2Bridge.node, Config.node, InstanceStore.node, CrossSpawnSpawner.node,
]), [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
  [Config.node, TestConfig.layer()],
]))

it.instance("one execute approval is reused at the same risk and isolated from later executes", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service
  const starts: string[] = []
  const completed: string[] = []
  // 观察真正的审批事件，而非替身函数次数；事件必须归属于父 execute。
  const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
    if (event.type === Permission.Event.ReviewStarted.type) starts.push(Schema.decodeUnknownSync(Permission.Event.ReviewStarted.data)(event.data).permission)
    if (event.type === Permission.Event.ReviewCompleted.type) completed.push(Schema.decodeUnknownSync(Permission.Event.ReviewCompleted.data)(event.data).outcome)
  }))
  yield* Effect.addFinalizer(() => unsubscribe)
  const sessionID = SessionID.descending()
  const tool = { messageID: MessageID.ascending(), callID: "execute-review" }
  // 子调用的权限事实仍来自 bash，review 归属则必须保持父 execute 的真实身份。
  const ruleset = [{ permission: "*", pattern: "*", action: "auto" as const }]
  const request = (command: string) => ({ permission: "bash", patterns: [command], always: [], metadata: { command, cwd: instance.directory, shell: "bash" } })
  const code = 'await tools.$opencode.bash({command:"git push origin one"}); await tools.$opencode.bash({command:"git push origin two"});'
  const input = { sessionID, tool, ruleset, agent: "build", code,
    calls: [{ tool: "bash", input: { command: "git push origin one" } }, { tool: "bash", input: { command: "git push origin two" } }],
    stop: (reason: Error) => { throw reason } }
  const review = { review: (input: Parameters<PermissionReviewer.Interface["review"]>[0]) => Effect.sync(() => {
    expect(input.tool).toEqual(tool)
    expect(input.metadata.code).toBe(code)
    return { action: "allow" as const, reason: "authorized test action", reviewID: input.reviewID, risk_level: "medium" as const, user_authorization: "high" as const }
  }) }
  yield* Effect.gen(function* () {
    const scope = yield* permission.beginExecute(input)
    // 预跑已经观察到两条谨慎调用，实际请求复用这一次整段审批。
    expect(starts).toEqual(["execute"])
    yield* scope.ask({ ...request("git push origin one"), sessionID, tool, ruleset })
    yield* scope.ask({ ...request("git push origin two"), sessionID, tool, ruleset })
    expect(starts).toEqual(["execute"])
    expect(completed).toEqual(["allow"])
    // 同 Session 的下一段代码拥有新的审批寿命，不能借用上一段的批准。
    const next = yield* permission.beginExecute(input)
    expect(starts).toEqual(["execute", "execute"])
    yield* next.ask({ ...request("git push origin one"), sessionID, tool, ruleset })
    expect(starts).toEqual(["execute", "execute"])
    expect(completed).toEqual(["allow", "allow"])
  }).pipe(Effect.provideService(PermissionReviewer.Service, review))
}))

it.instance("execute raises approval only for higher risk and keeps forbidden terminal", () => Effect.gen(function* () {
  // 先 cautious 后 dangerous 再回 cautious，能抓住将上界误降到最近一次风险的实现。
  const instance = yield* TestInstance
  const permission = yield* Permission.Service
  const levels: string[] = []
  const stopped: Error[] = []
  const context = { sessionID: SessionID.descending(), tool: { messageID: MessageID.ascending(), callID: "execute-levels" },
    ruleset: [{ permission: "*", pattern: "*", action: "auto" as const }] }
  const request = (command: string) => ({ ...context, permission: "bash", patterns: [command], always: [], metadata: { command, cwd: instance.directory, shell: "bash" } })
  yield* Effect.gen(function* () {
    // 只向权限入口交事实；真实高危命令从未交给 Shell 执行。
    const scope = yield* permission.beginExecute({ ...context,
      code: "dynamic composition", calls: [], agent: "build", stop: (error) => { stopped.push(error) } })
    yield* scope.ask(request("git push origin main"))
    yield* scope.ask(request("shutdown -h now"))
    yield* scope.ask(request("git push origin next"))
    expect(levels).toEqual(["cautious", "dangerous"])
    // 在同一 scope 再提交安全请求，验证终局拒绝封住后续接纳而非只拒绝当前调用。
    expect(Exit.isFailure(yield* scope.ask(request("rm -rf /")).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* scope.ask(request("pwd")).pipe(Effect.exit))).toBe(true)
    expect(stopped.length).toBeGreaterThan(0)
  }).pipe(Effect.provideService(PermissionReviewer.Service, { review: (input) => Effect.sync(() => {
    levels.push(input.precheck.level)
    return { action: "allow" as const, reason: "fixture", reviewID: input.reviewID, risk_level: "high" as const, user_authorization: "high" as const }
  }) }))
}))

it.instance("strict execute reviews the initial general scope once", () => Effect.gen(function* () {
  // ruleset=allow 与 strict 同时存在，确保普通规则放行不会伪造本次整体批准。
  const permission = yield* Permission.Service
  const levels: string[] = []
  yield* Effect.gen(function* () {
    const scope = yield* permission.beginExecute({ sessionID: SessionID.descending(), tool: { messageID: MessageID.ascending(), callID: "execute-strict" },
      code: "return 1", calls: [], ruleset: [{ permission: "*", pattern: "*", action: "allow" }], agent: "build", stop: (error) => { throw error } })
    yield* scope.ready()
    // 等待入口只观察当前审批；strict 的首次审查不会因此再被发起。
    expect(levels).toEqual(["general"])
  }).pipe(
    Effect.provideService(Config.Service, TestConfig.make({ get: () => Effect.succeed({ permission: { auto_review: { strict: true } } }) })),
    Effect.provideService(PermissionReviewer.Service, { review: (input) => Effect.sync(() => {
      levels.push(input.precheck.level)
      return { action: "allow" as const, reason: "fixture", reviewID: input.reviewID, risk_level: "low" as const, user_authorization: "high" as const }
    }) }),
  )
}))

it.instance("one human approval satisfies both AUTO routing and explicit parent ask", () => Effect.gen(function* () {
  const permission = yield* Permission.Service
  const sessionID = SessionID.descending()
  const tool = { messageID: MessageID.ascending(), callID: "execute-parent-ask" }
  // user reviewer 是既有路由，父 execute 的显式 ask 应消费同一次人工批准。
  const pending = yield* permission.beginExecute({ sessionID, tool, code: "git push fixture", calls: [], agent: "build",
    ruleset: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "execute", pattern: "*", action: "ask" }],
    stop: () => {},
  }).pipe(Effect.provideService(Config.Service, TestConfig.make({ get: () => Effect.succeed({ permission: {
    approvals_reviewer: "user", auto_review: { strict: true },
  } }) })), Effect.forkScoped)
  const request = yield* pollWithTimeout(permission.list().pipe(Effect.map((items) => items[0])), "parent approval not presented")
  expect(request.tool).toEqual(tool)
  yield* permission.reply({ requestID: request.id, reply: "once" })
  // 只回复一次；多弹一次窗会使 join 保持等待，而非伪造第二次自动回复。
  yield* awaitWithTimeout(Fiber.join(pending), "duplicate parent approval", "2 seconds")
  expect(yield* permission.list()).toEqual([])
}))

it.instance("explicit child ask remains separate from whole-script AUTO approval", () => Effect.gen(function* () {
  // 先完成无风险父批准，再让叶子显式 ask；它们是两个不同授权渠道。
  const permission = yield* Permission.Service
  const events = yield* EventV2Bridge.Service
  const asked = yield* Deferred.make<PermissionV1.Request>()
  const unsubscribe = yield* events.listen((event) => event.type === Permission.Event.Asked.type
    ? Deferred.succeed(asked, Schema.decodeUnknownSync(Permission.Event.Asked.data)(event.data)).pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => unsubscribe)
  const sessionID = SessionID.descending()
  const tool = { messageID: MessageID.ascending(), callID: "execute-ask" }
  const scope = yield* permission.beginExecute({ sessionID, tool, code: "read fixture", calls: [],
    ruleset: [{ permission: "*", pattern: "*", action: "allow" }], agent: "build", stop: (error) => { throw error } })
  const pending = yield* scope.ask({ sessionID, tool: { ...tool, callID: "execute-ask/1" }, permission: "read", patterns: ["note.txt"], always: [], metadata: {},
    ruleset: [{ permission: "read", pattern: "*", action: "ask" }] }).pipe(Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  // 等真实 Asked 事件再回复，既验证身份，也避免测试先回复尚未登记的请求。
  expect(request.tool?.callID).toBe("execute-ask/1")
  expect(request.permission).toBe("read")
  yield* permission.reply({ requestID: request.id, reply: "once" })
  yield* Fiber.join(pending)
  // 完成后观察公开 pending 列表，确保询问 Deferred 的生命周期已经收尾。
  expect(yield* permission.list()).toEqual([])
  // race 败方撤销的是未获执行机会的申请；用户从未拒绝父脚本。
  const canceled = yield* scope.ask({ sessionID, tool, permission: "read", patterns: ["next.txt"], always: [], metadata: {},
    ruleset: [{ permission: "read", pattern: "*", action: "ask" }] }).pipe(Effect.forkScoped)
  yield* pollWithTimeout(permission.list().pipe(Effect.map((items) => items[0])), "child approval not presented")
  yield* Fiber.interrupt(canceled)
  expect(Exit.isSuccess(yield* scope.ready().pipe(Effect.exit))).toBe(true)
  expect(yield* permission.list()).toEqual([])
}))

it.instance("whole-script denial stops a queued tool before its body", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const permission = yield* Permission.Service
  const reviewing = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const entered = yield* Deferred.make<void>()
  const context = { sessionID: SessionID.descending(), tool: { messageID: MessageID.ascending(), callID: "execute-wait" },
    ruleset: [{ permission: "*", pattern: "*", action: "auto" as const }] }
  yield* Effect.gen(function* () {
    const scope = yield* permission.beginExecute({ ...context, code: "queued composition", calls: [], agent: "build", stop: () => {} })
    // 原分类器只分析命令；该测试的唯一真实效果是等待之后的自有临时文件。
    const pending = yield* scope.ask({ ...context, permission: "bash", patterns: ["git push"], always: [],
      metadata: { command: "git push", shell: "bash", cwd: instance.directory },
    }).pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(reviewing)
    const queued = yield* Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      yield* scope.ready()
      yield* Effect.promise(() => Bun.write(`${instance.directory}/blocked.txt`, "unexpected"))
    }).pipe(Effect.exit, Effect.forkScoped)
    // 用真实待审状态与队列到达事件同步，拒绝后再等待两条链的最终结算。
    yield* Deferred.await(entered)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(true)
    // 即使工具本身没有 ctx.ask，整体拒绝也必须先于它的业务效果。
    expect(yield* Effect.promise(() => Bun.file(`${instance.directory}/blocked.txt`).exists())).toBe(false)
  }).pipe(Effect.provideService(PermissionReviewer.Service, { review: (input) => Effect.gen(function* () {
    yield* Deferred.succeed(reviewing, undefined)
    yield* Deferred.await(release)
    return { action: "deny", reason: "fixture denied", reviewID: input.reviewID, risk_level: "medium", user_authorization: "low" }
  }) }))
}))

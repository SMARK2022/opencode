import { describe, expect, test } from "bun:test"
// 用宿主控制原因与就绪门闩观察公开行为，不能用超时或私有状态冒充中断证据。
import { Cause, Deferred, Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

// Wave 5 acceptance suite: first-class promise values. Un-awaited tool calls start eagerly on
// supervised fibers, `await` settles them, and Promise.all/allSettled/race/resolve/reject are
// ordinary functions over arbitrary arrays mixing promises and plain values.

type Trace = {
  starts: Array<number>
  active: number
  maxActive: number
  completed: number
  interrupted: number
}

const makeTrace = (): Trace => ({ starts: [], active: 0, maxActive: 0, completed: 0, interrupted: 0 })

/** Echoes `id` after `ms` milliseconds, recording start order, live concurrency, and interruption. */
const sleepyTool = (trace: Trace) =>
  Tool.make({
    description: "Echo an id after a delay",
    input: Schema.Struct({ id: Schema.Number, ms: Schema.optionalKey(Schema.Number) }),
    output: Schema.Number,
    run: ({ id, ms }) =>
      Effect.gen(function* () {
        trace.starts.push(id)
        trace.active += 1
        trace.maxActive = Math.max(trace.maxActive, trace.active)
        yield* Effect.sleep(ms ?? 20)
        trace.active -= 1
        trace.completed += 1
        return id
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            trace.active -= 1
            trace.interrupted += 1
          }),
        ),
      ),
  })

const failingTool = Tool.make({
  description: "Always refuse",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.fail(toolError("Lookup refused")),
})

const run = (
  code: string,
  options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {},
): Promise<CodeMode.Result> => {
  const trace = options.trace ?? makeTrace()
  return Effect.runPromise(
    CodeMode.execute({
      tools: { host: { sleepy: sleepyTool(trace), fail: failingTool } },
      code,
      ...(options.limits ? { limits: options.limits } : {}),
    }),
  )
}

const value = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const error = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("first-class promise values", () => {
  test("an un-awaited tool call starts eagerly, in call order, before any await", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const a = tools.host.sleepy({ id: 1, ms: 40 })
        const b = tools.host.sleepy({ id: 2, ms: 40 })
        const rb = await b
        const ra = await a
        return [ra, rb]
      `,
      { trace },
    )
    expect(result).toEqual([1, 2])
    expect(trace.starts).toEqual([1, 2])
    // Both calls overlapped even though they were awaited sequentially.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("awaiting the same promise twice settles once and never re-runs the call", async () => {
    const result = await run(`
      const p = tools.host.sleepy({ id: 7 })
      const x = await p
      const y = await p
      return [x, y]
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([7, 7])
    expect(result.toolCalls).toStrictEqual([{ name: "host.sleepy" }])
  })

  test("await of a non-promise value is a passthrough no-op", async () => {
    expect(await value(`return await 42`)).toBe(42)
    expect(await value(`const x = await "s"; return x`)).toBe("s")
    expect(await value(`return await null`)).toBeNull()
    expect(await value(`return (await [1, 2]).length`)).toBe(2)
  })

  test("returning an un-awaited tool call resolves it (async-function return semantics)", async () => {
    expect(await value(`return tools.host.sleepy({ id: 9 })`)).toBe(9)
  })

  test("typeof a promise is 'object', and console.log renders it sensibly", async () => {
    const result = await run(`
      const p = Promise.resolve(1)
      console.log(p)
      return typeof p
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("object")
    expect(result.logs).toStrictEqual(["[Promise (await it to get its value)]"])
  })

  test("an awaited failure is catchable exactly like a synchronous throw", async () => {
    expect(
      await value(`
      const p = tools.host.fail({})
      try {
        await p
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a fire-and-forget call is interrupted when execution ends", async () => {
    // 检查真实挂起调用的清理记录，返回done不能掩盖仍在后台运行的工作。
    const trace = makeTrace()
    const result = await value(
      `
        tools.host.sleepy({ id: 1, ms: 30 })
        return "done"
      `,
      { trace },
    )
    expect(result).toBe("done")
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a never-awaited failure does not replace the explicit execution result", async () => {
    const result = await value(`
      tools.host.fail({})
      return "done"
    `)
    expect(result).toBe("done")
  })
})

describe("promises at data boundaries", () => {
  test("returning an un-awaited promise inside data is a clear await-hinting diagnostic", async () => {
    const diagnostic = await error(`return { result: tools.host.sleepy({ id: 1 }) }`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await tools.ns.tool(...)")
  })

  test("passing an un-awaited promise as a tool argument is a clear diagnostic", async () => {
    const diagnostic = await error(`return await tools.host.sleepy({ id: tools.host.sleepy({ id: 1 }) })`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("JSON.stringify of a promise is a diagnostic, not '{}'", async () => {
    const diagnostic = await error(`return JSON.stringify(Promise.resolve(1))`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("operators reject promise operands", async () => {
    const diagnostic = await error(`return Promise.resolve(1) + 1`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
  })
})

describe("Promise.all over arbitrary arrays", () => {
  test("mixes promises and plain values, preserving order", async () => {
    expect(
      await value(`
      return await Promise.all([tools.host.sleepy({ id: 1 }), "plain", tools.host.sleepy({ id: 2 }), 42])
    `),
    ).toEqual([1, "plain", 2, 42])
  })

  test("accepts arrays built beforehand, passed as identifiers, and spread elements", async () => {
    expect(
      await value(`
      const calls = []
      calls.push(tools.host.sleepy({ id: 1 }))
      calls.push(7)
      const more = [tools.host.sleepy({ id: 2 })]
      const batch = [...calls, ...more, "x"]
      return await Promise.all(batch)
    `),
    ).toEqual([1, 7, 2, "x"])
  })

  test("runs items.map tool calls in parallel", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = [1, 2, 3, 4]
        return await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 40 })))
      `,
      { trace },
    )
    expect(result).toEqual([1, 2, 3, 4])
    // maxActive counts truly-overlapping live executions, so > 1 proves real
    // parallelism deterministically - no wall-clock assertion needed.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("caps live tool-call concurrency at the fixed internal constant (8)", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = []
        for (let i = 0; i < 20; i += 1) ids.push(i)
        const results = await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 10 })))
        return results.length
      `,
      { trace },
    )
    expect(result).toBe(20)
    expect(trace.maxActive).toBeGreaterThan(1)
    expect(trace.maxActive).toBeLessThanOrEqual(8)
  })

  test("resolves the empty array", async () => {
    expect(await value(`return await Promise.all([])`)).toEqual([])
  })

  test("rejects with the first failure, catchable in-program", async () => {
    expect(
      await value(`
      try {
        await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.fail({})])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a non-collection argument is a clear error", async () => {
    const diagnostic = await error(`return await Promise.all(42)`)
    expect(diagnostic.message).toContain("Promise.all expects an array")
  })

  test("exceeding maxToolCalls inside Promise.all is a ToolCallLimitExceeded diagnostic", async () => {
    const diagnostic = await error(
      `return await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.sleepy({ id: 2 }), tools.host.sleepy({ id: 3 })])`,
      { limits: { maxToolCalls: 2 } },
    )
    expect(diagnostic.kind).toBe("ToolCallLimitExceeded")
  })
})

describe("Promise.allSettled", () => {
  test("reports fulfilled and rejected outcomes with catch-normalized reasons", async () => {
    expect(
      await value(`
      return await Promise.allSettled([
        tools.host.sleepy({ id: 5 }),
        tools.host.fail({}),
        "plain",
        Promise.reject(new Error("boom")),
      ])
    `),
    ).toEqual([
      { status: "fulfilled", value: 5 },
      { status: "rejected", reason: { name: "Error", message: "Lookup refused" } },
      { status: "fulfilled", value: "plain" },
      { status: "rejected", reason: { name: "Error", message: "boom" } },
    ])
  })

  test("never rejects for program-level failures", async () => {
    const result = await run(`
      const settled = await Promise.allSettled([tools.host.fail({}), tools.host.fail({})])
      return settled.filter((s) => s.status === "rejected").length
    `)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(2)
  })

  for (const wrap of [false, true])
    test(`a later ${wrap ? "async" : "direct"} host interruption is not hidden by a pending first member`, async () => {
      // 就绪信号保证前项确实已挂起；后项发出控制中断，不能等全局超时替它解围。
      const started = Deferred.makeUnsafe<void>()
      let cleaned = false
      const exit = await Effect.runPromise(
        CodeMode.execute({
          tools: {
            wait: Tool.make({
              description: "Wait for cancellation",
              input: Schema.Struct({}),
              run: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      cleaned = true
                    }),
                  ),
                ),
            }),
            stop: Tool.make({
              description: "Interrupt after first member starts",
              input: Schema.Struct({}),
              run: () => Deferred.await(started).pipe(Effect.andThen(Effect.interrupt)),
            }),
          },
          limits: { timeoutMs: 100 },
          code: `return await Promise.allSettled([tools.wait({}), ${wrap ? "(async () => await tools.stop({}))()" : "tools.stop({})"}])`,
        }).pipe(Effect.exit),
      )
      // Exit 失败且原因只有中断，排除 TimeoutExceeded 诊断或伪造 rejected 数据。
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(cleaned).toBe(true)
    })
})

describe("Promise.race", () => {
  test("execute exit interrupts pending race members", async () => {
    // 此断言在整个 Execute 返回后检查清理，与上文败方可继续等待的合同分开。
    const trace = makeTrace()
    const result = await value(
      `
        const fast = tools.host.sleepy({ id: 1, ms: 10 })
        const slow = tools.host.sleepy({ id: 2, ms: 5000 })
        return await Promise.race([fast, slow])
      `,
      { trace },
    )
    expect(result).toBe(1)
    expect(trace.interrupted).toBe(1)
    expect(trace.completed).toBe(1)
  })

  for (const wrap of [false, true])
    test(`a losing ${wrap ? "async function" : "tool"} remains awaitable`, async () => {
      // race 只竞争结算；保留原 Promise 再等待，才能区分选出赢家与结束整段执行。
      const trace = makeTrace()
      expect(
        await value(
          `
      const slow = ${wrap ? "(async () => await tools.host.sleepy({ id: 2, ms: 10 }))()" : "tools.host.sleepy({ id: 2, ms: 10 })"}
      const winner = await Promise.race([slow, "first"])
      return [winner, await slow]
    `,
          { trace },
        ),
      ).toEqual(["first", 2])
      expect(trace.completed).toBe(1)
      expect(trace.interrupted).toBe(0)
    })

  test("a losing rejection retains its original reason", async () => {
    // 被另一项抢先结算不应把后续业务失败改写为执行器制造的取消错误。
    expect(
      await value(`
      const slow = (async () => { await tools.host.sleepy({ id: 1 }); throw "original" })()
      const winner = await Promise.race([slow, "first"])
      return [winner, await Promise.allSettled([slow])]
    `),
    ).toEqual(["first", [{ status: "rejected", reason: "original" }]])
  })

  test("shared and duplicate members keep one producer across races", async () => {
    // 两个组合器共享同一 Promise；第一个的完成不得使第二个失去仍需要的结果。
    const trace = makeTrace()
    expect(
      await value(
        `
      const shared = tools.host.sleepy({ id: 7 })
      const first = Promise.race([shared, "first"])
      const second = Promise.race([shared, shared])
      return [await first, await second, await shared]
    `,
        { trace },
      ),
    ).toEqual(["first", 7, 7])
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a rejection can win the race", async () => {
    expect(
      await value(`
      try {
        await Promise.race([tools.host.fail({}), tools.host.sleepy({ id: 1, ms: 5000 })])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a plain value wins over pending promises", async () => {
    const trace = makeTrace()
    expect(
      await value(`return await Promise.race([tools.host.sleepy({ id: 1, ms: 5000 }), "immediate"])`, { trace }),
    ).toBe("immediate")
    expect(trace.interrupted).toBe(1)
  })

  test("an empty race stays pending until the execution timeout", async () => {
    // 空集合没有赢家，沿既有执行超时退出，而不是额外生成脚本可捕获的错误。
    expect(await error("return await Promise.race([])", { limits: { timeoutMs: 30 } })).toMatchObject({
      kind: "TimeoutExceeded",
    })
  })

  test("a pending empty race can lose to an outer value", async () => {
    // 只检查空 race 超时会漏掉“已拒绝但未观察”的实现，嵌套组合锁定 pending 身份。
    expect(
      await value('const pending = Promise.race([]); return [typeof pending, await Promise.race([pending, "done"])]'),
    ).toEqual(["object", "done"])
  })
})

describe("Promise.resolve / Promise.reject", () => {
  test("resolve wraps plain values and passes promises through", async () => {
    expect(await value(`return await Promise.resolve(42)`)).toBe(42)
    expect(await value(`return await Promise.resolve(Promise.resolve("nested"))`)).toBe("nested")
    expect(await value(`return await Promise.resolve(tools.host.sleepy({ id: 3 }))`)).toBe(3)
  })

  test("reject produces a promise whose await throws the reason", async () => {
    expect(
      await value(`
      try {
        await Promise.reject("nope")
        return "no"
      } catch (e) {
        return e
      }
    `),
    ).toBe("nope")
  })
})

describe("timeout interruption of forked calls", () => {
  test("the execution timeout interrupts in-flight forked fibers", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const a = tools.host.sleepy({ id: 1, ms: 60000 })
        const b = tools.host.sleepy({ id: 2, ms: 60000 })
        return await a
      `,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    // Both calls started; neither escaped the timeout - the awaited one AND the abandoned one.
    expect(trace.starts).toEqual([1, 2])
    expect(trace.interrupted).toBe(2)
    expect(trace.completed).toBe(0)
  })

  test("the timeout also interrupts calls inside Promise.all", async () => {
    const trace = makeTrace()
    const result = await run(
      `return await Promise.all([tools.host.sleepy({ id: 1, ms: 60000 }), tools.host.sleepy({ id: 2, ms: 60000 })])`,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    expect(trace.interrupted).toBe(2)
  })
})

describe("unsupported promise surface", () => {
  test(".then/.catch/.finally give a clear await-instead error", async () => {
    for (const method of ["then", "catch", "finally"]) {
      const diagnostic = await error(`return tools.host.sleepy({ id: 1 }).${method}((x) => x)`)
      expect(diagnostic.kind).toBe("UnsupportedSyntax")
      expect(diagnostic.message).toContain(`Promise.prototype.${method} is not supported`)
      expect(diagnostic.message).toContain("await")
    }
  })

  test("other property reads on a promise hint at the missing await", async () => {
    const diagnostic = await error(`return tools.host.sleepy({ id: 1 }).value`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await it first")
  })

  test("unknown Promise statics list what is available", async () => {
    const diagnostic = await error(`return await Promise.any([tools.host.sleepy({ id: 1 })])`)
    expect(diagnostic.message).toContain("Promise.any is not available")
    expect(diagnostic.message).toContain("Promise.allSettled")
  })

  test("new Promise(...) points at tool calls instead", async () => {
    const diagnostic = await error(`return new Promise((resolve) => resolve(1))`)
    expect(diagnostic.kind).toBe("UnsupportedSyntax")
    expect(diagnostic.message).toContain("new Promise(...) is not supported")
    expect(diagnostic.message).toContain("already return promises")
  })
})

describe("async function composition", () => {
  test.each(["async function f() { return 7 }", "const f = async function () { return 7 }", "const f = async () => 7"])(
    "keeps async identity for %s",
    async (declaration) => {
      // 三种语法共享函数值契约，不能只修 map 或箭头回调这一条入口。
      expect(await value(`${declaration}; const p = f(); return [p instanceof Promise, await p, await p]`)).toEqual([
        true,
        7,
        7,
      ])
      // 同步函数仍交付原值，不应为了统一调度强迫所有调用者增加 await。
      expect(await value("function f() { return 7 }; return f()")).toBe(7)
    },
  )

  test("settles body and parameter failures without throwing from invocation", async () => {
    // 原始无工具复现隔离了解释器故障，排除宿主工具失败传播的干扰。
    expect(
      await value('const p = (async () => { throw new Error("probe") })(); return await Promise.allSettled([p])'),
    ).toEqual([{ status: "rejected", reason: { name: "Error", message: "probe" } }])
    // 参数默认值也属于 async 调用，绑定失败不能提前逃出 Promise。
    expect(
      await value(
        'const fail = () => { throw "default" }; async function f(x = fail()) { return x }; return await Promise.allSettled([f()])',
      ),
    ).toEqual([{ status: "rejected", reason: "default" }])
    // 捕获后再抛仍保持原始原因，不得用默认成功值掩盖真实失败。
    expect(
      await value(
        'async function f() { try { await Promise.reject("inner") } catch (e) { throw e } }; return await Promise.allSettled([f()])',
      ),
    ).toEqual([{ status: "rejected", reason: "inner" }])
  })

  test("yields at await while keeping the synchronous prefix eager", async () => {
    // 即使等待普通值，caller 也应先得到控制权；不依赖工具延迟制造顺序。
    expect(
      await value(
        'const order=[]; const p=(async()=>{order.push("before"); await 1; order.push("after")})(); order.push("caller"); await p; return order',
      ),
    ).toEqual(["before", "caller", "after"])
    // 两个挂起帧交错恢复时，外层词法变量仍然是同一个共享绑定。
    expect(
      await value(
        "const order=[]; const p=(async()=>{order.push(1); await 0; order.push(2)})(); const q=(async()=>{order.push(3); await 0; order.push(4)})(); await p; order.push(5); await q; return order",
      ),
    ).toEqual([1, 3, 2, 4, 5])
  })

  test("runs multi-step async callbacks concurrently with isolated locals and shared closures", async () => {
    const trace = makeTrace()
    // 共享 counter 与每次调用独有的 local 同时受测，避免并发修复靠复制闭包偷换语义。
    const result = await value(
      `let counter=0; const jobs=[1,2,3].map(async id => {
      const local=await tools.host.sleepy({id,ms:10}); counter++;
      return await tools.host.sleepy({id:local+10,ms:10});
    }); return {results:await Promise.all(jobs),counter}`,
      { trace },
    )
    expect(result).toEqual({ results: [11, 12, 13], counter: 3 })
    // 活跃工具数量证明实际重叠，不用总耗时阈值把慢 CI 误判为语义回归。
    expect(trace.maxActive).toBeGreaterThan(1)
    expect(trace.active).toBe(0)
  })

  test("adopts returned promises without taking tool permits for wrapper functions", async () => {
    const trace = makeTrace()
    // 嵌套 helper 与组合器不能占用八个工具许可，否则批次会自锁。
    expect(
      await value(
        "async function inner(id) { return tools.host.sleepy({id}) }; async function outer(id) { return inner(id) }; return (await Promise.all(Array.from({length:20}).map((_,id)=>outer(id)))).length",
        { trace },
      ),
    ).toBe(20)
    expect(trace.maxActive).toBeGreaterThan(1)
    expect(trace.maxActive).toBeLessThanOrEqual(8)
    // 返回容器不是递归 await；其中工具 Promise 必须仍能在函数结束后被调用者收取。
    expect(
      await value("async function f() { return [tools.host.sleepy({id:7})] }; return await Promise.all(await f())"),
    ).toEqual([7])
  })

  test("keeps async callback values visible to ordinary collection contracts", async () => {
    // filter 不拥有异步筛选协议，Promise 对象保持真值；map 的调用者才选择如何等待。
    expect(await value("return [1,2].filter(async () => false)")).toEqual([1, 2])
    // 普通数据出口仍拒绝未等待 Promise，修复不能泄漏解释器内部对象。
    expect((await error("return {value:(async()=>7)()}")).kind).toBe("InvalidDataValue")
  })
})

describe("composable promise combinators", () => {
  test.each(["all", "allSettled", "race"])("Promise.%s returns a reusable promise", async (method) => {
    // 观察必须由 await 驱动消费，组合器调用本身不能提前返回数组或抛出成员错误。
    expect(await value(`const p=Promise.${method}([7]); return [p instanceof Promise, await p, await p]`)).toEqual(
      method === "allSettled"
        ? [true, [{ status: "fulfilled", value: 7 }], [{ status: "fulfilled", value: 7 }]]
        : method === "all"
          ? [true, [7], [7]]
          : [true, 7, 7],
    )
    // 非法集合在组合结果上拒绝，外层 allSettled 仍有机会接收失败。
    expect(await value(`const p=Promise.${method}(42); return (await Promise.allSettled([p]))[0].status`)).toBe(
      "rejected",
    )
  })

  test("nested combinator rejection reaches allSettled", async () => {
    // 此例不依赖工具，用原生 Promise 组合习惯直接捕获此前同步抛错的根因。
    expect(await value('const p=Promise.all([Promise.reject("probe")]); return await Promise.allSettled([p])')).toEqual(
      [{ status: "rejected", reason: "probe" }],
    )
  })

  test("all rejects before an earlier blocked call and leaves that call awaitable", async () => {
    const gate = Deferred.makeUnsafe<void>()
    // 等待项只能在 catch 后释放，旧的按索引等待实现必然超时，不靠碰运气的延迟排序。
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          host: {
            wait: Tool.make({
              description: "Wait for release",
              input: Schema.Struct({}),
              output: Schema.String,
              run: () => Deferred.await(gate).pipe(Effect.as("released")),
            }),
            fail: failingTool,
            release: Tool.make({
              description: "Release waiter",
              input: Schema.Struct({}),
              output: Schema.Boolean,
              run: () => Deferred.succeed(gate, undefined),
            }),
          },
        },
        code: "const p=tools.host.wait({}); try { await Promise.all([p,tools.host.fail({})]) } catch(e) { await tools.host.release({}) }; return await p",
        // 期限仅防止红灯永久挂起；成功条件是因果释放，而不是更快的墙钟时间。
        limits: { timeoutMs: 1000 },
      }),
    )
    expect(result).toMatchObject({ ok: true, value: "released" })
  })

  test.each([
    'try { await Promise.all([tools.host.sleepy({id:1,ms:20}),tools.host.fail({})]) } catch(e) {} return "done"',
    "return await Promise.all([tools.host.sleepy({id:1,ms:20}),tools.host.fail({})])",
    '(async()=>{await tools.host.sleepy({id:1,ms:20}); await tools.host.sleepy({id:2})})(); return "done"',
  ])("execution owns abandoned work after %s", async (code) => {
    const trace = makeTrace()
    // 宿主 fiber 在 execute 返回后继续存活，避免外层结束或 timeout 替错误清理实现兜底。
    await Effect.runPromise(
      CodeMode.execute({ tools: { host: { sleepy: sleepyTool(trace), fail: failingTool } }, code }).pipe(
        // 故意越过工具完成时刻以检测晚到副作用，而不是等待某个并发阶段就绪。
        Effect.andThen(Effect.sleep(40)),
      ),
    )
    expect(trace.starts).toEqual([1])
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
    expect(trace.active).toBe(0)
  })

  test("timeout and host interruption cannot become allSettled success", async () => {
    const trace = makeTrace()
    // async 包装和 allSettled 都不能把执行终止降级为可继续写入的业务结果。
    const result = await run(
      "return await Promise.allSettled([1,2].map(async id => await tools.host.sleepy({id,ms:60000})))",
      { trace, limits: { timeoutMs: 50 } },
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
    expect(trace.interrupted).toBe(2)
    // 宿主中断在真实工具 seam 发出，验证错误归一化没有吞掉执行控制信号。
    const exit = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          stop: Tool.make({
            description: "Interrupt execution",
            input: Schema.Struct({}),
            run: () => Effect.interrupt,
          }),
        },
        code: "return await Promise.allSettled([(async()=>await tools.stop({}))()])",
      }).pipe(Effect.exit),
    )
    expect(exit._tag).toBe("Failure")
  })
})

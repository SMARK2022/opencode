import { describe, expect, test } from "bun:test"
// 用宿主控制原因与就绪门闩观察公开行为，不能用超时或私有状态冒充中断证据。
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CodeMode, Tool, toolError } from "../src/index.js"

// 未await的工具调用也立即启动并受执行作用域监管；await消费结算结果。
// all/allSettled/race接受混合数组，resolve/reject把普通值或拒绝原因转为Promise。

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
    // 同时保留结果与回执，才能发现catch正常取到错误消息、父结果却仍误报未观察失败的情况。
    const result = await run(`
      const p = tools.host.fail({})
      try {
        await p
        return "no"
      } catch (e) {
        return e.message
      }
    `)
    expect(result).toMatchObject({ ok: true, value: "Lookup refused" })
    // catch已消费工具拒绝，成功结果中连提醒字段都不应出现，不能仅把它写成false。
    expect(result).not.toHaveProperty("unobservedFailure")
  })

  test("a fire-and-forget call is interrupted when execution ends", async () => {
    // 检查真实挂起调用的清理记录，返回done不能掩盖仍在后台运行的工作。
    const trace = makeTrace()
    const result = await run(
      `
        tools.host.sleepy({ id: 1, ms: 30 })
        return "done"
      `,
      { trace },
    )
    expect(result).toMatchObject({ ok: true, value: "done", unobservedFailure: true })
    // 完成数为0、中断数为1排除工具自然结束；此处的提醒专门来自根退出取消的未观察工作。
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
  })

  test("a never-awaited failure does not replace the explicit execution result", async () => {
    // 与上例被取消的等待不同，这里工具立即拒绝；两类未观察失败都保留显式返回的done。
    const result = await run(`
      tools.host.fail({})
      return "done"
    `)
    expect(result).toMatchObject({ ok: true, value: "done", unobservedFailure: true })
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
    // allSettled把两次拒绝转成可读结果，计数为2同时证明它实际消费了两项，而非直接返回空成功。
    expect(result).not.toHaveProperty("unobservedFailure")
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
              // 后项必须等前项发布启动信号再中断；按数组顺序只等首项的错误实现会停在never上。
              run: () => Deferred.await(started).pipe(Effect.andThen(Effect.interrupt)),
            }),
          },
          // 100ms只是防止错误实现挂死；下方要求宿主中断Exit，单纯触发执行超时不会满足断言。
          limits: { timeoutMs: 100 },
          code: `return await Promise.allSettled([tools.wait({}), ${wrap ? "(async () => await tools.stop({}))()" : "tools.stop({})"}])`,
        }).pipe(Effect.exit),
      )
      // Exit 失败且原因只有中断，排除 TimeoutExceeded 诊断或伪造 rejected 数据。
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      // 控制中断传播正确还不足以证明首项退出，清理标记单独检查被阻塞工具的真实收尾。
      expect(cleaned).toBe(true)
    })
})

describe("Promise.race", () => {
  test("execute exit interrupts pending race members", async () => {
    // 10ms的赢家触发根返回，5秒的败方仍在等待；这里只检查根退出清理，下一例检查race内部复用。
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

  test("shared and duplicate members keep one producer across races", async () => {
    // race 只观察同一 async 生产者；跨组合器复用并再次 await，验证不会取消或重放底层工具。
    const trace = makeTrace()
    expect(
      await value(
        `
      const shared = (async () => await tools.host.sleepy({ id: 7 }))()
      const first = Promise.race([shared, "first"])
      const second = Promise.race([shared, shared])
      return [await first, await second, await shared]
    `,
        { trace },
      ),
    ).toEqual(["first", 7, 7])
    // 第一个race被普通值抢先结算，第二个含重复成员；完成一次且零中断才排除重放或误取消共享生产者。
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

// 未等待的 Promise 仍是句柄；读取业务字段应提示等待，不能误判为宿主工具失败。
describe("unsupported promise surface", () => {
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
    // 结果11、12、13分别依赖每个回调自己的local；counter为3要求外层绑定仍共享，结束后active清零。
    expect(trace.active).toBe(0)
  })

  test("factory closures outlive their call frames and share only their own bindings", async () => {
    // 工厂返回后局部绑定仍存活；两次工厂调用不能共用一份计数器，旧闭包也不能被深复制。
    expect(
      // first的两次同步前缀依次取得2和3，second独立取得11；跨await返回各自mine可暴露局部帧串用。
      await value(`
      function factory(n) { let count = n; return async () => {
        count++; const mine = count; await tools.host.sleepy({ id: mine }); return mine;
      } }
      const first = factory(1), second = factory(10);
      return await Promise.all([first(), second(), first()]);
    `),
    ).toEqual([2, 11, 3])
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
    // 20个双层helper必须只按最底层工具计并发；上界8保留工具限流，下界大于1排除串行代替。
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
    // 组合器会立即观察成员；调用者先拿到 Promise，消费它时才收到结果数组或成员拒绝。
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
              // wait的成功值只能在release打开门闩后产生，任何提前取消或伪造完成都会改变最终返回值。
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
    // all先拒绝才进catch释放门闩，最后再次await首项得到released，连起快速拒绝与败方仍可继续两项合同。
    expect(result).toMatchObject({ ok: true, value: "released" })
  })

  test("an uncaught combinator failure cleans pending work before returning", async () => {
    const trace = makeTrace()
    // 成功返回已有基线覆盖；这里保留失败根的真实清理，并让宿主继续存活观察迟到副作用。
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { sleepy: sleepyTool(trace), fail: failingTool } },
        code: "return await Promise.all([tools.host.sleepy({id:1,ms:20}),tools.host.fail({})])",
      }).pipe(Effect.tap(() => Effect.sleep(40))),
    )
    expect(result.ok).toBe(false)
    // 40ms宿主观察窗超过工具原本的20ms延迟；已启动、未完成且中断一次排除返回后仍执行的迟到工作。
    expect(trace.starts).toEqual([1])
    expect(trace.completed).toBe(0)
    expect(trace.interrupted).toBe(1)
    expect(trace.active).toBe(0)
  })
})

// 二十次提交固定验证八个准入槽；取消后保留父作用域，释放门闩也不能复活排队工作。
const queuedCode = `const calls=Array.from({length:20}).map((_,id)=>tools.work({id})); search({query:"work"}); return await Promise.all(calls)`

for (const cancel of [false, true])
  test(`20-call admission and cleanup: cancel=${cancel}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const allSubmitted = yield* Deferred.make<void>()
        const ninth = yield* Deferred.make<void>()
        // 每项独立门闩允许只释放第0项；共用门闩无法证明一个空槽只准入一个排队调用。
        const gates = yield* Effect.forEach(Array.from({ length: 20 }), () => Deferred.make<void>())
        const starts: number[] = []
        let active = 0,
          peak = 0,
          cleaned = 0
        const fiber = yield* CodeMode.execute({
          code: queuedCode,
          tools: {
            work: Tool.make({
              description: "Gate",
              input: Schema.Struct({ id: Schema.Number }),
              run: ({ id }) =>
                Effect.gen(function* () {
                  starts.push(id)
                  active++
                  peak = Math.max(peak, active)
                  // 第九个真实run发布信号，测试据此等待许可交接，避免yield一次就猜测排队任务已启动。
                  if (starts.length === 9) yield* Deferred.succeed(ninth, undefined)
                  yield* Deferred.await(gates[id])
                  return id
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active--
                      cleaned++
                    }),
                  ),
                ),
            }),
          },
          onToolCallStart: (call) =>
            call.name === "$codemode.search"
              ? Deferred.succeed(allSubmitted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        }).pipe(Effect.forkChild)
        // search 位于二十次提交之后且不占许可；收到它的回调才证明剩余十二项已经排队。
        yield* Deferred.await(allSubmitted)
        expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        if (cancel) {
          yield* Fiber.interrupt(fiber)
          expect(starts).toHaveLength(8)
          // 十二项尚未进入run，因此只有已启动的八项执行finalizer；取消排队项不能虚增清理计数。
          expect(cleaned).toBe(8)
          expect(active).toBe(0)
          // 根结束后继续释放全部阻塞点，排队请求仍不得复活或产生迟到副作用。
          yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined))
          yield* Effect.yieldNow
          expect(starts).toHaveLength(8)
          return
        }
        yield* Deferred.succeed(gates[0], undefined)
        yield* Deferred.await(ninth)
        // 单独释放首个槽位，只允许第九个真实调用进入，证明不是批次等待屏障。
        expect(starts).toHaveLength(9)
        expect(active).toBe(8)
        yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined))
        expect(yield* Fiber.join(fiber)).toMatchObject({ ok: true, value: Array.from({ length: 20 }, (_, i) => i) })
        // 返回值按提交序号排列，峰值与清理数另外约束准入和资源回收，不能用正确数组掩盖超额并发。
        expect(peak).toBe(8)
        expect(cleaned).toBe(20)
        expect(active).toBe(0)
      }),
    )
  })

// 虚拟时钟跨过一千毫秒排队期；十毫秒叶子预算只能在拿到许可后开始计时。
test("queue time does not consume a leaf-owned timeout", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const allSubmitted = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const starts: number[] = []
      const fiber = yield* CodeMode.execute({
        code: queuedCode,
        tools: {
          work: Tool.make({
            description: "Leaf budget",
            input: Schema.Struct({ id: Schema.Number }),
            run: ({ id }) =>
              Effect.gen(function* () {
                starts.push(id)
                if (id < 8) yield* Deferred.await(release)
                // 后十二项各用5ms工作和10ms叶子超时；它们先排队1000ms，成功只可能因超时从获得许可后才开始。
                else yield* Effect.sleep(5).pipe(Effect.timeout(10))
                return id
              }),
          }),
        },
        onToolCallStart: (c) =>
          c.name === "$codemode.search" ? Deferred.succeed(allSubmitted, undefined).pipe(Effect.asVoid) : Effect.void,
      }).pipe(Effect.forkChild)
      yield* Deferred.await(allSubmitted)
      // 先确认二十项都已提交再推进时钟，后排确实经历了远长于10ms的许可等待。
      yield* TestClock.adjust(1000)
      expect(starts).toHaveLength(8)
      yield* Deferred.succeed(release, undefined)
      // 释放首批后推进20ms足够后续两个批次各跑5ms；结果仍要逐项完整，不能把超时项当成空成功。
      yield* TestClock.adjust(20)
      expect(yield* Fiber.join(fiber)).toMatchObject({ ok: true, value: Array.from({ length: 20 }, (_, i) => i) })
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

// sleep 与工具共用根 Scope；这里只检查计时器特有的真实取消回调，不重复宿主退出矩阵。
test("sleep releases its timer when the execution ends", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* Clock.Clock
      let live = 0
      let disposed = 0
      const observed = {
        // Clock 可能是类实例，显式转交方法而不展开丢失原型。
        currentTimeMillis: base.currentTimeMillis,
        currentTimeNanos: base.currentTimeNanos,
        currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
        currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
        sleep: (duration: Parameters<typeof base.sleep>[0]) => {
          // 只拦截脚本指定的长等待，运行时自身的调度计时继续使用原 Clock。
          if (Duration.toMillis(duration) !== 123456) return base.sleep(duration)
          // 这个替代计时器永不自行完成，只注册与释放；根返回后disposed增加只能来自取消回调。
          return Effect.callback<void>(() => {
            live++
            return Effect.sync(() => {
              live--
              disposed++
            })
          })
        },
      }
      const result = yield* CodeMode.execute({ code: "sleep(123456); return 1" }).pipe(
        Effect.provideService(Clock.Clock, observed),
      )
      expect(result).toMatchObject({ ok: true, value: 1 })
      expect(live).toBe(0)
      // 仅检查 live=0 会让完全没注册计时器的实现通过；释放次数证明它确实创建并收尾。
      expect(disposed).toBe(1)
    }),
  )
})

// 睡眠不占用宿主槽、调用预算或回执；八个正在运行的工具不能阻止计时器前进。
test("sleep progresses with eight occupied host permits and no receipt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let started = 0
      // 八个工具的门闩从不释放；sleep若也等宿主许可，脚本无法到达return，重复await还检查同一计时器可复用。
      const result = yield* CodeMode.execute({
        code: `Array.from({length: 8}).map(() => tools.wait({}));
        const p = sleep(0); await p; await p; return 1`,
        limits: { maxToolCalls: 8 },
        tools: {
          wait: Tool.make({
            description: "Hold slot",
            input: Schema.Struct({}),
            run: () =>
              Effect.sync(() => {
                started++
              }).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        },
      })
      expect(result).toMatchObject({ ok: true, value: 1 })
      expect(started).toBe(8)
      // 八次工具调用已用尽预算；sleep 若被计作第九次调用，业务结果就无法成功。
      expect(result.toolCalls).toHaveLength(8)
    }),
  )
})

// 隐式 next/终止/关闭都必须让出；循环体新建任务能观察 break/return/throw 的关闭顺序。
test("for-await suspends on values, termination and abrupt completion", async () => {
  // expected 来自原生 for-await 的让出规则；marker 区分迭代本身的等待与循环体 await。
  for (const [input, tail, expected] of [
    ["[1,2]", "", ["caller", 1, "marker", 2, "marker", "done", "finally"]],
    ["[Promise.resolve(1)]", "", ["caller", 1, "marker", "done", "finally"]],
    ['[Promise.reject("bad")]', "", ["caller", "bad", "finally"]],
    // 空迭代器也要等待第一次next结果，caller必须先出现；这条把迭代终止的让出与循环体等待分开。
    ["[]", "", ["caller", "done", "finally"]],
    ["[1,2]", "continue", ["caller", 1, "marker", 2, "marker", "done", "finally"]],
    ["[1,2]", "break", ["caller", 1, "marker", "done", "finally"]],
    // return跳过done但仍执行finally；marker先于finally，检查提前关闭迭代器时仍会让出执行权。
    ["[1,2]", "return", ["caller", 1, "marker", "finally"]],
    ["[1,2]", 'throw "bad"', ["caller", 1, "marker", "bad", "finally"]],
  ] as const) {
    // mark只等待普通值，顺序来自解释器让出规则；没有宿主耗时差可以替错误调度制造预期顺序。
    const code = `
      const events = [];
      async function mark() { await 0; events.push("marker"); }
      async function run() {
        try {
          for await (const value of ${input}) { events.push(value); mark(); ${tail}; }
          events.push("done");
        } catch (error) { events.push(error); }
        finally { events.push("finally"); }
      }
      const task = run(); events.push("caller"); await task; return events;
    `
    expect(await Effect.runPromise(CodeMode.execute({ code }))).toMatchObject({
      ok: true,
      value: expected,
    })
  }
})

// 同步启动即取消时，Execute 必须等真实 finalizer 门闩释放。
for (const mode of ["direct", "snapshot"] as const) {
  test(`eager ${mode} cancellation waits for an asynchronously gated finalizer`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // entered定位工具已进入，cleaning定位清理已开始，release决定清理何时结束，三个阶段各有独立信号。
        const entered = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const environment = CodeMode.createEnvironment()
        // 先保存会修改根绑定的helper，snapshot分支取消时也覆盖保留闭包的副本绑定，而非仅复制裸变量。
        yield* CodeMode.execute({
          environment,
          code: "let count=0; async function helper(){count++; await tools.waiting({});} return 1;",
        })
        let cleaned = 0
        const waiting = Tool.make({
          description: "Publish actual entry before the eager producer is registered",
          input: Schema.Struct({}),
          output: Schema.Null,
          run: () =>
            Effect.acquireUseRelease(
              Effect.void,
              // 发布entered后永久挂起，使外部取消紧贴工具同步启动，不等自然完成或普通拒绝帮忙收尾。
              () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              () =>
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.sync(() => {
                      cleaned++
                    }),
                  ),
                ),
            ),
        })
        const running = yield* CodeMode.execute({
          environment,
          snapshotEnvironment: mode === "snapshot",
          tools: { waiting },
          code: mode === "direct" ? "count++; await tools.waiting({});" : "await helper();",
        }).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        // 中断动作自身也会等待finalizer，须另起fiber才能在释放清理门闩前观察running是否错误提前返回。
        const interrupting = yield* Fiber.interrupt(running).pipe(Effect.forkChild({ startImmediately: true }))
        // 清理入口已到达而释放门闩仍关闭，此时检查返回状态能定位根作用域是否过早结束。
        yield* Deferred.await(cleaning)
        const returnedBeforeRelease = running.pollUnsafe() !== undefined
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        const exit = yield* Fiber.await(running)
        expect(returnedBeforeRelease).toBe(false)
        // 释放后清理必须恰好完成一次；仅检查释放前未返回会漏掉永不清理或重复执行finalizer。
        expect(cleaned).toBe(1)
        // 最终仍是宿主控制中断，不能把等待清理包装成普通JS失败或成功结果。
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        // 两种模式共用取消路径，只有真实执行可留下count；副本取消也不能写回Notebook。
        expect(yield* CodeMode.execute({ environment, code: "return count;" })).toMatchObject({
          ok: true,
          value: mode === "snapshot" ? 0 : 1,
        })
      }),
    )
  })
}

// 已观察工具失败仍计入调用事实；通用提醒只反映未观察的拒绝。
test("immediate and mixed failures warn only when their outcome was not observed", async () => {
  for (const [code, unobserved] of [
    ['Promise.reject("ignored");', true],
    ['Promise.resolve("done");', false],
    ['try { await Promise.reject("caught"); } catch {}', false],
    ['await Promise.allSettled([Promise.reject("settled")]);', false],
    // 工具拒绝已捕获，但随后另一个async拒绝无人观察；提醒不能仅由工具回执或“曾有catch”决定。
    ['try { await tools.host.fail({}); } catch {} (async () => { throw "ignored"; })();', true],
  ] as const) {
    const result = await run(`${code} return "done";`)
    expect(result).toMatchObject({ ok: true, value: "done" })
    expect(result.ok && result.unobservedFailure === true).toBe(unobserved)
    // 对公开Result做JSON往返及schema解码，确认新增提醒能随持久化结果保留且不改变旧结果形状。
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toEqual(result)
  }
})

// 拒绝被门闩推迟到 race 选出普通值之后，才能区分“开始等待”与“实际收到失败”。
test("a cancelled race observer does not mark a later rejection observed", async () => {
  for (const observe of [false, true]) {
    const gate = Deferred.makeUnsafe<void>()
    let failures = 0
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          later: Tool.make({
            description: "Fail after release",
            input: Schema.Struct({}),
            run: () =>
              Deferred.await(gate).pipe(
                Effect.andThen(
                  // 计数紧贴实际拒绝发出的位置，门闩已打开但生产者未继续运行的情况不能冒充已产生失败。
                  Effect.sync(() => {
                    failures++
                  }),
                ),
                Effect.andThen(Effect.fail(toolError("Later refusal"))),
              ),
          }),
          release: Tool.make({
            description: "Release producer",
            input: Schema.Struct({}),
            run: () => Deferred.succeed(gate, undefined),
          }),
        },
        // 先等race选出普通值再释放工具；只有observe分支额外消费原Promise，两个分支的提醒应恰好相反。
        code: `const pending = tools.later({}); await Promise.race([pending, "done"]);
        await tools.release({}); ${observe ? "try { await pending; } catch {}" : ""} return "done";`,
      }),
    )
    expect(result).toMatchObject({ ok: true, value: "done", toolCalls: [{ name: "later" }, { name: "release" }] })
    expect(result.ok && result.unobservedFailure === true).toBe(!observe)
    // 两种分支都要真正产生同一次拒绝；否则无告警可能只是生产者被race提前取消。
    expect(failures).toBe(1)
  }
})

describe("promise chaining", () => {
  test("finally awaits cleanup and preserves or replaces the original settlement", async () => {
    // 清理返回值不替换原结果；抛出或拒绝才替换，且回调不接收原结果参数。
    expect(
      await value(
        `const out = []; const n = await Promise.resolve(4).finally((...args) => { out.push(args.length); return 99; }); return [n, out];`,
      ),
    ).toEqual([4, [0]])
    expect(
      await value(
        `const e = {n:1}; return Promise.reject(e).finally(async () => { await sleep(1); return 99; }).catch(x => x === e);`,
      ),
    ).toBe(true)
    expect(await value(`return Promise.resolve(4).finally(() => { throw {n:2}; }).catch(x => x.n);`)).toBe(2)
    expect(await value(`return Promise.reject(4).finally(() => Promise.reject(5)).catch(x => x);`)).toBe(5)
    // 非函数沿原合同透传；内建函数仍复用已有callback入口。
    expect(await value(`return Promise.resolve(4).finally(null).finally(String);`)).toBe(4)
  })

  test("batch catch recovers tool errors and then transforms successful results", async () => {
    expect(
      await value(`return await Promise.all([1,2,3].map(id => tools.host.fail({}).catch(() => id).then(x => x * 2)))`),
    ).toEqual([2, 4, 6])
    // 成功源不能误走拒绝处理器，99若出现就说明分支选择错误。
    expect(await value(`return tools.host.sleepy({id: 7}).catch(() => 99).then(x => x + 1)`)).toBe(8)
  })

  test("missing and non-function handlers preserve values and rejection identity", async () => {
    // 非函数handler须传递同一个拒绝值，不能重新包装后丢失对象身份。
    expect(await value(`const e = {n:3}; return await Promise.reject(e).then(null, 7).catch(x => x === e)`)).toBe(true)
    expect(await value(`return Promise.resolve(4).then().then(null).catch(7)`)).toBe(4)
    expect(await value(`return Promise.reject(5).then(undefined, x => x + 1)`)).toBe(6)
  })

  test("built-in handlers share the collection callback surface", async () => {
    // 这些调用走集合方法已有的callback边界，不能要求模型额外套箭头函数。
    expect(await value(`return Promise.resolve(4).then(String)`)).toBe("4")
    expect(await value(`return Promise.resolve("a b").then(encodeURIComponent)`)).toBe("a%20b")
    expect(await value(`return Promise.resolve(0).then(sleep).then(() => 7)`)).toBe(7)
  })

  test("callbacks adopt sync and async returned promises and callback exceptions", async () => {
    expect(
      await value(
        `return Promise.resolve(1).then(x => tools.host.sleepy({id:x+1})).then(async x => { await sleep(1); return x+1; })`,
      ),
    ).toBe(3)
    // 同步抛出和返回拒绝Promise都应交给后续catch，而不是提前从宿主抛出。
    expect(await value(`return Promise.resolve(1).then(() => { throw {n:7}; }).catch(e => e.n)`)).toBe(7)
    expect(await value(`return Promise.resolve(1).then(() => Promise.reject("bad")).catch(e => e)`)).toBe("bad")
    expect(await value(`return Promise.reject(1).catch(async () => {throw "again"}).catch(e => e)`)).toBe("again")
  })

  test("callback runs after current statement and direct self-resolution rejects", async () => {
    for (const method of ["then", "finally"]) {
      // 同步已结算和仍在途的源都保留同步前缀，finally不能借清理名义提前执行。
      for (const source of ["Promise.resolve(1)", "tools.host.sleepy({id:1})"]) {
        expect(
          await value(
            `const out = []; const p = ${source}.${method}(() => out.push("callback")); out.push("sync"); await p; return out;`,
          ),
        ).toEqual(["sync", "callback"])
      }
      // 等待链自身会永久挂起；两个入口共用原TypeError拒绝行为。
      expect(await value(`let p; p = Promise.resolve(1).${method}(() => p); return p.catch(e => e.name)`)).toBe(
        "TypeError",
      )
    }
  })

  test("independent chain callbacks keep separate frames and shared captured bindings", async () => {
    expect(
      await value(
        `let count=0; const out = await Promise.all([1,2,3].map(id => Promise.resolve(id).then(async x => { await sleep(1); count++; return x; }))); return {out,count};`,
      ),
      // 参数按各帧保留，外层count却由三个回调共享，二者必须同时成立。
    ).toEqual({ out: [1, 2, 3], count: 3 })
  })

  test("host interruption passes through chain handlers without invoking any", async () => {
    let invoked = false
    const exit = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          stop: Tool.make({ description: "stop", input: Schema.Struct({}), run: () => Effect.interrupt }),
          mark: Tool.make({
            description: "mark",
            input: Schema.Struct({}),
            run: () =>
              Effect.sync(() => {
                invoked = true
                return null
              }),
          }),
        },
        code: `return tools.stop({}).catch(() => tools.mark({})).then(undefined, () => tools.mark({})).finally(() => tools.mark({}));`,
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // 失败类别与handler副作用一起验证，避免把宿主取消降格为普通可恢复错误。
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(invoked).toBe(false)
  })

  test("retained chain methods use the current execution and preview copies their receiver", async () => {
    const environment = CodeMode.createEnvironment()
    expect(
      (
        await Effect.runPromise(
          CodeMode.execute({
            environment,
            tools: {},
            code: `const p = Promise.resolve({n:1}); const then = p.then; await p;`,
          }),
        )
      ).ok,
    ).toBe(true)
    expect(
      (
        await Effect.runPromise(
          CodeMode.execute({
            environment,
            snapshotEnvironment: true,
            tools: {},
            code: `await then(x => {x.n=9; return x;});`,
          }),
        )
      ).ok,
    ).toBe(true)
    // 已确认副本中的then真正运行；真实receiver仍为1才排除浅拷贝泄漏。
    const result = await Effect.runPromise(CodeMode.execute({ environment, tools: {}, code: `return then(x => x.n);` }))
    expect(result.ok && result.value).toBe(1)
  })
})

// await 回调与迭代共享 Promise 生命周期；这里同时覆盖取消穿透及逐项绑定。
describe("async standard-library callbacks and iteration", () => {
  // replace拥有既有async扩展；嵌套替换专门验证挂起期间保留外层匹配游标。
  test("nested async replacers keep independent output and preserve ordinary rejection", async () => {
    const echo = Tool.make({
      description: "Echo",
      input: Schema.String,
      output: Schema.String,
      run: (value) => Effect.succeed(value),
    })
    expect(
      await Effect.runPromise(
        CodeMode.execute({
          tools: { host: { echo } },
          // 外层连续匹配a、b，每次内层替换又await工具；AB同时检验外层游标与内层输出缓冲互不覆盖。
          code: 'return "ab".replace(/./g, async c => c.replace(/./g, async d => await tools.host.echo(d.toUpperCase())))',
        }),
      ),
    ).toMatchObject({ ok: true, value: "AB" })
    // 兼容扩展只负责等待 async 回调，用户抛出的普通错误仍走原 catch 语义。
    expect(
      await value(
        'try { return "ab".replace(/./g, async () => { throw new Error("replacer refused") }) } catch(e) { return e.message }',
      ),
    ).toBe("replacer refused")
  })

  test("host interruption in an async replacer cannot resume caught side effects", async () => {
    const later: string[] = []
    const stop = Tool.make({ description: "Stop", input: Schema.Struct({}), run: () => Effect.interrupt })
    const after = Tool.make({
      description: "After",
      input: Schema.Struct({}),
      run: () =>
        Effect.sync(() => {
          later.push("ran")
          return "wrong"
        }),
    })
    // 真正宿主取消不是可恢复的替换失败；后续工具效果和脚本伪成功都必须缺席。
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { stop, after } },
        code: 'try { return "ab".replace(/./g, async () => await tools.host.stop({})) } catch(e) { return await tools.host.after({}) }',
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    // Exit含中断仍可能夹带catch里的副作用，宿主later清单独立证明取消后没有继续调用after。
    expect(later).toEqual([])
  })

  // 内建令牌沿用函数的不透明边界，别名和集合回调只能返回受监管的 Promise。
  test("sleep aliases and callbacks retain callable identity without exposing global methods", async () => {
    expect(
      await value(`const pause = sleep; const box = { pause };
    await box.pause(0.25); await Promise.all([0, 0].map(pause));
    new Set([0]).forEach(pause); new Map([[0, 0]]).forEach(pause);
    async function nested() { await pause(0); return 3; }
    return [typeof pause, await nested(), await pause(0)];`),
    ).toEqual(["function", 3, null])
    // sleep可当回调传递但不暴露宿主函数属性；Math.abs的反例保留原有全局方法不可提取的限制。
    for (const code of [
      "return sleep.name",
      "return sleep.constructor",
      "return [1].map(Math.abs)",
      "return sleep.call(null, 0)",
    ]) {
      expect((await run(code)).ok).toBe(false)
    }
    // 非法参数必须在调用sleep时同步抛出，脚本未await仍能catch；样本同时约束类型、有限性与计时器上限。
    for (const arg of ['"0"', "undefined", "null", "NaN", "Infinity", "-1", "2147483648"]) {
      expect(await value(`try { sleep(${arg}); } catch (e) { return true; } return false`)).toBe(true)
    }
    // 上限是有限可取消计时器，不能为了测试等待二十四天；根返回负责取消它。
    expect(await value("sleep(2147483647); return 1")).toBe(1)
  })

  // 循环后才调用闭包，才能发现各次迭代错误复用同一Binding；continue分支也必须保留自己的值。
  test("for-await settles yielded promises and preserves sequential bodies and iteration bindings", async () => {
    expect(
      // out因continue跳过2，闭包仍各自保存1、2、3；assigned为4则覆盖复用外部变量的另一种绑定入口。
      await value(`const out = [], closures = [];
    for await (const [n] of [Promise.resolve([1]), [2], [3]]) {
      await sleep(0); closures.push(() => n); if (n === 2) continue; out.push(n);
    }
    let assigned = 0; for await (assigned of [Promise.resolve(4)]) {}
    return [out, closures.map(f => f()), assigned];`),
    ).toEqual([[1, 3], [1, 2, 3], 4])
    // Map产出的是条目数组，只等待最外层条目；其中的Promise值仍由循环体显式await。
    expect(
      // 字符串按码点产出emoji，Set逐项等待Promise，Map条目内的Promise保持身份，三个迭代域分别约束一层等待。
      await value(`const chars = []; for await (const c of "A😀") chars.push(c);
    const set = []; for await (const n of new Set([Promise.resolve(1), 2])) set.push(n);
    const pairs = []; for await (const [k, v] of new Map([["a", Promise.resolve(3)]]))
      pairs.push([k, v instanceof Promise, await v]);
    return [chars, set, pairs];`),
    ).toEqual([["A", "😀"], [1, 2], [["a", true, 3]]])
  })

  // 外层n在两次绑定失败后仍为7，区分循环帧正确释放与只返回了预期错误消息。
  test("for-await rejects before binding and cleans frames through destructuring and early exits", async () => {
    expect(
      // no而非body证明拒绝先于循环体，break只留下1，return取得9；两次失败后外层n仍为7。
      await value(`let n = 7; let caught = "";
    try { for await (const n of [Promise.reject("no")]) { throw "body"; } } catch (e) { caught = e; }
    try { for await (const [n = missing] of [[]]) {} } catch (e) {}
    const out = []; for await (const x of [1, 2, 3]) { if (x === 2) break; out.push(x); }
    async function first() { for await (const x of [Promise.resolve(9)]) return x; }
    return [n, caught, out, await first()];`),
    ).toEqual([7, "no", [1], 9])
    expect((await run("for await (const x of { a: 1 }) {} ")).ok).toBe(false)
  })
})

import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

// 从公开执行入口跨两次调用观察闭包；只复用目录的 make 不能满足这个状态合同。
test("an environment retains variables, functions and factory closures between cells", async () => {
  const environment = CodeMode.createEnvironment()
  // 同一实例的 make 也必须逐次构造执行上下文，不能用保留整个 runtime 冒充词法复用。
  const runtime = CodeMode.make({ environment })
  expect(
    await Effect.runPromise(
      runtime.execute(`
    let n = 1;
    function factory(start) { let value = start; return () => ++value; }
    const next = factory(10);
    const increment = () => ++n;
    return [increment(), next()];
  `),
    ),
  ).toMatchObject({ ok: true, value: [2, 11] })
  expect(await Effect.runPromise(runtime.execute("return [increment(), next(), n];"))).toMatchObject({
    ok: true,
    value: [3, 12, 3],
  })
})

// 新单元可替换顶层定义，但旧闭包要读到新绑定，不能把每个单元叠成永久遮蔽层。
test("new cells may redeclare top-level bindings while existing closures see the replacement", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  await Effect.runPromise(runtime.execute("let n = 1; const read = () => n; function helper() { return read(); }"))
  expect(
    await Effect.runPromise(runtime.execute("const n = 8; function helper() { return read() + 1; } return helper();")),
  ).toMatchObject({ ok: true, value: 9 })
  // 跨单元重新声明不是把 const 变成可赋值变量；同一单元的重复声明仍由原语法拒绝。
  expect(await Effect.runPromise(runtime.execute("n = 2;"))).toMatchObject({ ok: false })
  expect(await Effect.runPromise(runtime.execute("let duplicate = 1; let duplicate = 2;"))).toMatchObject({
    ok: false,
    error: { kind: "ParseError" },
  })
})

// 上一单元收尾造成的中断不能成为下一单元的控制信号，也不能继续保活宿主工作。
test("an interrupted producer is cleaned before return and rejects catchably in the next cell", async () => {
  let cleaned = false
  const environment = CodeMode.createEnvironment()
  const waiting = Tool.make({
    description: "Wait until execution ends",
    input: Schema.Struct({}),
    output: Schema.Null,
    run: () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cleaned = true
          }),
        ),
      ),
  })
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        tools: { waiting },
        code: "const pending = tools.waiting({}); return 1;",
      }),
    ),
  ).toMatchObject({ ok: true, value: 1 })
  expect(cleaned).toBe(true)
  const resumed = await Effect.runPromise(
    CodeMode.execute({
      environment,
      code: "try { await pending; } catch (error) { return error.message; }",
    }).pipe(Effect.exit),
  )
  expect(Exit.isSuccess(resumed)).toBe(true)
  if (Exit.isSuccess(resumed))
    expect(resumed.value).toMatchObject({
      ok: true,
      value: "Promise interrupted when its originating Execute ended.",
    })
})

// 缺省仍是一段一状态；显式环境不能泄漏给同一 make 的下一段或另一个环境。
test("omitted environments and separate environments remain isolated", async () => {
  const runtime = CodeMode.make()
  expect(await Effect.runPromise(runtime.execute("const local = 1; return local;"))).toMatchObject({ value: 1 })
  expect(await Effect.runPromise(runtime.execute("return typeof local;"))).toMatchObject({ value: "undefined" })
  const environment = CodeMode.createEnvironment()
  await Effect.runPromise(CodeMode.execute({ environment, code: "const retained = 2;" }))
  // 相同变量名不会把两个显式环境关联起来，宿主可同时持有互不影响的词法状态。
  expect(
    await Effect.runPromise(
      CodeMode.execute({ environment: CodeMode.createEnvironment(), code: "return typeof retained;" }),
    ),
  ).toMatchObject({ value: "undefined" })
})

// 保留的是解释器对象图，不是 JSON 副本；别名、Map 自环、正则游标都必须跨单元延续。
test("mutable supported values retain identity and state without serialization", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  expect(
    await Effect.runPromise(
      runtime.execute(`
    const object = { value: 1 }; const alias = object;
    const array = [object]; const append = array.push;
    const map = new Map(); map.set("self", map); map.set("object", object);
    const set = new Set([object]); const regex = /a/g; regex.exec("aaba");
    const date = new Date("2020-01-02T03:04:05.000Z");
    const url = new URL("https://example.test/?a=1"); const params = url.searchParams;
    return 1;
  `),
    ),
  ).toMatchObject({ ok: true, value: 1 })
  // URL 与 searchParams 是同一可变视图；保存的方法引用也须继续绑定原接收者。
  expect(
    await Effect.runPromise(
      runtime.execute(`
    alias.value = 4; append(9); params.set("a", "2");
    return [object === alias, array[0].value, array[1], map.get("self") === map,
      map.get("object") === object, set.has(alias), regex.exec("aaba").index,
      date.toISOString(), url.href, params === url.searchParams];
  `),
    ),
  ).toMatchObject({
    ok: true,
    value: [true, 4, 9, true, true, true, 1, "2020-01-02T03:04:05.000Z", "https://example.test/?a=2", true],
  })
})

// 函数局部仍归每次调用；跨单元保留工厂闭包不能把并发参数帧合并成一个共享栈。
test("nested async factories, defaults, block captures and recursion survive later cells", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  expect(
    await Effect.runPromise(
      runtime.execute(`
    const counters = await Promise.all([1, 10].map(async start => {
      let n = start; return (step = 1) => n += step;
    }));
    let local; { const hidden = 7; local = () => hidden; }
    function factorial(n) { return n < 2 ? 1 : n * factorial(n - 1); }
    return counters.map(counter => counter());
  `),
    ),
  ).toMatchObject({ ok: true, value: [2, 11] })
  expect(
    await Effect.runPromise(runtime.execute("return [counters[0](2), counters[1](), local(), factorial(5)];")),
  ).toMatchObject({ ok: true, value: [4, 12, 7, 120] })
})

// 编译失败不会执行前面的赋值；运行失败与返回值校验失败则不能回滚已经发生的状态变更。
test("parse errors preserve state while runtime and output failures keep completed changes", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  await Effect.runPromise(runtime.execute("let value = 1;"))
  expect(await Effect.runPromise(runtime.execute("value = 2; const broken = ;"))).toMatchObject({
    ok: false,
    error: { kind: "ParseError" },
  })
  expect(await Effect.runPromise(runtime.execute("return value;"))).toMatchObject({ value: 1 })
  expect(await Effect.runPromise(runtime.execute('value = 3; throw new Error("stop"); value = 4;'))).toMatchObject({
    ok: false,
  })
  expect(await Effect.runPromise(runtime.execute("const helper = () => value; return helper;"))).toMatchObject({
    ok: false,
  })
  // 返回函数违反数据出口合同，但函数定义本身已经执行，后续调用仍应可用。
  expect(await Effect.runPromise(runtime.execute("return helper();"))).toMatchObject({ ok: true, value: 3 })
})

// 超时只结束当前执行；已经完成的赋值保留，下一单元重新获得自己的超时与取消边界。
test("timeout preserves completed mutations and does not poison the next cell", async () => {
  const environment = CodeMode.createEnvironment()
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        limits: { timeoutMs: 5 },
        code: "let value = 6; const pending = Promise.race([]); await pending;",
      }),
    ),
  ).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
  expect(await Effect.runPromise(CodeMode.execute({ environment, code: "return value;" }))).toMatchObject({
    ok: true,
    value: 6,
  })
})

// 显式取消仍是 Effect 中断，JS catch 不能续跑；只在后续单元观察到已完成的状态。
test("current-cell host interruption stays uncatchable and cancellation retains completed changes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const environment = CodeMode.createEnvironment()
        const waiting = Tool.make({
          description: "Signal entry and wait",
          input: Schema.Struct({}),
          output: Schema.Null,
          run: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const running = yield* CodeMode.execute({
          environment,
          tools: { waiting },
          code: `
      let value = 5; try { await tools.waiting({}); } catch { value = 9; } value = 10;
    `,
        }).pipe(Effect.forkScoped)
        // 就绪门闩证明取消发生在赋值之后、宿主等待之中，不依赖调度时长猜测。
        yield* Deferred.await(ready)
        yield* Fiber.interrupt(running)
        const exit = yield* Fiber.await(running)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* CodeMode.execute({ environment, code: "return value;" })).toMatchObject({ ok: true, value: 5 })
      }),
    ),
  )
})

// 终态只保存业务值或沙箱抛值；重复观察不得重新执行工具，也不能破坏抛值的引用身份。
test("completed and rejected promises retain outcomes and thrown identity without replay", async () => {
  const environment = CodeMode.createEnvironment()
  const completion: string[] = []
  const echo = Tool.make({
    description: "Produce one result",
    input: Schema.Struct({}),
    output: Schema.Number,
    run: () =>
      Effect.sync(() => {
        completion.push("completed")
        return 7
      }),
  })
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        tools: { echo },
        code: `
    const reason = { message: "refused" }; const resolved = Promise.resolve(reason);
    const immediate = Promise.reject(reason); const rejected = (async () => { throw reason; })();
    const done = tools.echo({}); await Promise.allSettled([rejected, immediate]); return await done;
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: 7 })
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        code: `
    const results = await Promise.allSettled([rejected, immediate]);
    return [await done, await done, await resolved === reason, results[0].reason === reason, results[1].reason === reason];
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: [7, 7, true, true, true] })
  // 这里观察实际业务完成记录；多次 await 只是消费终态，不允许再次产生该业务事实。
  expect(completion).toEqual(["completed"])
})

// 私有 cause 只供宿主诊断；后续单元接到安全拒绝文本，不应获得宿主 Error 或其附加数据。
test("retained rejected host promises expose only safe sandbox errors", async () => {
  const environment = CodeMode.createEnvironment()
  const fail = Tool.make({
    description: "Refuse safely",
    input: Schema.Struct({}),
    output: Schema.Null,
    run: () => Effect.fail(toolError("Request refused", new Error("private host detail"))),
  })
  await Effect.runPromise(
    CodeMode.execute({
      environment,
      tools: { fail },
      code: `
    const pending = tools.fail({}); await Promise.allSettled([pending]); return 1;
  `,
    }),
  )
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        code: `
    try { await pending; } catch (error) { return [error.name, error.message, error.cause, Object.keys(error)]; }
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: ["Error", "Request refused", null, ["name", "message"]] })
})

// 保留的工具值只是路径，必须使用当前目录与回调；旧别名不能携带旧授权继续副作用。
test("saved helpers and tool aliases use only current tools and current interruption", async () => {
  const environment = CodeMode.createEnvironment()
  const effects: string[] = []
  const original = Tool.make({
    description: "Original",
    input: Schema.Struct({}),
    output: Schema.String,
    run: () =>
      Effect.sync(() => {
        effects.push("original")
        return "original"
      }),
  })
  await Effect.runPromise(
    CodeMode.execute({
      environment,
      tools: { operation: original },
      code: `
    const saved = tools.operation; const helper = async () => saved({}); return await helper();
  `,
    }),
  )
  const current = Tool.make({
    description: "Current",
    input: Schema.Struct({}),
    output: Schema.String,
    run: () =>
      Effect.sync(() => {
        effects.push("current")
        return "current"
      }),
  })
  expect(
    await Effect.runPromise(
      CodeMode.execute({ environment, tools: { operation: current }, code: "return await helper();" }),
    ),
  ).toMatchObject({ ok: true, value: "current" })
  expect(await Effect.runPromise(CodeMode.execute({ environment, code: "return await helper();" }))).toMatchObject({
    ok: false,
    error: { kind: "UnknownTool" },
  })
  // 改为当前宿主拒绝后，保存的函数也必须穿透 catch 终止，后续工具不能获准执行。
  const revoked = Tool.make({
    description: "Revoked",
    input: Schema.Struct({}),
    output: Schema.String,
    run: () => Effect.interrupt,
  })
  const stopped = await Effect.runPromise(
    CodeMode.execute({
      environment,
      tools: { operation: revoked, after: current },
      code: `
    try { await helper(); } catch {} await tools.after({});
  `,
    }).pipe(Effect.exit),
  )
  // 同时检查控制中断与实际副作用，避免仅把一次普通报错误认为权限终止。
  expect(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause)).toBe(true)
  expect(effects).toEqual(["original", "current"])
})

// fetch 响应方法只捕获安全响应数据；移除网络能力后仍可读快照，却不能用旧别名再发请求。
test("fetch response closures survive while current fetch availability is refreshed", async () => {
  const environment = CodeMode.createEnvironment()
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        code: `
    const saved = fetch; const response = await fetch("https://example.test"); return response.status;
  `,
        fetch: () =>
          Effect.succeed({
            url: "https://example.test/",
            status: 200,
            statusText: "OK",
            ok: true,
            redirected: false,
            headers: { "content-type": "application/json" },
            text: '{"value":9}',
            bytes: [1, 2],
          }),
      }),
    ),
  ).toMatchObject({ ok: true, value: 200 })
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        code: `
    return [typeof fetch, await response.json(), await response.bytes(), response.headers.get("Content-Type")];
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: ["undefined", { value: 9 }, [1, 2], "application/json"] })
  expect(
    await Effect.runPromise(CodeMode.execute({ environment, code: 'return await saved("https://example.test");' })),
  ).toMatchObject({ ok: false, error: { kind: "UnknownTool" } })
})

// 内建发现与日志也属于当前调用；环境复用不能把旧工具名或上一轮日志当成当前事实。
test("discovery, logs and tool budgets are rebuilt for each cell", async () => {
  const environment = CodeMode.createEnvironment()
  const tool = Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Number,
    run: () => Effect.succeed(1),
  })
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        tools: { old: tool },
        limits: { maxToolCalls: 1 },
        code: `
    const discover = () => Object.keys(tools); console.log("first"); return await tools.old({});
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: 1, logs: ["first"] })
  const next = await Effect.runPromise(
    CodeMode.execute({
      environment,
      tools: { current: tool },
      limits: { maxToolCalls: 1 },
      code: `
    await tools.current({}); return discover();
  `,
    }),
  )
  // $codemode 是既有内建发现入口；用户工具名则必须来自第二次调用的新目录。
  expect(next).toMatchObject({ ok: true, value: ["current", "$codemode"] })
  expect(next.logs).toBeUndefined()
})

// 沿原 TypeScript 编译路径执行；额外单元状态不需要第二个语言模式或源代码重放。
test("TypeScript bindings and async replace callbacks remain usable across cells", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  // replace 的异步扩展会产生并清理 Promise；保留回调不能改变逐次匹配的共享计数。
  expect(
    await Effect.runPromise(
      runtime.execute(`
    let count: number = 0; const replace = async value => { count++; return value.toUpperCase(); };
    return await "ab".replace(/./g, replace);
  `),
    ),
  ).toMatchObject({ ok: true, value: "AB" })
  expect(
    await Effect.runPromise(
      runtime.execute('const output = await "cd".replace(/./g, replace); return [output, count];'),
    ),
  ).toMatchObject({ ok: true, value: ["CD", 4] })
})

// 保存的是无上下文令牌，不是上一单元的 Scope；对象别名和函数闭包都须使用当前执行。
test("retained sleep aliases belong to the current cell and old promises stay terminal", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  expect(
    await Effect.runPromise(
      runtime.execute(`const pause = sleep; const box = { pause };
    async function later() { await pause(0); return 5; }
    const pendingTimer = pause(123456); return 1;`),
    ),
  ).toMatchObject({ ok: true, value: 1 })
  expect(
    await Effect.runPromise(
      runtime.execute(`let rejected = false;
    try { await pendingTimer; } catch (e) { rejected = true; }
    await box.pause(0); await Promise.all([0].map(pause));
    return [rejected, await later()];`),
    ),
  ).toMatchObject({ ok: true, value: [true, 5] })
})

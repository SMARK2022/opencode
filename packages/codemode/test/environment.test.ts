import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
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
  // 下一格的3和12分别承接根计数2与工厂计数11，两种绑定都要在上格已完成的修改上继续累加。
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
    // read来自旧单元，helper来自新单元；返回9要求旧闭包读到替换后的n，再由新helper加一。
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
  // 首格返回即检查清理，避免第二格等待pending时才触发清理也被算作通过。
  expect(cleaned).toBe(true)
  const resumed = await Effect.runPromise(
    CodeMode.execute({
      environment,
      code: "try { await pending; } catch (error) { return error.message; }",
    }).pipe(Effect.exit),
  )
  // 外层Effect成功、内层JS捕获拒绝分别验证控制信号已结束和旧Promise仍有可读终态。
  expect(Exit.isSuccess(resumed)).toBe(true)
  if (Exit.isSuccess(resumed))
    expect(resumed.value).toMatchObject({
      ok: true,
      value: "Promise interrupted when its originating Execute ended.",
    })
})

// 省略 environment 时，同一 make 的两次执行各用新状态；两个显式环境也互不共享绑定。
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

// 编译失败不会执行前面的赋值；运行失败与返回值校验失败则不能回滚已经发生的状态变更。
test("parse errors preserve state while runtime and output failures keep completed changes", async () => {
  const runtime = CodeMode.make({ environment: CodeMode.createEnvironment() })
  await Effect.runPromise(runtime.execute("let value = 1;"))
  expect(await Effect.runPromise(runtime.execute("value = 2; const broken = ;"))).toMatchObject({
    ok: false,
    error: { kind: "ParseError" },
  })
  // 故意把赋值放在语法错误前，保留1才能证明整个单元先编译、后执行。
  expect(await Effect.runPromise(runtime.execute("return value;"))).toMatchObject({ value: 1 })
  expect(await Effect.runPromise(runtime.execute('value = 3; throw new Error("stop"); value = 4;'))).toMatchObject({
    ok: false,
  })
  // helper在失败的返回值校验前创建；下一格的3同时检查上次运行赋值与本次函数定义均已保留。
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
        // 空race永久等待且不依赖工具，超时只能来自当前执行预算，赋值6则已在等待前完成。
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
        // 5是取消前的写入，9和10分别标记catch续跑与正常续跑，任何一种恢复都会改变结果。
        expect(yield* CodeMode.execute({ environment, code: "return value;" })).toMatchObject({ ok: true, value: 5 })
      }),
    ),
  )
})

// 终态只保存业务值或沙箱抛值；重复观察不得重新执行工具，也不能破坏抛值的引用身份。
test("completed and rejected promises retain outcomes and thrown identity without replay", async () => {
  const environment = CodeMode.createEnvironment()
  // 第二格不再提供echo工具；仍读到7只能依靠已结算结果，调用记录再约束不得重放宿主工作。
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
  // 把安全文本与私有cause放进同一次失败，跨格读取时才有真实的敏感内容可检查是否被泄漏。
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
  // 先替换再移除同一路径，分别检查别名能更新实现，以及旧路径不能绕过当前目录继续执行。
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
  // 第二格未配置fetch，却仍可读取第一格的响应数据；读取快照与重新发起网络请求是两个权限边界。
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
  // 两格都给一次调用预算且各调用一次；第二格成功才能排除预算随环境累计。
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
  // 第二格没有打印；若日志随词法状态保留，这里会重新出现第一格的first。
  expect(next.logs).toBeUndefined()
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
  // 旧pendingTimer应维持中断终态，新pause调用则使用当前作用域；两个结果同时断言以区分令牌与生产者。
  expect(
    await Effect.runPromise(
      runtime.execute(`let rejected = false;
    try { await pendingTimer; } catch (e) { rejected = true; }
    await box.pause(0); await Promise.all([0].map(pause));
    return [rejected, await later()];`),
    ),
  ).toMatchObject({ ok: true, value: [true, 5] })
})

// helper同时读根变量、工厂私有变量和共享对象，浅拷贝或逐字段独立复制都会改变下方业务结果。
test("preview copies retained bindings, aliases and raw text but uses current tool implementations", async () => {
  const environment = CodeMode.createEnvironment()
  // 首尾空格使原文可与重新JSON序列化区分，三种文本读取都必须沿复制后的对象保留来源。
  const source = ' {"items":[1]} '
  let realCalls = 0
  const observed: unknown[] = []
  const record = (run: (input: unknown) => Effect.Effect<null>) =>
    Tool.make({ description: "Record input", input: Schema.Unknown, output: Schema.Null, run })
  const tools = {
    load: Tool.make({
      description: "Read text",
      input: Schema.Struct({}),
      run: () => Effect.succeed(CodeMode.fromJsonText(source)),
    }),
    record: record(() =>
      Effect.sync(() => {
        realCalls++
        return null
      }),
    ),
  }
  await Effect.runPromise(
    CodeMode.execute({
      environment,
      tools,
      code: `
    let n = 1; const box = { value: 2 }; const alias = box; const map = new Map([[box, alias]]);
    const data = await tools.load({}); const send = tools.record;
    function factory() { let local = 10; return { next: () => ++local, read: () => local }; }
    const f = factory();
    function helper() { n++; alias.value++; map.keys()[0].value++;
      return send({ n, value: box.value, same: map.get(box) === alias, local: f.next(), read: f.read(),
        source: String(data), template: \`x\${data}\`, text: data.text }); }
    return null;
  `,
    }),
  )
  // 首格只保存helper和工具别名；探测格只提供新record，成功调用就必须重新绑定当前工具实现。
  const probe = await Effect.runPromise(
    CodeMode.execute({
      environment,
      snapshotEnvironment: true,
      tools: {
        record: record((input) =>
          Effect.sync(() => {
            observed.push(input)
            return null
          }),
        ),
      },
      code: "await helper(); return [n, box.value, f.read()];",
    }),
  )
  // box经alias和Map键各加一次，f的两个闭包共用私有计数；预期同时约束复制后的共享身份。
  expect(probe).toMatchObject({ ok: true, value: [2, 4, 11] })
  // same检查Map键与别名仍指向同一副本，local/read检查工厂的两个闭包仍共享私有绑定。
  expect(observed).toEqual([
    { n: 2, value: 4, same: true, local: 11, read: 11, source, template: `x${source}`, text: source },
  ])
  // 探测结果正确仍可能误用了保存的旧回调，独立宿主计数排除这种越过当前工具表的执行。
  expect(realCalls).toBe(0)
  expect(
    await Effect.runPromise(
      // 先单独读原环境，排除浅拷贝已写回；随后再真实调用helper，检查保留闭包本身仍可执行。
      CodeMode.execute({ environment, code: "return [n, box.value, f.read(), map.keys()[0] === box];" }),
    ),
  ).toMatchObject({ ok: true, value: [1, 2, 10, true] })
  expect(
    await Effect.runPromise(
      CodeMode.execute({ environment, tools, code: "await helper(); return [n, box.value, f.read()];" }),
    ),
  ).toMatchObject({ ok: true, value: [2, 4, 11] })
  // 真实执行还应恰好触发旧record一次，与探测格的新record分别验证各自当前的工具实现。
  expect(realCalls).toBe(1)
})

// URL 使探针结束；同一环境仍保留原 Notebook 的容器、绑定方法和共享身份合同。
test("unsupported copied state skips preview while retained containers remain usable", async () => {
  const environment = CodeMode.createEnvironment()
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        code: `
    const object = { value: 1 }; const alias = object;
    const array = [object]; const append = array.push;
    const map = new Map(); map.set("self", map); map.set("object", object);
    const set = new Set([object]); const regex = /a/g; regex.exec("aaba");
    const date = new Date("2020-01-02T03:04:05.000Z");
    const url = new URL("https://example.test/?a=1"); const params = url.searchParams;
    return 1;
  `,
      }),
    ),
  ).toMatchObject({ ok: true, value: 1 })
  // 同一段代码先预跑失败、再真实执行；后者成功证明失败只来自复制限制，而非Notebook值已损坏。
  const code = `
    alias.value = 4; append(9); params.set("a", "2");
    return [object === alias, array[0].value, array[1], map.get("self") === map,
      map.get("object") === object, set.has(alias), regex.exec("aaba").index,
      date.toISOString(), url.href, params === url.searchParams];
  `
  expect(await Effect.runPromise(CodeMode.execute({ environment, snapshotEnvironment: true, code }))).toMatchObject({
    ok: false,
    error: { kind: "ExecutionFailure" },
    toolCalls: [],
  })
  // 读取三个可变对象的原值，确认复制失败发生在脚本赋值、数组追加和URL修改之前。
  expect(
    await Effect.runPromise(CodeMode.execute({ environment, code: "return [object.value, array.length, url.href];" })),
  ).toMatchObject({
    ok: true,
    value: [1, 1, "https://example.test/?a=1"],
  })
  // 正则已在首格消耗索引0，下一次命中应在1；Map自环、保存的append和URL参数视图也要跨格延续。
  expect(await Effect.runPromise(CodeMode.execute({ environment, code }))).toMatchObject({
    ok: true,
    value: [true, 4, 9, true, true, true, 1, "2020-01-02T03:04:05.000Z", "https://example.test/?a=2", true],
  })
})

// 探针只用一次执行时间预算，超时释放副本；真实状态不会留下超时前的赋值。
test("one two-second preview timeout leaves real bindings untouched", async () => {
  const environment = CodeMode.createEnvironment()
  await Effect.runPromise(CodeMode.execute({ environment, code: "let n = 1; return null;" }))
  expect(
    await Effect.runPromise(
      CodeMode.execute({
        environment,
        snapshotEnvironment: true,
        limits: { timeoutMs: 2000 },
        // 5秒等待超过2秒探测预算，第一次加一已在超时前执行，原环境仍为1才能证明写入只留在副本。
        code: "n++; await sleep(5000); n++; return n;",
      }),
    ),
  ).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded", message: "Execution timed out after 2000ms." } })
  expect(await Effect.runPromise(CodeMode.execute({ environment, code: "return n;" }))).toMatchObject({
    ok: true,
    value: 1,
  })
})

// 任务已结束不代表结果不可变；预跑必须复制保留Promise的成功值和拒绝值。
test("preview clones settled promise payloads without changing retained values", async () => {
  for (const setup of [
    "const p = Promise.resolve({ n: 1 }); await p;",
    "const p = Promise.reject({ n: 1 }); try { await p; } catch {}",
    "async function f() { return { n: 1 }; } const p = f(); await p;",
    "async function f() { throw { n: 1 }; } const p = f(); try { await p; } catch {}",
  ]) {
    const environment = CodeMode.createEnvironment()
    expect(await Effect.runPromise(CodeMode.execute({ environment, code: setup }))).toMatchObject({ ok: true })
    const calls: unknown[] = []
    const preview = await Effect.runPromise(
      CodeMode.execute({
        environment,
        snapshotEnvironment: true,
        tools: {
          capture: Tool.make({
            description: "Record cloned promise value",
            input: Schema.Unknown,
            output: Schema.Number,
            run: (input) => Effect.sync(() => calls.push(input)),
          }),
        },
        code: "let value; try { value = await p; } catch (error) { value = error; } value.n = 2; return await tools.capture({ n: value.n });",
      }),
    )
    // 先确认探针确实走到工具调用，再验证真实状态，避免复制失败造成“没有污染”的假通过。
    expect(preview.ok).toBe(true)
    expect(calls).toEqual([{ n: 2 }])
    expect(
      await Effect.runPromise(
        CodeMode.execute({
          environment,
          code: "try { return (await p).n; } catch (error) { return error.n; }",
        }),
      ),
    ).toMatchObject({ ok: true, value: 1 })
  }
})

// 旧别名使用本次宿主计时；预跑修改副本，真实调用仍按默认时钟等待。
test("preview sleep overrides retained aliases without changing real timing or state", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const environment = CodeMode.createEnvironment()
      const waits: number[] = []
      const calls: number[] = []
      const tools = {
        record: Tool.make({
          description: "Record the counter after sleep",
          input: Schema.Struct({ count: Schema.Number }),
          output: Schema.Null,
          run: ({ count }) =>
            Effect.sync(() => {
              calls.push(count)
              return null
            }),
        }),
      }
      expect(
        yield* CodeMode.execute({
          environment,
          code: "let count = 0; const pause = sleep; const work = async () => { await pause(100); count++; await tools.record({ count }); return count; };",
        }),
      ).toMatchObject({ ok: true })
      expect(
        yield* CodeMode.execute({
          environment,
          tools,
          snapshotEnvironment: true,
          sleep: (ms) =>
            Effect.sync(() => {
              waits.push(ms)
            }),
          code: "return await work();",
        }),
      ).toMatchObject({ ok: true, value: 1 })
      // 工具已收到副本里的增量，随后真实count仍为零才证明预跑没有写回。
      expect(waits).toEqual([100])
      expect(calls).toEqual([1])
      expect(yield* CodeMode.execute({ environment, code: "return count;" })).toMatchObject({ value: 0 })

      const running = yield* CodeMode.execute({
        environment,
        tools,
        code: "return await work();",
      }).pipe(Effect.forkChild)
      // 不靠墙钟猜测：推进到到期前一毫秒仍不能出现第二次真实调用。
      yield* TestClock.adjust(99)
      expect(calls).toEqual([1])
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(running)).toMatchObject({ ok: true, value: 1 })
      expect(calls).toEqual([1, 1])
      // 旧闭包没有保存探针的sleep能力，真实格子不再触发那个hook。
      expect(waits).toEqual([100])
      expect(yield* CodeMode.execute({ environment, code: "return count;" })).toMatchObject({ value: 1 })
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

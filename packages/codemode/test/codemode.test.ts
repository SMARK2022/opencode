import { describe, expect, test } from "bun:test"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

const run = (tool: Tool.Definition<never>) =>
  Effect.runPromise(CodeMode.make({ tools: { host: { call: tool } } }).execute("return await tools.host.call({})"))

class UnsafeHostError extends Schema.TaggedErrorClass<UnsafeHostError>()("UnsafeHostError", {
  reason: Schema.String,
}) {}

describe("CodeMode host failure boundary", () => {
  test("preserves explicit safe tool failures", async () => {
    const result = await run(
      Tool.make({
        description: "Fail safely",
        input: Schema.Struct({}),
        output: Schema.String,
        run: () => Effect.fail(toolError("Authorized request was refused")),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "ToolFailure",
      message: "Authorized request was refused",
    })
  })

  test("sanitizes unknown host failures and defects", async () => {
    for (const failure of [
      Effect.fail(new UnsafeHostError({ reason: "Authorization: Bearer typed-secret" })),
      Effect.die(new Error("postgres://user:defect-secret@example.invalid")),
    ]) {
      const result = await run(
        Tool.make({
          description: "Fail internally",
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => failure,
        }),
      )

      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: "ToolFailure",
        message: "Tool execution failed",
      })
      expect(JSON.stringify(result)).not.toMatch(/typed-secret|defect-secret|Authorization: Bearer/)
    }
  })

  test("sanitizes invalid host output", async () => {
    const secret = "invalid-output-secret"
    const result = await run(
      Tool.make({
        description: "Return invalid output",
        input: Schema.Struct({}),
        output: Schema.Struct({ safe: Schema.String }),
        run: () => Effect.succeed({ safe: 1, secret } as unknown as { readonly safe: string }),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "InvalidToolOutput",
      message: "Invalid output from tool 'host.call'.",
    })
    expect(JSON.stringify(result)).not.toMatch(/invalid-output-secret/)
  })

  test("sanitizes host output that throws while being copied", async () => {
    const result = await run(
      Tool.make({
        description: "Return hostile output",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        run: () =>
          Effect.succeed(
            new Proxy(
              {},
              {
                ownKeys: () => {
                  throw new Error("host-output-secret")
                },
              },
            ),
          ),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "InvalidToolOutput",
      message: "Invalid output from tool 'host.call'.",
    })
    expect(JSON.stringify(result)).not.toMatch(/host-output-secret/)
  })

  test("caught tool failures are Error values in-program", async () => {
    const result = await Effect.runPromise(
      CodeMode.make({
        tools: {
          host: {
            call: Tool.make({
              description: "Refuse",
              input: Schema.Struct({}),
              output: Schema.String,
              run: () => Effect.fail(toolError("Refused")),
            }),
          },
        },
      }).execute(`
        try {
          await tools.host.call({})
          return "no"
        } catch (e) {
          return { isError: e instanceof Error, message: e.message }
        }
      `),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ isError: true, message: "Refused" })
  })

  test("propagates host interruption instead of returning a diagnostic", async () => {
    const exit = await Effect.runPromiseExit(
      CodeMode.make({
        tools: {
          host: {
            call: Tool.make({
              description: "Interrupt",
              input: Schema.Struct({}),
              output: Schema.String,
              run: () => Effect.interrupt,
            }),
          },
        },
      }).execute("return await tools.host.call({})"),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
  })
})

describe("CodeMode tool-call observation", () => {
  test("reports the tools actually invoked with decoded input", async () => {
    const calls: Array<unknown> = []
    const lookup = Tool.make({
      description: "Look up a value",
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.String,
      run: ({ query }) => Effect.succeed(query),
    })

    const result = await Effect.runPromise(
      CodeMode.make({
        tools: { context: { lookup } },
        onToolCallStart: (call) => Effect.sync(() => calls.push(call)),
      }).execute(`
        if (false) await tools.context.lookup({ query: "not called" })
        return await tools.context.lookup({ query: "deployment failure" })
      `),
    )

    expect(result.ok).toBe(true)
    expect(calls).toStrictEqual([{ index: 0, name: "context.lookup", input: { query: "deployment failure" } }])
  })

  test("observes settled calls with outcome and duration", async () => {
    const events: Array<{ phase: string; index: number; name: string; outcome?: string; message?: string }> = []
    const lookup = Tool.make({
      description: "Look up a value",
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.String,
      run: ({ query }) => (query === "boom" ? Effect.fail(toolError("Lookup refused")) : Effect.succeed(query)),
    })

    const runtime = CodeMode.make({
      tools: { context: { lookup } },
      onToolCallStart: (call) =>
        Effect.sync(() => {
          events.push({ phase: "start", index: call.index, name: call.name })
        }),
      onToolCallEnd: (call) =>
        Effect.sync(() => {
          expect(call.durationMs).toBeGreaterThanOrEqual(0)
          events.push({
            phase: "end",
            index: call.index,
            name: call.name,
            outcome: call.outcome,
            ...(call.message === undefined ? {} : { message: call.message }),
          })
        }),
    })

    const success = await Effect.runPromise(runtime.execute(`return await tools.context.lookup({ query: "ok" })`))
    expect(success.ok).toBe(true)
    const failure = await Effect.runPromise(runtime.execute(`return await tools.context.lookup({ query: "boom" })`))
    expect(failure.ok).toBe(false)

    expect(events).toStrictEqual([
      { phase: "start", index: 0, name: "context.lookup" },
      { phase: "end", index: 0, name: "context.lookup", outcome: "success" },
      { phase: "start", index: 0, name: "context.lookup" },
      { phase: "end", index: 0, name: "context.lookup", outcome: "failure", message: "Lookup refused" },
    ])
  })
})

describe("CodeMode console capture", () => {
  test("captures console output as bounded result logs", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        const returned = console.log("Thread info:", { name: "Demo", count: 2 })
        console.warn("careful")
        return returned
      `,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: null,
      logs: ['Thread info: {"name":"Demo","count":2}', "[warn] careful"],
      toolCalls: [],
    })
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("keeps logs captured before failures", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("before failure")
        throw new Error("boom")
      `,
      }),
    )

    expect(result.ok ? undefined : result.logs).toStrictEqual(["before failure"])
    expect(result.ok ? undefined : result.error.message).toBe("Uncaught: boom")
  })

  test("prints NaN and Infinity literally instead of the JSON null", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log(NaN)
        console.log(Infinity, -Infinity)
        console.log({ ratio: NaN, bounds: [Infinity] })
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(["NaN", "Infinity -Infinity", '{"ratio":NaN,"bounds":[Infinity]}'])
  })

  test("renders sandbox values nested inside logged containers", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log({ m: new Map([["a", 1]]), when: new Date(0), r: /ab/g, s: new Set([1, 2]) })
        console.log([new Date(0)])
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual([
      '{"m":Map(1) [["a",1]],"when":1970-01-01T00:00:00.000Z,"r":/ab/g,"s":Set(2) [1,2]}',
      "[1970-01-01T00:00:00.000Z]",
    ])
  })

  test("console formatting is total: cycles and opaque references render as markers", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        const m = new Map()
        m.set("self", m)
        console.log({ box: m })
        console.log({ fn: (x) => x, ok: 1 })
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(['{"box":Map(1) [["self",[Circular]]]}', '{"fn":[CodeMode reference],"ok":1}'])
  })

  test("console.table renders sandbox value cells", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.table([{ when: new Date(0), n: NaN }])
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(["(index)\twhen\tn\n0\t1970-01-01T00:00:00.000Z\tNaN"])
  })

  test("captures console.dir and console.table output", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.dir({ nested: { ok: true } })
        console.table([
          { name: "Kit", count: 1, hidden: "x" },
          { name: "Olive", count: 2, hidden: "y" }
        ], ["name", "count"])
        return "done"
      `,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: "done",
      logs: ['{"nested":{"ok":true}}', "(index)\tname\tcount\n0\tKit\t1\n1\tOlive\t2"],
      toolCalls: [],
    })
  })
})

describe("CodeMode output budget", () => {
  test("absent maxOutputBytes means no truncation at all", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `console.log("z".repeat(50_000)); return "x".repeat(100_000)`,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBeUndefined()
    expect(result.value).toBe("x".repeat(100_000))
    expect(result.logs).toStrictEqual(["z".repeat(50_000)])
  })

  test("truncates an oversized result value with a marker instead of failing", async () => {
    const limits: CodeMode.ExecutionLimits = { maxOutputBytes: 40 }
    const result = await Effect.runPromise(
      CodeMode.execute({
        // 同次执行既超出结果预算又留下未观察拒绝，才能覆盖截断重建 Result 时丢字段的路径。
        code: `Promise.reject("unobserved"); return { data: "${"x".repeat(200)}" }`,
        limits,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    // 裁剪只改变交付值，不能抹掉同次执行已经记录的失败事实。
    expect(result.unobservedFailure).toBe(true)
    expect(typeof result.value).toBe("string")
    expect(result.value).toMatch(
      /^\{"data":"x+ \[result truncated: \d+ bytes exceeds the 40-byte output limit; return a smaller value\]$/,
    )
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("keeps leading logs within the remaining budget and marks the cut", async () => {
    const limits: CodeMode.ExecutionLimits = { maxOutputBytes: 40 }
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("first line")
        console.log("${"y".repeat(200)}")
        return "ok"
      `,
        limits,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("ok")
    expect(result.truncated).toBe(true)
    expect(result.logs).toStrictEqual(["first line", "[logs truncated: showing 1 of 2 lines]"])
  })

  test("does not mark results within the budget", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("fits")
        return { fits: true }
      `,
      }),
    )
    expect(result).toStrictEqual({
      ok: true,
      value: { fits: true },
      logs: ["fits"],
      toolCalls: [],
    })
  })
})

describe("CodeMode schema flexibility", () => {
  test("accepts render-only JSON Schema input and omitted output", async () => {
    const observed: Array<unknown> = []
    const call = Tool.make({
      description: "Call an adapter-described tool",
      input: {
        type: "object",
        properties: { id: { type: "string" }, count: { type: "number" } },
        required: ["id"],
      },
      run: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return { echoed: input }
        }),
    })
    const runtime = CodeMode.make({ tools: { adapter: { call } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "adapter.call",
        description: "Call an adapter-described tool",
        // JSON schema 仅负责展示，可选字段仍保留，但不能据此推断标量捷径。
        signature: "tools.adapter.call(input: { id: string; count?: number }): Promise<unknown>",
      },
    ])

    // JSON Schema is render-only: mistyped input passes through unvalidated.
    const result = await Effect.runPromise(runtime.execute(`return await tools.adapter.call({ id: 42 })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ echoed: { id: 42 } })
    expect(observed).toStrictEqual([{ id: 42 }])
  })

  test("renders JSON Schema outputs and $defs references", async () => {
    const lookup = Tool.make({
      description: "Look up a user",
      input: { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
      output: {
        $ref: "#/$defs/User",
        $defs: {
          User: {
            type: "object",
            properties: { login: { type: "string" }, id: { type: "number" } },
            required: ["login", "id"],
          },
        },
      },
      run: () => Effect.succeed({ login: "kit", id: 7 }),
    })
    const runtime = CodeMode.make({ tools: { users: { lookup } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "users.lookup",
        description: "Look up a user",
        // adapter 的返回 schema 独立渲染；不能从本次模拟结果推断输出类型。
        signature: "tools.users.lookup(input: { login: string }): Promise<{ login: string; id: number }>",
      },
    ])

    const result = await Effect.runPromise(runtime.execute(`return await tools.users.lookup({ login: "kit" })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ login: "kit", id: 7 })
  })

  test("Effect Schema output without an input transform still renders unknown when omitted", async () => {
    const ping = Tool.make({
      description: "Ping",
      input: Schema.Struct({ host: Schema.String }),
      run: () => Effect.succeed("pong"),
    })
    const runtime = CodeMode.make({ tools: { net: { ping } } })
    // 实际 Effect 输入有标量形式，但省略输出 schema 时仍只能承诺 unknown。
    expect(runtime.catalog()[0]?.signature).toBe("tools.net.ping(input: { host: string }): Promise<unknown>")

    const result = await Effect.runPromise(runtime.execute(`return await tools.net.ping({ host: "example.test" })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("pong")
  })
})

describe("CodeMode public contract", () => {
  const lookup = Tool.make({
    description: "Look up an order by ID",
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String, status: Schema.String }),
    run: ({ id }) => Effect.succeed({ id, status: "open" }),
  })
  const tools = { orders: { lookup } }
  const source = `return await tools.orders.lookup({ id: "order_42" })`

  // 发现测试只检查路径、排序和分页；完整 schema 合同集中在 signature fixture 验证。
  const searchSummary = (value: unknown) => {
    const page = value as {
      items: Array<{ path: string; description: string; signature: string }>
      remaining: number
      next: { offset: number } | null
    }
    // 只投影items里的紧凑字段，remaining和next原样留下，让路径测试继续精确验证分页而不重复详情合同。
    return {
      ...page,
      items: page.items.map((item) => ({ path: item.path, description: item.description, signature: item.signature })),
    }
  }

  test("keeps one-shot and reusable execution equivalent", async () => {
    const runtime = CodeMode.make({ tools })
    const [oneShot, reusable] = await Promise.all([
      Effect.runPromise(CodeMode.execute({ tools, code: source })),
      Effect.runPromise(runtime.execute(source)),
    ])

    expect(reusable).toStrictEqual(oneShot)
    const input: CodeMode.Input = { code: source }
    expect(Schema.decodeUnknownSync(CodeMode.Input)(input)).toStrictEqual(input)
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(reusable)))).toStrictEqual(reusable)
  })

  test("inlines a COMPLETE small catalog and keeps search registered but unadvertised", async () => {
    const runtime = CodeMode.make({ tools })
    expect(runtime.catalog()).toStrictEqual([
      {
        path: "orders.lookup",
        description: "Look up an order by ID",
        // 订单的对象与标量形式来自同一实际编码域，返回对象合同保持不变。
        signature: "tools.orders.lookup(input: { id: string }): Promise<{ id: string; status: string }>",
      },
    ])
    expect(runtime.instructions()).toContain("The catalog is complete.")
    expect(runtime.instructions()).toContain("- orders (1 tool)")
    // 下方搜索锁定同一紧凑接口，不再维护与目录不同的多行文档形式。
    expect(runtime.instructions()).toContain(
      // 内联目录与上方 catalog 的类型必须逐字一致，预算不改写接口。
      "  - tools.orders.lookup(input: { id: string }): Promise<{ id: string; status: string }> // Look up an order by ID",
    )
    // A fully inlined catalog does not advertise search in the instructions...
    expect(runtime.instructions()).not.toMatch(/\$codemode/)

    // ...but the search tool stays registered, so a speculative call still works with the
    // 相同路径的完整工具用途与紧凑签名，不再承诺字段 JSDoc。
    const result = await Effect.runPromise(runtime.execute(`return await tools.$codemode.search({ query: "order" })`))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(searchSummary(result.value)).toStrictEqual({
        items: [
          {
            path: "tools.orders.lookup",
            description: "Look up an order by ID",
            // 完整小目录不会删除 search；显式查询仍返回同一官方签名。
            signature: "tools.orders.lookup(input: { id: string }): Promise<{ id: string; status: string }>",
          },
        ],
        remaining: 0,
        next: null,
      })
    }
  })

  test("renders bracket notation for tool names that are not JavaScript identifiers", async () => {
    const resolveLibrary = Tool.make({
      description: "Resolve a library ID",
      input: Schema.Struct({ libraryName: Schema.String }),
      output: Schema.String,
      run: ({ libraryName }) => Effect.succeed(`/resolved/${libraryName}`),
    })
    const runtime = CodeMode.make({ tools: { context7: { "resolve-library-id": resolveLibrary } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "context7.resolve-library-id",
        description: "Resolve a library ID",
        // 横线名称要求括号访问；加入命名参数不能损坏可复制的路径。
        signature: 'tools.context7["resolve-library-id"](input: { libraryName: string }): Promise<string>',
      },
    ])
    // 压缩类型不能把特殊名称改成无效点号表达式，调用路径仍与完整搜索一致。
    expect(runtime.instructions()).toContain(
      'tools.context7["resolve-library-id"](input: { libraryName: string }): Promise<string>',
    )

    const search = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "resolve library id" })`),
    )
    expect(search.ok).toBe(true)
    if (search.ok) {
      expect(searchSummary(search.value)).toStrictEqual({
        items: [
          {
            path: 'tools.context7["resolve-library-id"]',
            description: "Resolve a library ID",
            // 搜索返回完整调用表达式，不能把括号路径退回无效点号表达式。
            signature: 'tools.context7["resolve-library-id"](input: { libraryName: string }): Promise<string>',
          },
        ],
        remaining: 0,
        next: null,
      })
    }

    const call = await Effect.runPromise(
      runtime.execute(`return await tools.context7["resolve-library-id"]({ libraryName: "TypeScript" })`),
    )
    expect(call.ok).toBe(true)
    if (call.ok) expect(call.value).toBe("/resolved/TypeScript")

    const exact = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: 'tools.context7["resolve-library-id"]' })`),
    )
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.value).toMatchObject({ remaining: 0, next: null })
  })

  test("instructions separate shared execution guidance and catalog branches", () => {
    // 固定说明先描述收益，再用一条渐进示例示范发现、并发和裁剪。
    expect(CodeMode.description).toContain("Run JavaScript/TypeScript")
    expect(CodeMode.description).toContain("pending work ends with the script")
    expect(CodeMode.description).toContain("Return the fields needed for your next decision")
    expect(CodeMode.description).toContain("eight-file bounded line-count check")
    // fetch 由宿主提供；仅保留必要能力边界，不加入强制异常包装教条。
    expect(CodeMode.description).toContain("Fetch is available when supplied by the host")
    expect(CodeMode.description).not.toMatch(/try\/catch|MUST NOT|IMPORTANT|timers are unavailable/)
    const complete = CodeMode.make({ tools }).instructions()
    expect(complete).toStartWith("# Code Mode\n\nCall these tools as JavaScript inside `execute`;")
    expect(complete).toContain("The catalog is complete.")
    expect(complete).toContain("## Code Mode tools (call only inside `execute`)")
    expect(complete).not.toContain("Promise.allSettled")
    const partial = CodeMode.make({ tools, discovery: { catalogBudget: 0 } }).instructions()
    // 同源紧凑签名不再承诺字段 JSDoc；路径仍是可直接使用的调用表达式。
    expect(partial).toContain("Use `search(...)` for unlisted tools.")
    expect(partial).toContain("Each result's `path` is the complete call expression")
    expect(partial).toContain("- search(input:")
    expect(partial).toContain("): { items: Array<{")
    // 中文维护段只解释代码修改，不进入任何模型可见出口。
    for (const text of [CodeMode.description, complete, partial, CodeMode.make({}).instructions()]) {
      expect(text).not.toMatch(/中文维护说明|@@ comment\./)
    }
    expect(CodeMode.make({}).instructions()).toBe(
      "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.",
    )
  })

  test("uses one ranked search returning complete definitions for large catalogs", async () => {
    const upload = Tool.make({
      description: "Upload one readable local file to the current Discord thread",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ sent: Schema.Boolean }),
      run: () => Effect.succeed({ sent: true }),
    })
    const generate = Tool.make({
      description: "Generate an image and upload it to the current Discord thread",
      input: Schema.Struct({ prompt: Schema.String }),
      output: Schema.Struct({ sent: Schema.Boolean }),
      run: () => Effect.succeed({ sent: true }),
    })
    const runtime = CodeMode.make({
      tools: { thread: { uploadFile: upload, generateImage: generate }, orders: { lookup } },
      discovery: { catalogBudget: 0 },
    })
    expect(runtime.instructions()).toContain(
      "The catalog is partial.",
    )
    expect(runtime.instructions()).toContain("- thread (2 tools, none shown)")
    expect(runtime.instructions()).toContain("- orders (1 tool, none shown)")
    // 零预算仍公开同步 search 的命名参数，保证隐藏项可被主动发现。
    expect(runtime.instructions()).toContain("- search(input: {")
    expect(runtime.instructions()).not.toContain("tools.thread.uploadFile(")

    const result = await Effect.runPromise(
      runtime.execute(`
      return await tools.$codemode.search({
        query: "send message attachment upload file to current Discord thread",
        limit: 2
      })
    `),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(searchSummary(result.value)).toStrictEqual({
      items: [
        {
          path: "tools.thread.uploadFile",
          description: "Upload one readable local file to the current Discord thread",
          // 文件路径标量与原对象都合法，返回 sent 仍是结构化业务字段。
          signature: "tools.thread.uploadFile(input: { path: string }): Promise<{ sent: boolean }>",
        },
        {
          path: "tools.thread.generateImage",
          description: "Generate an image and upload it to the current Discord thread",
          // 同组其他工具独立推导自己的参数键，不能复用上传工具的 path。
          signature: "tools.thread.generateImage(input: { prompt: string }): Promise<{ sent: boolean }>",
        },
      ],
      remaining: 0,
      next: null,
    })
    expect(result.toolCalls).toStrictEqual([{ name: "$codemode.search" }])

    const variants = await Effect.runPromise(
      runtime.execute(`
      return await Promise.all([
        tools.$codemode.search({ query: "file" }),
        tools.$codemode.search({ query: "image" })
      ])
    `),
    )
    expect(variants.ok).toBe(true)
    if (variants.ok) {
      expect((variants.value as Array<{ items: Array<{ path: string }> }>)[0]?.items[0]?.path).toBe(
        "tools.thread.uploadFile",
      )
      expect((variants.value as Array<{ items: Array<{ path: string }> }>)[1]?.items[0]?.path).toBe(
        "tools.thread.generateImage",
      )
    }

    const removed = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.describe({ path: "thread.uploadFile" })`),
    )
    expect(removed.ok).toBe(false)
    if (!removed.ok) expect(removed.error.kind).toBe("UnknownTool")
  })

  test("search defaults to 10 results and resolves exact tool paths", async () => {
    const tool = (index: number) =>
      Tool.make({
        description: `Numbered tool ${index}`,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        run: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        many: Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`tool${index}`, tool(index)])),
      },
    })

    const browse = await Effect.runPromise(runtime.execute(`return await tools.$codemode.search({})`))
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as {
        items: Array<{ path: string }>
        remaining: number
        next: { offset: number } | null
      }
      expect(value.items).toHaveLength(10)
      expect(value.remaining).toBe(4)
      expect(value.next).toStrictEqual({ offset: 10 })
    }

    for (const query of ["many.tool13", "tools.many.tool13"]) {
      const exact = await Effect.runPromise(
        runtime.execute(`return await tools.$codemode.search({ query: ${JSON.stringify(query)} })`),
      )
      expect(exact.ok).toBe(true)
      if (exact.ok) {
        expect(searchSummary(exact.value)).toStrictEqual({
          items: [
            {
              path: "tools.many.tool13",
              description: "Numbered tool 13",
              // 分页精确查找不能丢掉该工具的参数形式或把相似路径混入结果。
              signature: "tools.many.tool13(input: { id: string }): Promise<string>",
            },
          ],
          remaining: 0,
          next: null,
        })
      }
    }
  })

  test("scopes search to one namespace and browses it alphabetically", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        run: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        github: { list_issues: simple("List issues"), create_issue: simple("Create an issue") },
        linear: { list_issues: simple("List Linear issues") },
      },
    })

    // Empty query + namespace browses just that namespace, alphabetical by path.
    const browse = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "", namespace: "github" })`),
    )
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.github.create_issue",
        "tools.github.list_issues",
      ])
    }

    // A query + namespace ranks within that namespace only.
    const scoped = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "issues", namespace: "linear" })`),
    )
    expect(scoped.ok).toBe(true)
    if (scoped.ok) {
      const value = scoped.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.linear.list_issues")
    }

    const invalid = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "issues", namespace: 7 })`),
    )
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.kind).toBe("InvalidToolInput")
  })

  test("matches input parameter names and partial-word substrings", async () => {
    const upload = Tool.make({
      description: "Send a document to the workspace",
      input: {
        type: "object",
        properties: { attachment: { type: "string", description: "Local path of the payload to send" } },
        required: ["attachment"],
      },
      run: () => Effect.succeed("ok"),
    })
    const other = Tool.make({
      description: "Rename the workspace",
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.String,
      run: () => Effect.succeed("ok"),
    })
    const runtime = CodeMode.make({ tools: { files: { upload, other } } })

    // "attachment" appears in neither path nor description - only in the input schema's
    // property names, which the searchable text includes.
    const byParameter = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "attachment" })`),
    )
    expect(byParameter.ok).toBe(true)
    if (byParameter.ok) {
      const value = byParameter.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.files.upload")
    }

    // Substring matching: a partial word ("docum") still hits the description.
    const bySubstring = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "docum" })`),
    )
    expect(bySubstring.ok).toBe(true)
    if (bySubstring.ok) {
      const value = bySubstring.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.files.upload")
    }
  })

  test("a plural query term matches singular-only tool text", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        run: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        // Neither path nor description contains "issues" - only the singular "issue".
        tracker: { fetch_all: simple("Fetch every open issue in the project") },
        github: { list_issues: simple("List issues") },
        misc: { rename: simple("Rename the workspace") },
      },
    })

    // "issues" still finds the singular-only tool (term OR singular(term) per field)...
    const plural = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "issues", namespace: "tracker" })`),
    )
    expect(plural.ok).toBe(true)
    if (plural.ok) {
      const value = plural.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.tracker.fetch_all")
    }

    // ...while a true "issues" path match still outranks the singular-only description match.
    const ranked = await Effect.runPromise(runtime.execute(`return await tools.$codemode.search({ query: "issues" })`))
    expect(ranked.ok).toBe(true)
    if (ranked.ok) {
      const value = ranked.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.github.list_issues",
        "tools.tracker.fetch_all",
      ])
    }
  })

  test("empty query lists everything alphabetically by path", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({}),
        output: Schema.String,
        run: () => Effect.succeed("ok"),
      })
    // Deliberately declared out of alphabetical order.
    const runtime = CodeMode.make({
      tools: {
        zeta: { last: simple("Last") },
        alpha: { beta: simple("Middle"), aardvark: simple("First") },
      },
    })
    const browse = await Effect.runPromise(runtime.execute(`return await tools.$codemode.search({})`))
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as { items: Array<{ path: string }>; remaining: number; next: unknown }
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.alpha.aardvark",
        "tools.alpha.beta",
        "tools.zeta.last",
      ])
      expect(value.remaining).toBe(0)
      expect(value.next).toBeNull()
    }

    const middle = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ limit: 1, offset: 1 })`),
    )
    expect(middle.ok).toBe(true)
    if (middle.ok) {
      expect(middle.value).toMatchObject({
        items: [{ path: "tools.alpha.beta" }],
        remaining: 1,
        next: { offset: 2 },
      })
    }

    const exhausted = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ limit: 1, offset: 3 })`),
    )
    expect(exhausted.ok).toBe(true)
    if (exhausted.ok) expect(exhausted.value).toStrictEqual({ items: [], remaining: 0, next: null })
  })

  // 长度选择替代旧轮询策略；此处测实际入选集合，而非绑定实现循环。
  test("skips expensive signatures and selects the shortest current paths", () => {
    const cheap = Tool.make({
      description: "Cheap",
      input: Schema.Struct({ q: Schema.String }),
      output: Schema.String,
      run: () => Effect.succeed("ok"),
    })
    const expensive = Tool.make({
      description:
        "An expensive tool whose description alone consumes far more than the remaining inline catalog byte budget for this runtime",
      input: Schema.Struct({
        someRatherLongParameterName: Schema.String,
        anotherEvenLongerParameterName: Schema.Number,
      }),
      output: Schema.String,
      run: () => Effect.succeed("ok"),
    })
    // 两组共用预算且都要支付标题成本，样本只够放下两个短签名。
    const runtime = CodeMode.make({
      tools: { alpha: { cheap, expensive }, beta: { cheap } },
      // 预算按实际标准签名计量，运行时简写不额外占用一份 union 文本。
      discovery: { catalogBudget: 65 },
    })

    const instructions = runtime.instructions()
    expect(instructions).toContain("The catalog is partial.")
    expect(instructions).toContain("- alpha (2 tools, 1 shown)")
    // 较长工具跳过后，同组短工具仍可入选，不能把整个 namespace 封死。
    expect(instructions).toContain("  - tools.alpha.cheap(input: { q: string }): Promise<string> // Cheap")
    expect(instructions).not.toContain("tools.alpha.expensive(")
    // Fully shown namespaces read cleanly (no "shown" annotation).
    expect(instructions).toContain("- beta (1 tool)")
    // 剩余预算足够时另一组短工具也必须展示，组标题不承担选择策略。
    expect(instructions).toContain("  - tools.beta.cheap(input: { q: string }): Promise<string> // Cheap")
    expect(instructions).toContain("- search(input: {")
  })

  test("compact catalog is stable for equal sets supplied in different orders", () => {
    const entry = Tool.make({
      description: "Lookup",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      run: ({ id }) => Effect.succeed(id),
    })
    // 固定同一工具集合，仅改变组与成员的插入顺序，目录选择和最终文本都应稳定。
    for (const catalogBudget of [0, 40, 2000]) {
      // 三种预算分别触发零展示、部分展示和完整展示；同时打乱namespace与成员顺序以检测插入序依赖。
      const left = CodeMode.make({
        tools: { zeta: { last: entry }, alpha: { second: entry, first: entry } },
        discovery: { catalogBudget },
      })
      const right = CodeMode.make({
        tools: { alpha: { first: entry, second: entry }, zeta: { last: entry } },
        discovery: { catalogBudget },
      })
      expect(left.instructions()).toBe(right.instructions())
      expect(left.catalog()).toEqual(right.catalog())
    }
  })

  test("compact catalog and search share callable types without field JSDoc", async () => {
    const documented = Tool.make({
      description: "Look up a record",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "A detailed identifier description. ".repeat(20) },
        },
        required: ["id"],
      } as const,
      run: () => Effect.succeed("ok"),
    })
    const runtime = CodeMode.make({
      tools: { records: { lookup: documented } },
      discovery: { catalogBudget: 40 },
    })

    // 长字段说明放在搜索详情中；这里只测它不会挤占内联签名的预算。
    expect(runtime.catalog()[0]?.signature).not.toContain("/**")
    expect(runtime.instructions()).toContain("The catalog is complete.")
    expect(runtime.instructions()).toContain("tools.records.lookup(input: { id: string }): Promise<unknown>")
    expect(runtime.instructions()).not.toContain("A detailed identifier description.")
    // 搜索另有 inputSchema 承载字段说明，signature 仍须与内联接口逐字相同。
    expect(
      await Effect.runPromise(runtime.execute('return search({ namespace: "records" }).items[0].signature')),
    ).toMatchObject({ ok: true, value: runtime.catalog()[0]?.signature })
  })

  test("upstream global search directly exposes signatures and zero-argument calls retain validation", async () => {
    const ping = Tool.make({ description: "Ping", input: Schema.Struct({}), output: Schema.String, run: () => Effect.succeed("pong") })
    const runtime = CodeMode.make({ tools: { host: { ping, lookup } } })
    // 原缺口在直接访问items时出现；只测试await search会掩盖同步语义错误。
    const result = await Effect.runPromise(runtime.execute(`
      const item = search({query: "host.ping"}).items[0];
      return {item, pong: await tools.host.ping(), again: (await search({query: "host.ping"})).items[0].path};
    `))
    expect(result).toMatchObject({ ok: true, value: {
      item: { path: "tools.host.ping", description: "Ping", signature: "tools.host.ping(): Promise<string>" },
      pong: "pong", again: "tools.host.ping",
    } })
    // {}规范化仍经过原输入decoder，不能把必填字段或额外实参错误吞掉。
    for (const code of ["await tools.host.lookup()", "await tools.host.ping({}, {})"]) {
      const invalid = await Effect.runPromise(runtime.execute(code))
      expect(invalid).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" }, toolCalls: [] })
    }
    expect(await Effect.runPromise(runtime.execute("search().items.length"))).toMatchObject({ ok: true, value: 2 })
  })

  test("namespace rejection supplies a usable exact signature without a discovery call", async () => {
    const received: string[] = []
    const lookup = Tool.make({
      description: "Lookup",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      run: ({ id }) =>
        Effect.sync(() => {
          received.push(id)
          return id
        }),
    })
    const runtime = CodeMode.make({ tools: { "api-kit": { "group-name": { "lookup-item": lookup } } } })
    // 错把分组当函数只能产生诊断，不能猜测其中唯一工具并执行副作用。
    const failed = await Effect.runPromise(runtime.execute('await tools["api-kit"]["group-name"]({ id: "order_42" })'))
    expect(failed).toMatchObject({
      ok: false,
      error: {
        kind: "UnknownTool",
        suggestions: ['tools["api-kit"]["group-name"]["lookup-item"](input: { id: string }): Promise<string>'],
      },
    })
    // 先检查宿主未调用，再消费错误建议；单看UnknownTool诊断无法排除实现已猜测调用唯一成员。
    expect(received).toEqual([])
    if (failed.ok) throw new Error("expected namespace rejection")
    // 直接消费上一次错误中的精确表达式，证明调用者无需再 search 或自行规范化名字。
    const path = failed.error.suggestions?.[0]?.split("(")[0]
    expect(await Effect.runPromise(runtime.execute(`return await ${path}({ id: "order_42" })`))).toMatchObject({
      ok: true,
      value: "order_42",
    })
    // 恢复后只出现一次真实输入，证明建议可直接调用且初次误调用没有暗中执行同一工具。
    expect(received).toEqual(["order_42"])
  })

  test("namespace recovery bounds whole signatures and reports the omitted count", async () => {
    const simple = Tool.make({
      description: "Entry",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("ok"),
    })
    const entries = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`entry_${i}`, simple]))
    // 单条超长类型不能截成缺参数的伪签名，也不能挡住其它可完整展示的成员。
    const huge = Tool.make({
      description: "Huge",
      input: { type: "object", properties: { value: { const: "x".repeat(2100) } } } as const,
      run: () => Effect.succeed("ok"),
    })
    const runtime = CodeMode.make({ tools: { many: { huge, ...entries } } })
    const result = await Effect.runPromise(runtime.execute("await tools.many()"))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected namespace rejection")
    // 最后一项是省略计数，前面才是可调用签名；超长huge也计入总共101项，不能从剩余数里消失。
    const signatures = result.error.suggestions?.filter((line) => line.startsWith("tools.")) ?? []
    expect(signatures.length).toBeGreaterThan(0)
    expect(signatures.every((line) => /^tools\.many\.entry_\d+\(\): Promise<string>$/.test(line))).toBe(true)
    // 预算只计整条签名和换行；剩余数量让模型知道提示不是完整目录。
    expect(signatures.join("\n").length).toBeLessThanOrEqual(2000)
    expect(result.error.suggestions?.at(-1)).toBe(
      `${101 - signatures.length} more functions; use search for full details.`,
    )
    expect(result.toolCalls).toEqual([])
  })

  test("upstream discovery scopes nested paths, ranks path words, and suggests available tools", async () => {
    const item = Tool.make({ description: "List", input: Schema.Struct({}), output: Schema.String, run: () => Effect.succeed("ok") })
    const runtime = CodeMode.make({ tools: { api: { get_timezones: item, zones: { list: item }, get_zones: item } } })
    // 子串timezones不能排在完整路径词zones之前；同分按确定性路径顺序输出。
    expect(await Effect.runPromise(runtime.execute('search({query:"zones"}).items.map(x => x.path)'))).toMatchObject({
      ok: true, value: ["tools.api.get_zones", "tools.api.zones.list", "tools.api.get_timezones"],
    })
    for (const namespace of ["api.zones", "tools.api.zones"]) {
      expect(await Effect.runPromise(runtime.execute(`search({namespace:${JSON.stringify(namespace)}}).items.map(x => x.path)`)))
        .toMatchObject({ ok: true, value: ["tools.api.zones.list"] })
    }
    const missing = await Effect.runPromise(runtime.execute("await tools.api.list_zones()"))
    expect(missing).toMatchObject({ ok: false, error: {
      kind: "UnknownTool", message: "Unknown tool 'api.list_zones'. Did you mean tools.api.zones.list?",
      suggestions: ["Use search to find available tools."],
    } })
  })

  test("upstream catalog includes namespace cost and renders exact complete instructions", () => {
    const ping = Tool.make({ description: "Ping", input: Schema.Struct({}), output: Schema.String, run: () => Effect.succeed("pong") })
    const runtime = CodeMode.make({ tools: { host: { ping } } })
    // 独立预期取官方instructions.render格式，固定说明和目录只各承担自己的职责。
    expect(runtime.instructions()).toBe(
      [
        "# Code Mode",
        "",
        // 固定宿主入口和字段文档去向，短提示不能暗示所有工具都必须走 Execute。
        "Call these tools as JavaScript inside `execute`; call tools outside this catalog directly.",
        "",
        "The catalog is complete.",
        "",
        "## Code Mode tools (call only inside `execute`)",
        "",
        "- host (1 tool)",
        "  - tools.host.ping(): Promise<string> // Ping",
      ].join("\n"),
    )
    // 该签名本身可装入12 token，标题另占7；边界失败证明标题确实计费。
    expect(CodeMode.make({ tools: { host: { ping } }, discovery: { catalogBudget: 12 } }).instructions()).toContain(
      "1 tool, none shown",
    )
  })

  test("decodes tool input and output before exposing either side", async () => {
    const observed: Array<unknown> = []
    const transformed = Tool.make({
      description: "Double a number",
      input: Schema.Struct({ value: Schema.NumberFromString }),
      output: Schema.NumberFromString,
      run: ({ value }) =>
        Effect.sync(() => {
          observed.push(value)
          return String(value * 2)
        }),
    })
    const runtime = CodeMode.make({
      tools: { math: { double: transformed } },
      onToolCallStart: (call) => Effect.sync(() => observed.push(call.input)),
    })

    const success = await Effect.runPromise(runtime.execute(`return await tools.math.double({ value: "21" })`))
    expect(success).toStrictEqual({ ok: true, value: 42, toolCalls: [{ name: "math.double" }] })
    expect(observed).toStrictEqual([{ value: 21 }, 21])

    const invalid = await Effect.runPromise(runtime.execute(`return await tools.math.double({ value: 21 })`))
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error.kind).toBe("InvalidToolInput")
    expect(observed).toStrictEqual([{ value: 21 }, 21])
  })

  test("returns JSON-safe data and normalizes undefined to null", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `return { top: undefined, nested: [1, undefined] }`,
      }),
    )
    expect(result).toStrictEqual({
      ok: true,
      value: { top: null, nested: [1, null] },
      toolCalls: [],
    })
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("rejects invalid configuration and discovery limits", async () => {
    expect(() => CodeMode.execute({ code: "return 1", limits: { timeoutMs: 0 } })).toThrow(RangeError)
    expect(() => CodeMode.execute({ code: "return 1", limits: { timeoutMs: Number.POSITIVE_INFINITY } })).toThrow(
      RangeError,
    )
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxToolCalls: -1 } })).toThrow(RangeError)
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxOutputBytes: -1 } })).toThrow(RangeError)
    // 日志留存预算独立于结果预算；无日志脚本也应在构造执行时拒绝无效配置。
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxLogBytes: -1 } })).toThrow(RangeError)

    expect(() => CodeMode.make({ tools, discovery: { catalogBudget: -1 } })).toThrow(RangeError)

    const result = await Effect.runPromise(
      CodeMode.make({
        tools,
        discovery: { catalogBudget: 0 },
      }).execute(`return await tools.$codemode.search({ query: "order", limit: 0.5 })`),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("InvalidToolInput")

    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      const invalidOffset = await Effect.runPromise(
        CodeMode.make({ tools }).execute(
          `return await tools.$codemode.search({ query: "order", offset: ${JSON.stringify(offset)} })`,
        ),
      )
      expect(invalidOffset.ok).toBe(false)
      if (!invalidOffset.ok) expect(invalidOffset.error.kind).toBe("InvalidToolInput")
    }
  })

  test("enforces the tool-call limit as a diagnostic", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ tools, code: source, limits: { maxToolCalls: 0 } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ToolCallLimitExceeded")
  })

  test("timeoutMs and maxToolCalls have no defaults: absent means unlimited", async () => {
    // 150 tool calls would have exceeded the old default cap of 100; with no limits
    // provided, there is no cap and no timeout - budgets are host policy.
    const counter = Tool.make({
      description: "Count invocations",
      input: Schema.Struct({}),
      output: Schema.Number,
      run: () => Effect.succeed(1),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { count: counter } },
        code: `
        let total = 0
        for (let i = 0; i < 150; i += 1) total += await tools.host.count({})
        return total
      `,
      }),
    )
    expect(result).toMatchObject({ ok: true, value: 150 })
    if (result.ok) expect(result.toolCalls.length).toBe(150)
  })

  test("the timeout interrupts a busy loop without any operation budget", async () => {
    // 纯while(true)没有工具等待或操作预算，仍应仅凭timeoutMs退出；中断依赖Effect在解释器步骤间自动让出。
    const startedAt = Date.now()
    const result = await Effect.runPromise(CodeMode.execute({ code: "while (true) {}", limits: { timeoutMs: 200 } }))
    const elapsedMs = Date.now() - startedAt

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("TimeoutExceeded")
      expect(result.error.message).toContain("timed out after 200ms")
    }
    expect(elapsedMs).toBeLessThan(3_000)
  })

  test("reserves the discovery namespace", () => {
    expect(() => CodeMode.make({ tools: { $codemode: { lookup } } })).toThrow(/reserved for CodeMode discovery tools/)
  })
})

test("fetch response readers compose as async methods over one response", async () => {
  // 响应快照只来自一次宿主请求，读取方法的 Promise 身份不能要求代理采用特殊写法。
  const result = await Effect.runPromise(
    CodeMode.execute({
      fetch: () =>
        Effect.succeed({
          url: "https://example.com",
          status: 200,
          statusText: "OK",
          ok: true,
          redirected: false,
          headers: {},
          text: '{"id":7}',
          bytes: [7],
        }),
      code: 'const response=await fetch("https://example.com"); const p=response.json(); return [p instanceof Promise, await Promise.all([p,response.text(),response.bytes()])]',
    }),
  )
  // json、text和bytes并行读取同一响应快照；结果类型不同且json返回Promise，不能将读取方法改成同步取值。
  expect(result).toMatchObject({ ok: true, value: [true, [{ id: 7 }, '{"id":7}', [7]]] })
})

// 优先路径只影响展示；预算放不下或路径不存在时不能制造能力，search 必须仍完整。
test("discovery priority competes within budget and never restores absent tools", async () => {
  const tool = (description: string) =>
    Tool.make({ description, input: Schema.Struct({}), run: () => Effect.succeed(null) })
  const tools = { a: tool("short"), host: { core: tool("eligible core") } }
  const options = { tools, discovery: { catalogBudget: 35, priority: ["host.core", "missing.read"] } }
  const preferred = CodeMode.make(options)
  expect(preferred.instructions()).toContain("tools.host.core(): Promise<unknown>")
  expect(preferred.instructions()).not.toContain("tools.a(): Promise<unknown>")
  expect(preferred.instructions()).not.toContain("missing.read")
  // 两个路径都留在同一索引，未内联不等于权限被撤销或工具不存在。
  expect(await Effect.runPromise(preferred.execute("return search({}).items.map(item=>item.path)"))).toMatchObject({
    ok: true,
    value: ["tools.a", "tools.host.core"],
  })
  // 工具集和35预算保持不变，只移除priority；前后入选项互换才能把变化归因于优先顺序。
  const ordinary = CodeMode.make({ tools, discovery: { catalogBudget: 35 } })
  expect(ordinary.instructions()).toContain("tools.a(): Promise<unknown>")
  expect(ordinary.instructions()).not.toContain("tools.host.core(): Promise<unknown>")
  // 零预算和超长核心签名都诚实标记 partial，不能为了优先级突破计费。
  expect(
    CodeMode.make({ tools, discovery: { catalogBudget: 0, priority: ["host.core"] } }).instructions(),
  ).not.toContain("tools.host.core()")
  const oversized = CodeMode.make({
    tools: { short: tool(""), ["long".repeat(100)]: tool("") },
    discovery: { catalogBudget: 140, priority: ["long".repeat(100)] },
  })
  expect(oversized.instructions()).toContain("tools.short(): Promise<unknown>")
  expect(oversized.instructions()).not.toContain(`tools.${"long".repeat(100)}()`)
})

// 报错只读已求值的形状；同一流程同时检查求值次数和可选链短路。
test("call diagnostics describe the receiver without repeating evaluation or exposing values", async () => {
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: `
    let effects = 0;
    function receiver() { effects++; return { files: [], truncated: false, credential: "private-value" }; }
    function key() { effects++; return "map"; }
    let shape; let scalar; let bounded;
    try { receiver()[key()](effects++); } catch (error) { shape = error.message; }
    const nothing = null; const object = { files: [] };
    nothing?.[effects++]?.(effects++); object.map?.(effects++);
    for (let i = 0; i < 100; i++) object["x".repeat(1000) + i] = "never-print";
    try { object.map(); } catch (error) { bounded = error.message; }
    try { const value = 1; value(); } catch (error) { scalar = error.message; }
    return { effects, shape, bounded, scalar };
  `,
    }),
  )
  if (!result.ok) throw new Error(result.error.message)
  const diagnostic = result.value as { effects: number; shape: string; bounded: string; scalar: string }
  // 三次副作用分别来自 receiver、computed key 和实参；诊断重求值或可选链失去短路都会改变总数。
  expect(diagnostic.effects).toBe(3)
  expect(diagnostic.shape).toContain("Object")
  expect(diagnostic.shape).toContain('"files"')
  expect(diagnostic.shape).toContain('"truncated"')
  // 可见键名帮助识别接收者，credential的实际值仍须隐藏；只检查Object类型不足以约束信息泄漏。
  expect(diagnostic.shape).not.toContain("private-value")
  // 100个超长键使朴素键列表远超上限，长度断言检查诊断预算，never-print另行检查值未进入消息。
  expect(diagnostic.bounded.length).toBeLessThan(1000)
  expect(diagnostic.bounded).not.toContain("never-print")
  // 标量调用没有属性列表，仍应报告number；不能把对象形状诊断硬套到所有非函数值。
  expect(diagnostic.scalar).toContain("number")
})

// 追加限额只约束日志留存，业务返回值仍由原数据出口交付。
test("capture limit bounds many logs without changing returned data", async () => {
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: `for (let i = 0; i < 10000; i++) console.log('x'.repeat(100)); return { files: ['full-value'] };`,
      // 一万行累计约一兆字节，远超1KiB捕获预算；短业务结果则排除触发结果截断的干扰。
      limits: { maxLogBytes: 1024 },
    }),
  )
  expect(result).toMatchObject({ ok: true, value: { files: ["full-value"] }, truncated: true })
  // 每行100字节，1024字节只留十行；额外一行是省略标记，不占业务返回值。
  expect(result.logs).toHaveLength(11)
  // 丢弃9990行仍要持续计数并合成一个标记，不能预算耗尽后停止统计或每次追加一个标记。
  expect(result.logs?.at(-1)).toBe("[logs truncated: 9990 lines omitted during capture]")
  expect(result.logs?.slice(0, -1).join("\n").length).toBeLessThanOrEqual(1024)
})
// 函数帧共用一个 UTF-8 留存预算，失败出口继续返回已捕获日志。
test("shared async capture and failure keep log marker without changing catch behavior", async () => {
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: `async function item() { console.log('中😀'); await sleep(1); console.log('中😀'); }
      await Promise.all([item(), item()]); throw new Error('expected');`,
      // 两个async各打印两次并跨sleep恢复，四行需共享同一捕获预算，而不是每个调用帧各领一份。
      limits: { maxLogBytes: 8 },
    }),
  )
  expect(result).toMatchObject({ ok: false, truncated: true })
  // 中与emoji合计7个UTF-8字节，8字节预算只能留一行，可捕获按JS字符数误计的实现。
  expect(result.logs).toEqual(["中😀", "[logs truncated: 3 lines omitted during capture]"])
  // 预算已截断日志后仍应保留用户抛出的expected，日志处理不能覆盖原始失败原因。
  if (!result.ok) expect(result.error.message).toContain("expected")
})

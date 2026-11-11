import { describe, expect, test } from "bun:test"
// 参数形式回归沿用真实转换型 Schema，避免只测展示用 JSON。
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Scheduler, Schema, SchemaGetter } from "effect"
import { TestClock } from "effect/testing"
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
  // 工具返回真实解码入参，断言可同时发现形式转换错误与 decoder 被绕过。
  const execute = (input: Schema.Decoder<unknown>, args: string) =>
    Effect.runPromise(
      CodeMode.execute({
        tools: { call: Tool.make({ description: "Input forms", input, run: (value) => Effect.succeed(value) }) },
        code: `return await tools.call(${args})`,
      }),
    )

  // 不依赖参数名字；对象合同按唯一必填字段包装，标量合同保持原始输入。
  test("object shorthand and original scalar inputs keep their own contracts", async () => {
    expect(await execute(Schema.Struct({ unusual: Schema.String }), '"hello"')).toMatchObject({
      ok: true,
      value: { unusual: "hello" },
    })
    // 相同字符串在对象合同里得到命名字段，在标量合同里保持字符串；形状由合同决定。
    expect(await execute(Schema.String, '"hello"')).toMatchObject({ ok: true, value: "hello" })
  })

  // 假值也是显式输入；两种形式必须给真实 host 相同数据，而非把空值当缺省。
  for (const [schema, literal, value] of [
    [Schema.Boolean, "false", false],
    [Schema.Number, "0", 0],
    [Schema.Null, "null", null],
    [Schema.String, '""', ""],
  ] as const) {
    test(`preserve scalar ${literal}`, async () => {
      expect(await execute(Schema.Struct({ key: schema }), literal)).toMatchObject({ ok: true, value: { key: value } })
      expect(await execute(schema, literal)).toMatchObject({ ok: true, value })
    })
  }

  // 单键、多键、数组和嵌套对象各有原始业务形状；标量decoder拒绝它们后不能挑值重试。
  test("scalar rejects object wrappers before starting the host", async () => {
    let calls = 0
    const runtime = CodeMode.make({
      tools: {
        call: Tool.make({
          description: "Scalar input",
          input: Schema.String,
          run: (value) =>
            Effect.sync(() => {
              calls++
              return value
            }),
        }),
      },
    })
    // 首个单键对象看似可无损拆包，其余样本分别覆盖空对象、多键、数组、嵌套和假值，均须保留原形验证。
    for (const args of [
      '{arbitrary:"hello"}',
      "{}",
      '{a:"x",b:"y"}',
      '["x"]',
      '{a:{nested:"x"}}',
      "{a:undefined}",
      "{a:0}",
    ]) {
      expect(await Effect.runPromise(runtime.execute(`return await tools.call(${args})`))).toMatchObject({
        ok: false,
        error: { kind: "InvalidToolInput" },
      })
    }
    // 错误诊断也可能出现在工具已执行之后，宿主计数单独约束参数校验必须先于副作用。
    expect(calls).toBe(0)
  })

  // 默认值的副作用和实际结果共同证明只解码一次；仅统计次数不足以证明参数正确。
  test("defaults and transforms run once after normalization", async () => {
    let defaults = 0
    const input = Schema.Struct({
      // 编码域是字符串而解码域是数字；以解码类型分类会拒绝合法调用。
      count: Schema.NumberFromString,
      flag: Schema.Boolean.pipe(
        Schema.withDecodingDefaultKey(
          Effect.sync(() => {
            defaults++
            return true
          }),
        ),
      ),
    })
    const tool = Tool.make({ description: "default", input, run: (value) => Effect.succeed(value) })
    const runtime = CodeMode.make({ tools: { call: tool } })
    // 展示构建必须是静态分析，不能为了识别输入形状触发默认值副作用。
    runtime.catalog()
    runtime.instructions()
    expect(defaults).toBe(0)
    // 两种拼写各调用一次并得到完整默认字段，不能预解码后丢掉默认值。
    for (const args of ['"42"', '{count:"42"}']) {
      expect(await Effect.runPromise(runtime.execute(`return await tools.call(${args})`))).toMatchObject({
        ok: true,
        value: { count: 42, flag: true },
      })
    }
    // 两种写法共用同一decoder，默认值计数还能发现目录构建之外的重复解码。
    expect(defaults).toBe(2)
    // 根标量转换与上面的对象字段转换共用编码类型；只有对象合同允许把字符串包进字段。
    expect(await execute(Schema.NumberFromString, '"42"')).toMatchObject({ ok: true, value: 42 })
    expect(await execute(Schema.NumberFromString, '{named:"42"}')).toMatchObject({ ok: false })
  })

  // 分类不能执行 refinement，也不能把验证失败改成第二次调用。
  test("refinement remains original validation authority", async () => {
    let checks = 0
    // refinement放在唯一字段内部，使元数据提取能识别简写，又必须把长度校验留到真正调用时。
    const input = Schema.Struct({
      key: Schema.String.check(
        Schema.makeFilter((value) => {
          checks++
          return value.length > 2
        }),
      ),
    })
    // 描述符提取发生在执行之前，此时 refinement 必须仍未运行。
    const forms = Tool.make({ description: "Refinement", input, run: Effect.succeed }).inputForms
    expect(forms?.key).toBe("key")
    expect(checks).toBe(0)
    // 结构转换成功不意味着业务校验成功；短字符串必须保留原始拒绝。
    expect(await execute(input, '"x"')).toMatchObject({ ok: false })
    expect(checks).toBe(1)
    // 合法值证明 refinement 没有被全面禁用，也没有缓存前次失败。
    expect(await execute(input, '"valid"')).toMatchObject({ ok: true, value: { key: "valid" } })
    expect(checks).toBe(2)
  })

  // 不透明声明、索引对象、递归与混合 union 没有可证明的唯一形式。
  test("unsupported shapes retain original input domains", async () => {
    for (const input of [
      // Unknown 与 declare 不提供编码域证明，不得仅凭一次运行值猜形式。
      Schema.Unknown,
      Schema.declare((_value): _value is unknown => true),
      Schema.Array(Schema.String),
      // 索引对象没有唯一目标字段，因此任意字符串都不能自动绑定到一个键。
      Schema.Record(Schema.String, Schema.String),
      // 混合 union 的对象本来就是合法业务值，反向拆包会改变原合同。
      Schema.Union([Schema.String, Schema.Struct({ key: Schema.String })]),
      // 两个必填字段与两个可选字段都没有唯一目标键，字段是否可省略不能替代唯一性的证明。
      Schema.Struct({ a: Schema.String, b: Schema.String }),
      Schema.Struct({ a: Schema.optionalKey(Schema.String), b: Schema.optionalKey(Schema.String) }),
      // 不执行延迟定义来获取元数据，避免引入额外求值或递归分析路径。
      Schema.suspend(() => Schema.String),
    ]) {
      expect(Tool.make({ description: "Unsupported shorthand", input, run: Effect.succeed }).inputForms).toBeUndefined()
    }
    expect(
      await execute(Schema.Union([Schema.String, Schema.Struct({ key: Schema.String })]), '{key:"x"}'),
    ).toMatchObject({ ok: true, value: { key: "x" } })
    // 不支持便利形式不等于拒绝原形式，数组仍完整交给原 decoder。
    expect(await execute(Schema.Array(Schema.String), '["x"]')).toMatchObject({ ok: true, value: ["x"] })
  })

  // 单可选字段允许正向包装；直接标量union和literal继续由原decoder决定取值。
  test("optional, nullable, literal and scalar union domains", async () => {
    expect(await execute(Schema.Struct({ key: Schema.optionalKey(Schema.String) }), '"x"')).toMatchObject({
      ok: true,
      value: { key: "x" },
    })
    // null在这里是可接受的字段值，包装后必须保留key，不能当成没有传入参数。
    expect(await execute(Schema.Struct({ key: Schema.NullOr(Schema.String) }), "null")).toMatchObject({
      ok: true,
      value: { key: null },
    })
    expect(await execute(Schema.Union([Schema.String, Schema.Number]), "0")).toMatchObject({ ok: true, value: 0 })
    // 字面量限制必须由原 decoder 检查，不能因标量分类就放宽取值。
    expect(await execute(Schema.Literal("yes"), '"no"')).toMatchObject({ ok: false })
    expect(await execute(Schema.Literal("yes"), '"yes"')).toMatchObject({ ok: true, value: "yes" })
  })

  // 显式 undefined 直接交原 decoder；包装里的 undefined 不被拆成缺省触发器。
  test("undefined and zero arguments retain default contract", async () => {
    let defaults = 0
    const input = Schema.String.pipe(
      Schema.withDecodingDefault(
        Effect.sync(() => {
          defaults++
          return "default"
        }),
      ),
    )
    // 包装对象不是省略参数；拆出 undefined 会错误触发原本不适用的默认值。
    expect(await execute(input, "{a:undefined}")).toMatchObject({ ok: false })
    expect(defaults).toBe(0)
    // 直接传 undefined 才保持原始默认语义，不把显式省略当包装失败。
    expect(await execute(input, "undefined")).toMatchObject({ ok: true, value: "default" })
    expect(defaults).toBe(1)
    // 空args生成真正的零参数调用；它与显式undefined、带undefined属性的对象是三种独立输入。
    expect(await execute(Schema.Struct({ key: Schema.optionalKey(Schema.String) }), "")).toMatchObject({
      ok: true,
      value: {},
    })
  })

  // adapter 保留真实 schema 的描述符；展示属性被插件替换也不应改变规范输入键。
  test("actual metadata outranks display schema and leaves host decoding once", async () => {
    const actual = Schema.Struct({ realKey: Schema.String })
    // 展示 schema 故意把名称和类型都改错，确保执行权威并非展示推导结果。
    const displayed = { type: "object", properties: { displayKey: { type: "number" } } } as const
    let decodes = 0
    const seen: unknown[] = []
    // 展示schema不解码，run里的真实decoder拥有解码权；计数能发现类库在调用前重复执行它。
    const runtime = CodeMode.make({
      tools: {
        call: Tool.make({
          description: "adapter",
          input: displayed,
          inputContract: actual,
          run: (value) =>
            Effect.sync(() => {
              decodes++
              return Schema.decodeUnknownSync(actual)(value)
            }),
        }),
      },
      // start 回调看到的是标准化后的真实入参，不得继续暴露另一套形状。
      onToolCallStart: (call) =>
        Effect.sync(() => {
          seen.push(call.input)
        }),
    })
    expect(await Effect.runPromise(runtime.execute('return await tools.call("real")'))).toMatchObject({
      ok: true,
      value: { realKey: "real" },
    })
    // 同时验证调用观察面和工具返回值，防止仅对日志做展示性规范化。
    expect(seen).toEqual([{ realKey: "real" }])
    expect(decodes).toBe(1)
    // 只有展示 schema 时字符串保持原样，不擅自变成任何命名对象。
    const plain = CodeMode.make({
      tools: { call: Tool.make({ description: "plain", input: displayed, run: (value) => Effect.succeed(value) }) },
    })
    expect(await Effect.runPromise(plain.execute('return await tools.call("raw")'))).toMatchObject({
      ok: true,
      value: "raw",
    })
  })

  // 危险字段不生成简写，原解码器拒绝标量，不能靠第二遍复制才拒绝。
  test("object shorthand cannot introduce blocked fields", async () => {
    const { ToolRuntime } = await import("../src/tool-runtime.js")
    // 真实 schema 不能授予危险属性访问权，也不能让简写制造该字段。
    const object = ToolRuntime.make(
      {
        call: Tool.make({
          description: "object",
          input: Schema.Struct({ constructor: Schema.String }),
          run: (value) => Effect.succeed(value),
        }),
      },
      undefined,
      [],
    )
    await expect(Effect.runPromise(object.invoke(["call"], ["x"]))).rejects.toThrow("Expected object")
  })

  // 根转换前后形状不同，分类必须沿编码侧而非最终业务返回类型判断。
  test("root transformations use encoded input domains and decode exactly once", async () => {
    let objectDecodes = 0
    const object = Schema.Struct({ wire: Schema.String }).pipe(
      Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((value) => {
          objectDecodes++
          return Number(value.wire)
        }),
        encode: SchemaGetter.passthrough({ strict: false }),
      }),
    )
    // 解码结果是数字，但原始调用仍应先绑定到编码对象的 wire 字段。
    expect(await execute(object, '"42"')).toMatchObject({ ok: true, value: 42 })
    expect(objectDecodes).toBe(1)
    // 与上面的对象转数字成对构造字符串转对象，两个相反方向可排除仅按解码后的类型分类。
    let scalarDecodes = 0
    const scalar = Schema.String.pipe(
      Schema.decodeTo(Schema.Struct({ count: Schema.Number }), {
        decode: SchemaGetter.transform((value) => {
          scalarDecodes++
          return { count: Number(value) }
        }),
        encode: SchemaGetter.passthrough({ strict: false }),
      }),
    )
    // 解码后虽是对象，encoded仍是字符串；这个反向形状能识别错用decoded合同的分类器。
    expect(await execute(scalar, '{arbitrary:"7"}')).toMatchObject({ ok: false })
    // 包装对象在编码类型校验处就失败，转换计数保持0才能排除执行转换后再报错。
    expect(scalarDecodes).toBe(0)
    expect(await execute(scalar, '"7"')).toMatchObject({ ok: true, value: { count: 7 } })
    expect(scalarDecodes).toBe(1)
  })

  // adapter 的真实标量解码器收到原输入；类库不能抹去包装键。
  test("adapter scalar descriptor forwards original scalar domain to one host decoder", async () => {
    let decodes = 0
    const actual = Schema.String.pipe(
      Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((value) => {
          decodes++
          return Number(value)
        }),
        encode: SchemaGetter.passthrough({ strict: false }),
      }),
    )
    const seen: unknown[] = []
    const runtime = CodeMode.make({
      tools: {
        call: Tool.make({
          description: "scalar adapter",
          // 纯展示对象与实际字符串合同冲突，用于发现错误地按展示 schema 重新分类。
          input: { type: "object", properties: { misleading: { type: "boolean" } } },
          inputContract: actual,
          run: (value) =>
            Effect.sync(() => {
              seen.push(value)
              return Schema.decodeUnknownSync(actual)(value)
            }),
        }),
      },
    })
    runtime.catalog()
    // 编目录不能调用宿主 decoder；只有原始字符串能成功解码。
    expect(decodes).toBe(0)
    expect(await Effect.runPromise(runtime.execute('return await tools.call("42")'))).toMatchObject({
      ok: true,
      value: 42,
    })
    // adapter的展示schema只负责描述，错误包装仍应原样交给宿主decoder，由它按字符串合同拒绝。
    expect(await Effect.runPromise(runtime.execute('return await tools.call({arbitrary:"42"})'))).toMatchObject({
      ok: false,
    })
    // seen在解码前记录两次原始输入；decodes只统计成功转换，错误包装到达宿主但不会执行转换。
    expect(seen).toEqual(["42", { arbitrary: "42" }])
    expect(decodes).toBe(1)
  })

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

    // 同一执行契约内用新进程检查冷加载边界，不新增测试注册。
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-install",
        "--eval",
        `
      const { CodeMode } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)})
      const { Effect } = await import("effect")
      // resolve 只定位已安装编译器；cache 观察不能为检查而提前执行模块。
      const compiler = require.resolve("typescript")
      const loaded = () => Boolean(require.cache[compiler])
      // 库导入、目录渲染和两种 Effect 构造都不执行程序，分别检查资源边界。
      const states = [loaded()]
      const runtime = CodeMode.make()
      const metadata = { catalog: runtime.catalog(), hasInstructions: runtime.instructions().length > 0 }
      states.push(loaded())
      const prepared = runtime.execute("const answer: number = 42; return answer")
      // fetch 只取本地 Effect 数据；响应 json 方法仍经过解释器的第二处真实转译。
      const direct = CodeMode.execute({
        code: 'const response: object = await fetch("https://example.invalid"); return { url: response.url, status: response.status, body: await response.json() }',
        fetch: (url) => Effect.succeed({ url, status: 200, statusText: "OK", ok: true,
          redirected: false, headers: {}, text: "2", bytes: [50] }),
      })
      states.push(loaded())
      // 真实类型注解要求两入口仍使用同一编译器，不能通过跳过执行获得轻量结果。
      const values = await Promise.all([Effect.runPromise(prepared), Effect.runPromise(direct)])
      console.log(JSON.stringify({ states, loaded: loaded(), metadata, values }))
    `,
      ],
      {
        cwd: import.meta.dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // 子进程四秒预算短于既有用例默认五秒，保留回收时间；不放宽原用例期限。
        timeout: 4_000,
      },
    )
    try {
      // 同时消费两条管道并等待退出，防止资源探针自身因输出反压而挂起。
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      expect(JSON.parse(stdout)).toStrictEqual({
        states: [false, false, false],
        loaded: true,
        metadata: { catalog: [], hasInstructions: true },
        values: [
          { ok: true, value: 42, toolCalls: [] },
          {
            ok: true,
            value: { url: "https://example.invalid", status: 200, body: 2 },
            toolCalls: [{ name: "$codemode.fetch" }],
          },
        ],
      })
    } finally {
      // 即使读取或断言失败，本测试也负责终止并收完自己创建的进程。
      if (child.exitCode === null) child.kill()
      await child.exited
    }
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
    expect(CodeMode.description).toContain("return the fields needed for your next decision")
    expect(CodeMode.description).toContain("Chain dependent calls with await")
    // fetch 由宿主提供；仅保留必要能力边界，不加入强制异常包装教条。
    expect(CodeMode.description).toContain("host-supplied fetch")
    expect(CodeMode.description).toContain("Globals: tools, search, console, sleep(ms)")
    const complete = CodeMode.make({ tools }).instructions()
    expect(complete).toStartWith("# Code Mode\n\nUse these paths inside `execute`.")
    expect(complete).toContain("The catalog is complete.")
    expect(complete).toContain("## Code Mode tools")
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
    expect(runtime.instructions()).toContain("The catalog is partial.")
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
    const ping = Tool.make({
      description: "Ping",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("pong"),
    })
    const runtime = CodeMode.make({ tools: { host: { ping, lookup } } })
    // 原缺口在直接访问items时出现；只测试await search会掩盖同步语义错误。
    const result = await Effect.runPromise(
      runtime.execute(`
      const item = search({query: "host.ping"}).items[0];
      return {item, pong: await tools.host.ping(), again: (await search({query: "host.ping"})).items[0].path};
    `),
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        item: { path: "tools.host.ping", description: "Ping", signature: "tools.host.ping(): Promise<string>" },
        pong: "pong",
        again: "tools.host.ping",
      },
    })
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
    const item = Tool.make({
      description: "List",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("ok"),
    })
    const runtime = CodeMode.make({ tools: { api: { get_timezones: item, zones: { list: item }, get_zones: item } } })
    // 子串timezones不能排在完整路径词zones之前；同分按确定性路径顺序输出。
    expect(await Effect.runPromise(runtime.execute('search({query:"zones"}).items.map(x => x.path)'))).toMatchObject({
      ok: true,
      value: ["tools.api.get_zones", "tools.api.zones.list", "tools.api.get_timezones"],
    })
    for (const namespace of ["api.zones", "tools.api.zones"]) {
      expect(
        await Effect.runPromise(
          runtime.execute(`search({namespace:${JSON.stringify(namespace)}}).items.map(x => x.path)`),
        ),
      ).toMatchObject({ ok: true, value: ["tools.api.zones.list"] })
    }
    const missing = await Effect.runPromise(runtime.execute("await tools.api.list_zones()"))
    expect(missing).toMatchObject({
      ok: false,
      error: {
        kind: "UnknownTool",
        message: "Unknown tool 'api.list_zones'. Did you mean tools.api.zones.list?",
        suggestions: ["Use search to find available tools."],
      },
    })
  })

  test("upstream catalog includes namespace cost and renders exact complete instructions", () => {
    const ping = Tool.make({
      description: "Ping",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("pong"),
    })
    const runtime = CodeMode.make({ tools: { host: { ping } } })
    // 独立预期取官方instructions.render格式，固定说明和目录只各承担自己的职责。
    expect(runtime.instructions()).toBe(
      [
        "# Code Mode",
        "",
        // 固定宿主入口和字段文档去向，短提示不能暗示所有工具都必须走 Execute。
        "Use these paths inside `execute`. Other tools shown in the conversation can be called directly.",
        "",
        "The catalog is complete.",
        "",
        "## Code Mode tools",
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
    // 超界在入口拒绝；最大可计时值仍允许短脚本正常结束，不能退化成立即超时。
    expect(() => CodeMode.execute({ code: "return 1", limits: { timeoutMs: 2_147_483_648 } })).toThrow(RangeError)
    expect(
      await Effect.runPromise(CodeMode.execute({ code: "return 1", limits: { timeoutMs: 2_147_483_647 } })),
    ).toMatchObject({ ok: true, value: 1 })
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

describe("TypeScript source diagnostics", () => {
  test.each([
    ["const x = ;", "source line 1, column 11"],
    ["const first = 1;\nconst second: number = ;\nreturn first;", "source line 2, column 24"],
    ['const 标题 = "😀"; const x = ;', "source line 1, column 28"],
    ['const first = 1;\r\nconst 中文 = "😀";\r\nconst second: number = ;', "source line 3, column 24"],
  ])("reports the original position in %s", async (code, position) => {
    // 独立预期按原始源码计行；中文和emoji不能误用UTF-8字节当TypeScript列号。
    const result = await Effect.runPromise(CodeMode.execute({ code }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("ParseError")
      expect(result.error.message).toContain(position)
    }
  })

  test("does not label the wrapper as user source", async () => {
    // 缺少闭合符时诊断落在包装器或EOF，宁可没有位置也不能指向另一段用户代码。
    for (const code of ["if (true) {\nreturn 1;", 'const s = "abc']) {
      const result = await Effect.runPromise(CodeMode.execute({ code }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).not.toContain("source line")
    }
    expect(await Effect.runPromise(CodeMode.execute({ code: "const x: number = 1; return x;" }))).toMatchObject({
      ok: true,
      value: 1,
    })
  })
})

test("compact discovery and bounded details share exact signatures and lossless pagination", async () => {
  const runtime = CodeMode.make({
    tools: {
      many: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [
          `tool${i}`,
          Tool.make({
            description: `Numbered tool ${i}`,
            input: Schema.Struct({ id: Schema.String.annotate({ description: "Identifier ".repeat(40) }) }),
            output: Schema.String,
            run: () => Effect.die("Discovery must not invoke tools"),
          }),
        ]),
      ),
    },
  })
  const search = async (request: object) => {
    const result = await Effect.runPromise(runtime.execute(`return search(${JSON.stringify(request)})`))
    if (!result.ok) throw Error(result.error.message)
    return result.value as {
      items: Array<{ path: string; signature: string; inputSchema?: unknown; outputSchema?: unknown }>
      remaining: number
      next: { offset: number } | null
    }
  }
  // 十四项超过普通页默认十项及详情页最多三项；独立累计路径核对remaining/next，防止漏项或重复被自洽游标掩盖。
  const compact = await search({})
  expect(compact.items).toHaveLength(10)
  expect(compact.next).toEqual({ offset: 10 })
  for (const item of compact.items) {
    expect(item).not.toHaveProperty("inputSchema")
    expect(item).not.toHaveProperty("outputSchema")
  }
  expect((await search({ query: "Numbered", limit: 1 })).items[0]).not.toHaveProperty("inputSchema")
  const detailed = await search({ detail: true, limit: 99 })
  expect(detailed.items).toHaveLength(3)
  expect(detailed.next).toEqual({ offset: 3 })
  for (const item of detailed.items) expect(item).toHaveProperty("inputSchema")
  expect((await search({ detail: true, limit: 1 })).items).toHaveLength(1)
  const paths: string[] = []
  while (paths.length < 14) {
    const page = await search({ detail: true, offset: paths.length })
    expect(page.items.length).toBeGreaterThan(0)
    paths.push(...page.items.map((i) => i.path))
    expect(page.remaining).toBe(14 - paths.length)
    expect(page.next).toEqual(page.remaining ? { offset: paths.length } : null)
  }
  expect(new Set(paths).size).toBe(14)
  // 普通查询不附schema，精确路径即使detail:false也保留两侧schema，并与显式详情使用同一签名。
  for (const query of ["many.tool13", "tools.many.tool13"]) {
    const a = await search({ query })
    const b = await search({ query, detail: true })
    expect(a.items).toHaveLength(1)
    expect(a.items[0]).toHaveProperty("inputSchema")
    expect(a.items[0]).toHaveProperty("outputSchema")
    expect((await search({ query, detail: false })).items).toEqual(a.items)
    expect(b.items).toHaveLength(1)
    expect(a.items[0].signature).toBe(b.items[0].signature)
    expect(a.next).toBeNull()
    expect(b.next).toBeNull()
  }
})

// 投影夹具拥有自己的 run，合并文件不能覆盖已有宿主失败测试的同名入口。
describe("CodeMode JSON text results", () => {
  // 通过公共入口验证宿主显式投影，不让测试依赖弱映射内部实现。
  const run = (
    text: string,
    code = "const r = await tools.get({}); return { type: typeof r, value: r, raw: String(r) }",
    output?: Schema.Decoder<unknown>,
    project = true,
  ) =>
    Effect.runPromise(
      CodeMode.execute({
        tools: {
          get: Tool.make({
            description: "JSON text",
            input: Schema.Struct({}),
            output,
            // project只切换宿主是否显式投影，原文和输出decoder保持相同，便于隔离隐式JSON解析的回归。
            run: () => Effect.succeed(project ? CodeMode.fromJsonText(text) : text),
          }),
        },
        code,
      }),
    )

  test("opted-in object and array support structured operations and exact source coercion", async () => {
    // 空白属于原始文本，数组不能退化成逗号连接后的字符串。
    expect(await run(' {"items":[1]} ')).toMatchObject({
      ok: true,
      value: { type: "object", value: { items: [1] }, raw: ' {"items":[1]} ' },
    })
    // 数组的默认String是1,2，保留方括号和空格才能证明读取了源文本，而不是普通数组强制转换。
    expect(await run(" [1,2] ")).toMatchObject({ ok: true, value: { type: "object", value: [1, 2], raw: " [1,2] " } })
  })

  // 拒绝投影不是工具失败；危险键、过深结构和溢出均保留完整成功文本。
  for (const [label, text] of Object.entries({
    // 原型污染键在根层拒绝，不能因 JSON.parse 生成普通对象而放行。
    proto: '{"__proto__":{"polluted":true}}',
    // constructor 即使值是数字，也仍然属于解释器禁止访问的字段。
    constructor: '{"constructor":1}',
    // 数组内对象同样受边界约束，不能只检查投影根对象。
    nested: '{"items":[{"prototype":1}]}',
    // 34 层明确越过现有数据深度界限，必须保持文本成功而非工具异常。
    depth: '{"a":'.repeat(34) + "1" + "}".repeat(34),
    // JSON 数字溢出后会变成 Infinity；结构化出口会丢失信息，因此不投影。
    overflow: '{"items":[1e400]}',
    // 负溢出覆盖数组根分支，避免只在对象属性中检查数字。
    negativeOverflow: "[-1e400]",
    // 合法 JSON 原始值不属于对象/数组投影域，尤其不能把零当作空值。
    number: "0",
    boolean: "false",
    string: '"abc"',
    null: "null",
    // 畸形JSON与空字符串也保持成功文本；投影失败不等于工具业务失败。
    malformed: "{ nope",
    empty: "",
  }))
    test(`unrepresentable or non-container source remains exact text: ${label}`, async () => {
      expect(await run(text)).toMatchObject({ ok: true, value: { type: "string", value: text, raw: text } })
      // 检查宿主原型仍未受污染，文本回退不能以不安全对象作为中间成功结果。
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    })

  test("ordinary and declared strings are never implicitly projected", async () => {
    // 类库必须由宿主显式选择，内容看起来像 JSON 本身不构成解析权限。
    for (const output of [undefined, Schema.String]) {
      const raw = ' {"items":[1]} '
      // 两种输出声明都返回同一份原文，排除按内容自动推断格式的实现。
      const result = await run(raw, "const r = await tools.get({}); return { type: typeof r, value: r }", output, false)
      // 同一段可解析JSON在project=false时仍是string，声明Schema.String也不能偷偷启用投影。
      expect(result).toMatchObject({ ok: true, value: { type: "string", value: raw } })
    }
  })

  test("native operations and internal container copies preserve source", async () => {
    // Map/Set 与数组方法会经过内部数据复制；这些副本仍需支持原始文本访问。
    const raw = ' {"items":[1,2]} '
    expect(
      // sum证明结构化读取可用，template、alias和容器回读同时要求来源元数据随内部值保留。
      await run(
        raw,
        `const r = await tools.get({});
    const map = new Map([["r", r]]); const set = new Set([r]);
    return { sum: r.items.reduce((a,b) => a+b, 0), template: \`x\${r}\`, alias: r.text,
      map: String(map.get("r")), set: Array.from(set).map(String), copy: [r].map(String) }`,
      ),
    ).toMatchObject({ ok: true, value: { sum: 3, template: `x${raw}`, alias: raw, map: raw, set: [raw], copy: [raw] } })
    // 顶层数组的正常索引、长度与遍历不因来源标记而改变。
    expect(
      await run(
        "[1,2]",
        "const r=await tools.get({});return { length:r.length, doubled:r.map(x=>x*2), keys:Object.keys(r) }",
      ),
    ).toMatchObject({ ok: true, value: { length: 2, doubled: [2, 4], keys: ["0", "1"] } })
  })

  test("Notebook reuse keeps readonly source snapshot after business mutation", async () => {
    // 同一环境跨 cell 复用业务值，但源文本不随数组修改而变化。
    const raw = ' {"items":[1]} '
    const runtime = CodeMode.make({
      environment: CodeMode.createEnvironment(),
      tools: {
        get: Tool.make({
          description: "text",
          input: Schema.Struct({}),
          run: () => Effect.succeed(CodeMode.fromJsonText(raw)),
        }),
      },
    })
    // 第一格只保存值，不导出内部对象；第二格必须从环境中找回同一来源。
    expect(await Effect.runPromise(runtime.execute("const r=await tools.get({});return r.text"))).toMatchObject({
      ok: true,
      value: raw,
    })
    // 写入别名须成为可捕获的沙箱错误，不能泄漏宿主异常。
    expect(
      await Effect.runPromise(runtime.execute('try {r.text="changed"} catch(e) {return e.message}')),
    ).toMatchObject({
      ok: true,
      value: "Attempted to assign to readonly property.",
    })
    // 先尝试覆写只读text后再修改items，分别约束元数据不可改与业务数组仍可变。
    expect(
      await Effect.runPromise(
        // 变更后的 JSON 与原始 String 同时断言，区分业务快照和来源快照。
        runtime.execute(
          "r.items.push(2);return {raw:String(r),text:r.text,json:JSON.stringify(r),keys:Object.keys(r)}",
        ),
      ),
    ).toMatchObject({ ok: true, value: { raw, text: raw, json: '{"items":[1,2]}', keys: ["items"] } })
  })

  test("business text collisions retain their original type and writable field", async () => {
    // 同名字段可能不是字符串，便利别名不能覆盖合法业务数据。
    for (const text of ["business", 0, false, null]) {
      const raw = JSON.stringify({ text })
      expect(
        // original保留碰撞字段的原类型，text与json显示业务写入生效，raw则仍是修改前来源。
        await run(
          raw,
          'const r=await tools.get({});const original=r.text;r.text="edited";return {original,text:r.text,raw:String(r),json:JSON.stringify(r)}',
        ),
      ).toMatchObject({ ok: true, value: { original: text, text: "edited", raw, json: '{"text":"edited"}' } })
    }
  })

  test("host arguments and final results carry only business data", async () => {
    // 精确检查自有属性而非仅 stringify，防止不可枚举别名偷偷越过出口。
    const raw = '{"items":[1]}'
    // 直接观察真实工具收到的值，不通过 schema 重建来掩盖出口残留属性。
    const seen: unknown[] = []
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          get: Tool.make({
            description: "text",
            input: Schema.Struct({}),
            run: () => Effect.succeed(CodeMode.fromJsonText(raw)),
          }),
          echo: Tool.make({
            description: "egress",
            // Unknown 保持宿主入参原样，使不可枚举字段泄漏也能被断言发现。
            input: Schema.Unknown,
            run: (value) => {
              seen.push(value)
              return Effect.succeed(value)
            },
          }),
        },
        code: "const r=await tools.get({});const echoed=await tools.echo(r);return {r,echoed,echoedRaw:String(echoed)}",
      }),
    )
    // 宿主既要得到可用业务结构，也不能取得沙箱便利属性。
    expect(seen).toEqual([{ items: [1] }])
    expect(Object.getOwnPropertyNames(seen[0])).toEqual(["items"])
    // echo返回未投影的普通对象，String(echoed)回到默认形式；不能凭同一业务形状继承先前的来源。
    expect(result).toMatchObject({
      ok: true,
      value: { r: { items: [1] }, echoed: { items: [1] }, echoedRaw: "[object Object]" },
    })
    // 重新进入解释器的普通宿主回声不能凭旧对象形状恢复来源。
    if (!result.ok) throw new Error("expected successful execution")
    if (result.value === null || typeof result.value !== "object" || !("r" in result.value))
      throw new Error("expected object result")
    expect(Object.getOwnPropertyNames(result.value.r)).toEqual(["items"])
  })

  test("output schemas see original fields without a fabricated optional text", async () => {
    // 解码前不得安装别名，否则 optionalKey 会把它复制成可枚举业务字段。
    const raw = '{"items":[1]}'
    // 可选字段比必填错误更隐蔽：被伪造后仍会解码成功，却污染 JSON 和键集合。
    const output: Schema.Decoder<unknown> = Schema.Struct({
      items: Schema.Array(Schema.Number),
      text: Schema.optionalKey(Schema.String),
    })
    const result = await run(
      raw,
      "const r=await tools.get({});return {keys:Object.keys(r),json:JSON.stringify(r),raw:String(r),text:r.text}",
      output,
    )
    // keys与json要求text不成为业务字段，raw与text同时要求便利读取仍可用，不能简单删掉别名通过测试。
    expect(result).toMatchObject({ ok: true, value: { keys: ["items"], json: raw, raw, text: raw } })
  })

  test("required text and declared string still reject projected business objects", async () => {
    // 便利别名既不能满足必填字段，也不能把对象伪装成声明的字符串输出。
    // 宿主可动态声明解码器；保留 unknown 输入类型以真实测试运行期验证。
    const outputs: Schema.Decoder<unknown>[] = [
      Schema.String,
      Schema.Struct({ items: Schema.Array(Schema.Number), text: Schema.String }),
    ]
    for (const output of outputs) {
      const result = await run('{"items":[1]}', "try {await tools.get({})} catch(e) {return e.message}", output)
      // 错误必须来自原有输出验证，而不是改成成功原文或重新调用工具。
      expect(result).toMatchObject({ ok: true, value: "Invalid output from tool 'get'." })
    }
  })

  test("object output decoding runs once and source follows the transformed root", async () => {
    // 记录解码副作用及输入字段，证明没有为来源兼容再次执行转换。
    let calls = 0
    const raw = '{"items":[1]}'
    const output: Schema.Decoder<unknown> = Schema.Struct({
      items: Schema.Array(Schema.Number),
      text: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(Schema.Struct({ count: Schema.Number }), {
        decode: SchemaGetter.transform((value) => {
          calls++
          // 这里观察实际解码输入，避免只从最终枚举结果推断没有字段污染。
          expect(Object.hasOwn(value, "text")).toBe(false)
          // 返回新根对象，专门覆盖解码丢失原对象身份时的来源传递。
          return { count: value.items.length }
        }),
        encode: SchemaGetter.passthrough({ strict: false }),
      }),
    )
    const result = await run(
      raw,
      "const r=await tools.get({});return {count:r.count,keys:Object.keys(r),json:JSON.stringify(r),raw:String(r),text:r.text}",
      output,
    )
    // 新根上的业务值证明转换已生效，原文仍保留则证明来源没有错误绑定在旧对象上。
    expect(result).toMatchObject({
      ok: true,
      value: { count: 1, keys: ["count"], json: '{"count":1}', raw, text: raw },
    })
    // 计数只辅助验证有副作用的解码器；业务输出也已独立断言。
    expect(calls).toBe(1)
  })

  test("primitive output transformation remains primitive and runs once", async () => {
    // 输出解码器决定业务类型，来源元数据不能把原始值重新包装成对象。
    let calls = 0
    const output: Schema.Decoder<unknown> = Schema.Struct({ items: Schema.Array(Schema.Number) }).pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value) => {
          calls++
          return "count:" + value.items.length
        }),
        encode: SchemaGetter.passthrough({ strict: false }),
      }),
    )
    // String(r) 应使用转换后的标量内容，不能错误恢复转换前 JSON。
    const result = await run(
      '{"items":[1]}',
      "const r=await tools.get({});return {type:typeof r,value:r,raw:String(r)}",
      output,
    )
    // 转换产物是标量，typeof和值都应保持string；若沿用对象来源，raw会错误回到原JSON。
    expect(result).toMatchObject({ ok: true, value: { type: "string", value: "count:1", raw: "count:1" } })
    // 计数只辅助验证有副作用的解码器；业务输出也已独立断言。
    expect(calls).toBe(1)
  })

  test("array alias writes remain catchable without changing raw source", async () => {
    // 数组只允许数据索引赋值；来源别名不能绕过既有属性写入边界。
    expect(
      await run(
        "[1]",
        'const r=await tools.get({});try {r.text="changed"} catch(e) {return {message:e.message,raw:String(r),text:r.text}}',
      ),
    ).toMatchObject({
      ok: true,
      value: { message: "Only data fields may be assigned in CodeMode.", raw: "[1]", text: "[1]" },
    })
  })
})

describe("CodeMode retained environments", () => {
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
      await Effect.runPromise(
        runtime.execute("const n = 8; function helper() { return read() + 1; } return helper();"),
      ),
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

  // 预跑复制 URL 和容器，共享身份只在副本内保留；真实 Notebook 状态不受修改。
  test("URL preview preserves copied aliases while retained containers remain unchanged", async () => {
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
    // 同一段代码先预跑、再真实执行；分别验证副本关系和原环境的独立性。
    const code = `
    alias.value = 4; append(9); params.set("a", "2");
    return [object === alias, array[0].value, array[1], map.get("self") === map,
      map.get("object") === object, set.has(alias), regex.exec("aaba").index,
      date.toISOString(), url.href, params === url.searchParams];
  `
    expect(await Effect.runPromise(CodeMode.execute({ environment, snapshotEnvironment: true, code }))).toMatchObject({
      ok: true,
      value: [true, 4, 9, true, true, true, 1, "2020-01-02T03:04:05.000Z", "https://example.test/?a=2", true],
      toolCalls: [],
    })
    // 预跑已修改副本；三个原值仍保持初始状态，排除浅拷贝与直接执行原环境。
    expect(
      await Effect.runPromise(
        CodeMode.execute({ environment, code: "return [object.value, array.length, url.href];" }),
      ),
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

        const base = yield* Clock.Clock
        const ready = yield* Deferred.make<void>()
        const observed = {
          // 显式转发原 Clock 方法，只观察本例的真实计时器，不替换默认 sleep 能力。
          currentTimeMillis: base.currentTimeMillis,
          currentTimeNanos: base.currentTimeNanos,
          currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
          sleep: (duration: Parameters<typeof base.sleep>[0]) => {
            if (Duration.toMillis(duration) !== 100) return base.sleep(duration)
            return Effect.gen(function* () {
              // 仅计时器启动段禁自动让步；原 TestClock 入队后才允许父测试推进时间。
              const timer = yield* base.sleep(duration).pipe(
                Effect.forkChild({ startImmediately: true }),
                Effect.provideService(Scheduler.PreventSchedulerYield, true),
              )
              yield* Deferred.succeed(ready, undefined)
              // 结构化子任务仍随真实执行取消，解释器自身的调度策略不变。
              yield* Fiber.join(timer)
            })
          },
        }
        const running = yield* CodeMode.execute({
          environment,
          tools,
          code: "return await work();",
        }).pipe(Effect.provideService(Clock.Clock, observed), Effect.forkChild)
        // 动态导入可能先挂起；等待计时器实际登记，而不是假定 fork 后已经开始睡眠。
        yield* Deferred.await(ready)
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
})

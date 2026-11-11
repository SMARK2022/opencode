import { expect, test } from "bun:test"
import { Effect, Schema, SchemaGetter } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// 工具返回真实解码入参，断言可同时发现形式转换错误与 decoder 被绕过。
const execute = (input: Schema.Decoder<unknown>, args: string) =>
  Effect.runPromise(
    CodeMode.execute({
      tools: { call: Tool.make({ description: "Input forms", input, run: (value) => Effect.succeed(value) }) },
      code: `return await tools.call(${args})`,
    }),
  )

// 不依赖参数名字；正向使用唯一必填字段，反向只接受标量合同的一项包装。
test("schema-owned scalar forms work in both directions", async () => {
  expect(await execute(Schema.Struct({ unusual: Schema.String }), '"hello"')).toMatchObject({
    ok: true,
    value: { unusual: "hello" },
  })
  // 反向包装的属性名没有业务含义，任意安全名字都应到达同一标量合同。
  expect(await execute(Schema.String, '{arbitrary:"hello"}')).toMatchObject({ ok: true, value: "hello" })
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
    // 反向与正向分别断言，不能让其中一个方向的成功掩盖假值丢失。
    expect(await execute(schema, `{anything:${literal}}`)).toMatchObject({ ok: true, value })
  })
}

// 错误包装只能进入原始验证错误，不能尝试挑字段、过滤字段或嵌套解包。
// 多键、数组、嵌套对象和 undefined 都不能通过挑选候选字段获得替代成功。
for (const args of ["{}", '{a:"x",b:"y"}', '["x"]', '{a:{nested:"x"}}', "{a:undefined}", "{a:0}"]) {
  test(`scalar rejects ambiguous wrapper ${args}`, async () => {
    expect(await execute(Schema.String, args)).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" } })
  })
}

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
  // 两次请求只允许两次默认求值，捕获分类或规范化重复执行 decoder。
  expect(defaults).toBe(2)
  expect(await execute(Schema.NumberFromString, '{named:"42"}')).toMatchObject({ ok: true, value: 42 })
})

// 分类不能执行 refinement，也不能把验证失败改成第二次调用。
test("refinement remains original validation authority", async () => {
  let checks = 0
  const input = Schema.String.check(
    Schema.makeFilter((value) => {
      checks++
      return value.length > 2
    }),
  )
  // 描述符提取发生在执行之前，此时 refinement 必须仍未运行。
  const forms = Tool.inputForms(input)
  expect(forms?.kind).toBe("scalar")
  expect(checks).toBe(0)
  // 结构转换成功不意味着业务校验成功；短字符串必须保留原始拒绝。
  expect(await execute(input, '{a:"x"}')).toMatchObject({ ok: false })
  expect(checks).toBe(1)
  // 合法值证明 refinement 没有被全面禁用，也没有缓存前次失败。
  expect(await execute(input, '{a:"valid"}')).toMatchObject({ ok: true, value: "valid" })
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
    Schema.Struct({ a: Schema.String, b: Schema.String }),
    Schema.Struct({ a: Schema.optionalKey(Schema.String), b: Schema.optionalKey(Schema.String) }),
    // 不执行延迟定义来获取元数据，避免引入额外求值或递归分析路径。
    Schema.suspend(() => Schema.String),
  ]) {
    expect(Tool.inputForms(input)).toBeUndefined()
  }
  expect(
    await execute(Schema.Union([Schema.String, Schema.Struct({ key: Schema.String })]), '{key:"x"}'),
  ).toMatchObject({ ok: true, value: { key: "x" } })
  // 不支持便利形式不等于拒绝原形式，数组仍完整交给原 decoder。
  expect(await execute(Schema.Array(Schema.String), '["x"]')).toMatchObject({ ok: true, value: ["x"] })
})

// 单可选项和标量 union 仍能无歧义分类，literal 的限制留给 decoder。
test("optional, nullable, literal and scalar union domains", async () => {
  expect(await execute(Schema.Struct({ key: Schema.optionalKey(Schema.String) }), '"x"')).toMatchObject({
    ok: true,
    value: { key: "x" },
  })
  expect(await execute(Schema.Struct({ key: Schema.NullOr(Schema.String) }), "null")).toMatchObject({
    ok: true,
    value: { key: null },
  })
  expect(await execute(Schema.Union([Schema.String, Schema.Number]), "{a:0}")).toMatchObject({ ok: true, value: 0 })
  // 字面量限制必须由原 decoder 检查，不能因标量分类就放宽取值。
  expect(await execute(Schema.Literal("yes"), '{a:"no"}')).toMatchObject({ ok: false })
  expect(await execute(Schema.Literal("yes"), '{a:"yes"}')).toMatchObject({ ok: true, value: "yes" })
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

// 原始危险键必须先失败，适配新建的危险键也必须重新通过同一边界。
test("blocked keys cannot disappear through reverse conversion or appear through forward conversion", async () => {
  // 宿主传入的普通对象可含危险自有键，不能依赖解释器对象字面量提前拒绝。
  const { ToolRuntime } = await import("../src/tool-runtime.js")
  const scalar = ToolRuntime.make(
    { call: Tool.make({ description: "scalar", input: Schema.String, run: (value) => Effect.succeed(value) }) },
    undefined,
    [],
  )
  await expect(Effect.runPromise(scalar.invoke(["call"], [{ constructor: "x" }]))).rejects.toThrow(
    "blocked property 'constructor'",
  )
  // 正向新建字段也受同一边界约束，真实 schema 不能授予危险属性访问权。
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
  await expect(Effect.runPromise(object.invoke(["call"], ["x"]))).rejects.toThrow("blocked property 'constructor'")
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
  // 解码结果是对象也不允许保留包装；原 decoder 必须收到字符串而非对象。
  expect(await execute(scalar, '{arbitrary:"7"}')).toMatchObject({ ok: true, value: { count: 7 } })
  expect(scalarDecodes).toBe(1)
})

// adapter 声明标量描述符时，类库只拆包装；真正解码仍由宿主拥有。
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
  // 编目录不能调用宿主 decoder；直接值和包装值随后各经过一次解码。
  expect(decodes).toBe(0)
  for (const args of ['"42"', '{arbitrary:"42"}']) {
    expect(await Effect.runPromise(runtime.execute(`return await tools.call(${args})`))).toMatchObject({
      ok: true,
      value: 42,
    })
  }
  // 收到的字符串与返回的数字共同证明没有把已解码值再次送回宿主。
  expect(seen).toEqual(["42", "42"])
  expect(decodes).toBe(2)
})

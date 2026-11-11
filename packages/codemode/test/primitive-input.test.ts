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

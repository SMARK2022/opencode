import { expect, test } from "bun:test"
import { Effect, Schema, SchemaGetter } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// 通过公共入口验证宿主显式投影，不让测试依赖弱映射内部实现。
const run = (
  text: string,
  code = "const r = await tools.get({}); return { type: typeof r, value: r, raw: String(r) }",
) =>
  Effect.runPromise(
    CodeMode.execute({
      tools: {
        get: Tool.make({
          description: "JSON text",
          input: Schema.Struct({}),
          run: () => Effect.succeed(CodeMode.fromJsonText(text)),
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
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          get: Tool.make({
            description: "ordinary text",
            input: Schema.Struct({}),
            output,
            run: () => Effect.succeed(raw),
          }),
        },
        code: "const r = await tools.get({}); return { type: typeof r, value: r }",
      }),
    )
    expect(result).toMatchObject({ ok: true, value: { type: "string", value: raw } })
  }
})

test("native operations and internal container copies preserve source", async () => {
  // Map/Set 与数组方法会经过内部数据复制；这些副本仍需支持原始文本访问。
  const raw = ' {"items":[1,2]} '
  expect(
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
  expect(await Effect.runPromise(runtime.execute('try {r.text="changed"} catch(e) {return e.message}'))).toMatchObject({
    ok: true,
    value: "Attempted to assign to readonly property.",
  })
  expect(
    await Effect.runPromise(
      // 变更后的 JSON 与原始 String 同时断言，区分业务快照和来源快照。
      runtime.execute("r.items.push(2);return {raw:String(r),text:r.text,json:JSON.stringify(r),keys:Object.keys(r)}"),
    ),
  ).toMatchObject({ ok: true, value: { raw, text: raw, json: '{"items":[1,2]}', keys: ["items"] } })
})

test("business text collisions retain their original type and writable field", async () => {
  // 同名字段可能不是字符串，便利别名不能覆盖合法业务数据。
  for (const text of ["business", 0, false, null]) {
    const raw = JSON.stringify({ text })
    expect(
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
  const result = await Effect.runPromise(
    CodeMode.execute({
      tools: {
        get: Tool.make({
          description: "optional output",
          input: Schema.Struct({}),
          output,
          run: () => Effect.succeed(CodeMode.fromJsonText(raw)),
        }),
      },
      code: "const r=await tools.get({});return {keys:Object.keys(r),json:JSON.stringify(r),raw:String(r),text:r.text}",
    }),
  )
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
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: {
          get: Tool.make({
            description: "invalid output",
            input: Schema.Struct({}),
            output,
            run: () => Effect.succeed(CodeMode.fromJsonText('{"items":[1]}')),
          }),
        },
        code: "try {await tools.get({})} catch(e) {return e.message}",
      }),
    )
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
  const result = await Effect.runPromise(
    CodeMode.execute({
      tools: {
        get: Tool.make({
          description: "transformed output",
          input: Schema.Struct({}),
          output,
          run: () => Effect.succeed(CodeMode.fromJsonText(raw)),
        }),
      },
      code: "const r=await tools.get({});return {count:r.count,keys:Object.keys(r),json:JSON.stringify(r),raw:String(r),text:r.text}",
    }),
  )
  expect(result).toMatchObject({ ok: true, value: { count: 1, keys: ["count"], json: '{"count":1}', raw, text: raw } })
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
  const result = await Effect.runPromise(
    CodeMode.execute({
      tools: {
        get: Tool.make({
          description: "primitive output",
          input: Schema.Struct({}),
          output,
          run: () => Effect.succeed(CodeMode.fromJsonText('{"items":[1]}')),
        }),
      },
      code: "const r=await tools.get({});return {type:typeof r,value:r,raw:String(r)}",
    }),
  )
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

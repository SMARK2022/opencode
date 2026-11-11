import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"
import { inputTypeScript, jsonSchemaToTypeScript, outputTypeScript } from "../src/tool-schema.js"

// 发现 fixture 统一经过公开执行入口，不直接调用内部索引或重写分页算法。
const search = async (runtime: CodeMode.Runtime, request: { limit?: number; offset?: number } = {}) => {
  const result = await Effect.runPromise(runtime.execute(`return search(${JSON.stringify(request)})`))
  // 公开入口失败必须使fixture失败，不能把诊断对象误当成空页继续验证分页。
  if (!result.ok) throw new Error(result.error.message)
  return result.value as {
    items: Array<{
      path: string
      description: string
      signature: string
      inputSchema: unknown
      outputSchema?: unknown
      schemaUnavailable?: string[]
    }>
    remaining: number
    next: { offset: number } | null
  }
}

// A raw JSON Schema tool in the shape an MCP adapter produces: render-only input schema
// 字段说明用于搜索；签名只保留真实类型与可选性。
const listIssues = Tool.make({
  description: "List issues in a repository",
  input: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      after: { type: "string", description: "Cursor from the previous response's pageInfo" },
      perPage: { type: "number", description: "Results per page", default: 30 },
      labels: { type: "array", items: { type: "string" }, description: "Filter by labels", minItems: 1, maxItems: 10 },
      state: { type: "string", enum: ["open", "closed"] },
    },
    required: ["owner"],
  },
  run: () => Effect.succeed("[]"),
})

// Effect 字段描述仍可检索，输出类型仍由声明决定。
const lookupOrder = Tool.make({
  description: "Look up an order",
  input: Schema.Struct({
    id: Schema.String.annotate({ description: "Order identifier" }),
    verbose: Schema.optionalKey(Schema.Boolean),
  }),
  output: Schema.Struct({
    status: Schema.String.annotate({ description: "Current order status" }),
  }),
  run: () => Effect.succeed({ status: "open" }),
})

describe("compact signature rendering", () => {
  test("nested compact objects preserve their field types", () => {
    // 删除缩进展示不删除嵌套结构；说明文字不影响真实字段类型。
    expect(
      jsonSchemaToTypeScript({
        type: "object",
        properties: {
          filter: {
            type: "object",
            description: "Search filter",
            properties: { state: { type: "string", description: "Issue state" } },
          },
        },
      }),
    ).toBe("{ filter?: { state?: string } }")
  })

  test("compact input and output retain schema types", () => {
    // JSON Schema里的default、数组长度与字段说明仍属于详细合同，紧凑签名只保留类型和必填性。
    expect(inputTypeScript(listIssues)).toBe(
      '{ owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }',
    )
    // 可用简写不改变模型看到的标准对象签名，避免同一合同在不同出口膨胀成union。
    expect(inputTypeScript(lookupOrder)).toBe("{ id: string; verbose?: boolean }")
    expect(outputTypeScript(lookupOrder)).toBe("{ status: string }")
  })

  test("stays total on cyclic $refs and pathological nesting in compact mode", () => {
    const cyclic = {
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, name: { type: "string" } } } },
    } as const
    // 自引用分支退到unknown，旁边的name仍应精确；整个对象一起丢失也不能算正确处理循环。
    expect(jsonSchemaToTypeScript(cyclic)).toBe("{ child?: unknown; name?: string }")

    let deep: Record<string, unknown> = { type: "string" }
    for (let level = 0; level < 12; level += 1) deep = { type: "object", properties: { next: deep } }
    // 12层超过渲染深度边界，外层next仍应存在，unknown只标记无法继续展开的部分。
    const rendered = jsonSchemaToTypeScript(deep)
    expect(rendered).toContain("unknown")
    expect(rendered).toContain("next?:")
  })

  test("intersects ref and union siblings instead of discarding them", () => {
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User",
        properties: { active: { type: "boolean" } },
        required: ["active"],
        $defs: {
          User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }),
    ).toBe("{ id: string } & { active: boolean }")
    expect(
      jsonSchemaToTypeScript({
        type: "object",
        properties: { common: { type: "boolean" } },
        required: ["common"],
        anyOf: [
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        ],
      }),
    ).toBe("({ name: string } | { count: number }) & { common: boolean }")
    expect(jsonSchemaToTypeScript({ $ref: "https://example.com/schema.json" })).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User/properties/id",
        $defs: { User: { type: "object" }, id: { type: "string" } },
      }),
    ).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        type: ["object", "null"],
        properties: { name: { type: "string" } },
      }),
    ).toBe("{ name?: string } | null")
  })
})

describe("non-identifier property names render as quoted keys", () => {
  // 横线、@、点号和纯数字键都不能直接写成TS标识符，签名须加引号；普通plain键保持裸写。
  const rawSchema = {
    type: "object",
    properties: {
      "foo-bar": { type: "string" },
      "@type": { type: "string" },
      "x.y": { type: "number", description: "Dotted name" },
      "123": { type: "number" },
      plain: { type: "boolean" },
    },
    required: ["@type"],
  } as const

  test("compact rendering quotes non-identifier keys and leaves identifiers bare", () => {
    // 数字属性按JS键枚举规则排在前面；其余键保留定义顺序，问号由required而非引号决定。
    expect(jsonSchemaToTypeScript(rawSchema)).toBe(
      '{ "123"?: number; "foo-bar"?: string; "@type": string; "x.y"?: number; plain?: boolean }',
    )
  })

  // 单一紧凑渲染也必须保留输入与输出特殊键的引号，移除 pretty 不等于移除合同覆盖。
  test("JSON Schema input and output signatures of a tool both quote", () => {
    const tool = Tool.make({
      description: "Adapter tool with awkward field names",
      input: rawSchema,
      output: {
        type: "object",
        properties: { "content-type": { type: "string" } },
        required: ["content-type"],
      } as const,
      run: () => Effect.succeed({ "content-type": "text/plain" }),
    })
    expect(inputTypeScript(tool)).toContain('"foo-bar"?: string')
    // 返回字段同样必须是可表达的属性，而非把横线当成运算符。
    expect(outputTypeScript(tool)).toBe('{ "content-type": string }')
  })

  test("Effect Schema structs with non-identifier field names quote too", () => {
    const tool = Tool.make({
      description: "Schema tool with awkward field names",
      input: Schema.Struct({ "foo-bar": Schema.String, plain: Schema.optionalKey(Schema.Number) }),
      run: () => Effect.succeed(null),
    })
    // Effect字段同样保留原键名，引号规则不能只覆盖JSON Schema适配器。
    expect(inputTypeScript(tool)).toBe('{ "foo-bar": string; plain?: number }')
  })
})

describe("union schemas render every alternative", () => {
  test("anyOf with a number branch keeps sibling alternatives", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    } as const
    // 只留下紧凑出口，仍保留每个真实 union 成员。
    expect(jsonSchemaToTypeScript(schema)).toBe("string | number")
  })

  test("nullable numeric unions keep null", () => {
    const schema = {
      oneOf: [{ type: "number" }, { type: "null" }],
    } as const
    // nullable 与数字的两种实际结果不能因删除 pretty 断言而合并成 number。
    expect(jsonSchemaToTypeScript(schema)).toBe("number | null")
  })

  test("tool input and output signatures preserve numeric unions", () => {
    const tool = Tool.make({
      description: "Tool with numeric unions",
      input: {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      } as const,
      output: { anyOf: [{ type: "number" }, { type: "boolean" }] } as const,
      run: () => Effect.succeed(1),
    })
    expect(inputTypeScript(tool)).toBe("{ value?: string | number }")
    expect(outputTypeScript(tool)).toBe("number | boolean")
  })

  test("allOf renders intersections with parenthesized union members", () => {
    const schema = {
      allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: ["string", "null"] }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("{ id?: string } & (string | null)")
  })

  test("allOf does not discard an unresolved constraint", () => {
    expect(jsonSchemaToTypeScript({ allOf: [{ type: "string" }, { $ref: "https://example.com/external.json" }] })).toBe(
      "unknown",
    )
    expect(
      jsonSchemaToTypeScript({
        allOf: [{ type: "string" }, { allOf: [{ $ref: "https://example.com/external.json" }] }],
      }),
    ).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        type: "string",
        allOf: [{ $ref: "#/$defs/Constraint" }],
        $defs: { Constraint: { description: "TypeScript-neutral constraint" } },
      }),
    ).toBe("string")
  })
})

// 目录、搜索与恢复共用紧凑签名；字段说明随搜索schema交付，不嵌回签名。
describe("compact signatures in catalogs and search", () => {
  const runtime = CodeMode.make({ tools: { github: { list_issues: listIssues }, orders: { lookup: lookupOrder } } })
  const expected = [
    'tools.github.list_issues(input: { owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }): Promise<unknown>',
    "tools.orders.lookup(input: { id: string; verbose?: boolean }): Promise<{ status: string }>",
  ]
  test("JSON rendering and Effect encoded forms share exact public signatures", async () => {
    expect(runtime.catalog().map((tool) => tool.signature)).toEqual(expected)
    // 查字段文档仍能命中工具，但返回值不再放大成第二套多行接口。
    for (const [query, signature] of [
      ["Repository owner", expected[0]],
      ["Order identifier", expected[1]],
      ["tools.orders.lookup", expected[1]],
    ]) {
      expect(
        await Effect.runPromise(runtime.execute(`return search({query:${JSON.stringify(query)}}).items[0].signature`)),
      ).toMatchObject({ ok: true, value: signature })
    }
    for (const signature of expected) expect(runtime.instructions()).toContain(signature)
    expect(runtime.instructions()).not.toContain("/**")
    // 一个 fixture 锁定详细搜索字段；catalog 继续只发布紧凑接口。
    for (const entry of runtime.catalog()) expect(Object.keys(entry)).toEqual(["path", "description", "signature"])
    expect(runtime.instructions()).not.toContain("Repository owner")
    // 与路径排序测试使用的摘要不同，这里精确匹配完整详情，字段遗漏或额外塞入文档都会被发现。
    expect(await search(runtime)).toStrictEqual({
      items: [
        {
          path: "tools.github.list_issues",
          description: listIssues.description,
          signature: expected[0],
          // 原始JSON Schema直接随搜索交付，default和min/maxItems等未进签名的约束也因此保留。
          inputSchema: listIssues.input,
        },
        {
          path: "tools.orders.lookup",
          description: lookupOrder.description,
          signature: expected[1],
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "Order identifier" }, verbose: { type: "boolean" } },
            required: ["id"],
            // Effect.Struct只声明id和verbose，发射结果需保留禁止额外字段，不能只拼出properties。
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { status: { type: "string", description: "Current order status" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      ],
      remaining: 0,
      next: null,
    })
  })
})

// 编码输入与解码输出可不同；引用和假值 default 必须从真实合同保留。
test("search emits the actual encoded input, decoded output and shared definitions", async () => {
  const person = Schema.Struct({ name: Schema.String.annotate({ description: "Full name" }) }).annotate({
    identifier: "Person",
  })
  const input = Schema.Struct({
    amount: Schema.NumberFromString,
    enabled: Schema.Boolean.annotate({ default: false }),
    count: Schema.Number.annotate({ default: 0 }),
    // 同一命名合同出现两次，要求详情携带可解析的共享$defs，单次内联无法替代这项检查。
    person,
    other: person,
  })
  const runtime = CodeMode.make({
    tools: {
      call: Tool.make({
        description: "Actual contract",
        input: { type: "string" },
        // 展示输入故意写成string而真实合同是对象；详情必须由inputContract发射，不能沿展示schema取巧。
        inputContract: input,
        output: Schema.Struct({ amount: Schema.NumberFromString, person }),
        run: () => Effect.succeed({ amount: "1", person: { name: "Ada" } }),
      }),
    },
  })
  expect((await search(runtime)).items[0]).toMatchObject({
    inputSchema: {
      type: "object",
      properties: {
        // NumberFromString的调用输入是字符串，输出的decoded侧才是数字；两处amount不同是有意的方向检查。
        amount: { type: "string" },
        // false与0能发现用真值判断过滤default的实现，两者都属于应保留的schema注解。
        enabled: { default: false },
        count: { default: 0 },
        person: { $ref: "#/$defs/Person" },
        other: { $ref: "#/$defs/Person" },
      },
      $defs: { Person: { properties: { name: { description: "Full name" } } } },
    },
    outputSchema: {
      properties: {
        amount: {
          // 这是Effect对decoded Number的原始发射形式，搜索不能自行删去非有限数哨兵。
          anyOf: [
            { type: "number" },
            { type: "string", enum: ["NaN"] },
            { type: "string", enum: ["Infinity"] },
            { type: "string", enum: ["-Infinity"] },
          ],
        },
        person: { $ref: "#/$defs/Person" },
      },
      $defs: { Person: { properties: { name: { description: "Full name" } } } },
    },
  })
})

// 完整条目越过预算才换页；字符转义和输出 schema 也计入同一页。
test("search pages complete schema entries by count and serialized character budget", async () => {
  const input = { type: "object", properties: { query: { type: "string", format: "uri", description: "Exact query" } } }
  const output = { type: "string", description: "x".repeat(20_000) }
  for (const sample of [
    // 6000字符条目使第三项首次跨过16K；限制改为2时应由数量先截页。
    { descriptions: Array(7).fill("x".repeat(6000)), limit: 10, output: undefined, sizes: [3, 3, 1] },
    { descriptions: Array(7).fill("x".repeat(6000)), limit: 2, output: undefined, sizes: [2, 2, 2, 1] },
    // 超长项放中间，连同Unicode和JSON转义检验完整序列化计量，并验证下一页能越过它。
    { descriptions: ["Small", '中😀"\\\n'.repeat(3000), "Small"], limit: 10, output: undefined, sizes: [2, 1] },
    // 说明很短而输出合同很长，能发现只给description或inputSchema计费的实现。
    { descriptions: Array(3).fill("Output page"), limit: 10, output, sizes: [1, 1, 1] },
  ]) {
    const runtime = CodeMode.make({
      tools: Object.fromEntries(
        sample.descriptions.map((description, index) => [
          `tool${index}`,
          Tool.make({ description, input, output: sample.output, run: () => Effect.succeed(null) }),
        ]),
      ),
    })
    // 下一次offset由已经收到的条目数计算，测试不依赖被测next推进，避免游标和遗漏条目互相掩盖。
    const paths: string[] = []
    const sizes: number[] = []
    while (paths.length < sample.descriptions.length) {
      const page = await search(runtime, { offset: paths.length, limit: sample.limit })
      // 未读完时必须有进展；遇到超长第一项也不能返回空页，否则调用者会在同一offset无限重试。
      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.length).toBeLessThanOrEqual(sample.limit)
      for (const item of page.items) {
        // 逐条比对完整description与两侧schema，分页预算只决定在哪截页，不得截短条目内容。
        expect(item.description).toBe(sample.descriptions[paths.length])
        expect(item.inputSchema).toEqual(input)
        expect(item.outputSchema).toEqual(sample.output)
        paths.push(item.path)
      }
      sizes.push(page.items.length)
      // remaining和next依据总量与累计已收条目独立计算，最后一页必须同时归零并结束游标。
      expect(page.remaining).toBe(sample.descriptions.length - paths.length)
      expect(page.next).toEqual(page.remaining ? { offset: paths.length } : null)
      // 未碰数量上限却换页时，应已容纳越过16K的完整条目；低于阈值就停会让预算规则失效。
      if (page.remaining && page.items.length < sample.limit)
        expect(JSON.stringify(page).length).toBeGreaterThanOrEqual(16_384)
    }
    // 前三个样本分别锁定字符上限、数量上限和超长项的跨页进度，最后一个把输出schema纳入计量。
    expect(sizes).toEqual(sample.sizes)
    // 全程路径清单独立于分页器的next值，遗漏或重复条目不能靠自洽的offset掩盖。
    expect(paths).toEqual(sample.descriptions.map((_, index) => `tools.tool${index}`))
    expect(await search(runtime, { offset: paths.length })).toEqual({ items: [], remaining: 0, next: null })
  }
})

describe("non-identifier tool paths", () => {
  const resolveLibrary = Tool.make({
    description: "Resolve a Context7 library ID",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        libraryName: { type: "string" },
      },
      required: ["query", "libraryName"],
    } as const,
    run: () => Effect.succeed("/reactjs/react.dev"),
  })
  const runtime = CodeMode.make({ tools: { context7: { "resolve-library-id": resolveLibrary } } })

  test("inline catalog uses bracket notation for dashed tool names", () => {
    const instructions = runtime.instructions()

    // 特殊路径仍使用可执行的括号访问，签名参数名不改变真实调用表达式。
    expect(instructions).toContain(
      'tools.context7["resolve-library-id"](input: { query: string; libraryName: string }): Promise<unknown>',
    )
    // 精简措辞不能把带短横线的合法路径变成属性访问或自动猜测的别名。
    expect(CodeMode.description).toContain("Use the exact namespaced paths and argument shapes")
    expect(CodeMode.description).toContain("special names use bracket notation")
    expect(instructions).not.toContain("tools.context7.resolve-library-id")
    expect(instructions).not.toContain("tools.context7.resolve_library_id")
  })

  test("search results return callable bracket-notation paths and signatures", async () => {
    const result = await Effect.runPromise(
      runtime.execute(`return await tools.$codemode.search({ query: "resolve library" })`),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("search failed")

    const value = result.value as { items: Array<{ path: string; signature: string }> }
    expect(value.items[0]?.path).toBe('tools.context7["resolve-library-id"]')
    // 动态搜索与内联目录必须给相同括号路径。
    expect(value.items[0]?.signature).toContain('tools.context7["resolve-library-id"](input: {')
  })
})

// 适配器展示 schema 不得覆盖实际标量合同；签名和执行都保留原始类型。
test("scalar adapter signature uses its authoritative encoded scalar", async () => {
  const runtime = CodeMode.make({
    tools: {
      call: Tool.make({
        description: "Scalar adapter",
        input: {
          type: "object",
          properties: { misleading: { type: "boolean" } },
        },
        inputContract: Schema.String,
        run: (value) => Effect.succeed(Schema.decodeUnknownSync(Schema.String)(value)),
      }),
    },
  })
  // 显示对象与实际字符串合同相冲突，签名使用string且调用拒绝包装对象，两个出口共同约束合同来源。
  expect(runtime.catalog()[0].signature).toBe("tools.call(input: string): Promise<unknown>")
  expect(await Effect.runPromise(runtime.execute('return await tools.call("yes")'))).toMatchObject({
    ok: true,
    value: "yes",
  })
  expect(await Effect.runPromise(runtime.execute('return await tools.call({arbitrary:"yes"})'))).toMatchObject({
    ok: false,
  })
})

// 签名、发现和实际校验必须读取同一对象合同，不能被适配器展示字段替代。
for (const [actual, expected, input, value] of [
  [
    Schema.Struct({
      realKey: Schema.String.annotate({ description: "contractneedle" }),
      verbose: Schema.optionalKey(Schema.Boolean),
    }),
    "{ realKey: string; verbose?: boolean }",
    '"yes"',
    { realKey: "yes" },
  ],
  [
    Schema.Struct({ realKey: Schema.String.annotate({ description: "contractneedle" }), count: Schema.Number }),
    "{ realKey: string; count: number }",
    '{realKey:"yes",count:2}',
    { realKey: "yes", count: 2 },
  ],
] as const) {
  test(`adapter contract remains authoritative for ${expected}`, async () => {
    let decodes = 0
    const runtime = CodeMode.make({
      tools: {
        adapter: {
          call: Tool.make({
            description: "Adapter",
            input: { type: "object", properties: { misleading: { type: "boolean" } } },
            inputContract: actual,
            run: (input) =>
              Effect.sync(() => {
                decodes++
                return Schema.decodeUnknownSync(actual)(input)
              }),
          }),
        },
      },
    })
    const signature = `tools.adapter.call(input: ${expected}): Promise<unknown>`
    expect(runtime.catalog()[0].signature).toBe(signature)
    expect(runtime.instructions()).toContain(signature)
    // 字段索引同样取真实来源，不能签名已修而 search 仍只索引虚假展示字段。
    expect(
      await Effect.runPromise(runtime.execute('return search({query:"contractneedle"}).items[0].signature')),
    ).toMatchObject({ ok: true, value: signature })
    expect(await Effect.runPromise(runtime.execute("return tools.adapter()"))).toMatchObject({
      ok: false,
      error: { suggestions: [signature] },
    })
    // 目录、搜索和错误建议都已生成，计数仍为0才能说明这些发现出口没有执行宿主decoder。
    expect(decodes).toBe(0)
    // 多必填字段没有快捷形式也必须保留完整合同，真实解码只发生在调用本身。
    expect(await Effect.runPromise(runtime.execute(`return await tools.adapter.call(${input})`))).toMatchObject({
      ok: true,
      value,
    })
    expect(decodes).toBe(1)
    expect(
      await Effect.runPromise(runtime.execute("return await tools.adapter.call({misleading:true})")),
    ).toMatchObject({ ok: false })
    // 第二次传的是展示schema里的虚假字段；宿主decoder仍需被调用并拒绝，不能因目录展示成功而放行。
    expect(decodes).toBe(2)
  })
}

// 一个合法合同不可发射时，只标记该侧，邻项与已发射一侧仍可发现。
test("one unavailable schema side preserves neighboring tools and the other side", async () => {
  // Symbol字段是合法Effect合同但不能发射为JSON Schema，避免用损坏输入冒充表示能力限制。
  const unavailable = Schema.Struct({ [Symbol("key")]: Schema.String })
  const input = { type: "string", description: "Usable input" }
  const output = { type: "number", description: "Usable output" }
  const runtime = CodeMode.make({
    tools: Object.fromEntries(
      // 四项覆盖两侧均可用、只缺输入、只缺输出、两侧均缺，独立锁定schema不可用标记的方向。
      [
        [input, output],
        [unavailable, output],
        [input, unavailable],
        [unavailable, unavailable],
      ].map((contract, index) => [
        `tool${index}`,
        Tool.make({
          description: "Schema availability",
          input: contract[0],
          output: contract[1],
          // 发现只读合同，夹具把run设成必败，误执行工具的路径无法靠合法业务结果通过。
          run: () => Effect.die("Search must not execute a tool"),
        }),
      ]),
    ),
  })
  const full = await search(runtime)
  expect(full.items.map((item) => item.path)).toEqual(["tools.tool0", "tools.tool1", "tools.tool2", "tools.tool3"])
  expect(full.items.map((item) => item.schemaUnavailable)).toEqual([
    undefined,
    ["input"],
    ["output"],
    ["input", "output"],
  ])
  // 不可发射的一侧显式为null，可用一侧保留原schema；这与根本没有声明output的省略语义不同。
  expect(full.items.map((item) => [item.inputSchema, item.outputSchema])).toEqual([
    [input, output],
    [null, output],
    [input, null],
    [null, null],
  ])
  expect(full).toMatchObject({ remaining: 0, next: null })
  const first = await search(runtime, { limit: 2 })
  expect(first).toMatchObject({ remaining: 2, next: { offset: 2 } })
  const second = await search(runtime, { limit: 2, offset: 2 })
  expect(second).toMatchObject({ remaining: 0, next: null })
  // 把两页重新拼接到完整结果，检查不可发射合同也占正常条目位置且没有被过滤掉。
  expect([...first.items, ...second.items]).toEqual(full.items)
})

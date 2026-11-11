import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"
import { inputTypeScript, jsonSchemaToTypeScript, outputTypeScript } from "../src/tool-schema.js"

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
    expect(inputTypeScript(listIssues)).toBe(
      '{ owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }',
    )
    // 同一实际对象合同现在显式接受唯一标量字段。
    expect(inputTypeScript(lookupOrder)).toBe("{ id: string; verbose?: boolean } | string")
    expect(outputTypeScript(lookupOrder)).toBe("{ status: string }")
  })

  test("stays total on cyclic $refs and pathological nesting in compact mode", () => {
    const cyclic = {
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, name: { type: "string" } } } },
    } as const
    expect(jsonSchemaToTypeScript(cyclic)).toBe("{ child?: unknown; name?: string }")

    let deep: Record<string, unknown> = { type: "string" }
    for (let level = 0; level < 12; level += 1) deep = { type: "object", properties: { next: deep } }
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
  // MCP-style schemas routinely carry property names that are not bare TS identifiers
  // (`foo-bar`, `@type`, dotted names); the rendered signature must quote them so the
  // model sees a valid TypeScript object type. Bare identifiers stay unquoted.
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
    // 带横线的真实键仍有标量形式，不能在命名参数展示时丢失引号。
    expect(inputTypeScript(tool)).toBe('{ "foo-bar": string; plain?: number } | string')
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

// 目录、搜索与恢复共用紧凑签名，字段说明不会变成第二种展示。
describe("compact signatures in catalogs and search", () => {
  const runtime = CodeMode.make({ tools: { github: { list_issues: listIssues }, orders: { lookup: lookupOrder } } })
  const expected = [
    'tools.github.list_issues(input: { owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }): Promise<unknown>',
    "tools.orders.lookup(input: { id: string; verbose?: boolean } | string): Promise<{ status: string }>",
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
  })
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

// 同一条命名参数签名必须贯穿静态目录、动态搜索和误调用 namespace 的恢复提示。
test("one compact named signature across discovery surfaces", async () => {
  const runtime = CodeMode.make({ tools: { group: { lookup: lookupOrder } } })
  const signature = "tools.group.lookup(input: { id: string; verbose?: boolean } | string): Promise<{ status: string }>"
  expect(runtime.catalog()[0]?.signature).toBe(signature)
  expect(runtime.instructions()).toContain(signature)
  expect(
    await Effect.runPromise(runtime.execute('return search({query:"group.lookup"}).items[0].signature')),
  ).toMatchObject({ ok: true, value: signature })
  expect(await Effect.runPromise(runtime.execute("return tools.group()"))).toMatchObject({
    ok: false,
    error: { suggestions: [signature] },
  })
})

// 适配器展示 schema 不得覆盖实际标量合同，直接形式和拆包形式必须同源。
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
  expect(runtime.catalog()[0].signature).toBe(
    "tools.call(input: string | Record<string, string> /* exactly one own enumerable field; undefined values are not unwrapped */): Promise<unknown>",
  )
  for (const input of ['"yes"', '{arbitrary:"yes"}'])
    expect(await Effect.runPromise(runtime.execute(`return await tools.call(${input})`))).toMatchObject({
      ok: true,
      value: "yes",
    })
})

// 真实对象合同不能在生成快捷描述符时丢失，不能只修正标量这一处分支。
for (const [actual, expected, input, value] of [
  [
    Schema.Struct({
      realKey: Schema.String.annotate({ description: "contractneedle" }),
      verbose: Schema.optionalKey(Schema.Boolean),
    }),
    "{ realKey: string; verbose?: boolean } | string",
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
    expect(decodes).toBe(2)
  })
}

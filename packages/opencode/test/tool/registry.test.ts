// 注册表描述与库的公开说明比较，捕获两个提示词出口漂移。
import { CodeMode } from "@opencode-ai/codemode"
import { afterEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MCP } from "@/mcp"
// 插件钩子的载荷是 unknown；先收窄对象再修改实际工具定义。
import { isRecord } from "@/util/record"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, replacements))

it.instance("repository GitHub tools return their fixed business contracts", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const directory = path.join(instance.directory, ".opencode", "tool")
  yield* Effect.promise(() => fs.mkdir(directory, {recursive:true}))
  // 与生产一样动态加载实际模块，避免把项目局部旧插件类型带入应用编译上下文。
  for (const name of ["github-pr-search", "github-triage"]) yield* Effect.promise(() => fs.writeFile(path.join(directory, `${name}.ts`),
    `export { default } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, `../../../../.opencode/tool/${name}.ts`)).href)};`))
  const registry = yield* ToolRegistry.Service
  const entries = yield* registry.all()
  const search = entries.find((tool) => tool.id === "github-pr-search")
  const triage = entries.find((tool) => tool.id === "github-triage")
  if (!search || !triage) throw new Error("Missing repository tools")
  // GitHub地址固定且分派会写共享状态；只替换网络边界，原注册器验证真实返回值。
  const request = yield* Effect.acquireRelease(Effect.sync(() => spyOn(globalThis, "fetch")), (mock) => Effect.sync(() => mock.mockRestore()))
  const ctx = { sessionID:SessionID.create(),messageID:MessageID.ascending(),agent:"build",abort:new AbortController().signal,
    messages:[],metadata:()=>Effect.void,ask:()=>Effect.void }
  const item = {title:"Change",html_url:"https://github.com/anomalyco/opencode/pull/9"}
  for (const sample of [
    {response:{total_count:8,incomplete_results:true,items:[item]},expected:{totalCount:8,items:[{title:"Change",path:"https://github.com/anomalyco/opencode/pull/9"}],partial:true}},
    {response:{total_count:0,incomplete_results:false,items:[]},expected:{totalCount:0,items:[],partial:false}},
    {response:{total_count:8,incomplete_results:true,items:[]},expected:{totalCount:8,items:[],partial:true}},
  ]) {
    request.mockResolvedValue(Response.json(sample.response))
    expect((yield* search.execute({query:"fix",limit:10,offset:0},ctx)).program?.value).toEqual(sample.expected)
  }
  const sent: {url:string;body?:string}[] = []
  request.mockImplementation(Object.assign(async (...[url, init]: Parameters<typeof fetch>) => {
    sent.push({url:String(url),...(typeof init?.body === "string" ? {body:init.body} : {})})
    return Response.json({})
  }, { preconnect: () => {} }))
  yield* Effect.acquireRelease(Effect.sync(() => {const previous=process.env.ISSUE_NUMBER;process.env.ISSUE_NUMBER="42";return previous}),
    (previous) => Effect.sync(() => {if(previous===undefined) delete process.env.ISSUE_NUMBER; if(previous!==undefined) process.env.ISSUE_NUMBER=previous}))
  const result = yield* triage.execute({team:"windows"},ctx)
  // 与实际POST载荷核对同一随机选择，不能仅断言某个合法团队成员。
  expect(result.program?.value).toEqual({issueNumber:42,assignee:JSON.parse(sent.at(-1)?.body ?? "{}").assignees[0]})
  expect(sent.at(-1)?.url).toBe("https://api.github.com/repos/anomalyco/opencode/issues/42/assignees")
}))
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)
const withDisplayMutation = testEffect(
  LayerNode.compile(root, [
    ...replacements,
    [
      Plugin.node,
      Layer.mock(Plugin.Service, {
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (name, input, output) =>
          Effect.sync(() => {
            if (name === "tool.definition" && isRecord(input) && input.toolID === "read" && isRecord(output)) {
              // 泛型 hook 保留返回类型；写入只针对已检查的对象视图，不把所有输出强转为 definition。
              const definition: Record<string, unknown> = output
              // 同时替换 Effect 展示参数与 JSON 展示声明，避免仅改其中一份而让另一份继续掩盖运行时来源。
              definition.parameters = Schema.Struct({ displayOnly: Schema.Number })
              definition.jsonSchema = {
                type: "object",
                properties: { displayOnly: { type: "number" } },
                required: ["displayOnly"],
              }
            }
            return output
          }),
      }),
    ],
  ]),
)
// 展示 schema 可被插件替换，但 decoder 不能跟着切换到未获真实工具支持的参数。
withDisplayMutation.instance("definition hooks cannot replace the captured native runtime schema", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const native = (yield* registry.all()).find((tool) => tool.id === "read")
    // all 取得原始定义，tools 才经过模型展示 hook；两份引用来自同一注册器而非测试自造副本。
    const shown = (yield* registry.tools({
      providerID: ProviderV2.ID.opencode,
      modelID: ModelV2.ID.make("test"),
      agent: yield* agents.defaultInfo(),
    })).find((tool) => tool.id === "read")
    if (!native || !shown) throw new Error("Missing native read")
    // 先证明hook确实替换了展示对象，否则后面的真实读取会让未触发hook的夹具也通过。
    expect(shown.parameters).not.toBe(native.parameters)
    expect(shown.runtimeParameters).toBe(native.parameters)
    const instance = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(instance.directory, "actual.txt"), "actual decoder"))
    // 执行只提供 filePath，故意不满足 displayOnly；成功读取能证明执行闭包仍使用原生参数。
    const result = yield* shown.execute(
      { filePath: path.join(instance.directory, "actual.txt") },
      {
        sessionID: SessionID.create(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    // 真实read返回文件正文，证明保留下来的不只是schema引用，执行闭包也仍用filePath合同。
    expect(result.program?.value).toMatchObject({ type: "text-page", content: "actual decoder" })
  }),
)

const withBrokenPlugin = testEffect(LayerNode.compile(root, [...replacements, [Plugin.node, brokenPluginLayer]]))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("registers execute independently of experimental flags", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("execute")
    }),
  )

  withCodeMode.instance("exposes a base execute definition before session catalog resolution", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      // 注册与执行共用一份说明，动态目录仍由 Session 独立交付。
      // 使用注册器已经初始化的定义；测试不能在生命周期之外重建缺失 owner 的工具。
      const definition = (yield* registry.all()).find((tool) => tool.id === "execute")
      expect(execute?.description).toBe(definition?.description)
      expect(execute?.description).toContain(CodeMode.description)
      expect(execute?.description).toContain("environmentID")
    }),
  )

  withEmptyCodeMode.instance("exposes execute with an empty MCP connection set", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id)).toContain("execute")
    }),
  )

  it.instance("hides permission review decision from public tool ids and normal agents", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const reviewer = yield* agents.get("permission-reviewer")
      const ids = yield* registry.ids()

      expect(ids).not.toContain("permission_review_decision")
      expect((yield* registry.tools({ providerID: ProviderV2.ID.opencode, modelID: ModelV2.ID.make("test"), agent: build })).map((tool) => tool.id)).not.toContain("permission_review_decision")
      expect((yield* registry.tools({ providerID: ProviderV2.ID.opencode, modelID: ModelV2.ID.make("test"), agent: reviewer })).map((tool) => tool.id)).toContain("permission_review_decision")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .opencode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("ignores non-tool exports in .opencode/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-opencode` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
      // 此处走插件列表入口；即使容忍缺失 args，也不能凭生成了 schema 就获得 native decoder 身份。
      expect(
        (yield* registry.all()).find((tool) => tool.id === "broken_plugin_tool")?.runtimeParameters,
      ).toBeUndefined()
    }),
  )

  it.instance("loads tools from .opencode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      // Zod 包装器保留自己的校验边界，不冒充 Tool.wrap 捕获的原生 Effect decoder。
      expect(loaded.runtimeParameters).toBeUndefined()
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const opencode = path.join(test.directory, ".opencode")
        const customTools = path.join(opencode, "tools")
        const plugin = path.join(opencode, "node_modules", "@opencode-ai", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(opencode, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@opencode-ai/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  // #223：插件工具的 execute 是普通 async 函数，会跨出当前 Effect fiber。
  // V2 registry 的 fromPlugin 已通过 EffectBridge 把 ask 绑定到当前实例上下文；
  // 这个测试验证插件内部 await context.ask(...) 仍使用正确的 InstanceState 目录。
  it.instance("preserves instance context when plugin tools run permission asks inside async execute", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // #223：自定义工具写到 .opencode/tools/ask.ts，registry 会发现并加载它
      const customTools = path.join(test.directory, ".opencode", "tools")
      // #223：plugin SDK 的 tool() 工厂从 plugin 包源码导入，保证和运行时一致
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "ask.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'ask tool',",
            "  args: {},",
            // #223：V2 的 context.ask 返回 Promise<void>，插件直接 await 即可
            "  execute: async (_args, context) => {",
            // #223：插件内部调用 ask 时传入 permission/patterns/always/metadata 四件套，
            // registry 的 EffectBridge 会把它们转发到 V2 的 Tool.Context.ask Effect
            "    await context.ask({ permission: 'plugin_ask', patterns: ['*'], always: ['*'], metadata: { reason: 'inside-plugin-promise' } })",
            "    return 'asked'",
            "  },",
            "})",
            "",
          ].join("\n"),
        ),
      )

      // #223：加载自定义工具并从 registry 查找 ask 工具定义
      // #223：registry.all() 会扫描 .opencode/tools/ 并用 V2 的 fromPlugin 加载
      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "ask")
      if (!loaded) throw new Error("custom ask tool was not loaded")
      const agents = yield* Agent.Service
      // #223：asked 捕获插件内部 ask 调用时传入的 permission 值
      let asked: string | undefined
      // #223：Tool.Context.ask 返回 Effect——registry 的 EffectBridge 会把它桥接到
      // 插件的 Promise<void> ask；这里在 Effect 层直接检查 InstanceState.directory
      // 是否等于当前测试目录，验证上下文没有在 async 边界丢失
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (req) =>
          InstanceState.directory.pipe(
            Effect.map((dir) => {
              // #223：如果 EffectBridge 丢失了实例上下文，dir 不会等于 test.directory
              expect(dir).toBe(test.directory)
              asked = req.permission
            }),
          ),
      } satisfies Tool.Context)

      // #223：插件返回 'asked' 表示 ask 通过后继续执行；permission 精确匹配 'plugin_ask'
      // #223：如果 EffectBridge 丢失上下文，asked 会是 undefined 或 dir 断言先失败
      // #223：这个测试不 mock callBridge——它只验证权限上下文传递，不验证 bridge 返回
      expect(result.output).toBe("asked")
      expect(asked).toBe("plugin_ask")
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".opencode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})

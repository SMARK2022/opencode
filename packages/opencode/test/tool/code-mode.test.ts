// 共享说明是宿主实际公开的合同来源；引用它可验证出口一致而不锁定过时文案摘要。
import { CodeMode } from "@opencode-ai/codemode"
import { afterEach, describe, expect, test } from "bun:test"
import { CODE_MODE_TOOL, CodeModeTool, Parameters, describeCatalog, type CatalogEntry } from "@/tool/code-mode"
import { McpCatalog } from "@/mcp/catalog"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
// 虚拟时钟在宿主执行接缝推进十分钟；不替换解释器或为测试新增生产超时入口。
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
// 直接宿主夹具也使用真实环境引擎，不能把 registry stub 成每次新建状态。
import { ExecuteEnvironments } from "@/tool/execute-environments"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code-mode"),
  messageID: MessageID.make("msg_code-mode"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_code_mode",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function mcpTool(
  name: string,
  handler: (args: Record<string, unknown>) => unknown,
  inputSchema: Record<string, unknown> = { type: "object", properties: {} },
  outputSchema?: Record<string, unknown>,
): MCP.McpTool {
  return {
    def: { name, description: name, inputSchema, ...(outputSchema ? { outputSchema } : {}) } as MCPToolDef,
    client: {
      callTool: async (params: { arguments?: Record<string, unknown> }) => handler(params.arguments ?? {}),
    } as unknown as MCP.McpTool["client"],
  }
}

const registries = new Set<ReturnType<typeof ExecuteEnvironments.makeRegistry>>()
afterEach(async () => {
  // Tool.init 的 Effect 已退出时环境仍须可调用；测试真正结束才关闭引擎并等待其清理。
  await Effect.runPromise(Effect.forEach(registries, (registry) => registry.close(), { discard: true }))
  registries.clear()
})

function harness() {
  return Layer.mergeAll(
    Layer.sync(ExecuteEnvironments.Service, () => {
      const registry = ExecuteEnvironments.makeRegistry()
      registries.add(registry)
      return { use: (sessionID, id, run) => registry.use({ sessionID, directory: "/fixture" }, id, run) }
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "primary" as const, options: {}, permission: [] }),
    }),
  )
}

function serverNames(mcpTools: Record<string, MCP.McpTool>, servers?: string[]) {
  return servers ?? [...new Set(Object.keys(mcpTools).map((key) => key.split("_")[0]!))]
}

function catalogFor(mcpTools: Record<string, MCP.McpTool>, servers?: string[], permission: PermissionV1.Rule[] = []): CatalogEntry[] {
  const names = serverNames(mcpTools, servers).toSorted((a, b) => b.length - a.length)
  return Object.entries(Permission.visibleTools(mcpTools, permission)).map(([id, entry]) => {
    const server = names.find((name) => id.startsWith(name + "_")) ?? id.split("_")[0]
    return { id, path: [server, id.startsWith(server + "_") ? id.slice(server.length + 1) : id],
      description: entry.def.description ?? "", inputSchema: McpCatalog.schemas(entry.def).input, outputSchema: McpCatalog.schemas(entry.def).output }
  })
}

async function build(
  mcpTools: Record<string, MCP.McpTool>,
  servers?: string[],
  permission?: PermissionV1.Rule[],
) {
  const catalog = catalogFor(mcpTools, servers, permission)
  const definition = await Effect.runPromise(
    CodeModeTool.pipe(
      Effect.flatMap(Tool.init),
      Effect.provide(harness()),
    ),
  )
  return { ...definition, execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => definition.execute(params, {
    ...ctx, codeMode: {
      catalog, signal: ctx.abort, begin: () => Effect.void,
      invoke: (id, input) => Effect.gen(function* () {
        // transport/result 使用真实协议 owner；夹具只替代本测试范围外的 Session 宿主。
        const result = yield* Effect.promise(() => McpCatalog.callTool(mcpTools[id], input, ctx.abort))
        // 测试与 SessionTools 一样传递声明，避免夹具误把已声明文本当成候选。
        return { title: id, output: "", metadata: {}, program: McpCatalog.programResult(result, mcpTools[id].def.outputSchema) }
      }),
    },
  }) }
}

function describeFor(mcpTools: Record<string, MCP.McpTool>, servers?: string[], permission: PermissionV1.Rule[] = []) {
  return Effect.runPromise(describeCatalog(catalogFor(mcpTools, servers, permission)))
}

// 先严格验证句柄与 metadata 相同，再检查原有业务文本，不能用删前缀掩盖环境交付失败。
function scriptOutput(result: { output: string; metadata: { environmentID: string } }) {
  expect(result.metadata.environmentID).toMatch(/^env_/)
  const prefix = `Environment: ${result.metadata.environmentID}\n\n`
  expect(result.output.startsWith(prefix)).toBe(true)
  return result.output.slice(prefix.length)
}

// Program failures die at the tool boundary; recover the defect for message assertions.
async function failure(effect: Effect.Effect<unknown>) {
  const exit = await Effect.runPromise(effect.pipe(Effect.exit))
  if (Exit.isSuccess(exit)) throw new Error("expected the tool to fail")
  return Cause.squash(exit.cause) as Error
}

describe("code mode execute", () => {
  test("defines execute input with an Effect schema", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    await expect(Effect.runPromise(decode({ code: "return 1" }))).resolves.toEqual({ code: "return 1" })
    await expect(Effect.runPromise(decode({}))).rejects.toThrow()
    // 空 ID 是显式的恢复请求，schema 不能把它变成缺省的新环境创建。
    expect(await Effect.runPromise(decode({ code: "return 1", environmentID: "" }))).toEqual({ code: "return 1", environmentID: "" })
    expect(Exit.isFailure(await Effect.runPromiseExit(decode({ code: "return 1", environmentID: 1 })))).toBe(true)
    // 缺省值留给宿主运行策略；解码只接受安全正整数，不把字符串、零或非有限数悄悄修正。
    for (const timeout of [1, 600000, Number.MAX_SAFE_INTEGER]) {
      expect(await Effect.runPromise(decode({ code: "return 1", timeout }))).toEqual({ code: "return 1", timeout })
    }
    for (const timeout of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, "10"]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(decode({ code: "return 1", timeout })))).toBe(true)
    }
    expect(Schema.toJsonSchemaDocument(Parameters).schema).toMatchObject({
      properties: {
        timeout: { type: "integer" },
        code: {
          description: "Script body executed by the confined interpreter.",
        },
      },
    })
  })

  test("omission creates state and explicit IDs preserve results and mutations across errors", async () => {
    const tool = await build({})
    const first = await Effect.runPromise(tool.execute({ code: 'let n = 0; function next() { return ++n }; return "created"' }, ctx))
    const environmentID = first.metadata.environmentID
    expect(scriptOutput(first)).toBe("created")
    expect(scriptOutput(await Effect.runPromise(tool.execute({ environmentID, code: "return next()" }, ctx)))).toBe("1")
    // 错误不是事务回滚；运行错误和超时后的变更保留，语法错误则不能先执行任何语句。
    for (const [code, value, timeout] of [
      ['n++; throw new Error("cell failed")', "2", undefined],
      ["n++; const =", "2", undefined],
      ["n++; await Promise.race([])", "3", 5],
    ] as const) {
      const error = await failure(tool.execute({ environmentID, code, ...(timeout ? { timeout } : {}) }, ctx))
      expect(error.message.startsWith(`Environment: ${environmentID}\n\n`)).toBe(true)
      expect(scriptOutput(await Effect.runPromise(tool.execute({ environmentID, code: "return n" }, ctx)))).toBe(value)
    }
    // 没有显式句柄就没有状态继承；无效/跨会话 ID 不能偷偷创建替代环境。
    expect((await failure(tool.execute({ code: "return n" }, ctx))).message).toContain("Unknown identifier")
    for (const id of ["", "env_unknown"]) expect((await failure(tool.execute({ environmentID: id, code: 'return "wrong"' }, ctx))).message).toContain("unavailable")
    expect((await failure(tool.execute({ environmentID, code: "return n" }, { ...ctx, sessionID: SessionID.make("ses_other") }))).message).toContain("unavailable")
  })

  testEffect(harness()).effect("runtime schema owns shortcuts while defaults and permission inputs execute once", () => Effect.gen(function* () {
    let defaults = 0
    const decoded: unknown[] = []
    const asked: unknown[] = []
    const observed: unknown[] = []
    const parameters = Schema.Struct({count:Schema.NumberFromString, flag:Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => { defaults++; return true })))})
    // define 显式绑定 decoder 泛型，让 body 收到已解码类型；宿主适配边界仍以擦除的 Def 接收原始编码值。
    // 不能为了类型检查在此再 decode 一次，否则默认值副作用与真实运行合同都会改变。
    const native: Tool.Def = yield* Tool.define<typeof parameters, Record<string, unknown>, never>("count", Effect.succeed({
      description:"count", parameters,
      // initializer 给出的伪 provenance 必须被真实包装器覆盖，不能改变现有 decoder 的来源。
      runtimeParameters: Schema.Struct({count:Schema.NumberFromString, flag:Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))) }),
      execute: (input, context) => Effect.gen(function* () {
        decoded.push(input)
        yield* context.ask({permission:"read",patterns:[String(input.count)],always:[],metadata:input})
        return {title:"count",output:"",metadata:{},program:{value:input}}
      }),
    })).pipe(Effect.flatMap(Tool.init))
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const catalog: CatalogEntry[] = [{id:"count",path:["host","count"],description:"count",runtimeParameters:native.runtimeParameters,
      inputSchema:{type:"object",properties:{displayOnly:{type:"number"}},required:["displayOnly"]}}]
    yield* describeCatalog(catalog)
    expect(defaults).toBe(0)
    for (const args of ['"42"', '{count:"42"}']) {
      const result = yield* tool.execute({code:`return await tools.host.count(${args})`},{...ctx,
        ask:(request)=>Effect.sync(()=>{asked.push(request.metadata)}),codeMode:{catalog,signal:ctx.abort,
          begin:(_code,calls)=>Effect.sync(()=>{observed.push(...calls.map((call)=>call.input))}),
          invoke:(_id,input)=>native.execute(input,{...ctx,ask:(request)=>Effect.sync(()=>{asked.push(request.metadata)})})}})
      // 预跑及目录分类不运行默认值；真实 permission 与业务函数看到原 decoder 的同一结果。
      expect(JSON.parse(scriptOutput(result))).toEqual({count:42,flag:true})
    }
    expect(observed).toEqual([{count:"42"},{count:"42"}])
    expect(decoded).toEqual([{count:42,flag:true},{count:42,flag:true}])
    expect(asked).toEqual(decoded)
    expect(defaults).toBe(2)
  }))

  testEffect(harness()).effect("abort during first metadata publication preserves model-readable handle", () => Effect.gen(function* () {
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const controller = new AbortController()
    const snapshots: Array<{ metadata?: Record<string, unknown> }> = []
    let reviewed = false
    const exit = yield* tool.execute({ code: "return 1" }, {
      ...ctx, abort: controller.signal,
      // 在预跑及运行 finalizer 安装之前取消；已接纳的句柄仍须能经父失败输出交付。
      metadata: (value) => Effect.sync(() => { snapshots.push(value); controller.abort() }),
      codeMode: { catalog: [], signal: controller.signal,
        begin: () => Effect.sync(() => { reviewed = true }), invoke: () => Effect.die("Unexpected invocation") },
    }).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(reviewed).toBe(false)
    expect(snapshots.length).toBeGreaterThan(0)
    const id = snapshots[0].metadata?.environmentID
    expect(id).toMatch(/^env_/)
    // metadata 回调是替换协议，任一更新都不能仅留下 UI 可见但模型不可恢复的 ID。
    for (const snapshot of snapshots) {
      expect(snapshot.metadata?.environmentID).toBe(id)
      expect(snapshot.metadata?.output).toBe(`Environment: ${String(id)}`)
    }
  }))

  testEffect(harness()).effect("queued host abort releases only the waiter and does not spend its execution timeout", () => Effect.gen(function* () {
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const ready = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const host = {
      catalog: [{ id: "wait", path: ["host", "wait"] as const, description: "wait", inputSchema: { type: "object" as const, properties: {} } }],
      signal: ctx.abort, begin: () => Effect.void,
      invoke: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)),
        Effect.as({ title: "wait", output: "done", metadata: {} })),
    }
    const first = yield* tool.execute({ code: "let n = 0; return n" }, { ...ctx, codeMode: host })
    const environmentID = first.metadata.environmentID
    const holder = yield* tool.execute({ environmentID, code: "n++; await tools.host.wait({}); return n", timeout: 1000 }, { ...ctx, codeMode: host }).pipe(Effect.forkScoped)
    yield* Deferred.await(ready)
    const controller = new AbortController()
    const queued = yield* tool.execute({ environmentID, code: "n = 99; return n", timeout: 25 }, {
      ...ctx, abort: controller.signal, codeMode: { ...host, signal: controller.signal },
    }).pipe(Effect.exit, Effect.forkScoped)
    // 虚拟时间越过等待者的执行预算；仍在队列中时，25ms 不能开始计时或触碰词法状态。
    yield* TestClock.adjust(100)
    expect(queued.pollUnsafe()).toBeUndefined()
    controller.abort()
    const exit = yield* Fiber.join(queued)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    // 取消排队请求不能取消当前持有者；释放真实等待后仍只有持有者执行的那次加一。
    expect(holder.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    expect(scriptOutput(yield* Fiber.join(holder))).toBe("1")
    expect(scriptOutput(yield* tool.execute({ environmentID, code: "return n" }, { ...ctx, codeMode: host }))).toBe("1")
  }))

  testEffect(harness()).effect("single JS and TS fences share the raw permission and execution body", () => Effect.gen(function* () {
    // 直接观察公开 begin 与 invoke；预跑记录的参数、审查源码和真实工具输入必须来自同一正文。
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const body = "return (await tools.host.echo({value:7})).value as number"
    const reviewed: Array<{ code: string; calls: readonly { tool: string; input: unknown }[] }> = []
    const inputs: unknown[] = []
    // 外侧空白和 CRLF 只是围栏排版，正文自身仍逐字进入权限审查。
    const sources = [body, ...["", "js", "javascript", "ts", "typescript"].map((tag) => `  \n\`\`\`${tag}\n${body}\n\`\`\`\n `), `\`\`\`ts\r\n${body}\r\n\`\`\``]
    for (const code of sources) {
      const out = yield* tool.execute({ code }, {
        ...ctx, codeMode: {
          catalog: [{ id: "echo", path: ["host", "echo"], description: "echo", inputSchema: { type: "object", properties: { value: { type: "number" } } } }],
          signal: ctx.abort,
          begin: (code, calls) => Effect.sync(() => { reviewed.push({ code, calls }) }),
          invoke: (_id, input) => Effect.sync(() => { inputs.push(input); return { title: "echo", output: "", metadata: {}, program: { value: input } } }),
        },
      })
      // 原 TS 编译路径继续处理类型断言；不是先尝试原文失败后再切换另一套解析器。
      expect(scriptOutput(out)).toBe("7")
      expect(reviewed.at(-1)).toEqual({ code: body, calls: [{ tool: "echo", input: { value: 7 } }] })
    }
    expect(inputs).toEqual(Array.from({ length: sources.length }, () => ({ value: 7 })))
  }))

  test("mixed or multiple fences are not extracted and raw strings remain intact", async () => {
    // 把合法调用放进非法包裹；若实现擅自抽取其中一个块，独立副作用清单就会暴露执行。
    const called: string[] = []
    const tool = await build({ host_touch: mcpTool("touch", () => { called.push("touch"); return "ok" }) })
    const body = "await tools.host.touch({}); return 1"
    const fence = `\`\`\`js\n${body}\n\`\`\``
    for (const code of [`prose\n${fence}`, `${fence}\nprose`, `${fence}\n${fence}`, `\`\`\`python\n${body}\n\`\`\``, `\`\`\`js\n${body}`, `\`\`\`js\n${fence}\n\`\`\``]) {
      expect((await failure(tool.execute({ code }, ctx))).message.length).toBeGreaterThan(0)
    }
    expect(called).toEqual([])
    // 围栏样式可以是普通 JS 字符串数据，只有完整输入 envelope 才允许规范化。
    const literal = "```javascript\nnot code\n```"
    expect(scriptOutput(await Effect.runPromise(tool.execute({ code: `return ${JSON.stringify(literal)}` }, ctx)))).toBe(literal)
  })

  for (const timeout of [undefined, 25]) testEffect(harness()).effect(`execution budget uses ${timeout ?? "default"} milliseconds after review`, () => Effect.gen(function* () {
    // 默认十分钟与显式毫秒值走同一公开宿主；待审时间不能挤占真正执行的预算。
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const reviewing = yield* Deferred.make<void>()
    const reviewed = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    let cleaned = false
    const pending = yield* tool.execute({ code: 'await tools.host.wait({}); return "unreachable"', ...(timeout === undefined ? {} : { timeout }) }, {
      ...ctx, codeMode: {
        catalog: [{ id: "wait", path: ["host", "wait"], description: "wait", inputSchema: { type: "object", properties: {} } }],
        signal: ctx.abort,
        begin: () => Deferred.succeed(reviewing, undefined).pipe(Effect.andThen(Deferred.await(reviewed))),
        invoke: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => { cleaned = true }))),
      },
    }).pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(reviewing)
    yield* TestClock.adjust(600001)
    expect(pending.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(reviewed, undefined)
    // 工具发出开始信号后才推进时钟，避免把加载/预跑耗时误当运行超时。
    yield* Deferred.await(started)
    yield* TestClock.adjust((timeout ?? 600000) - 1)
    expect(pending.pollUnsafe()).toBeUndefined()
    expect(cleaned).toBe(false)
    yield* TestClock.adjust(1)
    // 到期必须已结束并完成清理，而不是只把超时原因写到仍运行的子调用上。
    expect(pending.pollUnsafe()).toBeDefined()
    const exit = yield* Fiber.join(pending)
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("timed out")
    expect(cleaned).toBe(true)
  }))

  test("renders the supplied multi-underscore namespace", async () => {
    const description = await describeFor({ my_server_do_thing: mcpTool("do_thing", () => "") }, ["my_server"])
    expect(description).toContain("- my_server (1 tool)")
    expect(description).toContain("tools.my_server.do_thing(")
  })

  test("renders a supplied namespace without underscores", async () => {
    const description = await describeFor({ standalone: mcpTool("standalone", () => "") }, [])
    expect(description).toContain("- standalone (1 tool)")
    expect(description).toContain("tools.standalone.standalone(")
  })

  test("describeCatalog carries the raw MCP schemas for rendering", async () => {
    const description = await describeFor(
      {
        weather_current: mcpTool(
          "current",
          () => "",
          { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          { type: "object", properties: { tempC: { type: "number" } }, required: ["tempC"] },
        ),
      },
      ["weather"],
    )
    // 紧凑目录仍由同一原始输入/输出 schema 渲染；字段说明保留在搜索索引，签名统一使用紧凑类型。
    expect(description).toContain("tools.weather.current(input: { city: string }): Promise<{ tempC: number }>")
  })

  test("the static base description exposes shared guidance without a session catalog", async () => {
    const tool = await build({ github_list_issues: mcpTool("list_issues", () => "") })
    expect(tool.id).toBe(CODE_MODE_TOOL)
    // 宿主沿用唯一共享说明，避免文案更新后仍锁定已废弃的上游摘要。
    // 基础说明仍共享，只有宿主增加一句有实际 owner 支持的环境复用提示。
    expect(tool.description).toBe(`${CodeMode.description}\nReuse the returned environmentID to continue with saved variables and functions; omit it for a fresh environment. Schema-less MCP object/array JSON text becomes data; use String(value) for its original text.`)
    expect(tool.description).not.toContain("Available tools")
    expect(tool.description).not.toContain("list_issues")
  })

  testEffect(harness()).effect("only captured native core paths win catalog budget before shorter collisions", () => Effect.gen(function* () {
    const native = yield* Tool.define("read",Effect.succeed({description:"native",parameters:Schema.Struct({filePath:Schema.String}),execute:()=>Effect.succeed({title:"",output:"",metadata:{}})})).pipe(Effect.flatMap(Tool.init))
    // 足量短签名耗尽原预算；只有真正的 native provenance 能让较长 read 先获得展示机会。
    const fillers:CatalogEntry[]=Array.from({length:250},(_,index)=>({id:`z${index}`,path:["host",`z${index}`],description:"",inputSchema:{type:"object",properties:{}}}))
    // JSON schema 合同中的 required 是普通数组，不能由测试 as const 制造额外 readonly 限制。
    const shape: CatalogEntry["inputSchema"] = {type:"object",properties:Object.fromEntries(Array.from({length:20},(_,index)=>[`field${index}`,{type:"string"}])),required:["field0"]}
    for(const origin of ["native","custom","mcp"] as const){
      const entry:CatalogEntry={id:origin === "mcp" ? "remote_read" : "read",path:[origin === "mcp" ? "remote" : "$opencode","read"],description:"",inputSchema:shape,
        ...(origin === "native" ? {runtimeParameters:native.runtimeParameters} : {})}
      const description=yield* describeCatalog([entry,...fillers])
      expect(description).toContain("The catalog is partial")
      // 同名自定义/MCP 条目不靠名字继承优先级；仍存在于原目录，不被删掉冒充安全过滤。
      expect(description.includes(`tools.${entry.path[0]}.read(`)).toBe(origin === "native")
      const tool=yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
      const result=yield* tool.execute({code:`return search({query:"read",namespace:${JSON.stringify(entry.path[0])},limit:1}).items.map(item=>item.path)`},{...ctx,codeMode:{catalog:[entry,...fillers],signal:ctx.abort,begin:()=>Effect.void,invoke:()=>Effect.die("Search must not invoke leaf")}})
      expect(JSON.parse(scriptOutput(result))).toEqual([`tools.${entry.path[0]}.read`])
    }
    // 已过滤的核心条目不在输入目录中，优先策略不能重新创造它。
    expect(yield* describeCatalog(fillers)).not.toContain("tools.$opencode.read(")
  }))

  // 完整目录表示每个精确调用类型都可见，不要求字段说明占用内联预算。
  test("small catalogs inline every compact signature in the appended catalog", async () => {
    const description = await describeFor({
      github_create_issue: mcpTool("create_issue", () => "", {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"],
      }),
      github_list_issues: mcpTool("list_issues", () => ""),
      linear_search: mcpTool("search", () => ""),
    })

    // 字段文档可继续按需搜索，完整目录不能被改写成工具权限或可用性限制。
    expect(description).toContain("The catalog is complete.")
    expect(description).toContain("- github (2 tools)")
    expect(description).toContain("- linear (1 tool)")
    expect(description).toContain("tools.github.create_issue(input: { title: string; body?: string }): Promise<unknown>")
    expect(description).toContain("tools.github.list_issues(")
    expect(description).toContain("tools.linear.search(")
    expect(description).toContain("tools.linear.search(): Promise<unknown>")
    expect(description).not.toContain("$codemode")
    expect(description).not.toContain("Browse one namespace")
    expect(description).toContain("## Code Mode tools (call only inside `execute`)")
    expect(description).not.toContain("JSON.parse(res)")
    // 目录外工具仍走直接调用，精简文案不能扩大 Execute 的可调用集合。
    expect(description).toContain("call tools outside this catalog directly.")
    expect(description).not.toContain("total_count")
  })

  test("signatures render the declared outputSchema as the return type", async () => {
    const description = await describeFor({
      weather_current: mcpTool(
        "current",
        () => "",
        { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        {
          type: "object",
          properties: { tempC: { type: "number" }, summary: { type: "string" } },
          required: ["tempC"],
        },
      ),
    })
    // 压缩展示不能丢失返回值的可选字段，也不能把 outputSchema 降格成 unknown。
    expect(description).toContain("tools.weather.current(input: { city: string }): Promise<{ tempC: number; summary?: string }>")
  })

  test("large catalogs inline a budgeted PARTIAL list plus runtime search", async () => {
    const tools: Record<string, MCP.McpTool> = {}
    const filler = "a searchable description of this operation that consumes catalog budget ".repeat(3)
    for (let i = 0; i < 150; i++) {
      tools[`alpha_op_${i}`] = {
        def: {
          name: `op_${i}`,
          description: `${filler}${i}`,
          inputSchema: { type: "object", properties: { value: { type: "string" }, count: { type: "number" } } },
        } as MCPToolDef,
        client: { callTool: async () => ({ content: [] }) } as unknown as MCP.McpTool["client"],
      }
    }
    tools["zeta_only_tool"] = mcpTool("only_tool", () => "", {
      type: "object",
      properties: { topic: { type: "string", description: "Subject to look up" } },
      required: ["topic"],
    })
    const description = await describeFor(tools, ["alpha", "zeta"])

    expect(description).toContain("The catalog is partial.")
    expect(description).toMatch(/- alpha \(150 tools, \d+ shown\)/)
    expect(description).toContain("- zeta (1 tool)\n")
    // 大目录保留少量命名空间的精确签名；长字段说明不应挤掉它的唯一工具。
    expect(description).toContain("tools.zeta.only_tool(input: { topic: string }): Promise<unknown>")
    expect(description).toContain("search(input: {")
    expect(description).toContain("limit?: number; offset?: number")
    expect(description).toContain("remaining: number; next: {")
    expect(description).toContain("offset: number } | null")
    expect(description).toContain("Use `search(...)` for unlisted tools.")
    expect(description).toContain(
      "Each result's `path` is the complete call expression",
    )
    expect(description).not.toContain("total_count")
    expect(description).toContain("tools.alpha.op_0(")
    expect(description).not.toContain("tools.alpha.op_99(")

    const tool = await build(tools, ["alpha", "zeta"])
    const out = await Effect.runPromise(
      tool.execute({ code: "return await tools.$codemode.search({ query: 'only tool', limit: 3, offset: 0 })" }, ctx),
    )
    const result = JSON.parse(scriptOutput(out))
    expect(result.items.map((i: any) => i.path)).toContain("tools.zeta.only_tool")
    expect(result).toMatchObject({ remaining: 0, next: null })
    expect(result.items[0].signature).toContain("tools.")
    const signature = result.items.find((i: any) => i.path === "tools.zeta.only_tool").signature
    // 搜索与内联共享紧凑签名，保留参数类型但不再承诺字段 JSDoc。
    expect(signature).toBe("tools.zeta.only_tool(input: { topic: string }): Promise<unknown>")
    expect(tools.zeta_only_tool.def.inputSchema.properties?.topic).toEqual({type:"string",description:"Subject to look up"})
    // 渲染不改声明本体，字段文档仍保留在原输入 schema。
    expect(description).not.toContain("/** Subject to look up */")
    expect(out.metadata.toolCalls).toEqual([
      { tool: "$codemode.search", status: "completed", input: { query: "only tool", limit: 3, offset: 0 } },
    ])
  })

  test("runs plain JavaScript and returns the value as text", async () => {
    const tool = await build({})
    const output = await Effect.runPromise(tool.execute({ code: "return 1 + 2" }, ctx))
    // 环境包装后仍精确检查普通 JavaScript 执行得到的原数字结果。
    expect(scriptOutput(output)).toBe("3")
    expect(output.metadata.toolCalls).toEqual([])
  })

  test("Object.keys(tools) enumerates the MCP server and CodeMode namespaces", async () => {
    const tool = await build({
      github_list_issues: mcpTool("list_issues", () => ""),
      linear_search: mcpTool("search", () => ""),
    })
    const output = await Effect.runPromise(
      tool.execute(
        { code: "const namespaces = Object.keys(tools); return { namespaces, count: namespaces.length }" },
        ctx,
      ),
    )
    // 自省结果保持当前目录的业务结构，句柄不是额外工具命名空间。
    expect(JSON.parse(scriptOutput(output))).toEqual({ namespaces: ["github", "linear", "$codemode"], count: 3 })
  })

  test("calls a namespaced MCP tool and flows its text result back into the program", async () => {
    const seen: Record<string, unknown>[] = []
    const tool = await build({
      greeter_hello: mcpTool("hello", (args) => {
        seen.push(args)
        return { content: [{ type: "text", text: `hello ${args.name}` }] }
      }),
    })

    const output = await Effect.runPromise(
      tool.execute({ code: "const r = await tools.greeter.hello({ name: 'world' }); return r.toUpperCase()" }, ctx),
    )

    expect(seen).toEqual([{ name: "world" }])
    // 同步字符串组合保持原值，恢复信息不得进入脚本数据。
    expect(scriptOutput(output)).toBe("HELLO WORLD")
    expect(output.metadata.toolCalls).toEqual([
      { tool: "greeter.hello", status: "completed", input: { name: "world" } },
    ])
  })

  test("exposes structured content as native data and composes multiple calls", async () => {
    const tool = await build({
      math_add: mcpTool("add", (args) => ({
        content: [],
        structuredContent: { sum: (args.a as number) + (args.b as number) },
      })),
    })

    const output = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const first = await tools.math.add({ a: 1, b: 2 })
            const second = await tools.math.add({ a: first.sum, b: 10 })
            return { total: second.sum }
          `,
        },
        ctx,
      ),
    )

    // 前次结果参与后续调用后仍返回可解析 JSON，不以宿主文字代替类型验证。
    expect(JSON.parse(scriptOutput(output))).toEqual({ total: 13 })
    expect(output.metadata.toolCalls).toEqual([
      { tool: "math.add", status: "completed", input: { a: 1, b: 2 } },
      { tool: "math.add", status: "completed", input: { a: 3, b: 10 } },
    ])
  })

  test("runs tool calls in parallel with Promise.all", async () => {
    const tool = await build({
      echo_one: mcpTool("one", () => ({ content: [{ type: "text", text: "1" }] })),
      echo_two: mcpTool("two", () => ({ content: [{ type: "text", text: "2" }] })),
    })

    const output = await Effect.runPromise(
      tool.execute(
        { code: "const [a, b] = await Promise.all([tools.echo.one({}), tools.echo.two({})]); return a + b" },
        ctx,
      ),
    )

    // 有效 MCP 输出仍按原 schema 解码；环境包装不放宽验证器。
    expect(scriptOutput(output)).toBe("12")
    expect(output.metadata.toolCalls.map((c) => c.tool).sort()).toEqual(["echo.one", "echo.two"])
    expect(output.metadata.toolCalls.every((c) => c.status === "completed")).toBe(true)
  })

  test("a program failure fails the tool with a readable error", async () => {
    const tool = await build({})
    const error = await failure(tool.execute({ code: "throw new Error('boom')" }, ctx))
    // 普通失败保留原错误语义，并携带可恢复同一词法状态的模型可见 ID。
    expect(error.message).toMatch(/^Environment: env_[^\n]+\n\nUncaught: boom$/)
  })

  test("eligible MCP JSON text becomes data while raw source and business text survive", async () => {
    const raw = ' {"items":[1,2],"text":"business"} '
    const tool = await build({json_read:mcpTool("read",()=>({content:[{type:"text",text:raw}]}))})
    // 对象字段、原始字符串与业务 text 同时验证；不能靠 JSON.parse 在示例里绕开 ingress 合同。
    const result = await Effect.runPromise(tool.execute({code:'const value = await tools.json.read({}); value.items.push(3); return {count:value.items.length,text:value.text,source:String(value),keys:Object.keys(value),json:JSON.stringify(value)}'},ctx))
    expect(JSON.parse(scriptOutput(result))).toEqual({count:3,text:"business",source:raw,keys:["items","text"],json:'{"items":[1,2,3],"text":"business"}'})
  })

  // 只有 MCP owner 明确标记的无声明文本才解析；原生 string 即便长得像 JSON 仍是字符串。
  testEffect(harness()).effect("declared native strings are never reinterpreted as JSON objects", () => Effect.gen(function* () {
    const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
    const source = ' {"value":1} '
    const out = yield* tool.execute({code:'const value = await tools.host.text({}); return {type:typeof value, source:value, upper:value.toUpperCase()}'},{...ctx,codeMode:{
      catalog:[{id:"text",path:["host","text"],description:"native text",inputSchema:{type:"object",properties:{}},outputSchema:{type:"string"}}],
      signal:ctx.abort,begin:()=>Effect.void,invoke:()=>Effect.succeed({title:"",output:"display only",metadata:{},program:{value:source}}),
    }})
    // 同时断言字符串方法与原始字节，防止只校验 typeof 而丢掉业务内容。
    expect(JSON.parse(scriptOutput(out))).toEqual({type:"string",source,upper:source.toUpperCase()})
  }))

  test("reports an unknown tool as a failed execution", async () => {
    const tool = await build({ known_tool: mcpTool("tool", () => "ok") })
    const error = await failure(tool.execute({ code: "return await tools.known.missing({})" }, ctx))
    expect(error.message).toContain("Unknown tool 'known.missing'")
  })

  test("propagates an MCP tool error into the program as a catchable failure", async () => {
    const tool = await build({
      bad_tool: mcpTool("tool", () => ({ isError: true, content: [{ type: "text", text: "server exploded" }] })),
    })
    const output = await Effect.runPromise(
      tool.execute({ code: "try { await tools.bad.tool({}) } catch (e) { return 'caught: ' + e.message }" }, ctx),
    )
    // 捕获异常仍是脚本成功；回执只补充工具终态，不能把 catch 结果改成父执行失败。
    expect(scriptOutput(output)).toBe("Tool calls: 0 completed; 1 failed or interrupted.\nFailed or interrupted: bad.tool\n\nScript result:\ncaught: server exploded")
    expect(output.metadata.error).toBeUndefined()
  })

  test("terminal receipts bound failed names without exposing arguments or causes", async () => {
    // 全部结算后主动只返回计数，证明宿主不会把私有工具错误或参数重新塞回模型文本。
    const names = ["a", "b", "c", "d", "e", "f", "x".repeat(201)]
    const tool = await build(Object.fromEntries([
      ...names.map((name) => [`batch_${name}`, mcpTool(name, () => ({ isError: true, content: [{ type: "text", text: "PRIVATE_CAUSE" }] }))]),
      ["batch_ok", mcpTool("ok", () => ({ content: [{ type: "text", text: "ok" }] }))],
    ]), ["batch"])
    const out = await Effect.runPromise(tool.execute({ code: `
      const settled = await Promise.allSettled(Object.keys(tools.batch).map(name => tools.batch[name]({secret:"PRIVATE_ARGUMENT"})));
      return { fulfilled: settled.filter(item => item.status === "fulfilled").length };
    ` }, ctx))
    expect(scriptOutput(out)).toBe('Tool calls: 1 completed; 7 failed or interrupted.\nFailed or interrupted: batch.a, batch.b, batch.c, batch.d, batch.e (2 more)\n\nScript result:\n{\n  "fulfilled": 1\n}')
    // 超长名称和第六个普通名称都计入省略数；脚本结果不受名称预算裁剪。
    expect(scriptOutput(out)).not.toContain("batch.f")
    expect(scriptOutput(out)).not.toContain("x".repeat(201))
    expect(scriptOutput(out)).not.toContain("PRIVATE_")
    expect(out.metadata.toolCalls.filter((call) => call.status === "error")).toHaveLength(7)
    expect(out.metadata.error).toBeUndefined()
  })

  test("an unawaited failed call is visible beside a successful script result", async () => {
    // 后续成功调用让已启动的失败有机会结算；漏 await 不能使最终模型回执只剩 done。
    const tool = await build({
      bad_tool: mcpTool("tool", () => ({ isError: true, content: [{ type: "text", text: "PRIVATE_CAUSE" }] })),
      good_tool: mcpTool("tool", () => ({ content: [{ type: "text", text: "ok" }] })),
    })
    const out = await Effect.runPromise(tool.execute({ code: "tools.bad.tool({}); await tools.good.tool({}); return 'done'" }, ctx))
    expect(scriptOutput(out)).toBe("Tool calls: 1 completed; 1 failed or interrupted.\nFailed or interrupted: bad.tool\n\nScript result:\ndone")
    // 错误详情仍由脚本自行决定是否输出，未捕获的工具终态不改变父 return 的成功身份。
    expect(out.metadata.error).toBeUndefined()
    expect(out.metadata.toolCalls.every((call) => call.status !== "running")).toBe(true)
  })

  // 权限终止、MCP ask 和 hooks 的验收移至 session/execute.test.ts 的真实共享宿主。
  // 此处继续验证解释器对宿主数据、普通错误、附件和取消的消费合同。

  test("streams live per-call metadata as a call starts and finishes", async () => {
    // 进度样本与真实替换载荷同形，句柄和模型可见前缀都是必要字段。
    const snapshots: Array<{ environmentID: string; output: string; toolCalls: { tool: string; status: string; input?: Record<string, unknown> }[] }> = []
    const recordingCtx: Tool.Context = {
      ...ctx,
      metadata: (val: any) => Effect.sync(() => void snapshots.push(val.metadata)),
    }
    const tool = await build({ greeter_hello: mcpTool("hello", () => ({ content: [{ type: "text", text: "hi" }] })) })

    await Effect.runPromise(
      tool.execute({ code: "await tools.greeter.hello({ name: 'Ada' }); return 'done'" }, recordingCtx),
    )

    // 初始及终态进度都必须保留同一环境的恢复身份。
    expect(snapshots).toContainEqual({
      environmentID: expect.stringMatching(/^env_/),
      output: expect.stringMatching(/^Environment: env_/),
      toolCalls: [{ tool: "greeter.hello", status: "running", input: { name: "Ada" } }],
    })
    expect(snapshots).toContainEqual({
      environmentID: expect.stringMatching(/^env_/),
      output: expect.stringMatching(/^Environment: env_/),
      toolCalls: [{ tool: "greeter.hello", status: "completed", input: { name: "Ada" } }],
    })
  })

  test("marks a failed child call as error in the live metadata", async () => {
    // 进度样本与真实替换载荷同形，句柄和模型可见前缀都是必要字段。
    const snapshots: Array<{ environmentID: string; output: string; toolCalls: { tool: string; status: string; input?: Record<string, unknown> }[] }> = []
    const recordingCtx: Tool.Context = {
      ...ctx,
      metadata: (val: any) => Effect.sync(() => void snapshots.push(val.metadata)),
    }
    const tool = await build({
      bad_tool: mcpTool("tool", () => ({ isError: true, content: [{ type: "text", text: "boom" }] })),
    })

    await Effect.runPromise(
      tool.execute(
        { code: "try { await tools.bad.tool({ reason: 'test' }) } catch (e) { return 'caught' }" },
        recordingCtx,
      ),
    )

    // 异常进度同样交付句柄与实际错误调用，不能只覆盖成功路径。
    expect(snapshots).toContainEqual({ environmentID: expect.stringMatching(/^env_/), output: expect.stringMatching(/^Environment: env_/), toolCalls: [{ tool: "bad.tool", status: "error", input: { reason: "test" } }] })
  })

  test("accumulates stripped media as execute attachments the sandbox never sees", async () => {
    const tool = await build({
      shot_take: mcpTool("take", () => ({
        content: [{ type: "image", data: "PNGDATA", mimeType: "image/png" }],
        structuredContent: { name: "shot.png" },
      })),
    })

    const out = await Effect.runPromise(tool.execute({ code: "return await tools.shot.take({})" }, ctx))
    // 结构化结果和图片附件继续分离，脚本结果不能包含图片字节。
    expect(JSON.parse(scriptOutput(out))).toEqual({ name: "shot.png" })
    expect(out.attachments).toEqual([{ type: "file", mime: "image/png", url: "data:image/png;base64,PNGDATA" }])
    expect(scriptOutput(out)).not.toContain("PNGDATA")
  })

  test("a media-only result returns a text marker so the program knows it succeeded", async () => {
    const tool = await build({
      shot_take: mcpTool("take", () => ({ content: [{ type: "image", data: "PNGDATA", mimeType: "image/png" }] })),
    })
    const out = await Effect.runPromise(tool.execute({ code: "return await tools.shot.take({})" }, ctx))
    // 纯媒体返回仍使用既有文字占位，环境 ID 不改变附件合同。
    expect(scriptOutput(out)).toBe("[1 image attached to the result]")
    expect(out.attachments).toEqual([{ type: "file", mime: "image/png", url: "data:image/png;base64,PNGDATA" }])
  })

  test("media-only markers distinguish all-image from mixed attachments", async () => {
    const tool = await build({
      media_images: mcpTool("images", () => ({
        content: [
          { type: "image", data: "PNG1", mimeType: "image/png" },
          { type: "image", data: "PNG2", mimeType: "image/png" },
        ],
      })),
      media_mixed: mcpTool("mixed", () => ({
        content: [
          { type: "image", data: "PNG3", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///tmp/report.pdf", mimeType: "application/pdf", blob: "PDF1" } },
        ],
      })),
    })
    const out = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const images = await tools.media.images({})
            const mixed = await tools.media.mixed({})
            return { images, mixed }
          `,
        },
        ctx,
      ),
    )

    // 混合资源的字段保持原形，附件字节仍不进入业务 JSON。
    expect(JSON.parse(scriptOutput(out))).toEqual({
      images: "[2 images attached to the result]",
      mixed: "[2 files attached to the result]",
    })
    expect(scriptOutput(out)).not.toContain("PNG")
    expect(out.attachments).toEqual([
      { type: "file", mime: "image/png", url: "data:image/png;base64,PNG1" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,PNG2" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,PNG3" },
      { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,PDF1", filename: "report.pdf" },
    ])
  })

  test("resource links flow to the program as text, never as attachments", async () => {
    const tool = await build({
      docs_find: mcpTool("find", () => ({
        content: [
          {
            type: "resource_link",
            uri: "https://example.com/guide.pdf",
            name: "guide.pdf",
            mimeType: "application/pdf",
          },
          { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md" },
        ],
      })),
    })
    const out = await Effect.runPromise(tool.execute({ code: "return await tools.docs.find({})" }, ctx))

    // 资源链接保持可读正文和原 URI，不以环境句柄替换来源。
    expect(scriptOutput(out)).toBe("guide.pdf: https://example.com/guide.pdf\nnotes.md: file:///tmp/notes.md")
    expect(out.attachments).toBeUndefined()
  })

  test("attachments still flow when the program returns something else entirely", async () => {
    const tool = await build({
      shot_take: mcpTool("take", () => ({ content: [{ type: "image", data: "PNGDATA", mimeType: "image/png" }] })),
    })
    const out = await Effect.runPromise(tool.execute({ code: "await tools.shot.take({}); return 'captured'" }, ctx))
    // 脚本返回其它值时仍保留独立附件，环境行不能代替原业务结果。
    expect(scriptOutput(out)).toBe("captured")
    expect(out.attachments).toHaveLength(1)
  })

  test("isolates the sandbox from host globals", async () => {
    const tool = await build({})
    const error = await failure(tool.execute({ code: "return process.env" }, ctx))
    expect(error.message).toContain("process")
  })

  test("cancelling via ctx.abort interrupts the running program", async () => {
    const controller = new AbortController()
    const tool = await build({
      host_trigger: mcpTool("trigger", () => {
        controller.abort()
        return new Promise(() => {})
      }),
    })
    const output = await Effect.runPromiseExit(
      tool.execute(
        { code: "try { await tools.host.trigger({}) } catch {} while (true) {}" },
        { ...ctx, abort: controller.signal },
      ),
    )
    expect(Exit.isFailure(output)).toBe(true)
    if (Exit.isFailure(output)) expect(Cause.hasInterrupts(output.cause)).toBe(true)
  })

  test("a pre-aborted signal cancels before the program runs", async () => {
    const controller = new AbortController()
    controller.abort()
    const ran: string[] = []
    const tool = await build({ host_touch: mcpTool("touch", () => (ran.push("called"), "ok")) })
    const output = await Effect.runPromiseExit(
      tool.execute({ code: "return await tools.host.touch({})" }, { ...ctx, abort: controller.signal }),
    )
    expect(Exit.isFailure(output)).toBe(true)
    expect(ran).toEqual([])
  })

  test("leaves oversized results to OpenCode's native tool-output truncation", async () => {
    const tool = await build({})
    const output = await Effect.runPromise(tool.execute({ code: "return 'x'.repeat(40000)" }, ctx))
    expect(output.metadata.error).toBeUndefined()
    // 大业务输出仍保持未截断长度，独立环境行不能掩盖数据丢失。
    expect(scriptOutput(output)).not.toContain("[result truncated:")
    expect(scriptOutput(output).length).toBeGreaterThanOrEqual(40_000)
  })

  test("appends logs after the result on success and after the message on error", async () => {
    const tool = await build({})

    const ok = await Effect.runPromise(
      tool.execute({ code: "console.log('step one'); console.warn('careful'); return 'done'" }, ctx),
    )
    // 正常业务值与多级日志的相对顺序不变，环境行位于它们之外。
    expect(scriptOutput(ok)).toBe("done\n\nLogs:\nstep one\n[warn] careful")

    const error = await failure(tool.execute({ code: "console.log('before the throw'); throw new Error('boom')" }, ctx))
    expect(error.message).toContain("Uncaught: boom")
    expect(error.message).toContain("Logs:\nbefore the throw")
  })
})

describe("code mode permission visibility", () => {
  const deny = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "deny" })
  const askRule = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "ask" })
  const ok = () => ({ content: [{ type: "text", text: "ok" }] })

  test("a hard-denied tool never enters the catalog or its search index", async () => {
    const mcpTools = {
      github_create_issue: mcpTool("create_issue", ok),
      github_list_issues: mcpTool("list_issues", ok),
    }
    const description = await describeFor(mcpTools, ["github"], [deny("github_create_issue")])
    expect(description).toContain("tools.github.list_issues(")
    expect(description).not.toContain("create_issue")
    expect(description).toContain("- github (1 tool)")
  })

  test("an ask-level tool stays fully visible in the catalog", async () => {
    const mcpTools = {
      github_create_issue: mcpTool("create_issue", ok),
      github_list_issues: mcpTool("list_issues", ok),
    }
    const description = await describeFor(mcpTools, ["github"], [askRule("github_create_issue")])
    expect(description).toContain("tools.github.create_issue(")
    expect(description).toContain("tools.github.list_issues(")
    expect(description).toContain("- github (2 tools)")
  })

  test("a hard-denied tool is not dispatchable: the program gets the unknown-tool diagnostic", async () => {
    const called: string[] = []
    const tool = await build(
      {
        github_create_issue: mcpTool("create_issue", () => {
          called.push("create_issue")
          return ok()
        }),
        github_list_issues: mcpTool("list_issues", ok),
      },
      ["github"],
      [deny("github_create_issue")],
    )

    const denied = await failure(tool.execute({ code: "return await tools.github.create_issue({ title: 'x' })" }, ctx))
    expect(denied.message).toContain("Unknown tool 'github.create_issue'")
    expect(denied.message).not.toContain("permission")
    expect(called).toEqual([])

    const allowed = await Effect.runPromise(tool.execute({ code: "return await tools.github.list_issues({})" }, ctx))
    expect(allowed.metadata.error).toBeUndefined()
    // 当前权限允许的叶子仍返回原值；禁止项继续由原权限断言约束。
    expect(scriptOutput(allowed)).toBe("ok")
  })

  test("Permission.visibleTools hides only hard denies, matching Permission.disabled", () => {
    const tools = { a_tool: 1, b_tool: 2, c_tool: 3 }
    const visible = Permission.visibleTools(tools, [
      deny("a_tool"),
      askRule("b_tool"),
      { permission: "c_tool", pattern: "something", action: "deny" },
    ])
    expect(Object.keys(visible)).toEqual(["b_tool", "c_tool"])
  })
})

// 宿主夹具沿用真实解释器与租约服务，覆盖跨调用状态和取消边界。
import { CodeMode } from "@opencode-ai/codemode"
import { afterEach, describe, expect, test } from "bun:test"
import { CODE_MODE_TOOL, CodeModeTool, Parameters, describeCatalog, makeExecutionBudget, type CatalogEntry } from "@/tool/code-mode"
import { McpCatalog } from "@/mcp/catalog"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { ExecuteEnvironments } from "@/tool/execute-environments"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Session } from "@/session/session"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import { TestInstance, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"

// 宿主夹具的 afterEach 只清理本组注册表，不接管后面的真实 Session 生命周期用例。
describe("code mode host fixtures", () => {
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
        // 只替代Session归属查询，租约和词法环境仍用真实引擎，跨调用状态由它持有。
        const registry = ExecuteEnvironments.makeRegistry()
        registries.add(registry)
        return { use: (sessionID, id, run) => registry.use({ sessionID, directory: "/fixture" }, id, run) }
      }),
      // 常规宿主用例不落盘；大输出用例接入原 Truncate 服务，验证它不会被提前调用。
      Layer.mock(Truncate.Service, {
        limits: () => Effect.succeed({ maxBytes: Truncate.MAX_BYTES, maxLines: Truncate.MAX_LINES }),
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
    // 初始化 Effect 已返回，后续 execute 仍消费同一 registry；这能发现把环境误绑到初始化作用域的问题。
    return {
      ...definition,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        definition.execute(params, {
          ...ctx,
          codeMode: {
            catalog,
            signal: ctx.abort,
            begin: () => Effect.void,
            invoke: (id, input) =>
              Effect.gen(function* () {
                // transport/result 使用真实协议 owner；夹具只替代本测试范围外的 Session 宿主。
                const result = yield* Effect.promise(() => McpCatalog.callTool(mcpTools[id], input, ctx.abort))
                // 测试与 SessionTools 一样传递声明，避免夹具误把已声明文本当成候选。
                return {
                  title: id,
                  output: "",
                  metadata: {},
                  program: McpCatalog.programResult(result, mcpTools[id].def.outputSchema),
                }
              }),
          },
        }),
    }
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
      expect(await Effect.runPromise(decode({ code: "return 1", environmentID: "" }))).toEqual({
        code: "return 1",
        environmentID: "",
      })
      expect(Exit.isFailure(await Effect.runPromiseExit(decode({ code: "return 1", environmentID: 1 })))).toBe(true)
      // 缺省值留给宿主运行策略；解码只接受安全正整数，不把字符串、零或非有限数悄悄修正。
      for (const timeout of [1, 600000, 2_147_483_647]) {
        expect(await Effect.runPromise(decode({ code: "return 1", timeout }))).toEqual({ code: "return 1", timeout })
      }
      for (const timeout of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, NaN, Infinity, null, "10"]) {
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
      const first = await Effect.runPromise(
        tool.execute({ code: 'let n = 0; function next() { return ++n }; return "created"' }, ctx),
      )
      // next 捕获的 n 与后续单元共享同一绑定；只保存最后返回值无法通过下一次递增。
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
        // 失败文本必须给出原句柄，下一次读取才能验证同一环境中的修改，而非另建状态。
        expect(error.message.startsWith(`Environment: ${environmentID}\n\n`)).toBe(true)
        expect(scriptOutput(await Effect.runPromise(tool.execute({ environmentID, code: "return n" }, ctx)))).toBe(value)
      }
      // 没有显式句柄就没有状态继承；无效/跨会话 ID 不能偷偷创建替代环境。
      // 这里省略 ID 而不是换用另一工具实例，排除宿主把最近环境当成默认值。
      expect((await failure(tool.execute({ code: "return n" }, ctx))).message).toContain("Unknown identifier")
      for (const id of ["", "env_unknown"])
        expect((await failure(tool.execute({ environmentID: id, code: 'return "wrong"' }, ctx))).message).toContain(
          "unavailable",
        )
      expect(
        (
          await failure(
            tool.execute({ environmentID, code: "return n" }, { ...ctx, sessionID: SessionID.make("ses_other") }),
          )
        ).message,
      ).toContain("unavailable")
    })

    testEffect(harness()).effect("runtime schema owns shortcuts while defaults and permission inputs execute once", () =>
      Effect.gen(function* () {
        let defaults = 0
        const decoded: unknown[] = []
        const asked: unknown[] = []
        const observed: unknown[] = []
        // count 的编码类型是字符串、执行类型是数字；转换有可见差异，不能由恒等 decoder 凑绿。
        const parameters = Schema.Struct({
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
        // define 显式绑定 decoder 泛型，让 body 收到已解码类型；宿主适配边界仍以擦除的 Def 接收原始编码值。
        // 不能为了类型检查在此再 decode 一次，否则默认值副作用与真实运行合同都会改变。
        const native: Tool.Def = yield* Tool.define<typeof parameters, Record<string, unknown>, never>(
          "count",
          Effect.succeed({
            description: "count",
            parameters,
            // initializer 给出的伪 provenance 必须被真实包装器覆盖，不能改变现有 decoder 的来源。
            runtimeParameters: Schema.Struct({
              count: Schema.NumberFromString,
              flag: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
            }),
            execute: (input, context) =>
              Effect.gen(function* () {
                decoded.push(input)
                yield* context.ask({ permission: "read", patterns: [String(input.count)], always: [], metadata: input })
                return { title: "count", output: "", metadata: {}, program: { value: input } }
              }),
          }),
        ).pipe(Effect.flatMap(Tool.init))
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const catalog: CatalogEntry[] = [
          {
            id: "count",
            path: ["host", "count"],
            description: "count",
            runtimeParameters: native.runtimeParameters,
            // 展示声明故意要求不相关字段，标量简写仍须按原 decoder 找到唯一必填的 count。
            inputSchema: { type: "object", properties: { displayOnly: { type: "number" } }, required: ["displayOnly"] },
          },
        ]
        // 初始化器声明的默认值为false，真实decoder为true；返回值能识别provenance是否被伪造。
        yield* describeCatalog(catalog)
        // 尚未调用工具时默认值计数必须为零，目录生成若执行 decoder 会在此直接暴露。
        expect(defaults).toBe(0)
        for (const args of ['"42"', '{count:"42"}']) {
          const result = yield* tool.execute(
            { code: `return await tools.host.count(${args})` },
            {
              ...ctx,
              ask: (request) =>
                Effect.sync(() => {
                  asked.push(request.metadata)
                }),
              codeMode: {
                catalog,
                signal: ctx.abort,
                begin: (_code, calls) =>
                  Effect.sync(() => {
                    observed.push(...calls.map((call) => call.input))
                  }),
                invoke: (_id, input) =>
                  native.execute(input, {
                    ...ctx,
                    ask: (request) =>
                      Effect.sync(() => {
                        asked.push(request.metadata)
                      }),
                  }),
              },
            },
          )
          // 预跑及目录分类不运行默认值；真实 permission 与业务函数看到原 decoder 的同一结果。
          expect(JSON.parse(scriptOutput(result))).toEqual({ count: 42, flag: true })
        }
        // 审查拿encoded字符串，权限和工具正文拿decoded数字；三个观察面共同定位转换所在入口。
        expect(observed).toEqual([{ count: "42" }, { count: "42" }])
        expect(decoded).toEqual([
          { count: 42, flag: true },
          { count: 42, flag: true },
        ])
        expect(asked).toEqual(decoded)
        // 两种输入各执行一次默认值；权限检查与预跑若额外解码，计数就会超过实际调用数。
        expect(defaults).toBe(2)
      }),
    )

    testEffect(harness()).effect("abort during first metadata publication preserves model-readable handle", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const controller = new AbortController()
        const snapshots: Array<{ metadata?: Record<string, unknown> }> = []
        let reviewed = false
        const exit = yield* tool
          .execute(
            { code: "return 1" },
            {
              ...ctx,
              abort: controller.signal,
              // 在预跑及运行 finalizer 安装之前取消；已接纳的句柄仍须能经父失败输出交付。
              metadata: (value) =>
                Effect.sync(() => {
                  snapshots.push(value)
                  controller.abort()
                }),
              codeMode: {
                catalog: [],
                signal: controller.signal,
                begin: () =>
                  Effect.sync(() => {
                    reviewed = true
                  }),
                invoke: () => Effect.die("Unexpected invocation"),
              },
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        // 审查尚未开始就中断，证明句柄交付不依赖 begin 或任何 leaf 已经启动。
        expect(reviewed).toBe(false)
        expect(snapshots.length).toBeGreaterThan(0)
        const id = snapshots[0].metadata?.environmentID
        expect(id).toMatch(/^env_/)
        // metadata 回调是替换协议，任一更新都不能仅留下 UI 可见但模型不可恢复的 ID。
        for (const snapshot of snapshots) {
          expect(snapshot.metadata?.environmentID).toBe(id)
          expect(snapshot.metadata?.output).toBe(`Environment: ${String(id)}`)
        }
      }),
    )

    testEffect(harness()).effect(
      "queued host abort releases only the waiter and does not spend its execution timeout",
      () =>
        Effect.gen(function* () {
          const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
          const ready = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const host = {
            catalog: [
              {
                id: "wait",
                path: ["host", "wait"] as const,
                description: "wait",
                inputSchema: { type: "object" as const, properties: {} },
              },
            ],
            signal: ctx.abort,
            begin: () => Effect.void,
            invoke: () =>
              Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ title: "wait", output: "done", metadata: {} }),
              ),
          }
          const first = yield* tool.execute({ code: "let n = 0; return n" }, { ...ctx, codeMode: host })
          const environmentID = first.metadata.environmentID
          const holder = yield* tool
            .execute(
              { environmentID, code: "n++; await tools.host.wait({}); return n", timeout: 1000 },
              { ...ctx, codeMode: host },
            )
            .pipe(Effect.forkScoped)
          // holder已改写n并进入宿主等待后才创建排队者，后续n=1能定位谁真正取得租约。
          yield* Deferred.await(ready)
          const controller = new AbortController()
          const queued = yield* tool
            .execute(
              { environmentID, code: "n = 99; return n", timeout: 25 },
              {
                ...ctx,
                abort: controller.signal,
                codeMode: { ...host, signal: controller.signal },
              },
            )
            .pipe(Effect.exit, Effect.forkScoped)
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
          // 再开一个单元检查 n，排除排队者取消后仍迟到执行 n = 99。
          expect(scriptOutput(yield* tool.execute({ environmentID, code: "return n" }, { ...ctx, codeMode: host }))).toBe(
            "1",
          )
        }),
    )

    testEffect(harness()).effect("single JS and TS fences share the raw permission and execution body", () =>
      Effect.gen(function* () {
        // 直接观察公开 begin 与 invoke；预跑记录的参数、审查源码和真实工具输入必须来自同一正文。
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const body = "return (await tools.host.echo({value:7})).value as number"
        const reviewed: Array<{ code: string; calls: readonly { tool: string; input: unknown }[] }> = []
        const inputs: unknown[] = []
        // 外侧空白和 CRLF 只是围栏排版，正文自身仍逐字进入权限审查。
        const sources = [
          body,
          ...["", "js", "javascript", "ts", "typescript"].map((tag) => `  \n\`\`\`${tag}\n${body}\n\`\`\`\n `),
          `\`\`\`ts\r\n${body}\r\n\`\`\``,
        ]
        for (const code of sources) {
          const out = yield* tool.execute(
            { code },
            {
              ...ctx,
              codeMode: {
                catalog: [
                  {
                    id: "echo",
                    path: ["host", "echo"],
                    description: "echo",
                    inputSchema: { type: "object", properties: { value: { type: "number" } } },
                  },
                ],
                signal: ctx.abort,
                begin: (code, calls) =>
                  Effect.sync(() => {
                    reviewed.push({ code, calls })
                  }),
                invoke: (_id, input) =>
                  Effect.sync(() => {
                    inputs.push(input)
                    return { title: "echo", output: "", metadata: {}, program: { value: input } }
                  }),
              },
            },
          )
          // 原 TS 编译路径继续处理类型断言；不是先尝试原文失败后再切换另一套解析器。
          expect(scriptOutput(out)).toBe("7")
          expect(reviewed.at(-1)).toEqual({ code: body, calls: [{ tool: "echo", input: { value: 7 } }] })
        }
        // 每种包裹只产生一次真实输入；仅核对审查正文会漏掉预跑错误调用宿主的重复副作用。
        expect(inputs).toEqual(Array.from({ length: sources.length }, () => ({ value: 7 })))
      }),
    )

    testEffect(harness()).effect("preview caps total calls while review retains unique tool inputs", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const reviewed: unknown[] = []
        let invoked = 0
        // 第 1024 次的新参数仍被记录，第 1025 次只在真实执行出现；重复调用同样耗费预算。
        const result = yield* tool.execute(
          {
            code: "for (let i = 0; i < 1023; i++) await tools.host.check({a:1}); await tools.host.check({a:2}); await tools.host.check({a:3}); return 7",
          },
          {
            ...ctx,
            codeMode: {
              catalog: [{ id: "check", path: ["host", "check"], description: "check", inputSchema: { type: "object" } }],
              signal: ctx.abort,
              begin: (_code, calls) =>
                Effect.sync(() => {
                  reviewed.push(...calls)
                }),
              invoke: () =>
                Effect.sync(() => {
                  invoked++
                  return { title: "check", output: "", metadata: {}, program: { value: null } }
                }),
            },
          },
        )
        expect(reviewed).toEqual([
          { tool: "check", input: { a: 1 } },
          { tool: "check", input: { a: 2 } },
        ])
        // 预跑只限制收集成本，真实执行仍须到达最后一次调用，不能沿用探针计数。
        expect(invoked).toBe(1025)
        expect(scriptOutput(result)).toBe("7")
      }),
    )

    testEffect(harness()).effect("preview deduplicates reordered inputs and keeps distinct tools and values", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const reviewed: unknown[] = []
        // 对象键序不影响相同参数；工具名、值以及 undefined 与缺省键仍是不同请求。
        yield* tool.execute(
          {
            code: `
        await tools.host.first({a:1,b:2}); await tools.host.first({b:2,a:1});
        await tools.host.first({a:2,b:2}); await tools.host.second({a:1,b:2});
        await tools.host.first({}); await tools.host.first({a:undefined});
        await fetch("https://example.invalid"); await fetch("https://example.invalid");
        return 1
      `,
          },
          {
            ...ctx,
            codeMode: {
              catalog: ["first", "second"].map((id) => ({
                id,
                path: ["host", id],
                description: id,
                inputSchema: { type: "object" },
              })),
              signal: ctx.abort,
              begin: (_code, calls) =>
                Effect.sync(() => {
                  reviewed.push(...calls)
                }),
              invoke: () => Effect.succeed({ title: "check", output: "", metadata: {}, program: { value: null } }),
              fetch: () =>
                Effect.succeed({
                  url: "https://example.invalid",
                  status: 200,
                  statusText: "",
                  ok: true,
                  redirected: false,
                  headers: {},
                  text: "null",
                  bytes: [],
                }),
            },
          },
        )
        // 保留首次出现的顺序，fetch 与普通工具共用同一档案，而不是另占一份重复记录。
        expect(reviewed).toEqual([
          { tool: "first", input: { a: 1, b: 2 } },
          { tool: "first", input: { a: 2, b: 2 } },
          { tool: "second", input: { a: 1, b: 2 } },
          { tool: "first", input: {} },
          { tool: "first", input: { a: undefined } },
          { tool: "webfetch", input: { url: "https://example.invalid" } },
        ])
      }),
    )

    testEffect(harness()).effect("preview reaches review at its 500 millisecond deadline", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const reviewing = yield* Deferred.make<void>()
        let reviewed = false
        // 无工具循环只能由预跑时间预算退出，审查入口阻塞以排除真实执行计时的干扰。
        const running = yield* tool
          .execute(
            { code: "while (true) {}" },
            {
              ...ctx,
              codeMode: {
                catalog: [],
                signal: ctx.abort,
                begin: () =>
                  Effect.sync(() => {
                    reviewed = true
                  }).pipe(Effect.andThen(Deferred.succeed(reviewing, undefined)), Effect.andThen(Effect.never)),
                invoke: () => Effect.die("unreachable"),
              },
            },
          )
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* TestClock.adjust(499)
        expect(reviewed).toBe(false)
        yield* TestClock.adjust(1)
        yield* Deferred.await(reviewing)
        expect(reviewed).toBe(true)
        yield* Fiber.interrupt(running)
      }),
    )

    test("mixed or multiple fences are not extracted and raw strings remain intact", async () => {
      // 把合法调用放进非法包裹；若实现擅自抽取其中一个块，独立副作用清单就会暴露执行。
      const called: string[] = []
      const tool = await build({
        host_touch: mcpTool("touch", () => {
          called.push("touch")
          return "ok"
        }),
      })
      const body = "await tools.host.touch({}); return 1"
      const fence = `\`\`\`js\n${body}\n\`\`\``
      for (const code of [
        `prose\n${fence}`,
        `${fence}\nprose`,
        `${fence}\n${fence}`,
        `\`\`\`python\n${body}\n\`\`\``,
        `\`\`\`js\n${body}`,
        `\`\`\`js\n${fence}\n\`\`\``,
      ]) {
        expect((await failure(tool.execute({ code }, ctx))).message.length).toBeGreaterThan(0)
      }
      expect(called).toEqual([])
      // 围栏样式可以是普通 JS 字符串数据，只有完整输入 envelope 才允许规范化。
      const literal = "```javascript\nnot code\n```"
      expect(
        scriptOutput(await Effect.runPromise(tool.execute({ code: `return ${JSON.stringify(literal)}` }, ctx))),
      ).toBe(literal)
    })

    for (const timeout of [undefined, 25])
      testEffect(harness()).effect(`execution budget uses ${timeout ?? "default"} milliseconds after review`, () =>
        Effect.gen(function* () {
          // 默认十分钟与显式毫秒值走同一公开宿主；待审时间不能挤占真正执行的预算。
          const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
          const reviewing = yield* Deferred.make<void>()
          const reviewed = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          let cleaned = false
          const pending = yield* tool
            .execute(
              { code: 'await tools.host.wait({}); return "unreachable"', ...(timeout === undefined ? {} : { timeout }) },
              {
                ...ctx,
                codeMode: {
                  catalog: [
                    {
                      id: "wait",
                      path: ["host", "wait"],
                      description: "wait",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                  signal: ctx.abort,
                  begin: () => Deferred.succeed(reviewing, undefined).pipe(Effect.andThen(Deferred.await(reviewed))),
                  invoke: () =>
                    Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          cleaned = true
                        }),
                      ),
                    ),
                },
              },
            )
            .pipe(Effect.exit, Effect.forkScoped)
          yield* Deferred.await(reviewing)
          // 先越过默认十分钟再放行审查，省略和显式超时都必须从执行开始才消耗预算。
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
        }),
      )

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
      // 返回类型只由MCP声明决定，紧凑展示不能借模拟执行结果猜测业务结构。
      expect(description).toContain("tools.weather.current(input: { city: string }): Promise<{ tempC: number }>")
    })

    test("the static base description exposes shared guidance without a session catalog", async () => {
      const tool = await build({ github_list_issues: mcpTool("list_issues", () => "") })
      expect(tool.id).toBe(CODE_MODE_TOOL)
      // 宿主只追加环境复用与MCP投影说明；通用使用指导仍须跟随共享文本更新。
      expect(tool.description).toContain(CodeMode.description)
      expect(tool.description).toContain("environmentID")
      expect(tool.description).toContain("saved variables, functions and closures")
      expect(tool.description).not.toContain("Available tools")
      expect(tool.description).not.toContain("list_issues")
    })

    testEffect(harness()).effect("only captured native core paths win catalog budget before shorter collisions", () =>
      Effect.gen(function* () {
        const native = yield* Tool.define(
          "read",
          Effect.succeed({
            description: "native",
            parameters: Schema.Struct({ filePath: Schema.String }),
            execute: () => Effect.succeed({ title: "", output: "", metadata: {} }),
          }),
        ).pipe(Effect.flatMap(Tool.init))
        // 足量短签名耗尽原预算；只有真正的 native provenance 能让较长 read 先获得展示机会。
        const fillers: CatalogEntry[] = Array.from({ length: 250 }, (_, index) => ({
          id: `z${index}`,
          path: ["host", `z${index}`],
          description: "",
          inputSchema: { type: "object", properties: {} },
        }))
        // 非原生条目使用二十个字段的长签名，短填充条目会抢先耗尽预算，暴露同名条目是否冒领优先级。
        const shape: CatalogEntry["inputSchema"] = {
          type: "object",
          properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, { type: "string" }])),
          required: ["field0"],
        }
        for (const keepTools of [true, false]) for (const id of ["read", "bash", "apply_patch", "write"])
        for (const origin of ["native", "custom", "mcp"] as const) {
          const entry: CatalogEntry = {
            id: origin === "mcp" ? `remote_${id}` : id,
            path: [origin === "mcp" ? "remote" : "$opencode", id],
            description: "",
            inputSchema: shape,
            ...(origin === "native" ? { runtimeParameters: native.runtimeParameters } : {}),
          }
          const description = yield* describeCatalog([entry, ...fillers], keepTools)
          expect(description).toContain("The catalog is partial")
          // 同名自定义/MCP 条目不靠名字继承优先级；仍存在于原目录，不被删掉冒充安全过滤。
          expect(description.includes(`tools.${entry.path[0]}.${id}(`)).toBe(origin === "native" && (!keepTools || id === "read"))
          const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
          const result = yield* tool.execute(
            {
              code: `return search({query:${JSON.stringify(id)},namespace:${JSON.stringify(entry.path[0])},limit:1}).items.map(item=>item.path)`,
            },
            {
              ...ctx,
              codeMode: {
                catalog: [entry, ...fillers],
                signal: ctx.abort,
                begin: () => Effect.void,
                invoke: () => Effect.die("Search must not invoke leaf"),
              },
            },
          )
          // 内联省略的条目仍能被 search 找到，预算裁剪不能变成调用目录的权限过滤。
          expect(JSON.parse(scriptOutput(result))).toEqual([`tools.${entry.path[0]}.${id}`])
        }
        // 已过滤的核心条目不在输入目录中，优先策略不能重新创造它。
        expect(yield* describeCatalog(fillers)).not.toContain("tools.$opencode.read(")
      }),
    )

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
      expect(description).toContain(
        "tools.github.create_issue(input: { title: string; body?: string }): Promise<unknown>",
      )
      expect(description).toContain("tools.github.list_issues(")
      expect(description).toContain("tools.linear.search(")
      expect(description).toContain("tools.linear.search(): Promise<unknown>")
      expect(description).not.toContain("$codemode")
      expect(description).not.toContain("Browse one namespace")
      expect(description).toContain("## Code Mode tools")
      expect(description).not.toContain("JSON.parse(res)")
      // 目录外工具仍走直接调用，精简文案不能扩大 Execute 的可调用集合。
      expect(description).toContain("Other tools shown in the conversation can be called directly.")
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
      expect(description).toContain(
        "tools.weather.current(input: { city: string }): Promise<{ tempC: number; summary?: string }>",
      )
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
      expect(description).toContain("Each result's `path` is the complete call expression")
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
      expect(tools.zeta_only_tool.def.inputSchema.properties?.topic).toEqual({
        type: "string",
        description: "Subject to look up",
      })
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

      // 两个返回值都是 JSON 数字文本，仍应保持字符串相加得到 12；只有对象或数组文本可成为数据候选。
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
      const tool = await build({ json_read: mcpTool("read", () => ({ content: [{ type: "text", text: raw }] })) })
      // 对象字段、原始字符串与业务 text 同时验证；不能靠 JSON.parse 在示例里绕开 ingress 合同。
      const result = await Effect.runPromise(
        tool.execute(
          {
            code: "const value = await tools.json.read({}); value.items.push(3); return {count:value.items.length,text:value.text,source:String(value),keys:Object.keys(value),json:JSON.stringify(value)}",
          },
          ctx,
        ),
      )
      // push 改变业务数组而 String(value) 保留原文，两项一起区分可变数据与原始文本的不同职责。
      expect(JSON.parse(scriptOutput(result))).toEqual({
        count: 3,
        text: "business",
        source: raw,
        keys: ["items", "text"],
        json: '{"items":[1,2,3],"text":"business"}',
      })
    })

    // 只有 MCP owner 明确标记的无声明文本才解析；原生 string 即便长得像 JSON 仍是字符串。
    testEffect(harness()).effect("declared native strings are never reinterpreted as JSON objects", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        const source = ' {"value":1} '
        const out = yield* tool.execute(
          {
            code: "const value = await tools.host.text({}); return {type:typeof value, source:value, upper:value.toUpperCase()}",
          },
          {
            ...ctx,
            codeMode: {
              catalog: [
                {
                  id: "text",
                  path: ["host", "text"],
                  description: "native text",
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: { type: "string" },
                },
              ],
              signal: ctx.abort,
              begin: () => Effect.void,
              invoke: () =>
                Effect.succeed({ title: "", output: "display only", metadata: {}, program: { value: source } }),
            },
          },
        )
        // 同时断言字符串方法与原始字节，防止只校验 typeof 而丢掉业务内容。
        expect(JSON.parse(scriptOutput(out))).toEqual({ type: "string", source, upper: source.toUpperCase() })
      }),
    )

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
      // catch 已观察失败，正文保持业务返回值；最终 metadata 仍记录失败 child。
      expect(scriptOutput(output)).toBe("caught: server exploded")
      expect(output.metadata.error).toBeUndefined()
      expect(output.metadata.toolCalls).toEqual([{ tool: "bad.tool", status: "error" }])
    })

    test("allSettled keeps observed failures out of the receipt and retains every child state", async () => {
      // 全部结算后主动只返回计数，证明宿主不会把私有工具错误或参数重新塞回模型文本。
      const names = ["a", "b", "c", "d", "e", "f", "x".repeat(201)]
      const tool = await build(
        Object.fromEntries([
          ...names.map((name) => [
            `batch_${name}`,
            mcpTool(name, () => ({ isError: true, content: [{ type: "text", text: "PRIVATE_CAUSE" }] })),
          ]),
          ["batch_ok", mcpTool("ok", () => ({ content: [{ type: "text", text: "ok" }] }))],
        ]),
        ["batch"],
      )
      const out = await Effect.runPromise(
        tool.execute(
          {
            code: `
      const settled = await Promise.allSettled(Object.keys(tools.batch).map(name => tools.batch[name]({secret:"PRIVATE_ARGUMENT"})));
      return { fulfilled: settled.filter(item => item.status === "fulfilled").length };
    `,
          },
          ctx,
        ),
      )
      expect(JSON.parse(scriptOutput(out))).toEqual({ fulfilled: 1 })
      expect(out.output).not.toContain("PRIVATE_")
      // 所有失败均已由 allSettled 观察；正文不列错误名称，恢复 metadata 仍保留完整调用事实。
      expect(out.metadata.toolCalls).toEqual([
        // 固定状态不能被 map 推宽为任意 string；预期回执仍按真实 CallEntry 合同检查。
        ...names.map((name) => ({
          tool: `batch.${name}`,
          status: "error" as const,
          input: { secret: "PRIVATE_ARGUMENT" },
        })),
        { tool: "batch.ok", status: "completed" as const, input: { secret: "PRIVATE_ARGUMENT" } },
      ])
      // 子调用全被观察后，父成功与子失败可以并存；父 error 标志不能直接取“是否有失败 child”。
      expect(out.metadata.error).toBeUndefined()
    })

    test("an unawaited failed call is visible beside a successful script result", async () => {
      // 后续成功调用让已启动的失败有机会结算；漏 await 不能使最终模型回执只剩 done。
      const tool = await build({
        bad_tool: mcpTool("tool", () => ({ isError: true, content: [{ type: "text", text: "PRIVATE_CAUSE" }] })),
        good_tool: mcpTool("tool", () => ({ content: [{ type: "text", text: "ok" }] })),
      })
      const out = await Effect.runPromise(
        tool.execute({ code: "tools.bad.tool({}); await tools.good.tool({}); return 'done'" }, ctx),
      )
      expect(scriptOutput(out)).toBe(
        "Some asynchronous work failed or was interrupted without the script observing its outcome." +
          "\n\nScript result:\ndone",
      )
      // 错误详情仍由脚本自行决定是否输出，未捕获的工具终态不改变父 return 的成功身份。
      expect(out.metadata.error).toBeUndefined()
      expect(out.output).not.toContain("PRIVATE_CAUSE")
      expect(out.metadata.toolCalls).toEqual([
        { tool: "bad.tool", status: "error" },
        { tool: "good.tool", status: "completed" },
      ])
    })

    // 权限终止、MCP ask 和 hooks 的验收移至 session/execute.test.ts 的真实共享宿主。
    // 此处继续验证解释器对宿主数据、普通错误、附件和取消的消费合同。

    test("streams child progress and returns the complete successful terminal state", async () => {
      const snapshots: Array<{ delivery?: "durable" | "ephemeral"; metadata?: Record<string, unknown> }> = []
      const recordingCtx: Tool.Context = {
        ...ctx,
        metadata: (value) =>
          Effect.sync(() => {
            snapshots.push(value)
          }),
      }
      const tool = await build({ greeter_hello: mcpTool("hello", () => ({ content: [{ type: "text", text: "hi" }] })) })
      const out = await Effect.runPromise(
        tool.execute({ code: "await tools.greeter.hello({ name: 'Ada' }); return 'done'" }, recordingCtx),
      )
      const environmentID = out.metadata.environmentID
      expect(scriptOutput(out)).toBe("done")
      // 首个句柄先持久化，后续 running 允许临时发送；快速完成时也不能失去环境的恢复入口。
      expect(snapshots[0]?.delivery).toBe("durable")
      expect(snapshots.map((snapshot) => snapshot.metadata)).toContainEqual({
        environmentID,
        output: `Environment: ${environmentID}`,
        toolCalls: [{ tool: "greeter.hello", status: "running", input: { name: "Ada" } }],
      })
      // 100ms 窗口可合并 completed 进度；最终结果必须独立保留完整终态与输入。
      expect(out.metadata.toolCalls).toEqual([{ tool: "greeter.hello", status: "completed", input: { name: "Ada" } }])
      // metadata 按整份替换而非合并，逐条检查 ID 才能发现某次进度更新抹掉句柄。
      expect(snapshots.every((snapshot) => snapshot.metadata?.environmentID === environmentID)).toBe(true)
    })

    test("caught child failures remain in the result and uncaught failures persist final metadata", async () => {
      const snapshots: Array<{ delivery?: "durable" | "ephemeral"; metadata?: Record<string, unknown> }> = []
      const recordingCtx: Tool.Context = {
        ...ctx,
        metadata: (value) =>
          Effect.sync(() => {
            snapshots.push(value)
          }),
      }
      const tool = await build({
        bad_tool: mcpTool("tool", () => ({ isError: true, content: [{ type: "text", text: "boom" }] })),
      })
      const out = await Effect.runPromise(
        tool.execute(
          {
            code: "try { await tools.bad.tool({ reason: 'test' }) } catch (e) { return 'caught' }",
          },
          recordingCtx,
        ),
      )
      expect(scriptOutput(out)).toBe("caught")
      expect(out.metadata.error).toBeUndefined()
      expect(out.metadata.toolCalls).toEqual([{ tool: "bad.tool", status: "error", input: { reason: "test" } }])

      // 父执行失败没有成功 ToolResult，onExit 必须绕过进度节流持久化最终事实。
      snapshots.length = 0
      const error = await failure(tool.execute({ code: "await tools.bad.tool({ reason: 'uncaught' })" }, recordingCtx))
      const environmentID = snapshots[0]?.metadata?.environmentID
      expect(environmentID).toMatch(/^env_/)
      expect(error.message).toContain(`Environment: ${environmentID}`)
      expect(error.message).toContain("boom")
      // 最终失败没有可返回的成功结果，最后一条更新必须可持久化，不能只停留在临时进度中。
      expect(snapshots.at(-1)?.delivery).not.toBe("ephemeral")
      expect(snapshots.at(-1)?.metadata).toEqual({
        environmentID,
        output: `Environment: ${environmentID}`,
        error: true,
        toolCalls: [{ tool: "bad.tool", status: "error", input: { reason: "uncaught" } }],
      })
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

    testEffect(harness()).live("synchronous and registered aborts await producer cleanup without late callbacks", () =>
      Effect.gen(function* () {
        const tool = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
        for (const mode of ["registered", "synchronous"] as const) {
          const controller = new AbortController()
          const started = yield* Deferred.make<void>()
          const finalizing = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          // 若断言提前失败，外层清理仍释放门闩，避免测试自己把待验证的 producer 永久挂住。
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
          const snapshots: Array<{ delivery?: "durable" | "ephemeral"; metadata?: Record<string, unknown> }> = []
          // 原生Promise故意晚于取消结算，能在父退出后继续检验是否还会发送进度。
          const pending = Promise.withResolvers<Tool.ExecuteResult>()
          let cleaned = 0
          const running = yield* tool
            .execute(
              {
                code: "try { await tools.host.trigger({}) } catch {} return 'unreachable'",
              },
              {
                ...ctx,
                abort: controller.signal,
                metadata: (value) =>
                  Effect.sync(() => {
                    snapshots.push(value)
                  }),
                codeMode: {
                  catalog: [
                    {
                      id: "trigger",
                      path: ["host", "trigger"],
                      description: "trigger",
                      inputSchema: { type: "object" },
                    },
                  ],
                  signal: controller.signal,
                  begin: () => Effect.void,
                  invoke: () =>
                    Effect.promise(() => {
                      // 在原生启动回调返回Promise之前取消，专门打到根Fiber尚在登记的窗口。
                      if (mode === "synchronous") controller.abort()
                      Deferred.doneUnsafe(started, Effect.void)
                      return pending.promise
                    }).pipe(
                      Effect.ensuring(
                        Deferred.succeed(finalizing, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(
                            Effect.sync(() => {
                              cleaned++
                            }),
                          ),
                        ),
                      ),
                    ),
                },
              },
            )
            .pipe(Effect.exit, Effect.forkScoped)
          if (mode === "registered") {
            yield* awaitWithTimeout(Deferred.await(started), "host call did not start")
            // 与同步通知对照：等待启动栈退出，再从外部取消已登记的 producer。
            yield* Effect.yieldNow
            controller.abort()
          }
          yield* awaitWithTimeout(Deferred.await(finalizing), `${mode} abort lost producer cleanup`)
          // finalizer已开始但被门闩挡住，父调用此时必须仍未结算，不能只等取消通知发出。
          expect(running.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          const exit = yield* awaitWithTimeout(Fiber.join(running), "cancelled execute did not finish")
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
          // 两个取消窗口都必须只完成一次真实清理；父 Fiber 中断本身不能替代这个资源断言。
          expect(cleaned).toBe(1)
          const environmentID = snapshots[0]?.metadata?.environmentID
          expect(environmentID).toMatch(/^env_/)
          expect(snapshots[0]?.delivery).toBe("durable")
          expect(snapshots.at(-1)?.delivery).not.toBe("ephemeral")
          expect(snapshots.at(-1)?.metadata).toMatchObject({
            environmentID,
            error: true,
            toolCalls: [{ tool: "host.trigger", status: "error" }],
          })
          expect(snapshots.at(-1)?.metadata?.output).toContain(`Environment: ${environmentID}`)
          // 原传输迟到结算不能再次发送进度或重复清理，父退出必须已切断回调归属。
          const count = snapshots.length
          pending.resolve({ title: "late", output: "late result", metadata: {} })
          yield* Effect.yieldNow
          expect(snapshots).toHaveLength(count)
          expect(cleaned).toBe(1)
        }
      }),
    )

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

    testEffect(Layer.merge(harness(), LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))).live(
      "oversized results reach Session finalization without early clipping or recovery files",
      () =>
        Effect.gen(function* () {
          const truncate = yield* Truncate.Service
          const fs = yield* FSUtil.Service
          yield* fs.ensureDir(Truncate.DIR)
          // 共享目录可能已有其它测试的恢复文件，只计算本次新增文件，避免历史文件造成假失败。
          const before = new Set(yield* fs.readDirectory(Truncate.DIR))
          let outputCalls = 0
          // 只统计原服务是否被调用；此宿主阶段必须不触发截断或恢复文件写入。
          const tool = yield* CodeModeTool.pipe(
            Effect.flatMap(Tool.init),
            Effect.provideService(Truncate.Service, {
              ...truncate,
              output: (...args) => {
                outputCalls++
                return truncate.output(...args)
              },
            }),
          )
          // 规则、日志与未观察失败同时进入大输出，验证宿主不会只保留脚本返回的数组。
          const context: Tool.Context = {
            ...ctx,
            codeMode: {
              catalog: ["info", "fail"].map((id) => ({
                id,
                path: ["host", id],
                description: id,
                inputSchema: { type: "object" },
              })),
              signal: ctx.abort,
              begin: () => Effect.void,
              invoke: (id) =>
                id === "fail"
                  ? Effect.fail(new Error("unobserved failure"))
                  : Effect.succeed({
                      title: "info",
                      output: "ok",
                      metadata: {},
                      context: [{ kind: "instruction", key: "/fixture/AGENTS.md", text: "important instruction" }],
                    }),
            },
          }
          const result = yield* tool.execute(
            {
              code: `await tools.host.info({}); tools.host.fail({});
        console.log("saved log"); const rows = Array.from({ length: 1500 }).map((_, id) => ({ id, label: "row-" + id }));
        return rows;`,
            },
            context,
          )
          // 终态预算属于 Session：这里必须保留完整中间回执，且不能提前落盘或裁剪。
          expect(outputCalls).toBe(0)
          expect(result.output.length).toBeGreaterThan(36_000)
          expect(result.output).toContain("row-0")
          expect(result.output).toContain("row-1499")
          expect(result.output).toContain("row-750")
          expect(result.metadata).toMatchObject({ truncated: false })
          expect(result.metadata.environmentID).toMatch(/^env_/)
          expect("outputPath" in result.metadata).toBe(false)
          expect((yield* fs.readDirectory(Truncate.DIR)).filter((name) => !before.has(name))).toHaveLength(0)
          expect(result.output).not.toContain('<opencode_notice type="output_truncated" source="tool"')
          // 不提前省略任何数据；Session 测试另验证最终预算、50:50 与唯一完整恢复文件。
          const full = result.output
          expect(full).toContain(`Environment: ${result.metadata.environmentID}`)
          expect(full).toContain(
            "Some asynchronous work failed or was interrupted without the script observing its outcome.",
          )
          // 规则由 host context 通道进入，脚本只返回 rows；中间回执仍须包含规则与日志。
          expect(full).toContain("important instruction")
          expect(full).toContain("Logs:\nsaved log")
          // 逐项比较全部一千五百行，排除中间回执只保留看似完整的头部或末尾。
          expect(JSON.parse(full.split("Script result:\n")[1].split("\n\nLogs:")[0])).toEqual(
            Array.from({ length: 1500 }, (_, id) => ({ id, label: "row-" + id })),
          )
          // 交付完整中间回执后再续用环境，末项仍须保持原来的值。
          const resumed = yield* tool.execute(
            { environmentID: result.metadata.environmentID, code: "return rows[1499]" },
            context,
          )
          expect(JSON.parse(scriptOutput(resumed))).toEqual({ id: 1499, label: "row-1499" })
        }),
    )

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

  testEffect(Layer.empty).effect("execution budget resumes only the remaining time after overlapping waits", () =>
    Effect.gen(function* () {
      const { Tool } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
      const budget = yield* makeExecutionBudget
      const entered = Deferred.makeUnsafe<void>()
      const go = Deferred.makeUnsafe<void>()
      let ended = false
      const execution = yield* CodeMode.execute({
        code: "await tools.work(); return 1",
        tools: {
          work: Tool.make({
            description: "Wait for the execution budget",
            input: Schema.Struct({}),
            run: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(go)),
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    ended = true
                  }),
                ),
              ),
          }),
        },
        limits: { timeoutMs: 100 },
        waitForTimeout: budget.wait,
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(30)
      // 两个等待共用暂停计数，结束第一个不能提前恢复预算。
      const one = Deferred.makeUnsafe<void>()
      const two = Deferred.makeUnsafe<void>()
      const a = yield* budget.pause(Deferred.await(one)).pipe(Effect.forkScoped({ startImmediately: true }))
      const b = yield* budget.pause(Deferred.await(two)).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(1000)
      expect(execution.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(one, undefined)
      yield* Fiber.join(a)
      yield* TestClock.adjust(1000)
      expect(execution.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(b)
      yield* Deferred.succeed(go, undefined)
      // 先前已用30毫秒，恢复后只剩70毫秒，不重新获得完整预算。
      yield* TestClock.adjust(69)
      expect(execution.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(execution)).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
      expect(ended).toBe(true)
    }),
  )

  testEffect(Layer.empty).effect("external cancellation cleans children while the execution budget is paused", () =>
    Effect.gen(function* () {
      const { Tool } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
      const budget = yield* makeExecutionBudget
      const entered = Deferred.makeUnsafe<void>()
      let ended = false
      const execution = yield* CodeMode.execute({
        code: "await tools.question()",
        tools: {
          question: Tool.make({
            description: "Wait for external input",
            input: Schema.Struct({}),
            run: () =>
              budget.pause(
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      ended = true
                    }),
                  ),
                ),
              ),
          }),
        },
        limits: { timeoutMs: 100 },
        waitForTimeout: budget.wait,
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      // 暂停只冻结超时预算，不屏蔽外部中断；越过预算后再取消，必须仍等待真实 child 清理。
      yield* Deferred.await(entered)
      yield* TestClock.adjust(1000)
      expect(execution.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(execution)
      expect(ended).toBe(true)
    }),
  )

  testEffect(Layer.empty).effect(
    "explicit pause closure crosses independent runPromise and leaves other executions timed",
    () =>
      Effect.gen(function* () {
        const { Tool } = yield* Effect.promise(() => import("@opencode-ai/codemode"))
        const budget = yield* makeExecutionBudget
        const entered = Deferred.makeUnsafe<void>()
        const answer = Deferred.makeUnsafe<void>()
        const execution = yield* CodeMode.execute({
          code: "return await tools.question()",
          tools: {
            question: Tool.make({
              description: "Wait for external input through an independent runtime",
              input: Schema.Struct({}),
              run: () =>
                Effect.tryPromise(() =>
                  Effect.runPromise(
                    budget.pause(
                      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer)), Effect.as("ok")),
                    ),
                  ),
                ),
            }),
          },
          limits: { timeoutMs: 100 },
          waitForTimeout: budget.wait,
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(entered)
        // 闭包显式跨独立Effect入口；另一次没有暂停的执行仍应按时结束。
        const other = yield* CodeMode.execute({
          code: "await tools.wait()",
          tools: {
            wait: Tool.make({
              description: "Wait until cancelled",
              input: Schema.Struct({}),
              run: () => Effect.never,
            }),
          },
          limits: { timeoutMs: 100 },
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* TestClock.adjust(1000)
        expect(execution.pollUnsafe()).toBeUndefined()
        expect(yield* Fiber.join(other)).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
        yield* Deferred.succeed(answer, undefined)
        expect(yield* Fiber.join(execution)).toMatchObject({ ok: true, value: "ok" })
      }),
  )
})

describe("execute environment ownership and lifecycle", () => {
  // 失败出口和副作用分开验证；统一断言保留 Effect 上下文，不用抛错重试替代实际调用。
  const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.map(Effect.exit(effect), (exit) => expect(Exit.isFailure(exit)).toBe(true))

  const unit = testEffect(Layer.empty)
  const owner: ExecuteEnvironments.Owner = { sessionID: "ses_notebook", directory: "/project" }

  unit.effect("environment handles resume full state without crossing owners or guessing missing IDs", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      // 同一执行引擎跨调用保留函数和变量；新建与复用只选择状态，不切换运行模式。
      const first = yield* registry.use(owner, undefined, (lease) =>
        CodeMode.execute({
          environment: lease.environment,
          code: "let n = 1; const next = () => ++n; return next()",
        }).pipe(Effect.map((result) => ({ id: lease.id, result }))),
      )
      // 前缀和长度来自宿主 Identifier 合同，复用成功还须交付可供模型下一轮传回的有效句柄。
      expect(first.id).toMatch(/^env_[0-9a-zA-Z]{26}$/)
      expect(first.result).toMatchObject({ ok: true, value: 2 })
      expect(
        yield* registry.use(owner, first.id, (lease) =>
          CodeMode.execute({ environment: lease.environment, code: "return next()" }),
        ),
      ).toMatchObject({ ok: true, value: 3 })
      // 显式错误句柄和其它会话/位置均不得获得替代环境，更不能执行传入回调。
      let effects = 0
      for (const [other, id] of [
        [owner, ""],
        [owner, "env_missing"],
        [{ ...owner, sessionID: "ses_other" }, first.id],
        [{ ...owner, directory: "/else" }, first.id],
        [{ ...owner, workspaceID: "wrk_other" }, first.id],
      ] as const) {
        yield* expectFailure(registry.use(other, id, () => Effect.sync(() => effects++)))
      }
      // 报错还不够：无效句柄的 callback 从未运行，才证明没有失败后备用执行。
      expect(effects).toBe(0)
      // 省略 ID 与显式错误 ID 分开检查，既允许新建，也不把复用失败偷偷降级为新建。
      const fresh = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      expect(fresh).not.toBe(first.id)
      yield* registry.close()
    }),
  )

  unit.effect("same environment waits through cleanup while other environments stay concurrent", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const id = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const order: string[] = []
      // 先观察 holder 已进入，再观察清理阻塞；测试不以 sleep 猜测锁或取消是否生效。
      yield* Effect.gen(function* () {
        const first = yield* registry
          .use(owner, id, () =>
            Effect.gen(function* () {
              order.push("first")
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }).pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(finish))))),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(entered)
        const second = yield* registry
          .use(owner, id, () =>
            Effect.sync(() => {
              order.push("second")
            }),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }))
        // 同时执行另一环境可排除全局串行锁，前一个环境的排他性必须只绑定自身ID。
        expect(yield* registry.use(owner, undefined, () => Effect.succeed("independent"))).toBe("independent")
        expect(order).toEqual(["first"])
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(cleanup)
        // 用户主值已结束但 finalizer 仍被阻塞，这段窗口也必须排他。
        expect(order).toEqual(["first"])
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(first)
        // 两个 Fiber 都结束后再看顺序，排除第二个调用只是暂时没被调度、从未成功取得租约。
        yield* Fiber.join(second)
        expect(order).toEqual(["first", "second"])
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(release, undefined), Deferred.succeed(finish, undefined)], { discard: true }),
        ),
      )
      yield* registry.close()
    }),
  )

  unit.effect("self-published retirement cannot return success or deadlock the publishing cell", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const id = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      // 自退休应中断当前租约；通知不能等待当前单元结束，也不能让这次调用返回成功。
      const result = yield* registry
        .use(owner, id, () => registry.retireSession(owner.sessionID).pipe(Effect.as("wrong success")))
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      // 自退休调用失败后，同一 ID 还须继续拒绝，不能只中断当前执行却保留可复活的条目。
      yield* expectFailure(registry.use(owner, id, () => Effect.succeed("wrong replacement")))
      yield* registry.close()
    }),
  )

  unit.effect("owner capacity keeps the latest eight unique calls", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const create = () => registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      const ids: string[] = []
      // 每个 owner 独立保留八个唯一环境，重复复用只刷新调用顺序。
      for (let i = 0; i < 8; i++) ids.push(yield* create())
      for (let i = 0; i < 20; i++)
        expect(yield* registry.use(owner, ids[0], () => Effect.succeed("touched"))).toBe("touched")
      const newest = yield* create()
      // 调用第一个后刷新顺序；新增只淘汰未被触碰的第二个。
      yield* expectFailure(registry.use(owner, ids[1], () => Effect.succeed("wrong")))
      expect(yield* registry.use(owner, ids[0], () => Effect.succeed("retained"))).toBe("retained")
      // 淘汰旧项后新项必须可用；只断言旧 ID 失败会放过“容量满后全部拒绝”的实现。
      expect(yield* registry.use(owner, newest, () => Effect.succeed("newest"))).toBe("newest")
      yield* registry.close()
    }),
  )

  unit.effect("active environments finish independently and retain the latest eight unique calls", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const release = yield* Deferred.make<void>()
      const ids: string[] = []
      const holders = []
      // 所有租约共同等待释放，直接观察超过八个环境同时执行；结束顺序不刷新调用顺序。
      for (let i = 0; i < 16; i++)
        holders.push(
          yield* registry
            .use(owner, undefined, (lease) =>
              Effect.sync(() => ids.push(lease.id)).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkScoped({ startImmediately: true })),
        )
      expect(ids).toHaveLength(16)
      let reused = false
      // 排队复用最早的环境也刷新 unique 调用顺序，且必须保留其等待者。
      const queued = yield* registry
        .use(owner, ids[0], () =>
          Effect.sync(() => {
            reused = true
          }),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      // 等待全部 finalizer 完成后再查窗口，避免把尚未回收的临时状态误当作保留。
      for (const holder of holders) yield* Fiber.join(holder)
      yield* Fiber.join(queued)
      expect(reused).toBe(true)
      // 第一个 ID 的复用将它移到末尾，因此最终窗口是 9～15 加 0，而非最后结束的八项。
      for (const id of ids.slice(1, 9)) yield* expectFailure(registry.use(owner, id, () => Effect.void))
      for (const id of [...ids.slice(9), ids[0]]) yield* registry.use(owner, id, () => Effect.void)
      yield* registry.close()
    }),
  )

  const integration = testEffect(
    // 第二个目录与原目录共用真实 owner，但临时目录构造器的依赖也属于本测试层。
    LayerNode.compile(
      LayerNode.group([
        ExecuteEnvironments.node,
        Session.node,
        SessionProjector.node,
        EventV2.node,
        CrossSpawnSpawner.node,
      ]),
    ),
  )

  integration.instance("real deletion without Location cancels leases and rejects late fresh admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const environments = yield* ExecuteEnvironments.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create()
      const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
      const entered = yield* Deferred.make<void>()
      let cleaned = false
      let queuedEffect = false
      // 使用真实 projector 删除持久 Session；无 Location 外壳也必须回收其活动和排队租约。
      const holder = yield* environments
        .use(session.id, id, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                cleaned = true
              }),
            ),
          ),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      const queued = yield* environments
        .use(session.id, id, () =>
          Effect.sync(() => {
            queuedEffect = true
          }),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      // 去掉发布者的 InstanceRef，强制删除通知不依赖位置外壳，而从事件中的会话身份回收。
      const deletion = yield* events
        .publish(SessionV1.Event.Deleted, { sessionID: session.id, info: session })
        .pipe(Effect.provideService(InstanceRef, undefined))
      expect(deletion.location).toBeUndefined()
      expect(Exit.isFailure(yield* Fiber.await(holder))).toBe(true)
      // 排队者也必须结束为失败，不能等 holder 清理后拿到旧许可再执行。
      expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
      expect(cleaned).toBe(true)
      // 删除通知不能只让 holder 报错，排队 callback 也必须没有产生效果。
      expect(queuedEffect).toBe(false)
      // 事件已过去后才省略 ID 新建，也必须由权威 placement 读取阻止，不能依赖已错过的通知。
      yield* expectFailure(
        environments.use(session.id, undefined, () =>
          Effect.sync(() => {
            queuedEffect = true
          }),
        ),
      )
      expect(queuedEffect).toBe(false)
    }),
  )

  integration.instance("real move retires source state and preserves destination state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const environments = yield* ExecuteEnvironments.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create()
      const source = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
      const destination = yield* tmpdirScoped()
      const moved = {
        sessionID: session.id,
        location: Location.Ref.make({ directory: AbsolutePath.make(destination) }),
        timestamp: yield* DateTime.now,
      }
      // 真实 Moved projector 先改权威位置；旧宿主之后不能再创建一个仍绑在源目录的环境。
      yield* events.publish(SessionEvent.Moved, moved)
      yield* expectFailure(environments.use(session.id, source, () => Effect.succeed("wrong")))
      yield* expectFailure(environments.use(session.id, undefined, () => Effect.succeed("wrong")))
      // 进入目的目录的真实 InstanceState 后才新建，源目录拒绝不能被“全局禁用此 Session”冒充。
      const target = yield* environments
        .use(session.id, undefined, (lease) => Effect.succeed(lease.id))
        .pipe(provideInstanceEffect(destination))
      // 重复位置通知不能把目的地已存在的合法环境一并删掉，事件 owner 以目的位置比较。
      yield* events.publish(SessionEvent.Moved, moved)
      // 目标目录使用同一个 Service，但按新的 InstanceState 键承载状态，不共享源环境。
      expect(
        yield* environments
          .use(session.id, target, () => Effect.succeed("retained"))
          .pipe(provideInstanceEffect(destination)),
      ).toBe("retained")
    }),
  )

  integration.instance("legacy workspace updates retire state but title updates preserve it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const environments = yield* ExecuteEnvironments.Service
      const session = yield* sessions.create()
      const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
      // 元数据更新不是退出；只改变 workspace 的真实 Updated 事件才使当前 owner 失效。
      yield* sessions.setTitle({ sessionID: session.id, title: "Renamed" })
      expect(yield* environments.use(session.id, id, () => Effect.succeed("retained"))).toBe("retained")
      // 目录路径不变，只变 workspace 身份，使旧环境失效原因只能来自 owner 的 workspace 比较。
      yield* sessions.setWorkspace({ sessionID: session.id, workspaceID: WorkspaceV2.ID.make("wrk_other") })
      yield* expectFailure(environments.use(session.id, id, () => Effect.succeed("wrong")))
    }),
  )

  unit.effect("owner quotas and live ID collisions never replace another live identity", () =>
    Effect.gen(function* () {
      // 两次连续分配同名ID后再给新ID，只测真实碰撞重试，不依赖随机生成器碰巧重复。
      const issued = ["env_first", "env_first", "env_second"]
      const colliding = ExecuteEnvironments.makeRegistry({ nextID: () => issued.shift() ?? "env_unexpected" })
      const one = yield* colliding.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      const two = yield* colliding.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      // 同时存在的冲突只重新分配新 ID，不把第二个新建单元绑定到第一个环境。
      expect([one, two]).toEqual(["env_first", "env_second"])
      // 重新分配第二个 ID 后再访问第一个，确认碰撞重试没有替换仍存活的原条目。
      expect(yield* colliding.use(owner, one, () => Effect.succeed("original"))).toBe("original")
      yield* colliding.close()
      const registry = ExecuteEnvironments.makeRegistry()
      const other = { ...owner, sessionID: "ses_other" }
      const retained = yield* registry.use(other, undefined, (lease) => Effect.succeed(lease.id))
      const ids: string[] = []
      for (let i = 0; i < 9; i++) ids.push(yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id)))
      // 一个 owner 已发生窗口外回收，另一个 owner 的状态仍独立保留。
      yield* expectFailure(registry.use(owner, ids[0], () => Effect.void))
      expect(yield* registry.use(other, retained, () => Effect.succeed("retained"))).toBe("retained")
      yield* registry.close()
    }),
  )

  integration.instance("actual instance disposal waits for cleanup before replacing the registry", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const environments = yield* ExecuteEnvironments.Service
      const instance = yield* TestInstance
      const session = yield* sessions.create()
      const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
      const entered = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let disposed = false
      yield* Effect.gen(function* () {
        const holder = yield* environments
          .use(session.id, id, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(finish)))),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(entered)
        const disposer = yield* Effect.promise(() => disposeInstance(instance.directory)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              disposed = true
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        // 先等 holder 的清理器真正开始，再检查 dispose 尚未完成，把等待范围定位到 finalizer。
        yield* Deferred.await(cleanup)
        // 全局 disposer 会收集错误；观察清理 barrier，不能仅因 dispose 返回就假定原工作已结束。
        expect(disposed).toBe(false)
        yield* Deferred.succeed(finish, undefined)
        // 清理完成只说明资源释放，holder失败还要证明实例关闭没有被转换成业务成功。
        expect(Exit.isFailure(yield* Fiber.await(holder))).toBe(true)
        yield* Fiber.join(disposer)
        expect(disposed).toBe(true)
        // 同一个 Service 下一次经 InstanceState 获得新 owner，旧句柄不得复活。
        yield* expectFailure(environments.use(session.id, id, () => Effect.succeed("wrong")))
        expect(yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))).not.toBe(id)
      }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)))
    }),
  )

  integration.instance("forked Sessions cannot resume the parent's environment", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const environments = yield* ExecuteEnvironments.Service
      const parent = yield* sessions.create()
      const id = yield* environments.use(parent.id, undefined, (lease) => Effect.succeed(lease.id))
      const child = yield* sessions.fork({ sessionID: parent.id })
      // fork 复制会话历史而不复制进程内词法图；父句柄不能成为子会话的隐含能力。
      expect(Exit.isFailure(yield* environments.use(child.id, id, () => Effect.succeed("wrong")).pipe(Effect.exit))).toBe(
        true,
      )
      // 子 Session 的拒绝不能连带退休父环境，原 owner 仍须继续使用同一 ID。
      expect(yield* environments.use(parent.id, id, () => Effect.succeed("parent retained"))).toBe("parent retained")
    }),
  )

  unit.effect("queued leases stay protected and cancellation does not refresh call order", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const create = () => registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      const ids: string[] = []
      for (let i = 0; i < 8; i++) ids.push(yield* create())
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const waiterEntered = yield* Deferred.make<void>()
      const holder = yield* registry
        .use(owner, ids[0], () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      const waiter = yield* registry
        .use(owner, ids[0], () => Deferred.succeed(waiterEntered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkScoped({ startImmediately: true }))
      // 两次复用已经把该环境刷新为最近调用；新增淘汰更早调用的第二项。
      yield* create()
      yield* expectFailure(registry.use(owner, ids[1], () => Effect.succeed("wrong")))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      // 确认排队者已经成为实际使用者，再取消它；否则只能验证取消等待队列，不能覆盖最后租约退出。
      yield* Deferred.await(waiterEntered)
      // 后续调用另一环境，再取消最后租约；完成和取消都不能刷新最近调用顺序。
      yield* registry.use(owner, ids[3], () => Effect.void)
      yield* Fiber.interrupt(waiter)
      for (let i = 0; i < 6; i++) yield* create()
      yield* expectFailure(registry.use(owner, ids[0], () => Effect.succeed("wrong")))
      expect(yield* registry.use(owner, ids[3], () => Effect.succeed("retained"))).toBe("retained")
      yield* registry.close()
    }),
  )
})

describe("lease fiber ownership regressions", () => {
  const unit = testEffect(Layer.empty)
  const owner: ExecuteEnvironments.Owner = { sessionID: "ses_notebook", directory: "/project" }

  unit.effect("closing waits for lease cleanup but not the caller's later work", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const entered = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let finished = false
      // 租约结束后调用者仍可做其它工作；注册表不能把这个更长的 Fiber 当成租约寿命。
      const caller = yield* registry
        .use(owner, undefined, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(
          // 先把预期中断转成 Exit 供测试观察，不能让它提前取消调用者尾部。
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))),
          Effect.andThen(Deferred.succeed(ended, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered)
        // close 必须先独立完成，再允许调用者结束；反过来等待会形成真实死锁。
        yield* registry.close()
        yield* Deferred.await(ended)
        expect(finished).toBe(false)
        yield* Deferred.succeed(release, undefined)
        // 释放后还需观察调用者真正结束，避免把尚未调度误判成正确隔离。
        yield* Fiber.join(caller)
        expect(finished).toBe(true)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }),
  )

  unit.effect("self-retirement survives an uninterruptible callback boundary", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const id = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
      // 回调可以暂缓中断，但不能清除退休事实或把已关闭环境报告为成功。
      const result = yield* registry
        .use(owner, id, () =>
          registry.retireSession(owner.sessionID).pipe(Effect.as("wrong success"), Effect.uninterruptible),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      // 不只是当前调用失败；同一身份在清理结束后也不得复活。
      const retry = yield* registry.use(owner, id, () => Effect.succeed("wrong replacement")).pipe(Effect.exit)
      expect(Exit.isFailure(retry)).toBe(true)
      yield* registry.close()
    }),
  )

  unit.effect("lease ownership keeps the caller's existing Scope service", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const scope = yield* Scope.Scope
      // 租约的取消所有权不是 callback 的依赖注入权，调用者原 Scope 必须保持。
      expect(yield* registry.use(owner, undefined, () => Scope.Scope)).toBe(scope)
      yield* registry.close()
    }),
  )

  unit.effect("retirement waits for the lease fiber's child finalizers", () =>
    Effect.gen(function* () {
      const registry = ExecuteEnvironments.makeRegistry()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let closed = false
      // 子 Fiber 的隐式关闭发生在 callback 返回之后，必须与普通 ensuring 分开验证。
      const lease = yield* registry
        .use({ sessionID: "ses_children", directory: "/project" }, undefined, () =>
          Effect.forkChild(
            Effect.never.pipe(
              Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release)))),
            ),
            { startImmediately: true },
          ).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      // 断言失败也须解除屏障，否则不可中断的子任务 finalizer 会卡住测试退出。
      yield* Effect.gen(function* () {
        // 等真实 finalizer 阻塞后再关闭，避免仅凭调度延迟得到假通过。
        yield* Deferred.await(cleaning)
        const closing = yield* registry.close().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        // 释放前不能完成关闭；释放后还须观察租约和关闭操作的真实终态。
        expect(closed).toBe(false)
        yield* Deferred.succeed(release, undefined)
        // 租约预期被中断，只观察 Exit；关闭本身仍须成功，因此 await 与 join 不能互换。
        yield* Fiber.await(lease)
        yield* Fiber.join(closing)
        expect(closed).toBe(true)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }),
  )
})

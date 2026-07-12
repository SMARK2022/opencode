import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { eq, sql } from "drizzle-orm"
import yargs from "yargs/yargs"
// #236：aggregateStats 聚合 session+part 数据计算工具归因统计
import { aggregateStats } from "@/cli/cmd/stats-data"
// #236：renderBreakdown 渲染统计报告——验证 Tool context tokens 文案
import { renderBreakdown } from "@/cli/cmd/stats-render"
// #483：CLI 契约测试需要公开命令对象
import { StatsBreakdownCommand, StatsCommand, StatsInsightsCommand, StatsSessionsCommand, StatsTimelineCommand } from "@/cli/cmd/stats"
// #236：Session.Service 提供 create/updateMessage/updatePart 接口
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
// #483：outcome/attribution 测试需要直接写 usage schema
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
// #483：project identity 测试需要写真实 ProjectTable
import { ProjectTable } from "@opencode-ai/core/project/sql"
// #236：resetDatabase 清理全局 DB 文件——确保每个用例从干净状态开始
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
// #236：source 路径 stats/data.ts 在目标扁平化为 stats-data.ts——import 适配
import { httpApiLayer } from "../server/httpapi-layer"

// #236：目标无 Session.defaultLayer——用 LayerNode + httpApiLayer 组合
// #236：httpApiLayer 提供 InstanceRef/Config 等 Session 依赖
const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
})

const seedToolBreakdownReport = (input: { legacyEmptyMessages?: boolean; errorCall?: boolean; filter?: Parameters<typeof aggregateStats>[0] } = {}) =>
  // #483：通过真实 Session 服务写入数据，避免测试复制 aggregateStats 的归因算法
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      // #236：目标 schema 用 ProviderV2/ModelV2 brand——测试用裸字符串 + as never 绕过类型检查
      model: { providerID: "test", modelID: "test" } as never,
      time: { created: Date.now() },
    })
    const assistant = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: "test" as never,
      providerID: "test" as never,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
    })
    const now = Date.now()
    // #236：step-finish part 的 ID 提前生成——legacy 改写需要引用它
    const stepPartID = PartID.ascending()
    // #236：step-finish 数据含完整 inputBreakdown——tools=10 用于工具上下文归因计算
    const stepData = {
      type: "step-finish" as const,
      reason: "stop",
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      inputChars: 100,
      inputBreakdown: {
        system: 10,
        instructions: 10,
        skills: 0,
        tools: 10,
        messages: {
          userText: 10,
          assistantText: 10,
          reasoning: 0,
          toolInput: 30,
          toolOutput: 20,
          attachments: 0,
          total: 70,
        },
      },
    }

    // #236：tool part 播种——bash 工具调用 completed 状态，output 2 字符
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: info.id,
      messageID: assistant.id,
      type: "tool",
      callID: "call_bash",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "ok",
        title: "pwd",
        metadata: {},
        time: { start: now, end: now + 250 },
      },
    })
    // #483：可选错误调用与成功调用共用 owner，用于验证复合 tuple 合并后仍累加错误和耗时
    if (input.errorCall) {
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: assistant.id,
        type: "tool",
        callID: "call_bash_error",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "false" },
          error: "failed",
          time: { start: now, end: now + 400 },
        },
      })
    }
    // #236：step-finish part 播种——inputBreakdown 的 tools=10 + messages.toolInput=30 + toolOutput=20
    yield* session.updatePart({ id: stepPartID, sessionID: info.id, messageID: assistant.id, ...stepData })

    if (input.legacyEmptyMessages) {
      // #236：legacy 场景模拟——1.15.3 历史行的 messages 为空 {}，不含 per-category 计数
      // #236：直接 Drizzle update 模拟历史行——比原生 SQL 更安全且与目标 schema 一致
      const { db } = yield* Database.Service
      yield* db
        .update(PartTable)
        // #236：messages 改为 {} 后其余 inputBreakdown 字段保留——测试目标对 legacy 行的兼容性
        .set({
          data: { ...stepData, inputBreakdown: { ...stepData.inputBreakdown, messages: {} } } as never,
        })
        .where(eq(PartTable.id, stepPartID))
        .run()
        // #236：orDie 保证 DB 写入失败时测试硬失败而非吞错
        .pipe(Effect.orDie)
    }

    // #236：aggregateStats 从 session+part 数据计算工具归因统计
    return yield* aggregateStats(input.filter)
  })

// #483：旧 assistant message 不含 step-finish part，用于覆盖聚合器的兼容读取路径
const seedLegacyUsageAt = (created: number) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" } as never,
      time: { created },
    })
    yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: "test" as never,
      providerID: "test" as never,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 1,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created },
    })
    return yield* aggregateStats({ days: 60 })
  })

// #483：直接写入现有 usage schema，测试跨 Assistant owner 的真实聚合边界而不是复制生产算法
const seedMultiAssistantRequest = (created = Date.now()) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const requestID = MessageID.ascending()
    const firstAssistantID = MessageID.ascending()
    const secondAssistantID = MessageID.ascending()
    const now = created
    const { db } = yield* Database.Service
    // Request row 是健康指标的唯一 owner；最终 outcome 故意与 Assistant status 不同
    yield* db
      .insert(RequestUsageTable)
      .values({
        session_id: info.id,
        request_id: requestID,
        root_request_id: requestID,
        source: "prompt",
        status: "error",
        agent: "build",
        provider_id: "owner-provider",
        model_id: "owner-model",
        assistant_count: 2,
        time_created: now,
        time_updated: now + 2_000,
        time_completed: now + 2_000,
      })
      .run()
    yield* db
      .insert(RequestUsageAssistantTable)
      .values([
        {
          session_id: info.id,
          request_id: requestID,
          assistant_message_id: firstAssistantID,
          root_request_id: requestID,
          status: "completed",
          provider_id: "owner-provider",
          model_id: "owner-model",
          tokens_input: 100,
          tokens_total: 100,
          cost_micros: 1_000_000,
          time_created: now + 500,
          time_updated: now + 600,
          time_completed: now + 600,
        },
        {
          session_id: info.id,
          request_id: requestID,
          assistant_message_id: secondAssistantID,
          root_request_id: requestID,
          status: "completed",
          provider_id: "secondary-provider",
          model_id: "secondary-model",
          tokens_input: 200,
          tokens_total: 200,
          cost_micros: 2_000_000,
          time_created: now + 1_000,
          time_updated: now + 1_100,
          time_completed: now + 1_100,
        },
      ])
      .run()
    return yield* aggregateStats({ statusFilter: "error" })
  })

// #483：元数据写入真实 ProjectTable，证明 identity 是聚合查询结果而非 renderer 猜测 basename
const seedNamedProject = () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const created = Date.now()
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" } as never,
      time: { created },
    })
    yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: "test" as never,
      providerID: "test" as never,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 1,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created },
    })
    const { db } = yield* Database.Service
    // 控制字符会破坏 panel；shell 元字符只是项目名称的一部分，不能被解释或删除
    yield* db
      .update(ProjectTable)
      // #483：worktree 列带 AbsolutePath brand——测试用裸字符串 as never 直写存储边界
      .set({ name: "Stats\nProject\u001bX | $HOME > report", worktree: "/tmp/project with space/$(noop)|source" as never })
      .where(eq(ProjectTable.id, info.projectID))
      .run()
    return { report: yield* aggregateStats(), projectID: info.projectID }
  })

describe("stats data", () => {
  // #483：直接执行公开命令解析器，验证真实默认值而不是读取 option 定义或源码字符串；
  // 纯 yargs 解析不依赖 DB/Effect 环境，用普通 async test
  test("defaults CLI stats to 60 days while preserving explicit all-time", async () => {
    if (typeof StatsCommand.builder !== "function" || typeof StatsTimelineCommand.builder !== "function") {
      throw new Error("stats command builders are unavailable")
    }
    const defaults = await (await StatsCommand.builder(yargs([]).exitProcess(false))).parse()
    const allTime = await (await StatsCommand.builder(yargs(["--all-time"]).exitProcess(false))).parse()
    const timeline = await (await StatsTimelineCommand.builder(yargs([]).exitProcess(false))).parse()

    expect(defaults.days).toBe(60)
    // 默认值必须落在 yargs 解析结果上：聚合层与交互循环都依赖同一常量
    expect(defaults.allTime).toBe(false)
    expect(allTime.allTime).toBe(true)
    expect(timeline.heatmap).toBe(false)
  })

  // #483：无值 shortcut 表示进入对应 Breakdown 并使用默认/响应式数量；带值时才覆盖显示上限
  test("accepts root breakdown shortcuts with optional limits", async () => {
    const builder = StatsCommand.builder
    if (typeof builder !== "function") throw new Error("stats command builder is unavailable")
    const parse = async (args: string[]) => (await builder(yargs(args).exitProcess(false).showHelpOnFail(false))).parse()
    const tools = await parse(["--tools"])
    const topTools = await parse(["--tools", "4"])
    const models = await parse(["--models"])

    expect(tools.tools).toBe(true)
    // 无值与带值两种形态都可用：boolean true 表示全部，数字才是 top N
    expect(topTools.tools).toBe(4)
    expect(models.models).toBe(true)
    // 非数字值和负数必须在 CLI 边界失败，不能静默退回 Dashboard
    const invalid = await builder(yargs(["--tools", "invalid"]).exitProcess(false).showHelpOnFail(false))
    const negative = await builder(yargs(["--tools", "-1"]).exitProcess(false).showHelpOnFail(false))
    expect(() => invalid.parse()).toThrow()
    expect(() => negative.parse()).toThrow()
  })

  test("rejects options that a stats endpoint does not consume", async () => {
    if (typeof StatsCommand.builder !== "function" || typeof StatsBreakdownCommand.builder !== "function" || typeof StatsTimelineCommand.builder !== "function" || typeof StatsSessionsCommand.builder !== "function" || typeof StatsInsightsCommand.builder !== "function") throw new Error("stats detail command builders are unavailable")
    const rootBuilder = StatsCommand.builder
    const parser = (args: string[]) => yargs(args).exitProcess(false).showHelpOnFail(false).strictOptions().fail((message, error) => { throw error ?? new Error(message) })
    const timeline = await StatsTimelineCommand.builder(parser(["--sort", "cost"]))
    const sessions = await StatsSessionsCommand.builder(parser(["--metric", "cost"]))
    const insights = await StatsInsightsCommand.builder(parser(["--limit", "5"]))
    const breakdown = await StatsBreakdownCommand.builder(parser(["--sort", "updated"]))
    const toolCost = await StatsBreakdownCommand.builder(parser(["--by", "tool", "--metric", "cost"]))
    expect(() => timeline.parse()).toThrow()
    expect(() => sessions.parse()).toThrow()
    expect(() => insights.parse()).toThrow()
    expect(() => breakdown.parse()).toThrow()
    expect(() => toolCost.parse()).toThrow()
    let called = false
    let failure: unknown
    // 保留真实builder，只替换执行入口；错误参数被放行时也不会触发AppRuntime。
    const publicParser = yargs(["stats", "--limit", "5", "insights"]).exitProcess(false).showHelpOnFail(false).fail((message, error) => { throw error ?? new Error(message) }).command({
      ...StatsCommand,
      builder: async (root) => (await rootBuilder(root)).command({ ...StatsInsightsCommand, handler: () => { called = true } }),
      handler: () => {},
    }).demandCommand().strict()
    try { await publicParser.parse() } catch (error) { failure = error }
    expect(String(failure)).toContain("limit")
    expect(called).toBe(false)
  })

  // #483：事件落在滚动 60×24 小时范围内、但早于第一个完整自然日，必须被排除
  it.instance("uses complete natural days for positive windows", () =>
    Effect.gen(function* () {
      const latest = new Date()
      latest.setHours(0, 0, 0, 0)
      const earliest = new Date(latest)
      earliest.setDate(earliest.getDate() - 59)
      const rollingCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000
      const report = yield* seedLegacyUsageAt(Math.floor((rollingCutoff + earliest.getTime()) / 2))

      expect(report.requestedDays).toBe(60)
      expect(report.daily).toHaveLength(60)
      // 日轴长度与 dateRange 必须同步：cutoff 语义变化只允许同时改变两者
      expect(report.dateRange.earliest).toBe(earliest.getTime())
      expect(report.total.tokens.total).toBe(0)
      // 总计与逐日合计闭合：任何一行日聚合丢失都会破坏这个等式
      expect(report.daily.reduce((sum, day) => sum + day.tokens.total, 0)).toBe(report.total.tokens.total)
    }),
  )

  // #483：两个 completed Assistant 都属于最终 error request；按 Assistant status 过滤会让 300 token 全部消失
  it.instance("attributes request health once while filtering Assistant usage by final outcome", () =>
    Effect.gen(function* () {
      const report = yield* seedMultiAssistantRequest()
      const owner = report.models.find((item) => item.id === "owner-model")
      const secondary = report.models.find((item) => item.id === "secondary-model")
      const error = report.statuses.find((item) => item.id === "error")

      expect(report.total.tokens.total).toBe(300)
      expect(report.total.cost).toBe(3)
      expect(report.total.requests).toBe(1)
      expect(report.total.errors).toBe(1)
      // outcome 过滤把最终 error 同时投影到 Status 维；
      // 若按 Assistant status 分组，这个 error 桶会完全消失
      // Request owner 只得到一次健康指标；secondary model 仍保留自身 usage，但不能伪造 owned request
      expect(owner).toMatchObject({ requests: 1, errors: 1, durationMs: 2_000 })
      expect(secondary).toMatchObject({ requests: 0, errors: 0, tokens: { total: 200 } })
      expect(error).toMatchObject({ requests: 1, errors: 1, tokens: { total: 300 }, assistantCalls: 2 })
    }),
  )

  // #483：固定本地 17:30，可直接验证 RequestUsage.time_created 而不依赖测试运行时钟
  it.instance("buckets requests by their recorded start hour", () =>
    Effect.gen(function* () {
      const report = yield* seedMultiAssistantRequest(new Date(2026, 5, 1, 17, 30).getTime())

      expect(report.requestsByHour).toHaveLength(24)
      expect(report.requestsByHour[17]).toBe(1)
      // 小时投影必须与已过滤 request shell 总数闭合：Assistant 次数不进分母，
      // 双计抑制行也不重复计数，否则 Dashboard 时段分布会虚高
      expect(report.requestsByHour.reduce((sum, value) => sum + value, 0)).toBe(report.total.requests)
    }),
  )

  // #483：ID 仍是 filter/series 关联键，label/path 只承担显示身份
  it.instance("renders stable project identity without interpreting terminal or shell characters", () =>
    Effect.gen(function* () {
      const result = yield* seedNamedProject()
      const project = result.report.projects[0]

      expect(project).toMatchObject({
        id: result.projectID,
        label: "Stats Project X | $HOME > report",
        path: "/tmp/project with space/$(noop)|source",
      })
      const output = renderBreakdown(result.report, { color: "never", by: "project" })
      // shell 元字符必须原样可见；测试只验证字符串显示，绝不执行或转义成命令
      expect(output).toContain("Stats Project X | $HOME > report")
      expect(output).toContain("/tmp/project with space/$(noop)|source")
      expect(output).not.toContain("\u001b")
    }),
  )

  // #483：跨操作系统数据库复制的路径显示不能依赖当前平台分隔符
  it.instance("uses the final path segment for projects recorded on another operating system", () =>
    Effect.gen(function* () {
      const result = yield* seedNamedProject()
      const { db } = yield* Database.Service
      yield* db
        .update(ProjectTable)
        .set({ name: null, worktree: sql`${"H:\\Hyper\\FRCheck"}` })
        .where(eq(ProjectTable.id, result.projectID))
        .run()
      const report = yield* aggregateStats()
      const project = report.projects.find((item) => item.id === result.projectID)

      expect(project).toMatchObject({ label: "FRCheck", path: "H:\\Hyper\\FRCheck" })
      // 跨平台回退只在显示层生效：path 仍保留完整 worktree 用于消歧，
      // 短身份必须始终是用户认识的那一段
      expect(renderBreakdown(report, { color: "never", by: "project" })).toContain("FRCheck")
    }),
  )
  // #236：验证完整 breakdown 时 contextTokens=50（toolInput 30 + toolOutput 20）
  it.instance("attributes tool context tokens from complete input breakdowns", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport()

      expect(report.totalTools).toBe(1)
      expect(report.toolUsage).toEqual([
        {
          id: "bash",
          count: 1,
          inputChars: expect.any(Number),
          outputChars: 2,
          contextTokens: 50,
        },
      ])
      expect(renderBreakdown(report, { color: "never", by: "tool" })).toContain("Tool context tokens")
    }),
  )

  // #483：calls/chars/error/duration 来自 ToolPart；estimated context 是另一条后续消费链，不能互相冒充
  it.instance("attributes ToolPart footprint to its issuing runtime and applies owner filters", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport({ errorCall: true })

      // 复合 tuple 合并：成功 output 2 字符 + error 6 字符 = 8；耗时 250+400=650ms
      expect(report.totalTools).toBe(2)
      expect(report.toolCalls).toHaveLength(1)
      expect(report.toolCalls[0]).toMatchObject({
        toolID: "bash",
        modelID: "test",
        providerID: "test",
        agent: "build",
        source: "legacy-message",
        status: "completed",
        calls: 2,
        outputChars: 8,
        errors: 1,
        durationMs: 650,
      })
      const output = renderBreakdown(report, { color: "never", by: "tool" })
      // 页面断言锁定 attribution 已到达用户边界，而不是只存在于内部 report 字段；
      // 页面列必须携带 errors 与 per-call 维度，仅 calls 计数无法回答“工具失败了多少”
      expect(output).toContain("errors=")
      expect(output).toContain("avg/call=")

      // legacy ToolPart 属于 completed Assistant；error filter 不能只过滤 context 而保留未归属的 calls
      const filtered = yield* aggregateStats({ statusFilter: "error" })
      // 三个公开总量必须同时清空：独立清零任何一个都会让页面出现“部分可用”的假象，
      // 这正是 source 要消灭的 owner 泄漏形态
      expect(filtered.totalTools).toBe(0)
      expect(filtered.toolCalls).toEqual([])
      expect(filtered.toolUsage).toEqual([])
    }),
  )

  // #236：验证 legacy 空 messages 时 contextTokens=0 且 toolSeries 为空——不产生 NaN
  it.instance("keeps tool breakdown finite for legacy empty message breakdowns", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport({ legacyEmptyMessages: true })

      expect(report.toolUsage).toEqual([
        {
          id: "bash",
          count: 1,
          inputChars: expect.any(Number),
          outputChars: 2,
          contextTokens: 0,
        },
      ])
      expect(report.toolUsage.every((tool) => Number.isFinite(tool.contextTokens))).toBe(true)
      // #236：contextTokens=0 的事件被 filter 掉——toolSeries 为空数组
      expect(report.toolSeries).toEqual([])
      const output = renderBreakdown(report, { color: "never", by: "tool" })
      // #483：页头与表格必须使用同一可用性语义，不能把“未保存 breakdown”误报成精确零；
      // footprint 标题证明调用计数的展示路径独立于 context 估算可用性
      expect(output).toContain("Context estimate unavailable")
      expect(output).toContain("Tool footprint")
      // #236：渲染 legacy 报告不抛错——NaN 安全性验证
      expect(() => renderBreakdown(report, { color: "never", by: "tool" })).not.toThrow()
    }),
  )
})

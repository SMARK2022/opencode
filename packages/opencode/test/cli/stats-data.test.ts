import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import yargs from "yargs/yargs"
import { aggregateStats, type StatsFilter } from "@/cli/cmd/stats/data"
import { renderBreakdown } from "@/cli/cmd/stats/render"
import { StatsBreakdownCommand, StatsCommand, StatsInsightsCommand, StatsSessionsCommand, StatsTimelineCommand } from "@/cli/cmd/stats"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database, eq } from "@/storage/db"
import { RequestUsageAssistantTable, RequestUsageTable } from "@/session/request-usage.sql"
import { ProjectTable } from "@/project/project.sql"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
})

const seedToolBreakdownReport = (input: { legacyEmptyMessages?: boolean; errorCall?: boolean; filter?: StatsFilter } = {}) =>
  // 通过真实 Session 服务写入数据，避免测试复制 aggregateStats 的归因算法。
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })
    const assistant = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
    })
    const now = Date.now()
    const stepPartID = PartID.ascending()
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
    // 可选错误调用与成功调用共用 owner，用于验证复合 tuple 合并后仍累加错误和耗时。
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
    yield* session.updatePart({ id: stepPartID, sessionID: info.id, messageID: assistant.id, ...stepData })

    // legacy 分支只改变持久化 breakdown，不改变 ToolPart 本身，便于隔离 context estimate 兼容性。
    if (input.legacyEmptyMessages) {
      // 1.15.3 的部分本地记录只保存空 messages 对象，没有分类计数。
      // 在存储层改写 JSON 可让测试停留在 stats 行为边界：当前写入仍遵循 schema，
      // 同时验证从用户数据库复制来的历史记录仍可被安全读取。
      yield* Effect.sync(() =>
        Database.Client().$client.run("update part set data = ? where id = ?", [
          JSON.stringify({ ...stepData, inputBreakdown: { ...stepData.inputBreakdown, messages: {} } }),
          stepPartID,
        ]),
      )
    }

    return yield* aggregateStats(input.filter)
  })

const seedLegacyUsageAt = (created: number) =>
  // 旧 assistant message 不含 step-finish part，用于覆盖聚合器的兼容读取路径。
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created },
    })
    yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 1,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created },
    })
    return yield* aggregateStats({ days: 60 })
  })

const seedMultiAssistantRequest = (created = Date.now()) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const requestID = MessageID.ascending()
    const firstAssistantID = MessageID.ascending()
    const secondAssistantID = MessageID.ascending()
    const now = created

    // 直接写入现有 usage schema，测试跨 Assistant owner 的真实聚合边界而不是复制生产算法。
    yield* Effect.sync(() =>
      Database.use((db) => {
        // Request row 是健康指标的唯一 owner；两个 Assistant row 只贡献各自模型的 token/cost/call。
        // 最终 outcome 故意与 Assistant status 不同，用来证明 `--status` 不能在分组前丢掉 usage。
        db.insert(RequestUsageTable).values({
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
        }).run()
        db.insert(RequestUsageAssistantTable).values([
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
        ]).run()
      }),
    )

    return yield* aggregateStats({ statusFilter: "error" })
  })

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
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created },
    })
    yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 1,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created },
    })
    // 元数据写入真实 ProjectTable，证明 identity 是聚合查询结果而非 renderer 猜测 basename。
    yield* Effect.sync(() =>
      Database.use((db) =>
        db.update(ProjectTable)
          .set({
            // 控制字符会破坏 panel；shell 元字符只是项目名称的一部分，不能被解释或删除。
            name: "Stats\nProject\u001bX | $HOME > report",
            worktree: "/tmp/project with space/$(noop)|source",
          })
          .where(eq(ProjectTable.id, info.projectID))
          .run(),
      ),
    )
    return { report: yield* aggregateStats(), projectID: info.projectID }
  })

describe("stats data", () => {
  test("defaults CLI stats to 60 days while preserving explicit all-time", async () => {
    // 直接执行公开命令解析器，验证真实默认值而不是读取 option 定义或源码字符串。
    // all-time 必须覆盖默认 days，保证聚合层可以区分默认窗口和无界窗口。
    if (typeof StatsCommand.builder !== "function" || typeof StatsTimelineCommand.builder !== "function") {
      throw new Error("stats command builders are unavailable")
    }
    const defaults = await (await StatsCommand.builder(yargs([]).exitProcess(false))).parse()
    const allTime = await (await StatsCommand.builder(yargs(["--all-time"]).exitProcess(false))).parse()
    const timeline = await (await StatsTimelineCommand.builder(yargs([]).exitProcess(false))).parse()

    expect(defaults.days).toBe(60)
    expect(defaults.allTime).toBe(false)
    expect(allTime.allTime).toBe(true)
    expect(timeline.heatmap).toBe(false)
  })

  test("accepts root breakdown shortcuts with optional limits", async () => {
    // 无值 shortcut 表示进入对应 Breakdown 并使用默认/响应式数量；带值时才覆盖显示上限。
    const builder = StatsCommand.builder
    if (typeof builder !== "function") throw new Error("stats command builder is unavailable")
    const parse = async (args: string[]) => (await builder(yargs(args).exitProcess(false).showHelpOnFail(false))).parse()
    const tools = await parse(["--tools"])
    const topTools = await parse(["--tools", "4"])
    const models = await parse(["--models"])

    expect(tools.tools).toBe(true)
    expect(topTools.tools).toBe(4)
    expect(models.models).toBe(true)
    // 非数字值和负数必须在 CLI 边界失败，不能静默退回 Dashboard。
    const invalid = await builder(yargs(["--tools", "invalid"]).exitProcess(false).showHelpOnFail(false))
    const negative = await builder(yargs(["--tools", "-1"]).exitProcess(false).showHelpOnFail(false))
    expect(() => invalid.parse()).toThrow()
    expect(() => negative.parse()).toThrow()
  })

  test("rejects options that a stats endpoint does not consume", async () => {
    // 每个端点只接受有实际行为的参数，防止 CLI 成功退出却静默忽略用户输入。
    // 同时覆盖 tool+cost 的语义冲突，而不是只依赖 yargs 的未知参数检查。
    if (
      typeof StatsCommand.builder !== "function" ||
      typeof StatsBreakdownCommand.builder !== "function" ||
      typeof StatsTimelineCommand.builder !== "function" ||
      typeof StatsSessionsCommand.builder !== "function" ||
      typeof StatsInsightsCommand.builder !== "function"
    ) throw new Error("stats detail command builders are unavailable")
    const rootBuilder = StatsCommand.builder

    const parser = (args: string[]) => yargs(args)
      .exitProcess(false)
      .showHelpOnFail(false)
      .strictOptions()
      .fail((message, error) => {
        throw error ?? new Error(message)
      })
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
    let publicError: unknown
    // 以真实 `stats insights` 嵌套命令解析参数；stub 只防止回归时误执行数据库 handler，不替代生产 builder。
    const publicParser = yargs(["stats", "--limit", "5", "insights"])
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => { throw error ?? new Error(message) })
      .command({
        ...StatsCommand,
        builder: async (root) => (await rootBuilder(root)).command({ ...StatsInsightsCommand, handler: () => { called = true } }),
        handler: () => {},
      })
      .demandCommand()
      .strict()
    try {
      await publicParser.parse()
    } catch (error) {
      publicError = error
    }
    // Root 的 limit 是 Dashboard shortcut，不得泄漏后被 Insights 静默接受。
    expect(String(publicError)).toContain("limit")
    expect(called).toBe(false)
  })

  it.instance("uses complete natural days for positive windows", () =>
    Effect.gen(function* () {
      // 事件落在滚动 60×24 小时范围内、但早于第一个完整自然日，必须被排除。
      // 这从聚合结果锁定自然日边界，避免测试复制 cutoff 实现。
      const latest = new Date()
      latest.setHours(0, 0, 0, 0)
      const earliest = new Date(latest)
      earliest.setDate(earliest.getDate() - 59)
      const rollingCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000
      const report = yield* seedLegacyUsageAt(Math.floor((rollingCutoff + earliest.getTime()) / 2))

      expect(report.requestedDays).toBe(60)
      expect(report.daily).toHaveLength(60)
      expect(report.dateRange.earliest).toBe(earliest.getTime())
      expect(report.total.tokens.total).toBe(0)
      expect(report.daily.reduce((sum, day) => sum + day.tokens.total, 0)).toBe(report.total.tokens.total)
    }),
  )

  it.instance("attributes request health once while filtering Assistant usage by final outcome", () =>
    Effect.gen(function* () {
      const report = yield* seedMultiAssistantRequest()
      const owner = report.models.find((item) => item.id === "owner-model")
      const secondary = report.models.find((item) => item.id === "secondary-model")
      const error = report.statuses.find((item) => item.id === "error")

      // 两个 completed Assistant 都属于最终 error request；按 Assistant status 过滤会让 300 token 全部消失。
      expect(report.total.tokens.total).toBe(300)
      expect(report.total.cost).toBe(3)
      expect(report.total.requests).toBe(1)
      expect(report.total.errors).toBe(1)
      // Request owner 只得到一次健康指标；secondary model 仍保留自身 usage，但不能伪造 owned request。
      expect(owner).toMatchObject({ requests: 1, errors: 1, durationMs: 2_000 })
      expect(secondary).toMatchObject({ requests: 0, errors: 0, tokens: { total: 200 } })
      expect(error).toMatchObject({ requests: 1, errors: 1, tokens: { total: 300 }, assistantCalls: 2 })
    }),
  )

  it.instance("buckets requests by their recorded start hour", () =>
    Effect.gen(function* () {
      // 固定本地 17:30，可直接验证 RequestUsage.time_created，而不依赖测试运行时钟。
      const report = yield* seedMultiAssistantRequest(new Date(2026, 5, 1, 17, 30).getTime())
      const requestsByHour = Reflect.get(report, "requestsByHour") as number[] | undefined

      expect(requestsByHour).toHaveLength(24)
      expect(requestsByHour?.[17]).toBe(1)
      // 小时投影必须与已过滤 request shell 总数闭合，Assistant 次数不能重复进入分母。
      expect(requestsByHour?.reduce((sum, value) => sum + value, 0)).toBe(report.total.requests)
    }),
  )

  it.instance("renders stable project identity without interpreting terminal or shell characters", () =>
    Effect.gen(function* () {
      const result = yield* seedNamedProject()
      const project = result.report.projects[0]

      // ID 仍是 filter/series 关联键，label/path 只承担显示身份，未来重构不能混用两者。
      expect(project).toMatchObject({
        id: result.projectID,
        label: "Stats Project X | $HOME > report",
        path: "/tmp/project with space/$(noop)|source",
      })
      const output = renderBreakdown(result.report, { color: "never", by: "project" })
      // shell 元字符必须原样可见；测试只验证字符串显示，绝不执行或转义成命令。
      expect(output).toContain("Stats Project X | $HOME > report")
      expect(output).toContain("/tmp/project with space/$(noop)|source")
      expect(output).not.toContain("\u001b")
    }),
  )

  it.instance("uses the final path segment for projects recorded on another operating system", () =>
    Effect.gen(function* () {
      const result = yield* seedNamedProject()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(ProjectTable)
            // Stats 数据可能由 Windows 数据库迁移到 macOS；显示名称不能依赖当前平台的路径分隔符。
            .set({ name: null, worktree: "H:\\Hyper\\FRCheck" })
            .where(eq(ProjectTable.id, result.projectID))
            .run(),
        ),
      )
      const report = yield* aggregateStats()
      const project = report.projects.find((item) => item.id === result.projectID)

      // 完整 worktree 仍用于消歧，但各图表的短身份必须保持为用户可识别的最后一段。
      expect(project).toMatchObject({ label: "FRCheck", path: "H:\\Hyper\\FRCheck" })
      expect(renderBreakdown(report, { color: "never", by: "project" })).toContain("FRCheck")
    }),
  )

  it.instance("attributes tool context tokens from complete input breakdowns", () =>
    Effect.gen(function* () {
      // 工具调用数和 context token 来自不同粒度记录，聚合后两者必须同时保留。
      // Tool footprint 的可见输出证明数据不仅计算完成，也到达公开页面。
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
      expect(renderBreakdown(report, { color: "never", by: "tool" })).toContain("Tool footprint")
    }),
  )

  it.instance("attributes ToolPart footprint to its issuing runtime and applies owner filters", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport({ errorCall: true })

      // calls/chars/error/duration 来自 ToolPart；estimated context 是另一条后续消费链，不能互相冒充。
      expect(report).toMatchObject({
        totalTools: 2,
        toolCalls: [{
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
        }],
      })
      const output = renderBreakdown(report, { color: "never", by: "tool" })
      // 页面断言锁定 attribution 已到达用户边界，而不是只存在于内部 report 字段。
      expect(output).toContain("errors")
      expect(output).toContain("avg/call")

      // legacy ToolPart 属于 completed Assistant；error filter 不能只过滤 context 而保留未归属的 calls。
      const filtered = yield* aggregateStats({ statusFilter: "error" })
      // 三个公开总量必须同时清空，防止未来只修 toolCalls 却留下旧 ToolUsage 分母。
      expect(filtered).toMatchObject({ totalTools: 0, toolCalls: [], toolUsage: [] })
    }),
  )

  it.instance("keeps tool breakdown finite for legacy empty message breakdowns", () =>
    Effect.gen(function* () {
      // 历史空 messages 不应产生 NaN，也不能导致整页工具分析失败。
      // 零 context 是兼容性回退，不推测旧记录中从未保存的分类数据。
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
      // 没有 context estimate 时不应伪造零趋势 series，但真实调用 footprint 仍须可渲染。
      expect(report.toolSeries).toEqual([])
      const output = renderBreakdown(report, { color: "never", by: "tool" })
      // 页头与表格必须使用同一可用性语义，不能把“未保存 breakdown”误报成精确零。
      expect(output).toContain("context estimate unavailable")
      expect(output).not.toContain("0 estimated context tokens")
    }),
  )
})

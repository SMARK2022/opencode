import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { StatsFilter } from "../../src/cli/cmd/stats-data"

// 固定本地自然日使坐标、小时与 Forecast 月末锚点可复现；all-time 与 60 日交互帧共用这份 seed。
const seed = [
  // 首条是缓存主导的正常请求，Token 排名与第二条的费用排名故意相反。
  // apply_patch 与 bash 分属不同 issuing runtime，工具归因不能只按 Session 总数投影。
  {
    id: "a",
    project: "alpha",
    model: "model-a",
    provider: "provider-a",
    agent: "build",
    source: "prompt",
    status: "completed",
    input: 80,
    output: 12,
    read: 160,
    cost: 125000,
    day: 0,
    hour: 4,
    tool: "apply_patch",
  },
  {
    // 小 Token、高费用并带 error，独立锁定费用、失败和归因三个可观察维度。
    // 17 点与其他请求的清晨时段不同，可发现从 Session 更新时间猜小时的错误。
    id: "b",
    project: "beta",
    model: "model-b",
    provider: "provider-b",
    agent: "review",
    source: "command",
    status: "error",
    input: 30,
    output: 9,
    read: 0,
    cost: 250000,
    day: 1,
    hour: 17,
    tool: "bash",
  },
  {
    // 同 Provider 跨模型、同 Agent 跨项目，防止实现把这些身份视为一对一映射。
    // 0.001 美元必须保留到 renderer；舍成零会改变 Provider、Agent 与工具筛选总额。
    id: "c",
    project: "alpha",
    model: "model-b",
    provider: "provider-a",
    agent: "review",
    source: "prompt",
    status: "aborted",
    input: 20,
    output: 2,
    read: 40,
    cost: 1000,
    day: 2,
    hour: 6,
    tool: "bash",
  },
  {
    // running 独立于 completed/error/aborted，状态页需要保留这第四个结果。
    // 第二次四点请求落在另一自然日，用于区分日历位置和累计小时分布。
    id: "d",
    project: "beta",
    model: "model-a",
    provider: "provider-b",
    agent: "build",
    source: "command",
    status: "running",
    input: 10,
    output: 1,
    read: 0,
    cost: 10000,
    day: 2,
    hour: 4,
    tool: "apply_patch",
  },
] as const

export const filters = {
  // all-time 使用空过滤器而非永远匹配的特殊 ID，才能经过原先错误的累计覆盖分支。
  all: {},
  provider: { providerFilter: "provider-a" },
  agent: { agentFilter: "review" },
  status: { statusFilter: "error" },
  tool: { toolFilter: "bash" },
} satisfies Record<string, StatsFilter>

// 这些常量独立来自人工可核算的四条账本，不从 aggregateStats 或目标图表反算。
export const expectedTotals = {
  // 四条 Token 分别为 257、44、67、16；费用单位在 seed 中为微美元。
  all: { tokens: 384, cost: 0.386, requests: 4 },
  provider: { tokens: 324, cost: 0.126, requests: 2 },
  // Agent 与 tool 恰好覆盖 b/c，但匹配字符串不同，错用对方筛选键仍会得到空集合。
  agent: { tokens: 111, cost: 0.251, requests: 2 },
  status: { tokens: 44, cost: 0.25, requests: 1 },
  tool: { tokens: 111, cost: 0.251, requests: 2 },
}

export const seedStatsDatabase = () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    // 使用真实 Core 表结构，不手造 StatsReport，也不创建生产会话或调用模型。
    for (const id of ["alpha", "beta"]) {
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.make(id),
          name: id === "alpha" ? "Alpha 项目" : "Beta",
          worktree: AbsolutePath.make(`/stats/${id}`),
          // 目录只作为持久身份文本，不要求磁盘存在，避免 Stats 验收触碰真实项目文件。
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
    }
    for (const row of seed) {
      // oracle 与候选均固定 UTC；自然日构造使小时、周历和月末预测共用相同时间基准。
      const time = new Date(2026, 9, 1 + row.day, row.hour).getTime()
      const sessionID = SessionID.make(`ses_${row.id}`)
      const requestID = MessageID.make(`msg_request_${row.id}`)
      // request 与 Assistant 的 ID 分离，才能验证精确 owner tuple 而非同 ID 的偶然匹配。
      const messageID = MessageID.make(`msg_assistant_${row.id}`)
      const tokens = { input: row.input, output: row.output, reasoning: 2, cache: { read: row.read, write: 3 } }
      // 账本 total 包含 reasoning 和 cache write，不能只汇总输入、输出与命中缓存。
      const common = {
        session_id: sessionID,
        request_id: requestID,
        root_request_id: requestID,
        status: row.status,
        provider_id: row.provider,
        model_id: row.model,
        step_count: 1,
        tokens_input: row.input,
        tokens_output: row.output,
        tokens_reasoning: 2,
        tokens_cache_read: row.read,
        tokens_cache_write: 3,
        tokens_total: row.input + row.output + row.read + 5,
        cost_micros: row.cost,
        time_created: time,
        time_updated: time,
        time_completed: row.status === "running" ? null : time + 1200,
        // running 不伪造完成时间；其 owning request 状态仍须与已完成 Assistant 明细分开。
      }
      // Session 累计刻意保持零：源报告依赖事件，不能从缓存累计生成另一套分母。
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.make(row.project),
          directory: `/stats/${row.project}`,
          slug: row.id,
          title: `Session ${row.id} 中文`,
          // 标题实际经过终端文本清洗和 CJK 列宽计算，数据库级 oracle 不只覆盖英文标识。
          version: "test",
          agent: row.agent,
          time_created: time,
          time_updated: time + 1200,
        })
        .run()
      yield* database.db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          time_created: time,
          time_updated: time,
          data: {
            role: "assistant",
            // 同一条 Assistant 同时存在历史消息和账本，统计必须去重，不能把两份表示各计一次。
            parentID: requestID,
            modelID: ModelV2.ID.make(row.model),
            providerID: ProviderV2.ID.make(row.provider),
            agent: row.agent,
            mode: "build",
            path: { cwd: `/stats/${row.project}`, root: `/stats/${row.project}` },
            time: { created: time, completed: time + 1200 },
            tokens,
            cost: row.cost / 1_000_000,
            // 消息存美元、账本存微美元，来源不同也必须生成同样的小额费用。
          },
        })
        .run()
      yield* database.db
        .insert(RequestUsageTable)
        // 请求来源和 Agent 属于 shell owner，不从工具名或模型名称推断。
        .values({ ...common, source: row.source, agent: row.agent, assistant_count: 1 })
        .run()
      // Assistant 自身 completed 与最终 request outcome 分开，验证健康归因不会重复或丢失。
      yield* database.db
        .insert(RequestUsageAssistantTable)
        .values({ ...common, assistant_message_id: messageID, status: "completed" })
        .run()
      yield* database.db
        .insert(PartTable)
        .values([
          {
            id: PartID.make(`prt_tool_${row.id}`),
            // 使用真实 prt 品牌前缀，fixture 的成功不能依赖绕过当前持久 ID 校验。
            session_id: sessionID,
            message_id: messageID,
            time_created: time,
            time_updated: time,
            data: {
              type: "tool",
              callID: row.id,
              tool: row.tool,
              state:
                // ToolPart error 是执行结果；request status 过滤仍由关联的 request/Assistant 决定。
                row.status === "error"
                  ? { status: "error", input: {}, error: "failed", time: { start: time, end: time + 100 } }
                  : {
                      status: "completed",
                      input: {},
                      output: "ok",
                      title: "done",
                      metadata: {},
                      time: { start: time, end: time + 100 },
                      // 明确工具耗时，以便 Footprint 的 avg/call 不是永久显示零。
                    },
            },
          },
          {
            id: PartID.make(`prt_step_${row.id}`),
            // breakdown 属于实际消费输入的 step，不将它复制到 request shell 伪造归因。
            session_id: sessionID,
            message_id: messageID,
            time_created: time,
            time_updated: time,
            // 十类输入均有非零数据，避免只有空 report 的颜色测试放过主体缺失。
            data: {
              type: "step-finish",
              reason: "stop",
              tokens,
              cost: row.cost / 1_000_000,
              inputChars: 80,
              // 25 个系统类字符加 55 个消息类字符闭合为 80，十类输入各有非零贡献。
              inputBreakdown: {
                system: 10,
                instructions: 5,
                skills: 3,
                tools: 7,
                messages: {
                  userText: 20,
                  assistantText: 10,
                  reasoning: 5,
                  toolInput: 8,
                  toolOutput: 10,
                  attachments: 2,
                  total: 55,
                  // messages.total 是其子类之和，不是只数 userText；漏项会改变所有 context 百分比。
                },
              },
            },
          },
        ])
        .run()
    }
  })

// 只改变输入账本以产生支持域分支；旧、新源码分别消费同样的 rows，不在夹具复制聚合规则。
export const setStatsScenario = (scenario: "no-cost" | "tool-only") =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    if (scenario === "no-cost") {
      // 只清价格不清 Token，才能验证不可用费用不会把已有用量和健康事实一起隐藏。
      // 两个账本级别一起清零，防止 request fallback 从另一层残留费用恢复成正费用报告。
      yield* database.db.update(RequestUsageTable).set({ cost_micros: 0 }).run()
      yield* database.db.update(RequestUsageAssistantTable).set({ cost_micros: 0 }).run()
    }
    if (scenario === "tool-only") {
      // 没有 request 账本的旧工具记录仍属于真实支持域，不能借 request 生成伪请求分母。
      yield* database.db.delete(RequestUsageAssistantTable).run()
      yield* database.db.delete(RequestUsageTable).run()
    }
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    // 无账本的工具场景走真实旧消息路径；消息计费清零但工具内容和状态继续存在。
    for (const message of yield* database.db.select().from(MessageTable).all()) {
      if (message.data.role !== "assistant") continue
      yield* database.db
        .update(MessageTable)
        .set({ data: { ...message.data, cost: 0, tokens: scenario === "tool-only" ? tokens : message.data.tokens } })
        .where(eq(MessageTable.id, message.id))
        .run()
    }
    for (const part of yield* database.db.select().from(PartTable).all()) {
      // 只改变计费 step，不删除 ToolPart；否则“无计费但有工具”的场景会被误做成完全空态。
      if (part.data.type !== "step-finish") continue
      yield* database.db
        .update(PartTable)
        .set({ data: { ...part.data, cost: 0, tokens: scenario === "tool-only" ? tokens : part.data.tokens } })
        .where(eq(PartTable.id, part.id))
        .run()
    }
  })

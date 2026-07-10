import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
// #244：timeout 上限用 schema 包的正整数与上限检查表达
import { PositiveInt } from "@opencode-ai/schema"
// #138：grep 结果上限与过宽候选处理
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// #138：工具输出匹配上限（有界搜索）
// #138：工具默认 64 条匹配上限（与 source 一致）
const RESULT_LIMIT = 64
// #244：默认 10 秒覆盖常规代码库检索；它替代原先的 5000 文件硬拒绝，
// 让「小文件很多但搜索很快」的仓库能完成，同时仍给低命中大扫描一个确定边界
const DEFAULT_TIMEOUT = 10_000
// #244：允许显式放宽时间预算，但保留 2 分钟上限，避免把 grep 当成长时间后台任务
const MAX_TIMEOUT = 120_000
// #244：include/exclude 都允许单个 glob 或 glob 列表；共用一个 schema 常量，
// 避免两参数定义分叉后出现 include 支持数组而 exclude 不支持的回归
const PatternList = Schema.Union([Schema.String, Schema.Array(Schema.String)])


export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to include in the search (e.g. "*.js", ["*.ts", "*.tsx"])',
  }),
  exclude: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to exclude from the search (e.g. "node_modules/**", ["dist/**", "*.lock"])',
  }),
  timeout: Schema.optional(
    // #244：机器可读 schema 和描述文字保持同一上限；调用方在提交前就能看到 120 秒边界
    PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT)),
  ).annotate({
    description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}.`,
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        // #244：参数类型直接引用 Parameters 推断——新增字段自动进入 execute 类型，
        // 避免手写注解与 schema 漂移
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            // #244：确定性空结果（搜索完整执行且无匹配）与 timedOut 路径的
            // emptyTimedOut 在 metadata 上必须可区分，下游据此决定是否建议重试
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            // #244：审计元数据记录全部搜索参数（含过滤与预算），
            // 便于事后复盘为什么某次搜索被超时终止或结果被收窄
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
              exclude: params.exclude,
              timeout: params.timeout,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          // #244：显式文件目标转成相对单文件参数，rg 只扫该文件而不受 glob 收窄影响
          const file = info?.type === "Directory" ? undefined : path.relative(cwd, search)
          // #244：用户未传 timeout 也启用默认预算——grep 工具是需要时间边界的交互入口；
          // 默认值在执行层而非 schema 层兜底，避免 wire schema 对未传字段产生隐式值
          const timeout = params.timeout ?? DEFAULT_TIMEOUT
          // timeout与partial可并存，权限信息不能被预算文案吞掉。
          const emptyTimedOut = (partial = false) => ({
            // #244：title 沿用 pattern 与普通结果对齐，调用方按 title 聚合时不受影响
            title: params.pattern,
            // #244：timedOut 必须同时置 truncated——下游消费者只看 truncated 判断结果不完整
            metadata: { matches: 0, truncated: true, timedOut: true, ...(partial ? { partial: true } : {}) },
            // #244：文案同时说明「结果不完整」与「下一步怎么办」，
            // 让模型能自主选择收窄范围或加大预算重试
            output: [
              `Search timed out after ${timeout} ms before finding matches.`,
              "Results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout.",
            ].join("\n"),
          })

          // #244：search 通道替代 grep()：工具需要 timedOut/truncated 元数据来区分
          // 「确认无匹配」与「受控截断」两种空结果，避免向模型谎报 No files found
          const result = yield* ripgrep.search({
            cwd,
            pattern: params.pattern,
            // #244：exclude 单独透传（不经 globs 预组合），数组展开由 core 统一处理
            exclude: params.exclude,
            include: params.include,
            file,
            // #244：显式单文件目标与 glob 过滤互斥，core 侧保证 file 优先
            limit: RESULT_LIMIT + 1,
            // #244：用真实执行时间做保护，不再用候选文件数粗暴拒绝；
            // 小文件多的仓库应允许快速完成，低命中大搜索由 timeout 受控终止
            maxFiles: false,
            // #244：预算取用户显式值或默认值，与 schema 上限共同构成三层防线
            timeout,
            // #244：用户主动取消优先于时间预算——ctx.abort 失败必须保持可区分，
            // 调用方用 signal 的错误通道区分「我取消」与「预算耗尽」
            signal: ctx.abort,
          })
          if (result.items.length === 0 && result.timedOut) return emptyTimedOut(result.partial)
          // #244：非超时的空结果是完整搜索的确定性结果；两种空结果（确认无匹配 vs
          // 受控截断）的输出必须可区分，否则模型会把超时误读为全量确认无匹配
          // [local-smark] partial（rg exit 2，TCC/ACL/EACCES）空结果同样不可当作
          // 确定性阴性——必须显式携带 partial 标记，模型才能区分「全量无匹配」与
          // 「部分路径不可访问导致的假阴性」（源提交修复的核心缺陷场景）
          if (result.items.length === 0 && result.partial)
            return {
              title: params.pattern,
              metadata: { matches: 0, truncated: false, partial: true },
              output: [
                "No files found, but the search could not access some paths (permission denied).",
                "Results may be incomplete. Narrow the search path or adjust include/exclude patterns.",
              ].join("\n"),
            }
          if (result.items.length === 0) return empty

          // #244：绝对路径化在工具边界完成——core 返回的相对路径不带会话目录上下文；
          // path.resolve 锚点是 rg 的实际扫描 cwd，两者必须同一基准输出才稳定
          const rows = result.items.map((item) => ({
            path: path.resolve(
              requestedInfo?.type === "Directory" ? requested : path.dirname(requested),
              item.entry.path,
            ),
            line: item.line,
            text: item.text,
          }))

          // #138：超出 RESULT_LIMIT 截断展示；#244：时间预算耗尽也标记截断；
          // 两者分开记录是因为文案不同（条数上限提示 vs 超时提示可同时出现）
          const resultLimitTruncated = result.truncated || rows.length > RESULT_LIMIT
          const truncated = resultLimitTruncated || result.timedOut === true
          // #138：只返回前 RESULT_LIMIT 条匹配
          const final = resultLimitTruncated ? rows.slice(0, RESULT_LIMIT) : rows
          // [local-smark] 截断时在输出文案中提供 rows.length（截断前的数量），
          // 保留 + 后缀表示截断（如 "65+ matches"），帮助模型评估搜索密度。
          // metadata.matches 是截断后长度（向后兼容），metadata.totalMatches 是截断前数量（新增）。
          const totalMatches = rows.length
          // #244：超时语义优先于空结果语义：即使 rg 曾输出匹配但文件随后在 stat
          // 阶段不可用，也不能把未完成搜索降级成确定性的 "No files found"
          if (final.length === 0 && result.timedOut) return emptyTimedOut(result.partial)
          // [local-smark] 同上：RESULT_LIMIT 过滤后为零匹配也须区分 partial 假阴性
          if (final.length === 0 && result.partial)
            return {
              title: params.pattern,
              metadata: { matches: 0, truncated: false, partial: true },
              output: [
                "No files found, but the search could not access some paths (permission denied).",
                "Results may be incomplete. Narrow the search path or adjust include/exclude patterns.",
              ].join("\n"),
            }
          if (final.length === 0) return empty

          const output = [
            // #244：RESULT_LIMIT 截断与 timeout 截断独立计数，同一结果可能两者同时标注
            // [local-smark] 截断时显示实际数量 + "+" 后缀，不截断时显示精确数
            `Found ${resultLimitTruncated ? `${totalMatches}+` : final.length} matches${
              resultLimitTruncated ? ` (showing first ${RESULT_LIMIT})` : ""
            }${result.timedOut ? ` before timing out after ${timeout} ms` : ""}`,
          ]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (resultLimitTruncated) {
            output.push("")
            // #244：条数截断提示只在数量截断时出现，与超时提示分开措辞，
            // 模型可依据措辞差异选择「收窄 pattern」还是「加大 timeout」
            output.push(`(Results truncated: showing first ${RESULT_LIMIT} matches. Consider using a more specific path or pattern.)`)
          }

          if (result.timedOut) {
            output.push("")
            // #244：与条数截断分开成段——两段提示可同时出现，措辞需可区分归因；
            // 该提示含具体预算数值，模型可据此判断加大到多少仍安全
            output.push(
              `(Search timed out after ${timeout} ms; results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout.)`,
            )
          }

          if (result.partial) {
            output.push("")
            // #244：partial 来自 rg exit code 2；部分路径不可访问不改变结果可信度，
            // 但必须提示调用方结果集并非对所有候选路径完整
            output.push("(Some paths were inaccessible and skipped)")
          }

          return {
            title: params.pattern,
            // #138：metadata.matches 为展示条数；
            // #244：timedOut 用条件展开写入 metadata，未超时时保持旧 wire 形状（无该键）
            // [local-smark] partial 无条件持久化（源 :1657-1663 契约）：compaction
            // 剪枝 output 后，metadata.partial 是不完整性的唯一载体
            metadata: {
              matches: final.length,
              // [local-smark] totalMatches: 截断前的真实匹配数，供 TUI 和后续逻辑使用
              totalMatches,
              truncated,
              ...(result.timedOut && { timedOut: true }),
              partial: result.partial,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

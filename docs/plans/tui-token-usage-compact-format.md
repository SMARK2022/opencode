# Canonical Implementation Plan: TUI Token Usage Compact Format

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户原始需求（见 §1 逐字引用）
>
> Implementation allowed: no
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> Auto · GPT-5.6-SOL · 33m 26s · ↑1.3M ↓27.7K  如上这个是每一次的message之后,我们open code的TUI部分所渲染显示的相应的token消耗的内容。我希望其风格使用类似后面这个计数器的排版，也就是要加上空格↑ 1.3M ↓ 27.7K（同时opencodeTUI退出显示的stdout也要这么改）;↑ 71.5K ↓ 1.7K · 73.2K (15%)，还有个问题,这个是主面板,也就是TUI的主面板的parameter下方显示的token指示器,而相应的sub-agent里面,相应的指示器则更为复杂,其包含了相应的上传以及下载的历史累积在括号里面。所以请你看一看,我想把那个sub-agent里面的相应token计数器统一成我们当前这种token计数器,请你检查检查相应的逻辑,以及相应的方案,如何进行点点级别的,就是手术刀级别的修改,不要进行过分冗余的额外侵入性修改,就是手术刀级把那些冗余的还有不需要的逻辑给替换掉就行,请你完整检查检查。当前我希望是这种compact格式。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不修改 `tokenAccounting` / `Session.getUsage` 的数值语义（pure input、cache-inclusive step、cost 公式保持不变）。
- 不修改 completed message footer / exit Stats 的 **字段选择**（继续 pure `totalInputPure` + `totalOutput` + `cost`）；本任务只改 **排版空格**。
- 不修改主面板 Prompt footer 的数据口径（当前 step 含 cache 的实时条已是用户引用的目标形态 `↑ x ↓ y · total (p%)`）。
- 不修改 sidebar Context 插件的 `↑x(total) · ↓y(total)` 累积括号——既有设计把 request 累积放在 sidebar；用户未要求改 sidebar。
- 不修改 `/context` 面板、`opencode stats` CLI、session-v2 debug surface。
- 不抽取新的跨层 shared usage renderer 模块；两处实时 footer 保持本地 JSX，只对齐字符串形态。
- 不把 subagent 窄屏做成 `↑↓` 合并（主面板 `promptWidth>90` 的窄屏合并）——用户明确要的是 compact 分拆形态；subagent footer 空间约束不同且未要求窄屏策略。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session / Message / Agent（含 subagent）词汇；v1 `session/` 为生产 TUI 路径。 |
| `AGENTS.md` (root) | 单函数优先、不预提取单用 helper、functional style、`const` over `let`。 |
| `packages/opencode/AGENTS.md` | 测试与 typecheck 在 package 目录运行；`bun typecheck`。 |
| `docs/plans/session-end-display-enhancement.md` | 既有 verified 方案确立了 completed footer + exit Stats 共用 `formatUsageStats`，以及 pure input 口径；本任务在该 seam 上只改 spacing。 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁止 fallback；forward/reverse mapping；E/C 中文注释门禁。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts:17-28` | `formatUsageStats` 当前模板 `` `↑${Locale.number(...)}` `` / `` `↓${...}` ``：**箭头与数字之间无空格**。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts:31-52` | `formatSessionExitMessage` 直接调用 `formatUsageStats` 写入 exit stdout Stats 行。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1688-1700` | completed AssistantMessage footer 通过 `formatUsageStats({ input: totalInputPure, ... })` 渲染 `· {usage}`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1791-1810` | 可见形态：`▣ Mode · model · duration · ↑… ↓…`。 | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:376-419` | 主面板 usage：仅 step input/output + context + cost；**已移除** totalInput/totalOutput 展示。 | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:2083-2102` | 宽屏：``↑ {n} ↓ {n} · {context} · {cost}``（**已有空格**）；窄屏 `↑↓ {context}`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx:44-84` | UsageInfo 仍携带 `totalInput`/`totalOutput`；`usageRaw` 从 `acc.request.total*` 填充。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx:96-128` | `showCumulative = width > 120`；渲染 ``↑ n(total) · ↓ n(total) · context · cost``——与主面板 compact 不一致。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1397-1398` | `session.parentID` 时挂载 `SubagentFooter`（与 Prompt 并存）。 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx:175-178` | sidebar 仍显示累积括号；本任务 non-goal。 | observed |
| `packages/opencode/src/token/accounting.ts:162-167,398-407` | `totalInput` 含 cache；`totalInputPure` 仅 pure input；step.input 含 cache。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx:36-66` | 锁定 `formatUsageStats` / exit stdout 为 **无空格** 期望：`↑12.3K ↓1.0K`。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:46-140` | completed footer 渲染断言 `↑12.3K ↓1.0K`（无空格）；cache 非零证明 pure input。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts:228-235` | prompt 源码级锁定分拆 ↑/↓ 与 `Locale.number`，说明主面板已做过“去累积”迁移。 | observed |
| `packages/opencode/src/cli/cmd/tui/util/signal.ts:72-74` | `createTokenFlowPulse` 仅依赖 `{input,output}`，删除 total* 字段不破坏脉冲。 | observed |
| `packages/opencode/src/cli/cmd/tui/util/token-estimate.ts:12-20` | 共享 `UsageInfo` 类型仍含 totalInput/totalOutput，但 **无 import consumer**（prompt/subagent 各自本地 type）。 | observed |

## 5. Current Behavior

```text
[Completed message / exit stdout]
  step-finish parts -> tokenAccounting(...).request.totalInputPure/totalOutput/cost
    -> formatUsageStats -> "↑12.3K ↓1.0K · $0.01"   // 无空格
    -> AssistantMessage footer 与 ExitProvider stdout Stats

[Main Prompt footer]
  tokenAccounting -> step.input/output + stepTotal + % + cost
    -> "↑ 71.5K ↓ 1.7K · 73.2K (15%) · $…"   // 已有空格；无 request 括号

[SubagentFooter]
  tokenAccounting -> step + request.total*
    -> width>120: "↑ 71.5K(xxx) · ↓ 1.7K(yyy) · 73.2K (15%) · $…"
    -> else:     "↑ 71.5K · ↓ 1.7K · …"        // 仍用 · 分隔 ↑↓，且数据层保留 total*
```

用户可见差异：

1. 完成态/exit 的 flow 组缺箭头后空格，与主面板 live compact 不一致。
2. Subagent 实时条仍暴露 request 累积括号，与主面板“去累积、只留 step compact”不一致。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 完成 assistant（`finish` 非 tool-calls/unknown）且有 visible parts | Session processor + TUI Sync | step-finish tokens 已落库 | AssistantMessage footerVisible → formatUsageStats | exit-summary + session index | observed |
| 用户退出 TUI | ExitProvider | sessionUsage memo 写入 exit.message | formatSessionExitMessage → stdout | exit-summary | observed |
| 有 parentID 的 child Session | task/subagent 创建 | SubagentFooter 挂载 | usageRaw + JSX | subagent-footer | observed |
| width ≤120 / >120 | 终端尺寸 | showCumulative 门控 | subagent-footer | subagent-footer | observed |
| input-only / output-only / cost-only / 全零 usage | formatUsageStats 门控 | 零字段省略 | 两 consumer | exit-summary | observed (tests) |
| 修改 sidebar 或 pure-input 语义 | 用户未要求 | — | — | — | speculative (out of scope) |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 完成态 message footer 与 exit stdout 的 flow 文案，箭头与数字之间有且仅有一个空格：`↑ {n}` / `↓ {n}`。 | 用户要求 + 主面板对照 | `session-exit.test.tsx`、`session-message-render.test.tsx`（期望需更新） |
| INV-02 | 零字段省略规则保持：input/output/cost 各自门控，不出现 `↓0`/`$0.00`/空 Stats 行。 | session-end plan + 现有测试 | 同上 |
| INV-03 | completed/exit 的 input 数值仍为 pure input（不含 cache）；output 仍含 reasoning 合并。 | accounting + 现有 pure-input 测试 | `session-message-render` cache 非零 fixture；`session-exit` stepFinish cache |
| INV-04 | SubagentFooter 实时 usage 展示与主面板宽屏 compact 一致：`↑ {stepIn} ↓ {stepOut} · {total} (p%) · $…`，**不**显示 request 累积括号。 | 用户要求 + prompt footer | 无直接 subagent usage 行为测试（需新增或扩展） |
| INV-05 | SubagentFooter 导航 chrome（label、index of total、Parent/Prev/Next）与 token 数值计算路径不变。 | 现有 subagent-footer | `session-message-render` agent 名提取相关测试 |
| INV-06 | 主面板 Prompt footer 行为保持（已 compact）；本任务不引入其回归。 | prompt 已达标 | `session-integration` token usage display |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `formatUsageStats` 用 `` `↑${n}` `` 拼接，**未**在箭头后插入空格；message footer 与 exit 共用此函数，故两处同时错。 | `exit-summary.ts` `formatUsageStats` | 源码 L19-20；测试期望 `↑12.3K` |
| INV-04 | `SubagentFooter` 在主面板移除 request 括号后**未同步**，仍投影 `totalInput/totalOutput` 并在 `width>120` 渲染括号；↑↓ 之间仍用 `·`。 | `subagent-footer.tsx` usage projection + JSX | 源码 L44-84, L96-128 对比 prompt L376-419, L2096-2101 |

根因分类：展示层格式/投影滞后，**不是** accounting 数值错误。  
下游症状：用户看到 `↑1.3M` 与主面板 `↑ 71.5K` 风格分裂；subagent 括号冗余。

本任务是 **display format alignment**（非 bug 诊断 loop）：red-capable 信号 = 现有/更新后的单元与渲染测试对独立期望字符串失败。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 完成态/exit flow 字符串格式 | `formatUsageStats` | 把 usage 数字变成 flow+cost 文本 | message footer 与 exit 已共用；一处改两处 | accounting 只产数字；route 不应重复拼接 |
| Subagent 实时 usage 投影与渲染 | `SubagentFooter` | child session 底栏展示当前 step compact + 导航 | 仅 child session 挂载 | Prompt 已是正确对照但不负责 subagent chrome |
| Token 数值权威 | `tokenAccounting` | step/request/session 三级统计 | 已稳定 | 本任务不改 |

## 10. Single Approved Primary-Path Design

```text
[Path A — permanent flow spacing]
  formatUsageStats(usage)
    -> flow segments: `↑ ${Locale.number(input)}` | `↓ ${Locale.number(output)}` when >0
    -> join with single space; cost with ` · ` as today
    -> consumers: AssistantMessage turnUsage, formatSessionExitMessage unchanged

[Path B — subagent live compact]
  usageRaw:
    input/output = acc.step.input/output
    context/cost 与 prompt 相同
    删除 totalInput/totalOutput 字段与赋值
  JSX:
    `↑ {n} ↓ {n}` 空格分隔（不用 · 隔开 ↑↓）
    ` · {context}` ` · {cost}` 可选
    删除 showCumulative 与 dimensions 仅-for-cumulative 依赖
  tokenAccounting / navigation / pulse 保持
```

为何修复 first divergence：

- A：根因在唯一 formatter；改模板即同时满足 message + stdout。
- B：根因在 subagent 仍展示 request 累积；删除该投影与门控即对齐主面板 compact，不引入第二套 accounting。

不抽取 shared React 组件：prompt 有窄屏 `showSplitFlow` 与 voice chrome 耦合；subagent 有导航 chrome。对齐的是 **字符串形态**，不是组件树。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| formatUsageStats 统一 spacing | proposed primary | primary | yes | 100% permanent flow text | implement |
| SubagentFooter 去括号 + ↑↓ 空格分隔 | proposed primary | primary | yes | 100% subagent live usage text | implement |
| 在 JSX 各处手写空格而不改 formatUsageStats | rejected | forbidden fallback | yes | 会分裂 exit vs message | reject |
| 修改 accounting 以“假装”格式变化 | rejected | forbidden fallback | n/a | 错误 owner | reject |
| Subagent 窄屏 ↑↓ 合并 | not proposed | speculative | — | — | reject (non-goal) |
| Sidebar 去括号 | not proposed | out of scope | — | — | preserve |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Subagent `showCumulative` + `totalInput/totalOutput` 括号 | 主面板迁移前的 request 累积展示；主面板已迁到 sidebar | 用户要求与主面板 compact 统一；累积不再属于 subagent chrome | `subagent-footer.tsx` 删除字段、门控、括号 JSX |
| （可选清理）`token-estimate.ts` 中无 consumer 的 `UsageInfo.total*` | 历史类型 | 若仍无引用可删字段或整类型注释对齐；非行为必需 | 仅当实施时确认无 import |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 箭头后空格（message + exit） | formatUsageStats | `exit-summary.ts` 改模板 | `session-exit.test.tsx` 期望 `↑ 12.3K ↓ 970` / `↑ 12.3K ↓ 1.0K`；`session-message-render` footer 期望同步 |
| INV-02 零字段省略 | formatUsageStats 既有门控 | 仅改有值分支的模板字符串 | 现有 input-only / cost-only / empty 用例改期望含空格 |
| INV-03 pure input 数值 | accounting 不变 | 无 production 改动 | 现有 cache 非零 fixture 仍断言 12.3K 而非 cache-inclusive |
| INV-04 subagent compact 无括号 | SubagentFooter usageRaw+JSX | `subagent-footer.tsx` | 新增行为测试：child session footer 可见 `↑ … ↓ …` 且 **不含** `(` 累积模式；或在已有 render harness 中挂 parent+usage 后断言 |
| INV-05 导航 chrome | SubagentFooter 其余 JSX | 不改 | 既有 subagent label 测试不被破坏 |
| INV-06 prompt 保持 | 不改 prompt | 无 | `session-integration` 源码断言仍过 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `formatUsageStats` 模板加空格 | INV-01 | 用户 sample `↑ 1.3M`；prompt 已空格 | 当前 `` `↑${n}` `` 正是无空格根因 |
| Subagent 删除 total*/showCumulative | INV-04 | 用户要求统一 compact；prompt 已无括号 | subagent 仍投影并渲染累积 |
| 不改 accounting / pure 语义 | INV-03 | session-end 方案 + 测试 | 格式与语义分离 |
| 不抽 shared UI module | 手术刀约束 | AGENTS 不预提取 | prompt 与 subagent 布局不同 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts` | modify | `↑ ${n}` / `↓ ${n}`；注释说明与主面板 flow 空格对齐 | ~3–6 |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | modify | 去掉 cumulative 字段/门控/括号；↑↓ 空格分隔对齐 prompt 宽屏 | ~25–40 净减 |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | modify | 期望字符串改为带空格 | ~8 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | completed footer 期望带空格 | ~6 |
| `packages/opencode/test/cli/cmd/tui/…`（subagent usage 行为） | modify or add | 断言 subagent footer compact 无 request 括号 | ~30–80 |
| `packages/opencode/src/cli/cmd/tui/util/token-estimate.ts` | optional modify | 清理死 `UsageInfo` total* 或注释 | 0–10 |

不修改：`token/accounting.ts`、`prompt/index.tsx`、`sidebar/context.tsx`、`session/index.tsx` 的 usage 数据选择（除非测试专用 fixture）。

## 16. TDD Behavior Slices

Seam 1：`formatUsageStats` / exit stdout / completed footer 公共文本。  
Seam 2：`SubagentFooter` 可见 usage 行（child session）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `formatUsageStats({input:12300,output:970,cost:0.01}) === "↑ 12.3K ↓ 970 · $0.01"` | 无空格模板 | 改 exit-summary 模板 | input-only / output-only / cost-only / empty |
| 2 | exit capture 含 `↑ 12.3K ↓ 1.0K · $0.01` | 同 formatter | 同 slice 1 | reasoning 合并进 ↓ |
| 3 | message-render frame 含 `↑ 12.3K ↓ 1.0K · $0.01`（及 multi-step `↑ 12.3K ↓ 1.1K`） | 同 formatter | 同 slice 1 | pure input 与 multi-step 累加 |
| 4 | child session SubagentFooter 文本匹配 `↑ <stepIn> ↓ <stepOut>` 且不匹配 `↑…(…)` 累积括号模式；可含 `· <total> (<pct>%)` | 仍渲染 total* | 删 cumulative 投影与 JSX | label/导航仍在 |

测试规则：期望值为独立字面量；不断言 private helper 调用次数；不复制 accounting 算法。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~20–35 | 排除 import-only、纯期望字符串替换若计为 test 则 production E 更小（~12–20） |
| Required Chinese explanatory comments `C` | `max(1, ceil(E*0.15))` → 至少 2–3 if E≈20 | 邻近修改点 |

应注释的非显然点：

1. `formatUsageStats`：箭头后空格对齐主面板 live flow，避免永久记录与实时条视觉分裂。
2. SubagentFooter：request 累积改由 sidebar 承载；此处只保留 step compact（与 prompt 同源注释意图）。
3. 测试：带空格期望锁定用户可见 compact 形态，而非内部字段名。

禁止：复述 `` `↑ ${n}` `` 字面意思的注释。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` | `packages/opencode` | INV-01/02/03 exit 路径 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx`（或相关 filter） | `packages/opencode` | completed footer 空格 + pure input + multi-step |
| Subagent usage 相关测试文件 | `packages/opencode` | INV-04 |
| `bun test test/cli/cmd/tui/session-integration.test.ts` | `packages/opencode` | prompt 无回归 |
| `bun typecheck` | `packages/opencode` | 类型：删除 total* 后无残留引用 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0–1 | 仅当单独拆 subagent 测试文件；优先扩展现有 harness |
| Files modified | 4–6 | formatter + subagent + 2–3 tests + optional type cleanup |
| Files deleted | 0 | |
| Production lines | ~30–50 净 | 多为删除 cumulative |
| Test lines | ~40–100 | 期望更新 + 一条 subagent 行为 |
| Generated lines | 0 | |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 测试硬编码无空格字符串遗漏 | 全仓 grep ``↑\d`` / `↑12` 于 test 期望；跑相关 tui tests |
| Subagent 与 Prompt 双显示 usage | 既有架构；本任务只统一形态，不合并两栏（用户未要求） |
| Locale.number 对 970 显示 `970` 对 1000 显示 `1.0K` | 期望继续使用现有 Locale 输出，与当前测试一致，仅加空格 |

### Open Decisions Requiring the User

无。用户已给出目标形态与手术刀范围。

### Rejected Speculation

- 同步改 sidebar 括号：用户对照的是主面板 parameter 下指示器，不是 sidebar。
- 改 pure vs cache 语义：此前分析已确认 message footer 为 pure；本需求是空格与 subagent compact。
- v2 session footer parity：non-goal（与 session-end plan 一致）。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 waitForFrame predicates also hardcode no-space tokens (`session-message-render.test.tsx:66,95,137`); implementer must update predicates with expects. N-02 INV-04 assertion must not treat all `(` as cumulative (sibling index and `(p%)` remain). N-03 optional `token-estimate.ts` UsageInfo cleanup. | APPROVE | task ses_07ece0cebffe10yJKd6xYJbfmg |

### Independent plan audit verdict (verbatim)

```text
No blocking findings.
APPROVE
```

- **Audited artifact:** `docs/plans/tui-token-usage-compact-format.md`
- **Revision:** R1
- **Full scope:** yes (message footer spacing, exit stdout spacing, subagent compact unification, surgical non-goals)
- **Blocking findings:** none
- **Implementation allowed after recorder transition:** only for R1 as written (`Status: approved`, `Approved revision: R1`, `Implementation allowed: yes`)

Non-blocking findings (verbatim summary from auditor):

- N-01: waitForFrame predicates also hardcode no-space tokens; after spacing, harness can hang if predicates not updated.
- N-02: INV-04 assertion must not treat all `(` as cumulative; use cumulative `↑…(…)` pattern, not naive `not.toContain("(")`.
- N-03: optional `token-estimate.ts` UsageInfo cleanup.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts` | `formatUsageStats` → `↑ ${n}` / `↓ ${n}` |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | 删除 total*/showCumulative；↑↓ 空格分隔 compact |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | 期望字符串加空格 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | footer 期望加空格；新增 subagent compact 行为测试 |
| `docs/plans/tui-token-usage-compact-format.md` | plan + audit + evidence |

`git diff --stat` (production+tests, excluding plan): 4 files, +110/-25 lines.

### Red-Green Test Evidence

1. Red: `session-exit` `formats each usage field independently` failed Expected `↑ 12.3K…` Received `↑12.3K…`.
2. Green: after `formatUsageStats` template change, full `session-exit.test.tsx` 3 pass.
3. Red: `subagent footer shows compact…` failed Received `↑ 6.5K(12.6K) · ↓ 1.0K(1.1K)…` Expected contain `↑ 6.5K ↓ 1.0K`.
4. Green: after subagent-footer change, that test + related footer tests pass.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` | packages/opencode | 3 pass |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "subagent footer shows compact\|completed assistant footer\|formats each"` | packages/opencode | 5 pass (filter matched footer suite) |
| `bun test test/cli/cmd/tui/session-integration.test.ts -t "token usage"` | packages/opencode | 2 pass |
| `bun typecheck` | packages/opencode | pass (`tsgo --noEmit`) |

### Original Feedback-Loop Result

Display alignment (not a runtime bug loop). User-visible red signals were the updated independent string expects above; both failed pre-fix and passed post-fix.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| formatUsageStats spacing | primary | implemented |
| SubagentFooter step compact | primary | implemented; cumulative branch deleted |
| accounting / pure input | unchanged | preserved |
| sidebar cumulative | out of scope | preserved |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 28 | production: exit-summary template+comment, subagent type/projection/JSX; test: new subagent behavior test assertions + expect updates; exclude pure plan doc |
| Qualifying Chinese comment lines `C` | 5 | (1) formatUsageStats 空格对齐注释；(2) SubagentFooter step-only 投影注释；(3) running 占位不带累积；(4) subagent 测试 step/total 分叉意图；(5) 禁止累积括号且保留 sibling/(p%) 合法括号 |
| Ratio `C / E` | 0.18 |  |
| Required minimum `C` | 5 | `ceil(28*0.15)=5` |

Representative comments:
- exit-summary: 箭头后空格对齐主面板 live compact flow
- subagent-footer: 只投影当前 step，request 累积由 sidebar 承载
- test: 勿用 not.toContain("(")——sibling 与 (p%) 仍合法

### Remaining Unverified Items

- 未手测真实 TUI 终端像素布局（有 OpenTUI testRender 行为覆盖）。
- 未改 `token-estimate.ts` 死类型（N-03 optional，跳过）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 input-only 负向断言 `not.toContain("↓0")` 对 `↓ 0` 灵敏度下降（INV-02 仍由 unit 精确期望锁住）。N-02 optional token-estimate 死类型未清理。 | APPROVE | task ses_07ec7410effeoELAI4b1y2U3LG |

### Independent implementation audit verdict (verbatim)

```text
No blocking findings.
APPROVE
```

- **Audited artifact:** 实际 diff vs `docs/plans/tui-token-usage-compact-format.md` **R1**
- **Full original scope:** message footer 空格、exit stdout 空格、subagent compact 统一、手术刀 non-goals
- **Blocking findings:** none

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

# Canonical Implementation Plan: Session-End Display Enhancement

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: full-scope
>
> Requirement source: 用户原始需求（见 §1 逐字引用）
>
> Implementation allowed: no
>
> Last updated: 2026-07-17

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 现在请你再次完整详细检查一下,详细调研调研我们 Open Code在进行结束之后,它的显示内容是否能够得到有效的更新。因为你可以检查检查相应Codex在我们结束会话之后会显示什么内容,同时你也可以结合相应的 Open Code status,就是Open Code STATS相应的显示内容,可以完整检查一下,理论上来说,我们 Open Code在结束之后显示什么内容会更好。请你构建相应的方案,同时你的方案中要包含完整的显示的样例,包括现在显示的内容样例,以及你预期的显示样例是如何的。请注意保持OpenCode相应的整体风格,不要过分地进行设计一些不符合我们OpenCode相应样式或者风格的内容。也就是让其结束之后适当显示一些有效信息,但是也避免显示那些故意显示的信息,也就是我们没必要把每一个内容都显示清楚,但是可以适当显示一些有效信息来说明本次的session,我们的一些相应的统计或者一些记录等等。

同时最好整体的input口径是那个新增的纯input（不含cache）的累积；

## 2. Explicit Non-Goals

- 不修改 prompt footer（输入区下方）的显示逻辑——它展示当前 step 的实时流量，职责是 live monitoring，与本方案的 permanent record 不同。
- 不修改 sidebar context 插件的显示逻辑——它展示活跃 turn 的实时累计，职责也是 live monitoring。
- 不修改 `/context` 面板或 `/status` 对话框——它们是按需打开的独立面板。
- 不修改 `opencode stats` CLI 命令——它是跨 session 聚合分析工具，不属于 session 内显示。
- 不新增 session 级汇总块（session summary block）——sidebar 已有 session 累计，`/context` 已有 Session Totals，新增会造成冗余。
- 不修改 v2 session 渲染路径（`session-v2.tsx`）——v2 是 in-progress 迁移目标且 `internal:session-v2-debug` 是 debug surface，用户未要求；其独立消息模型和非生产 flag 不属于本次 v1 Session/exit surface。v2 parity 待迁移完成且数据模型对齐后再独立处理。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session/Message/Status/Run state 词汇；v1 (`session/`) 是当前生产路径，v2 是迁移目标。 |
| `AGENTS.md` (root) | 代码风格：单函数优先、避免 `any`、使用 Bun API、functional array methods、`const` over `let`。 |
| `AGENTS.md` (packages/opencode) | 测试不能从 repo root 运行；typecheck 用 `bun typecheck`。 |
| `packages/opencode/src/token/accounting.ts` | 统一 token 统计入口；`tokenAccounting()` 一次遍历完成 step/request/session 三级统计，R7 扩展 request selection 和 pure input 字段。 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | v1 生产路径的 Session route、AssistantMessage turn 完成态 footer 和 Session exit message owner。 |
| `packages/opencode/src/util/locale.ts` | `Locale.number()`（K/M 缩略）、`Locale.durationClock()`（turn 耗时）是已有格式化口径。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/cli/cmd/tui/routes/session/index.tsx:1641-1802` | v1 AssistantMessage 组件：`final()`、`duration()`、`footerVisible()` 和完成态 footer 渲染（`▣ Mode · model · duration`）。 | observed |
| `src/cli/cmd/tui/routes/session/index.tsx:1681-1686` | `duration` memo 调用 `assistantTurnDuration(messages(), props.message)`——证明 footer 已有 messages + parts 访问路径。 | observed |
| `src/cli/cmd/tui/routes/session/index.tsx:1775-1800` | 完成态 footer JSX：`▣ {Mode} · {model} · {duration} · interrupted?`——缺少 token/cost 字段。 | observed |
| `src/cli/cmd/tui/routes/session/index.tsx:471-489` | Session route 通过 `exit.message.set(...)` 构造 renderer 销毁后的 stdout 文本，目前只有 logo、Session title、Continue 命令。 | observed |
| `src/cli/cmd/tui/app.tsx:791-796` | `/exit`、`/quit`、`/q` 都进入 `app.exit` 并调用 `exit()`。 | observed |
| `src/cli/cmd/tui/context/exit.tsx:38-57` | `ExitProvider` 在 `onBeforeExit` 后销毁 renderer，并将 `exit.message.get()` 写入 stdout。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts` | R6 planned pure Session-exit 文本和 usage formatter seam；由 Session route 和 AssistantMessage 调用，供 exit 行为测试直接观察。 | contracted (planned seam) |
| `src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:311-389` | v2 AssistantMessage 组件：平行 footer 渲染 `▣ Mode · model · duration`。 | observed |
| `src/token/accounting.ts:24-71` | `TokenAccounting` 类型：`step`（当前 step）、`request`（当前 user request 累计）、`session`（全 session 累计）。 | observed |
| `src/token/accounting.ts:102-200` | `tokenAccounting()` 主函数：`requestAssistantIDs` 锁定活跃 turn 的 assistant 集合，`confirmedRequest` 累加 step-finish tokens/cost。 | observed |
| `src/token/accounting.ts:149-160` | per-turn 累加公式：`input += tokens.input + cache.read + cache.write`；`output += tokens.output + reasoning`；`cost += p.cost`。 | observed |
| `src/cli/cmd/tui/component/prompt/index.tsx:374-416` | prompt footer `usageRaw`：展示当前 step 的 `↑ input ↓ output · context · cost`，注释说明已移除 request 累积以避免与 sidebar 冗余。 | observed |
| `src/cli/cmd/tui/feature-plugins/sidebar/context.tsx:41-65` | sidebar context：展示活跃 turn 的 step + request 累计（`input(totalInput)`），以及 `tokens · % · cost · latency`。 | observed |
| `src/cli/cmd/tui/routes/session/subagent-footer.tsx:53-84` | subagent footer：展示 `↑ input(totalInput) · ↓ output(totalOutput) · context · cost`。 | observed |
| `src/cli/cmd/tui/routes/session/context-usage.tsx:184-200` | `/context` 面板 footer：`Session Totals · Input · Output · Reason · Cache W/R · Cost`。 | observed |
| `src/cli/cmd/tui/component/dialog-status.tsx:1-168` | `/status` 对话框：MCP/LSP/Formatters/Plugins——不含 session token 统计。 | observed |
| `src/cli/cmd/stats.ts:1-100` | `opencode stats` CLI：跨 session 聚合分析（dashboard/models/providers/timeline/sessions/costs/tokens/insights/forecast）。 | observed |
| `src/cli/cmd/tui/util/session-pending.ts:50-60` | `assistantTurnDuration()`：以 `user.time.created` → `assistant.time.completed` 推导 turn 耗时。 | observed |
| `src/util/locale.ts:30-80` | `Locale.number()`（K/M 缩略）、`Locale.durationClock()`（floor 时钟格式）。 | observed |
| `test/token/accounting.test.ts:1-60` | tokenAccounting 测试 fixture 模式：`userMsg`/`assistantMsg`/`stepFinishPart` 最小化构造。 | observed |
| `test/cli/cmd/tui/exit.test.tsx:1-12` | 现有 ExitProvider signal/import 测试入口；R5 的真实 Session stdout 集成位于独立 `session-exit.test.tsx`。 | observed |
| `test/cli/cmd/tui/session-message-render.test.tsx` | 现有真实 Session/AssistantMessage `testRender` seam；R6 在此添加完成态 footer 行为断言。 | observed |
| `test/cli/tui/token-estimate.test.ts:1-253` | TUI token 显示测试：直接调用 `tokenAccounting` 验证数据，不渲染组件。 | observed |
| OpenAI Codex developer commands（`https://developers.openai.com/codex/developer-commands`） | 官方命令参考；可作为 Codex command-surface 对照，但不把未在官方页面复现的 CLI `/quit` 文本当作 OpenCode contract。 | observed (external) |
| Codex CLI usage/statusline evidence（`https://github.com/openai/codex/issues/10588`, `https://github.com/openai/codex/issues/21324`） | 公共 Codex issue 记录了 `/stats` 需求以及 persistent context/token statusline 方向，用于比较“按需统计/持续状态”而非复制完整设计。 | observed (external) |

## 5. Current Behavior

### 5.1 两条当前显示路径

**单个 Agent turn 完成路径**：

```text
assistant message completes (finish set)
  -> index.tsx AssistantMessage.final() = true
  -> footerVisible() = true
  -> footer renders: ▣ {Mode} · {model} · {duration} · interrupted?
  -> (prompt footer/sidebar continue showing live step/request values)
```

**Session 退出 stdout 路径**：

```text
/exit or /quit or /q
  -> app.exit command
  -> useExit().exit()
  -> ExitProvider.onBeforeExit()
  -> renderer.destroy()
  -> exit.message.get()
  -> process.stdout.write(text + "\\n")
```

Session route currently owns the text placed in `exit.message`:

```text
Session route
  -> exit.message.set(logo + Session title + Continue command)
  -> ExitProvider emits it after renderer destruction
```

### 5.2 当前显示样例

**Assistant message 完成态 footer**（消息流内，单个 turn 的永久记录）：
```text
▣ Primary · claude-sonnet-4-5 · 42s
```

中断时：
```text
▣ Primary · claude-sonnet-4-5 · interrupted
```

**Session 退出后的 stdout**（当前真实结构，logo 省略）：
```text
[OpenCode logo]

  Session   Fix parser bug
  Continue  opencode -s ses_01H...
```

这里没有 Session 累计 input、output、cost 或纯 input 记录。

**Prompt footer**（输入区下方，实时监控，完成后持久化最后 step 值）：
```text
↑ 1.2K ↓ 850 · 2.1K (45%) · $0.0123
```

窄屏（prompt width ≤ 90）：
```text
↑↓ 2.1K (45%) · $0.0123
```

**Sidebar context**（侧边栏，实时监控，完成后持久化活跃 turn 值）：
```text
Context
↑ 1.2K(3.4K) · ↓ 850(1.7K)
2,100 (3,400) tokens · 45%
$0.01 spent · ⚡ 234ms
```

**`/context` 面板**（按需打开）：
```text
Session Totals  Input 12.3K  Output 850  Reason 120  Cache W/R 8.2K/5.1K  Cost $0.0123
```

**`/status` 对话框**（按需打开）：MCP/LSP/Formatters/Plugins，不含 Session token 统计。

**`opencode stats` CLI**（独立命令）：跨 Session 聚合分析。

### 5.3 Gap 分析

存在两个独立的用户可观察缺口：

1. 单个 turn 完成态 footer 只显示 `mode · model · duration`，没有该 turn 的纯 input、output、cost 永久记录。
2. `/exit`、`/quit`、`/q` 的 stdout 只显示 Session title 和 Continue 命令，没有本次 Session 的累计统计。

`tokenAccounting` 已经是唯一的 Message/Part 统计 owner：

- `session.input` 已经是纯 input 累计（`cacheRead`/`cacheWrite` 分开保存）。
- `request.totalInput` 是既有实时上下文/上传总量，包含 cache read/write，prompt/sidebar 已依赖该语义。
- R7 为同一个 accounting 结果增加 `request.totalInputPure`，供指定 parent user 的完成态 footer 使用；不会复制第二套 Message/Part 遍历。

两个 UI surface 只消费同一 accounting owner 的不同范围：Session stdout 使用 `session` 累计，turn footer 使用指定 parent user 的 `request` 累计。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 完成的 assistant message（`finish` 非 `tool-calls`/`unknown`） | LLM stream 结束后 session 持久化 | `props.message.finish` 已设置，`props.message.parentID` 指向 parent user | `AssistantMessage` 组件 `final()` = true → `footerVisible()` = true → footer 渲染 | `index.tsx AssistantMessage` | observed |
| 多 step turn（tool calls → 最终响应） | agent loop 在同一 user request 下产生多个 assistant message | 所有 assistant message 共享同一 `parentID` | `tokenAccounting(..., requestUserID).request` 只选择 `parentID === requestUserID` 的 assistant message | `token/accounting.ts tokenAccounting` | observed |
| 中断的 assistant message（`MessageAbortedError`） | 用户中断 | `props.message.error?.name === "MessageAbortedError"`，可能有部分 step-finish parts | `footerVisible()` = true（error 分支），partial tokens 可用 | `index.tsx AssistantMessage` | observed |
| 无 step-finish parts 的历史 message | 旧数据或 fallback | `message.tokens` 可能存在（`msgHasFinish` fallback 路径） | `tokenAccounting` 的 request fallback 读取 message.tokens；session fallback 同时保留既有 session 累计 | `token/accounting.ts tokenAccounting` | reachable |
| `parentID` 缺失的 assistant message | 数据异常（理论不应发生） | 无 | 指定 request selection 不匹配，request pure input 为零；session aggregate 仍按既有 session owner 处理 | `token/accounting.ts tokenAccounting` | reachable |
| step-finish 中同时存在纯 input 与 cache read/write | Provider usage producer | `tokens.input`、`tokens.cache.read`、`tokens.cache.write` 是独立字段 | `tokenAccounting.session.input` / `request.totalInputPure` 仅读取 `tokens.input`；cache 字段继续由既有 accounting / `/context` 统计使用 | `token/accounting.ts tokenAccounting` | observed |
| Session exit request | 用户输入 `/exit`、`/quit` 或 `/q` | app command 已注册三个别名 | `app.exit` → `ExitProvider` → stdout | `app.tsx` + `context/exit.tsx` | observed |
| Session-specific exit text | Session route `exit.message.set` | 当前文本在 renderer 销毁后被读取 | `Session` createEffect 更新 formatter 输入；ExitProvider 原样写出 | `routes/session/index.tsx` + `exit-summary.ts` | observed |
| Signal-driven exit | `SIGINT`/`SIGTERM`/`SIGHUP` | ExitProvider 注册同一 stored-message emission path | signal handler → `exit()` → same Session stdout text | `context/exit.tsx` | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 完成态 footer 在 turn 完成后显示该 turn 的 token 用量（input + output）和费用，使用已有 `↑`/`↓`/`$` 格式 | 用户需求："适当显示一些有效信息来说明本次的session,我们的一些相应的统计或者一些记录" | 无（本方案新增） |
| INV-02 | `↑`、`↓`、`$` 三个显示字段分别只在自身非零时显示；全零时不显示 usage group | 用户需求："避免显示那些故意显示的信息" | 无（本方案新增） |
| INV-03 | 完成态 per-turn 的 `request.totalInputPure` 是纯 input 累计（只含 `tokens.input`，不含 cache read/write）；`output` 含 reasoning；`cost` 含全部 step-finish cost | 新增用户要求："纯input（不含cache）的累积"；`accounting.ts:149-160` 证明 cache 是独立字段 | 无（本方案新增） |
| INV-04 | `tokenAccounting` 的 optional requestUserID 仅累加指定 parent user 的 assistant message、latest step 和 in-flight contribution，不跨 turn 混入 | `accounting.ts:120-128` requestAssistantIDs 同口径；Session prompt 固定 assistant `parentID` | 无（本方案新增） |
| INV-05 | 显示格式保持 OpenCode 风格：`·` 分隔、`Locale.number()` 缩略、money 格式化 | prompt footer / subagent footer / sidebar 已有 `↑`/`↓`/`$` 约定 | 无（本方案新增） |
| INV-06 | queued user 只在其实际 assistant `parentID` 分桶中计入；coalesced orphan user 没有 assistant 时保持零 pure input | `MessageV2.latest()` 每轮取最新 user；assistant 创建时锁定 `parentID: lastUser.id`；prompt.ts:2162-2179 的 coalescing 处理 | 无（本方案新增） |
| INV-07 | Session stdout 退出文本在 renderer 销毁后仍包含原有 Session title/Continue 记录，并在有统计时增加一行 restrained Stats | `ExitProvider` 的 stdout emission contract + 原始需求 | 无（本方案新增） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-03 | `index.tsx:1775-1800` 完成态 footer JSX 只渲染 `mode · model · duration · interrupted?`，没有读取或渲染 token/cost 数据。 | `AssistantMessage` 组件 + `token/accounting.ts` | §5.2 当前 turn footer 无 token/cost；既有 accounting 没有 historical request selection 或 pure request field |
| INV-07 | `index.tsx:478-488` 的 `exit.message.set` 只拼接 logo、Session title、Continue，没有统计行；这是 Session 退出 stdout 缺少有效记录的第一个 divergence。 | Session route exit-message owner + `exit-summary.ts` formatter | §5.2 当前 stdout 样例无 Stats；`ExitProvider` 只负责原样发射，不拥有 Session 业务内容 |

本任务是 feature enhancement（非 bug），无 red-capable feedback loop 要求。两个 feature seams 是现有 `tokenAccounting` 的 request/session 结果和 Session-exit formatter；red slice 必须同时证明 pure input 与实际 stdout 文本。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 统一 token 统计与 request selection | `src/token/accounting.ts` | `tokenAccounting(messages, getParts, contextLimit?, requestUserID?)` 保持现有默认 active request，并新增 `request.totalInputPure` | 同一个单遍历 owner 同时产生 session pure input、指定 request pure input、既有 cache-inclusive request total 和 output/cost | TUI 不应内联 Message/Part 聚合；再增加独立 helper 会制造第二 authoritative traversal |
| 既有实时 request 统计 | `src/token/accounting.ts` | `tokenAccounting.request.totalInput` 继续包含 `tokens.input + cache.read + cache.write` | prompt/sidebar 已依赖该结果表示当前上下文/上传总量；保持现有契约避免改变非本需求 surface | 新增 pure fields 不授权修改既有 live monitoring 语义 |
| Session stdout 统计投影 | `src/cli/cmd/tui/routes/session/index.tsx` | 使用同一 accounting 结果的 `session.input`、`session.output + session.reasoning`、`session.cost` | Session route 已拥有 `exit.message.set`，可在 renderer 销毁前持续更新最终退出文本 | `ExitProvider` 只负责生命周期和 stdout emission，不应读取 Session messages 或计算 token |
| 完成态 footer 渲染 token/cost | `index.tsx AssistantMessage` | footer 在 `footerVisible()` 时渲染 `↑{input} ↓{output} · {cost}` | footer 已渲染 `mode · model · duration`，是 turn 永久记录的唯一展示点 | prompt footer 是 live step 监控；sidebar 是 live turn 监控；都不是永久记录 |
| Session exit 文本格式化 | `routes/session/exit-summary.ts` | 纯 formatter 保留 logo/Session/Continue，条件性增加 Stats 行 | 从 Session route inline JSX/string 拼接中抽出可测试的真实 stdout seam | generic ExitProvider 不拥有 Session title/stats/Continue 的业务格式 |
| 格式化 | `util/locale.ts` + `Intl.NumberFormat` | `Locale.number()` + money format | 已有 K/M 缩略和 currency 格式化口径 | 不新建格式化器 |

## 10. Single Approved Primary-Path Design

### 10.1 数据层：扩展现有 `tokenAccounting` owner

不新增 `turnTotals`。扩展现有 `tokenAccounting` 的 request selection 和返回数据，使一个单遍历继续成为所有 TUI usage consumer 的 authoritative path：

```text
tokenAccounting(messages, getParts, contextLimit?, requestUserID?)
  -> requestUserID 未提供：保持现有 active user / queued orphan 选择逻辑
  -> requestUserID 已提供：选择该 parent user 的 assistant message 集合，并选择该集合的 latest assistant/parts
  -> requestUserID 已提供且目标不是全局 latest assistant 的 parent：request 只使用已确认/legacy 数据，禁止全局 latest step 的 in-flight contribution
  -> 单次遍历同时累加：
       request.totalInput       += tokens.input + cache.read + cache.write  // 既有实时口径
       request.totalInputPure   += tokens.input                              // 新增完成态口径
       request.totalOutput      += tokens.output + tokens.reasoning
       request.cost             += p.cost ?? 0
       session.input            += tokens.input                              // 既有纯 input session 累计
       session.cacheRead/Write += cache fields
  -> 无 step-finish 时沿用 message.tokens fallback；pure input 只取 message.tokens.input
  -> return { request, session, ...existing fields }
```

`requestUserID` 是同一主算法的受支持 request-selection 分支，不是备用成功路径。默认调用方不传该参数，现有 prompt/sidebar/subagent/context 语义保持不变；AssistantMessage footer 传入自己的 `parentID`，从同一个结果读取 `request.totalInputPure`。显式历史 parent 会同时约束 selected latest step、`request.totalOutput` 和 in-flight gate，不能读取后续 turn 的流式 output；Session stdout 使用同一个结果的 `session` 字段。

**Fallback 口径说明：** 默认 active request 继续执行现有 pre-stream upload estimate 去重规则；显式 `requestUserID` 用于已完成历史 turn 时，legacy message.tokens fallback 的 pure input 直接取 `message.tokens.input`，不取 cache，output/reasoning/cost 继续保留。只有显式 target 与全局 latest assistant 属于同一 parent 时，才允许使用当前 step 的 in-flight contribution。

这条路线直接修复 R3 审计指出的 duplicate aggregation：不保留第二个 parent/Part/fallback 实现，所有统计都来自 `tokenAccounting` 的一次遍历。

### 10.2 渲染层：完成态 footer 增强

在 `index.tsx` `AssistantMessage` 组件中，将当前 assistant 的 `parentID` 传给同一 `tokenAccounting` owner；在 footer 的 `duration` 之后、`interrupted` 之前插入 token/cost：

```text
input (assistant message completes)
  -> final() = true, footerVisible() = true
  -> tokenAccounting(messages, getParts, undefined, props.message.parentID).request memoized as turnUsage
  -> footer renders: ▣ {Mode} · {model} · {duration} · {usage?} · interrupted?
  -> formatUsageStats 独立门控 ↑input、↓output、$cost；全零时不插入 usage group
```

`↑` 是完成态 turn 的纯 input 累计，不是既有实时 `request.totalInput` 的 cache-inclusive 总量；因此同一 turn 在 sidebar 中的括号累计值可能大于完成态 footer 的 `↑`，这是两个已声明的统计口径。

预期的单 turn 完成态样例：
```text
▣ Primary · claude-sonnet-4-5 · 42s · ↑12.3K ↓970 · $0.01
```

这里 `↑12.3K` 是该 parent user 的纯 input 累计；同一 turn 的 cache read/write 不进入 `↑`。

### 10.3 Session 退出 stdout 增强

在 `Session` route 的现有 `exit.message.set` 位置，先用同一 `tokenAccounting(messages(), getParts)` 读取 Session 级结果，再交给 `formatSessionExitMessage`：

```text
Session messages/parts
  -> tokenAccounting(...).session
  -> { input: session.input, output: session.output + session.reasoning, cost: session.cost }
  -> formatSessionExitMessage(...)
  -> exit.message.set(formattedText)
  -> ExitProvider destroys renderer and writes the same text to stdout
```

Stats 行只在至少一个字段非零时增加；`↑input`、`↓output`、`$cost` 各自独立省略零值。保留现有 title 和 Continue 行；不显示 cache、context 百分比、tool 数量或 stats dashboard。

### 10.4 Session 退出预期显示样例

正常 Session 退出（logo 省略）：
```text
[OpenCode logo]

  Session   Fix parser bug
  Stats     ↑12.3K ↓970 · $0.01
  Continue  opencode -s ses_01H...
```

其中 `↑12.3K` 是 Session 全部实际 assistant usage 的纯 input 累计，即使 cache read/write 另有数值，也不加到 `↑`；`↓970` 是 output + reasoning；`$0.01` 是 Session cost。

无 usage 的空 Session 保持当前简洁输出，不人为添加 `Stats 0`：
```text
[OpenCode logo]

  Session   Empty session
  Continue  opencode -s ses_01H...
```

input-only 的中断/未产出输出场景不显示无意义的 `↓0` 或 `$0.00`：
```text
[OpenCode logo]

  Session   Interrupted session
  Stats     ↑1.2K
  Continue  opencode -s ses_01H...
```

### 10.5 为什么两条显示路径共享一个 owner

两条显示路径都是同一 `tokenAccounting` 结果的不同 projection：turn footer 选择一个 `parentID` 的 request，stdout 读取全 Session 的 session aggregate。这样 queue/coalescing 只影响 assistant 的既有 parentID 归属，不会在两个显示 surface 中产生不同的聚合算法。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `tokenAccounting` optional request selection | proposed | primary-contract branch；同一遍历为 active/default 或指定 parent user 产生 request 结果 | yes | 100% 的 request/session token 数据 | add |
| `tokenAccounting` message.tokens fallback | current + extended | existing compatibility；pure input 只取 `message.tokens.input`，不取 cache | yes | <10%（仅无 step-finish 的 legacy message） | preserve |
| prompt footer `↑/↓` step 显示 | current | 不变——live monitoring，不同职责 | N/A | N/A | preserve |
| sidebar context `input(totalInput)` | current | 不变——live monitoring，不同职责 | N/A | N/A | preserve |
| `/context` Session Totals | current | 不变——按需面板 | N/A | N/A | preserve |
| AssistantMessage completed footer | proposed | 从同一 request 结果显示 pure input/output/cost | yes | 只读 accounting result | add |
| Session stdout Stats line | proposed | 从同一 session 结果显示 pure input/output/cost | yes | 只读 accounting result | add |
| `ExitProvider` stdout emission | current | generic renderer teardown + stored text emission | yes | N/A | preserve |

New alternate success path count: 0。R4 不新增第二套 Message/Part aggregation；两个显示面都读取现有 `tokenAccounting` 的同一结果。`requestUserID` 是 primary contract 的 supported selection，不是失败后的备用成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Session route 内联 exit 文本拼接 | 便于当前 Session route 直接设置 `exit.message` | 抽出同一 formatter 以便 stdout 行为测试，并在原位置继续调用 | `routes/session/index.tsx` → `routes/session/exit-summary.ts` |

不删除任何兼容 workaround；只把已有 exit 文本拼接 collapse 到被同一 owner 调用的纯 formatter。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 完成态 footer 显示 token/cost | `tokenAccounting(..., parentID).request` → `formatUsageStats` → footer | `accounting.ts` + `index.tsx` + `exit-summary.ts` + `session-message-render.test.tsx` | 真实渲染后的 footer 包含正确 `↑`/`↓`/`$` |
| INV-02 零值不显示 | `formatUsageStats` 对每个字段独立门控；全零返回 undefined | `exit-summary.ts` + both consumers + `session-message-render.test.tsx` | input-only 不出现 `↓0`；cost=0 不出现 `$0.00`；全零无 usage 行 |
| INV-03 纯 input 统计口径 | `request.totalInputPure` / `session.input` 只累加纯 input | `accounting.ts` | 非零 cache fixture 下 pure input 只等于 input literal |
| INV-04 不跨 turn 混入 | `tokenAccounting(..., requestUserID)` 按 parentID 选择 request assistant 集合 | `accounting.ts` | 多 turn 场景下指定 request 只返回对应 parent 的累计 |
| INV-05 OpenCode 格式 | `formatUsageStats` 使用 `Locale.number()` + money format | `exit-summary.ts` | footer/exit 使用统一 `↑`/`↓`/`$` 格式 |
| INV-06 queued/coalesced turn 边界 | assistant 创建时的 parentID 分桶 + 空桶零值 | `accounting.ts` + existing prompt lifecycle | queued new user 不进入旧 parent；orphan parent request pure input 为零 |
| INV-07 Session stdout 文本 | Session `exit.message.set` → formatter → ExitProvider stdout | `index.tsx` + `exit-summary.ts` + `session-exit.test.tsx` | 正常退出保留 title/Continue 并增加 Stats；空 Session 不增加 0 行 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `tokenAccounting` request selection + `totalInputPure` | INV-01, INV-03, INV-04, INV-06 | 现有函数已拥有唯一 Message/Part 遍历、active request selection、session pure input 和 cache 分列 | 需要把历史 parent selection、selected latest step 和 pure request input 纳入同一 authoritative pass，避免 R3 的第二算法 |
| `formatUsageStats` | INV-01, INV-02, INV-05, INV-07 | 两个显示 surface 需要同一逐字段零值门控和格式，避免 stdout/footer 数字口径漂移 | 既有 prompt/sidebar 各自局部格式，不能承载新的共同永久显示语义 |
| `formatSessionExitMessage` | INV-07 | 当前 exit 文本在 Session route 内联，ExitProvider 只发射字符串 | 需要可直接测试的真实 stdout text seam，同时保留 Session/Continue 内容 |
| Session route `exitUsage` projection | INV-03, INV-07 | Session route 已经拥有 messages、parts、session title/id 和 `exit.message.set` | generic ExitProvider 不应读取 Session 数据；stats CLI 也不属于当前 Session exit |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/token/accounting.ts` | modify | 扩展 `tokenAccounting` 的 optional `requestUserID` selection、selected latest step/in-flight scope 和 `request.totalInputPure`，保留既有 `totalInput` cache-inclusive 语义 | +36 |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts` | add | 提供逐字段 zero suppression 的 `formatUsageStats` 和 `formatSessionExitMessage`；保留 logo/Session/Continue，条件增加 Stats 行 | +38 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Session route 用 session accounting 更新 exit message；AssistantMessage 用指定 parentID 的 request accounting 更新 completed footer | +28 |
| `packages/opencode/test/token/accounting.test.ts` | modify | 验证 pure input、指定 parent request、历史 parent 不受当前流式 assistant 污染、queued/coalesced 分桶、legacy fallback 和既有 cache-inclusive request 回归 | +95 |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | add | 使用真实 testRender、Session、ExitProvider 和 stdout capture 验证正常 Session stdout、零 usage、省略 cost 和 Continue/title 保留 | +95 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 使用现有真实 Session renderer fixture，验证完成态 AssistantMessage footer 的 pure input、output+reasoning、cost 和 zero suppression | +45 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `tokenAccounting` 对含 cache 的单 step request 返回 pure input=100、既有 totalInput=125 | 当前没有 `totalInputPure` | 同一 step-finish 累加 `totalInput` 和 `totalInputPure` 两个明确字段 | 新增 pure input 契约；既有 cache-inclusive consumer 不回归 |
| 2 | 指定 `requestUserID` 时只累计该 parent 的多 step request；旧 parent 完成后，即使另一 parent 正在流式输出，旧 request.totalOutput 也不变化 | 当前只能选择 active request；全局 latest assistant/stepOutput 会污染显式历史 request | 将 requestAssistantIDs、selected latest assistant/parts 和 in-flight gate 统一绑定到 request scope，仍一次遍历 | slice 1 不回归 |
| 3 | legacy message.tokens fallback 的 pure input 只取 input，不取 cache；active request 原有 estimate 去重继续通过 | 当前无 pure request 字段 | 在同一 fallback 分支维护 `totalInputPure`，保留现有 `totalInput` 规则 | slice 1-2 不回归 |
| 4 | queued/coalesced 场景中，旧 orphan parent request pure input 为零，新 parent 获得 assistant 的 pure input | 仅按消息顺序或错误 parent 会错配 | 以 assistant 稳定 `parentID` 选择 request | slice 1-3 不回归 |
| 5 | `session.input` 是所有实际 assistant step 的 pure input 累计，output 包含 reasoning，cost 保持总量 | Session exit 没有统计 projection | 直接消费同一 accounting.session，不新增 session aggregation | slice 1-4 不回归 |
| 6 | `formatUsageStats` 对 input-only、output-only、cost-only 分别只生成非零字段，全零返回 undefined | 无共同 formatter，整组门控会产生 `↓0` | 实现逐字段门控和统一格式 | footer/exit 两个 consumer 不回归 |
| 7 | 真实 Session route → `ExitProvider.exit()` → stdout 对 populated Session 保留 Session/Continue 并插入 Stats；空 Session 不显示 `Stats 0` | 当前 route/ExitProvider 输出无 Stats，且没有该集成测试 | 抽取 inline 文本、挂回 Session route，并在真实 renderer harness 中捕获 stdout | 实际 stdout 输出契约 |
| 8 | 真实 `AssistantMessage` 渲染在 completed turn 中显示 pure input、output+reasoning、cost；input-only 不显示 `↓0`；全零 usage 不显示 usage 字段 | 当前 JSX 没有 usage，且没有针对该 footer 的渲染断言 | 在 `session-message-render.test.tsx` 现有 `testRender` seam 添加多 step/cache/reasoning/input-only fixture 和行为断言 | INV-01/INV-02 的真实 UI 回归 |

测试使用 `test/token/accounting.test.ts` 已有的 `userMsg`/`assistantMsg`/`stepFinishPart` fixture 模式，通过结构匹配传入 `tokenAccounting` 的内部窄类型，不与 SDK Message schema 耦合。expected value 使用独立 literal：input=100、cache read=20、cache write=5 时，预期 `totalInputPure=100`、既有 `totalInput=125`。queued/coalesced slice 以 parentID 归属构造 user orphan 和新 parent。

历史 request 隔离 slice 使用两个 parent：旧 parent 有已完成 step-finish output=200；新 parent 的 latest assistant 未完成并有 live text/reasoning。显式选择旧 parent 时预期 totalOutput 固定为 200，不能随新 parent 的流式 parts 增长。

`session-exit.test.tsx` 使用现有 TUI `testRender` harness，挂载真实 `ExitProvider`、`SyncProvider` 和 `Session` route；等待 route 将最终文本写入 `exit.message`，再调用真实 `ExitProvider.exit()` 并临时捕获 `process.stdout.write`。断言去 ANSI 后的 stdout 内容，覆盖 populated/empty Session。`session-message-render.test.tsx` 通过同一真实 `Session`/`AssistantMessage` renderer seam 观察完成 footer 文本；两个测试都不以 source-text 或私有调用次数作为 acceptance。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~230 | 排除 import、formatting、pure move；按 §15/§19 的 accounting、formatter、route 和三组行为测试估算 |
| Required Chinese explanatory comments `C` | `max(1, ceil(230 * 0.15)) = 35` | `if E > 0: C >= max(1, ceil(E * 0.15))` |

需要中文注释的位置：

1. `tokenAccounting` request selection：解释显式 parentID 与 active queued-orphan 选择为何共用一个统计 owner。
2. `totalInputPure` 累加：解释纯 `tokens.input` 与既有 cache-inclusive `totalInput` 并存的真实 consumer 边界。
3. message.tokens fallback：解释 active pre-stream estimate 去重与 historical explicit parent pure input 的不同条件。
4. Session `input` projection：解释 Session stdout 使用 pure input，而 cache 仍由 session cache 字段保留。
5. `formatUsageStats` 零值门控：解释为何两个显示 surface 都不渲染 `Stats 0`。
6. `formatSessionExitMessage`：解释为何保留 Continue 记录并只增加一行 Stats，避免把 stats dashboard 搬入退出文本。
7. `AssistantMessage` request selection：解释完成 footer 使用当前 message.parentID，避免 queued/coalesced user 归属漂移。
8. footer/exit shared formatter：解释两个输出必须共享相同 token/cost 格式，防止显示口径分叉。
9. selected latest/in-flight gate：解释历史 parent 为什么禁止读取当前其他 parent 的流式 output。
10. 独立字段 zero suppression：解释 input-only/output-only/cost-only 为什么分别省略零字段。

实施时至少添加 35 行符合门禁的中文解释性注释；注释应分布在 accounting selection、pure/cache 边界、selected latest/in-flight gate、逐字段 zero suppression、exit formatter、真实 stdout harness 和 footer renderer fixture 附近，不得集中堆放或重复代码流程。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/token/accounting.test.ts` | `packages/opencode` | `tokenAccounting` pure input、request selection、queued/coalesced 和既有 cache-inclusive 口径全部 pass |
| `bun test test/cli/tui/token-estimate.test.ts` | `packages/opencode` | `tokenAccounting` 既有测试不回归 |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` | `packages/opencode` | 真实 `Session` route → `ExitProvider.exit()` → `process.stdout.write` 输出：Stats、纯 input、zero suppression、Session/Continue 保留 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | 真实 `AssistantMessage` completed footer 显示 pure input、output+reasoning、cost，并抑制全零 usage |
| `bun typecheck` | `packages/opencode` | 类型安全，无 `any` |
| `bun dev`（tmux 手动验证） | `packages/opencode` | 单 turn 完成 footer 显示 pure `↑`/`↓`/`$`；输入 `/quit` 后 stdout 显示 Session Stats；空 Session 不显示 `Stats 0` |
| `bun test test/cli/tui/context-usage.test.ts` | `packages/opencode` | `/context` 既有 Session Totals 和 cache 展示不回归，证明纯 input 新口径未改变该面板 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2 | 新增 `routes/session/exit-summary.ts` 和真实 `session-exit.test.tsx` |
| Files modified | 4 | accounting.ts + index.tsx + accounting.test.ts + session-message-render.test.tsx |
| Files deleted | 0 | 无删除 |
| Production lines | ~102 | accounting ~36 + exit-summary ~38 + index.tsx ~28 |
| Test lines | ~235 | accounting ~95 + stdout integration ~95 + AssistantMessage footer regression ~45 |
| Generated lines | 0 | 无生成 |

Implementation complexity cap: effective changed lines must remain below 1,800 and the complete path must remain within 12 files. The current plan estimates 6 files and ~337 total changed lines, leaving substantial margin without authorizing unrelated work.

## 20. Real Risks and Open Decisions

### Real Risks

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| footer/exit 行过长在窄终端截断 | 模型名 + token + cost 可能在 <80 列终端超出消息宽度 | footer 使用 `wrapMode="none"`；stdout Stats 保持单行，token 用 `Locale.number()` K/M 缩略 |
| 每个完成 message 显示 pure request usage 可能触发 accounting 重算 | `AssistantMessage` 组件为视口内每个 message 实例化 | 使用 createMemo；所有计算仍走一个 `tokenAccounting` owner，不新增第二遍历算法；只对完成态 footer 读取显式 parentID |
| v2 迁移期间 v1/v2 footer 不一致 | v2 是 in-progress 迁移目标，不属于本次 v1 production Session/exit surface | 本方案仅修改 v1（§2 已将 v2 排除）；v2 parity 待迁移完成后独立处理 |
| pure input 与既有 cache-inclusive total 同时存在 | `tokenAccounting.request.totalInput` 被 prompt/sidebar 使用，`request.totalInputPure`/`session.input` 为新增永久显示口径 | 在类型、shared formatter、plan 文档和中文注释中明确两个 consumer 的语义；只新增字段，不改变既有实时 consumer |
| ExitProvider 销毁 renderer 后仍需拿到最新 Stats | `ExitProvider` 在 `onBeforeExit` 后才读取 message，但 exit message 由 Session route reactive effect 更新 | Session route 在 messages/parts 变化时持续设置 formatter 结果；ExitProvider 只读取最终 stored text，不重新聚合 |
| 真实 stdout harness 的全局 write 捕获 | 测试必须观察 `ExitProvider` 的 `process.stdout.write`，且不能污染同文件其他测试 | 测试串行执行，捕获前保存原 write，断言后在 finally 恢复；只在该集成 slice 使用边界 stub |

### Open Decisions Requiring the User

无。用户已明确要求同时设计 turn 完成和 Session stdout；R7 已获得完整 `APPROVE`，可以按批准范围实施。实施审计和用户明确要求的 `commit --only` 仍未完成前，不得宣称终态完成。

### Rejected Speculation

| Concern | Why rejected |
| --- | --- |
| 显示 session 级累计汇总块 | sidebar 已有 session 累计，`/context` 已有 Session Totals——新增会造成三处冗余 |
| 把 prompt/sidebar 的 `request.totalInput` 一并改成 pure input | 当前 `request.totalInput` 有已测试的 cache-inclusive 上下文总量契约；新增要求约束新增完成显示，扩大到 live surfaces 会改变既有行为且无独立授权 |
| 显示 tool 调用次数或文件修改数 | 用户明确说"我们没必要把每一个内容都显示清楚"——这些是 `opencode stats` 的职责，不属于 session 内完成态 footer |
| 显示 context window 占用百分比 | prompt footer 和 sidebar 已有 `%` 显示——完成态 footer 的职责是 turn 记录而非实时 context 监控 |
| 连接 `opencode stats` CLI 数据到 session 内显示 | stats 是跨 session 聚合分析，与单 turn 完成记录职责不同；用户说"不要过分设计" |

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
| 1 | R1 | yes | B-01: v2 file change structurally infeasible—`SessionMessageAssistant` has no `parentID`, no `getParts`, no step-finish parts in `content`; `turnTotals` cannot be invoked; "v1/v2 一致" claim is false for multi-step turns | N-01: fallback pseudocode omits `latestRequestAssistant` input exclusion while claiming consistency; N-02: forward-traceability references non-existent `.total` field; N-03: interrupted example shows `$0.00` contradicting INV-02; N-04: examples use lowercase `k` but `Locale.number()` produces uppercase `K`; N-05: plan does not state whether `tokenAccounting` delegates to `turnTotals` | BLOCK | task ses_093f399e3ffe2M2up6vmEEwfHW |
| 2 | R2 | yes | None | N-01: display samples use non-existent `0:42` duration format (`durationClock` produces `42s`); N-02: `money` "reuse" terminology imprecise (module-local `const`, not shared export) | APPROVE | task ses_093e87a2bffe38cHTO801R7lJP |
| 3 | R3 | yes | B-01: The plan targets turn completion instead of Session exit; `/exit`/`/quit`/`/q` stdout path and Session-specific exit message are absent. B-02: Proposed verification cannot detect failure of requested Session-end display; no behavior-sensitive exit stdout test. B-03: `turnTotals` creates a second authoritative token-aggregation path duplicating `tokenAccounting` parent selection, Part traversal, accumulation, and fallback semantics. | Codex comparison lacks reproducible citation/captured `/quit` output; formatting is broadly consistent. | BLOCK | task ses_093b35306ffeR5P1AFSaOuGb0T |
| 4 | R4 | yes | B-01: Exit-display verification does not exercise the real Session-exit producer-to-consumer path; direct formatter tests observe neither Session route nor ExitProvider emission. B-02: One verification command targets nonexistent `test/cli/cmd/tui/context-usage.test.ts`; actual path is `test/cli/tui/context-usage.test.ts`. | N-01: missing concrete expected completed-turn footer sample; N-02: Codex comparison lacks concrete captured termination sample; N-03: signal-driven ExitProvider path not explicit in supported-domain/tests; N-04: comment-budget estimate lacks explicit minimum line commitment. | BLOCK | task ses_0939ff466ffeSpnfM5aP7D1H9t |
| 5 | R5 | yes | B-01: Completed-turn footer has no executable behavior-sensitive verification through real AssistantMessage rendering; accounting/formatter/stdout tests cannot prove footer JSX displays pure input/output/cost or suppresses zero usage. | N-01: planned `exit-summary.ts` is described as an R4 existing seam although it is planned/new; N-02: Codex comparison has no reproducible concrete termination sample; N-03: E estimate does not exactly align with file estimates. | BLOCK | task ses_093995557ffeWPb7UNKUax5Hv2 |
| 6 | R6 | yes | B-01: Explicit historical request selection still mixes the current streaming turn's output because global latestAssistant/stepOutput/inFlight totals are not scoped to requestUserID. B-02: Canonical revision identity was not unique because the header still said R5 while the file recorded substantive R5→R6 changes. B-03: Partial-zero display semantics conflict with INV-02; input-only usage would render `↓0`, and no real footer/exit test covers independent field suppression. | N-01: Codex termination research still lacks a reproducible sample. N-02: E/C estimate differs from file delta estimates but retains the actual ratio formula. | BLOCK | task ses_09392f8d6ffeW3ULORVqe6J3qa |
| 7 | R7 | yes | None | N-01: Codex comparison is qualitative rather than a directly captured termination transcript; N-02: the plan could distinguish new permanent pure-input surfaces from existing cache-inclusive live surfaces more explicitly; N-03: the real stdout test must preserve serialized capture and restoration in `finally` | APPROVE | task ses_0937aac5effejtOcySNI3t0X1g |

R1→R2 修订：B-01 resolved by dropping v2 from §15/§17 (v2 data model cannot support `turnTotals`; v2 is debug surface user did not require). N-01 resolved by explicitly documenting fallback口径差异. N-02 resolved by using `input + output > 0 || cost > 0` condition. N-03 resolved by omitting `$0.00` from interrupted example. N-04 resolved by using uppercase `K` in examples. N-05 resolved by stating `tokenAccounting` is not refactored.

R2→R3 修订：记录新增用户要求——完成态 `turnTotals.input` 改为纯 `tokens.input` 累计，不含 cache read/write；保留既有 `tokenAccounting.request.totalInput` 的 cache-inclusive 实时契约；补充 cache 非零测试、queued/coalesced parentID 分桶测试和对应 traceability/comment/verification 证据。

R3→R4 修订：按用户明确要求同时覆盖单 turn 完成 footer和 Session 退出 stdout；以现有 `tokenAccounting` 作为唯一 Message/Part 聚合 owner，移除 `turnTotals` 第二算法设计；新增 `request.totalInputPure`、Session exit formatter、实际 stdout 行为测试，并保留既有 `request.totalInput` cache-inclusive 实时契约。

R4→R5 修订：真实集成测试通过 `testRender` 挂载 Session route、ExitProvider 和 SyncProvider，调用真实 `ExitProvider.exit()` 并捕获 stdout；修正 context-usage 测试路径；补充完成态 footer 样例、signal 共享退出路径说明和显式中文注释最低行数承诺。

R5→R6 修订：在现有 `session-message-render.test.tsx` 真实 AssistantMessage renderer seam 增加多 step、cache、reasoning、cost 和 zero suppression 行为测试；补充文件/traceability/verification 映射，修正 planned formatter 的时间描述和 E/文件估算记录。

R6→R7 修订：将显式历史 request 的 selected latest assistant、step/in-flight contribution 和 final totals 全部绑定到 requestUserID；将 usage formatter 改为 `↑`/`↓`/`$` 独立 zero suppression；同步补充 input-only fixture、历史 parent 与新流式 parent 隔离测试，并将实现预算固定为不超过 12 个文件、1800 个有效变更行。

### R7 Independent Auditor Verdict (verbatim)

Blocking findings

No blocking findings.

Release verdict

**APPROVE**

Revision **R7** passes this full-scope plan audit with no blocking findings. Approval applies only to the exact audited canonical revision **R7**; implementation is allowed for that revision.

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

Implementation completed for approved revision R7; no further material changes are allowed without a new plan revision and full re-audit.

### Actual Files and Diff

- `packages/opencode/src/token/accounting.ts`: same single accounting traversal now supports optional `requestUserID` selection and `request.totalInputPure`; existing cache-inclusive `request.totalInput` is preserved.
- `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts`: new shared usage/Session-exit formatter with independent field suppression.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`: Session route projects `session` totals into stored exit text; completed AssistantMessage projects scoped request totals into the footer.
- `packages/opencode/test/token/accounting.test.ts`: pure/cache separation, historical parent isolation, and legacy message-token fallback behavior.
- `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx`: formatter, real Session route, real ExitProvider, stdout capture, and empty Session behavior.
- `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`: real completed footer and input-only zero suppression behavior.
- `docs/plans/session-end-display-enhancement.md`: implementation evidence and audit state only; no additional production scope.

Tracked implementation diff: 276 added / 33 deleted lines across the four pre-existing implementation/test files; new formatter/test files contain 53 and 262 lines respectively. The full task remains within 7 paths including the canonical plan, 6 implementation paths, and the approved 12-file/1800-effective-line cap.

### Red-Green Test Evidence

| Slice | Red evidence | Green evidence |
| --- | --- | --- |
| Pure request input | `totalInputPure` was `undefined`; existing `totalInput` alone could not satisfy pure input. | `bun test test/token/accounting.test.ts`: 4 pass. |
| Historical request scope | Explicit old parent expected output `200`, received global latest `900`. | Same accounting suite: 4 pass, including parent isolation. |
| Legacy historical fallback | Explicit historical `message.tokens.input=77` returned pure input `0`. | Same accounting suite: 4 pass, including fallback. |
| Shared formatter | New formatter module was missing. | `bun test test/cli/cmd/tui/session-exit.test.tsx`: 3 pass, including input+cost, output+cost, cost-only, input-only, normal, and all-zero shapes. |
| Session stdout | Real ExitProvider output preserved Session/Continue but had no `Stats` row. | Same Session exit suite: 3 pass; normal and empty output covered through real route → ExitProvider → stdout. |
| Completed footer | Real renderer showed mode/model/duration but no `↑12.3K`, timing out the behavior predicate. | `bun test test/cli/cmd/tui/session-message-render.test.tsx`: 71 pass; reasoning, input-only, multi-step cumulative, and all-zero footer covered. |

Implementation audit round 1 rework:

- B-01 resolved at `formatUsageStats`: flow fields and cost now retain semantic identity before zero suppression, so every positive cost following token flow receives ` · `.
- B-02 resolved through the already approved seams: sparse formatter matrix, nonzero reasoning in real stdout/footer, two-assistant same-parent cumulative footer, and completed all-zero footer are behaviorally asserted.
- N-02 corrected without changing behavior: stdout interception now uses typed `spyOn`, and readiness returns a narrowed ExitProvider function without a non-null assertion.

### Verification Commands and Results

All commands ran from `packages/opencode` unless noted:

- `bun test test/token/accounting.test.ts` — pass, 4 tests.
- `bun test test/cli/tui/token-estimate.test.ts` — pass, 11 tests.
- `bun test test/cli/cmd/tui/session-exit.test.tsx` — pass, 3 tests.
- `bun test test/cli/cmd/tui/session-message-render.test.tsx` — pass, 71 tests.
- `bun test test/cli/tui/context-usage.test.ts` — pass, 14 tests.
- `bun typecheck` — pass (`tsgo --noEmit`).
- `git diff --check` for tracked implementation files — pass.
- `tmux new-session -d -s opencode-dev 'bun dev'` manual path — not run because `tmux` is unavailable on this Windows environment; no replacement command is claimed as equivalent.

The full renderer suite emitted a non-failing OpenTUI listener warning; an earlier pre-rework run also emitted a non-failing temporary KV cleanup warning while all tests passed. These are existing test-harness/environment warnings, not assertion or typecheck failures.

### Original Feedback-Loop Result

Not applicable: this is a feature enhancement, not a bug/regression report. The required red-capable behavior loops were created and executed for each new surface above.

### Actual Secondary and Replacement Path Inventory

- `requestUserID` is a supported selection branch inside the existing `tokenAccounting` primary traversal, not an alternate success path.
- `message.tokens` remains the existing shipped legacy compatibility path; only its explicit historical pure-input projection is extended.
- `ExitProvider` remains the existing generic renderer teardown/stdout emission path and does not gain Session accounting responsibility.
- No new fallback, catch-and-success, duplicate Message/Part traversal, feature flag, dependency, or public configuration path was added.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ≈360 | Independent implementation audit count excluding imports, blank lines, formatting-only changes, unchanged code, and pure movement. |
| Qualifying Chinese comment lines `C` | ≈63 | Independent count distributed beside request selection, pure/cache ownership, historical fallback, in-flight gate, exit lifecycle, sparse formatter rules, and behavioral fixtures. |
| Ratio `C / E` | ≈17.5% | `63 / 360`. |
| Required minimum `C` | 54 | `ceil(360 * 0.15) = 54`; gate passes. |

### Remaining Unverified Items

- Manual interactive `bun dev` footer and `/quit` verification remains unverified because `tmux` is unavailable on this host. The real renderer and real stdout integration tests cover the same producer/consumer seams.
- Codex termination behavior is qualitative external comparison only; the plan does not claim a captured Codex transcript.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01: sparse usage fields lose the required cost separator; B-02: approved behavior-sensitive verification is incomplete for sparse composition, reasoning inclusion, multi-step pure-input accumulation, and all-zero completed footer | N-01: all-zero formatter wording says `undefined` in parts of R7 while implementation returns an empty string; N-02: stdout harness has avoidable type assertions; N-03: recorded command results were not independently reproduced by the auditor; N-04: Codex comparison remains qualitative | BLOCK | task ses_0935ad1a1ffecmB1hn3i9h7zAg |
| 2 | R7 | yes | None | N-01: Codex comparison remains qualitative; N-02: Session renderer test harness emits a non-failing EventTarget listener warning; N-03: plan wording around formatter returning `undefined` is stale while implementation returns an equivalent empty string | APPROVE | task ses_0934ffe4dffegBq4uo15Or7oXt |

### R2 Independent Implementation Auditor Verdict (verbatim)

Blocking findings

No blocking findings.

Release verdict

**APPROVE**

The actual audited implementation satisfies the approved R7 primary path, covers both requested permanent display surfaces, preserves existing live-monitoring semantics, passes the relevant tests and typecheck, and has no blocking findings.

### R1 Independent Implementation Auditor Verdict (verbatim)

Blocking findings

### B-01 Sparse usage fields lose the required cost separator

Filtering the fields before indexing them changes the field positions. For `{ input: 1200, output: 0, cost: 0.01 }`, the formatter produces `↑1.2K $0.01`, not the contracted `↑1.2K · $0.01`. The same malformed text reaches both the completed footer and Session exit stdout.

### B-02 Approved behavior-sensitive verification is incomplete

The approved test matrix does not cover the reachable input-plus-cost/output-zero shape, output-only or cost-only formatting, nonzero reasoning inclusion, multi-step pure-input accumulation through the completed footer, or an all-zero completed footer. Incorrect implementations can therefore pass the current acceptance tests.

Release verdict

**BLOCK**

The exact R7 implementation cannot be released. A correction requires another complete implementation audit of the full original scope and affected interfaces.

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

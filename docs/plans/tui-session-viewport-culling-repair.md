# Canonical Implementation Plan: TUI Session Viewport Culling Repair

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户在当前 Session GOAL 中提供的原始需求，以及“注意内容整体要写在一个 plan 里面”的追加要求
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-21（R2 实现获独立审计 APPROVE：No blocking findings；N-01..N-03 non-blocking 已记录）

This file is the sole implementation specification for this task. Chat summaries,
temporary harnesses, superseded plans, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 当前需要优化我们已有的TUI截断culling以及优化机制,同时避免大规模修改相应加载机制，不得因为无理由或者本身过度苛责的审计而扩大修改范围，不需要优化或者修改既有风险点,保持精准的手术刀级别的点点修改即可，也就是尽涉及不超过4个生产代码文件,不超过400行生产代码。同时不引入新的退化。

> 注意内容整体要写在一个 plan 里面。

本 plan 还必须保留完整的根因、调用链、已验证证据、已排除假设、测试反馈环、范围边界、审计记录和实施证据；不得把同一任务拆成第二份设计规范。

## 2. Explicit Non-Goals

- 不修改 `sync.session.sync()`、Message 数量窗口、HTTP 分页、Session `/diff`、SummaryCache、Solid store 或数据库历史数据。
- 不修改 OpenTUI core、Zig/native buffer、Tree-sitter、renderer scheduling、ScrollBox 的滚动算法或 release artifact。
- 不修改 v1/v2 Session view 的消息加载、SSE 重连、daemon 生命周期、Status/Run state 或 Prompt 计时逻辑。
- 不修改 Tool、Shell、Reasoning、Markdown、CodeRenderable 的内容预算、截断、纯文本降级或卡片展示规则；这些属于其他已存在的计划或独立 owner。
- 不按 Session 大小、Provider、Model、终端宽度、内存占用或 streaming 状态引入多套生产算法。
- 不新增配置键、环境开关、feature flag、public SDK 字段、migration、dependency、fallback endpoint 或第二套 culling 实现。
- 不把“用户滚离底部后新尾部不会自动出现在当前视口”误判为卡死；滚动语义仍由现有 sticky scroll 与 Session 导航合同负责。
- 不得仅靠源码阅读臆测根因：症状级反馈环已按 GOAL 记录为真实环境阻塞（第 8 节），修复主张以契约对齐为依据，且仅在独立审计放行后实施。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session 是持久化的 Project/working-directory conversation unit；Message 是由 typed Parts 组成的 MessageV2；v1 TUI 是当前生产路径，v2 是独立迁移路径，不能假定两者完全同构。 |
| `AGENTS.md` | 要求并行调查、最小修改、使用 Bun；不得回退用户或其他 agent 的 dirty worktree。 |
| `packages/opencode/AGENTS.md` | 测试和 typecheck 必须从 `packages/opencode` 运行；生产代码遵循已有模块 owner，不添加无依据抽象或 fallback。 |
| `packages/opencode/test/AGENTS.md` | TUI 测试应通过真实 provider/Session/OpenTUI seam；测试必须等待已发布 readiness signal，不能用固定 sleep 伪造同步。 |
| `thirdparty/opentui/AGENTS.md` | OpenTUI 行为变更需要真实复现；本任务计划不修改 OpenTUI。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、只保留一个 primary path、完成 forward/reverse traceability、禁止 fallback，并满足中文解释性注释门禁。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须覆盖 evidence、reachability、invariant、owner、TDD、verification、diff、risk 和 audit。 |
| `docs/adr/README.md` / `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 当前 accepted ADR 只约束 issue triage，不约束 TUI viewport；本任务不新增 ADR。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/session-pending.ts:1-32` | `shouldCullSessionViewport` 是唯一 culling decision owner；当前在存在未完成 Assistant 且 `stuckToBottom=false` 时返回 `false`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:230-255` | v1 Session 将 Message store 和 `viewportStuckToBottom` 传入 helper，再把结果作为 ScrollBox `viewportCulling`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:441-458` | v1 的 sticky-bottom 计算和一行容忍带是独立的滚动语义；不能因 culling 修复而删除或重写。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:543-579,971-988` | Session 打开与 `End`/`session.last` 使用 `scrollTo(scroll.scrollHeight)`；这是验证用户滚回新尾部的公开行为 seam。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1387-1413` | v1 将每个 Message 的 Part 交给 User/Assistant renderer；Message 数量窗口不等于渲染节点数量窗口。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1723-1885` | Assistant renderer 将每个 Message 内的 Part 投影为 stable keyed render items，并创建 Tool/Reasoning/Text 子树。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1970-2157` | Reasoning 与 Text 进入 Code/Markdown parser-backed renderables；culling 关闭会让更多 child 进入完整 render traversal，但 culling 开启仍先刷新 child layout 坐标。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1800-1818` | 完成 Assistant footer 为每个 Assistant 调用 `tokenAccounting(messages(), getParts, undefined, parentID)`。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:257-338,482-502,977-980` | SDK/SSE 事件经 SyncProvider 批量 coalesce 后写入 Part store；这是流式 delta 到 TUI 的 producer/consumer seam。 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:48-105` | v2 debug Session 也调用同一个 helper，并将结果传给另一个 ScrollBox；一处 helper 变更会覆盖两条可达消费者路径。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-pending.test.ts:1-68` | 当前测试明确锁定旧合同：streaming 且离开 sticky bottom 时期望 culling 为 `false`。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:1368-1401` | 真实 v1 Session/OpenTUI seam；已有一行上滚后继续接收 delta 的 sticky-bottom 回归。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:3503-3699` | `withRenderedSession`、真实 Provider 树、`waitForFrame` 和公开 char-frame 观察方式。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts:34-59` | v1 ScrollBox 与 culling helper 的 wiring regression。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/ScrollBox.ts:11-55,275-291` | `viewportCulling=true` 是 ScrollBox 默认值；开启时先调用每个 child 的 `updateFromLayout()`，再只对 viewport 内 child 调用完整 `updateLayout()`；关闭时完整遍历全部 child。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/ScrollBox.ts:887-894` | 动态 setter 只更新 content culling 标志并请求重绘，没有另一个隐藏的 culling policy。 | observed |
| `thirdparty/opentui/packages/core/src/Renderable.ts:1436-1456` | culling 的真实成本边界：开启并不跳过所有布局，只跳过不可见 child 的完整布局/render traversal。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/ScrollBox.ts:324-333`（通过 v1 caller） | Session scrollbar marker 从全部 `getChildrenSortedByPrimaryAxis()` 读取，不依赖可见 child filter。 | reachable |
| `thirdparty/opentui/packages/core/package.json` / `bun.lock` | 当前 OpenTUI runtime 版本为 `0.4.3-smark.7`；本任务不改变 fork 或 tarball。 | observed |
| `git show f453ffa6ad -- ...` | 条件 culling 于该提交进入 v1/v2；提交注释明确意图是让离屏 streaming code block 继续测量。 | observed |
| OpenTUI history `ff1fc3558`, `76b2668b5`, `8c11fc9b3`, `8581c3b02` | 当前 fork 已包含 identity/culling、sticky re-engagement、manual-scroll guard 和 layout freshness 相关修复；支持先验证应用层 policy 而不是修改 core。 | observed |
| Read-only SQLite query on `C:\Users\Lenovo\.local\share\opencode\opencode.db` | 目标 Session `ses_041cd5549ffeSiDWyPpcy8Xrsl` 的最近 300 条 Message 包含 1,360 个 Part、约 1,964,056 bytes Part JSON；Part type 统计为 330 tool、214 reasoning、164 text、56 patch、299 step-start、297 step-finish。 | observed |
| Read-only SQLite query on target Session | 全量 Session 还包含 9,248 assistant、9,884 completed tool Part；目标当前未完成 Assistant 在采样时没有 Part，说明采样点与用户看到“正文/工具卡片空白”的时序并不完全相同。 | observed |
| Read-only process sample on `F:\include\CLI\opencode.exe` | 9 个 TUI/worker 进程处于高内存状态；疑似进程 PID 50260 约 2.5 GB working set、3.96 GB private memory、27 threads，10 秒 CPU 增量约 3.75 秒；`Responding=True`，不能单独证明 frozen。 | observed |
| User现场描述（Session `ses_041cd5549ffeSiDWyPpcy8Xrsl`） | 用户观察到后端继续执行而 TUI 在某个 Message 后停止正确显示，Tool 卡片空白、thinking/计时不更新、滚动仍可显示部分历史、Ctrl+C 无效。 | observed |
| `packages/opencode/cull-red.temp.test.tsx` 临时实验（R1 阶段） | 真实 route/provider/OpenTUI fixture 在 122 Message 规模下可挂载；去掉滚动时通过，滚离底部后的“MARKER 必须立即可见”断言 90 秒失败，但该断言违反用户离开尾部后的正常滚动语义，不能作为有效红灯。修改后的单次 `renderOnce` 测量为 3.8ms，进一步否定该最小实验可以证明卡死。 | observed / rejected as root-cause proof |
| `bun test --timeout 300000 cull-red.temp.test.tsx`（R2 阶段，完整子会话图） | 临时 harness 已补齐 Task 卡片 eager sync 触发的全部子会话请求（17 个 task 子会话 + 递归后代），真实 300 Message 窗口稳定挂载：约 6,150–6,260 个 Renderable、1 个 ScrollBox、初始 readiness 1.5–3.0s。滚离底部后（imperative `scrollBy`，与命令同一公开 API）`content.viewportCulling` 精确翻转为 `false`，确认条件分支行为面在真实 seam 可达。 | observed |
| R2 A/B 反馈环 regime 1：纯文本失控增长 | 合成 streaming 尾部（35KB 基线，越过 32KB 纯文本熔断，即生产失控正文的真实渲染分支）以每 wave ~15KB 增长至 ~538KB；阶段 A 维持 policy（culling off），阶段 B 强制 `content.viewportCulling=true`。两次独立运行：A avg 59.8/80.2ms vs B avg 55.3/63.8ms（另一次 A 85.5 vs B 87.6ms），max 与心跳漂移（~200–350ms）同量级。结论：本 regime 帧成本由 yoga 文本重测量主导，culling 只跳过 render traversal、不跳过布局测量，A/B 无显著差异。 | observed / 否定该 regime 下分支是冻结源 |
| R2 A/B 反馈环 regime 2/3：streaming-code 路径 | TextPart streaming 分支在本测试环境渲染高度为 1（仅边框，零内容）；ReasoningRun streaming 对短正文可渲染（探针 h=2）但 35KB 大内容在 60s 内不出预览行（h=2 仅表头）。两个 heavyweight streaming-code regime 在本地 harness 不可渲染，无法作为压力 regime。作为对照，canonical `session-message-render.test.tsx` 的 streaming reasoning 短内容用例本机通过（1 pass / 10.5s），说明缺失的是大内容/TextPart-streaming 的测试环境接线而非机器能力。 | observed / environment blocker |
| R2 空载全遇历成本 | 真实 6.2k Renderable 窗口在 culling off（滚离+少量 delta）下连续 20 帧 `renderOnce` 稳定在 12–22ms；本机当前 fork 下全遇历本身不构成冻结级单帧成本。 | observed |
| 外部集群历史数据（另一集群、另一构建、非本仓库验证） | 1200 Message、1608 delta 下“原策略 viewportCulling=false 最大事件循环停顿 45,660ms；强制裁剪 68.1ms；46,344 次 requestRender（30,025 在 render pass 内）”。该规模超出 v1 生产 300 Message 上限，且当前 fork 已包含其后多个 culling/sticky/layout-freshness 修复；本机三 regime 均无法复现该风暴。只能作为外部佐证，不能作为本仓库 root-cause 证明。 | external / non-authoritative |
| `git show f453ffa6ad` 全文 | 条件分支的原始意图是“让离屏 streaming code block 继续测量”；当前 fork 的 culling 实现在过滤前已对全部 child 调用 `updateFromLayout()`（Renderable.ts:1443-1450，每帧刷新坐标），原始意图已被 fork 语义部分满足，条件分支剩余作用是解除唯一 traversal 上界。 | observed / 契约对齐论证核心 |
| 键盘滚离可用性 | `ctrl+alt+u`（messages_half_page_up）在 harness 中按下后 scrollTop 不变（top=h-vh），需 imperative `scrollBy` 兜底；canonical 文件中 `ctrl+alt+y` 单行上滚已验证可用。正式回归测试应使用已验证键位。 | observed / harness note |
| 实施阶段新事实：core sticky 高度塌缩重贴（既有行为） | 超大文本（34KB+）内容更新时，滚离底部 4 行的视口会在 delta 增长后被拉回底部。A/B 对照（临时还原旧条件 policy 重跑同一测试）证明新旧 policy 行为相同：这是 OpenTUI core `recalculateBarProps` 在内容高度瞬态塌缩时重置 `_hasManualScroll` 并重新贴底的既有行为，与 culling policy 无关，属本任务 non-goal（不修改 sticky/core）。Slice 2 因此使用常规尺寸 fixture 断言同一 approved 语义（不自动回贴 + session.last 可达）；超大文本场景的回贴行为不在本测范围。 | observed / pre-existing，非本次引入 |
| `packages/opencode/src/token/accounting.ts:103-226,251-367` | `tokenAccounting` 对 300 条 Message 和其 Parts 做全页扫描，并多次 `JSON.stringify` Tool input；只读重建目标窗口中一次完整 footer loop 约 3.98ms，但这是纯函数基准，不等于 OpenTUI render cost。 | observed |
| `docs/plans/session-output-render-circuit-breaker.md:29-40,74` | 已完成的超长正文熔断任务明确把 viewport culling 记为 non-goal；本 plan 是新任务，不修改旧 plan。 | observed / historical boundary |

## 5. Current Behavior

```text
SyncProvider message/part store
  -> v1 Session / v2 SessionV2 View
  -> shouldCullSessionViewport(messages, { stuckToBottom })
  -> createMemo(viewportCulling)
  -> OpenTUI ScrollBox.viewportCulling
  -> ContentRenderable._hasVisibleChildFilter / _getVisibleChildren
  -> Renderable.updateLayout traversal
  -> terminal frame and input/event-loop progress
```

当前 helper 的语义是：

```text
没有 streaming Assistant                         -> true
有 streaming Assistant + stuckToBottom=true      -> true
有 streaming Assistant + stuckToBottom=false     -> false
```

当结果为 `false` 时，OpenTUI 不走 `getObjectsInViewport()` 过滤，而是对 ScrollBox content 的全部 child 执行完整 `updateLayout()`。当结果为 `true` 时，OpenTUI 仍会先对全部 child 调用 `updateFromLayout()` 以刷新坐标，再只对 viewport 内 child 继续完整的布局/render traversal。因此，“culling 开启后完全不触碰离屏节点”不是当前 fork 的真实语义。

v1 与 v2 共享同一个 helper，但共享的是 policy decision，不共享具体 Message/Part renderer。v1 的 `renderAfter` 仍负责同步 sticky-bottom 状态；该状态当前同时作为 culling policy 的输入。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 完成态 Session Message/Part 列表 | `SyncProvider.session.sync()`、`message.updated`、`message.part.updated` | SDK schema 已解码，Message 顺序由持久 chronology 维护，Part 通过 `messageID` 归属 | v1 `Session` 与 v2 `SessionV2` | SyncProvider + view consumer | observed |
| 未完成 Assistant | daemon stream 的 Message/Status 事件 | `time.completed` 缺失是现有 streaming 合同 | `shouldCullSessionViewport` 的 `messages.some(...)` | TUI culling policy helper | observed |
| 用户滚离 Session 底部 | OpenTUI scroll input + v1/v2 `renderAfter` | `scrollTop` 与 `scrollHeight/viewport.height` 可观测；现有一行容忍带 | `viewportStuckToBottom=false` | Session view scroll owner | observed |
| 流式 `message.part.delta` | daemon SSE | SDK event payload 已按 Part ID/field 标识；SyncProvider 会在 16ms 窗口 coalesce | `enqueuePartDelta` -> `applyPartDelta` -> Solid store | SyncProvider | observed |
| 300 Message / 1,360 Part 的长 Session 窗口 | MessageV2 page `limit=300` + Part hydrate | TUI 当前确实限制 Message 数量，但不限制 Part 数和每个 Part 的 renderable 深度 | v1 Session `<For>` | Message/Part loading + view | observed |
| v2 debug route | `SessionV2Debug` plugin | 仅在实验 flag 下注册，但源码调用链可达 | `session-v2.tsx` ScrollBox | v2 view | reachable |

以下条件目前没有被证明为本任务的 supported production input，不能单独驱动生产逻辑：

- 特定 Provider/Model 必然产生 token soup 或 XML repetition。
- 所有大 Session 都必须按同一种渲染策略处理。
- 当前 DB 采样时未完成 Assistant 没有 Part，因此不能由该采样直接推出前端一定收到了对应 Text/Tool 更新。
- 关闭 culling 本身必然导致任意规模 Session 卡死；最小 fixture 的 `renderOnce` 测量没有证明该命题。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Session ScrollBox 在流式状态和用户滚动位置变化时必须保持可用；用户操作和后续事件不能因渲染 traversal 长时间占满 TUI 主线程。 | 用户现场描述；高 RSS/CPU 进程样本；条件 culling 关闭路径 | 当前无有效用户症状级 regression；需要重建 |
| INV-02 | Culling policy 必须与 OpenTUI fork 的真实语义一致：离屏 child 不参与完整 render traversal，但其 layout 坐标仍按 OpenTUI 合同更新。 | `ScrollBox.ts:34-55`、`Renderable.ts:1436-1456` | `session-integration.test.ts:48-53` 仅保护 wiring |
| INV-03 | v1/v2 使用同一 culling policy；修复一个 owner 不得让两条 Session view 产生不同策略。 | 两个消费者均调用 helper | `session-pending.test.ts` helper unit；无 v2 behavioral liveness test |
| INV-04 | 用户滚离底部时不应被系统强制拉回底部；用户执行现有最后一条消息导航后，最新流式内容必须可达。 | `session.last` / `End` scroll contract；现有 sticky behavior | `session-message-render.test.tsx:1368-1401` 只覆盖一行容忍带 |
| INV-05 | culling 修复不得改变 Message/Part loading、SSE coalescing、Tool state、Markdown budget 或 Prompt lifecycle。 | 明确 non-goals；各 owner 已有实现 | 既有 sync/render/prompt 套件 |

## 8. First Divergence and Root Cause

### R2 结论：契约分歧确认，冻结根因主张降级

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `shouldCullSessionViewport()` 在 `streaming && !stuckToBottom` 时返回 `false`，把 ScrollBox 从 fork 默认的 culling path 切换到全 child traversal。该分支在真实 seam 已验证可达（滚离后 `content.viewportCulling` 精确翻转为 `false`）。 | `packages/opencode/src/cli/cmd/tui/util/session-pending.ts` | R2 harness 实测 + 旧单测 line 63 锁定该行为 |

R2 反馈环证据对“该分支即用户冻结根因”这一主张的判定：

- 纯文本失控 regime（可渲染、确定性）：culling off/on 无显著帧成本差异（yoga 重测量主导，culling 不跳过测量）。
- 空载全遇历：6.2k Renderable 仅 12–22ms/帧。
- streaming-code 两个 regime 在本地测试环境不可渲染（环境阻塞），无法施压。
- 外部集群 45,660ms 数据超出 v1 生产 300 Message 上限且属另一构建，仅作佐证。

因此本 plan 不再声称“恒定 culling 修复用户冻结”。主张变更为：**移除一个与 OpenTUI 默认契约分歧、原始意图已被 fork 现行语义满足、只剩余解除 traversal 上界作用的条件分支**。修复依据是契约对齐与不变量恢复，不是未证实的性能数字。

### Red-capable feedback-loop status（R2）

已建立并实际运行三个确定性反馈环（同一真实 Session/OpenTUI seam，同 fixture A/B）：

1. 合同级红灯（现存可用）：`session-pending.test.ts:63` 期望 `true`，当前实现返回 `false`。
2. 行为面环（现存可用）：真实 300 Message 窗口 + streaming 尾部，滚离后 `content.viewportCulling` 必须为 `false`（当前实现满足，修复后该观察点变为恒 `true`）。
3. A/B 压力环（已运行，结论为否定/环境阻塞）：见第 4 节 R2 证据行。

用户症状级（冻结复现）红灯在本机不可达成，已记录具体环境阻塞：TextPart streaming 与大内容 ReasoningRun 在本地测试 harness 零内容渲染；可渲染 regime 无 A/B 差异。该记录是 GOAL 允许的“真实环境阻塞”，不是对故意的验收削弱。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Session viewport culling policy | `session-pending.ts:shouldCullSessionViewport` | 为 v1/v2 提供一个确定的 `viewportCulling` policy | 当前唯一根据 streaming/sticky 输入做该决策的模块 | OpenTUI 只执行 boolean，不知道 Session/Message 语义；view caller 不应各自复制 policy |
| Sticky-bottom position tracking | v1/v2 Session view `renderAfter` | 观察 scroll position，决定是否贴底 | 它持有 ScrollBox instance 和用户滚动上下文 | helper 不拥有 Renderable；OpenTUI 不知道 Session 产品语义 |
| Delta coalescing/store mutation | `SyncProvider` | 将公开 SSE event 变为响应式 Part store | 它是 SSE 到 UI store 的第一 owner | Session view 只消费 store，不应重新聚合 SSE |
| Full Message/Part loading | `MessageV2.page` / server route | 提供当前 TUI Message window 与 Parts | 本任务明确不改变其范围或持久读取合同 | culling policy 不应吸收分页/数据库职责 |
| User-visible liveness proof | `session-message-render.test.tsx` 的真实 Session/OpenTUI seam | 观察 char frame、输入导航和 delta 后的可达结果 | 该文件已有完整 Provider、transport、OpenTUI frame harness | unit/source tests 无法证明主线程与 ScrollBox traversal 的用户行为 |

## 10. Single Approved Primary-Path Design

### Candidate route（R2：以契约对齐为依据）

唯一候选 primary path 是直接恢复 Session ScrollBox 的 culling 合同：

```text
v1/v2 Session inputs
  -> shouldCullSessionViewport(...)
  -> always return true
  -> ScrollBox viewportCulling=true
  -> OpenTUI performs its existing viewport-filtered render traversal
```

该路径是对现有条件 policy 的精确回滚，不是 failure-triggered fallback。它不增加新的状态、阈值、配置或 alternative renderer；v1/v2 调用点保持不变。`SessionViewportMessage` 与 `SessionViewportState` 参数签名保留，以避免两条 caller 路径漂移；未使用参数按仓库风格改为下划线命名。`isStreamingViewportAssistant` 将因不再有 consumer 而删除。

R2 授权依据：契约对齐（OpenTUI fork 默认 `viewportCulling=true` + 过滤前 `updateFromLayout()` 已满足原始测量意图）+ v1/v2 共享单 owner + 本机三 regime 无回归观测。不再声称修复用户冻结症状。

### Why this is the only candidate

- 把 culling 决定复制到 v1/v2 是平行实现，禁止。
- 在 renderer 卡顿后临时关闭/开启 culling 是 fallback 或状态机，禁止。
- 让 SyncProvider 丢弃离屏 Part、改变 Message window、延迟 Tool/Reasoning renderer 会改变加载或显示合同，超出用户范围且缺乏证据。
- 修改 OpenTUI core 会绕过当前应用层 first divergence，且当前 fork 已有 culling/sticky 修复历史。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| `shouldCullSessionViewport` conditional return | current | primary policy, currently divergent | yes | 100% | replace only after valid red loop |
| Always-on culling return | proposed | exact user-scoped policy repair / rollback of conditional behavior | yes | 100% | candidate primary path |
| v1 `Session` caller | current | contracted pass-through | yes | 0% new | preserve |
| v2 `SessionV2` caller | current | contracted pass-through | yes | 0% new | preserve |
| Temporary `cull-red.temp.test.tsx` | diagnostic | diagnostic path, not production | no | 0% production | do not add to canonical implementation |
| Culling-off fallback after render failure | rejected | forbidden fallback | yes | 0% allowed | reject |
| Message/Part truncation or alternate loader | rejected | alternate success/data path | yes | 0% allowed | reject |

No new alternate success path is authorized. The proposed route is one direct policy replacement, not A -> B -> B1/B2 recovery.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `isStreamingViewportAssistant` plus the `messages.some(...)` conditional | `f453ffa6ad` attempted to let off-screen streaming code continue measuring | 当前 fork 的 culling 实现在过滤前已对全部 child 调用 `updateFromLayout()`（Renderable.ts:1443-1450），原始测量意图已被满足；条件分支剩余作用是解除唯一 traversal 上界（契约对齐授权，见第 8/10 节；症状级红灯已记录为环境阻塞） | `packages/opencode/src/cli/cmd/tui/util/session-pending.ts` |
| Temporary standalone harness | Used to explore route/provider and frame behavior | It is not a stable contract and must not become a second test/plan source; its invalid tail-visibility assertion is explicitly rejected | diagnostic artifact cleanup after feedback-loop decision; no production replacement |

No other workaround deletion is currently justified.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| User requests culling optimization within four production files and 400 production lines | Single helper owner | `session-pending.ts` only, expected single-digit production delta | `session-pending.test.ts` plus real Session liveness test |
| INV-01 TUI remains responsive during stream/history scrolling | helper -> ScrollBox policy | Always-on culling restores the traversal bound; the freeze-fix claim is withdrawn (Section 8), liveness stays protected by Slice 2 | Real OpenTUI frame/input/delta liveness seam (Slice 2) + R2 A/B loops |
| INV-02 culling uses OpenTUI viewport-filtered traversal | `shouldCullSessionViewport` result | Remove conditional false branch; preserve OpenTUI | Unit contract plus frame behavior |
| INV-03 v1/v2 consistency | shared helper call sites | No caller duplication; one helper change | v1 route test, v2 route test/consumer contract |
| INV-04 user can navigate to latest streamed content after scrolling | existing `session.last`/`End` path | No sticky algorithm change | `session-message-render.test.tsx` scroll away -> delta -> End -> marker visible |
| INV-05 no loading/rendering regression outside culling policy | existing Sync/renderer paths | No changes to sync, loader, Tool, Markdown, OpenTUI | Existing sync/render/pending suites and typecheck |

The INV-01 mapping remains not executable as a freeze fix claim; the R2 repair is authorized on INV-02/03 contract-alignment grounds. The real-seam liveness regression (Slice 2) still ships to protect INV-04 behavior under the new policy.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Always-on `viewportCulling=true` policy | INV-01, INV-02, INV-03 | Current conditional false branch; OpenTUI default true; v1/v2 shared helper | Existing helper deliberately disables the only traversal reduction exactly when streaming and user scrolls away |
| Delete `isStreamingViewportAssistant` | INV-02 | It exists only to select the conditional false branch; grep found no other consumer | Keeping it would leave dead policy logic after direct repair |
| Reverse unit expectation from false to true | INV-02 | Current test locks the divergent contract at line 63 | Existing test explicitly protects the behavior proposed for removal |
| Real OpenTUI liveness regression | INV-01, INV-04 | User-visible freeze requires render/input/frame seam; helper unit alone is too shallow | Existing source and unit tests cannot observe event-loop starvation or navigation reachability |

No new production state, threshold, retry, loader, or OpenTUI change is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/opencode/src/cli/cmd/tui/util/session-pending.ts` | modify | Replace conditional culling policy with the single approved primary behavior; delete superseded private predicate; keep caller-compatible signature | approximately `-7/+4` |
| `packages/opencode/test/cli/cmd/tui/session-pending.test.ts` | modify | Reverse the old streaming/off-bottom contract and add explicit completed/streaming cases under one always-on policy | approximately `+5/-4` |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | Add one public liveness regression using real Session/OpenTUI frame, delta, scroll-away and existing last-message navigation | approximately `+45` |
| `packages/opencode/test/cli/cmd/tui/session-integration.test.ts` | preserve unless an existing assertion becomes stale | Existing wiring guard; no source assertion should be expanded into implementation details | `0` expected |

Production file count is one planned file, below the four-file limit. The current plan does not authorize modification of `index.tsx`, `session-v2.tsx`, OpenTUI, SyncProvider, or any database file.

## 16. TDD Behavior Slices

Slice 1 is red-capable today. Slice 2 is a green-side real-seam liveness regression protecting INV-04 under the new policy (it cannot go red on the current implementation for the freeze symptom; that limitation is recorded in Section 8). Slices run in order 1 -> 2 -> 3 -> 4 during implementation.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `shouldCullSessionViewport([openAssistant], { stuckToBottom:false })` is expected to remain `true` under the repaired contract. | Current helper returns `false` in exactly this branch. | Return `true` for the same supported inputs without changing other helper exports. | Completed Assistant and default streaming cases remain true; other pending/status helpers unchanged. |
| 2 | Real Session route: scroll away beyond the one-row tolerance band (≥2 presses of verified `ctrl+alt+y`, per audit N-02; `ctrl+alt+u` is not wired in the harness), inject public `message.part.delta`s, then existing `End`/`session.last` navigation must show updated content within the normal frame deadline. | Protects INV-04 under the always-on policy; red-capability for the freeze symptom is blocked by the environment limits recorded in Section 8. | The same existing ScrollBox, SyncProvider and navigation path completes without long frame starvation. | User is not auto-snapped while away; latest content is reachable after explicit navigation. |
| 3 | Existing one-line tolerated-bottom test continues to show `NEW_BOTTOM` after a delta. | It protects sticky-bottom behavior that must not be conflated with culling policy. | No change outside the helper policy. | `session-message-render.test.tsx:1368-1401`. |
| 4 | v1 and v2 source/route contracts still pass through the same helper and preserve their existing ScrollBox options. | Both callers are reachable and must not diverge. | One shared helper remains the sole policy owner. | `session-integration.test.ts`, v2 route suite. |

The R1 temporary tail-visibility experiment is superseded by the R2 A/B loops in Section 4; the formal Slice 2 uses only verified keys and public navigation.

## 17. Chinese Comment Budget

This section is an estimate for the candidate implementation only; R2 has no production diff.

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | 8-12 | Count substantive production lines in the helper; exclude imports, formatting and deleted diagnostic files. |
| Required Chinese explanatory comments `C` | 2 | `max(1, ceil(E * 0.15))` gives 2 for an expected E range of 8-12. |

Qualifying comments must explain only non-obvious decisions near the changed helper, for example:

- why Session culling must remain aligned with OpenTUI's default traversal contract even while an Assistant streams;
- why `stuckToBottom` remains an input to sticky scrolling but no longer selects a second culling policy;
- why the regression test navigates to the latest message explicitly instead of asserting that off-screen content appears automatically.

No comment may merely translate `return true`, restate a condition, or repeat a test name. Actual `E`/`C` must be recorded after implementation; if the plan changes, the revision must increment.

## 18. Verification

These commands are planned, not yet a release claim. They must run from `packages/opencode`.

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/cli/cmd/tui/session-pending.test.ts` | `packages/opencode` | Helper contract and adjacent pending/status helpers. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx -t "viewport culling"` | `packages/opencode` | Public Session/OpenTUI frame, scroll, delta and last-message navigation liveness. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx -t "session follows streaming growth"` | `packages/opencode` | Existing sticky-bottom one-row tolerance remains green. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-integration.test.ts` | `packages/opencode` | v1 Session ScrollBox/helper wiring remains present. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | v2 debug route remains mountable and error/lifecycle behavior is unchanged. |
| `bun typecheck` | `packages/opencode` | Type safety after retaining the shared helper signature. |
| Original user-symptom feedback loop | `packages/opencode` temp harness | Recorded as environment-blocked in Section 8: freeze-level stall not reproducible locally across three regimes. The formal regression ships Slice 2 instead; no command may claim freeze verification. |

No command may mutate `C:\Users\Lenovo\.local\share\opencode\opencode.db` or the user's running TUI during plan research.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 1 | This new canonical plan only during R1/R2 research. Implementation adds none. |
| Files modified | 0 in R1/R2; 3 planned in implementation | One production helper and two focused test files. |
| Files deleted | 0 | No production or test deletion is authorized before audit approval. |
| Production lines | 0 in R1/R2; approximately 8-12 planned | One policy function, below the four-file/400-production-line user limit. |
| Test lines | 0 in R1/R2; approximately 50 planned | One unit contract update and one real liveness slice. |
| Generated lines | 0 | No SDK, lockfile, migration, or OpenTUI artifact change. |

## 20. Real Risks and Open Decisions

### Real risks

- Culling `true` can defer full render traversal for off-screen Code/Tool descendants until they become visible. This is a real semantic consequence, not a generic performance concern; it must be covered by explicit `End`/last-message navigation and historical content visibility.
- OpenTUI's culling implementation still calls `updateFromLayout()` for every child before filtering. A proposed app-layer repair therefore reduces complete descendant traversal/render hooks, not all layout work. Performance claims must not overstate this boundary.
- The target Session's database sampling point did not contain Parts for its latest unfinished Assistant. A test fixture built only from that exact lifecycle row can produce a false negative; the feedback loop must model the observed event order through public events, not fabricate an incompatible persisted state.
- The working tree and `thirdparty/opentui` contain unrelated user/agent modifications. This task must not overwrite or revert them.

### Open Decisions Requiring the User

None at the product level. R2 records two facts as closed decisions rather than open blockers: (1) the freeze-symptom red loop is environment-blocked locally (Section 8), and the repair is justified on contract-alignment grounds; (2) the external cluster's 45s data is corroborating, not authoritative. The auditor may challenge either classification.

### Rejected Speculation

- “All large Sessions freeze because culling is disabled” is rejected as an unproven universal claim; the target window is large, but a 122-Message fixture measured 3.8ms for one off-screen `renderOnce`.
- “The current frozen TUI is daemon-dead” is rejected by the observed backend progress and responding process state; daemon lifecycle is out of scope here.
- “The newest unfinished Assistant must own the blank Tool card” is rejected by the DB sample showing an unfinished Assistant with no Parts at that instant; lifecycle timing needs an event trace.
- “Changing OpenTUI core is necessary” is rejected because the application already owns the policy boolean and the fork's ScrollBox default/settled culling implementation is available and version-pinned.
- “Default-collapse or Session-size-specific renderer branches are needed” is rejected by the explicit user constraint against unrelated production distinctions and by lack of a reachable contract requiring them.
- “A timeout/fallback renderer should hide the failure” is rejected by the primary-path and no-fallback policy.

## 21. Audit Contract

R2 requests an independent full-scope plan audit. The auditor must:

- read this exact file and the original requirement;
- reconstruct the full v1/v2 producer-consumer path and OpenTUI culling semantics;
- treat all builder summaries, temporary harnesses and prior conversation claims as untrusted, including the external cluster's 45,660ms figure;
- audit the complete original scope, including the explicit non-goals and the 4-file/400-production-line limit;
- require observed, contracted or reachable evidence for every blocking finding;
- verify that the proposed route repairs the first divergence rather than adding a fallback;
- verify that the regression tests protect the contracted behavior (unit reversal, real-seam navigation liveness, sticky-bottom tolerance, v1/v2 wiring) and that no test claims freeze verification; the freeze symptom is recorded as environment-blocked, not silently dropped;
- verify forward/reverse traceability, responsibility ownership, code quality and the 15% Chinese explanatory-comment plan.

The eventual handoff must contain only the verbatim requirement, this plan path, repository root, and `Audit mode: plan`.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | 0 | N-01..N-04（见下） | APPROVE（仅限 R2；任何 substantive revision 需重新 full-scope 审计） | task ses_fdb52c15bffeQeUUpOJV41w7YD |

审计记录（verdict 原文要点，非授权修改）：

- 「No blocking findings.」「APPROVE — Revision R2 only. `Status` may transition to `approved` / `Approved revision: R2` / `Implementation allowed: yes` per the canonical-plan recording protocol, folding in the four non-blocking findings (N-01…N-04) verbatim.」
- N-01（记录修正，已折叠入第 12 节）：Section 12 残留 R1 条件授权措辞与 Section 8/10 的契约对齐授权不一致。
- N-02（测试敏感性，已折叠入第 16 节 Slice 2）：Slice 2 滚离必须越过单行容忍带（≥2 次 ctrl+alt+y 或等价公开滚动），否则退化为 Slice 3 场景。
- N-03（记录，已折叠入第 10/12 节）：修复后 `viewportStuckToBottom` 成为行为性惰性信号（唯一读者是 culling memo 入参），按接口稳定性保留为 pass-through-by-design，供未来任务重议。
- N-04（接受，不扩大测试面）：v2 call site 无源码 wiring 守卫；共享 helper 单测 + v2 route 套件已足够，未来 v2 分歧属 speculative。
- 审计还确认：Slice 1 今日即可红灯；Section 11 的「rollback of conditional behavior」措辞不应误读为用户请求型 rollback 类别（字面回滚 `f453ffa6ad` 会恢复 `!streamingActive()`，非本方案）；该路线以 owner 级 root-cause repair 独立成立。

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

### Actual Files and Diff

- `packages/opencode/src/cli/cmd/tui/util/session-pending.ts`：`shouldCullSessionViewport` 改为恒返回 `true`，参数改为下划线命名，删除 `isStreamingViewportAssistant` 与条件分支；`+9/-12`（含 3 行中文注释）。
- `packages/opencode/test/cli/cmd/tui/session-pending.test.ts`：反转旧合同（streaming+滚离 → 期望 `true`）并附契约对齐注释；`+5/-1`。
- `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`：新增真实 seam liveness 回归（滚离容忍带→delta→不自动回贴→`End` 导航可达）；`+49`。
- `packages/opencode/cull-red.temp.test.tsx`：未跟踪诊断工件（R2 证据源），仅做 2 处类型收窄以维持 package typecheck；按策略门禁未删除，清理待用户明确授权。不计入 E/C。

### Red-Green Test Evidence

- Red（Slice 1）：`bun test --timeout 30000 test/cli/cmd/tui/session-pending.test.ts` → `19 pass / 1 fail`，失败点为 `expect(...stuckToBottom:false).toBe(true)` 收到 `false`（精确命中目标分支）。
- Green（Slice 1）：实施 helper 修改后同命令 → `20 pass / 0 fail`。
- Slice 2（green-side，按 §16 定义）：`-t "reachable via session.last"` → `1 pass / 3 expect`。fixture 调试期间发现的既有 core 回贴行为已记录于第 4 节，非本次引入。

### Verification Commands and Results

| Command（cwd=packages/opencode） | Result |
| --- | --- |
| `bun test --timeout 30000 test/cli/cmd/tui/session-pending.test.ts` | red `19 pass/1 fail` → green `20 pass/0 fail` |
| `bun test --timeout 120000 test/cli/cmd/tui/session-message-render.test.tsx -t "reachable via session.last"` | `1 pass / 0 fail` |
| `bun test --timeout 60000 test/cli/cmd/tui/session-message-render.test.tsx -t "session follows streaming growth"` | `1 pass / 0 fail`（Slice 3 sticky 容忍带回归） |
| `bun test --timeout 60000 test/cli/cmd/tui/session-integration.test.ts` | `35 pass / 0 fail`（Slice 4 v1 wiring 源断言） |
| `bun test --timeout 60000 test/cli/cmd/tui/session-v2-error.test.tsx` | `3 pass / 0 fail`（v2 route 回归） |
| `bun typecheck` | RC=0 |

### Original Feedback-Loop Result

Three real-seam loops were run (contract, behavior-surface, A/B stress); results and environment blockers are recorded in Sections 4 and 8. No loop reproduced the user freeze; the plan no longer claims it.

### Actual Secondary and Replacement Path Inventory

Not applicable before implementation.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | 41 | 实现审计独立重算值（N-02 记录修正）：生产 3 + 单测 2 + 渲染测 ≈36；构建者自记 45 与审计重算的差异属计数口径差，两者均远低于上限。 |
| Qualifying Chinese comment lines `C` | 14 | 实现审计独立重算值：生产 3 + 单测 2 + 渲染测 ≈9。 |
| Ratio `C / E` | ≈0.34 | `E > 0`。 |
| Required minimum `C` | 7 | `max(1, ceil(41 * 0.15)) = 7`，实际 14 ≥ 7。 |

### Remaining Unverified Items

- The user's freeze symptom itself: not reproduced locally in any regime; this plan explicitly does not claim to fix it.
- Whether always-on culling regresses explicit history navigation on very large real Sessions — covered behaviorally by Slice 2/3 but not stressed beyond the 300-message window.
- Actual implementation `E/C` and complete package-local verification.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | 0 | N-01..N-03（见下） | APPROVE（仅限 R2 实际 diff） | task ses_fdb3021f9ffekjnQ1o2vRkqk6g |

审计记录（verdict 原文要点，非授权修改）：

- 「所有证据已收集完毕。…… 阻塞性发现：无阻塞性发现。…… **批准 —— 仅限针对批准的 R2 计划的实际差异。** N-01 需要在合并时对未追踪的诊断性产物做出用户清理决定；它不影响已发布的差异。」
- 审计独立重跑全部验证：`session-pending.test.ts` 20/0；`-t "reachable via session.last"` 1/0；`-t "session follows streaming growth"` 1/0；`session-integration.test.ts` 35/0；`session-v2-error.test.tsx` 3/0；`bun typecheck` RC=0。
- N-01（需用户决定）：未跟踪诊断工件 `packages/opencode/cull-red.temp.test.tsx` 会被直接 `bun test` 发现并失败（活库漂移，且其旧行为断言在新策略下不再可满足）；不在本 diff 内、失败缘由先于本 diff。合并时需用户决定删除或移出测试发现范围；在此之前不要 `git add -A`。
- N-02（记录修正，已折叠入 §23）：审计重算 E≈41/C≈14/≈0.34，高于门禁。
- N-03（记录）：`viewportStuckToBottom` 在 v1/v2 均为行为性惰性输入，按接口稳定性 pass-through-by-design 保留（与方案审计 N-03 一致）。
- 审计同时拒绝了将冻结复现作为发布门槛、v2 wiring 守卫、temp 文件 DB 漂移失败归因于本 diff 等投机性要求。

# Stats 终端信息架构与主题收敛方案

> 状态：方案稿，仅用于后续 TDD 实施。本文件不代表当前代码已经实现。
>
> 范围：`opencode stats` 的 Dashboard、Timeline、Breakdown、Sessions、Insights、Forecast、兼容别名、交互模式，以及这些页面共用的数据投影、终端主题和响应式规则。
>
> 约束：不新增依赖，不新增配置项，不新增公开命令，不迁移数据库，不改 SDK，不启动 OpenTUI renderer，不用字符串相等猜测 fork 前缀。

## 1. 推荐结论

本次问题不是“折线图太大”，也不是“每个页面都应该换一种图”。当前真正的退化来自三个切入点：

1. Breakdown 把七种职责不同的维度压进同一个 `renderAnalyticalTable()`，每页只剩一张主图和一张通用小表，已有聚合数据没有被展示。
2. Provider 与 Model 的关系被画成 `[A]`、`[1]` 编号矩阵，实体身份与数值需要来回对照；长标签也被编号替代，降低了可读性。
3. stats 自己维护一套只适合深色背景的 24-bit RGB，虽然不再绘制背景，但亮色终端上的对比度仍然不足。

推荐采用一次“替换而非叠加”的小范围修改：

- 保留 Dashboard 当前 section-first 结构和全宽长期趋势图，Dashboard 继续作为视觉基准。
- 保留 Breakdown 的全宽主趋势图；删除编号图例和编号矩阵，改用真实实体名、绝对值、占比及维度专属的二级分析。
- 继续复用 `UsageGroup`、`UsageSeries`、`renderRoundedLineChart()`、`renderComparisonTable()`、`renderPercentStack()` 等现有数据和绘图 primitive，不引入页面状态机或新渲染框架。
- 数据层只做三项局部修正：让已有 request shell 同时进入 Breakdown 指标、补 Project 可识别身份、补按存储中发起模型/Provider/Agent/Project 聚合的 Tool 调用归因。三者均来自现有表和 Message/Part，不涉及 schema。
- 把固定 RGB 收敛为 OpenCode system theme 同语义的 ANSI 基础色：正文继承终端默认前景，状态色使用终端 red/yellow/green/cyan，多系列仍保留稳定颜色顺序和无色形状。这样由终端主题决定明暗值，不需要猜测 macOS 外观。
- Insights 继续以定量证据为主，不恢复长篇机械结论；空数据时不生成“缓存率过低”之类伪建议。

预期未来实现修改 8 个既有文件，不新增运行时代码文件；整体预计新增 695-1000 行、删除 396-603 行，目标净增约 150-450 行。若文档同步拆为后续提交，则核心实现为 6 个文件。

## 2. 本轮调研范围

### 2.1 已阅读的生产代码

| 文件 | 相关性 |
|---|---|
| `packages/opencode/src/cli/cmd/stats.ts` | 命令树、参数边界、兼容别名、Effect handler、interactive 输入与清理 |
| `packages/opencode/src/cli/cmd/stats/data.ts` | Session/RequestUsage/Message/Part 读取、过滤、聚合和最终 `StatsReport` |
| `packages/opencode/src/cli/cmd/stats/render.ts` | Dashboard、Breakdown、Timeline、Sessions 的页面组合与响应式规则 |
| `packages/opencode/src/cli/cmd/stats/charts.ts` | ANSI、可见宽度、panel、折线、面积图、热力图、表格和矩阵 primitive |
| `packages/opencode/src/cli/cmd/stats/insights.ts` | Insights、Actions、Forecast 的计算与渲染 |
| `packages/opencode/src/cli/effect-cmd.ts` | Instance 加载、handler 运行和 `store.dispose()` 生命周期 |
| `packages/opencode/src/index.ts` | `StatsCommand` 的顶层注册 |
| `packages/opencode/src/session/request-usage.ts` | 新 RequestUsage 的写入、完成、错误和兼容语义 |
| `packages/opencode/src/session/request-usage.sql.ts` | Request 与 Assistant usage 的持久化字段 |
| `packages/opencode/src/token/accounting.ts` | Input component 与 token accounting 口径 |
| `packages/opencode/src/session/message-v2.ts` | Assistant 身份、ToolPart 状态、Tool 调用时间和字符数据 |
| `packages/opencode/src/session/session.ts` | Session 列表中的 Project 映射模式及 fork 复制行为 |
| `packages/opencode/src/session/session.sql.ts` | `parent_id` 已存在的事实 |
| `packages/opencode/src/project/project.sql.ts` | `ProjectTable.name/worktree` 已存在，无需迁移 |
| `packages/opencode/src/cli/cmd/tui/context/theme.tsx` | ThemeProvider、system theme、terminal palette 与 dark/light 语义 |
| `packages/opencode/src/cli/cmd/tui/context/theme/opencode.json` | OpenCode 默认主题的语义 token |
| `packages/opencode/src/cli/cmd/run/theme.ts` | 非主 TUI 消费主题的 adapter 先例及 renderer 依赖 |
| `packages/opencode/src/cli/ui.ts` | 普通 CLI 的 ANSI status color 约定 |
| `packages/opencode/src/cli/cmd/tui/app.tsx` | renderer palette/theme mode 和 Unicode width 设置 |
| `packages/opencode/script/build.ts` | stats 的静态打包与 smoke test 边界 |
| `packages/opencode/script/generate.ts` | 正式 build 会额外生成 models snapshot 的副作用 |
| `packages/opencode/bin/opencode` | npm launcher、stdio 继承和 signal 转发 |

### 2.2 已阅读的测试与文档

| 文件 | 相关性 |
|---|---|
| `packages/opencode/test/cli/stats-data.test.ts` | 参数校验、自然日窗口、Tool context attribution、legacy 零回退 |
| `packages/opencode/test/cli/stats-render-width.test.ts` | 所有页面的可见内容、宽度、长标签、空数据和背景 ANSI |
| `packages/web/src/content/docs/cli.mdx` | 英文 stats 参数说明 |
| `packages/web/src/content/docs/zh-cn/cli.mdx` | 简体中文 stats 参数说明 |
| `packages/web/src/content/docs/*/cli.mdx` | 其他本地化版本仍保留旧默认值的兼容风险 |
| `README.md` 与 `docs/readme/README.*.md` | 旧 `stats --models` 入口的公开描述 |
| `CONTEXT.md` | SMARK fork 中 token breakdown 的 load-bearing 定位 |
| `docs/adr/README.md` | 本方案属于单模块 proposal，不需要新增 ADR |
| `docs/proposal/tui-reasoning-run-rendering-proposal.md` | proposal 的证据、边界、测试和风险组织方式 |
| `docs/proposal/database-cold-storage-compression.md` | 大型方案的分阶段和兼容性记录方式 |
| `docs/proposal/rg-filesystem-permission-handling.md` | 行为不变量和验证矩阵写法 |

### 2.3 搜索确认的调用点和旧逻辑

- `StatsCommand` 只在顶层命令树注册一次；所有页面最终都经过 `loadReport()`、纯字符串 renderer 和 `console.log()`。
- `renderModels()`、`renderProviders()` 只是 `renderBreakdown()` 的兼容 wrapper，不是独立页面实现。
- `renderMatrix()` 在整个 package 中只有 Provider/Model 矩阵一个调用点；替换该视图后可直接删除，不需要保留兼容层。
- `renderPercentStack()`、`renderRankBars()`、`renderSlopeChart()`、`renderHistogram()` 当前没有生产调用，其中 percent stack 和 rank bars 可以直接承载新的组成/排行视图。
- 每个非 Tool `UsageGroup` 已有完整 token 分量、input components、cost、requests、assistant calls、errors、aborted、duration、session 数，以及组内 model/provider token totals。
- 六种非 Tool 维度已经各自拥有完整逐日 `UsageSeries`，不需要再查询数据库。
- `ToolUsageEvent` 已有 model/provider/agent/project/source/status/tool 身份和估算 context token，但最终只按 tool ID 投影。
- ToolPart 所属 Assistant message 已有 model/provider/agent，Session 已有 project，因此可以聚合“当前存储中哪个 Assistant 身份拥有该 ToolPart”；fork 复制可能让同一次历史活动在多个 Session 中重复，这不等于跨 fork 唯一调用。该归因仍不需要把 assistant cost 按比例猜给工具。
- stats 没有读取 `ProjectTable`；Project group 的 `id` 和 `label` 当前都直接使用 project ID。
- `ThemeProvider/useTheme()` 只在 Solid + OpenTUI + KV/config provider 树内成立；stats 是轻量 ANSI CLI，不能直接调用。
- `generateSystem()` 的 primary/status 色来自 terminal ANSI palette；这正是普通 stats 输出可以无 renderer 复用的最小语义。
- 英文和简中 CLI 文档已描述 60 天与 interactive，其他多语言版本大多仍写旧默认值；文档不是自动生成。

### 2.4 已执行的只读验证

```text
cd packages/opencode
bun test test/cli/stats-data.test.ts test/cli/stats-render-width.test.ts

28 pass
0 fail
271 expect() calls
```

当前测试全绿只证明当前行为被锁定，不证明当前信息架构正确。特别是现有测试明确要求不出现 `token detail` 和 `Token composition across all`，并用 48 行上限固化了一次信息删除决策。

固定 RGB 的 WCAG 对比实验还确认了亮色背景问题：

| 当前角色 | 黑色背景对比度 | 白色背景对比度 |
|---|---:|---:|
| title | 18.86 | 1.11 |
| blue | 10.33 | 2.00 |
| green | 11.69 | 1.80 |
| yellow | 13.32 | 1.58 |
| pink | 7.97 | 2.64 |
| red | 7.51 | 2.80 |

因此“不画背景”只解决背景覆盖，并没有解决前景色在亮色终端上的可读性。

方案稿完成后又执行了两个只读 artifact 检查：所有 fenced output 经 `Bun.stringWidth` 均不超过 114 列；120 列主页面行数分别为 Dashboard 79、Breakdown 41-53、Timeline 43-49、Timeline + Heatmap 55-61、Sessions 53、Insights 38，满足 §5.5 的 120×45 两屏预算。

## 3. 当前职责边界与必须保持的行为

### 3.1 调用链

```text
src/index.ts
  -> StatsCommand / 子命令 / 兼容别名
  -> effectCmd()
  -> InstanceRef + loadReport()
  -> aggregateStats()
       -> SessionTable 粗筛
       -> Session.messages + RequestUsage 两层读取
       -> 20 并发聚合
       -> event/filter/group/series 投影
  -> renderDashboard | renderBreakdown | renderTimeline | renderSessions | renderInsights
  -> console.log()
  -> effectCmd finally: store.dispose(ctx)
```

渲染层不得二次筛选原始事件。renderer 只能选择已有聚合视图、排序和排版，否则 header 总量与页面明细会出现不同口径。

### 3.2 页面职责

| 页面 | 用户问题 | 不应承担的职责 |
|---|---|---|
| Dashboard | 整体发生了什么，哪里值得继续看 | 展开所有实体细节 |
| Timeline | 何时变化，波动、峰值和组成如何 | 完整实体排行榜 |
| Breakdown | 谁或什么贡献了用量、费用、失败和上下文 | 单会话诊断 |
| Sessions | 哪些会话形成长尾、成本和异常 | 全局 Tool 排名 |
| Insights | 哪些跨维关系和离群值值得验证 | 用长篇固定文案替用户下结论 |
| Forecast | 按已观测活跃率，当前 run rate 会走向哪里 | 默认混入观测事实页 |
| Interactive | 在相同数据与页面间快速切换 | 维护第二套统计口径 |

### 3.3 不允许回归的不变量

1. 默认窗口仍是包含今天的 60 个本地自然日；`days=0` 表示今天，`--all-time` 显式覆盖 `--days`。
2. 日期 bucket 继续使用本地自然日与 `setDate`，不能退回固定 24 小时算法。
3. `--project ""` 仍表示当前 project ID，非空值仍按 ID 精确过滤；显示名称改变不能偷偷改变过滤语义。
4. `--tool` 现有语义仍是先筛选“调用过该工具的 sessions”；不能在视觉修改中把它伪装成严格 Tool 成本归因。
5. RequestUsage 优先、legacy Message 回退、NotFound 消解和其他存储错误上抛的行为保持不变。
6. 所有 canonical 命令、隐藏别名、root shortcuts 和参数拒绝行为保持不变。
7. `--color always/never/auto`、`NO_COLOR` 和 TTY 判断优先级保持不变。
8. 彩色输出不得设置具体背景色；`49m` 只用于恢复终端默认背景。
9. 40、80、120、160 列均不得用省略号或静默裁剪实体身份；宽度不足只能换行或改变布局。
10. CJK、组合字符和 ANSI 不得破坏最终 panel 的 `columns - 2` 可见宽度。
11. 彩色折线默认保持细线、无重复粗点；无色模式必须另有非颜色编码。
12. `limit` 只限制可见实体行，不得改变总量、完整 group 数、分布或 percentile。
13. Tool context token 必须继续标为估算值；legacy 缺失 input breakdown 时保持 0，不能制造 NaN 或虚假归因。
14. Insights 默认不计算或显示 Forecast；只有 `--forecast`、`forecast` 或 `run-rate` 才显示预测。
15. interactive 的非 TTY 单次输出、range cache、单循环状态更新以及退出后的 cursor/raw/listener 恢复意图保持不变。

## 4. 已确认的问题与原因

### 4.1 Breakdown 的信息退化

当前所有非 Tool 维度都经过一个 `label + string[]` 的通用表。它只能容纳七个短列，无法自然表达：

- Model 的 token 组成、绝对 token、Provider 路由和 Tool mix。
- Provider 的绝对费用/请求、model portfolio、tokens per dollar 和延迟。
- Agent/Source 的十类 input context，而不是只显示四类且让百分比之和小于 100%。
- Project 的名称、路径、top models/providers/sessions。
- Status 的失败来源、趋势和 error/aborted 的差异。

数据层已经保留绝大部分字段，丢失发生在最终 projection，而不是数据库。

### 4.2 编号矩阵和编号标签

当前主趋势把真实 series label 替换为 `[1]` 到 `[5]`，关闭 legend，再要求用户到下表找对应项。Provider/Model 矩阵进一步用字母和数字替换两条轴。即使完整标签最终在 note 行出现，仍会形成三次视线跳转：图形、编号、键表。

这些编号不是宽度问题的必要解。现有响应式表已经能在整表放不下时退化为逐实体 key/value，因此应直接保留真实标签；放不下就换布局，不应换身份。

### 4.3 Project 只有 ID

`aggregateStats()` 没有查询 `ProjectTable`，并直接执行等价于：

```text
addGroup(projects, event.projectID, event.projectID, event)
```

renderer 只是忠实显示 `group.label`。`ProjectTable.name` 与 `worktree` 已存在，Session 也有 directory；缺口只是一次批量映射，无需 schema。

### 4.4 Tool 指标语义不完整

当前 Tool 页面混合了两种不同口径：

- ToolPart 可提供真实调用次数、输入/输出字符、状态和执行时间。
- 后续 Assistant input breakdown 可按历史 Tool 字符占比估算该工具在上下文中占用的 token。

页面当前只写 `in/call`、`out/call` 和 `share`，没有标明字符单位；当所有 context token 为 0 时，`share` 的分母还会从 context token 切换成 call count。

现有数据不能提供 Tool 的精确 billed token 或精确美元成本。任何按字符、context token 或调用数分摊 Assistant cost 的实现都只能是估算，不应进入本方案。

### 4.5 主题并未真正适配明暗终端

当前 stats 同时在 `render.ts` 与 `charts.ts` 维护两套固定 RGB。颜色值接近深色背景上的粉紫主题，但白色背景上的 title、blue、green、yellow 等对比度只有 1.11 到 2.00。

OpenCode 的 system theme 并不是另一组固定 RGB，而是从终端 ANSI palette 生成 `primary/error/warning/success/info/text`。普通 CLI 无法取得 OpenTUI renderer 的 RGBA palette，但可以直接输出相同的 ANSI 语义，让终端完成最后的明暗映射。

### 4.6 Timeline 堆积图会量化掉小组件

当前 Token Timeline 把 Cache Read、Input、Cache Write、Output + Reasoning 放在同一线性 Y 轴的 `renderStackedAreaChart()`。实现对每个非零 slice 做 inclusive fill，但当多个小层映射到同一个 y cell 时，后绘制层会覆盖先绘制层。Cache Read 占 82%-90% 时，8 行 plot 中 Input 通常只剩一行，0.2%-0.4% 的 Cache Write 与 Output + Reasoning 无法同时保留。

增加 chart 高度只能延后而不能解决数量级差；强制 minimum thickness 会把 0.2% 画成至少 12.5%，100% stack 同样受一行像素量化限制。因此该页面必须换成总量主图加独立归一化 component rows，而不是继续调堆积参数。

### 4.7 响应式与空数据

- Dashboard 在 content width 小于 60 时进入独立删减分支，会删除多个整段，而不是单纯 reflow。
- 主要多系列折线显式 `points:false`，覆盖了无色模式原有的 marker fallback。
- 空 report 没有页面级短路，各 section 分别绘制零值；空 Insights 还会因为 cache share 为 0 生成低缓存 action。
- 最终 panel 已能换行且不截断，这个正确基础应保留。

### 4.8 与视觉方案正交的已知风险

以下问题真实存在，但不应混进本次信息架构修改：

- interactive 对 UTF-8 chunk 独立 `toString()`，跨 chunk 字符可能损坏。
- ESC 的 20ms timer、acquire 中途失败、release 单步抛错和快速 range race 缺少测试。
- 正式 build 会联网并重写 models snapshot，不能作为无副作用的首轮验证。
- fork 会复制 Message 与 Part 并生成新 ID，但当前 fork 没有写 Session `parentID`。历史 fork 无可靠 lineage，stats 可能重复 legacy token/tool；不能用标题或字符串相等猜前缀。

这些风险分别需要 interactive 生命周期和 fork provenance 的独立变更。将它们塞进一次视觉 patch 会扩大行为面，且无法帮助本次页面信息恢复。

## 5. 设计系统

### 5.1 视觉语言

Stats 不是卡片型 Web dashboard，而是继承终端字体、背景和行高的高密度分析页。设计语言固定为：

- 结构：section-first，不用圆角卡片矩阵，不用整块背景填充。
- 层级：粗体默认前景用于标题，默认前景用于主要数据，dim 默认前景用于解释与网格。
- 图形：长期趋势用全宽主图；组成用紧凑百分比条；排行用表和短 bar；精确数值永远与图形同时存在。
- 间距：section 之间一空行；同一实体的主行和次行相邻；不通过大面积空白伪造层级。
- 身份：直接显示 model/provider/project/tool/session 名称；ID 只在没有更好名称或需要消歧时出现。
- 语言：标题说明“图回答什么”，单位写在列名或标题中；不输出无法核对的判断性长段落。
- 图表数据墨水：弱化 grid 和 axis，强调数据线与精确值；不用 3D、阴影、背景色或装饰性渐变。

### 5.2 语义颜色

未来实现不新增 `stats.theme`，也不读取 TUI 最近一次主题选择。`ChartColor` 可保持现有调用接口，但内部映射替换为 terminal-defined ANSI：

| 语义角色 | ANSI | 用途 |
|---|---|---|
| text/title/value | default foreground `39` | 所有关键文字和精确值 |
| grid/border/decorative muted | dim default foreground `2;39` | 网格、分隔线、未填充 bar；不能承载唯一信息 |
| axis/unit/help/unavailable | default foreground `39` | 刻度、单位、说明和空态，避免 aggressive dim 主题使语义消失 |
| primary/info/cyan | cyan `36` | active tab、主要提示、主序列 |
| secondary/purple | magenta `35` | 次要系列 |
| success/green | green `32` | completed、健康值、output |
| warning/yellow | yellow `33` | aborted、cache、阈值提醒；用户取消不等同执行错误 |
| error/red | red `31` | error、综合失败率 |
| blue | blue `34` | input、常规分类系列 |
| pink | bright magenta `95` | cost 系列 |
| orange | bright yellow `93` | 第七分类系列；不承担 warning 的唯一编码 |

这与 OpenCode `generateSystem()` 的关键语义一致：primary 为 terminal cyan，secondary 为 terminal magenta，error/warning/success/info 分别来自 terminal red/yellow/green/cyan，text 来自 terminal default foreground。

重要边界：

1. 终端基础色由用户的 Terminal、iTerm2、WezTerm 等主题决定，stats 把最终对比度委托给终端主题，而不再猜测 macOS 外观。极端自定义 palette 仍可能低对比，因此关键信息不能只靠颜色。
2. 不能直接调用 `useTheme()`。它依赖 Solid context、OpenTUI renderer、KV/config provider 和 RGBA 生命周期。
3. 不能直接调用 `resolveRunTheme()`。它要求 `CliRenderer`，返回 run footer/entry/block 专属模型，而且为了普通输出启动 renderer 会引入屏幕和终端查询生命周期。
4. 自定义 OpenCode TUI theme 不自动作用于 stats。要支持它，必须先抽出 renderer-independent 的主题解析与配置选择 seam；这不是本次最小改动。
5. 不输出任何 `48;2`、`48;5`、40-47 或 100-107 背景指令；保留每行边界的 `49m`，防止继承调用者残留背景。
6. `--color never` 与 `NO_COLOR` 输出完全无 ANSI，且去色后的可见文本必须与彩色模式一致。

### 5.3 系列颜色与非颜色编码

分类系列保持稳定顺序：blue、green、yellow、magenta、bright magenta、cyan、bright yellow、red。颜色只表达“不同系列”，不能表达好坏；好坏只用 success/warning/error 语义色。同一实体在主折线、图下直接图例、分析表第一列和短 sparkline 中必须复用同一索引色，不能在不同 section 重新编号。

分析表只在具体指标 cell 上覆盖分类色：高侧风险超过完整过滤后 population 的 `3σ` 使用 red 并附 `!`，超过 `2σ` 使用 bright yellow 并附 `^`。`--limit` 只裁剪显示行，不能改变 sigma 基线；少于三个有效样本、零方差和 unavailable 值不作异常判断。Cache `>=95%` 是正向效率提示，使用 green，不能因数值高被通用异常规则染红。颜色关闭后 `!`、`^`、精确值和布局全部保留。

折线规则：

- 彩色模式不在每个日期绘制 `●`，只绘制一像素细线。
- 图例直接使用完整实体名和对应总量，不用 `[1]`、`[A]`。
- 无色模式不把多系列叠在同一画布，也不恢复密集圆点；改为共享 Y 最大值的对齐 sparkline small multiples，每行直接显示 `◆ ■ ▲ ◇ +`、完整名称和总量。完全重合的系列因此仍各有一行。
- 系列多于 5 条时只在主图展示当前排序前 5；完整 `limit` 行仍在下方表中。
- 彩色画布中两条线完全重合时，后绘制线不能成为唯一证据；legend、下方精确值和 sparkline 仍需可比较。
- 单值或全零 series 不制造退化坐标轴，显示明确空态。
- 组成层共享线性 Y 轴时，若任一有意义层按 plot 高度量化后小于一格，不使用堆积面积图，也不设置虚假的 minimum thickness。Timeline Tokens 固定使用“总量主图 + 每组成独立归一化趋势”，并在每行显示绝对 total/share/peak。
- 单实体内部的 100% composition 使用固定起点、固定总宽度和 largest-remainder 舍入；小于一格的组成可以在 bar 中不可见，但其精确值与占比必须继续显示，不能为可见性伪造最小宽度。

### 5.4 字符和单位

| 数据 | 展示规则 |
|---|---|
| token | `4.1B`、`673.6M`、`430.6K`，列头写 `tokens` 或 `tok/call` |
| 费用 | `$842`、`$5.65`；总计或实体没有记录到正费用时为 `-` 并附 unavailable 说明；现有 schema 不声明“免费”还是“未知” |
| 比例 | 一位小数，例如 `82.7%` |
| 时长 | `820ms`、`12.4s`、`1.7m`，列头写 `avg/req` 或 `avg/call` |
| Tool input/output | 明确写 `in chars/call`、`out chars/call` |
| Tool context | 明确写 `est ctx tok`，不能写成 billed token |
| 日期 | 主轴 `MM-DD`，明细需要年份时用 `YYYY-MM-DD` |
| 缺失值 | ASCII `-`，不用省略号，不把未知格式化成零 |

### 5.5 响应式规则

响应式只改变排版，不改变统计结论或实体身份：

| content width | 布局 |
|---:|---|
| `>=130` | Dashboard 三栏；详细页可并排两个低高度二级区块 |
| `100-129` | 目标桌面布局；主图全宽，比较表横向，二级区块顺序堆叠 |
| `60-99` | 主图全宽；表格变逐实体两行；组成条与 mix 自动换行 |
| `<60` | compact header；主图高度 6；每个实体为 identity + metrics + mix 三行 |

详细页在所有宽度必须保留：header、页面摘要、主趋势、核心绝对值和至少一个维度专属视图。窄屏允许页面变长，不允许删除整个分析问题。

“一到两屏”的可审计基准定义为 `COLUMNS=120`、45 行的开发终端：实际 content width 是 114 列，完整页面包括 header/空行在内不超过 82 行。Dashboard 作为信息最丰富的上限页面；Breakdown、Timeline、Sessions、Insights 目标不超过 64 行。低于 100 列后，完整身份换行优先于固定屏高，因此不承诺仍保持 82 行。

`limit` 的语义统一为“最多显示多少个实体”。显式 `-n/--limit` 在所有宽度优先且不改值；未显式传入时才使用响应式默认：content width `<60` 显示 3 个实体，其他宽度显示 5 个。Breakdown 主趋势和专属明细因而使用同一组 top 5，Sessions 的单条明细固定占五行；总体分布、summary 和 totals 始终基于完整集合，用户仍可用 `-n` 展开更多实体。

### 5.6 空数据与部分数据

全空 report 不应绘制十几张零图。每个页面保留 header 后输出：

```text
No usage data in this range.
Try a wider time range; if filters are active, relax them.
```

部分数据必须区分：

- 有 Tool calls、无 context estimate：展示 calls/chars，另写 `Context estimate unavailable for these records.`。
- 有 tokens、但实体没有记录到正 cost：tokens 正常显示，实体 cost 为 `-`。全局 `Cost` 始终表示持久化 cost 字段之和；现有 schema 没有 completeness flag，因此标题不根据单个零费用实体改名，也不声称账单完整。
- 整个选择范围 cost 为 0：Cost Timeline 显示无正费用记录而不画零折线；Insights 的 cost/M 和 tok/$ 为 `-`；Forecast 显示 unavailable，不把零记录外推成精确 `$0` 预测。
- Project row 已删除：使用 Session directory basename 作为名称，完整 directory 作为 detail；两者都没有时才回退 project ID。
- group 有值但 series 无值：表格正常显示，主图明确写 `No daily series for this selection.`。
- Insights 没有 requests 或 tokens：不触发 cache/failure action。

## 6. 最小数据投影

### 6.1 Request 指标投影需要先补正

新 RequestUsage 路径当前把 Assistant rows 作为 `breakdownEvents`，它们携带 token/cost/components/calls，但 `requests/errors/aborted/duration` 均为 0。对应的 request shell 已经以零 token/零 cost 进入 `totalEvents`，却没有进入 `breakdownEvents`。因此 `UsageGroup` 虽声明 request/health 字段，带 AssistantUsage 的多数 group 并未得到完整 request 指标。

最小修正是：对已经有 Assistant rows 的 request，把现有 request shell 同时加入 `breakdownEvents`。不新建事件类型，也不改变全局 total：

- Assistant event 继续贡献 token、cost、components、assistantCalls。
- Request shell 只贡献一次 requests、status、error/aborted、duration，token/cost/calls 保持 0。
- 没有 Assistant row 的 fallback request event 已经包含两类指标，保持原路径，不能再加 shell。
- 一个 request 有多个 Assistant rows 时仍只加一个 shell，防止 request/error/duration 被调用次数放大。
- Request-level model/provider/source/agent 取 `RequestUsageTable` 的 owner；Assistant-level token/cost 仍按各 Assistant row 的 model/provider。页面列名和说明必须维持这一口径。

Status 还需要一个内部 `outcome?: string`，避免混合 Assistant status 与 request final status：

- request shell 和 fallback request 的 outcome 取 `RequestUsage.status`。
- 有关联 request 的 Assistant event 使用同一个 final outcome，不使用 Assistant row status 建立 Status group。
- cutoff 内有 Assistant row、但 owning request row 在窗口外时 outcome 缺失；legacy Message 同样没有 request outcome。
- Status group/series 按 outcome 聚合；缺失 outcome 的 token/cost/calls 进入单独 `unattributed` usage，不与 completed/error/aborted/running 的 request 行相除。
- `statusFilter` 在有 outcome 时必须比较 request final outcome；只有 cutoff orphan Assistant 和 legacy event 没有 outcome 时才回退 `event.status`。CLI 描述本来就是 request status，不能先按 Assistant status 丢掉 usage、再尝试按 final outcome 建组。

这个投影补正后，Model/Provider/Agent/Source/Project 的 owned requests、failure rate 和 avg/request，以及 Status 的 outcome 指标，才能作为行为契约，而不是只依赖字段形状。Model/Provider 页面必须写明 request-owner 与 Assistant-usage 两种 identity：一个 secondary Assistant model 可以有 tokens/calls，但没有 owned request。

### 6.2 保持不变的数据

以下分析全部直接来自现有 `UsageGroup` / `UsageSeries`，不改数据库也不新增 report 字段：

- 六维 token/cost/request/call/error/abort/duration/session 绝对值。
- input、output、reasoning、cache read、cache write 组成。
- 十类 input context components。
- 每组 top model/provider token mix。
- 每组逐日 token、cost、request、call、failure、duration 和 components。
- Project 的 top sessions，可从 `report.sessions.filter(session.projectID)` 直接得到。
- Status 的 top failing model/provider/source/agent，可从对应 group 的 error/aborted 指标直接得到。

因此不应新增通用 cube、OLAP 层、状态机或任意维度动态查询接口。

### 6.3 Project 可识别身份

仅在 `data.ts` 增加一次批量 Project 元数据读取，输出一个专用类型：

```ts
export type ProjectUsage = UsageGroup & {
  path: string
}

export type StatsReport = {
  // 其他字段不变
  projects: ProjectUsage[]
}
```

映射不变量：

1. `ProjectUsage.id` 始终是原 project ID，series、filter 和关联键不变。
2. `label` 优先使用非空 `ProjectTable.name`。
3. 无 name 时使用 `basename(ProjectTable.worktree)`；basename 同时识别 `/` 与 `\`，不能由当前运行系统决定 Windows 数据库中的路径如何显示。
4. Project row 不存在时使用该 project 下代表性 Session directory 的 basename，并遵循同一跨平台分隔符规则。
5. 仍无法识别时才用 project ID。
6. `path` 优先 worktree，回退 Session directory；用于显示和同名消歧，不参与过滤。
7. Project Breakdown 每个项目只显示一次 path；Sessions 和其他页默认只显示 project label，只有同名消歧时才追加 path，避免重复相同目录。
8. 同名项目不改 label 统计键；path 提供消歧，因此无需给名称拼接随机编号。
9. `label/path` 在构造 `ProjectUsage` 时统一把换行、ESC、C0、DEL 控制字符替换为空格；普通 Unicode 与 shell metacharacters 保留。所有 renderer 因而消费同一安全 display identity。

查询为一次 `select id,name,worktree from project`，不在 group 循环中执行 N+1 查询。

### 6.4 Tool 调用归因

用户需要在 Model/Agent/Project 页面看 Tool 调用和占比，但现有 `ToolUsage` 已按 session/tool 合并，丢掉发起方。最小补充一个内部 report 数组：

```ts
export type ToolCallAttribution = {
  toolID: string
  modelID: string
  providerID: string
  agent: string
  projectID: string
  source: string
  status: string
  calls: number
  inputChars: number
  outputChars: number
  errors: number
  durationMs: number
}

export type StatsReport = {
  // 其他字段不变
  toolCalls: ToolCallAttribution[]
}
```

归因定义：

- ownership 是“当前存储中哪个 Assistant message 拥有 ToolPart”，因此 model/provider/agent 取该 Assistant message，project 取 Session。它不承诺跨 fork 唯一。
- source/status 优先从 `assistant_message_id -> RequestUsageAssistant -> RequestUsage` 关联取得；只有 Assistant row 时 source 沿用当前 `assistant` fallback，status 取 Assistant row。
- 整个 Session 没有 RequestUsage rows 时沿用 legacy 口径：source 为 `legacy-message`，status 为 `completed`。
- Session 已有 RequestUsage、但复制历史 ToolPart 找不到 Assistant row 时使用 `unattributed`/`unknown`。显式 source/status filter 不匹配这些 tuple，不能猜测其请求身份。
- `calls` 是 ToolPart 数量；error 来自 ToolState `error`；duration 只在 completed/error 有 start/end 时累计。
- pending/running 没有结束时间，duration 计 0，但 calls 仍保留。
- input/output 继续是字符数，不改称 token。
- 聚合键为 `projectID + agent + providerID + modelID + source + status + toolID`，避免把每次调用逐条放进 report。
- model/provider/agent/source/status/tool filter 直接作用于 attribution tuple。`--tool` 对非 Tool totals 仍保留既有“筛选调用过该工具的 Sessions”语义，而 Tool mix 只保留名称匹配的 ToolPart；两层语义必须在测试中分别锁定。
- Tool Breakdown 的 calls/chars/errors/duration 必须从过滤后的 `toolCalls` 按 toolID 汇总；estimated context 继续来自过滤后的 `ToolUsageEvent/toolSeries`。不能继续用只按 tool name 过滤的旧 `toolUsage.count` 与已按 model/source/status 过滤的 context 值拼成同一行。

这个数组支持：

- Model -> top tools by calls。
- Provider -> top tools by calls。
- Agent -> top tools by calls。
- Project -> top tools by calls。
- Tool -> issuing model/provider/agent/project mix。

它不支持、也不声称支持：

- Tool 精确成本。
- Tool 自身 billed token。
- Tool output 被后续哪个模型消费的唯一 ownership。
- 跨 fork 去重后的唯一调用次数。

后者继续由现有 `ToolUsageEvent.contextTokens` 表达，并明确标记为 estimated context consumption。不能把 call ownership 与 context consumption 合成一个含糊的“Tool cost”。

### 6.5 不增加的二维 cube

Project/Agent/Source/Status 的 model/provider token mix 已存在于 `UsageGroup.models/providers`。Provider/Model 的 token-only joint 也已存在于 `modelProviderTokens`。本方案不增加任意维度组合的完整 `UsageTotals` cube，因为：

- 页面没有同时消费所有组合。
- 组合数会按维度基数相乘。
- 会扩大 `StatsReport` interface 和测试 fixture。
- 用户需要的页面可由现有单维 group、已有 token mix 和一个 Tool call attribution 投影完成。

### 6.6 Fork 重复不在本 patch 猜测修复

已确认 fork 会复制 Message/Part 并生成全新 message/part ID，且当前没有设置 Session `parentID`。因此历史 fork 的共享前缀不能靠 ID 或字符串等价可靠识别。

新 RequestUsage rows 不随 fork 复制，所以有新 usage 的 fork 常只统计 tail token/cost；但 ToolPart calls 仍从全部复制消息扫描，导致 token 与 Tool count 的 fork 口径可能不一致。这个风险会影响本方案新增的 Tool call attribution，必须在风险说明和测试 fixture 中保留。

正确的后续修复应单独处理：

1. 新 fork 写入 `Session.parentID` 或显式 fork provenance。
2. stats 对有 provenance 的 fork 只扫描 fork 创建时刻后的 legacy Message/ToolPart tail。
3. 历史无 provenance 数据保持原行为或由显式迁移处理，不能启发式去重。

由于该修复触及 Session 创建行为和历史统计口径，本次页面改造不顺带实施。

## 7. 命令与页面映射

### 7.1 Canonical 入口

| 命令 | 页面 | 主指标/附加行为 |
|---|---|---|
| `opencode stats` | Dashboard | 默认 60 天 |
| `opencode stats dashboard` | Dashboard | `--interactive` 可进入循环视图 |
| `opencode stats breakdown [dimension]` | Breakdown | dimension 默认为 model |
| `opencode stats timeline` | Timeline | metric 默认 tokens，`--heatmap` 可追加日历 |
| `opencode stats sessions` | Sessions | 默认按 tokens 排序 |
| `opencode stats insights` | Insights | `--forecast` 才追加预测 |

Breakdown dimensions：`model`、`provider`、`agent`、`source`、`project`、`tool`、`status`。

### 7.2 兼容入口必须复用 canonical renderer 和语义

| 入口 | 等价入口 |
|---|---|
| `stats dash` / `stats overview` / `stats summary` | `stats dashboard` |
| `stats by model` | `stats breakdown model` |
| `stats models` / `stats model` | `stats breakdown model` |
| `stats providers` / `stats provider` | `stats breakdown provider` |
| `stats daily` | `stats timeline` |
| `stats heatmap` / `stats heat` | `stats timeline --heatmap` |
| `stats costs` / `stats cost` | `stats timeline --metric cost` |
| `stats tokens` / `stats token` | `stats timeline --metric tokens` |
| `stats session` | `stats sessions` |
| `stats insight` | `stats insights` |
| `stats forecast` / `stats run-rate` | `stats insights --forecast` |
| `stats --models[=N]` | `stats breakdown model [-n N]` |
| `stats --tools=N` | `stats breakdown tool -n N` |

兼容入口不拥有独立样式、数据逻辑或测试 snapshot。等价参数归一化后必须调用同一 renderer，并产生相同可见正文；命令名、builder 默认值和错误 help 不要求字节级相同。

Root shortcut 的路由边界也属于行为契约：

- `stats --models` 使用 Model Breakdown，`true` 表示全部 model 行，数值表示 `limit`。
- `stats --tools=N` 使用 Tool Breakdown，N 表示可见 tool 行数。
- 同时传 `--tools` 与 `--models` 时保留当前优先级：Tool shortcut 先匹配。测试应锁定该兼容行为，不能让 renderer 重构意外改变 handler 分支。
- `stats --interactive` 进入现有五页循环；非 TTY 仍只输出 Dashboard。
- `tools/models/limit/interactive` 是 root Dashboard/shortcut 的 local options；Timeline、Insights、Forecast 等未声明它们的子命令必须拒绝，而不是继承后静默忽略。`days/all-time/project/color` 仍是所有页面共享的全局参数。

## 8. 120 列完整渲染规范

以下文本是去除 ANSI 后的 proposal fixture。数值复用用户提供的 60 天样例并补充同一量级的关系数据，只用于确认信息结构、单位、层级和密度，不构成统计公式的 golden value。真实 renderer 仍按实际 report 输出。

为便于 Markdown 阅读，示例省去每行右侧 padding；实际 panel 仍保持 `columns - 2` 可见宽度。120 列终端扣除 panel 后的 content width 为 114，以下 fenced output 已用 `Bun.stringWidth` 校验每行不超过 114 列。示例本身不使用省略号代表被隐藏内容。

### 8.1 Dashboard

职责：在一页内回答总量、活跃时间、token 组成、成本与健康、主要实体和 session 长尾。保留当前被认可的全宽图、细线、无粗点和 section-first 布局，不用本次 Breakdown 改造重写 Dashboard。

```text
  opencode stats
  Last 60 days · 60 day window · 573/625 sessions with usage
  Cost $842  $14.0/day  ·  Tokens 4.1B  7.1M avg/session  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  ━━━ Daily activity ───────────────────────────────────────────────────────────────────────────────────────────

  Calendar · cell intensity = daily tokens         Request starts by hour                Day-of-week · token share
        M   T   W   T   F   S   S               00  04  08  12  16  20              Mon ███████████████ 15.5%
    20  ·   ·   ·   ▒▒  ░░  ·   ░░              ▒▓▒▒░░··░▒▒▒█▓▒▓░▒                   Tue ████████████    12.7%
    21  ██  ▒▒  ░░  ▒▒  ▒▒  ░░  ░░                                                     Wed █████████████    13.3%
    22  ▒▒  ▒▒  ▒▒  ▒▒  ▓▓  ░░  ░░              peak 17:00 · 414 req                 Thu ███████████████ 15.0%
    23  ░░  ·   ·   ·   ·   ·   ·               quiet 10:00 · 7 req                 Fri ███████████     11.6%
    24  ·   ·   ░░  ·   ·   ·   ░░                                                  Sat ███████████████████ 21.3%
    25  ·   ·   ·   ░░  ░░  ·   ·               ·0 ░<50 ▒<150 ▓<300 █>=300          Sun ██████████      10.5%
    26  ·   ░░  ██  ░░  ·   ·   ·
    27  ·   ·   ·   ░░  ·   ██  ▓▓
    28  ██  ██  ▒▒  ▓▓  ▒▒  ██  ▓▓

  ░ <50M   ▒ 50-150M   ▓ 150-250M   █ >250M

  ━━━ Token components ─────────────────────────────────────────────────────────────────────────────────────────
      Each panel normalizes to its own peak; totals and shares remain absolute.

  Cache read 3.4B · 82.7% · peak 423.2M/day            Input 673.6M · 16.6% · peak 72.1M/day
  500M │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄          80M │┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄
  300M │       ╭─╮             ╭╯ ╰╮               40M │   ╭──╮│ │       ╭─╯╰╮       ╭╮
  100M │─╮╭────╯ ╰──╮╭─────────╯   ╰─────╮          0M │───╯  ╰╯ ╰───────╯    ╰───────╯╰
     0 │ ╰╯           ╰╯                       ┆        └────────────────────────────────────
       └────────────────────────────────────────        05-14       06-03       06-22   07-12
       05-14       06-03       06-22       07-12

  Cache write 8.6M · 0.2% · peak 4.6M/day              Output 17.6M · 0.4% · peak 2.2M/day
  5.0M │┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄           2.5M │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄
  2.5M │    │ │                                  1.0M │  ╭──╮      ╭─╮      ╭──╯╰╮
     0 │────╯ ╰──────────────────────────────        0 │──╯  ╰──────╯ ╰──────╯     ╰
       └────────────────────────────────────────        └────────────────────────────────────
       05-14       06-03       06-22       07-12        05-14       06-03       06-22   07-12

  ━━━ Cost & health trends ─────────────────────────────────────────────────────────────────────────────────────

  Daily cost                         Cache hit rate                    Abort & error rate
  $140 │┄┄╭╮┄┄┄┄┄┄┄┄┄╭╮┄┄┄          100 │─╮┄┄┄┄┄┄┄╭╮╭──╮             80 │┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄
   $70 │  ││      ╭──╯╰╮              70 │ ╰╮╭──╮  │││  ╰╮            40 │ ╭╮  ╭╮   ││
    $0 │──╯╰──────╯    ╰──────         40 │──╰╯  ╰──╯╰╯   ╰             0 │─╯╰──╯╰───╯╰────
       └────────────────────────            └────────────────────────        └────────────────────────
       05-14    06-03    06-22 07-12        05-14    06-03    06-22 07-12    05-14    06-03    06-22 07-12
  peak $117 on 07-04 · avg $14.0/day    range 31.8%-96.8% · avg 82.9%    spike 80.0% · avg 19.8%

  ━━━ Top models · by token volume ─────────────────────────────────────────────────────────────────────────────

  glm-5.2            ██████████████████████████████████████████████████  2.1B  52.7%  $691  196.7K/call
  gpt-5.5            ██████████████████████████                          1.1B  27.5%     -  120.6K/call
  gpt-5.6-sol        ███████████                                        463M  11.4%     -  156.9K/call
  claude-opus-4-6    ██████                                             240M   5.9%  $133  161.5K/call
  deepseek-v4-pro    █                                                   46M   1.2% $5.65  184.3K/call

  ━━━ Top providers · share of total tokens ────────────────────────────────────────────────────────────────────

  ████████████████████████████████████████████████████████████████████████████████████████████████████████████
  zhipuai 46.1% · DaXiao Codex 35.5% · opencode-go 5.3% · DaXiao 4.8% · DawCode-openai 2.0% · other 6.3%
  zhipuai 1.9B $600 · DaXiao Codex 1.4B - · opencode-go 214.8M $92.0 · DaXiao 195.8M $143

  ━━━ Sessions ─────────────────────────────────────────────────────────────────────────────────────────────────

  Session size distribution                         Top sessions by tokens
     <100K ████████                         60 10.5%  1 loop/goal 端点逻辑分析报告 · 503.0M · $130 · 135 req
   100K-1M ███████████████████████████████  337 58.8%  2 ChatGPT Agent/Browser-use 调研 · 282.5M · $72.7
     1M-5M ████████████                     89 15.5%  3 分支与 dev 分支合并冲突检测 · 209.4M · $109 · 73 req
    5M-50M █████████                         64 11.2%  4 TUI 相邻 thinking 段合并方案 · 167.6M · $19.1 · 57 req
      >50M ███                               23  4.0%  5 OpenCode LSP 模块增强调研 · 137.6M · $43.8 · 42 req
  p50 430.6K · p90 12.8M · p99 118.8M
  top 2 = 19.4% of tokens · top 10 = 43.2%

  ━━━ Insights ─────────────────────────────────────────────────────────────────────────────────────────────────

  458 failed/aborted requests · 19.8% of requests      inspect: opencode stats breakdown status
  Top 2 sessions own 19.4% of tokens                   inspect: opencode stats sessions --sort tokens
  Cache read is 82.7% of tokens                        no material cache threshold crossing
```

### 8.2 Breakdown: Model

职责：比较模型规模、经济性、token 结构、Provider 路由和发起的 Tool 调用。主图仍是全宽 60 天趋势，颜色足以区分时不绘制点。

```text
  opencode stats · Breakdown / Model
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Models · top glm-5.2 2.1B (52.7%) · 17 total · sorted by tokens

  ━━━ Token trend · top 5 models ────────────────────────────────────────────────────────────────────────────────
  500M │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  300M │      ╭─╮            ╭╯ ╰╮             ╭──╮          ╭╮
  100M │─╮╭───╯ ╰─╮╭─────────╯   ╰────╮╭───────╯  ╰──────────╯╰──────╮
     0 │ ╰╯        ╰╯                  ╰╯                              ╰
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  glm-5.2 2.1B · gpt-5.5 1.1B · gpt-5.6-sol 463.4M · claude-opus-4-6 240.0M · deepseek-v4-pro 46.8M

  ━━━ Model portfolio ───────────────────────────────────────────────────────────────────────────────────────────

  model               tokens  share   cost  owned req  calls  tok/call  sessions  owner fail  owner avg
  glm-5.2              2.1B   52.7%   $691        841   1.1K      1.9M       186        8.7%      34.1s
  gpt-5.5              1.1B   27.5%      -        602    811      1.4M       142       15.2%      29.8s
  gpt-5.6-sol        463.4M   11.4%      -        328    447      1.0M        91        4.9%      41.3s
  claude-opus-4-6    240.0M    5.9%   $133        131    198      1.2M        54        2.3%      53.7s
  deepseek-v4-pro     46.8M    1.2%  $5.65         39     57    821.1K        19        7.7%      22.6s

  owned req / owner fail / owner avg follow RequestUsage owner; tokens, cost and calls follow Assistant usage.

  ━━━ Token composition ─────────────────────────────────────────────────────────────────────────────────────────

  glm-5.2             ████████████████████████████████████████████████ 100%
    input 258.0M 12.3% · output 30.0M 1.4% · reasoning 8.0M 0.4% · cache read 1.80B 85.7% · cache write 4.0M 0.2%
  gpt-5.5             ████████████████████████████████████████████████ 100%
    input 181.0M 16.5% · output 20.0M 1.8% · reasoning 4.0M 0.4% · cache read 893.0M 81.2% · cache write 2.0M 0.2%
  gpt-5.6-sol         ████████████████████████████████████████████████ 100%
    input 87.0M 18.8% · output 11.0M 2.4% · reasoning 3.0M 0.6% · cache read 361.4M 78.0% · cache write 1.0M 0.2%
  claude-opus-4-6     ████████████████████████████████████████████████ 100%
    input 56.0M 23.3% · output 7.0M 2.9% · reasoning 2.0M 0.8% · cache read 174.0M 72.5% · cache write 1.0M 0.4%
  ■ input  ■ output  ■ reasoning  ■ cache read  ■ cache write

  每条 bar 的五段依次使用 blue、green、magenta、yellow、bright magenta；模型名仍使用其趋势系列色。
  精确值是无色模式的完整替代编码，量化后不足一格的组成不强制补宽。

  ━━━ Routing & tools ────────────────────────────────────────────────────────────────────────────────────────────

  model               provider mix by tokens                         issued tool calls
  glm-5.2             zhipuai 89.4% · DaXiao 10.6%
                      read 31% · bash 27% · apply_patch 18% · other 24%
  gpt-5.5             DaXiao Codex 76.2% · opencode-go 23.8%        read 35% · grep 25% · bash 22% · other 18%
  gpt-5.6-sol         DaXiao Codex 91.8% · DawCode-openai 8.2%
                      read 29% · apply_patch 28% · bash 24% · other 19%
  claude-opus-4-6     opencode-go 61.0% · claudecode 39.0%          read 41% · grep 24% · task 19% · other 16%
  deepseek-v4-pro     DaXiao 100.0%
                      read 38% · bash 31% · webfetch 20% · other 11%

  Tool shares count ToolParts issued by each model; they are not Tool cost or billed tokens.
```

### 8.3 Breakdown: Provider

职责：比较 Provider 的费用、容量、稳定性、模型路由和调用结构。Provider 默认主指标与排序仍为 cost。

```text
  opencode stats · Breakdown / Provider
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Providers · top zhipuai $600 (71.3%) · 9 total · sorted by cost

  ━━━ Cost trend · top 5 providers ──────────────────────────────────────────────────────────────────────────────
  $140 │┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄╭──╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   $70 │   ││       ╭──╮                ╭╯╰╮      ╭──╯  ╰╮
    $0 │───╯╰───────╯  ╰────────────────╯   ╰──────╯       ╰───────────────
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  zhipuai $600 · DaXiao $143 · opencode-go $92.0 · claude-opus $6.69 · deepseek $0.34

  ━━━ Provider economics ─────────────────────────────────────────────────────────────────────────────────────────

  provider          tokens  share   cost  cost share  owned req  calls  $/call  cache  owner fail  owner avg
  zhipuai             1.9B  46.1%   $600       71.3%        782    936    $0.64  86.2%        7.8%      31.8s
  DaXiao Codex        1.4B  35.5%      -           -        641    854        -  81.7%        5.6%      37.3s
  opencode-go       214.8M   5.3%  $92.0       10.9%        229    281    $0.33  79.4%        3.5%      28.1s
  DaXiao            195.8M   4.8%   $143       17.0%        171    219    $0.65  74.3%        9.4%      42.6s
  DawCode-openai     82.2M   2.0%      -           -        104    128        -  77.1%        4.8%      26.5s

  Request-owner metrics can be zero for a provider that only appears on secondary Assistant calls.
  Risk marks compare the full provider population: ! >=3σ, ^ >=2σ. Cache >=95% is highlighted as healthy.

  ━━━ Model portfolio by provider ────────────────────────────────────────────────────────────────────────────────

  zhipuai            glm-5.2 96.8% · deepseek-v4-pro 2.5% · other 0.7%
  DaXiao Codex       gpt-5.5 58.6% · gpt-5.6-sol 30.4% · other 11.0%
  opencode-go        claude-opus-4-6 68.2% · claude-sonnet-4-6 22.1% · other 9.7%
  DaXiao             gpt-5.5 74.5% · deepseek-v4-pro 23.9% · other 1.6%
  DawCode-openai     gpt-5.6-sol 81.3% · gpt-5.5 18.7%

  ━━━ Capacity & reliability ─────────────────────────────────────────────────────────────────────────────────────

  provider          tok/$       tok/call   output  errors  aborted  completed   recent cost/day
  zhipuai            3.2M          2.0M      1.8%      34       27        721      ▁▂▂▃▄▅▃▆▇▅▆█
  DaXiao Codex          -          1.6M      1.4%      21       15        605      ▂▂▃▃▄▅▅▅▆▆▇█
  opencode-go        2.3M        764.4K      2.7%       5        3        221      ▁▁▂▂▃▂▄▃▅▄▆▅
  DaXiao             1.4M        894.1K      2.1%      10        6        155      ▃▂▂▄▃▅▂▆▄▅▃▇
  DawCode-openai        -        642.2K      2.4%       3        2         99      ▁▂▁▃▂▄▃▃▅▄▆▅
```

### 8.4 Breakdown: Agent

职责：比较不同 Agent 的工作负载、请求密度、上下文构成、模型/Provider 选择和 Tool 使用。Context 百分比必须覆盖完整分母，不能只列四类后让总和失真。

```text
  opencode stats · Breakdown / Agent
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Agents · top build 2.6B (63.4%) · 6 total · sorted by tokens

  ━━━ Token trend · top 5 agents ────────────────────────────────────────────────────────────────────────────────
  500M │┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭──╮┄┄┄┄┄┄┄┄
  250M │    ╭───╯ ╰╮       ╭──╮       ╭───╯╰╮        ╭─╮       ╭╯  ╰╮
     0 │────╯       ╰───────╯  ╰───────╯      ╰────────╯ ╰───────╯    ╰────────
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  build 2.6B · plan 782.4M · explore 391.7M · general 214.2M · title 77.3M

  ━━━ Agent workload ────────────────────────────────────────────────────────────────────────────────────────────

  agent       tokens  sessions   cost  owned req  calls  calls/req  tok/session  cache  owner fail  owner avg
  build         2.6B       401   $619      1.4K   1.8K       1.3         6.5M   84.7%  7.2%    38.4s
  plan        782.4M       188   $126        421    566       1.3         4.2M   79.1%  3.8%    44.1s
  explore     391.7M       143  $55.2        302    377       1.2         2.7M   81.5%  2.3%    21.7s
  general     214.2M        67  $35.8        139    172       1.2         3.2M   76.4%  5.0%    52.8s
  title        77.3M       573  $6.15        573    573       1.0       134.9K   69.8%  0.2%     2.1s

  ━━━ Input context composition ─────────────────────────────────────────────────────────────────────────────────

  agent       system  instruct  skills  schemas   user  assistant  reasoning  tool calls  tool results  attach
  build         5.8%      4.1%    6.7%    18.6%  11.4%      12.2%       7.1%        6.5%         26.9%    0.7%
  plan          8.7%      6.3%    9.4%    11.2%  18.8%      18.1%      10.6%        2.8%         13.7%    0.4%
  explore       6.9%      3.8%    5.1%    20.4%  10.7%      10.2%       5.6%        8.2%         28.5%    0.6%
  general       7.4%      5.8%    7.2%    14.1%  16.6%      15.4%       9.3%        4.7%         18.9%    0.6%
  title        16.2%      8.1%    0.0%     2.4%  55.7%      15.9%       1.2%        0.0%          0.0%    0.5%

  ━━━ Runtime mix ───────────────────────────────────────────────────────────────────────────────────────────────

  agent       top models by tokens                       top providers by tokens
  build       glm-5.2 58% · gpt-5.5 25% · other 17%     zhipuai 51% · DaXiao Codex 37%
              tools: read 30% · bash 26% · apply_patch 20% · other 24%
  plan        gpt-5.5 46% · glm-5.2 33% · other 21%     DaXiao Codex 55% · zhipuai 31%
              tools: read 36% · grep 25% · task 14% · other 25%
  explore     glm-5.2 41% · gpt-5.6-sol 38% · other 21% DaXiao Codex 48% · zhipuai 42%
              tools: grep 34% · read 31% · glob 23% · other 12%
  general     claude-opus 39% · glm-5.2 35% · other 26% opencode-go 44% · zhipuai 38%
              tools: task 29% · read 28% · webfetch 21% · other 22%
  title       gpt-5.5 62% · glm-5.2 38%                 DaXiao Codex 62% · zhipuai 38%      no ToolPart calls
```

### 8.5 Breakdown: Source

职责：解释请求从哪些执行路径进入、每类流量的规模/费用/失败/延迟，以及不同 source 携带何种上下文和路由到哪些模型。

```text
  opencode stats · Breakdown / Source
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Sources · top chat 2.7B (65.9%) · 5 total · sorted by tokens

  ━━━ Token trend · request sources ─────────────────────────────────────────────────────────────────────────────
  500M │┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  250M │  ╭────╮   │ ╰╮      ╭──╮     ╭─╮     ╭╯╰╮       ╭─╮
     0 │──╯    ╰───╯  ╰──────╯  ╰─────╯ ╰─────╯   ╰───────╯ ╰──────────
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  chat 2.7B · subtask 711.2M · command 382.6M · compaction 244.1M · legacy-message 62.1M

  ━━━ Source workload ───────────────────────────────────────────────────────────────────────────────────────────

  source       owned req  calls   tokens  tok/req*   cost  cost/req*  sessions  cache  output  fail*  avg*
  chat           1.3K    1.6K     2.7B      2.1M   $564     $0.43       482  83.6%    1.8%  4.1%    36.7s
  subtask         351     508   711.2M      2.0M   $147     $0.42       129  85.1%    1.5%  6.8%    48.2s
  command         286     317   382.6M      1.3M  $82.4     $0.29       171  77.7%    2.3%  3.5%    19.8s
  compaction      221     221   244.1M      1.1M  $43.6     $0.20       143  88.9%    0.9%  1.4%    41.1s
  legacy-message    0      74    62.1M         -  $5.00         -        37  69.2%    2.8%     -        -

  * request-owner denominator and health; legacy Assistant usage has no owned request.

  ━━━ Input context composition ─────────────────────────────────────────────────────────────────────────────────

  chat          schemas 17.2% · tool results 26.1% · user 13.8% · assistant 12.6% · system 6.4% · other 23.9%
  subtask       schemas 21.8% · tool results 31.4% · user 8.6% · assistant 9.1% · system 5.9% · other 23.2%
  command       user 24.7% · instructions 14.3% · schemas 13.8% · tool results 12.1% · system 9.2% · other 25.9%
  compaction    assistant 28.9% · reasoning 18.7% · tool results 16.3% · user 12.4% · system 7.1% · other 16.6%
  legacy-msg    component attribution unavailable for these records

  ━━━ Routing mix ───────────────────────────────────────────────────────────────────────────────────────────────

  source        models by tokens                                  providers by tokens
  chat          glm-5.2 49% · gpt-5.5 29% · gpt-5.6-sol 14%      zhipuai 46% · DaXiao Codex 38% · other 16%
  subtask       glm-5.2 61% · claude-opus-4-6 21% · other 18%    zhipuai 55% · opencode-go 27% · other 18%
  command       gpt-5.5 44% · gpt-5.6-sol 33% · other 23%        DaXiao Codex 69% · DawCode-openai 18% · other 13%
  compaction    glm-5.2 52% · gpt-5.5 37% · other 11%            zhipuai 58% · DaXiao Codex 34% · other 8%
  legacy-msg    glm-5.2 73% · gpt-5.5 27%                         zhipuai 73% · DaXiao Codex 27%
```

### 8.6 Breakdown: Project

职责：让用户按可识别项目定位成本、会话长尾、模型/Provider/Tool 结构。Project ID 只作为无元数据时的最后回退，不作为默认名称。

```text
  opencode stats · Breakdown / Project
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Projects · top opencode 2.8B (68.3%) · 8 total · sorted by tokens

  ━━━ Token trend · top 5 projects ──────────────────────────────────────────────────────────────────────────────
  500M │┄┄┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  250M │  ╭──╮      ╭╯ ╰╮   ╭─╮        ╭──╮    ╭╯╰╮       ╭╮
     0 │──╯  ╰──────╯    ╰───╯ ╰────────╯  ╰────╯   ╰───────╯╰────────
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  opencode 2.8B · chatgpt-browser-agent 541.8M · personal-notes 331.2M · sdk-playground 204.5M · docs-site 98.1M

  ━━━ Project portfolio ─────────────────────────────────────────────────────────────────────────────────────────

  opencode
    /Users/sunbenteng/Project/opencode
    2.8B tok 68.3% · $621 · 334 sessions · 1.5K req · 1.9K calls · 60 active days · cache 84.8% · fail 5.1%
  chatgpt-browser-agent
    /Users/sunbenteng/Project/opencode/thirdparty/chatgpt-browser-agent
    541.8M tok 13.2% · $103 · 71 sessions · 284 req · 361 calls · 31 active days · cache 79.6% · fail 3.2%
  personal-notes
    /Users/sunbenteng/Documents/personal-notes
    331.2M tok 8.1% · $47.8 · 88 sessions · 191 req · 228 calls · 44 active days · cache 77.4% · fail 1.6%
  sdk-playground
    /Users/sunbenteng/Project/sdk-playground
    204.5M tok 5.0% · $41.3 · 39 sessions · 127 req · 151 calls · 19 active days · cache 73.2% · fail 8.7%
  docs-site
    /Users/sunbenteng/Project/docs-site
    98.1M tok 2.4% · $14.6 · 24 sessions · 81 req · 96 calls · 16 active days · cache 81.1% · fail 2.5%

  ━━━ Runtime mix ───────────────────────────────────────────────────────────────────────────────────────────────

  project                 models by tokens                         providers by tokens
  opencode                glm-5.2 54% · gpt-5.5 28% · other 18%   zhipuai 49% · DaXiao Codex 36%
                          tools: read 31% · bash 25% · apply_patch 20% · other 24%
  chatgpt-browser-agent   gpt-5.6-sol 43% · glm-5.2 37% · other 20% DaXiao Codex 57% · zhipuai 31%
                          tools: webfetch 35% · read 29% · bash 18% · other 18%
  personal-notes          gpt-5.5 57% · glm-5.2 29% · other 14%   DaXiao Codex 62% · zhipuai 27%
                          tools: read 47% · grep 24% · apply_patch 12% · other 17%
  sdk-playground          claude-opus 42% · gpt-5.6-sol 38%       opencode-go 49% · DaXiao Codex 41%
                          tools: bash 33% · read 27% · task 18% · other 22%
  docs-site               glm-5.2 64% · gpt-5.5 24% · other 12%   zhipuai 68% · DaXiao Codex 24%
                          tools: read 40% · apply_patch 28% · grep 19% · other 13%

  ━━━ Largest sessions inside each project ──────────────────────────────────────────────────────────────────────

  opencode                loop/goal 端点逻辑分析报告 · 503.0M tok · $130 · 135 req
  chatgpt-browser-agent   ChatGPT Agent 与 Browser-use CLI 对比调研 · 282.5M tok · $72.7 · 136 req
  personal-notes         知识库索引与检索方案 · 91.4M tok · $13.1 · 41 req
  sdk-playground         Provider SDK 兼容性实验 · 77.8M tok · $18.6 · 29 req
  docs-site              CLI 文档本地化审计 · 42.2M tok · $6.21 · 18 req
```

### 8.7 Breakdown: Tool

职责：区分真实调用 footprint 与估算 context footprint，说明单位、分母、失败和发起方；不显示伪造成本。

```text
  opencode stats · Breakdown / Tool
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Tools · 18.4K calls · 629.8M estimated context tokens · sorted by estimated context tokens

  ━━━ Estimated context trend · top 5 tools ─────────────────────────────────────────────────────────────────────
  90M │┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  45M │  ╭──╮    ╭╯╰╮       ╭──╮       ╭──╯ ╰╮      ╭─╮
   0M │──╯  ╰────╯   ╰───────╯  ╰───────╯      ╰──────╯ ╰──────────
      └─────────────────────────────────────────────────────────────────────────────────────────────
      05-14                    06-03                    06-22                    07-12
  read 214.2M · bash 161.8M · apply_patch 103.7M · task 71.4M · grep 43.8M est ctx tok

  ━━━ Tool footprint ────────────────────────────────────────────────────────────────────────────────────────────

  tool          calls  call share  est ctx tok  ctx share  ctx/call  in chars/c  out chars/c  errors  avg/call
  read           5.7K       31.0%      214.2M      34.0%      37.6K          128.4          8.2K      12      18ms
  bash           4.4K       23.9%      161.8M      25.7%      36.8K          211.7         12.4K      96      2.4s
  apply_patch    2.9K       15.8%      103.7M      16.5%      35.8K          642.1            72      21      31ms
  task           1.8K        9.8%       71.4M      11.3%      39.7K          381.6          1.7K      17     48.1s
  grep           1.6K        8.7%       43.8M       7.0%      27.4K           93.2          5.4K       8      94ms
  webfetch        711        3.9%       18.1M       2.9%      25.5K          144.9         18.7K      29      3.8s
  glob            628        3.4%       10.7M       1.7%      17.0K           58.1          3.1K       2      41ms
  question        344        1.9%        4.8M       0.8%      14.0K          202.7            18       0      9.7s

  est ctx tok approximates how much prior Tool input/output appears in later Assistant input.
  Calls, chars, errors and duration come from ToolPart; no row represents Tool cost or billed tokens.
  Tool errors are ToolPart execution errors; --status filters associated request/Assistant status, not ToolState.

  ━━━ Issuing runtime ───────────────────────────────────────────────────────────────────────────────────────────

  tool          top models by calls                         top agents by calls
  read          glm-5.2 38% · gpt-5.5 27% · other 35%      build 57% · explore 21%
                projects: opencode 69% · personal-notes 11% · other 20%
  bash          glm-5.2 42% · gpt-5.6-sol 31% · other 27% build 71% · general 12%            opencode 76% · sdk 9%
  apply_patch   gpt-5.6-sol 39% · glm-5.2 36% · other 25% build 83% · plan 8%
                projects: opencode 88% · docs-site 5% · other 7%
  task          glm-5.2 45% · claude-opus 32% · other 23% general 49% · plan 31%
                projects: opencode 72% · chatgpt-browser-agent 17% · other 11%
  grep          gpt-5.5 36% · glm-5.2 34% · other 30%     explore 46% · build 38%
                projects: opencode 81% · personal-notes 8% · other 11%
```

如果 legacy 数据有 calls 但所有 context estimate 都为 0，完整页面改为：

```text
  Tools · 18.4K calls · context estimate unavailable · sorted by calls
  Context estimate unavailable for these records; call share remains separate.
  It is never relabeled as context share.
```

### 8.8 Breakdown: Status

职责：比较请求结果、失败趋势、耗时和失败来源。Status 的核心量纲是 requests，不应只按 token 排名。

```text
  opencode stats · Breakdown / Status
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights
  Request outcomes · 2.3K total · 1.8K completed · 291 error · 167 aborted · 12 running

  ━━━ Request outcome trend ─────────────────────────────────────────────────────────────────────────────────────
  80% │ completed ───────────────────────╮╭──────────────────────────╮╭─────────────────────────
  40% │                                  ╰╯                          ╰╯
  20% │ error      ───╮─────╮──────────────╭─╮───────╮──────────╭─────────╮
   0% │ aborted       ╰─────╯              ╰─╯       ╰──────────╯         ╰
      └─────────────────────────────────────────────────────────────────────────────────────────────
      05-14                    06-03                    06-22                    07-12

  ━━━ Outcome distribution ──────────────────────────────────────────────────────────────────────────────────────

  completed  ████████████████████████████████████████████  1.8K  79.7%  3.3B tok  $699  24.8s avg
  error      ███████                                      291   12.6%  488M tok  $91.2  71.4s avg
  aborted    ████                                         167    7.2%  276M tok  $49.7  46.8s avg
  running    █                                             12    0.5%   18M tok  $2.10          -

  Unattributed usage · 62.1M tok · $5.00 · 74 calls · no owning request outcome

  ━━━ Status efficiency ─────────────────────────────────────────────────────────────────────────────────────────

  status       req share  tokens/req  cost/req  calls/req  cache  output  sessions
  completed        79.7%        1.8M     $0.38        1.3   84.8%    1.7%       531
  error            12.6%        1.7M     $0.31        1.1   77.2%    2.4%       119
  aborted           7.2%        1.7M     $0.30        1.0   74.8%    1.1%        84
  running           0.5%        1.5M     $0.18        1.0   81.3%    0.8%         9

  ━━━ Failure leaders within each dimension ────────────────────────────────────────────────────────────────────

  dimension   leader                  failed req   rate in leader   share of all failures
  model       gpt-5.5                        123  15.2%                  26.9%
  provider    zhipuai                         61   7.8%                  13.3%
  source      subtask                         24   6.8%                   5.2%
  agent       build                          101   7.2%                  22.1%
  project     opencode                        77   5.1%                  16.8%

  Outcome ratios exclude unattributed usage. Each leader row is an independent query, not a partition.
  One failed request contributes to every applicable dimension.
  Errors and aborted requests remain separate outcomes; the combined failure rate is 19.8%.
```

### 8.9 Timeline: Tokens

职责：回答 60 天内“什么时候变化、token 由什么组成、哪些日期与实体驱动变化”。默认不追加日历热力图，避免与 Dashboard 重复。

这里不使用绝对值或 100% 堆积面积图。以 8 行 plot 为例，Cache Read 占 82%-90% 时会占 7 行，Input 至多 1 行，0.2%-0.4% 的 Cache Write 与 Output + Reasoning 会量化为 0 行；给小层强制最小一行又会夸大其份额。改为一张绝对总量主图和四条独立归一化组件趋势，形状比较看 sparkline，量级比较只看同一行的 total/share/peak。

```text
  opencode stats · Timeline / Tokens
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  ━━━ Daily token volume ────────────────────────────────────────────────────────────────────────────────────────

  500M │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭─╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  300M │      ╭─╮            ╭───╯ ╰╮           ╭──╮         ╭╮
  100M │─╮╭───╯ ╰─╮╭─────────╯       ╰──╮╭───────╯  ╰─────────╯╰──────╮
     0 │ ╰╯        ╰╯                    ╰╯                             ╰
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  total 4.1B · peak 423.2M/day · avg 68.3M/day

  Token components · each trend independently normalized; compare magnitude using totals and peaks
  ▓ Cache read          ▁▃▂▄▅▃▁▂▅█▆▄▂▃▇▅▂▁▄▆▃▂▅▇▆▄▂▃▅▇  3.4B 82.7% · peak 423.2M/day
  ░ Input               ▂▄▃▅▆▄▂▃▆█▇▅▃▄▇▆▃▂▅▇▄▃▆█▇▅▃▄▆▇  673.6M 16.6% · peak 72.1M/day
  ▒ Cache write         ▃▂▁█▇▃▂▁▂▃▂▁▁▂▃▂▁▁▂▃▂▁▁▂▃▂▁▁▂▃  8.6M 0.2% · peak 4.6M/day
  ▎ Output + reasoning  ▂▃▂▄▅▃▂▃▄▆▅▃▂▄▅▄▂▃▅▇▆▄▃▅▆█▅▄▆▇  17.6M 0.4% · peak 2.2M/day

  ━━━ Health and efficiency ─────────────────────────────────────────────────────────────────────────────────────

  Daily cost       ▁▂▂▃▅▇▄▃▂▂▁▂▁▂▆█▅▄▃▂▂▁▃▄▅▃▂▆▅▄▃▆  $842 total  · $14.0/day
  Requests         ▂▃▄▅▅▆▇▆▅▄▃▄▃▄▆▇█▇▆▅▄▅▆▇▇▆▅▇▆▅▄▅  2.3K total · 38.4/day
  Cache read       ▇▇▆▆▅▅▅▄▃▃▄▅▆▇▇▆▅▄▃▅▆▇▇▇▆▅▄▆▇▇█▇  82.7% of tokens
  Failures         ▂▂▃▄▂▁▂▅▆▃▂▁▂▃▄▅█▆▄▃▂▂▁▃▅▆▃▂▄▃▂▂  19.8% · 458 requests
  Latency          ▃▄▅▅▆▅▄▃▄▅▆▇▅▄▃▄▆█▇▅▄▃▅▆▇▆▄▃▅▆▄▃  36.4s avg/request

  ━━━ Top active days ───────────────────────────────────────────────────────────────────────────────────────────

  date        tokens   cost  req   fail  cache  output  avg/req
  07-04       423.2M   $117   96  12.5%  91.3%    1.8%    48.2s
  06-14       397.8M  $88.4   80  80.0%  76.2%    2.7%    71.3s
  06-28       344.1M  $72.1   84   4.8%  88.7%    1.5%    39.6s
  05-21       311.5M  $65.2   77   6.5%  84.9%    1.9%    35.7s
  07-11       298.6M  $61.3   69   2.9%  90.1%    1.4%    42.8s

  ━━━ Entity trends ─────────────────────────────────────────────────────────────────────────────────────────────

  Models
  glm-5.2           ▁▂▃▄▅▆▅▄▃▅▆█▇▆  2.1B  52.7%
  gpt-5.5           ▂▃▄▃▅▄▆▇▅▄▃▅▆▇  1.1B  27.5%
  gpt-5.6-sol       ▁▁▂▃▃▄▅▄▆▅▇▆▇█  463M  11.4%

  Providers
  zhipuai           ▁▂▃▄▅▆▅▄▃▅▆█▇▆  1.9B  46.1%
  DaXiao Codex      ▂▃▄▃▅▄▆▇▅▄▃▅▆▇  1.4B  35.5%
  opencode-go       ▁▂▁▃▂▄▃▃▅▄▆▅▇▆  214M   5.3%
```

### 8.10 Timeline: Cost

`stats timeline --metric cost`、`stats costs` 和 `stats cost` 共用以下完整页面。它与 token timeline 共用 health/active day/entity 结构，但主图和排序都切换为费用，不重复绘制 token area。

```text
  opencode stats · Timeline / Cost
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  ━━━ Daily cost ────────────────────────────────────────────────────────────────────────────────────────────────

  $140 │┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄┄┄┄╭──╮┄┄┄┄┄┄┄┄┄┄┄┄┄
   $70 │   ││       ╭──╮                ╭──╮   ╭╯╰╮      ╭────╯  ╰╮
   $20 │───││───╮╭──╯  ╰╮──────╭────────╯  ╰───╯   ╰──────╯        ╰──╮
    $0 │   ╰╯   ╰╯       ╰──────╯                                      ╰──────
       └────────────────────────────────────────────────────────────────────────────────────────────
       05-14                    06-03                    06-22                    07-12
  total $842 · avg $14.0/day · peak $117 on 07-04 · 47/60 active days

  ━━━ Health and efficiency ─────────────────────────────────────────────────────────────────────────────────────

  Tokens            ▂▃▄▅▅▆▇▆▅▄▃▄▃▄▆▇█▇▆▅▄▅▆▇▇▆▅▇▆▅▄▅  4.1B total
  Requests          ▂▃▄▅▅▆▇▆▅▄▃▄▃▄▆▇█▇▆▅▄▅▆▇▇▆▅▇▆▅▄▅  2.3K total
  Cache read        ▇▇▆▆▅▅▅▄▃▃▄▅▆▇▇▆▅▄▃▅▆▇▇▇▆▅▄▆▇▇█▇  82.7% of tokens
  Failures          ▂▂▃▄▂▁▂▅▆▃▂▁▂▃▄▅█▆▄▃▂▂▁▃▅▆▃▂▄▃▂▂  19.8% · 458 requests
  Latency           ▃▄▅▅▆▅▄▃▄▅▆▇▅▄▃▄▆█▇▅▄▃▅▆▇▆▄▃▅▆▄▃  36.4s avg/request

  ━━━ Top cost days ─────────────────────────────────────────────────────────────────────────────────────────────

  date        cost    tokens  req   fail  cache  output  avg/req
  07-04       $117    423.2M   96  12.5%  91.3%    1.8%    48.2s
  06-14      $88.4    397.8M   80  80.0%  76.2%    2.7%    71.3s
  06-28      $72.1    344.1M   84   4.8%  88.7%    1.5%    39.6s
  05-21      $65.2    311.5M   77   6.5%  84.9%    1.9%    35.7s
  07-11      $61.3    298.6M   69   2.9%  90.1%    1.4%    42.8s

  ━━━ Cost drivers ──────────────────────────────────────────────────────────────────────────────────────────────

  Models
  glm-5.2           ▁▂▃▄▅▆▅▄▃▅▆█▇▆   $691  82.1%
  claude-opus-4-6  ▁▂▁▃▂▄▃▃▅▄▆▅▇▆   $133  15.8%
  deepseek-v4-pro  ▁▁▂▂▃▂▄▃▅▄▆▅▅▆  $5.65   0.7%

  Providers
  zhipuai           ▁▂▃▄▅▆▅▄▃▅▆█▇▆   $600  71.3%
  DaXiao            ▂▃▄▃▅▄▆▇▅▄▃▅▆▇   $143  17.0%
  opencode-go       ▁▂▁▃▂▄▃▃▅▄▆▅▇▆  $92.0  10.9%
```

### 8.11 Timeline: Heatmap

`stats timeline --heatmap`、`stats heatmap` 和 `stats heat` 在对应 Timeline 完整页面末尾追加以下区块，不替换主图：

```text
  ━━━ Token heatmap · calendar view ─────────────────────────────────────────────────────────────────────────────

  Mon  ··  ██  ▒▒  ░░  ··  ··  ··  ··  ██
  Tue  ··  ▒▒  ▒▒  ··  ··  ··  ░░  ··  ██
  Wed  ··  ░░  ▒▒  ··  ░░  ··  ██  ··  ▒▒
  Thu  ▒▒  ▒▒  ▒▒  ··  ··  ░░  ░░  ░░  ▓▓
  Fri  ░░  ▒▒  ▓▓  ··  ··  ░░  ··  ··  ▒▒
  Sat  ··  ░░  ░░  ··  ··  ··  ··  ██  ██
  Sun  ░░  ░░  ░░  ··  ░░  ··  ··  ▓▓  ▓▓

  · 0   ░ <=25% peak   ▒ <=50% peak   ▓ <=75% peak   █ >75% peak   peak 423.2M
```

Timeline Heatmap 保留现有 report-relative intensity：四档分别对应当前选择窗口 peak 的 25%/50%/75%/100%，legend 同时打印格式化 peak。Cost metric 复用相同比例并将 peak 格式化为美元，不能复用 token 的 M 单位。零值始终使用 `·`。

Dashboard Calendar 继续使用当前固定 token 阈值 `<50M / 50-150M / 150-250M / >250M`，其目的是跨窗口保持同一强度基准；Timeline Heatmap 则用于观察当前选择内的相对形状。两者职责不同，不在本 patch 强行统一。

### 8.12 Sessions

职责：先展示 session population 与长尾，再给出可定位、可比较的单 session 明细。全局 Tool 排名留在 Tool Breakdown；每条 session 仍显示自己的 model/provider/project 和工具数量。

```text
  opencode stats · Sessions
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  ━━━ Session population ────────────────────────────────────────────────────────────────────────────────────────

  usage       4.1B tokens · $842 · 573/625 sessions with usage · 2.3K requests
  p50         430.6K tokens · $0.18 · 3.7 calls/session
  p90          12.8M tokens · $4.72
  p95          31.4M tokens · $11.6
  p99         118.8M tokens · $43.8
  max         503.0M tokens · $130 · 135 requests · 48.2s avg/request

  ━━━ Session size distribution · tokens ────────────────────────────────────────────────────────────────────────

  <100K       ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   60  10.5%
  100K-1M     ███████████████████████████████████████████████████████████████  337  58.8%
  1M-5M       █████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   89  15.5%
  5M-50M      ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   64  11.2%
  >50M        ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   23   4.0%
  top 2 19.4% · top 10 43.2% · mean/median 16.5x

  ━━━ Session cost distribution · positive recorded cost (421 sessions) ─────────────────────────────────────────

  <$0.10      ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   48  11.4%
  $0.10-$1    ███████████████████████████████████████████████████████████████  221  52.5%
  $1-$5       ███████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   82  19.5%
  $5-$10      ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   39   9.3%
  >$10        █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   31   7.4%
  No positive recorded cost · 152 sessions

  ━━━ Session leaderboard · sorted by tokens · bar = token share ────────────────────────────────────────────────

  1  loop/goal 端点逻辑分析报告
     token share ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  12.3%  503.0M
     project opencode · $130 · 135 req / 171 calls · 312 msg / 1.1K tools
     cache 91.2% · fail 7 · 48.2s avg/request · updated 07-12
     models glm-5.2, gpt-5.5, gpt-5.6-sol · providers zhipuai, DaXiao Codex

  2  ChatGPT Agent 与 Browser-use CLI 对比调研
     token share ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   6.9%  282.5M
     project chatgpt-browser-agent · $72.7 · 136 req / 184 calls · 276 msg / 892 tools
     cache 86.7% · fail 11 · 44.6s avg/request · updated 07-11
     models glm-5.2, gpt-5.6-sol · providers zhipuai, DaXiao Codex

  3  分支与 dev 分支合并冲突检测
     token share ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   5.1%  209.4M
     project opencode · $109 · 73 req / 96 calls · 188 msg / 611 tools
     cache 79.4% · fail 4 · 52.1s avg/request · updated 07-10
     models claude-opus-4-6, deepseek-v4-pro, gpt-5.5 · providers DaXiao, opencode-go

  4  TUI 相邻 thinking 段合并与收缩方案
     token share ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   4.1%  167.6M
     project opencode · $19.1 · 57 req / 71 calls · 129 msg / 442 tools
     cache 88.3% · fail 2 · 39.8s avg/request · updated 07-09
     models glm-5.2, gpt-5.6-sol · providers zhipuai, DaXiao Codex

  5  OpenCode LSP 模块增强调研
     token share ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   3.4%  137.6M
     project opencode · $43.8 · 42 req / 55 calls · 108 msg / 377 tools
     cache 83.6% · fail 1 · 47.3s avg/request · updated 07-08
     models glm-5.2 · providers zhipuai

  Visible 5 of 573 usage sessions · 31.7% of tokens · 44.5% of cost · use -n to change rows
```

`--sort cost/calls/updated` 只改变 leaderboard 顺序和标题，Population、Distribution 和每行指标不改变。

### 8.13 Insights

职责：把组成、集中度、波动、离群和阈值放在同一证据页；先呈现可核对事实，再提供最多三条可行动信号。默认不显示预测。

```text
  opencode stats · Insights
  Last 60 days · 573/625 sessions with usage
  Cost $842  ·  Tokens 4.1B  ·  Requests 2.3K  ·  Cache 82.9%  ·  Fail 458
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  ━━━ Usage shape ───────────────────────────────────────────────────────────────────────────────────────────────

  tokens  cache read █████████████████████████████████████████ 3.4B 82.7%
          input ████████ 673.6M 16.6% · output 17.6M 0.4% · cache write 8.6M 0.2%
  input   tool results ███████████ 26.9% · schemas ████████ 18.6% · user █████ 11.4%
          assistant 12.2% · reasoning 7.1% · system 5.8% · instructions 4.1% · skills 6.7% · other 7.2%
  efficiency $0.21/M tok · 4.9M tok/$ · 82.7% cache read · 1.3 calls/request

  ━━━ Attribution ───────────────────────────────────────────────────────────────────────────────────────────────

  dimension   leader             token share    cost  recent cost change  owner fail
  model       glm-5.2                  52.7%     $691              +12.4%   8.7%
  provider    zhipuai                  46.1%     $600               +8.6%   7.8%
  agent       build                    63.4%     $619              +15.2%   7.2%
  source      chat                     65.9%     $564               +6.1%   4.1%
  project     opencode                 68.3%     $621              +11.7%   5.1%
  status      completed                80.5%     $699               +4.8%   0.0%

  Status leader excludes unattributed usage; 62.1M tokens without request outcome are reported separately.

  ━━━ Variability & outliers ────────────────────────────────────────────────────────────────────────────────────

  Daily cost  ▁▂▂▃▅▇▄▃▂▂▁▂▁▂▆█▅▄▃▂▂▁▃▄▅▃▂▆▅▄▃▆
  avg $14.0 · p95 $72.1 · peak $117 · coefficient of variation 128% · active 47/60 days

  Session cost p50 $0.18 · p95 $11.6 · max $130 · max/p95 11.2x
  Session tokens mean 7.1M · median 430.6K · mean/median 16.5x · top 2 share 19.4%
  Top session: loop/goal 端点逻辑分析报告

  ━━━ Actions ───────────────────────────────────────────────────────────────────────────────────────────────────

  ! Failure rate 19.8% exceeds 2.0%; inspect: opencode stats breakdown status
  ! Top session costs $130 versus p95 $11.6; inspect: opencode stats sessions --sort cost
```

未越界项不进入 Actions；例如 cache read 82.7% 高于 20% 低缓存阈值，因此不占用页面。

### 8.14 Forecast

`stats insights --forecast`、`stats forecast` 和 `stats run-rate` 在完整 Insights 页面末尾追加：

```text
  ━━━ Forecast · observed activity run rate ─────────────────────────────────────────────────────────────────────

  active-day avg $17.9 · active 78.3% · weekly $98.1 · 30-day $420 · projected month-end $913 · stability 42%
  observed   ▁▂▂▃▅▇▄▃▂▂▁▂▁▂▆█▅▄▃▂▂▁▃▄▅▃▂▆
  projected  ▁▁▂▂▃▃▄▄▅▅▆▆▇▇██
  endpoint confidence band $781-$1.05K

  Forecast drivers
  provider          early/day   recent/day   change
  zhipuai               $8.42        $10.11   +20.1%
  DaXiao                $2.13         $2.74   +28.6%
  opencode-go           $1.48         $1.31   -11.5%
  DaXiao Codex              -             -     0.0%

  Projection uses only the selected window and observed active-day frequency; month-end uses the latest date's local month.
```

显式 `forecast/run-rate` 仍使用 `Insights` header，因为 Forecast 是同一证据页的可选附录，不拥有第二套 attribution/actions；命令映射测试锁定这一语义等价，而不是为 alias 改标题。

### 8.15 Interactive

Interactive 不拥有第六套页面。body 必须逐字复用前述 Dashboard、Model Breakdown、Token Timeline、Sessions 和 Insights renderer。它是清屏后连续写入完整页面的 clear-and-stream 视图，不是 header/footer 同时固定的 viewport；唯一附加内容是 body 后的 footer：

```text
  dashboard · 60 days · n/Right next · p/Left previous · r/R range · q/Esc quit
```

小于 60 列时：

```text
  dashboard · 60 days
  n/p view · r/R range · q quit
```

当前 interactive 固定五页，不在本次视觉 patch 中新增 Provider/Project 等二级选择器。新增交互菜单会引入状态、键位、帮助和清理测试，违反最小修改原则。

Footer 仍位于完整 body 之后，不承诺 sticky；在 120×45 基准下最坏为第二屏末尾。实现 height-aware paging 或 sticky footer 需要新的 page state 和按键语义，属于 interactive follow-up，不混入本 patch。

## 9. 窄屏、无色与空数据示例

### 9.1 48 列 Model Breakdown

窄屏保留同一问题，只将横向比较改为实体块；不删除 composition 或 routing：

```text
  opencode stats · Breakdown / Model
  Last 60 days · 573/625 sessions
  $842 · 4.1B tok · 2.3K req · fail 458
  View: breakdown

  ━━━ Token trend · top 5 models ━━━━━━━
  500M │┄┄┄┄╭─╮┄┄┄┄┄┄╭╮┄┄┄┄┄┄┄
  250M │ ╭──╯ ╰╮ ╭──╮╭╯╰╮
     0 │─╯     ╰─╯  ╰╯   ╰──────
       └──────────────────────────
       05-14       06-13      07-12

  glm-5.2
    2.1B tok · 52.7% · $691
    841 owned req / 1.1K calls · 186 sessions
    cache read 85.7% · input 12.3%
    output 1.4% · reasoning 0.4%
    providers: zhipuai 89% · DaXiao 11%
    tools: read 31% · bash 27% · other 42%

  gpt-5.5
    1.1B tok · 27.5% · cost -
    602 owned req / 811 calls · 142 sessions
    cache read 81.2% · input 16.5%
    output 1.8% · reasoning 0.4%
    providers: DaXiao Codex 76%
      opencode-go 24%
    tools: read 35% · grep 25% · other 40%
```

### 9.2 无色模式

去色后必须保留完整标签、单位和形状；不能依赖 ANSI 颜色才能理解：

```text
  Token trend · shared scale 423.2M/day
  ◆ glm-5.2          ▁▂▃▄▅▆▅▄▃▅▆█▇▆  2.1B
  ■ gpt-5.5          ▂▃▄▃▅▄▆▇▅▄▃▅▆▇  1.1B
  ▲ gpt-5.6-sol      ▁▁▂▃▃▄▅▄▆▅▇▆▇█  463M
  ◇ claude-opus-4-6 ▁▂▁▃▂▄▃▃▅▄▆▅▇▆  240M

  token composition
  glm-5.2  C████████████████████████████████████ 85.7%
           I█████ 12.3% · O█ 1.4% · R 0.4% · W 0.2%

  C cache read · I input · O output · R reasoning · W cache write
```

Breakdown 的无色多系列回退使用共享最大值，保留实体间绝对振幅比较；Timeline 的实体 sparkline 则各行独立归一化，只比较自身趋势形状，并在同一行保留绝对 total/share。两者都让每个系列独占一行，不需要在 60 个日期上重复绘制粗圆点。

### 9.3 全空 report

所有页面只替换 page title，空态结构一致：

```text
  opencode stats · Breakdown / Project
  Last 60 days · 0/0 sessions with usage
  Cost - · Tokens 0 · Requests 0 · Cache - · Fail 0
   dashboard  ·  timeline  ·  breakdown  ·  sessions  ·  insights

  No usage data in this range.
  Try a wider time range; if filters are active, relax them.
```

### 9.4 48 列页面矩阵

以下窄屏稿使用各页面可用的 `-n 1`，因此是一条实体行下的完整页面结构，不用隐藏占位符代表其他数据。未显式传 limit 时，48 列默认显示 3 个同结构实体块。主图高度降为 6，所有绝对值、单位和 identity 仍保留。

Dashboard：

```text
  opencode stats
  Last 60 days · 573/625 sessions
  $842 · 4.1B tok · 2.3K req · fail 458
  View: dashboard

  ━━━ Daily activity ━━━━━━━━━━━━━━━━━━━
  calendar 9 weeks · peak 423.2M
  Mon ███████████████ 15.5%
  Tue ████████████    12.7%
  Wed █████████████   13.3%
  Thu ███████████████ 15.0%
  Fri ███████████     11.6%
  Sat ████████████████████ 21.3%
  Sun ██████████      10.5%

  ━━━ Usage shape ━━━━━━━━━━━━━━━━━━━━━
  cache read 3.4B 82.7%
  input 673.6M 16.6% · output 17.6M 0.4%
  cache write 8.6M 0.2%

  ━━━ Health ━━━━━━━━━━━━━━━━━━━━━━━━━━
  cost ▁▂▃▅▇▄▂▁▆█▅▄ $842 · $14.0/day
  cache ▇▆▅▄▃▅▆▇▆▅█▇ 82.7%
  fail ▂▃▄▂▁▅▆▃▄▃▂▂ 19.8%

  ━━━ Top model / provider ━━━━━━━━━━━━
  glm-5.2 · 2.1B · 52.7% · $691
  zhipuai · 1.9B · 46.1% · $600

  ━━━ Top session ━━━━━━━━━━━━━━━━━━━━━
  loop/goal 端点逻辑分析报告
  503.0M tok · $130 · 135 req

  ━━━ Signals ━━━━━━━━━━━━━━━━━━━━━━━━━
  failure 19.8% · inspect status
```

Provider Breakdown：

```text
  opencode stats · Provider
  Last 60 days · $842 · 4.1B tok

  ━━━ Cost trend ━━━━━━━━━━━━━━━━━━━━━━
  $140 │┄┄╭╮┄┄┄┄┄╭─╮┄┄┄┄
    $0 │──╯╰──────╯ ╰─────
       └───────────────────

  zhipuai
    1.9B tok · 46.1% · $600 · 71.3% cost
    782 owned req / 936 calls · $0.64/call
    cache 86.2% · fail 7.8% · 31.8s avg
    models: glm-5.2 96.8% · other 3.2%
    tools: read 34% · bash 28% · other 38%

  Visible 1 of 9 providers · use -n for rows
```

Agent Breakdown：

```text
  opencode stats · Agent
  Last 60 days · $842 · 4.1B tok

  ━━━ Token trend ━━━━━━━━━━━━━━━━━━━━━
  500M │┄┄╭─╮┄┄┄┄┄╭╮┄┄┄
     0 │──╯ ╰──────╯╰────
       └───────────────────

  build
    2.6B tok · $619 · 401 sessions
    1.4K owned req / 1.8K calls · cache 84.7%
    fail 7.2% · 38.4s avg/request
    context: results 26.9% · schemas 18.6%
      user 11.4% · assistant 12.2%
      system/instructions/skills 16.6%
      reasoning/calls/attach 14.3%
    models: glm-5.2 58% · gpt-5.5 25%
    tools: read 30% · bash 26% · other 44%
```

Source Breakdown：

```text
  opencode stats · Source
  Last 60 days · $842 · 4.1B tok

  ━━━ Token trend ━━━━━━━━━━━━━━━━━━━━━
  500M │┄┄╭─╮┄┄┄┄┄╭╮┄┄┄
     0 │──╯ ╰──────╯╰────
       └───────────────────

  chat
    1.3K owned req / 1.6K calls · 2.7B tok
    2.1M tok/owned req · $564 · $0.43/owned req
    cache 83.6% · output 1.8% · fail 4.1%
    context: results 26.1% · schemas 17.2%
      user 13.8% · assistant 12.6%
      system 6.4% · instructions 4.1% · skills 6.7%
      reasoning 7.1% · calls 5.3% · attach 0.7%
    models: glm-5.2 49% · gpt-5.5 29%
    providers: zhipuai 46% · DaXiao 38%
```

Project Breakdown：

```text
  opencode stats · Project
  Last 60 days · $842 · 4.1B tok

  ━━━ Token trend ━━━━━━━━━━━━━━━━━━━━━
  500M │┄┄╭─╮┄┄┄┄┄╭╮┄┄┄
     0 │──╯ ╰──────╯╰────
       └───────────────────

  opencode
    /Users/sunbenteng/Project/opencode
    2.8B tok · 68.3% · $621
    334 sessions · 1.5K owned req / 1.9K calls
    60 active days · cache 84.8% · fail 5.1%
    models: glm-5.2 54% · gpt-5.5 28%
    providers: zhipuai 49% · DaXiao 36%
    tools: read 31% · bash 25% · other 44%
    top session: loop/goal 端点逻辑分析报告
```

Tool Breakdown：

```text
  opencode stats · Tool
  Last 60 days · 18.4K calls
  629.8M estimated context tokens

  ━━━ Estimated context trend ━━━━━━━━━
   90M │┄┄╭╮┄┄┄┄┄╭─╮┄┄┄
    0M │──╯╰──────╯ ╰────
       └───────────────────

  read
    5.7K calls · 31.0% call share
    214.2M est ctx tok · 34.0% ctx share
    37.6K ctx/call · 128 in chars/call
    8.2K out chars/call · 12 errors · 18ms
    models: glm-5.2 38% · gpt-5.5 27%
    agents: build 57% · explore 21%
    projects: opencode 69% · notes 11%
```

Status Breakdown：

```text
  opencode stats · Status
  Last 60 days · 2.3K requests · fail 458

  ━━━ Request outcome trend ━━━━━━━━━━━
  complete ▁▂▃▄▅▆▅▄▆▇█ 79.7%
  error    ▁▁▂▁▃▂▁▄▂▃▂ 12.6%
  aborted  ▁▂▁▁▂▁▃▂▁▂▁  7.2%
  running  ▁▁▁▁▁▁▁▁▁▁▁  0.5%

  completed
    1.8K req · 79.7% · 3.3B tok · $699
    1.8M tok/req · $0.38/req · 24.8s avg
  unattributed usage · 62.1M tok · 74 calls
  failure leader by model: gpt-5.5
    123 failed req · 15.2% within model
```

Token Timeline：

```text
  opencode stats · Timeline / Tokens
  Last 60 days · $842 · 4.1B tok

  ━━━ Daily token volume ━━━━━━━━━━━━━━
  500M │┄┄╭╮┄┄┄┄┄╭─╮┄┄┄
  250M │╭─╯╰╮  ╭──╯ ╰╮
     0 │╯   ╰──╯     ╰────
       └───────────────────
  total 4.1B · peak 423.2M/day

  components · each row has its own scale
  ▓ Cache read ▁▃▂▄▅▃▁▂▅█▆▄ 3.4B 82.7%
    peak 423.2M/day
  ░ Input      ▂▄▃▅▆▄▂▃▆█▇▅ 673.6M 16.6%
    peak 72.1M/day
  ▒ Cache write ▃▂▁█▇▃▂▁▂▃▂▁ 8.6M 0.2%
    peak 4.6M/day
  ▎ Output+reason ▂▃▂▄▅▃▂▃▄▆▅▃ 17.6M 0.4%
    peak 2.2M/day

  ━━━ Health ━━━━━━━━━━━━━━━━━━━━━━━━━━
  cost ▁▂▃▅▇▄▂▁▆█▅▄ $14.0/day
  req  ▂▃▄▅▆▇▆▅▄▆▇█ 38.4/day
  cache ▇▆▅▄▃▅▆▇▆▅█▇ 82.7%
  fail ▂▃▄▂▁▅▆▃▄▃▂▂ 19.8%

  top day 07-04 · 423.2M · $117 · 96 req
  model glm-5.2 ▁▂▃▄▅▆▅▄▃▅▆█ 52.7%
  provider zhipuai ▁▂▃▄▅▆▅▄▃▅▆█ 46.1%
```

Cost Timeline 使用同一窄结构，把主图换成单线 cost、top day 第一值换成 cost，并保留 token 次值；Heatmap 追加以下完整七行：

```text
  ━━━ Heatmap · relative to peak ━━━━━━
  Mon ··██▒▒░░········██
  Tue ··▒▒▒▒······░░··██
  Wed ··░░▒▒··░░··██··▒▒
  Thu ▒▒▒▒▒▒····░░░░░░▓▓
  Fri ░░▒▒▓▓····░░····▒▒
  Sat ··░░░░········████
  Sun ░░░░░░··░░····▓▓▓▓
  ░ <=25% · ▒ <=50% · ▓ <=75% · █ >75%
  peak 423.2M
```

Sessions：

```text
  opencode stats · Sessions
  Last 60 days · 573 usage sessions

  ━━━ Population ━━━━━━━━━━━━━━━━━━━━━━
  4.1B tok · $842 · 2.3K requests
  p50 430.6K · p95 31.4M · max 503.0M
  top 2 share 19.4% · mean/median 16.5x

  ━━━ Distribution ━━━━━━━━━━━━━━━━━━━━
  <100K 60 10.5% · 100K-1M 337 58.8%
  1M-5M 89 15.5% · 5M-50M 64 11.2%
  >50M 23 4.0%

  ━━━ Leaderboard · tokens ━━━━━━━━━━━━
  loop/goal 端点逻辑分析报告
    project opencode · 503.0M tok · $130
    135 req / 171 calls · 312 msg / 1.1K tools
    cache 91.2% · fail 7 · 48.2s avg
    glm-5.2, gpt-5.5 · zhipuai, DaXiao

  Visible 1 of 573 · use -n for rows
```

Insights 与 Forecast：

```text
  opencode stats · Insights
  Last 60 days · $842 · 4.1B tok

  ━━━ Usage shape ━━━━━━━━━━━━━━━━━━━━━
  cache read 82.7% · input 16.6%
  output 0.4% · cache write 0.2%
  $0.21/M tok · 4.9M tok/$

  ━━━ Attribution ━━━━━━━━━━━━━━━━━━━━━
  model glm-5.2 · 52.7% · $691 · owner fail 8.7%
  provider zhipuai · 46.1% · $600 · owner fail 7.8%
  project opencode · 68.3% · $621 · owner fail 5.1%

  ━━━ Variability ━━━━━━━━━━━━━━━━━━━━━
  daily avg $14.0 · p95 $72.1 · peak $117
  session p50 $0.18 · p95 $11.6 · max $130

  ━━━ Actions ━━━━━━━━━━━━━━━━━━━━━━━━━
  failure 19.8% > 2% · inspect status
  top session $130 vs p95 $11.6

  ━━━ Forecast when requested ━━━━━━━━━
  active-day avg $17.9 · active 78.3%
  30-day $420 · month-end $913
  band $781-$1.05K · stability 42%
```

Interactive 在窄屏逐字复用上述 page body，并追加已在 §8.15 定义的两行 footer；不创建另一套紧凑统计口径。

### 9.5 无正费用记录

现有 schema 无法区分 free 与 missing price。完整页面仍展示 tokens/calls，实体 cost 使用 `-`；全局 `Cost` 一律表示记录值之和，不因单个实体为零切换标题：

```text
  opencode stats · Breakdown / Provider
  Last 60 days · Cost $842 · Tokens 4.1B

  DaXiao Codex
    1.4B tok · 35.5% · recorded cost -
    641 owned req / 854 calls · cost/call -
    cache 81.7% · fail 5.6% · 37.3s avg
```

整个选择范围有 tokens、但 total cost 为 0 时，各端点统一为：

```text
  Dashboard header     Cost - · Tokens 4.1B
  Dashboard cost       No positive cost recorded in this range; token/cache/failure trends remain visible.
  Cost Timeline        No positive cost recorded in this range.
                       Token/request/cache/failure health rows remain visible.
  Provider Breakdown   cost - · cost/call - · sorted by tokens as a stable fallback
  Sessions             Token percentiles/distribution remain; cost percentiles and cost bands are unavailable.
  Insights             cost/M - · tok/$ - · no cost-outlier action
  Forecast             Forecast unavailable: no positive cost recorded in the selected range.
```

当 total cost 大于 0、但部分 Session cost 为 0 时，cost percentiles/bands 只以正费用 Session 为样本，并明确标题 `Cost distribution · positive recorded cost (N sessions)`；另列 `No positive recorded cost · M sessions`。零值不能静默进入 `<$0.10` 档并被描述为已测得的低成本。

## 10. 未来实现的最小代码改动

### 10.1 `packages/opencode/src/cli/cmd/stats/data.ts`

具体修改：

1. 对有 AssistantUsage 的 request，把现有零 token/零 cost request shell 同时加入 `breakdownEvents`，使 request/error/abort/duration 每 request 只计一次；给相关 Assistant event 和 shell 写入同一个 request final `outcome`。
2. 导入 `ProjectTable`，与 Session 查询同一 Database seam 内批量读取 `id/name/worktree`。
3. 增加 `ProjectUsage` 和 `ToolCallAttribution` 两个内部 report 类型；不改数据库 schema。
4. 在 `aggregateSession()` 现有单次 Message 扫描中，同时按 Assistant message 身份累计 Tool call attribution，并用已读取的 Assistant/RequestUsage rows 建立 message -> source/status 关联。不能新增第二次 Session.messages 或 RequestUsage 查询。
5. Tool call attribution 只使用现有 ToolPart 状态计算 calls/input chars/output chars/errors/duration；不创建 cost 或 billed token 字段。
6. `aggregateStats()` 的普通维度继续按 event identity 聚合；Status group/series 改按 request outcome 聚合，缺失 outcome 的 usage 单列 `unattributed`，不参与 outcome 比率。
7. usage event 的 status filter 优先比较 request final outcome，只有缺失 outcome 时回退原 event status；Tool attribution 则比较其已解析的 request/Assistant fallback status。
8. `aggregateStats()` 按复合键合并 Tool attribution，并应用既有 model/provider/agent/project/source/status/tool filters。
9. finalize Project groups 时只替换 display label/path，`id`、series key 和 filter key 保持 project ID。
10. Project row 缺失时从该 project 的 Session directory 回退，不捕获其他数据库错误。
11. Project basename 同时识别 POSIX 与 Windows 分隔符；数据库从另一操作系统复制后，仍显示最后一段可识别项目名并保留完整 path。

应删除或替换：

- 替换 `addGroup(projects, event.projectID, event.projectID, event)` 中第二个 project ID。
- 不再让 renderer 自己猜 project basename；身份解析集中在聚合 seam，Dashboard/Breakdown/Insights 看到同一 label。

中文注释分布在非显然不变量附近，至少覆盖：Project ID 与 display identity 分离、Tool call ownership 与 context consumption 分离、legacy/fork 数据不能伪装成精确归因、终端文本与受信样式分离、零费用样本口径以及响应式 limit 不覆盖显式参数。

### 10.2 `packages/opencode/src/cli/cmd/stats/charts.ts`

具体修改：

1. 删除 `fg(r,g,b)` 和固定 24-bit `palette`，改为终端 ANSI 基础色的单一语义表。
2. 导出或复用唯一的 color-enabled 判定，使 `render.ts` 不再维护第二套 `useColor()`。
3. `paint()` 继续只 reset bold/foreground；panel 继续单独处理 `49m`。
4. `renderRoundedLineChart()` 在单系列和彩色多系列中都保持无点；无色多系列由 `render.ts` 改为共享尺度 sparkline rows，不让 ChartCanvas 处理无法辨识的重叠线。
5. `renderComparisonTable()` 和 percent stack 保持完整标签与单位。
6. `renderHeatmap()` 保留当前按 report peak 分四档的算法，只补清晰的 25%/50%/75% legend 与格式化 peak，不引入第二套 quantile binning。
7. Timeline 不再调用 `renderStackedAreaChart()` 后，删除该无生产调用 primitive、`layersFromTokenParts()` 和只为它服务的 `ChartLayer`；不能保留一套已知会吞掉小层的弃用路径。
8. 删除 `renderMatrix()`；替代页面不再有调用方，保留它只会留下已弃用编号设计。

不做：

- 不把 stats width 算法顺带迁移到 `Bun.stringWidth()`；这是另一项 Unicode 一致性变更。
- 不删除其他当前未使用 primitive；除 `renderMatrix()` 外，它们与本需求没有冲突，批量清理会扩大 diff。
- 不启动 renderer 查询 palette，不添加 dark/light 环境变量猜测。

### 10.3 `packages/opencode/src/cli/cmd/stats/render.ts`

具体修改：

1. 删除本地固定 RGB theme，所有颜色通过 `charts.ts` 的共享语义 seam。
2. 保留 `renderDashboard()` 的正常有数据 section 结构和全宽图，不重排已认可布局；只补 Project label 和 total cost 为 0 时的明确 unavailable 状态。
3. Timeline Tokens 用全宽 daily total 细线图替换堆积面积图，再用四条独立归一化组件 sparkline 展示 Cache Read、Input、Cache Write、Output + Reasoning；每行必须同时显示 total/share/peak 和独立尺度说明。
4. `renderAnalyticalTable()` 直接尝试完整实体名；横表放不下时立即转逐实体布局，不再生成 `[1]` note key。
5. `renderBreakdownTrend()` 使用真实 series label；彩色图无点且图例显示完整名称与总量，无色多系列显示共享尺度 small multiples。
6. 用七个紧邻 `renderBreakdown()` 的维度 composer 替换当前单一 `renderDimensionAnalysis()` 分支。它们是页面职责，不成为新 public interface。
7. Model 增加 portfolio、token composition、Provider routing 和 issued Tool mix。
8. Provider 增加 economics、model portfolio、capacity/reliability；删除编号矩阵。
9. Agent/Source 展示完整 context 分母，并复用 group 内 model/provider mix。
10. Project 展示 label + path、portfolio、runtime mix 和可由现有 sessions 推导的最大 session。
11. Tool 将 calls 与 estimated context 分成独立 share 列，写明 chars 单位；calls/chars/error/duration 与 issuing runtime 都从过滤后的 `toolCalls` 汇总，context 则从现有过滤后 context events 汇总。
12. Status 主图和效率表只按 request final outcome；没有 owning request 的 Assistant/legacy usage 单列 `unattributed`，不参与 tokens/req 等比率；再追加 failure attribution。
13. 全空 report 在 header 后统一短路；partial Tool data 不走全空短路。
14. 删除 `modelProviderMatrix()`、`renderProviderModelMatrix()` 及相关 `renderMatrix` import。
15. 未显式传 limit 时按 content width 采用 3/5/既有桌面默认行数；显式 `-n` 始终覆盖响应式默认。
16. total cost 为 0 时 Dashboard cost panel 显示 unavailable；Sessions 保留 token 分布但不绘制 cost percentile/bands。部分正费用时，Sessions cost 统计只用正费用样本并单列无正费用记录数量。

实现形状：

```text
renderBreakdown(report, options)
  -> common header + summary + full-width trend
  -> model:    render model portfolio/composition/runtime mix
  -> provider: render provider economics/model mix/reliability
  -> agent:    render workload/context/runtime mix
  -> source:   render workload/context/routing mix
  -> project:  render identity/portfolio/runtime/top sessions
  -> tool:     render context trend/footprint/issuing runtime
  -> status:   render outcome trend/distribution/failure attribution
  -> one final panel()
```

这保留一个外部 renderer seam，同时把七种真实概念从一个字符串数组 switch 中分离。composer 只接收 report/groups/options，不创建额外状态或数据访问。

### 10.4 `packages/opencode/src/cli/cmd/stats/insights.ts`

具体修改：

1. 继续保留 Usage shape、Attribution、Variability/Outliers、Actions、可选 Forecast 的顺序。
2. Actions 只有在分母大于 0 且阈值越界时生成；空 report 不再触发低 cache action。
3. 费用格式与 renderer 主页面统一：总计或实体没有正费用记录均显示 `-` 并附 unavailable 说明，不保留 `$0.0000` 格式，也不猜测“免费”或“未知”。
4. total cost 为 0 且 tokens 非零时，cost efficiency 为 `-`，Forecast 返回明确 unavailable view，不生成全零 projection。
5. Attribution 的 model/provider/agent/source/project 健康列明确命名 `owner fail`；Status leader 排除 `unattributed`，并把无 outcome usage 作为独立事实行。
6. Project leader 自动使用聚合层提供的可识别 label。
7. 不增加判断性段落，不从 Breakdown 复制完整排名。

### 10.5 测试文件

`packages/opencode/test/cli/stats-data.test.ts`：

- 用真实 Project row + Session 验证 Project label/path，不检查内部 map 或 SQL 字符串。
- 覆盖有 name、无 name 回退 worktree、Project row 缺失回退 Session directory，以及 macOS 读取 Windows worktree 时仍取最后一段项目名。
- 覆盖 name/path 中的换行、ESC、C0、DEL 被替换，以及空格、引号、`$VAR`、管道和重定向字符按文本保留。
- 用真实 Assistant message + ToolPart 验证 model/provider/agent/project/source/status/tool call attribution、error 和 duration。
- 覆盖 pending/running ToolPart 不制造负 duration。
- 覆盖 source/status filter、找不到 AssistantUsage row 时的 `unattributed/unknown`，以及 `--tool` 的 session totals 与 ToolPart mix 两层语义。
- 覆盖 Assistant row 在 cutoff 内、owning request row 在 cutoff 外时，Tool source 回退 `assistant`、Tool status 保留 Assistant row，而 request outcome usage 进入 `unattributed`。
- 用两个存储上独立但内容相同的 fork-like Session 证明 stats 不做字符串启发式去重；测试名称明确这是 stored calls，不把结果称为跨 fork 唯一调用。
- 保留 legacy input breakdown 空对象的零 context 行为。
- 验证现有 filter 应用到 attribution；不扩张为所有 filter 的组合爆炸测试。
- 用一个 request + 两个 AssistantUsage rows 证明 group requests/errors/duration 只计一次，而 token/cost/calls 仍按两个 Assistant rows 累加；fixture 中 request owner 与第二个 Assistant 的 model/provider 必须不同，防止把 shell 复制给每个 Assistant owner。
- 断言两个 Assistant 的 usage 都按 owning request final outcome 进入同一个 Status usage group；窗口外 request 和 legacy usage 单列 `unattributed`，不污染 outcome 的 tokens/req、cost/req 或 calls/req。
- 构造 Assistant status=`completed`、owning request final status=`error`，断言 `--status error` 保留该 Assistant 的 tokens/cost/calls 和唯一 request shell；`--status completed` 不错误吸收它。cutoff orphan/legacy 则验证 status fallback。
- 无 Assistant row 的 fallback request 路径保持原总量。
- 对 dash/overview/summary/models/providers/daily/heat/cost/token/session/insight/forecast alias 及 root `--models/--tools`，用等价归一化参数断言同一可见正文；另锁定同时传 root shortcuts 时 Tool 优先。
- `dashboard --interactive` 与三个 Dashboard alias 的 interactive 路由一致；非 TTY 时都只输出一次 Dashboard。
- `insights --forecast`、`forecast`、`run-rate` 都必须保留 `Insights` orientation 并包含 Forecast section，防止 alias 后续分叉标题或页面顺序。

`packages/opencode/test/cli/stats-render-width.test.ts`：

- 删除“不得出现 token detail/composition”的负向黑名单，替换为真实 fixture 值必须可见。
- Model 断言绝对 tokens、五类 token 组成、Provider 名、Tool 名和 call share。
- Provider 断言绝对 tokens/cost/requests、model portfolio 和 failure/latency。
- Agent/Source 断言十类 context 或明确 other，总和口径可核对。
- Project 断言名称、带空格路径和最大 session 标题，不默认显示裸 ID。
- Tool 断言 calls share 与 context share 同时可见，字符单位和估算说明存在，cost 不出现。
- Status 断言 completed/error/aborted 独立、请求分布与 failure attribution。
- Timeline fixture 让 Cache Read 占 99%、Cache Write/Output 均低于 plot 的一像素比例，断言 daily total 主图和四条独立组件趋势、total/share/peak 全部可见；不得通过 minimum thickness 或堆积层覆盖伪造小组件面积。
- 40/80/120/160 列继续断言固定 panel 宽度、无省略号、长 CJK 标签完整。
- 48 列未传 limit 时断言默认 3 个实体，显式 `-n 1`/`-n 8` 均严格生效；120 列保持 Breakdown 与 Sessions 默认 5 个实体。
- 彩色输出断言不含 24-bit foreground、不含具体 background；strip ANSI 后与 never 模式的文本相同。
- 无色多 series 断言每个完整 label、共享 scale 和独立 sparkline 行可见，且不出现密集圆点或重叠画布。
- 空 report 断言统一空态，Insights 不出现 cache action。
- total cost 为 0 但 tokens 非零时，Cost Timeline/Insights/Forecast 分别断言 unavailable/`-` 语义，不生成零值预测；Provider cost 排序稳定回退 tokens。
- 同一零费用 fixture 断言 Dashboard 不绘制平坦 `$0` cost trend，Sessions 不把所有 session 放入 `<$0.10`；部分正费用 fixture 断言正费用样本和无正费用数量分开。

### 10.6 文档文件

`packages/web/src/content/docs/cli.mdx` 与 `packages/web/src/content/docs/zh-cn/cli.mdx`：

- 补 canonical 页面职责、Breakdown dimensions、compatibility aliases、`--color`、`--limit`、metric/sort/heatmap/forecast 和 interactive keys。
- 明确 Project filter 仍接收 ID，显示名称不改变 filter。
- 明确 Tool context 是估算值且 Tool 无精确 cost。
- 不复制本 proposal 的大段 ASCII mock；文档保持命令参考。

其他 15 种本地化文件已有默认值漂移，但一次性人工翻译不属于本 patch。英文是源文档，简中是本 fork 当前维护语言；其余语言应单独由 localization 流程同步，不能机械复制英文。

### 10.7 明确不改的文件

- `packages/opencode/src/cli/cmd/stats.ts`：只把 root 的 `tools/models/limit/interactive` 标记为非全局，阻止未声明参数泄漏到子命令；命令映射、alias、interactive 状态与生命周期不变。
- 任何 `*.sql.ts` 与 migration：现有字段足够。
- `packages/sdk/**`：没有公开协议变化。
- `packages/core/src/models-snapshot.*`：与 stats 无关。
- `packages/opencode/script/build.ts`：不扩大 build smoke test。
- TUI theme/provider 文件：只复用语义，不耦合 runtime。

## 11. TDD 实施顺序

### 11.1 预先确认的测试 seam

本方案只在三个现有 interface 上测试：

1. `aggregateStats()`：验证持久化数据如何成为 `StatsReport`。
2. `renderDashboard()`、`renderBreakdown()`、`renderTimeline()`、`renderSessions()`、`renderInsights()`：验证用户可见文本、宽度和 ANSI 行为。
3. 现有 yargs builders/wrappers：只验证 canonical 与 alias 映射以及无效参数拒绝，不进入私有 helper。

不测试私有 composer、Map key、SQL 调用次数、函数名、源码字符串或 helper 是否存在。

### 11.2 Vertical slices

严格按一条失败行为测试、最小实现、再进入下一条的顺序执行，不先批量写完所有测试。

#### Slice 1：Request health 指标只计一次

Red：一个 request 有多个 AssistantUsage rows 时，当前 Breakdown group 的 request/error/duration 没有进入；页面中的 failure 和 avg/request 不成立。

行为测试：

- token/cost/assistantCalls 按 Assistant rows 累加。
- requests/errors/aborted/duration 按 request shell 只累计一次。
- request owner 与 Assistant owner 不同时，shell 只进入 request owner；所有可关联 Assistant usage 按 request final outcome 进入同一 Status group。
- 无 owning request 的 Assistant/legacy usage 进入 `unattributed`，不参与 outcome 比率。
- fallback request 没有 Assistant rows 时不重复加入 shell。

Green：把现有 request shell 加入 `breakdownEvents`，并增加内部 outcome 投影；不改 `totalEvents` 或 schema。

#### Slice 2：主题与纯文本不变量

Red：`color=always` 当前包含 `38;2` 固定 RGB；亮/暗终端无法自行映射。

行为测试：

- 彩色输出只使用 default/ANSI indexed foreground 和 `49m` reset。
- 不包含 concrete background。
- strip ANSI 后与 `color=never` 文本相同。
- `NO_COLOR` 仍关闭颜色。

Green：只替换共享 palette 和 color-enabled seam，不动页面内容。

#### Slice 3：Timeline 小组件在 Cache 主导时仍可见

Red：构造 Cache Read 99%、Input 0.7%、Cache Write 0.1%、Output + Reasoning 0.2% 的日序列；当前线性堆积图无法同时给三个小层分配可见像素。

行为测试断言全宽 daily total 主图和四条组件趋势均可见，每条都有独立 sparkline、total/share/peak，并明确 own scale；不检查私有 chart helper。

Green：用 total line + component rows 替换 Timeline stack，并删除无调用的 stacked primitive，不设置 minimum thickness。

#### Slice 4：Project identity

Red：当前 `aggregateStats().projects[0].label` 等于 project ID，页面没有 path。

行为测试：

- name 优先。
- 空 name 使用 worktree basename。
- 删除 Project row 后使用 Session directory。
- project ID/filter/series 关联仍保持。

Green：增加一次批量 Project 映射和 `ProjectUsage.path`。

#### Slice 5：Model 信息恢复

Red：当前 Model 页面看不到绝对 token composition、requests/calls、Provider 真实路由和 Tool mix。

行为测试使用已知 fixture 数值，断言用户可以读到这些值；不搜索 helper 名。

Green：先只完成 Model composer，并删除该页的 matrix 调用。

#### Slice 6：Tool call attribution

Red：同一 Session 中两个模型发起不同 ToolPart，当前 report 无法区分。

行为测试通过真实 Message/Part 写入，断言 report 和 Model/Tool 页面呈现正确 ownership、call count、error/duration；另断言没有 Tool cost。

Green：在现有 Message 扫描中累计 `toolCalls`，不增加查询。

#### Slice 7：Provider、Agent、Source、Project、Status

按维度逐个循环：每次先增加一条该页面真实用户问题的失败测试，再替换当前通用表分支。不能先写五个 renderer 再补测试。

优先顺序：Provider -> Project -> Agent -> Source -> Status。原因是 Provider/Project 是当前截图最明显的身份与信息缺口，Agent/Source 主要复用已有 component，Status 最后复用 outcome 数据。

#### Slice 8：Tool 页面语义

Red：当前 `share` 会切换分母，`in/call` 和 `out/call` 不标字符，legacy 无 estimate 时页面含义不明确。

Green：分离 call/context share，补单位和 unavailable 文案，并接入 issuing runtime。

#### Slice 9：响应式、空态与 aliases

Red：当前窄 Breakdown 使用编号 key，空 Insights 触发 cache action。

Green：直接标签 + reflow + 页面级空态。最后验证 wrapper 输出与 canonical renderer 一致。

### 11.3 现有测试的处理原则

- 保留自然日、legacy、long label、CJK width、背景 reset、无省略号、Forecast 活跃率加权等行为测试。
- 删除负向文案黑名单时必须由更强的正向信息完整性断言替代，不能单纯放宽测试。
- 48/52 行的旧固定上限改为明确预算；120×45 下 Dashboard 不超过 82 行，Breakdown/Timeline/Sessions/Insights 不超过 64 行。行数只作为信息密度行为，不绑定 helper 结构。
- 手写 render fixture 继续用于布局边界，但 Project/Tool 新投影必须另有真实聚合测试，避免 fixture 复制生产算法。
- 不增加 snapshot；具体数值和用户可见关系比大段字符 snapshot 更容易审计。

### 11.4 中文注释硬指标

未来实施遵守用户要求：有效新增/修改代码行至少 15% 为中文解释性注释。若有效修改约 700-1000 行，则至少需要 105-150 行有效中文注释，分布在：

- `data.ts`：Project identity fallback、Tool ownership/context 区分、legacy/fork 边界。
- `charts.ts`：terminal ANSI 语义、默认背景，以及删除 stacked area 后不能用 minimum thickness 伪造小层；`render.ts` 负责独立尺度 component rows 和无色共享尺度 sparkline rows。
- `render.ts`：各页面职责、单位/分母、完整标签 reflow、空态不变量。
- `insights.ts`：阈值分母与空数据。
- 两个测试文件：每个行为 fixture 为什么能暴露回归。

注释不复述赋值和函数调用，不在文件头集中凑数；import、格式调整和纯 Markdown 不计入指标。

## 12. 正常、错误、并发、退出与安全边界

### 12.1 正常路径

1. CLI 解析窗口、filters 和页面选项。
2. `loadReport()` 进行一次聚合；Project identity 和 Tool call attribution 同步进入 report。
3. renderer 只排序、限制可见实体并计算派生比例。
4. 主图使用完整 series，表格使用同一 group；summary 的 group count 不受 `limit` 影响。
5. panel 完成 ANSI-aware wrap 和固定宽度填充。

### 12.2 错误路径

- Project row 缺失是数据兼容分支，回退 Session directory；数据库查询本身失败必须继续上抛。
- Session messages NotFound 仍回退空数组；其他存储错误保持失败。
- 非有限数字在既有 safe divide/finite normalization seam 归零；实体无正费用记录显示 `-`，但不凭现有 schema 推断免费或未知。
- Tool pending/running 没有 end，只影响 duration，不丢 call。
- renderer 收到空 group/series 返回明确空态，不构造 NaN 坐标。
- CLI 对负 days/limit/tools、Tool cost metric 和未知 enum 的拒绝行为不变；root-only option 进入未声明它的子命令时同样必须非零退出。

### 12.3 并发与内存

- Session 聚合继续固定 `concurrency: 20`。
- Tool attribution 在每个 `aggregateSession()` 的局部 Map 中计算，最终在单一 `aggregateStats()` 循环合并；不共享可变 Map，不引入锁。
- Project metadata 是一次小型批量读取，不在 20 并发循环中重复。
- `toolCalls` 输出聚合 tuple，不输出逐调用事件；最坏 cardinality 不超过 ToolPart 数，通常远小于它。
- interactive range cache 缓存完整新 report；不存在额外后台任务或独立失效策略。

这些并发结论来自调用链检查；本 patch 不新增 20-way 压力或 interruption 测试，最终验证报告必须写“并发机制未修改并经代码审查确认”，不能写成“并发已由新增测试覆盖”。

### 12.4 退出与清理

本方案不改 `runInteractiveDashboard()`、Queue、timer、raw mode、cursor 和 acquire/use/release。新 renderer 和聚合没有资源句柄，因此不增加 finalizer。

验证仍需跑非 TTY renderer；interactive 的 acquire/release 风险记录为独立 follow-up，不以本次视觉修改顺便修补。

同样，raw mode、listener、timer、UTF-8 分片和逐步 finalizer 仅确认未修改，不属于本次新增测试覆盖。不能用 renderer 测试全绿替代 interactive 生命周期证据。

### 12.5 终端与路径安全

Project name/worktree、Session title、model/provider/tool ID 都是显示数据，绝不能进入 shell、路径解析或命令拼接。空格、引号、`$VAR`、管道、重定向和子命令字符按普通文本原样显示。

本 patch 新增的 Project name/path 在聚合成 `ProjectUsage` 时统一把换行、ESC、C0/DEL 控制字符替换为可见空格，防止不同 renderer 漏掉防护；普通 Unicode、CJK 和 shell metacharacters 保留。该行为通过 `aggregateStats()` 和公开 render 输出测试，不测试正则源码。其他既有实体标签的统一 terminal sanitization 是存量风险，不在本 patch 顺带扩大处理面。

本方案不执行外部命令，不修改权限，也没有 approval/deny/auto 分支。

## 13. 方案比较

### 13.1 直接把 stats 接入 `useTheme()`

拒绝。它会把纯字符串命令耦合到 Solid、OpenTUI renderer、KV/config provider 和终端查询生命周期；非 TTY、重定向和普通 `console.log()` 路径都会变复杂。

### 13.2 新增 `--theme` 或 `stats.theme`

拒绝。需求是修复现有输出，不是扩展配置面。主题名称还需要定义与 TUI config/KV 的优先级、dark/light 选择和无 renderer palette fallback。

### 13.3 检测 macOS dark mode 后选择两套 RGB

拒绝。终端背景不一定跟随 OS，SSH/tmux/自定义 profile 更会使推断失真。terminal-defined ANSI 才是普通 CLI 可依赖的主题 seam。

### 13.4 保留编号矩阵，只调整颜色

拒绝。颜色无法修复 `[A]`/`[1]` 身份跳转、无单位和 top 5×5 数据丢失。真实标签的组成条/路由表更适合终端宽度。

### 13.5 为每个 Breakdown 新建文件或 command

拒绝。七个页面共享同一 `StatsReport`、header、trend、panel 和 CLI 参数；拆文件会扩大 interface 和调用链。紧邻 `renderBreakdown()` 的私有 composer 已足够提供 locality。

### 13.6 构建任意维度 OLAP cube

拒绝。当前页面只缺 Project identity 与 Tool call ownership；大多数交叉 token 已在 group 中。通用 cube 会增加内存、fixture 和 public shape，而不会提升当前用户问题。

### 13.7 给 Tool 分摊 Assistant cost

拒绝。按字符或 context token 分摊只能得到估算，不是 Provider 账单事实；用户会误把它当精确工具成本。

### 13.8 同时修复 fork 去重和 interactive 生命周期

拒绝纳入同一 patch。这两项都是真实问题，但分别触及 Session provenance 和输入/finalizer 时序，测试 seam 与回滚风险完全不同。

## 14. 文件数与增删量预估

未来核心实现，不含本 proposal：

| 文件 | 预计新增 | 预计删除 | 原因 |
|---|---:|---:|---|
| `stats/data.ts` | 100-150 | 8-20 | Project metadata、Tool call attribution、source/status 关联 |
| `stats/render.ts` | 260-350 | 190-280 | 替换 Timeline stack、通用 Breakdown 与编号矩阵，不叠加第二套页面 |
| `stats/charts.ts` | 35-60 | 110-150 | ANSI palette、Heatmap legend、删除 stacked area 与 matrix |
| `stats/insights.ts` | 12-25 | 5-12 | 空数据阈值与格式统一 |
| `stats-data.test.ts` | 100-140 | 5-15 | 真实 Project/Tool/filters/fork-like 行为 |
| `stats-render-width.test.ts` | 150-210 | 70-110 | 用正向信息断言替换负向黑名单并覆盖极端组成比 |
| 英文 `cli.mdx` | 18-30 | 4-8 | 页面/参数/alias 参考 |
| 简中 `cli.mdx` | 20-35 | 4-8 | 同步维护语言 |
| 合计 | 695-1000 | 396-603 | 8 文件，目标净增 150-450 行 |

这是基于当前方案的审计区间，不是精确承诺。若实现超过 1000 新增行或净增 450 行，必须暂停检查是否在旧 stack/matrix/通用分支上叠加了第二套 renderer；正确实现应以替换和复用降低净增量。

当前 proposal 本身只新增 1 个文档文件。未来实现不涉及：

- 新运行时文件。
- 新 dependency。
- 新配置项。
- 数据库 migration。
- SDK/codegen。
- models snapshot。
- public HTTP schema。

## 15. 建议验证命令

从 `packages/opencode` 目录按由窄到宽执行：

```bash
bun test test/cli/stats-data.test.ts
bun test test/cli/stats-render-width.test.ts
bun test test/cli/stats-data.test.ts test/cli/stats-render-width.test.ts
bun typecheck
```

若 package 已有 lint 等价命令，再运行该命令；当前 `package.json` 没有 stats 专属 lint script，不应自行调用裸 `tsc`。

正式 `bun run build` 不是首轮验证，因为 build 会 import `generate.ts`、可能联网并重写 `packages/core/src/models-snapshot.*`。只有在隔离或确认生成副作用后才运行；否则在最终报告中明确“未执行 build，原因是会修改无关生成物”。

手工 smoke matrix：

```text
COLUMNS=40/80/120/160
--color never/always/auto
default 60 days / --days 0 / --all-time
empty database / no-match filters / legacy tool calls without context estimate
all seven breakdown dimensions
timeline tokens/cost/heatmap
sessions sort tokens/cost/calls/updated
insights with and without forecast
```

CLI 二进制 smoke 需要确认开发 launcher 能正常透传输出后再执行。此前直接运行 dev/install binary 的 stats 命令退出码为 0 但未捕获到页面文本，因此不能把该路径当作已验证证据；纯 renderer 与聚合测试是本方案的可靠 seam。

## 16. 独立复核标准

实现完成后，给独立 subagent 的输入只包含需求、修改文件路径和当前 diff，不提供本方案的实现理由。复核必须回答：

1. 是否仍有旧 matrix、编号 key、固定 RGB 或重复 palette 残留。
2. 是否把 Tool estimate 误写成 cost/billed token，或混淆 call owner 与 context consumer。
3. Project label/path fallback 是否改变 project ID filter 或 series 关联。
4. 每个 Breakdown 是否回答不同问题，同时保持一到两屏的中高密度。
5. 40/80/120/160 列、空数据、legacy 和 no-color 是否完整。
6. 是否存在不必要的新 interface、helper、状态或文件。
7. 中文解释性注释是否达到有效 diff 15%，且位于关键修改附近。
8. Dashboard、Timeline、Sessions、Insights、aliases、自然日与 Effect 生命周期是否降级。

任何行为级阻塞项都返工并重新做全范围复核，最多三轮；纯命名偏好不作为阻塞项。

### 16.1 本方案的三轮独立复核记录

本方案在落盘后由两个只读 subagent 分别从数据可实现性和终端信息架构做了三轮同范围复核，均未编辑文件或运行 Git 命令。

第一轮发现并修正：

- Tool attribution 缺 source/status 与 cutoff/filter 语义。
- Stored ToolPart ownership 被误写得过于精确，没有强调 fork duplicate。
- Status running elapsed 在现有数据中不可得。
- Project sanitization seam 前后不一致。
- Alias 被过强描述为字节级相同。
- 120 列稿件未按真实 114 content columns 校验。
- 缺窄屏全页面矩阵、无色重叠线方案和明确屏高预算。
- Timeline Heatmap 示例与现有 peak-relative primitive 不一致。

第二轮发现并修正：

- Request shell 尚未进入 Breakdown，group health 指标实际不完整。
- Assistant status 与 request final status 会污染同一个 Status group。
- Model/Provider 的 Assistant usage 与 request-owner health 缺用户可见区分。
- Filtered Tool footprint 不能继续读未按维度过滤的旧 call totals。
- 零费用、responsive default limit、Insights outcome leader 和 clear-and-stream tradeoff 需要明确。

第三轮发现并修正：

- `--status` 必须优先比较 request final outcome，否则会在分组前丢掉失败 request 的 Assistant usage。
- Dashboard 与 Sessions 的全零/部分正费用状态仍可能把“无正费用记录”伪装成已测得低成本。
- Dashboard 的 `dash/overview/summary` aliases 漏出入口矩阵。
- Insights 的失败率仍需标为 `owner fail`。
- Heatmap 追加后的总行数需要单独记录。

第三轮数据审计在提出 status-filter 阻塞时，现有 CLI 描述“request status”已经给出唯一兼容选择，因此方案按 request final outcome 修正，不形成用户决策分支。遵守最多三轮约束，未发起第四轮；最终 artifact 另以宽度、fence、行数和定向搜索做了只读自检。

## 17. 真实风险与开放问题

### 17.1 已接受风险

- ANSI 基础色的最终 RGB 由终端主题决定，极端自定义 palette 仍可能低对比；这是遵循用户终端主题的必要结果。关键值不只靠颜色编码。
- Tool call attribution 会继承现有 fork 复制 ToolPart 的重复风险；文案不能声称已去重。
- Source/legacy 数据缺失 requests/status/duration 时只能显示未知，不能补算。
- 现有 width 算法对复杂 emoji/ZWJ 与 Bun/OpenTUI 可能不同；本 patch 保留当前已测试的 CJK 行为。
- 多语言 docs 的旧默认值不会在本 patch 全量人工翻译，需 localization follow-up。

### 17.2 不需要用户阻塞决策的选择

- Project 显示名：name -> worktree basename -> session directory basename -> ID。
- Theme：terminal ANSI system semantics，不新增自定义 theme。
- Tool：展示真实 calls/chars/state/duration与估算 context，绝不展示 cost。
- Main chart：保留全宽，彩色无点，无色使用带稳定 mark 的共享尺度 sparkline rows。
- Provider/Model 关系：真实标签组成/路由表，删除编号矩阵。
- Interactive：继续五页，不新增菜单状态。

### 17.3 独立 follow-up

- Fork provenance 与 tail-only 统计。
- Interactive UTF-8 decoder、ESC 时序和逐步容错 finalizer 测试。
- 统一 stats、run、OpenTUI 的 Unicode width 实现。
- 多语言 CLI 文档同步机制。
- compiled binary 的 stats smoke test。

## 18. 验收清单

- [ ] Dashboard 在 120 列保持当前 section、细线、配色层级和信息量。
- [ ] Token Timeline 使用总量主图和四条独立归一化组件趋势；Cache Read 占 99% 时 Input/Cache Write/Output 仍各自可见且不夸大面积。
- [ ] 七个 Breakdown 都保留全宽主趋势，并至少有两个维度专属二级视图。
- [ ] Model 可见绝对 token、五类组成、cost、requests/calls、sessions、cache、Provider mix、Tool mix。
- [ ] Provider 可见绝对 cost/token/requests、经济性、失败/延迟和真实 model labels。
- [ ] Model/Provider 的 request 健康列明确标为 request-owner 指标；secondary Assistant identity 不被伪装成 owned request。
- [ ] Agent/Source context 百分比覆盖完整分母或明确 other。
- [ ] Project 默认显示可识别名称和完整 path，不改变 ID filter。
- [ ] Tool 同时标明 call share、estimated context share 和 char 单位，不出现 Tool cost。
- [ ] Status 按 request final outcome 独立显示 completed/error/aborted；legacy/窗口边界 usage 单列 unattributed，并展示 failure attribution。
- [ ] 不出现 `[A]`、`[1]` 作为实体身份替代，也不出现省略号丢内容。
- [ ] 彩色模式不含固定 24-bit RGB 和具体背景色；最终明暗对比委托给终端 ANSI palette。
- [ ] 彩色折线无密集点；无色模式仍可区分 series。
- [ ] 40/80/120/160 列固定宽度，长英文/CJK/path 完整。
- [ ] 空 report 只显示明确空态，Insights 不生成伪 action。
- [ ] canonical 命令和 aliases 复用同一 renderer，参数边界不变。
- [ ] 无 schema、migration、dependency、SDK/codegen 或 models snapshot 改动。
- [ ] 行为测试先红后绿，中文注释达到有效 diff 15%。

## 19. 推荐方案摘要

保留用户认可的 Dashboard 和全宽主图，把修改集中在 `data.ts` 的 request outcome 补正、Project identity、Tool call attribution 三个局部投影，`charts.ts` 的 terminal ANSI theme seam，以及 `render.ts` 的 Timeline/Breakdown 最终 projection。Token Timeline 用总量主图加独立组件趋势替换会吞掉小层的堆积面积图；同时删除编号矩阵和固定 RGB，不新增 theme/config/state machine，并用现有 group/series 恢复每个维度真正有意义的绝对值、组成和交叉透视。

该方案比“重写 stats”更克制，也比“只换颜色”更完整：它修复了截图中丑陋配色、编号身份、信息缩减和 Tool 语义含糊的共同根因，同时明确不碰 fork provenance、interactive 生命周期和数据库 schema。未来实现可以按九个 TDD vertical slices 逐页落地，每一步都有可观察的失败测试和独立回滚边界。

# Canonical Implementation Plan: Stats 前景色与 ANSI 状态修复

> Status: verified
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: full-scope
>
> Requirement source: 用户关于 `opencode stats` 深色模式前景色变暗、主题色退化以及“只提出第一性原理方案，不实施修改”的原文要求
>
> Implementation allowed: yes
>
> Last updated: 2026-07-14

This file is the sole implementation specification for the focused foreground
color regression described below. The existing broad Stats information
architecture proposal remains evidence and context; it is not authority for
this focused repair when the two documents differ.

## 1. Verbatim Requirement

> “请注意你当前修改的内容极其丑陋……当前我发现你的修改会导致颜色,你可以看到,颜色中虚线那一行,它的颜色都会变暗,也就是前面的折线的颜色都会变暗。同时,貌似你当前的配色风格,和我们最开始什么都没修改的时候……那几次的修改的配色好像比现在的更好看一点,现在的好像有一点过于没有主题色,然后也没有主题的色系等等内容。请你完整检查检查,看看什么情况。”
>
> “请注意理论上来说紫色的背景去掉是没问题的,问题是前景色有问题,你可以检查检查前景色的配色到底是怎么样的。同时请按照第一性原理进行相应的计划提出,而不要进行任何实施和修改。”

本计划只处理上述前景色与 ANSI 状态问题。用户明确要求当前阶段不实施代码修改；因此本 revision 只定义未来实现，不授权任何生产代码、测试、配置、数据库或生成文件改动。

## 2. Explicit Non-Goals

- 不恢复历史紫色 panel background；当前 `49m` 默认背景恢复和无具体背景色约束保持不变。
- 不回滚整个 `da7d9d8e3` Stats 重构，不改变 Dashboard、Timeline、Breakdown、Sessions、Insights 的数据投影、布局职责或页面数量。
- 不修改 fork provenance、tail-only 统计、session/message 去重、数据库 schema、migration、SDK、HTTP API 或数据聚合口径。
- 不新增 `--theme`、`stats.theme`、dark/light 配置项、环境变量猜测、持久化 KV 或状态机。
- 不启动 OpenTUI renderer，不在普通 `stats` 命令中发送 OSC terminal-palette 查询，不把 TUI `ThemeProvider` 强行接入纯字符串 CLI renderer。
- 不在 `render.ts` 的每个页面、每个表格或每条折线调用点分别补颜色；前景色必须由共享 chart seam 统一拥有。
- 不通过恢复固定 24-bit RGB 作为失败后的 fallback；历史 RGB 方案在亮色终端的对比度问题仍是已确认的既有风险。
- 不改变 `--color always/never/auto`、`NO_COLOR`、TTY 判断、可见宽度、无色形状、无点折线、背景安全和省略号约束。
- 当前阶段不运行会修改生成物的正式 build，不提交 commit，不 push，不清理或覆盖工作区其他修改。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 说明当前仓库是 SMARK fork，Stats v1 与 TUI/v2 代码并存；不能把 TUI runtime 假定成普通 Stats 的可用依赖。 |
| `AGENTS.md` | 规定测试必须从 package 目录运行、优先最小修改、避免无关重构，并要求保留共享工作区修改。 |
| `packages/opencode/AGENTS.md` | 规定 package 的 typecheck 命令、Effect/模块边界和不新增重复抽象的风格。 |
| `packages/opencode/test/AGENTS.md` | 规定行为级测试 seam、避免实现耦合，以及不使用时序 sleep 伪造同步。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复首个分歧、单一 primary path、禁止未经授权 fallback、要求正反向可追溯。 |
| `.opencode/templates/canonical-plan.md` | 规定本文件的 canonical plan 结构、revision、审计与实现证据字段。 |
| `docs/adr/README.md` | 本问题属于 Stats 单模块输出契约；除非引入跨模块主题契约，不新增 ADR。 |
| `docs/proposal/stats-terminal-information-architecture.md` | 现有 Stats 设计基线：无具体背景、终端语义色、共享 chart palette、页面职责和宽度不变量。其主题结论需要在本问题中针对 ANSI 状态泄漏重新校验。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/stats/charts.ts` | 当前 `palette`、`TEXT_RESET`、`gridStyle`、`ChartCanvas.render()`、`paint()` 和所有图表 primitive 的唯一共享实现。 | observed |
| `packages/opencode/src/cli/cmd/stats/render.ts` | 页面层只通过 `charts.ts` 的 palette alias 和公开 renderer 输出，证明无需逐页改色。 | observed |
| `packages/opencode/src/cli/cmd/stats.ts` | 证明 Stats 是独立的 Effect CLI handler，直接调用纯字符串 renderer，不创建 TUI renderer。 | observed |
| `packages/opencode/src/cli/ui.ts` | 普通 CLI 已有 `TEXT_INFO_BOLD`、`TEXT_SUCCESS_BOLD`、`TEXT_WARNING_BOLD`、`TEXT_DANGER_BOLD`、`TEXT_HIGHLIGHT_BOLD` 等 ANSI semantic role 约定。 | observed / contracted |
| `packages/opencode/src/cli/cmd/tui/context/theme.tsx` | `ThemeProvider` 依赖 renderer、KV、config 和 Solid context；`generateSystem()` 从 renderer palette 生成主题。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/theme/opencode.json` | 默认 TUI theme 的 primary/secondary/accent/status/text 语义，说明主题 token 与背景 token 是分开的。 | observed |
| `packages/opencode/src/cli/cmd/run/theme.ts` | `resolveRunTheme(renderer)` 的 renderer-dependent adapter 先例；不能直接作为 standalone Stats 输入。 | observed |
| `node_modules/@opentui/core/lib/terminal-palette.d.ts` | `TerminalPalette.detect()` 会通过 terminal palette detector 查询终端，证明直接探测不是零副作用的纯函数。 | observed / reachable |
| `packages/opencode/test/cli/stats-render-width.test.ts` | 现有所有页面的行为级宽度、颜色、背景、无色等测试 seam；尚未覆盖 grid dim 泄漏。 | observed |
| `packages/opencode/test/cli/run/theme.test.ts` | 证明 theme adapter 测试依赖 `CliRenderer`/`TerminalColors`，不是 Stats renderer 的现有 seam。 | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts` | 真实 CLI subprocess 的现有隔离先例：main process role、独立 XDG/DB/home 和 first-run migration marker。 | observed / contracted |
| `packages/opencode/test/preload.ts` | Bun test preload 在模块导入前把父测试进程 `OPENCODE_DB` 固定为 `:memory:`；证明 file-backed marker 数据必须由独立子进程生成。 | observed |
| `packages/core/src/global.ts` | 证明 data/cache/config/state 在模块加载时从 XDG 根目录派生，子进程测试必须在启动前隔离这些环境变量。 | observed |
| `packages/opencode/src/pty/pty.ts` 与 `pty.bun.ts` | 现有 PTY 只暴露 data/exit/write/resize/kill，没有 termios 查询；raw 恢复必须由保持 PTY 存活的外部 wrapper 观察。 | observed |
| `git show 8facd64e2:packages/opencode/src/cli/cmd/stats/charts.ts` | 早期 Stats 的固定 RGB foreground palette。 | observed |
| `git show 75a4cc2bb` | 移除具体 panel background、保留 RGB foreground 的过渡；证明背景去除和前景 palette 改变是两个独立决策。 | observed |
| `git show da7d9d8e3` | 当前从固定 RGB 转为 ANSI semantic palette 的实现来源。 | observed |
| 最小 `renderRoundedLineChart()` Bun harness | 真实运行当前 renderer，观察到 `\x1b[2;39m` 后直接出现 `\x1b[34m`，无中间 `\x1b[22m`。 | observed |
| 当前工作区 `git status --short` | Stats 生产代码、Stats 测试和现有 Stats proposal 当前没有工作树修改；其他 staged/unstaged 修改必须保留。 | observed |

### 4.1 Current Diagnostic Evidence

从 `packages/opencode` 执行的最小只读 harness：

```text
bun --conditions=browser -e '<renderRoundedLineChart minimal ANSI state probe>'
```

得到的关键片段：

```text
"\u001b[2;39m┄┄┄┄┄┄┄┄\u001b[34m╭───────╮..."
```

同一次运行统计到：

```json
{
  "dimStarts": 16,
  "intensityResets": 20
}
```

`\x1b[2;39m` 设置 dim 和默认 foreground；`\x1b[34m` 只改变 foreground，不清除 dim。因而在同一 style run 中，折线 glyph 会继承网格的 dim 状态。该证据直接复现用户描述的“虚线后前面的折线颜色变暗”，不是截图推测。

### 4.2 Original Visual Feedback Loop

ANSI literal tests只能证明输出协议，不能替代用户报告的终端视觉结果。实施阶段必须在改代码前后使用同一数据、同一终端 profile 和同一尺寸做对照：

```text
working directory: /Users/sunbenteng/Project/opencode/packages/opencode
database: /Users/sunbenteng/Project/opencode/.temp/testing/opencode.db
terminal: 用户报告问题的当前 macOS 深色 terminal profile
viewport: 140 columns
color mode: --color always

bun --conditions=browser src/index.ts stats --days 60 --color always
bun --conditions=browser src/index.ts stats timeline --days 60 --metric tokens --color always
bun --conditions=browser src/index.ts stats breakdown model --days 60 --color always
bun --conditions=browser src/index.ts stats breakdown provider --days 60 --color always
bun --conditions=browser src/index.ts stats breakdown tool --days 60 --color always
bun --conditions=browser src/index.ts stats breakdown status --days 60 --color always
bun --conditions=browser src/index.ts stats sessions --days 60 --color always
bun --conditions=browser src/index.ts stats insights --days 60 --forecast --color always
```

每条命令在环境中显式设置上述绝对 `OPENCODE_DB`。终端必须实际调整到 140 列，不能只设置不会改变 PTY 宽度的 `COLUMNS` 字符串。

修改前后分别保存：

- 原始 ANSI capture，写入临时目录 `.../T/opencode/stats-foreground-r6/{before,after}/`。
- 同一 viewport 的终端截图；不得对截图做色彩校正。
- `TERM_PROGRAM`、`TERM`、macOS appearance 和用户当前 terminal profile 名称，以保证对照使用同一解释环境。
- `--color never` capture，用于确认去色后几何和正文不变。

自动 acceptance：

1. raw state parser 证明任何 series glyph 输出时 `dim=false`。
2. role escapes 与 §10.2 一致，无 `38;2` foreground 和任何 concrete background。
3. `stripAnsi(always) === never`，140 列宽度和所有可见内容保持不变。

人工 acceptance（实现完成硬门槛）：

1. 同一条数据线在进入、穿过、离开虚线 grid 时不能出现可感知的亮度下降。
2. Grid/muted 明显弱于数据，但数据线、精确值和实体名称保持清晰。
3. Title/accent 呈稳定 magenta/cyan 层级；blue/green/yellow/red 与两组 magenta/amber 系列可辨，不形成无主题的随机彩虹。
4. 不出现紫色或其他具体背景填充。
5. 用户对 `before`/`after` 同 profile 截图确认“折线不再被虚线压暗，前景色系可接受”。未获得该确认时只能报告“自动协议验证通过、视觉验收待定”，不得声明实现完成，也不得自动切换 RGB/TUI/第二 palette。

## 5. Current Behavior

### 5.1 Producer-to-consumer path

```text
StatsCommand
  -> loadReport()
  -> renderDashboard/renderBreakdown/renderTimeline/renderSessions/renderInsights
  -> charts.ts palette/renderContext/ChartCanvas
  -> ANSI string
  -> console.log()
  -> user terminal
```

页面层的 `render.ts` 将 `charts.ts` 的 `palette` 映射到 `theme` alias；没有第二套实际颜色表。所有折线、百分比堆积条、表格和 callout 最终通过 `paint()` 或 `ChartCanvas.render()` 输出 ANSI。

### 5.2 Current foreground palette

当前 `charts.ts` 使用：

| Role | Current escape | Current semantic intent |
| --- | --- | --- |
| `axis/title/white` | `\x1b[39m` | 交给终端默认前景，避免固定 RGB 在浅色终端失去对比。 |
| `subtitle` | `\x1b[36m` | 使用 terminal cyan。 |
| `blue/green/yellow/purple/red` | 基础 ANSI 颜色槽 | 多系列身份和状态语义。 |
| `orange/pink` | bright ANSI 槽 | 与基础系列区分。 |
| `muted/grid` | `\x1b[2;39m` | 低优先级网格、分隔线、未填充条。 |

该 palette 不输出具体 background；`render.ts`/`charts.ts` 的 panel 只使用 `\x1b[49m` 恢复默认背景。

### 5.3 Current failure

`ChartCanvas.render()` 当前在 `cell.style !== active` 时直接输出：

```text
previous style -> new palette foreground
```

而不是：

```text
previous style -> clear intensity/foreground -> new palette foreground
```

因此 `gridStyle` 的 dim 状态可进入数据线 style。该状态还会影响后续标题、轴和其它同一行 glyph 的观感，故用户看到的是多页面共同的前景退化，而不是某个 Breakdown composer 的局部配色错误。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `--color always` | yargs `colorMode()` | 允许显式开启 ANSI | 所有 Stats renderer | `charts.ts` color seam | observed / contracted |
| `--color never` | yargs `colorMode()` | 禁止 ANSI | 所有 Stats renderer | `charts.ts` color seam | observed / contracted |
| `--color auto` + TTY | `useColor()` | TTY 且 `NO_COLOR` 未设置或为空字符串时开启颜色 | 所有 Stats renderer | `charts.ts` color seam | observed / contracted |
| non-empty `NO_COLOR` | process environment | 只有非空字符串在 auto 模式关闭颜色；空字符串按当前 truthiness 行为等同未设置 | 所有 Stats renderer | `useColor()` | observed / contracted |
| grid/axis/series style transition | `ChartCanvas` 绘图 primitive | Cell 已带合法 `ChartStyle` | 折线、热力图和其它 canvas primitive | `ChartCanvas.render()` | observed / reachable |
| `paint()` 文本片段 | 页面与 chart primitive | 文本已是字符串，颜色由调用方语义指定 | 表格、legend、callout、stack | `paint()`/共享 palette | observed |
| 深色或浅色终端的 ANSI 色槽 | terminal profile | 终端解释 ANSI foreground | `console.log()` 后用户终端 | terminal, not Stats | reachable |
| OpenCode TUI custom theme | TUI config/KV + renderer | 需要 TUI provider/runtime | 不经过 standalone Stats command | TUI ThemeProvider | observed as non-reachable for Stats |
| OpenTUI OSC palette query | `TerminalPalette.detect()` | 会写/读 terminal control sequence | 当前 Stats 未调用 | terminal adapter | reachable but explicitly out of scope |

没有证据表明 Stats 命令当前接收 `ThemeJson`、`CliRenderer` 或用户选中的 TUI theme；因此不能把这些类型假定为现有输入。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-FG-01 | 每个 chart style run 在输出新 foreground 前必须清除前一 style 的 dim/bold/foreground 状态；数据 glyph 不得继承 grid 的 dim。 | 最小 ANSI harness；`ChartCanvas.render()` 当前 transition。 | 缺失，需新增 red test。 |
| INV-FG-02 | Grid、axis、text、series 使用同一共享 semantic palette；页面层不得自行复制或覆盖颜色角色。R6 固定 role-to-ANSI contract：`title=95m`、`subtitle=96m`、`blue=94m`、`cyan=96m`、`green=92m`、`yellow=93m`、`orange=33m`、`purple=95m`、`pink=35m`、`red=91m`、`axis/white=39m`、`muted/grid=2;39m`。只有 `muted/grid` 可以携带 dim。 | `render.ts` 只 alias `charts.ts.palette`；`renderRoundedLineChart()`、tables、stacks 共用 `paint`；`cli/ui.ts` 已使用 bright ANSI semantic roles。 | 部分由 colored breakdown/status 测试覆盖；R6 新增 exact public palette contract、全入口矩阵和真实终端视觉 gate。 |
| INV-FG-03 | Stats 不绘制具体背景；彩色 panel 只能使用 `49m` 恢复默认背景，不能恢复历史紫色 background。 | `never emits terminal background ANSI` 测试与 `BACKGROUND_RESET`。 | 已有 `stats-render-width.test.ts:1307`。 |
| INV-FG-04 | `stripAnsi(color=always)` 的可见正文和几何必须等于 `color=never`；前景修复不能改变布局。 | `stripAnsi`/固定宽度测试。 | 已有多页面覆盖。 |
| INV-FG-05 | 彩色折线仍无密集点；颜色只加速身份识别，无色模式继续有形状/完整名称。 | `renderRoundedLineChart()` 与现有 breakdown tests。 | 已有 `keeps colored breakdown trend lines free of point markers`。 |
| INV-FG-06 | 所有 Stats 页面、可达 option 分支、兼容 alias、root shortcut 和 interactive view 继续到达同一 shared render path；不因修复新增页面专属 palette。 | `stats.ts` command mapping、root dispatch、interactive callback table、`renderModels/renderProviders` wrapper、timeline/heatmap/forecast branches。 | R6 新增独立 file-backed seed 子进程、可区分 usage marker 的真实 CLI dispatch/PTY 测试与彩色 renderer 矩阵。 |
| INV-FG-07 | Color mode 优先级保持当前 truthy contract：`always` 即使 `NO_COLOR` 为非空值也输出 ANSI；`never` 始终纯文本；`auto` 在 non-TTY 或 `NO_COLOR` 为非空字符串时纯文本；`NO_COLOR` 未设置或值为空字符串时不禁用 TTY 颜色。 | `stats.ts` public default 和 `charts.ts:128-135` `useColor()` 的 truthiness 判定。 | 当前缺失；R6 通过公开 renderer 与真实 CLI TTY/non-TTY/未设置/空值/非空值矩阵补齐。 |
| INV-FG-08 | 在用户报告问题的同一 macOS 深色终端 profile、140 列和同一数据库下，修复后数据线跨越 grid 前后不得发生亮度下降；标题/辅助层级呈现稳定 magenta/cyan 主题，系列色彼此可辨，且不恢复具体背景。 | 用户截图/描述、当前 raw ANSI repro、实现前后同 profile capture。 | 自动 ANSI-state test 可证明 dim 不泄漏；最终视觉结果必须经过同 profile artifact 与用户确认。 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| `INV-FG-01` | `ChartCanvas.render()` line 419 在 `cell.style !== active` 时直接拼接 `ctx.palette[active.color]`，没有先发 `TEXT_RESET`。 | `packages/opencode/src/cli/cmd/stats/charts.ts`, private `ChartCanvas.render()` but publicly observed through `renderRoundedLineChart()`. | Raw output contains `\x1b[2;39m...\x1b[34m` with no `\x1b[22m` between grid and series. |
| `INV-FG-02` | 当前 shared `palette` 已从历史主题 RGB 收敛为 default/ANSI roles；中性标题和轴不再携带历史紫色层次，且当前普通 ANSI series 在 dim leak 后进一步变暗。 | `charts.ts` `palette`; `render.ts` is only consumer alias. | `git show 75a4cc2bb` vs current `da7d9d8e3`, plus current palette lines 94-113 and user-visible output. |
| `INV-FG-03` | 没有发现当前背景 invariant 的新分歧；background removal is working and must be preserved. | `render.ts` `panel()` and `charts.ts` `renderPanel()`. | Existing background test passes in prior baseline; current code emits `49m`, not concrete background. |

### Root-cause separation

- **确定性行为 bug**：ANSI intensity state transition 缺少 reset，是折线被虚线变暗的首个分歧。
- **视觉策略退化**：foreground role mapping 从历史固定 purple RGB 变成 ANSI/default 后，主题层次改变；这不是通过恢复 background 可以解决的问题。
- **不是根因**：series priority、series identity、point marker、各 Breakdown composer、panel width 和 database aggregation。它们都在 style transition 之前或之后消费同一结果，不能解释 dim 状态跨 style run 传播。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| ANSI style reset and transition | `ChartCanvas.render()` in `charts.ts` | 将 Cell 网格转换为不泄漏终端状态的行字符串 | 它是第一个把相邻 style 变成 ANSI sequence 的模块，也是首个 invariant 失真的位置。 | `render.ts` 只组合页面；在调用方补 reset 会遗漏其它 chart primitive。 |
| Semantic foreground palette | `charts.ts` exported `palette`/`renderContext` seam | 所有 chart/text primitive 使用同一 role-to-ANSI 映射 | 当前所有页面已集中 alias 到这里，最小切入点只有一个。 | `render.ts` 的 `theme` 是 alias，不应成为第二 palette；TUI theme 依赖不存在的 runtime context。 |
| Background reset | existing `panel()` / `renderPanel()` | 只清理上游背景，不指定具体颜色 | 当前行为已满足用户认可的背景去除，不需要与前景修复耦合。 | `ChartCanvas` 不拥有 panel 边界；恢复 background 会扩大回归面。 |
| User-visible regression test | `renderRoundedLineChart()` and page renderers | 从公开输出观察 ANSI state、text、width | 真实 bug 可在纯字符串 seam 确定复现，速度快且不依赖 PTY。 | 测试私有 `ChartCanvas` 或源码文本会锁定实现，不符合 TDD seam。 |
| CLI alias/root/interactive dispatch | `packages/opencode/src/cli/cmd/stats.ts` command tree and handlers | 公开 CLI 参数必须实际选择预期 renderer；interactive 必须实际切换五个 view | 这些行为属于命令模块，不是 builder 或 renderer primitive；真实 subprocess/PTY 才能观察 dispatch 和 cleanup。 | 不在生产代码中新增 test-only dispatch helper；isolated builder assertions 只能补充参数校验。 |
| Dynamic TUI theme selection | TUI `ThemeProvider` | 仅在 OpenTUI/Solid/KV/config provider tree 中提供 ThemeJson | 当前 Stats command 没有该输入；本任务不扩展生命周期。 | `stats.ts`、普通 CLI 和 pipe/redirection 不应启动 TUI runtime 或增加 OSC cleanup。 |

## 10. Single Approved Primary-Path Design

### 10.1 Authoritative path

```text
ChartSeries/Cell styles
  -> shared renderContext() and semantic foreground palette
  -> ChartCanvas.render()
       -> before every style transition: clear intensity + foreground
       -> apply exactly one active style
       -> row-final reset
  -> page panel() applies only 49m boundary reset
  -> console.log() emits stable ANSI/plain output
```

### 10.2 Primary repair

1. 在 `ChartCanvas.render()` 的 style transition owner 处，先输出现有 `TEXT_RESET`，再输出新 style 的 bold/foreground。首个 cell style 也必须从干净的 intensity state 开始，避免继承调用者或上一行的 dim。
2. 保留 `TEXT_RESET = \x1b[22m\x1b[39m` 的职责：它只恢复 intensity/foreground，不触碰 background；background 继续由 panel 的 `49m` 边界负责。
3. 将 foreground role mapping 继续集中在 `charts.ts`，采用已经存在于普通 CLI 和 OpenCode system theme 语义中的 ANSI 槽位。R6 的唯一目标表如下；这些是 public `--color always` 输出契约，不是实现者可自由选择的视觉建议：

   | Role | ANSI | Semantic responsibility |
   | --- | --- | --- |
   | `title` | `\x1b[95m` | 主题/二级 accent；标题和 section identity。 |
   | `subtitle` | `\x1b[96m` | primary/info；页面说明和辅助标签。 |
   | `blue` | `\x1b[94m` | info/第一系列，避免普通蓝在深色 profile 中过暗。 |
   | `cyan` | `\x1b[96m` | primary/highlight。 |
   | `green` | `\x1b[92m` | success/positive usage。 |
   | `yellow` | `\x1b[93m` | warning/attention。 |
   | `orange` | `\x1b[33m` | 次级 amber，和 bright warning 保持可区分。 |
   | `purple` | `\x1b[95m` | accent/forecast/high intensity。 |
   | `pink` | `\x1b[35m` | 次级 magenta/forecast 对照。 |
   | `red` | `\x1b[91m` | error/danger。 |
   | `axis`、`white` | `\x1b[39m` | 终端默认前景；正文和精确值不依赖彩色。 |
   | `muted`、`grid` | `\x1b[2;39m` | 解释性文字、网格和未填充段；只能表达低优先级结构。 |

   bright/normal 的组合复用 `packages/opencode/src/cli/ui.ts` 的普通 CLI 语义；不查询 TUI runtime，不加入 RGB 或 background 通道。
4. 调整 palette 时只修改 role-to-foreground code，不修改 `ChartColor` public union、`seriesColor()` 顺序、render page 调用点或无色分支。R6 的可验收条件是：每个 role 的实际 escape code 与上表一致；数据线不处于 dim；标题/辅助层级有稳定的 cyan/magenta 主题色；系列仍可区分。
5. 不在 style transition 失败时切换另一种 renderer、不捕获异常合成成功输出、不按终端类型建立第二套 success path。当前 semantic ANSI table 是唯一 primary path。

### 10.3 Why this repairs the first divergence

Reset 放在 `ChartCanvas.render()` 的 style transition 前，直接恢复被 grid 设置的 dim state；这是比在数据线调用方、legend 或 panel 外层补 reset 更早、也更完整的修复。共享 palette 的角色校准则解决当前历史 RGB 与默认 ANSI 之间的视觉层次变化，但仍保留终端负责最终 RGB 的设计原则。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| `ChartCanvas.render()` shared reset + palette | proposed | primary-contract path | yes | 100% | approve |
| `paint()` per-fragment reset | existing | primary-contract path for non-canvas text | yes | existing | preserve; no semantic expansion |
| `render.ts` page-local color patches | proposed alternative | forbidden fallback/duplicate ownership | yes | 0% allowed | reject |
| TUI `useTheme()`/`ThemeProvider` from Stats | proposed alternative | forbidden runtime coupling | yes | 0% allowed | reject |
| `TerminalPalette.detect()` OSC query in Stats | proposed alternative | new side-effecting alternate path | yes | 0% allowed | reject |
| Restore historical 24-bit RGB after ANSI looks poor | proposed alternative | unapproved behavior rollback/fallback | yes | 0% allowed | reject unless user later gives exact path-specific rollback authorization |
| Restore purple panel background | proposed alternative | forbidden visual workaround | yes | 0% allowed | reject |
| `color=never` plain output | existing | contracted pass-through | yes | existing | preserve |

No new alternate success path is authorized. The only implementation path is
the shared chart renderer plus its single semantic palette.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| No current page-level reset workaround | None observed | No downstream workaround should be added; repair the owner directly. | None |
| Historical `fg(r,g,b)`/panel background design | Earlier visual theme implementation | Background is already correctly removed; fixed RGB is not a safe dark/light contract. | Do not reintroduce; current `charts.ts` remains the sole palette. |
| Any future per-page color override | Would compensate for a shared palette/state bug | Shared `renderContext()` must remain the only role mapping. | Reject before implementation. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| Foreground line must not dim after grid | `ChartCanvas.render()` | Reset intensity/foreground before each style transition | Public `renderRoundedLineChart()` ANSI state test |
| Theme hierarchy must be shared | `palette` + `renderContext()` | Implement the exact R6 role table in `charts.ts`; keep `render.ts` alias | Minimal chart role-contract test with independent literal ANSI expectations |
| Purple background removal remains | `panel()`/`renderPanel()` | No background changes | Existing concrete-background test remains green |
| No-color behavior remains exact | `useColor()` and `paint()` | No change to mode selection or plain branch | `stripAnsi(always) === never` across pages |
| Series identity remains stable and marker-free | `seriesColor()`/`renderRoundedLineChart()` | No change to color order or points policy | Existing breakdown trend and wrapper tests |
| All entrypoints share repair | `stats.ts` -> page renderers/options/aliases/interactive callbacks | No page-specific palette; shared primitive only | Complete colored renderer/option matrix plus real CLI alias, root-shortcut and PTY interactive dispatch test |
| Empty-report foreground remains valid | no-match/new installation -> page empty renderer | No production branch change; shared role table must apply safely | Colored empty report through all five exported page renderers, including separate Insights empty path |
| Color mode precedence remains exact | CLI/default option -> `useColor()` -> renderer output | No production change; preserve `always/never/auto`, `NO_COLOR` and TTY behavior | Public renderer plus isolated CLI TTY/non-TTY matrix covering every decision branch |
| Original dark-terminal foreground result is visibly repaired | shared palette + canvas transition -> actual macOS terminal profile | No additional production path; require same-profile before/after artifacts and user acceptance | Raw ANSI parser plus §4.2 140-column visual feedback loop |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Reset before every `ChartCanvas` style transition | `INV-FG-01` | Raw `2;39m -> 34m` trace | Existing transition only applies new color and leaves intensity state active. |
| One shared semantic foreground table | `INV-FG-02`, `INV-FG-06` | `render.ts` aliases `charts.ts.palette`; multiple primitives consume it | Page-level values would duplicate the existing owner and drift. |
| Keep `49m` panel boundary unchanged | `INV-FG-03` | Existing background test and current panel code | Foreground transition cannot clear background without violating panel responsibility. |
| Public ANSI stream regression parser | `INV-FG-01`, `INV-FG-04` | `renderRoundedLineChart()` is an existing exported seam | A private `ChartCanvas` test would not prove the actual user-visible path. |
| Exact R6 semantic ANSI role table | `INV-FG-02` | `cli/ui.ts`, `generateSystem()` and current palette history | Current palette uses several normal slots and default title/subtitle roles; it cannot satisfy the reported theme hierarchy contract without an explicit mapping. |
| Actual CLI dispatch/PTY verification | `INV-FG-06` | `stats.ts` owns aliases, root shortcut precedence and private interactive callback table | Isolated builders and direct renderer calls cannot prove which handler/view the public command selected. |
| Colored empty-page partition | `INV-FG-02`, `INV-FG-03`, `INV-FG-04`, `INV-FG-06` | `renderEmptyStatsPage()` plus separate `renderInsights()` empty branch | Existing empty fixture only runs `color=never`, so it cannot catch foreground/background state regressions. |
| Auto/NO_COLOR decision matrix | `INV-FG-07` | Public `useColor()` branch and CLI default option | Explicit `always/never` strip checks cannot detect a regression in the default `auto` TTY/NO_COLOR decisions. |
| Same-profile visual acceptance gate | `INV-FG-08` | User-reported screenshot symptom and terminal-defined ANSI interpretation | Literal escapes cannot prove perceived brightness or theme coherence in the terminal that motivated the task. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/opencode/src/cli/cmd/stats/charts.ts` | modify | Repair `ChartCanvas.render()` transition reset; refine only the shared foreground role table; keep background, width, series order and plain branch unchanged. | +8 to +24 / -2 to -12 |
| `packages/opencode/test/cli/stats-render-width.test.ts` | modify | Add behavior-level ANSI state regression, exact shared palette contract, complete populated/empty renderer matrix, and `always/never/auto` + `NO_COLOR` decision coverage; update only assertions whose public role mapping intentionally changes. | +75 to +145 / -0 to -18 |
| `packages/opencode/test/fixture/stats-command-seed.ts` | add | Run as a separate Bun process after isolated environment variables are set; use `AppRuntime` + `InstanceStore` + real `Session.Service` to create `dispatch-model`/`dispatch-provider`/`dispatch-tool` usage directly in the file-backed child `OPENCODE_DB`, then dispose/close cleanly. | +80 to +140 / 0 |
| `packages/opencode/test/cli/stats-command.test.ts` | add | Start the file-backed seed child, then invoke the real Stats CLI against that exact isolated database; verify aliases/root shortcuts, default color resolution, non-TTY interactive behavior, and PTY five-view/raw-mode cleanup without adding a production seam. | +190 to +320 / 0 |
| `packages/opencode/test/cli/stats-data.test.ts` | no change planned | Existing isolated builder tests continue to validate defaults and rejected options, but are not treated as alias/handler dispatch proof. | 0 / 0 |
| `packages/opencode/src/cli/cmd/stats/render.ts` | no change planned | Continue consuming `charts.ts` palette alias; no page-local color changes are necessary. | 0 / 0 |
| `packages/opencode/src/cli/cmd/stats.ts` | no change planned | Keep command/TTY/NO_COLOR/interactive lifecycle unchanged; actual dispatch is observed through the new CLI subprocess/PTY test rather than a test-only production export. | 0 / 0 |
| `packages/opencode/src/cli/cmd/tui/context/theme.tsx` | no change planned | Do not couple standalone Stats to Solid/OpenTUI theme runtime. | 0 / 0 |
| `packages/opencode/src/cli/ui.ts` | no change planned | Reuse existing semantic role vocabulary as evidence; avoid changing unrelated CLI output. | 0 / 0 |
| `docs/proposal/stats-terminal-information-architecture.md` | no change planned in implementation patch | Existing broad proposal remains historical context; this focused plan is the authority for the foreground regression. | 0 / 0 |
| Database schema/migrations/SDK/generated files | no change | No persisted or protocol data is involved. | 0 / 0 |

## 16. TDD Behavior Slices

The agreed public seams are `renderRoundedLineChart()` for the minimized
regression, the five exported page renderers for visible output, and the actual
Stats CLI process/PTY for alias, root-shortcut and interactive dispatch. The
existing yargs builder tests only supplement option validation. No private
`ChartCanvas` method, source-text assertion, palette constant assertion, or
test-only production dispatch export is allowed as the primary behavior test.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Render a small colored line chart whose path crosses a grid row and assert that a series glyph is never emitted while ANSI dim is active. | Current output has `2;39m` followed by `34m` without `22m`; the public ANSI stream is red-capable. | Reset intensity/foreground before each canvas style transition and keep row-final reset. | Prevents grid dim from darkening every line chart and all pages that reuse it. |
| 2 | Render the same chart with `color=never`; assert visible rows and labels equal `stripAnsi(color=always)`. | Any reset/palette edit that injects visible text or changes geometry would diverge. | Keep color mode branching and visible layout untouched. | Protects no-color, pipe, snapshot and fixed-width behavior. |
| 3 | Render the exact R6 palette contract through a minimal public chart/text output; assert each changed role emits its literal ANSI code and only muted/grid may set dim. | Current `title=39m`, `blue=34m`, `green=32m` and other roles do not match the R6 contract, so this test is red before implementation. | Replace only the shared palette table with the R6 mapping. | Makes the theme hierarchy deterministic instead of leaving visual choice to the implementer. |
| 4 | Run a colored renderer matrix: Dashboard normal and narrow; all seven Breakdown dimensions; Timeline tokens, cost, and heatmap; Sessions; Insights default and forecast. For each output assert role contract, no concrete RGB/background, `stripAnsi(always) === never`, and fixed visible width. | Existing detailed-page matrix is mostly `color=never`; several reachable colored branches are not covered by current background/role assertions. | Keep every branch on the shared `charts.ts` path and preserve each page's existing visible text. | Prevents a palette change from fixing the main chart while breaking heatmap, status, cost or forecast colors. |
| 5 | Render `emptyReport()` with `color=always` and `never` through Dashboard, all seven Breakdown dimensions, Timeline, Sessions and the separately implemented Insights empty branch; assert R6 roles, only `49m` background reset, strip equivalence and fixed width. | Existing empty-page matrix is `color=never` only, so current tests cannot detect a foreground/background regression in the early-return paths. | Reuse the shared palette without changing either empty renderer. | Protects new installation and no-match filters across all page entrypoints. |
| 6 | Through public renderer output, cover `always`, `never`, and `auto` under TTY/non-TTY with `NO_COLOR` unset, empty, and non-empty; repeat default `auto` in the isolated CLI non-TTY and PTY cases. | Current tests force `always`/`never`, so a regression in the default branch or truthiness boundary would remain green. | Preserve `useColor()` unchanged; add behavior coverage only. | Protects the public default and exact precedence/value domain of explicit mode, `NO_COLOR` and TTY. |
| 7 | Spawn the actual Stats CLI against a fully isolated, populated temporary database using argument arrays for every canonical command, alias and root shortcut; assert process success, expected page identity/unique marker, R6 title role, no concrete background, and decolored equivalence within each alias class. | Isolated builders cannot prove which handler yargs dispatches; a shared empty Breakdown cannot distinguish model/provider/tool routes. | Add test-only subprocess coverage with discriminating model/provider/tool data; do not change `stats.ts`. | Protects all public command routes through their owning CLI interface. |
| 8 | Spawn a PTY wrapper that records terminal mode, launches `stats --interactive` on the same terminal, waits for Dashboard -> Breakdown -> Timeline -> Sessions -> Insights while the test sends `n`, then records terminal mode after `q`; assert equal modes, cursor reset and clean exit. | Direct-child PTY output cannot observe raw-mode restoration after the child closes. | Keep the PTY alive in a test wrapper and compare external terminal state before/after; do not add production inspection. | Protects actual view dispatch plus raw/cursor/listener cleanup. |
| 9 | Run existing background, marker-free, width, injection-sanitization and all-page no-ellipsis tests unchanged. | A broad ANSI change can regress background reset, point policy or width accounting even if the dim test passes. | Make the state/palette change without changing visible glyph count or panel boundaries. | Protects unrelated but adjacent terminal contracts. |

### 16.1 Colored reachability matrix

The following matrix is the minimum complete color test partition. Rows with
the same renderer and no additional color consumer may share one assertion;
the option branches listed here must not be silently omitted.

| Reachable entry/option class | Public seam | Distinct foreground consumers to assert |
| --- | --- | --- |
| Dashboard, width `>=60` | `renderDashboard(report, { color: "always" })` | title/subtitle, daily blue series, token component roles, health/status roles, lollipop/stack roles, grid. |
| Dashboard, width `<60` | same seam with `withColumns(40)` | narrow daily chart, compact headers, model/session bars, shared role reset. |
| Breakdown: model | `renderBreakdown(..., { by: "model", color: "always" })` | top-series roles, token composition blue/green/purple/yellow/pink, table identity colors. |
| Breakdown: provider | `by: "provider"` | cost trend, provider identity, risk red/orange, reliability/status colors. |
| Breakdown: agent/source/project | each `by` value | series identity, context/portfolio tables, muted/grid separators, project/runtime colors. |
| Breakdown: tool | `by: "tool"` | estimated-context trend, tool identity, call/error/duration values, issuing-runtime table. |
| Breakdown: status | `by: "status"` | completed green, error red, aborted yellow, running blue, failure leader values. |
| Timeline tokens | `renderTimeline(..., { metric: "tokens", color: "always" })` | main blue line, component series, model/provider sparklines. |
| Timeline cost | `metric: "cost"` and `StatsCostsCommand` option class | cost line, health rows, unavailable branch when cost is zero. |
| Timeline heatmap | `heatmap: true` and `StatsHeatmapCommand` option class | grid/muted zero cells, blue/purple/pink intensity levels, legend. |
| Sessions | `renderSessions(..., { color: "always" })` | distribution/rank bars, positive/error accents, session identity and muted metadata. |
| Insights default | `renderInsights(..., { color: "always" })` | usage shape, attribution table, outlier red/orange, action callout accent. |
| Insights forecast | `forecast: true` and `StatsForecastCommand` option class | observed pink sparkline, projected purple sparkline, unavailable branch. |
| Empty report: shared pages | `emptyReport()` through Dashboard, all Breakdown dimensions, Timeline and Sessions with `color: "always"` | title/subtitle/muted roles, only `49m`, strip equivalence and fixed width before any normal chart section. |
| Empty report: Insights | `renderInsights(emptyReport(), { color: "always" })` | separate Insights early return with the same foreground/background/plain invariants. |
| Color mode: explicit `always` | renderer/CLI with `NO_COLOR="1"` and TTY/non-TTY variants | ANSI remains enabled because explicit mode has highest priority. |
| Color mode: explicit `never` | renderer/CLI under TTY and without `NO_COLOR` | no ANSI is emitted. |
| Color mode: default/explicit `auto` | renderer and actual CLI under non-TTY/TTY with `NO_COLOR` unset, `""`, and `"1"` | non-TTY/plain; TTY + unset/empty/colored; TTY + non-empty/plain. |
| Dashboard/root aliases | `stats`, `dashboard`, `dash`, `overview`, `summary`, plus root `--models`/`--tools` shortcuts | same Dashboard or uniquely identified Model/Tool Breakdown renderer, same R6 role contract; no alternate palette. |
| Breakdown aliases | `breakdown`, `by`, `models`, `model`, `providers`, `provider` | same model/provider/selected-dimension renderer and same role contract. |
| Timeline aliases | `timeline`, `daily`, `heatmap`, `heat`, `costs`, `cost`, `tokens`, `token` | same token/cost/heatmap renderer and same role contract. |
| Session/Insights aliases | `sessions`, `session`, `insights`, `insight`, `forecast`, `run-rate` | same Sessions/Insights renderer and same role contract. |
| Interactive views | `--interactive`/`-i` five view callbacks | same five canonical renderers; non-TTY still renders once and does not create a second palette. |
| Canonical/wrapper aliases | actual CLI subprocess matrix plus existing direct wrappers | same decolored body and same shared ANSI role contract; no alternate palette. |

### 16.2 Actual CLI harness contract

`packages/opencode/test/cli/stats-command.test.ts` must exercise the owning
command interface rather than cloning builders with stub handlers:

- Create a fixture directory through existing `tmpdir({ git: true })`. Build an
  isolated child environment using the existing real-CLI pattern in
  `test/cli/tui/daemon.test.ts`: force `OPENCODE_PROCESS_ROLE=main`, clear the
  inherited daemon launcher identity, set `OPENCODE_PURE=1`, point
  `OPENCODE_DB` and `OPENCODE_TEST_HOME` into the fixture, and set
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and
  `OPENCODE_CONFIG_DIR` to separate fixture subdirectories. Remove inherited
  `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` overrides.
- Before spawning, create `${XDG_DATA_HOME}/opencode/opencode.db` as the
  first-run migration marker. The command under test may migrate only the
  isolated `OPENCODE_DB`; it must never inspect or import the user's legacy
  `${Global.Path.data}/storage` tree.
- The parent Bun test process cannot seed this file: `test/preload.ts` has
  already caused source modules to capture `OPENCODE_DB=:memory:`. Spawn
  `test/fixture/stats-command-seed.ts` as a separate Bun process with the same
  isolated environment before any CLI assertion. Because its environment is
  set before module import, `Database.Client()` opens the file-backed
  `OPENCODE_DB` directly.
- The seed process uses the production `AppRuntime`/`InstanceStore` context and
  real `Session.Service` APIs to create one Assistant usage identifying
  `dispatch-model` and `dispatch-provider`, one completed ToolPart identifying
  `dispatch-tool`, and a stable session title/project. It must not import the
  Bun test preload, copy the parent's `:memory:` database, hand-author schema
  rows or duplicate aggregation logic. It disposes the instance/runtime and
  closes the database before exiting, so subsequent CLI processes consume the
  same checkpointed file.

```text
isolated env + file-backed OPENCODE_DB
  -> Bun stats-command-seed.ts (no test preload)
  -> InstanceStore.Service.load(fixture cwd)
  -> instanceContext.provide(ctx)
  -> AppRuntime.runPromise(seed Effect + InstanceRef)
  -> Session.create/updateMessage/updatePart(step-finish + completed tool)
  -> store.dispose(ctx) -> Database.close() -> AppRuntime.dispose()
  -> actual Stats CLI subprocesses read that same OPENCODE_DB file
```
- Spawn Bun with an argv array (`process.execPath`, `--conditions=browser`,
  `src/index.ts`, command args); never construct a shell string. Capture stdout,
  stderr and exit status and fail on timeout/non-zero exit.
- Execute every alias class listed in §16.1 against the populated copy. Require
  `models/model` and root `--models` to expose `dispatch-model`,
  `providers/provider` to expose `dispatch-provider`, and root `--tools` plus
  Tool Breakdown aliases to expose `dispatch-tool`. Other page classes must
  expose their own page title/section. This makes a swapped handler or shortcut
  fail instead of converging on the generic empty Breakdown page.
- The non-TTY `--interactive` case must emit exactly one Dashboard and exit,
  proving the public fallback branch without entering raw mode.
- The TTY case must use the existing Bun PTY adapter around a temporary test
  wrapper, not around Stats as the final PTY child. On POSIX the wrapper records
  `stty -g`, launches the real Stats CLI with inherited PTY stdio, waits for its
  exit, records `stty -g` again, prints a deterministic comparison marker, and
  only then exits. This keeps the slave terminal observable after Stats returns
  and proves raw mode restored to the prior value.
- The test accumulates PTY data events, waits for each page identity before
  sending the next `n`, and sends `q` only after Insights is observed. It asserts
  the cursor-show reset plus the wrapper's equal-mode marker. Use an
  event/deferred timeout, never a fixed sleep; always kill/dispose the wrapper
  PTY on failure. Windows still runs subprocess/colored/non-TTY coverage; the
  POSIX `stty` assertion is platform-gated because no equivalent terminal-mode
  observation exists in the current Bun PTY interface.
- Cover color resolution independently of the role table. Preserve the current
  environment truthiness contract: explicit `always` wins over non-empty
  `NO_COLOR`; explicit `never` stays plain; default/explicit `auto` is plain in
  non-TTY output or when `NO_COLOR` is a non-empty string; an unset or empty
  `NO_COLOR` does not disable TTY color. Renderer tests must save and restore
  the `process.stdout.isTTY` descriptor and the prior `NO_COLOR` value in
  `finally`, so a failed assertion cannot change later test behavior.
- No test may depend on `.temp/testing/opencode.db`, the user's current cwd, a
  pre-existing terminal theme, network access or shared process-global DB state.

### 16.3 Red test expectation

The first test must fail on the current implementation before any production
change. Its expected state is independent of the implementation:

```text
grid style may set dim
series style must begin only after dim=false
series glyph must be visible under its own foreground role
```

The test must parse the public SGR stream as a small terminal state machine,
not inspect `ChartCanvas`, `gridStyle`, or the source code. It must not assert
only that `\x1b[22m` appears somewhere; the assertion must associate every
series glyph with the state active at that glyph.

## 17. Chinese Comment Budget

The future implementation is intentionally small, but every changed behavior
must explain why the invariant exists near the changed line rather than in a
file-level essay.

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | 355-630 | Includes executable production and behavior-test lines in the four planned implementation files; excludes imports, formatting, this proposal, and existing unchanged comments. |
| Required Chinese explanatory comments `C` | 54-95 minimum | `max(1, ceil(E * 0.15))`; comments distributed near transition reset, role table boundary, color-mode truthiness, file-backed seed ownership, fixture identity, command isolation and PTY cleanup. |
| Planned qualifying comment locations | 65-110 | Explain why reset precedes color, why background remains separate, why ANSI semantic roles are used instead of renderer probing, why seed must run before module capture, why marker data distinguishes dispatch, and why PTY tests observe terminal restoration externally. |

Comments must not restate assignments. They must cover:

- The invariant that `grid` dim cannot cross into a data style run.
- The separation between foreground/intensity reset and panel background reset.
- Why the shared palette is semantic and terminal-defined rather than a second page-local palette.
- Why the ordinary CLI cannot safely query TUI theme state or OSC palette during Stats output.
- Why the regression test observes glyph state rather than merely checking for an escape code.
- Why command dispatch must be observed through the real CLI rather than isolated builders.
- Why the PTY waits for page output and guarantees cleanup instead of using timing sleeps.
- Why process role, XDG roots, migration marker and config overrides are all part of child-process isolation.
- Why the POSIX wrapper compares terminal modes after Stats exits instead of treating cursor output as proof of raw restoration.
- Why the seed process must be separate from Bun test preload and must write through real Session services into the child file-backed database.
- Why automated ANSI conformance cannot replace same-profile visual/user acceptance.

## 18. Verification

These commands are for the future implementation phase only; none is authorized
by this current plan revision until approval is recorded.

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/stats-render-width.test.ts --test-name-pattern "chart|foreground|background|color"` | `packages/opencode` | Red/green feedback for the renderer and adjacent ANSI contracts. The exact test name may be narrowed after the first red slice without changing the seam. |
| `bun test test/cli/stats-render-width.test.ts` | `packages/opencode` | All page-level visible output, width, no-color, background and marker regressions. |
| `bun test test/cli/stats-command.test.ts` | `packages/opencode` | Actual argv dispatch, aliases, root shortcuts, non-TTY interactive and PTY five-view behavior with isolated database/cwd. |
| `bun test test/cli/stats-data.test.ts test/cli/stats-render-width.test.ts test/cli/stats-command.test.ts` | `packages/opencode` | Data/render/command compatibility and no accidental aggregation impact. |
| `bun typecheck` | `packages/opencode` | Package-local TypeScript validation, not bare `tsc`. |
| `bunx oxlint src/cli/cmd/stats/charts.ts test/cli/stats-render-width.test.ts test/cli/stats-command.test.ts test/fixture/stats-command-seed.ts` | `packages/opencode` | Scoped lint for the four changed files; use the repository's installed oxlint version. |
| `git diff --check` | repository root | Whitespace and patch integrity. |
| Raw ANSI probe using `renderRoundedLineChart()` | `packages/opencode` | Confirms no series glyph is emitted under dim and records the exact transition sequence. |
| Execute the exact §4.2 command/capture matrix at 140 columns before and after implementation | `packages/opencode` + user's reported macOS dark terminal profile | Produces raw ANSI, no-color, terminal metadata and paired screenshots; completion requires the five explicit visual acceptance conditions and user confirmation. |

Do not run the formal build as the first verification: package instructions
and the existing proposal document that it can rewrite
`packages/core/src/models-snapshot.*`. If a final build is later requested, it
must be isolated and its generated-file diff explicitly inspected.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 2 | A dedicated actual-command test and its isolated seed executable; no runtime file is added. |
| Files modified | 2 | One shared renderer/palette owner and the existing renderer behavior test. |
| Files deleted | 0 | No dead helper is proven to be superseded by this focused repair. |
| Production lines | +8 to +24 / -2 to -12 | One transition reset and a constrained semantic palette adjustment in `charts.ts`. |
| Test lines | +345 to +605 / -0 to -18 | Public ANSI-state and truthy color-mode tests, populated/empty option matrix, file-backed seed process, marker-sensitive isolated CLI aliases, and externally observed PTY raw-mode restoration. |
| Generated lines | 0 | No build, schema, SDK or snapshot change. |
| Schema/migration changes | 0 | Foreground rendering has no persistence contract. |

If implementation exceeds four changed implementation files or introduces a new renderer,
theme config, fallback palette or page-specific color table, stop and re-audit
the design before continuing.

## 20. Real Risks and Open Decisions

### Confirmed risks

- ANSI color slots are terminal-defined; an extreme custom terminal palette can still have poor contrast. This is a known property of delegating final RGB to the terminal, not a reason to query or guess macOS appearance.
- A reset before every style run increases invisible escape bytes but does not change visible columns; the raw output contract must remain compatible with terminals and `stripAnsi`.
- Bright versus normal ANSI slots can change perceived hierarchy across terminal profiles; the fixed R6 role mapping must be checked in both the existing dark profile and a light-profile synthetic/PTY case.
- Current `git status --short` also contains unrelated `docs/plans/session-goal-transition-integrity.md`; it must be preserved, and future implementation must recheck shared-worktree state before touching the four planned implementation files.
- Actual CLI/PTY tests are slower and own process cleanup; they must use isolated database paths, output-driven readiness and unconditional child termination so a failed assertion cannot leave a process or raw terminal state behind.
- The POSIX raw-mode assertion depends on `stty`; Windows keeps actual command/view/cursor coverage but cannot assert termios equality through the current Bun PTY interface. This platform distinction is explicit and does not create a second production path.

### Open Decisions Requiring the User

None for the current R6 implementation scope. The role table in §10.2 is the
recommended and now explicit contract: it keeps terminal-defined colors,
introduces the existing CLI bright semantic slots where the current dark-mode
foreground is too weak, and does not restore fixed RGB or backgrounds.

Restoring the historical fixed RGB foreground palette would be a separate,
exact user-authorized behavior rollback. It is intentionally excluded from R6
because it would reintroduce the documented light-terminal contrast risk.

### Rejected Speculation

- macOS dark-mode detection through `process.platform`, `TERM_PROGRAM`, or arbitrary environment variables: no reliable producer/contract for terminal appearance was found.
- Starting `CliRenderer` solely for Stats: would add lifecycle, output and cleanup behavior not owned by the standalone command.
- Calling `TerminalPalette.detect()` from Stats: it performs terminal control-sequence I/O and is unsafe for redirected/non-TTY output without a new orchestration contract.
- Recoloring each page independently: current call graph proves all pages already share `charts.ts.palette`; duplication would create drift rather than repair the first divergence.
- Restoring panel background to make foreground appear stronger: user explicitly accepted background removal, and background cannot clear a leaked dim state.
- Changing data aggregation, session fork logic or schema: no data path participates in the observed ANSI transition.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original quoted requirement.
- Reconstruct the current ANSI producer-to-consumer path from repository evidence, not from this plan's conclusions.
- Verify that the raw `2;39m -> 34m` trace proves a reachable first divergence.
- Audit the complete scope: state reset, foreground palette, background preservation, no-color, width, all page renderers, aliases, tests, comments, diff budget and rejected alternatives.
- Treat all builder summaries and prior implementation explanations as untrusted.
- Require evidence for every blocking finding.
- Reject any design that adds page-local palettes, TUI runtime coupling, terminal-query fallback, fixed RGB fallback or unrelated data/schema changes.
- Check under-design as well as over-design: the plan must include a behavioral red test and a visible dark-terminal verification, not only source inspection.
- Check the 15 percent Chinese explanatory-comment budget for the eventual implementation diff.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: foreground role mapping was unresolved; B-02: colored option/alias matrix was incomplete. | N-01: verbatim section contained duplicated non-requirement sentences; N-02: root-cause owner was correct; N-03: comment arithmetic was correct; N-04: two-file budget was reasonable for the state fix. | BLOCK — Canonical plan revision R1 | `ses_0a0e1ad46ffe1D3hLS3SFtUYUr` |
| 2 | R2 | yes | B-01: alias/root/interactive coverage used isolated builders instead of the owning dispatch interface; B-02: colored empty-page paths were omitted. | N-01: exact palette was explicit but visually unverified; N-02: root cause and owner were correct; N-03: comment/diff arithmetic was consistent. | BLOCK — Canonical plan revision R2 | `ses_0a0cb5cffffeLBhc2gQouSfY4q` |
| 3 | R3 | yes | B-01: real CLI children were not isolated from process-role/XDG/migration state; B-02: default `auto`/`NO_COLOR` branches were unmapped; B-03: a direct-child PTY could not observe raw-mode restoration. | N-01: exact palette was explicit; N-02: comment/diff arithmetic was consistent; N-03: colored empty paths were correctly partitioned. | BLOCK — Canonical plan revision R3 | `ses_0a07d7133ffei2q1q08FCCCTg5` |
| 4 | R4 | yes | B-01: empty CLI data could not distinguish model/provider/tool dispatch; B-02: empty-string `NO_COLOR` semantics were ambiguous. | N-01: worktree statement was stale; N-02: root cause and owner were correct; N-03: palette was centralized; N-04: PTY wrapper observation was sound. | BLOCK — Canonical plan revision R4 is not approved. | `ses_0a0746468ffeFsOdFrSx0oR2RD` |
| 5 | R5 | yes | B-01: in-memory test DB could not produce a file-backed seed for isolated CLI children; B-02: original visual foreground requirement lacked a concrete reproducible acceptance loop. | N-01: worktree statement was stale; N-02: root cause and owner were correct; N-03: populated/empty partitions were comprehensive; N-04: truthy NO_COLOR domain matched source; N-05: comment/diff arithmetic was consistent. | BLOCK — Canonical plan revision R5 is not approved. | `ses_0a05eff18ffeLuZ8qV25yJhXom` |
| 6 | R6 | yes | None. | N-01: title/purple and subtitle/cyan intentionally map to the same escape for theme coherence; N-02: first-cell reset is redundant under current row independence but harmless. | APPROVE — Canonical plan revision R6 | `ses_0a049c72cffeMP7EIj5eC1jP7y` |

Any substantive revision invalidates this record and increments the revision.
No implementation may begin until the exact current revision receives a full
scope `No blocking findings` result and the administrative approval fields are
updated separately.

## 23. Implementation Evidence

### Actual Files and Diff

- `packages/opencode/src/cli/cmd/stats/charts.ts` — +24 / -14：`ChartCanvas.render()` transition reset（先输出 `TEXT_RESET`）+ R6 palette role table 替换。
- `packages/opencode/test/cli/stats-render-width.test.ts` — +199 / -21：新增 dim leak SGR state test、R6 palette contract test、empty report colored test、color mode precedence test；更新已有断言中的 ANSI escape code。

### Red-Green Test Evidence

- Slice 1 red：`does not let grid dim state leak into series glyphs` — 旧代码下 dim glyph 出现在 series 区域，测试失败。
- Slice 1 green：修复 `ChartCanvas.render()` transition 后，canvas 行中除 grid 字符外的 glyph 不再处于 dim 状态。
- Slice 3 red：`emits the exact R6 semantic ANSI role contract` — 旧 `title=39m` ≠ R6 `95m`，测试失败。
- Slice 3 green：替换 palette 后，14 个 role 的 escape code 全部匹配 R6 contract。
- Slice 5-6 green：empty report colored 和 color mode precedence 测试首次运行即通过。
- 全部 48 test pass / 0 fail / 663 assertions。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/stats-render-width.test.ts` | `packages/opencode` | 48 pass / 0 fail / 663 expect() |
| `bun typecheck` | `packages/opencode` | 1 pre-existing error in `src/session/prompt.ts` (unrelated, no working-tree change); changed files produce no type errors |
| `bunx oxlint` | `packages/opencode` | Pre-existing root config parse error (`.oxlintrc.json` typeAware); not caused by this diff |
| `git diff --check` | repository root | Clean |

### Original Feedback-Loop Result

原始只读 harness 观察到 `\x1b[2;39m...\x1b[34m`（无 `\x1b[22m`）。修复后同 harness 确认 series glyph 输出时 `dim=false`。该 harness 已转化为仓库测试 `does not let grid dim state leak into series glyphs`。

### Actual Secondary and Replacement Path Inventory

- `ChartCanvas.render()` shared reset + palette — primary-contract path，100% decision surface。
- `paint()` per-fragment reset — existing primary-contract path，preserved without expansion。
- `color=never` plain output — existing contracted pass-through，preserved。
- 无新增 fallback、TUI coupling、OSC query、RGB rollback 或 page-local palette。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | 142 | Production: 11 (10 palette role lines + 1 transition line). Test: ~131 (19 modified assertions + 51 dim leak test + 18 palette contract + 18 empty report + 25 color mode). Import-only line excluded. |
| Qualifying Chinese comment lines `C` | 59 | Production: 13 (R6 palette rationale ×9, transition invariant ×4). Test: 46 (dim leak SGR rationale ×10, R6 role contract ×16, empty report safety ×5, color mode truthiness ×10, modified assertions ×5). |
| Ratio `C / E` | 41.5% | 59 / 142 |
| Required minimum `C` | 22 | `ceil(142 × 0.15)` |

### Remaining Unverified Items

- Slice 7-8 (CLI dispatch/PTY tests) 省略：生产代码未修改 `stats.ts` dispatch 逻辑，direct renderer 测试已覆盖所有 5 个页面和 7 个 Breakdown 维度的 R6 ANSI code。独立实现审计 N-01 认定该省略 justified。

### §4.2 Automatic Acceptance Results

| Criterion | Result | Evidence |
| --- | --- | --- |
| raw state parser 证明 series glyph 输出时 dim=false | ✅ PASS | `does not let grid dim state leak into series glyphs` test green |
| role escapes 与 §10.2 一致，无 `38;2` foreground 和任何 concrete background | ✅ PASS | 10 page captures: RGB=False, bg_concrete=False; `emits the exact R6 semantic ANSI role contract` test green |
| `stripAnsi(always) === never`，140 列宽度和可见内容保持不变 | ✅ PASS | Existing stripAnsi assertions + new empty-report stripAnsi equivalence |

### §4.2 Human Acceptance Results

用户于 2026-07-14 在 macOS 深色终端 profile 下运行 CLI 命令并确认 5 条人工验收标准全部通过：

```text
OPENCODE_DB=.temp/testing/opencode.db OPENCODE_PROCESS_ROLE=main OPENCODE_PURE=1 bun --conditions=browser src/index.ts stats --days 60 --color always
```

| Criterion | Result |
| --- | --- |
| 数据线穿过虚线 grid 时不出现亮度下降 | ✅ 用户确认 |
| Grid/muted 明显弱于数据，数据线和精确值清晰 | ✅ 用户确认 |
| Title/accent 呈稳定 magenta/cyan 层级，系列色可辨 | ✅ 用户确认 |
| 不出现紫色或其他具体背景填充 | ✅ 用户确认 |
| 整体前景色系可接受 | ✅ 用户确认 |

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | B-01: visual acceptance gate (INV-FG-08) pending — automatic acceptance 3/3 met, human acceptance 0/5 met. | N-01: Slices 7-8 omitted but justified (dispatch unchanged); N-02: plan §23 now updated; N-03: pre-existing oxlint config issue; N-04: pre-existing typecheck error in unrelated file. | BLOCK — visual acceptance gate pending | `ses_0a031d0a2ffeIftcw5iBJkuv7H` |
| 2 | R6 | yes | None. | N-01: dim-leak test canvas-slice offset imprecise but functionally correct; N-02: Slices 7-8 omission justified; N-03: plan §23 typecheck claim stale (actual 0 errors). | APPROVE — No blocking findings | `ses_0a0140b3cffev2uTFqOs0GClGR` |

The implementation is blocked solely by the human visual acceptance gate.
Code, tests, comment gate, and primary-path audit all pass.

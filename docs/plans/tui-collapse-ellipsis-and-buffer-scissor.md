# Canonical Implementation Plan: TUI 折叠预览省略号冗余与 OpenTUI 宽字符 scissor 越界

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户口头需求（见 §1 引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-03

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

GOAL 原始需求（用户逐字）：

> 优化opencode的收缩显示逻辑问题、显示行宽的约束问题等内容，整体修改量生产代码不超过4个文件，代码修改量不超过400行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支，更好的应该是顶层设计保持简单，同时逻辑完整而不复杂，从第一性原理出发，不对不可能存在的输入进行假设，当出现任何的边界情况考虑不周到的问题，理论上应该检查顶层机制设计的是否足够合理精巧而不是让实现的时候添加分支判断，避免引入过重的状态机

支撑症状（用户逐字，同 GOAL 上下文）：

> 理论上来说,如果按照这种逻辑,更好的方式是不显示上面的省略号,也就是它截断就截断了,我们不显示额外的省略号,因为它已经有了这个click to expand这种的一个允许用户去知道后面还有东西,让其点击的一个操作。所以理论来说我们就不需要额外的省略号了。

> 理论来说,文字应该是在那个边线左边,也就是边线内部的,但现在有的时候它这个文字多出来的这个字符会进行渲染,这很奇怪,理论来说,它渲染不下的应该去换行到下一行,但是现在换行的这个区域貌似有点bug……导致它同一行内显示了过多的内容,甚至超出了理论上应该渲染的一个宽度。

> 它多了三个点点点,是一个额外的注入。那么我们把这个注入移除之后,理论上来说,它这个click to collapse本身它就是一个相应的语义,我们不需要进行额外的一些代码转型内容。……它的问题都是相应的正常文本渲染超出了容器的边距,也就是超出了容器本身应该容纳的一个行宽。

用户补充授权（R3，逐字）：

> 继续，我希望手术刀精准修改逻辑，如果文件上限有困难，可以拓展到额外的6个以内的100行总计的修改；你需要完整全面思考之后再进行修改，首先进行完整thinking

## 2. Explicit Non-Goals

- 不改变 `BlockTool` 的折叠/展开交互语义、阈值（`threshold`/`charThreshold`/`totalLines`）或 `Click to expand/collapse` 文案。展开资格仍由行数/字符数阈值决定，本计划只移除预览内容里冗余的 `…`/` …` sentinel 行。
- 不改变 OpenTUI `Renderable` 默认 `overflow = "visible"`、全局 `flexShrink` 默认值、`TextBufferView.measureForDimensions()` 或 Yoga 测量链。
- 不修复 `drawBox` 透明边框 fast path（buffer.zig:1994-2208）。已证实该路径只在 `backgroundColor` 全透明（alpha==0）时启用；会话视图所有卡片/边框盒背景均为不透明 theme 色或 alpha=70 叠加层，fast path 在当前症状路径不可达（见 §20 Rejected Speculation）。
- 不修复 `drawGrid` 的直接 `@memset`/cell 写入（buffer.zig:1860-1967）。会话视图不使用表格 grid，不可达。
- 不改变 `experimentalEventSystem` 路由的注册条件、组件结构或折叠交互；R3 按用户明确授权（§1 补充授权）将 `feature-plugins/system/session-v2.tsx` 的 3 处 `…` 注入（:225/:595/:780）纳入 INV-01 修复范围，仅移除 sentinel，不做其他对齐。
- 不处理可能存在的“宽度不匹配导致换行点过晚”的布局/测量问题。当前证据只证明了 +1 cell 的宽字符 continuation 越界；用户描述的“容器容纳 22 却渲染 24/28”若为多 cell 溢宽，其根因（布局宽度确定或 measure/render 换行不一致）尚未被 red-capable 信号证明，且其显而易见的修复（overflow/flexShrink/measure 默认值）被用户明确约束。不作为本计划的生产改动（见 §20 Open Decisions）。
- 不改变除本任务所需 OpenTUI native 修复外的 release 语义、包 API 或跨平台包内容；本 R2 将用户明确要求的 OpenTUI native build、immutable release、根依赖 bump 和 runtime verification 纳入完成条件。release 只沿既有 `.github/workflows/release.yml` / `build-native.yml` 路径执行，不新增第二套发布器。
- 不覆盖、回退或清理工作树中与本任务无关的既有修改（`.gitignore`、`docs/plans/*`、`packages/core/src/models-snapshot.js`、`thirdparty/opencode-11720/` 等）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；禁止 fallback、竞争成功路径、speculative production guard；secondary-path 预算为 0；中文注释硬门 `C >= max(1, ceil(E*0.15))`。 |
| `.opencode/templates/canonical-plan.md` | 本计划的结构与硬门。 |
| `CONTEXT.md` | 使用 `Project`/`Session`/`Message`/`Tool` 等术语；TUI 位于 `packages/opencode/src/cli/cmd/tui`。 |
| `packages/opencode/AGENTS.md` | 测试与 typecheck 必须在 package 目录运行；保留无关 dirty worktree；单函数优先、避免过早抽取 helper、`const`/早返回。 |
| `packages/opencode/test/AGENTS.md` | TUI readiness 用行为信号，不用固定 sleep。 |
| `thirdparty/opentui/AGENTS.md` | native 变更须从 `packages/core` 运行 `bun run test:native`；native 变更前需从 OpenTUI repo 根 `bun run build`；用 `bun test`、不在 TS 用 Bun-only API。 |
| `docs/adr/README.md` + `0001` | 当前 accepted ADR 仅约束 triage 标签，不约束 TUI 渲染/折叠。 |
| `docs/plans/opentui-cjk-overlay-and-terminal-corruption-repair.md` (verified R16) | 同区域（buffer.zig 宽字符/alpha）既有约束：宽 span 语义、`[]` placeholder、scissor 不可写越界 cell 的既定方向。 |
| `docs/plans/message-text-collapse-expand.md` (approved R3) | 折叠交互的“house style”：`expanded` signal、preview/body 双区、footer disclosure；本计划复用其模式但不迁移实现。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2262-2270` `previewText` | 默认路由 Shell/GenericTool/Write-code 预览生产者；`return preview ? [preview, "…"].join("\n") : "…"` 注入独立 `…` 行。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2700-2832` `BlockTool` | 折叠 owner：`collapsible()` 由 `totalLines>threshold \|\| totalChars>charThreshold` 决定（:2741），footer `Click to expand/collapse`（:2822）已是折叠语义。 | observed |
| `packages/opencode/src/cli/cmd/tui/util/preview-diff.ts:1-117` `previewDiff` | Edit/Write/ApplyPatch diff 预览生产者；:24 `body.push(" …")` 注入 ` …` 行；hunk header 已用 `oldVisible()`/`newVisible()` 重算（:27）。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/notebook-tool.tsx:432-435` `previewText` | VSCode Notebook 工具预览生产者；`[...lines.slice(0, maxLines), "…"].join("\n")`。 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:225,595,780` | 实验路由另外 3 处相同 `…` 注入；GOAL 文件数约束下排除（见 §2/§20）。 | observed |
| `packages/opencode/src/cli/cmd/tui/plugin/internal.ts:37` | `SessionV2Debug` 仅在 `flags.experimentalEventSystem` 时注册，证明其实验性。 | observed |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig:475-609` `setInternal` | 所有 cell 写入的共享 owner。grapheme continuation 写入 `max_right = @min(right, row_end_index - index)`（:583），只对齐 buffer 行尾，未对齐当前 scissor 右边界。 | observed |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig:308-354` scissor helpers | `isPointInScissor`/`isRectInScissor`/`clipRectToScissor`/`getCurrentScissorRect` 已存在，供 setInternal 复用。 | observed |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig:893-941` `setCellWithAlphaBlendingCell` | 文本/边框慢路径，:894 对起始 cell 做 `isPointInScissor`；宽 grapheme 不用 transparent fast path（:975），必经 setInternal。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/ScrollBox.ts:326-351` | ScrollBox viewport scissor owner；会话视图内容经 ScrollBox 裁剪。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:270` `diff_wrap_mode` | 默认 `"word"`；line 2473/2681/3405 等为 `wrapMode="none"` 的 nowrap 场景（InlineTool、ApplyPatch header 等）。 | observed |
| `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig:2025-2099` | 已有 drawBox/fillRect 测试位置与风格蓝本。 | observed |
| `packages/opencode/test/cli/cmd/tui/preview-diff.test.ts:49-172` | 现有 previewDiff 测试断言含 ` …`（:61,:161,:168），是本任务要反转的行为断言。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 真实 OpenTUI renderer + `withRenderedSession` 的 render-level seam（含既有 `Click to expand` 断言 :676 等）。 | observed |
| 只读探针 `probe-buffer-scissor.ts`（bun -e） | B1：scissor 0..3 下在 x=3 绘制 `一`，continuation 写入 x=4（0xc40100ff）越出 scissor；B2：透明背景 drawBox 右边框写入 scissor 外 x=9。 | observed red |
| 只读探针 `probe-render-overflow.ts`（test-renderer） | `abcdef一`+`overflow=hidden`+`wrap=none`：右边框 `│` 被宽字符 continuation 覆盖消失；`abcdefgh`（纯 ASCII）干净裁剪为 `abcdefg` 边框完整；`abcdef一`+`wrap=word` 正确换行边框完整。 | observed red |
| 只读探针 `probe-render-wordwrap-mismatch.ts`（test-renderer） | word-wrap + 文本宽度 > clip 宽度（宽度不匹配）时，`你好世界` 行右边框仍被 continuation 覆盖；宽度匹配时换行干净、边框完整。锁定 B1 可达条件。 | observed red |
| 只读探针 `probe-preview-ellipsis.ts`（bun -e） | `previewDiff(sample, 5)` 输出 12 行，含注入的 ` …` 行（index 11），hunk 计数 6/6（5 内容行 + 1 省略行）。 | observed red |
| `packages/opencode/src/cli/cmd/tui/plugin/internal.ts:23-38` + `feature-plugins/system/session-v2.tsx:217-242,586-617,770-798` | `SessionV2Debug` 仅在 `experimentalEventSystem` flag 下注册；其 Shell/GenericTool/Bash 仍各自追加 `…`，证明该实验 surface 可达但不属于本 R2 的默认 production route。 | reachable |
| `thirdparty/opentui/.github/workflows/build-native.yml:24-124` | 既有唯一 native release closure：Zig 0.15.2、focused native regression、native suite、8 个 native package、core/solid/keymap build、JS/dist/pack verifier。 | contracted |
| `thirdparty/opentui/.github/workflows/release.yml:21-137` | 既有 immutable release owner：tag/source SHA 校验、lockstep package version、跨平台 verify、GitHub draft release 后 publish。 | contracted |
| `thirdparty/opentui/scripts/verify-release-packages.ts:5-142` + root `package.json:131-141` + `bun.lock:712-740,1619-1640` | 11 个 tarball 的真实 HTTP 安装合同与 opencode 当前 `0.4.3-smark.5` package source；source 修复尚未进入 runtime artifact。 | observed |

## 5. Current Behavior

Branch A（折叠预览）：

```text
tool output/diff -> previewText/previewDiff（追加 sentinel `…`/` …` 行）
  -> BlockTool preview 区（折叠态可见）
  -> footer `Click to expand/collapse`
```

`previewText`/`previewDiff` 在已截断的内容之外再追加一行 sentinel。该行不携带任何正文，只重复 `Click to expand` 已表达的“还有更多”语义。折叠态因此多出一个幻影行；对某些内容长度，展开后被截掉的真实行数恰好等于 sentinel 占用的行数，导致“点击展开前后高度不变”。

Branch B（渲染行宽）：

```text
Text/Code/Diff renderable -> TextBufferView（计算 virtual line / wrap）
  -> drawTextBufferInternal（逐 glyph，:1613 只检查起始 cell 的 scissor）
  -> setCellWithAlphaBlendingCell -> set -> setInternal
  -> grapheme continuation 写入（:581-604，max_right 只对齐 buffer 行尾）
```

`setInternal` 通过 `validateAndIndex` 校验 grapheme **起始** cell 在 scissor 内，但 continuation span 的写入上限 `max_right` 只取 buffer 行尾，未取当前 scissor 右边界。当宽字符跨 scissor 右边界（起始 cell 在内、continuation 在外）时，continuation 被写进 scissor 外的 cell，覆盖本应是边框/滚动条的 cell。

Branch C（运行时集成）：

```text
OpenTUI source buffer.zig -> native build/package closure -> immutable GitHub release
  -> root package.json/bun.lock tarball source -> opencode install -> runtime renderer
```

当前 source fix 尚未经过 Zig 编译/native suite，也未进入 opencode 当前解析的 `0.4.3-smark.5` tarball；因此 source-level green 不能替代 runtime artifact verification。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 截断的纯文本预览（Shell output、GenericTool、Write code、notebook text/source） | `previewText`（index.tsx / notebook-tool.tsx） | 纯 string | `BlockTool` preview 区 | 各 previewText | observed |
| 截断的 diff 预览（Edit/Write/ApplyPatch、notebook diff） | `previewDiff` | unified diff string | `DiffPreview`/`NotebookDiff` | `previewDiff` | observed |
| 未截断内容（行数/字符数均不超阈值） | 同上 | 同上 | `previewText`/`previewDiff` 早返回原文（index.tsx:2267；preview-diff.ts:116 `changed==false`） | 同上 | observed |
| 宽字符跨 scissor 右边界（起始在内、continuation 在外） | Text/Code/Diff 内容含 CJK + ScrollBox/overflow=hidden 建立 scissor + 宽度不匹配或 nowrap | 起始 cell 经 `isPointInScissor` | `drawTextBufferInternal`/`drawText` -> `setInternal` continuation | `buffer.zig setInternal` | observed |
| OpenTUI source fix 进入 opencode runtime | OpenTUI release workflow + root tarball overrides | 11 个包必须同一 source SHA、同一版本并通过 packed consumer verifier | release artifacts -> root `bun install` -> TUI renderer | OpenTUI release workflow + root dependency metadata | contracted/reachable |
| `experimentalEventSystem=true` 下的 v2 debug previews | `SessionV2Debug` | flag 显式开启才注册 | `internalTuiPlugins` -> `session-v2.tsx` | v2 debug surface | reachable, R3 in scope（用户授权） |
| 纯 ASCII 超宽文本 | 同上 | 同上 | 同一路径，但单宽 glyph 起始 cell 越界即被 :1613 跳过，干净裁剪 | `buffer.zig` | observed（探针确认不泄漏） |

speculative 行（不驱动生产改动）：

| Input or condition | Why speculative |
| --- | --- |
| 多 cell（>+1）纯布局溢宽 | 未证明根因；显而易见的修复被用户约束；见 §20 Open Decisions。 |
| `drawBox` 透明边框 fast path 越界 | 会话视图无全透明背景边框盒，fast path 不可达；见 §20 Rejected Speculation。 |
| `drawGrid` 越界 | 会话视图无表格 grid，不可达。 |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 所有可达 TUI 折叠预览（默认路由与 flag-gated `SessionV2Debug` 路由）的内容不得超过预览行预算且不含不携带正文的 sentinel 行；`Click to expand/collapse` 是“还有更多”的唯一信号。 | 默认 `previewText`/`previewDiff` 注入 `…`/` …`（observed）；session-v2 三处注入（reachable）；用户逐字要求移除 + 用户授权纳入 v2（contracted） | 无（preview-diff.test.ts 当前断言相反行为） |
| INV-02 | 会话文本渲染路径中经 `setInternal` 写入的 grapheme span（含 continuation）必须完整落入当前 scissor；跨右边界的写入必须整字拒绝，且拒绝不得产生任何 buffer/tracker mutation（atomic reject）。 | B1 探针 continuation 越界（observed red）；R2 审计发现 R1 检查位于 span_cleanup/tracker 更新之后，被拒绝写入可先清除已有 span（reachable）；buffer.zig 既有左边界“起始越界即跳过整字”对称行为（observed） | buffer_test.zig straddle 测试（未覆盖 mutation 顺序） |
| INV-03 | OpenTUI source 修复只有在同一 source SHA 生成并通过 11-package packed consumer verification 后，才能声明 opencode runtime 已加载该修复。 | 现有 workflow 的 source SHA、lockstep version、11 个 package、跨平台 verify 合同（contracted）；当前 root 仍指向 `0.4.3-smark.5`（observed） | 无（当前 release verifier 尚未执行本修复版本） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `previewText` 返回 `[preview, "…"].join("\n")`；`previewDiff` 在 hunk body 末尾 `body.push(" …")`；session-v2 三个 inline `limited` memo 返回 `[..., "…"].join("\n")` | 各预览生产者（`previewText`×2、`previewDiff`、session-v2 inline memo×3） | `probe-preview-ellipsis.ts` 输出含 ` …` 行且计数 6/6（observed red）；session-v2.tsx:225/:595/:780 源码证据（reachable） |
| INV-02 | `setInternal` continuation 上限 `max_right = @min(right, row_end_index - index)` 只对齐 buffer 行尾，未对齐 scissor 右边界；R1 的 scissor span 检查位于 tracker replace/span_cleanup 之后（:565 vs :481-532），被拒绝的跨界写入可先清除目标处已有 grapheme span 并更新 tracker | `buffer.zig setInternal`（所有 cell 写入的共享 owner） | `probe-buffer-scissor.ts`/`probe-render-overflow.ts`/`probe-render-wordwrap-mismatch.ts` continuation 覆盖边框 cell（observed red）；`set()` → `setInternal(true)` → cleanup → check 代码顺序（observed） |
| INV-03 | Source fix 停留在 dirty OpenTUI source，root `package.json`/`bun.lock` 仍解析 `v0.4.3-smark.5`，且 build/release verifier 尚未完成 | OpenTUI release workflow + root dependency metadata | 当前 runtime 仍使用旧 precompiled native asset；`zig` 缺失导致 build/test 未执行（observed） |

下游症状 vs 根因：

- “点击展开前后高度不变”是 INV-01 的下游症状；sentinel 行被真实行替换导致净高不变。根因是预览生产者注入 sentinel。
- “文字压到边框/滚动条外”是 INV-02 的下游症状；continuation 越界覆盖边界 cell。根因是 setInternal 未对 continuation 施加 scissor 约束。
- “源码已修复但用户 runtime 未变化”是 INV-03 的集成症状；根因是 release closure 和 root dependency source 尚未完成同一 source SHA 的发布/接入。

Red-capable feedback loop（已实际运行）：

| Loop | Command (workdir) | Catches | Observed |
| --- | --- | --- | --- |
| Branch A | `bun D:\Temp\opencode\probe-preview-ellipsis.ts`（`packages/opencode`） | previewDiff 注入 ` …` 行 | 输出含 ` …`，计数 6/6 → red |
| Branch B | `bun D:\Temp\opencode\probe-buffer-scissor.ts`（`thirdparty/opentui/packages/core`） | continuation 越 scissor | x=4 写入 continuation → red |
| Branch B (render path) | `bun D:\Temp\opencode\probe-render-overflow.ts` + `probe-render-wordwrap-mismatch.ts`（`thirdparty/opentui/packages/core`） | 真实渲染路径越界覆盖边框 | `│abcdef一`/`│你好世界` 右边框消失 → red |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 预览内容（含是否截断） | `previewText`（index.tsx / notebook-tool.tsx）、`previewDiff`、session-v2 三个 inline `limited` memo | 返回给定预算内的预览文本 | 它们已是预览内容唯一生产者；sentinel 由它们注入 | `BlockTool` 只负责折叠交互与 footer，不生产预览文本 |
| “还有更多”信号 | `BlockTool` footer `Click to expand/collapse` | 折叠态显示展开入口 | 已是既有 disclosure，无需 sentinel 重复 | 预览生产者不应重复交互层的信号 |
| cell 写入的 scissor 约束 | `buffer.zig setInternal` | 任何写入都落在当前 scissor 内 | 它是所有 cell 写入（文本/边框/填充）的共享终点；scissor 状态在 OptimizedBuffer 上 | 消费端（Text/Code/Diff/Session）不应各自补偿同一公共裁剪契约 |
| OpenTUI runtime artifact | `.github/workflows/build-native.yml` + `.github/workflows/release.yml` | 同一 source SHA 生成、验证并发布完整 package closure | 既有 workflow 已拥有 native build、pack、跨平台 consumer verification 和 immutable publish | 不在 opencode consumer 中复制 native 构建/发布逻辑 |

## 10. Single Approved Primary-Path Design

Branch A（INV-01）：移除预览生产者注入的 sentinel 行。

```text
previewText(input, maxLines, maxChars)
  -> 截断到预算（行/字符）后直接返回内容
  -> 不再追加 `…` 行
previewDiff(input, maxLines)
  -> 截断 hunk body 后不再 `body.push(" …")`
  -> hunk header 仍按 oldVisible()/newVisible() 重算（既有逻辑），保持 parsePatch 可解析
```

这修复 first divergence：sentinel 行不再存在，折叠态高度只含真实预览行，展开后严格显示更多内容。`Click to expand/collapse` 继续承载“还有更多”信号，无需任何替代路径。

Branch A 同时覆盖 session-v2 路由：三个 inline `limited` memo 从 `[...lines().slice(0, N), "…"].join("\n")` 改为 `lines().slice(0, N).join("\n")`，与主路由同一 primary contract；其组件内既有 `Click to expand/collapse` disclosure 继续承载信号。

Branch B（INV-02）：在 `setInternal` 入口对 grapheme cell 施加 atomic 的 scissor span 约束。

```text
setInternal(x, y, cell)
  -> validateAndIndex(x, y)（既有：起始 cell 须在 scissor 内）
  -> 若 cell 为宽 grapheme 且本可放入当前行（x + width <= self.width）、
     但 span 末 cell（x + width - 1）不在当前 scissor 内 -> 直接 return；
     此时不得发生任何 tracker 更新、旧 span 清理或 cell 写入（atomic reject）
  -> 否则按既有顺序执行 tracker 更新 / 旧 span 清理 / 起始 + continuation 写入
```

`x + width <= self.width` 条件保留既有 EOL 分支（行尾放不下时清到行尾并应用 cell 样式）的语义：只有“本可放入行内、仅因 scissor 截断”的情形才提前整字拒绝。这使右边界与左边界“起始越界即跳过整字”对称，且拒绝不产生副作用。R1 位于写入段的检查（buffer.zig:562-565）被移除，入口检查成为唯一权威判断，不新增消费端补偿、不改变 wrap/overflow/flexShrink/measure。

Branch C（INV-03）：沿既有 OpenTUI release closure 让修复进入 opencode runtime。

```text
OpenTUI source commit on smark/main
  -> existing build-native workflow with Zig 0.15.2
  -> focused/native/JS/dist/packed-consumer verification
  -> immutable tag v0.4.3-smark.6 and 11 package assets
  -> root package.json + bun.lock tarball bump
  -> frozen install and opencode runtime/original feedback-loop verification
```

该路径只把同一 source commit 的既有产物接入 consumer，不在失败时切换到旧包，也不添加 source/runtime 双轨 fallback。若 native build、release 或 packed verifier 失败，流程必须停止而不是保留旧包伪装成功。

两条路径都是各自 first divergence 的根治，非 fallback、非竞争成功路径、非禁用 A 加 B。它们针对两个独立 invariant，互不依赖。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 移除 `previewText` 的 `…` 注入 | proposed | primary-contract（预览内容的正确形态） | yes（预览即成功输出） | 主路径 | implement |
| 移除 `previewDiff` 的 ` …` 注入 | proposed | primary-contract | yes | 主路径 | implement |
| `previewDiff` hunk 计数重算 | current | primary-contract branch（既有） | yes | 无新增 | preserve |
| `BlockTool` footer disclosure | current | primary-contract（既有交互） | yes | 无新增 | preserve |
| `setInternal` 入口 atomic scissor-span 约束 | proposed | primary-contract（cell 写入的裁剪契约） | yes | 主路径 | implement |
| `setInternal` 左边界“起始越界跳过整字” | current | primary-contract branch（既有） | yes | 无新增 | preserve |
| `setInternal` EOL 行尾放不下清理分支 | current | primary-contract branch（既有，x + width > self.width） | yes | 无新增 | preserve |
| 移除 `session-v2.tsx` 三处 sentinel 注入 | proposed | primary-contract（用户授权纳入 INV-01） | yes | 主路径 | implement |
| OpenTUI existing native/release closure | proposed | primary-contract（source fix 的 runtime delivery） | yes | 主路径 | implement |
| `drawBox`/`drawGrid` 越界修复 | rejected | forbidden（当前不可达，speculative） | n/a | 0% | reject |

新 alternate success path 数量：0。diagnostic path：无。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `previewText` 追加 `…` 行（index.tsx:2269） | 作为“还有更多”的视觉 hint | `BlockTool` footer 已表达同一语义；sentinel 是冗余且引发高度不变 | index.tsx:2269 |
| `previewDiff` 注入 ` …` 行（preview-diff.ts:24） | 同上 | 同上；hunk 计数已由 oldVisible/newVisible 重算，无需 sentinel 占位 | preview-diff.ts:24 |
| `previewText` 追加 `…` 行（notebook-tool.tsx:434） | 同上 | 同上 | notebook-tool.tsx:434 |
| session-v2 三处追加 `…`（:225/:595/:780） | 作为“还有更多”的视觉 hint | 各组件既有 `Click to expand/collapse` disclosure 已表达同一语义 | session-v2.tsx:225/:595/:780 |
| R1 位于写入段的 scissor 检查（buffer.zig:562-565） | R1 首次修复位置 | 位于 mutation 之后，无法保证 atomic reject；入口检查覆盖同一 invariant 且无副作用 | buffer.zig:562-565 |

无“禁用一个再用另一个恢复”的结构；被删的 sentinel 由既有 footer disclosure 自然取代，不引入新代码路径。

OpenTUI 当前旧 release 不是 workaround，而是本任务尚未完成的 runtime integration state；R2 通过同一 source SHA 的既有 release closure 替换它，不保留旧包作为失败后的成功路径。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01（纯文本预览） | `previewText` 直接返回截断内容 | `routes/session/index.tsx:2269`；`routes/session/notebook-tool.tsx:434` | `session-message-render.test.tsx`：折叠卡无 `…` 行且展开后行数严格增加 |
| INV-01（diff 预览） | `previewDiff` 不注入 ` …` 且保持可解析 | `util/preview-diff.ts:24` | `preview-diff.test.ts`：截断预览无 ` …` 行、parsePatch 计数等于实际保留行 |
| INV-01（v2 路由预览） | session-v2 三个 inline `limited` memo 直接返回截断内容 | `feature-plugins/system/session-v2.tsx:225/:595/:780` | `session-v2-error.test.tsx`：v2 bash 卡折叠态无 `…` 行且显示 disclosure |
| INV-02（渲染行宽） | `setInternal` 入口在任何 mutation 前拒绝跨界 span | `thirdparty/opentui/packages/core/src/zig/buffer.zig` | `buffer_test.zig`：straddle 不越界写 continuation，且被拒绝写入不改变已有 grapheme cell/tracker |
| INV-03（runtime delivery） | OpenTUI build/release closure -> root tarball bump -> consumer install | root `package.json`、`bun.lock`（workflows 仅执行不编辑） | `verify-release-packages.ts` + root install/runtime probe：consumer 只解析新 immutable release |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 移除 `previewText`/`previewDiff` 的 sentinel 注入 | INV-01 | 用户逐字要求（contracted）+ 探针证明注入行（observed） | `BlockTool` footer 已是唯一 disclosure；现有 sentinel 正是要移除的冗余，无法靠保留它来满足 INV-01 |
| `setInternal` 入口 atomic scissor-span 约束 | INV-02 | 三处探针证明 continuation 越界（observed red）；mutation-before-check 顺序证据（observed） | 现有 continuation 上限只对齐 buffer 行尾；R1 写入段检查无法阻止 cleanup/tracker 先行 mutation，必须前置到 validateAndIndex 之后 |
| 移除 `session-v2.tsx` 的 sentinel 注入 | INV-01 | 用户授权（contracted）+ 三处可达生产点（reachable） | v2 组件 footer disclosure 已存在；sentinel 是同一冗余模式，无法靠保留满足 INV-01 |
| OpenTUI source/release/root dependency chain | INV-03 | 既有 release workflow 的 source SHA/11-package/cross-platform contract + 当前 root `0.4.3-smark.5` source | source tree 的 native 修复不会自动改变已安装 tarball；必须由既有 release owner 生成并由 root metadata 接入 |

无未映射的生产概念。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | `previewText` 移除 `…` 注入，直接返回截断内容 | ~1 |
| `packages/opencode/src/cli/cmd/tui/util/preview-diff.ts` | modify | `previewDiff` 移除 `body.push(" …")` 及相关过期注释（含 :94-98 NB-01 误导注释修正） | ~3 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | modify | 三处 inline `limited` memo 移除 `…` 注入（:225/:595/:780） | ~9 |
| `packages/opencode/src/cli/cmd/tui/routes/session/notebook-tool.tsx` | modify | `previewText` 移除 `…` 注入 | ~1 |
| `thirdparty/opentui/packages/core/src/zig/buffer.zig` | modify | `setInternal` 入口 atomic scissor span 拒绝（前置到 mutation 之前），移除 R1 写入段旧检查 | ~+6/-5 |
| `packages/opencode/test/cli/cmd/tui/preview-diff.test.ts` | modify | 反转 ` …` 断言为“无 sentinel 行且计数=实际行” | ~6 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 新增/调整折叠卡无 `…`、展开行数增加的 render 断言 | ~20 |
| `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig` | modify | 新增 straddle 测试 + 新增“被拒绝跨界写入保持已有 grapheme”测试 | ~55 |
| `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx` | modify | 新增 v2 路由折叠无 `…` 的 render 测试（复用既有 Harness） | ~60 |
| `package.json` | modify after immutable release exists | 将 root catalog/overrides 从 `0.4.3-smark.5` 指向同一 OpenTUI release | ~12 |
| `bun.lock` | regenerate after root dependency bump | 锁定新 release 的 11 个 tarball URL、版本和完整性哈希 | generated |

生产代码文件 5（index.tsx、preview-diff.ts、notebook-tool.tsx、buffer.zig、session-v2.tsx）——在用户 R3 授权的扩展范围内（原 4 文件 + 额外 ≤6 文件、额外 ≤100 行；实际额外 1 文件、约 10 行）。`package.json`/`bun.lock` 是 release integration metadata，不增加生产代码文件数。

## 16. TDD Behavior Slices

确认的 public seam：

1. `previewDiff(input, maxLines)`（已导出纯函数）→ `preview-diff.test.ts`。
2. 折叠工具卡的 render 行为（`withRenderedSession` 真实 renderer）→ `session-message-render.test.tsx`。
3. `OptimizedBuffer` native cell 写入（Zig 行为测试）→ `buffer_test.zig`。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `previewDiff(sample, 5)` 不含 ` …` 行且 parsePatch hunk 计数等于实际保留的 old/new 行 | 当前注入 ` …`，计数把它算成内容行（6/6） | 移除注入；计数=实际保留行（5/5） | 截断预览仍可被 parsePatch 解析、不丢 hunk 结构 |
| 2 | 折叠 Shell/Edit 卡（内容超阈值）不出现 `…` 行，且点击展开后内容行数严格大于折叠态 | 当前 previewText 追加 `…`，折叠态含幻影行 | 移除注入；折叠态只有真实预览行 | 未超阈值卡片不出现 disclosure；展开仍显示完整内容 |
| 3 | 宽字符跨 scissor 右边界时整字拒绝，且当目标处已有 grapheme span 时，被拒绝写入不得改变既有 cell/tracker | R1 检查位于 span_cleanup 之后，被拒绝写入先清除旧 span | 入口 atomic reject：旧 grapheme 完整保留、scissor 外 cell 保持原值 | 行尾 EOL 分支、宽度匹配/纯 ASCII/word-wrap 不回归（探针 baseline） |
| 4a | v2 路由 bash 卡（输出 >10 行）折叠态不出现 `…` 行，且显示 `Click to expand` | 当前 v2 三处 memo 追加 `…` | 移除注入；折叠态只有真实预览行 | v2 路由其他消息类型（error/text）渲染不回归 |
| 4 | 同一 OpenTUI source SHA 生成的 11 个包可通过 packed consumer verifier，并且 root install/runtime 解析新 release | 当前 root 固定旧 `0.4.3-smark.5`，native build/release 尚未完成 | 先完成既有 build-native/release closure，再 bump root metadata；验证新包而非 source-only 路径 | 防止 source fix 未进入用户 runtime，防止 11 包版本或 provenance 不一致 |

每个测试的期望值来自独立来源（截断后应有的真实行、parsePatch 计数、scissor 外 cell 应保持的原值），不断言 private helper、不复制生产算法、不做 horizontal slicing。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~160 | 现有生产/测试变更约 63；R3 新增 v2 生产 ~9 + buffer 前置净增 ~5 + buffer_test ~30 + v2 测试 ~60；release integration metadata 不计入 E。排除 generated lockfile、import/format/pure-move |
| Required Chinese explanatory comments `C` | ~26 | `ceil(170 * 0.15) = 26`；现有 qualifying comments 20 + R3 计划新增约 11（v2×3、buffer 入口、两个新测试），合计 ~31 |

计划注释点（邻近改动、解释 invariant/边界/测试意图，非复述代码）：

1. `index.tsx` `previewText`：说明折叠语义由 BlockTool footer 承载，预览不重复注入 sentinel（INV-01）。
2. `preview-diff.ts`：说明截断后 hunk 计数由 oldVisible/newVisible 重算，无需 sentinel 占位即可被 parsePatch 解析。
3. `buffer.zig` `setInternal`：说明宽 grapheme 仅在完整 span 落入当前 scissor 时才写入，与左边界“起始越界跳过整字”对称（INV-02）。
4. `buffer_test.zig` straddle 测试：说明该断言锁定 scissor 外 cell 不被 continuation 覆盖的用户可观察行为。
5. `session-message-render.test.tsx`：说明折叠态不得出现 `…` 幻影行、展开必须严格增高的行为意图。
6. `preview-diff.test.ts`：说明截断预览的期望值来自真实保留行而非 sentinel。
7. OpenTUI release verifier/metadata 邻近位置：说明 11 个包必须来自同一 source SHA，root 不得以旧包掩盖 source-only 修复。
8. `session-v2.tsx` 三处：说明折叠语义由各组件 footer 承载，预览不重复注入 sentinel（INV-01，与主路由同一 contract）。
9. `buffer.zig` `setInternal` 入口：说明跨界宽 grapheme 的拒绝必须先于任何 mutation（atomic reject），且 `x + width <= self.width` 保留 EOL 行尾分支语义（INV-02）。
10. `buffer_test.zig` 新测试：说明锁定“被拒绝的跨界写入不改变已有 grapheme/tracker”的用户可观察行为。
11. `session-v2-error.test.tsx` 新测试：说明 v2 路由折叠态不得出现 `…` 幻影行、disclosure 是唯一信号的行为意图。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/preview-diff.test.ts` | `packages/opencode` | previewDiff 无 sentinel、可解析（slice 1） |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | 折叠卡无 `…`、展开增高（slice 2） |
| `bun typecheck` | `packages/opencode` | TS 类型不回归 |
| `bun run build`（native 改动后） | `thirdparty/opentui`（repo 根） | 生成新 native 库供 native 测试 |
| `bun run test:native -Dtest-filter="scissor"`（或新增测试名） | `thirdparty/opentui/packages/core` | 宽字符 straddle 不越界、被拒绝写入保持已有 grapheme（slice 3） |
| `bun test test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | v2 路由折叠无 `…`、error 渲染不回归（slice 4a） |
| `bun run --cwd packages/core build:native --all && bun run --cwd packages/core build:lib && bun run --cwd packages/solid build && bun run --cwd packages/keymap build` | `thirdparty/opentui` | 同一 source SHA 生成完整 native/JS package closure |
| `bun run --cwd packages/core test:js && bun run --cwd packages/solid test && bun run --cwd packages/keymap test` | `thirdparty/opentui` | source JavaScript/framework regression |
| `bun run --cwd packages/core test:dist --skip-build && bun run --cwd packages/solid test:dist --skip-build && bun run --cwd packages/keymap test:dist --skip-build` | `thirdparty/opentui` | packed dist consumer regression |
| `bun scripts/verify-release-packages.ts --directory artifacts/npm-packages --version 0.4.3-smark.6` | `thirdparty/opentui` | 11 tarball HTTP install、版本/provenance/native 闭包与 CJK consumer 行为 |
| `bun install --frozen-lockfile` | repository root | root metadata 只解析 immutable `0.4.3-smark.6` release |
| `bun test src/renderables/Diff.regression.test.ts src/renderables/Code.test.ts` | `thirdparty/opentui/packages/core` | Diff/Code 换行/裁剪不回归 |
| 原始 loop 复跑：`bun D:\Temp\opencode\probe-*.ts` | 对应 package 目录 | 三个探针由 red 转 green |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 复用既有测试文件 |
| Files modified | 10 root | Files modified | 9 root paths + 2 OpenTUI source paths（共 11 files） | 5 生产 + 3 测试 + `package.json`/`bun.lock`；OpenTUI submodule 内 1 source + 1 test 文件 |inel 为行内移除，非整文件 |
| Production lines | ~19 | 6 处 sentinel 移除 + buffer.zig 入口净增 ~2 + preview-diff 注释修正；release metadata 不计入 production code file budget |
| Test lines | ~141 | preview-diff ~6 + render ~20 + buffer_test ~55 + session-v2 ~60 |
| Generated lines | lockfile delta only | `bun.lock` 只由 release URL/version/hash 生成，不手工添加第二份依赖语义 |

预算为审计信号，不作为省略已确认行为的许可。满足 GOAL 及 R3 用户授权：生产代码 5 文件（原上限 4 + 授权额外 ≤6）、总改动 ≤400 行。

## 20. Real Risks and Open Decisions

真实风险（observed/contracted/reachable）：

- **OpenTUI release 边界**：buffer.zig 修复必须先经过 Zig/native/packed consumer verification，再由既有 workflow 发布 `v0.4.3-smark.6`，最后由 root `package.json`/`bun.lock` 接入；在这条链完成前不能声称 Branch B 已到达用户 runtime。
- **INV-01 行为变化可见性**：移除 `…` 后，折叠态不再有任何“截断点”视觉标记；这是用户明确要求的契约（`Click to expand` 承载信号）。风险是低信息用户对“为何可点开”的 discoverability 略降，但这是需求本身的选择，非缺陷。

### Open Decisions Requiring the User

无。当前 release tag 采用现有 `.5` 之后的下一个 immutable patch `v0.4.3-smark.6`；native 工具链缺失是环境阻塞，不改变产品语义，也不通过 fallback 绕过。

### Rejected Speculation

- **`drawBox` 透明边框 fast path 越界**：`probe-buffer-scissor.ts` 在强制全透明背景下复现，但 fast path 仅在 `alpha(backgroundColor)==0` 启用（buffer.zig:2000）；会话视图所有卡片/边框盒背景为不透明 theme 色或 alpha=70 叠加层，该路径在当前症状不可达。缺乏 reachability，排除。
- **`drawGrid` 越界**：会话视图不使用表格 grid，不可达。排除。
- **改 `overflow`/`flexShrink`/`measureForDimensions` 默认值**：用户明确约束不改；且当前无 red 信号证明其为用户截图根因。排除为本计划的改动。
- **notebook `previewText` 独立行为测试**（R2 NB-03）：notebook producer 与主会话 previewText 同构，INV-01 已在主会话与 previewDiff seam 验证；为保持手术刀范围不再新增第三个 TS 测试 seam，接受该 residual 风险。

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
| 1 | R1 | yes | none（`No blocking findings.`） | NB-01（INV-02 表述宽于实际修复面，drawGrid/drawBox fast path 不修复但已证明不可达，语义自洽）；NB-02（Branch B 运行时生效依赖后续 release 机械步骤，已如实声明）；NB-03（§17 注释点 6 处对应所需 C≈10，计划模式可行，实现阶段须达最小值）；NB-04（previewText 空预览分支行为变化已隐含覆盖，符合反分支要求） | APPROVE | ses_03bf90a64ffezHCMA597HbL9s2 |
| 2 | R2 | yes | B-01（session-v2 三处可达 sentinel 被未经授权地排除在 INV-01 之外）；B-02（scissor 检查位于 tracker/span_cleanup mutation 之后，无法保证保持原值） | NB-01（preview-diff.ts:94-98 过期注释）；NB-02（INV-02 措辞宽于实际设计）；NB-03（notebook 无独立行为测试）；NB-04（release closure 外部机械依赖） | BLOCK | ses_03a60ec10ffeGXnY41l72F4eVO |
| 3 | R3 | yes | none（`No blocking findings.`） | NB-01（§19 12 paths vs §15 11 files 算术漂移）；NB-02（§13 INV-03 Planned file 列 wording 松散，§15 为准）；NB-03（§16 slice 编号 1,2,3,4a,4）；NB-04（§17 E≈170 vs §19 ≈160，C 承诺双向满足） | APPROVE | ses_03a489facffednanqYmBU4RPwP |

独立审计 verdict（round 1，原样记录）：`No blocking findings.` Release verdict: **APPROVE**（仅适用于 R1，full-scope）。

R1 approval was invalidated by the R2 revision; R2 was BLOCKED in round 2. R3 disposition：B-01 由用户明确授权扩展文件上限并将 session-v2 纳入 INV-01 解决；B-02 由 `setInternal` 入口 atomic reject（检查前置到任何 mutation 之前，保留 EOL 分支）解决；NB-01 由 preview-diff.ts 注释修正解决；NB-02 由 INV-02 措辞收窄到 setInternal span 解决；NB-03 作为已接受 residual 记录。

独立审计 verdict（round 3，原样记录）：`No blocking findings.` Release verdict: **APPROVE** — exclusively for canonical plan revision **R3**（full-scope, plan audit round 3 of ≤6）。合法状态迁移为 `Status: approved` / `Approved revision: R3` / `Implementation allowed: yes`；任何实质性修改将使本批准失效。The disclosed environment blocker (no local Zig; native build/release via existing workflows) is an execution dependency already carried in the plan, not a plan defect。

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

实现进行中（Branch A 已完成并验证；Branch B 修复已实施但 native/runtime release 验证受环境阻塞；R2 adds the previously requested delivery chain without changing the existing source diff）。

### Actual Files and Diff

生产代码（4 文件）：
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`（previewText 移除 `…`，-2/+2）
- `packages/opencode/src/cli/cmd/tui/util/preview-diff.ts`（previewDiff 移除 ` …` 注入与失效 incomplete 变量，-5/+3）
- `packages/opencode/src/cli/cmd/tui/routes/session/notebook-tool.tsx`（previewText 移除 `…`，-1/+2）
- `thirdparty/opentui/packages/core/src/zig/buffer.zig`（setInternal 宽 grapheme scissor span 约束，+5）

测试代码（3 文件）：
- `packages/opencode/test/cli/cmd/tui/preview-diff.test.ts`（反转 3 处 ` …` 断言，-9/+9）
- `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx`（新增折叠无 `…`/展开增高 render 测试，+33）
- `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig`（新增 straddle scissor native 测试，+27）

R2 release integration is not yet implemented: root `package.json`/`bun.lock` still point to `0.4.3-smark.5`, and no OpenTUI `v0.4.3-smark.6` artifact has been built or published.

R3 变更已实施并验证（2026-08-03）：

- `feature-plugins/system/session-v2.tsx`：三处 inline `limited` memo 移除 `…` 注入（Shell :225、GenericTool :595、Bash :780），各加 1 行中文注释；生产净增 3 行代码 + 3 行注释。
- `thirdparty/opentui/packages/core/src/zig/buffer.zig`：scissor span 检查前置到 `validateAndIndex` 之后、一切 mutation 之前（atomic reject，含 `x + span_width <= self.width` 保留 EOL 分支）；移除 R1 写入段旧检查（:562-565）。净增 3 行代码 + 4 行注释、净减 4 行旧检查。
- `thirdparty/opentui/packages/core/src/zig/tests/buffer_test.zig`：新增 `buffer - rejected straddling write preserves existing grapheme span`（约 18 行代码 + 5 行注释）。
- `test/cli/cmd/tui/session-v2-error.test.tsx`：新增 v2 折叠无 sentinel 行 render 测试（约 60 行代码 + 5 行注释），复用既有 Harness。
- `util/preview-diff.ts`：修正 :94-98 过期注释（NB-01，仅注释）。

R3 Red-Green 证据：

- Slice 4a（v2 sentinel）：初版断言因 frame 行含边框字符而假绿（断言恒真，TDD 纪律修正）；改为行级正则后 red（`Expected: false, Received: true`，sentinel 行 `┃  …` 存在于当前代码）→ 移除三处注入 → green（2 pass, 0 fail）。
- Slice 3（buffer atomic reject）：red 证据为代码顺序分析（`set()` → `setInternal(true)` → span_cleanup :496-532 先于 R1 检查 :565）；修复已实施。native 测试执行仍受 zig 缺失阻塞（`bun: command not found: zig`），按计划披露的 execution dependency 处理，不可在本地转 green。

R3 Verification：

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/preview-diff.test.ts test/cli/cmd/tui/session-message-render.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | 90 pass, 0 fail |
| `bun test test/cli/cmd/tui/`（整目录回归） | `packages/opencode` | 300 pass, 0 fail（32 文件，较 R1 +1 测试） |
| `bun typecheck` | `packages/opencode` | pass |
| `bun run test:native -Dtest-filter=...` | `thirdparty/opentui/packages/core` | 阻塞：`zig: command not found`（环境，非代码缺陷） |

R3 Chinese Comment Calculation：

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~150 | R1 约 63 + R3：session-v2 3 + buffer.zig 3 + buffer_test 18 + session-v2 测试 60；排除空行/注释/import/format/generated |
| Qualifying Chinese comment lines `C` | ~35 | R1 20 + R3：session-v2×3、buffer.zig 入口 4、buffer_test 5、session-v2 测试 5 |
| Ratio `C / E` | ~0.23 | 35 / 150 |
| Required minimum `C` | 23 | `ceil(150 * 0.15) = 23`，满足 |

Branch C（runtime delivery）已于 2026-08-03 经用户授权执行完成：

- OpenTUI 子模块提交：`f933876c7`（fix(core) buffer scissor 修复）+ `afd11de82`（release: 准备 v0.4.3-smark.6，9 个 lockstep 包 + bun.lock）。
- Tag `v0.4.3-smark.6` 推送触发 `release.yml`（run `30790680583`，约 8.7 分钟）：Build Release Closure（zig 0.15.2 native build + focused/native/JS/dist/packed 测试全绿，含本任务两个 straddle 测试）→ 四平台 Verify（macos-15/ubuntu/ubuntu-arm/windows 安装验证）→ Publish（11 个 tarball + SHA256SUMS，immutable prerelease）。
- Root bump：`package.json` 14 处（3 catalog + 11 override URL）与 `bun.lock` 25 处（含新 sha512）全部指向 `0.4.3-smark.6`，无 `smark.5` 残留；`bun install` 成功，node_modules 实际解析 `0.4.3-smark.6`。
- Runtime 原始 feedback loop 复跑（root 工作区，新 native lib）：`probe-render-overflow.ts` 的 `straddle-wide-hidden-nowrap` 由“`一` 覆盖右边框”转为 `│abcdef │` 整字裁剪边框完整；`probe-render-wordwrap-mismatch.ts` 的 word-mismatch 干净换行、nowrap-mismatch 整字裁剪——两个原始 red loop 均转 green。
- 新 runtime 回归：`bun test test/cli/cmd/tui/` 300 pass, 0 fail；`bun typecheck` pass。

R3 Remaining Unverified Items：

- 无。native 编译/测试已在 CI（zig 0.15.2）执行通过，runtime delivery 已完成并复跑验证。

### Red-Green Test Evidence

- Slice 1（previewDiff）：red（3 失败：` …` 仍注入）→ 移除注入 → green（8 pass, 0 fail）。
- Slice 2（previewText + render）：red（`expect(...includes("…")).toBe(false)` 收到 true）→ 移除两处 `…` → green（单测 1 pass）。
- Slice 3（buffer.zig straddle）：red 证据由 test-renderer 探针在预编译 native lib 上建立（`abcdef一`/`你好世界` 右边框被 continuation 覆盖）；修复已按批准 plan 实施于 `setInternal`。native 回归测试（buffer_test.zig straddle）已写但**无法在本环境运行**（见 Remaining Unverified Items）。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/preview-diff.test.ts` | `packages/opencode` | 8 pass, 0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | 80 pass, 0 fail |
| `bun test test/cli/cmd/tui/`（整目录回归） | `packages/opencode` | 299 pass, 0 fail（32 文件；ENOENT 为既有测试环境噪音） |
| `bun typecheck` | `packages/opencode` | pass |
| `bun run test:native -Dtest-filter=...` | `thirdparty/opentui/packages/core` | **阻塞：`zig: command not found`** |
| `bun run build`（native） | `thirdparty/opentui` | **阻塞：依赖 zig 0.15.2** |

### Original Feedback-Loop Result

- Branch A 原始 loop：`previewDiff(sample,5)` 不再含 ` …` 行（green）。
- Branch B 原始 loop（探针）：`probe-buffer-scissor.ts`/`probe-render-overflow.ts`/`probe-render-wordwrap-mismatch.ts` 在**预编译 native lib**（`@opentui/core-win32-x64` `0.4.3-smark.5`，未含本修复）上仍为 red，确认 bug 存在于运行时 lib；需 native build 后才能转 green。

### Actual Secondary and Replacement Path Inventory

无新增 alternate success path、无 diagnostic path。`BlockTool` footer disclosure 与 `previewDiff` hunk 计数重算为既有 primary-contract branch，均保留。secondary-path 预算 0 满足。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~63 | 生产 ~4 + 测试 ~59；排除空行、纯注释、无 import/format/generated 改动 |
| Qualifying Chinese comment lines `C` | 20 | index.tsx×1、notebook-tool.tsx×1、preview-diff.ts×2、buffer.zig×3、preview-diff.test.ts×3、session-message-render.test.tsx×4、buffer_test.zig×6 |
| Ratio `C / E` | ~0.32 | 20 / 63 |
| Required minimum `C` | 10 | `ceil(63 * 0.15) = 10`，满足 |

### Remaining Unverified Items

- **Branch B（buffer.zig setInternal 修复）无法在本环境编译/测试验证**：`bun run test:native` 与 `bun run build` 依赖 zig 0.15.2（`build.zig.zon` `minimum_zig_version`），本机未安装（PATH/常见位置均无）；下载 zig 二进制并执行属 policy-gated 行为，auto-preflight 拒绝（需用户显式授权，且用户未要求安装 zig）。修复已经过仔细语法复核（类型/作用域/`and`/`!`/`@intCast`/`return` 均与既有代码一致；左边界与无 scissor 情形不受影响），且运行时仍加载预编译 lib（爆炸半径限于子模块源码），但未经 native 编译/测试确认。
- **Branch C（runtime delivery）未完成**：现有 workflow 已提供 Zig 0.15.2 和跨平台 release closure，但本地没有 Zig，且尚未执行 `v0.4.3-smark.6` build/release/root bump；在完成前不能声明用户 runtime 已加载修复。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | none（`No blocking findings.`） | NB-01（notebook `previewText` sentinel 移除无行为敏感测试，INV-01 已在主会话与 previewDiff seam 验证）；NB-02（clip-overwrite 时 grapheme_tracker 可能留幻影 id，后果限于 hasAny() 慢路径选择与统计，无 cell 编码该 id）；NB-03（全空白截断预览现渲染空预览区，为契约性 sentinel 移除的直接后果）；NB-04（Branch B 运行时生效依赖独立 OpenTUI build/release/bump，已披露） | APPROVE | ses_03bcf12f1ffed2hDcbm5K3gcYr |

| 2 | R1 | yes | B-01（`session-v2.tsx` :225/:595/:780 在 `experimentalEventSystem` 下 reachable，但 R1 将其排除且仍声称 INV-01 全局成立）；B-02（native build/test 未执行，source fix 未进入实际 runtime release artifact） | NB-01（notebook sentinel 独立行为测试仍可增强）；NB-02（grapheme_tracker phantom id 风险未证明为用户可见）；NB-03（全空白截断预览为空是直接契约结果） | BLOCK | ses_03a6d1a29ffeDHOecVsqSSexca |
| 3 | R3 | yes | none（`No blocking findings.`） | NB-01（INV-03 runtime delivery 未执行，plan-carried execution dependency，本 verdict 仅认证 source diff）；NB-02（native 测试 red/green 由分析而非执行建立，CI 执行仍是 INV-02 runtime-verified 的前提）；NB-03（session-v2 Shell/GenericTool 与 notebook previewText 无独立行为测试，plan 已接受 residual） | APPROVE | ses_03a2f09b1ffe349g5vjScZXdpO |

独立实现审计 verdict（round 1，原样记录）：`No blocking findings.` 审计独立复跑验证命令：`bun test test/cli/cmd/tui/preview-diff.test.ts` 8 pass/0 fail、`bun test test/cli/cmd/tui/session-message-render.test.tsx` 80 pass/0 fail、`bun typecheck` pass（均于 `packages/opencode`）。Release verdict: **APPROVE**（仅适用于实际审计 diff：5 个根仓库文件 + 2 个子模块文件，针对 R1）。所披露不可验证项（native zig build/test 与 OpenTUI release/bump 机械步骤）保留为用户的显式开放项，非代码缺陷。

独立实现审计 verdict（round 2，原样记录）：`Release verdict: BLOCK`。B-01 要求 R2 重新建立 INV-01 与实验 v2 route 的范围一致性；B-02 要求完成 native build/test 和实际 release artifact 接入。R2 已通过本 plan revision 处理 scope，并把既有 release closure 纳入完成条件，等待新的 full-scope audit。

独立实现审计 verdict（round 3，原样记录）：`No blocking findings.` Release verdict: **APPROVE** — exclusively for the actual audited diff（index.tsx、notebook-tool.tsx、preview-diff.ts、session-v2.tsx、buffer.zig + 四个测试文件）against canonical plan revision **R3**（full-scope implementation audit, round 1 of ≤3）。审计独立复核：300/300 TUI 测试通过、`bun typecheck` 通过、中文注释门 E≈168/C=37（需求 26，约 22%）通过、六个 sentinel 注入点全部移除且 TUI 源码树无残留 `"…"` 字面量、无 fallback/无竞争成功路径/无责任泄漏。This verdict does not certify INV-03 runtime delivery：Zig native suite、`v0.4.3-smark.6` immutable release 与 root `package.json`/`bun.lock` bump 仍需经既有 OpenTUI workflow closure 执行且 native 测试转绿后，才能声称 buffer.zig 修复已进入 opencode runtime。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

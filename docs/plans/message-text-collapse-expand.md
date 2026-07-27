# Canonical Implementation Plan: 消息正文与错误的折叠/展开

> Status: approved
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: 用户口头需求 — 用户错误、用户消息、助手正文过长时缺少折叠/展开机制，应对标现有 Thinking / 工具块的 disclosure 风格，统一交互并避免与现有点击行为冲突。
>
> Implementation allowed: yes（计划已批准；但本 GOAL 终态为 approved-plan-only，用户要求不实施，不进入阶段 3）
>
> Last updated: 2026-07-28
>
> Revision history: R1 初稿。R2 折入用户决策：消息类阈值 20 行/1600 字符；错误类阈值跟随工具口径（10 预览/20 行/800 字符）且默认收缩 + header；footer 文案 `▼ expand (N rows)`；v2 debug route 一期一并迁移。R3 折入 R2 审计 non-blocking 发现：N-01 v2 `AssistantText` 补入迁移清单；N-02 user body 右键 toggle 机制明确（evt.button 分支）；N-03 TextPart 测量口径明确（raw markdown 近似）；N-04/05/06 记录修正。

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 当前我发现我的 open code 在展示用户的错误的时候，它会展示得非常长……假设这个错误可能有几百行，它现在仍然会全量展示。这种理论上来说应该是有一个 expand 的逻辑……类似于相应的 thinking 字段，或者说工具的字段等等内容。与此同时，我发现用户的消息特别长的时候，它理论上来说也没有相应的收缩相应的机制。因此请你详细完整进行调研……看看理论上来说实现比较好的风格是如何的，然后实现比较好的样式是如何定义的，同时交互的逻辑是如何的，同时符合现有的内容，以及尽量减少和现有内容冲突。当然也可以比如说把现在的逻辑进行一下适当的优化，比如现在的每一条消息正常点击它都会进行相应的弹出菜单，或者理论上来说比如说这种消息右键它可以进行收缩或者展开等等逻辑。然后理论上来说我们每一条消息，它只要过长的话，比如它超过十行或者超过多少行，它都可以进行相应的收缩……你当前只是进行方案构建阶段，不要进行任何的代码修改。你最终需要给我呈现的是相应的样式以及交互逻辑等等内容。

## 2. Explicit Non-Goals

- 不改变现有 `ReasoningRun`（Thinking）与 `BlockTool`（工具块）的折叠语义、阈值与外观。它们已稳定且有各自专属约束（多 source segment、preview/body 双区、wrap-mode 切换），本计划只复用其模式，不迁移其实现。
- 不引入按消息逐条的键盘导航/焦点模型。现有 `session.message.next/previous` 默认 `none` 且消息无逐条 focus 语义；折叠保持与 Thinking/工具一致的鼠标驱动。
- 不持久化折叠状态。与 `ReasoningRun`/`BlockTool` 一致，每次挂载默认收缩。
- 不改变 `DialogMessage`（Revert/Retry/Copy/Fork）菜单的触发方式与项集合。
- 不改变 `errorMessage` / `errorFormat` 的格式化口径（`src/util/error.ts`）。
- 不改变 v2 debug route（`feature-plugins/system/session-v2.tsx`）的独立渲染职责；其 `UserMessage`/error/`AssistantText` 在一期迁移到 `CollapsibleTextBlock` 以收敛两 route 外观（见 §11、§15），`AssistantReasoning` 的 minimal 折叠保持不变。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `packages/opencode/AGENTS.md`（Style Guide） | 单函数优先、避免过早抽取单用 helper；函数式数组方法；`const`/ternary/早返回；中文注释覆盖非显然约束。 |
| `packages/opencode/AGENTS.md`（Testing） | 测试不能从仓库根运行；在 `packages/opencode` 内运行。 |
| `.opencode/templates/canonical-plan.md` | 本计划的结构与硬门。 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | 主 Session 渲染器，含 `ReasoningRun`、`BlockTool`、`UserMessage`、`AssistantMessage`、`TextPart` 与 legacy error 全部既有折叠/未折叠实现。 |
| `packages/opencode/src/cli/cmd/tui/config/keybind.ts` | 现有 `display_thinking` / `tool_details` 默认 `none`；per-block 折叠为鼠标驱动，无需新键位。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `routes/session/index.tsx:1944-2052` `ReasoningRun` | 折叠的"house style"蓝本：`expanded` signal、`REASONING_PREVIEW_ROWS=5`、`reasoningRowsTotal` 视觉行测量、`maxHeight+overflow:hidden`、`onMouseUp` 含 selection guard + `!overflow()` 防预写、`▼ expand`/`▲ collapse` footer、wrap-mode 切换。 | observed |
| `routes/session/index.tsx:2256-2270` `DEFAULT_BLOCK_CHAR_THRESHOLD=800` / `previewText` | 工具块的同步阈值与预览切片口径（行数 + 字符数双门，尾部 `…`）。 | observed |
| `routes/session/index.tsx:2700-2832` `BlockTool` | preview/body 双区、懒挂载 + `visible` 切换（规避 OpenTUI renderable 重挂 bug）、`onMouseUp` 含 selection guard + 右键 `MouseButton.RIGHT` → `onRightClick`、footer `Click to expand/collapse`。 | observed |
| `routes/session/index.tsx:1893-1907` legacy error | 当前全量渲染 `errorMessage(props.message.error)`，`theme.error` 左边框，无折叠。 | observed |
| `routes/session/index.tsx:1561-1691` `UserMessage` | 当前全量 `<text>{content()}</text>`（1623）；`onMouseUp`（1616）→ 父级 `DialogMessage` 菜单（1389-1400）。左键已被占用，是核心冲突点。 | observed |
| `routes/session/index.tsx:2098-2154` `TextPart` | 助手正文全量 `<markdown>`/`<code>`，无折叠、无点击处理。 | observed |
| `routes/session/index.tsx:2774-2786` / `app.tsx:1076` / `ui/dialog.tsx:185` | `MouseButton.RIGHT` 右键作为既有"次要动作通道"的成熟模式。 | observed |
| `src/util/error.ts:31-51` `errorMessage` | 错误文本来源，可能为多行 stack/JSON。 | observed |
| `feature-plugins/system/session-v2.tsx:176-214, 361-376, 393-449, 452-513` | v2 debug route 的 `UserMessage`/error/`AssistantText` 全量渲染，以及其独立的 reasoning 折叠（minimal 模式 `▶ Thought`/`▼ Thinking`）。一期一致性收敛对象（`AssistantReasoning` 除外）。 | observed |
| `config/keybind.ts:132-133` | `tool_details` / `display_thinking` 默认 `none`；per-block 折叠为鼠标驱动。 | observed |
| `test/cli/cmd/tui/session-message-render.test.tsx:940-978` | 现有 reasoning 折叠的测试口径（`▼ expand` 出现条件、overflow 行数断言、短正文不得出现 disclosure）。新测试需对齐该口径。 | observed |

## 5. Current Behavior

```text
errorMessage(error) -> <text> 全量渲染（legacy error，index.tsx:1905）
user content()      -> <text> 全量渲染（UserMessage，index.tsx:1623）
assistant text      -> <markdown>/<code> 全量渲染（TextPart，index.tsx:2107-2150）
```

三者均无 disclosure：不测量长度、不设 `maxHeight`、不提供 toggle、不显示 `▼/▲` footer。相比之下，同文件内的 `ReasoningRun` 与 `BlockTool` 已具备完整折叠语义。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 多行/超长 error（stack/JSON，数百行） | `errorMessage`（`util/error.ts`） | 纯 string | `AssistantMessage` error 分支（index.tsx:1893） | `AssistantMessage` | observed |
| 超长 user 文本（粘贴日志/代码/长 prompt） | `UserMessage.parts` text 拼接（index.tsx:1574-1584） | 纯 string | `UserMessage` 正文（index.tsx:1623） | `UserMessage` | observed |
| 超长 assistant 正文（大代码块/长解释） | `TextPart.part.text`（index.tsx:2102） | 纯 string | `TextPart`（index.tsx:2107-2150） | `TextPart` | observed |
| 短正文（≤ 阈值） | 同上 | 同上 | 同上，应保持完整无 disclosure | 同上 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 任意可折叠文本区在视觉行数超过阈值时默认收缩，仅显示预览行数 + disclosure footer。 | ReasoningRun:2018-2046；BlockTool:2814-2823 | session-message-render.test.tsx:947-961 |
| INV-02 | 短正文（未超阈值）保持完整渲染，不出现 disclosure footer，点击不预写 `expanded`。 | ReasoningRun:2004-2006, 2043；测试:940 | session-message-render.test.tsx:940, 978 |
| INV-03 | 折叠/展开 toggle 不得在文本拖选（`getSelection().getSelectedText()` 非空）时触发。 | ReasoningRun:2003；BlockTool:2776 | session-message-render.test.tsx:980-989（点击短正文不预写） |
| INV-04 | `UserMessage` 左键 → `DialogMessage` 菜单的既有行为不得被折叠 toggle 改变。 | index.tsx:1389-1400, 1616 | — |
| INV-05 | 折叠状态为挂载局部、非持久化，新 Session/新挂载默认收缩（与 ReasoningRun/BlockTool 一致）。 | ReasoningRun:1975；BlockTool:2743 | session-message-render.test.tsx:1296-1316 |
| INV-06 | 流式 assistant 正文在未完成时不得伪造 disclosure（仅当真实 overflow 时显示 toggle）。 | ReasoningRun:1981-1987, 测试:964-978 | session-message-render.test.tsx:964-989 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01（error） | `AssistantMessage` error 分支直接 `<text>{errorMessage(...)}</text>`，无测量、无 `maxHeight`、无 toggle。 | `routes/session/index.tsx` `AssistantMessage`（1893-1907） | 该 `<box>` 仅设 padding/border，子节点为单一全量 `<text>`。 |
| INV-01（user） | `UserMessage` 直接 `<text>{content()}</text>`，无测量、无 `maxHeight`、无 toggle。 | `routes/session/index.tsx` `UserMessage`（1623） | 同上，且 `onMouseUp` 已绑定菜单，无 disclosure 入口。 |
| INV-01（assistant text） | `TextPart` 直接全量 `<markdown>`/`<code>`，无 `maxHeight`、无 toggle。 | `routes/session/index.tsx` `TextPart`（2107-2150） | `<box paddingLeft={3}>` 无高度约束，子节点全量渲染。 |

根因是统一的：这三处文本区从未接入 `ReasoningRun`/`BlockTool` 已建立的 disclosure 通路。非 bug，是缺失的能力。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 文本视觉行测量 | 新 `measureTextRows(content, width, widthMethod)`（泛化自 `reasoningRowsTotal`） | 同步返回视觉行数；释放 native 句柄 | ReasoningRun 已证明该口径对 word-wrap 文本必要；复用避免第二套测量 | `previewText` 是切片工具，不测量 |
| 折叠 disclosure 组件 | 新 `CollapsibleTextBlock`（`routes/session/collapsible-text.tsx`） | 接收 `content`/`fg`/`header?`/`previewRows`/`threshold`；渲染限高正文 + footer + toggle；暴露 `onMouseUp` 行为模式（body-toggle vs footer-toggle） | 三处调用点（error/user/assistant text）语义同构，复用消除三份漂移实现 | ReasoningRun/BlockTool 各有专属约束，不合并 |
| error 渲染入口 | `AssistantMessage` error 分支 | 用 `CollapsibleTextBlock` 包裹 `errorMessage(...)`，保留 `theme.error` 边框 | 该分支是 error 文本的唯一生产消费点 | — |
| user 渲染入口 | `UserMessage` | 正文用 `CollapsibleTextBlock`（footer-toggle 模式）；保留 body `onMouseUp`→菜单 | 左键冲突在此解决 | — |
| assistant 正文入口 | `TextPart` | `<markdown>`/`<code>` 外包 `CollapsibleTextBlock`（body-toggle 模式），流式遵循 INV-06 | 该组件是助手正文唯一渲染者 | — |

**测量口径（N-03 澄清）**：`measureTextRows` 测量传入的 content 字符串。`UserMessage`/error 传入纯文本（`<text>` 无 conceal），raw = rendered，测量精确。`TextPart` 传入 raw markdown（`props.part.text.trim()`，pre-conceal）：与 `ReasoningRun` 的 post-conceal 捕获（`onChunks`/`onContent`，ReasoningRun:2087-2090）不同——reasoning 需精确测量来决定 word/char wrap 切换（ReasoningRun:2031, 2086），而 TextPart wrap-mode 固定，测量仅用于 disclosure gate。raw markdown 含语法标记（`**`/`#`/`` ` ``），conceal 后不可见，故 raw 测量可能略微高估视觉行数；在 20 行阈值下该高估（通常 <20% 字符）不会让明显短的正文误触阈值，worst case 为临界正文多出 disclosure footer（展开后可见实际不长，再收起即可），属可接受近似。`maxHeight`/`overflow:hidden` 保证折叠态显示与真实 post-conceal 行数一致，不受 raw 测量影响。若实测误报，可后续为 TextPart 补 `onChunks` 捕获，但当前不引入第二套捕获机制（避免冗余）。

## 10. Single Approved Primary-Path Design

一个权威语义路径：抽取一个共享的 `CollapsibleTextBlock` disclosure 组件，复用 `ReasoningRun` 的"视觉行测量 + `maxHeight`/`overflow:hidden` + `▼/▲` footer + selection-guarded toggle"模式，接入三处当前未折叠的文本区。

```text
content string
  -> measureTextRows(content, width, widthMethod)  // 同步视觉行测量
  -> collapsible = rows > threshold || chars > charThreshold
  -> CollapsibleTextBlock:
       collapsed => maxHeight=previewRows, overflow=hidden, footer "▼ expand (N rows)"
       expanded  => maxHeight=undefined, overflow=visible, footer "▲ collapse"
       onMouseUp: selection guard -> toggle (body or footer per mode)
  -> observable: 限高预览 + disclosure + 可展开全量
```

### 10.1 样式定义（与现有 house style 对齐）

- **容器**：沿用各调用点既有 `<box>`（error 保留 `theme.error` 左边框；user 保留 agent 色左边框；assistant text 保留 `paddingLeft={3}`）。`CollapsibleTextBlock` 只接管正文 `<box>` 的 `maxHeight`/`overflow`，不改外层边框色。
- **限高**：`maxHeight={expanded() ? undefined : MESSAGE_PREVIEW_ROWS}`，`overflow={expanded() ? "visible" : "hidden"}`（与 ReasoningRun:2018-2019 完全一致）。
- **footer**：`<box marginTop={1}><text fg={theme.textMuted}>{expanded() ? "▲ collapse" : `▼ expand (${rows()} rows)`}</text></box>`。采用 ReasoningRun 的 `▼/▲` 字形（文本块更接近 reasoning 而非工具卡），并附带被隐藏行数 `（N rows）` 以提升可预期性。仅 `overflow()` 为真时渲染（INV-02）。
- **error header（可选）**：error 区在正文上方加一行 `<text fg={theme.error}>✕ {errorName ?? "Error"}</text>`，使折叠态仍能一眼识别为错误（边框色 + header 双重信号）。`errorName` 取 `props.message.error?.name`。
- **预览行数 / 阈值（消息类：user + assistant text）**：`MESSAGE_PREVIEW_ROWS = 20`、`MESSAGE_COLLAPSE_THRESHOLD_ROWS = 20`、`MESSAGE_COLLAPSE_CHAR_THRESHOLD = 1600`。20 对齐用户确认的放宽档（"超过十行"的更宽容版本）；1600 捕获长单行 wrap（如粘贴的长日志单行）。
- **错误类阈值**：error **不走消息阈值**，而是复用 `BlockTool` 的工具口径——`previewRows = 10`、`threshold = 20`、`charThreshold = 800`（即 `DEFAULT_BLOCK_CHAR_THRESHOLD`）。错误通常更密集（stack/JSON），更早折叠更合理，且与工具块视觉一致。`CollapsibleTextBlock` 通过 props 接受这三值，error 调用点显式传入工具口径，消息类调用点用消息常量。

### 10.2 交互逻辑（冲突最小化）

| 区块 | 左键 body | 左键 footer | 右键 body | 说明 |
| --- | --- | --- | --- | --- |
| error | toggle（INV-03 guard） | toggle | toggle | 无既有占用，沿用 ReasoningRun body-toggle |
| user message | **保留 → `DialogMessage` 菜单**（INV-04） | toggle（`stopPropagation`） | toggle（body `onMouseUp` 按 `evt.button` 分支） | 左键冲突用独立 footer 点击目标解决；右键由 body `onMouseUp` 的 `evt.button===RIGHT` 分支拦截（用户明确提及） |
| assistant text | toggle（INV-03 guard） | toggle | toggle | 无既有占用；流式遵循 INV-06 |

- **selection guard**：所有 toggle 入口首行 `if (renderer.getSelection()?.getSelectedText()) return`（复制 ReasoningRun:2003 / BlockTool:2776）。
- **overflow guard**：`if (!overflow()) return`，短正文不预写 `expanded`（复制 ReasoningRun:2004-2006）。
- **footer 点击目标**：user message 的 footer `<box>` 自带 `onMouseUp`，调用 `setExpanded(toggle)` 后 `evt.stopPropagation()`，避免冒泡到 body 触发菜单。
- **右键**：`evt?.button === MouseButton.RIGHT` 时 `evt.preventDefault(); evt.stopPropagation(); setExpanded(toggle)`（复制 BlockTool:2777-2782 的右键通道）。user message 的 body `onMouseUp` 当前不接收 evt（`index.tsx:1616` `() => props.onMouseUp(goal)`）；改为 `(evt) => { if (evt?.button === MouseButton.RIGHT) { toggle; stopPropagation } else props.onMouseUp(goal) }`——左键仍开菜单（INV-04 不变），右键改为 toggle。footer 的右键由其自身 `onMouseUp` 处理（同上）。
- **不改键位**：per-block 折叠为鼠标驱动，与 Thinking/工具一致；不新增 keybind。

### 10.3 为何修复了第一处发散

三处第一发散（§8）均为"文本区未接入 disclosure"。`CollapsibleTextBlock` 把已验证的 `ReasoningRun` disclosure 模式以可复用形式接入这三处，根因即被关闭。`measureTextRows` 泛化自 `reasoningRowsTotal`，不引入第二套测量口径。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `ReasoningRun` 折叠 | current | existing compatibility | yes | 不变 | preserve（不合并） |
| `BlockTool` 折叠 | current | existing compatibility | yes | 不变 | preserve（不合并） |
| v2 debug route 的 `UserMessage`/error/`AssistantText` 全量渲染 | current | existing compatibility | yes | 一期一致性收敛 | 一期：迁移到 `CollapsibleTextBlock` |
| v2 debug route 的 `AssistantReasoning` minimal 折叠 | current | existing compatibility | yes | 不变 | preserve |
| 鼠标驱动 per-block 折叠 | proposed | primary-contract branch | yes | 100% | implement |
| 键盘 per-block 折叠 | — | forbidden fallback | — | 0% | reject（无逐条 focus 模型，§2） |

无新增 alternate success path。无用户请求的 rollback。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无 | 三处文本区从未有折叠 workaround | — | — |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 error 折叠 | `AssistantMessage` error 分支 → `CollapsibleTextBlock` | `index.tsx` error 分支 + `collapsible-text.tsx` | 长 error 渲染 `▼ expand (N rows)`，展开后含全文 |
| INV-01 user 折叠 | `UserMessage` 正文 → `CollapsibleTextBlock`（footer-toggle） | `index.tsx` UserMessage + `collapsible-text.tsx` | 长 user 文本渲染 footer，footer 点击展开 |
| INV-01 assistant text 折叠 | `TextPart` → `CollapsibleTextBlock`（body-toggle） | `index.tsx` TextPart + `collapsible-text.tsx` | 长 assistant 正文渲染 `▼ expand`，body 点击展开 |
| INV-02 短正文无 disclosure | `overflow()` 为假时不渲染 footer、不预写 | `collapsible-text.tsx` | 短文本无 `▼/▲`，点击不改变状态 |
| INV-03 selection guard | toggle 入口首行 guard | `collapsible-text.tsx` | 拖选后 mouseup 不触发 toggle |
| INV-04 user 菜单不破坏 | footer `stopPropagation`；body `onMouseUp` 左键分支→菜单保留，右键分支→toggle | `index.tsx` UserMessage | 长 user 文本 body 左键仍弹出 `DialogMessage`，右键展开 |
| INV-05 非持久化 | `createSignal(false)` 局部状态 | `collapsible-text.tsx` | 新挂载默认收缩 |
| INV-06 流式不预写 | `overflow()` 依赖 post-measure；未 overflow 不显示 toggle | `index.tsx` TextPart + `collapsible-text.tsx` | 流式短正文无 disclosure，增长到 overflow 后出现 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `CollapsibleTextBlock` 组件 | INV-01..06 | ReasoningRun/BlockTool 已有模式但内联、不可复用 | 三处文本区无任何折叠代码 |
| `measureTextRows` | INV-01, INV-06 | `reasoningRowsTotal`:1953-1967 为 reasoning 专属 | 当前未导出、未泛化 |
| `MESSAGE_PREVIEW_ROWS=20` 等常量（消息类）+ 工具口径常量（错误类） | INV-01 | 用户"超过十行"放宽至 20 + BlockTool 工具口径 | 三处无阈值常量 |
| footer `▼ expand (N rows)` | INV-01 | ReasoningRun:2046 `▼ expand` | 三处无 footer |
| error header `✕ Error` | INV-01 | error 边框色已有，折叠态需更强信号 | 无 header |
| footer `stopPropagation`（user） | INV-04 | BlockTool 右键 `stopPropagation`:2779 | user body 左键被菜单占用 |
| 右键 toggle | INV-01 | BlockTool:2777-2782；用户明确提及 | 三处无右键 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/collapsible-text.tsx` | add | 新文件：导出 `CollapsibleTextBlock` + `measureTextRows` + 阈值常量。复用 `ReasoningRun` 的测量/限高/footer/selection-guard 模式，参数化 `content`/`fg`/`header?`/`toggleMode`（`body` \| `footer`）。 | +90 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | (a) import `CollapsibleTextBlock`；(b) error 分支（1893-1907）用其包裹 `errorMessage(...)`，传 `header`/`toggleMode="body"`；(c) `UserMessage`（1623）用其包裹正文，`toggleMode="footer"`，body `onMouseUp` 改为接收 evt：左键→`props.onMouseUp(goal)`（菜单保留），右键→toggle+`stopPropagation`；(d) `TextPart`（2107-2150）用其包裹 `<markdown>`/`<code>`，`toggleMode="body"`，流式遵循 INV-06。 | +34 / -8 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 新增 7 个行为切片（见 §16），复用现有 `withRenderedSession` / `waitForFrame` / `findRow` / `clickVisibleText` 夹具。 | +210 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | modify（一期） | `UserMessage`（176-214）正文、error（361-376）与 `AssistantText`（393-449）迁移到 `CollapsibleTextBlock`，收敛两 route 外观。`AssistantReasoning` 不变。 | +18 / -8 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 长 user 文本（>20 视觉行）出现 `▼ expand (N rows)` footer | `UserMessage` 全量渲染无 disclosure | footer 渲染 + 行数断言 | INV-01(user) |
| 2 | 长 user 文本 body 左键弹出 `DialogMessage`（菜单项可见），footer 左键展开全文 | body `onMouseUp` 被菜单占用，footer 无 `stopPropagation` 则会双双触发或不触发 | footer 独立 toggle + body 菜单保留 | INV-04 |
| 3 | 长 error 出现 `▼ expand` + `theme.error` 边框 + `✕ Error` header；展开含全文 | error 分支无 disclosure | header + footer + 展开全文 | INV-01(error) |
| 4 | 长 assistant 正文出现 `▼ expand`；body 点击展开 | `TextPart` 无 disclosure | body-toggle 展开 | INV-01(assistant) |
| 5 | 短正文（≤20 行消息 / ≤20 行错误）无 `▼/▲`，点击不改变渲染 | （应通过，作回归） | 无 footer | INV-02 |
| 6 | 流式短 assistant 正文无 disclosure；增长到 overflow 后出现 `▼ expand` | 需 `overflow()` 跟随测量 | 流式不预写 | INV-06 |
| 7 | 长 user 文本 body 右键展开（不弹菜单）；body 左键仍弹 `DialogMessage` | body `onMouseUp` 未按 `evt.button` 分支，右键会开菜单 | body 右键 toggle + 左键菜单 | INV-04 + N-02 |

测试口径对齐 `session-message-render.test.tsx:940-989`：用 `waitForFrame` 等待文本出现，`findRow` 定位 footer 行，`clickVisibleText` 触发点击，断言 `▼ expand`/`▲ collapse` 与行间距。selection guard（INV-03）以"点击短正文不预写状态"间接覆盖（与 :980-989 同口径），不引入 mock。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~126 | 排除 import、格式、纯移动 |
| Required Chinese explanatory comments `C` | >= 19 | `ceil(126*0.15)=19` |

需中文注释的非显然点：
1. 阈值常量取值理由：消息类 `MESSAGE_PREVIEW_ROWS=20`/`MESSAGE_COLLAPSE_THRESHOLD_ROWS=20`/`MESSAGE_COLLAPSE_CHAR_THRESHOLD=1600`（用户"超过十行"放宽档）；错误类复用工具口径 `previewRows=10`/`threshold=20`/`charThreshold=800`（错误密集，更早折叠）。
2. `measureTextRows` 每次计算释放 native 句柄（复制 `reasoningRowsTotal:1963-1965` 的泄漏防护理由）。
3. `toggleMode="footer"` 存在理由：user body 左键被 `DialogMessage` 菜单占用，必须用独立 footer 目标 + `stopPropagation` 解决冲突。
4. `overflow()` 为假时不渲染 footer、不预写 `expanded`（INV-02/INV-06，复制 ReasoningRun:2004-2006 理由）。
5. error header `✕ Error` 在折叠态的双重信号理由（边框色 + header）。
6. 流式 assistant 正文 `overflow` 依赖 post-measure，未 overflow 不显示 toggle（INV-06）。
7. 右键 `stopPropagation` 与 BlockTool:2779 同通道的理由。
8. TextPart 用 raw markdown（pre-conceal）测量、不引入 `onChunks` 捕获的理由（wrap-mode 固定，仅 gate disclosure；与 ReasoningRun post-conceal 捕获的区别）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | §16 七个切片全绿 |
| `bun test test/cli/cmd/tui/` | `packages/opencode` | 无既有 render 测试回归 |
| `bun typecheck` | `packages/opencode` | `collapsible-text.tsx` 与三处调用点类型通过 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | `collapsible-text.tsx` |
| Files modified | 3（一期） | `index.tsx`、测试、`session-v2.tsx`（一期迁移） |
| Files deleted | 0 | — |
| Production lines | ~120 | 组件 + 测量 + 三处接入 |
| Test lines | ~210 | 7 行为切片 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

### 真实风险

- **OpenTUI renderable 重挂**：`BlockTool` 注释（2746-2751）指出 `<Show>` 销毁后重挂同一 JSX 对象会空白。`CollapsibleTextBlock` 用 `maxHeight+overflow:hidden`（ReasoningRun 路线）而非 `<Show>` 切卸正文，规避该 bug；但展开/收起切换时仍需验证 `<markdown>`/`<code>` 在 `maxHeight` 切换下不空白。一期需在切片 4 验证。
- **测量成本**：`measureTextRows` 每次 memo 计算创建/销毁 TextBuffer。ReasoningRun 已验证可接受；三处新增会放大调用次数。若 profile 显示热点，可对完成态正文按 `completedKey`（`${width}\u0000${content}`，复用 TextPart:2103 口径）缓存测量结果。列为二期优化，不阻塞一期。
- **user footer 与 body 的命中区**：footer 是独立 1 行 `<box>`，需确认 OpenTUI 下 `onMouseUp` 在 footer 行不冒泡到 body。`stopPropagation` 是主防线，切片 2 是回归保护。

### Resolved Decisions (R2)

1. **阈值**：消息类（user + assistant text）= 预览 20 行 / 阈值 20 行 / 字符 1600；错误类 = 工具口径（预览 10 / 阈值 20 / 字符 800），默认收缩 + `✕ Error` header。
2. **footer 文案**：统一 `▼ expand (N rows)` / `▲ collapse`。
3. **v2 debug route**：一期一并迁移 `session-v2.tsx` 的 `UserMessage` 正文与 error。

> 说明：用户对"错误默认态"的答复为"且收缩阈值跟随普通工具而非用户消息阈值"。本方案解读为：错误默认**收缩**（与推荐项一致，非默认展开），但阈值复用 `BlockTool` 工具口径而非消息阈值。若解读有误请纠正。

### 非阻塞 speculative

- 未来若引入消息逐条 focus，可补键盘 `space`/`enter` toggle（与 `dialog.tool.toggle` 同键）。当前不引入。
- 未来若 `previewText` 的 `…` 风格需要统一，可将 footer 也改为 `…` 收尾。当前保留 `▼/▲` 字形以与 reasoning 一致。

## Audit Contract

- 仓库根：`/Users/sunbenteng/Project/opencode`
- Canonical plan：`docs/plans/message-text-collapse-expand.md`
- Audit mode: plan
- 用户需求原文：见 §1。

## Audit Record

- R2 audit（已被 R3 实质性变更取代）：
  - Revision audited: R2
  - Auditor: `adversarial-auditor` (independent, task `ses_05bb08dafffeejyT5WIePgNgjh`)
  - Verdict (verbatim): `No blocking findings.` / `APPROVE for Revision R2.`
  - 6 non-blocking findings N-01..N-06；R3 已折入 N-01（v2 AssistantText 补入迁移）、N-02（user body 右键 toggle 机制明确）、N-03（TextPart 测量口径明确）、N-04/05/06（记录修正）。
- R3 audit:
  - Revision audited: R3
  - Auditor: `adversarial-auditor` (independent, task `ses_05b2f532bffeBPjXtI2NtaZ2fx`)
  - Verdict (verbatim): `No blocking findings.` / `APPROVE for Revision R3.`
  - Evidence: auditor independently reconstructed `ReasoningRun` (1944-2052), `BlockTool` (2700-2832), legacy error (1893-1907), `UserMessage` (1561-1691, 1389-1400), `TextPart` (2098-2154), v2 route (176-214, 361-449, 393-449), `error.ts`, `keybind.ts`, test helpers (3437/3615/3639/3645). All citations verified.
  - 3 non-blocking findings（实施时注意，不清空 approval）：
    - R3-N01: §7 INV-03 的"Existing test"引用 `:980-989` 实为 overflow-guard（INV-02）测试，非 selection-guard；`clickVisibleText` 预 `clearSelection` 无法触发 selection 分支。与 ReasoningRun/BlockTool 同覆盖级别。建议实施时在 §7 标注"无直接测试"。
    - R3-N02: §10.2 伪代码 `props.onMouseUp(goal)` 应为 `props.onMouseUp(goal() !== undefined)`（boolean），否则 truthy function 会让非 continuation 消息误进 Revert-only 过滤。实施时按 boolean 传参。
    - R3-N03: `measureTextRows` 与 `reasoningRowsTotal` 有 ~5 行体重复，但因 §2 禁改 ReasoningRun + 跨模块私有 + 输入形态不同（`string` vs `string[]`），属可接受设计偏好。
- 实施许可：`Implementation allowed: yes`（计划已批准）。但本 GOAL 终态为 `approved-plan-only`，用户明确不实施，故不进入阶段 3，标记 GOAL complete。

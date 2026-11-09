# Canonical Implementation Plan: BlockTool 折叠所有权全量收敛（复刻 dev-smark 容器自有机制）

> Status: verified
>
> Revision: R17
>
> Approved revision: R17
>
> Audit mode: full-scope
>
> Requirement source: 用户口头需求（见 §1 引用）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-09
>
> Revision history: R1-R9 为错误段折叠方案的多轮修订（详见文末 Audit Verdict Record）。R10 获批后，用户明确扩大范围：不只是错误段，而是把整套折叠所有权从各工具卡片收敛回 BlockTool（§1 新增逐字需求），R10 的批准因范围变更失效。R11 按 dev-smark 全量移植容器自有折叠机制，卡片退回纯申报；R10 的 denied 豁免、错误行独立点击目标等错误段专属分支逻辑全部取消（用户："你不要去自己去写两套 owner，或者说两套分支逻辑"）。R11 审计 BLOCK：B-01 可空 useContext+无 Session 回退不属于 dev-smark 机制（其本地 signal 仅覆盖缺键）；B-02 snapshot harness 的 edit fixture 仍是旧合同（条件 preview、无 totals）。R12：`use()` 原样保留、测试挂载一律提供真实 context.Provider、snapshot edit fixture 改 totals+preview 申报；ApplyPatch 沿用当前完整键；同步 index.tsx:249 反向注释；补录 red 环重跑命令。R12 审计 BLOCK（编辑残留+验证设计）：B-01 §7/§13/§16 残留 R11 的可空 context/无 Provider 表述，与 §10.1 互斥；B-02 原始 red harness 未挂 Provider 且断言只能红不能绿。R13 统一为 `use()` 原样 + 全部挂载真实 Provider；red harness 补 Provider 并将症状断言改为修复前红/修复后绿的行为断言（仅 harness，不动生产）；§21 批准 revision 记录修正。确认审计（R13）APPROVE（No blocking findings），原样记录 verdict 并置批准状态；折入 NB-01/NB-02 记录修正。R13 获批后用户要求：不新增行为测试文件（新 slice 并入既有测试文件）、全面排查既有测试是否变红、测试逻辑变化保持克制。R14：取消新增测试文件，7 个 slice 并入既有 block-tool-collapse.test.tsx；补全测试排查结论（session-message-render 等集成测试预期零改动保持绿色）；ApplyPatch preview 条件化以保持无 patch 删除摘要现状；R13 批准随本次修订失效，需重审。R14 审计 APPROVE（No blocking findings），原样记录 verdict 并置批准状态；折入 NB-01（auto-review-render 工具卡接触面补全）/NB-02（§1 补录新需求原文与日期）记录修正。R14 实现审计 BLOCK：B-01 逐文件隔离测试自行传入 stateKey，绕过真实 ApplyPatch producer。R15 仅修正测试 seam：容器 store 恢复留在 block-tool-collapse，真实双文件长 patch 隔离移入既有 session-message-render；不新增测试文件、不改生产设计，需重审。R15 方案审计 BLOCK：§21 仍要求批准 R14 且终态残留 approved-plan-only。R16 将批准目标与终态统一为当前 R16 / verified-implementation-and-commit；同步无 totals 的错误条件说明及 notebook affordance 注释，需重审。R16 方案审计 BLOCK：§1 仍把 approved-plan-only 标为现行约束。R17 明确废止旧终态，统一为 verified-implementation-and-commit，并修正 E/C 文件统计口径，需重审。

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户本次的范围收敛指令（逐字，2026-11-07）：

> 请注意一点，我们之前已经说过了，要和这个，要把相应的折叠 owner 归到 Block Tool 里面。也就是说，不要只是去改 Block Tool，让巴拉巴拉巴拉巴拉。也就是说相应的，比如说各个工具，那本质上我们之前的就主线，既然上游就没有去写折叠机制，那我们只是当前的分支去合并的时候把它写到了各个工具卡片。那我们现在要去把它再收敛到这个 Block Tool 里面作为 owner。然后按照这个 owner 逻辑呢，本质上你什么错误啊，还有什么这个输出正文啊，巴拉巴拉这些东西都不用去具体管它的这个情况。那本身呢，它的折叠就是，它这反正所有这些东西只要超长了，或者说超字数了，它就直接折叠就完了。所以这些东西都是放到一块去折叠的，它本身是一个外部的一个容器，这样折叠就会非常容易。你不要去自己去写两套 owner，或者说两套分支逻辑。请注意一点，我说过了，要收敛到 Block Tool 里面。然后当然那个 inline tool 不需要去管。

用户同时确认的旧主线模型（逐字引用用户认可的分析）：

> 旧主线 dev-smark（你印象中的"好机制"）：通用卡片 BlockTool 是折叠 owner。工具卡片只申报：totalLines/totalChars/maxLines/threshold/preview；BlockTool 自己算 collapsible、把 expanded 存进 Session 级 interaction store、点击切换、body 折叠即卸载（native 资源释放）、preview 区 visible 切换、"Click to expand/collapse" 提示。语义集中在一处，所有工具卡片白拿。

既有的移植方式约束（逐字，仍然有效）：

> 相应的内容尽量去复刻……代码尽量保持它那套逻辑呢和我们原逻辑一致。当然如果原分支的逻辑呢，有一部分这个内容是有一定的小问题的，你也可以适当去进行一点点的调整。但是请尽量避免去自己去写一套机制，保持就是避免自己去造轮子。

> 请注意一点，说过了很多遍，保持 HUNK，保持修改简洁。如果有大量东西出现在几处，那请你思考你的修改的模式是不是有一点过于 heavy……按理来说是一个 unified 的一个非常 simple 的一套逻辑，不应该是非常 heavy。

本次终态（用户 2026-11-09 提供的 workflow）：`verified-implementation-and-commit`。此前的 `approved-plan-only` 约束已从当前 GOAL 废止，不再允许方案获批后提前停止；历史审计记录中的旧终态引文仅作历史保留。

用户症状（逐字，调查起点）：

> 我当前经常发现有一些命令呢，它执行的时候报了大量的错误，它的错误甚至占满了整个屏幕。

> 按理来说相应那个错误，它如果去报错的话，它不应该走默认的那套。我们这个TUI有一套折叠语义，也就是说，一个工具它如果报错了，它会直接在那个错误里，它会把错误折叠到工具的下面，点击工具才会把那个错误去展示出来。

测试面新要求（用户逐字，2026-11-08）：

> 你 Play 中是否有检查相应的既有测试，或者说其他的相关测试逻辑，是否会涉及到相应的工具，等等的一些状态逻辑，是否考虑到，或者说会引入一些既有测试变成红色。也就是除了你已经适配的五个测试之外，还有没有其他的一些问题。同时我不建议你新增行为测试文件，应当将新的行为测试仍然放在旧的，或者说放在你旧的那个逻辑里面。就是说你不要试图去新增测试文件。

> 相关测试逻辑变化请保持克制。

## 2. Explicit Non-Goals

- `InlineTool`/`InlineToolRow`：用户明确"那个 inline tool 不需要去管"。其 `errorExpanded` 行为保持原样。
- 卡片**内容**（children、preview 的具体构成）：不做 dev-smark 内容级回迁（如 Diagnostics 组件、删除摘要样式等）；本任务只收敛折叠**所有权与机制**，卡片现有内容保持不变。
- 数据层错误文本限长、Prompt 层引导：延续既有 non-goal，用户未授权。
- denied 错误的单独豁免：**取消**。用户明确"什么错误啊……都不用去具体管它的这个情况""不要两套分支逻辑"。denied 不再单独判定；短 denied 错误随"未超阈值全显"自然全显，长 denied 错误随容器折叠。
- 第二套状态路径、错误行独立点击目标、错误专属预览分支（R10 方案）：全部不实施，被统一容器机制取代。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/guides/workflow.md` | 本次终态 `verified-implementation-and-commit`：方案批准、实施与验证、独立实现审计均通过后，仅提交本 GOAL 文件。 |
| `.opencode/policy/first-principles-engineering.md` | 证据分类、单一 primary path、reverse traceability、禁止 fallback。 |
| 根 `AGENTS.md` | 测试/typecheck 从包目录运行；风格约束。 |
| 旧主线分支 `dev-smark`（HEAD 26061b595b31） | **全量移植来源**：`BlockTool` 容器自有折叠机制的完整实现与各卡片申报形态。 |
| 上游 `upstream/dev` | 其 `BlockTool` 无折叠机制，当前分支的卡片级折叠是合并时分散写入的——用户据此要求收敛回容器。 |
| `packages/tui/test/routes/session/shell-output-spacing.test.ts` | 锁定当前 dev1-smark 形态的源码断言；本次用户指令的机制恢复将使其失效，须随计划更新（§15）。 |
| `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | 源码执行 harness（正则抽取 + `new Function` + 依赖注入）；其 `use()` 假实现已携带 interaction store，兼容 dev-smark 形态（§15 依赖核对）。 |
| `docs/plans/block-tool-error-collapse-port.md` R10 及以前各轮审计 | 被本 revision 取代；错误段专属设计不再执行。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| dev-smark 导出副本 `BlockTool` 全文（3199-3341） | **移植蓝本**：props（maxLines/threshold/totalLines/totalChars/charThreshold/preview/stateKey 等）、`collapsible` 同步公式、`expanded`（`ctx.interaction` + stateKey/localExpanded 回退）、preview 区 visible 切换、body 折叠卸载、affordance、根 `onMouseUp`（auto-review -> selection -> RIGHT -> collapsible toggle + `props.onClick?.()`） | observed |
| dev-smark 各调用点（GenericTool 2864/2879、PermissionReviewDecision 3439（maxLines=0）、Shell 3393、Write 3535/3561、Edit 3850、ApplyPatch 3954（stateKey 逐文件）、TodoWrite 4025、Question 4054） | 卡片申报形态蓝本：totals + preview + stateKey，无自有折叠状态 | observed |
| 当前 `packages/tui/src/routes/session/index.tsx` 的 `BlockTool`（3296-3398）与各卡片机制（Shell 3400-3480、Write 3555-3640、Edit 3990-4035、ApplyPatch 4100-4155、GenericTool 2730-2810） | 待收敛的分散实现：每卡自有 `expanded`（useInteraction）、`canCollapse` sticky、`collapsed`/`limited`/`overflow` 计算、`onClick`/`footer`/`preview` 接线；错误段 3392-3396 无条件全显 | observed |
| `packages/tui/src/routes/session/index.tsx:574、588-591、1786` | Session `interaction` store：`get = interaction[key] ?? false`（缺键=false=收缩），与 dev-smark 键 `expanded:${part.id}` 兼容 | observed |
| 当前 ApplyPatch 逐文件键（index.tsx:4119 `expanded:${part.id}:${file.filePath}`） | 逐文件区分键的现行 producer——dev-smark `stateKey` 的需求为 observed（不再是 speculative） | observed |
| `packages/tui/src/util/collapse-tool-output.ts`、`previewText`（index.tsx:2721-2724） | 预览截断工具，卡片申报 preview 内容时复用；无新常量 | observed |
| `opencode.db` 34KB 错误 part（prt_1ac89f91e0013foeCoQIHRtiPc）与隔离 red 反馈环（.temp/tui-harness，已运行复现症状） | 原始症状证据：超长错误全量刷屏；统一容器折叠后该症状消失 | observed |
| `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx:338-470` | harness 依赖核对：`use()` 假实现已含 interaction store；`previewText` 在抽取清单、`collapseToolOutput` 在依赖表；dev-smark 形态无需新增注入 | observed |
| 三个既有 headless 测试（block-tool-collapse/preview-once/visible-once） | 其 fixture 不挂 Session、不传 totals——移植后须改为申报合同（totals）但保留原行为断言意图（§15/§16） | observed |

## 5. Current Behavior

当前 dev1-smark 的折叠职责**分散在各工具卡片**（合并上游时写入）：

```text
Shell/Write/Edit/ApplyPatch/GenericTool 各自持有：
  expanded（useInteraction，expanded:${part.id}）
  canCollapse sticky（#111，溢出后粘住）
  collapsed/limited/overflow 计算（collapseToolOutput/previewText）
  onClick（toggle）+ footer（"Click to collapse"）+ preview 条件节点
BlockTool 仅作机制框架：preview 存在即折叠，不拥有状态；
  错误段（3392-3396）无条件全量渲染，不在任何折叠管辖内
```

dev-smark 的目标模型（用户指定恢复）：`BlockTool` 容器统一 own——卡片只申报 totals/preview/stateKey；容器算 collapsible、存 expanded、切换 preview/body、渲染 affordance、处理点击。错误目前不在容器内（dev-smark 也如此），本次按用户指令把错误并入容器统一折叠（移植的既定调整，§10.2）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 超长正文（长命令/长输出/长 diff） | 各工具卡片 | 无 | 卡片 totals -> 容器 collapsible | `BlockTool` | observed |
| 超长错误（如 34KB base64） | spawn 失败 -> `failToolCall` 原文写入 | 无 | `part.state.error` -> 容器统一折叠（错误行数/字符由容器并入 totals） | `BlockTool` | observed |
| 短正文/短错误（含短 denied） | 各工具 | 无 | 未超阈值 -> 全显无 affordance | `BlockTool` | observed |
| 长 denied 错误（已进入 BlockTool 且文本含 denied 者） | 权限拒绝等长文本错误（observed） | 无 | 随容器折叠（无豁免，§2）。注意 Shell preflight denied 在 `metadata.output` 写入前失败时走 `InlineTool`（豁免，不在本计划端到端承诺内，NB-02 记录修正） | `BlockTool` | observed |
| `part` 缺省（stateKey 缺席） | headless 测试挂载（挂 Provider） | — | dev-smark 原生本地 signal 回退（仅缺键语义） | `BlockTool` | observed |
| Session context 缺席 | 仅无 Provider 的测试挂载，非生产形态 | — | `use()` 抛错——测试挂载一律提供真实 `context.Provider`，生产不存在此形态 | 测试 harness | observed |
| apply_patch 逐文件多卡 | `ApplyPatch`（现行键 index.tsx:4119） | 同 part 多卡 | `stateKey=${part.id}:${file.filePath}` 逐文件隔离 | `BlockTool` | observed |
| PermissionReviewDecision | 审查决策卡 | — | `maxLines=0` 显式不折叠（dev-smark 3439 同款） | `BlockTool` | observed |
| TodoWrite/Question | 列表卡 | — | 不传 totals 且无超阈值错误时不折叠（dev-smark 同款）；超阈值错误仍并入容器预算 | `BlockTool` | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 容器统一折叠：正文+错误合计超阈值（默认 20 行或 800 字符）时默认收缩，显示预览 + `Click to expand`；点击容器切换展开/收起 | 用户症状与本次指令；dev-smark collapsible 公式 | 无（本计划新增/更新） |
| INV-02 | 未超阈值内容（含短错误、短 denied）全显且无 affordance | 现状保持 | 新增 preserve 断言 |
| INV-03 | 文本拖选时点击不 toggle；右键走独立通道不 toggle | dev-smark 根处理器守卫 | 既有/新增断言 |
| INV-04 | 展开状态存 Session `interaction` store（`expanded:${part.id}`，`stateKey` 可覆盖逐文件区分），缺键=false；仅 stateKey 缺席时走 dev-smark 原生本地 signal 回退；Session context 一律由真实 `context.Provider` 提供（生产与测试均不引入无 Session 状态语义） | store 缺键语义（index.tsx:589）；dev-smark stateKey/localExpanded | 新增 slice |
| INV-05 | 单一 owner、单一分支逻辑：正文与错误共用同一 collapsible/expanded/affordance/点击路由；不存在错误专属第二机制 | 用户逐字指令 | 新增 slice（长命令+长错误同容器一次折叠） |
| INV-06 | 折叠时 body 卸载（native 资源释放）；preview 树单次构造复用（65535 handle 保护）；collapse->expand->collapse->expand 内容不空白 | dev-smark 注释与既有三 headless 测试意图 | 三个更新后的既有测试 |
| INV-07 | 卡片 children/preview 内容与 InlineTool 行为不因所有权收敛改变 | 用户 non-goal | 既有快照/行为测试 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/05 | 折叠职责分散在各工具卡片（owner 错位），且错误段（index.tsx:3392-3396）从未进入任何容器折叠 | `BlockTool`（容器）应为唯一 owner | 现状逐卡机制清单（§5）；dev-smark 蓝本对照 |

Red-capable 反馈环（已实际运行）：`.temp/tui-harness/block-tool-error-red.test.tsx`——6000 字符单行错误在 80x100 视口全量渲染约 78 行（TAIL-MARKER 可见、无 affordance）；短/denied 基线绿。该症状在统一容器折叠下由 slice 1 锁定。

根因：dev1-smark 合并上游时把折叠拆到了卡片层（上游无此机制），失去 dev-smark 的容器自有单一语义；错误段则在三个背景（上游/dev-smark/dev1-smark）中都未入容器。修复=恢复容器自有机制并把错误并入，非新增第二套机制。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| collapsible 计算、expanded 状态、preview/body 切换、affordance、点击路由、错误文本并入 totals | `BlockTool` | 通用卡片容器；用户指定唯一折叠 owner | 一处生效、所有卡片白拿；用户逐字要求 | 卡片分散持有正是被修复的错位 |
| totals/preview 内容/stateKey 申报 | 各工具卡片（Shell/Write/Edit/ApplyPatch/GenericTool 等） | 声明式 props | 只有卡片知道内容语义（diff preview、code preview 等） | 容器不应理解各工具内容结构 |
| 展开状态持久化 | Session `interaction` store | 键值布尔，缺键=false | 正文已用 `expanded:` 键，兼容 | 本地 signal 无法跨 owner 重建 |
| 截断数学 | `previewText`/`collapseToolOutput` | 行数+字符双门 | 既有工具 | 自写=造轮子（用户禁止） |

## 10. Single Approved Primary-Path Design

### 10.1 BlockTool 全量移植（dev-smark 逐件复刻）

1. **Props**：dev-smark 原样——`title/children/onClick/onRightClick/part/spinner/contextView/contextLabel/maxLines/threshold/totalLines/totalChars/charThreshold/preview/autoReview/stateKey`。当前 `footer` prop 废除（内置 affordance 取代）；调用点不再传 `footer`。
2. **collapsible**：dev-smark 同步公式（首帧即判定，不用 effect），`previewLines<=0` 时不折叠；`maxLines` 默认 10、`threshold` 默认 20、`charThreshold` 默认 `DEFAULT_BLOCK_CHAR_THRESHOLD`。**调整点（用户指令）**：容器自行把 `part.state.error` 的行数/字符并入 totals——错误无需卡片申报。
3. **expanded 状态**：dev-smark 原样——`use()` 取 ctx（不做可空改造），`stateKey ?? expanded:${part.id}`，`ctx.interaction` 读写；`localExpanded` **仅覆盖 stateKey 缺席**（dev-smark 原生语义，不扩展为无 Session 回退）。真实 headless 测试挂载一律提供真实 `context.Provider`（reasoning-disclosure.test.tsx:38-72 的响应式形态），保证 `use()` 不抛错；源码抽取式 harness 沿用其注入式 `use()` 假实现（§10.3，NB-01 记录修正）；生产中带 part 的 `BlockTool` 恒在 Session Provider 内。
4. **JSX 结构**：dev-smark 原样——preview 区 `visible` 切换、body 区折叠即卸载（无 preview 时保留 maxHeight 裁剪兼容 TodoWrite 等）、affordance 内置（`Click to expand/collapse`）、`marginTop={1}` 单一间距策略。
5. **根 `onMouseUp`**：dev-smark 原样——auto-review -> selection -> `MouseButton.RIGHT`（无 onRightClick 直接 return；有则 preventDefault+stopPropagation+调用）-> `if (collapsible()) setExpanded(toggle)` -> `props.onClick?.()`。
6. **错误并入容器**：错误全文渲染在 body 区（children 之后），折叠时随 body 卸载；preview 区在卡片 preview 之后追加错误的截断预览（同一 `previewText` 预算）。无 denied 判定、无错误专属状态、无错误行独立点击目标——点击容器即整体切换。

### 10.2 卡片收敛清单（删除分散实现，退回纯申报）

| 卡片 | 删除 | 申报（对齐 dev-smark 调用点） |
| --- | --- | --- |
| Shell | `expanded`/`shellCanCollapse`/`collapsed`/`limited`/`footer` | `maxLines={isRunning()||showContextOutput()?0:10}`、totals(shellPreviewText)、`preview={<text>{previewText(shellPreviewText(),10)}</text>}`；保留 onRightClick/contextView/contextLabel |
| Write（覆写 diff） | `expanded`/`diffOverflow`/`footer` | totals(diffStats.total, diff.length)、preview=DiffPreview(previewDiff(diff,10)) |
| Write（内容） | `expanded`/`writeCanCollapse`/`collapsed`/`limited`/`footer` | totals(code)、preview=line_number code(previewText(code,10)) |
| Edit | `expanded`/`overflow`/`footer` | totals(stats.total, diffContent.length)、preview=DiffPreview |
| ApplyPatch（逐文件） | `patchExpanded`/`patchOverflow`/`onClick`/`footer` | `stateKey={\`expanded:${part.id}:${file.filePath}\`}`（沿用当前完整键，隔离维度与前缀均不变）、totals(file.patch)、`preview={file.patch ? <DiffPreview .../> : undefined}`（无 patch 的删除摘要仍由 body 内既有 Show fallback 呈现，现状不变）、autoReview=false |
| GenericTool（notebook block） | `expanded`/`notebookOverflow`/`footer` | view().maxLines/threshold/totalLines/totalChars/preview，body=view().body() 工厂 |
| GenericTool（通用输出） | `expanded`/`collapsed`/`limited`/`footer` | totals(output)、preview=previewText(output,10) |
| PermissionReviewDecision | 无（当前无机制） | 补 `maxLines={0}`（dev-smark 3439 同款，显式不折叠） |
| TodoWrite/Question | 无 | 不变（不传 totals；无超阈值错误时不折叠） |

`useInteraction` 在这些卡片中的调用随删除消失（BlockTool 直接读写 store，键不变）；`previewText`/`collapseToolOutput`/`DiffPreview`/`previewDiff` 继续用于申报内容。同一 hunk 更新 index.tsx:249 的陈旧注释（"不把折叠职责搬回BlockTool"）为收敛后的真实责任说明（正文与错误折叠均归容器）。

### 10.3 既有测试的适配

- 三个 headless 测试（collapse/preview-once/visible-once）：fixture 改为申报合同（传 totals + preview）并挂载响应式 `context.Provider`（保证 `use()` 可用），行为断言意图保留（collapse 循环内容完整、preview 单次构造、native handle 纪律）；不再由调用方 onClick 驱动展开（容器自行 toggle）。
- `shell-output-spacing.test.ts`：源码断言更新为恢复后的机制形态（`collapsible`/`collapsed=collapsible()&&!expanded()`/`hasPreview`/无第二套卡片状态），间距与 preview 单次构造等有效断言保留。
- `inline-tool-wrap-snapshot.test.tsx`：**需适配 edit fixture**（第 11 轮 B-02）：edit 分支由"条件 preview + 调用方 expanded 驱动"改为 totals + preview 申报合同，affordance 断言由容器自身 toggle 支撑；`use()` 假实现已含 interaction store，无需新增 context 注入；auto-review 导航与点击行为断言保留。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `InlineTool` 错误 `errorExpanded` | current | existing compatibility（用户豁免） | yes | inline 路径 | preserve |
| 未超阈值全显（含短错误/短 denied） | current | primary-contract branch | yes | 不可折叠时唯一路径 | preserve |
| 本地 signal 回退（仅 stateKey 缺席） | dev-smark 原有 | primary-contract branch（dev-smark 原生 localExpanded） | yes | 无 part 挂载 | adopt（移植原样；不扩展为无 Session 回退） |
| `maxLines=0` 不折叠（PermissionReviewDecision） | dev-smark 原有 | primary-contract branch | yes | 审查决策卡 | adopt（复刻） |
| 无 totals 且无超阈值错误不折叠（TodoWrite/Question） | dev-smark 原有 | primary-contract branch | yes | 列表卡 | preserve |
| R10 的错误段专属机制（denied 豁免/错误行 handler/独立 errorExpanded 键） | R10 曾批准 | 被用户本次指令取代 | — | — | reject（不实施） |
| 数据层错误限长 / Prompt 引导 | 未授权 | out of scope | — | — | reject |

无 forbidden fallback；无替代成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 各卡片分散的 `expanded`/`canCollapse`/`collapsed`/`limited`/`overflow`/`footer` 机制 | dev1-smark 合并上游时逐卡补写折叠 | 收敛为容器单一实现 | 各卡片（§10.2 清单） |
| 错误段无条件全显（index.tsx:3392-3396） | 从未接入容器 | 错误并入容器 body/preview | `BlockTool` 错误段 |
| `BlockTool` 的 `footer` prop | 卡片外置 affordance 文案 | 容器内置 affordance | `BlockTool` props 与各调用点 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 容器统一折叠 | `BlockTool` collapsible 公式（含错误并入）+ preview/body 切换 + affordance | index.tsx `BlockTool` | block-tool-collapse.test.tsx 并入的 slice 1/7 及其既有更新断言 |
| INV-02 未超阈值全显 | collapsible=false 分支 | 同上 | 同文件 slice 2 |
| INV-03 selection/右键守卫 | 根 `onMouseUp`（dev-smark 原样） | 同上 | 同文件 slice 4 |
| INV-04 store 持久化与回退 | `use()`（dev-smark 原样）+ `interaction` store + 仅缺键的本地回退；测试挂载真实 Provider | 同上 | block-tool-collapse 的 store 恢复/缺键 slice + session-message-render 的真实 ApplyPatch 双文件隔离 |
| INV-05 单一 owner 单一逻辑 | 错误并入同一容器，无第二机制 | 同上 | 同文件 slice 7（长命令+长错误一次折叠） |
| INV-06 资源纪律 | body 折叠卸载、preview 单次构造 | 同上 + 三个既有测试 fixture 更新 | 更新后的三个 headless 测试 |
| INV-07 内容与 InlineTool 不变 | 只动所有权 props | 各卡片 | inline-tool-wrap-snapshot 等既有测试 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `BlockTool` 全套 props 与 collapsible/expanded/preview/body/affordance/点击路由 | INV-01/03/04/05/06 | dev-smark 3199-3341 完整蓝本（observed） | 当前容器无状态，卡片分散实现必须收敛 |
| 错误行数/字符并入 totals + 错误随 body/preview 折叠 | INV-01/05 | 用户"放到一块去折叠"逐字指令 | 现状错误段在容器外 |
| `stateKey` 逐文件键 | INV-04 | 现行 ApplyPatch 键（index.tsx:4119，observed） | 同 part 多卡共享键会串状态 |
| 真实 headless 测试挂载一律提供真实 `context.Provider`（源码抽取式 harness 沿用注入式假 `use()`） | INV-04 验证要求 | reasoning-disclosure.test.tsx:38-72 的响应式 Provider 形态（observed）；`use()` 在无 Session 时抛错（observed） | 生产容器不兼容测试环境；可空 context/无 Session 回退属 test-only（第 11 轮 B-01 否决） |
| 三个 headless 测试与 shell-output-spacing 断言更新 | INV-06 | 它们锁定的是被取代的 dev1-smark 形态（observed） | 机制恢复后旧断言必然失败，须随合同更新 |

无其它新概念；无新常量；无新组件。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/tui/src/routes/session/index.tsx` | modify | `BlockTool` 全量移植为 dev-smark 容器自有机制（含错误并入）；§10.2 各卡片收敛为纯申报 | BlockTool 约 +150/-90；卡片约 +40/-120 |
| `packages/tui/test/routes/session/block-tool-collapse.test.tsx` | modify | fixture 改申报合同（totals+preview）并挂真实 Provider；并入 slice 1-4/6-7 与 slice 5 的容器 store 恢复（用户：不新增测试文件） | 约 +130/-40 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | modify | slice 5 的真实 ApplyPatch 双文件长 patch 隔离：测试不提供 stateKey，验证生产 producer -> 逐文件键 -> 容器消费 | 约 +30 |
| `packages/tui/test/routes/session/block-tool-preview-once.test.tsx` | modify | 同上（preview 单次构造断言保留） | 约 ±15 |
| `packages/tui/test/routes/session/block-tool-visible-once.test.tsx` | modify | 同上（visible/挂载纪律断言保留） | 约 ±15 |
| `packages/tui/test/routes/session/shell-output-spacing.test.ts` | modify | 源码断言更新为恢复后机制形态；有效间距/preview 断言保留 | 约 ±25 |
| `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | modify | edit fixture 改 totals+preview 申报合同、移除调用方 expanded 驱动；auto-review 与点击断言保留（第 11 轮 B-02） | 约 ±20 |
| `packages/tui/src/routes/session/notebook-tool.tsx` | modify | 仅注释：footer 已删除，折叠提示归容器内置 affordance（R15 NB-02） | ±1 |

**不新增任何测试文件**（用户指令，R14）；新增行为断言全部并入上表既有文件。

既有测试全量排查结论（R14，逐文件证据）：

| 测试 | 与本机制的接触面 | 处置 |
| --- | --- | --- |
| `test/cli/cmd/tui/session-message-render.test.tsx` | :338-367 七种卡片折叠循环与间距；Write 折叠预览行号/语法色；100 次收放帧一致与 renderable 数稳定；屏外释放后 expanded 状态恢复；无 patch 删除卡；新增真实双文件长 patch 隔离 | 既有断言**零改动**；仅新增 slice 5 的真实 ApplyPatch 集成测试（R15 实现审计修正），若既有断言变红先查申报等价性，不得改断言迁就 |
| `test/routes/session/auto-review-render.test.tsx` | :1178 的 expanded 注释属推理折叠（Thought/▼ 展开查看完整推理）；:158-245 真实 Shell 长输出折叠与 `Click to expand`；:386-449 Edit 等工具卡审查导航并断言导航后无 `Click to collapse` | 零改动（30 行输出仍超阈值；根处理器保持 auto-review 导航优先于折叠切换，NB-01 补全） |
| `test/cli/tui/inline-tool-wrap-snapshot.test.tsx:684` | `errorExpanded` 快照走 InlineTool（:91-106），属豁免范围 | 零改动（仅 edit fixture 适配，见上表） |
| `diff-viewer-file-tree`/`context-usage`/`prompt-submit-transport` 等 | expandedNodes/footer 与工具卡无关 | 零改动 |
| `collapseToolOutput`/`previewText` 相关单测 | 工具函数不变 | 零改动 |

不改动：`InlineTool*`、各卡片 children/preview 内容、任何数据层文件。

隔离验证 harness（gitignore 区，不计入 diff 预算）：`.temp/tui-harness/block-tool-error-red.test.tsx` 适配为可闭环形态——挂载补真实响应式 `context.Provider`（`use()` 需要）；长错误用例的 red-only 症状断言（帧含 TAIL-MARKER）改为修复前红/修复后绿的行为断言（默认收缩无尾部标记 + `Click to expand`，点击展开全文）；短/denied 基线保留。仅 harness 适配，不改变生产状态合同（第 12 轮 B-02）。

## 16. TDD Behavior Slices

公共 seam：slice 1-4/6-7 与 slice 5 的容器 store 恢复并入既有 `packages/tui/test/routes/session/block-tool-collapse.test.tsx`；slice 5 的真实逐文件隔离并入既有 `session-message-render.test.tsx`（R15，不新增测试文件）。headless `testRender` 挂载均挂真实响应式 `context.Provider`（复刻 reasoning-disclosure.test.tsx:38-72）；slice 6 为挂 Provider 但无 part（stateKey 缺席）的缺键场景，不存在无 Provider 挂载。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 长命令（正文超阈值）+ 长错误（6000 字符）同卡：默认一次收缩（错误截断预览 + 单一 `Click to expand`）；点击容器展开全部内容；再点击收缩 | 现状错误段全显、卡片各自折叠（两套逻辑） | 容器统一折叠，错误并入 | INV-01/05（原始症状闭环） |
| 2 | 短错误全显无 affordance；短正文全显 | 现状即绿（preserve） | 不得变红 | INV-02 |
| 3 | 长 denied 错误（含 denied 子串 + 尾部标记，>800 字符）随容器折叠：截断预览 + affordance；短 denied 全显 | 现状全显（长 denied 也无折叠）；语义变更见 §2/§20 | 无 denied 豁免，统一容器行为 | INV-01/02/05 |
| 4 | selection 非空不 toggle；右键不 toggle 且走既有右键通道 | 现状无容器 toggle | 根处理器 dev-smark 原样守卫 | INV-03 |
| 5 | 展开后卸载/重建（同一 store）状态恢复（block-tool-collapse）；以真实 Session -> ApplyPatch -> 两个超阈值文件卡验证独立收放，测试不传入 stateKey（session-message-render） | 现状卡片各自持有状态 | store + 真实 producer 生成的逐文件键隔离 | INV-04 |
| 6 | 挂 Provider 但无 part（stateKey 缺席）的挂载：dev-smark 原生本地 signal 回退可用，折叠/展开行为正确 | 现状无容器状态 | 原生回退（仅缺键语义；无 Session 形态已从设计中删除） | INV-04 |
| 7 | 长命令+长错误同卡只出现一个 affordance、一次 toggle 同时展开正文与错误 | 现状正文/错误分离（错误全显） | 单一容器单一 affordance | INV-05 |

既有三个 headless 测试与 snapshot/源码断言测试的更新以"原断言意图保留 + 新合同可执行"为准。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 450 | 政策口径：production 实质新增/修改约 190 + tests 约 260（六个既有测试文件适配与集成 slice，无新增文件）；排除空行、import-only、格式化、纯移动 |
| Required Chinese explanatory comments `C` | >= 68 | `max(1, ceil(450 * 0.15))`；实现审计硬地板 `C/E >= 0.10`（即 C >= 45） |

计划注释点：

1. `BlockTool` 容器自有折叠的移植出处（dev-smark 行号级对应），用户指定的 owner 语义。
2. 错误行数/字符并入 totals 的原因（用户"放到一块去折叠"）；无 denied 豁免的指令依据。
3. `use()` 按 dev-smark 原样保留的原因（可空 context/无 Session 回退属 test-only，已被审计否决）；测试挂载一律提供真实 `context.Provider` 的责任划分；dev-smark 本地回退仅覆盖 stateKey 缺席。
4. `stateKey` 逐文件隔离原因（同 part 多卡）。
5. `footer` prop 废除与内置 affordance 的对应关系。
6. preview 单次构造/折叠卸载的 native 资源纪律（65535 handle 保护，dev-smark 原注释移植）。
7. 各测试文件：fixture 改申报合同的原因（机制恢复）、原断言意图保留说明、slice 1-7 各自的行为意图、长 denied 语义变更注释、双折叠消失断言意图、snapshot harness 无需改动的依赖核对结论。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/routes/session/block-tool-collapse.test.tsx test/routes/session/block-tool-preview-once.test.tsx test/routes/session/block-tool-visible-once.test.tsx` | `packages/tui` | 并入的 7 slice + 更新后既有机制行为断言全绿 |
| `bun test test/routes/session/shell-output-spacing.test.ts` | `packages/tui` | 更新后的源码断言绿 |
| `bun test test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | `packages/tui` | edit fixture 申报合同适配后全绿（含长命令正文折叠回归 :575-599） |
| `bun test block-tool-error-red.test.tsx` | `.temp/tui-harness`（gitignore 隔离区，harness 按 §15 适配后运行） | 原始 red 环闭环：同一命令修复前红（6000 字符最小化用例，对应 34KB 原始场景）、修复后绿 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/tui` | 集成回归：七种卡片折叠循环、Write 预览行号/颜色、100 次收放、屏外恢复——预期零改动即绿（R14 排查结论） |
| `bun test test/routes/session/` | `packages/tui` | session 渲染面全量回归 |
| `bun test` | `packages/tui` | 包级全量回归 |
| `bun typecheck` | `packages/tui` | 类型检查通过 |
| 原始症状闭环：slice 1 即 34KB 错误场景的容器化形态 | `packages/tui` | 满屏错误不再复现 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 用户：不新增测试文件 |
| Files modified | 8 | 上述生产/测试文件 + notebook-tool.tsx 注释同步 |
| Files deleted | 0 | — |
| Production lines | 约 +190 / -210 | BlockTool 移植 + 卡片收敛，净删除为主 |
| Test lines | 约 +150 / ±105 | 新增 slice 并入既有文件 + 五个既有测试适配 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

- **denied 豁免取消是语义变更**：长 denied 错误将随容器折叠（此前 R10 设计为豁免）。依据为用户本次逐字指令（"什么错误啊……都不用去具体管""不要两套分支逻辑"），在 §1/§2 记录；短 denied 全显不变。
- 三个 headless 测试与 shell-output-spacing 断言的更新是机制恢复的既定部分，不是削弱测试：原行为断言意图（内容完整性、preview 单次构造、native 资源纪律）全部保留并映射到新合同。
- 当前工作区 `index.tsx` 有未提交修改；实施阶段先重读批准区域（workflow 阶段 3 门禁）。
- 测试改动克制约束（用户）：仅 §15 表内 6 个文件可动；session-message-render 等集成测试若变红，先修申报等价性，不得通过改断言/删用例消红。
- dev-smark 根处理器在 collapsible toggle 后仍调用 `props.onClick?.()`：收敛后的卡片原则上不再传 onClick（onRightClick 保留），该附加动作语义按蓝本保留，不构成双重 toggle。

### Open Decisions Requiring the User

无（本次指令已明确统一模型与 denied 处理）。

### Speculative（non-blocking 记录，不驱动实现）

- 错误文本 ANSI 转义：现状未 `stripAnsi`，保持。
- dev-smark 卡片内容级差异（Diagnostics 组件、删除摘要样式等）：属内容回迁，不在本任务范围（§2）。

## Audit Verdict Record

- R1-R9 各轮审计（错误段折叠方案）：R1 BLOCK（E/C 预算）；R2 APPROVE；R3 BLOCK（语义分叉+store 验证）；R4 BLOCK（INV-04 残留+右键分支）；R5 BLOCK（无 Provider 回归缺失）；R6 BLOCK（denied 样例无效）；R7 BLOCK（根级早返回吞正文折叠）；R8 BLOCK（§15 编辑残留）；R9 BLOCK（snapshot harness 自由变量）；R10 BLOCK（非折叠错误行死点击区）。
- R10 确认审计：**APPROVE**（No blocking findings）。
- R11：用户扩大范围为整套折叠所有权收敛，R10 批准失效。R11 审计 BLOCK：B-01 可空 context/无 Session 回退不属 dev-smark 机制；B-02 snapshot edit fixture 仍为旧合同。R12 处置：`use()` 原样保留、测试挂载一律提供真实 Provider、edit fixture 改申报合同；ApplyPatch 沿用当前完整键；index.tsx:249 反向注释同步；red 环重跑命令补录。
- R12 审计 BLOCK：B-01 §7/§13/§16 残留可空 context/无 Provider 表述（与 §10.1 互斥）；B-02 原始 red harness 未挂 Provider 且断言只能红不能绿。R13 处置：合同统一为 `use()` 原样 + 全部挂载真实 Provider；red harness 补 Provider 并改为可闭环行为断言（仅 harness）；§21 批准 revision 记录修正为 R13。

确认审计（R13）verdict 原样记录：

> **APPROVE — 仅限 canonical plan R13。**
>
> Blocking findings: No blocking findings.
>
> Non-blocking findings: NB-01"所有测试挂载"措辞略宽——真实 headless 挂载一律真实 Provider，源码抽取式 snapshot harness 保留注入式假 `use()`（已折入 §10.1/§14）；NB-02 长 denied producer 描述精确化——slice 3 指已进入 BlockTool 且文本含 denied 的错误，Shell preflight denied 在 metadata.output 写入前失败时走 InlineTool（豁免，不在端到端承诺内，已折入 §6）。
>
> Primary-path verdict：唯一权威路径是 BlockTool 统一计算 collapsible、持有展开语义并切换 preview/body；卡片只申报内容尺寸与 preview；错误不再拥有独立状态或点击路径。仅缺 stateKey 的本地 signal、maxLines=0、无 totals 不折叠均属输入域分支，无禁止的替代成功路径或责任外移。
>
> 可记录本次 full-scope 结果为 No blocking findings，将 R13 标记为批准 revision；随后按 approved-plan-only 停止，不实施代码。

- R13 获批后用户要求不新增测试文件、全面排查既有测试、测试改动克制。R14 处置：取消新增测试文件，7 slice 并入 block-tool-collapse.test.tsx；补全逐文件排查结论（session-message-render/auto-review-render/inline 错误快照等均零改动）；ApplyPatch preview 条件化保持删除摘要现状；R13 批准失效，需重审。

R14 审计 verdict 原样记录：

> **APPROVE — 仅限 canonical plan R14。**
>
> Blocking findings: No blocking findings.
>
> Non-blocking findings: NB-01 §15 对 auto-review-render 接触面记录不完整（:158-245 真实 Shell 长输出折叠、:386-449 Edit 等工具卡审查导航断言，预期零改动保持绿色，已补全）；NB-02 §1 未逐字收录 2026-11-08 测试面新要求且 Last updated 未更新（已补录）。
>
> Primary-path verdict：唯一权威路径是工具卡申报尺寸与 preview -> BlockTool 合并正文和错误尺寸 -> 同一 collapsible/expanded 状态 -> 同一 preview/body 与点击路由。仅缺 stateKey 的本地 signal、maxLines=0、未超阈值全显及无 totals 列表卡均为输入域分支，无禁止的 fallback、双 owner 或错误专属第二套状态。
>
> 本次为 full-scope 方案审计；未执行实施后的测试，因为当前目标为 approved-plan-only。可记录本次 verdict，将 R14 标记为批准 revision，随后停止，不实施代码。

R17 审计 verdict 原样记录（full-scope plan audit，task `ses_e43186dd5ffe8e9p0iKGTPebfI`）：

> **APPROVE — 仅限 canonical plan R17。**
>
> Blocking findings: No blocking findings.
>
> Non-blocking findings: NB-01 Shell 遗留未使用的 `const ctx = use()`，可在同一卡片收敛 hunk 删除，不影响行为或方案放行。
>
> Primary-path verdict：唯一权威路径为工具卡申报正文尺寸和 preview -> BlockTool 合并错误尺寸 -> 同一 collapsible/expanded -> 同一 preview/body 与点击路由。缺 stateKey 的本地 signal、maxLines=0、未超阈值全显及无 totals 列表卡均为输入域分支；InlineTool 为用户保留的独立既有接口。未发现 forbidden fallback、错误专属第二状态或替代成功路径。
>
> 本次为 full-scope 方案审计，未重新执行测试；§22 的测试结果及包级既有失败未作为独立通过证据。后续仍须按 R17 完成实施验证和 full-scope 实现审计，不能把本 verdict 视为实现、提交或 GOAL 完成放行。

R17 full-scope implementation audit verdict 原样记录（task `ses_e4308420dffelJPsC3UvVqW4NB`，独立复跑验证）：

> **APPROVE — 仅限 canonical plan R17 与本次审计的八个生产/测试文件实际 diff。**
>
> Blocking findings: No blocking findings.
>
> Non-blocking findings:
> - NB-01 验证记录需刷新：构建方记录包级 717 pass / 2 skip / 14 fail；独立复跑为 719 pass / 2 skip / 13 fail。当前 13 个失败全部属于 HEAD 基线失败集合，基线额外的 execute 超时未在本次复现，不是本 diff 回归。
> - NB-02 少量注释仍使用旧术语：`packages/tui/src/util/collapse-tool-output.ts:1`、`packages/tui/test/util/preview-diff.test.ts:54` 仍提到 BlockTool footer；`index.tsx:2727` 仍称窄屏使用更小宽度预算。仅影响说明准确性，不影响行为放行。
>
> Primary-path verdict：唯一权威路径为 ToolPart -> 各工具卡申报正文尺寸和 preview -> BlockTool 合并 part.state.error -> 同一 collapsible/expanded -> 同一 preview/body 与点击路由。卡片级 expanded/canCollapse/overflow/footer 已移除；错误没有独立状态、独立点击目标或 denied 豁免。未引入新 fallback、替代成功路径、诊断成功化或额外依赖。R17 与实际八个生产/测试文件的每个 diff hunk 相符。
>
> 独立复跑：BlockTool 定向 21 pass；inline/snapshot 22 pass；原始反馈环 3 pass；真实卡片/Write/offscreen/ApplyPatch 定向集成 10 pass；test/routes/session/ 159 pass；bun typecheck 通过；git diff --check 通过；包级 719 pass / 2 skip / 13 fail，13 个失败全部由 HEAD 基线复现。
>
> Chinese-comment verdict：E=446，C=68，C/E≈15.25%，超过 15% 实施目标与 10% 硬地板。
>
> 可记录 full-scope implementation audit 为 No blocking findings 并进入 verified。包级套件仍有上述可复现的基线失败，必须在实施证据中保留，不能声明全库测试全绿。bun.lock 及其他未跟踪计划文件不属于本次批准范围。

## 21. Audit Contract

- 本计划请求 full-scope 独立审计（Audit mode: plan）。
- 审计材料：§1 逐字需求、本文件路径、仓库根 `F:\ML\PythonAIProject\Claude-Code\opencode`。
- 任何 blocking finding：修订同一文件、revision 递增、清空 approval、full-scope 重审。
- 获批后置 `Status: approved`、`Approved revision: R17`、`Implementation allowed: yes`，继续完成实施、完整验证和独立实现审计；仅在实现审计获得 `No blocking findings` 并置 `Status: verified` 后，按 `verified-implementation-and-commit` 终态提交本 GOAL 文件。

## 22. Implementation Evidence

### Changed files and diff

- `packages/tui/src/routes/session/index.tsx`：BlockTool 统一 collapsible/expanded/preview/body/affordance/点击路由；错误尺寸并入容器；Shell、Write、Edit、ApplyPatch、GenericTool 删除卡片级折叠机制并改为 totals+preview 申报；PermissionReviewDecision 显式 `maxLines=0`。
- `packages/tui/test/routes/session/block-tool-collapse.test.tsx`：既有 fixture 迁移到真实 Provider 与申报合同，并入 slice 1-4/6-7 与容器 store 恢复（slice 1 同时覆盖 slice 7 的单容器单入口）。
- `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx`：R15 新增真实 ApplyPatch 双文件长 patch 独立收放测试，测试不提供 stateKey。
- `packages/tui/test/routes/session/block-tool-preview-once.test.tsx`、`block-tool-visible-once.test.tsx`：保留资源纪律断言并迁移挂载合同。
- `packages/tui/test/routes/session/shell-output-spacing.test.ts`：源码断言更新为容器自有机制。
- `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`：edit fixture 改 totals+preview，移除调用方 expanded 驱动。
- 实际 diff：8 个本 GOAL 生产/测试文件，540 insertions / 217 deletions（含注释与测试，含 notebook-tool.tsx 一行注释同步）；完整生产/测试差异导出 `D:\Temp\opencode\block-tool-r17-implementation.diff`。`session-message-render.test.tsx` 的临时 DEBUG 输出已全部清理，最终 diff 仅含真实 ApplyPatch 隔离测试。R17 NB-01 的 Shell 未使用 `ctx` 已删除。

### Red-green and behavioral evidence

- slice 1 初始红：`bun test test/routes/session/block-tool-collapse.test.tsx -t "one container"` 在长正文+长错误卡点击后超时，无法统一展开；修正 JSX harness 后确认症状为缺少容器 toggle，错误仍独立直出。
- 容器实现后同一命令 green；随后短错误、denied、拖选/右键、store 恢复与逐文件键、缺键本地回退逐 slice 通过。
- slice 1/7 同时断言长正文与长错误只有一个 `Click to expand`，一次点击同时恢复完整正文与错误尾部，再点击统一收缩。
- R14 实现审计后返工：直接 BlockTool 的逐文件键模拟已删除；`bun test test/cli/cmd/tui/session-message-render.test.tsx -t "per-file cards independently"` 通过真实 ApplyPatch 双文件入口验证独立收放（1 pass），`block-tool-collapse.test.tsx` 保留容器 store 恢复（8 pass）。
- 原始隔离反馈环 `.temp/tui-harness/block-tool-error-red.test.tsx` 按批准方案补真实 Provider 并改为可闭环断言；最终 `bun test block-tool-error-red.test.tsx`（工作目录 `.temp/tui-harness`）3 pass，6000 字符错误尾部默认不可见、点击后完整恢复。

### Verification commands and results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/routes/session/block-tool-collapse.test.tsx test/routes/session/block-tool-preview-once.test.tsx test/routes/session/block-tool-visible-once.test.tsx test/routes/session/shell-output-spacing.test.ts` | `packages/tui` | 21 pass / 0 fail |
| `bun test test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | `packages/tui` | 22 pass / 0 fail，8 snapshots |
| `bun test test/routes/session/` | `packages/tui` | 159 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "legacy card section gaps"` | `packages/tui` | 7 pass / 0 fail（七种真实卡片） |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "new Write collapsed preview"` | `packages/tui` | 1 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "offscreen messages"` | `packages/tui` | 1 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "per-file cards independently"` | `packages/tui` | 1 pass / 0 fail（真实 ApplyPatch 双文件隔离，R15） |
| `bun test block-tool-error-red.test.tsx` | `.temp/tui-harness` | 3 pass / 0 fail |
| `bun typecheck` | `packages/tui` | `tsgo --noEmit` 通过 |
| `bun test` | `packages/tui` | 构建方初跑 717 pass / 2 skip / 14 fail；独立实现审计复跑 719 pass / 2 skip / 13 fail，当前 13 个失败全部属于 HEAD 基线失败集合 |
| HEAD 隔离对照：`bun test test/cli/cmd/tui/session-message-render.test.tsx` | `D:\Temp\opencode\head-baseline\packages\tui` | 23 pass / 14 fail，与当前文件相同的 14 个既有失败；`unexpected request` 覆盖层和 100 次收放 5s 超时均在 HEAD 复现，不属于本 diff 回归 |

未验证项：包级套件未获全绿，原因是上述 HEAD 可复现的既有集成测试环境失败；未通过修改断言或跳过测试消红。独立审计复跑时 HEAD 额外的 `execute renders its child summary...` 超时未重现，因此当前为 13 个基线失败。与 BlockTool 直接相关的定向、集成、原始反馈环和包级 typecheck 均通过。

### Actual secondary and replacement paths

- 保留 InlineTool 既有 `errorExpanded`（用户明确豁免）。
- 未超阈值正文/短错误/短 denied 全显，是容器合同分支。
- 本地 signal 仅覆盖 stateKey 缺席；所有真实测试挂载均提供 Provider，未新增无 Session 生产回退。
- `maxLines=0` 禁用折叠用于运行态、模型上下文视图和 PermissionReviewDecision。
- 无 denied 豁免、无错误专属状态、无错误行独立点击目标、无数据层替代截断路径。

### Chinese comment gate

- 计算方式：`git diff --unified=0` 统计本 GOAL 全部 8 个生产/测试文件的新增非空代码行；排除 import-only、空行；注释单独统计。保守未额外扣除 pure-move，因此不会低估 E。
- 独立实现审计复算：`E=446`（另排除纯移动 `autoReview={false}` 1 行），`C=68`（另排除纯移动注释 1 行），`C/E≈15.25%`，要求 `ceil(446*0.15)=67`，通过。
- 代表性注释：容器首帧同步 collapsible 防止超长 diff 先挂载；错误与正文共用预算；preview 单树防止 native handle 泄漏；逐文件 stateKey 防止同 Part 串状态；拖选与右键不可触发收放；展开正文不得继续消费 previewText。

### Workarounds removed

- 删除 GenericTool/Shell/Write/Edit/ApplyPatch 各自的 expanded、canCollapse/sticky、collapsed/limited/overflow、footer/onClick 折叠接线。
- 删除 BlockTool 外置 `footer` prop 与无条件独立错误段；错误并入统一 body/preview。
- 未新增组件、依赖、配置、迁移或第二套生产状态路径。

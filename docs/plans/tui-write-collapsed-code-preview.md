# Canonical Implementation Plan: TUI Write Collapsed Code Preview

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户原文（见 §1）
>
> Target state: verified-implementation-and-commit
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-07

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

原始症状与只读调查要求：

> 下面需要你检查一下我们当前的情况。你看一下为什么 Write 这个工具，它在去收缩的时候，它就没有显示完全了。它就直接是以这种普通文本的形式去显示。而且按照逻辑来讲，比如 Edit 这种一些工具，它的展示都是，即使在收缩状态下都是正常的。你可以看到它有明确的这种高亮啊，以及这种 diff 的这种形式。但现在 Write 就不是这样。你看一下到底怎么回事儿，注意 read only 去调用。

本次方案要求：

> 按照 first principle plan 的原则，也就是我们这个 DOCS 里面有个 workflow，按照 workflow 的原则去构建一个 verified plan。保持修改的较小，HUNK以及泛化性。以及鲁棒性等的内容，不要引入过多的这种性能开销或者等内容。然后我不知道当前是不是预先都已经有各种各样的性能优化。我希望你这一套逻辑能够去复用那套逻辑，不要自己去造一条路，这种轮子的东西。注意不允许进行任何除了方案外的工作区文件的修改请注意这点。

最新工作区约束：

> 工作区的代码所有内容保持read only。

原目标终态为 `approved-plan-only`，R2 已获独立全 Scope 审计批准。

后续实施与提交授权（用户原文）：

> 按照 workflow 的相关流程规范进行准确的实施等等阶段，最终的验收标准是 verified implementation and commit。

目标终态据此更新为 `verified-implementation-and-commit`。该授权只推进已批准 R2 的实施、
验证、独立实现审计和限定范围提交，不改变生产设计、文件范围或行为验收条件。

## 2. Explicit Non-Goals

- 不改变 Write 工具执行、文件写入、权限、格式化、诊断或持久化行为。
- 不改变新文件 Write 与覆写 Write 的分支合同；新文件继续显示源码，覆写继续显示 diff。
- 不修改 Edit、ApplyPatch、Notebook、Shell 或 GenericTool 的渲染实现。
- 不修改 `BlockTool`、`DiffView`、`DiffPreview`、`CodeRenderable`、Tree-sitter、主题或行号组件。
- 不改变 20 行/字符折叠阈值、10 行预览预算、`previewText`、`collapseToolOutput` 或 `limited()` 的语义。
- 不新增共享跨工具组件、公开导出、配置、feature flag、缓存、解析器、折叠状态、重试或备用渲染路径。
- 不把新文件 Write 改造成 diff 视图，也不构造无旧文件语义的增删背景。
- 不承诺未测量的“零开销”或速度提升；只保留已有有界预览与 renderable 生命周期。
- 不处理其他工作树修改，不 push；commit 仅包含本计划及其实施的两个既有文件。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/workflow.md` | bug 必须有实际运行的 red-capable feedback loop；R2 批准后按 TDD 实施、独立实现审计，verified 后才可 scoped commit。 |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；禁止 fallback、重复实现、无证据边界；要求完整 traceability 和中文注释门禁。 |
| `.opencode/templates/canonical-plan.md` | 规定本计划结构、TDD、验证、审计和实施记录字段。 |
| `AGENTS.md` | 修改保持局部；可复用组件须有真实复用点；测试与 typecheck 从 package 目录运行。 |
| `CONTEXT.md` | 本任务只改变 Session 的 ToolPart 展示，不改变 durable Session History 或 Tool 执行语义。 |
| `docs/adr/README.md`、ADR-0001 | 当前 accepted ADR 只约束 triage，不约束 TUI；本局部修复不需要新 ADR。 |
| `docs/plans/code-renderable-highlight-failure-visibility-repair.md` R10 的相关已验证证据 | CodeRenderable 已有异步高亮、失败可见性和缓存责任；本任务不得另造高亮机制。 |
| `docs/plans/tui-collapse-ellipsis-and-buffer-scissor.md` R3 的相关已验证证据 | 纯文本与 diff 预览已有统一预算和省略号合同；本任务保留它们。 |
| `docs/plans/tui-legacy-message-chrome.md` R4 的相关已验证证据 | 当前卡片 chrome、footer 和 preview/body 生命周期必须保留，不能恢复旧折叠状态机。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/tui/src/routes/session/index.tsx:246-250,593-689` | Session 驻留、字节估算和 `subtreeHasPendingHighlight` 已处理 Code 高亮完成边界。 | observed |
| 同文件 `3294-3398` | `BlockTool` 持有 preview 树、隐藏 preview、销毁/重建 body，并统一 disclosure footer。 | observed |
| 同文件 `3496-3536` | Edit/覆写共用的 `DiffView`/`DiffPreview` 已集中 filetype、syntax、行号和 diff 色彩。 | observed |
| 同文件 `3538-3646` | 新文件 Write 的 preview 是普通 `<text>`，body 是 `<line_number><code>`；`limited()` 已有十行预算。 | observed |
| 同文件 `3972-4044` | Edit 的 collapsed preview 使用 `DiffPreview`，与 Write 新文件分支形成直接对照。 | observed |
| `packages/tui/src/routes/session/notebook-tool.tsx:95-153,263-304` | `NotebookSourceCode` 已在 preview/body 复用相同 line_number + code 结构，且 preview 只取有界内容。 | observed |
| `packages/opencode/src/tool/write.ts:56-88,120-154,210-232` | Write metadata 提供 `filepath`、`exists` 和有界 diff；新文件 `exists=false` 选择源码分支。 | reachable |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx:38-202,334-363` | 真实 Session renderer harness 已存在；当前卡片测试只检查字符、间距和折叠，不检查行号/颜色。 | observed |
| `packages/tui/test/routes/session/block-tool-collapse.test.tsx` | preview/body 重开、正文 owner 重建和完整内容恢复已有回归。 | observed |
| `packages/tui/test/routes/session/block-tool-preview-once.test.tsx` | preview 只构造一棵树、无脱树泄漏已有回归。 | observed |
| `packages/tui/test/routes/session/block-tool-visible-once.test.tsx` | preview/body 互斥、不泄漏首行已有回归。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:31-115,179-230` | CodeRenderable 已拥有 content/filetype/syntaxStyle、高亮调度和缓存失效。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/LineNumberRenderable.ts:20-35,89-129,172-186` | 行号 gutter 从 target 的 virtual lines 派生，调用方无需另算行号。 | observed |
| `thirdparty/opentui/packages/core/src/testing/test-renderer.ts:58-75,227-231,331-353` | `captureCharFrame()` 与 `captureSpans()` 提供公开的用户可见字符/颜色验证 seam。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:80-91,1242-1301` | 已有通过 span 颜色验证高亮结果的测试方式。 | observed |
| 外部 `D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx` | 原工作区的真实 Session 红测；30 行 Markdown 新文件 Write。 | observed |
| 外部 `D:/Temp/opencode/write-preview-candidate/packages/tui` | 隔离候选副本；只修改 Write 局部 JSX，未修改工作区。 | observed |
| 外部 `D:/Temp/opencode/tui-write-collapse-preview-probe.test.tsx` | 候选绿测；只轮询字符帧和颜色帧，不断言内部节点类型。 | observed |
| 当前 `git status` / `git diff` | 工作区存在其他修改；本任务没有写入这些文件，实施时必须保留并在当前内容上叠加局部 hunk。 | observed |

## 5. Current Behavior

新文件 Write 的当前路径：

```text
WriteTool result metadata.filepath + exists=false
  -> ToolPart -> Write
  -> collapseToolOutput(code, 20, char budget)
  -> writeCanCollapse
  -> limited() = previewText(code, 10, maxChars) when collapsed
  -> BlockTool.preview = <text>limited prefix</text>
  -> ordinary terminal text without gutter or syntax spans
```

同一 Write 展开后：

```text
expanded=true
  -> limited() = full code
  -> BlockTool body = <line_number><code filetype syntaxStyle>full code</code></line_number>
  -> numbered, syntax-highlighted terminal frame
```

覆写 Write 和 Edit 是另一受支持分支：

```text
metadata.diff + overwrite/existing-file condition
  -> previewDiff(...)
  -> DiffPreview -> DiffView
  -> numbered diff with syntax and added/removed backgrounds
```

`BlockTool` 已拥有 preview/body 生命周期：preview 在展开时保留但隐藏，body 在折叠时销毁、
再次展开时重建。`Write` 不需要也不应新增第二套折叠 owner。当前普通文本 preview
与 Code body 的表示分叉发生在 `Write` 给 `BlockTool` 选择 preview 的位置。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 新文件 Write，内容超过 20 行或字符阈值 | ToolPart input + `metadata.filepath`, `exists=false` | content 是字符串；成功结果已有 filepath | Write source card -> collapsed preview | `Write` | observed |
| 同一新文件 Write 展开、再次折叠、再次展开 | 用户点击 + `useInteraction` | 展开状态按 part ID 保存 | Write -> BlockTool preview/body | `Write` + `BlockTool` | observed |
| 短内容或未达到字符阈值 | 同一 ToolPart | `writeCanCollapse=false` | Write body 直接显示完整内容 | `Write` | reachable |
| 覆写已有文件 | `exists=true` 且 diff 非空 | WriteTool 已生成 diff | Write overwrite -> DiffPreview/DiffView | 现有 diff 分支 | observed |
| Edit/ApplyPatch/Notebook 卡片 | 各自 ToolPart metadata | 各自现有输入合同 | 各自现有 preview/body | 各自组件，不在修改范围 | reachable |
| Markdown/CJK/长行和字符预算 | Write content + 终端宽度 | 现有 Unicode 安全 `collapseToolOutput` | `limited()` -> 同一字符串供 preview/body | 现有预算逻辑 | reachable |
| 异步高亮尚未完成 | CodeRenderable + Tree-sitter | Code 有 settled/highlighting 状态 | WriteSource -> Code -> captureSpans | CodeRenderable；测试只等待公开帧 | reachable |
| Offscreen release、selection、resize | Session residency | 现有冻结前需排空高亮和几何约束 | WriteSource 子树进入现有扫描 | Session | reachable |
| Pending/running Write | ToolPart state | 尚未形成成功卡片结果 | InlineTool pending 路径 | 现有 InlineTool | reachable |

没有证据支持新增异常 metadata 修复、第二解析器、跨工具迁移、额外错误处理或
新文件 diff 兼容分支。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 新文件 Write 的 collapsed preview 对同一内容前缀保留与展开态一致的行号和语法颜色。 | 用户截图与要求；原红测颜色/行号差异 | 缺失；当前卡片测试只看字符 |
| INV-02 | collapsed preview 继续使用 `limited()` 的 10 行与字符预算；expanded body 显示完整内容，反复切换不丢失正文。 | 当前 `limited()`、BlockTool 合同、用户要求鲁棒性 | `session-message-render`、`block-tool-collapse` 有部分覆盖 |
| INV-03 | Write 源码展示只有一个渲染语义 owner；preview/body 是同一组件的两个独立实例，沿用 BlockTool 生命周期，不新增折叠状态、缓存或解析路径。 | 用户要求复用；现有 NotebookSourceCode 与 BlockTool 证据 | preview-once/visible-once/collapse |
| INV-04 | 覆写 Write、Edit、ApplyPatch、Notebook、pending Write 和短内容行为保持不变。 | 当前分支和调用链 | 现有卡片矩阵与各工具测试 |
| INV-05 | 新增高亮工作只针对已有十行 preview，不增加全量内容的第二次高亮；保留 preview 驻留、body 重建和 Session pending-highlight 处理。 | `limited()`、BlockTool、Session 扫描；用户性能约束 | preview 生命周期与 Session residency 测试 |
| INV-06 | 回归验证观察公开字符帧与颜色帧，并在异步高亮落地后取样，不依赖内部节点类型、固定 sleep 或实现调用次数。 | OpenTUI public capture API；当前异步路径 | Code tests 提供颜色断言先例 |
| SCOPE-07 | 实施限定为 1 个现有生产文件和 1 个现有测试文件，保留所有无关工作树修改；verified 后仅提交这两个文件和本计划。 | 用户小 HUNK 要求及最新实施/提交授权 | `git status`、intended diff review、scoped commit |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | **Origin：** `Write` 新文件分支在 `index.tsx:3626` 把 collapsed preview 构造成普通 `<text>`，而同分支 body 在 `:3628-3636` 使用 line_number + Code。 | `Write` 的 preview/body 选择；不是 CodeRenderable、BlockTool 或 WriteTool | 原红测：collapsed `numbered=false`，颜色从展开的 `[157,124,216,255]` 变为 `[238,238,238,255]` |
| INV-02 | 当前 `limited()` 已产生正确十行预览，无预算 divergence。 | 现有 `limited()`/`previewText` | 同一红测中 `bounded=true`，第 30 行未出现在 collapsed 帧 |
| INV-03/05 | 普通文本 preview 绕开已有 Code 表示，但 BlockTool 生命周期本身正常；修复只需消除 Write 的表示分叉。 | `Write` 局部组件边界 | 候选复用 BlockTool 后探针转绿，现有 preview 生命周期测试保持绿色 |

### Red-capable feedback loop

从 `packages/tui` 实际运行：

```powershell
bun test "D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000
```

该命令使用真实 `Session`、真实 ToolPart、真实 OpenTUI renderer 和 Markdown Write。
它先展开读取已知正常的行号/颜色，再折叠比较相同前缀，并检查第 30 行仍被预算排除。

R1 原实现两次运行均为同一结果（直接值断言）：

```text
0 pass, 1 fail
numbered: false（expected true）
collapsed color: [238,238,238,255]
expanded color:  [157,124,216,255]
bounded: true（符合预期）
```

最小化条件只有：30 行 Markdown、`filePath="plan.md"`、`metadata.filepath`、
`exists=false`、完成态 Write。初始外部模块解析失败未进入缺陷路径，未计作证据。

### Candidate plan-stage experiment

候选只在外部副本增加私有 `WriteSource`，preview/body 均调用它并直接消费 `limited()`。
从 `packages/tui` 运行公开帧探针：

```powershell
bun test "D:/Temp/opencode/tui-write-collapse-preview-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000
```

R2 探针以展开后的普通正文行 `Body line 30` 提供默认文本颜色参照，不再要求
collapsed 初始高亮尚未完成。候选连续 3 次运行均为 `1 pass, 0 fail, 3 expect() calls`；
同一 R2 探针在原实现的 collapsed 行号/颜色条件处超时，仍显示无行号普通文本。
候选没有 CodeRenderable 节点断言，异步等待通过 `captureSpans()` 完成。

候选现有回归与类型检查：

```text
legacy card section gaps: 7 pass, 0 fail
BlockTool collapse/preview-once/visible-once: 4 pass, 0 fail
bun typecheck: exit 0
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Write 源码的行号、filetype、syntaxStyle 和内容 | `Write` 内私有 `WriteSource` | 给定一个已选内容字符串，按当前 filepath/theme 渲染源码 | preview 与 body 当前在这里发生表示分叉 | Code 只执行高亮；Notebook 属于不同工具且有额外 language 语义 |
| 十行和字符预算 | 现有 `limited()` / `previewText` | collapsed 返回有界前缀，expanded/不可折叠返回完整内容 | 已满足 INV-02 | 新组件不得再次截断或复制预算 |
| preview/body 显示、驻留和销毁 | 现有 `BlockTool` | preview 保留并隐藏，body 折叠销毁、展开重建 | 已是唯一折叠 owner | `WriteSource` 只返回渲染节点 |
| 异步高亮、缓存、失败可见性 | 现有 CodeRenderable/Tree-sitter | 对传入 content/filetype/syntaxStyle 执行既有高亮 | 已有完整实现与性能修复 | 本任务不新增 parser、cache 或 retry |
| 新文件/覆写分支与 metadata | 现有 WriteTool + `Write.isOverwrite` | `exists` 与 diff 决定源码或 diff | 当前数据已充分 | 无需修改 Tool 执行或持久化 |
| 用户可见回归 | 现有真实 Session headless renderer | 通过 ToolPart 渲染并观察 char/span frames | 直接覆盖截图症状和点击路径 | 私有 helper/source-text 测试不能证明视觉行为 |

## 10. Single Approved Primary-Path Design

在 `Write` 内、`diffOverflow` 之后和 `return` 之前增加一个私有、局部的
`WriteSource(sourceProps: { content: string })` 组件。它使用当前 `Write` 闭包已有的
`theme`、`syntax`、`filepath`，返回现有 `<line_number>` + `<code>` 结构，逐属性保留：

- `fg={theme.textMuted}`、`minWidth={3}`、`paddingRight={1}`；
- `conceal={false}`、`fg={theme.text}`；
- `filetype={filetype(filepath())}`、`syntaxStyle={syntax()}`；
- `content={sourceProps.content}`。

随后只做两处替换：

```text
collapsed preview: <text>{previewText(limited(), ...)}</text>
  -> <WriteSource content={limited()} />

expanded/uncollapsed body: inline <line_number><code ... content={limited()} /></line_number>
  -> <WriteSource content={limited()} />
```

这直接修复 first divergence：collapsed preview 与 body 不再选择不同渲染器。
`limited()` 已经执行 collapsed 截断，因此删除 preview 上重复的 `previewText(limited(), ...)`
调用，不增加第二次预算计算或另一套内容来源。

两个 JSX 调用必须分别创建 preview/body 实例；不得把同一个 JSX/renderable 对象共享给
两个位置。BlockTool 继续决定可见性、保留 preview、销毁和重建 body。`WriteSource`
保持 `Write` 私有，不导出、不提升到共享模块，也不把 Notebook 组件改造成公共接口。

性能边界：当前展开 body 的全量 Code 高亮路径不变；新增工作仅限于 collapsed 时已有的
十行 `limited()` 字符串。preview 继续由 BlockTool 驻留，body 次数和生命周期不变。
没有新全量 preview parse、重复正文树、常驻 instrumentation 或额外扫描。该设计不声称
零成本，必要成本是使用现有 Code 对有界 preview 进行高亮。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 新文件 Write collapsed source preview | current + repaired | primary-contract branch | yes | 修复同一 Write source 决策面 | preserve and repair |
| 新文件 Write expanded/uncollapsed body | current + repaired | primary-contract branch | yes | 与 preview 共用同一组件 | preserve and repair |
| 覆写 Write diff preview/body | current | primary-contract branch | yes | 0% changed | preserve |
| Edit/ApplyPatch/Notebook 各自 preview/body | current | primary-contract branch | yes | 0% changed | preserve |
| Pending/running Write inline row | current | contracted pass-through | yes | 0% changed | preserve |
| 普通文本作为高亮失败后的备用 preview | none proposed | forbidden fallback | N/A | 0% | reject |
| 新 parser/cache/state/配置路径 | none proposed | forbidden fallback | N/A | 0% | reject |

新增 alternate success path 为 0；新增 diagnostic path 为 0，diagnostic decision-surface
占比为 0%。修改没有失败触发的高亮降级或第二成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 新文件 Write 的普通 `<text>` collapsed preview | #144 引入通用文本预览，#154 修复 diff 卡片时未覆盖该分支 | 同一 WriteSource 直接恢复行号与语法色 | `index.tsx` Write preview 属性 |
| preview/body 各自书写源码渲染结构 | body 已有 Code，preview 使用另一表示 | 一个私有组件承载两处相同语义，避免后续再次漂移 | `index.tsx` Write 内局部 JSX |
| preview 对 `limited()` 再调用一次 `previewText` | 早期文本预览写法遗留 | `limited()` 已按 collapsed 状态返回十行前缀 | 同一 preview 属性，直接传 `limited()` |

不删除现有 `previewText`、`limited()` 或 BlockTool；它们仍承担原合同。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | WriteSource -> line_number + Code -> collapsed char/span frame | `index.tsx` 私有组件与 preview 替换 | 新真实 Session 测试比较 expanded/collapsed 行号和颜色 |
| INV-02 | 现有 `limited()` -> WriteSource preview/body | 两处都直接消费 `limited()`，删除重复 previewText | 同一测试检查十行预算、完整展开和再次展开 |
| INV-03 | 一个 WriteSource 的两个独立 JSX 实例 -> 现有 BlockTool | 只修改 Write 局部组件，不改 owner | 新测试切换路径 + 现有 collapse/preview-once/visible-once |
| INV-04 | 现有 overwrite/Edit/Patch/Notebook/pending 分支 | 这些分支不改 | 现有 Session 卡片矩阵和相关 package 回归 |
| INV-05 | 有界 preview + BlockTool 驻留 + Session pending-highlight 扫描 | 不添加全量第二棵 preview 或新状态 | 现有 preview 生命周期、residency、typecheck；不新增 profiler |
| INV-06 | captureCharFrame/captureSpans 公共测试 seam | `session-message-render.test.tsx` 增加行为测试和颜色等待 | 测试自身先红后绿；无内部节点或 call-count 断言 |
| SCOPE-07 | 局部叠加两文件修改，verified 后 scoped commit | 本计划；生产与测试各一个现有文件 | `git status`、`git diff --check`、intended diff review、commit path check |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `Write` 私有 `WriteSource` | INV-01、INV-03 | 当前 preview/body 渲染器分叉；Notebook 有同类复用结构 | 现有 body JSX 只能覆盖展开态；普通 text preview 无法表达行号/高亮。组件有两个真实调用点，不是单次 helper |
| `sourceProps.content` | INV-01、INV-02 | preview/body 内容不同，渲染配置相同 | 其余配置已在 Write 闭包；只把变化的内容作为参数可避免复制内容预算 |
| preview/body 直接消费 `limited()` | INV-02、INV-05 | `limited()` 已按 expanded/writeCanCollapse 返回正确字符串 | 再包一层 `previewText` 是重复工作；另建 preview memo/state 会形成第二内容来源 |
| 真实 Session 颜色帧断言 | INV-01、INV-06 | 当前测试无法识别纯文本与语法色差异 | `captureCharFrame()` 单独不能验证颜色；私有节点断言又会耦合实现 |

没有新模块、公开接口、依赖、配置、状态、缓存、guard、retry、compatibility adapter、
migration 或 diagnostic 概念需要映射。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/tui/src/routes/session/index.tsx` | modify | 在现有 Write 内增加私有 WriteSource；替换新文件 preview/body；其余分支不动 | 约 +16/-10 文本行；有效生产代码约 15 行 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 用现有 withRenderedSession/completedToolPart/click/waitForFrame 增加公开帧红测与 spanColor 小读取器 | 约 +45-55 行 |
| `docs/plans/tui-write-collapsed-code-preview.md` | add/modify | 唯一 canonical plan、审计和后续实施证据 | 文档，不计生产/测试代码 |

不得复制临时探针到仓库，不得修改外部副本之外的工作区文件来“对齐”候选。
实施时读取当时文件内容，保留当前及后续无关修改；若 Write 相关 interface、owner、
preview 生命周期或测试 seam 漂移，停止并修订本计划。

## 16. TDD Behavior Slices

确认的公开 seam 是现有真实 Session headless renderer。它捕获用户可见的
`captureCharFrame()` 和 `captureSpans()`；不新增生产导出，不直接调用私有 `WriteSource`。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 完成态新文件 Write 的 collapsed preview 与 expanded 前缀具有相同行号和语法色，并保留十行预算 | 当前 preview 是 text，无行号且颜色为普通文本色 | 私有 WriteSource 同时承载 preview/body，内容仍取 `limited()` | 行号、颜色、折叠预算、完整展开 |
| 2 | 再次展开后完整第 30 行和 Click to collapse 恢复 | 修复不得破坏 BlockTool 的 body owner 重建 | 使用两个独立组件实例，BlockTool 不变 | preview 驻留、body 重建、无双显 |

第一个垂直 slice 的仓库测试按以下顺序执行：

1. 以 30 行 Markdown 和 `exists=false` 构造真实 Write；首行使用已有主题中与普通文本
   不同色的 heading，内容尾部使用不带 quote 的普通正文字面标记 `Body line 30`。
2. 点击展开并等待完整尾部出现；读取普通正文 `Body line 30` 的颜色作为默认文本参照，
   等待 heading 颜色区别于该参照。记录展开态行号和颜色作为已知正常、独立的期望值；
   该同步条件不读取 collapsed 初始颜色，因此 collapsed 提前完成高亮也能成立。
3. 点击折叠，通过公开帧轮询等待行号和颜色达到该期望值；检查 `Body line 30`
   不在 collapsed 帧中。颜色等待避免在异步高亮完成前误判，不使用固定 sleep。
4. 再次展开，检查完整尾部和 disclosure 恢复。
5. 先只添加该测试并观察原实现红，再实施 §10 的最小组件修改并观察同测试转绿，
   最后运行现有回归。禁止通过节点类型断言、source-text 检查或复制生产截断算法制造绿色。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 65 | 生产约 15 + 测试约 45-55；排除空行、import-only、格式化、文档和纯移动 |
| Required Chinese explanatory comments `C` | `C >= 10`（按 E=65 估算） | 实际实施必须重新计算并满足 `C >= max(1, ceil(E * 0.15))`，不得沿估算降低比例 |

计划在修改点附近提供真实解释，而非拆行凑数：

1. 生产：WriteSource 统一 preview/body 表示及只消费现有 `limited()` 预算的原因。
2. 生产：两个独立 JSX 实例必须保留 BlockTool preview/body 所有权，不能共享 renderable。
3. 测试：30 行 Markdown fixture 同时提供折叠条件、可辨识语法色和独立尾部标记。
4. 测试：展开后的普通正文行提供默认文本颜色参照，避免要求 collapsed 必须先呈普通色。
5. 测试：expanded 帧是 collapsed 表示的独立已知正常参照。
6. 测试：公开颜色轮询用于等待异步高亮，避免固定 sleep 和未落地帧假绿。
7. 测试：collapsed 同时检查行号、颜色与十行预算，防止只恢复其中一项。
8. 测试：再次展开锁定 preview 保留时 body 仍能重建完整内容。
9. 测试：`spanColor` 只读取用户可见颜色，不推断内部节点或复制高亮规则。
10. 测试：独立尾部字面量用于证明 collapsed 截断与 expanded 恢复，而非测试自行计算预算。

实际审计只统计邻近相关决策且符合政策的解释；无意义重复不计入 C。

## 18. Verification

### Plan-stage checks already executed

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test "D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000` | `packages/tui` | R1 两次直接值红色；R2 原实现仍在 collapsed 行号/颜色条件处超时，十行预算正常 |
| `bun test "D:/Temp/opencode/tui-write-collapse-preview-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000` | `packages/tui` | R2 外部候选公开帧探针连续 3 次均为 1 pass，0 fail |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "legacy card section gaps survive collapse and expand" --timeout 30000` | 外部候选 `packages/tui` | 7 pass，0 fail；Write overwrite/Edit 等卡片保持 |
| `bun test test/routes/session/block-tool-collapse.test.tsx test/routes/session/block-tool-preview-once.test.tsx test/routes/session/block-tool-visible-once.test.tsx --timeout 30000` | 外部候选 `packages/tui` | 4 pass，0 fail；生命周期保持 |
| `bun typecheck` | 外部候选 `packages/tui` | exit 0 |

### Required implementation verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "new Write collapsed preview preserves expanded line numbers and syntax color" --timeout 30000` | `packages/tui` | 新回归实施前红、实施后绿；直接覆盖原症状 |
| `bun test "D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000` | `packages/tui` | 原始外部 feedback loop 在实际工作区修复后转绿 |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` | `packages/tui` | 完整真实 Session 卡片、residency、resize、interaction 回归 |
| `bun test test/routes/session/block-tool-collapse.test.tsx test/routes/session/block-tool-preview-once.test.tsx test/routes/session/block-tool-visible-once.test.tsx --timeout 30000` | `packages/tui` | preview 不泄漏、不双显，body 可重建 |
| `bun run test` | `packages/tui` | 执行 package 既有 `--only-failures` 入口并报告结果；不单独作为全量 package 回归证据 |
| `bun typecheck` | `packages/tui` | 生产 JSX 与测试类型安全 |
| `git diff --check` 与完整 intended diff review | repository root | 无 whitespace 错误、无越界文件、无无关 worktree 覆盖 |

没有 Protocol/Server API、生成代码、native、依赖或数据库变化，因此不需要 generate、
native build、SDK regeneration、migration 或跨 package runtime 验证。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 当前只新增本 canonical plan；实施不新增生产/测试文件 | 复用现有模块和测试 harness |
| Files modified | 实施 2 个：1 生产 + 1 测试 | 根因和公开行为回归的最小完整范围 |
| Files deleted | 0 | 普通文本 preview 在原位置替换，无独立文件 |
| Production lines | 约 +16/-10 文本行；有效 E 约 15 | 一个局部私有组件和两处调用 |
| Test lines | 约 +45-55 | 一个真实 Session 行为测试、公开颜色读取和必要注释 |
| Generated lines | 0 | 无生成链变化 |

预算不是削减 INV-01 至 SCOPE-07 的许可；任何额外 production concept 必须先修订
本计划并重新全 Scope 审计。

## 20. Real Risks and Open Decisions

- **异步高亮时序：** Code 的颜色可能晚于文本落地，collapsed 也可能早已完成高亮。
  测试以展开后的普通正文行作为默认颜色参照，再等待标题高亮和 collapsed 公开帧达到
  展开态参照；不能依赖 collapsed 初始普通色、固定 sleep 或首帧颜色。
- **Renderable ownership：** preview 与 body 不能共享同一个 JSX 对象。两个独立组件
  调用保留 BlockTool 当前 preview 驻留和 body 重建语义，并由现有生命周期测试兜底。
- **性能边界：** 高亮 preview 是新增的必要工作，但输入已被 `limited()` 限为十行。
  不新增全量第二次高亮，不作零成本声明，也不加入永久 profiler/instrumentation。
- **并行工作树：** 当前 `index.tsx` 和测试文件存在其他修改。实施只能在当时内容的
  Write/测试局部叠加，不得复制覆盖候选副本、回退或格式化整个文件。
- **范围保持：** WriteSource 只统一新文件源码卡片；把它提升为跨工具公共组件会引入
  Notebook language 等无关合同，当前没有证据支持。

### Open Decisions Requiring the User

无。用户已明确症状、复用/性能/鲁棒性要求、小 HUNK 偏好，以及后续
`verified-implementation-and-commit` 终态；现有公开 Session 渲染 seam 足以承载验证。

### Rejected Speculation

- 不修改 WriteTool metadata 或把新文件转为 diff；当前 `exists=false` 已明确选择源码分支。
- 不修改 CodeRenderable、Tree-sitter、BlockTool、主题或行号组件；红测证明 divergence 在 Write 调用方。
- 不新增共享 Notebook/Write 公共组件、缓存、memo/effect、第二预览状态或 plain-text fallback。
- 不增加异常 metadata、恶意输入、parser 失败恢复、额外 retry 或新错误转换；它们与本缺陷无可达新增路径。
- 不新增性能框架、全局 benchmark 或常驻计数器；现有有界输入与生命周期回归足以约束本次局部变化。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, performance reuse,
  worktree constraints, and the 15 percent Chinese explanatory-comment plan.
- Verify that the red-capable loop catches the original visible symptom and that the
  candidate experiment actually exercises the proposed local reuse route.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 无其他非阻塞发现 | BLOCK | `ses_e4d64c1beffeZ4WqeWV4RIU2Mp` |
| 2 | R2 | yes | No blocking findings | NB-01 | APPROVE | `ses_e4d524f32ffe2lXmBBvnzsAXlZ` |

### Round 1 Verdict (Verbatim)

## Blocking findings

### B-01 修复后的测试仍假设 collapsed 初始颜色一定是普通文本色

- Violated invariant: INV-06 的可靠异步验证要求，以及 INV-01 在同一 red/green 回归测试中的可执行性。
- Evidence class: reachable
- Producer and execution path: 新文件 Write → 修复后的 collapsed `WriteSource` → `CodeRenderable.renderSelf()` 启动异步高亮 → 测试的 `pumpFrames()` 多次让出执行权 → collapsed 高亮可能在读取 `plainColor` 前已经完成 → expanded 得到相同高亮色 → 等待“颜色不同于 `plainColor`”永远无法成立。
- Source evidence: `thirdparty/opentui/packages/core/src/renderables/Code.ts:609-696,828-842`；`packages/tui/test/cli/cmd/tui/session-message-render.test.tsx:124-140`；候选探针的对应逻辑位于 `D:/Temp/opencode/tui-write-collapse-preview-probe.test.tsx:146-150`。
- Canonical-plan evidence: §16 第 1–3 步、§17 第 4 项、§18 候选探针结果。
- Responsibility owner: `session-message-render.test.tsx` 中计划新增的 Session 渲染回归测试；不是 CodeRenderable。
- Concrete behavioral consequence: 正确实现让 collapsed 和 expanded 都具备高亮后，只要 collapsed 高亮足够早完成，测试就会在展开态等待颜色变化时超时。候选探针单次通过不能排除这个时序，计划中的 green 验证因此可能拒绝正确实现。
- Minimal correction direction: 保留公开字符帧和颜色帧断言，但移除“collapsed 初始普通文本色”这一展开高亮完成基线，改用不依赖 collapsed 必须晚高亮的公开行为同步条件，并同步修订 §17 第 4 项后重新执行 red/green。

## Non-blocking findings

无其他非阻塞发现。生产侧增加局部 `WriteSource` 的方向不需要因 B-01 改变。

## Rejected speculation

- 不支持把新文件 Write 改造成 diff：当前 `exists=false` 明确进入源码分支，用户要求的是恢复源码行号和高亮。
- 不支持新增共享跨工具组件、parser、cache、折叠状态或普通文本备用路径；计划没有这些概念，现有 `CodeRenderable`、`line_number`、`limited()` 和 `BlockTool` 已覆盖对应职责。
- 不将 preview 的必要高亮工作直接认定为性能回归：其输入受现有十行及字符预算限制，也没有测量证据支持额外性能门槛。
- 不把 Edit、覆写 Write、Notebook 或 pending Write 纳入修复；它们的实际分支没有被计划修改。

## Requirement and traceability coverage

- R1 完整引用了三段原始需求，并正确限定当前阶段为 `approved-plan-only`，没有授权工作区实施。
- 根因定位成立：`packages/tui/src/routes/session/index.tsx:3626` 给 collapsed preview 使用普通 `<text>`，而同一新文件分支的 body 在 `3628-3636` 使用 `line_number + code`。覆写 Write 已在 `3605-3616` 使用现有 diff 路径。
- 生产修复位于首次表示分叉的 `Write` 组件，没有下沉修改 BlockTool、CodeRenderable 或 WriteTool。
- `WriteSource` 有两个真实调用点，直接复用现有 filetype、syntax、行号和内容预算；forward/reverse traceability、文件范围、package-local 验证命令及只读边界均已建立。
- 外部原始探针能够在原实现上捕获行号缺失和颜色差异；但 B-01 使计划中的同一测试无法可靠转绿，因此验证覆盖尚不满足放行要求。
- 本轮仅只读检查源码、测试和外部探针，未重新执行测试命令。

## Primary-path and fallback verdict

生产设计只有一条权威路径：

`limited() → WriteSource → line_number + CodeRenderable → BlockTool preview/body`

它保留覆写 diff、Edit、Notebook 和 pending 分支，不增加失败后的备用成功路径、第二解析器或额外缓存。主路径方向符合用户要求的小 HUNK、复用现有性能机制和鲁棒性目标，但整个 R1 仍受测试同步缺陷阻塞。

## Code quality and Chinese-comment verdict

- 私有 `WriteSource` 有两个真实复用点，不属于单次调用的提前抽象，也没有扩大公开接口。
- 计划估算 `E ≈ 65`、`C >= 10`，算术满足 `ceil(65 × 0.15) = 10`，并承诺实施时重新计算实际值。
- §17 第 4 项建立在 B-01 的错误时序假设上，修订测试时必须同步替换；其余生产所有权、异步公开帧、正文重建和尾部预算注释具备可实施的解释价值。
- 当前为方案审计，没有实际实现 diff，因此没有实际 `E/C` 可重新计算。

## Release verdict

**BLOCK**

R1 不得批准。需要修订测试同步条件、递增 canonical revision、保持 `Implementation allowed: no`，然后进行新的全 Scope 方案审计。

### R2 Resolution

B-01 的同步假设已删除。R2 使用展开后的普通正文 `Body line 30` 作为默认文本颜色
参照，不再读取或要求 collapsed 初始普通色。原实现使用同一 R2 探针仍在 collapsed
行号/颜色条件处超时；候选连续 3 次通过。§16、§17、§18 和 §20 已同步修订，
生产主路径没有改变。当前递增为 R2，`Implementation allowed: no`，等待新的全 Scope 审计。

### Round 2 Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- **NB-01： package 测试命令的证据表述需保持准确。** `bun run test` 实际执行 `bun test --timeout 30000 --only-failures`（`packages/tui/package.json:9`），不能单独证明全量 package 回归。此项不阻塞，因为计划已分别要求运行完整 `session-message-render.test.tsx`、三个 BlockTool 回归及新增红绿测试，足以覆盖本次受影响路径；实施报告不应把该命令描述成全量测试。若需要全量包回归，应另行执行 `bun test --timeout 30000`。

## Rejected speculation

- 不支持把新文件 Write 改成 diff：当前源码分支由现有 `isOverwrite()` 分流，用户要求修复的是源码预览的行号和高亮，而非改变 diff 合同。
- 不支持新增跨工具公共组件、parser、cache、折叠状态或普通文本备用路径；现有 `limited()`、`CodeRenderable`、`line_number` 和 `BlockTool` 已承担对应职责。
- 不将有界预览的必要高亮工作认定为性能回归：新增输入仍是现有十行及字符预算内的前缀，没有测量证据支持额外性能门槛。
- 不要求为本局部修改增加异常 metadata、恶意输入或 parser 失败恢复；这些路径没有因本计划产生新的可达性。

## Requirement and traceability coverage

- R2 完整保留三段原始需求，当前终态为 `approved-plan-only`，没有授权本任务修改工作区生产代码或测试。
- 根因定位成立：`packages/tui/src/routes/session/index.tsx:3626` 使用普通 `<text>` 构造折叠预览，而同一新文件 Write 分支在 `:3628-3636` 使用 `line_number + code`。首次表示分叉属于 `Write`，不在 WriteTool、BlockTool 或 CodeRenderable。
- 覆写 Write 已走 `DiffPreview/DiffView`（`index.tsx:3605-3616`），Edit 也保留独立 diff 路径（`:4017-4029`）；计划没有 narrowing 或无关扩张。
- R2 已消除 R1 的异步时序缺陷：测试从展开后的普通正文取得默认颜色参照，不再要求 collapsed 初始颜色必须为普通文本色（计划 §16；外部探针 `D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx:146-160`）。原实现没有行号，因此该测试仍对原缺陷敏感。
- 外部候选与计划主路径一致：私有 `WriteSource` 位于候选 `index.tsx:3604-3616`，preview/body 分别在 `:3641-3643` 创建独立实例。
- INV-01 至 SCOPE-07 均有生产或明确的不改路径、文件变更及行为验证映射；reverse traceability 中的私有组件、content 参数、直接消费 `limited()` 和公开颜色帧断言都有现有证据支持。
- 本轮只读检查了当前源码、现有测试、外部探针及隔离候选，没有重新执行测试命令。

## Primary-path and fallback verdict

唯一权威路径为：

```text
limited() → WriteSource → line_number + CodeRenderable → BlockTool preview/body
```

该路径修复首次表示分叉，同时保留覆写 diff、Edit、Notebook、pending 和短内容分支。没有新增失败触发的备用成功路径、第二解析器、额外缓存或 diagnostic path。

性能边界合理：新增高亮仅处理已有十行及字符预算内的 preview，继续复用 CodeRenderable 的异步高亮机制、BlockTool 生命周期和 Session pending-highlight/residency 处理，没有另建性能机制。

## Code quality and Chinese-comment verdict

- `WriteSource` 为 `Write` 私有组件，具有 preview/body 两个真实调用点，不属于单次调用抽象，也没有扩大公开接口。
- 两处直接消费 `limited()`，删除重复且幂等的 `previewText(limited(), ...)` 包装，不形成第二内容来源。
- 计划估算 `E ≈ 65`、`C >= 10`，满足 `ceil(65 × 0.15) = 10`，并明确要求实施时按实际 diff 重新计算。R2 已同步修正颜色参照相关注释意图，十项计划解释具有可实施价值。
- 当前为方案审计，没有实际实现 diff，因此实际 `E/C` 为 N/A。

## Release verdict

**APPROVE** — 仅适用于 canonical plan **R2** 的本次全 Scope 方案审计（第 2 轮）。按用户指定的 `approved-plan-only` 终态，批准后停止；本 verdict 不表示工作区实现或其完整回归已经完成。

NB-01 disposition: §18 已明确 `bun run test` 的 `--only-failures` 语义；该记录修正不扩大设计范围，也不把它单独作为全量回归证据。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

R2 已按批准主路径实施，当前等待独立全 Scope 实现审计；本节的通过结果不替代审计。

### Actual Files and Diff

- `packages/tui/src/routes/session/index.tsx`：+18/-11 文本行；私有 `WriteSource` 统一新文件
  Write 的 preview/body，直接消费 `limited()`；有效生产代码 `E=15`。
- `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx`：+53/-0；新增公开字符/颜色帧
  回归和 `spanColor` 读取器；有效测试代码 `E=41`。
- `docs/plans/tui-write-collapsed-code-preview.md`：canonical plan、审计与实施证据，文档不计 E。
- 未修改 BlockTool、CodeRenderable、WriteTool、Edit、Notebook、配置、依赖或生成文件。
  工作区另有 `bun.lock` 一行注释删除和多个无关 untracked plan，均不属于本任务且不纳入提交。

### Red-Green Test Evidence

批准 seam 的真实仓库红测命令：

```powershell
bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "new Write collapsed preview preserves expanded line numbers and syntax color" --timeout 30000
```

- 在调整公开视口同步后、生产修复前：`0 pass / 1 fail / 3 expect() calls`。
  失败发生在 collapsed 行号/颜色条件，最终帧仍为无行号普通文本，符合目标缺陷。
- 初次测试编写时展开尾部跟随使标题离开视口；使用现有 `sessionScrollBox` 回到消息顶部，
  并回到底部点击折叠，消除跨视口取样。另将 viewport size 从 Bun `test` 选项移回
  `withRenderedSession`，修正 TS2769。两次调整只修正测试 harness，不改变生产行为或削弱断言。
- 实施 WriteSource 后同一命令：`1 pass / 0 fail / 4 expect() calls`；修正测试选项后
  再次运行仍为 `1 pass / 0 fail / 4 expect() calls`。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| 上述 focused Write 回归 | `packages/tui` | 修复前红、修复后绿；最终 1 pass，4 assertions |
| `bun test "D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx" --test-name-pattern "new Write collapsed preview" --timeout 30000` | `packages/tui` | 原始 feedback loop 转绿：1 pass，0 fail，3 assertions |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "legacy card section gaps survive collapse and expand" --timeout 30000` | `packages/tui` | 7 pass，0 fail，22 assertions |
| `bun test test/routes/session/block-tool-collapse.test.tsx test/routes/session/block-tool-preview-once.test.tsx test/routes/session/block-tool-visible-once.test.tsx --timeout 30000` | `packages/tui` | 4 pass，0 fail，19 assertions |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` | `packages/tui` | 37 pass，0 fail，747 assertions |
| `bun run test` | `packages/tui` | 708 pass，2 skip，0 fail；94 files，3803 assertions，exit 0。既有 KV 读取/写入警告未造成失败 |
| `bun typecheck` | `packages/tui` | 修正测试选项后 `tsgo --noEmit` exit 0 |
| `git diff --check` | repository root | exit 0，无 whitespace 错误 |

### Original Feedback-Loop Result

外部原始探针在真实工作区修复后已通过：`1 pass / 0 fail / 3 expect() calls`，验证行号、
语法色和十行预算，未以候选副本替代工作区验证。再次展开由仓库回归
`session-message-render.test.tsx` 独立覆盖并通过，不归入外部探针自身证据。

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Decision-surface share | Verdict |
| --- | --- | --- | --- |
| 新文件 Write collapsed source preview | primary-contract branch，WriteSource + limited + BlockTool | 与 expanded 共用同一组件 | repaired |
| 新文件 Write expanded/uncollapsed body | primary-contract branch | 与 collapsed 共用同一组件 | preserved/repaired |
| 覆写 Write、Edit、ApplyPatch、Notebook、pending Write | existing supported-domain branches | 0% changed | preserved |
| 普通文本备用 preview、新 parser/cache/state/配置 | forbidden fallback；未引入 | 0% | absent |

实际新增 alternate success path 为 0，新增 diagnostic path 为 0，diagnostic 占比为 0%。
原普通文本 preview、重复 JSX 和重复 `previewText(limited(), ...)` 包装已由批准路线取代。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 56 | 生产 15 + 测试 41；排除空行、import-only、formatter-only、生成文件、纯移动、文档和纯删除 |
| Qualifying Chinese comment lines `C` | 11 | 生产 2 + 测试 9；分别解释共享渲染/实例所有权、fixture、独立参照、公开视口/异步同步、预算和 body 重建 |
| Ratio `C / E` | 19.64%（11/56） | 仅计邻近修改点的合格解释，未计复述代码或拆行文字 |
| Required minimum `C` | 9 | `ceil(56 × 0.15) = 9`；实际 11 >= 9 |

代表性注释：`收缩与展开共享代码渲染语义；预览只消费 limited 的既有十行预算，不新增解析或折叠状态。`
以及 `preview/body 分别创建组件实例，沿用 BlockTool 的驻留与正文重建所有权。`

### Remaining Unverified Items

批准范围内无剩余未验证项；独立全 Scope 实现审计已记录 No blocking findings 和 APPROVE，
当前可执行用户授权的 scoped commit。无 Protocol/SDK/native/generated/migration 变化，无需相应
额外验证。Package 测试中的 KV 警告按实际退出码与 0 fail 记录，没有扩展为无关修复。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings | NB-01、NB-02 | APPROVE | `ses_e4aad105effeWV3q0J68zlSuVU` |

### Round 1 Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- **NB-01：外部原始探针的证据归属可更准确。** `docs/plans/tui-write-collapsed-code-preview.md:622-623` 将“再次展开”列在外部探针结果段落中，但 `D:/Temp/opencode/tui-write-collapse-preview-original-probe.test.tsx:138-170` 本身没有第二次展开。该行为已由仓库回归 `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx:412-414` 覆盖并独立通过，因此只是非阻塞的记录修正。
- **NB-02：package 测试仍有 KV 警告。** `bun run test` 输出既有 `ENOENT \tmp\opencode\state\kv.json` 读取警告，但最终为 **708 pass、2 skip、0 fail**。本 diff 不涉及 KV 路径，目标回归也全部通过，不构成本次修改的回归。

## Rejected speculation

- 不把新文件 Write 改为 diff；`exists=false` 的源码卡片与覆写 Write 的 diff 卡片是既有不同合同。
- 不要求新增跨工具公共组件、parser、cache、折叠状态、plain-text fallback 或性能框架；现有 `limited()`、`CodeRenderable` 和 `BlockTool` 已承担对应职责。
- 不将有界十行预览的必要高亮认定为性能回归；没有测量证据支持额外性能门槛，也没有新增全量内容的第二份预览。
- 不要求为异常 metadata、恶意输入或高亮失败增加本任务外的恢复逻辑；这些路径没有因本 diff 获得新的可达性。

## Requirement and traceability coverage

- **根因与 owner 正确。** 实际入口为 `ToolPart → Write`（`packages/tui/src/routes/session/index.tsx:2631-2675`）。旧实现首次分叉于新文件 Write 的 collapsed preview：preview 使用普通 `<text>`，body 使用 `line_number + code`。当前在拥有该选择的 `Write` 内修复，而非下游补偿。
- **INV-01：** 私有 `WriteSource` 统一行号、filetype、syntaxStyle 和默认颜色（`index.tsx:3603-3616`），preview/body 分别实例化（`index.tsx:3640-3643`）。公开帧测试比较展开与折叠的首行号和语法色（`session-message-render.test.tsx:369-410`）。
- **INV-02：** 原有 `limited()` 和十行/字符预算保持不变（`index.tsx:3574-3577`）；测试验证折叠时排除第 30 行、展开及再次展开恢复完整正文（`session-message-render.test.tsx:377-414`）。
- **INV-03、INV-05：** 两个 JSX 实例继续由 `BlockTool` 管理 preview 驻留、隐藏和 body 重建（`index.tsx:3325-3390`）；高亮仍由 `CodeRenderable` 执行，Session 的 pending-highlight 扫描仍可发现新增 Code 子树（`index.tsx:634-642`）。没有第二套折叠状态或内容来源。
- **INV-04：** 覆写 Write 仍走 `DiffPreview/DiffView`（`index.tsx:3620-3631`），Edit、ApplyPatch、Notebook、pending 和短内容路径未改。既有工具卡片矩阵及完整 Session 回归均通过。
- **INV-06：** 测试通过 `captureCharFrame()`/`captureSpans()` 观察用户可见行为（`session-message-render.test.tsx:170-172,385-410`），不断言内部节点类型，也不复制截断或高亮算法。旧 hunk 的普通 `<text>` 没有行号，必然无法满足 collapsed 行号条件，因此测试对原缺陷敏感。
- **SCOPE-07：** 实际任务修改仍仅为两个既有生产/测试文件及 canonical plan；无关 `bun.lock` 和其他 untracked plans 未纳入本 diff。`git diff --check` 通过。

本轮独立执行结果：

| 验证 | 结果 |
| --- | --- |
| 新增 Write focused 回归 | 1 pass，4 assertions |
| 原始外部 feedback loop | 1 pass，3 assertions |
| 完整 `session-message-render.test.tsx` | 37 pass，0 fail，747 assertions |
| 三个 BlockTool 生命周期测试文件 | 4 pass，0 fail，19 assertions |
| 既有工具卡片折叠矩阵 | 7 pass，0 fail，22 assertions |
| `bun run test` | 708 pass，2 skip，0 fail，94 files |
| `bun typecheck` | 通过 |
| `git diff --check` | 通过 |

## Primary-path and fallback verdict

唯一权威路径为：

```text
ToolPart
  → Write
  → limited()
  → WriteSource
  → line_number + CodeRenderable
  → BlockTool preview/body
```

`WriteSource` 只是同一渲染语义的两个真实调用点，不是竞争实现。普通文本 preview 及其重复 `previewText(limited(), ...)` 包装已被删除，没有保留失败后的备用成功路径。

新增 alternate success path 为 **0**，diagnostic path 为 **0**。覆写 diff、Edit、Notebook、pending 等既有受支持分支保持独立且未被修改。设计符合原需求的小 HUNK、复用现有性能机制和鲁棒性方向。

## Code quality and Chinese-comment verdict

- 局部组件具有 preview/body 两个真实复用点，不属于单次调用抽象；没有扩大公开接口、新增依赖、`any`、类型压制或无关重构。
- 测试期望来自展开态这一已知正常用户表示及独立字面量，不是复制生产算法制造绿色；既有断言和安全检查未被削弱。
- 独立重算 **E=56**：生产代码 15 行、测试代码 41 行。排除了空行、注释、纯删除、文档、import-only、formatter-only、生成代码和纯移动类别。
- 合格中文解释 **C=11**：生产 2 行、测试 9 行，分别邻近共享渲染/实例所有权、fixture、公开视口、异步高亮、预算及正文重建决策。
- **C/E = 11/56 = 19.64%**，高于 15% 实施目标所需的 `C >= 9`，也高于 10% 审计阻塞底线。

## Release verdict

**APPROVE** — 仅适用于 canonical plan **R2** 与本次审计的实际生产/测试 diff。所有阶段适用的行为、测试、类型检查、责任边界、主路径和中文注释硬门禁均通过。

可以按 workflow 记录本 verdict 并将实施标记为 `verified`，随后执行用户已授权的 scoped commit；提交只能包含 canonical plan 和两个已审计文件，不得带入无关工作树修改。本审计未创建 commit。

NB-01 disposition: §23 已将再次展开明确归入仓库回归证据，不再归入外部探针自身行为。
NB-02 disposition: KV 警告已按 708 pass、2 skip、0 fail 的实际结果保留记录，未扩大为本任务修改。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan revision.
That later implementation status is distinct from this task's requested plan approval.

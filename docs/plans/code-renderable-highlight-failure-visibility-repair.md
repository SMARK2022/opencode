# Canonical Implementation Plan: CodeRenderable Highlight Failure Visibility Repair

> Status: verified
>
> Revision: R10
>
> Approved revision: R10
>
> Audit mode: full-scope
>
> Requirement source: 用户本轮原始需求与此前关于批量 Tool/Thinking 空白、保留空白框高度、Ctrl+P 和滚动无法恢复的连续请求
>
> Implementation allowed: yes; verified exact diff, no further material changes required
>
> Last updated: 2026-08-25

本文是本任务唯一的 implementation specification。聊天摘要、旧计划和 builder 说明不构成实施授权。

## 1. Verbatim Requirement

> “是的,因此请你进行相应的CodeRenderable 在 highlight 失败后继续禁止绘制 TextBuffer。问题修复,适当按照上游内容,同时保持相应修改鲁棒稳定,不会引入新的问题。同时保持相对较小的机制调整面,以及保持相对兼容性的调整面,也就是避免因为审计者的变化导致审计范围越扩越大。”

> “生产文件修改数量不应该超过8个，同时代码修改行数不应该超过1200行。当前方案已经满足时只把要求补入本文，不需要因此重新审计。”

相关用户症状合同是：大量 Tool 输出、Thinking 和正文在某个历史节点后变成保留高度的空白框；强制全局重绘、打开 `Ctrl+P`、滚动都不能恢复；前序已经完成的内容仍可能正常显示。

## 2. Explicit Non-Goals

- 不修改 OpenCode 的每一个 Tool、Thinking 或正文调用方，不通过逐组件补 seed 解决同一个 owner 问题。
- 不改变 `drawUnstyledText` 在高亮进行中的既有语义；不把它改成始终显示。
- 不新增 Tree-sitter parser、重试、watchdog、renderer restart、定时恢复或第二条成功路径。
- 不修改 Tree-sitter worker 的 parser 资源生命周期；本任务只修复 CodeRenderable 在已到达失败终态后的表示提交。
- 不修改 `@opentui` release manifest、`bun.lock` 或发布版本。源码修复进入下一次 fork release 后才会进入安装的 tarball，这是发布流程边界，不在本任务中扩展。
- 不修改 native Zig、FFI ABI、TextBuffer native allocator 或 terminal output writer。
- 不恢复失败快照的 `onHighlight`/`onChunks` 成功回调，不把失败转换成成功高亮结果。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | OpenTUI core 是 `thirdparty/opentui/packages/core`；`packages/opencode` 是 Session/Message/Part 的生产调用方。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、一个 authoritative primary path、禁止无证据 fallback，并要求完整 traceability。 |
| `.opencode/templates/canonical-plan.md` | 规定本计划的证据、TDD、验证、审计、E/C 和实现记录结构。 |
| `AGENTS.md` | 要求优先使用 Bun；测试从 package 目录运行；根仓库不能直接运行测试。 |
| `thirdparty/opentui/AGENTS.md` | OpenTUI 使用 `bun test`；仅 TypeScript 改动不需要 native build；避免静默错误。 |
| `packages/opencode/AGENTS.md` | OpenCode 的包级验证从 `packages/opencode` 运行，并使用现有 Session/TUI 测试习惯。 |
| `docs/plans/opentui-streaming-markdown-performance-repair.md` R62 | 已有合同要求 managed rejection 提交失败快照的当前 plain text，清除 conceal mapping，完成可见状态并请求重绘。 |
| `docs/plans/opentui-tree-sitter-request-lifecycle-repair.md` R81 | 已有 Tree-sitter owner/lifecycle 修复边界；本任务不能把 producer 生命周期再次扩成新的工作流。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:121-141` | seedless `content` 更新在 `streaming && filetype && !drawUnstyledText` 路径仍保持既有 pending 语义；R2 未改变此路径。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:183-300` | public rendering setters set `_highlightsDirty=true`; cache-affecting setters advance `_cacheGeneration`, while `drawUnstyledText` and `onChunks` currently do not. `initialStyledText` is a pending-only seed and currently also sets the primary dirty flag. | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:68,235-239,381-475,599-703,818-832` | `_streamingActive` is the existing request-lifecycle owner. R8 used only a configuration tuple, so a settled streaming instance could still consume a new seed without scheduling authoritative highlight. | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:591-597` | `commitStreamingVisible()` 是 styled-success finalization helper，且无条件执行 `_highlightsDirty=false`；R7 仍只保留它在成功路径。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:675-695` | R2 one-shot rejection catch 已恢复可见的 request-local plain representation；R7 不改变这个既有 one-shot settlement。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:811-825` | `_highlightsDirty` 是 render-time 唯一会重新调度 primary highlight request 的 gate。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:269-303,904-938,2363-2400,2714-2795` | R2 tests 已断言 rejection plain-text/frame visibility、current snapshot correctness 和零 success callbacks；R7 将它们作为 preserved baseline。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:2651-2712,2825-2856` | 已有 `syntaxStyle` setter in-flight seam 证明 shared dirty gate 可调度替代请求；seeded rejection test 证明 request-local source，但 R7 增加 setter 后普通 render 的 queueing 时序。 | observed |
| `thirdparty/opentui/packages/core/src/testing/mock-tree-sitter-client.ts:132-183` | 提供可控 streaming resolve/reject seam，可稳定触发真实 CodeRenderable 失败路径。 | observed |
| `thirdparty/opentui/packages/core/src/testing/test-renderer.ts:198-231` | 提供真实 render loop 和 char frame capture，可验证用户看到的 frame，而不是只看内存状态。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Markdown.ts:464-493,642-668,977-995,998-1068` | Markdown pending seed 可以 conceal/transform 原文；它是等待期表示，不等同于 rejection 后要求的 current-source plain text。真实 producer 先更新 seed，再更新 content；R7 保留这条顺序。 | observed |
| `thirdparty/opentui/packages/core/src/renderables/Diff.ts:715-733` | conceal + wrap 时会把 `drawUnstyledText` 设为 `false`，其内部 CodeRenderable 也依赖共享 failure owner。 | reachable |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2078-2094` | `ReasoningBody` 直接使用 `drawUnstyledText={false}`，未传 `initialStyledText`。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2133-2158` | 普通完成态和流式 TextPart 直接使用 seedless CodeRenderable。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:3061-3079` | Write 内容预览和正文使用 CodeRenderable；共享同一 owner。 | reachable |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | v2 debug/feature 路径也有 `drawUnstyledText={false}` Code 调用。 | reachable |
| `packages/opencode/src/cli/cmd/tui/routes/session/notebook-tool.tsx:269` | Notebook 工具代码显示使用同一 CodeRenderable。 | reachable |
| `git show a8fe63ce2 -- packages/core/src/renderables/Code.ts` | 上游原始 Code 高亮失败后调用 `fallback(content)`，保持内容可见。 | observed |
| `git show 61023ba5e -- packages/core/src/renderables/Code.ts` | R62 版本在 streaming/one-shot failure 中提交 plain text 并请求重绘。 | observed |
| `git show 1b9a20a08 -- packages/core/src/renderables/Code.ts` | 当前 fork 在 parser lifecycle repair 时移除了两处失败表示提交，形成回归。 | observed |
| 安装的 `node_modules/@opentui/core/index-mh9nh736.js` | 当前 `0.4.3-smark.7` tarball 保留 `Code streaming highlight failed` 路径且不包含旧 plain-text 提交。 | observed |
| 已运行的单实例 Bun repro | `plainText` 有内容、height 有值、frame 为空、`_shouldRenderTextBuffer=false`。 | observed |
| 已运行的 8 实例 Bun repro | 8 个共享 client 的 CodeRenderable 全部保留高度但 `visibleTextCount=0`，frame 为空。 | observed |
| 已运行的 seed control repro | 同样 rejection 下传入 `initialStyledText` 后 pending frame 能显示 seed；这只证明等待期表示，不证明 rejection 终态可以继续使用 seed。 | observed |

## 5. Current Behavior

R2 已修复原始空白 frame divergence。当前实现的剩余问题是：

```text
rendering-semantic setter during in-flight streaming request
  -> setter sets _highlightsDirty=true / may advance _cacheGeneration
  -> request rejects
  -> R2 catch commits request-local plain content
  -> failure finalization preserves a newer R7-scope invalidation
  -> next render uses the existing primary highlight gate exactly once

seed-only setter during in-flight streaming request
  -> initialStyledText changes pending representation
  -> normal render must not call startStreamingHighlight() for unchanged content
  -> original request rejects
  -> terminal failure remains request-local plain text with no queued replacement
```

空白 frame、保留高度和普通重绘不能恢复的问题仍是本任务的历史根因证据；它们已经由 R2 production diff 和 frame-level tests 修复。R7 不重复实施该行为，只修正 failure finalization 与 pending-only seed 调度的边界，同时保护 rejection 期间较新的 rendering invalidation，并明确区分“无 setter 的 rejection 不 retry”和“有 in-scope setter invalidation 时恰好一次 rehighlight”。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 流式 Markdown 首次高亮 rejection，且 caller 没有 seed | `ReasoningBody`、流式 `TextPart` | content 已是字符串，CodeRenderable 接受该组合 | `renderSelf -> startStreamingHighlight -> runStreamingLoop -> catch` | `CodeRenderable` | observed |
| 非 streaming 或非 Markdown 的 one-shot highlight rejection | completed TextPart、Diff 内部 Code、Write/Notebook Code | filetype 和 content 已由调用方传入 | `renderSelf -> startOneShotHighlight -> catch` | `CodeRenderable` | reachable |
| streaming 非 Markdown 内容更新失败 | fenced code 或其他 streaming Code caller | 当前 snapshot 仍由 CodeRenderable 管理 | `content setter -> startOneShotHighlight -> catch` | `CodeRenderable` | observed |
| 已有 `initialStyledText` 的 Markdown block rejection | `MarkdownRenderable` | seed 用于 pending，可 conceal/transform；request 已捕获 current source | Code failure catch 必须使用 request-local `content` | `CodeRenderable` | reachable |
| Tree-sitter client 在请求期间被销毁 | renderer destroy / lifecycle owner | client rejection 会抵达 Code request | client Promise -> Code catch | `CodeRenderable` 表示 owner；client 仍拥有生命周期 | observed / reachable |
| 后续新 delta 在旧请求完成前到达 | Session event stream | Code 用 snapshot id 丢弃旧响应 | old catch sees stale snapshot and continues to latest pending content | `CodeRenderable` | observed |
| streaming request 在途时 `drawUnstyledText` 或 `onChunks` setter 变化 | Solid reconciler / public CodeRenderable props | setter 当前会置 `_highlightsDirty=true`；R5 失败结算只比较 `_cacheGeneration`，因此这两类变更可被清除 | public setter -> streaming rejection catch -> next render | `CodeRenderable` | observed / reachable |

未将 native allocator OOM、terminal writer failure、任意 malformed input 或未证明的外部 caller 作为本次 production 设计输入；它们没有必要的 first divergence 证据。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | CodeRenderable 的 highlight 请求进入终态 failure 后，必须显示该 request 已捕获的 current source plain text；不能使用 independently mutable seed，也不能留下有高度的空白或旧表示。 | 用户需求、上游 `a8fe63ce2`、R62 rejection contract、R2 frame repro | R2 `Code.test.ts:2714-2759` 已有 managed rejection frame assertion |
| INV-02 | managed parser/request rejection 不得伪装成成功高亮：rejection 发生在 success callbacks 前时，不调用 `onHighlight`/`onChunks`，不提交 styled highlight 或 conceal mapping。 | R62/R81 managed rejection contract；`runStreamingLoop` request rejection 先于 success conversion | `Code.test.ts:2707` 已断言两个 callback 次数为 0 |
| INV-03 | `drawUnstyledText=false` 的在途等待语义不变；pending 阶段仍使用既有 seed 机制，不能把未完成高亮改成全局常开。 | R74-INV-04、Markdown seed implementation | Markdown pending tests、Code pending tests |
| INV-04 | **streaming rejection 路径中**，failure 表示提交完成后，后续新 content 和请求期间发生的 rendering-semantic setter invalidation 都能继续进入一次 primary highlight；普通 rejection 在后续普通 render 中不得产生请求；每个 in-scope setter invalidation 只允许恰好一次既有 primary rehighlight。scope 包含 `filetype`、`syntaxStyle`、`conceal`、`drawUnstyledText`、`streaming`、`treeSitterClient`、`baseHighlight`、`onHighlight`、`onChunks`；`content` 由 snapshot gate 管理。`initialStyledText` 只有在 `_streamingActive=true` 时是 pending-only：非空 seed 可刷新当前等待期表示，清空 seed保留当前 buffer/visibility；`_streamingActive=false` 时保留既有 primary dirty 行为；one-shot rejection 的既有 dirty settlement 不在 R9 扩展。 | 当前 snapshot/cache generation 检查、streaming failure finalization、`_streamingActive` lifecycle、pending representation 与 `_highlightsDirty` render gate | R9 ordinary rejection、active non-empty seed、active empty seed、settled streaming seed、non-streaming seed、`syntaxStyle`、`drawUnstyledText` 与 `onChunks` tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | R2 已恢复 `runStreamingLoop()` 和 `startOneShotHighlight()` 的 request-local `content` plain-text commit；R5 不再修改该已验证 divergence。 | `CodeRenderable`，它拥有 request snapshot、TextBuffer 和 `_shouldRenderTextBuffer` | R2 source diff、Code tests、单实例及 8 实例 frame repro |
| INV-02 | managed parser/request rejection 本身无需修改 settlement；表示修复必须继续位于 callback conversion 之前的 catch。 | `CodeRenderable` | `Code.test.ts:2707` callback counters 为 0 |
| INV-03 | 无需修复；Markdown seed 和 `ensureVisibleTextBeforeHighlight()` 已存在。 | `MarkdownRenderable`/`CodeRenderable` | Markdown source 与 pending tests |
| INV-04 | R2 failure catch 复用了无条件清 dirty 的 success helper，吞掉请求期间 rendering semantic setter 留下的 `_highlightsDirty`；R7 同时修正 seed-only setter 误进入 streaming queue 的调度分叉，并保留 R6 的统一 generation marker，不改变请求队列或 one-shot settlement。 | `CodeRenderable` | R5 implementation audit B-01、R6 plan audit B-01；public `initialStyledText` interleaving 与 `onChunks`/`drawUnstyledText` setter paths |

### Historical R2 feedback loop

该 loop 属于 R2 历史根因与修复证据，不是 R5 的 red baseline。它从 `thirdparty/opentui/packages/core` 运行，使用实际 `CodeRenderable`、`MockTreeSitterClient`、真实测试 renderer 和 `captureCharFrame()`；创建 `streaming=true`、`filetype="markdown"`、`drawUnstyledText=false` 且无 seed 的 CodeRenderable；首帧发起 streaming update；reject update；等待 `highlightingDone`；执行 render；检查 frame。

已实际运行的 exact command：

```powershell
bun -e 'import { CodeRenderable } from "./src/renderables/Code.js"; import { SyntaxStyle } from "./src/syntax-style.js"; import { createTestRenderer, MockTreeSitterClient } from "./src/testing.js"; const setup = await createTestRenderer({ width: 80, height: 24 }); const client = new MockTreeSitterClient(); client.streamingAutoResolve = false; const code = new CodeRenderable(setup.renderer, { id: "repro", content: "# broken\n", filetype: "markdown", syntaxStyle: SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }), treeSitterClient: client, streaming: true, drawUnstyledText: false, left: 0, top: 0 }); setup.renderer.root.add(code); await setup.renderOnce(); const before = setup.captureCharFrame(); client.rejectStreamingUpdate(); await code.highlightingDone; await setup.renderOnce(); const after = setup.captureCharFrame(); console.log(JSON.stringify({ plainText: code.plainText, height: code.height, beforeHasText: before.includes("# broken"), afterHasText: after.includes("# broken"), shouldRenderTextBuffer: (code as any)._shouldRenderTextBuffer, highlightsDirty: (code as any)._highlightsDirty })); setup.renderer.destroy();'
```

已运行结果：

```text
plainText: "# broken\\n"
height: 2
beforeHasText: false
afterHasText: false
shouldRenderTextBuffer: false
highlightsDirty: false
```

8 个共享 client 的批量结果为：

```text
pending: 8
heights: [2,2,2,2,2,2,2,2]
plainTextCount: 8
visibleTextCount: 0
frame: ""
```

该历史 loop 直接断言用户原始症状及 R2 修复结果：内部文本存在且布局占位存在，但用户可见 frame 在旧实现中没有正文；它确定、快速、无需人工操作。

### R10 red feedback loop

R9 必须使用八个独立的 public render seams：

1. 普通 managed rejection：无 setter 变化时 reject，完成 failure 后至少执行一次普通 `renderOnce()`，断言 `pendingStreamingUpdates()` 仍为 `0`。
2. setter rejection：streaming update pending 时修改 `syntaxStyle`，reject 原请求；第一次后续 `renderOnce()` 必须产生恰好一个 pending update，resolve 它并完成渲染，再执行一次普通 `renderOnce()` 仍不得出现第二个 pending update。
3. `drawUnstyledText` rejection：streaming update pending 时修改 `drawUnstyledText`，reject 原请求；后续普通 `renderOnce()` 必须产生恰好一个 replacement update，完成后不得再次 pending。
4. `onChunks` rejection：streaming update pending 时修改 `onChunks`，reject 原请求；replacement 必须应用新 callback 的可见文本变换，且完成后不得再次 pending。
5. seed-only interleaving：streaming update pending 时只修改 `initialStyledText`，先执行一次普通 `renderOnce()` 再 reject 原请求；failure settlement 后不得出现 replacement update，pending seed 仍可作为等待期表示但终态必须是 request-local plain source。
6. empty-seed visibility：在 `streaming && filetype && !drawUnstyledText` 且请求在途时将 `initialStyledText` 设为 `undefined`，普通 render 后不得提前显示 unstyled current source。
7. non-streaming seed invalidation：在非 streaming CodeRenderable 中改变 `initialStyledText`，仍必须进入既有 one-shot primary highlight path，而不能被 pending-only 逻辑吞掉。
8. settled-streaming seed invalidation：完成一次 streaming highlight 后，在没有 active request 时改变 `initialStyledText`，必须重新进入既有 primary streaming path，不能永久覆盖 authoritative `_content` representation。

这八个 slice 共享真实 `CodeRenderable`、`MockTreeSitterClient`、renderer 和 `highlightingDone`，分别锁定“普通 failure 不 retry”、所有已证明渲染语义 setter 的“只 rehighlight 一次”，以及 seed-only 变化只在真实 `_streamingActive` 状态下不进入 primary queue。R9 不把 `initialStyledText` 无条件改成 pending-only。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| highlight failure 后的当前文本表示 | `CodeRenderable` | CodeRenderable 必须拥有可绘制的当前 TextBuffer 表示，并公开 `plainText`/layout/render 行为 | failure catch 与 `_shouldRenderTextBuffer`、TextBuffer 提交在同一 owner | Session caller 只提供 content/options；Tree-sitter 只提供 highlight request/result，不拥有 terminal representation |
| pending seed 的保留与调度 | `CodeRenderable` + `MarkdownRenderable` | 只有真实 `_streamingActive` 的 pending 状态把 seed 当等待期表示；非空 seed 可刷新等待期 buffer，空 seed 不打开 unstyled visibility；inactive 状态保留既有 primary invalidation | seed 可以 conceal/transform，不能承担 rejection 的 current-source plain contract；状态边界属于 Code owner | 每个 Tool 重复生成 seed 会复制责任并漏掉 Diff/其他 Code caller |
| Tree-sitter 错误终态 | `TreeSitterClient`/worker | request rejection 传回原调用方，不伪装成功 | 当前 client/worker 已拥有 request settlement | Code 不应吞掉错误或重试 parser；本计划只消费已到达的 failure |
| 失败诊断日志 | 现有 Code warning 路径 | 保留现有 warning，不增加生产 telemetry | 本任务只恢复表示，不扩大诊断面 | renderer、Session 和 worker 不拥有 Code 表示决策 |

## 10. Single Approved Primary-Path Design

```text
highlight request
  -> success: existing styled conversion -> existing styled commit
  -> failure: existing rejection -> commit request-local current source as plain text -> mark visible/request render
```

批准的 primary repair 是恢复上游/R62 的单一 rejection representation contract：

- streaming catch 使用当前 loop 已捕获、并通过 `_highlightSnapshotId` 验证仍为 current 的局部 `content`；调用 `textBuffer.setText(content)`、清除 rendered-line source mapping、设置 `_shouldRenderTextBuffer=true`、更新 text info 并请求重绘，但 failure path 不调用会无条件清除 dirty 的 `commitStreamingVisible()`。
- streaming failure finalization 只在该 request 期间没有新的 rendering-semantic invalidation 时把 `_highlightsDirty` 保持为 `false`；如果 in-scope setter 已将它置为 `true`，则保留 `true`，由下一次既有 `renderSelf()` dirty gate 恰好调度一次 primary highlight。普通 rejection 不得通过 failure finalization 自己制造新的 dirty。`_cacheGeneration` 作为统一 request-local invalidation marker；`drawUnstyledText` 与 `onChunks` 必须与其他渲染语义 setter 一样推进它，`initialStyledText` 不推进且不得设置 primary dirty。
- one-shot catch 使用 `startOneShotHighlight()` 已捕获并通过 `snapshotId` 验证的局部 `content`；调用 `textBuffer.setText(content)`、清除 rendered-line source mapping、把 `_shouldRenderTextBuffer` 设为 `true`，保持 R2 已验证的 one-shot failure settlement，不纳入 R10 dirty-state 扩展。
- failure catch 不读取 `_initialStyledText`。该 public setter 可以在 request in-flight 时独立改变，且 seed 可能 conceal/transform 原文；只有真实 `_streamingActive` 时才进入 pending-only 分支。active 且 seed 非空时可提交 pending seed 并请求绘制；active 且 seed 为空时保留既有 visibility gate；inactive 状态统一保留 `_highlightsDirty=true` 和既有 streaming/one-shot primary scheduling。
- streaming failure 的可见性提交与 dirty finalization 分离：没有 newer rendering semantic invalidation 时保持原有 `false`；如果 R10 scope 中任一 rendering setter 已把 `_highlightsDirty` 重新置为 `true`，下一帧必须进入既有 primary highlight path，且完成后不得再次产生 pending。
- managed request rejection failure 路径不调用 `onHighlight`/`onChunks`，不构造成功 styled result，不重试，不改变 pending 期间 `drawUnstyledText=false` 的行为；callback 自身抛错不属于该 managed rejection 合同。

这个设计修复的是 first divergence：failure catch 没有向 CodeRenderable 的 TextBuffer owner 提交终态表示。它不在 OpenCode 的 Reasoning、Shell、Edit、Write、Diff 或 Notebook 调用方分别添加补丁。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| existing styled highlight success | current | primary-contract branch | yes | existing | preserve |
| pending `_initialStyledText` commit | current | primary-contract branch | no independent success; current pending representation | existing | preserve only before terminal rejection |
| failure 后提交 request-local current source plain text | proposed restoration | existing shipped compatibility / explicit user-requested repair direction | no; it is terminal visible representation and does not invoke success callbacks | all new production decision surface | restore |
| no-filetype plain rendering | current | contracted pass-through | yes as existing non-highlight path | existing | preserve |
| Tree-sitter rejection | current | diagnostic/error path | no | existing | preserve |
| retry parser / alternate parser / caller-local fallback | not present in approved route | forbidden fallback | would produce alternate success | 0 allowed | reject |

失败后的 request-local plain text 不是“失败后再尝试成功”的 alternate success path。它是 CodeRenderable 唯一的 rejection display contract，且与上游 `fallback(content)`、R62 rejection contract 和用户要求一致；失败的高亮回调和 styled success 仍不会发生。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `1b9a20a08` 后 failure catch 仅清 `_prefixCache`/`_cachedHighlights`，依赖 caller seed 留住可见内容 | R74 实现假设所有重要 Markdown caller 都有 seed | R2 已将共同 owner 恢复为 request-local plain representation；R5 不删除该修复 | Keep the R2 `Code.ts` failure representation commit |
| 各 caller 逐个新增 seed | 未批准；会将共同表示责任复制到多个 UI consumer | CodeRenderable 已拥有同一 failure seam，调用方改动会扩大兼容面且仍可能漏掉 Diff/插件路径 | Do not add |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| 用户要求：highlight failure 后不得继续禁止 TextBuffer 绘制 | R2 `Code.ts` one-shot/streaming failure catches | R2 已提交 catch 捕获的 `content` plain text 并恢复 visibility；R5 仅保持该历史修复 | R2 `Code.test.ts` frame assertions；历史批量 red loop |
| INV-01：失败后当前正文可见、无高度空白 | R2 streaming failure catch | R2 已完成 `setText(content)` + clear line source + visible flag/text info/render request；R5 保持 | R2 `Code.test.ts` frame assertions；历史批量 red loop |
| INV-01：最新失败 snapshot 不停在旧文本或 mutable seed | R2 streaming/one-shot catches | R2 只消费 request-local `content`；R5 不改该 contract | R2 `Code.test.ts:2358` + seeded in-flight mutation test |
| INV-02：managed rejection 不进入成功回调 | existing failure catch | R5 不改变 callback settlement；只修 streaming dirty finalization | `Code.test.ts:2714` 保留 `onHighlightCalls=0`、`onChunksCalls=0` |
| INV-03：pending 语义不变 | `ensureVisibleTextBeforeHighlight` and Markdown seeds | 不修改 pending path、Markdown.ts 或 callers | existing Code/Markdown pending tests |
| INV-04：streaming rejection 保留 R10 scope 内 newer rendering invalidation，且 failure 不形成 retry | streaming failure catch -> existing `_highlightsDirty` render gate；`_streamingActive` seed setter -> pending representation path | 不调用 success helper；无 setter 时保持 dirty=false，有 R10 scope setter 时保留 dirty=true，下一帧仅由既有 dirty gate 调度一次 primary request；仅 active seed 分支不进入该 gate，inactive seed 保留既有 primary path | ordinary rejection + active non-empty/empty seed with reject/no-replacement + settled streaming seed + non-streaming seed + `syntaxStyle`/`drawUnstyledText`/`onChunks` focused tests + full `Code.test.ts` |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| failure catch 提交 request-local `content` plain text | INV-01 | R2 red repro、上游 `fallback(content)`、R62 rejection contract | R2 已修复当前 catch；R5 必须保留该 request-local failure contract，不能回退到 mutable seed |
| streaming failure visibility 与 dirty finalization 分离 | INV-01, INV-04 (streaming only) | R2 implementation audit 的 observed B-01 证明 `commitStreamingVisible()` 会吞掉 newer setter invalidation | 失败可见性需要保留，但 failure path 不能复用无条件清 dirty 的 success helper；普通 rejection 必须无 pending，setter rejection 恰好一次 pending |
| 失败测试改为 frame-level assertion | INV-01 | 现有 plainText 测试会在用户仍看不到内容时通过 | 用户症状发生在 terminal frame，不发生在 plainText getter |
| 失败快照测试改为 current content assertion | INV-01 | 2358 当前只证明旧内容未被替换，无法满足“当前内容可见” | failure catch 需要使用当前 snapshot 表示，旧 buffer 内容不能作为正确终态 |
| 保留 callback count assertions | INV-02 | R62/R81 明确禁止 failure 伪装成功 | 只检查 frame 会允许错误地调用 success callback；已有 seam 可直接保护该合同 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | modify | 保留 R2 两处 request-local plain failure commit；统一让 R10 scope 内 rendering semantic setter 推进 `_cacheGeneration`；仅在真实 `_streamingActive` 时按 seed 是否为空分流 pending representation 与既有 visibility/dirty 语义，inactive 状态保留 primary path。 | 约 +12 至 +28 行总 R2/R10 production diff；不新增 public API/helper |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | modify | 保留 R2 visibility/current-source/seed regressions；新增 ordinary no-retry、active non-empty/empty seed with rejection settlement, settled streaming seed、non-streaming seed、`syntaxStyle`、`drawUnstyledText` 与 `onChunks` focused regressions。 | 约 +125 至 +195 行总 R2/R10 test diff |

不修改 `Markdown.ts`、`Diff.ts`、OpenCode Session route、`session-v2.tsx`、release manifest、lockfile、native Zig 或 generated output。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 保留 R2 managed streaming rejection 的 frame assertion，证明当前 plain text 仍可见。 | R2 已修复原始 blank-frame divergence。 | 不重复改动该路径，只作为 R10 preserved regression baseline。 | 防止 dirty-state 修复回退可见性。 |
| 2 | 保留 R2 one-shot failure frame/current-content assertions。 | R2 已完成 one-shot visibility contract。 | 不扩大 one-shot dirty semantics。 | 防止 streaming-only rework 改坏共享 failure representation。 |
| 3 | 新增 active seed-only interleaving：`_streamingActive` 期间 `initialStyledText` mutation 后先普通 render 再 rejection，failure settlement 后 pending streaming update 必须保持 `0`，终态仍显示 request source。 | 当前 R9 只规定真实 active marker，必须验证 replacement queue 未被 seed-only render 注入。 | 仅在 `_streamingActive` 且 seed 非空时提交 pending representation，不设置 primary dirty；其他状态保留既有 dirty。 | 防止 pending seed 变化隐性变成 rejection retry 或抑制 one-shot。 |
| 4 | 新增普通 managed rejection regression：reject 后执行至少一次普通 render，pending streaming update 必须保持 `0`。 | 如果 failure path 无条件保留 dirty，下一次 render 会错误地产生 retry。 | 无 setter 时 failure visibility finalization 保持 dirty=false；普通 render 不发起新 request。 | 防止把 failure 可见性修复成自动 retry。 |
| 5 | 新增 `syntaxStyle` setter 在 streaming rejection 期间发生的 regression：reject 后 render 必须重新发起恰好一个 pending update，并最终以新 style 完成成功提交。 | R2 的 `commitStreamingVisible()` 无条件清 dirty，当前实现会让 pending count 保持 0。 | failure visibility 直接提交，不调用 success helper；保留 newer dirty，下一帧走既有 primary path 一次。 | 防止修复空白时吞掉 semantic invalidation。 |
| 6 | 新增 `drawUnstyledText` setter rejection regression：reject 后必须有恰好一个 replacement，并保持既有 pending visibility contract。 | setter 设置 dirty 但未推进 generation 时，R5 failure catch 会错误清 dirty。 | 与其他 rendering semantic setter 共享 `_cacheGeneration` marker，不新增 recovery path。 | 防止可见性模式切换在失败结算中丢失。 |
| 7 | 新增 `onChunks` setter rejection regression：replacement 必须执行新 callback 的可见文本变换，且不发生第二次请求。 | setter 设置 dirty 但未推进 generation 时，R5 failure catch 会错误清 dirty。 | 与其他 rendering semantic setter 共享 marker，由既有 dirty gate 重新高亮。 | 防止 callback 语义更新静默丢失。 |
| 8 | 新增 empty-seed rejection regression：active streaming 且 `drawUnstyledText=false` 时清空 seed，普通 render 后 reject 原请求，等待结算并再次 render；不得显示 unstyled source，且 `pendingStreamingUpdates() === 0`。 | 错误实现即使保持 frame 隐藏，也可能把 seed-only 变化写入 `_streamingPending`，在 rejection 后隐式发起 replacement。 | 清空 seed 时只保留既有 visibility/dirty 状态，不提交 unstyled source，也不启动 replacement。 | 同时锁定等待期 visibility 和 seed-only no-retry。 |
| 9 | 新增 non-streaming seed invalidation regression：非 streaming Code 的 seed mutation 仍触发 one-shot primary path。 | 无条件 pending-only setter 会吞掉既有 `_highlightsDirty`。 | 仅 active streaming 状态特殊处理，其他状态维持原 setter dirty。 | 防止兼容性 one-shot 路径被抑制。 |
| 10 | 新增 settled-streaming seed invalidation regression：完成初次 streaming highlight 后再改变 seed，仍必须由 primary path消费并恢复 authoritative content。 | R8 配置组合判断会把 settled instance 错当 pending state，seed 可以永久覆盖成功表示。 | 只使用 `_streamingActive` 判断 pending-only 分支；inactive seed 保留 dirty。 | 防止已结算内容被 pending seed 永久遮蔽。 |
| 11 | 运行完整 `Code.test.ts`、Markdown tests 和 R2 原始 frame repro。 | 需要证明 R2 visibility contract、pending seed、success conversion、cleanup、ordinary no-retry、active/inactive seed semantics、四个 setter exactly-once settlement 同时稳定。 | 所有现有与新增行为测试通过，原始 repro 保持可见。 | 防止只修状态标志而回退用户症状修复。 |

测试只观察公开可见行为、`plainText`、frame 和已有 callback contract；不通过私有 helper 调用次数证明实现正确。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 60-80 总 diff | R2 implementation diff plus R5 streaming finalization rework and ordinary/setter rejection regressions；排除 imports、空行、formatter-only、generated 和纯移动。 |
| Required Chinese explanatory comments `C` | 至少 12 | 按上界 `ceil(80 * 0.15)=12` 规划；实际 implementation 必须按真实 E 重算且不得低于 15%。 |

需要保留或新增的 qualifying comments：

- 说明 failure 是终态表示提交，不是重新尝试高亮或伪装 success。
- 说明 rejection 只使用 request-local source；mutable seed 只属于 pending 表示。
- 说明 streaming failure path 不调用会无条件清 dirty 的 success helper；请求期间的新 semantic invalidation 必须继续存在。
- 说明 frame assertion 专门锁定“plainText 有值但用户 frame 为空”的真实缺陷。
- 说明 callback count assertion 保留 failure 不进入 success conversion 的合同。
- 说明 `drawUnstyledText`/`onChunks` 与 cache-generation marker 的统一边界，以及 `initialStyledText` 为什么仍是 pending-only。
- 说明 seed-only setter 只有在真实 `_streamingActive` 且 seed 非空时刷新等待期表示；active 清空 seed 保留 visibility gate并且 rejection 后无 replacement；inactive（包括 settled streaming 与 non-streaming/one-shot）必须保留既有 primary scheduling。

不计划添加解释显然赋值、函数调用或测试名称的空洞中文注释。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test ./src/renderables/Code.test.ts` | `thirdparty/opentui/packages/core` | 完整 CodeRenderable success、pending、failure、streaming、cleanup 和 R9 active/inactive seed/setter regression。 |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | `thirdparty/opentui/packages/core` | Markdown seed、结构化 block 和 pending visibility 不被 failure repair 改坏。 |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | TypeScript library build 仍可完成；本任务不运行 native build。 |
| 原始 `bun -e` red loop（同第 8 节） | `thirdparty/opentui/packages/core` | 单实例 after frame 含正文；8 实例 visibleTextCount 从 0 变为 8；重绘后不再为空。 |

`bun run test:native` 不属于本任务验证：本次只修改 TypeScript，且当前环境没有 `zig`；不以跳过 native test 代替 TypeScript behavior evidence。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 只修改已有 Code owner 与已有行为测试。 |
| Files modified | 2 | `Code.ts` 和 `Code.test.ts`。 |
| Files deleted | 0 | 不删除现有公共路径。 |
| Production lines | 约 6-12 effective lines | 保留 R2 plain failure commit，并分离 streaming visibility 与 dirty finalization；不新增 public API、helper、状态机或 parser。 |
| Test lines | 约 45-60 effective lines | 保留 R2 visibility/seed regressions，并新增一个 setter/rejection regression；不再重复修改已完成的 R2 red slices。 |
| Generated lines | 0 | 不提交 build output、release tarball 或 native artifact。 |

用户硬上限为生产文件不超过 8 个、代码修改不超过 1200 行；R6 仍为 1 个生产文件、2 个总文件，新增修改远低于上限。

行数只是范围信号；若完整行为验证证明需要更多行，必须在 plan revision 中说明原因并重新审计。

## 20. Real Risks and Open Decisions

### Real Risks

- `initialStyledText` caller 在 pending 阶段仍显示 seed；terminal failure 必须切换为 request-local source plain text，避免 conceal/transform seed 被误当 rejection contract。
- 失败后每帧不能自动重试；R6 只允许请求期间 R6 scope setter 已留下 dirty 时，由现有 dirty gate 驱动恰好一次 primary rehighlight；普通 rejection 后保持无 pending request。
- streaming failure visibility finalization 必须区分“本次 failure 已结束”和“请求期间出现新的 rendering invalidation”；后者应保留并由现有 dirty gate 消费。`drawUnstyledText` 与 `onChunks` 通过统一 generation marker 纳入该合同，`initialStyledText` 仍不纳入。
- 安装的 OpenCode `0.4.3-smark.7` tarball 不会因 source-only 修改自动更新；要让已发布二进制获得修复，需要独立的 OpenTUI fork release/upgrade 流程。该事实记录为发布边界，不扩大本任务文件范围。

### Open Decisions Requiring the User

None. 用户已经明确要求修复 CodeRenderable failure visibility、参考上游并保持小机制面；本 plan 不引入额外产品选择。

### Rejected Speculation

- 物理 RAM 51% 本身不能证明 OOM；它不是本 plan 的 production trigger。
- native renderer full repaint、scissor、滚动坐标和 render-list cache 不能解释已复现的 `_shouldRenderTextBuffer=false` early return；不改 native renderer。
- BlockTool `visible`/`<Show>` 历史问题存在独立回归，但当前可复现的批量空白 first divergence 在 CodeRenderable failure catch；不把两个机制合并成范围膨胀的修复。
- 为每个 Tool/Thinking caller 生成 seed 是重复责任；Code owner 已有 request-local source 和 TextBuffer visibility 控制，不需要新增下游分支。
- Tree-sitter parser asset race、persistent Tree cleanup 和 worker error protocol 是相邻生命周期问题；它们可能触发 rejection，但不改变本任务已观察的 CodeRenderable terminal representation defect。

## 21. Audit Contract

独立 auditor 必须：

- 读取本 exact plan 和原始用户需求。
- 从 repository source、tests、history 和 package contracts 重建 CodeRenderable failure path。
- 将 builder transcript 和聊天中的自述视为不可信材料。
- 审计完整原始范围：seedless streaming、seeded streaming、one-shot、Diff/Tool consumer、failure callback contract、pending semantics 和 release boundary。
- 对每个 blocking finding 提供 observed/contracted/reachable 证据、producer、owner、路径、后果和 no-fallback correction。
- 检查 first divergence、primary path、secondary path、workaround、TDD 行为断言、E/C 中文注释门禁和不相关范围扩张。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 `Seed failure representation contradicts the existing rejection contract`; B-02 `The proposed seed commit is not bound to the failed snapshot`; B-03 `The new seeded failure branch has no behaviorally sensitive regression test` | N-01 `INV-02 is broader than the actual callback contract`; N-02 `The red feedback loop is described procedurally but no exact bun -e command is recorded`; N-03 `The plan's own maximum diff budget ... requires 7 qualifying Chinese comment lines ... while §17 estimates only 5-6` | BLOCK | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 2 | R2 | yes | No blocking findings. | N-01 `initialStyledText mutation test is broader than the actual Markdown producer sequence.`; N-02 `The plan’s comment estimate is feasible but implementation audit must recompute it.` | APPROVE — plan revision R2. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 3 | R3 | yes | B-01 current plan baseline still described already-fixed R2 visibility work as pending; B-02 primary path still referenced `commitStreamingVisible()` while requiring dirty preservation; B-03 unconstrained INV-04 covered one-shot route without production/test mapping. | N-01 diff-budget upper bounds were internally inconsistent. | BLOCK — R3. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 4 | R4 | yes | B-01 R4 did not separately prove ordinary rejection no-retry and setter rejection exactly-once rehighlight. | N-01 historical R2 red loop was not labeled separately; N-02 stale INV-01 evidence wording; N-03 setter scope wording; N-04 forward traceability mixed R2 and R4; N-05 E/C range ambiguity; N-06 callback-thrown wording broader than managed rejection. | BLOCK — R4. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 5 | R5 | yes | No blocking findings. | N-01 rendering semantic setter scope should be explicitly bounded; N-02 focused R5 loop lacks separate exact command/output; N-03 historical line references drift; N-04 E/C estimate range slightly exceeds §19 split upper bound; N-05 resolution mapping recorded after verdict. | APPROVE — plan revision R5. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 6 | R6 | yes | B-01 `Seed-only initialStyledText mutation can still enqueue a post-rejection streaming update`. | N-01 setter scope broader than explicit rejection slices; N-02 cumulative diff/E-C estimate imprecise; N-03 current-behavior wording drift. | BLOCK — plan revision R6. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 7 | R7 | yes | B-01 `initialStyledText` clearing can expose unstyled source while `drawUnstyledText=false`; B-02 unconditional seed scheduling isolation can suppress the non-streaming one-shot primary path. | Focused command names and representative setter coverage remain implementation-evidence notes. | BLOCK — plan revision R7 is not approved. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 8 | R8 | yes | B-01 configuration tuple was not actual pending state; B-02 missing settled-streaming test mapping. | R8 command block and historical wording drift. | BLOCK — R8. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 9 | R9 | yes | B-01 inactive seed dirty instructions conflicted; B-02 active empty-seed test did not detect replacement queueing. | Scope/line-budget estimate drift; `_streamingActive` reverse mapping could be more explicit. | BLOCK — R9. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 10 | R10 | yes | No blocking findings. | §10 wording remains historically broad; §8 title and §18 verification label drift; diff estimates differ across historical/current sections; R8 row was previously pending and is now recorded above. | APPROVE — plan revision R10 | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |

### R1 Verbatim Independent Verdict

```text
## Blocking findings

### B-01 Seed failure representation contradicts the existing rejection contract

- Violated invariant: Managed highlight rejection must commit the failed snapshot’s current source as plain text; the plan must preserve one authoritative failure representation.
- Evidence class: contracted
- Producer and execution path: `TreeSitterClient.updateStreamingBuffer()` rejects at `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:701-739` -> `CodeRenderable.runStreamingLoop()` catch -> proposed `commitPendingRepresentation()`.
- Source evidence: `docs/plans/opentui-streaming-markdown-performance-repair.md:155-169` explicitly requires current-source plain text on rejection. Seeded Markdown callers provide `initialStyledText` at `thirdparty/opentui/packages/core/src/renderables/Markdown.ts:642-665`.
- Canonical-plan evidence: `code-renderable-highlight-failure-visibility-repair.md:173-179` proposes seed-or-plain; `:187-194` classifies both as the same compatibility path.
- Responsibility owner: `CodeRenderable` failure representation owner.
- Concrete consequence: A rejected seeded request will display pending `StyledText` rather than the contracted current source. That seed may conceal or transform text and is not the R62 rejection behavior or the upstream `fallback(content)` behavior.
- Why this is not speculative: The seeded Markdown producer and managed rejection seam both exist, and the cited verified plan states the plain-text contract.
- Minimal correction direction: Make the failure path follow one explicit contract. The current revision must either restore current-source plain text for rejection or explicitly supersede the R62 contract with user-authorized semantics and dedicated evidence; it cannot silently combine seed and plain representations.

### B-02 The proposed seed commit is not bound to the failed snapshot

- Violated invariant: The failure representation must correspond to the current failed snapshot and must not introduce stale or blank output.
- Evidence class: reachable
- Producer and execution path: `startOneShotHighlight()` captures `content` and `snapshotId` at `thirdparty/opentui/packages/core/src/renderables/Code.ts:589-593`; `initialStyledText` can change through the public setter at `:235-239` without incrementing `_highlightSnapshotId`; the planned catch then reads mutable `_initialStyledText` and `_content` through `commitPendingRepresentation()` at `:342-351`.
- Source evidence: The Solid reconciler forwards arbitrary public properties through `thirdparty/opentui/packages/solid/src/reconciler.ts:341-344`; the setter has no seed/content validation or snapshot binding.
- Canonical-plan evidence: `code-renderable-highlight-failure-visibility-repair.md:175` assumes seed and content come from the same snapshot, but no mechanism enforces that assumption.
- Responsibility owner: `CodeRenderable`, which owns snapshot validity and the representation commit.
- Concrete consequence: A seed changed while a request is in flight can be committed when the old request rejects, producing a stale, mixed, or empty visible representation while the snapshot check still passes.
- Why this is not speculative: `initialStyledText` is an exported Code option and public setter with a current reachable prop path; no upstream owner validates its temporal relationship with the request.
- Minimal correction direction: The failure commit must consume a representation captured and validated with the same request snapshot; an independently mutable seed cannot be used as the failure result without that ownership guarantee.

### B-03 The new seeded failure branch has no behaviorally sensitive regression test

- Violated invariant: INV-01 explicitly covers both seeded and seedless failure representations.
- Evidence class: reachable
- Producer and execution path: Markdown creates seeded `CodeRenderable` instances at `thirdparty/opentui/packages/core/src/renderables/Markdown.ts:642-665` and `:977-995`; `MockTreeSitterClient.rejectStreamingUpdate()` provides the rejection seam at `:132-183`.
- Source evidence: Existing failure tests in `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:269-300`, `:904-933`, `:2358-2393`, and `:2707-2751` are seedless. Markdown tests at `:1449-1509` cover pending visibility only, not seeded rejection.
- Canonical-plan evidence: `code-renderable-highlight-failure-visibility-repair.md:205-212` and `:233-243` claim seeded behavior is covered by existing tests, but no seeded rejection slice is specified.
- Responsibility owner: `Code.test.ts` through the public Markdown/Code rendering seam.
- Concrete consequence: The proposed seed-specific production behavior can regress while every planned test remains green; INV-01 and the exact compatibility claim remain unverifiable.
- Why this is not speculative: The seeded producer and controlled rejection are both current executable paths.
- Minimal correction direction: Add a red-capable seeded rejection test at the existing Markdown/Code renderer seam, or remove the unverified seeded failure behavior from the canonical design.

## Non-blocking findings

- **N-01:** INV-02 is broader than the actual callback contract. `onHighlight` and `onChunks` execute before the surrounding catch at `Code.ts:486-496` and `:527-536`; if a callback throws, the failure path has already invoked a callback. Narrow the invariant to managed parser/request rejection.
- **N-02:** The red feedback loop is described procedurally but no exact `bun -e` command is recorded. The OpenCode verification also uses the installed `0.4.3-smark.7` tarball and cannot validate the source change directly. The core tests remain the relevant evidence.
- **N-03:** The plan’s own maximum diff budget is up to `43` effective lines (`8 + 35`), which requires `7` qualifying Chinese comment lines at the 15% floor, while §17 estimates only `5-6`. This is an estimate-quality issue; implementation audit must recalculate `E/C`.

## Rejected speculation

- Native Zig, terminal writer, allocator, RAM-pressure, and renderer repaint failures lack a reachable first divergence for this plan.
- Arbitrary malformed input and unknown external callers are not valid blocking inputs without a producer or explicit interface contract.
- Tree-sitter parser lifecycle repair, retry, watchdog, and release/tarball changes are adjacent concerns already excluded by the plan and are not required to establish the CodeRenderable representation defect.

## Requirement and traceability coverage

- The first divergence and owning module are correctly identified: the failure catches leave `_shouldRenderTextBuffer` false after rejection.
- Seedless streaming and one-shot visibility are mapped to `Code.ts` and frame-level tests.
- Callback non-success behavior and no-retry intent are mapped for managed rejection.
- Seeded rejection behavior is claimed but not behaviorally mapped or verified, and its semantics conflict with the verified plain-text rejection contract.
- The two-file production/test boundary is restrained and does not expand into caller, native, release, or lockfile changes.

## Primary-path and fallback verdict

The plan preserves the existing successful highlight path and does not introduce a parser retry, alternate parser, caller-local fallback, or second success algorithm. The owner choice is correct.

However, the failure representation is not currently one authoritative semantic path: the plan permits both seed and plain output while citing an existing contract that requires plain output. The exact R1 revision therefore fails the contract and snapshot-ownership gates.

## Code quality and Chinese-comment verdict

Plan mode has no implementation diff, so actual code-quality and `E/C` approval cannot be issued. The proposed file scope is otherwise small and avoids public API/native changes. The comment estimate has the non-blocking upper-bound mismatch noted in N-03.

## Release verdict

**BLOCK.** Revision R1 is not approved, and implementation remains disallowed. A revised canonical plan with an incremented revision requires another full-scope audit.
```

### R2 Resolution Mapping

| R1 finding | R2 resolution |
| --- | --- |
| B-01 | failure contract 收敛为上游/R62 的 request-local current source plain text；seed 只属于 pending。 |
| B-02 | 两个 catch 直接消费各自已捕获并经 snapshot check 验证的局部 `content`，不读取 mutable `_initialStyledText`/`_content`。 |
| B-03 | 新增 seeded in-flight mutation + managed rejection 行为测试，断言终态是 request source plain text 而不是新 seed。 |
| N-01 | INV-02 收窄为 managed parser/request rejection，明确 callback 自身抛错不属于该断言。 |
| N-02 | 第 8 节记录已实际运行的 exact `bun -e` command；安装 tarball 测试不再作为 source change 证明。 |
| N-03 | E 上界调整为 60，计划 C 最少 9；implementation 仍按实际 E 重算。 |

### R2 Verbatim Independent Verdict

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01 — `initialStyledText` mutation test is broader than the actual Markdown producer sequence.**  
  R2 appropriately proves that `CodeRenderable.initialStyledText` is independently mutable through its public setter. The test should state it is a `CodeRenderable` interface-boundary regression, rather than implying ordinary `MarkdownRenderable` updates normally mutate only the seed without updating content. This does not weaken the test or block the plan.

- **N-02 — The plan’s comment estimate is feasible but implementation audit must recompute it.**  
  Section 17 correctly budgets `C >= 9` against the `E = 60` upper bound. Actual effective modified lines, qualifying Chinese comments, exclusions, and ratio remain implementation-audit work.

## Rejected speculation

- Native renderer repaint, scissor, terminal writer, allocator/OOM, scrolling, and command-palette transitions have no demonstrated first divergence after `CodeRenderable.renderSelf()` already skips the `TextBuffer`.
- Parser lifecycle repair, retry, alternate parser, watchdog, caller-local seeds, release manifest, lockfile, and tarball upgrade are adjacent concerns outside this owner-level repair.
- Callback-thrown exceptions are not covered by INV-02; R2 correctly narrows it to rejections that occur before successful callback conversion.

## Requirement and traceability coverage

| Requirement / invariant | Verified owner and path | Planned verification |
|---|---|---|
| Failure must no longer leave a height-preserving blank frame | `CodeRenderable.runStreamingLoop()` and `startOneShotHighlight()` catches | Frame-level managed rejection and one-shot tests |
| Failure representation is current request source | Catch-local `content`, guarded by snapshot identity | Updated-current-content and seeded in-flight mutation rejection tests |
| Failure remains distinct from styled success | Existing catch before callback conversion for managed request rejection | `onHighlight` / `onChunks` zero-call assertions |
| Pending `drawUnstyledText=false` semantics remain intact | Existing `MarkdownRenderable` seed + `ensureVisibleTextBeforeHighlight()` behavior | Existing Markdown and Code pending tests |
| New content may highlight after failure without auto-retry | Existing dirty/snapshot lifecycle | Full `Code.test.ts` and repeated-render repro |

The producer-to-consumer chain is established from Session/Markdown/Diff callers through `CodeRenderable.content`, `renderSelf()`, visibility gating, Tree-sitter request settlement, and terminal-frame rendering. The first divergence remains the two failure catches in `thirdparty/opentui/packages/core/src/renderables/Code.ts:445-457` and `:677-689`, which clear state without restoring a drawable representation.

R2 repairs that owner with request-local `content`; it does not consume mutable `_initialStyledText`, alter callers, or expand the parser/renderer/release boundary.

## Primary-path and fallback verdict

The exact R2 design has one authoritative rejection-display contract:

```text
request rejection
  -> validated request-local source
  -> TextBuffer plain-text commit
  -> clear rendered-line mapping
  -> existing visibility/render finalization
```

This is an existing compatibility/display contract, not an alternate highlight success path: it performs no retry, alternate parser selection, callback conversion, styled-result construction, or caller-local fallback. The successful syntax-highlighting path remains unchanged.

## Release verdict

**APPROVE — plan revision R2.**

The approval applies only to `docs/plans/code-renderable-highlight-failure-visibility-repair.md` at R2. Implementation remains disallowed until the orchestrating agent records this full-scope verdict administratively, sets `Status: approved`, `Approved revision: R2`, and `Implementation allowed: yes`; any substantive edit requires a new revision and full audit.
```

任何 substantive plan revision 都必须递增 revision、清空 approval 并重新进行完整范围审计。

## 23. Historical R2 Implementation Evidence

Implementation followed approved revision R2 exactly. The user-provided hard limit is also met: 1 production file changed, 2 code files changed in total, and 58 added/modified diff lines before excluding imports/blank lines.

### Actual Files and Diff

| File | Actual change | Why necessary |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | Both failure catches now commit the catch-local request `content` as plain TextBuffer text, clear rendered-line source mapping, and restore visible/render-finalization state. | Repairs the first divergence in the owner that controls `_shouldRenderTextBuffer` and TextBuffer drawing. |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | Three existing failure expectations now assert current plain-text frame visibility; managed rejection adds a frame assertion; one public `initialStyledText` mutation boundary regression was added. | Locks the user-visible blank-frame contract, current snapshot contract, and no-success-callback contract. |

Actual code diff from `thirdparty/opentui`:

```text
2 files changed
58 insertions(+), 9 deletions(-)
1 production file changed
0 release/native/generated files changed
```

### Red-Green Test Evidence

1. Added frame assertion to managed streaming rejection test. Before the repair it failed with `plainText="# broken\\n"`, height `2`, and a frame containing only spaces. After the streaming catch repair it passed.
2. Changed one-shot failure assertion from blank frame to visible unstyled plain text. Before the one-shot catch repair it failed with an all-space frame. After the repair it passed.
3. Changed streaming non-Markdown one-shot failure assertion from stale initial text to the failed snapshot source. It passed after the same one-shot catch repair.
4. Added the approved seeded interface-boundary test: while streaming update was pending, public `initialStyledText` was changed to `MUTATED SEED`; rejection still produced `# request source` and excluded the mutated seed. It passed after the request-local `content` implementation.

The production repair was deliberately implemented after the first red slice and before related regression slices; no test was weakened to make the existing implementation pass.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test ./src/renderables/Code.test.ts -t "managed rejection commits current plain text without success callbacks"` | `thirdparty/opentui/packages/core` | Red before fix; green after fix, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "commits unstyled plain text when highlighting throws"` | `thirdparty/opentui/packages/core` | Red before one-shot fix; green after fix, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "keeps failed drawUnstyledText=false output visible and unstyled"` | `thirdparty/opentui/packages/core` | Green, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "streaming with drawUnstyledText=false commits the failed snapshot as plain text"` | `thirdparty/opentui/packages/core` | Green, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "streaming rejection uses request source after initialStyledText changes"` | `thirdparty/opentui/packages/core` | Green, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts` | `thirdparty/opentui/packages/core` | 73 pass, 1 skip, 0 fail, 2 snapshots, 251 expect calls. |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | `thirdparty/opentui/packages/core` | 156 pass, 0 fail, 91 snapshots, 391 expect calls. |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | Library bundle and declarations generated successfully. |

### Original Feedback-Loop Result

The exact original single-instance repro changed from:

```text
beforeHasText: false
afterHasText: false
plainText: "# broken\\n"
height: 2
```

to:

```text
beforeHasText: false
afterHasText: true
plainText: "# broken\\n"
height: 2
```

The corrected batch repro used marker-based matching and a tall viewport to avoid confusing culling with blank rendering:

```text
pending: 8
plainTextCount: 8
visibleTextCount: 8
markers: [true,true,true,true,true,true,true,true]
```

The earlier batch check with height 24 reported only 6 visible markers because two renderables were below the viewport; the corrected height-80 run proves all 8 are visible.

### Actual Secondary and Replacement Path Inventory

| Path | Actual disposition |
| --- | --- |
| Successful syntax-highlighting path | Unchanged and remains the only styled-success path. |
| Pending `initialStyledText` | Unchanged; remains a pending-only representation. |
| Request rejection | Restored existing upstream/R62 plain-text terminal representation; no retry, alternate parser, callback conversion, or success-shaped result. |
| Caller-local seed/fallback | Not added. |
| Native/release/tarball path | Not changed. |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 52 | 53 added nonblank lines minus 1 import-only line; excludes blank, formatter-only, generated and pure-move lines. |
| Qualifying Chinese comment lines `C` | 8 | 2 production failure-contract comments and 6 adjacent behavior-test intent comments. |
| Ratio `C / E` | 15.38% | `8 / 52`. |
| Required minimum `C` | 8 | `ceil(52 * 0.15) = 8`. |

Representative qualifying comments explain: request-local rejection source versus mutable pending seed; frame-level assertion versus plainText-only false confidence; unstyled output versus successful highlight; and the public setter boundary regression.

### Remaining Unverified Items

- The installed `@opentui/core@0.4.3-smark.7` OpenCode tarball was intentionally not changed; a separate fork release/upgrade is required before a bundled OpenCode executable consumes this source repair.
- Native Zig tests were not run because this task changes TypeScript only and the environment has no `zig`; the package-local TypeScript tests and `build:lib` passed.
- No source-level OpenCode Session test was used as proof of this source repair because `packages/opencode` resolves the published tarball rather than the vendored OpenTUI source. The direct Code/Markdown seams and original frame loop cover the affected owner.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 implementation | yes | B-01 `Streaming rejection clears a newer semantic invalidation` | E/C counting used two compatible scopes; native Zig unavailable because `zig` is not installed. | BLOCK — implementation rework required. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |

## 25. R5 Implementation Evidence

### Actual Files and Diff

| File | Actual change | Why necessary |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | R2 request-local plain failure representation remains. R5 captures each streaming request's cache generation and makes the rejection finalization restore visibility while retaining dirty only when an in-flight rendering-semantic setter changed that generation. | `CodeRenderable` owns the request snapshot, TextBuffer visibility and shared render-time dirty gate; this prevents the success helper from dropping a newer style/conceal/base-highlight/onHighlight invalidation. |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | Adds the two R5 public rendering seams: ordinary rejection has no pending retry after another render; in-flight `syntaxStyle` invalidation produces exactly one replacement update, applies the new style, then produces no extra update. R2 visible-frame/current-source/seed regressions remain. | Separately locks both sides of INV-04 without observing private implementation state or adding a test-only interface. |

Actual nested OpenTUI diff:

```text
2 files changed
128 insertions(+), 9 deletions(-)
1 production file changed
0 release/native/generated files changed
```

The user hard limit remains satisfied: one production file is below eight and 137 raw code diff lines are below 1200.

### R5 Red-Green Evidence

1. Before the R5 production change, `bun test ./src/renderables/Code.test.ts -t "streaming rejection preserves a style invalidation for one replacement update"` failed deterministically: expected `pendingStreamingUpdates()` to be `1` after rejection and render, received `0`. This directly proved that `commitStreamingVisible()` cleared the newer dirty invalidation.
2. The minimal production repair removed only the streaming failure call to `commitStreamingVisible()`. It restores visible TextBuffer state directly and compares the request-local cache generation with the current generation to preserve only rendering-semantic invalidations.
3. The first repair attempted to preserve all dirty changes and correctly made the style slice green, but the existing seeded request-source regression failed because `initialStyledText` is pending-only and must not schedule a replacement highlight. Capturing the request-local cache generation corrected that boundary; the style and seed tests both then passed.
4. The ordinary managed rejection test now exercises a second normal render and observes `pendingStreamingUpdates() === 0`; it remains green, proving the failure itself does not retry.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test ./src/renderables/Code.test.ts -t "streaming rejection preserves a style invalidation for one replacement update"` | `thirdparty/opentui/packages/core` | Red before R5 repair (`Expected: 1`, `Received: 0`); green after, 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "managed rejection commits current plain text without success callbacks"` | `thirdparty/opentui/packages/core` | Green, 1 pass, 0 fail; checks two no-pending points around an ordinary render. |
| `bun test ./src/renderables/Code.test.ts -t "streaming rejection uses request source after initialStyledText changes"` | `thirdparty/opentui/packages/core` | Green, 1 pass, 0 fail; verifies pending seed mutation does not create a replacement request or replace request-local source. |
| `bun test ./src/renderables/Code.test.ts` | `thirdparty/opentui/packages/core` | 74 pass, 1 skip, 0 fail, 2 snapshots, 258 expect calls. |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | `thirdparty/opentui/packages/core` | 156 pass, 0 fail, 91 snapshots, 391 expect calls. |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | Passed; library bundle, declarations and tree-sitter assets generated. |
| `git diff --check` | `thirdparty/opentui` | Passed. |
| Original single-instance `bun -e` frame loop | `thirdparty/opentui/packages/core` | `afterHasText: true`, `plainText: "# broken\\n"`, `height: 2`, `pending: 0`. |
| Original eight-instance `bun -e` frame loop | `thirdparty/opentui/packages/core` | `pending: 0`, `plainTextCount: 8`, `visibleTextCount: 8`, all eight markers true. |
| `bun typecheck` | `thirdparty/opentui/packages/core` | Not green due to existing package-wide dev/generated Yoga test configuration errors (`expect`/`test` globals, `.ts` import extension, missing JSON module resolution) plus unrelated dev files. No diagnostic named `Code.ts` or `Code.test.ts`. |

### Actual Primary-Path and Workaround Record

```text
streaming request
  -> success: existing styled commit -> commitStreamingVisible()
  -> managed rejection: request-local plain TextBuffer commit
       -> restore visible/render state directly
       -> no rendering-semantic setter: dirty=false, no retry
       -> cache-generation-changing setter: dirty=true, one existing primary rehighlight
```

The R5 rejection display is still one terminal failure representation, not a second success algorithm. It adds no parser retry, alternate parser, caller fallback, styled-result synthesis, callback conversion, native change, release change or caller-local seed. The obsolete R2 failure reuse of the success-only `commitStreamingVisible()` helper has been removed from the streaming rejection path.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 117 | 130 added lines minus 1 import-only line and 12 blank lines; excludes generated, formatter-only and pure-move lines. |
| Qualifying Chinese comment lines `C` | 18 | Adjacent production and behavior-test comments explain request-local source, pending-seed exclusion, cache-generation invalidation, terminal-frame visibility, no-retry and exactly-once replacement invariants. |
| Ratio `C / E` | 15.38% | `18 / 117`. |
| Required minimum `C` | 18 | `ceil(117 * 0.15) = 18`. |

### Remaining Unverified Items

- Native Zig tests were not run: this changes TypeScript only and `zig` is unavailable in the environment.
- Package-wide `bun typecheck` is currently blocked by existing dev/generated Yoga test configuration diagnostics unrelated to `Code.ts` and `Code.test.ts`; TypeScript library build and all relevant behavior suites pass.
- The installed `@opentui/core@0.4.3-smark.7` tarball was intentionally not changed. A separate OpenTUI fork release/upgrade is required before the bundled OpenCode executable consumes the source repair.

本任务只有在 approved plan、实现、行为验证和独立 full-scope implementation audit 全部满足合同后，才能进入 `verified`，再按用户要求创建 commit。

## 26. R6 Plan Revision and R5 Blocker Resolution

R5 的独立 implementation audit 返回了一个属于本任务 owner、同一用户症状链和同一 INV-04 的 blocking finding；因此 R5 approval 被清空，当前 plan 递增为 R6，implementation 被重新禁止。R5 的两项行为证据和 R2 visibility/current-source 修复保留为基线，不被撤回。

### R5 Blocking Finding (Recorded)

```text
### B-01 The R5 implementation uses cache-generation change as a proxy for all rendering semantic invalidation, but the plan’s INV-04 scope includes setters that do not advance that generation

Violated invariant: Every rendering semantic setter included in R5 must survive an in-flight streaming rejection and cause exactly one existing primary rehighlight; pending-only seed changes must not cause a replacement request.

Observed reachable evidence: CodeRenderable.drawUnstyledText and onChunks setters set _highlightsDirty=true without advancing _cacheGeneration, while the R5 failure catch sets _highlightsDirty = requestCacheGeneration !== this._cacheGeneration. A real public-seam repro changed onChunks during a pending streaming update, rejected it, and observed pending: 0 instead of one replacement.

Minimal correction direction: Make the canonical contract and implementation use one authoritative marker for the exact R6 rendering-semantic scope. Preserve dirty for every declared rendering setter while keeping initialStyledText pending-only; do not add a second retry path.

Release verdict: BLOCK — implementation does not satisfy the exact approved R5 contract.
```

### R6 Authoritative Scope

The R6 rendering-semantic invalidation scope is exactly the following public `CodeRenderable` setters:

```text
filetype, syntaxStyle, conceal, drawUnstyledText, streaming,
treeSitterClient, baseHighlight, onHighlight, onChunks
```

`content` remains governed by `_highlightSnapshotId` and the latest-wins pending queue. `initialStyledText` remains a pending-only representation and is deliberately excluded from replacement invalidation. No caller, parser, renderer, release, or native scope is added.

### R6 Primary Repair

```text
R6-scope setter
  -> existing _highlightsDirty=true
  -> authoritative request invalidation marker advances
  -> streaming request rejects
  -> request-local plain failure representation becomes visible
  -> marker comparison preserves dirty only when the request became stale
  -> existing renderSelf() dirty gate performs exactly one primary rehighlight
```

The minimal production change is to make `drawUnstyledText` and `onChunks` advance the existing `_cacheGeneration` marker when they set `_highlightsDirty`. This is the current owner’s existing invalidation mechanism, adds no public API or helper, and prevents R5’s proxy from erasing reachable setter invalidations. `initialStyledText` is not changed and does not advance the marker.

### R6 TDD Slices

| Order | Red behavior | Why current R5 code fails | Minimal green behavior |
| --- | --- | --- | --- |
| 1 | While a streaming update is pending, change `drawUnstyledText`, reject the request, render once, and observe exactly one replacement request; resolve it and verify no second pending request. | The setter sets dirty but does not advance `_cacheGeneration`; R5 catch clears dirty. | Advance the existing marker in the setter; reuse the current failure finalization and dirty gate. |
| 2 | While a streaming update is pending, change `onChunks` to a callback that transforms the full visible text, reject the request, and verify one replacement applies the new transformation with no second request. | The setter sets dirty but does not advance `_cacheGeneration`; R5 catch clears dirty and the new callback is never reprocessed. | Advance the existing marker in the setter; the existing primary replacement runs and uses the public callback. |
| 3 | Re-run ordinary rejection, `syntaxStyle` replacement, seeded source, complete Code/Markdown suites and original frame repro. | The marker change must not turn ordinary rejection into retry or pending seed mutation into replacement. | Existing R5/R2 contracts remain green. |

### R6 Traceability and Budget

| Requirement | Owner/path | File/test evidence |
| --- | --- | --- |
| INV-04 preserves every declared rendering-semantic setter | `CodeRenderable` setter invalidation + streaming rejection catch | `Code.ts`; new `drawUnstyledText` and `onChunks` rejection slices |
| `initialStyledText` remains pending-only | `CodeRenderable.initialStyledText` setter and request-local failure catch | existing seeded rejection test |
| Ordinary rejection does not retry | streaming failure finalization + existing dirty gate | existing managed rejection no-pending test |
| Original blank frame remains repaired | streaming/one-shot failure visibility commits | existing frame-level tests and single/eight-instance repros |

Expected R6 diff remains within user limits: one production file, one behavior-test file, no generated/native/release files, approximately 2 production added lines plus two focused tests and their qualifying comments, and well below 1200 total code lines.

### R6 Verification

```text
bun test ./src/renderables/Code.test.ts -t "drawUnstyledText setter rejection preserves one replacement update"
bun test ./src/renderables/Code.test.ts -t "onChunks setter rejection preserves one replacement update"
bun test ./src/renderables/Code.test.ts
bun test ./src/renderables/__tests__/Markdown.test.ts
bun run build:lib
git diff --check
```

All Bun commands run from `thirdparty/opentui/packages/core`; `git diff --check` runs from `thirdparty/opentui`. The original frame repro is rerun after the focused slices. `bun typecheck` and native Zig availability retain the R5 documented limitations.

### R6 Audit Gate

R6 was not approved. Its full-scope plan audit returned the blocking finding recorded in §27; no implementation was authorized for R6 and its design is not treated as approval for R7.

## 27. R7 Plan Revision and R6 Blocker Resolution

R6 的独立 plan audit 返回了一个属于同一 `CodeRenderable` owner、同一 pending-only invariant 和同一 streaming rejection 调度链的 blocking finding；因此 R6 不获批准，R7 重新清空 approval。R6 设计中补齐 `drawUnstyledText`/`onChunks` generation marker 的方向保留，但必须再隔离 seed-only setter 的 primary scheduling effect。

### R6 Blocking Finding (Recorded)

```text
### B-01 Seed-only initialStyledText mutation can still enqueue a post-rejection streaming update

Violated invariant: initialStyledText must remain a pending-only representation. A seed-only mutation must not schedule a replacement highlight or turn an ordinary rejection into a retry.

Observed reachable evidence: the public initialStyledText setter sets _highlightsDirty=true; a normal render while the original request is pending enters renderSelf() and startStreamingHighlight(), which writes current content into _streamingPending. The original request then rejects, while the loop consumes the queued pending update. A public-seam repro produced pendingBeforeReject: 1 and pendingAfterReject: 1 after seed setter -> render -> reject.

Minimal correction direction: Keep seed-only changes on the pending-representation path and prevent them from entering startStreamingHighlight() or populating _streamingPending when the content snapshot is unchanged. Add the sequence regression; do not add retry, alternate parser, or caller fallback.

Release verdict: BLOCK — plan revision R6 is not approved.
```

### R7 Authoritative Scheduling Boundary

`initialStyledText` remains a public pending representation setter, but it is not a primary highlight invalidation. Its setter must update `_initialStyledText`, submit the pending representation through the existing `commitPendingRepresentation()` path, and request a render without setting `_highlightsDirty`. `content` changes continue to increment `_highlightSnapshotId` and schedule the existing primary streaming path. All R7 rendering-semantic setters continue to use `_highlightsDirty`; `drawUnstyledText` and `onChunks` continue to advance `_cacheGeneration`.

This is not a caller workaround: `CodeRenderable` already owns both the seed representation and the render gate. It prevents one internal state bit from meaning both “pending display changed” and “primary highlight must be scheduled”.

### R7 Primary Repair and TDD

```text
initialStyledText setter
  -> update pending seed
  -> commitPendingRepresentation()
  -> requestRender()
  -> no _highlightsDirty / no _streamingPending

R7 rendering-semantic setter
  -> _highlightsDirty=true
  -> existing cache-generation marker advances where required
  -> rejection finalization preserves dirty
  -> existing renderSelf() schedules exactly one primary replacement
```

| Order | Red behavior | Why current R6 path fails | Minimal green behavior |
| --- | --- | --- | --- |
| 1 | Change only `initialStyledText`, execute a normal `renderOnce()`, reject the original streaming request, then assert `pendingStreamingUpdates() === 0` and request-local plain text is visible. | The setter sets `_highlightsDirty`; the normal render starts a streaming update even though content did not change, and rejection then drains it. | Remove only the setter’s primary dirty assignment; commit the pending seed and request a render through the existing pending path. |
| 2 | Re-run the four R6 slices: ordinary rejection, `syntaxStyle`, `drawUnstyledText`, and `onChunks`, including exactly-once replacement and no second pending request. | The scheduling split must not remove legitimate primary invalidation. | Keep R6 generation-marker behavior unchanged for rendering-semantic setters. |
| 3 | Re-run seeded current-source, complete Code/Markdown suites and original single/eight-instance frame loops. | Seed must remain visible while pending but must not become terminal failure source or retry. | Existing R2/R5 behavior remains green. |

### R7 Traceability and Budget

| Requirement | Owner/path | File/test evidence |
| --- | --- | --- |
| Seed-only changes remain pending-only | `CodeRenderable.initialStyledText` setter -> `commitPendingRepresentation` | new seed interleaving regression |
| Rendering semantic invalidations survive rejection | existing setter generation markers -> streaming failure finalization | R6 `drawUnstyledText`/`onChunks`/`syntaxStyle` regressions |
| Ordinary rejection does not retry | streaming failure finalization and existing dirty gate | existing no-pending regression plus seed interleaving |
| Original blank frame remains visible | request-local failure catches | existing frame-level tests and original repros |

Expected R7 change remains one production file and one test file, no callers/Markdown/native/release files, below eight production files and 1200 total code lines. The production delta is one removed dirty assignment plus pending representation/render calls; actual E/C must be recomputed after implementation.

### R7 Plan Audit Gate

R7 is not approved and implementation remains disallowed until an independent full-scope plan audit returns `No blocking findings` and `APPROVE — plan revision R7`.

## 28. R7 Audit Result and Open Decision

The resumed independent auditor returned `BLOCK — plan revision R7 is not approved` without further tool exploration. The blocking behavior remains inside `CodeRenderable` but requires the seed scheduling transition to be state-bounded:

- While a streaming request is active, a non-empty seed may refresh only the pending representation; clearing the seed must preserve the existing visibility gate and must not reveal current unstyled source when `drawUnstyledText=false`.
- Outside an active streaming request, including non-streaming and one-shot paths, the public setter must preserve the existing `_highlightsDirty` primary scheduling behavior.

The canonical workflow's original six full plan-audit rounds were consumed by R1 through R6. The user explicitly authorized six additional rounds; R8 is the first additional revision and remains subject to the same full-scope standard. Until R8 receives an independent clean verdict, `Status` remains `audit-required`, `Approved revision` remains `none`, and `Implementation allowed` remains `no`.

## 29. R8 Plan Revision and R7 Blocker Resolution

R7 的独立 plan audit 返回了两个属于 `CodeRenderable` 状态边界的 blocking findings。R8 不扩大 owner 或调用方范围，而是将 `initialStyledText` 的特殊处理精确限制到 `streaming && filetype && !drawUnstyledText` 的 pending 状态：非空 seed 只更新等待期表示；空 seed 不打开 unstyled visibility；其他状态维持既有 primary dirty scheduling。

### R7 Blocking Findings (Recorded)

```text
### B-01 initialStyledText 清空时会破坏 drawUnstyledText=false 的等待语义

Evidence: public initialStyledText accepts StyledText | undefined; R7's unconditional commitPendingRepresentation() calls setText(_content) and sets _shouldRenderTextBuffer=true when the seed is undefined. A reachable empty-seed producer exists through the public setter and Markdown reuse path.

### B-02 R7 会抑制非 streaming CodeRenderable 的既有 one-shot primary path

Evidence: the public setter currently sets _highlightsDirty and renderSelf() routes non-streaming/non-Markdown instances through startOneShotHighlight(). R7's unconditional pending-only setter design would remove that dirty transition and could leave a non-streaming seed visible without the existing one-shot rehighlight.

Release verdict: BLOCK — plan revision R7 is not approved.
```

### R8 State-Bounded Primary Design

```text
initialStyledText setter
  -> if streaming && filetype && !drawUnstyledText:
       non-empty seed -> commit pending representation + request render
       empty seed     -> preserve existing visibility gate; no unstyled commit
  -> otherwise:
       preserve _highlightsDirty=true and existing primary path
```

The setter remains in `CodeRenderable`; no caller-side condition, new fallback, or second highlight path is introduced. The R8 tests cover both branches and the prior R6 rendering-semantic invalidation regressions.

### R8 Audit Gate

R8 is not approved and implementation remains disallowed until the independent auditor returns `No blocking findings` and `APPROVE — plan revision R8` for the full original scope plus these state-bounded producer paths.

## 30. R8 Audit Result and R9 Resolution

The independent auditor returned `BLOCK — plan revision R8 is not approved` because R8 used the configuration tuple `streaming && filetype && !drawUnstyledText` instead of the real request lifecycle marker. A settled streaming renderable could therefore treat a new seed as pending and bypass the primary highlight path. R9 corrects this by using the already-owned `_streamingActive` state and adds the missing settled-streaming behavior test.

### R8 Blocking Finding (Recorded)

```text
### B-01 R8 still treats a configuration combination as actual pending state

Evidence: public initialStyledText setter is reachable at any time; R8 checks only streaming/filetype/drawUnstyledText and does not require _streamingActive. After a streaming request settles, a new seed can be committed and permanently cover the authoritative content without scheduling primary highlight.

### B-02 R8 lacks an executable settled-streaming test mapping

Evidence: the plan covers active non-empty and empty seed cases but does not test the same configuration after the request has settled. A wrong configuration-only implementation would pass the listed tests.

Release verdict: BLOCK — plan revision R8 is not approved.
```

### R9 Authoritative State Boundary

The pending-only branch is now defined by `_streamingActive`, which is set by the existing `runStreamingLoop()` owner and cleared in its existing `finally` block. No new lifecycle state is introduced:

```text
_streamingActive=true
  -> non-empty initialStyledText: commit current pending representation + request render
  -> empty initialStyledText: retain existing visibility gate; do not set unstyled content

_streamingActive=false
  -> initialStyledText setter retains _highlightsDirty=true
  -> existing streaming/non-streaming primary path consumes authoritative content
```

R9 is not approved and implementation remains disallowed until an independent full-scope audit returns `No blocking findings` and `APPROVE — plan revision R9`.

## 31. R9 Audit Result and R10 Resolution

The independent auditor returned `BLOCK — plan revision R9 is not approved` for two contract-level issues. R10 makes the inactive branch normative rather than merely descriptive and strengthens the active empty-seed test so it observes the full rejection settlement, including the absence of a queued replacement.

### R9 Blocking Findings (Recorded)

```text
### B-01 R9 had conflicting inactive-seed dirty instructions

Evidence: §10 said initialStyledText “不得设置 primary dirty” while §10, INV-04 and the R9 boundary required inactive seed mutation to retain _highlightsDirty=true for settled streaming and one-shot paths.

### B-02 R9 active empty-seed test could pass while an unauthorized replacement was queued

Evidence: the planned visibility-only assertion did not reject the original request or assert pendingStreamingUpdates() after failure settlement. The existing dirty gate can keep the frame hidden while still enqueueing _streamingPending.

Release verdict: BLOCK — plan revision R9 is not approved.
```

### R10 Normative State Contract

```text
if (_streamingActive) {
  if (value !== undefined) {
    _initialStyledText = value
    commitPendingRepresentation()
    requestRender()
    return
  }

  _initialStyledText = undefined
  // Preserve the current waiting visibility state; do not setText(_content).
  requestRender()
  return
}

_initialStyledText = value
_highlightsDirty = true
```

The inactive branch is the required behavior for both settled streaming and non-streaming/one-shot renderables. The active empty-seed branch must complete the original rejection and assert no replacement request; it is not sufficient to assert only that the frame remains hidden. No new state, fallback, parser path, or caller change is introduced.

### R10 Audit Gate

R10 is approved for implementation under the exact contract recorded above. Any substantive implementation-scope change requires a new revision and full-scope audit.

## 32. R10 Verbatim Independent Plan Verdict

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- §10 `:200` 仍保留“`initialStyledText` 不得设置 primary dirty”的宽泛历史措辞，但 R10 已通过 §10 `:202` 和 §31 `:927-948` 的 exact normative pseudocode 明确限定：只有 `_streamingActive=true` 时不设置 dirty，inactive 分支必须设置 `_highlightsDirty=true`。实施应以 R10 normative contract 为准。
- §8 仍以 “R9 red feedback loop” 为标题，其中 empty-seed 摘要只描述等待期 visibility。当前 authoritative TDD 表 §16 `:269` 已补充 rejection settlement、再次 render 和 `pendingStreamingUpdates() === 0`，因此属于历史标题和摘要漂移。
- §18 `:299` 的 verification evidence仍写 “R9 active/inactive regression”，应理解为当前 R10 slices。
- Diff estimates不一致：§15 预计 production `12-28` 行、test `125-195` 行，§19 仍记录 production `6-12` 行、test `45-60` 行，§17 又以 `E=60-80` 估算注释。这不授权突破用户硬限制，也不降低实际 15% comment门禁，属于实施审计时需要重算的记录问题。
- §22 已记录 R9 verdict，但 R8 audit record仍保留 `pending`。这不影响 R10 metadata和实施合同。

## Rejected speculation

- `_streamingActive` 在 `startStreamingHighlight()` 与 `runStreamingLoop()` 之间没有可达的异步空窗：调用 `runStreamingLoop()` 后会同步执行到第一个 `await`，并先将该 marker设为 `true`。
- post-destroy setter、callback自身抛错、native allocator、Zig renderer、terminal writer和任意 OOM场景没有本轮 owner-level reachability证据。
- parser retry、alternate parser、watchdog、renderer restart、caller-local seed fallback与release更新均不属于该修复。
- Markdown producer的属性顺序不需要 caller补丁：seed先于content更新时，active seed只改变pending representation，随后的content setter仍负责authoritative highlight scheduling；inactive seed和content均复用既有dirty gate。
- settled-streaming与non-streaming seed tests在当前baseline上可能是preservation tests，而非新的red tests；它们能在R8/R7错误实现上失败，并保护R10状态边界，不构成测试缺口。

## Requirement and traceability coverage

- **原始空白问题：** streaming和one-shot rejection继续提交request-local `content`、清除rendered-line mapping、打开`_shouldRenderTextBuffer`并请求render；R2 frame tests与单实例/八实例repro继续验证用户可见结果。
- **Failure contract：** managed rejection不调用`onHighlight`或`onChunks`，不构造styled success，不读取mutable seed。
- **Active non-empty seed：** `_streamingActive=true`时提交pending seed并请求绘制，不设置primary dirty；测试在普通render后拒绝原请求，证明没有replacement且终态是request source。
- **Active empty seed：** 保持当前waiting visibility，不调用`setText(_content)`、不设置dirty；R10 test完成原请求rejection并断言`pendingStreamingUpdates() === 0`。
- **Inactive seed：** settled streaming与non-streaming/one-shot均设置`_highlightsDirty=true`，继续由现有`renderSelf()` primary gate消费authoritative content。
- **Semantic setters：** `syntaxStyle`、`drawUnstyledText`和`onChunks` slices分别验证rejection后的exactly-one replacement、实际新语义生效及无第二请求；ordinary rejection单独证明no retry。
- **Consumers：** Markdown、Diff、Reasoning、TextPart、Write与Notebook均继续通过共享`CodeRenderable` owner获得行为，不需要caller修改。
- **Verification：** package-local完整`Code.test.ts`、Markdown suite、`build:lib`和原始frame repro均有明确工作目录和预期证据。
- **范围：** 计划只修改`Code.ts`和`Code.test.ts`，其中生产文件1个；即使采用§15上界，总代码增量也远低于1200行，满足用户硬限制。

## Primary-path and fallback verdict

R10 保留一条authoritative semantic path：

```text
render-time dirty gate
  -> existing streaming or one-shot highlight
  -> success: existing styled commit
  -> managed rejection: request-local plain terminal representation
```

`initialStyledText`只是active request期间的pending representation。inactive mutation仍回到同一primary highlight path。Failure plain representation属于`CodeRenderable`的terminal display contract，不是第二次解析或成功替代路径。

计划没有新增parser、retry、alternate parser、watchdog、caller-local fallback、配置开关、native修复或第二成功算法。状态、表示、调度和failure settlement均由`CodeRenderable`拥有。

Plan mode没有actual diff，因此不能计算实际`E`和`C`。R10明确承诺实施时按真实effective changed lines重算，并满足：

```text
C >= ceil(E * 0.15)
```

计划列出的中文注释主题覆盖failure terminal contract、request-local source、generation marker、active/inactive seed boundary和行为测试意图，具备满足门禁的可行性。实施审计必须忽略当前漂移估算，独立计算实际`E/C`。

## Release verdict

**APPROVE — plan revision R10**

批准仅适用于当前exact R10。任何生产行为、状态边界、测试合同、文件范围或fallback classification的实质修改都必须递增revision并重新进行full-scope plan audit。

## 33. R10 Implementation Evidence

### Actual Files and Diff

Only the approved OpenTUI owner and its behavior tests changed:

| File | Actual responsibility | Necessity |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | Preserves the existing request-local plain failure settlement; advances `_cacheGeneration` for `drawUnstyledText` and `onChunks`; makes `initialStyledText` state-aware: while `_streamingActive`, non-empty seed refreshes pending representation and empty seed preserves the current waiting visibility; while inactive, the existing `_highlightsDirty` primary scheduling remains unchanged. | `CodeRenderable` owns the request lifecycle, pending representation, dirty gate and TextBuffer visibility. This is the first divergence owner identified by R10. |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | Adds public-seam regressions for active non-empty/empty seed interleavings, settled streaming seed, non-streaming seed, `drawUnstyledText` invalidation and `onChunks` invalidation. Existing ordinary rejection, style replacement, frame, source and callback tests remain. | These tests distinguish pending-only representation from primary scheduling and prove no retry or exactly-once replacement through `MockTreeSitterClient` and the real test renderer. |

Nested OpenTUI diff summary:

```text
2 files changed
378 additions, 9 deletions in the exact unified diff
1 production file changed
0 caller, Markdown, Diff, native, generated, release or lockfile source files changed
```

The production-file hard limit is `1 <= 8`; the total code diff is far below `1200` lines. Build output is ignored and is not part of the changed source path.

### Red-Green Evidence

1. The active non-empty seed interleaving was red before the repair: after `initialStyledText` mutation, a normal render and rejection, `pendingStreamingUpdates()` was expected `0` but was `1`. The repaired state-aware setter passed and returned request-local plain text.
2. The active empty seed interleaving was independently red before the repair with the same `Expected: 0`, `Received: 1` result. The repaired empty branch kept the pending frame hidden, completed rejection as plain request source and left no replacement request.
3. Settled streaming seed and non-streaming seed preservation slices passed after the state boundary was implemented, proving inactive seed mutation still re-enters the existing primary streaming/one-shot path.
4. To capture the approved generation-marker red signal, the two marker increments were temporarily removed from the production file. Both focused tests then failed deterministically with `Expected: 1`, `Received: 0` after rejection. The exact approved increments and explanatory comments were restored immediately; no test or final behavior was weakened.
5. After restoring the approved route, `drawUnstyledText` and `onChunks` focused tests each passed with one replacement and no later pending request.

### Verification Commands and Results

All Bun commands below ran from `thirdparty/opentui/packages/core`:

| Command | Result |
| --- | --- |
| `bun test ./src/renderables/Code.test.ts -t "active seed mutation does not enqueue a replacement after rejection"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "active empty seed preserves waiting visibility and does not retry after rejection"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "settled streaming seed mutation re-highlights authoritative content"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "non-streaming seed mutation keeps the one-shot primary path"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "streaming rejection preserves a drawUnstyledText invalidation for one replacement update"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts -t "streaming rejection preserves an onChunks invalidation for one replacement update"` | 1 pass, 0 fail. |
| `bun test ./src/renderables/Code.test.ts` | 80 pass, 1 skip, 0 fail, 2 snapshots, 282 expect calls. |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | 156 pass, 0 fail, 91 snapshots, 391 expect calls. |
| `bun run build:lib` | Passed; library bundle, declarations and tree-sitter assets generated. |

`bun typecheck` was also run from the package directory. It remains non-zero because of existing `dev/`, generated Yoga test globals/imports, missing `src/lib/fonts/*.json` module resolution, and unrelated pointer/configuration diagnostics. No reported diagnostic names `Code.ts` or `Code.test.ts`; behavior suites and library build are green.

From `thirdparty/opentui`, `git diff --check` passed.

### Original Feedback-Loop Result

The original single-instance frame loop now reports:

```text
plainText: "# broken\\n"
height: 2
beforeHasText: false
afterHasText: true
shouldRenderTextBuffer: true
highlightsDirty: false
pending: 0
```

The original eight-instance shared-client loop with an 80-row viewport reports:

```text
pendingBefore: 8
pendingAfter: 0
plainTextCount: 8
visibleTextCount: 8
markers: [true,true,true,true,true,true,true,true]
```

### Actual Secondary and Replacement Path Inventory

| Path | Actual verdict |
| --- | --- |
| Existing styled success path | Preserved; `commitStreamingVisible()` remains success-only. |
| Active non-empty `initialStyledText` | Existing pending representation path; no primary dirty or replacement request. |
| Active empty `initialStyledText` | Existing waiting visibility is preserved; no unstyled source commit and no replacement request. |
| Inactive `initialStyledText` | Existing primary dirty path; settled streaming and one-shot instances rehighlight authoritative content. |
| Streaming rejection | Request-local plain terminal representation; no parser retry, callback success conversion or alternate success path. |
| R10 semantic setters | Existing primary dirty gate with `_cacheGeneration` marker preservation; exactly one replacement in focused tests. |
| Caller-local fallback/parser/native/release path | Not added. |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 334 | Independent final audit calculation: nested unified diff added lines `378`, minus `1` import-only line and `43` blank lines; excludes formatter-only, generated and pure-move lines. |
| Qualifying Chinese explanatory comment lines `C` | 51 | 51 adjacent Chinese comments explain request-local failure source, pending seed boundary, `_cacheGeneration` semantics, active/inactive lifecycle, frame-vs-plainText evidence, no-retry and exactly-once replacement intent. The stale active-dirty comment was corrected and is not counted as a duplicate. |
| Ratio `C / E` | 15.27% | `51 / 334`. |
| Required minimum `C` | 51 | `ceil(334 * 0.15) = 51`. |

### Remaining Unverified Items

- Native Zig tests were not run because `zig` is unavailable; this implementation changes TypeScript only.
- Package-wide `bun typecheck` remains blocked by unrelated existing dev/generated/Yoga/JSON configuration diagnostics as recorded above.
- The installed `@opentui/core@0.4.3-smark.7` tarball was intentionally not changed; a separate fork release/upgrade is required before a bundled OpenCode executable consumes this source repair.

## 34. R10 Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R10 implementation | yes | B-01 actual Chinese explanatory comments were below the 15% hard gate; one stale active-dirty comment was inaccurate. | Diff/E/C evidence initially drifted from actual nested diff; package-wide typecheck remains blocked by existing unrelated diagnostics; native Zig tests unavailable; installed tarball unchanged by approved release boundary. | BLOCK — implementation rework required. | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |
| 2 | R10 implementation | yes | No blocking findings. | Current nested diff is `378 additions, 9 deletions`; `bun typecheck` remains blocked by unrelated existing diagnostics; native Zig unavailable; installed tarball unchanged by approved release boundary. | APPROVE — R10 implementation | `ses_fddfc8436ffeSFJ3Nj6Zm3zm7J` |

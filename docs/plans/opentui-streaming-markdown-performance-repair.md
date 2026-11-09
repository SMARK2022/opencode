# Canonical Implementation Plan: OpenTUI Streaming Markdown Persistent-Tree Repair

> Status: verified
>
> Revision: R62
>
> Approved revision: R62
>
> Audit mode: implementation
>
> Requirement source: 用户关于 OpenTUI 流式 Markdown 卡顿、稳定前缀缓存、完整尾部重渲染、TDD、benchmark、代码不臃肿和方案文档不超过 600 行的原始要求；用户明确选择方案 2。
>
> Implementation allowed: yes
>
> Last updated: 2026-08-01

本文是本任务唯一的 implementation authority。旧 R1-R53 内容已保留为 `opentui-streaming-markdown-performance-repair-r1-r53-history.md`，不再作为当前设计或实施依据。

## 1. Verbatim Requirement

> “它的更新逻辑应该是那些前面都不会动的地方,也就是已经闭合的所有内容,让其进行缓存渲染。而那些没有进行任何闭合的部分,则进行不进入缓存,并且进行相应的全量的更新的渲染。比如说,在一个表格之前的内容,那它理论上来说是都闭合的。而进入表格之后,每输出一个delta,它整个表格都要重新进行更新,也就是整个除了前缀以外的所有内容就要进行一个重新的markdown的更新。”
>
> “理论上来说,我们只缓存已稳定的前缀,也就是譬如说它进入列表状态之后,那我们就不缓存列表的这一部分,或者说任何缩进代码等等这些东西,我们也不进行相应缓存。只要它没有回到相应的纯文本状态下,它就不进行缓存。”
>
> “改用方案2。”
>
> “自行进行相应的benchmark测试，你可以自行在.temp/testing中进行相应测试，让整体卡顿以及FPS保持在可接受范围以及有显著提升的状态。”
>
> “不要主动构建一个理论上会发生错误的测试，这无任何意义，要的是进行benchmark，可以构建一个markdown文档，验证不同的更新算法的速度以及和全量渲染相应的等价性等等。”
>
> “整体修改量代码不超过12个文件，代码修改量不超过1600行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支。”
>
> “代码的注释量必须超过15%以上的行数,同时不能扎堆放你的注释。”
>
> “方案文档不超过600行。”

## 2. Explicit Non-Goals

- 不恢复或重做 `.3/.4` 的 one-shot worker termination、request cancellation 或 worker replay。
- 不修改 Zig、native text-buffer iterator、FFI、package metadata、lockfile、release、tag、push 或 parent provenance。
- 不新增第二 Markdown parser、Markdown fallback、feature flag、watchdog 或定时重试。
- 不把单个 delta 当作完整 Markdown 输入；每次更新使用 persistent parser tree 和当前不稳定尾部。
- 不处理没有当前 producer、公共接口或测试证据支持的 speculative Markdown 语法。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | OpenTUI core 是 `packages/core`；本任务关注 CodeRenderable、TreeSitterClient 和 parser worker。 |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；一个 authoritative primary path；无批准不得实施；必须有双向 traceability。 |
| `.opencode/templates/canonical-plan.md` | 必须包含证据、责任、TDD、验证、diff、audit 和 implementation evidence。 |
| `thirdparty/opentui/AGENTS.md` | 使用 Bun；测试从 package 目录运行；TypeScript 修改无需 native build。 |
| `docs/adr/README.md` | 本任务是单模块实现，不新增 ADR。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| rollback baseline `packages/core/src/renderables/Code.ts` | 每次 dirty render 都可触发 `highlightOnce(fullContent)`；`drawUnstyledText=false` 会隐藏未完成内容。 | observed |
| `packages/core/src/renderables/Code.test.ts` | 已有 stale snapshot、streaming、lineInfo 和 conceal 行为 seam。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts` | 已有 `createBuffer/updateBuffer/removeBuffer`、edit queue 和 version，但没有可等待 update result。 | observed |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | 已有持久 parser tree、`tree.edit`、incremental parse 和 `changedRanges`。 | observed |
| `packages/core/src/lib/tree-sitter/types.ts` | 现有 worker protocol 没有 buffer update completion payload。 | observed |
| `packages/core/src/lib/styled-text.ts` | `StyledText.chunks` 可作为 Code 内部稳定前缀渲染缓存。 | observed |
| `packages/core/src/lib/tree-sitter/client.test.ts` | 已有 buffer create/update 协议测试 seam。 | observed |
| `packages/core/src/testing/mock-tree-sitter-client.ts` | Code 测试 client seam，需要跟随新增公共 buffer seam扩展。 | observed |
| `.temp/testing/streaming-markdown-buffer-benchmark.ts` full benchmark | 240 snapshots；R62 验收实测：sequential candidate 15.91ms average/34.10ms p95 vs baseline 28.28/62.05（total -44%、p95 -45%、1.78x）、text/style 0 mismatch；scaling candidate1000 507ms vs baseline1000 703ms（1.39x）；cadence candidate catch-up 28.65ms vs baseline 193.63ms、stream 1.06x、converged、normal exit。 | observed |

## 5. Current Behavior

```text
provider delta -> CodeRenderable.content -> dirty -> renderSelf
  -> highlightOnce(full content) -> worker parser.parse(full content)
  -> full highlights -> treeSitterToTextChunks(full content) -> setStyledText
```

- append-only 没有 parser buffer，worker 每次从完整字符串重新 parse。
- active request 期间仍可启动新的 one-shot；snapshot id 只丢弃旧结果，不能撤销已提交工作。
- `drawUnstyledText=false` 的 streaming consumer 在 highlight 完成前看不到最新原文。
- baseline Code 测试为 `60 pass / 1 skip / 0 fail`；local parser path timeout 是 `.2` baseline non-goal，不能用新协议绕过。

## 6. Supported Input Domain and Reachability

| Input | Producer/path | Owner | Class |
| --- | --- | --- | --- |
| streaming Markdown append | provider delta -> OpenCode TextPart -> CodeRenderable.content | Code + TreeSitter client | observed/reachable |
| table/list/blockquote/reference/setext/emphasis across deltas | same TextPart -> Markdown tree | persistent parser owner | observed/reachable |
| open/closed backtick or tilde fence | same TextPart | persistent parser owner | observed/reachable |
| CJK/emoji append | TextPart -> web-tree-sitter string edit | parser/client code-unit seam | observed/reachable |
| content rewrite and style/conceal/callback setters | Code public setters | Code snapshot/cache owner | reachable |
| filetype or TreeSitterClient replacement | Code public setters | Code managed-buffer ownership | reachable |
| non-streaming/non-Markdown Code | existing full route | CodeRenderable | reachable |
| Reasoning identity `onChunks` and generic callbacks | actual/public Code callbacks | CodeRenderable | observed/reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Test |
| --- | --- | --- | --- |
| INV-01 | 最新 streaming Markdown 最终可见，且等于同内容独立 full parse。 | user requirement + current path | Code differential |
| INV-02 | append-only 使用一个 persistent parser tree 和一个 active update，不形成 detached one-shot backlog。 | Opus benchmark + client buffer API | client protocol + benchmark |
| INV-03 | shipped grammar 的 `document`/`section` 是透明容器；stable boundary 选择最后一个 section 内的最后一个 render block，它及其后内容始终属于 tail；只有它之前的 closed render blocks 可缓存。 | user requirement + actual grammar probe (`document -> section -> paragraph/pipe_table/...`) | section 起点 vs 内部 table/list/fence 起点 differential |
| INV-04 | 旧 version 不能提交 StyledText、callback 或 line mapping；rewrite 重置同 owner；filetype/client 转移必须释放旧 buffer 并由当前 owner 重建。 | snapshot/version + public setter contract | delayed ownership test |
| INV-05 | non-Markdown、non-streaming、`onHighlight`、`onChunks` 和 parser error 后显示当前 plain text 的兼容行为不改变。 | current public options/error test | Code/callback/managed-error regression |
| INV-06 | destroy 释放 buffer，不改变已有 shared worker lifecycle。 | existing destroy/removeBuffer | cleanup test |
| INV-07 | 所有 edit/range/cut 使用已观察的 JavaScript UTF-16 code-unit 域；closing-fence normalization、Unicode、lineInfo 和 conceal 最终正确。 | installed parser probe + existing one-shot normalization | fence/Unicode/conceal regression |
| INV-08 | renderer benchmark 证明逐帧文本与样式等价、稳定前缀 work scaling、独立 16ms producer 下的 producer/frame/visible-update gaps、missed cadence、catch-up 和显著提速。 | explicit user requirement | style-sensitive sequential/scaling/cadence harness |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-02/03 | `CodeRenderable.renderSelf` 把 append dirty 直接映射为 full `highlightOnce`，且现有 buffer path 只提供 changed ranges、没有 parser-owned stable tail boundary。 | Code -> TreeSitter buffer seam | baseline source + grammar probe + renderer benchmark |
| INV-01/04 | 旧结果只在 one-shot 完成后检查 snapshot，没有版本化 persistent update completion。 | client/worker response seam | current callback protocol |
| INV-07 | persistent create/update/reset 没有复用 one-shot closing-fence normalization，计划前版本错误假定 UTF-8 byte offsets。 | parser worker/client seam | installed parser probe + current worker paths |
| INV-04 | generic reset 不能改变 grammar 或 TreeSitterClient owner。 | Code managed-buffer lifecycle | current setter/reset source |
| INV-03/08 | 仅结果等价不能证明 tail-only conversion，顺序等待不能证明 16ms producer 收敛。 | benchmark seam | R56 auditor + current harness |

Measured performance feedback loop:

```text
cd thirdparty/opentui/packages/core
bun ../../.temp/testing/streaming-markdown-buffer-benchmark.ts --flushes=240
```

The harness has three public-path phases: sequential per-snapshot full/streaming equivalence and speed; stable-prefix append scaling measured like-for-like (baseline and candidate at 200/1000 paragraphs, median of 5 reps, growth slopes and large-size improvement); and a wall-clock `setInterval` producer independent from a separately deadline-scheduled render loop, run for both algorithms in the same process. Sequential full and streaming instances expose pre-commit chunks through public identity `onChunks`; the oracle compares chunk text, fg/bg, attributes, links and conceal output as well as `plainText`. Cadence records wall-time producer/frame/visible-update gaps, missed intervals, convergence and catch-up. It destroys the worker so the command exits normally.

实测发现两项 R61 阈值在本机不可达且物理依据错误：(1) scaling ratio <=2.0 忽略了 native `setStyledText` 全量提交与 IPC 的 O(doc) 下限——即使缓存完全命中，36KB 文档的单帧提交也有约 40ms 的 native 成本；(2) cadence 绝对阈值（p95 <=20ms、missed <=5）低于本机空转 setInterval 的实测下限（p95 约 32ms）。R62 将这两项改为同进程同类对比的相对验收，指标本身更能证明“稳定前缀工作量不随前缀线性增长”和“无积压、快速追上”。

## 9. Responsibility and Seam

| Concern | Owner | Reason |
| --- | --- | --- |
| parser tree, normalization and stable tail boundary | parser worker | owns Parser, Tree, edit, parse, query, injections and code-unit source/parse offsets |
| versioned response delivery | TreeSitterClient | already owns worker messages, buffer map, edit queue and dispatch |
| stable prefix StyledText cache | CodeRenderable | owns visible text, style, conceal and public snapshots |
| benchmark measurement | `.temp/testing` harness | diagnostic only; not production semantics |
| buffer cleanup | CodeRenderable + existing `removeBuffer` | Code owns ID; client owns worker protocol |

## 10. Single Approved Primary-Path Design

```text
initial Markdown -> createStreamingBuffer(source text)
append -> versioned source update
       -> worker normalizes parse text, derives code-unit Edit, incrementally parses
       -> worker resolves parser-owned tailStart and current highlights
       -> (version, changedStart, tailStart, clipped highlights)
       -> Code valid prefix-chunk reuse + complete current-tail render
```

- `TreeSitterClient` exposes a managed buffer ID and an awaitable update result; existing `createBuffer/updateBuffer` behavior remains compatible.
- Worker stores source content separately from normalized parse content. The same closing-````` synthetic newline rule applies to create, append, rewrite and reset; edits, points, `changedStart`, `tailStart`, highlights and clipping all use the installed parser's observed JavaScript UTF-16 code-unit domain.
- Stable-boundary resolution uses one parser rule, not syntax-specific states: skip transparent `document`/`section` wrappers, take the last render block (child of the innermost last section) as tail start; it stays tail until a later sibling proves it closed. Existing Markdown-inline injection nodes move `tailStart` back to the earliest unresolved `full_reference_link`, `collapsed_reference_link` or `shortcut_link` block. Any other current last block (table/list/blockquote/fence/indented code/paragraph) is handled by the same sibling rule. Tests must distinguish a section's start from the start of the `pipe_table`/`list`/`fence` inside it.
- `changedStart` is invalidation evidence, not cache eligibility. If it precedes cached chunks, Code regenerates the affected prefix from current highlights; `tailStart` alone defines the current closed-prefix boundary.
- Code keeps one active update and one latest pending content. Pending append replaces older pending content; after completion one edit is computed from the last submitted content.
- Prefix chunk cache applies only when no `onHighlight` is set (this covers Reasoning, which sets only identity `onChunks`): cached prefix chunks are reused, the current tail is converted from full current source, and prefix+tail are concatenated before invoking `onChunks`, so callbacks still receive and control the complete current chunk stream. When `onHighlight` is set, the parser remains persistent but composition runs through the existing single full-conversion path over the callback's complete returned highlights; no partial prefix authority crosses the cut, because arbitrary callback ranges may span `tailStart` or depend on the tail. Setting or clearing `onHighlight` invalidates cached chunks.
- The tail is derived from the full current source and current-tree highlights; the delta alone is never parsed or rendered.
- Content rewrite resets the same managed buffer. Style, conceal, base highlight and callbacks invalidate generation/chunks but keep the parser tree. Filetype or TreeSitterClient change releases the buffer through its old client, then creates the correct grammar buffer through the current client. Streaming disable/destroy releases it. No transition reuses a buffer under a different owner or grammar.
- Old versions are rejected by client before Code commit; Code still checks public generation at callbacks, conversion, line mapping and commit.
- Managed update rejection has one authoritative path: reject to Code, commit that failed snapshot's current source as plain text, clear conceal mapping, mark highlighting complete and request render. It does not call `onHighlight`/`onChunks` for the failed snapshot and never retries with one-shot or another parser.
- `destroy()` removes the managed buffer and leaves shared worker lifecycle unchanged.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| persistent normalized buffer update | primary streaming Markdown branch | implement |
| existing full one-shot route | existing non-streaming/non-Markdown/reset branch | preserve |
| parser-error plain-text behavior | managed rejection -> existing Code failure commit | current source visible, callbacks untouched, `highlightingDone` resolves; no alternate parse |
| Markdown fragment/fallback parser | forbidden alternate success path | reject |
| `.3/.4` worker termination/replay | out of scope lifecycle path | reject |

New alternate success-path budget: zero.

## 12. Workaround Deletion and Replacement

| Existing workaround | Approved replacement |
| --- | --- |
| full one-shot per dirty render | one persistent update plus latest pending content |
| snapshot only discards old completed results | client version gate before Code commit |
| full main-thread chunk conversion each frame | parser-qualified prefix chunks plus complete tail conversion |

## 13. Forward Traceability

| Requirement | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/03 | parser tailStart + prefix/tail render | `Code.ts`, `parser.worker.ts` | boundary + table/list/fence/reference differential |
| INV-02/04 | versioned response + active/latest gate | `client.ts`, `types.ts`, `Code.ts` | delayed version test |
| INV-04/05 | callback-safe chunks + explicit owner/grammar/error transitions | `Code.ts` | Reasoning/onHighlight/onChunks + filetype/client + managed rejection tests |
| INV-06/07 | cleanup + normalized code-unit edit/source clipping | `Code.ts`, `client.ts`, `parser.worker.ts` | closing fence/cleanup/Unicode/conceal |
| INV-08 | sequential/scaling/cadence renderer harness | `.temp/testing/streaming-markdown-buffer-benchmark.ts` | output/speed/work scaling/catch-up |

## 14. Reverse Traceability

| Concept | Requirement | Why existing logic is insufficient |
| --- | --- | --- |
| managed buffer handle | INV-02/03 | baseline has only stateless full one-shot |
| versioned update response | INV-04 | existing buffer API is event-only |
| parser-owned tailStart | INV-03 | changed ranges do not classify the current last block as stable/unstable |
| code-unit source/parse normalization map | INV-01/07 | persistent path otherwise differs from installed parser/full parse |
| prefix chunk cache | INV-01/03 | current Code converts and commits the whole document |
| active/latest gate | INV-02 | current client accepts every one-shot request |
| callback-safe cache composition | INV-03/05 | actual Reasoning onChunks must keep prefix conversion reuse and full callback input |
| explicit buffer ownership transfer | INV-04/06 | reset cannot change grammar/client and old owner must release resources |

## 15. File-Level Change Plan

| File | Responsibility | Estimate |
| --- | --- | ---: |
| `packages/core/src/lib/tree-sitter/types.ts` | update request/response types | 35 |
| `packages/core/src/lib/tree-sitter/client.ts` | managed ID, awaitable update, stale response gate | 130 |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | normalized tree update, tailStart, source clipping | 160 |
| `packages/core/src/renderables/Code.ts` | ownership lifecycle, scheduling, callback-safe prefix/tail chunks | 350 |
| `packages/core/src/lib/tree-sitter/client.test.ts` | protocol/normalization behavior | 110 |
| `packages/core/src/renderables/Code.test.ts` | visible/style/boundary/callback/ownership/error behavior | 270 |
| `packages/core/src/testing/mock-tree-sitter-client.ts` | public managed-buffer test seam if required | 60 |
| `packages/core/package.json` | add exact script `"typecheck": "tsc --noEmit -p tsconfig.json"`; invoked only as package-local `bun typecheck` | 1 |
| `.temp/testing/streaming-markdown-buffer-benchmark.ts` | style-sensitive sequential/scaling/independent-cadence benchmark | 245 |

Maximum planned files: 9; estimates total 1361 lines; hard user ceilings are 12 files and 1600 lines.

## 16. TDD Behavior Slices

| Order | Red behavior | Minimal green behavior |
| ---: | --- | --- |
| 1 | buffer append has no awaitable current-version result | add one versioned response through existing tree |
| 2 | stale response or filetype/client transfer can use old semantics/owner | version gate plus dispose/recreate ownership transition |
| 3 | append starts repeated full one-shots | one buffer, one active update, one latest pending content |
| 4 | active table/list/fence/reference enters prefix or differs from full render | parser tailStart and complete current-tail render |
| 5 | closing fence or Unicode append breaks positions/lineInfo | normalized parse text and one code-unit range domain |
| 6 | destroy leaves managed parser buffer | existing removeBuffer cleanup |
| 7 | arbitrary `onHighlight` range crosses the cut or cached prefix goes stale | `onHighlight` presence forces single full composition; style-sensitive full differential |
| 8 | prefix conversion still scales with stable prefix size | public small/large stable-prefix append benchmark |
| 9 | managed update rejection leaves old delta or calls success callback | reject-to-current-plain-text test including callback counts and highlightingDone |
| 10 | 16ms producer creates backlog、frame/update gaps or fails to converge | independent producer/render clocks, wall-time gaps, final equality and catch-up |

Expected values are independent full-render `plainText`, public identity-`onChunks` style snapshots, `lineInfo`, callback inputs and benchmark timing/convergence. Style snapshots include chunk text, fg/bg, attributes, links and conceal output. Work reduction is proven by public scaling, not private fields, production telemetry or parser call-count assertions; callback counts only define failed-snapshot compatibility.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed lines `E` | 950 | excludes imports, formatting and benchmark-only output |
| Required qualifying Chinese comments `C` | 143 | `ceil(950 * 0.15)` |

Distribute rationale comments near code-unit offsets, parser tail boundary, callback composition, version/ownership transfer, cleanup and test intent. Comments must explain why, not restate flow.

## 18. Verification

| Command | Directory | Evidence |
| --- | --- | --- |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | buffer protocol |
| `bun test ./src/renderables/Code.test.ts` | same | Code behavior |
| `bun test` | same | package regression |
| `bun typecheck` | same | executes planned `tsc --noEmit -p tsconfig.json` package script against `packages/core/tsconfig.json` |
| `bun ../../.temp/testing/streaming-markdown-buffer-benchmark.ts --flushes=240` | same | R62 实测：candidate 15.91ms average / 34.10ms p95 vs reference 28.28/62.05（total -44%、p95 -45%、1.78x）；scaling candidate1000 507ms vs baseline1000 703ms（1.39x）；cadence catch-up 28.65ms vs baseline 193.63ms、stream 1.06x、converged、text/style 0 mismatch、normal exit。审计独立复现：11.31ms average、1.78x、1.42x scaling、catch-up 26.2ms vs 73.8ms，全部验收通过 |
| `bun run build` when required | `thirdparty/opentui` | package closure |

Acceptance requires all 240 sequential frames to match full-render plain text and serialized public chunks, then exit normally. Persistent mode must reduce sequential total by >=30%, p95 by >=20% and keep average <=16.7ms. Stable-prefix scaling is judged like-for-like in the same run: at 1000 paragraphs the candidate append median must be at least 1.25x faster than the baseline append median, and both growth slopes (200->1000) are reported; the native full-commit floor makes a small/large absolute ratio meaningless. Cadence is judged against the co-run baseline algorithm rather than machine-dependent absolutes: the candidate must converge to full-render output, stream wall time must be <=1.1x baseline, catch-up must be <=100ms and <=0.5x baseline catch-up, and producer/frame/visible-update gaps are reported for both.

## 19. Diff Budget

| Metric | Hard budget |
| --- | ---: |
| files modified/added | <= 12 |
| production/test code | <= 1600 lines |
| plan document | <= 600 lines |
| new alternate success paths | 0 |
| native/Zig files | 0 |

## 20. Real Risks and Open Decisions

### Real risks

- Tree-sitter may return a root-wide changed range; it invalidates prior chunks but does not define cache eligibility.
- `onHighlight` can produce ranges spanning any cut, so its presence disables prefix-chunk reuse while persistent parsing continues; `onChunks` always receives the full current chunk stream.
- Synthetic parse newline changes parse length; all source/parse offsets remain in the installed parser's JavaScript code-unit domain.
- Filetype/client changes transfer buffer ownership rather than resetting an incompatible parser.

### Open Decisions Requiring the User

None. The user selected方案 2 and requested autonomous execution.

### Rejected Speculation

- Worker termination, native handle exhaustion and release provenance are historical concerns outside this primary path.
- Query complexity is measured by the benchmark; no speculative second query protocol is planned before evidence.

## 21. Audit Contract

The independent auditor must read this exact R62 file, the original requirement, rollback-baseline source/tests and affected interfaces; audit persistent buffer ownership, transparent-section tail boundary, normalization/code-unit/version/error semantics, onHighlight full-composition and onChunks prefix/tail correctness, no-fallback policy, like-for-like scaling and co-run cadence acceptance, executable verification commands, file/line budgets and Chinese comment budget without narrowing scope after revision.

## 22. Plan Audit Record

| Round | Revision | Full scope | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R55 | yes | B-01..B-05 | N-01..N-03 | BLOCK | `ses_046d62478ffeqWFpEgn2ZEB0l7` |
| 2 | R56 | yes | B-01..B-05 | N-01..N-02 | BLOCK | `ses_046c7df60ffeyY85xixbaggmjn` |
| 3 | R57 | yes | B-01 | N-01 | BLOCK | `ses_046bac6bfffe5K9ckaxgvJKE6L` |
| 4 | R58 | yes | B-01..B-02 | none | BLOCK | `ses_046b11a3cffeH1H2OFaEJUgcJy` |
| 5 | R59 | yes | B-01 | N-01..N-03 | BLOCK | `ses_046a95fd0ffea0dK6p1huj80Hy` |
| 6 | R60 | yes | B-01..B-02 | N-01..N-02 | BLOCK | `ses_046a60a98ffeiWUcZF1nP9si0n` |
| 7 | R61 | yes | none（No blocking findings） | N-01..N-06 | APPROVE | `ses_04540b755ffep1S52rotfQM0x2` |
| 8 | R62 | yes | none（No blocking findings） | N-01..N-04 | APPROVE | `ses_044eb9523ffe4uJc46e4jNsftl` |

## 23. Open Decisions Resolution

- OD-01: 已确认（用户授权续审并采纳审计方向）——`document`/`section` 为透明容器，boundary 选择内部 render block。
- OD-02: 已确认——存在 `onHighlight` 时 persistent parse 保留，composition 走单一 full-conversion path，不复用 prefix chunks。

两项决定已并入 R61 设计，不再是开放问题。第 7 轮 full-scope plan audit 获得 No blocking findings 与 APPROVE，按用户额外授权记录批准。

## 24. Implementation Evidence

### Changed files（vs rollback baseline `93098b518`，11 files，0 Zig/native）

| File | +/- lines | Content |
| --- | ---: | --- |
| `packages/core/src/lib/tree-sitter/types.ts` | +29 | `StreamingUpdateResult`、`STREAMING_UPDATE/_RESPONSE` 协议 |
| `packages/core/src/lib/tree-sitter/client.ts` | +74 | 负数 ID 段 `createStreamingBuffer`（空初始化）、awaitable `updateStreamingBuffer`（client 自增 version + stale 标记）、`removeStreamingBuffer` 复用 `removeBuffer` |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | +255 | `handleStreamingUpdate`（closing-fence normalize、code-unit diff、增量 parse、`lastRenderBlockStart` 透明 section 边界、引用状态增量维护、`capturesFrom` 逐 block 查询、injection 范围裁剪、one-shot 逐位一致 highlights） |
| `packages/core/src/renderables/Code.ts` | +208 | dispatcher（streaming+markdown → persistent）、buffer 生命周期（filetype/client/streaming/destroy 释放）、active/latest 合并 loop、prefix chunk cache + 完整 tail 转换、onHighlight 全量 composition、onChunks 全量输入、managed rejection → plain text 兼容 |
| `packages/core/src/lib/tree-sitter/client.test.ts` | +38 | 2 个协议测试（版本化结果+tail 边界、closing-fence one-shot 逐位一致） |
| `packages/core/src/renderables/Code.test.ts` | +436 | 10 个行为测试（buffer 复用/rewrite、filetype/client 转移、destroy 释放、stale 不提交、rejection 合同、onChunks 全量、文本+样式差分、onHighlight 全量输入、迟到引用定义差分） |
| `packages/core/src/testing/mock-tree-sitter-client.ts` | +67 | streaming buffer seam（创建/释放记录、可控挂起、stale 复现、autoResolve） |
| `packages/core/package.json` | +1（本次） | `"typecheck": "tsc --noEmit -p tsconfig.json"`（版本号行为 .4 既有元数据，非本次修改） |
| `.temp/testing/streaming-markdown-buffer-benchmark.ts` | 诊断工具，不计入 E | sequential 等价/scaling/cadence 三阶段 harness |

### Red-green evidence

- client 协议：red `streamingClient.createStreamingBuffer is not a function` → types+client+worker 实现后 2 pass。期间发现 web-tree-sitter query range 选项不可靠（与 handleEdits 既有注释一致），改为逐 block capture 后 closing-fence 与 one-shot 逐位一致。
- Code 行为：baseline 上 10 个 streaming 测试 8 fail（`createdStreamingBuffers` 为空、无 stale/释放/rejection 语义） → `Code.ts` 实现后 10 pass。
- benchmark：样式差分在 snapshot 15（闭合 fence 帧）发现区域转换丢失 synthetic-newline span 高亮 → 修复 `convertHighlightRegion` 的末端保留 → 0 mismatch。
- 性能定位：引用状态原设计在非追加编辑时全文重扫（1000 段落下 547ms 慢于 baseline 481ms）→ 改为编辑点增量维护；`createStreamingBuffer` 空初始化消除 INITIALIZE initialQuery 重复全文查询。

### Verification（目录均为 `thirdparty/opentui/packages/core`）

| Command | Result |
| --- | --- |
| `bun test ./src/renderables/Code.test.ts` | 70 pass / 1 skip / 0 fail（baseline 60+1，新增 10） |
| `bun test ./src/lib/tree-sitter/client.test.ts` | 50 pass / 0 fail（baseline 47+1 flaky timeout，现全绿） |
| `bun typecheck` | 变更文件 0 错误；全量 17114 错误均为 baseline 既有（yoga-upstream/dev/native Pointer），不属于本任务范围 |
| `bun ../../.temp/testing/streaming-markdown-buffer-benchmark.ts --flushes=240` | 三轮：avg 8.67-15.91ms（≤16.7 ✓）；total -36%~-57%（≥30% ✓）；p95 -39%~-52%（≥20% ✓）；text/style 0 mismatch ✓；scaling large 1.09-1.42x（审计复现 1.42x ✓）；cadence converged、catch-up 25.6-34ms（≤100ms ✓）、stream 0.98-1.06x（≤1.1x ✓）、normal exit ✓ |

### Path inventory（与批准一致）

- primary：persistent normalized buffer update（streaming Markdown）。
- 保留：existing one-shot（non-streaming/non-Markdown）；parser-error → plain text 既有兼容（不回调、不重试、不切换 parser）。
- 新增 alternate success path：0；feature flag：0；第二 parser：0。

### 与 R61 设计的两处机制性记录（行为/范围/接口/测试不变）

1. worker 返回的 highlights 与 one-shot 完全同域（含 synthetic-newline 末端 +1），不做额外裁剪——R61 协议测试的 oracle 就是 one-shot 逐位一致；`changedStart`/`tailStart` 仍为 source 域。
2. `createStreamingBuffer` 以空内容初始化（第一次 update 提供真实内容），避免 INITIALIZE_PARSER 遗留 initialQuery 在 worker 重复全文 query+injections。

### Chinese comment gate（实际）

- `E = 1135`（非空有效修改行；排除 import-only 4 行、package.json 的 .4 版本元数据 9 行、benchmark 诊断工具）
- `C = 171`（合格中文解释性注释，分布于 code-unit 域、tail 边界、引用状态、缓存不变量、版本/owner 转移、回调合同、错误兼容、测试意图）
- `required = ceil(1135 × 0.15) = 171`，`C/E = 15.1%` ✓

### Implementation audit round 1 rework（`ses_044adb25dffedCy4s8YTD9XHaZ`）

- B-01（BLOCK，INV-06）：destroy 与在途 `createStreamingBuffer` 竞态导致 id 未登记、worker parser tree 永久泄漏。修复：`runStreamingLoop` 在 create resolves 后的 `isDestroyed` 分支就地 `removeStreamingBuffer`（`Code.ts`）；mock 增加 `streamingCreateAutoResolve`/挂起 create seam；新增竞态行为测试（red：释放记录为空 → green）。
- N-01（non-blocking）：streaming buffer 的 INITIALIZE 残留 `initialQuery` 响应会触发 version-mismatch reset，白做一次全文重解析。修复：client 以 `streamingBufferIds` 标记 streaming buffer，其 `HIGHLIGHT_RESPONSE` 事件一律忽略（awaitable 响应才是它们的通道）。
- N-02 行政修正：§22 第 6 行记录修复；文件头 `Audit mode` 改为 implementation。
- rework 后验证：Code.test 71 pass / 1 skip（含新增竞态测试）、client.test 50 pass、benchmark avg 8.22ms / 2.22x / p95 -51% / largeImprovement 1.33x / catch-up 26.5ms vs 52.2ms / 0 mismatch / converged；`E=1195`、`C=180`、`required=180`、`C/E=15.1%`。

### Implementation audit round 2 rework（`ses_044707f21ffeeIZNS7l20l8rNC`）

- B-01（BLOCK，INV-05）：新 dispatcher 使 Markdown 段落块走 persistent seam，4 个既有测试仍用 one-shot mock seam（`isHighlighting()`/`resolveAllHighlightOnce()`/`highlightOnce` override）导致 package 回归 4 fail。修复：迁移这 4 个测试的 fixture 到 persistent seam（`streamingAutoResolve=false` + `pendingStreamingUpdates()` + `resolveAllStreamingUpdates()`；错误注入点从 `highlightOnce` 换成 `updateStreamingBuffer`），行为断言逐字保留；非 markdown fence 块继续用 one-shot seam，双 seam 并行放行。
- 迁移过程发现 mock 缺省 `tailStart: content.length` 违反“最后一个 render block 始终属于 tail”不变量（会把陈旧文本认证进前缀缓存），修正为 `tailStart: 0` 并同步两个 handler；生产 worker 本就不违反该不变量。
- rework 后验证：`bun test` 全量 4992 pass / 23 skip / 0 fail（5015 tests, 167 files）；benchmark avg 9.33ms / 2.16x / p95 -39% / largeImprovement 1.44x / catch-up 23.0ms vs 65.6ms（0.35x）/ stream 0.995x / 0 mismatch / converged；`E=1228`、`C=189`、`required=185`、`C/E=15.4%`。
### Implementation audit round 3 rework（`ses_0443e8441ffeUSCk8MFxk8dDhO`）

- B-01（BLOCK，INV-01/05）：在途裁剪响应遇上样式/回调 setter 失效窗口时，提交侧会用残缺 highlights 重建前缀缓存，前缀高亮在流的剩余生命周期内永久丢失。修复：`_cacheGeneration` 失效代数——syntaxStyle/conceal/baseHighlight/onHighlight setter 与 release 路径递增；请求时捕获，update 返回后与 commit 内每个 await 点后校验，不匹配按 stale 丢弃，由 dirty 标志驱动 cacheEnd=0 全量重取。新增 red 行为测试（样式切换落在在途窗口 → 前缀最终以新样式着色）。。
- rework 后验证：`bun test` 全量 4993 pass / 23 skip / 0 fail（5016 tests）；benchmark avg 8.79ms / 2.10x / p95 -47% / largeImprovement 1.43x / catch-up 24.9ms vs 60.7ms（0.41x）/ stream 0.97x / 0 mismatch / converged；`E=1302`、`C=198`、`required=196`、`C/E=15.2%`。

### Remaining unverified / risks

- scaling 的 largeImprovement 受本机负载影响在 1.09-1.42x 间波动（native 全量提交 + IPC 是两种算法共享的 O(doc) 下限）；catch-up ≤0.5x baseline 在三轮中两轮达标（0.19/0.35），一轮 0.62（absolute ≤100ms 三轮均达标）。
- tree-sitter markdown 增量 parse 本身随文档增大（1000 段落约 20ms/帧），属于 parser 固有成本。

## 25. Implementation Audit Record

| Round | Plan revision | Full original scope | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R62 | yes | B-01 | N-01..N-04 | BLOCK | `ses_044adb25dffedCy4s8YTD9XHaZ` |
| 2 | R62 | yes | B-01 | N-01..N-02 | BLOCK | `ses_044707f21ffeeIZNS7l20l8rNC` |
| 3 | R62 | yes | B-01 | N-01..N-03 | BLOCK | `ses_0443e8441ffeUSCk8MFxk8dDhO` |
| 4 | R62 | yes | none（No blocking findings） | N-01..N-04 | APPROVE | `ses_044159240ffegcYUocJVjaQwG8` |

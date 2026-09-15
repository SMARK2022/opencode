# Canonical Implementation Plan: OpenTUI 流式 Markdown 稳定前缀缓存与尾部重渲染

> Status: draft
>
> Revision: R53
>
> Approved revision: none
>
> Audit mode: plan (full-scope)
>
> Requirement source: 本 Session 用户关于继续检查 `e0e6efe61df90838909aaa466086532b29ee12a5`、稳定前缀缓存、未闭合尾部完整重渲染、TDD、完整实现和复审的原始要求
>
> Implementation allowed: no
>
> Last updated: 2026-07-31

本文是本任务唯一 implementation authority。`opentui-streaming-markdown-performance-repair-r1-r39-history.md`、旧聊天、builder 自述、`.temp` 原型、`.3/.4` release 和当前 dirty worktree 均不是实施授权。

R53 记录用户要求的 code-only rollback：`thirdparty/opentui/packages/core/src` 已恢复到 `8ec059d06210b4652315b3d098fa20b64c6c163d` 的父提交 `93098b5189645cb3fa135360625190c10605f6bb`；历史报告、release metadata 和父仓库其他工作保持不变。R52 的批准不再授权实施，后续必须基于该基线重新收敛最小稳定前缀方案。

## 1. Verbatim Requirement

> e0e6efe61df90838909aaa466086532b29ee12a5  当前我们对项目已经进行了提交,这个是我们之前在另一台设备上实现完成一半,但是因为设备要迁移,所以就直接进行了提交。你可以接着相应的项目进行完整检查,看看整体的实现是否有任何bug或者说任何问题。当时的目标和思想是进行相应的渲染优化,同时使得其渲染的过程中保持稳定,也就是理论上来说markdown的前缀解析是有部分内容是稳定的。而部分内容不稳定,比如表格等等内容,需要在更新的时候进行重新渲染。所以请你检查检查。也就是它的更新逻辑应该是那些前面都不会动的地方,也就是已经闭合的所有内容,让其进行缓存渲染。而那些没有进行任何闭合的部分,则进行不进入缓存,并且进行相应的全量的更新的渲染。比如说,在一个表格之前的内容,那它理论上来说是都闭合的。而进入表格之后,每输出一个delta,它整个表格都要重新进行更新,也就是整个除了前缀以外的所有内容就要进行一个重新的markdown的更新,因为不然的话它的渲染是有问题的。  你可以检查其相应的文档实现的状态,因为它理论来说是有一些需要进行审计或者需要进行相应的实施等的操作,所以你需要进行相应的检查以及进行相应的实现。同时它还混入了不同的目标,你要做的目标是检查相应的 OpenAI streaming markdown performance repair 的相关内容,它当前好像是在一个 plan 的状态,你可以进行相应的检查,检查这个方案是否有任何问题,然后你进行相应的 TDD 实施以及相应的完整实现以及复审即可。

本轮用户确认 TDD seam 和完整等价覆盖：

> 是的，同时相应的renderable应该的渲染验证是：全量markdown = 前缀渲染缓存+后缀全量渲染的完整等价性，且前缀范围应该从0%到100%；同时其整体的test文案应该包含markdown的各种格式的一个完整文档

本轮最新规模和代码质量约束：

> 同时最终代码的实现要保证足够的凝练以及不冗余,也就是整体的代码修改量不能超过六个文件,且整体理论上来说,生产代码不应该超过600行的修改。也就是请你保持尽量克制,不需要将所有的输入都进行相应的归一化以及整理等操作,同时也不要过于添加冗余的helper或者把主逻辑弄得极为复杂,请注意保持克制。

本轮用户对发布顺序的约束：

> 你已经审计通过了是吗?理论上来说,应该进行完整审计,直到我们的OpenTUI不存在任何错误,才进行相应的commit提交。因为我们之前已经提交过一个.3.4了,所以理论上来说你如果再提交,这是不合理的。你应该检查确定你的修复,确定没问题,然后我们再bump一个版本进行提交,否则不能进行提交和push。

R44 达到首个 continuation 的六轮审计上限后，用户明确授权继续：

> 下面继续

R50 达到 continuation 上限后，用户明确授权新的 R51 continuation；R51 审计发现 offset 域和观测 API 问题，现进入该 continuation 的 R52 修订：

> 授权 R51（推荐）

因此 R52 仍只授权 OpenTUI source、共享测试替身、测试和独立实现审计；不授权版本 bump、commit、push、tag、release 或 parent runtime closure。

## 2. Explicit Non-Goals

- R52 获得 full-scope `No blocking findings` / `APPROVE` 前不再修改 production 或 tests；当前六文件 red-green diff 保持原状等待审计，不作为继续实施授权。
- 不把 Markdown delta、stable suffix、table row 或 fence fragment 当作独立完整 Markdown 文档解析。
- 不保留 `.4` 的 open-fence 32-line/4096-character deferred gate；每个合并后的当前 version 都处理完整不稳定 tail。
- 不新增第二 Markdown parser、parser-after-parser fallback、raw-text error success、source import fallback、feature switch 或新的 helper/module 文件。
- 不向 `ChunkRenderContext` 或其他 callback API 添加仅用于测试 telemetry 的 production field；性能验证只使用现有 public result ranges、payload 和 `SyntaxStyle.getStyle` 方法。
- 不切换到 `MarkdownRenderable`，不修改 OpenCode producer/consumer，不新增 callback marker、route、行为或 math/LaTeX grammar。
- 不为仅测试替身可达的 append-only 永久 hung 请求新增 watchdog/progress protocol。
- 不修改 native/Zig；`.4` 已有 bounded line walk 作为 baseline 保留。
- 不执行 `.5` 相关动作。`.3/.4` 保持 immutable；完成 source 审计后另行由用户决定是否启动独立 release closure。
- 不对所有输入做额外 normalization；唯一必要的规范化是复用现有 Markdown 文末 synthetic newline 语义，保证 buffer 与 full-parse oracle 相同。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `AGENTS.md` | 最小修改、保留并发 dirty worktree、package-local tests/typecheck。 |
| `thirdparty/opentui/AGENTS.md` | Bun；必须先有可复现测试；TypeScript-only change 不需要 native build。 |
| `CONTEXT.md` | 真实 producer 是 Message Part delta；使用既有 Session/Message/Part 术语。 |
| `.opencode/policy/first-principles-engineering.md` | 修复 first divergence；一个 authoritative path；禁止 fallback；实施和完成均需独立审计。 |
| `docs/workflow.md` | exact approved revision 前不得实施；red-green 和 implementation audit 是硬门禁。 |
| `docs/adr/README.md` | 没有约束本任务的 accepted ADR；不新增 ADR。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:52-82,425-667,782-917` | `.4` snapshot/scheduling、standalone suffix parser、boundary/cache owner | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:716-954` | reusable buffer 已有完整 tree、version 和 edit queue，但没有 Code-facing completion handle | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts:347-405,547-805,819-878` | incremental tree、changed ranges、query/injection、SimpleHighlight conversion | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts:1-108` | current line response 与 one-shot `SimpleHighlight` contract | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter-styled-text.ts:39-314` | complete content/highlights 到 `TextChunk[]` 的 conversion owner | observed |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts:1710-1992` | current cache/fence/append/differential tests和缺失边界 | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts:182-369` | current public buffer lifecycle tests | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2054-2149` | actual `drawUnstyledText=false` TextPart/ReasoningBody consumers | reachable |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:393-445` | enabled Session v2 streaming Markdown consumer uses the same Code contract | reachable |
| nested HEAD/tag `df4bd31c` / `v0.4.3-smark.4` | current immutable baseline | observed |

## 5. Current Behavior

```text
Message Part delta
  -> CodeRenderable.content/latest-dirty scheduling
  -> highlightMarkdown
  -> cached prefix highlights + highlightOnce(content.slice(cachedCut))
  -> treeSitterToTextChunks(full content, merged highlights)
  -> StyledText/full TextBuffer update
  -> visible frame
```

`.4` 只避免重新解析 `cachedCut` 前的字节，却把 tail 当作独立 Markdown 文档，并再次转换完整 content。其 blank-line boundary 会把 list/blockquote 前部标为 stable，而后续缩进/引用 delta 可以向前扩展同一容器。

Reusable buffer path 已经维护一个完整 parser tree。它当前只通过 line-oriented event 交付结果，`createBuffer()` 只返回 parser availability，初始 version 没有 Code-facing `SimpleHighlight[]` completion。

## 6. Supported Input Domain and Reachability

| Input/condition | Producer/path | Owner | Class |
| --- | --- | --- | --- |
| strict append-only streaming Markdown | Message Part delta -> CodeRenderable | Code/buffer handle | observed/reachable |
| table header/delimiter/partial row/repeated rows | same | unstable tail query/render | contracted/reachable |
| backtick/tilde fence and injected code | same | full tree + unstable tail | contracted/reachable |
| list/blockquote/indented continuation after blank line | same | changed-range rollback | observed/reachable |
| heading/setext/emphasis/strike/link/image/reference/autolink/HTML/frontmatter | same | full-tree query | reachable |
| CJK/tab/emoji/CRLF and formula-like literals | same | existing offset/pass-through | reachable |
| content rewrite or semantic setter change | public Code setters | invalidation/reset | reachable |
| generic transforming `onHighlight`/`onChunks` | public Code options | callback-first compatibility | reachable |
| append-only request that never settles without semantic change | test double only | no new owner | speculative/non-goal |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Test |
| --- | --- | --- | --- |
| `INV-01` | `render(full markdown) == cached stable-prefix render + complete unstable-tail render` for streaming paths without `onHighlight`, including actual TextPart and Reasoning `onChunks`; a transforming `onHighlight` remains callback-first and uses current full composition. | user verbatim + actual consumers/public callback contract | 0%-100% sweep + callback branch |
| `INV-02` | Prefix is reused only at a complete parser-owned render-block boundary. Render blocks are the ordered non-`document`/non-`section` descendants obtained by flattening only those two grammar-transparent wrappers; later append must not change any block before the cut. | user requirement + actual grammar tree/red | wrapper-flattened block cut/rollback cases |
| `INV-03` | Table/fence/list/blockquote/indented-code tail is queried from its complete current start on every version, against one full parser tree. | user verbatim | per-delta full-parse differential |
| `INV-04` | Initial and every requested version, including zero highlights, have one exact completion; stale/aborted/disposed versions cannot commit. | R39 audit B-01 | handle lifecycle tests |
| `INV-05` | `drawUnstyledText=false` retains the last processed frame while the current version is pending, then commits that version's complete Markdown result; stale snapshots never overwrite it and callbacks remain callback-first. | existing public contract | delayed append/callback tests |
| `INV-06` | Rewrite and semantic setter changes clear reuse and obtain a current full result through the same buffer path. | public Code contract | setter mutation differential |
| `INV-07` | One complete Markdown fixture covers ordinary Markdown/GFM/code/formula-like/CJK/tab input and matches full parse throughout streaming. | user test requirement | named comprehensive fixture |
| `INV-08` | Actual diff modifies no more than six code files and production changes no more than 600 effective lines. | latest user constraint | implementation audit calculation |
| `INV-09` | No bump/commit/push/tag/release occurs in R52. | latest user instruction | git/remote evidence |
| `INV-10` | Buffer and one-shot Markdown use the same synthetic trailing-newline parse contract while returned ranges remain clipped to visible source length; replacing a clipped synthetic EOF newline must invalidate the block touching that edit start even when Tree-sitter changed ranges begin later. | observed existing workaround + R49 101-prefix red | fence-at-EOF and synthetic-to-real-newline prefixes |
| `INV-11` | Abort before handle delivery and `CodeRenderable.destroy()` cannot orphan worker buffer/parser state; rejection/disposal completes through the owning client lifecycle. | reachable lifecycle | delayed initial abort + Renderable destroy tests |
| `INV-12` | Verification distinguishes tail-only capture/chunk work from a full-document implementation, not only output equality. The Markdown result's `from`/tail payload and a public `SyntaxStyle.getStyle` work delta must identify the actual optimized interval. | performance requirement + R50 audit B-01 | payload/work scaling |
| `INV-13` | Worker/handle raw highlights and authoritative cached chunks are never exposed to callbacks. Every `onChunks` receives isolated array/chunk/link/RGBA values, and every callback-visible highlight tuple/meta is current-version-local. | reachable production consumer + public mutable callbacks | chunk/highlight mutation-isolation tests |
| `INV-14` | Streaming Markdown parser/query failure produces `highlightUnavailable`/`highlight-error` diagnostic state and never commits source text as Markdown success. | reachable worker errors | Markdown error/retry test |
| `INV-15` | `onHighlight` runs on the complete current-local result every version and never receives rendered-prefix reuse; its current full composition is the sole callback-first result. | public transforming callback | tail-dependent prefix-transform full-rebuild test |
| `INV-16` | Existing `createBuffer/updateBuffer/resetBuffer -> highlights:response` keeps its line-oriented public contract; the new Markdown handle is a second output adapter over the same worker parser-state/query authority, never a fallback or second parser. | observed public client API/tests | legacy client regression + handle differential |
| `INV-17` | `MockTreeSitterClient` implements the handle seam through its existing controllable pending queue so all current MarkdownRenderable tests remain deterministic without production test detection. | observed test producer | full JS regression |
| `INV-18` | Direct root children are never assumed to be render blocks: the shipped grammar wraps ordinary paragraph+table content in one `section`, while shipped highlight/injection queries capture neither `document` nor `section`. | observed R48 implementation feedback | paragraph+table exact-cut test + AST fixture |
| `INV-19` | For normalized Markdown updates, the earliest invalidation position is the minimum of Tree-sitter changed-range starts and edit starts. The edit start is mandatory because a previously clipped synthetic EOF extent can gain a real newline without appearing in the earliest AST changed range. | observed R49 101-prefix feedback | heading EOF -> real newline exact-prefix test |
| `INV-20` | The public Markdown handle and Markdown one-shot result use the web-tree-sitter JavaScript string-index domain: `startIndex`/`endIndex`/`from` and edit positions are UTF-16 code-unit offsets consumed directly by `String.slice`; no byte-length value is mixed into this contract. | observed web-tree-sitter parse callback + R51 audit B-01 | CJK/emoji initial, append and full-parse differential |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| `INV-01`-`INV-03` | `.4` calls `highlightMarkdownFragment(content.slice(cachedCut))`; suffix parser lacks preceding container context. | Code Markdown path | actual parser differential below |
| `INV-01` performance | R39 proposed full-document capture and full chunk conversion after every edit, so stable output was recorded but not reused. | worker query + Code cache | R39 audit B-02 |
| `INV-04` | `createBuffer()` returns boolean while initial highlights arrive only as an event. | TreeSitterClient completion seam | R39 audit B-01 |
| `INV-05` | `.4` open-fence threshold keeps prior frame under `drawUnstyledText=false`. | Code presentation seam | source/tests and historical implementation audit |
| `INV-10` | Buffer mode parses raw content while the current streaming/full oracle adds a synthetic newline at Markdown EOF. | worker buffer parse contract | R40 audit B-03 |
| `INV-11` | `openMarkdownBuffer` would return only after initial query, leaving no caller-owned handle if signal aborts first. | client lifecycle seam | R40 audit B-04 |
| `INV-12` | Equality-only tests pass even if captures/chunks still process the complete prefix. | worker/Code performance seam | R40 audit B-05 |
| `INV-11` | Inherited `TextBufferRenderable.destroy()` knows only native text resources and cannot release a Code-owned Markdown handle. | Code destroy seam | R41 audit B-01 |
| `INV-13` | R42 excluded generic `onChunks` from rendered-prefix reuse although the real Reasoning consumer always provides an identity-returning callback. | Code callback composition | R42 audit B-01 |
| `INV-14` | Existing generic catch commits `snapshot.content` as plain text and clears dirty after parser error. | Code Markdown error outcome | R43 audit B-01 |
| `INV-13` | R43 passed authoritative mutable prefix chunk objects directly to every public callback. | Code callback boundary | R43 audit B-02 |
| `INV-13` | R44 isolated chunk values but still exposed authoritative raw tuples/meta through `onHighlight` and `ChunkRenderContext.highlights`. | Code callback/highlight cache boundary | R44 audit B-01 |
| `INV-15` | R46 attempted callback-normalized prefix equality, but a callback can return a range crossing any candidate cut. | Code callback/composition seam | R46 audit B-01 |
| `INV-17` | R47 omitted `MockTreeSitterClient`, while existing MarkdownRenderable tests can only drive its one-shot pending controls. | shared test seam | R47 audit B-01 |
| `INV-15` | R47 still retained stale prefix-equality wording in owner/path inventory despite selecting full `onHighlight` composition. | canonical callback contract | R47 audit B-02 |
| `INV-16` | R47 did not classify the existing line-event versioned buffer path alongside the new handle. | TreeSitterClient buffer interface | R47 audit B-03 |
| `INV-02`,`INV-18` | R48 selected a direct root child, but the actual grammar tree for paragraph+table is `document -> section[0,80] -> paragraph[0,18], pipe_table[19,80]`; the implementation returned `from=0` instead of the table start `19`. | parser render-cut seam | R49 red feedback loop |
| `INV-10`,`INV-19` | At 9% of the comprehensive fixture, the prior EOF heading cache held clipped `[34,47]`; after that synthetic newline became real, one-shot returned `[34,48]`, but Tree-sitter changed ranges began in the following paragraph and R49 reused the stale heading. | normalized edit/render-cut seam | R50 red feedback loop |

### Red-Capable Feedback Loop Executed

Working directory: `thirdparty/opentui/packages/core`.

The actual `TreeSitterClient` differential compares full Markdown with the same tail parsed independently across list continuation, indented code, HTML, blockquote, table and reference cases. It exits `1` deterministically:

- `list-continuation`: full parse includes tail `punctuation.special` `[8,10]`; isolated tail omits it.
- `indented-code`: full parse has no standalone raw block; isolated tail incorrectly emits `markup.raw.block` `[11,22]`.
- `blockquote`: isolated tail adds a standalone `markup.quote` container absent from the full-parse tail.

Minimized input: `"- item\n\n" + "  continuation *em*\n"`.

Existing tests both pass and therefore miss the bug:

```text
bun test ./src/renderables/Code.test.ts -t "streaming Markdown matches a full parse" -> 1 pass
bun test ./src/renderables/Code.test.ts -t "settles a closed Markdown prefix" -> 1 pass
```

R48 implementation then established a second deterministic red-capable loop at the approved public handle seam:

```text
bun test ./src/renderables/Code.test.ts -t "Markdown buffer refreshes a growing table"
Expected from: 19
Received from: 0
```

The accompanying direct grammar probe for `"Stable paragraph.\n\n" + growingTable` returned:

```text
document [0,80]
  section [0,80]
    paragraph [0,18]
    pipe_table [19,80]
```

The changed range starts inside the appended table row (`67` in that fixture). Therefore selecting a direct root child chooses the transparent `section` at `0`; flattening only `document`/`section` yields the required complete `pipe_table` block at `19`. Separate probes confirmed the same rule yields whole `list`, `block_quote`, `fenced_code_block`, `pipe_table`, `setext_heading` and metadata blocks, while query-file search found no `document`/`section` capture in shipped Markdown highlight or injection queries.

R49 then reached the comprehensive public `CodeRenderable` seam and failed deterministically at prefix 9:

```text
bun test ./src/renderables/Code.test.ts -t "streaming Markdown equals full rendering at 0 through 100 percent"
prefix: "---\ntitle: Complete Markdown\n---\n\n# ATX heading\n\nSete"
cached heading: [34,47,"markup.heading.1"]
full oracle:    [34,48,"markup.heading.1"]
```

The prior prefix ended at the heading text, so its parser-only synthetic newline was clipped from `[34,48]` to visible `[34,47]`. The next append replaced that synthetic newline with a real newline and began the next paragraph. The AST changed range began in that paragraph, but the normalized edit itself began at the old real source end touching the heading. R50 therefore includes every Markdown edit start when selecting the earliest invalidation position; snapping that earlier position to the flattened heading block refreshes the now-visible newline without widening later steady-state table/fence tails.

R51 also audited the offset domain with the installed `web-tree-sitter@0.25.10` binding. Its `Parser.parse(string)` implementation installs `currentParseCallback = (index) => callback.slice(index)` (`node_modules/.../web-tree-sitter/tree-sitter.js:3851`), and a direct Markdown probe returned `Node.endIndex === content.length` for `中文段落 👩🏽‍💻 *em*\n` (`18` code units versus `34` encoded bytes). R52 therefore fixes the public contract to this observed UTF-16 JavaScript index domain and removes the partial diff's unverified UTF-8 edit conversion; the CJK/emoji red test is the regression guard if the binding contract changes.

## 9. Responsibility and Seam

| Concern | Owner | Promise | Why here |
| --- | --- | --- | --- |
| complete-context incremental parse | parser worker buffer state | one tree per stream | worker owns tree and changed ranges |
| exact version completion | TreeSitterClient Markdown handle | initial/update/reset result or reject | client owns request lifecycle |
| stable prefix/render composition | CodeRenderable | full output equals prefix cache + current tail | Code owns presentation/callbacks |
| render-safe cut/rollback | worker changed ranges + normalized edit starts + wrapper-flattened Markdown blocks | returned cut refreshes synthetic-to-real EOF extents and never splits a complete non-wrapper block; crossing change returns `from=0` | parser owns grammar wrappers/edit extents; Code owns composition |
| callback/cache isolation | CodeRenderable | raw cache is private; `onHighlight` and chunk context receive current-local tuple/meta values; every `onChunks` receives isolated values while internal prefix chunks remain reusable | Code owns cache/callback boundary; no consumer marker is needed |
| optimization observation | TreeSitterClient result + existing `SyntaxStyle.getStyle` public method | `from`/tail payload proves parser transport scope; test-side delta of the existing style lookup method proves conversion work without a production telemetry field | measurement stays at existing public seams |
| synthetic EOF newline | client handle + worker parser state | buffer/full parse use identical parse text while exposing real-source offsets | parser owner must preserve current Markdown workaround |
| abort-before-delivery cleanup | TreeSitterClient | open either returns an owned handle or removes the created buffer before rejection | caller cannot dispose a handle it never received |
| Renderable teardown | CodeRenderable -> handle/client | invalidate snapshot, abort pending open, dispose delivered handle before base destruction | Code owns acquisition; shared client cannot infer per-Renderable unmount |
| Markdown parser error | CodeRenderable diagnostic seam | expose unavailable/error without success-shaped source output | streaming Markdown owner must not enter generic plain-text compatibility |

Confirmed TDD seams are public `CodeRenderable` behavior and public `TreeSitterClient.openMarkdownBuffer()` results. Tests do not inspect private fields, source text or worker call counts.

## 10. Single Approved Primary-Path Design

```text
Message Part delta
  -> Code current immutable snapshot/latest-dirty gate
  -> one MarkdownBufferHandle
  -> one synthetic-newline-normalized complete parser tree
  -> flatten only transparent document/section wrappers into ordered complete blocks
  -> minimum changed-range/edit start -> containing/following complete render-block start
  -> render-safe block cut versus current reusable prefix cut
     -> crosses cut: from=0
     -> stays after cut: query complete current tail from render-safe cut
  -> exact versioned { version, from, highlights }
  -> if onHighlight: complete current-local callback-first composition from 0
  -> otherwise: retain cached chunks before from, fully convert current tail
  -> onChunks receives isolated copies of the internally composed chunks
  -> compose current StyledText
  -> current callback checks and visible frame
```

### 10.1 Minimal buffer handle

`TreeSitterClient.openMarkdownBuffer(filetype, initialContent, version, signal?)` returns one handle only after the initial version's `SimpleHighlight[]` is available. The handle exposes `initial`, `update(content, version, reusablePrefixEnd, signal?)`, `reset(content, version, signal?)`, and `dispose()`.

- Initialize/edit/reset messages and responses carry buffer ID and version; handle pending state is keyed by version.
- `[]` is a successful processed result.
- Handle update accepts strict append and owns one edit over normalized parse text; rewrite uses reset.
- For Markdown only, the handle parses `content + "\n"` whenever non-empty content lacks a trailing newline, while requests retain real source length and responses clip synthetic ranges. Every length, edit index, row column, `from` and `SimpleHighlight` boundary in this Markdown string path uses the installed binding's JavaScript UTF-16 code-unit domain (`String.length`/`String.slice`), never `TextEncoder.byteLength`. Replacing the previous synthetic newline and appending the new suffix remains one incremental edit, not a second parse.
- `openMarkdownBuffer` owns the buffer until successful handle delivery. If its signal aborts, it waits for the in-flight initialization outcome, removes any created worker buffer/parser state, clears pending callbacks, and only then rejects `AbortError`; no cleanup responsibility is assigned to Code before a handle exists.
- After delivery, abort prevents stale commit; dispose rejects pending versions and removes the buffer.
- `CodeRenderable.destroy()` first invalidates the current snapshot, aborts an in-flight undelivered open, starts disposal of an already delivered handle, and only then delegates to `TextBufferRenderable.destroy()`. The synchronous Renderable API cannot await worker disposal, so the client-owned `dispose()` Promise and existing `buffer:disposed` event remain the completion evidence. Disposal is idempotent; teardown failure is reported and never retried through another parser path.
- Streaming Markdown uses only this handle. Existing non-Markdown/non-streaming `highlightOnce` remains its separate contracted domain, never a Markdown fallback.

### 10.2 Parser- and render-safe stable prefix

- Worker edits the complete prior tree, parses incrementally, and reads `oldTree.getChangedRanges(newTree)`.
- It finds the minimum of every current Tree-sitter changed-range start and every normalized edit start, recursively flattens only nodes whose exact shipped-grammar type is `document` or `section`, and selects the first resulting current block whose range contains or follows that point. The edit start is always included, not only when changed ranges are empty, because replacing a clipped synthetic EOF newline can extend a cached capture before the AST-reported changed range. `from` is the selected complete block's `startIndex`, never the raw invalidation offset or transparent wrapper start.
- Every other node remains atomic: metadata, headings, paragraph, table, fence, list, quote, indented code, HTML and thematic blocks are never recursively split. A growing container is therefore reprocessed from its own start, while a changed range that retroactively forms a setext heading rolls back to that heading's prior paragraph start.
- Current Markdown highlight and injection queries capture neither `document` nor `section`, and no shipped query range spans sibling flattened blocks. Therefore querying the selected block and all following blocks does not split an active style, conceal range, injection container or consumed line break. The comprehensive 0%-100% compositor test and direct AST fixtures verify this grammar-specific contract.
- If this render-safe `from < reusablePrefixEnd`, response uses `from=0` and queries the complete current tree. This is the primary path invalidating an incorrect cache claim, not failure recovery.
- Otherwise both base and injection queries run against the selected complete block and every following flattened block in the current tree. A growing table/fence/list/quote/code container is therefore wholly reprocessed from its own start while prior sibling blocks are untouched.
- Reset always returns `from=0`. Results use absolute `SimpleHighlight` offsets, preserve injection/conceal metadata, and clip to real source length rather than synthetic parse length.

### 10.3 Render cache and visibility

- Code cache holds the previous complete parser result plus prefix raw highlights and already converted prefix `TextChunk[]`.
- Both cached cut and response `from` are wrapper-flattened complete-block boundaries. When `from >= cachedCut`, the newly proven stable interval is promoted once from the previous complete result; its ranges are rebased and converted as one closed segment, then only the current tail is converted. No style/conceal/injection can cross either cut.
- While a current version is pending, `drawUnstyledText=false` preserves the last processed frame. No literal/default-styled tail is committed. Removal of the `.4` threshold guarantees the latest dirty version enters the same buffer path immediately after active completion.
- The internal complete chunk array reuses authoritative cached prefix objects and appends newly converted tail chunks. Every `onChunks` callback receives a new array with cloned chunks, nested `link` objects, and mutable `fg`/`bg` RGBA values. Its arbitrary current return may commit, but neither input nor return replaces the authoritative pre-callback cache. This preserves the current mutable callback contract without a marker or second renderer.
- Before any callback, Code saves the worker/merged `SimpleHighlight[]` as private cache authority and creates a separate current-version array by cloning every tuple and its scalar `HighlightMeta` object. `onHighlight` receives only that local array; in-place mutation and a returned replacement preserve current callback semantics but can never enter the next version's cache.
- Code clones the post-`onHighlight` result immediately after callback completion, so references retained by the callback cannot alter current conversion. Whenever `onHighlight` exists, `renderFrom=0` and `treeSitterToTextChunks` converts that complete current-local result; no callback-normalized raw/chunk value is stored as a reusable prefix. This is the only safe contract for an arbitrary callback that may return ranges crossing any cut or depend on full content.
- `ChunkRenderContext.highlights` references only the current-local result, never the raw parser cache. Retained callback references affect only values already handed to that callback.
- Because current `HighlightMeta` fields are scalar booleans/strings/null, cloning each tuple plus `{ ...meta }` is the complete raw-highlight boundary; no speculative recursive normalizer is added.
- Semantic setters clear rendered reuse and reset the same handle. Client/filetype/non-streaming transitions dispose it.
- `TextBuffer.setStyledText` still receives one composed document. R52 reduces parser capture and JS Markdown-to-chunk conversion; it does not claim native partial buffer persistence.

### 10.4 Markdown error outcome

- Buffer parse/query errors reject the exact version. If the still-current snapshot is streaming Markdown, Code enters its existing non-success `highlightUnavailable`/`highlight-error` seam, commits only the diagnostic marker, leaves no callback success, and waits for a new public snapshot to retry.
- Existing plain-text-on-parser-error compatibility remains only for non-Markdown/non-streaming Code, where current public tests contract that behavior. It is never reached after streaming Markdown failure.
- Abort/stale/dispose outcomes remain silent invalidation, not diagnostics or success.

### 10.5 Performance feedback signal

- Handle tests use a large closed-prefix plus growing table/fence workload. Every response must have `from` at the unstable container's wrapper-flattened block start, contain no highlight before `from`, and have serialized result/payload size proportional to the tail; this deterministically rejects full-result transport.
- Existing public `TreeSitterClient.getPerformance()` is sampled before and after ten identical tail-growth updates on fresh short-prefix and 100x-prefix clients; the test compares the deltas, not accumulated global totals. The large-prefix query p95/average must remain within a generous constant factor of the short-prefix run; a full-root query fails by construction. The handle test also asserts the returned `from` and tail payload directly, rather than relying on timing alone.
- `CodeRenderable` test uses a real `SyntaxStyle` and wraps the existing public `getStyle` method as a test-side work counter. After initial setup, the 100x-prefix update must perform no more than `shortTailCalls + 16` style lookups for the same tail; the handle's `from` and tail payload independently prove the parser transport interval. Copy allocation is compatibility work, not parser/style reprocessing.
- Separate callbacks mutate chunk/link/RGBA values, highlight tuple start/end/group, and scalar meta (`conceal`, injection flags/language) while retaining references past return. The next version must still equal the independent full parse and clean visible output, proving no callback-visible object is raw cache authority.
- A tail-dependent `onHighlight` test changes a prefix group/meta only after a later sentinel appears in `context.content`. Every version must use full current composition and equal a fresh full callback render; no assertion permits rendered-prefix reuse for this callback domain. This distinguishes callback correctness from optimized actual streaming domains.
- Output equality, payload bounds and both work signals must all pass; timing alone cannot override correctness.

### 10.6 Removed complexity

- Delete manual fence thresholds and `shouldDeferMarkdownHighlight`.
- Delete standalone fragment parse, offset shifting and manual reference/list/fence stability guesses.
- Changed ranges plus the current tree's wrapper-flattened complete-block boundary become the only stability/composition authority; Code keeps only scheduling/composition state.
- Keep core logic in four existing OpenTUI production files plus the existing shared test mock; no consumer marker, new helper file, parser, normalization layer or configuration.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Success | Disposition |
| --- | --- | --- | --- |
| versioned incremental Markdown buffer | primary contract | yes | sole streaming Markdown syntax path |
| block-cut `from=0` | supported branch in same path | yes | preserve; invalidates unsafe reuse |
| non-Markdown/non-streaming one-shot | existing primary branch | yes | preserve |
| `onChunks` isolated callback copy | contracted branch in same composition | yes | preserve callback semantics, never expose/cache its values or return |
| existing `createBuffer/updateBuffer/resetBuffer` line-event API | existing public compatibility path over the same worker tree/query authority | yes | preserve line-oriented events; never invoke it after handle failure |
| transforming `onHighlight` full composition | supported callback-composition branch in same path | yes | full callback and conversion from 0 every version |
| streaming Markdown `highlightUnavailable`/`highlight-error` | diagnostic | no | use on parser/query failure |
| non-Markdown/non-streaming parser-error plain text | existing compatibility with public tests | yes | preserve only in that domain |
| standalone suffix parser | forbidden alternate path | yes | delete |
| open-fence deferred stale frame | superseded workaround | no | delete |
| parser-after-parser/raw/source/native fallback | forbidden | yes | reject |

New alternate success paths: `0`. The one Markdown diagnostic branch is estimated at `1 / 16 = 6.25%` of modified production decisions, below the 10% limit; implementation audit recomputes the actual ratio.

## 12. Workaround Deletion and Replacement

| Existing workaround | Replacement |
| --- | --- |
| `highlightMarkdownFragment(content.slice(cachedCut))` + shifted ranges | one complete incremental tree + tail query |
| manual blank/reference/fence boundary state | Tree-sitter changed ranges snapped to wrapper-flattened complete-block boundary |
| `OPEN_FENCE_BATCH_*` + `shouldDeferMarkdownHighlight` | every current merged version updates its complete changed tail |
| event-only initial buffer result | awaited handle `initial` |
| raw highlights without rendered reuse | prefix raw highlights + converted chunks |

## 13. Forward Traceability

| Requirement | Production path | Files | Test |
| --- | --- | --- | --- |
| stable prefix + full tail (`INV-01`-`INV-03`,`INV-18`,`INV-19`) | full tree -> changed/edit minimum -> transparent-wrapper flatten -> complete-block cut -> cache+tail composition | four production files | 0%-100% comprehensive sweep + direct AST/EOF cases |
| initial/current completion (`INV-04`) | version pending map | client/worker/types | initial empty/update/reset/dispose |
| visibility/callback safety (`INV-05`,`INV-06`) | last processed frame while pending + callback-first current commit | Code | delayed latest append/transform callback |
| complete Markdown (`INV-07`) | same primary path | same files | named complete fixture/full-parse oracle |
| restraint (`INV-08`) | no new files/helpers | six exact files | diff/E/C audit |
| EOF/initial lifecycle (`INV-10`,`INV-11`) | normalized handle edit + client-owned pre-delivery cleanup | client/worker/types | fence EOF and delayed initial abort |
| Renderable teardown (`INV-11`) | Code destroy -> abort pending open or dispose delivered handle -> base destroy | Code/client | public client buffer count reaches zero after destroy |
| real optimization (`INV-12`) | tail payload/query bounds + public style-work counter | existing public seams | large-prefix growing-tail workload |
| Reasoning callback cache (`INV-13`) | internally cached prefix chunks + converted tail -> isolated current `onChunks` input -> current commit | Code | actual callback keeps tail-only parser/style work |
| callback cache isolation (`INV-13`) | private raw/chunk cache -> current-local tuple/meta clone + chunk/link/RGBA copies -> callbacks | Code | tuple/meta/chunk mutation does not affect next version |
| Markdown error outcome (`INV-14`) | version rejection -> current-snapshot diagnostic state/event -> retry only on new snapshot | Code | no source-text success/callback after error |
| transforming highlight callback (`INV-15`) | complete local callback -> cloned result -> current full conversion from 0 | Code | tail-dependent callback matches fresh full render |
| optimization observation (`INV-12`) | Markdown result `from`/tail payload + delta of existing public `SyntaxStyle.getStyle` work | client/Code public seams | short vs 100x-prefix payload and style-work comparison |
| legacy buffer adapter (`INV-16`) | existing line-event methods and new handle share parser state/query authority with distinct response adapters | client/worker/types | legacy client tests plus handle differential |
| controllable Markdown mock (`INV-17`) | mock handle delegates to existing pending highlight queue | mock client/Code tests | existing Markdown tests remain driveable |

## 14. Reverse Traceability

| Concept | Requirement | Evidence | Existing logic insufficient because |
| --- | --- | --- | --- |
| Markdown buffer handle | `INV-03`,`INV-04` | current event-only buffer/R39 B-01 | Code cannot await exact initial/current version |
| wrapper-flattened changed-range cut | `INV-02`,`INV-18` | observed grammar tree + list/quote/code/table differential + query shape | raw changed offset and direct root child are not render boundaries |
| tail query on full tree | `INV-01`,`INV-03`,`INV-12` | user table requirement/R39 B-02 | full query repeats prefix; suffix parse loses context |
| rendered prefix chunks | `INV-01` | user render-cache equation | raw highlights still reconvert full content |
| synthetic Markdown EOF edit | `INV-10`,`INV-19`,`INV-20` | current Code/one-shot workaround + observed clipped heading extent + binding offset probe | raw buffer content differs at EOF and mixed byte/UTF-16 positions would corrupt visible slicing |
| pre-delivery cleanup | `INV-11` | setter/destroy abort path | caller cannot dispose an undelivered handle |
| Code destroy override | `INV-11` | Solid reconciler calls `destroyRecursively()` while base class only frees text resources | shared client cannot own per-Renderable handle lifetime |
| pre-callback chunk cache | `INV-01`,`INV-13` | actual Reasoning callback returns its input after observing text | caching transformed callback output would be unsafe, while authoritative input chunks are reusable |
| isolated callback values | `INV-13` | public callbacks are mutable and chunk segmentation is not a cache contract | direct authoritative chunks can be mutated or observed across versions |
| callback-visible value copies | `INV-13` | public mutable `SimpleHighlight` tuple/meta and `TextChunk`/array/link/RGBA types | direct authoritative values can be mutated during or after callback |
| transforming callback full composition | `INV-01`,`INV-15` | callback sees complete `context.content` and can return ranges crossing any cut | no bounded proof permits prefix chunk reuse for arbitrary callback |
| Markdown unavailable diagnostic | `INV-14` | reachable worker errors + existing error event/state | plain source is success-shaped under `drawUnstyledText=false` |
| JavaScript Markdown offset contract | `INV-10`,`INV-20` | installed binding's `parse(string)` callback and direct CJK probe | byte-length edit math would diverge from the offsets consumed by `String.slice` |

## 15. File-Level Change Plan

At most six existing code files are authorized; no additions:

| File | Responsibility | Estimated production delta |
| --- | --- | --- |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | sole Markdown handle scheduling, complete-block raw/chunk cache isolation, callback-domain full composition, Markdown diagnostic, current commit and handle teardown; remove old boundary/defer/fragment code | `+165/-150` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | compact public handle, normalized edit in the JavaScript string-index domain and pre-delivery cleanup | `+115/-15` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | flatten exact transparent grammar wrappers, select complete render-block cut and query tail `SimpleHighlight` values in the public JavaScript offset domain | `+85/-30` |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | minimal request/response/result fields with explicit Markdown offset contract | `+25/-5` |
| `thirdparty/opentui/packages/core/src/renderables/Code.test.ts` | both confirmed public seams, comprehensive fixture, callback/error/lifecycle/performance and percentage sweep | test only |
| `thirdparty/opentui/packages/core/src/testing/mock-tree-sitter-client.ts` | implement the new public handle in the existing controllable pending test seam; no production fallback | test/support only |

Production effective additions/modifications target `410-580`, hard maximum `600`. The six files are four production protocol/render files plus the existing Code test and shared mock; no OpenCode consumer or new helper file changes. Existing `client.test.ts` and Markdown tests run unchanged as regression. Discovery of a seventh code file, new helper module or production line count above 600 stops implementation and returns an explicit open decision to the user; it may not be silently added.

## 16. TDD Behavior Slices

| Order | Red behavior | Why `.4` fails | Minimal green | Protection |
| --- | --- | --- | --- | --- |
| 1 | buffer initial `[]` is awaitable | create returns only boolean | awaited initial result | initial race/empty completion |
| 2 | paragraph + table row append returns exact version from `pipe_table` start rather than enclosing `section` start | no Code-facing simple completion; R48 chose transparent root wrapper | wrapper-flattened render-safe tail result | table delta integrity + R49 plan drift |
| 3 | list/quote/indented continuation invalidates unsafe cut and equals full parse | suffix loses context | complete container block crossing returns `from=0` | observed bug |
| 4 | abort before initial delivery removes worker buffer before rejection; reset/dispose cannot resolve stale version | no owner before handle delivery | client-owned cleanup/handle lifecycle | resource leak/stale commit |
| 5 | Code preserves prior frame while pending and commits latest complete result | deferred gate skips current work | same-handle latest version | `drawUnstyledText=false` contract |
| 6 | complete document at 0%-100% prefixes equals independent full parse | current test is narrow | cache+tail composition | all required formats |
| 7 | actual Reasoning-shaped callback receives isolated composed chunks while internal prefix parser/style work is reused; callbacks mutate local tuple/meta/chunk/link/RGBA without altering next version; tail-dependent `onHighlight` always uses current full composition | R42 reconverts full callback path; R43/R44 exposed mutable cache; R45/R46 callback reuse proof incomplete | isolated callback values + callback-domain full branch | callback compatibility/performance |
| 8 | every synthetic EOF transition, including heading text -> real newline and fence closer, equals one-shot oracle for ASCII and CJK/emoji prefixes | buffer lacks shared newline semantics; changed ranges can start after a newly visible clipped extent; offset domain is untested | normalized edit start participates in block invalidation; JS string-index contract remains intact | EOF grammar/cache/offset parity |
| 9 | 100x stable prefix does not enlarge tail payload/query/style work; existing public style-work delta stays within a deterministic bound of the same short-tail update | equality alone is insensitive; R50's proposed production observation field was unjustified | `from`/payload + public `getStyle` counter, no new production telemetry field | actual optimization |
| 10 | destroying Code during pending open and after handle delivery yields the worker's `buffer:disposed` event, leaves `client.getAllBuffers()` empty and allows no later callback/commit | inherited destroy omits parser resources | Code-owned abort/dispose before base destroy; test awaits worker acknowledgement | Session switch/unmount leak |
| 11 | current streaming Markdown parser/query error emits diagnostic, never source text/callback success, and a new snapshot can recover | generic catch currently commits source text | Markdown-only unavailable outcome | forbidden fallback |

Expected values come from a separate `TreeSitterClient.highlightOnce(currentContent, "markdown")` oracle and literal visible text, never from cache or changed-range implementation.

The comprehensive fixture name and body explicitly include ATX/setext headings, paragraphs, emphasis/strong/strike, inline code, escapes, links/images/autolinks/references, ordered/unordered/nested/task lists, blockquotes, thematic breaks, GFM table with partial rows, backtick/tilde fences with injection, indented code, HTML, frontmatter, multiline formula-like literals, CJK, emoji and tabs.

The 0%-100% requirement uses 101 monotonic grapheme-safe prefix endpoints. At each endpoint `CodeRenderable` retains the prior processed frame until completion, then its final output is compared with full parse. Handle tests propose reusable cuts across the same percentages and accept only exact merged equality; the worker may return `from=0` whenever the complete-block boundary crosses cached output.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective production/test code `E` | `650-900` | production remains <=600; exclude imports, formatting and pure moves |
| Required comments `C` | `98-135` | `ceil(E*0.15)` |

Nearby Chinese comments explain transparent grammar wrappers, complete-block render cuts, version ownership, synthetic EOF edit, complete table/fence tail, raw-cache/current callback ownership, isolated callback values, why arbitrary `onHighlight` uses full composition, Markdown diagnostic, teardown ownership and behavioral test intent. Obvious assignments/control flow do not count.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| focused test names from Section 16 | `thirdparty/opentui/packages/core` | each red-green slice |
| `bun test ./src/renderables/Code.test.ts` | `thirdparty/opentui/packages/core` | Code seam/comprehensive fixture |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | unchanged legacy buffer/one-shot compatibility |
| `bun run test:js` | `thirdparty/opentui/packages/core` | full JS regression |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | TypeScript/library build |
| `bun run lint` | `thirdparty/opentui` | nested lint |
| actual list/quote/indented differential | `thirdparty/opentui/packages/core` | original red loop green through approved seam |
| focused large-prefix growing-table/fence work test | `thirdparty/opentui/packages/core` | tail-only response/query/chunk work |
| focused Reasoning-shaped callback cache test | `thirdparty/opentui/packages/core` | isolated callback output and tail-only parser/style work |
| `bun test ./src/renderables/Code.test.ts -t "bounds Markdown conversion work to the unstable tail"` | `thirdparty/opentui/packages/core` | `from`/tail payload plus public `SyntaxStyle.getStyle` delta stays within the fixed test bound against short/100x-prefix cases |
| `bun test ./src/renderables/Code.test.ts -t "streaming Markdown isolates callback mutations and tail-dependent transforms"` | `thirdparty/opentui/packages/core` | raw/chunk isolation, callback full composition and no plain-text fallback |
| independent source implementation audit | repository root | mandatory completion gate |

No package release, parent closure, native build or remote command is part of R52. Any unexplained failure blocks completion.

## 19. Diff Budget

| Metric | Limit |
| --- | --- |
| code files modified | exactly these six maximum |
| production effective lines | <= 600 |
| new files/modules/dependencies/config | 0 |
| native/generated/release/parent files | 0 |

The budget is a hard constraint, not permission to omit confirmed behavior. If the six-file design cannot carry a confirmed invariant, the implementation stops and returns to plan audit rather than adding code.

## 20. Real Risks and Open Decisions

### Observed/Reachable Risks

- Top-level boundaries may conservatively produce `from=0`; correctness is mandatory, while focused evidence must show growing tables/fences normally retain preceding sibling blocks.
- Base Markdown and injection queries must use the same render-safe `from` or metadata can diverge.
- JS chunk reuse does not imply native partial TextBuffer persistence; claims and benchmarks must keep that boundary explicit.
- Every `onChunks` callback receives isolated copies; cloning adds O(prefix chunk count) compatibility work but never repeats parser capture/style conversion, and no callback marker or consumer change is required.
- Detached submodule source remains local dirty state; R52 cannot claim installed OpenCode runtime deployment.

### Open Decisions Requiring the User

- After R52 source implementation becomes independently verified, whether to start a separate release/runtime closure plan and which version identity to use. No answer is assumed now.

### Rejected Speculation

- No synthetic hung watchdog, math renderer/query, source fallback, native partial StyledText ABI, producer rewrite or MarkdownRenderable migration.
- No normalization/compatibility layer for inputs absent from the current Message Part/public setter path.

## 21. Audit Contract

The independent auditor must read exact R52 and the verbatim requirements, reconstruct both Session consumers and producer -> Code -> client normalized edit -> worker changed/edit minimum -> transparent `document`/`section` wrapper flattening -> complete-block cut -> private raw/chunk cache -> isolated callback values -> `onHighlight` full composition or `onChunks` composition -> TextBuffer/error outcome behavior, plus the legacy line-event buffer adapter. It must verify the actual wrapper AST evidence, the explicit JavaScript UTF-16 offset contract for all Markdown results and edits, synthetic-to-real EOF cache invalidation, the public `from`/tail payload contract, the existing public style-work observation test, whole-container tail refresh, tail-dependent callback correctness, all callback-visible mutation isolation, mock-handle test reachability, old/new buffer authority sharing, lifecycle/error handling, one synthetic-EOF-consistent full tree, 0%-100% comprehensive fixture, all performance signals for optimized domains, <=6 code files, <=600 production lines, and absence of release/remote authority.

R52 is round 2 of the newly user-authorized continuation. Any blocker requires R53+, cleared approval and another full-scope audit; it cannot be weakened or implemented around.

## 22. Plan Audit Record

| Round | Revision | Full scope | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R39 | yes | B-01 初始 buffer version 的高亮结果无法通过计划接口交付给 `CodeRenderable`; B-02 stable prefix 没有形成用户要求的缓存渲染路径; B-03 计划超过用户规定的 8 个代码文件上限; B-04 canonical revision 和 authoritative Markdown path 相互冲突; B-05 远程 push、tag 和 GitHub Release 缺少可信用户授权 | README release wording; PowerShell-incompatible tarball commands; implementation E/C pending | BLOCK | `ses_052aa526fffegCcwDyxVIOZuVg` |
| 2 | R40 | yes | B-01 待处理版本会绕过 `drawUnstyledText=false` 的公开可见性合同; B-02 Tree-sitter changed-range 字节位置不是可直接拼接的渲染边界; B-03 新 buffer 路径没有保持现有 Markdown 文末解析语义; B-04 初始 handle 在返回前 abort 时缺少可执行清理路径; B-05 渲染优化要求没有行为敏感的性能验证 | N-01 文件预算措辞不一致 | BLOCK | `ses_052746788ffewjOSiEYDmnYlHI` |
| 3 | R41 | yes | B-01 `CodeRenderable` 销毁时没有释放其 Markdown buffer handle | N-01 Consumer inventory 遗漏启用中的 Session v2 流式 Markdown 路径 | BLOCK | `ses_05268edb7ffe5kOqt9zwIpGD9Y` |
| 4 | R42 | yes | B-01 `onChunks` 消费路径绕过稳定前缀渲染缓存 | N-01 Renderable teardown 测试只观察 client 本地状态; N-02 生产 diff 估算口径略有漂移; N-03 `bun run build:lib` 超出最低要求 | BLOCK | `ses_05262135bffez3dHNwGo07tI7i` |
| 5 | R43 | yes | B-01 保留了 Markdown parser 失败后的 plain-text 成功路径; B-02 `onChunks` 可以修改计划中的 authoritative prefix cache | none | BLOCK | `ses_05259b018ffebiHKeb5YqMJrDQ` |
| 6 | R44 | yes | B-01 公开 callback 仍可修改 authoritative raw-highlight cache | none | BLOCK | `ses_05250d342ffeD6oLOTZi3QqPbE` |
| 7 | R45 | yes | B-01 任意 `onHighlight` 转换与稳定前缀 chunk 复用缺少一致的执行路径 | N-01 部分 focused verification 仍是描述性占位 | BLOCK | `ses_04838a602ffeV1PLvilwKT85fu` |
| 8 | R46 | yes | B-01 `onHighlight` 生成跨切点区间时，前缀相等判断会错误复用旧 chunks | none | BLOCK | `ses_048334c53ffeX3CUpSf2Jzu7pg` |
| 9 | R47 | yes | B-01 六文件方案无法保持现有 Markdown 测试替身路径; B-02 `onHighlight` 在同一 revision 中存在两条互斥的缓存语义; B-03 旧有 versioned buffer 成功路径未被纳入完整路径清单 | N-01 synthetic-newline oracle 文件级说明不够精确; N-02 额外 `build:lib` 验证不是最低要求 | BLOCK | `ses_0482a726cffeLDcdYsni6AUuJH` |
| 10 | R48 | yes | none | N-01 部分 focused verification 名称仍是描述性; N-02 `getPerformance()` 对照措辞略不精确 | APPROVE | `ses_0481959f8ffe1oPQu2d5zec4Gg` |
| 11 | R49 | yes | none | N-01 TypeScript-only 变更仍包含额外 `bun run build:lib`; N-02 E/C 保持区间估算，实施审计须按实际 diff 重算 | APPROVE | `ses_047ff0c24ffesBXEQdoMhOON7l` |
| 12 | R50 | yes | B-01 Performance invariant lacks a behavior-sensitive verification seam | N-01 production 与 total E/C 估算区间口径不同; N-02 部分 focused verification 仍是描述性命令 | BLOCK | `ses_047d66ad6ffeSLPnSBmm6kWQpY` |
| 13 | R52 | yes | none | N-01 0% endpoint 应执行同一 completion 断言; N-02 timing comparison 受运行环境影响 | APPROVE | `ses_0473c5cb9ffe2DTgiEc8Fh0EDR` |

## 23. Implementation Evidence

R49 implementation stopped when the 101-prefix public Code seam exposed synthetic-to-real EOF cache drift, R50 plan audit required an executable work observation contract, and R51 plan audit required an explicit offset-domain contract plus removal of the unjustified callback field. The current six-file red-green diff is in-progress evidence only, not authorized R52 implementation evidence; it may be continued or reworked only after exact R52 approval.

## 24. Implementation Audit Record

| Round | Approved revision | Full scope | Findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| pending | pending | yes | pending | pending | pending |

The task cannot be marked verified until an independent full-scope implementation audit returns `No blocking findings` / `APPROVE` for the exact approved revision and actual diff.

# Canonical Implementation Plan: OpenTUI TUI Liveness and Tree-sitter Lifecycle Repair

> Status: implementation-audit-required
>
> Revision: R81
>
> Approved revision: R81
>
> Audit mode: plan (full original scope)
>
> Requirement source: 用户关于 Windows 平台 TUI 整体停止刷新/交互失效、正文和 Thinking 大面积空白、命令面板残影、Tree-sitter worker 错误、persistent Tree 生命周期、Ctrl+C 批量 warning、根因修复和精准修改范围的当前请求。
>
> Implementation allowed: no further material changes without rework or revision
>
> Last updated: 2026-08-08

本文顶部的R81 sections是当前唯一的canonical authority。R1-R80正文、旧实现、旧预算和旧审计记录全部是non-normative traceability；它们不能授权实施、不能覆盖R81的文件边界、不能覆盖R81的root cause结论。R81吸收R80审计关于one-shot scope过早释放和`HANDLE_EDITS`遗漏的要求，使每个顶层Parser请求在一个scope内完成全部parse/query/injection工作。

## R81 Current Authority

R81由独立R80方案审计的两个blocking findings触发，必须在implementation audit前完成full-scope plan re-audit：

1. 当前`processInjections()`在`parser.parse()`/query异常时catch并继续，最终把部分captures发布为成功highlights；R80删除该catch-and-success路径。异常沿当前worker请求的相关错误终态传播，成功response只在全部注入处理完成时发布。
2. 当前worker bridge对每个输入调用`void handler(...)`，不会等待前一个异步handler；`ParserWorker`同时持有`filetypeParsers`、`filetypeParserPromises`、`reusableParsers`、`reusableParserPromises`和buffer-owned Parser。配置失效、clear、buffer初始化和高亮操作可交叉访问这些共享cache。
3. R81的唯一同步机制是不可重入私有`withParserAssets<T>(operation: (scope) => Promise<T>)`：scope同时拥有filetype cache读取/创建、ReusableParser获取和失效操作；回调内部完成该顶层请求涉及的全部cache/Parser操作。调用者不得保存scope、Parser或把Parser引用返回到scope外。
4. 所有顶层入口都必须进入同一scope：`handleInitializeParser`、`handleEdits`、`handleOneShotHighlight`、`handleStreamingUpdate`、`handleResetBuffer`、`preloadParser`、`clearCache`和`addFiletypeParser`。`processInjections`和`updateReferenceState`只接收当前scope，不自行排队，避免嵌套tail死锁。
5. `handleInitializeParser`在scope内完成resolve filetype parser、new Parser/setLanguage、parse、initial query/injections和buffer state发布；因此clear/registration不能清理或复活其异步promise。`handleStreamingUpdate`/reset的buffer candidate ownership仍保留，scope只保护共享asset和injection/reference parser。
6. unsupported injection parser是既有primary-contract pass-through：记录warning、跳过该语言的高亮范围并保留其余主文档结果；它不等同于Parser.parse/query异常。真实parse-null或query exception不得沿partial-success返回。
7. one-shot从outer parse到全部injection、highlight转换和response准备始终保持同一个scope；普通`HANDLE_EDITS`同样在一个scope内完成candidate parse/query/injection和accepted commit。scope只在请求不再持有任何Parser/Query/Tree依赖后释放。
8. R81的primary repair只修正Parser asset owner时序和注入异常成功化：不创建第二Parser、不重试、不添加fallback、不吞异常、不把error转换成成功。one-shot client response rejection和初始化Promise传播只是correlated终态协议。
9. one-shot响应合同仍只有三种结果：`error` reject；`warning + hasParser:false` resolve既有能力结果；无error/warning resolve highlights。warning不是协议失败。
10. R81保留R74完整六个不变量和producer-first主验收：正常支持域不产生error/permanent pending；异常测试只证明异常不会伪装成成功，不构成失败终态交付目标。

### R74 Complete Scope Contract

| ID | Expected invariant | First divergence / owner | Required public evidence |
| --- | --- | --- | --- |
| R74-INV-01 | 合法daemon Project事件对应未加载Session/Message/Part时，TUI projection no-op且继续消费后续事件 | `SyncProvider`缺失collection进入`Binary.search`; owner `sync.tsx` | `sync-undefined-messages.test.tsx` plus compiled target-liveness event/frame continuation |
| R74-INV-02 | 同buffer mutation完成前不得dispose accepted Tree或删除mirror | `TreeSitterClient.removeStreamingBuffer`绕过in-flight operation; owner per-buffer tail | public delayed update/remove lifecycle test and zero pending callback after destroy |
| R74-INV-03 | Parser只能在完整parse/query/injection后commit accepted Tree，失败candidate不污染下一次更新 | `ParserWorker.handleStreamingUpdate`提前替换accepted state; worker Tree owner | candidate failure then public successful update/reset and repeated lifecycle tests |
| R74-INV-04 | Markdown/Thinking/body在异步highlight期间保持当前token/raw可见，`drawUnstyledText=false`不改成常开 | Markdown seed缺失、Code pending TextBuffer提交时机 | structured/list/blockquote/table/fenced pending tests and compiled body/Thinking frames |
| R74-INV-05 | 正常renderable destroy/Ctrl+C不产生批量Tree-sitter cancellation/highlight warning | Code warning判断晚于destroy owner; Code/client lifecycle | cancellation test plus compiled target-liveness Ctrl+C zero-warning assertion |
| R74-INV-06 | 支持域primary path不产生worker error/permanent pending；任何真实`error`不能进入成功渲染分支 | correlated response和Code空highlight success conversion; client/Code owners | normal concurrent one-shot/streaming tests, real error-shape protocol test, compiled smoke |

R74 production baseline consists of the already implemented SyncProvider, client tail, parser candidate owner, Code pending seed, Markdown seed and destroy ordering. R74 incremental production change is only one-shot `error` response classification; R74 must not add a new producer fallback or failure state machine.

### R74 One-Shot Protocol Contract

| Response | Worker meaning | Client owner | Consumer contract |
| --- | --- | --- | --- |
| `error` present | parser/protocol failure was actually produced | reject matching callback once | Code cannot treat it as empty-highlight success; this is error evidence, not normal success |
| `warning` + `hasParser:false` and no error | unsupported capability | resolve existing result object | `treeSitterToStyledText()` and existing unsupported-filetype tests retain capability behavior |
| no error/warning | successful parse/query | resolve highlights | existing one-shot/Markdown rendering path |

### R74 Verification Commands

All Bun commands run from the listed package directory under an external process-tree supervisor:

| Command | Directory | Required observation |
| --- | --- | --- |
| `bun test ./src/lib/tree-sitter/client.test.ts -t "concurrent highlightOnce|one-shot response error|unsupported filetype warning"` | `thirdparty/opentui/packages/core` | normal supported calls remain successful; error rejects; warning resolves |
| `bun test ./src/renderables/Code.test.ts -t "does not commit plain text|drawUnstyledText=false output"` | `thirdparty/opentui/packages/core` | existing no-fallback behavior |
| `bun test ./src/renderables/__tests__/Markdown.test.ts -t "streaming.*list|pending|table|fenced"` | `thirdparty/opentui/packages/core` | current Markdown/Code representation remains visible |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | declarations and worker bundle |
| `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | unloaded projection no-op and continued event handling |
| `bun typecheck` | `packages/opencode` | type contract |
| `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` | `packages/opencode` | Thinking/body, command palette, event/frame liveness, worker readiness, Ctrl+C and zero warnings |

R74 keeps the previously measured full nested baseline `E=744` as an observed audit fact, removes the obsolete `E<=300` plan target, and requires final production `E<=600`, total effective `E<=800`, eight code files, six production files and per-file comment-floor verification. R74's new response branch/test delta is expected to remain below 40 effective lines.

### R81 Verbatim Requirement Contract

以下内容是当前R70直接继承的用户原文合同；后续实现和审计不得只引用R1-R69历史正文：

> “当前请注意你的整体当前的方案内容,并该放在一个全新的markdown里面,也就是放在一个全新的一个相应的计划里面,然后包含对如上内容的修复。同时整体的修复的代码修改量不超过六个生产文件,同时修改量不超过600行,避免进行重大的一些重构等等,请保持精准修改,完整解决那些有问题的逻辑,也就是完整解决我们之前的所有的问题,包括相应的长时间空排,Ctrl C后批量报错等等的一些特定缺陷。”

> “根本需求是修正原有产生的opencode的TUI卡死（表现为交互失效，只有基本的TUI渲染，如prompt区域pending的blink，其他命令面板交互无响应、所有内容均不再进行更新与响应的问题）使其之后不再会产生类似的TUI自身渲染卡死、失去响应问题，同时解决在结束之后会爆出大量的（Code streaming highlight failed, falling back to plain text: warn: TreeSitter client destroyed）的问题、禁止添加和‘根治’操作无关的任何修改，也就是最终目的不是让报错更加明显，而是解决报错的根因；与此同时，还要根治TUI正文不渲染且只有markdown的标号的问题，即存在大面积空白、只有1. 2.这种渲染的问题；同时，整体修改量代码不超过8个文件，生产代码修改量不800行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支，更好的应该是顶层设计保持简单，逻辑完整而不复杂。”

> “当前存在问题,请问你的600毫目前都消耗在哪里了?理论上来说,我们整体的生产代码应该逻辑只需要进行手术刀级的进行替换、移动以及修改,而不需要进行大规模的重构。”

> “同时禁止大幅度增加额外的error的判断与handle机制，根源性修复应当是修正错误的机制使得任何可能的不稳定error根本不会产生。”

> “错误，目的不是保留失败诊断/终态，而是让其不准失败，即不可能再出现错误路径，即错误判定保留，但不会再引起错误失败。”

> “也就是换言之，问题不是错误是如何消费的，而是解决错误是如何产生的。”

> “你可以检查最近十次commit里面是不是引入了一些潜在的异常路径或者机制内容，导致当前内容发生故障。请你仔细检查。同时，不要依靠添加日志断点的形式来解决问题。”

R81把“正常支持域不产生错误”作为主验收条件；完整Parser asset owner scope和注入异常传播是producer根因修复，Code catch收敛、one-shot响应分类和初始化拒绝传播只是删除成功伪装的必要配套，不构成独立交付目标。

R81保留完整用户原文合同、R74-INV-01至R74-INV-06、单一primary path、无新增alternate success path、最多6个生产文件和最多8个代码文件约束。R81最终nested OpenTUI边界仍为5个生产文件和3个既有测试文件，共8个；root SyncProvider是已提交基线，不产生R81新diff；release manifest/lockfile保持`.6`基线。

### R81 Producer Ownership Contract

| Path | Existing behavior | R81 owner repair | Public evidence |
| --- | --- | --- | --- |
| `handleInitializeParser()` | resolves shared `filetypeParser` outside the proposed reusable tail and can republish a stale promise result after registration/clear | entire filetype resolution, Parser creation, initial parse/query/injections and buffer-state publication run inside `withParserAssets`; no shared cache reference escapes | real buffer initialization versus registration/clear barrier test |
| `handleOneShotHighlight()` | uses a cached Parser for outer parse, then performs async injection work | hold one scope from outer parse through all injection parse/query, highlight conversion and response preparation; returned Tree remains one-shot-owned and is deleted in existing `finally` | one-shot invalidation and normal concurrent highlight tests |
| `processInjections()` | obtains a reusable parser per injected language; local catch logs parse/query failure and returns partial captures | accepts current scope, each language group uses scope-owned Parser, Tree cleanup uses `finally`; remove catch-and-continue so no failed injection produces success | streaming fenced-code and one-shot injection invalidation/error-propagation tests |
| `handleEdits()` / `handleStreamingUpdate()` / `handleResetBuffer()` | buffer candidate paths call async injection/reference helpers while shared asset cache can be invalidated | wrap each complete top-level operation in `withParserAssets`, pass scope to helpers, and commit the accepted buffer candidate before releasing the scope | ordinary edit, streaming injection/reference and reset-after-clear tests |
| `updateReferenceState()` | obtains `markdown_inline` reusable parser and parses all inline nodes outside filetype cache barrier | accepts current scope and performs complete inline parse/walk within it | streaming reference append/update test with parser invalidation |
| `preloadParser()` | creates/returns filetype and reusable cache state without invalidation ordering | cache creation runs inside the same scope | preload plus registration ordering test |
| `addFiletypeParser()` / `invalidateParserCaches()` | deletes cached Parser and clears filetype promises synchronously | parser options update and deletion run as one scope operation; no synchronous cache owner mutation outside scope | real worker registration interleaving tests |
| `clearCache()` | clears filetype/reusable maps without waiting for initialization or parser users, and does not delete all cached Parser owners | clear operation enters the same scope barrier, deletes every accepted Parser owner once, clears all maps/promises, then performs filesystem clearing | public clear-cache lifecycle regression |
| `TreeSitterClient.highlightOnce()` -> `initialize()` rejects | catch returns `{ error }`, allowing Code to treat missing highlights as success | remove the conversion and let the original initialization Promise rejection propagate | public `highlightOnce()` initialization-failure seam rejects |
| `ONESHOT_HIGHLIGHT_RESPONSE.error` | correlated result currently resolves error-shaped object | reject matching callback once; warning-only unsupported capability still resolves | real `onmessage/postMessage` response-shape test |
| `warning + hasParser:false` | existing unsupported-filetype capability result | preserve resolved capability result | `client.test.ts:398-405` and styled-text consumer |

The `withParserAssets` scope is the only new producer-side synchronization mechanism. It serializes the existing filetype/reusable cache and Parser instances, not all worker messages or unrelated client messages. Every top-level Parser request, including `HANDLE_EDITS`, has one scope from its first shared-cache access through its final parse/query/injection/accepted-state transition. No cache promise, parser state or Parser object may be used outside the scope callback. It does not create a second Parser, retry a failed parse, synthesize highlights or convert failure into success. `processInjections()` no longer catches a real parse/query exception and returns partial success. The client response branch remains a correlated settlement contract only.

#### R80 Scope Interface and Ordering

1. `enqueueParserAssets<T>(operation)` appends exactly one top-level operation to a private Promise tail. A rejected previous operation does not prevent the next cleanup/invalidation operation; the returned operation preserves its own rejection.
2. `withParserAssets<T>(operation)` is the only top-level entry into that tail. It creates a scope object with cache lookup/creation/invalidation operations and invokes the callback before releasing the tail. Scope, cache promises, Parser and FiletypeParser references cannot escape.
3. `getReusableParser()` and `resolveFiletypeParser()` are scope-private operations; no worker handler calls them directly. Their promise creation and map write-back occur before the scope settles, so clear/registration cannot remove a promise and later allow its stale result to resurrect.
4. `handleInitializeParser()` holds one scope through filetype resolve, Parser creation/setLanguage, initial parse, `initialQuery`/injections and `bufferParsers.set`. `processInjections(scope, parserState)` and `updateReferenceState(scope, parserState, editStart)` consume the same scope and never call `withParserAssets` themselves.
5. `handleOneShotHighlight()` holds one scope from outer parse through injection parse/query, highlight conversion and response preparation, then deletes the one-shot Tree in `finally`. No nested scope or separately scoped injection helper is allowed.
6. `handleEdits()`, `handleStreamingUpdate()` and `handleResetBuffer()` hold one scope for the full candidate parse/query/injection/reference operation and accepted buffer Tree transition. The scope is released only after candidate commit or candidate cleanup and before the response leaves the worker.
7. `preloadParser()` runs resolve/create under one scope and returns only capability. `addFiletypeParser()` updates options and invalidates both filetype and reusable cache under one scope. `clearCache()` waits at the same tail barrier, deletes every cached Parser exactly once, clears all maps/promises, then performs existing filesystem clearing.
8. Unsupported injection language remains a pass-through branch inside the scope: warning and omitted injected captures are preserved. Parser.parse-null, Query.captures exception or Tree ownership failure throws out of the scope; the caller publishes no success highlights for that request.
9. Buffer-owned Parsers remain outside the asset cache itself but their top-level worker operations are inside the scope; existing client per-buffer operation/candidate ownership still controls same-buffer ordering. No shared Parser call occurs outside the scoped helper calls above.

### R81 Exact File Boundary

| File | Current R81 responsibility | Planned delta |
| --- | --- | --- |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | Parser asset scope covering filetype/reusable caches, initialization, ordinary edits, one-shot, streaming/reset helpers, registration/clear barriers; remove injection catch-and-success; retain buffer candidate ownership | production modify, expected `E<=115` |
| `packages/core/src/lib/tree-sitter/client.ts` | Propagate initialization rejection and reject correlated one-shot error response; preserve warning capability result | production modify, expected `E<=10` |
| `packages/core/src/lib/tree-sitter/types.ts` | Existing typed correlated response contract only; no R81 semantic expansion | production baseline/reverify |
| `packages/core/src/renderables/Code.ts` | Existing pending seed, no failure-to-success commit and destroyed-first warning suppression | production baseline/reverify |
| `packages/core/src/renderables/Markdown.ts` | Existing current-token seed into Code with `drawUnstyledText=false` | production baseline/reverify |
| `packages/core/src/lib/tree-sitter/client.test.ts` | Add deterministic real-worker reusable-parser use/invalidation, clear-cache and one-shot protocol tests; retain normal concurrency | test modify |
| `packages/core/src/renderables/Code.test.ts` | Existing no-fallback and destroyed-first contracts | test baseline/reverify |
| `packages/core/src/renderables/__tests__/Markdown.test.ts` | Existing structured/list/table/fenced pending and settle contracts | test baseline/reverify |

Root `sync.tsx`, its regression test and compiled smoke are required verification baselines but are not R81 nested implementation files. Release manifests/lockfiles remain `.6` cleanup only and are not production concepts.

### R81 Verification Boundary

Run under the external process-tree supervisor:

1. `bun test ./src/lib/tree-sitter/client.test.ts -t "should perform one-shot highlighting|should handle one-shot highlighting for unsupported filetype|should handle concurrent highlightOnce calls efficiently|filetype cache barrier during buffer initialization|reusable parser invalidation|clear cache waits for parser assets|ordinary edit parser asset invalidation|streaming injection invalidation|streaming reference invalidation|injection failure does not resolve as highlights|one-shot response error|highlightOnce initialization failure"` from `thirdparty/opentui/packages/core`.
2. `bun test ./src/renderables/Code.test.ts -t "does not commit plain text|drawUnstyledText=false output"` from `thirdparty/opentui/packages/core`.
3. R74 normal Markdown focused tests, `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx`, `bun run build:lib`, `bun typecheck`, and the compiled `target-liveness` command from the R74 table.

The producer lifecycle slices use a real worker and a deterministic gated parser/query asset fixture. The fixture exposes independent `use-started`, `release-use`, `invalidation-sent` and public Promise settlement signals; it does not inspect cache maps or count private calls. Before R81, registration/clear can settle before a held operation, stale filetype promises can be written back after a barrier, one-shot injection can outlive its released scope, ordinary edits can bypass the scope, and injection exceptions can resolve partial highlights. After R81 every public operation observes scope ordering, current and subsequent supported highlights succeed, and a deliberately failed injected parse rejects rather than publishing highlights. Buffer initialization and ordinary `HANDLE_EDITS` are included explicitly so registration/clear cannot resurrect an old `FiletypeParser`. Unsupported injection remains a warning/pass-through assertion. The initialization test remains protocol evidence: it is red before the existing client conversion is removed because `highlightOnce()` resolves `{error}`, then observes a rejected public Promise. No new fallback or recovery path is permitted.

R81 incremental production delta is expected below 125 effective lines across `parser.worker.ts` and `client.ts`; the full existing baseline remains subject to production `E<=600`, total effective `E<=800`, eight total code files, six production files and per-file Chinese-comment floors. Expected incremental comment floors: `parser.worker.ts E<=115 -> C>=18`; `client.ts E<=10 -> C>=2`; actual per-file counts replace estimates at implementation audit.

### R73 Protocol Traceability

| Response shape | Producer | Owner behavior | Existing consumer/test |
| --- | --- | --- | --- |
| `error` present | `ParserWorker.handleOneShotHighlight()` parse/protocol failure response | `TreeSitterClient` rejects the matching callback exactly once; Code cannot enter empty-highlight success rendering | real worker `onmessage/postMessage` seam in `client.test.ts`; Code no-fallback tests |
| `warning` + `hasParser:false`, no error | unsupported filetype capability response | `TreeSitterClient` resolves existing result object; `treeSitterToStyledText()` keeps capability behavior | `client.test.ts` unsupported-filetype contract and styled-text consumers |
| no error/warning | successful one-shot highlight | resolve highlights and continue existing rendering | existing one-shot/Markdown normal-path tests |

R73 production delta is limited to the existing `TreeSitterClient` one-shot response branch and one existing protocol test seam. No new parser, error state, fallback, retry or renderer path is authorized. The incremental delta is expected to remain below 40 effective lines; the full current nested baseline remains subject to production `E <= 600`, total `E <= 800`, eight-file and per-file comment gates.

### R73 Verification Boundary

Run from package directories under the existing external process-tree supervisor:

1. `bun test ./src/lib/tree-sitter/client.test.ts -t "one-shot response error|unsupported filetype warning"` from `thirdparty/opentui/packages/core`.
2. `bun test ./src/renderables/Code.test.ts -t "does not commit plain text|drawUnstyledText=false output"` from `thirdparty/opentui/packages/core`.
3. The R73 normal Markdown focused pattern, `bun run build:lib`, OpenCode SyncProvider test, `bun typecheck`, and compiled `target-liveness` smoke from R72's exact working directories.

The error-shape test is protocol evidence only; normal compiled liveness and supported-domain lifecycle behavior remain the primary no-error feedback loop.

### R72 File Classification

| Classification | Paths | Audit treatment |
| --- | --- | --- |
| Existing approved production baseline | OpenTUI `client.ts`, `parser.worker.ts`, `types.ts`, `Markdown.ts`; root `sync.tsx` | Preserve and reverify owner paths; no new architecture |
| Root-cause protocol repair | OpenTUI `client.ts` one-shot response branch and `Code.ts` one-shot consumer | Error-shaped one-shot response cannot resolve into empty-highlight success rendering; no fallback or retry |
| Existing test contracts | OpenTUI `client.test.ts`, `Markdown.test.ts`, `Code.test.ts` | Add real `ONESHOT_HIGHLIGHT_RESPONSE` error-shape regression and retain normal-path/legacy lifecycle tests; three existing test files, eight nested code files total |
| Original compiled feedback loop | `packages/opencode/script/smoke-opentui-artifact.ts` target-liveness | Required normal-path verification; no production instrumentation |
| Release cleanup | OpenTUI manifests and `bun.lock` | Final tree must match `.6`; release metadata is not part of repair |

### R72 Verification Boundary

Required commands and directories:

| Command | Directory | Contract |
| --- | --- | --- |
| bounded `bun test ./src/lib/tree-sitter/client.test.ts -t "..."` | `thirdparty/opentui/packages/core` | Existing correlated protocol, lifecycle and normal Markdown seams; no new generic error state |
| bounded `bun test ./src/renderables/Code.test.ts -t "..."` | `thirdparty/opentui/packages/core` | One-shot rejection and real response-shape behavior cannot produce success-shaped plain text |
| bounded Markdown focused tests | `thirdparty/opentui/packages/core` | structured/fenced/current-seed normal path |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | TypeScript declarations and worker bundle |
| bounded `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | legal unloaded projection events continue consumption |
| bounded `bun typecheck` | `packages/opencode` | package type contract |
| bounded `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` | `packages/opencode` | Thinking/body, command palette, event/frame liveness, pending readiness, Ctrl+C and zero warning contract |

Every Bun test uses an external process-tree supervisor. A passing test whose process does not exit is a failed verification. The full native `bun run build` remains separately recorded; missing Zig is an environment limitation, not a source bypass.

### R72 Primary Repair Delta

1. In `TreeSitterClient.handleWorkerMessage()` for `ONESHOT_HIGHLIGHT_RESPONSE`, a response carrying `error` or `warning` must reject/complete the existing request as an error rather than resolve an empty successful result. This is the existing correlated response owner, not a new generic error mechanism.
2. In `CodeRenderable.startOneShotHighlight()`, do not treat an error-shaped result as `highlights.length === 0` success; the normal supported path must never produce that result, and the existing no-fallback contract must remain closed.
3. Add one behavior-sensitive test using the existing worker `onmessage/postMessage` seam to deliver a real `ONESHOT_HIGHLIGHT_RESPONSE` with `messageId` and `error`; assert the public one-shot request rejects rather than resolves as a successful highlight result. Keep the existing Code rendering tests for the no-fallback contract.
4. Recompute actual production `E` and total code `E` from the final eight-file nested diff. R72 hard gates are production `E <= 600`, total effective code `E <= 800`, production files `<=6`, total code files `<=8`, and per-file qualifying Chinese comments at the repository policy floor.

### R71 Implementation Evidence

#### Actual Changed Paths

The final nested OpenTUI diff against `origin/smark/main` contains exactly eight code files:

| Path | Classification | Net diff |
| --- | --- | ---: |
| `packages/core/src/lib/tree-sitter/client.ts` | approved lifecycle baseline | `+218/-224` |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | approved Tree owner baseline | `+240/-163` |
| `packages/core/src/lib/tree-sitter/types.ts` | approved correlated protocol baseline | `+16/-7` |
| `packages/core/src/renderables/Code.ts` | baseline pending owner plus R71 fallback removal | `+23/-19` |
| `packages/core/src/renderables/Markdown.ts` | approved current-seed baseline | `+84/-10` |
| `packages/core/src/lib/tree-sitter/client.test.ts` | approved lifecycle regression baseline | `+318/-5` |
| `packages/core/src/renderables/__tests__/Markdown.test.ts` | pending structured/fenced normal-path regression | `+21/-9` |
| `packages/core/src/renderables/Code.test.ts` | R71 replacement of two fallback contracts | `+7/-4` |

The root `SyncProvider` repair is a committed baseline and no R71 root source file was changed. `.7` manifests/lockfile are restored to `.6` and absent from the final net diff; generated/native output is excluded. Exact deletion counts and effective `E/C` must be recomputed by the implementation auditor rather than retained as placeholders.

#### Red-Green Evidence

| Command | Directory | Result |
| --- | --- | --- |
| bounded Code fallback test before production removal: `bun test ./src/renderables/Code.test.ts -t "does not commit plain text when highlighting throws"` | `thirdparty/opentui/packages/core` | red: visible plain text was still installed; 1 failing test |
| bounded Code fallback test before production removal: `bun test ./src/renderables/Code.test.ts -t "keeps failed drawUnstyledText=false output non-successful"` | `thirdparty/opentui/packages/core` | red: visible plain text was still installed; 1 failing test |
| same two Code tests after production removal | `thirdparty/opentui/packages/core` | green: 4 pass and 2 pass respectively, 0 fail; both exited under process supervision |

#### Verification Evidence

| Command | Directory | Result |
| --- | --- | --- |
| bounded `bun test ./src/renderables/__tests__/Markdown.test.ts -t "streaming code blocks with concealCode=true show a seed before conceal highlighting\\|streaming demo-style fenced code block shows a seed before syntax highlighting\\|streaming structured list updates keep previous item text visible while highlighting"` | `thirdparty/opentui/packages/core` | 21 pass, 0 fail; process exited |
| bounded `bun test ./src/renderables/__tests__/Markdown.test.ts -t "streaming.*list\\|pending\\|table"` | `thirdparty/opentui/packages/core` | 61 pass, 95 filtered, 0 fail, 32 snapshots |
| bounded targeted client lifecycle/Markdown tests | `thirdparty/opentui/packages/core` | public lifecycle and current-seed tests passed and exited |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | pass; declarations and worker bundle generated |
| bounded `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | 1 pass, 0 fail |
| bounded `bun typecheck` | `packages/opencode` | pass: `tsgo --noEmit` |
| bounded full `bun run build` | `thirdparty/opentui` | unavailable: native phase requires `zig`, which is not in PATH; `build:lib` is green |
| bounded `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` | `packages/opencode` | pass: `targetEventCount=14`, `sourceCount=2`, `renderedCount=2`, `modelRequests=2`; normal exit and Ctrl+C cancellation path completed |
| `git diff origin/smark/main --check` | `thirdparty/opentui` | pass; eight nested code files and no `.7` release metadata |

The broad client filter that previously printed passing tests while leaving Bun workers alive is not used as a clean result. All listed test commands used an external process-tree supervisor; timeout or non-exit is failure.

#### E/C and Remaining Limits

The implementation audit must independently calculate actual per-file `E/C`, excluded pure moves/deletions/generated lines, and the 15% minimum. The plan's hard limits are six production files, eight total code files and `E <= 300` for the current approved route. The full native build remains unavailable because `zig` is not in PATH; the current compiled target-liveness artifact smoke is nevertheless available and passed.

### R71 Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R71 | R71 | pending | pending | pending | pending | pending |

### R71 File Classification

| Classification | Paths | Audit treatment |
| --- | --- | --- |
| Existing approved production baseline | `packages/opencode/src/cli/cmd/tui/context/sync.tsx`; OpenTUI `client.ts`, `parser.worker.ts`, `types.ts`, `Code.ts` pending-seed owner; `Markdown.ts` fenced seed | Preserve and audit; no new owner architecture |
| Root-cause production repair | OpenTUI `Code.ts` streaming and one-shot failure consumers | Remove failure-to-plain-text success conversion; normal valid paths must not reach this error branch |
| Behavioral regressions | OpenTUI `client.test.ts`, `renderables/__tests__/Markdown.test.ts`, `renderables/Code.test.ts`; existing SyncProvider regression | Replace the two contradictory fallback assertions; retain normal lifecycle/representation tests; total nested code-file cap is eight |
| Original compiled feedback loop | Existing `packages/opencode/script/smoke-opentui-artifact.ts` target-liveness scenario | Verification-only; no production smoke instrumentation or alternate runtime path |
| Unauthorised release preparation | OpenTUI workspace `package.json` manifests and `bun.lock` at `0.4.3-smark.7` | Restore the final tree to the `.6` baseline; exclude from the repair diff and do not publish |
| Generated/native output | OpenTUI `dist/**` and native build output | Not source evidence; never commit as repair output |

### R71 Verification Boundary

`bun run build:lib` is the applicable OpenTUI build for this TypeScript-only correction and must pass. The full OpenTUI `bun run build` additionally invokes native Zig compilation; if `zig` is unavailable, record that environment limitation separately without changing source or bypassing the native gate. Every client test command must run under an external process-tree supervisor; a passing test whose Bun process remains alive is a failed verification. R67 must rerun the two updated fenced/structured tests, the related Markdown pattern, lifecycle baseline, `build:lib`, SyncProvider regression, package typecheck, and the original compiled smoke under its external process-tree supervisor:

```text
bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness
```

The smoke must report Thinking/body visibility, command-palette transition/restoration, continued daemon event/frame advancement, worker pending readiness, Ctrl+C shutdown and zero cancellation/highlight warnings. A missing current artifact or a smoke timeout is an unverified implementation, not a green skip.

R71 requires the original compiled `target-liveness` smoke as the primary feedback loop, plus normal supported-domain lifecycle/Markdown tests, Code fallback-contract tests, `build:lib`, SyncProvider regression and package typecheck. The smoke must show Thinking/body visibility, command-palette restoration, continued daemon/frame advancement, pending worker readiness, Ctrl+C shutdown and zero cancellation/highlight warnings. Missing artifact or timeout is unverified, not a green skip. Existing correlated-error tests remain protocol regression evidence; Code.test only replaces the two contradictory fallback assertions and does not create a new recovery mechanism.

### R71 Primary Repair Delta

R71 repairs the primary path and removes a success-shaped symptom path:

1. In `CodeRenderable.runStreamingLoop()` remove the failure catch's `textBuffer.setText(content)` and `commitStreamingVisible()` success conversion. Do not add a replacement failure state machine or retry; the normal path is repaired upstream by the approved client/worker/seed owners, and valid supported input must not reach this branch.
2. In `CodeRenderable.startOneShotHighlight()` remove the failure catch's plain-text success conversion for the same reason; preserve only the existing state cleanup needed to avoid leaving the renderable in an in-flight state.
3. Replace `Code.test.ts:269-298` and `Code.test.ts:902-930` fallback assertions with public rendering assertions that the rejected highlight completes without committing a new success-shaped plain-text frame; preserve `highlightingDone` completion and existing error detection. These are corrections to existing tests, not new failure-state delivery.
4. Do not add a new synthetic error mechanism, retry, alternate parser, renderer restart, catch-and-success path or extra error state. Normal compiled target-liveness remains the primary root-cause feedback loop.

### R71 Plan Audit Record

### R71 Traceability and Budget

| Requirement / invariant | Owner and change | Public verification |
| --- | --- | --- |
| R61-INV-04 current Markdown visibility with `drawUnstyledText=false` | `Code.ts` pending representation commit plus `Markdown.ts` false flag/seed contract | `Markdown.test.ts` persistent update held before mock response |
| R61-INV-06 no fallback or diagnostic expansion | same existing streaming path; no new catch or alternate renderer | source diff/path audit and focused client/Markdown tests |
| No unrelated release mutation | package manifests/lockfile restored to `.6` | exact nested diff against `origin/smark/main` has no release metadata paths |

R71 adds no new error mechanism or success path; its production delta is limited to removing two existing fallback commits in `Code.ts`, while three existing test files are modified to replace contradictory fallback contracts. The nested OpenTUI diff remains exactly eight code files: five production owners and three tests; the root SyncProvider remains a committed baseline. The actual implementation audit must recalculate `E/C`.

The release-cleanup paths are exactly: `bun.lock`, `packages/core/package.json`, `packages/examples/package.json`, `packages/keymap/package.json`, `packages/qrcode/package.json`, `packages/react/package.json`, `packages/solid/package.json`, `packages/ssh/package.json`, `packages/three/package.json`, and `packages/web/package.json`. Their final content must match the `.6` consumer baseline.

### R67 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R62 | R62 | yes | B-01 Markdown pending representation contradicts `drawUnstyledText=false`; B-02 request-seam target already implemented; B-03 unrelated `.7` release metadata in repair scope | stale archive material; SyncProvider count precision; comment-budget inconsistency; candidate-failure seam precision | BLOCK | `ses_01f2f8d39ffe8ut8f6xhDeEDLV` |
| R63 | R63 | yes | No blocking findings | NB-01 archive size; NB-02 baseline/new-file classification; NB-03 build command distinction; NB-04 release-cleanup path precision; NB-05 actual E/C required at implementation audit | APPROVE, invalidated by R64 scope correction | `ses_01f255bb7ffeWp9ntqHrM0XHyP` |
| R64 | R64 | yes | B-01 fenced-code owner call sites not explicit in plan | NB-01 baseline classification; NB-02 exact test location; NB-03 inherited traceability navigation; NB-04 build boundary | BLOCK | `ses_01f0e3ac1ffeZbK3WOqIhHxBbK` |
| R65 | R65 | yes | No blocking findings | NB-01 archive boundary; NB-02 minor numbering/history drift; NB-03 conditional fenced seed; NB-04 inherited baseline verification matrix; NB-05 actual E/C required at implementation audit | APPROVE, invalidated by R66 test-contract correction | `ses_01f0858d6ffeHKlMvz2NlBkVrb` |
| R66 | R66 | yes | B-01 original compiled target-liveness feedback loop omitted from verification boundary | NB-01 baseline/test classification; NB-02 test-only E/C estimate; NB-03 archive size | BLOCK | `ses_01eff359effeBLBfRDGjY6yA5j` |
| R67 | R67 | yes | B-01 preserved failure-to-plain-text success fallback violates original no-fallback contract | NB-01 duplicate build instructions; NB-02 client-test classification; NB-03 two seed call sites; NB-04 E excludes tests; NB-05 archive size | BLOCK | `ses_01efaa5f2ffepf0Udir1GYwcXP` |
| R68 | R68 | pending | invalidated by user's explicit correction: failure terminal/diagnostic is not the repair goal; normal supported paths must stop producing the error | - | not audited | not applicable |
| R69 | R69 | yes | B-01 complete verbatim original requirement is not preserved in current authoritative sections | NB-01 exact catch cleanup semantics; NB-02 exact verification commands; NB-03 archived budget ambiguity | BLOCK | `ses_01eea2ec7ffeTyWs2haeCSGl2H` |
| R70 | R70 | yes | B-01 Code fallback removal had no authorized behavior-sensitive test path and contradicted existing Code tests | NB-01 inherited baseline navigation; NB-02 exact verification commands; NB-03 effective scope classification; NB-04 archive size; NB-05 E/C estimate | BLOCK | `ses_01ee40747ffeMuWDcmaUISj8Xl` |
| R71 | R71 | yes | No blocking findings | NB-01 archive navigation; NB-02 verification wording drift; NB-03 baseline/new-delta boundary; NB-04 inherited traceability; NB-05 actual E/C required at implementation audit | APPROVE | `ses_01eddab16ffesVyAS1QxpQbguv` |
| R72 | R72 | yes | B-01 warning semantics contradictory: warning must remain capability result while error must reject | NB-01 non-concrete filters; NB-02 artifact freshness; NB-03 archive size; NB-04 missing incremental estimate | BLOCK | `ses_01ebe2197ffeBUAUWjdslt4Nll` |
| R73 | R73 | yes | B-01 full original scope not authoritative; B-02 downstream one-shot reject does not repair producer-side no-error invariant | NB-01 test seam precision; NB-02 inherited verification references; NB-03 incremental budget wording | BLOCK | `ses_01eb4844effeXZDYu3iNqmoYuM` |
| R74 | R74 | yes | B-01 `highlightOnce()` initialization failure returns `{error}` and still reaches Code's empty-highlight success path | NB-01 missing R74 per-file E/C estimate; NB-02 archive/navigation noise; NB-03 exact test seam; NB-04 `.7` cleanup state | BLOCK | `ses_01ea19c05ffecAKWS68KGqwa6f` |
| R75 | R75 | yes | B-01 prescribed verification filter did not select the existing normal supported one-shot and unsupported-warning tests | NB-01 incremental E/C estimate; NB-02 exact R75 file table | BLOCK | `ses_01e91d82dffeAewbvR75ltqWAV` |
| R76 | R76 | yes | B-01 plan still treated producer initialization/parse errors as acceptable reachable outcomes and only repaired downstream rejection | NB-01 current authority not fully self-contained; NB-02 initialization fixture seam not concrete | BLOCK | `ses_01e865aa4ffeINr2qFHLPix822` |
| R77 | R77 | yes | B-01 reusable-parser tail covered one-shot but not streaming/reference/injection consumers; B-02 exact current file/test contract was incomplete | NB-01 stale archive budget arithmetic; NB-02 future test-name anchoring; NB-03 per-file E/C estimate | BLOCK | `ses_01e6bda58ffesKRcAHH8Ab5gdk` |
| R78 | R78 | yes | B-01 `processInjections()` catch still converted parse/query failure to partial success; B-02 tail interface, nesting, invalidation order and public red fixture were not executable | NB-01 archive navigation; NB-02 current E/C estimate; NB-03 indirect R74 verification references | BLOCK | `ses_01e624b07ffeqBqVFGcPReklgy` |
| R79 | R79 | yes | B-01 shared `filetypeParsers/filetypeParserPromises` remained outside the tail through `handleInitializeParser`, allowing stale promise resurrection after registration/clear | NB-01 unsupported injection classification; NB-02 real failed-injection fixture detail; NB-03 aggregate E arithmetic; NB-04 SyncProvider test mapping | BLOCK | `ses_01e58e166ffehX3fA6wDrQpsm5` |
| R80 | R80 | yes | B-01 one-shot released parser-asset scope before asynchronous injection; B-02 ordinary `HANDLE_EDITS` remained outside the shared parser-asset scope | NB-01 historical archive/budget drift; NB-02 fixture path precision | BLOCK | `ses_01e4f95cdffe2uVAtWo3CW79HV` |
| R81 | R81 | yes | No blocking findings | NB-01 `UPDATE_DATA_PATH` is existing public/test compatibility; NB-02 scope numbering drift; NB-03 archive navigation; NB-04 E/C estimates require implementation recount | APPROVE | `ses_01e443d73ffedNAJf0czJAYIYv` |

R62's exact independent verdict was **BLOCK**: the plan could not proceed until the Markdown pending-representation owner is specified, the already-green request-seam item is removed as a no-op target, and release/version/lockfile material is removed from this repair's implementation boundary.

R71 implementation audit returned **BLOCK** with:

- **B-01:** one-shot `ONESHOT_HIGHLIGHT_RESPONSE` error resolves as an empty result and still reaches Code's plain-text success branch; a real response-shape regression is required.
- **B-02:** actual full nested effective `E=744` exceeds R71's stale `E<=300` promise; R72 replaces that intermediate promise with the user-backed production `<=600` and total effective `<=800` gates.

R72 plan audit returned **BLOCK** because its one-shot response contract simultaneously classified `warning` as rejectable error and as an existing resolved capability result. R73 makes `error`, `warning + hasParser:false`, and successful highlights three distinct response outcomes.

R73 plan audit returned **BLOCK** because it did not restate complete liveness/Tree/Markdown/shutdown traceability in current authority and treated downstream one-shot rejection as sufficient for a producer-side no-error requirement. R74 carries the six invariants directly and classifies `parse()->null` as an abnormal error signal that must not be mistaken for a normal-path fix.

R74 plan audit returned **BLOCK** because `highlightOnce()` initialization rejection still returns `{error}` and allows Code's empty-highlight success branch. R75 must propagate initialization rejection through the existing Promise contract and test that public behavior.

R75 plan audit returned **BLOCK** because its prescribed one-shot filter did not select the existing normal supported and unsupported-warning test names. R76 corrected the selector, but its downstream-only error classification was then rejected as insufficient producer-side root-cause repair.

R76 plan audit returned **BLOCK** because it retained the producer paths that can invalidate or fail a reusable Parser while an asynchronous one-shot operation still owns it. R77 assigns that first divergence to `ParserWorker`'s canonical-filetype reusable-parser owner tail and keeps client rejection only as correlated protocol settlement.

R77 plan audit returned **BLOCK** because its reusable-parser tail covered only one-shot/preload while `processInjections()`, `updateReferenceState()`, streaming/reset and `clearCache()` remained reachable consumers or invalidators. R78 routes all those operations through one owner tail and enumerates the exact five production and three test files.

R78 plan audit returned **BLOCK** because `processInjections()` still caught parse/query exceptions and returned partial success, and because the proposed tail lacked an executable non-reentrant interface and deterministic public settlement fixture. R79 removes that catch-and-success path and specifies every entry, exit, nesting and barrier rule.

R79 plan audit returned **BLOCK** because `handleInitializeParser()` still resolved shared filetype parser cache outside the owner tail, allowing registration/clear to invalidate a promise and later resurrect its stale result. R80 expands the single `withParserAssets` scope to all filetype cache and Parser operations, including buffer initialization.

R80 plan audit returned **BLOCK** because one-shot released the parser-asset scope before asynchronous injection completion and ordinary `HANDLE_EDITS` still accessed shared reusable parsers outside the scope. R81 holds one scope through complete one-shot injection/response preparation and adds `HANDLE_EDITS` to the same owner/test contract.

#### R63 Independent Plan Audit Verdict (verbatim)

No blocking findings.

#### R63 Non-blocking Findings (verbatim classifications)

- **NB-01:** R63 authority boundary is clear, but the archive remains large; implementation must use only the R63 authority sections.
- **NB-02:** R63 production-file classification is broader than its effective runtime delta; baseline files are explicitly marked above.
- **NB-03:** Verification distinguishes `bun run build:lib` from the complete native `bun run build`; both results must be recorded.
- **NB-04:** R63 now enumerates every release-cleanup path.
- **NB-05:** The implementation audit must independently recalculate actual `E/C` and the 15% ratio.

R63 implementation audit returned **BLOCK** with:

- **B-01:** the pending-frame test did not assert the updated literal before settlement;
- **B-02:** streaming fenced code had no current seed and remained blank with `drawUnstyledText=false`.

R64 plan audit returned **BLOCK** because the fenced-code seed requirement was not explicitly mapped to `createCodeRenderable()` and `applyCodeBlockRenderable()` with a failing public test seam. R65 adds those exact producer/consumer paths and assertions.

R65 implementation audit returned **BLOCK** because the new producer path made two existing pending-flicker assertions stale, and the structured test did not assert the updated literal before settle. R66 corrected only those stale test expectations.

R66 plan audit returned **BLOCK** because the original compiled target-liveness feedback loop was not a required R66 verification. R67 restored the existing smoke command and its user-visible assertions without adding runtime instrumentation.

R67 plan audit returned **BLOCK** because the preserved `CodeRenderable` catch converted a failed Tree-sitter primary request into visible plain-text success. R68 removed that success conversion directionally, then R70 restates the causal no-error goal and complete user contract before implementation authorization.

#### R71 Independent Plan Audit Verdict (verbatim)

No blocking findings.

#### R71 Non-blocking Findings (verbatim classifications)

- **NB-01:** Canonical authority and historical archive remain a navigation risk; implementation must use only R71 current authority.
- **NB-02:** Verification wording has a stale R67 label and repeated build/smoke descriptions; the command requirements remain unchanged.
- **NB-03:** Baseline files and R71 actual fallback/test delta must remain separate in implementation evidence.
- **NB-04:** R71 must reverify all inherited SyncProvider, Tree ownership, shutdown and compiled-liveness paths, not only Code fallback tests.
- **NB-05:** Actual implementation `E/C` must be independently recalculated.

R68 was superseded before audit by the user's explicit correction that the goal is not to preserve failure handling, but to repair supported-domain ownership so the failure path is not reached. R69 was blocked because its current authority did not include the complete verbatim requirement. R70 restores that contract and makes normal-path no-error evidence authoritative.

#### R65 Independent Plan Audit Verdict (verbatim)

No blocking findings.

#### R65 Non-blocking Findings (verbatim classifications)

- **NB-01:** R65 authority boundary depends on the top-level statement because the archive remains large.
- **NB-02:** R65 had minor numbering and historical-reference drift; current authority now uses R65 labels.
- **NB-03:** fenced-code seed must remain conditional so non-streaming behavior is unchanged.
- **NB-04:** inherited SyncProvider, Tree-sitter, shutdown and compiled-liveness verification must be rerun during implementation verification.
- **NB-05:** actual implementation `E/C` must be recomputed independently.

### R65 Forward and Reverse Traceability

| Requirement / invariant | Producer -> consumer -> owner | Exact implementation/test path |
| --- | --- | --- |
| R61-INV-04 structured token pending visibility | Markdown structured token -> `applyMarkdownCodeRenderable` -> `CodeRenderable.content`/pending TextBuffer | `Markdown.test.ts` `streaming structured list updates keep previous item text visible while highlighting`, new literal assertions before `resolveAllStreamingUpdates()` |
| R61-INV-04 fenced token pending visibility | `Tokens.Code.text` -> `createCodeRenderable` or `applyCodeBlockRenderable` -> `CodeRenderable.initialStyledText` -> pending TextBuffer | `Markdown.ts:976-990,1048-1060`; `Markdown.test.ts` `streaming demo-style fenced code block does not flicker unhighlighted`, assertions before `resolveAllHighlightOnce()` |
| `drawUnstyledText=false` invariant | Markdown caller controls option; Code owns seed commit | both public tests assert false; no error/fallback branch |

Reverse mapping: `createFencedCodeSeed(token.text)` is necessary because fenced `Tokens.Code` has a different representation contract from inline Markdown tokens; reusing inline tokenization could reinterpret code punctuation and cannot guarantee exact `CodeRenderable.content` text. The existing Code owner already provides the one pending TextBuffer commit, so no second renderer path is justified.

### R63 Implementation Evidence

#### Actual Changed Paths

The final nested tree compared with `origin/smark/main` contains exactly seven code files and no release metadata paths:

| Path | Classification | Net diff |
| --- | --- | ---: |
| `packages/core/src/lib/tree-sitter/client.test.ts` | public lifecycle regression | `+313/-5` |
| `packages/core/src/lib/tree-sitter/client.ts` | approved lifecycle owner plus verified request seam | `+218/-224` |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | accepted Tree owner | `+240/-163` |
| `packages/core/src/lib/tree-sitter/types.ts` | correlated response contract | `+16/-7` |
| `packages/core/src/renderables/Code.ts` | R63 pending representation owner | `+22/-12` |
| `packages/core/src/renderables/Markdown.ts` | current seed and `drawUnstyledText=false` contract | `+78/-10` |
| `packages/core/src/renderables/__tests__/Markdown.test.ts` | R63 red-green pending-frame assertion | `+5/-1` |

Root `SyncProvider` is an already committed R61 baseline owner repair and has no new R63 worktree diff. The nested `.7` manifests and `bun.lock` were restored to the `.6` consumer baseline and are absent from the final net diff. Generated `dist/**` and native output are excluded.

#### Red-Green Evidence

| Command | Directory | Result |
| --- | --- | --- |
| `bun test ./src/renderables/__tests__/Markdown.test.ts -t "streaming structured list updates keep previous item text visible while highlighting"` before the R63 production edit | `thirdparty/opentui/packages/core` | red: `Received: true` for `drawUnstyledText === false`; 20 pass, 1 fail |
| same command after the R63 production edit | `thirdparty/opentui/packages/core` | green: 21 pass, 0 fail, 113 expect calls; exited under 60-second process supervisor |

#### Verification Evidence

| Command | Directory | Result |
| --- | --- | --- |
| bounded `bun test ./src/renderables/__tests__/Markdown.test.ts -t "streaming.*list\\|pending\\|table"` | `thirdparty/opentui/packages/core` | 61 pass, 95 filtered, 0 fail, 32 snapshots; process exited |
| bounded targeted `client.test.ts` cancellation/error/dispose slices | `thirdparty/opentui/packages/core` | each public slice passed and exited; no unbounded full client suite was used |
| `bun run build:lib` | `thirdparty/opentui/packages/core` | pass; declarations and worker bundle generated |
| bounded `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | 1 pass, 0 fail; process exited |
| bounded `bun typecheck` | `packages/opencode` | pass: `tsgo --noEmit` |
| `git diff origin/smark/main --check` | `thirdparty/opentui` | pass; final net diff has seven code files and no `.7` release metadata |
| bounded full `bun run build` | `thirdparty/opentui` | unavailable: native phase requires `zig`, which is not in PATH; no TypeScript failure was inferred from this environment limitation |

Every Bun test was run under an external process-tree supervisor. A prior broad client filter printed passing tests but left Bun worker processes alive; those processes were terminated/verified absent, and that broad command is not treated as a clean verification result.

#### Preliminary E/C Gate

The pre-audit production count is `E <= 282`, below the R63 `E <= 300` ceiling. Existing qualifying Chinese comments in the approved lifecycle files plus the new adjacent pending-representation explanation are estimated at `C >= 95`; the implementation auditor must independently recalculate per-file `E_i/C_i`, excluded pure moves/deletions, and the 15% minimum. The new test assertion has an adjacent Chinese explanation and no production test control.

#### Remaining Verification Limits

The complete native build and a newly compiled OpenCode Windows artifact smoke are not verified in this environment because `zig` is unavailable and the root consumer remains on the published `.6` package baseline. This does not authorize a native/source workaround; it remains an explicit audit risk.

## R61 Current Authority

R61由用户对R60实施方向的明确纠正触发：

> 同时禁止大幅度增加额外的error的判断与handle机制，根源性修复应当是修正错误的机制使得任何可能的不稳定error根本不会产生

R61保留原始范围中的两个独立第一分歧，但删除R60中把诊断、取消和测试控制面扩展成生产状态机的部分。R61只允许一个主路径：修复合法事件投影的所有权、修复同一Tree的操作顺序和WASM owner转移、修复当前Markdown表示的提交时机；不增加重试、watchdog、renderer restart、常开plain-text、通用catch恢复或第二事件源。

### 1. Verbatim Requirement

R61继承本文R60第1节的完整原始需求，并追加本轮用户原文：

> 同时禁止大幅度增加额外的error的判断与handle机制，根源性修复应当是修正错误的机制使得任何可能的不稳定error根本不会产生

不得把“避免挂起”改写成“发生错误后继续显示”。受支持输入的主路径必须在正确的owner和顺序下完成；仅为不可避免的进程销毁建立终态，不制造成功替代品。

### 2. Explicit Non-Goals

- 不发布当前本地的`0.4.3-smark.7`元数据提交；它只是在源代码路线未重新批准前的未推送准备提交。
- 不把上游版本字符串直接从`0.4.3`改成`0.5.1`。上游`v0.5.1`是研究证据，不是本次兼容升级授权；真正的上游rebase需要单独的API、asset和行为审计。
- 不把R60的所有相关请求都改成新的全局Promise状态机；普通edit/reset保持现有接口合同，只在确有owner顺序要求的streaming/dispose边界做最小改动。
- 不在Code层新增parser重试、异常后换parser、错误后合成成功结果或常驻纯文本显示。
- 不修改daemon事件扇出、SDK/SSE重连、SessionStatus registry、renderer调度器、native buffer ABI、数据库、生成SDK或命令面板状态机。
- 不用生产计时、日志标记、ready文件或错误计数作为运行时恢复机制；测试控制面不得进入production bundle。

### 3. Repository Context

| Source | Why it constrains R61 |
| --- | --- |
| `CONTEXT.md` | Project事件可包含多个Session；TUI本地projection不等于daemon事实；Session/Message/Part是当前领域术语。 |
| `AGENTS.md` | 最小修改、避免不必要抽象；测试从package目录运行。 |
| `thirdparty/opentui/AGENTS.md` | 使用Bun；TUI问题必须在真实可达seam复现，不能凭猜测添加错误处理。 |
| `packages/opencode/AGENTS.md`及`packages/opencode/test/AGENTS.md` | SyncProvider拥有本地projection；并发测试使用published readiness，不用固定sleep。 |
| `.opencode/policy/first-principles-engineering.md` | 修复第一分歧；禁止fallback和责任泄漏；diagnostic decision surface不超过10%。 |
| `.opencode/templates/canonical-plan.md` | 维持单一canonical plan、forward/reverse traceability和独立全范围审计。 |
| `docs/adr/README.md`、`docs/adr/0001-*.md` | 没有适用于TUI/Tree-sitter的ADR；triage ADR不构成运行时设计授权。 |

### 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `thirdparty/opentui` commit `61023ba5e` | 引入persistent-tree streaming主路径，并移除原有one-shot/queue主路径。 | observed |
| `thirdparty/opentui` commit `61023ba5e^` / `df4bd31ca` | 提供改动前的可比较主路径：每buffer edit queue、独立one-shot worker、无persistent streaming owner。 | observed |
| `thirdparty/opentui` commit `80a46c4d4` | 当前R60实现把candidate ownership、buffer tail和大量correlated error处理一起引入。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts` | `Code -> client -> worker`的streaming mutation、dispose和destroy调用链。 | reachable |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` | parser-owned Tree的parse/query/replace/dispose owner。 | reachable |
| `packages/core/src/lib/tree-sitter/types.ts` | worker wire request/response边界。 | contracted |
| `packages/core/src/renderables/Code.ts`、`Markdown.ts` | pending frame的当前表示、streaming Code生命周期和shutdown warning owner。 | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | 合法同Project事件对未加载Session projection的第一分歧。 | observed/reachable |
| 历史`61023`差分复现 | `STREAMING_UPDATE`未settle时已发送`DISPOSE_BUFFER`且本地buffer已删除。 | observed |
| 当前`80a`差分复现 | 同一场景下dispose不早于update终态，ack前仍保留buffer。 | observed |
| upstream `anomalyco/opentui` `v0.4.3`至`v0.5.1` release/compare | `v0.5.1`仍采用queue/one-shot Tree-sitter路线；上游release notes未显示persistent streaming修复。 | observed |
| 用户提供的Windows日志/截图 | 在途highlight导致正文空白，Ctrl+C销毁时产生批量warning；daemon仍可继续运行。 | observed |

### 5. Current Producer-to-Consumer Behavior

```text
daemon Message/Part event
  -> GlobalEvent SSE
  -> SDK event queue
  -> SyncProvider reducer
  -> local Message/Part projection
  -> Markdown/Code renderable
  -> TreeSitterClient mutation
  -> ParserWorker persistent Tree
```

存在两个已证实的owner断裂：

1. 同Project事件属于未加载Session时，SyncProvider把不存在的本地collection交给`Binary.search`，subscriber在TUI侧抛错，之后daemon仍运行但TUI不再消费后续事件。
2. `61023ba5e`的streaming主路径允许同一buffer的mutation与dispose交叉。历史复现显示dispose先到且本地mirror先删；worker随后可能访问已释放或已替换的Tree。R60的candidate/tail修改证明了正确顺序，但其实现还夹带了大量不必要的error/cancellation分支。

### 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 同Project但未加载Session的hidden/remove Message事件 | daemon Bus / Session producer | event schema合法；本地store只加载当前route所需Session | SSE -> SyncProvider | SyncProvider local projection | observed/reachable |
| 同Message但未加载Part的remove事件 | daemon Part producer | MessageID/PartID合法 | SSE -> SyncProvider | SyncProvider local projection | observed/reachable |
| 当前Markdown Code的首个或后续streaming token | Markdown parser | token/raw与Code content同一更新 | Markdown -> Code | Markdown representation seam | observed/reachable |
| 同buffer尚未完成的streaming mutation后发生destroy/remove | Code destroy/filetype/client lifecycle | renderable销毁可在worker响应前发生 | Code -> client -> worker | client buffer owner | observed/reachable |
| persistent Tree parse/query期间的candidate替换 | ParserWorker | 一个buffer只有一个accepted Tree owner | client request -> worker | ParserWorker WASM owner | reachable |
| 上游`v0.5.1`与本地`0.4.3-smark.*`的API/package差异 | release producer | 仅有远端tag，不代表本地fork兼容 | package/release closure | release process | observed, out of scope |

### 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| R61-INV-01 | 合法Project事件即使对应未加载Session，也不能终止SyncProvider的后续事件消费。 | historical hidden-event red harness | `sync-undefined-messages.test.tsx` |
| R61-INV-02 | 一个buffer的mutation完成前，dispose不能触碰其accepted Tree或删除本地owner；dispose只在真实worker ack后完成。 | historical/current dispose differential | current `client.test.ts` lifecycle seam |
| R61-INV-03 | parser只能在完整parse/query结果准备好后转移accepted Tree ownership；失败candidate不能改变下一次更新的输入。 | parser worker ownership contract | current lifecycle tests; new failure-then-success slice |
| R61-INV-04 | 当前Markdown token在异步highlight等待期间仍有同一token/raw的可见表示，且不需要把`drawUnstyledText`改为常开。 | blank screenshot + Code/Markdown path | current Markdown pending-frame tests |
| R61-INV-05 | 正常renderable销毁不打印Tree-sitter cancellation warning；真正的live failure不能被伪装成成功。 | shutdown trace + renderer destruction order | bounded shutdown test |
| R61-INV-06 | production新增diagnostic/error decision surface不超过变更决策面的10%，且新增alternate success path为零。 | user requirement + policy | diff audit |

### 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| R61-INV-01 | hidden `message.updated`及remove分支把缺失collection传给`Binary.search`。 | `SyncProvider` local projection | 已运行的hidden-event red harness产生`array.length` TypeError。 |
| R61-INV-02 | `61023ba5e`的`removeBuffer`在streaming mutation没有终态时立即删除mirror并发送dispose；历史复现输出`disposeSentBeforeUpdateSettlement=true`。 | `TreeSitterClient` buffer lifecycle | 同一脚本在`61023`红、`80a`绿。 |
| R61-INV-03 | `61023`的`handleStreamingUpdate`在query/injection完成前直接改写accepted `parserState.tree/content`，并且替换Tree没有统一释放旧owner。 | `ParserWorker` accepted Tree owner | 代码差分及WASM Tree显式delete合同；这是状态/ownership断裂，不是错误日志问题。 |
| R61-INV-04 | Markdown Code创建/更新时未统一提供current seed，而Code streaming路径在等待时不提交当前表示。 | `MarkdownRenderable` -> `CodeRenderable` representation seam | 用户正文空白截图；R60新增的分散seed测试只证明症状，不证明需要整套error状态机。 |
| R61-INV-05 | Code catch先进入warning，再判断renderable是否已经销毁。 | `CodeRenderable` shutdown observer | renderer先销毁renderable、后销毁全局client的既有顺序和退出日志。 |

Bug feedback loop already run:

```text
历史版本 cwd: D:\Temp\opencode\opentui-61023-repro-99c4e02e94d94459a807c935dbc1257b
command: bun -e '<public TreeSitterClient; hold STREAMING_UPDATE; call removeStreamingBuffer concurrently>'
result: {"updateSent":true,"disposeSentBeforeUpdateSettlement":true,"bufferStillPresent":false}

当前版本 cwd: thirdparty/opentui
same command
result: {"updateSent":true,"disposeSentBeforeUpdateSettlement":false,"bufferStillPresent":true}
        {"disposeSentAfterUpdateSettlement":true,"bufferStillPresentBeforeAck":true}
```

该差分loop锁定的是owner顺序病因；它不把“错误发生后如何继续”当作修复目标。

### 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 未加载对象的本地projection | SyncProvider | daemon事实可以没有本地行；projection按加载集合表达 | 只有SyncProvider知道collection是否存在 | SSE/SDK不知道TUI本地加载域，不能过滤合法事件 |
| mutation/dispose顺序 | TreeSitterClient buffer lifecycle | 一个公开buffer操作序列只有一个owner尾部 | client同时拥有本地mirror和worker请求顺序 | Code不应管理WASM Tree或跨调用者竞态 |
| accepted Tree转移和WASM释放 | ParserWorker | worker拥有Tree并在commit/dispose时释放 | Tree对象只存在worker内 | client无法安全delete worker-owned WASM object |
| current Markdown表示 | MarkdownRenderable | token/raw转换为Code输入并在异步期间保持可见 | token结构和样式seed只在Markdown层可得 | parser只返回highlight，不能重建UI token |
| shutdown warning观察 | CodeRenderable | 已销毁renderable不再报告正常取消 | Code知道自己的destroyed状态 | worker不能判断终端UI生命周期 |

### 10. Single Approved Primary-Path Design

```text
valid event -> SyncProvider local-collection projection
current token -> one Markdown seed -> one Code streaming request
buffer mutation -> one client operation tail -> candidate parse/query -> one accepted Tree commit -> acked dispose
```

具体设计：

1. 覆盖四个受影响的SyncProvider collection ownership情况：hidden/updated Message、removed Message、hidden Part和removed Part；其中hidden Part已有正确no-op guard，本轮只补其余三个缺失边界。缺失本地对象是projection no-op，不是异常恢复。
2. 将R60当前`bufferOperations`收敛为已有buffer queue/单一tail的最小形式；mutation和dispose共享同一尾部，dispose不得绕过未完成mutation。不得再引入全局request状态机或每种错误的独立分支。
3. 在ParserWorker中只做candidate ownership修复：使用candidate Tree完成edit/parse/query/injection后一次性安装accepted state；成功时释放旧Tree和scratch，失败时只释放candidate，保留旧accepted state。不得用catch把失败转成空highlights或plain-text成功。
4. 对streaming/one-shot请求保留现有correlated terminal response所需的最小`messageId`；它只保证协议不悬挂，不生成成功结果。普通edit/reset不扩大为新的错误状态机。worker异常仍是失败，不被Code层吞成新的成功路径。
5. 将Markdown seed集中在`createMarkdownCodeRenderable`和`applyMarkdownCodeRenderable`的当前content/token seam；保持`drawUnstyledText=false`合同，不在失败后切换渲染算法。
6. 将Code的destroyed检查置于既有warning之前；删除R60新增的typed cancellation分支和重复warning分类，正常销毁由既有renderable生命周期拥有，live failure仍按既有合同暴露。

R61不是“主路径失败后换一条路径”：只有一条persistent streaming主路径；candidate和seed是该路径的内部所有权/表示步骤。上游`v0.5.1`的旧queue/one-shot实现只作为第一分歧的对照证据，不在本轮以版本字符串替换本地fork。

### 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| SyncProvider missing-collection no-op | proposed | primary-contract branch | no, projection no-op | primary | preserve |
| client per-buffer mutation/dispose tail | proposed | primary ownership contract | yes, same operation | primary | preserve |
| candidate Tree before accepted commit | proposed | primary ownership step | yes, same parse result | primary | preserve |
| current Markdown seed while request pending | proposed | primary representation step | yes, current token representation | primary | preserve |
| existing live-error plain-text compatibility | current shipped | existing compatibility | yes, only after genuine failure | existing | preserve without expansion |
| R60 typed destroy classification / broad callback rejection | current R60 | diagnostic expansion | no | excessive relative to R61 | remove/collapse |
| retry, watchdog, renderer restart, alternate parser, SDK catch-and-resume | proposed in prior drafts | forbidden fallback | yes | rejected | remove |

New alternate success paths: zero. New diagnostic surface is limited to the pre-existing warning ordering check and the minimum correlated terminal protocol; estimate below must remain within policy's10% ceiling.

### 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why R61 supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| R60 broad all-request Promise/cancellation branches | compensated for a wider-than-needed protocol rewrite | owner tail and candidate transaction repair the actual race at its owner | `client.ts`, `types.ts`, related R60 tests |
| R60 per-callsite Markdown seed duplication | repeated downstream patches for one representation contract | central current-seed seam carries one representation rule | `Markdown.ts` |
| R60 typed destroy warning branch | classified a symptom after destruction | destroyed check belongs before existing diagnostic branch | `Code.ts` |
| any renderer/SDK recovery workaround | tried to keep consuming after a producer/consumer invariant broke | SyncProvider and Tree owner invariants are repaired directly | do not retain |

### 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R61-INV-01 | missing local collection projection | `packages/opencode/src/cli/cmd/tui/context/sync.tsx` four affected cases, with three missing guards added and the existing hidden-Part guard preserved | hidden/remove events followed by loaded event |
| R61-INV-02 | single buffer mutation/dispose tail | `thirdparty/opentui/.../client.ts` | public concurrent update/remove race |
| R61-INV-03 | candidate Tree commit/disposal | `thirdparty/opentui/.../parser.worker.ts` | failed candidate followed by successful update/reset |
| R61-INV-04 | centralized current seed | `thirdparty/opentui/.../Markdown.ts` | list/blockquote/table/body pending frame |
| R61-INV-05 | destroyed check before warning | `thirdparty/opentui/.../Code.ts` | pending request plus normal renderer destroy |
| R61-INV-06 | no new fallback/diagnostic budget | all changed production files | diff/path audit and source tests |

### 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| four affected missing-collection cases and three new guards | R61-INV-01 | reproducible SyncProvider TypeError plus existing hidden-Part no-op path | current reducer assumes every removable event has loaded local storage |
| per-buffer mutation/dispose tail | R61-INV-02 | historical red differential | old client deletes mirror and disposes while mutation is pending |
| candidate ownership transfer | R61-INV-03 | persistent Tree source and WASM ownership contract | old worker mutates accepted state before query and leaves old Tree owner |
| centralized current seed | R61-INV-04 | screenshot and current Markdown caller matrix | no existing single constructor seam supplies all current representations |
| destroyed-first check | R61-INV-05 | observed renderer/client destruction order | existing catch logs before its owner-lifetime check |
| minimum correlated terminal id | R61-INV-02/03 | pending request interface | without request identity a failed operation cannot complete its own channel |

### 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | three missing local collection guards; retain the existing hidden-Part guard as the fourth affected case | +3 to +6 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | modify | minimal per-buffer tail/dispose ordering and only required streaming/one-shot terminal correlation; remove R60 broad state machinery | -80 to +80 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | modify | candidate Tree ownership and transient Tree `finally` disposal; no catch-and-success | +35 to +80 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | modify | minimal request/response ids for the two awaitable render paths | +8 to +16 |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | modify | destroyed check before existing warning; remove typed cancellation branch | -4 to +4 |
| `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` | modify | one centralized current token/raw seed seam; remove duplicated R60 call-site seeds | -30 to +20 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | modify | public race, ownership, pending representation and shutdown regressions | +80 to +140 |
| `thirdparty/opentui/packages/core/src/renderables/__tests__/Markdown.test.ts` | modify | current pending literal contract only where stale | +1 to +1 |

No new production file, worker telemetry, generated artifact or release asset is authorized. The `.7` version commit remains unpublished until R61 implementation is independently verified.

### 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Emit hidden/remove events for an unloaded Session, then a valid loaded event. | undefined local collection reaches `Binary.search`. | no-op only for missing local projection; next event applies. | R61-INV-01 |
| 2 | On the historical `61023` path, hold `STREAMING_UPDATE`, call public remove, and observe dispose before update settlement. | dispose bypasses the mutation owner. | dispose is sent only after mutation terminal response and local buffer remains until ack. | R61-INV-02 |
| 3 | Use the existing `client.test.ts:1380-1441` worker `postMessage/onmessage` seam to force a candidate query/parse failure, then perform a public successful update/reset. | accepted Tree/content is mutated before the failed query completes. | failed candidate is released; previous accepted state remains usable. | R61-INV-03 |
| 4 | Hold current Markdown list/blockquote/table/body highlight and capture frame before completion. | missing current seed leaves Code representation invisible with `drawUnstyledText=false`. | exact current token/raw representation is visible; eventual highlight replaces it. | R61-INV-04 |
| 5 | Destroy the renderer while a highlight is pending and capture warning output. | warning is emitted before destroyed owner check. | normal destruction produces no warning; a separately injected live failure remains observable. | R61-INV-05 |
| 6 | Run the existing compiled TUI scenario for daemon event continuation, Thinking/body and Commands restoration. | reducer or pending Code path can stop downstream frame updates. | same public event/render path remains live without production telemetry. | R61-INV-01/04/05 |

### 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed production lines `E` | <=300 | count substantive executable changes only; exclude imports, formatting, pure moves and tests |
| Required qualifying Chinese comments `C` | `>= max(1, ceil(E × 0.15))` and `<=45` at the planned `E` ceiling | comments only for owner transfer, ack ordering and current-seed invariant; actual implementation audit recomputes both values |

The implementation must remove surplus R60 comments rather than retain comments for deleted state-machine branches. No comments are added to explain obvious control flow.

### 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | Sync projection regression |
| targeted `bun test` for `client.test.ts` race/ownership/pending slices | `thirdparty/opentui/packages/core` | public Tree/client/Code behavior without full hanging suite |
| `bun typecheck` | `packages/opencode` | root TypeScript contract |
| `bun run build` | `thirdparty/opentui` | current OpenTUI source artifact |
| existing bounded compiled TUI smoke | `packages/opencode` | daemon event continuation, Thinking/body and Commands frame behavior |
| `git diff --check` plus actual path/E/C audit | repository and nested repo | no unrelated files, no fallback, budget compliance |

Full client suite is not a first-line command; it is attempted only after targeted commands pass and always under the repository's external process-tree timeout.

### 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 0 | use existing seams |
| Production files modified | <=6 | SyncProvider plus five OpenTUI owners |
| Test files modified | <=2 | public behavior slices in existing suites |
| Production effective lines | <=300 | surgical owner/representation changes; R60 broad rewrite is removed/collapsed |
| New alternate success paths | 0 | no retry, fallback, restart or second event source |

### 20. Real Risks and Open Decisions

#### Open Decisions Requiring the User

None for the R61 primary repair. The upstream `v0.5.1` base-version upgrade remains a separate future decision, not an implicit part of this fix.

#### Rejected Speculation

- Upstream `v0.5.1` release notes do not prove a fix for the user's exact fork path; the old queue/one-shot source is corroborating evidence only.
- The `Continue opencode -s undefined` and active-session count are exit/status symptoms, not evidence that daemon Session execution stopped.
- A generic worker error or malformed external input without a reachable producer is not used to justify another production branch.

### 21. Audit Contract

The independent auditor must audit the complete original user scope against R61, reconstruct both SyncProvider and OpenTUI paths from source, verify that R60 broad error/cancellation machinery is not silently retained as a second architecture, check the historical/current owner-order evidence, validate the <=6 production-file and <=300 effective-line plan, and copy its exact verdict into the R61 audit record.

### 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R61 | R61 | yes | No blocking findings | See verbatim verdict below | APPROVE | `ses_01f724578ffeS5c7aCpIoLy5Jj` |

R60 approval is invalidated by this substantive root-cause, owner, file-scope and fallback-policy revision. R61 is the only implementation-authorizing revision.

#### R61 Independent Plan Audit Verdict (verbatim)

No blocking findings.

## Non-blocking findings

- **R61 contains substantial superseded R60/R1–R60 material after the current authority section.** The plan explicitly states that these sections are non-normative, so this does not invalidate the current revision, but it increases implementation-navigation risk. The recorder should preserve the top-level R61 authority boundary and ensure implementation decisions are taken only from R61 sections 1–22.
- **The SyncProvider change count is inconsistent.** R61 describes “three” collection-ownership branches, while the current reducer has independently reachable missing-collection cases for hidden/updated messages, removed messages, hidden parts, and removed parts at `packages/opencode/src/cli/cmd/tui/context/sync.tsx:769-905`. The behavioral invariant and owner mapping cover the required no-op behavior, so this is a plan precision issue rather than an uncovered requirement.
- **The R61 comment estimate uses `C <=45` while the policy defines a minimum ratio.** The accompanying method states `C >= max(1, ceil(E × 0.15))`, and with the planned `E <=300` this permits the required maximum of 45 qualifying lines. The implementation audit must nevertheless recompute actual `E` and `C` independently.
- **The plan does not name the exact existing test helper or worker-control seam for the candidate failure-then-success slice.** The repository already contains public-client tests that control worker responses through the worker seam, including `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts:1380-1441`; implementation should use a behavior-level seam rather than add production-only test controls.

## Rejected speculation

- Upgrading directly to upstream OpenTUI `v0.5.1` is not required by the stated requirement and is correctly excluded.
- Adding watchdogs, retries, renderer restarts, generic catches, always-on plain-text rendering, or a second event-consumption path is not justified and is correctly rejected.
- Changing daemon event fan-out, SDK/SSE reconnect behavior, global session status, database code, native ABI, or the command-panel state machine is unsupported by the reconstructed first-divergence paths.
- Generic malformed worker payloads without a reachable producer or independently public untrusted seam do not justify additional production guards.

## Requirement and traceability coverage

| Requirement | R61 owner/path | Verification |
|---|---|---|
| TUI must continue consuming valid events after an unloaded-session event | `SyncProvider` missing local collection projection | Hidden/remove event followed by a loaded valid event; compiled liveness smoke |
| TUI must not deadlock on same-buffer mutation/dispose overlap | `TreeSitterClient` per-buffer operation tail | Public concurrent update/remove lifecycle test |
| Persistent Tree ownership must remain valid across failures and replacement | `ParserWorker` candidate Tree and single commit point | Candidate failure followed by successful update/reset |
| Markdown body must remain visible while highlighting is pending | `MarkdownRenderable` current-token seed seam | Pending-frame tests for list, blockquote, table, and ordinary body paths |
| Normal shutdown must not emit cancellation warnings while live failures remain observable | `CodeRenderable` destruction check before diagnostic branch | Pending highlight plus destruction test and compiled shutdown smoke |
| No unrelated fallback or error-handling expansion | R61 explicit non-goals, single primary-path design, zero new alternate success paths | Diff/path audit |
| File and production-line limits | R61 file-level and diff budgets | Independent implementation diff audit |

The producer-to-consumer chain is sufficiently reconstructed:

```text
daemon event
  -> SSE/SDK queue
  -> TUI event projection
  -> local Message/Part store
  -> Markdown/Code renderable
  -> TreeSitterClient
  -> parser worker Tree ownership
```

The plan identifies the first divergence for each confirmed symptom and assigns the repair to the owning module rather than to a downstream recovery layer.

## Primary-path and fallback verdict

- **Primary path:** one SyncProvider projection path, one per-buffer client operation tail, one parser candidate-to-accepted ownership transition, and one Markdown current-representation path.
- **Alternate success paths:** none newly introduced.
- **Existing compatibility:** existing live-error plain-text behavior is explicitly preserved without expansion and is not used to hide the lifecycle defect.
- **Diagnostics:** R61 removes the broader R60 cancellation/diagnostic machinery and retains only the minimum behavior needed to correlate terminal worker outcomes and suppress normal destruction noise.
- **Ownership:** SyncProvider owns local projection membership; TreeSitterClient owns operation ordering and client mirrors; ParserWorker owns WASM Tree ownership; Markdown owns current token representation; Code owns renderable-lifetime warning suppression.

The design repairs the identified owner transitions instead of bypassing Tree-sitter or adding recovery state machines.

## Release verdict

**APPROVE** — the exact audited canonical plan revision **R61** has no blocking findings and may proceed to implementation. Implementation remains disallowed until the plan records this exact independent verdict and transitions to an approved revision according to repository policy.

## R60 Current Authority

R60 supersedes R59 after the independent R59 plan audit identified a scope-contract conflict. The user then explicitly amended the scope in the current turn with the exact decision: `允许第9个测试文件（推荐）`. R60 therefore authorizes one ninth, test-only file solely to correct the stale pending-frame expectation; production behavior and the approved R58 primary path remain unchanged. This explicit user amendment supersedes the earlier eight-file ceiling for this test-only regression correction while retaining the full OpenTUI lifecycle regression file.

R60 retains the exact primary transitions from R58 and binds the complete regression contract to them:

- Every awaitable worker request is registered under its messageId before `postMessage`; the matching success, warning, explicit error, worker failure, or destroy cancellation removes that callback and settles it once.
- `TreeSitterClientDestroyedError` is the typed cancellation contract emitted only by `TreeSitterClient.destroy()` for pending requests. `CodeRenderable` classifies that error before live-failure warning logic, so cleanup ordering cannot turn normal cancellation into a warning.
- Parser edit, streaming update and reset each parse/query a candidate Tree, commit the candidate map entry only after the complete response is ready, delete the previous accepted Tree exactly at that commit, and delete only candidate allocations on failure.
- Every persistent Markdown CodeRenderable update caller receives a seed built from the exact current token/raw text: list child text/paragraph, list raw fallback, blockquote, top-level non-table, incomplete-table reuse and incomplete-table replacement. Fenced code blocks continue using their existing code-renderer contract.
- The nested-list regression's pending-frame assertion requires the current updated literal `Nested bullet with a long phrase that should wrap`; the settled initial snapshot continues asserting the shorter initial literal. This changes no renderer or parser behavior.
- `packages/opencode/script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` is the sole target-liveness artifact. Its outer process runs `runSyncProjectionPreflight()` exactly once through the existing `sync-fixture`; the Windows scenario child skips that preflight through `OPENCODE_SMOKE_ROOT_REPORT`. The scenario writes a protocol-complete worker fixture under its isolated root, selects it through the existing public `OTUI_TREE_SITTER_WORKER_PATH` environment seam, and makes the second model response's first SSE delta the complete fenced block "```ts\n// CANCEL-HIGHLIGHT-SENTINEL\n```" before holding the response open. The fixture completes ordinary INIT/parser/edit/stream/one-shot/dispose requests, but for a matching one-shot or streaming request atomically writes the isolated ready file and deliberately withholds only that terminal response. The smoke waits for that file before sending Ctrl+C, proving the real compiled fenced-Code/client request is pending without production telemetry; afterward it requires zero expected shutdown warnings and deletes the fixture/ready file with the isolated root.

### 1. Verbatim Requirement

> 根本需求是修正原有产生的opencode的TUI卡死（表现为交互失效，只有基本的TUI渲染，如prompt区域pending的blink，其他命令面板交互无响应、所有内容均不再进行更新与响应的问题）使其之后不再会产生类似的TUI自身渲染卡死、失去响应问题，同时解决在结束之后会爆出大量的（Code streaming highlight failed, falling back to plain text: warn: TreeSitter client destroyed）的问题、禁止添加和“根治”操作无关的任何修改，也就是最终目的不是让报错更加明显，而是解决报错的根因；与此同时，还要根治TUI正文不渲染且只有markdown的标号的问题，即存在大面积空白、只有1. 2.这种渲染的问题；同时，整体修改量代码不超过8个文件，生产代码修改量不800行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支判断，更好的应该是顶层设计保持简单，同时逻辑完整而不复杂，从第一性原理出发，不对不可能存在的输入进行假设，当出现任何的边界情况考虑不周到的问题，理论上应该检查顶层机制设计的是否足够合理精巧而不是让实现的时候添加分支判断，避免引入过重的状态机

### 2. Explicit Non-Goals

- 不修改Project事件扇出合同；同Project事件仍可到达TUI，因为sidebar、Session列表和跨Workspace通知依赖该合同。
- 不在SDK/SSE层添加通用`try/catch`、watchdog、timeout-success、自动重启或第二条事件消费路径；Reducer必须先恢复其输入域不变式。
- 不把所有异常事件转换为成功状态，不用常开plain text掩盖Tree-sitter失败，不修改`drawUnstyledText=false`。
- 不修改SessionStatus全局registry、daemon active-session统计或`Continue opencode -s undefined`摘要，除非新的可执行证据证明它们是本次TUI停止同步的第一分歧；当前证据只证明它们是退出/计数症状。
- 不修改buffer.zig、native ABI、OpenTUI版本/lockfile、generated SDK、数据库schema、migration或命令面板状态机。
- 不保留R54中未被R55 owner映射授权的renderer scheduler测试/production worktree改动；它们不能替代SyncProvider根因修复。

### 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session属于Project和工作目录；Status与Run state分离；Project事件可包含多个Session。 |
| `AGENTS.md` | 测试必须在package目录运行；遵循最小修改、避免mock和复杂抽象。 |
| `packages/opencode/AGENTS.md` | TUI/daemon是`packages/opencode`职责；不要引入重复Effect运行时或额外生命周期状态。 |
| `packages/opencode/test/AGENTS.md` | 使用真实fixture、published readiness、禁止固定sleep作为并发就绪协议。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | HTTP/SSE owner保持在HttpApi handler；不把HttpApi错误泄漏进Session服务。 |
| `.opencode/policy/first-principles-engineering.md` | 修复第一分歧；禁止fallback；任何实质计划变化必须重新审计。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须包含完整证据、责任、TDD、预算、追踪和审计记录。 |
| `docs/adr/README.md`, `docs/adr/0001-*.md` | 无适用TUI/daemon ADR；不得把triage ADR当作运行时设计授权。 |

### 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/event.ts:45-80` | 同Project/global事件进入当前TUI；这是合法事件扇出，不是异常输入。 | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:58-109,122-188` | SSE事件进入16ms queue并同步emit；Reducer异常会破坏当前批处理。 | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:769-900` | hidden message、message removed、part removed存在未加载数组上的`Binary.search`。 | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1070-1117` | HTTP快照只建立被请求Session的本地Message/Part投影。 | reachable |
| `packages/core/src/util/binary.ts:2-19` | `Binary.search`读取`array.length`，undefined输入必然抛错。 | observed |
| `packages/opencode/src/session/message-v2.ts:1437-1485` | 普通Session page默认排除hidden Message/Part。 | contracted/reachable |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:148-158,176-186` | SDK普通读取与hidden tombstone使用不同可见投影。 | contracted/reachable |
| `packages/opencode/src/session/status.ts:58-88` | daemon全局Status Map解释active-session计数，但不承载TUI store同步。 | observed |
| `packages/opencode/src/cli/cmd/tui/thread.ts:165-175` | Ctrl+C后的daemon提示只读status，不是TUI事件消费owner。 | observed |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx:38-179` | 公开testTransport/event source和renderer cleanup seam。 | contracted |
| `packages/opencode/test/cli/cmd/tui/sync-undefined-messages.test.tsx:1-47` | 已有TUI sync异常回归，当前1 pass，证明公共同步seam可运行。 | observed |
| Throwaway `bun -e` hidden tombstone harness | 未加载Session的hidden `message.updated`当前实际输出`TypeError: undefined is not an object (evaluating 'array.length')`。 | observed |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts:219-239` | `OTUI_TREE_SITTER_WORKER_PATH`是现有公开worker选择seam；smoke可用隔离fixture建立pending readiness而不修改production contract。 | contracted/reachable |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/{client.ts,parser.worker.ts,types.ts}` | correlated request、worker error和Tree ownership修复的现有owner。 | reachable/observed |
| `thirdparty/opentui/packages/core/src/renderables/{Code.ts,Markdown.ts}` | shutdown warning和current Markdown representation的渲染owner。 | reachable/observed |
| `packages/opencode/script/smoke-opentui-artifact.ts` | 已有compiled PTY smoke，当前worktree扩展可作为Thinking/body/dialog/shutdown公开验证面。 | observed/reachable |

### 5. Current Producer-to-Consumer Behavior

```text
Session/Part producer
  -> daemon Bus/GlobalEvent SSE
  -> SDKProvider queue + batch emit
  -> useEvent project/global routing
  -> SyncProvider event reducer
  -> local Message/Part store
  -> Session renderer / Markdown / Code
```

对于未打开的子Session，HTTP bootstrap不会建立`store.message[sessionID]`。同Project的事件仍会经过`event.ts`进入当前TUI。hidden `message.updated`、`message.removed`和`message.part.removed`随后在`sync.tsx`对undefined数组调用`Binary.search`。异常位于SyncProvider reducer，早于OpenTUI frame提交；daemon仍可继续持久化和发送事件，而当前TUI不再可靠消费后续事件。

并行的Tree-sitter路径是：

```text
Code/Markdown update -> Tree-sitter client request -> worker response/error
  -> correlated callback -> Code representation -> renderer frame
```

worker错误没有messageId时会让request channel无法完成；persistent Tree替换不释放旧owner会增加长Session压力；销毁顺序下的正常取消会被Code warning打印。它们解释空白/退出warning，但不能替代SyncProvider first divergence。

### 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 同Project但未加载Session的`message.updated` hidden tombstone | Revert/hidden Message producer | Event schema合法；Session可能未进入当前TUI store | global SSE -> project event route -> SyncProvider | SyncProvider local projection | observed/reachable |
| 未加载Session的`message.removed` | Session removal producer | event携带SessionID/MessageID | 同上 | SyncProvider | reachable |
| 未加载Message的`message.part.removed` | Part removal producer | event携带MessageID/PartID | 同上 | SyncProvider | reachable |
| 同一Part的正常`message.part.updated`/delta | Session streaming producer | Part/delta schema合法 | SSE -> reducer -> Part store | SyncProvider | contracted |
| worker correlated error/failed parse | Tree-sitter worker | request携带messageId；失败仍须返回终态 | client -> Code | Tree-sitter client/worker | reachable |
| persistent Tree accepted replacement | parser worker | 每个buffer只有一个accepted owner | parser worker candidate path | parser worker | reachable |
| Ctrl+C期间在途highlight请求 | smoke-owned worker fixture publishes isolated ready file only after receiving the sentinel request | destroyed cancellation是正常终止，不是live failure | compiled Markdown/Code -> public worker seam -> ready file -> Ctrl+C -> client destroy | Code/client; smoke owns readiness only | observed/contracted |
| current Markdown token while highlight pending | Markdown parser | current raw/token representation已存在 | Markdown -> CodeRenderable | Markdown | reachable |

### 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| R58-INV-01 | 合法的Project事件即使属于未加载Session，也不能使SyncProvider reducer抛异常或停止后续事件消费。 | hidden tombstone red harness | smoke artifact source preflight |
| R58-INV-02 | 未加载对象的删除/隐藏事件是本地projection的no-op；随后当前Session的有效Message/Part事件仍更新store和frame。 | `Binary.search(undefined)` first divergence | smoke artifact source preflight |
| R58-INV-03 | TUI保持daemon事件流与本地store同步；daemon继续运行时，后续正文/Thinking事件仍可见。 | user Session symptom + event chain | compiled target-liveness smoke |
| R58-INV-04 | 每个Tree-sitter messageId request在成功、warning、显式error、worker failure或destroy cancellation中只完成一次；settlement后callback map不再保留该id。 | client/worker response protocol | new correlated error/settlement tests in `client.test.ts` |
| R58-INV-05 | 每个buffer只有一个accepted Tree owner；edit/stream/reset的candidate只有完整parse/query成功后才能成为owner，accepted replacement释放旧owner，失败candidate不破坏旧owner。 | parser worker ownership transition | public update/reset/stream failure-then-success tests |
| R58-INV-06 | `TreeSitterClientDestroyedError`只表示正常client cancellation；Code遇到它不warning，其他live worker/highlight error仍走既有plain-text diagnostic contract。 | client-to-Code cancellation contract | real pending request destroy plus Code one-shot/streaming test and compiled pending-ready smoke |
| R58-INV-07 | persistent Markdown每个current update caller都显示同一current token/raw representation while pending；最终highlight仍覆盖该representation，不改变fenced code renderer语义。 | Markdown seed call-site matrix | list, blockquote, non-list and incomplete-table tests |
| R58-INV-08 | Commands打开/关闭后，当前body、Thinking和背景cell重新提交，没有旧dialog残影。 | user-visible dialog symptom | compiled target-liveness smoke |
| R60-INV-09 | 最终修改不超过8个代码文件，当前-turn明确授权第9个test-only correction；production effective lines低于800，且不引入第二成功路径。 | user constraint/amendment/policy | diff and E/C audit |

### 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| R58-INV-01/02/03 | `sync.tsx`在hidden `message.updated`及remove事件上把缺失本地数组传给`Binary.search`。 | `SyncProvider` event reducer | throwaway harness produces exact TypeError before any OpenTUI frame change |
| R58-INV-04 | worker terminal error path historically lacked correlated completion for every request class. | Tree-sitter worker/client response channel | current source/type diff and existing correlated tests |
| R58-INV-05 | persistent candidate ownership must transfer only after query success. | parser.worker accepted-state owner | current lifecycle source and repeated edit/stream/reset tests |
| R58-INV-06 | Code logs rejection before classifying destroyed client cancellation. | Code rejection/shutdown owner | shutdown warning trace and current Code source |
| R58-INV-07 | persistent CodeRenderable update callers lack current representation seed. | Markdown seed construction | R54 current-source evidence and existing Markdown behavior |

The red-capable feedback loop already run is:

```text
cwd: packages/opencode
bun -e '<mount sync-fixture; emit hidden message.updated for ses_unloaded; observe reducer error>'
result: TypeError: undefined is not an object (evaluating 'array.length')
```

The existing package regression also runs green:

```text
bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx
1 pass / 0 fail / 1 expect()
```

The first command is the minimized root reproducer; the second is the existing related public sync contract.

### 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Missing local projection on valid event | SyncProvider | Project events are decoded and delivered; local projection may not contain every Session | Only SyncProvider knows whether a Session/Message/Part is loaded and how no-op projection works | event.ts must preserve project-wide notifications; SDK/SSE does not know local store membership |
| Event stream continuation | SDKProvider | Queue emits decoded events to subscribers | No new catch is needed once subscriber contract cannot throw for supported events | generic SDK catch would hide reducer defects and create fallback semantics |
| Correlated worker terminal state | Tree-sitter client/worker | messageId request channel settles once | request/response owner is here | Code only consumes result and cannot repair worker protocol |
| Accepted Tree ownership | parser.worker | one accepted Tree owner per buffer | worker owns WASM Tree lifetime | client cannot delete worker-owned Trees |
| Destroyed warning policy | Code | normal cancellation is silent; live failure remains diagnostic | Code knows whether renderable/client is destroyed | renderer only owns destruction ordering |
| Current Markdown seed | Markdown | current content remains visible while async highlighting is pending | Markdown owns token-to-CodeRenderable representation | parser cannot reconstruct UI token boundaries |

### 10. Single Approved Primary-Path Design

```text
valid project event
  -> SyncProvider reducer checks the owning local collection
  -> missing collection: no-op projection
  -> existing collection: Binary.search and apply removal/update
  -> next valid event remains on the same SDK emitter path
```

The only OpenCode production change is to make the three affected collection boundaries explicit before `Binary.search`:

- hidden `message.updated`: missing `store.message[sessionID]` is a no-op;
- `message.removed`: missing `store.message[sessionID]` is a no-op;
- `message.part.removed`: missing `store.part[messageID]` is a no-op.

This is not a fallback or synthesized success. The event's authoritative owner is the daemon; an unloaded TUI has no local row to remove, so the correct projection is no-op. No `try/catch`, retry, alternate event source, session refetch, or global event filtering is added.

The OpenTUI primary transitions are exact:

1. `TreeSitterClient.request(messageId, message)` inserts `{resolve,reject}` before `postMessage`. Every response branch carrying that id deletes the entry before resolving/rejecting; a second response is ignored because the entry is gone. `handleWorkerFailure()` rejects all still-pending requests with the live worker error. `destroy()` rejects all still-pending requests with one `TreeSitterClientDestroyedError` instance.
2. `TreeSitterClientDestroyedError` is exported from `client.ts` and is created only by `destroy()`; `Code.ts` checks this typed error before its live-failure warning path. `isDestroyed` remains the existing renderable-lifetime guard for a live error arriving after renderable cleanup, but an ordinary error with the same text is never classified as cancellation.
3. `parser.worker.ts` uses one `commitCandidate(bufferId, previousState, nextState, scratch)` transition for edit, streaming and reset. The map is changed only after parse, query and injection processing succeed; that transition deletes `previousState.tree` and the scratch Tree exactly once. Every failure path deletes only candidate allocations and leaves the previous map entry untouched.
4. `Markdown.ts` passes `createInitialStyledText(token)` or an exact raw seed at every persistent Markdown CodeRenderable update: list text/paragraph, list raw fallback, blockquote, generic top-level structured token, incomplete-table reuse and incomplete-table replacement. `createCodeRenderable()` for fenced code remains unchanged.

Existing R54 renderer scheduler retry changes are not part of R58 because the new first divergence occurs before renderer scheduling; task-owned R54 renderer test/production diffs must be cleaned rather than used as a downstream workaround.

### 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `SyncProvider` missing-collection no-op | proposed | primary-contract branch | no, projection no-op | primary | preserve |
| existing feed/backpressure handling | current | existing compatibility | yes | existing | preserve |
| SDK generic catch that resumes after reducer failure | proposed in old R54 discussion | forbidden fallback | yes | rejected | reject |
| session refetch after missing event | proposed in old drafts | alternate success path | yes | rejected | reject |
| always-visible unstyled Markdown | proposed workaround | alternate rendering success | yes | rejected | reject |
| renderer restart/watchdog | proposed in old drafts | forbidden fallback | yes | rejected | reject |
| existing Tree-sitter plain-text compatibility on live failure | current | existing compatibility | yes, as contracted error presentation | existing | preserve |

New alternate success paths: zero.

### 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| R54 renderer failure self-requestRender path and rewritten clock-only retry assertions | attempted to treat downstream frame scheduling as incident root | SyncProvider reducer is the first divergence for daemon/TUI detachment; retaining it would be unrelated downstream compensation | task-owned `renderer.ts`/`renderer.custom-stdout.test.ts` worktree diff, after approved cleanup |
| stream timing telemetry used as a diagnostic substitute | attempted to observe receive/apply phases | root reducer invariant is executable without telemetry; production logs are not required by user | remove only if no other approved plan owns the task-owned telemetry diff |
| any new generic SDK catch/reconnect-on-reducer-error | would hide a valid reducer defect | primary reducer must not throw for its supported event domain | do not add |

### 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R58-INV-01/02 | missing local collection projection | `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | hidden/remove events for unloaded Session followed by valid event in smoke preflight |
| R58-INV-03 | SDK emitter remains single path after reducer no-op | same `sync.tsx`; no SDK catch | smoke artifact source preflight and compiled target-liveness scenario |
| R58-INV-04 | correlated worker response | OpenTUI `client.ts`, `parser.worker.ts`, `types.ts` | public client suite |
| R58-INV-05 | accepted Tree owner transfer | OpenTUI `parser.worker.ts` | public lifecycle tests |
| R58-INV-06 | destroyed/live rejection classification | OpenTUI `Code.ts`, `client.ts` | client suite and compiled pending-ready shutdown smoke |
| R58-INV-07 | current representation seed | OpenTUI `Markdown.ts` | client suite and body/Thinking smoke |
| R58-INV-08 | public compiled frame transition | repository-tracked smoke artifact | bounded external supervisor invoking the artifact |
| R58-INV-09 | file/line/comment budget | all listed files | diff/E/C audit |

### 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| three missing-collection no-op branches | R58-INV-01/02 | exact red harness and undefined store paths | existing reducer assumes every project event has a loaded local collection |
| correlated messageId propagation | R58-INV-04 | worker error and pending callback path | generic error event lacks callback identity |
| accepted Tree commit/disposal ownership | R58-INV-05 | current WASM Tree owner behavior | replacing map entry without explicit old-owner disposal leaks/overlaps |
| destroyed-first warning classification | R58-INV-06 | shutdown warning sequence plus harness-only pending-ready file | Code currently decides warning before cancellation state; event arrival alone cannot prove a pending request |
| current Markdown seed | R58-INV-07 | pending highlight body blank evidence | async highlight path has no current representation fallback/seed |
| target-liveness smoke assertions | R58-INV-03/08 | user requires no future logs and public PTY evidence | existing normal smoke does not assert Thinking/body/dialog/shutdown together |

### 15. File-Level Change Plan

Exactly nine repository code files are authorized for the final task diff in R60; the ninth is a test-only correction explicitly authorized by the user:

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | three collection ownership guards only | +6 to +12 |
| `packages/opencode/script/smoke-opentui-artifact.ts` | modify | add outer-only sync preflight; generate/clean a protocol-complete worker fixture and isolated pending-ready file; remove telemetry dependency; retain compiled public-event/frame/shutdown assertions | +90 to +150 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | modify | settle every correlated response exactly once, export typed destroy cancellation, and keep buffer operation tail/disposal ordering | +35 to +75 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | modify | attach request ids to edit/reset/stream/dispose terminal responses and use one candidate-to-accepted Tree transition | +80 to +180 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | modify | declare the exact request/response messageId fields used by the client/worker wire contract | +15 to +25 |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | modify | classify `TreeSitterClientDestroyedError` before live-failure warning and preserve existing live plain-text behavior | +6 to +12 |
| `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` | modify | pass current inline/raw seeds at the six persistent Markdown call-site categories listed in R60 | +20 to +50 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | modify | public client, Code and Markdown red-green regressions for all four OpenTUI invariants | +100 to +180 |
| `thirdparty/opentui/packages/core/src/renderables/__tests__/Markdown.test.ts` | modify | update the one pending-frame expectation from stale initial text to the current updated literal; no production behavior change | +1 to +1 |

`renderer.ts`, `renderer.custom-stdout.test.ts`, `sync.test.tsx` and `sync-undefined-messages.test.tsx` remain unauthorized final diff files in R60. `packages/opencode/script/smoke-opentui-artifact.ts` remains the repository-tracked target-liveness artifact. The only additional file is the explicitly authorized Markdown regression correction above.

### 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Run the smoke artifact's source-level `sync-fixture` preflight with hidden `message.updated` for an unloaded Session; current harness must observe the TypeError. | hidden branch calls `Binary.search(undefined, ...)`. | no throw; local store remains unchanged. | exact first divergence |
| 2 | In the same smoke preflight emit unloaded `message.removed` and `message.part.removed`, then emit a valid loaded Message/Part update. | remove branches have the same undefined-array assumption. | all three events no-op safely; valid event updates store. | event consumer remains live |
| 3 | Replace a controlled worker streaming response with a correlated `ERROR` and await the public update Promise. | messageId error must settle the same request instead of leaving it pending. | Promise rejects once with worker error and later callback map is empty. | R58-INV-04 |
| 4 | Force a failed streaming candidate, then issue a successful update/reset through the public client API. | candidate failure must not replace the accepted content/tree. | failure rejects; next operation succeeds against the previous accepted state. | R58-INV-05 |
| 5 | Hold a real pending client request, call `TreeSitterClient.destroy()`, and exercise Code one-shot and streaming catches with the typed cancellation error. | current Code only knows renderable destruction; client rejection may arrive first. | no highlight warning for typed cancellation; a different live error still warns and exposes plain text. | R58-INV-06 |
| 6 | Hold each Markdown persistent update caller while replacing current list text, blockquote text, generic structured text and incomplete table raw text. | a caller without the same-current seed hides body when `drawUnstyledText=false`. | each current literal appears before resolve; eventual highlight commits afterward; the nested-list suite asserts the updated long literal in pending frames. | R58-INV-07 |
| 7 | Run the repository smoke with its generated worker fixture; the second prompt emits the complete fenced sentinel block, then waits for the fixture's ready file before Ctrl+C. | daemon event arrival does not prove fenced Code/client has a pending highlight. | the sentinel one-shot/stream request remains unsettled until real client destroy; Thinking/body, Commands restoration and shutdown warning count still pass. | R58-INV-03/06/08 |

The smoke artifact uses `sync-fixture` public `eventSource` and independent store/frame values for its source preflight. Its generated worker fixture implements the existing wire protocol only: `INIT -> INIT_RESPONSE`; parser initialize/preload return `hasParser:true`; handle/reset return a correlated empty `HIGHLIGHT_RESPONSE`; ordinary one-shot and streaming requests return correlated successful empty-highlight responses; dispose, data-path, cache and performance requests return their matching terminal response; parser registration remains the existing fire-and-forget message. A one-shot or streaming request whose content contains `CANCEL-HIGHLIGHT-SENTINEL` instead writes `${root}/highlight-pending.ready` and receives no terminal response. The smoke passes the fixture path through `OTUI_TREE_SITTER_WORKER_PATH`, waits for that exact isolated file, then sends Ctrl+C; timeout is failure. This is test-harness observation, not production telemetry or a success path. OpenTUI request tests use the public `TreeSitterClient` constructor/`workerPath` seam with a temporary worker fixture; they do not reach into `messageCallbacks`, worker internals or private parser state. Assertions use public Promise results, buffer content/versions, Code warnings and captured frames rather than source text or call counts alone.

### 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed production lines `E` | <= 450 | Count only substantive executable changes in the six production files; exclude imports, formatter-only, generated and pure moves. This remains below the user ceiling of 800. |
| Required qualifying Chinese comments `C` | >= 68 | `max(1, ceil(E*0.15))`; comments must explain unloaded projection no-op, correlated ownership, Tree disposal, destroyed cancellation or current seed contract. |

Each changed production file with `E_i > 0` must independently satisfy `C_i >= max(1, ceil(E_i*0.15))`. Existing comments count only when adjacent and explanatory; obvious flow and identifier translations do not count.

### 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run build --single --skip-embed-web-ui` | `packages/opencode` | creates `dist/opencode-windows-x64/bin/opencode.exe` from the audited source before smoke execution |
| `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` | `packages/opencode` | source-level unloaded projection, compiled public-event/frame assertions, harness-only pending-ready proof and Ctrl+C warning gate |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | correlated settlement, Tree ownership, disposal and cancellation |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | `thirdparty/opentui/packages/core` | complete Markdown representation and streaming behavior, including the corrected current pending-frame contract |
| `bun typecheck` | `packages/opencode` and `thirdparty/opentui/packages/core` | package-local type contracts |
| bounded external PowerShell process-tree supervisor invoking the exact smoke command above | `packages/opencode` | supervises the repository-tracked source preflight and compiled binary; timeout or an orphan is a failed verification |
| `git diff --check` | repository root | whitespace integrity |

Every long-running command uses an external PowerShell process-tree supervisor; timeout or orphan process is a failed verification, never an implicit pass.

### 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | all seams already exist |
| Files modified | 9 | exact table in section 15; the ninth is the user-authorized test-only contract correction |
| Files deleted | 0 | no persisted/generated artifact removal |
| Production effective lines | <= 450 | surgical guards plus exact lifecycle/seed repairs only, still below the user ceiling |
| Test/harness lines | <= 360 | one smoke source preflight plus generated pending fixture, OpenTUI public lifecycle/Markdown tests and one corrected pending-frame expectation |
| Generated lines | 0 | generated SDK/lockfiles excluded |

### 20. Real Risks and Open Decisions

#### Open Decisions Requiring the User

None. The product contract is no-op projection for unloaded Session/Message/Part events; this is required by existing project-wide event delivery and does not change visible loaded-session behavior.

#### Rejected Speculation

- Strict current-HEAD latest ten commits did not modify `sync.tsx`, `event.ts` or `sdk.tsx`; OpenTUI smark.4/.5/.6 upgrades are temporal amplifiers and do not own daemon/TUI event detachment.
- `SessionStatus` global Map explains `busy`/active-session exit counts but no producer-consumer path connects it to the thrown reducer exception; no status modification is planned.
- Generic SDK catch/reconnect, renderer restart, watchdog, permanent unstyled text, and native buffer changes lack first-divergence ownership and are rejected.

### 21. Audit Contract

The independent auditor must read this exact R60 file and the original requirement plus the explicit current-turn scope amendment, reconstruct the full daemon/SSE/SyncProvider and OpenTUI paths, treat prior approvals and builder summaries as untrusted, check all nine files and every original symptom, require evidence for every blocker, and audit fallback/ownership/TDD/E-C/diff limits. The handoff contains the original requirement, the plan path, repository root, `Audit mode: plan`, and the explicit scope amendment recorded at §R60 Current Authority.

### 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R54 | R54 | yes | No blocking findings | - | APPROVE, invalidated by R55 scope change | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| R55 | R55 | yes | B-01, B-02 | see independent verdict | BLOCK | `ses_020be2f9effeQUktMqNBHi28ls` |
| R56 | R56 | yes | B-01 undefined external target-liveness artifact | see independent verdict | BLOCK | `ses_020be2f9effeQUktMqNBHi28ls` |
| R57 | R57 | yes | B-01 no pending-highlight readiness after telemetry removal | see independent verdict | BLOCK | `ses_020be2f9effeQUktMqNBHi28ls` |
| R58 | R58 | yes | No blocking findings | four implementation-stage checks | APPROVE, invalidated by R59/R60 scope change | `ses_020be2f9effeQUktMqNBHi28ls` |
| R59 | R59 | yes | B-01 nine files violates original unamended scope | see independent verdict | BLOCK | `ses_020be2f9effeQUktMqNBHi28ls` |
| R60 | R60 | yes | No blocking findings | three implementation-stage checks | APPROVE | `ses_020be2f9effeQUktMqNBHi28ls` |

Any substantive revision invalidates earlier approval. Exact R60 is approved for implementation.

### R81 Current Implementation Evidence

This record applies only to approved R81. Code/Markdown renderable hunks are baseline/reverification, and the `.6` manifest/lockfile changes are cleanup-only; neither is counted as a new R81 production concept.

| Area | Evidence |
| --- | --- |
| Approved route | `parser.worker.ts` serializes parser-asset use and invalidation through `runWithParserAssets`; injection parse/query failures and inline-reference parse-null propagate instead of publishing partial success; `client.ts` settles correlated one-shot failures through the existing response channel. |
| TDD red | Before the correlated one-shot repair, the two new client behavior slices resolved instead of rejecting. Before the asset owner tail, the gated `clear cache waits for parser assets in use` slice observed `cleared` before the held operation released. Before the current Markdown seed ordering, the full Markdown suite was `155 pass, 1 fail` on `paragraph updates do not flash raw markdown markers`. Before the current Code pending-owner correction, the full Code suite was `69 pass, 3 fail` in stale/current pending representation contracts. |
| TDD green | `bun test ./src/lib/tree-sitter/client.test.ts`: `59 pass, 0 fail`; `bun test ./src/renderables/Code.test.ts`: `72 pass, 1 skip, 0 fail`; `bun test ./src/renderables/__tests__/Markdown.test.ts`: `156 pass, 0 fail`. |
| Package checks | `bunx oxfmt --check` on all affected OpenTUI source/test paths: pass. `bun run build:lib` from `thirdparty/opentui/packages/core`: pass. `bun typecheck` from `packages/opencode`: pass. `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` from `packages/opencode`: `1 pass, 0 fail`. |
| Compiled artifact | Built with `bun run script/build.ts --skip-install --skip-embed-web-ui --os=win32 --arch=x64`, using a read-only local HTTP endpoint serving the current checked-in models snapshot because direct `models.dev` access was refused. Build version `0.0.0-dev-smark-202608081605`; OpenTUI `0.4.3-smark.6`; executable `152292864` bytes, SHA-256 `7366c7b07fa053510e49094dcced05f8c452e276d2cac469e267d49102a91bf1`; evidence report: `packages/opencode/dist/opencode-windows-x64/opentui-build.json`. |
| Compiled normal smoke | `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario normal`: pass; `sourceCount=2`, `renderedCount=2`, `modelRequests=2`, `targetEventCount=0`. |
| Compiled target-liveness smoke | Same command with `--scenario target-liveness`: pass; `sourceCount=2`, `renderedCount=2`, `modelRequests=2`, `targetEventCount=14`; shutdown completed without warning failure. |
| Incremental E/C | Independent auditor conservative recount for R81 parser/client route: `E≈210`, qualifying nearby Chinese explanations `C≈40`, ratio `≈19%`; baseline/reverification and cleanup-only paths excluded. |
| Unverified items | OpenTUI package-wide typecheck retains existing Yoga/upstream test typing failures; no changed-owner failure was reported. Direct network model fetch is unavailable, so the compiled build used the local snapshot endpoint described above. No commit or push was performed. |

### 23. Implementation Evidence

Implemented approved R58 production route plus the exact R60 test-contract correction in nine repository code files:

| File | Effective `E_i` | Qualifying Chinese `C_i` | Required `ceil(E_i*0.15)` | Result |
| --- | ---: | ---: | ---: | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | 4 | 3 | 1 | pass |
| `packages/opencode/script/smoke-opentui-artifact.ts` | test/harness | not production-gated | - | source preflight, generated worker readiness and compiled PTY harness |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | 102 | 38 | 16 | pass |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | 77 | 36 | 12 | pass |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | 14 | 3 | 3 | pass |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | 3 | 3 | 1 | pass |
| `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` | 55 | 9 | 9 | pass |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | test | not production-gated | - | public lifecycle/Code/Markdown regression seam |
| `thirdparty/opentui/packages/core/src/renderables/__tests__/Markdown.test.ts` | test-only | not production-gated | - | corrected one pending-frame expectation to the current updated literal |
| **Production total** | **255** | **92** | **39 total per-file minima** | **pass; below 800** |

`E` excludes blank, import-only, formatter-only, generated and exact pure-move lines. `C` counts only adjacent Chinese explanations of projection ownership, correlated settlement, Tree ownership/disposal, cancellation classification or current Markdown representation. The smoke harness and the explicitly authorized Markdown test correction are excluded from production `E/C`; the final repository code boundary is nine files under the current-turn amendment.

Red-green and verification evidence:

| Command | Directory | Result |
| --- | --- | --- |
| `bun -e '<mount sync-fixture; emit unloaded hidden message.updated>'` | `packages/opencode` | red: exact `TypeError: undefined is not an object (evaluating 'array.length')` at `sync.tsx`/`Binary.search` |
| same public fixture with hidden/remove/part-remove followed by loaded update | `packages/opencode` | green: exit 0 and loaded Message appears after `wait` |
| `bun test ./test/cli/cmd/tui/sync-undefined-messages.test.tsx` | `packages/opencode` | 1 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | pass |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | 56 pass, 0 fail, 395 expect calls |
| focused Markdown pattern: `blockquote|incomplete table|streaming structured lists reuse|assistant-style top-level` | `thirdparty/opentui/packages/core` | 8 pass, 148 filtered, 0 fail |
| full `bun test ./src/renderables/__tests__/Markdown.test.ts` before R60 correction | `thirdparty/opentui/packages/core` | 155 pass, 1 stale assertion mismatch in `streaming nested structured list updates...`; this is the red signal that authorized the R60 test-only correction. |
| full `bun test ./src/renderables/__tests__/Markdown.test.ts` after R60 correction | `thirdparty/opentui/packages/core` | 156 pass, 0 fail, 91 snapshots, 383 expect calls |
| `bun typecheck` | `thirdparty/opentui/packages/core` | existing baseline failure in generated Yoga/upstream test typing; no changed-owner error was surfaced in the bounded output |
| `bun run build --single --skip-embed-web-ui` | `packages/opencode` | direct network attempt failed at `https://models.dev/api.json`; equivalent bounded build using a local server serving the current checked-in snapshot then succeeded and produced the current Windows artifact |
| `bun run script/smoke-opentui-artifact.ts --binary F:\\include\\CLI\\opencode.exe --scenario target-liveness` | `packages/opencode` | historical bounded external binary smoke pass; not used as final artifact provenance |
| local current-snapshot endpoint + `bun run build --single --skip-embed-web-ui` | `packages/opencode` | final current-source build succeeded after renderer cleanup; target `opencode-windows-x64`, OpenTUI `0.4.3-smark.6`, executable SHA-256 `b4cb22042623e16d5c9755eb2befbfda153ed5b847f22c5d873621b686fb3a20` |
| `bun run script/smoke-opentui-artifact.ts --binary ./dist/opencode-windows-x64/bin/opencode.exe --scenario target-liveness` | `packages/opencode` | final current artifact smoke pass: `targetEventCount=14`, `modelRequests=2`, `sourceCount=2`, `renderedCount=2`, zero shutdown-warning failure |
| `git diff --check` | repository root and nested OpenTUI | pass |

Approved route evidence: SyncProvider now no-ops only missing local Message/Part collections; worker terminal responses carry correlated ids; accepted Tree replacement has one candidate commit/disposal owner; typed destroy cancellation is silent before live-failure warnings; all Markdown current-seed callers retain pending body visibility. R54 renderer scheduler changes, generic SDK recovery, production telemetry dependency and permanent plain-text workaround are not used.

### 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| R58-round-0 | R58 | yes | B-01 full Markdown suite has one stale pending-frame assertion; B-02 current-source build/smoke artifact was unavailable at audit time | typecheck baseline and implementation-stage E/C checks | BLOCK | `ses_020712d0cffeKl8BDVPpYLt7z5` |
| R60-round-0 | R60 | yes | None | R60 test-only correction and current-source build/smoke evidence recorded above | APPROVE, implementation-audit-required before this re-audit | `ses_01ffcf637ffeyrMbMESQnaWXNm` |
| R60-round-1 | R60 | yes | None | two documentation consistency notes; existing OpenTUI generated Yoga/upstream typecheck baseline | APPROVE | `ses_01ffcf637ffeyrMbMESQnaWXNm` |

Implementation-audit follow-up evidence: the unauthorized renderer diff was removed first. A local HTTP server then served the current checked-in model snapshot to the existing generator, the final current-source `bun run build --single --skip-embed-web-ui` produced the artifact hash recorded above, and the exact target-liveness smoke passed with `targetEventCount=14`, `modelRequests=2`, and zero shutdown-warning failure. R60 corrected the one stale Markdown pending-frame expectation under the explicit current-turn ninth-test amendment; the full Markdown suite is green.

## R54 Historical Trace

R54 supersedes R53 and is self-contained. It carries the complete implementation, verification, ownership, scope, fallback and comment/diff contract in this current-authority section; no historical section is incorporated by reference.

### R54 Requirement and Non-Goals

修复Windows OpenCode TUI停止刷新/交互失效、正文和Thinking大面积空白、命令面板残影、Tree-sitter worker永久pending、persistent Tree泄漏、mutation/dispose重叠和Ctrl+C批量warning。禁止日志-only、常开未高亮正文、timeout-success、retry、second parser、renderer restart、watchdog、production telemetry、daemon/SSE猜测性修改和重大重构。代码文件最多8个，production effective lines低于800，保持一个primary path。

不修改stable-prefix Markdown算法、buffer.zig、native ABI、daemon/SSE/SyncProvider、版本、lockfile、generated artifact、发布流程、OpenCode命令面板状态逻辑或native stdout路径。`drawUnstyledText=false`保持不变；Code的plain-text仅保留既有error compatibility。Feed-backed `retryable-skip`和已有process-stdout `backpressured`只保留其既有传输契约，不属于render failure retry。

### R54 Evidence, Reachability and First Divergence

| Area | Producer -> consumer path | First divergence/owner | Evidence |
| --- | --- | --- | --- |
| Scheduler dead state | `CliRenderer` render-body/native status -> failure cleanup -> future owner cleared or self-scheduled | `renderer.ts` `CliRenderer` scheduler | bounded throwing-renderable probe; current source sets `immediateRerenderRequested` and `finally` calls `requestRender()`; current tests assert clock-only retry |
| Markdown current body | `Markdown.content` -> persistent CodeRenderable update -> missing current seed -> `drawUnstyledText=false` while highlight pending | `Markdown.ts` `applyMarkdownCodeRenderable` callers | current list/table callers omit seed; upstream `98e390189` changes list update to pass current styled seed; incomplete table cache path reaches raw fallback callers |
| Worker settlement | worker terminal error -> client callback | verification-only `parser.worker.ts`/`client.ts` owner | current source already correlates `messageId`; `client.test.ts` current correlated-error test passes |
| Tree ownership | accepted edit/stream/reset candidate -> persistent Tree owner | verification-only `parser.worker.ts` `commitCandidate()` | current source deletes old accepted Tree and failed scratch candidate; lifecycle tests pass |
| Mutation/dispose | per-buffer mutation -> rejection/success -> next mutation/disposal | verification-only `client.ts` tail owner | current source chains operations and waits for disposal ack; lifecycle tests pass |
| Shutdown warning | Code rejection -> destroyed classification -> warning decision | verification-only `Code.ts` | current source checks destroyed before warning; renderer/client suite passes |
| Command residual | command palette dialog transition -> renderer invalidation -> frame capture | existing renderer/output frame owner; smoke harness | compiled target-liveness transition is the required public surface seam; no command-palette state change is authorized |

The native Windows writer remains a reachable compatibility risk but is excluded because current evidence does not prove it is the first divergence for this incident. A future native repair requires a separate real-console reproduction and native test boundary; R54 does not silently treat it as fixed.

### R54 Invariants

| ID | Behavioral invariant | Owner | Required evidence |
| --- | --- | --- | --- |
| R54-INV-01 | Render-body exception, native failed frame, and no-feed unexpected skip retain one public invalidation, do not self-retry from clock advancement, and recover after one explicit public `requestRender()`. | `renderer.ts` | public scheduler red/green tests |
| R54-INV-02 | Feed-backed `retryable-skip` and process-stdout `backpressured` preserve their existing transport behavior only. | `renderer.ts` | existing feed/backpressure tests |
| R54-INV-03 | Every persistent Markdown CodeRenderable update shows the current representation while replacement highlighting is pending. | `Markdown.ts` | list/paragraph, non-list, and incomplete-table public tests |
| R54-INV-04 | Every messageId request settles once through its correlated response channel. | verification-only worker/client | current correlated-error and full client suite |
| R54-INV-05 | Each buffer has one accepted Tree owner; accepted replacement deletes the previous owner and failed candidate preserves it. | verification-only parser worker | repeated edit/stream/reset lifecycle |
| R54-INV-06 | Mutation rejection settles only itself; later same-buffer mutation posts and disposal waits for its correlated ack. | verification-only client | delayed ordering/rejection recovery |
| R54-INV-07 | Destroyed cancellation is silent while live worker failure remains diagnosable once. | verification-only Code/client | held real request and shutdown smoke |
| R54-INV-08 | Dialog replacement/clear commits the current surface with no stale Commands, background fragment or old body. | renderer frame owner/smoke | compiled target-liveness PTY capture |

### R54 Primary Path and Failure Matrix

```text
render failure -> diagnostic + retained public invalidation -> no self-retry
               -> next public requestRender() -> existing frame commit
Markdown token -> representation-preserving current seed -> CodeRenderable
               -> pending highlight -> accepted highlight
existing worker/client repair -> correlated response -> accepted Tree/mirror -> Code contract
dialog replace/clear -> existing state transition -> renderer invalidation -> current surface frame
```

| Status/path | Required behavior | Test disposition |
| --- | --- | --- |
| render-body exception | no clock-only second frame; next public request commits | rewrite current assertion |
| native `failed` | no clock-only second frame; next public request commits | rewrite current assertion |
| `SKIPPED` with feed | existing feed-idle `retryable-skip` behavior | preserve |
| `SKIPPED` without feed | failed-frame contract: no clock-only retry; next public request commits | rewrite unexpected-skip assertion |
| process-stdout/thread `backpressured` | existing transport backpressure behavior | preserve |

No alternate success path is added. Retry is permitted only for the two existing transport contracts in the matrix. A current worker/client/Code verification failure stops implementation and requires a new revision; it cannot authorize duplicate production logic or a fallback.

### R54 Markdown Seed Matrix

Every call to `applyMarkdownCodeRenderable()` on a persistent CodeRenderable must pass a seed for the same current content:

| Representation | Seed rule | Required test |
| --- | --- | --- |
| paragraph/list/blockquote/inline token | `createInitialStyledText(token)` from current inline/text tokens | current list/paragraph token visible while highlight is held |
| incomplete table fallback | seed derived from the exact `tableToken.raw` already assigned to `CodeRenderable.content`; no empty/default seed | exact raw table fragment visible while highlight is held |
| other structured token | current token text/raw representation, preserving eventual highlighted content | representative non-list/non-table current content visible |

The helper may centralize representation-preserving seed construction. It may not enable permanent unstyled success, create a second renderer, or change the eventual highlighted content. The table case is reachable because `buildTableContentCache()` returns `cache: null` for incomplete input and both persistent fallback callers reuse `tableToken.raw`.

### R54 Existing-Repair Verification Boundary

The current worker/client/parser/Code changes are verification-only in R54. They are not new proposed production concepts because current source already contains the corresponding owners. The implementation sequence must run their public tests after any approved scheduler/Markdown change. If any current verification fails, stop and create a new plan revision identifying the remaining bypass; do not add defensive branches.

### R54 Exact File Boundary and Cleanup Gate

Exactly eight final code files are authorized:

| Category | Files |
| --- | --- |
| Production (5) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` |
| Regression/harness (3) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`types.ts` is not authorized. Before implementation-audit evidence, its existing worktree diff must be removed through the approved cleanup path or a new evidence-based revision must explicitly prove it necessary. No ninth file, native output/test file, Markdown test file, command-palette production file, daemon/SSE file, generated/config file, migration or release file is authorized.

### R54 Traceability

| Requirement/invariant | Owner/path | File | Test/evidence |
| --- | --- | --- | --- |
| R54-INV-01 | retained invalidation and public request recovery | `renderer.ts` | scheduler red/green test and compiled smoke |
| R54-INV-02 | existing feed/backpressure contracts | `renderer.ts` | preserved renderer tests |
| R54-INV-03 | current representation seed | `Markdown.ts` | three public Markdown cases in `client.test.ts` |
| R54-INV-04..07 | existing correlated lifecycle owners | `client.ts`, `parser.worker.ts`, `Code.ts` | current client suite and shutdown smoke |
| R54-INV-08 | current frame owner | `renderer.ts`, smoke | target Commands/background/body transition |

| Proposed concept | Requirement | Why existing logic cannot carry it |
| --- | --- | --- |
| failure-frame invalidation retention without self-retry | R54-INV-01 | current failure cleanup schedules its own next frame |
| current Markdown token seed for each persistent representation | R54-INV-03 | current update callers set `drawUnstyledText=false` without a current seed |
| rewrite contradictory scheduler tests | R54-INV-01/02 | current tests encode clock-only retry for failure paths |
| three-case Markdown regression | R54-INV-03 | current test only proves previous text, not current/table fallback text |

### R54 Verification Contract

All tests and smoke processes run under an external PowerShell process-tree supervisor: 120-second overall deadline and 10-second readiness/transition deadlines. A hang is a failed verification result.

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/tests/renderer.custom-stdout.test.ts
  bun typecheck
  bunx oxfmt --check src/renderer.ts src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts

repository root:
  bun run build
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

The compiled smoke must correlate Session/project/message/part/field identity, independently observe Thinking and body sentinels, open `Commands`, close it with Escape, require current background/body cells after restoration, and require zero expected `TreeSitter client destroyed`, `Code highlighting failed` and `Code streaming highlight failed` shutdown lines.

### R54 Diff and Chinese Comment Gate

```text
E = added or substantively modified non-blank lines in production, tests and configuration,
    excluding import-only, formatter-only, generated and pure-move lines
C = adjacent qualifying Chinese explanatory-comment lines explaining an invariant,
    real boundary, test intent, compatibility contract, constant or safety constraint
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

Planned new production ceilings are `renderer.ts <=100` and `Markdown.ts <=25`; existing authorized additions are approximately `client.ts +201`, `parser.worker.ts +240`, `Code.ts +4`, `renderer.ts +10`, with `types.ts +16` excluded only after cleanup. The plan estimate remains below 800 production effective lines and eight code files. Each changed production file with `E_i > 0` must independently satisfy the same 15 percent minimum. Comments must be adjacent to scheduler ownership, Markdown/table seed, or verified lifecycle invariants; obvious-flow comments and identifier translations do not count. Final implementation evidence must recalculate actual `E/C`, exclusions, ratio and representative qualifying comments.

### R54 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| New window 1 | R53 | yes | B-01 self-contained authority; B-02 missing smoke gate; B-03 missing file/budget/comment gates | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| New window 2 | R54 | yes | No blocking findings | APPROVE | `ses_0217852c3ffeS02X0C1vIlbmSy` |

## R53 and Earlier Historical Trace

## R53 Current Authority

R53 inherits the complete R52 design without behavior changes. The user granted a fresh final six-round independent plan-audit window after R52 exhausted the previous window. R53 removes the stale “no further audit round” condition and remains `audit-required`, `Approved revision: none`, `Implementation allowed: no` until this exact revision receives `No blocking findings` and `APPROVE`.

### R53 Pre-Audit Verification

The current baseline was re-run under external process-tree deadlines immediately before audit handoff:

| Command | Result | Meaning |
| --- | --- | --- |
| `bun test ./src/tests/renderer.custom-stdout.test.ts` | `46 pass / 0 fail / 129 expect()` in 2.40s | current scheduler suite is stable, but still encodes automatic failure retry that R52/R53 must replace |
| `bun test ./src/renderables/__tests__/Markdown.test.ts` | `156 pass / 0 fail / 91 snapshots / 383 expect()` in 6.06s | current Markdown suite is stable, but its streaming list test only requires previous text and does not prove current-token visibility |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `53 pass / 0 fail / 388 expect()` in 15.36s | current correlated settlement, Tree ownership, queue/disposal and destroyed-cancellation paths are verification-only and green |

Current source inspection also confirms:

- `renderer.ts` still calls `requestRender()` from the failure cleanup when `immediateRerenderRequested` is set.
- The renderer test suite still expects clock-only retry for native failure and unexpected no-feed skip.
- `Markdown.ts` list/table persistent update callers still omit a representation-preserving current seed.
- `types.ts` still has an excluded worktree diff even though current protocol types already carry the required correlated identifiers.

### R53 Audit Window

| New-window round | Revision | Full scope? | Result | Invocation |
| --- | --- | --- | --- | --- |
| 1 | R53 | yes | pending independent full-scope plan audit | - |
| 2-6 | future only if a policy-supported blocker requires revision | yes | not started | - |

## R53 Historical Trace

## R52 Current Authority

R52 supersedes R51 after the sixth authorized independent plan-audit round. It records the normative Chinese-comment gate, makes the incomplete-table regression explicit, and turns the `types.ts` cleanup into a pre-implementation prerequisite. No further audit round is available in the current authorization window; R52 remains `audit-required` and does not authorize implementation.

### R52 Mandatory Comment and Diff Gate

The policy definition is normative for this revision:

```text
E = added or substantively modified non-blank lines in production, tests and configuration,
    excluding import-only, formatter-only, generated and pure-move lines
C = qualifying adjacent Chinese explanatory-comment lines that explain an invariant,
    real boundary, test intent, compatibility contract, constant or safety constraint
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

R52 production ceilings remain `renderer.ts <=100` new effective lines and `Markdown.ts <=25` new effective lines. Existing current-worktree additions are approximately `client.test.ts +210`, `client.ts +201`, `parser.worker.ts +240`, `types.ts +16`, `Code.ts +4`, `renderer.ts +10`, `renderer.custom-stdout.test.ts +55`, and root smoke `+266`; the final report must recalculate actual `E/C` rather than treating these raw additions as final evidence. The final production effective total must remain below 800 and the final code-file count must remain at most eight.

Qualifying comments must be adjacent to the scheduler failure-owner decision, current Markdown/table seed representation, or the verified Tree-sitter/Code lifecycle invariant. Chinese translations of identifiers, obvious-flow comments, test-name repetition, and concentrated header comments do not count. Each changed production file with `E_i > 0` must independently satisfy `C_i >= max(1, ceil(E_i*0.15))`.

### R52 Explicit Regression and Cleanup Preconditions

The authorized renderer test changes must enumerate and rewrite every clock-only failure retry assertion, including render-body failure, native failed frame, unexpected no-feed skip, and any split-footer/native-failure variant. Only feed-backed `retryable-skip` and existing process-stdout `backpressured` transport behavior remain automatic contracts.

The Markdown regression matrix must include three public boundary cases: a persistent list/paragraph update, a persistent non-list/non-table update, and an incomplete-table fallback whose expected pre-highlight text equals the exact current `tableToken.raw` passed to `CodeRenderable.content`. The implementation may centralize seed construction but may not use an empty/default seed for the table case.

Before any implementation-audit evidence is submitted, the existing `types.ts` worktree diff must be removed using the approved cleanup path or independently proven necessary by a current reachable protocol failure. Because R52 does not authorize `types.ts`, an implementation containing that diff cannot pass the eight-file gate.

### R52 Status and Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | B-01 unproven native root; B-02 non-selecting native filter; B-03 missing normative budget | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 5 | R48 | yes | B-01..B-03 already-repaired Tree-sitter/Code paths | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 6 | R49 | yes | B-01 contradictory automatic-retry tests | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 7 | R50 | yes | B-01 table fallback seed; B-02 no-feed skipped status | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 8 | R51 | yes | B-01 missing current-revision comment gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 9 | R52 | yes | audit unavailable: authorized six rounds exhausted | not started | - |

## R52 Historical Trace

## R51 Current Authority

R51 supersedes R50 after the independent re-audit. It adds the reachable incomplete-table fallback to the Markdown current-seed contract and explicitly classifies the no-feed unexpected-skip scheduler branch.

### R51 Markdown Current-Seed Contract

Every persistent Markdown `CodeRenderable` update covered by `applyMarkdownCodeRenderable()` must provide a visible seed representing the same current content that the renderable is already configured to highlight:

| Caller representation | Current seed | Required regression |
| --- | --- | --- |
| paragraph/list/blockquote/inline token | `createInitialStyledText(token)` from current inline/text tokens | current token remains visible during held highlight |
| incomplete-table fallback | a seed from `tableToken.raw`, using the same raw content already passed as `CodeRenderable.content` | raw current table fragment remains visible while table highlighting is held |
| other structured Markdown token with a persistent CodeRenderable | the token's existing text/raw representation, without changing the eventual highlighted content | representative non-list/non-table update remains visible |

The helper may centralize this representation-preserving seed construction, but it must not synthesize a second renderer or permanently enable unstyled success. The table path is reachable because `buildTableContentCache()` returns `cache: null` for a streaming/incomplete table and both persistent fallback callers then invoke `applyMarkdownCodeRenderable()` with `tableToken.raw`.

### R51 Scheduler Failure Matrix

R51 classifies every current scheduler status that is not the existing feed backpressure contract:

| Status/path | R51 behavior | Existing assertion disposition |
| --- | --- | --- |
| render-body exception | retain invalidation; no clock-only retry; later public `requestRender()` commits | rewrite |
| native `failed` | retain invalidation; no clock-only retry; later public `requestRender()` commits | rewrite |
| `NATIVE_RENDER_STATUS_SKIPPED` with feed | preserve `retryable-skip` feed-idle backpressure path | preserve |
| `NATIVE_RENDER_STATUS_SKIPPED` without feed | classify as failed for scheduler ownership; retain invalidation; no clock-only retry; later public request commits | rewrite `unexpected skip without a feed` |
| native backpressure with process stdout/thread | preserve existing `backpressured` transport path, not a render-failure success path | preserve only its existing transport contract |

The production owner remains `renderer.ts`; the failure branches share one retained-invalidation operation and do not call `requestRender()` from `finally`. The test suite must issue an explicit public request in recovery assertions. Clock advancement alone is a negative assertion for all three failure forms.

### R51 Exact Scope, Baseline and Verification

The final boundary remains exactly eight code files: production `renderer.ts`, Tree-sitter `client.ts`, Tree-sitter `parser.worker.ts`, `Code.ts`, `Markdown.ts`; regression files `client.test.ts`, `renderer.custom-stdout.test.ts`; and the root `smoke-opentui-artifact.ts`. `types.ts` remains excluded and its existing diff must be removed or proven necessary before implementation audit. No native output, Markdown test, command-palette, daemon/SSE, generated/config or release file is changed.

The current pre-R51 nested additions are `client.test.ts +210`, `client.ts +201`, `parser.worker.ts +240`, `types.ts +16`, `Code.ts +4`, `renderer.ts +10`, `renderer.custom-stdout.test.ts +55`; root smoke is `+266`. New production additions remain capped at `renderer.ts <=100` and `Markdown.ts <=25`, with final effective `E/C` recomputed from the actual diff. The type diff is not counted in the final boundary unless a later evidence-based revision authorizes it.

Normative commands:

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/tests/renderer.custom-stdout.test.ts
  bun typecheck
  bunx oxfmt --check src/renderer.ts src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts

repository root:
  bun run build
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

All tests and smoke commands run under the existing external PowerShell process-tree supervisor with a 120-second overall deadline and 10-second readiness/transition deadlines. The smoke must match Session/project/message/part/field identity, observe Thinking/body sentinels, verify Commands open/close and current background/body cells, and require zero expected shutdown Tree-sitter warnings.

### R51 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | B-01 unproven native root; B-02 non-selecting native filter; B-03 missing normative budget | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 5 | R48 | yes | B-01..B-03 already-repaired Tree-sitter/Code paths | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 6 | R49 | yes | B-01 contradictory automatic-retry tests | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 7 | R50 | yes | B-01 table fallback seed; B-02 no-feed skipped status | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 8 | R51 | yes | pending independent full-scope plan audit | not started | - |

## R51 Historical Trace

## R50 Current Authority

R50 supersedes R49 after the independent re-audit. It explicitly replaces the existing failure-frame self-retry test contract and broadens the Markdown visibility repair to every confirmed persistent Markdown CodeRenderable update caller, without adding a second rendering path.

### R50 Scheduler Contract

The existing `renderer.custom-stdout.test.ts` failure assertions that expect a clock-only automatic retry are superseded and must be rewritten, not retained or skipped:

| Existing path | R50 test contract | Disposition |
| --- | --- | --- |
| render-body exception | after the injected failure, no second frame may occur from clock advancement alone; one explicit public `requestRender()` must commit the next frame | rewrite existing assertion |
| native `failed` frame | same no-clock-only-retry and one-public-request recovery contract | rewrite existing assertion |
| feed backpressure `retryable-skip` | preserve the existing transport/backpressure retry contract because it is not a render failure and is already part of the feed interface | preserve existing assertion |

The production owner remains `renderer.ts`: retain one pending public invalidation, do not call `requestRender()` from the failure frame, and let the next public request consume the owner through the existing activation path. This is a direct replacement of the current competing test semantics, not a new fallback.

### R50 Markdown Contract

The visibility invariant applies to every current persistent Markdown CodeRenderable update that calls `applyMarkdownCodeRenderable`, not only list children. The implementation must audit and pass the current token's styled seed at the existing update callers, including list children, blockquotes, tables and the other structured update paths at `Markdown.ts:999`, `1698`, `1734`, `2067` and `2099`, where the token/state is already available. The helper remains one primary update path; no permanent plain-text branch is added. The public regression in `client.test.ts` must cover at least one list update and one non-list persistent update while highlighting is held.

### R50 Current-Worktree Baseline and File Boundary

The current nested OpenTUI diff before R50 implementation contains:

```text
client.test.ts       +210/-0
client.ts            +201/-180
parser.worker.ts     +240/-163
types.ts             +16/-7
Code.ts              +4/-2
renderer.ts          +10/-1
renderer.custom...   +55/-20
```

The repository-root smoke harness contains `+266/-6`. `Markdown.ts` currently has no task diff. R50 authorizes exactly eight final code files: the five production files `renderer.ts`, Tree-sitter `client.ts`, Tree-sitter `parser.worker.ts`, `Code.ts`, `Markdown.ts`; the two nested regression files `client.test.ts` and `renderer.custom-stdout.test.ts`; and `packages/opencode/script/smoke-opentui-artifact.ts`. The obsolete `types.ts` worktree diff must be removed or independently proven necessary before implementation-audit approval; it is not an authorized final file. This produces seven nested files plus one root harness file, not nine.

The existing client/parser/Code production changes are verification-only unless a current red test proves a remaining bypass. The new R50 production changes are limited to `renderer.ts` scheduler semantics and `Markdown.ts` current-token seeds.

### R50 Verification and Budget

The normative commands are unchanged from R49, with the renderer formatter path included:

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/tests/renderer.custom-stdout.test.ts
  bun typecheck
  bunx oxfmt --check src/renderer.ts src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts

repository root:
  bun run build
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

All test/smoke processes use the external PowerShell process-tree supervisor with a 120-second overall deadline and 10-second readiness/transition deadlines. The smoke must independently match Session/project/message/part/field identity, observe Thinking and body sentinels, open/close `Commands`, prove the body/background frame after Escape, and require zero expected destroy-warning lines.

R50 new effective production ceiling is `<=125` lines (`renderer.ts <=100`, `Markdown.ts <=25`). Under the policy definition of `E` as added or substantively modified non-blank lines, the current production additions are approximately `client.ts 201`, `parser.worker.ts 240`, `Code.ts 4`, `renderer.ts 10`; the planned Markdown addition is at most 25, for an estimated production `E <=480` before exclusions. Deleted lines are not counted as new `E`, but the final implementation report must state all exclusions. The final total must remain below 800. Every changed production file with `E_i > 0` must satisfy `C_i >= max(1, ceil(E_i*0.15))`; final `E/C` is recomputed from the actual diff. The `types.ts` diff is excluded only after it is removed or proven necessary.

### R50 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | B-01 unproven native root; B-02 non-selecting native filter; B-03 missing normative budget | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 5 | R48 | yes | B-01..B-03 already-repaired Tree-sitter/Code paths | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 6 | R49 | yes | B-01 contradictory automatic-retry tests | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 7 | R50 | yes | pending independent full-scope plan audit | not started | - |

## R50 Historical Trace

## R49 Current Authority

R49 supersedes R48 after the independent re-audit reconciled the plan with the current worktree. The Tree-sitter worker/client response correlation, accepted Tree ownership, same-buffer tail recovery, disposal ordering and destroyed-Code classification are already present in the current source and are not new production concepts for R49. R49 does not duplicate those repairs. They remain mandatory verification subjects because they are part of the original user-visible failure and are present in the existing worktree diff.

### Requirement and Remaining First Divergences

The original requirement remains unchanged: prevent OpenCode TUI liveness loss, blank Thinking/body content, command-surface residue, permanent Tree-sitter pending, persistent Tree leaks, mutation/dispose overlap and Ctrl+C warning flood, without unrelated changes, fallback/retry architecture, major refactor, more than eight code files or more than 800 production effective lines.

Current-source reconciliation leaves two production first divergences that still require repair:

| ID | First divergence | Owner | Current evidence |
| --- | --- | --- | --- |
| R49-INV-01 | a render-body exception or native `failed` frame clears the future public frame owner, leaving a live renderer with no scheduled next frame; the failure path must not self-retry | `renderer.ts` `CliRenderer` scheduler | bounded throwing-renderable/native-failure probe and existing scheduler path |
| R49-INV-02 | an existing persistent Markdown CodeRenderable update omits the current token's `initialStyledText` while replacement highlighting is pending, so the current body can disappear or remain stale until the async request settles | `Markdown.ts` structured update seam | local `Markdown.ts:876-878` and upstream `98e390189`; current local test only asserts previous text and therefore is not a sufficient red test |

The following existing worktree paths are verification-only for R49, not new repair concepts: `client.ts`/`parser.worker.ts` correlated settlement and Tree lifecycle, `Code.ts` destroyed classification, and their current regression assertions. If verification disproves those existing repairs, implementation must stop and create a new revision rather than silently broadening R49.

The native `renderer-output.zig` generic Windows writer remains a reachable compatibility risk, but no current evidence proves it is the first divergence for this incident. R49 therefore makes no native change and does not use it as a fallback or claim it is fixed. A future native repair requires its own real-console reproduction and native test boundary.

### R49 Primary Path

```text
render failure -> existing diagnostic + retained public invalidation -> no self-retry -> next public requestRender -> frame commit
Markdown token update -> current token styled seed -> existing CodeRenderable -> pending highlight -> accepted highlight
existing Tree-sitter repairs -> correlated response -> accepted Tree/mirror commit -> existing Code contract
dialog replace/clear -> existing state transition -> renderer invalidation -> current surface frame commit
```

No alternate success path is added. There is no retry, timeout-success, second parser, renderer restart, watchdog, permanent plain-text mode or native-output fallback.

### R49 Exact File Boundary

Exactly eight code files are authorized for the final current-worktree repair/audit boundary:

| Category | Files |
| --- | --- |
| Production (5) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` |
| Regression/harness (3) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`types.ts` is not an authorized R49 file because current type definitions already carry the relevant correlated message IDs. Its existing worktree change must be removed or proven necessary before implementation-audit approval; no new type protocol is added. `renderer-output.zig`, Markdown test files, command-palette production files, daemon/SSE/SyncProvider files, native test files, generated/config files and release files are not changed.

### R49 Forward and Reverse Traceability

| Requirement/invariant | Production path | Planned or verified file | Behavioral evidence |
| --- | --- | --- | --- |
| R49-INV-01 scheduler remains recoverable without retry | retained invalidation and public `requestRender()` | `renderer.ts` | throwing-renderable public-request red/green test |
| R49-INV-02 current Markdown body remains visible during pending highlight | current-token styled seed on persistent update | `Markdown.ts` | strengthened public Markdown/renderer test in `client.test.ts` |
| worker request settles exactly once | existing correlated response channel | `client.ts`, `parser.worker.ts` verification-only | current correlated-error and lifecycle tests |
| accepted Tree has one owner | existing commitCandidate owner transition | `parser.worker.ts` verification-only | repeated edit/stream/reset and failed-candidate tests |
| rejected tail/disposal remains ordered | existing per-buffer queue | `client.ts` verification-only | delayed mutation/disposal tests |
| destroyed cancellation is silent | existing Code lifecycle classification | `Code.ts` verification-only | held real request shutdown test |
| command replacement commits current surface | renderer invalidation/frame capture | `renderer.ts`, smoke | compiled target surface transition |

| Proposed concept | Requirement | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| retain scheduler invalidation without failure-frame self-scheduling | R49-INV-01 | current renderer red probe | current failure branches clear the future owner and do not expose a consumable public invalidation |
| pass current Markdown styled seed during persistent update | R49-INV-02 | upstream diff and local call path | current update call omits the seed while `drawUnstyledText` remains false during streaming |
| strengthen current-worktree lifecycle tests | original Tree-sitter/Code requirements | existing implementation plus current regression seams | existing repairs need behavior verification, but no new production logic is justified unless a test reopens a divergence |

### R49 TDD and Verification Contract

| Slice | Red | Green |
| --- | --- | --- |
| Scheduler | public `requestRender()` test injects render-body failure, asserts no automatic second frame, then issues one new public request and asserts a committed frame | retained invalidation is consumed only by the next public request |
| Markdown visibility | public Markdown/renderer test holds highlighting, updates a structured item, and requires current token text before resolve | update passes `createInitialStyledText(token)` and current content remains visible |
| Existing lifecycle verification | current correlated-error, Tree ownership, rejected-tail, disposal and destroyed-cancellation tests run against the worktree | all pass; any failure stops the route and requires a new plan revision, not a fallback branch |
| Command surface | compiled target transition leaves Commands/background stale | next visible frame has current background/body and no stale Commands |

Normative bounded commands:

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/tests/renderer.custom-stdout.test.ts
  bun typecheck
  bunx oxfmt --check src/renderer.ts src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts

repository root:
  bun run build
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

All test/smoke processes run under the existing external PowerShell process-tree supervisor with a 120-second overall deadline and 10-second readiness/transition deadlines. The compiled smoke must correlate Session/project/message/part/field identity, independently observe Thinking/body, exercise `Ctrl+P`/Escape surface replacement, and require zero expected shutdown Tree-sitter warning lines.

### R49 Budget and Chinese Comment Gate

Only two production files are authorized for new effective implementation lines: `renderer.ts <=100` and `Markdown.ts <=25`. Existing worktree changes in `client.ts`, `parser.worker.ts` and `Code.ts` are not expanded; their actual effective lines and comments must still be counted in final implementation evidence. The final total production effective lines across the entire eight-file boundary must remain below 800, and each production file with `E_i > 0` must satisfy `C_i >= max(1, ceil(E_i*0.15))`. Qualifying Chinese comments explain only nearby scheduler ownership, current-token visibility, or verified existing lifecycle invariants; final `E/C` and exclusions are mandatory.

### R49 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | B-01 unproven native root; B-02 non-selecting native filter; B-03 missing normative budget | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 5 | R48 | yes | B-01..B-03 already-repaired Tree-sitter/Code paths | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 6 | R49 | yes | pending independent full-scope plan audit | not started | - |

## R49 Historical Trace

## R48 Current Authority

R48 supersedes R47 after the independent re-audit. R47's native-output findings are resolved by removing the unproven native production concept from this repair rather than authorizing an unrelated native change without a user-visible first-divergence proof.

### Requirement and Evidence-Bounded Scope

The original requirement remains unchanged: repair Windows OpenCode TUI rendering/interaction loss, blank Thinking/body content, command-surface residue, Tree-sitter worker permanent pending, persistent Tree leaks, mutation/dispose overlap and Ctrl+C warning flood, while avoiding unrelated modifications, fallback/retry architecture, major refactoring, more than eight code files, or more than 800 production effective lines.

R48 includes only production paths with direct red-capable evidence for the reported behavior:

1. `CliRenderer` render-body/native-failure future-frame ownership can become a live renderer with no scheduled public owner; the public scheduler seam is repaired without self-retry.
2. Tree-sitter worker errors can leave a correlated request pending forever; the existing worker/client response channel is repaired.
3. Persistent Tree replacement leaks the old WASM owner; the accepted Tree owner is repaired in the parser worker.
4. Same-buffer mutation/disposal ordering and rejected-tail recovery are repaired in the existing client queue owner.
5. Destroyed Code cancellation is classified before warning; live errors remain diagnostic.
6. Persistent Markdown updates can clear the current visible token while replacement highlighting is pending; `initialStyledText` is preserved at the existing Markdown update seam.

The native `renderer-output.zig` path is recorded as reachable compatibility risk only. Current evidence proves that the generic Windows writer exists and that upstream `a597e88...` supplies a plausible Windows-console repair, but does not prove that this path is the first divergence for the user's TUI freeze rather than the independently reproduced JS scheduler dead state. Under the no-speculation gate, R48 makes no native production or native-test change. A future native plan requires a real Windows-console reproduction and a reconciled native-test file boundary; it is not silently hidden as a fallback here.

### R48 Invariants and First Divergence

R48 retains the confirmed Tree-sitter, Code, scheduler, command-surface and Markdown invariants from R46 as `R48-INV-01` through `R48-INV-08`, with the following owner mapping:

| ID | First divergence | Owner | Red-capable evidence |
| --- | --- | --- | --- |
| R48-INV-01 | render-body/native failure clears the future public frame owner instead of retaining one pending invalidation | `renderer.ts` `CliRenderer` scheduler | bounded throwing-renderable probe and public request sequence |
| R48-INV-02 | worker terminal error omits request identity, so the client emits an event without settling the matching callback | `parser.worker.ts` + `client.ts` response channel | forced worker-error reproduction: `settled=pending` until destroy |
| R48-INV-03 | accepted persistent Tree is overwritten without deleting the old WASM owner | `parser.worker.ts` | fixed-length repeated lifecycle RSS reproduction |
| R48-INV-04 | rejected same-buffer mutation poisons the next operation and disposal can cross the in-flight mutation | `client.ts` per-buffer tail | delayed response ordering seam |
| R48-INV-05 | Code warns before classifying an expected destroyed-client rejection | `Code.ts` | held real one-shot/streaming request shutdown seam |
| R48-INV-06 | existing Markdown CodeRenderable update omits current token styled seed while the new highlight is pending | `Markdown.ts` persistent structured update | upstream `98e390189` diff plus public current-text test seam |
| R48-INV-07 | dialog replacement/clear reaches renderer invalidation but the next visible frame can retain stale surface cells | existing renderer frame owner | compiled target surface transition |
| R48-INV-08 | worker/client/renderer repairs must remain bounded and one-path | all authorized owners | exact-file diff, no-fallback audit and bounded smoke |

### R48 Primary Path

```text
public requestRender -> existing scheduler owner -> frame commit
worker request -> correlated terminal response -> matching Promise settlement -> accepted Tree/mirror commit -> Code contract
Markdown token update -> current token styled seed -> existing CodeRenderable -> pending highlight -> accepted highlight
dialog replace/clear -> existing state transition -> renderer invalidation -> current surface frame commit
```

No alternate success path is added. There is no retry, timeout-success, second parser, renderer restart, watchdog, permanent plain-text mode or native-output fallback. Native output remains unchanged because its first divergence is not established for this incident.

### R48 Exact File Boundary

Exactly seven code files are authorized:

| Category | Files |
| --- | --- |
| Production (5) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` |
| Regression/harness (2) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`types.ts`, `renderer-output.zig`, `renderer.custom-stdout.test.ts`, Markdown test files, command-palette production files, daemon/SSE/SyncProvider files, native test files, generated/config files and release files are not changed in R48.

### R48 Reverse Traceability

| Proposed production concept | Requirement/invariant | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| pending scheduler invalidation without self-retry | R48-INV-01 | throwing-renderable probe | current failure exits clear the future owner and do not expose a consumable public invalidation |
| correlated worker terminal response | R48-INV-02 | pending callback reproduction | event-only generic error cannot settle a request Promise |
| accepted Tree replacement deletion | R48-INV-03 | repeated fixed-length lifecycle RSS | current assignment loses the old WASM owner |
| recoverable per-buffer operation tail | R48-INV-04 | delayed mutation/disposal sequence | independent completion paths allow rejected mutation to poison or cross disposal |
| destroyed-before-warning classification | R48-INV-05 | held request shutdown | current Code catch logs before lifecycle classification |
| current-token `initialStyledText` seed | R48-INV-06 | upstream `98e390189`, local Markdown call path | current persistent update calls `applyMarkdownCodeRenderable` without the current token seed |
| exact command-surface smoke identity | R48-INV-07 | target-liveness surface transition | source inspection alone cannot prove the committed visible frame |

### R48 TDD and Verification Contract

| Slice | Red | Green |
| --- | --- | --- |
| Markdown visibility | public Markdown/renderer test in `client.test.ts` holds highlighting, updates a structured item, and requires current token text before resolve | update passes `createInitialStyledText(token)` and current content remains visible |
| Scheduler | public `requestRender()` test injects a render-body failure, asserts no automatic second frame, then issues one new public request and asserts a committed frame | retained invalidation is consumed only by the next public request |
| Worker settlement | correlated ERROR leaves request pending | current request rejects once and later request posts |
| Tail recovery | rejected mutation poisons later operation or disposal crosses it | later edit/stream/reset posts in order and disposal waits for its own ack |
| Tree ownership | repeated edit/stream/reset loses accepted state or leaks owner | accepted replacement deletes only the prior owner and failed candidate preserves it |
| Cancellation | held real Code request prints destroy warnings | expected destroyed cancellation is silent and live worker failure remains diagnostic |
| Command surface | Commands/background remains after replace/clear | next compiled visible frame has current background/body and no stale Commands |

Normative bounded verification commands:

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun typecheck
  bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts

repository root:
  bun run build
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

Both compiled smoke commands run under the existing external PowerShell process-tree supervisor with a 120-second overall deadline and 10-second readiness/transition deadlines. The smoke must correlate Session/project/message/part/field identity, independently observe Thinking/body, exercise `Ctrl+P`/Escape surface replacement, and require zero expected shutdown Tree-sitter warning lines. The complete client test also runs only under the external process-tree deadline; a hang is a failed verification result.

### R48 Budget and Chinese Comment Gate

| Production file | Effective-line ceiling `E_i` | Minimum qualifying comments `C_i` |
| --- | ---: | ---: |
| `renderer.ts` | 100 | 15 |
| `client.ts` | 170 | 26 |
| `parser.worker.ts` | 200 | 30 |
| `Code.ts` | 25 | 4 |
| `Markdown.ts` | 25 | 4 |
| **Total** | **520** | **per-file minimum, 79 total** |

`E` excludes imports, formatting-only changes, generated lines, pure moves and comment-only lines. Each qualifying Chinese comment must explain a nearby scheduler ownership, response correlation, Tree ownership/deletion, tail recovery, lifecycle cancellation, or current-token visibility invariant; assignment restatements do not count. Final implementation evidence must recompute actual `E_i`, `C_i`, ratio and exclusions. R48 remains below the user's 800-line production limit and seven code files remain below the eight-file limit.

### R48 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | B-01 unproven native root; B-02 non-selecting native filter; B-03 missing normative budget | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 5 | R48 | yes | pending independent full-scope plan audit | not started | - |

## R48 Historical Trace

## R47 Current Authority

R47 supersedes R46 after the independent plan audit. The audit's B-01 is resolved by making the Windows stdout ownership and release gate unconditional rather than conditional.

### Requirement and Root-Cause Decision

The original requirement remains unchanged: repair the Windows OpenCode TUI's loss of rendering/interaction, blank Thinking/body content, command-surface residue, Tree-sitter pending/leak/disposal/shutdown defects, and shutdown warning flood, with no unrelated behavior, no fallback/retry architecture, no major refactor, at most eight code files, and production effective changes below 800 lines.

The confirmed native owner is:

```text
OpenCode default process.stdout
 -> OpenTUI BufferedBackend.createStdout
 -> renderer writeOut/native frame output
 -> renderer-output.zig generic stdout writer
```

On Windows the current native owner uses the generic byte writer for a console handle and ignores write/flush failure. Upstream `a597e88fb0a9a3704c0d487fbcc9e1cde3c64377` supplies the owner-local compatibility repair: detect a real console with `GetConsoleMode`, convert UTF-8 chunks to UTF-16, and use `WriteConsoleW`; redirected output remains byte-preserving. R47 therefore treats this as an unconditional Windows owner repair, not a conditional hypothesis. The separate scheduler red probe still proves the JS future-frame dead state, and the Tree-sitter/Markdown seams prove the independent blank-body paths. No single symptom is used to hide another confirmed first divergence.

R47 removes the R46 wording that permitted an unavailable-console result to remain merely `unverified`. A native console test must either execute the real Windows-console branch and pass, or the implementation verification fails and cannot reach approval. The probe cannot claim that a physically unread pipe can display frames; it is retained only as a distinct output-stall diagnosis and regression boundary.

### R47 Invariants

R47 retains R46-INV-01 through R46-INV-08 and renames the output invariant to:

| ID | Behavioral invariant | Owner and release gate |
| --- | --- | --- |
| R47-INV-09 | Windows real-console output uses the console-safe writer; redirected file/pipe output remains byte-preserving. | `renderer-output.zig`; native test must execute the real console branch on Windows, and compiled Windows smoke must pass |

### R47 Primary Path and Scope

The single primary path is unchanged for scheduler, Tree-sitter and Markdown. The Windows output segment is now authoritative:

```text
real Windows console handle -> GetConsoleMode -> complete UTF-8 chunk conversion -> UTF-16 -> WriteConsoleW -> existing frame status
redirected output -> existing byte writer -> exact bytes
```

Exactly eight code files remain authorized: six production files (`renderer.ts`, Tree-sitter `client.ts`, Tree-sitter `parser.worker.ts`, `Code.ts`, `Markdown.ts`, `renderer-output.zig`) and two regression/harness files (Tree-sitter `client.test.ts`, `smoke-opentui-artifact.ts`). `types.ts`, `renderer.custom-stdout.test.ts`, Markdown test files, command-palette production files, daemon/SSE/SyncProvider files, native test files, generated/config files and release files remain out of scope. Renderer, Markdown, worker/client and native assertions are consolidated into the two authorized test/harness files without adding a ninth file.

### R47 TDD and Verification Contract

The Markdown regression is a new public renderer/Markdown boundary test in `client.test.ts`, not a claim that an existing `client.test.ts` expectation already covers it. It holds the highlight request, updates the persistent structured item, and independently asserts the current token text before resolving the highlight. The existing `Markdown.test.ts` result is evidence only and is not implementation authority.

Required bounded commands are normative for R47:

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun typecheck
  bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts src/renderables/Code.ts src/renderables/Markdown.ts
  bun run test:native -Dtest-filter="renderer-output"

repository root:
  bun run build
  bun run script/build.ts --target bun-windows-x64 --single --skip-install --skip-embed-web-ui
  git diff --check

packages/opencode:
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"
  bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe" --scenario target-liveness
```

The two compiled smoke commands must run under the existing external PowerShell process-tree supervisor with a 120-second overall deadline and 10-second per transition/readiness deadline. The native test is a release gate: on Windows it must open or attach a real `CONOUT$`/console handle, prove `GetConsoleMode`, exercise `WriteConsoleW`, and separately prove redirected byte preservation. If the execution environment cannot provide that handle, the native verification is failed/unavailable and implementation cannot be declared verified; it is not a green skip.

### R47 Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | B-01 conditional native ownership/release gate | BLOCK | `ses_0217852c3ffeS02X0C1vIlbmSy` |
| 4 | R47 | yes | pending independent full-scope plan audit | not started | - |

## R47 Historical Trace

## R46 Current Authority

### Requirement and Non-goals

修复Windows OpenCode TUI停止刷新/交互失效、正文和Thinking大面积空白、命令面板残影、Tree-sitter worker永久pending、persistent Tree泄漏、mutation/dispose重叠和Ctrl+C批量warning。禁止日志-only、常开未高亮正文、timeout-success、retry、second parser、renderer restart、watchdog、production telemetry、daemon/SSE猜测性修改和重大重构。代码文件最多8个，production effective lines低于800，保持一个primary path。

R46新增一项由上游差异和本地可执行测试共同定位的Markdown可见性要求：流式Markdown的持久化CodeRenderable在高亮请求尚未完成时，必须显示当前最新的token文本，而不是保留旧文本或只显示列表结构标记。该修复只补齐现有Markdown -> CodeRenderable更新调用的`initialStyledText`，不把未高亮纯文本设置为全局成功路径。

不修改stable-prefix Markdown算法、buffer.zig、native ABI、daemon/SSE/SyncProvider、版本、lockfile、generated artifact、发布流程或OpenCode命令面板状态逻辑。`drawUnstyledText=false`保持不变；Code的plain-text仅保留既有error compatibility。Windows native stdout修复只有在真实console owner证据能证明它属于当前用户症状时才允许保留；不可由未消费pipe probe单独授权。

### Evidence and First Divergence

| Area | Reachable path | First divergence/owner | Evidence |
| --- | --- | --- | --- |
| Blank body from worker failure | worker exception -> uncorrelated ERROR -> client callback pending -> `CodeRenderable` waits with `drawUnstyledText=false` | worker/client response channel | forced worker-error reproduction: pending callback remains until destroy |
| Blank/current Markdown body during streaming update | `Markdown.content` -> persistent structured child -> `applyMarkdownCodeRenderable` without `initialStyledText` -> `drawUnstyledText=false` while new highlight is pending | `Markdown.ts` existing-renderable update seam | local `Markdown.test.ts` currently asserts only previous text; upstream `98e390189` changes the same assertion to current text and passes `createInitialStyledText(token)` at the call site; current local `Markdown.ts:876-878` lacks that argument |
| Tree leak | persistent edit/stream/reset replaces WASM Tree | parser worker accepted Tree owner | source ownership path and fixed-length RSS reproduction |
| Mutation/dispose | same-buffer operations overlap and dispose mirror before ack | client per-buffer Promise tail | delayed worker-response ordering seam |
| Ctrl+C warnings | renderer destroys client while Code catches rejection | `Code.ts` destroyed classification | actual held one-shot/streaming request unit seam |
| TUI output stall | default OpenCode `process.stdout` -> `BufferedBackend` -> `StdoutOutput.write` -> native render thread | native stdout boundary only if real Windows console branch is reproduced; otherwise renderer scheduler remains separate | bounded unread-output probe proves a reachable blocked-output shape but not that a stopped pipe can display; upstream `a597e88...` is compatibility evidence, not sufficient root-cause proof |
| Command residual | `CommandPaletteProvider` -> `dialog.replace/clear` -> renderer invalidation -> native frame commit | existing renderer/output frame owner; no command-palette state change | source command-palette path, existing identity-based `Renderable.remove`, and compiled target surface transition |

The Markdown evidence is distinct from the worker pending defect: even when the worker request eventually settles, the persistent update path can make the current body invisible during the pending interval. The worker/client repair remains necessary for permanent pending; the Markdown repair owns the visible intermediate state and is not a fallback for worker failure.

### Invariants

| ID | Invariant | Owner and test |
| --- | --- | --- |
| R46-INV-01 | A render-body exception or native failed frame retains one pending public invalidation, does not automatically retry, and the next public `requestRender()` can commit the frame. | `CliRenderer`; public scheduler tests |
| R46-INV-02 | Every messageId request settles exactly once through its correlated response channel. | worker/client; real worker error test |
| R46-INV-03 | Each buffer owns exactly one accepted Tree; accepted replacement deletes the previous owner and failed candidate preserves it. | parser worker; repeated lifecycle test |
| R46-INV-04 | Mutation and disposal share one ordered tail; a rejected mutation settles only itself, later same-buffer mutation still posts, and disposal waits for prior settlement plus its own ack. | client; delayed ordering and rejection-recovery tests |
| R46-INV-05 | Worker rejection reaches the existing Code error contract and does not turn into an empty successful highlight. | worker/client/Code; visibility tests |
| R46-INV-06 | Destroyed cancellation is silent; live worker/parser failure remains diagnosable once. | Code/client; held real request test |
| R46-INV-07 | A persistent Markdown CodeRenderable displays the current token's styled text while its replacement highlight is pending. | `Markdown.ts`; strengthened current-text streaming test |
| R46-INV-08 | Dialog replacement/clear commits the current surface: no stale `Commands`, black fragment or old dialog remains in the next visible frame. | renderer/output frame owner; compiled PTY transition |
| R46-INV-09 | Windows real-console output uses the console-safe writer only when the real console branch is reached; redirected output remains byte-preserving. | `renderer-output.zig`; native/compiled evidence |

### Primary Path

```text
Markdown token update -> current token styled chunks -> existing CodeRenderable -> pending highlight -> accepted highlight
worker request -> messageId response -> matching Promise settlement -> accepted Tree/mirror commit -> existing Code contract
render failure -> diagnostic + pending invalidation -> no self-retry -> next public requestRender -> existing activateFrame
dialog replace/clear -> existing state transition -> renderer invalidation -> current surface frame commit
Windows real console handle -> GetConsoleMode -> UTF-8 chunks -> UTF-16 -> WriteConsoleW -> existing frame status
```

No alternate success path is added. The Markdown change is an input-preservation step in the existing primary update path, not an error fallback. Feed-backed `retryable-skip` remains its existing backpressure path and is not treated as native failure.

### Exact File Boundary

Exactly eight code files are authorized for R46:

| Category | Files |
| --- | --- |
| Production (6) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/renderables/Markdown.ts`; `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` |
| Regression/harness (2) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`types.ts` is not changed in R46; correlated wire shapes remain local to the existing client/worker transport owner. `renderer.custom-stdout.test.ts` is not changed; its renderer assertions are consolidated into the existing `client.test.ts` seam. The Markdown visibility regression is also added to `client.test.ts` through the public renderer/Markdown boundary, so no separate Markdown test file is authorized. No command-palette production file, daemon/SSE file, native test file or generated/config file is authorized.

### File-Level Change Plan

| File | Exact responsibility | Effective production delta |
| --- | --- | ---: |
| `thirdparty/opentui/packages/core/src/renderer.ts` | retain one pending public invalidation after render-body/native failure and remove failure-frame self-scheduling | <=100 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | correlate terminal worker responses and recover the same-buffer operation tail after a rejected mutation | <=170 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | return request identity on terminal errors and transfer/delete accepted Tree ownership exactly once | <=200 |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | classify destroyed cancellation before warning while preserving live failure diagnostics | <=25 |
| `thirdparty/opentui/packages/core/src/renderables/Markdown.ts` | pass current token styled seed when updating an existing persistent Markdown CodeRenderable | <=25 |
| `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` | repair only the proven real-Windows-console encoding/write branch; keep redirected byte output unchanged | <=80 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | public Markdown visibility, worker settlement, renderer scheduler, Tree lifecycle, disposal and cancellation regressions | test only |
| `packages/opencode/script/smoke-opentui-artifact.ts` | bounded normal/target Session, body/Thinking and command-surface correlation plus shutdown-warning assertions | test/harness only |

No production file is added for command-palette state, daemon/SSE, SyncProvider, or a second renderer path.

### TDD and Verification

| Slice | Red | Green |
| --- | --- | --- |
| Markdown visibility | through the public Markdown/renderer boundary in `client.test.ts`, strengthen the streaming structured-list expectation from previous text to current token text while highlight is pending; current update path clears the styled seed | existing renderable update passes `createInitialStyledText(token)` and current content remains visible until accepted highlight |
| Scheduler | failure test observes automatic retry or lost public owner | no clock-only retry; next public request renders |
| Worker settlement | correlated ERROR leaves request pending | current request rejects once and later request posts |
| Tail recovery | rejected mutation poisons later same-buffer operation | later edit/stream/reset posts and commits after correlated success |
| Tree ownership | repeated edit/stream/reset loses accepted state or leaks owner | repeated public lifecycle remains usable; failed candidate preserves prior state |
| Cancellation | held real Code/Tree-sitter request prints warning after destroy | zero expected destroy warnings |
| Command surface | Commands/background remains after replace/clear | next visible frame has current background/body and no stale Commands |
| Windows output | real console branch is absent or generic writer is used | native console branch passes when a real handle is available; redirected bytes remain exact; unavailable console is reported as unverified, not green |

Required commands remain package-local and bounded by an external process-tree supervisor. The Markdown slice must run first as a filtered test; the complete client test must never run without the 120-second supervisor. The final verification must include the compiled normal and target-liveness smoke, `git diff --check`, formatter/typecheck, and an explicit native console pass/unverified result.

### Budget and Comments

The R46 production ceiling is `<=600` effective lines, preserving the user's stricter earlier request and remaining below the hard `800` line limit. The six production files each require independent qualifying Chinese explanatory comments under `C_i >= max(1, ceil(E_i*0.15))`; final `E/C` is computed from the actual diff, not this ceiling. The Markdown comment budget covers only the non-obvious invariant that the current token's styled seed is owned by the persistent update before asynchronous highlight completion.

### Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R45 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface, stale authority and Markdown visibility seam | BLOCK | multiple independent audits recorded below |
| 3 | R46 | yes | pending independent full-scope plan audit | not started | - |

## R46 Historical Trace

## R45 Current Authority

### Requirement and Non-goals

修复Windows OpenCode TUI停止刷新/交互失效、正文和Thinking大面积空白、命令面板残影、Tree-sitter worker永久pending、persistent Tree泄漏、mutation/dispose重叠和Ctrl+C批量warning。禁止日志-only、常开未高亮正文、timeout-success、retry、second parser、renderer restart、watchdog、production telemetry、daemon/SSE猜测性修改和重大重构。代码文件最多8个，production effective lines低于800，保持一个primary path。

不修改stable-prefix Markdown算法、`buffer.zig`、native ABI、daemon/SSE/SyncProvider、版本、lockfile、generated artifact、发布流程或OpenCode命令面板状态逻辑。`drawUnstyledText=false`保持不变；Code的plain-text仅保留既有error compatibility。

### Evidence and First Divergence

| Area | Reachable path | First divergence/owner | Evidence |
| --- | --- | --- | --- |
| Blank body | worker exception -> uncorrelated ERROR -> client callback pending -> `CodeRenderable` waits with `drawUnstyledText=false` | worker/client response channel | pending callback reproduction; forced correlated-error test seam |
| Tree leak | persistent edit/stream/reset replaces WASM Tree | parser worker accepted Tree owner | source ownership path and fixed-length RSS reproduction |
| Mutation/dispose | same buffer operations overlap and dispose mirror before ack | client per-buffer Promise tail | delayed worker-response ordering seam |
| Ctrl+C warnings | renderer destroys client while Code catches rejection | `Code.ts` destroyed classification | actual held one-shot/streaming request unit seam |
| TUI output stall | default OpenCode `process.stdout` -> `BufferedBackend` -> `StdoutOutput.write` -> native render thread; unread-output probe receives STOP but destroy cannot complete | native `StdoutOutput` Windows console boundary, with JS scheduler as downstream owner | bounded default-process-stdout red probe; upstream `a597e88fb0a9a3704c0d487fbcc9e1cde3c64377` adds `GetConsoleMode`/UTF-16/`WriteConsoleW` |
| Command residual | `CommandPaletteProvider` -> `dialog.replace/clear` -> renderer invalidation -> native frame commit | existing renderer/output frame owner; no command-palette state change | source `command-palette.tsx:82-95,128-139`; target smoke surface transition |

The unread-pipe probe is diagnosis evidence for the reachable blocked-output owner, not a claim that an OS consumer which stopped reading can be forced to display. The native repair is limited to real Windows console handles; redirected output preserves byte semantics.

### Invariants

| ID | Invariant | Owner and test |
| --- | --- | --- |
| R45-INV-01 | A render-body exception or native failed frame retains one pending public invalidation, does not automatically retry, and the next public `requestRender()` can commit the frame. | `CliRenderer`; public scheduler tests |
| R45-INV-02 | Every messageId request settles exactly once through its correlated response channel. | worker/client; real worker error test |
| R45-INV-03 | Each buffer owns exactly one accepted Tree; accepted replacement deletes the previous owner and failed candidate preserves it. | parser worker; repeated lifecycle test |
| R45-INV-04 | Mutation and disposal share one ordered tail; a rejected mutation settles only itself, later same-buffer mutation still posts, and disposal waits for prior settlement plus its own ack. | client; delayed ordering and rejection-recovery tests |
| R45-INV-05 | Worker rejection reaches the existing Code error contract and does not turn into an empty successful highlight. | worker/client/Code; visibility tests |
| R45-INV-06 | Destroyed cancellation is silent; live worker/parser failure remains diagnosable once. | Code/client; held real request test |
| R45-INV-07 | Dialog replacement/clear commits the current surface: no stale `Commands`, black fragment or old dialog remains in the next visible frame. | renderer/output frame owner; compiled PTY transition |
| R45-INV-08 | Windows real-console output uses the console-safe writer; redirected file/pipe output remains byte-preserving. | `renderer-output.zig`; embedded native tests and compiled binary |

### Primary Path

```text
Windows console handle -> GetConsoleMode -> UTF-8 chunks -> UTF-16 -> WriteConsoleW -> existing frame status
render failure -> diagnostic + pending invalidation -> no self-retry -> next public requestRender -> existing activateFrame
worker request -> messageId response -> matching Promise settlement -> accepted Tree/mirror commit -> existing Code contract
dialog replace/clear -> existing state transition -> renderer invalidation -> current surface frame commit
```

No alternate success path is added. Feed-backed `retryable-skip` remains its existing backpressure path and is not treated as native failure.

### Exact File Boundary

Exactly eight code files are authorized:

| Category | Files |
| --- | --- |
| Production (5) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` |
| Regression/harness (3) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`types.ts` is not changed in R45; correlated wire shapes are local to the existing client/worker transport owner. No ninth file, command-palette production file, native test file, daemon/SSE file or generated/config file is authorized.

### TDD and Verification

| Slice | Red | Green |
| --- | --- | --- |
| Scheduler | failure test observes automatic retry or lost public owner | no clock-only retry; next public request renders |
| Worker settlement | correlated ERROR leaves request pending | current request rejects once and later request posts |
| Tail recovery | rejected mutation poisons later same-buffer operation | later edit/stream/reset posts and commits after correlated success |
| Tree ownership | repeated edit/stream/reset loses accepted state or leaks owner | repeated public lifecycle remains usable; failed candidate preserves prior state |
| Cancellation | held real Code/Tree-sitter request prints warning after destroy | zero expected destroy warnings |
| Command surface | Commands/background remains after replace/clear | next visible frame has current background/body and no stale Commands |
| Windows output | real console branch is absent or generic writer is used | native console branch pass; redirected bytes exact |

Required commands:

```text
repository root: bun run build
repository root: bun run script/build.ts --target bun-windows-x64 --single --skip-install --skip-embed-web-ui
thirdparty/opentui/packages/core: bun test ./src/tests/renderer.custom-stdout.test.ts
thirdparty/opentui/packages/core: bun test ./src/lib/tree-sitter/client.test.ts
thirdparty/opentui/packages/core: bun test ./src/renderables/Code.test.ts
thirdparty/opentui/packages/core: bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts
thirdparty/opentui/packages/core: bun run test:native -Dtest-filter="renderer-output"
thirdparty/opentui/packages/core: bun typecheck
repository root: git diff --check
packages/opencode: normal and target-liveness smoke under external 120-second PID-tree supervisors
```

The native test is embedded in `renderer-output.zig`: UTF-8 conversion and redirected compatibility always run; on Windows it opens/allocates `CONOUT$` when necessary, requires `GetConsoleMode`, executes `WriteConsoleW`, and reports explicit pass/failure. A console allocation failure is not a green release result.

### Budget and Comments

| Production file | `E_i` ceiling | `C_i` minimum |
| --- | ---: | ---: |
| `renderer.ts` | 100 | 15 |
| `client.ts` | 170 | 26 |
| `parser.worker.ts` | 200 | 30 |
| `Code.ts` | 25 | 4 |
| `renderer-output.zig` | 85 | 13 |
| **Total** | **580** | **88 independently** |

Comments count only nearby explanations of scheduler ownership, response correlation, Tree transfer/deletion, tail recovery, Windows handle distinction, encoding boundary or test intent. Final actual `E/C` recount is mandatory.

### Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01..B-06 | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |
| 2 | R38-R44 | yes | Windows/native proof, scope conflicts, mutation recovery, command surface and stale authority | BLOCK | multiple independent audits recorded below |
| 3 | R45 | yes | pending independent full-scope plan audit | not started | - |

## R45 Historical Trace

### 1. Verbatim Requirement

> “根本需求是修正原有产生的opencode的TUI卡死（表现为交互失效，只有基本的TUI渲染，如prompt区域pending的blink，其他命令面板交互无响应、所有内容均不再进行更新与响应的问题）使其之后不再会产生类似的TUI自身渲染卡死、失去响应问题，同时解决在结束之后会爆出大量的（Code streaming highlight failed, falling back to plain text: warn: TreeSitter client destroyed）的问题、禁止添加和‘根治’操作无关的任何修改，也就是最终目的不是让报错更加明显，而是解决报错的根因；与此同时，还要根治TUI正文不渲染且只有markdown的标号的问题，即存在大面积空白、只有1. 2.这种渲染的问题；同时，整体修改量代码不超过8个文件，生产代码修改量不800行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支，更好的应该是顶层机制设计保持简单，同时逻辑完整而不复杂，从第一性原理出发，不对不可能存在的输入进行假设，当出现边界情况考虑不周到时，应检查顶层机制设计是否合理，而不是继续添加分支判断。”

R38必须修复已证明的Tree-sitter request永久pending、persistent Tree泄漏、mutation/dispose重叠和destroy warning分类；同时在同一个`CliRenderer` scheduler owner内修复两条已执行可达的future-frame dead-state：render body exception和native `failed` status。R37审计发现原实现把future owner错误地转换成自动retry；R38改为保留待消费的invalidation，由下一次公开`requestRender()`消费，不在失败帧中再次主动进入renderer。当前隔离compiled smoke已证明默认process-stdout在正常输入、resize、busy和completion路径可持续刷新，但这只能是正向回归而不能排除异常分支；daemon/SSE和SyncProvider不进入本revision的生产修改。不得以增加日志、常开未高亮正文、timeout-success、retry或第二parser替代根因。

### 2. Explicit Non-Goals

- 不修改stable-prefix Markdown算法、tail边界、closing-fence、引用状态或已验证的正文等价性。
- 不把`drawUnstyledText=false`改为常开；正文可见性必须来自请求完成和现有Code error contract。
- 不新增worker watchdog、timeout-success、retry、second parser、renderer restart、feature flag、production telemetry或alternate success path。
- 不修改`buffer.zig`、native ABI、版本、lockfile、generated artifact或发布流程；`renderer-output.zig`仅允许本revision中的Windows stdout owner修复。
- 不把custom stdout `NativeSpanFeed`的probe当作OpenCode默认process stdout的根因；它只能保留自己的compatibility回归。
- `Daemon still running`、`Continue opencode -s undefined`是附加退出观察。本R37只独立记录其状态，不修改daemon status、SDK reconnect或退出摘要。

### 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | OpenTUI core在`thirdparty/opentui/packages/core`；OpenCode TUI正文使用`CodeRenderable`。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复first divergence和正确owner；禁止fallback；无批准不得实施。 |
| `.opencode/templates/canonical-plan.md` | 要求证据、reachability、双向traceability、TDD、验证、预算和审计记录。 |
| `AGENTS.md`、`thirdparty/opentui/AGENTS.md`、`packages/opencode/AGENTS.md`、`packages/opencode/test/AGENTS.md` | 使用Bun、package-local tests/typecheck、真实seam、published readiness，禁止固定sleep猜测完成。 |
| `docs/adr/README.md`、`docs/adr/0001-*.md` | 本次为局部bug repair，不新增跨模块ADR；现有ADR无TUI生命周期约束。 |

### 4. Current Behavior and Evidence

| Path | Evidence | Class |
| --- | --- | --- |
| OpenCode renderer construction | `packages/opencode/src/cli/cmd/tui/app.tsx:177-190,272`未传custom stdout，并将`externalOutputMode`设为`passthrough`；OpenTUI默认使用process stdout。 | observed |
| JS/native scheduler boundary | `thirdparty/opentui/packages/core/src/renderer.ts:4373-4504`在`root.render()`异常后只执行`finally`；`:1438-1457,4488-4496`的native `failed`状态也清除future-frame owner。两个分支都由`CliRenderer`持有同一scheduler状态；renderer red probe和现有native failure test分别复现两个dead-state。 | observed/reachable |
| Renderer red seam | `RootRenderable -> renderSelf -> renderer.loop()` probe得到`isRunning=true`、`isRendering=false`、`hasScheduledRender=false`，red为`render exception left a live renderer without a scheduled next frame`。 | observed |
| Custom feed | `renderer.ts:1005,1061-1076,1410-1435`可复现backpressure/coalescing，但不是OpenCode默认output。 | observed secondary |
| Tree-sitter pending | clean nested HEAD的worker generic catch丢失request identity；client `ERROR`分支只emit不reject；此前真实harness为`settled=pending`、`pendingCallbacks=1`，destroy后才reject。 | observed |
| Tree ownership | clean nested HEAD的`handleEdits`、`handleStreamingUpdate`和`handleResetBuffer`替换accepted Tree时不释放旧WASM owner；one-shot/injection finally显式delete。 | observed |
| Code visibility | Session保持`drawUnstyledText=false`；pending highlight因此表现为Thinking/正文空白或只剩Markdown结构标记。 | observed |
| Shutdown warning | renderer/client destroy拒绝在途请求；Code catch在destroy分类前打印warning，产生批量`TreeSitter client destroyed`。 | observed |
| SSE/exit | `handlers/global.ts:18-95`在abort/stream close递减SSE计数；`thread.ts:157`随后立即status查询，可能观察到关闭时序。 | observed/reachable |
| Exit summary | `exit-summary.ts:32-52`允许`sessionID?: string`并可输出`opencode -s undefined`；与原始正文空白未建立因果连接。 | observed, out of R37 production scope |
| Upstream | upstream latest tag `v0.5.1`，main `265d9310735e06b9fddf274a14813a119d8f93e5`；相关修复包括#1314、#1306、#1272、#1150、#1020。 | observed |
| Recent local release chain | parent `fe2abb7ede`升级至nested`df4bd31ca`，`94f19ae42b`升级至`2ce7e0d5f`（包含`61023ba5e` persistent Tree），`48add250a0`升级至`afd11de829`；最近高风险streaming owner集中在`.5`引入的persistent path。 | observed |
| Live daemon probe | `127.0.0.1:4096/global/health`返回`1.15.12-smark/healthy=true`；有界SSE读取立即得到`server.connected`，随后得到真实`message.part.progress`。 | observed |
| API Session metadata | `/session?directory=F:\\ML\\PythonAIProject\\Claude-Code\\opencode\\.temp\\API`返回两个Session，均绑定ProjectID`e5ad5189c1ceb9f616cadf4bcf42bb3cb0aca4c3`；`/session/{id}/message`可读取持久化Message/Part快照。 | observed |
| API TUI attachment | 当前进程列表没有绑定上述`.temp/API`两个Session的TUI；可见TUI为其他Session。因此live probe证明daemon发布和SQLite快照存在，但尚不能把目标Session的TUI丢失定位到event filter或renderer。 | observed verification boundary |
| Compiled smoke | `bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"`已在隔离root完成daemon、Session/Goal、初始/resize/restore frame、busy spinner和两次model request；子进程正常清理。该正向结果排除默认process-stdout正常工作负载的必现停帧，但尚未覆盖原始blank-body、command palette残影或目标真实Session的异常路径；当前真实`.temp/API`只读探测未产生可用异常证据，不能替代后续harness gate。 | observed verification boundary |

### 5. Supported Domain and Reachability

| Condition | Producer -> consumer path | Owner | Class |
| --- | --- | --- | --- |
| Windows compiled TUI frame | input/state invalidation -> `requestRender` -> `loop` -> root/native -> terminal | `CliRenderer` | reachable |
| Render-body exception | Renderable/frame callback -> `loop` async body | `CliRenderer` scheduler | observed/reachable |
| Worker exception with messageId | parser/query/injection -> worker catch -> client callback map -> Code | worker protocol/client | observed |
| Persistent streaming/edit/reset replacement | Code/public mutation -> parser worker Tree replacement | parser worker | observed/reachable |
| Ctrl+C with highlight in flight | ExitProvider -> renderer/client destroy -> Code catch | Code lifecycle | observed |
| Daemon SSE close | SDK abort/TCP close -> `eventResponse.close` -> count update | SSE handler | reachable, diagnostic only |

### 6. Required Invariants

| ID | Invariant | Evidence / test seam |
| --- | --- | --- |
| R38-INV-01 | Live renderer invalidation either commits a frame or reaches an explicit terminal error while retaining a future frame owner; it cannot remain running with no scheduled frame after either a render-body exception or native `failed` status. A failed frame must not automatically retry; the next public invalidation consumes the retained owner. | renderer public request red probe, native failure test and compiled process-stdout smoke |
| R38-INV-02 | Every messageId-bearing worker request settles exactly once through its own response channel. | forced worker-error harness/client test |
| R38-INV-03 | A persistent parser buffer has one accepted Tree owner; each replaced Tree is deleted exactly once after accepted replacement. | repeated edit/stream/reset lifecycle test and failed-candidate preservation |
| R38-INV-04 | Each buffer's mutation and disposal operations share one completion chain: an in-flight mutation must settle before `DISPOSE_BUFFER` is sent, and disposal must settle before the client removes its mirror. | delayed worker-response disposal test |
| R38-INV-05 | Worker rejection reaches the existing Code error contract; `drawUnstyledText=false` remains unchanged. | Code visibility test |
| R38-INV-06 | Expected post-destroy cancellation is silent; live worker/parser failure remains diagnosable once. | one-shot and streaming shutdown tests plus a real compiled request-boundary predicate |
| R38-INV-07 | Daemon/SSE receipt, SyncProvider application and renderer frame progress remain distinguishable; a healthy daemon cannot be reported as a TUI-render success. | target-Session compiled trace |

### 7. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| R38-INV-01 | Both render-body exception and native `failed` exits retain a future invalidation without scheduling an automatic retry; public `requestRender()` is the sole next-frame owner. | `CliRenderer.loop()` and public scheduler | public request red probe plus native failure test |
| R38-INV-02/05 | Worker generic ERROR loses request correlation; client emits an event instead of rejecting the matching callback. | `parser.worker.ts` + `client.ts` | pending until destroy |
| R38-INV-03 | Persistent edit/stream/reset handlers replace accepted Trees without deleting the previous owner. | parser worker | repeated public lifecycle test and failed-candidate preservation |
| R38-INV-04 | Client-side mutation and disposal can cross unless all buffer operations use one serialized lifecycle chain and the disposal ack remains correlated. | `client.ts` + `types.ts` + worker dispatch | delayed update/dispose response ordering test |
| R38-INV-06 | Code warning is emitted before destroyed lifecycle is classified. | `Code.ts` catch | exact one-shot/streaming cancellation test and compiled request-boundary smoke |
| R38-INV-07 | Current daemon probe reaches global SSE and persists API Session Messages, but target API TUI is not attached in the observed process set. | `handlers/global.ts`, `sdk.tsx`, `event.ts`, `sync.tsx`, compiled harness | current probe localizes daemon-wide health but not TUI consumer divergence; no daemon/SSE production change is authorized |

### 8. Feedback Signal

Already run from package-local directories:

```text
bun test ./src/tests/renderer.custom-stdout.test.ts
45 pass / 0 fail / 128 expect()
```

```text
packages/opencode: bun test test/cli/cmd/tui/sync.test.tsx
19 pass / 0 fail / 48 expect()

packages/opencode: bun test test/cli/cmd/tui/sdk.test.tsx test/cli/cmd/tui/session-integration.test.ts
37 pass / 0 fail / 71 expect()
```

Already run red probes:

```text
RED: render exception left a live renderer without a scheduled next frame
RED: pending output left later renderer invalidation without a scheduled frame
```

The second probe is a secondary custom-feed seam. The first proves the selected scheduler invariant. The current compiled harness now returns:

```text
binary=F:\\include\\CLI\\opencode.exe
sourceCount=2
renderedCount=2
modelRequests=2
isolated daemon/Session/Goal/frame/resize/spinner cleanup: pass
```

R38 has one shared scheduler gate and one compiled end-to-end gate. The scheduler gate covers both existing red seams that enter `CliRenderer` (`root.render()` exception and native `failed`), exercises them through public `requestRender()`/`activateFrame()` scheduling, and proves that a failure does not self-retry while the next public invalidation is still consumable. The compiled harness gate is a concrete contract, not a future placeholder: it must correlate target Session/project/directory, observe a matching `message.part.delta` or `message.part.updated` SSE event, assert separate Thinking and assistant-body cell predicates, send `Ctrl+P` then Escape and assert command-palette replacement/restoration, and capture shutdown warning patterns while the real Code/Tree-sitter request boundary is still held. Every predicate has a bounded timeout and records the first missing stage; a hang is a failed result, not an open wait.

### 9. Responsibility and Seam

| Concern | Owner | Why this owner |
| --- | --- | --- |
| Exception-to-next-frame scheduling | `renderer.ts` | owns rendering flag, timers and existing status branches; Renderable cannot schedule the renderer. |
| Native/process-stdout scheduler status | compiled renderer boundary | native `failed` is an existing executable dead-state in the same `CliRenderer` owner; R38 retains the next invalidation owner without automatically re-entering the renderer. |
| Correlated worker error | `parser.worker.ts` | the existing response type already permits an optional messageId; the worker knows the inbound id. |
| Callback settlement | `client.ts` | client owns callback map and Promise completion. |
| Persistent Tree delete | `parser.worker.ts` | worker creates/replaces WASM Trees. |
| Destroy warning classification | `Code.ts` | Code owns renderable lifecycle and user-visible fallback diagnostics. |

### 10. Single Approved Primary-Path Design

Renderer:

```text
invalidation -> existing loop body -> normal status schedule
                         \-> one diagnostic + existing next-frame owner when live
```

The renderer change is limited to the existing `CliRenderer.loop()` owner: when the render body throws or `renderNative()` returns `failed`, it records the existing failure and retains one pending invalidation flag. The failure path does not call `requestRender()` or schedule a retry; the next public `requestRender()` consumes that retained owner through the existing `activateFrame()` path. It must preserve normal output status branches, never synthesize a successful frame, never restart the renderer and never add a second scheduler. The two status exits share the same retention operation; no new branch-specific state machine is introduced. Daemon/SSE and SyncProvider paths remain unchanged in R38; the compiled harness observes them only to prove whether the visible frame contract reaches the renderer and the actual Code/Tree-sitter request boundary.

Tree-sitter:

```text
buffer mutation -> correlated success or ERROR/WARNING
                -> matching callback settles once
                -> next same-buffer operation may send
buffer disposal -> correlated BUFFER_DISPOSED/ERROR
                 -> client mirror is removed only after ack
```

The worker preserves inbound ids in terminal error responses and returns a correlated `BUFFER_DISPOSED` ack. The client rejects the matching callback before emitting the diagnostic. One per-buffer operation chain serializes create/edit/reset/streaming mutation and disposal; `removeStreamingBuffer` remains non-blocking to its caller but cannot send disposal until its predecessor settles, and cannot delete the client mirror until the ack settles. Persistent Tree handlers release the previous accepted Tree only after replacement acceptance; candidate failures release only their own allocations. `Code.ts` checks destruction before warning. No timeout, retry, second parser or raw-text emergency route is introduced.

### 11. Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Disposition |
| --- | --- | --- | --- |
| normal renderer/native status | primary-contract branch | yes | preserve |
| render-body exception diagnostic | primary error branch | no | repair at scheduler owner |
| correlated Tree-sitter success | primary-contract branch | yes | preserve/repair protocol |
| correlated worker error -> existing Code plain text | existing shipped compatibility | yes under existing contract | preserve, not add |
| uncorrelated worker diagnostic | diagnostic path | no | preserve for event-only operations |
| custom stdout feed | existing compatibility | yes | test only unless compiled reachability proves it |
| daemon/SSE reconnect | existing transport | yes | zero-diff without first divergence |
| timeout/retry/second parser/raw emergency/renderer restart | forbidden fallback | yes | reject |

New alternate-success-path budget: zero.

### 12. Workaround Deletion

| Workaround | R38 action |
| --- | --- |
| generic ERROR without request id | replace only for messageId requests; retain event-only diagnostics |
| destroy-time rejection as first worker completion | retain only for actual client destruction |
| warning before destroyed guard | classify lifecycle before warning |
| permanent unstyled rendering | reject; retain `drawUnstyledText=false` |
| mutation/dispose overlap | replace independent completion paths with one per-buffer ordered chain and a correlated disposal ack |

### 13. Forward Traceability

| Requirement / invariant | Production path | Planned file/change | Behavioral evidence |
| --- | --- | --- | --- |
| no live scheduler dead state | render body exception -> loop owner | `renderer.ts` | throwing Renderable probe |
| no blank body from worker exception | worker catch -> callback reject -> Code contract | `parser.worker.ts`, `client.ts`, `Code.ts` | forced-error public request and visible source |
| no persistent Tree leak | accepted replacement -> delete old owner | `parser.worker.ts` | fixed-size repeated updates |
| no Ctrl+C warning flood | destroy -> reject -> Code guard | `client.ts`, `Code.ts` | one-shot/streaming destroy |
| native/daemon distinction | SSE/input/frame/native trace | no daemon/SSE production change in R38; record target-session separation as a verification boundary | bounded compiled target-Session workload |

### 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why reuse is insufficient |
| --- | --- | --- | --- |
| exception/native failed frame scheduling | R38-INV-01 | public request/activate scheduler probe and compiled smoke | automatic retry must be removed while the invalidation owner remains consumable |
| correlated ERROR/WARNING response | R38-INV-02/05 | pending callback | event-only branch cannot settle a Promise |
| correlated disposal response | R38-INV-02/03/04 | worker Tree ownership must be observable | client cannot prove worker release or ordering without response id |
| per-buffer mutation/dispose chain | R38-INV-04 | delayed worker-response ordering test | separate tails can let disposal cross an in-flight mutation |
| accepted Tree replacement deletion | R38-INV-03 | repeated edit/stream/reset lifecycle and failed-candidate test | current assignment loses old owner |
| destroyed guard before warning | R38-INV-06 | warning flood | current Code catch logs too early |

### 15. File-Level Change Plan

R38 plans the same five production files, two existing regression files and the existing compiled smoke harness. No new benchmark, generated artifact, config or native file is part of the implementation diff.

| File | Responsibility | Effective production delta |
| --- | --- | ---: |
| `thirdparty/opentui/packages/core/src/renderer.ts` | common `CliRenderer.loop()` future-frame ownership for render-body exception and native `failed` status | <=110 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | correlated callback rejection and acknowledged disposal | <=150 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | correlated catch response and accepted Tree candidate/replacement ownership for edit/stream/reset | <=220 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | explicit correlated mutation/disposal wire contract | <=20 |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | destroyed-before-warning classification | <=25 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | real worker request/error/disposal/Tree/Code regression | test only |
| `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts` | renderer exception/native status seam and existing feed regression | test only |
| `packages/opencode/script/smoke-opentui-artifact.ts` | add `--scenario target-liveness`; in that scenario subscribe to the daemon global event stream after Session creation, correlate events by Session/project/directory, submit the sentinel fixture prompt, assert Thinking/body and `Ctrl+P`/Escape command-palette frames, then count shutdown warnings from the isolated log | test/harness only |

Planned production effective ceiling is 525 lines, below the user hard limit of 800 and the earlier stricter 600-line request. The total code-file set is eight, exactly at the user's absolute cap. If the approved implementation exceeds 525 effective lines or needs `event.ts`/`sync.tsx` changes, stop and create a new revision instead of broadening the diff.

### 16. TDD Behavior Slices

| Order | Red behavior | Current failure | Minimal green behavior |
| ---: | --- | --- | --- |
| 1 | Throwing render body or native `failed` status leaves live renderer without scheduled next frame. | both exits clear the future owner from separate branches. | the common scheduler owner preserves the existing continuous-frame contract without a second renderer or success-shaped fallback. |
| 2 | Forced worker error leaves streaming request pending until destroy. | generic ERROR only emits event. | same id rejects callback once and existing Code error contract makes source visible. |
| 3 | Fixed-length edit/stream/reset updates retain replaced Tree memory. | old Tree is overwritten without delete. | accepted replacement deletes exactly previous owner; failed candidate preserves accepted owner. |
| 4 | Dispose after an in-flight mutation can cross the mutation, remove the mirror early, or remain pending. | response correlation and per-buffer ordering are incomplete. | one queue sends disposal after predecessor settlement and removes the mirror only after correlated ack/rejection. |
| 5 | Ctrl+C during one-shot/streaming highlight prints zero expected warnings. | warning precedes destroyed classification. | destroyed rejection returns silently; live failure remains diagnostic. |
| 6 | Compiled target Session independently shows daemon SSE receipt, project identity, input acknowledgement, visible body, command-panel transition and shutdown warnings. | current smoke proves normal rendering but does not record the original target-Session observables. | the same bounded harness records the first missing observable, sends `Ctrl+P`/escape through PTY, and fails fast on a hang. |

Tests must use real worker/renderer seams and published readiness; no fixed sleep as completion proof, private-method test or source-text assertion.

### 17. Chinese Comment Budget

| Metric | Estimate | Rule |
| --- | ---: | --- |
| Effective changed production lines `E` | <=525 | exclude imports, formatting, generated, pure moves and comment-only lines |
| Qualifying comments `C` | per-file | each changed production file independently satisfies `C_i >= max(1, ceil(E_i*0.15))`; `E_i=0` requires `C_i=0` |

| Production file | `E_i` ceiling | Required `C_i` minimum |
| --- | ---: | ---: |
| `renderer.ts` | 110 | 17 |
| `client.ts` | 150 | 23 |
| `parser.worker.ts` | 220 | 33 |
| `types.ts` | 20 | 3 |
| `Code.ts` | 25 | 4 |
| Total | 525 | 80 across files, not concentrated |

Comments must explain the scheduler ownership invariant, messageId response contract, accepted Tree deletion boundary, disposal acknowledgement or destroyed-cancellation compatibility. Assignment restatements, identifier translations, obvious control flow and test names do not count.

### 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test ./src/tests/renderer.custom-stdout.test.ts` | `thirdparty/opentui/packages/core` | scheduler/feed regression |
| `bun test ./src/lib/tree-sitter/client.test.ts` | `thirdparty/opentui/packages/core` | worker correlation/disposal/Tree lifecycle |
| `bun typecheck` | `thirdparty/opentui/packages/core` | no new diagnostics in changed files; baseline separated |
| `git diff --check` | repository root | whitespace integrity |
| `bun run script/smoke-opentui-artifact.ts --binary "F:\\include\\CLI\\opencode.exe"` | `packages/opencode` | current isolated baseline: daemon/Session/Goal, two model requests, initial/resize/restore frames, busy spinner and cleanup all passed |
| exact PowerShell supervisor below with `--scenario target-liveness` | `packages/opencode` | original prompt/body/command-panel/SSE/native/shutdown behavior under a 120-second process-tree deadline |
| original normal/error/Ctrl+C workload under same supervisor | compiled boundary | user-visible recovery and zero expected shutdown warning flood |

Full package/client tests must never run without an external process-tree timeout; a hang is a failed verification result.

The exact Windows target-liveness invocation, run from `packages/opencode`, is:

```powershell
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = "bun"
$start.WorkingDirectory = "F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode"
$start.UseShellExecute = $false
@(
  "run",
  "script/smoke-opentui-artifact.ts",
  "--binary",
  "F:\include\CLI\opencode.exe",
  "--scenario",
  "target-liveness"
) | ForEach-Object { [void]$start.ArgumentList.Add($_) }
$process = [System.Diagnostics.Process]::Start($start)
if (-not $process) { throw "failed to start target-liveness smoke" }
if (-not $process.WaitForExit(120000)) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
  [void]$process.WaitForExit(10000)
  throw "target-liveness smoke exceeded 120-second process-tree deadline"
}
if ($process.ExitCode -ne 0) {
  throw "target-liveness smoke exited with code $($process.ExitCode)"
}
```

The supervisor deadline is only a test-process failure boundary. It does not change worker request semantics, manufacture success or become a production timeout.

#### Compiled Target-Session Contract

The smoke harness must keep the existing isolated root and public HTTP/PTY seams, but its fixture and assertions must be deterministic:

1. The provider fixture emits a reasoning part containing `THINKING-SENTINEL` and an assistant text part containing `BODY-SENTINEL`; the harness must not treat the generic `ok` completion as body evidence.
2. After `sessionID` is created, the harness reads `/global/event` and accepts only events whose envelope has the created `directory` and `project`, whose payload `properties.sessionID` equals that Session, and whose payload type is `message.part.delta` or `message.part.updated`. The matching event is required before any PTY body assertion.
3. The isolated daemon message endpoint is queried for the same Session after completion. Its persisted parts must independently contain both sentinels, separating producer/persistence from TUI consumption.
4. The isolated TUI log is checked for existing `stream timing` entries with `phase=delta.receive` and `phase=delta.apply` for the same message/part key. `delta.receive` without `delta.apply` is an explicit SyncProvider boundary failure; both phases with missing cells are a renderer/Code boundary failure. No new production telemetry is added.
5. The PTY cell capture must separately contain `THINKING-SENTINEL` and `BODY-SENTINEL`. After body visibility, the harness writes `Ctrl+P` (`\x10`), requires the dialog title `Commands`, writes Escape, and requires the body sentinel to return while the `Commands` title disappears. Missing title, stale title, stale body or unchanged cells is a failed transition, not a success.
6. Before shutdown, the harness records the in-flight stage and sends the real Ctrl+C sequence. Isolated logs must contain zero `TreeSitter client destroyed`, zero `Code highlighting failed` and zero `Code streaming highlight failed` lines caused by expected destruction; a live forced worker failure remains a separate non-shutdown diagnostic assertion in `client.test.ts`.
7. Every item has an explicit 10-second readiness or transition deadline, the overall child/process-tree deadline remains bounded, and the artifact records the first missing predicate plus Session/project/directory identity without dumping message content or credentials.

### 19. Diff Budget

| Metric | Hard budget |
| --- | ---: |
| Production files | <=5 planned; absolute user cap <=8 |
| Total code files | <=8 planned; absolute user cap <=8 |
| Production effective lines | <=525 planned; absolute user cap <=800 |
| New alternate success paths | 0 |
| Native/Zig files | 0 in R38 |
| Generated/config/migration files | 0 |

The budget cannot justify omitting a confirmed invariant. If the route cannot fit, revise and re-audit.

### 20. Risks, Decisions and Rejected Speculation

#### Real risks

- The renderer source and existing tests prove two future-frame owner failures under one `CliRenderer` scheduler: render-body exception and native `failed`. R38 repairs the common owner without automatic retry; the isolated default process-stdout smoke remains the positive normal-workload regression.
- Tree deletion must occur only after accepted replacement; premature deletion would invalidate the accepted parser state.
- Disposal must not be treated as a best-effort tail: the client must keep the per-buffer operation chain alive until the correlated worker ack or rejection, while destroy remains the only path that cancels all pending work at once.
- Correlated rejection must reach existing Code plain-text compatibility and cannot become empty successful highlight output.
- `Daemon.status()` may observe SSE close race after local exit; it is not a frame-success signal.
- The R38 implementation retains the approved five Tree-sitter/Code production files plus the two approved regression files; any further semantic change requires a new revision rather than silently expanding the owner boundary.

#### Open Decisions Requiring the User

None for the original TUI/Tree-sitter scope. `event.ts`, `sync.tsx`, `sdk.tsx` and daemon handlers remain diagnostic-only in R38; native output is repaired only at the existing `CliRenderer` scheduler owner. `Continue opencode -s undefined` remains separately recorded because no causal connection to the original blank-body/freeze has been proven.

#### Rejected Speculation

- stable-prefix cache, ScrollBox width, ScrollBar geometry, dialog background, `buffer.zig` and daemon reconnect are not production owners without reachable differential evidence.
- timeout, retry, renderer restart and permanent plain-text mode would conceal rather than repair the first divergence.

### 21. Audit Contract

The independent auditor must read this exact R37 authority, the original requirement and repository evidence, then audit the complete original scope: default process-stdout reachability, common JS/native renderer scheduler owner, target-Session daemon/SSE/SyncProvider separation, Tree-sitter request/Tree/Code lifecycle including mutation/dispose ordering, blank-body behavior, Ctrl+C warnings, dialog/width evidence, file cap, production line cap, fallback prohibition and per-file Chinese comment gate. Handoff contains only the verbatim requirement, this plan path, repository root and `Audit mode: implementation`.

### 22. Plan Audit Record

| Round | Revision | Full scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R32 | yes | B-01 stale normative/archive conflict; B-02 compiled renderer owner not proven; B-03 per-file E/C not recalculable | BLOCK | `ses_0231310a8ffeVWRnp3RZlfYAbA` |
| 2 | R33 | yes | B-01 compiled Windows default process-stdout/native first divergence and original blank-body path not proven; B-02 existing smoke cannot execute target-Session body/command/SSE/Ctrl+C/shutdown contract | BLOCK | `ses_022f29cf8ffep0W21WlCf2OELx` |
| 3 | R34 | yes | B-01 compiled first divergence remained unresolved; B-02 `types.ts` wire contract omitted; B-03 mutation/dispose in-flight ordering and owner boundary incomplete | BLOCK | `ses_022c1f3d1ffeUysSqPedCVxAFd` |
| 4 | R35 | yes | B-01 original compiled abnormal first divergence not proven; B-02 reachable native `failed` dead-state excluded; B-03 compiled target contract remained non-executable | BLOCK | `ses_022c1f3d1ffeUysSqPedCVxAFd` |
| 5 | R36 | yes | B-01 compiled target contract had no exact process-tree-supervised command and planned sentinel assertions were not yet present in the existing harness | BLOCK | `ses_022c1f3d1ffeUysSqPedCVxAFd` |
| 6 | R37 | yes | none | APPROVE | `ses_022c1f3d1ffeUysSqPedCVxAFd` |

R37 received `No blocking findings` and `APPROVE`; implementation is authorized only for this exact revision.

### 23. R37 Implementation Evidence (Superseded by R38)

This section preserves the evidence audited in R37. It is not implementation authorization for R38 and its claims are superseded wherever the R38 revision delta below differs.

#### Actual changed files and raw delta

| File | Raw additions / deletions | Purpose |
| --- | ---: | --- |
| `thirdparty/opentui/packages/core/src/renderer.ts` | `10 / 1` | Retain the existing future-frame owner after render-body exception or native `failed`. |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | `201 / 180` | Correlated callback settlement, one per-buffer operation tail and acknowledged disposal. |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | `240 / 163` | Correlated worker errors and candidate/accepted Tree ownership; changed blocks formatter-conformant. |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | `16 / 7` | MessageId-bearing mutation, warning/error and disposal wire contract. |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | `4 / 2` | Classify one-shot and streaming destroyed cancellation before warning. |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | `210 / 0` | Worker error, mutation/disposal ordering and Code lifecycle regressions. |
| `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts` | `55 / 20` | Render exception and native failure future-frame regressions. |
| `packages/opencode/script/smoke-opentui-artifact.ts` | `247 / 6` | Bounded target-Session compiled feedback loop, part-key correlation and in-flight Ctrl+C. |

No daemon/SSE/SyncProvider production file, native/Zig file, generated artifact, configuration, timeout-success, retry, second parser or renderer restart was added.

#### Red-green evidence

| Slice | Red evidence | Green result |
| --- | --- | --- |
| renderer future-frame owner | render-body exception and native `failed` probes left a live renderer without a scheduled next frame | `46 pass / 0 fail / 129 expect()` |
| worker error correlation | forced worker failure remained pending until destroy | `53 pass / 0 fail / 388 expect()` |
| persistent Tree replacement | accepted edit/stream/reset replacement lost the previous WASM owner | covered by the same client lifecycle suite; no pending or ownership regression |
| mutation/dispose ordering | disposal could cross an in-flight mutation and remove the mirror early | covered by delayed-response ordering tests; no pending or mirror-order regression |
| Code destruction warning | warning was emitted before destroyed classification | `72 pass / 1 skip / 0 fail / 2 snapshots` |
| compiled target Session | existing smoke did not separately prove SSE, persisted body, Thinking/body cells and Commands restoration | target-liveness smoke completed with `sourceCount=2`, `renderedCount=2`, `modelRequests=2`, `targetEventCount=14`; the second prompt remained in-flight before Ctrl+C |
| compiled normal workload | latest harness changes must not regress bootstrap, Session, resize or busy rendering | normal smoke completed with `sourceCount=2`, `renderedCount=2`, `modelRequests=3`, `targetEventCount=0` |

#### Verification commands and results

```text
thirdparty/opentui/packages/core: bun test ./src/lib/tree-sitter/client.test.ts
53 pass / 0 fail / 388 expect()

thirdparty/opentui/packages/core: bun test ./src/renderables/Code.test.ts
72 pass / 1 skip / 0 fail / 2 snapshots / 243 expect()

thirdparty/opentui/packages/core: bun test ./src/tests/renderer.custom-stdout.test.ts
46 pass / 0 fail / 129 expect()

packages/opencode: target-liveness smoke under an external 120-second PID-tree supervisor
pass; sourceCount=2; renderedCount=2; modelRequests=2; targetEventCount=14; in-flight Ctrl+C completed without shutdown warnings

packages/opencode: normal smoke under an external 120-second PID-tree supervisor
pass; sourceCount=2; renderedCount=2; modelRequests=3; targetEventCount=0

packages/opencode: Windows compiled artifact build and version smoke
pass; `bun run script/build.ts --target bun-windows-x64 --single --skip-install --skip-embed-web-ui`; binary smoke reported `0.0.0-dev-smark-202608072059`

thirdparty/opentui/packages/core: bunx oxfmt --check src/lib/tree-sitter/parser.worker.ts
pass

repository/nested changed files: git diff --check
pass
```

The client suite was run under `Start-Process` plus recursive `taskkill` at the 120-second deadline; it completed in 14.23 seconds. The package typecheck was also run from `thirdparty/opentui/packages/core` and returned the repository's existing diagnostics in `dev/*` and `src/tests/yoga-upstream/**`; no diagnostic referenced an R37 changed file.

#### Effective-line and Chinese-comment gate

The reproducible zero-context hunk recount excludes blank, import-only, comment-only and formatter-only lines and uses `max(substantive additions, substantive deletions)` per hunk:

| Production file | `E_i` | qualifying `C_i` | required `ceil(E_i*0.15)` | verdict |
| --- | ---: | ---: | ---: | --- |
| `renderer.ts` | 8 | 2 | 2 | pass |
| `client.ts` | 181 | 38 | 28 | pass |
| `parser.worker.ts` | 88 | 27 | 14 | pass |
| `types.ts` | 13 | 3 | 2 | pass |
| `Code.ts` | 4 | 4 | 1 | pass |
| `client.test.ts` | 161 | 25 | 25 | pass |
| `renderer.custom-stdout.test.ts` | 46 | 8 | 7 | pass |
| `smoke-opentui-artifact.ts` | 223 | 34 | 34 | pass |
| **Total** | **724** | **141** | **113** | **pass; per-file gate is authoritative** |

The largest `client.ts` count includes replacement of the old independent queue/debounce and disposal timer; those removed paths are the approved superseded workaround, not an additional semantic path. The parser count excludes formatter-only lines through the zero-context `--ignore-all-space` recount. Every added comment is adjacent to request correlation, operation-tail ordering, accepted Tree transfer, renderer scheduling, destroy classification or a regression assertion.

#### Round 1 implementation-audit rework

The first independent implementation audit returned `BLOCK` with five actionable findings. The following changes are the bounded R37 rework, not a scope expansion:

| Finding | Evidence from round 1 | R37 rework completed |
| --- | --- | --- |
| B-01 | One-shot Code cancellation could warn before checking `isDestroyed`. | The one-shot catch now classifies destroyed cancellation before warning; the Code regression covers one-shot and streaming held requests. |
| B-02 | Smoke correlation was event-type based and could accept another part. | `hasPartTiming()` requires the same session, message, part and field identity in one receive/apply record. |
| B-03 | Ctrl+C was not held against a live highlight response. | The target fixture emits the first delta of a second public `prompt_async` request, keeps the response in flight, then sends Ctrl+C. |
| B-04 | The previous comment count did not satisfy the recalculated gate. | Comments were added only adjacent to the affected lifecycle, scheduler, harness and regression assertions; the current recount is `E=724`, `C=141`, with every file passing its floor. |
| B-05 | Parser changed blocks were not formatter-conformant. | `bunx oxfmt --check src/lib/tree-sitter/parser.worker.ts` passes. |

#### Remaining unverifiable items

The compiled harness uses an isolated fixture Session and cannot prove the exact historical `.temp/API` Session attachment without reading protected user data. It does independently prove daemon event correlation, persisted Thinking/body parts, TUI cell visibility, command-panel restoration and shutdown-warning behavior through public seams. No causal evidence currently authorizes daemon/SSE production changes.

### 24. R37 Implementation Audit Record (Superseded by R38)

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R37 | yes | B-01 one-shot cancellation warning; B-02 target-part correlation; B-03 missing in-flight Ctrl+C; B-04 comment gate; B-05 parser formatting | BLOCK | `ses_022118a47ffegn80bogGe10Rz8` |

## R38 Revision Delta

R38 accepts all six blocking findings from the full-scope R37 implementation audit `ses_021cef779ffe66Mv4pbNcLc3Va`. Every unchanged R37 requirement, invariant, owner, file boundary, non-goal and verification rule remains normative; this delta replaces only the failed renderer scheduling design and the incomplete verification gates.

### R38 First Divergences and Owners

| Finding | First divergence | Owner | R38 correction |
| --- | --- | --- | --- |
| B-01/B-02 | The failed frame sets `immediateRerenderRequested`, then `loop()` calls `requestRender()` from its own `finally`; in one-shot mode this is both an automatic retry and races `activateFrame()` clearing `updateScheduled`. | `CliRenderer.loop()` and public `requestRender()`/`activateFrame()` scheduler boundary | Keep the pending invalidation flag after failure, remove the failure-frame call to `requestRender()`, and let only the next public invalidation enter `activateFrame()`. |
| B-03 | The compiled fixture held a provider response, not a Tree-sitter callback. | Code/Tree-sitter cancellation verification boundary | Move the exact in-flight predicate to a package regression using a real `TreeSitterClient` worker and real `CodeRenderable`; hold the actual messageId-bearing worker request, destroy Code/client, and assert zero warning. The compiled target smoke remains the public shutdown/output integration gate and no longer claims internal pending-state observability. |
| B-04 | Tree replacement was source-inspected but repeated edit/stream/reset and failed-request recovery were not exercised through public client operations. | `ParserWorker` accepted state observed through `TreeSitterClient` | Add a bounded repeated lifecycle regression covering accepted edit, streaming and reset operations, then a correlated failed mutation followed by a successful operation that proves the last accepted state remained usable. Deletion count itself is not exposed across the worker isolate; the existing fixed-length RSS reproduction remains the explicit leak oracle. |
| B-05 | Changed `client.ts` is not formatter-conformant. | package formatter gate | Format only `client.ts`; the pre-existing `Code.ts` formatter difference is not widened. |
| B-06 | Raw Chinese comment candidates included obvious or duplicated comments. | each changed file | Remove non-qualifying duplicates, recount per file after semantic edits, and add only nearby invariant/test-boundary explanations or reduce the changed surface until every file independently meets its floor. |

### R38 Single Primary Path

```text
renderer failure
  -> record the existing terminal diagnostic
  -> retain one pending invalidation bit
  -> return without scheduling
next public requestRender()
  -> existing activateFrame()
  -> consume current render state

Code render with real TreeSitterClient
  -> messageId-bearing one-shot/streaming request is held
  -> Code and client destroy reject that exact request
  -> destroyed guard exits before warning
```

This design contains no retry, timeout-success, renderer restart, second parser, permanent unstyled mode, production telemetry or test-only production flag. Feed-backed `retryable-skip` remains the existing feed-idle backpressure contract and is not conflated with native `failed`.

### R38 TDD Slices

| Slice | Public seam | Red expectation before correction | Green contract |
| --- | --- | --- | --- |
| renderer failure retention | `CliRenderer.requestRender()` plus manual public clock | native `failed` or `root.render()` failure automatically re-enters the loop or loses the owner when `activateFrame()` clears `updateScheduled` | no second call occurs without a new public request; the next request commits a frame |
| actual cancellation boundary | real `CodeRenderable` plus real `TreeSitterClient` worker transport | destroying with a held messageId request can print `highlight failed` | one-shot and streaming requests reject silently after destroy |
| persistent lifecycle | public `createBuffer`/`updateBuffer`/`resetBuffer`/`updateStreamingBuffer`/remove methods | repeated replacement or failed mutation can poison the accepted state or leave disposal incomplete | repeated accepted operations remain correct; failure preserves the prior state; acked disposal removes the mirror |
| compiled integration | existing normal and target-liveness scenarios | TUI body/dialog/shutdown can regress independently of package tests | both bounded scenarios pass; target correlation remains session/message/part/field exact and shutdown warning count is zero |

### R38 File and Diff Boundary

The exact eight-file boundary remains unchanged: five production files, two existing nested regression files and the existing compiled smoke harness. R38 adds no file and no daemon/SSE/native/generated/config change. Production effective lines must remain below 525 planned and 800 absolute; total code-file count remains eight. Per-file Chinese comment floors are recalculated from the final R38 diff, not inherited from the R37 raw candidate count.

### R38 Verification

Run from `thirdparty/opentui/packages/core` unless noted:

```text
bun test ./src/tests/renderer.custom-stdout.test.ts
bun test ./src/lib/tree-sitter/client.test.ts
bun test ./src/renderables/Code.test.ts
bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts
bun typecheck
```

Run both compiled scenarios from `packages/opencode` under the external 120-second PID-tree supervisor. Rebuild the Windows binary only after production changes, using the already verified local models snapshot and `--skip-install --skip-embed-web-ui`. Record baseline-only typecheck/formatter failures separately and reject any changed-file diagnostic.

### R38 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R38 | yes | pending independent full-scope plan audit | not started | - |

## R39 Revision Delta

R39 supersedes any conflicting R38 statement below. R39 accepts the R38 plan-audit blocker `B-01`: the original Windows default process-stdout first divergence was not proven by the synthetic JS scheduler probe. Current repository evidence now identifies the actual platform boundary: OpenCode uses default `process.stdout`; local `renderer-output.zig` writes UTF-8 bytes through the generic Windows stdout writer and swallows write failure; upstream OpenTUI commit `a597e88fb0a9a3704c0d487fbcc9e1cde3c64377` (`core(renderer): write Windows console output with WriteConsoleW`, included before upstream `v0.5.1`) detects real console handles and uses `WriteConsoleW` after UTF-8-to-UTF-16 conversion. R39 backports only that owner-local behavior, without upgrading Zig, copying the release, or changing redirected output.

R39 also incorporates the R38 corrections: failed JS frames retain a pending public invalidation without automatic retry; the exact in-flight cancellation predicate is tested at a real `CodeRenderable` plus real `TreeSitterClient` worker boundary; repeated public edit/stream/reset lifecycle coverage is added; changed-file formatting and per-file comment gates are recomputed from the final diff.

### R39 Current Evidence and First Divergence

| Path | Current evidence | R39 owner decision |
| --- | --- | --- |
| OpenCode output construction | `packages/opencode/src/cli/cmd/tui/app.tsx:177-190,272` leaves stdout at `process.stdout`; OpenTUI therefore selects `BufferedBackend.createStdout`. | Reachable default producer; no custom feed substitution. |
| Local Windows stdout writer | `thirdparty/opentui/packages/core/src/zig/renderer-output.zig:42-61` uses the generic stdout writer for every platform and ignores write/flush errors. | First platform divergence for real Windows console output; repair in `renderer-output.zig`. |
| Upstream compatibility evidence | Upstream `a597e88...` adds `GetConsoleMode`, UTF-8 chunk conversion and `WriteConsoleW`; its commit message specifically identifies `WriteFile`/console code-page behavior as the defect. | Concrete compatibility repair, not a speculative alternative owner. |
| JS scheduler failure path | R38 audit found automatic retry and public one-shot scheduling race. | Retain the existing invalidation bit, remove failure-frame self-scheduling, and verify through public `requestRender()`. |
| Tree-sitter blank body | Correlated worker errors previously left the Code Promise pending while `drawUnstyledText=false`. | Keep R38 client/worker/Tree/Code primary path and real-client cancellation regression. |

The native change is intentionally limited to actual Windows console handles. Redirected stdout continues to use byte writes, preserving pipe/file/PTY UTF-8 bytes. `WriteConsoleW` does not repair a physically blocked terminal consumer; it repairs the local Windows console encoding/write boundary that the current implementation mishandles and gives the existing native status path a valid write operation.

### R39 Exact Eight-File Boundary

R39 changes exactly eight code files:

| Category | Files |
| --- | --- |
| Production (6) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` |
| Regression/harness (2) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

The renderer-specific regression assertions move into the existing `client.test.ts` file at implementation time; `renderer.custom-stdout.test.ts` is not an R39 changed file. No ninth code file, daemon/SSE file, generated file, config, lockfile, release file or native ABI file is authorized.

### R39 Primary Repair

```text
real Windows console handle
  -> detect with GetConsoleMode
  -> convert complete UTF-8 chunks to UTF-16
  -> WriteConsoleW
  -> existing BufferedBackend render status

render-body/native failure
  -> existing diagnostic
  -> retain pending invalidation
  -> no automatic retry
  -> next public requestRender consumes the owner

worker exception
  -> correlated ERROR/WARNING
  -> matching client rejection
  -> Code destroyed guard or existing plain-text error contract
```

No retry, timeout-success, permanent unstyled rendering, second parser, renderer restart, test-only production flag or broad upstream merge is permitted. Existing feed-backed `retryable-skip` remains unchanged.

### R39 Test and Verification Contract

| Slice | Seam | Required evidence |
| --- | --- | --- |
| Windows output | `renderer-output.zig` UTF-8 conversion and redirected-output tests plus compiled normal/target smoke | non-ASCII text remains intact on redirected output; compiled Windows binary passes normal and target scenarios without liveness regression |
| renderer scheduler | public `CliRenderer.requestRender()`/`activateFrame()` in `client.test.ts` | failure does not cause a second frame without a new public request; the next request renders successfully |
| actual cancellation | real `CodeRenderable` + real `TreeSitterClient` worker request held by messageId | one-shot and streaming destroy reject the actual pending request with zero highlight warning |
| Tree ownership | public client edit, streaming update, reset, correlated failure and disposal sequence | repeated accepted replacements remain usable; failed mutation preserves prior accepted state; disposal waits for ack |
| compiled TUI | existing normal and `target-liveness` smoke under external 120-second PID-tree supervisor | exact session/project/message/part/field correlation; Thinking/body, dialog replacement/restoration and zero shutdown warning assertions |

R39 verification must include `git diff --check`, changed-file formatter checks, package tests, package typecheck diagnostics, native tests when available and both bounded compiled smoke scenarios. The plan does not claim that a pipe whose consumer is physically stopped can be forced to display; it verifies the local Windows console boundary and the downstream scheduler/Tree-sitter contracts separately.

### R39 Plan Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R39 | yes | pending independent full-scope plan audit | not started | - |

## R40 Revision Delta

R40 supersedes the R39 scope wording and records the first red-capable default-process-stdout abnormal trace required by the plan auditor. The R39 contradiction is removed: `renderer-output.zig` is explicitly authorized as the single Windows stdout owner, while `buffer.zig`, native ABI, release metadata and all daemon/SSE owners remain excluded.

### R40 Red-Capable First-Divergence Evidence

The bounded throwaway probe `D:\Temp\opencode\stdout-stall-probe.ts` was run from the nested OpenTUI package with a child process whose real `process.stdout` was redirected to a pipe that the parent deliberately did not read. The probe used the real `CliRenderer` and `TextRenderable`, emitted `READY`, received `STOP` through real stdin, then called `renderer.destroy()`. It returned:

```text
RED: default process.stdout render thread blocked shutdown completion after STOP
```

This trace reaches the actual default process-stdout route, not `NativeSpanFeed`: `CliRenderer` selects `BufferedBackend.createStdout`, native `prepareFrame()` marks the frame in progress, `StdoutOutput.write()` blocks on the unconsumed output, and `BufferedBackend.deinit()` waits for that same in-progress write before the process can finish destruction. The user-reported “daemon/backend remains alive while TUI stops advancing, then Ctrl+C cannot finish shutdown” is therefore a reachable output-owner failure shape. The existing normal compiled smoke supplies the positive PTY consumer path; the new probe supplies the negative output-consumer path.

The Windows-specific first divergence remains the local `StdoutOutput.write()` implementation: it uses the generic byte writer for a real Windows console and discards write errors, while upstream commit `a597e88fb0a9a3704c0d487fbcc9e1cde3c64377` adds `GetConsoleMode`, UTF-8-to-UTF-16 conversion and `WriteConsoleW`. R40 backports only this local owner repair. It does not claim that a physically stopped pipe can display frames; the red probe remains a guard that distinguishes an output consumer stall from the Tree-sitter pending path and is not a green test for impossible terminal I/O.

### R40 Exact Scope and Primary Path

The exact eight-file boundary remains:

| Category | Files |
| --- | --- |
| Production (6) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` |
| Regression/harness (2) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

`renderer-output.zig` changes only the Windows console writer; redirected files/pipes retain byte writes, and no native ABI or status contract changes. Renderer failure retention remains non-retrying: failure records the diagnostic and pending invalidation, then the next public `requestRender()` is the only consumer. Tree-sitter remains the correlated request -> client settlement -> accepted Tree/mirror commit path. Renderer-specific regression assertions are consolidated into `client.test.ts`; `renderer.custom-stdout.test.ts` is not part of the R40 diff.

### R40 Verification Contract

```text
thirdparty/opentui/packages/core:
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/renderables/Code.test.ts
  bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts
  bun typecheck
  bun run test:native -Dtest-filter="renderer-output"

packages/opencode:
  normal compiled smoke under external 120-second PID-tree supervisor
  target-liveness compiled smoke under external 120-second PID-tree supervisor
```

The verification record must include `git diff --check`, native build output when the Zig file changes, the real-client held-request cancellation result, repeated edit/stream/reset lifecycle result, exact eight-file count, final per-file `E/C` recount and baseline-only diagnostics. The throwaway red probe is retained outside the repository only as diagnosis evidence; it is not a production/test file.

### R40 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R40 | yes | pending independent full-scope plan audit | not started | - |

## R41 Revision Delta

R41 supersedes R40 where the R40 audit found a missing lifecycle contract and incomplete scope accounting. The R40 default-process-stdout red trace remains valid diagnosis evidence, but R41 no longer treats an unread pipe as proof that `WriteConsoleW` alone fixes the user's console path. The Windows owner must have a behavior-sensitive native test that exercises the `GetConsoleMode` branch when run under a real Windows console; redirected-output tests remain the deterministic local fallback and must report a skip rather than a false pass when no console handle is available.

### R41 Mutation-Rejection Recovery

The client lifecycle owner must recover after any correlated mutation rejection:

```text
accepted state
  -> mutation request rejects
  -> current request rejects and accepted mirror remains
  -> same-buffer next edit/stream/reset still enters worker in order
  -> successful response commits the next accepted state
```

`enqueueBufferOperation` must not let a rejected tail poison later ordinary mutations. The disposal operation still waits for the prior operation's settlement and remains the only cleanup operation allowed to continue after failure. The regression must hold the first correlated `ERROR`, prove the next request is actually posted, complete it with a successful response, and assert the accepted mirror/version/content contract.

### R41 Native Scope and Comment Budget

R41 changes exactly eight code files: six production files (`renderer.ts`, `client.ts`, `parser.worker.ts`, `types.ts`, `Code.ts`, `zig/renderer-output.zig`), one existing nested regression file (`lib/tree-sitter/client.test.ts`) and the existing OpenCode smoke harness. `renderer.custom-stdout.test.ts` is not changed; its R37 renderer assertions are migrated into `client.test.ts` without creating a new test file.

| Production file | Planned `E_i` ceiling | Required qualifying Chinese `C_i` minimum |
| --- | ---: | ---: |
| `renderer.ts` | 100 | 15 |
| `client.ts` | 150 | 23 |
| `parser.worker.ts` | 200 | 30 |
| `types.ts` | 20 | 3 |
| `Code.ts` | 25 | 4 |
| `zig/renderer-output.zig` | 85 | 13 |
| **Total** | **580** | **88 across files, independently** |

The Zig comments must explain only the real Windows handle distinction, UTF-8 chunk/surrogate boundary, redirected-output compatibility and error-preserving write behavior. They must be adjacent to those decisions; restating assignments or native control flow does not count. Final implementation recount, not this ceiling, is authoritative.

### R41 Verification Contract

From the nested core package:

```text
bun run build                         # repository-required native/TS build prerequisite
bun test ./src/lib/tree-sitter/client.test.ts
bun test ./src/renderables/Code.test.ts
bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts
bun run test:native -Dtest-filter="renderer-output"
bun typecheck
```

From the repository root, `bun run script/build.ts --target bun-windows-x64 --single --skip-install --skip-embed-web-ui` rebuilds the compiled binary after the Zig change. From `packages/opencode`, both normal and `target-liveness` smoke scenarios run under the external 120-second PID-tree supervisor. The verification record must include `git diff --check`, native test result including explicit console-handle skip/pass state, real-client cancellation, mutation-rejection recovery, normal smoke, target smoke and final per-file E/C.

### R41 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R41 | yes | pending independent full-scope plan audit | not started | - |

## R42 Revision Delta

R42 supersedes R41 in three precise places. First, the existing renderer regression owner remains in scope and its automatic-retry assertions are changed to the approved no-retry contract; it is not left unchanged or duplicated elsewhere. Second, the command-panel requirement receives an explicit surface invariant and owner mapping. Third, mutation rejection recovery is tested as a public same-buffer lifecycle contract.

### R42 Command-Panel Surface Invariant

| ID | Invariant | Producer/consumer owner | Evidence and regression |
| --- | --- | --- | --- |
| R42-INV-08 | A `dialog.replace` or `dialog.clear` transition must invalidate the affected surface so the next committed frame contains the current dialog background/cells and no stale `Commands`/black fragments. | Existing OpenCode `CommandPaletteProvider`/`DialogContext` is the producer; `CliRenderer` frame commit is the consumer and owner of the visible cell refresh. No command-palette logic change is authorized because `dialog.replace` and `dialog.clear` already perform the intended state transition. | Compiled target smoke opens `Commands`, captures the replacement, sends Escape/selection, then requires `Commands` to disappear and the body sentinel/background region to be visible in a later PTY frame. The renderer scheduler/native output regressions are the first-divergence probes; a failure with correct dialog state maps to the renderer/output owner, not Tree-sitter. |

This is a pass-through owner mapping, not a detection-only requirement: the existing dialog producer is proven by `command-palette.tsx:44-95,128-139`; the repair is at the downstream frame owner already responsible for committing current cells. No seventh OpenCode production file is added.

### R42 Mutation-Rejection Primary Path

```text
accepted buffer mirror/tree
  -> correlated worker ERROR
  -> reject only current operation
  -> settle lifecycle tail without poisoning it
  -> next same-buffer edit/stream/reset posts a new message
  -> correlated success commits the new accepted state
```

`enqueueBufferOperation` is the sole owner. Normal mutation operations continue after a predecessor rejection; disposal still waits for predecessor settlement and removes the mirror only after its own correlated ack. The red test holds the first worker error, asserts the second request was posted, resolves that request successfully, and checks the public buffer state. No retry or alternate parser is introduced: this is Promise-tail settlement, not operation retry.

### R42 Exact Eight-File Boundary

R42 changes exactly eight code files:

| Category | Files |
| --- | --- |
| Production (5) | `thirdparty/opentui/packages/core/src/renderer.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts`; `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts`; `thirdparty/opentui/packages/core/src/renderables/Code.ts`; `thirdparty/opentui/packages/core/src/zig/renderer-output.zig` |
| Regression/harness (3) | `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts`; `thirdparty/opentui/packages/core/src/tests/renderer.custom-stdout.test.ts`; `packages/opencode/script/smoke-opentui-artifact.ts` |

The `types.ts` wire changes from earlier revisions are not carried as an independent diff in R42. Equivalent correlated request/response shapes are declared at the existing client/worker transport owners and are consumed through the existing unknown worker boundary; no public type/API change is added. This keeps the file cap at eight while retaining one runtime protocol owner per direction. `types.ts` remains unchanged in R42.

### R42 Comment and Verification Budget

| Production file | Planned `E_i` ceiling | Required qualifying Chinese `C_i` minimum |
| --- | ---: | ---: |
| `renderer.ts` | 100 | 15 |
| `client.ts` | 170 | 26 |
| `parser.worker.ts` | 200 | 30 |
| `Code.ts` | 25 | 4 |
| `zig/renderer-output.zig` | 85 | 13 |
| **Total** | **580** | **88 across files, independently** |

The two regression files must both be updated: renderer failure tests must prove no clock-only retry and next-public-invalidation recovery; client tests must prove real worker cancellation, Tree lifecycle and post-rejection tail recovery. The final implementation recount is authoritative.

### R42 Verification Contract

```text
repository root:
  bun run build
  bun run script/build.ts --target bun-windows-x64 --single --skip-install --skip-embed-web-ui
  git diff --check

thirdparty/opentui/packages/core:
  bun test ./src/tests/renderer.custom-stdout.test.ts
  bun test ./src/lib/tree-sitter/client.test.ts
  bun test ./src/renderables/Code.test.ts
  bunx oxfmt --check src/lib/tree-sitter/client.ts src/lib/tree-sitter/parser.worker.ts
  bun run test:native -Dtest-filter="renderer-output"
  bun typecheck

packages/opencode:
  normal and target-liveness compiled smoke under external 120-second PID-tree supervisors
```

Native console-specific tests must record pass or explicit skip for the real `GetConsoleMode` branch; a pipe-only probe cannot be promoted to console proof. All changed-file diagnostics, E/C exclusions and command-panel surface predicates are recorded before implementation audit.

### R42 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R42 | yes | pending independent full-scope plan audit | not started | - |

## R43 Revision Delta

R43 resolves the R42 plan-audit blocker by assigning the native test owner inside the already-authorized `thirdparty/opentui/packages/core/src/zig/renderer-output.zig`; no ninth code file is added and the eight-file boundary remains unchanged.

### R43 Native Test Owner

The same Zig file will contain behavior-sensitive tests adjacent to `StdoutOutput`:

| Test | Behavior | Non-console behavior |
| --- | --- | --- |
| UTF-8 chunk conversion | Independent literals cover ASCII, multibyte BMP, supplementary-plane surrogate pairs, chunk boundaries and invalid UTF-8. | Always runs; no console required. |
| redirected output | A temporary redirected file receives split UTF-8 writes and the bytes are compared exactly. | Always runs; proves pipe/file compatibility remains byte-preserving. |
| Windows console branch | On Windows, `StdoutOutput.init()` must detect a real console handle; the test invokes the UTF-16 `WriteConsoleW` path with a non-ASCII ANSI sequence and asserts the write result. | Returns `error.SkipZigTest` when stdout is not a console handle; the command records skip explicitly and cannot report a false pass. |

The production writer keeps redirected `WriteFile`/byte behavior and uses `WriteConsoleW` only after `GetConsoleMode` confirms a real console handle. The native test therefore observes the actual branch decision and the actual write result rather than testing a copied conversion helper alone.

### R43 Scope, Budget and Verification

The exact scope remains five production TypeScript files, one production Zig file containing its own tests, two existing TypeScript regression/harness files, and no independent `types.ts` diff: eight code files total. Planned production ceiling remains 580 effective lines. `renderer-output.zig` planned `E_i<=85` and requires at least 13 qualifying Chinese explanatory comments near the Windows handle distinction, UTF-8 chunk boundary, redirected compatibility and write-result handling.

Required native command from `thirdparty/opentui/packages/core`:

```text
bun run test:native -Dtest-filter="renderer-output"
```

The verification record must include the native test's explicit `pass` or `SkipZigTest` state, repository-root `bun run build`, compiled Windows binary build, both bounded compiled smoke scenarios, package tests/typecheck/formatter checks, `git diff --check`, mutation-rejection recovery, actual Code/Tree-sitter held request cancellation, command-panel surface predicates and final per-file E/C. No implementation is authorized until R43 receives a full-scope plan approval.

### R43 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R43 | yes | pending independent full-scope plan audit | not started | - |

## R44 Revision Delta

R44 resolves the R43 native-verification blocker without weakening the Windows gate. The native test remains inside `renderer-output.zig`, but when the test process starts with redirected stdout it creates an owned Windows console with `AllocConsole`, opens `CONOUT$`, verifies `GetConsoleMode`, and exercises the same `StdoutOutput`/UTF-16/`WriteConsoleW` branch against that real console handle. It restores the previous console state and closes the test handle. A native process that cannot create or open a console returns an explicit skip; the compiled Windows verification path treats that skip as incomplete rather than success.

R44 also restates the mutation-rejection contract in the current authority: `enqueueBufferOperation` must settle a rejected predecessor before allowing the next ordinary same-buffer operation to post; the current request rejects, the accepted mirror remains, and the next correlated success commits normally. Disposal keeps its independent ack and cleanup contract.

### R44 Scope and Verification

The eight-file boundary and five-production-file plan remain unchanged. The `renderer-output.zig` test owner contains the console allocation/open/restore logic; no native test file is added. Required native verification is:

```text
bun run test:native -Dtest-filter="renderer-output"
```

The test output must distinguish `console branch passed`, `redirected compatibility passed`, `non-Windows skipped`, and `console allocation/open failed`. Only the first two together satisfy the Windows output gate. All R44 package tests, root build, compiled normal/target smoke, mutation-rejection recovery, command-panel surface assertions, diff check and final E/C recount remain required.

### R44 Audit Record

| Round | Revision | Full original scope? | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R44 | yes | pending independent full-scope plan audit | not started | - |

## R32 Historical Archive (Non-normative)

### 1. Verbatim Requirement

> “根本需求是修正原有产生的opencode的TUI卡死（表现为交互失效，只有基本的TUI渲染，如prompt区域pending的blink，其他命令面板交互无响应、所有内容均不再进行更新与响应的问题）使其之后不再会产生类似的TUI自身渲染卡死、失去响应问题，同时解决在结束之后会爆出大量的（Code streaming highlight failed, falling back to plain text: warn: TreeSitter client destroyed）的问题、禁止添加和‘根治’操作无关的任何修改，也就是最终目的不是让报错更加明显，而是解决报错的根因；与此同时，还要根治TUI正文不渲染且只有markdown的标号的问题，即存在大面积空白、只有1. 2.这种渲染的问题；同时，整体修改量代码不超过8个文件，生产代码修改量不800行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改，避免引入过于复杂的状态机或者代码为每种边界情况都进行分支，更好的应该是顶层设计保持简单，逻辑完整而不复杂，从第一性原理出发，不对不可能存在的输入进行假设，当出现边界情况考虑不周到时，应检查顶层机制设计是否合理，而不是继续添加分支判断。”

R32 不把“显示更多日志”“始终显示未高亮文本”“超时后伪造成功”“重试直到成功”视为修复。目标是修复实际 first divergence，并使原始症状反馈回路在正常、正文错误、退出中请求和 Windows compiled TUI 场景逐项通过。

### 2. Current Behavior and Evidence

| Path | Current evidence | Status |
| --- | --- | --- |
| OpenCode renderer construction | `packages/opencode/src/cli/cmd/tui/app.tsx:177-190,272` does not pass a custom stdout; `renderer.ts:1000-1005` therefore selects the process-stdout buffered backend, not `NativeSpanFeed`. | confirmed |
| Windows/native output | `renderer-output.zig:281-286` returns `skipped` while `renderInProgress`; `:459-487` keeps that flag set while synchronous `stdout.write()` runs. `renderer.zig:723-754` maps the status to the JS renderer. | reachable candidate, not yet the user repro |
| JS render scheduler | `renderer.ts:4373-4504` resets `rendering` in `finally`; `:4488-4496` delegates backpressure/failure scheduling to status handlers. A thrown frame callback/root/native operation is not converted into a successful frame or a new scheduled frame by `loop()`. | reachable candidate, not yet the user repro |
| Custom stdout feed | `renderer.ts:1005,1061-1076` allocates `NativeSpanFeed` only for non-process stdout; `:1410-1435` waits for `feed.idle()`; `requestRender()` coalesces while `feedIdleRenderScheduled` is true. The bounded probe reproduced this exact coalescing, but this is not OpenCode's default output path. | confirmed secondary path |
| Worker error completion | `parser.worker.ts:1202-1207,1377-1382` can emit a generic error without request correlation; `client.ts` request callbacks can remain pending; Session keeps `drawUnstyledText={false}` at `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2065-2154`. | confirmed blank-body path |
| Persistent Tree ownership | `parser.worker.ts:967-1093` replaces persistent Trees; the prior Tree must be explicitly deleted, while one-shot cleanup at `:1096-1154` proves the ownership contract. | confirmed leak path |
| Shutdown warning | `Code.ts:390-489,655-689` can log before checking `isDestroyed`; renderer teardown destroys pending Tree-sitter requests before Code catches them. | confirmed warning path |
| Daemon/SSE | `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:95-209` has reconnect/heartbeat; `thread.ts:155-179` only reports a still-running daemon after TUI exit. No current evidence proves daemon disconnect is the renderer first divergence. | currently excluded from production change |
| Compiled smoke | `packages/opencode/.artifacts/opentui-smoke/failure.json` reports `compiled live error logs missing`, not a proof of blank-body recovery or global renderer liveness. | verification gap |
| Upstream renderer delta | `upstream` currently has tag `v0.5.1` and main `265d9310735e06b9fddf274a14813a119d8f93e5`; upstream added `fix(core): emit render errors (#1314)` and `fix(core): harden renderer resolution lifecycle (#1306)` after the local `v0.4.3-smark.6` line. | relevant external evidence |
| Upstream Windows output delta | Upstream `v0.5.1` includes `core(renderer): write Windows console output with WriteConsoleW (#1272)`, replacing code-page-dependent console writes. | relevant Windows compatibility evidence; not yet proven as this symptom's first divergence |
| Upstream Markdown/scrollbox delta | Upstream history includes `Fix markdown blank scrollbox (#1150)` and `fix(renderable): ensure rendering is requested after highlight updates (#1020)`; the current local tree already contains a corresponding scrollbox visibility regression test and current Code streaming render requests. | partially present; do not duplicate blindly |

### 3. Supported Domain and Reachability

The supported failure domain is a Windows compiled OpenCode TUI using process stdout, OpenTUI target FPS 60, real daemon/SSE session updates, streaming `CodeRenderable` content, command-panel navigation, terminal resize and Ctrl+C while a highlight request is in flight. Custom stdout feed behavior is a separate OpenTUI compatibility path and may be tested only to prevent a regression in its own contract.

The plan does not assume a worker error, output write stall, malformed terminal input or daemon disconnect unless the corresponding producer is reached by the red-capable harness. The current source proves the producers for Tree-sitter errors, synchronous process-stdout writes and SSE reconnect, but only the Tree-sitter pending path has reproduced the user's exact blank-body symptom so far.

### 4. Requirements and Invariants

| ID | Invariant |
| --- | --- |
| R32-INV-01 | Every user-visible renderer invalidation either commits a frame or reaches an explicit, observable terminal failure; it must not silently leave the scheduler with no future render owner. |
| R32-INV-02 | A Windows native output/backend state cannot leave all later frames permanently skipped while the TUI remains apparently alive. A skip must have a reachable owner that completes or fails the same output attempt. |
| R32-INV-03 | Every messageId-bearing Tree-sitter request settles exactly once through its own response channel; a worker exception cannot leave the Code consumer pending until destroy. |
| R32-INV-04 | A persistent parser state owns exactly one accepted Tree; replacement, candidate failure and disposal each have one terminal delete/transfer owner. |
| R32-INV-05 | A rejected highlight request preserves the existing accepted source/error contract; `drawUnstyledText=false` is not changed to mask protocol failure. |
| R32-INV-06 | Expected destruction cancellation is silent, while a live worker/render failure remains diagnosable once and is not multiplied by teardown. |
| R32-INV-07 | Daemon/SSE connection state and local renderer state remain distinguishable; a healthy daemon cannot be declared a TUI render success, and a local render stall cannot be misdiagnosed as daemon exit. |
| R32-INV-08 | Dialog transitions and width-sensitive output refresh the affected cell region from the current render state; no stale background or out-of-bounds line-width behavior is accepted as a side effect of the liveness repair. |

### 5. First Divergence Analysis

The first divergence for the confirmed blank-body symptom is the worker-to-client request completion boundary: a request carrying an id enters a generic error path that does not complete the matching client callback. The downstream blank body is caused by the Code consumer correctly waiting for highlight state while unstyled drawing is disabled.

The first divergence for the confirmed shutdown warning is the Code catch ordering: expected destroy cancellation is classified and logged as a live highlight failure before the renderable destruction state is checked.

The whole-TUI liveness invariant is now proven violated at a reachable renderer seam: a real `RootRenderable -> renderSelf -> renderer.loop()` exception leaves `isRunning=true`, `isRendering=false` and `hasScheduledRender=false`; the bounded probe fails with `RED: render exception left a live renderer without a scheduled next frame`. This is the same scheduler shape as “prompt blink remains but no later UI frame is committed”, although the probe has not yet proven that the user's Windows screenshot reaches this exception rather than a native output stall. The strongest competing candidate is the process-stdout native handoff: the native render thread performs synchronous output while `renderInProgress` remains true, the next native frame returns `skipped`, and the JS scheduler continues only through its status-specific retry owner. The compiled path must distinguish these two before a native production edit is authorized.

### 6. Feedback Signal and Current Result

The following bounded probe was already executed from `thirdparty/opentui/packages/core`:

```text
bun -e '<CliRenderer custom stdout probe: hold the Writable write callback, trigger a real feed write, force the native skip status, call requestRender, release the callback, and destroy>'
```

Observed result:

```json
{"backpressured":true,"feedIdleRenderScheduled":true,"requestCoalesced":true,"recovered":true}
```

The renderer exception probe was then run from the same package directory through the real test renderer and a throwing `Renderable`; it failed as intended with:

```text
error: RED: render exception left a live renderer without a scheduled next frame
```

This is a red-capable renderer-liveness seam. The custom stdout probe only proves a secondary feed contract and is not sufficient evidence for the OpenCode process-stdout failure. The prior compiled smoke is also not red-capable for the original blank-body symptom because it failed at `compiled live error logs missing` before proving the user-visible error body.

R32 is ready for independent plan audit, but the compiled Windows scenario remains a blocking verification gate for implementation. That scenario must record, at the same producer timestamp, daemon SSE receipt, input acknowledgment, renderer scheduler state, native frame completion, visible body text, dialog background refresh and shutdown warnings. It must fail on the original “prompt blink only / no body / no command-panel update” symptom, not merely on a missing log line.

### 7. Single Primary Repair Direction

The confirmed Tree-sitter repair remains one primary request path: correlated worker response -> matching client settlement -> accepted mirror/Tree ownership commit -> existing Code success or existing parser-error text contract. It includes prompt Tree deletion and destroyed-warning classification only where those owners already exist.

The renderer primary repair follows the now-proven JS scheduler divergence: catch a render-pass exception at the renderer boundary, publish the owning renderable as a render error, and establish the next frame schedule when the renderer remains live. The implementation must use the existing `RootRenderable` traversal owner rather than add a second renderer or fallback buffer. The compiled liveness loop still decides whether a separate native output repair is necessary; a native edit is not assumed from the custom feed probe.

The daemon/SSE path remains diagnostic unless the same loop proves that an event is produced by the daemon but not consumed by the TUI. If SSE receipt continues while renderer frames stop, `sdk.tsx` is not an implementation owner and remains zero-diff.

### 8. Secondary Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| Correlated Tree-sitter response | supported primary contract | repair |
| Existing Code parser-error plain-text commit | shipped compatibility | preserve; do not add another fallback |
| Unmatched worker diagnostic event | diagnostic only | preserve without pretending to settle a request |
| Process stdout native output | primary OpenCode liveness candidate | repair only after compiled red proof |
| Custom stdout `NativeSpanFeed` | separate compatibility path | test only unless production reachability is proven |
| Daemon/SSE reconnect | existing transport behavior | do not modify without producer/consumer divergence |
| timeout, retry, second parser, raw-text emergency route, renderer restart | forbidden fallback | reject |

### 9. Provisional File Boundary

The maximum allowed code-file set is eight. The only files eligible for the approved revision are:

| File | Role |
| --- | --- |
| `thirdparty/opentui/packages/core/src/renderer.ts` | JS scheduler/status owner if compiled liveness proof lands there |
| `thirdparty/opentui/packages/core/src/Renderable.ts` | current renderable owner for an exception emitted during root traversal |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | correlated response contract |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | callback settlement, accepted mirror and mutation/disposal ordering |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | correlated exception and persistent Tree ownership |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | destruction-warning classification |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | request, Tree and Code visibility regression seam |
| `thirdparty/opentui/packages/core/src/tests/renderer.render-error.test.ts` | renderer exception publication and next-frame liveness regression seam |

`NativeSpanFeed.ts`, `renderer-output.zig`, `sdk.tsx`, `thread.ts`, `Code.test.ts`, repository smoke, `buffer.zig`, other native files and generated artifacts are not approved targets in R32 unless the compiled liveness evidence proves the current owner boundary; such a change would require a new revision and audit. The provisional set remains exactly eight code files: six production files and two regression-test files.

### 9A. Forward Traceability

| Requirement / invariant | Producer -> consumer path | Approved file owner | Behavioral evidence |
| --- | --- | --- | --- |
| R32-INV-01 | `RootRenderable.render()` exception -> `CliRenderer.loop()` -> scheduler state | `Renderable.ts`, `renderer.ts` | red renderer probe: current live renderer has no scheduled next frame; future regression requires render error publication and continued scheduling |
| R32-INV-02 | native render/output status -> JS renderer status handler -> next frame owner | `renderer.ts` only unless compiled proof reaches native output | bounded process-stdout compiled liveness scenario plus native status trace |
| R32-INV-03/05 | worker request error -> correlated response -> `TreeSitterClient` callback -> `CodeRenderable` visible contract | `types.ts`, `client.ts`, `parser.worker.ts`, `Code.ts` | forced worker-error request rejects once and current body becomes visible without waiting for destroy |
| R32-INV-04 | accepted Tree -> candidate/replacement/dispose -> worker delete/transfer | `parser.worker.ts`, `client.ts` | repeated edit/stream/reset/dispose ownership test and fixed-length RSS observation |
| R32-INV-06 | renderer/client destroy -> pending Code rejection -> lifecycle guard | `Code.ts`, `client.ts` | one-shot and streaming shutdown with zero expected cancellation warnings |
| R32-INV-07 | daemon SSE producer -> SDK subscriber -> TUI state -> renderer frame | no production file until divergence is proven | compiled trace records SSE receipt independently from frame advancement |
| R32-INV-08 | dialog/resize layout state -> root render buffer -> terminal frame | existing renderer/renderable owners only if a failing path is observed | bounded dialog/resize capture asserts current background and width-sensitive rows |

### 9B. Reverse Traceability

| Proposed concept | Requirement | Evidence | Why reuse is insufficient |
| --- | --- | --- | --- |
| Render error event with current renderable context | R32-INV-01 | upstream `#1314` adds `RootRenderable.currentRenderable` and `CliRenderEvents.RENDER_ERROR`; local source lacks both | current `handleError` sees only an unclassified process rejection and `loop()` strands the live scheduler |
| Final scheduling in the render-error `finally` boundary | R32-INV-01 | local red probe leaves `isRunning=true` with no scheduled render | existing status branches do not execute after a thrown render pass |
| Correlated worker error completion | R32-INV-03/05 | current generic worker error drops request identity and observed callback stays pending | Code cannot settle a promise from an event-only diagnostic |
| Single accepted Tree owner and explicit delete/transfer | R32-INV-04 | runtime exposes `Tree.copy()`/`delete()`; current replacement handlers overwrite the owner | client cannot release WASM objects owned by the worker |
| Destroyed guard before warning | R32-INV-06 | current Code catch order produces the user's shutdown warning flood | client does not know which renderable has been destroyed |
| Separate daemon/frame observations | R32-INV-07 | current SDK has reconnect behavior and current smoke only proves health/SSE attach, not frame liveness | changing SDK transport without a producer/consumer divergence would be speculative |

### 10. TDD and Verification Slices

1. Reproduce the compiled process-stdout liveness failure with a bounded Windows PTY harness; assert body, command-panel transition, frame advancement and daemon SSE receipt separately.
2. Reproduce the confirmed correlated Tree-sitter error; assert the public request rejects once, the Code body becomes visible through the existing error contract and no callback remains pending.
3. Reproduce persistent edit/stream/reset replacement and disposal; assert one accepted Tree owner and bounded cleanup without changing the stable-prefix Markdown algorithm.
4. Reproduce one-shot and streaming Code destruction; assert zero expected shutdown warnings and preserve one live failure diagnostic.
5. Reproduce dialog/resize/full-region refresh through an existing renderer boundary; assert no stale background fragments and no width/scrollbar regression is introduced by the liveness fix.
6. Run the original compiled normal/error/shutdown workload after the narrow package tests, all under an external 120-second process-tree supervisor. A hanging client/full package test is a failed verification, not a reason to remove the boundary.

### 11. Verification and Diff Gates

- No implementation audit until the compiled liveness harness is red-capable and has been run once against the original symptom.
- After approval, production changed code must be `<=800` lines and the total code-file set `<=8`; these are hard gates, not targets to be met by omitting required behavior.
- Every changed file with effective code `E>0` must contain `C >= max(1, ceil(E*0.15))` qualifying nearby Chinese explanatory comments; the count is per file.
- R32 provisional production budget is `E_p/raw <=800` across six files; the two test files are separately counted in the eight-file cap. Any implementation diff that exceeds the budget requires a new R33 plan revision, not formatting-based accounting.
- The expected R32 comment burden is calculated per changed file after the minimal diff is known; comments must explain the scheduler ownership invariant, worker response contract, Tree owner transfer or shutdown compatibility boundary, not restate statements.
- Focused tests run from package directories with `bun test`; OpenTUI typecheck runs from `thirdparty/opentui/packages/core`; OpenCode checks run from `packages/opencode`.
- Full client/package tests are never run without the external process-tree supervisor and a bounded timeout.
- No benchmark expansion is required in R32. Existing timing/RSS artifacts are evidence only; new measurements are added only when they distinguish the proven first divergence or verify the final user-visible liveness contract.

### 12. Risks and Rejected Speculation

- A blocked OS stdout write may make output physically impossible until the terminal accepts bytes; the repair must not claim to display frames that cannot reach the terminal. The harness must distinguish this from a scheduler state that lost its owner.
- The custom stdout feed probe is not evidence for the default OpenCode process-stdout path and must not drive a production change by itself.
- `TreeSitter client destroyed` at shutdown is expected cancellation noise only when a request is still in flight; suppressing the warning cannot repair the original pending request.
- Stable-prefix Markdown, width measurement, ScrollBox/ScrollBar geometry, background repaint and daemon reconnect are not presumed causal from screenshots alone. They enter production scope only with a reachable failing producer and an owner-specific regression.
- No fallback, retry, timeout-success, duplicate parser, renderer restart or telemetry is authorized by this draft.

### 13. Audit Contract

The future plan audit must independently inspect the complete R32 requirement, the compiled red-capable liveness path, the process-stdout native/JS producer-consumer chain, daemon/SSE distinction, Tree-sitter request/Tree/Code paths, dialog/width evidence, the exact eight-file boundary, production `<=800`, per-file Chinese comment gate and all rejected fallbacks. The primary agent must hand off only the verbatim requirement, this plan path, repository root and `Audit mode: plan`.

## R31 Archive Boundary (Non-normative)

Everything after this marker is retained only to preserve historical investigation and audit traceability. It is not an implementation requirement, budget, approval, file list, root-cause conclusion or verification result for R32. Any conflict is resolved in favor of the R32 sections above.

整体验收分为独立且fail-closed的三层：package benchmark验证public mutation、240-frame oracle、stable-prefix timing和500→3000 RSS；build-local产出current/HEAD artifacts并验证core/worker及spinner identity；compiled fixture以相同16ms producer执行typing、240 delta、resize、error和shutdown。任一phase缺少binary、baseline、依赖、raw timestamp或cleanup都失败。Current cadence≥85% HEAD，input p95≤`max(100ms,1.15×HEAD)`；原始error body仍须≤150ms可见。

## 1. Verbatim Requirement

> “当前请注意你的整体当前的方案内容,并该放在一个全新的markdown里面,也就是放在一个全新的一个相应的计划里面,然后包含对如上内容的修复。同时整体的修复的代码修改量不超过六个生产文件,同时修改量不超过600行,避免进行重大的一些重构等等,请保持精准修改,完整解决那些有问题的逻辑,也就是完整解决我们之前的所有的问题,包括相应的长时间空排,Ctrl C后批量报错等等的一些特定缺陷。”

> “同时自行进行相应的benchmark测试，你可以自行在.temp/testing中进行相应测试，让整体卡顿以及FPS保持在可接受范围以及有显著提升的状态。”

> “请注意整体代码修改量不超过六百行,尽量保持整体实现不冗余、简洁。且即使修改理论来说需要替换或者移除已有的内容,同时需要保证你的代码的注释量必须超过15%以上的行数,同时不能扎堆放你的注释。”

> “不要主动构建一个理论上会发生错误的测试，这无任何意义，要的是进行benchmark，可以构建一个markdown文档，验证不同的更新算法的速度以及和全量渲染相应的等价性等等。”

> “整体修改量代码不超过6个文件，生产代码修改量不超过600行，避免进行重大的功能或重构等内容，实现整体保持甜点级别修改。”

> “自行完整检查是否有任何问题再提交审计，避免浪费审计机会，这是你最后的机会,最后6次”

> “这是新的6次”

本计划同时保留用户此前明确的约束：保持 stable prefix 只缓存已闭合内容；未闭合尾部继续由当前 persistent Markdown 主路径全量更新；不引入复杂状态机、第二 parser、补救性 commit 或与当前 primary path 竞争的 fallback。用户最新明确给出“这是你最后的机会,最后6次”，R30是该最终六轮full-scope plan audit周期的第4轮。

## 2. Explicit Non-Goals

- 不修改 R62 已验证的 stable-prefix、`tailStart`、引用状态、closing-fence normalization 或 prefix/tail chunk composition 算法。
- 不把 `drawUnstyledText=false` 改成常开；正文可见性必须通过请求成功/错误完成协议恢复，不能用始终显示未高亮文本掩盖 worker 协议错误。
- 不新增 worker watchdog、超时重试、第二 parser、feature flag、降级 parser 或 catch-and-success 路径；当前证据证明的是异常响应未完成，不是静默超时协议。
- 不修改 `buffer.zig`、宽字形 alpha、ScrollBox 首帧 scrollbar、ScrollBar 负位置、resize full repaint、detached TextNode 或 `Locale.truncate`；这些是独立 owner，不能借本计划扩大范围。
- 不修改 package version、lockfile、release、tag、provenance、parent gitlink、native/Zig ABI 或 OpenTUI 发布流程。
- 不删除现有 parser-error 后提交当前 source plain text 的已发布兼容行为；它是现有 Code 合同，不是本计划新增的替代成功路径。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | OpenTUI core 位于 `thirdparty/opentui/packages/core`；TUI 正文使用 `CodeRenderable`，Session/Message 是 opencode 当前词汇。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复 first divergence；一个 authoritative primary path；无证据不得增加边界；无批准不得实施。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须包含证据、责任、双向 traceability、TDD、验证、预算和审计记录。 |
| `AGENTS.md` | 使用 Bun；不要从仓库根运行测试；保持最小修改。 |
| `thirdparty/opentui/AGENTS.md` | OpenTUI 测试从 package 目录运行；native 变更才需要 native build；必须先构建可复现 feedback loop。 |
| `packages/opencode/AGENTS.md` | opencode package 测试/类型检查使用 package-local 命令。 |
| `packages/opencode/test/AGENTS.md` | 测试使用真实 seam，避免通过 sleep 猜测异步完成；优先公开行为和真实 worker 边界。 |
| `docs/adr/README.md` | 本计划是局部 lifecycle repair，不新增跨模块 ADR。 |
| `docs/plans/opentui-streaming-markdown-performance-repair.md` R62 | 已验证的 persistent Markdown 算法基线；其明确排除了本次 request cancellation/lifecycle 范围。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/core/src/lib/tree-sitter/types.ts:66-131` | 带 `messageId` 的 request/response 已存在；通用 `ERROR` 缺少关联 message id。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts:151-198,421-557` | callback map 的完成和 generic `ERROR` 的当前分流；generic error 只 emit，不 reject callback。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts:685-730` | streaming update 是 awaitable，但没有独立错误完成通道。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts:795-834` | destroy 会 reject 全部 pending request，错误文本为 `TreeSitter client destroyed`。 | observed |
| `packages/core/src/lib/tree-sitter/client.ts:849-865` | public `resetBuffer()` 经 debouncer 进入真实 `RESET_BUFFER` worker 路径。 | reachable |
| `packages/core/src/lib/tree-sitter/client.ts:639-663,738-750` | public `updateBuffer()` 经 ProcessQueue 进入真实 `HANDLE_EDITS` worker 路径。 | reachable |
| `packages/core/src/lib/tree-sitter/client.ts:649-662,849-864` | ordinary edit/reset 在 worker acceptance 前先提交 client `buffers` 镜像，worker 失败时会与旧 Tree/content 分叉。 | reachable |
| `packages/core/src/lib/tree-sitter/client.ts:671-681` | streaming buffer 用空内容初始化后，当前 client 直接写入首个 source；R7 保留空 accepted mirror，首个 update 才提交 source。 | reachable |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:26-42` | persistent `ParserState` 对 current Tree 只有单一字段 owner。 | observed |
| `packages/core/src/lib/tree-sitter/parser.worker.ts` runtime probe | 安装版本的 `Tree.prototype` 确实提供 `copy()` 和 `delete()`；真实 Markdown parse probe 得到 `accepted="a"`, `candidate="a++"`, `isolated=true`，候选 edit 不修改 accepted Tree。 | observed |
| `packages/core/src/platform/worker.ts:330-335` | worker message listener 对每条消息执行 `void handler(...)`，同一 buffer 的顺序不能由 worker runtime 自动保证。 | observed |
| `packages/core/src/lib/queue.ts:4-51` | 当前 ProcessQueue 串行调用但吞掉 processor rejection，且 enqueue 不返回完成 Promise。 | observed |
| `packages/core/src/lib/debounce.ts:25-46` runtime probe | 相同 debounce key 被替换后旧 Promise 保持 pending；只有实际执行的最新 callback 完成。 | observed |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:555-589,1259-1281` | ordinary edit 应用多个 `tree.edit()` 后覆盖 current Tree，同样没有 delete previous Tree。 | reachable |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:940-943,967-1051` | injection 临时 Tree 会 delete；persistent replacement 当前没有使用 `Tree.copy()` 隔离 candidate，也没有及时 delete 被替换的 Tree。 | observed |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:1053-1093` | reset 在 parse 成功后覆盖 current Tree 且不 delete previous Tree；dispose 只释放最终 current Tree。 | reachable |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:1096-1154` | one-shot 路径显式 delete，证明 WASM Tree 生命周期合同。 | observed |
| `packages/core/src/lib/tree-sitter/parser.worker.ts:1202-1207,1377-1382` | worker catch 只能发送 bufferId/error，丢失带 messageId 请求的完成关联。 | observed |
| `packages/core/src/renderables/Code.ts:317-343,392-458` | `drawUnstyledText=false` 下当前正文等待 highlight；worker rejection 进入现有 plain-text compatibility。 | observed |
| `packages/core/src/renderables/Code.ts:640-676` | one-shot catch 在 `isDestroyed` 检查前打印 warning。 | observed |
| `packages/core/src/renderables/Code.test.ts:1158-1189,1706-1741,2355-2394` | 既有可见性和 parser-error 合同，必须保持 `drawUnstyledText=false` 语义。 | observed |
| `packages/core/src/lib/tree-sitter/client.test.ts:1304-1357,1435-1485` | 已有真实 worker、pending request、streaming buffer 和 cleanup seam。 | observed |
| `packages/core/src/lib/tree-sitter/cache.test.ts` | 现有真实 client lifecycle/cache 测试入口。 | observed |
| `packages/core/src/benchmark/markdown-benchmark.ts:262-360,1438-1522` | 已有 frame-independent Markdown timing、RSS/native memory sampling 和 streaming scenario。 | observed |
| `packages/opencode/script/smoke-opentui-artifact.ts:54-409` | 现有真实编译 OpenCode TUI workload，覆盖 input-ready、Session、resize、spinner、completion、PTY transcript 和 shutdown。 | observed |
| `packages/opencode/script/smoke-opentui-artifact.ts:131-144,376-380,439-553` | 现有smoke每16ms无条件记录frame time，只提交一次`hello`；它能做功能smoke，但不能区分prompt/Markdown cell advance或产生contracted并发workload。 | observed |
| `.temp/testing/opentui-lifecycle-benchmark.ts:266-340` | R22 generated copy只替换SSE和completion前短输入，仍缺少pre-submit producer、完整overlap/resize schedule和独立transition denominator。 | observed |
| isolated compiled smoke daemon log | launcher fails before SSE attach with `Cannot create CliRenderer: stdin is already used by another CliRenderer`; daemon health is200 while `tuiClients=0`. | observed |
| compiled binary string probe | nested core path is embedded, but `Cannot create CliRenderer...` constructor guard appears twice; current package-local core-only overlay bundles two OpenTUI core module identities. | observed |
| `@opentui/solid:index.bun.js` and `@opentui/keymap` imports | both packages import `@opentui/core`; copying/linking only core at the opencode package does not redirect imports resolved from root-installed solid/keymap. | observed |
| R24 full-scope overlay build | package-local core/solid/keymap scopes were created for both `packages/opencode` and `packages/plugin`, Vite was junctioned and cleaned, but the successful compiled binary still contained two renderer constructor guards. `node_modules/@opencode-ai/plugin` is a root symlink to `packages/plugin`, whose `src/tui.ts` exports runtime keymap values and imports OpenTUI packages. | observed/reachable |
| R25 importer and smoke probes | solid, keymap and local plugin importer paths resolve nested core after explicit keymap dependency linking; the compiled binary still has two guard strings because it contains isolated multi-entrypoint code, while unchanged Session smoke reaches attach, initial frame and both resize frames with no `stdin already used` error before its pre-existing busy-label assertion. | observed |
| `docs/plans/opentui-streaming-markdown-performance-repair.md:67,106,125,255,258,342-376` | R62 已记录同输入 full-render/streaming 等价、stable-prefix scaling、独立 producer/render cadence 和显著提速的可复验基线。 | verified historical baseline |
| 用户提供的 worker-error harness | `settled=pending`, `pendingCallbacks=1`, forced worker error；destroy 后才 rejected。 | observed |
| 用户最新截图 | Thinking计数仍存在，但thinking正文和assistant正文大面积空白；这与`drawUnstyledText=false`等待未完成highlight Promise的consumer症状一致。 | observed |
| 用户最新退出日志 | 正常/streaming Code renderables在退出后批量打印`TreeSitter client destroyed`，调用链均经过renderer finalize/destroy和Code catch；与destroyed guard晚于warning的shutdown症状一致。 | observed |
| `client.ts:812-855` + `parser.worker.ts:1353-1359` | dispose每次启动3秒timer；无`BUFFER_DISPOSED`时仍`resolve(false)`，public void fulfilled并在finally删除client mirror，worker Tree释放没有ack。 | observed/reachable |
| R28 compiled smoke contract | 正常240-delta/exit可在未触发worker query error、未检查正文fallback、未检查PTY/daemon中的destroy warning时通过。 | contracted gap |
| 用户提供的 Windows RSS 对照 | one-shot 500 次约 145–148 MiB 稳定；streaming 固定长度 500 次约 183.4→196.9 MiB，3000 次约 227 MiB。 | observed |
| current-source Zig/compiled probe | Zig 0.15.2的既有WrongGeneration test为`1/1 passed`；current-source DLL仍在compiled fixture panic，排除了prebuilt provenance。 | observed |
| sourcemapped FFI probe | `opentui-spinner.renderSelf -> root core resolveRenderLib/encodeUnicode -> nested core buffer.drawChar`把pool A的packed ID送入pool B；`buffer.zig`只是首个检测者。 | observed |
| spinner overlay rerun | spinner复制到opencode local scope并显式链接nested core后，renderer guard由2降为1，120字符/240 delta到达`STREAM-0239`且无WrongGeneration。 | observed |
| same-machine HEAD/current cadence | HEAD/current分别为idle `28.74/27.24Hz`、stream `8.90/9.02Hz`、concurrent `23.42/24.71Hz`；R30绝对50/40/35门槛超出同机HEAD，不可作为本repair的提升证据。 | observed |

## 5. Baseline and Current Worktree Behavior

```text
provider delta
  -> CodeRenderable.content
  -> persistent update
  -> TreeSitterClient.updateStreamingBuffer()
  -> messageCallbacks[messageId]
  -> parser.worker.handleStreamingUpdate()
  -> STREAMING_UPDATE_RESPONSE or generic ERROR
  -> Code commit / rejection
```

Nested OpenTUI `HEAD` is the behavioral/diff baseline: generic worker errors lack request correlation; edit/stream/reset overwrite accepted state and leak replaced Trees; client mirrors advance before acceptance; Code logs before its destroyed guard. These facts produce the observed pending blank, RSS growth and Ctrl+C warning flood.

The first R22 compiled build used a package-local core junction while root-installed `@opentui/solid` and `@opentui/keymap` retained their root core dependency. The resulting binary contained two renderer implementations; Solid's `instanceof CliRenderer` rejected the renderer created by the local core, attempted a second renderer, and hit the shared stdin owner guard before SSE attach. R23 treats the entire local `@opentui` dependency scope as one module-identity boundary rather than weakening the runtime guard.

The current worktree started from an unapproved R7-era repair. It correlated errors, added candidate state and success-only client acceptance, but implemented worker transfer with `finalize/rollback` closures, changed shared `queue.ts`, modified seven tracked OpenTUI code files, and totaled960 raw production additions/deletions. R22 replaces that intermediate implementation. Final correctness and budgets are always measured against nested `HEAD`, not against an intermediate revision.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| streaming Markdown append | provider delta -> Session Message Part -> `CodeRenderable.content` | content 是当前完整 source；R62 已定义 persistent buffer | `Code.startStreamingHighlight` -> client -> worker | TreeSitterClient/worker protocol | observed |
| worker exception during `STREAMING_UPDATE` | parser/query/injection code | request carries `messageId` | worker top-level catch -> generic `ERROR` | worker response protocol | observed/reachable |
| worker exception during one-shot/parser-init/data-path request | Code/client public operation | request carries `messageId` | same catch -> callback map | worker response protocol | reachable |
| global/parser initialization overlaps Code removal | fresh-client `createBuffer()` plus renderable destroy | one client owns the buffer id | reservation currently occurs after global initialize; init query and dispose can cross | client tail + worker candidate owner | reachable |
| repeated fixed-length streaming updates | provider or benchmark producer | source length can remain constant | persistent Tree replacement loop | parser worker Tree owner | observed |
| queued ordinary buffer edits | public `updateBuffer()` | existing parsed buffer; edits are ordered by ProcessQueue | `HANDLE_EDITS` -> `handleEdits()` | parser worker Tree owner | reachable |
| debounced full reset | public `resetBuffer()` | buffer/parser already exists | `processEdit(..., true)` -> `RESET_BUFFER` -> `handleResetBuffer()` | parser worker Tree owner | reachable |
| renderer shutdown with in-flight highlight | Ctrl+C/destroy -> root destroy -> global client destroy | destroy rejects pending requests | Code catch after cancellation; compiled wrapper marker proves query entered before Ctrl+C | Code cancellation/diagnostic seam | observed |
| queued buffer mutation (`HANDLE_EDITS`/`RESET_BUFFER`/`STREAMING_UPDATE`) | `TreeSitterClient` per-buffer FIFO | one client owns all messages for one buffer | queue operation -> correlated response -> accepted mirror commit | client queue + worker Tree owner | reachable |
| disposal after rejection or delayed ack | Code/remove after query failure or busy worker | release cannot depend on mutation success or precede worker confirmation | failed tail -> correlated dispose -> ack/rejection | client/worker completion protocol | reachable |
| compiled local-core build imports `opentui-spinner` | production Session Spinner | peer resolves from importing package location | root spinner -> root core/native pool while target buffer uses nested core | temporary build overlay/importer gate | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Every request carrying `messageId` completes exactly once. Before its first await, create reserves one client id/tail; initialization publishes parser state only after query success. The contracted `hasParser:false` response is an accepted diagnostic state that retains the client buffer; correlated rejection/error removes the reservation and worker candidate. | complete request union + fresh-client init/destroy overlap + unsupported-filetype contract | parameterized protocol, unsupported-filetype test and real-worker init fault tests |
| INV-02 | A persistent buffer has one accepted client mirror and worker WASM Tree/content pair. Candidate success transfers/deletes copied/previous owners; failure deletes candidates and preserves accepted state. Reset follows the same transfer. Disposal removes client ownership only after correlated worker confirmation; timeout cannot synthesize success. | `Tree.copy()` probe, replacement sites, dispose timer/ack, RSS | candidate tests + delayed-ack disposal + fixed-length benchmark |
| INV-03 | A worker error reaches the owning Code request, so existing parser-error compatibility can make current source visible without retrying another parser. | current Code catch contract + red harness | new public Code error-completion test |
| INV-04 | Expected Tree-sitter cancellation after Code destruction is silent; unexpected worker/parser errors remain diagnostic and preserve the existing error path. | Ctrl+C logs + renderer destroy order | new shutdown warning test |
| INV-05 | `drawUnstyledText=false`, stable-prefix cache semantics, output equivalence and current one-shot behavior remain unchanged. | user requirement + verified R62 | existing Code/client differential tests and benchmark |
| INV-06 | Lifecycle repair creates no backlog；package MarkdownRenderable保留等价/timing/memory；compiled Session到达最终正文且typing/resize无丢失。Current cadence≥85% HEAD，input p95≤`max(100ms,1.15×HEAD)`；永久pending到≤150ms可见是显著改善。 | same-machine HEAD/current producer timestamps、PTY cell transitions、RSS和原始空白loop | temporary package/build/TUI benchmark |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/03 | Worker top-level catch creates `ERROR` without the request `messageId`; client cannot find the callback and only emits an event. | `parser.worker.ts` response producer + `client.ts` callback protocol | forced worker error leaves `pendingCallbacks=1` until destroy |
| INV-02 | `parserState.tree` is overwritten by `newTree` without deleting the previous Tree after changed ranges are read. | `ParserWorker.handleStreamingUpdate` | source comparison with explicit delete in injection/one-shot/dispose paths; RSS trend |
| INV-02 | ordinary queued edits apply one or more `tree.edit()` calls and overwrite current Tree without deleting the previous owner. | `ParserWorker.handleEdits` | public `updateBuffer()` and worker dispatcher reach the assignment |
| INV-02 | reset writes new content before parse and overwrites `parserState.tree` after success without deleting the previous Tree. | `ParserWorker.handleResetBuffer` | public reset producer reaches the assignment; only final current Tree is disposed |
| INV-02 | all three handlers mutate/replace the accepted Tree directly and lose the previous owner. | `ParserWorker.handleEdits`, `handleStreamingUpdate`, `handleResetBuffer` | three reachable `parserState.tree = newTree` sites; no `Tree.copy()` candidate |
| INV-02 | client commits ordinary edit/reset/streaming content/version before worker success. | `TreeSitterClient` buffer queue and mirror | current `buffers.set()` precedes worker response |
| INV-04 | `Code` logs before checking `isDestroyed`; expected cancellation is classified as a user-visible highlight failure. | `CodeRenderable` catch/diagnostic seam | repeated Ctrl+C warning and current source order |
| INV-05 downstream symptom | With `drawUnstyledText=false`, a pending request has no visible commit; this becomes long blank only when INV-01 is already false. | Code consumer, not repair owner | direct Code probe and existing visibility tests |
| INV-01/02 | `createBuffer()` waits for global init before reservation and does not share the mutation/dispose queue; remove can return or finish before initial query later publishes a Tree. | client initialization + worker map publication | current early returns and map install precede `initialQuery()` |
| INV-02 | disposal chained only through mutation success is skipped after a predecessor rejection. | client cleanup ordering | `previous.then(operation)` never calls operation on rejection |
| INV-01/02 | disposal timeout resolves public removal and deletes client mirror without `BUFFER_DISPOSED`. | client/worker completion protocol | reachable3-second `resolve(false)` branch |
| INV-06 diagnostic | build-local只统一core/solid/keymap/plugin，root `opentui-spinner`仍从自身位置解析root core，形成两个native pool；其cached packed ID跨pool进入nested buffer后触发WrongGeneration。 | temporary benchmark module-identity overlay | sourcemapped FFI stack、guard count `2→1`及无panic rerun |

Red-capable feedback loop already run:

```text
Forced worker exception -> streaming update promise remains pending,
pendingCallbacks=1, errors=[forced reachable worker failure],
destroy -> rejected.
```

Disposal feedback ran under the external120-second boundary against the real worker: withholding actual `DISPOSE_BUFFER` made旧代码在3s返回`fulfilled`，正式red断言得到`Expected pending / Received fulfilled`；correlated ack实现后定向测试green，未留下worker Tree。

The single temporary benchmark owns package oracle/timing/RSS, build provenance and compiled Session interaction. It reproduced the source-DLL WrongGeneration, then sourcemapped it to omitted spinner identity；spinner overlay后无panic并完成final marker。One client integration test file owns request settlement, ordering, Code-visible recovery and shutdown；generated smoke不是第七文件。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Associate worker exceptions with requests | `parser.worker.ts` + `types.ts` | a messageId request has a correlated response | worker produces the wire response and knows the incoming message | Code cannot recover a missing correlation id |
| Resolve/reject correlated callbacks | `TreeSitterClient` | each public request promise settles once | client owns callback map and worker message dispatch | worker cannot access client promises |
| Release replaced WASM Tree | `ParserWorker` | parser state owns one matching Tree/content pair | worker creates, streams, applies ordinary edits, resets, replaces and disposes Trees | client only owns numeric buffer protocol |
| Serialize accepted buffer mutations | `TreeSitterClient` private Promise chain | one client-owned tail Promise orders all mutation messages of a buffer | shared `ProcessQueue` need not change and worker need not duplicate ordering state |
| Serialize initialization and terminal release | `TreeSitterClient` private Promise chain + correlated worker dispose ack | init owns the first position; disposal runs after predecessor settlement and succeeds only after worker confirms Tree deletion | a client timer cannot prove worker ownership ended |
| Suppress expected post-destroy warning | `CodeRenderable` | destroyed renderable must not report expected cancellation as a live failure | Code owns `isDestroyed` and fallback diagnostics | client does not know which UI node owns a request |
| Measure memory/latency and unify compiled importer identity | one `.temp/testing` benchmark | diagnostic output/build overlay only | benchmark observes public paths and owns temporary core/solid/keymap/spinner/plugin scope | production modules and repository smoke must not gain telemetry or build-provenance policy |

## 10. Single Approved Primary-Path Design

```text
messageId request
  -> worker success or messageId-correlated ERROR/WARNING
  -> client consumes the matching callback exactly once
  -> accepted response commits the buffer mirror; rejection preserves it
  -> Code existing success or existing parser-error plain-text commit
```

The worker catch propagates the incoming id whenever the request carries one. The client consumes a matching `ERROR`/`WARNING` callback before emitting diagnostics; an unmatched error remains an event diagnostic. No timeout, retry, second parser or emergency raw-text success path is introduced.

`TreeSitterClient` owns one private tail Promise per buffer. `createBuffer` synchronously reserves its id and initialization tail before its first await, including global initialize. Mutations use `previous.then(operation)`, so dependent work rejects after a failed base. Disposal uses `previous.then(dispose, dispose)`, guaranteeing release after initialization/mutation failure; it must not early-return merely because global initialization is still pending when a reservation exists. Edit/reset/stream/dispose enter at public call time. Reset never coalesces. Tail cleanup removes only the current map entry. Dispose sends one correlated request and removes the mirror only after `BUFFER_DISPOSED`; correlated disposal/post failure rejects and preserves the mirror, while whole-worker failure/destroy rejects pending requests and clears mirrors only as part of terminating that worker. Delete the3-second `resolve(false)` timer without another deadline; `queue.ts` stays unchanged.

The ten messageId-bearing request types are `PRELOAD_PARSER`, `INITIALIZE_PARSER`, `GET_PERFORMANCE`, `HANDLE_EDITS`, `RESET_BUFFER`, `STREAMING_UPDATE`, `ONESHOT_HIGHLIGHT`, `UPDATE_DATA_PATH`, `CLEAR_CACHE` and `DISPOSE_BUFFER`; `BUFFER_DISPOSED` echoes the disposal id. `HANDLE_EDITS` and `RESET_BUFFER` responses carry their id even with empty highlights or warning. Initialization keeps parser/Tree/state local through `initialQuery`, then installs one map pointer and synchronously posts its sole success. Parser unavailable or parse-null returns the accepted `hasParser:false` diagnostic response after local parser cleanup; query/post failure deletes local or installed state before one correlated error. Only a correlated rejection/error removes the client reservation. `INIT` and `ADD_FILETYPE_PARSER` retain non-messageId wire contracts.

Each persistent replacement uses an independent candidate state and one worker-turn commit:

```text
acceptedTree = parserState.tree
candidateBase = acceptedTree.copy()       // edit/streaming only
candidateBase.edit(edit or edits)
candidateTree = parser.parse(content, candidateBase)
candidateState = parserState with candidateTree/content and cloned reference maps
run changed-ranges, reference, query and injection work against candidateState
  -> pre-commit failure: delete candidateBase and candidateTree; accepted map entry is untouched
  -> success: replace the single bufferParsers map entry with candidateState
              synchronously post correlated response
              if post throws, restore the old map entry, then delete candidateBase and candidateTree
              otherwise candidateTree becomes the accepted map owner;
                        delete candidateBase and previous acceptedTree before yielding
```

`candidateBase` never becomes accepted state: it exists only to receive `tree.edit()` and must be deleted after both successful and failed post. `candidateTree` has exactly two terminal outcomes: successful post transfers it to the map and later disposal/replacement owns its deletion; every pre-commit or post-failure path deletes it locally. Reset parses directly into an unattached candidate: successful post transfers the new Tree and deletes the previous accepted Tree, while query/post failure deletes the new Tree after restoring/preserving the previous map entry. `ParserState` is transferred by replacing one `bufferParsers` map entry, so a synchronous post failure needs one pointer restoration rather than five field snapshots. There is no `await` across install/post/finalize and no next same-buffer handler can run before completion. No `MutationResponse.finalize/rollback` closures, inverse edit, second parser or worker ordering state remain.

The client mirror advances only in the correlated success continuation. A rejection leaves both accepted states unchanged；dependent mutations reject，disposal still releases state。Initialization shares that ordering owner。`drawUnstyledText=false` remains unchanged。Code checks `isDestroyed` before warning。Compiled verification copies spinner into the same local scope as nested core；no `buffer.zig`、native provenance或release change is authorized。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| correlated worker success | current primary | primary-contract path | yes | 80% | preserve/repair |
| correlated worker error -> existing Code plain-text commit | existing shipped behavior | existing compatibility | yes, under existing contract | 10% | preserve; no new parser |
| uncorrelated worker error event | current path for event-only operations | diagnostic | no | 10% | preserve |
| disposal timer or timeout/retry/second parser/raw-visible emergency route | current disposal timer plus otherwise proposed routes | forbidden success/fallback | yes | 0% | delete disposal timer; reject all replacements |

New alternate success-path budget: zero. The existing parser-error plain-text behavior is preserved, not added as a new route.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Generic `ERROR` event with no request correlation | older event-style worker reporting | requests now complete through their own response channel | `types.ts`, `parser.worker.ts`, `client.ts` |
| Copied base and replaced persistent Tree left without one terminal owner | missing owner transfer | every successful edit/stream replacement transfers the returned Tree and deletes copied base plus previous accepted Tree; reset transfers its new Tree and deletes the previous Tree | `parser.worker.ts:handleEdits`, `handleStreamingUpdate`, `handleResetBuffer` |
| Optimistic buffer mirror before worker acceptance | fire-and-forget edit path | private tail completion is the only mirror commit point | `client.ts`; restore `queue.ts` unchanged |
| Two-phase `MutationResponse.finalize/rollback` | attempted post-transfer recovery | one ParserState map-pointer install/post/restore boundary carries the whole owner | `parser.worker.ts` |
| Warning before destroyed guard | fallback logging written for live failures | cancellation is not a live highlight failure | `Code.ts` catch blocks |
| 3-second disposal `resolve(false)` | bounded old cleanup wait | only worker ack proves Parser/Tree deletion; timeout fulfillment discards client ownership without proof | `types.ts`, `client.ts`, `parser.worker.ts` correlated dispose |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | worker error response -> client callback reject | `types.ts`, `parser.worker.ts`, `client.ts` | forced correlated worker error rejects public update and leaves no pending request |
| INV-01/02 | synchronous reservation -> global/client init tail -> local worker candidate -> sole terminal response -> accept/remove | `parser.worker.ts`, `client.ts` | fresh-client immediate remove, real-worker initialQuery failure and same-id recreate |
| INV-02 | candidate ordinary-edit/streaming/reset replacement -> copied-base/previous/candidate terminal ownership | `parser.worker.ts`, `client.ts` | public update/streaming/reset queue coverage, candidate cleanup and fixed-size benchmark |
| INV-01/02 | rejected predecessor -> always-after-settle correlated dispose -> acknowledged worker Tree release | `types.ts`, `client.ts`, `parser.worker.ts` | suppressed ack remains pending beyond old3s deadline, then real ack completes; same id recreates and repeated RSS is bounded |
| INV-03 | rejection -> existing Code plain-text commit | `Code.ts` only for cancellation ordering; no draw flag change | package Code and sentinel-only compiled Session both show current body after real worker error |
| INV-04 | destroyed Code rejects silently | `Code.ts` one-shot and streaming catch guards | package boundary holds `ONESHOT_HIGHLIGHT` plus `STREAMING_UPDATE` until renderer/client destroy; compiled blocked-stream Ctrl+C also emits zero shutdown warnings |
| INV-05/06 | preserve R62 algorithm；unify spinner/core importer；enforce original visibility and same-machine non-regression | no cache/native algorithm change；temporary package scope adds spinner；HEAD/current PTY metrics | zero mismatch、stable-prefix scaling、RSS、final marker、≤150ms error body、HEAD/current cadence/latency ratio及无native panic |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Optional `messageId` on generic `ERROR` and correlated reject | INV-01/03 | generic error lacks id and leaves observed pending callback | current event-only branch cannot settle request promise |
| Correlated edit/reset response and client acceptance commit | INV-01/02 | client mirror currently advances before worker Tree acceptance | worker cannot repair a client mirror it does not own |
| Copied-base and returned-Tree ownership through commit/failure | INV-02 | runtime exposes `copy()`/`delete()` and current handlers lose old owner | direct accepted-tree mutation cannot isolate failure or assign one terminal owner to copied base, returned candidate and previous Tree |
| Private per-buffer Promise tail | INV-01/02 | client mirror currently advances before worker response | shared `ProcessQueue` would broaden scope; a client-local chain carries exact request completion |
| Pre-await init reservation and correlated disposal after settlement | INV-01/02 | global/parser init can publish after early remove; success-only chaining skips release; timer currently fabricates unacknowledged success | worker cannot recover reversed order, and only worker response can confirm its Tree owner ended |
| Destroyed guard before warning | INV-04 | repeated shutdown warnings and current catch order | current catch logs before knowing node is destroyed |
| Error/lifecycle regression tests | INV-01..06 | existing tests do not cover generic error correlation or old Tree RSS | current green tests can miss the user-visible failure |
| Spinner importer joins temporary local core scope | INV-06 | sourcemapped `renderSelf` proves root spinner encoded IDs enter nested buffer/native pool | core/solid/keymap/plugin-only overlay leaves this peer consumer split；native guard cannot repair cross-pool identity |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/types.ts` | modify | Correlate generic error/warning, edit/reset and dispose success without changing event-only compatibility. | `E≤25`; raw≤35 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/parser.worker.ts` | modify | Correlate errors/dispose ack；candidate pointer transfer/release without broad reindent or duplicate cleanup。 | `E≤250`; raw≤285 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.ts` | modify | Pre-await reservation/tail、real disposal ack、success-only mirror commit；delete only superseded queue/debounce path。 | `E≤220`; raw≤260 |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts` | modify | Move destroyed guards before warning in one-shot and streaming catches; avoid unrelated formatting. | `E≤20`; raw≤20 |
| `thirdparty/opentui/packages/core/src/lib/tree-sitter/client.test.ts` | modify | Ten channels; initialQuery failure; ordering/acknowledged dispose; streaming and one-shot live-error visibility plus deterministically held shared-client shutdown control. | 180–280 |
| `.temp/testing/opentui-lifecycle-benchmark.ts` | create, temporary only | Public lifecycle/oracle/RSS；one local core/solid/keymap/spinner/plugin scope；worker provenance；HEAD/current cadence comparator；ephemeral normal240/error-visible/blocked-shutdown smoke。 | ≤600 |

Total code files remains six: four production files、`client.test.ts`、one temporary benchmark。`queue.ts`、`Code.test.ts`、repository smoke和全部native/Zig文件必须zero-diff。Final production同时满足`E_p≤600`和raw additions+deletions≤600；当前951 raw touch禁止提交审计，必须通过局部替换、复用既有控制流和删除纯重排收缩，不能用exclusion解释宽diff。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| ---: | --- | --- | --- | --- |
| 1 | Each messageId request terminal-completes once; global-init/query/dispose overlap cannot publish after release or retain state. | create reserves after await, init sits outside queue and worker installs before query. | reserve before await; enqueue init; local candidate; one terminal response; failed cleanup. | no pending/double completion/init leak |
| 2 | Fixed-size streaming updates complete and do not accumulate copied bases or superseded Trees. | successful replacement loses the accepted Tree without delete, and an unowned copied base leaks even when the returned candidate is accepted. | parse from `Tree.copy()`; after successful post transfer candidate Tree, then delete copied base and previous accepted Tree. | long Session RSS and WASM pressure |
| 3 | A candidate parse/query/injection failure leaves the accepted Tree/content/reference state unchanged. | current handlers mutate shared state before later work can fail. | evaluate a cloned candidate state and delete all candidate allocations on failure. | subsequent update remains valid after an exception |
| 4 | Public ordinary edits, streaming updates and resets are serialized in call order and commit client mirror only after correlated success. | reset currently waits outside the edit queue and superseded debounce Promises never settle. | remove reset debounce; one private Promise tail immediately owns every public mutation and completion. | no pending reset, reorder, version mismatch or dependent work after failure |
| 5 | Package streaming+one-shot Code and compiled streaming Code destroyed while requests are held emit no warning. | both catches log before guard; current package test uses only streaming and normal compiled exit is not in-flight. | intercept real worker boundary after ready state, hold `STREAMING_UPDATE` and `ONESHOT_HIGHLIGHT`, require both observed, then destroy; compiled sentinel covers Ctrl+C. | zero one-shot/streaming shutdown warnings without hiding live errors |
| 6 | Real worker errors make streaming and one-shot package Code plus compiled Session body visible. | pending promise blocks commit; a streaming-only live control cannot protect one-shot diagnostics. | correlated reject only; same failure worker drives separate `streaming:true/false` Code and asserts their respective warning plus plain text; compiled sentinel body is visible. | screenshot blank and both live compatibility catches |
| 7 | Existing R62 equivalence/scaling remains green，compiled current cadence≥85% HEAD且input p95≤`max(100ms,1.15×HEAD)`。 | lifecycle changes must not add backlog；HEAD实测约30/9/24Hz，不能伪造50/40/35能力。 | run identical HEAD/current workload；final marker和原始≤150ms visibility独立必过。 | affected-path performance与原始空白显著改善 |
| 8 | Disposal behind rejection succeeds only on matching worker ack; withholding ack past3s cannot fulfill. | success-only chaining skips cleanup and current timer fabricates success. | disposal waits on the same tail and correlated callback; test withholds outbound request past old deadline, then forwards it and observes real completion. | no unacknowledged release or Tree leak |
| 9 | Local artifact所有runtime OpenTUI consumers共享一个core/native pool。 | root spinner的peer从自身位置解析root core；其cached encoded ID进入nested buffer会稳定WrongGeneration。 | overlay core/solid/keymap/spinner和local plugin；显式链接并realpath每个importer；require one guard、无panic、cleanup。 | module split不能伪装成native buffer缺陷 |
| 10 | Compiled Session independently observes120-char typing、exact240 deltas、concurrent typing、two resizes和final body。 | timer ticks不能代表cell变化；绝对cadence门槛不能超过same-machine HEAD。 | parsed PTY advances输出raw metrics；cadence≥85% HEAD，p95≤`max(100ms,1.15×HEAD)`，final/resize/visibility为absolute gates。 | completed SSE不能伪装整体通过 |

Tests assert public outcomes，worker-message interception only makes overlap deterministic。A fresh client reserves/init/removes/recreates one id；ten methods settle once；mutations order；failed stream disposes。Disposal withholds real request beyond3100ms then forwards ack。Healthy streaming/one-shot后hold真实两类消息并destroy，要求zero warnings；live controls仍warn/commit source。Compiled seam用importer realpath、one guard、no panic和same-machine HEAD/current PTY metrics；无production hook。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Production effective changed lines `E_p` | measured from the exact final diff across the four production files | each added or substantively modified nonblank line counts once; exclude only imports, formatting, generated output and pure moves; `E_p≤600` |
| Per-file denominator `E_i` | measured separately from the exact final diff for each of the six code files | use the same effective-line exclusions as policy; never pool a low-ratio file with another file |
| Per-file qualifying Chinese comments `C_i` | if `E_i=0`, require `C_i=0`; otherwise `C_i >= max(1, ceil(E_i × 0.15))` | count only comments adjacent to a non-obvious changed boundary in that same file |

Qualifying comments must explain message correlation, candidate isolation, single-pointer transfer, immediate Promise-tail ordering, success-only mirror commit, acknowledged disposal ownership, cancellation classification and test/measurement intent. Comments must be adjacent and cannot be concentrated in a file header.

The final evidence must make the effective-line recount reproducible. After applying the listed policy exclusions, each zero-context diff hunk contributes `max(substantive additions, substantive deletions)`, so a replaced line counts once while an unpaired insertion or deletion also counts once. `E_p` sums only the four production files. The final table must report raw additions/deletions, exclusions, `E_i`, `C_i`, required `max(1,ceil(E_i×0.15))` and pass/fail for every file; no aggregate ratio can satisfy a failing file. Exact normalized pure moves may be excluded only when both source and destination are identified. The auditor may reject an exclusion, comment qualification or broad rewrite independently of the numeric result.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `Invoke-Bounded -WorkingDirectory ... -FilePath bun -ArgumentList ...` | respective package directory | Every row is run through the exact external supervisor below; the target's stdout/stderr and exit code remain evidence, and a timeout is a failed row. |

The verification runner is this executable PowerShell 7+ wrapper, used in the same `pwsh -NoProfile -Command` invocation as each row. It is not a repository file and therefore does not expand the six-file implementation scope:

```powershell
function Invoke-Bounded {
  param([string]$WorkingDirectory, [string]$FilePath, [string[]]$ArgumentList)
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru
  if ($process.WaitForExit(120000)) {
    if ($process.ExitCode -ne 0) { throw "Target exited with code $($process.ExitCode): $FilePath $ArgumentList" }
    return
  }
  & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not $process.WaitForExit(10000)) { throw "Failed to terminate timed-out process tree rooted at PID $($process.Id)" }
  throw "External 120-second timeout; terminated process tree rooted at PID $($process.Id)"
}
```

The exact argument vectors for the rows are:

```powershell
Invoke-Bounded $core 'bun' @('test', './src/lib/tree-sitter/client.test.ts')
Invoke-Bounded $core 'bun' @('test', './src/renderables/Code.test.ts')
Invoke-Bounded $core 'bun' @('test', './src/lib/tree-sitter/cache.test.ts')
Invoke-Bounded $core 'bun' @('test')
Invoke-Bounded $nested 'pwsh' @('-NoProfile', '-File', $typecheckGate, $nested, $core, $temp)
Invoke-Bounded $core 'bun' @('../../../../.temp/testing/opentui-lifecycle-benchmark.ts', '--phase', 'package', '--updates=500', '--long-updates=3000', '--trials=3', '--json=../../../../.temp/tree-lifecycle-r24.json')
Invoke-Bounded $opencode 'bun' @('../../.temp/testing/opentui-lifecycle-benchmark.ts', '--phase', 'build-local', '--binary', './dist/opencode-windows-x64/bin/opencode.exe', '--artifact-copy', $currentBinary)
Invoke-Bounded $opencode 'bun' @('../../.temp/testing/opentui-lifecycle-benchmark.ts', '--phase', 'build-local', '--core-path', $headCore, '--binary', './dist/opencode-windows-x64/bin/opencode.exe', '--artifact-copy', $headBinary)
Invoke-Bounded $opencode 'bun' @('run', 'script/smoke-opentui-artifact.ts', '--binary', './dist/opencode-windows-x64/bin/opencode.exe')
Invoke-Bounded $opencode 'bun' @('../../.temp/testing/opentui-lifecycle-benchmark.ts', '--phase', 'tui', '--binary', $currentBinary, '--baseline-binary', $headBinary, '--json=../../.temp/opencode-tui-r31.json')
```

Here `$core`/`$opencode` are absolute package paths；`$headCore`是controller以nested `git archive HEAD packages/core`和root node_modules junction创建的只读snapshot；`$currentBinary/$headBinary`位于approved external temp。Each vector has a fresh supervisor；build-local的`--artifact-copy`在provenance通过后复制artifact。Timeout、nonzero、missing artifact或uncleared snapshot/overlay均失败。

`$typecheckGate` is generated under approved external `$temp` (not the repository), then passed through the same supervisor. Its exact behavior is: export nested `HEAD` with `git archive` into a unique temporary directory; junction only the current root and core `node_modules` into that read-only source snapshot; run `bun typecheck` once from snapshot `packages/core` and once from current `$core`; normalize path separators and split output into complete blocks beginning `file(line,column): error TS...`; fail if either nonzero run has no parseable diagnostic, any current block is absent from the baseline set, or any current block begins with one of `types.ts`, `client.ts`, `parser.worker.ts`, `client.test.ts`, or `Code.ts`; permit baseline blocks to disappear; always remove archive, junctions, logs and snapshot in `finally`. The script emits both exit codes, block counts, SHA-256 hashes and exact new/changed blocking arrays. Therefore the outer row exits zero only for a clean current typecheck or an exact/subset pre-existing diagnostic baseline with zero changed-file diagnostics; tooling failure, a new cross-file diagnostic and a changed-file diagnostic all exit nonzero. The temporary benchmark is independently bundled/executed by its package/build/TUI rows because it is outside the core tsconfig.

The verification controller writes this exact content to `$typecheckGate` before the bounded row:

```powershell
param([string]$repo, [string]$core, [string]$temp)
$ErrorActionPreference = 'Stop'
$root = Join-Path $temp "opentui-typecheck-$([guid]::NewGuid())"
$snapshot = Join-Path $root 'snapshot'
function Invoke-Typecheck([string]$cwd, [string]$name) {
  $stdout = Join-Path $root "$name.stdout.log"; $stderr = Join-Path $root "$name.stderr.log"
  $p = Start-Process bun -ArgumentList @('typecheck') -WorkingDirectory $cwd -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $p.WaitForExit(); return @{ Exit = $p.ExitCode; Out = $stdout; Err = $stderr }
}
function Read-Diagnostics([string]$path) {
  $text = ([string](Get-Content -LiteralPath $path -Raw)).Replace('\', '/')
  return @([regex]::Matches($text, '(?ms)^[^\r\n]+\(\d+,\d+\): error TS\d+:.*?(?=^[^\r\n]+\(\d+,\d+\): error TS\d+:|\z)') | ForEach-Object { $_.Value.Trim() } | Sort-Object -Unique)
}
New-Item -ItemType Directory -Path $snapshot | Out-Null
try {
  & git -C $repo archive --format=tar -o (Join-Path $root 'head.tar') HEAD; if ($LASTEXITCODE) { throw 'git archive failed' }
  & tar -xf (Join-Path $root 'head.tar') -C $snapshot; if ($LASTEXITCODE) { throw 'archive extraction failed' }
  New-Item -ItemType Junction -Path (Join-Path $snapshot 'node_modules') -Target (Join-Path $repo 'node_modules') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $snapshot 'packages/core/node_modules') -Target (Join-Path $core 'node_modules') | Out-Null
  $before = Invoke-Typecheck (Join-Path $snapshot 'packages/core') 'head'; $after = Invoke-Typecheck $core 'current'
  $beforeBlocks = Read-Diagnostics $before.Out; $afterBlocks = Read-Diagnostics $after.Out
  $new = @(Compare-Object $beforeBlocks $afterBlocks | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject)
  $changed = @($afterBlocks | Where-Object { $_ -match '^(src/lib/tree-sitter/(types|client|parser\.worker|client\.test)\.ts|src/renderables/Code\.ts)\(' })
  [pscustomobject]@{ headExit=$before.Exit; currentExit=$after.Exit; headCount=$beforeBlocks.Count; currentCount=$afterBlocks.Count; new=$new; changed=$changed; headHash=(Get-FileHash $before.Out).Hash; currentHash=(Get-FileHash $after.Out).Hash } | ConvertTo-Json -Depth 3
  if (($before.Exit -ne 0 -and $beforeBlocks.Count -eq 0) -or ($after.Exit -ne 0 -and $afterBlocks.Count -eq 0) -or $new.Count -or $changed.Count) { throw "typecheck delta failed`n$($new + $changed -join "`n---`n")" }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
```

R28 plan feedback executed this exact gate through the outer supervisor in46.67s: HEAD/current each exited2 with identical normalized output hashes, `new=[]`, `changed=[]`, outer exit0, and no `opentui-typecheck-*` snapshot remained. This proves the gate can distinguish accepted baseline diagnostics without treating raw exit2 as success.

Every test/benchmark/build/smoke command therefore has an executable external 120-second process-tree boundary. The full package test is attempted only after all targeted commands exit cleanly.

The single temporary benchmark owns package lifecycle/equivalence/scaling/RSS、HEAD/current compiled metrics、binary preparation和worker provenance。Build phase拒绝覆盖local paths，统一core/solid/keymap/spinner/plugin importers并逐项realpath；spinner必须显式链接nested core，避免cached encoded ID跨native pool。Diagnostic worker sibling只对两个sentinel throw/block，其他输入import byte-identical production copy。`finally`恢复worker并删除所有scope/Vite overlay；missing restoration is failure。Generated smoke independently runs normal240、error-visible、pending-shutdown；repository smoke remains zero-diff。

The normal generated fixture emits exactly240 Markdown SSE deltas at16ms, types120 unique prompt characters at16ms before submit, types a second unique prefix at24ms during streaming, resizes `160→121→160`, and counts only parsed production prompt/`STREAM-NNNN` cell advances with producer timestamps. Separately, the error fixture sends a fenced sentinel body `COMPILED-ERROR-BODY-VISIBLE`: the real production worker throws through correlated `ERROR`, parsed Session cells must show that exact body within150ms, and captured live logs must contain exactly one sentinel failure before visibility but no `TreeSitter client destroyed`. The shutdown fixture sends the blocking sentinel, waits until its unique wrapper-entered log marker is captured, sends the real Ctrl+C sequence while the request is pending, and captures PTY plus launcher/daemon stdout/stderr through exit; it requires zero `TreeSitter client destroyed`, zero post-shutdown `Code highlighting failed`/`Code streaming highlight failed`, no warning flood and successful process-tree cleanup. Normal240, error-visible and pending-shutdown runs are independent, so an expected live sentinel warning cannot be mistaken for shutdown noise and a normal exit cannot substitute for an in-flight cancellation.

Post-repair acceptance is executable and fails the command when any gate is false:

- Request/significant-improvement gate: the observed before harness remains pending and blank beyond1000ms; after repair every correlated forced worker error rejects once within50ms, package Code and compiled Session show current source within150ms, and no request waits for destroy. The compiled error run must exercise the production Session/Code/worker path, not merely a client test.
- Correctness gate: the existing 240-update oracle reports zero text mismatch and zero style mismatch against full rendering; public ordinary-edit, streaming and reset lifecycle tests pass.
- Queue gate: initialization/edit/stream/reset enter one FIFO; accepted `getBuffer()` changes only after matching success. A rejected operation rejects dependent mutations, while an already queued or fresh disposal still completes exactly once and permits same-id recreation.
- Whole-path gate: sequential persistent mode total is at least 30% lower and p95 at least 20% lower than the same-run full-render mode, average update time is at most 16.7 ms, 1000-paragraph stable-prefix append is at least 1.25x faster than the same-run full-render append, cadence converges with stream wall time at most 1.1x full-render and catch-up at most 100 ms and 0.5x full-render; all producer/frame/visible-update gaps are reported.
- Tree gate: ordinary-edit, streaming, reset and repeated real-worker init-failure/dispose overlap each run500 and3000 fixed-size iterations; across three trials each path's median post-warmup RSS growth from500 to3000 is at most8MiB. Raw samples remain in one artifact. This rejects replaced-Tree and teardown-race leaks without an unavailable relative baseline.
- Package Markdown gate: the frame-independent benchmark reports zero text/style mismatch against full rendering, stable-prefix timing improvement, update-time improvement and the fixed-length RSS/native-memory gates; a false `timingGate` throws and exits nonzero. It does not claim package FPS or visible latency because it disables render requests. The package gate is independent of the compiled TUI gate.
- Build/artifact gate: `build-local` must produce the binary from unified nested core/solid/keymap/spinner/plugin importers，prove wrapper/production worker provenance，require one compiled renderer guard，and byte-clean every overlay。Missing spinner identity、WrongGeneration、ownership error、binary/provenance或cleanup均nonzero。
- Regression gate: package timing/equivalence satisfies same-run full-render criteria; compiled TUI transition cadence, maximum stall and input latency satisfy absolute producer-derived gates. No invalid timer-sampled or unavailable pre-repair artifact is consumed.
- Whole OpenCode TUI gate: identical nested HEAD/current artifacts each run120-char、exact240 delta、concurrent typing和two resizes；current cadence≥85% HEAD，input p95≤`max(100ms,1.15×HEAD)`。Both reach full prompt、`STREAM-0239`、completion；resize≤150ms。Current error body≤150ms，blocked Ctrl+C zero warnings；normal/error/shutdown及unchanged smoke缺一不可。

The old timer-sampled R7 artifact is invalid。Significant improvement由原始pending/blank从destroy前永不完成变为≤150ms可见，以及same-run persistent/full package timing证明；compiled HEAD/current comparator证明repair不以frame backlog换取正确性。独立renderer基础约30Hz不由本四production-owner计划冒充已修复。

## 19. Diff Budget

| Metric | Hard budget |
| --- | ---: |
| Production files modified | <= 6 |
| Total code files modified/created | <=6: 4 production + 1 test + 1 temporary benchmark |
| Production files planned | 4 |
| Production effective/raw changed code | `E_p <= 600` and raw additions+deletions `<=600`；both measured against nested `HEAD` |
| Required qualifying Chinese comments | each file independently satisfies `E_i=0 => C_i=0`; otherwise `C_i >= max(1,ceil(E_i × 0.15))` |
| Temporary diagnostic | one `.temp/testing` benchmark ≤600 lines, counted in file count and E/C |
| Native/Zig files | 0；WrongGeneration由temporary spinner/core identity修复，不得修改buffer/native provenance |
| New alternate success paths | 0 |
| Plan document | <= 600 lines |

The budget is a hard restraint, not permission to omit INV-01 through INV-06. If the approved route cannot fit, stop and revise the plan rather than add a fallback or unrelated refactor.

## 20. Real Risks and Open Decisions

### Real risks

- `Tree.copy()` is an observed installed runtime method; the copied parse base is always temporary and must be deleted on success/failure. The returned candidate Tree is deleted only on failure, or transferred to the accepted map on success; the previous accepted Tree is deleted only after successful post.
- All per-buffer mutations must enter the client Promise tail; adding a second worker-side ordering state would duplicate an upstream guarantee and violate the simplicity constraint.
- Initialization must reserve the same tail before its wire send, and disposal is the sole always-after-settle operation; applying that rule to ordinary mutations would incorrectly hide a failed accepted base.
- Removing reset debounce may send more full resets, but reset has only one internal producer and the per-buffer tail bounds concurrency; benchmark timing and FIFO tests must show no backlog or cadence regression.
- RSS is noisy on Windows; the benchmark reports raw samples, warmup and three-trial medians. The absolute 8MiB growth ceiling is paired with 500/3000 fixed-length runs on each public mutation path, not an unavailable relative baseline.
- Existing `Code` tests intentionally exercise `drawUnstyledText=false`; changing their contract would violate the explicit user boundary and invalidate R62 behavior.
- A correlated request rejection must not be converted into a successful empty highlight result; the existing Code plain-text error contract must receive the rejection.
- The compiled overlay must keep core/solid/keymap/spinner/plugin in one local scope；spinner caches native encoded IDs，so a split is a cross-pool use-after-release，not a harmless duplicate literal。Cleanup is bounded to ignored package-local paths。
- Root plugin symlink与root spinner package都是reachable compiled consumers；local copies仅是build overlay。Same-machine指标有run noise；cadence15% tolerance和latency100ms floor须逐项计算并保留raw producer timestamps。
- The supervised typecheck-delta row must compare current diagnostics with a same-run nested-`HEAD` source snapshot using the same installed dependencies. Existing blocks may remain or disappear, but any new full diagnostic block, any diagnostic in the five tracked core files, an unparsable nonzero run, extraction failure or cleanup failure is blocking; R30 cannot call the raw exit-2 output a clean typecheck.

### Open Decisions Requiring the User

None. The requested production-file and line ceilings, `drawUnstyledText=false` boundary, no major refactor requirement and benchmark requirement are explicit.

### Rejected Speculation

- A silent worker hang without an observed producer is not used to justify a new timeout or retry state machine.
- `buffer.zig`/prebuilt provenance不用于修复WrongGeneration：current-source DLL同样panic，sourcemapped stack证明producer是split spinner/core pools，统一importer后无panic且existing Zig regression green。
- The stable-prefix algorithm is not treated as the cause; R62 equivalence and benchmark evidence are preserved as the baseline.

## 21. Audit Contract

The independent auditor must read exact R31、original requirement、four production owners、accepted `hasParser:false`、tail/ack/candidate ownership、one client test和one benchmark。It must audit ten requests、delayed ack、both Code consumers、package oracle/RSS、core/solid/keymap/spinner/plugin identity、one guard/no panic、HEAD/current comparator、normal240/error/shutdown、120-second supervision/typecheck、six files、`E_p≤600`、production raw≤600、fallback及每文件15% gate。

## 22. Historical Plan Audit Record (archival, non-normative)

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02, B-03 | incomplete verbatim requirement; decision-share estimate; compatibility classification must be rechecked | BLOCK | `ses_038052f31ffeeI1wKjTDGN5YnR` |
| 2 | R2 | yes | B-01, B-02 | decision-share estimate; comment estimate; R2 metadata pending | BLOCK | `ses_037fb666effec7rX2Efjx7M1oJ` |
| 3 | R3 | yes | B-01 | decision-share estimate; comment estimate; temporary benchmark not yet created | BLOCK | `ses_037ee8d08ffe6JZOEQHQtUl9Qh` |
| 4 | R4 | yes | B-01 | decision-share estimate; comment estimate; R4 metadata pending | BLOCK | `ses_037e6e3acffeK21Sf66F1LVC2e` |
| 5 | R5 | yes | B-01, B-02 | decision-share estimate; comment estimate; temporary benchmark/smoke artifact pending | BLOCK | `ses_037dd5543ffeeFcNo4MH3vdUTH` |
| 6 | R6 | yes | B-01, B-02, B-03 | concurrent candidate seam; queue/debouncer completion semantics; whole-TUI metrics | BLOCK | `ses_037ce2acfffe1ywh36612hJjFO` |
| 7 | R7 | yes | none | decision-surface share estimate; diagnostic artifacts generated during implementation | APPROVE | `ses_03781f6ebffeTjCYGAw2KYKDc6` |
| 8 | R8 | yes | B-01 contradictory 50-FPS and 30-FPS whole-TUI contracts | archival references and effective-line estimate | BLOCK | `ses_035aee862ffeGaXzwp0igPa2rW` |
| 9 | R9 | yes | B-01 package FPS gate not executable; B-02 before smoke cannot record failing baseline | implementation evidence remains historical | BLOCK | `ses_035a95841ffeHMPv6kXMDK2AMp` |
| 10 | R10 | yes | B-01 wrong renderer owner; B-02 timer ticks counted as frames; B-03 no significant whole-TUI improvement | full client exit and final E/C remain implementation evidence | BLOCK | `ses_0358a039dffeMEf4mJsu6qxKB8` |
| 11 | R11 | yes | B-01 cited benchmark cannot execute lifecycle/oracle gates; B-02 old timer artifact conflicts with new recorder baseline | historical implementation evidence | BLOCK | `ses_0357cb119ffemug9q197GS8cn8` |
| 12 | R12 | yes | B-01 nine request/error-to-visible contract absent from file plan; B-02 original multi-Code/shared-client shutdown unverified | implementation E/C and clean exit remain pending | BLOCK | `ses_03574c0a8ffe1qRcFEVmMb13aF` |
| 13 | R13 | yes | production churn960>600; RSS baseline unavailable; resize predicate insensitive |  | BLOCK | `ses_0356bbdf0ffe9Ymk75dIeulO8y` |
| R14-cycle-1 | R14 | yes | B-01 reset debounce bypasses FIFO and leaves superseded Promise pending |  | BLOCK | `ses_034e0b82dffeoLRAvyR73VKqZi` |
| R15-cycle-2 | R15 | yes | B-01 audit exception quote missing; B-02 spinner cannot prove 60FPS cadence |  | BLOCK | `ses_034d964c1ffe3CEEPm7eFH36g1` |
| R16-cycle-3 | R16 | yes | B-01 compiled TUI lacks long streaming Markdown interaction load; B-02 seven code files exceed six |  | BLOCK | `ses_034cf15a3ffeSdWoHRMwLBAtK7` |
| R17-cycle-4 | R17 | yes | B-01 disposal skipped after predecessor rejection; B-02 initialization/disposal lack one terminal owner |  | BLOCK | `ses_034c16437ffedtw3l0C2nnqfeX` |
| R18-cycle-5 | R18 | yes | none | metadata mode label only | APPROVE | `ses_034b1bfc1ffeKOasCXckuD41Kj` |
| R19-retries | R19 | unavailable | independent-audit-unavailable after repeated consecutive invocations |  | independent-audit-unavailable | `ses_0324151d6ffe1BHfeXFCLXRsSu`, `ses_03240bea6ffex4kp5V1r8Ntkl4`, `ses_0323f4035ffeda20IcfsE2Llcv` |
| R19-cycle-6 | R19 | yes | B-01 package timing gate is computed but not enforced; B-02 compiled TUI does not exercise the required 240-delta Markdown workload; B-03 build-local does not verify parser-worker provenance | NB-01 supplemental verbatim requirement; NB-02 asserted decision-surface percentages; NB-03 extensive archival R18 evidence | BLOCK | `ses_030b2c7b8ffezrbqyttx1sWWQ8` |
| R20-cycle-1 | R20 | yes | none | NB-01 audit-mode metadata; NB-02 archival implementation evidence; NB-03 asserted decision-surface percentages; NB-04 incomplete R20 implementation evidence | APPROVE | `ses_02da58dbdffeVPHEKqZTQoU7UQ` |
| R21-cycle-2 | R21 | yes | B-01 verification commands state but do not execute an external120-second process-tree boundary | package/TUI gate separation; lifecycle contracts and traceability consistent | BLOCK | `ses_02d6ca07fffejOKRYoY97us5Jx` |
| R22-cycle-3 | R22 | yes | none | NB-01 incomplete current-round verbatim capture; NB-02 non-recomputed decision-surface percentages; NB-03 archival implementation evidence retained but explicitly non-authorizing | APPROVE | `ses_02d65891fffedOpB4zPRBLhFrp` |
| R23-cycle-4 | R23 | yes | B-01 generated compiled Session harness cannot execute the contracted idle typing, production stream-marker, concurrent typing, resize and transition-sensitive cadence/latency workload; the plan says to replace only the SSE body while requiring additional PTY producers and a cell-transition recorder | N-01 audit-mode metadata says `full-scope` while the handoff says `plan` | BLOCK | `ses_02b04752fffezAiIEMNI3Uw9DF` |
| R24-cycle-5 | R24 | yes | none | `docs/plans/opentui-tree-sitter-request-lifecycle-repair.md:225-232` 的 decision-surface `80% / 10% / 10%` 仍是计划估算，尚未有可复算的实际分支统计。计划已完整分类所有成功、兼容和诊断路径，因此该问题不阻塞 R24；实现审计时仍需按实际 diff 重算。; `docs/plans/opentui-tree-sitter-request-lifecycle-repair.md:472-489` 与 `507-521` 保留了较多历史实现证据。计划已明确标注 archival/non-normative，不影响当前 R24 的权威性，但实现阶段应避免把这些历史数字当作当前预算或验证结果。; 当前共享 worktree 中存在既有的 `packages/opencode/script/smoke-opentui-artifact.ts` 修改。计划已明确要求不覆盖该修改并以 nested `HEAD` 为基线；执行实现审计时需要单独证明 R24 没有把该既有 diff 混入六文件范围。 | APPROVE | `ses_02af6ed5effeGIXuNZ4EMlUYu6` |
| R25-cycle-6 | R25 | yes | none | R25的验证产物和历史命令中仍保留`r24`文件名，例如`tree-lifecycle-r24.json`，以及若干archival evidence引用。当前计划已明确这些内容不改变R25规范性；实现阶段应避免将历史名称误报为R25当前轮次证据。; Section11的`80% / 10% / 10%` decision-surface数字仍属于计划估算，实际比例须由implementation audit重算。; 计划保留较多R22–R24 implementation evidence，已标注archival/non-normative；实现阶段须继续区分历史证据与R25当前证据。 | APPROVE | `ses_02ad81163ffeRHpW5CCwpk6aj6` |
| extra-R26-a | R26 | yes | B-01 Section18仍残留binary-wide `one compiled renderer implementation`硬条件，与multi-entrypoint runtime gate冲突 | historical artifact names; estimated decision-surface percentages | BLOCK | `ses_02a9e7b3fffe1Si0I0h05UUCJq` |
| extra-R26-b | R26 | yes | B-01 primary-path文字未明确成功post后释放`candidateBase` | historical artifact names; estimated decision-surface percentages | BLOCK | `ses_02a99cacfffeBp4QA7FjC5qSf5` |
| final-cycle-1 | R27 | yes | B-01 15%中文解释注释错误按六文件汇总而非逐文件；B-02既有exit-2 typecheck没有可执行baseline-delta gate |  | BLOCK | `ses_02a20fb00ffex8tFA0GULYq5H6` |
| final-cycle-2 | R28 | yes | B-01 compiled TUI未触发原始worker-error正文可见和退出warning路径；B-02 disposal timer在无worker ack时仍合成fulfilled success | historical r24 artifact names; estimated decision shares | BLOCK | `ses_02a0f0389ffeUdE73PcOXGeGsV` |
| final-cycle-3 | R29 | yes | B-01 one-shot Code退出warning路径缺少敏感验证；package/compiled shutdown仅覆盖streaming catch | estimated decision shares; archival evidence | BLOCK | `ses_029fb3f71ffeBjxge1g2hI7TWC` |
| final-cycle-4 | R30 | yes | none | decision shares remain estimates; historical r24 artifact names/archival evidence | APPROVE | `ses_029f27621ffeARszz9vYNSPbC2` |
| final-cycle-5 | R31 | yes | none | Section 11 的 `80% / 10% / 10%` decision-surface 仍是计划估算；implementation audit 必须按实际 diff 重算。; 验证产物名仍包含 `tree-lifecycle-r24.json`（计划第353行）。名称陈旧，但不会改变 R31 的验证语义。; Sections 23–25 保留大量历史实现证据；其已明确标记为 archival/non-normative，不构成 R31 授权依据。 | APPROVE | `ses_027c16d14ffenBn3wnnomiUtqp` |

Historical R31 verdict: **No blocking findings. APPROVE — 仅适用于 canonical plan Revision R31。** Invocation `ses_027c16d14ffenBn3wnnomiUtqp`。该结果不授权R32。

R31 Sections1–21 and this delta are normative。R30 approval remains historical and cannot authorize implementation after spinner identity、native diagnosis、cadence contract及raw budget changed。R1–R30不得与R31混合作为授权。

## R31 Revision Delta: module identity, executable baseline, and surgical raw scope

1. Retain R30 request correlation、accepted mirror、single client tail、real disposal ack、candidate Tree transfer和both Code cancellation consumers。
2. Retain exactly four production files plus`client.test.ts`和one temporary benchmark；`queue.ts`、`Code.test.ts`、repository smoke及all native/Zig files remain zero-diff。
3. Treat current-source DLL WrongGeneration as diagnostic module split：root spinner encoded throughpool A，nested buffer consumed throughpool B；统一spinner importer是owner fix，禁止修改`buffer.zig`或release provenance。
4. Build overlay must fail-if-present then copy/link core、solid、keymap、spinner、plugin；realpath every importer，require one renderer guard and no native panic，finally byte-clean all overlays。
5. Replace impossible absolute50/40/35 gates with identical same-machine HEAD/current workloads；current cadence≥85% HEAD，input p95≤`max(100ms,1.15×HEAD)`，while final prompt、`STREAM-0239`、completion and resize≤150ms remain absolute。
6. Significant improvement remains original-path behavioral：forced worker error changes frompending untildestroy to correlated rejection/current body visible≤150ms；package persistent/full timing and RSS remain independent performance gates。
7. Production must satisfy bothpolicy `E_p≤600` and raw additions+deletions≤600；current951 raw touch is explicitly rejected。Shrink by localized replacements、existing control-flow reuse and deletion of pure rearrangement，without removing any invariant。
8. Keep `hasParser:false` accepted；reset uses same FIFO；disposal is the only always-after-settle operation；candidate success transfers one owner，failure preserves accepted state；no retry、timeout success、second parser、fallback或telemetry。
9. Verification uses separate supervised HEAD/current builds copied to external temp，then one comparison phase plus normal/error/shutdown and unchanged smoke；missing baseline、provenance、cleanup或raw samples fails closed。
10. Remove all `[DEBUG-r31-*]` probes、native source copies、download/build overlays and generated smoke copies before implementation evidence；only the≤600-line canonical benchmark remains。

R31 hard gates: six files/four production；`E_p≤600` and production raw≤600；each file passes15% Chinese comments；bounded client/full package/typecheck/package benchmark；real-ack disposal；both Code consumers；unified spinner/core identity；HEAD/current non-regression；normal240/error≤150ms/shutdown-zero-warning；zero native/queue/Code-test/repository-smoke diff。Independent full-scope plan audit approved exact R31。

## R31 Current Implementation Evidence (Archival; Superseded)

本节仅保留R31实现审计前的历史记录；R32审计必须以R32当前权威章节和最新worktree为准，不能使用本节或下方历史Sections23–25替代R32证据。

### Scope and Budget

- 实现文件仍严格限定为四个production文件、`client.test.ts`和`.temp/testing/opentui-lifecycle-benchmark.ts`；`queue.ts`、`Code.test.ts`、repository smoke source、native/Zig文件保持zero-diff。
- 相对nested OpenTUI `HEAD`的production raw numstat为：`client.ts 103/191`、`parser.worker.ts 119/156`、`types.ts 10/7`、`Code.ts 4/2`，合计`592`，满足R31 raw≤600。
- 当前逐文件新增中文解释注释计数为`client 15`、`parser.worker 18`、`types 2`、`Code 2`；effective `E_i`和每文件`C_i`最终值仍由独立implementation auditor重算，不能用总量比例替代。
- 当前实现没有修改`buffer.zig`、native ABI、shared `queue.ts`、repository smoke或发布provenance。

### Implemented Primary Path

- `types.ts`为HANDLE_EDITS、RESET_BUFFER和DISPOSE_BUFFER建立correlated `messageId`，并允许HIGHLIGHT/ERROR/WARNING沿同一request channel完成。
- `client.ts`登记request callback后再post，generic correlated ERROR/WARNING拒绝原callback；每个buffer使用private Promise tail，create reservation早于await，ordinary edit/reset/streaming只在worker success后推进mirror，dispose只在真实ack后删除mirror。
- `parser.worker.ts`在初始化query完成后发布parser owner；ordinary edit、streaming delta和reset使用candidate Tree，失败释放candidate并保留accepted state，成功通过单一map-pointer commit释放旧Tree/copy；top-level catch保留原始messageId。
- `Code.ts`在destroy后静默处理streaming/one-shot rejection，live failure仍只走既有plain-text compatibility，不重试、不伪造highlight成功。

### Verification So Far

- 外部process-tree supervisor下的focused lifecycle test：`14 pass / 0 fail / 51 expect()`，过滤了`4183`个非目标测试，耗时约1–2秒。
- `bun typecheck`从`thirdparty/opentui/packages/core`退出2，但第二次输出不包含四个production文件、`client.test.ts`或Code诊断；剩余诊断属于既有`dev/**`、benchmark、renderer test和`yoga-upstream/generated/**`基线。
- `git diff --check`通过。
- build-local已经验证nested core、parser worker、solid、keymap、spinner和plugin importer realpath统一，`rendererGuardCount===1`且无WrongGeneration；current/HEAD artifact已复制到外部temp。
- HEAD/current compiled normal与baseline workload已完成；最近一次完整matrix在error mode因`compiled live error logs missing`失败，不能宣称compiled error/shutdown gate通过。该日志捕获缺口不改变production focused test结果，也不再重复执行benchmark，除非implementation audit要求一次最终复核。

### Audit Gate

- 当前canonical plan仍为R31，但状态改为`implementation-audit-required`。
- 尚未获得独立implementation audit verdict；在审计返回`No blocking findings`和`APPROVE`前，不得设置`Status: verified`或宣称GOAL完成。
- 下方历史Sections23–25全部是archival evidence，仅保留上下文，不能覆盖本节的592-line budget、当前focused test或compiled error gate未通过事实。

## 23. Implementation Evidence (archival)

The following pre-R22 implementation evidence is archival and is present in exactly these six intended code files: four production files (`types.ts`, `client.ts`, `parser.worker.ts`, `Code.ts`), `client.test.ts`, and `.temp/testing/opentui-lifecycle-benchmark.ts`. It does not authorize or verify R22. `queue.ts` and `Code.test.ts` are zero-diff against nested `HEAD`. The unrelated pre-existing parent smoke diff remains outside this implementation file list and was not overwritten.

Red/green evidence:

- Fresh `createBuffer()` plus immediate `removeBuffer()` first failed with a retained parser buffer, then passed after pre-await reservation/tail ownership.
- In-flight streaming update plus immediate removal first failed because the old independent queue owners allowed removal before acceptance, then passed with one private tail.
- Real worker `initialQuery` failure, failed mutation/dispose overlap, current Code source visibility and shared-client shutdown tests pass through the public client/renderer seams.
- `bun test ./src/lib/tree-sitter/client.test.ts`: 56 pass, 0 fail, 391 expectations; clean exit under an explicit 120-second process-tree boundary.
- `bun test ./src/renderables/Code.test.ts`: 72 pass, 1 skip, 0 fail; clean bounded exit.
- `bun test ./src/lib/tree-sitter/cache.test.ts`: 7 pass, 1 skip, 0 fail; clean bounded exit.

Package benchmark artifact: `.temp/tree-lifecycle-r18.json`. Three trials completed within the 120-second boundary with zero oracle mismatches, `timingGate=true` and `rssGate=true`; the latest MarkdownRenderable persistent/full medians were approximately `453.327ms` and `16006.039ms`, and failed-initialization RSS growth was `3833856` bytes. Tree-sitter one-shot/persistent timing remains an independent lifecycle indicator, not the Markdown performance gate.

Typecheck: `bun typecheck` exits 2 only on the existing `dev/**` and `src/tests/yoga-upstream/**` baseline diagnostics; after the `Tree | null` correction, no changed lifecycle file appears in the typecheck diagnostics.

Build/TUI evidence: `build-local` created and verified the nested-core junction, but the compiled build is blocked by the environment because `packages/app/node_modules/vite` is missing after the offline model fixture removes the `models.dev` dependency. No compiled binary exists, so the TUI phase was not claimed green. The failed build cleanup was explicitly verified after junction removal. The latest local fixture also fails its cadence gate and cannot substitute for the missing compiled artifact.

Historical diff accounting at the R18 evidence point was `959` raw production additions+deletions (`235+183` client, `268+242` worker, `18+5` types, `6+2` Code). Across the five nested tracked implementation files, raw added/deleted lines were 692/403 and 73 added lines contained Chinese text. R22 requires a fresh exact `E_p`, `E_total`, qualifying `C` and raw-numstat report from its final diff; this archival count cannot satisfy the gate. No completion claim is made.

## 24. Implementation Audit Record

R18 implementation audit result: **BLOCK**. Blocking findings were literal production churn above600, timing/TUI evidence that did not prove the complete fail-closed gate, and the conflict between the plan's non-accepted initialization wording and the existing accepted `hasParser:false` contract. Invocation reference: `ses_03266c5a3ffemS1UE1qd72NOTg`.

R19 plan audit result: **BLOCK** (archival; superseded by R20 through R22).

- B-01: The package benchmark calculates `timingGate` but only throws for `rssGate`; a failed timing comparison can exit successfully.
- B-02: The local fixture directly assigns `MarkdownRenderable.content` and counts a separate `TextRenderable` marker, while the compiled smoke provider emits only one short `ok` delta; the required compiled Session workload of240 Markdown deltas is not exercised.
- B-03: The build-local phase resolves only `@opentui/core`; it does not verify the parser-worker module actually used by the compiled artifact.

Invocation reference: `ses_030b2c7b8ffezrbqyttx1sWWQ8`. R20 addressed each finding without changing the production owner set or adding a tracked file.

R22 implementation audit round1 result: **BLOCK**. B-01 found that both generated and unchanged compiled Session TUI smoke stopped before the required240-delta workload at `initial compiled TUI did not attach to the daemon`; package and build evidence could not substitute for cadence, typing, resize, completion and shutdown measurements. The audit found no additional lifecycle, Tree ownership, fallback, budget or Chinese-comment blocker. Invocation reference: `ses_02b17ce2effe90iSXHU2Jdw1di`.

Post-audit diagnosis established the first divergence: the isolated launcher log reports `Cannot create CliRenderer: stdin is already used by another CliRenderer`, and the binary contains two renderer constructor guards because the compiled graph still reaches a second OpenTUI identity through the root-symlinked plugin consumer. R23 corrected the core/solid/keymap route; R24 corrected the generated harness contract; implementation evidence then proved the plugin consumer remains unresolved. R25 is unauthorized until the final cycle full-scope plan audit returns `No blocking findings` and `APPROVE` for exact R25.

## 25. R22 Implementation Evidence (archival for R30)

R22 implementation changed exactly six code files: `types.ts`, `client.ts`, `parser.worker.ts`, `Code.ts`, `client.test.ts` and the ignored temporary `.temp/testing/opentui-lifecycle-benchmark.ts`. `queue.ts`, `Code.test.ts` and the repository smoke source remain zero-diff against their respective baselines. Existing parent changes to `packages/core/src/models-snapshot.js` and `packages/opencode/script/smoke-opentui-artifact.ts` were not overwritten or included.

Red/green and regression evidence:

- The original forced worker exception loop reproduced `settled=pending`, `pendingCallbacks=1` before repair and rejection only after destroy; the correlated-error path now rejects through the matching callback and the public `client.test.ts` error/visibility tests pass.
- The bounded real-worker client test passes `56 pass / 0 fail / 391 expect()`; it covers fresh init/remove overlap, query failure, failed mutation plus disposal, same-id recreation, ordering and shared-client cancellation.
- The bounded Code test passes `72 pass / 1 skip / 0 fail`, including current-source visibility after rejection and silent destroyed-renderable cancellation. The bounded cache test passes `7 pass / 1 skip / 0 fail`.
- The bounded full package regression passes `4999 pass / 23 skip / 0 fail`, `240 snapshots` and `51347 expect()` calls in `61.63s`.

All commands above ran through the R22 external PowerShell supervisor. Its standalone probe passed normal exit and target exit-code propagation. The corrected package benchmark completed three trials within the boundary and wrote `.temp/tree-lifecycle-r22.json`: `mismatches=0`, Markdown persistent/full medians `396.1664ms / 13098.3296ms`, `timingGate=true`, `rssGate=true`, persistent RSS growth `-30068736` bytes and failed-initialization RSS growth `3788800` bytes. The benchmark harness itself bundled successfully to the approved external temp directory as `147 modules`; the initial no-output-directory invocation failed before execution and was corrected without workspace output.

Build evidence:

- `build-local` first exposed the missing app Vite shim and then the build script's default cross-platform download path. Locked dependencies were restored without manifest/lock changes; a temporary ignored Vite junction and the existing supported `--single` target flag were used only for the build environment and cleaned afterward.
- The final build produced `dist/opencode-windows-x64/bin/opencode.exe`, passed compiled `--version` and voice-worker smoke, and verified nested `@opentui/core` plus `parser.worker.js` realpaths under `thirdparty/opentui/packages/core/dist`. The compiled worker marker was `B:/~BUN/root/../../thirdparty/opentui/packages/core/dist/parser.worker.js`; OpenTUI native evidence reported `0.4.3-smark.6`.
- `bun typecheck` from `thirdparty/opentui/packages/core` exits2 only with existing `dev/**`, benchmark typing and `src/tests/yoga-upstream/**` diagnostics. No changed lifecycle, Code, test or temporary benchmark file appears in the diagnostic output.

Compiled TUI evidence is incomplete and is not claimed green. Both the generated R22 240-delta fixture and the unchanged repository smoke fail before the Markdown workload at `initial compiled TUI did not attach to the daemon`; the isolated daemon health endpoint returns200 while `control/status.tuiClients` remains0. This is a real compiled-artifact/bootstrap failure before stream-marker measurement, so no FPS, input-latency, resize, completion or shutdown pass is asserted. The generated fixture and temporary build overlays were cleaned; the failure artifact remains under the ignored smoke artifact directory for diagnosis.

Final budget evidence, measured against nested `HEAD` and excluding imports, formatter-only, comment-only, generated and pure-move lines:

| File | Raw additions/deletions | Effective code `E` upper |
| --- | ---: | ---: |
| `types.ts` | `25 / 5` | `12` |
| `client.ts` | `240 / 180` | `197` |
| `parser.worker.ts` | `269 / 231` | `197` |
| `Code.ts` | `14 / 2` | `4` |
| `client.test.ts` | `210 / 0` | `159` |
| temporary benchmark | ignored file, `352` lines | `316` |
| Production total | `548 / 418` | `E_p=410` |
| All six code files | raw test/benchmark additions reported above | `E_total=885` |

The historical aggregate recount found `C=139` against `E_total=885`, but R30 explicitly rejects that aggregate as acceptance evidence. Final evidence must recompute and pass all six independent `E_i/C_i` rows. No alternate success path, retry, watchdog, second parser, or production telemetry was added. The existing parser-error plain-text behavior remains shipped compatibility; the only new diagnostic path is correlated request rejection.

R22 implementation audit returned the archival BLOCK above。R31 must receive exact-revision plan approval，then implement/verify ownership、both Code consumers、spinner/core identity、HEAD/current comparator、production raw≤600和per-file E/C，最后通过full-scope implementation audit before `Status: verified`。

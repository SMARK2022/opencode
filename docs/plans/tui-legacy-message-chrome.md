# Canonical Implementation Plan: Restore Legacy TUI Message Chrome

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: User instructions in this conversation, quoted below
>
> Target state: verified-implementation-and-commit
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-06

This is the sole implementation specification. The primary agent owns the plan,
experiments, tests, implementation, verification, and commit. Task is restricted
to the workflow's independent read-only audits.

## 1. Verbatim Requirement

> 把 description恢复成B必填是没有必要的。本身可选就是可选，就没有问题。但是那个，在格式化为点儿就隐藏这个规则是需要给撤掉的。
>
> 然后相应的消息级边框这个以及配套间距，请你为我去按照旧的这个格式去准确地恢复。你不要去自己去写一套格式，或者说自己去写一套这个算法论，这个等等一些情况。本质上你应该去按照旧的逻辑去进行一个复现，或者说什么，你保持一个简洁，就是把旧的逻辑按照更简洁的方式去搬过来，同时保持什么具体的这个结果的一个 case 是正确的。
>
> 然后你需要按照我们的 DOCS 里面的 Workflow 去进行。
>
> 最终的验收状态呢是verified以及这个commit。然后请你保持相应的这个样式啊，整体就是复现的准确，然后包括什么间距啊，然后卡片内部的间距啊，等等。还有这个不同工具的一个样式啊，巴拉巴拉的，你都去尽量去复现对齐一下。当然比如说现在这个新版的 TUI，它所增加的一些机制，就比如说这个 thinking 啊，等等，它去做了一些这种额外的一些动画，或者说动效处理，那本身这当然也不需要把那些东西去给撤回。就你去兼容一下两者的机制。然后其实用户的本身的需求就是说让我们能够去看得到每一个 session 之间的一个范围。所以本身用户之前那么一个卡片机制就是这么一套操作。然后同时每一个这个 bash 命令，它最好要能够让用户去知道它到底在什么地方去运行啊，巴拉巴拉，或者说运行的一些这个像那些消息啊，巴拉巴拉的。

Additional verbatim constraints:

> 那与此同时你注意一点，相应的什么 Yinla、Tool这些组件的这个卡片更新，我们更新的不只是一个 commit，应该是多个 commit 都在处理这件事情。然后最后它是一个完全态的东西。你当然也可以去结合 commit以及这个最终文件的终态，你去最终状态你去进行一个检查。

> 请注意点，所有的修改啊，所有的方案提出以及修改操作本质上应当由你进行，不得由 Task 进行。

Further verbatim clarification of the same visual requirement:

> 注意你要保持原有的视觉语言，你不要试图去修改、使得相应的视觉语言等等又不一致了，请注意这一点。也就是视觉语言需要保持一致。之前是怎么样的视觉语言，你现在就用成什么样的视觉语言。你不要又自己去建一套这个样式逻辑，请注意这一点。
>
> 换言之，之前我们DEV Spark那个分支使用的怎样的编程语言，现在就是使用怎样的。

Latest controlling scope corrections, verbatim:

> LSP不被支持了呀，它就不需要被渲染了呀。LSP是诊断等等内容都不需要被渲染，请注意这点，任何LSP都不需要去管了。

> 任何的断言、assert都应该是基于 HED 去做的，比如 HED 里面没有什么或者有什么。HED 里面，HED 里面本来就没有 LSP，那你去加断言去限制它没有是干嘛？你是不是在限制空气吗。

> 如果 diagnostics表示的是 LSP 所返回的具体的这个文件是否有错误，有几处错误，巴拉巴拉这种东西，不应当保留，我说过了，应该被移去，且彻底移去。

R4 corrects R3's mistaken preservation of HEAD's diagnostic display. Remove the
file-error/count/clean-state presentation completely from TUI tool cards: all
four render sites, Diagnostics, its parser, its now-orphaned path helper and its
dedicated unit test. No negative LSP assertion, filtering policy, feature flag or
backend investigation is introduced. Generic tool errors remain generic errors.
New assertions still concern the observed visual contract, not a prohibition.
This supersedes R3's LSP exclusion and R2's diagnostic-spacing B-01 condition;
the complete original message/card restoration remains required.

The earlier investigation instruction, verbatim:

> 你需要保持 read only，去高效地去调研一下，然后分析一下情况，以及我去提出应该去怎么做修改。然后同时请注意你的修改本质上应该保持这个克制以及精简精准，同时这个逻辑呢整体要保持泛化性啊，就是泛用性收益要较多，然后同时不要去对性能有影响。因为我们上一个 commit，或者说上上个 commit 刚修完这个性能问题。

Conversation order: this earlier message authorized read-only investigation. A
later user message, quoted first in this section, explicitly requested restoration,
workflow verification and a commit. Plan-stage work stayed read-only except for
this canonical artifact and the authorized isolated probe; implementation starts
only after the recorded exact-revision approval. The pasted external handoff is
background, not an authoritative design or acceptance source. This source-only
record correction resolves N-01 without changing R1's approved behavior.

Dependency setup was explicitly authorized after the first installation attempt
was rejected: “我就是授权你进行所有的这个 BUN 的 install。对，当前这个因为我们工作区是刚迁移过来，所以必要的 install 是可以允许的。”

## 2. Explicit Non-Goals

- No change to either V1 or V2 Shell schema: description remains optional.
- No execution, permission, provider, durable progress, database, SDK, or Protocol changes.
- No default-workdir metadata, history backfill, global cache, or additional HTTP requests.
- No replacement of current reasoning header animations, opaque Thought handling,
  streaming completion, keyed projection, content residency, or native cleanup.
- No restoration of legacy BlockTool-owned expansion or renderBefore signal mutation.
- Preserve newer inline hanging-wrap/error interactions while restoring legacy
  message boundaries, indentation, and vertical spacing. No unrelated tool text rewrite.
- No changes to the existing untracked cross-host daemon plan and no push.
- No LSP producer/server/schema changes or suppression of ordinary tool output
  and failures. Delete the TUI diagnostic-display feature directly; do not add
  runtime filtering, compatibility branches or positive/negative LSP assertions.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `AGENTS.md` | Reuse existing owners, no speculative abstractions, package-local tests/typecheck |
| `docs/workflow.md` and first-principles policy | Plan approval, TDD, full implementation audit, E/C gate, verified before commit |
| `CONTEXT.md` | Presentation must not change durable history, tool output, or Location ownership |
| `docs/adr/README.md` | No applicable rendering ADR; no new architectural decision is needed |
| `packages/tui/package.json`, `tsconfig.json`, `bunfig.toml` | Bun/OpenTUI Solid runtime; `bun typecheck`; tests run in this package |
| `docs/long-session-performance-fixes.md` and commits `c495ef00e6`, `1194c9ad01` | Preserve shared request usage and bounded history/control paths |

## 4. Files and Evidence Read

Comparison uses final `dev-smark@26061b595b` (1.15.14-smark) and current
`dev1-smark@321a3ffedd` (1.19.17-smark), not an individual migration patch.

| Evidence | Relevance | Class |
| --- | --- | --- |
| Legacy `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2140-2146,2214-2243,2308-2364,2482-2536,3094-3421` | Final border, first-visible, tri-state tool spacing, card sections, Shell title | observed |
| Legacy `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:791-870` | Independent frame expectations for continuity and hidden first parts | observed |
| Current `packages/tui/src/routes/session/index.tsx` | Session list, raw part projection, message shell, all common tool consumers, footer/error/patch | observed |
| Current `packages/tui/src/util/layout.ts`, `routes/session/layout.ts` | Cached pre-layout adjacency and width accounting | observed |
| Current `component/spinner.tsx`, `routes/session/notebook-tool.tsx`, `context/path-format.tsx` | Animation, caller-owned preview/body, path formatting | observed |
| Current `test/cli/cmd/tui/session-message-render.test.tsx`, `sync-fixture.tsx`, `test/fixture/tui-sdk.ts`, `tui-environment.tsx` | Real Session rendering seam and external transport fixture | observed |
| Current inline wrap, block collapse/preview-once/visible-once, session layout, reasoning disclosure tests | Existing visual and resource invariants | observed |
| V1 `tool/shell/prompt.ts`, `session/processor.ts`, V2 `core/src/tool/bash.ts` | Optional description and retained input reach TUI without metadata duplication | observed |
| Commits `5b3ab4311d`, `ea7e3d9375`, `37b280feb8`, `f0469142a6`, `559e71e017`, `86cae19ba9`, `30d745752a` | Cumulative migration evidence; final source is authoritative | observed |
| Temporary `D:/Temp/opencode/tui-legacy-parity-probe.test.ts` | Three executed failing user-visible frame assertions | observed |
| Same probe, `--test-name-pattern 'legacy markup'` | Native render of exact old inline/Loaded markup: both start after 3 spaces, not 6; 1 pass, 2 assertions | observed |

## 5. Current Behavior

```text
optional Shell arguments -> retained ToolPart.state.input -> ToolPart -> Shell title
Session messages -> raw keyed part projection -> AssistantMessage root
  -> ReasoningRun / TextPart / ToolPart -> InlineToolRow or BlockTool -> terminal frame
```

The message root has no border or external margin. Text/reasoning/card nodes
always add their own top row; transparent layoutGroups flatten tools across
message roots. This preserves some empty rows but cannot draw message identity.
Inline rows retain the old actual outer inset but lost the self-multiline separator.
BlockTool retains preview/body lifetime fixes but its collapsed affordance has
no preceding blank row; expanded hints live in inconsistent caller bodies.
Shell ignores input.description, hides formatted '.', and animates command text.

## 6. Supported Input Domain and Reachability

| Input/condition | Producer/guarantee | Reachable path and owner | Class |
| --- | --- | --- | --- |
| Missing description, missing/raw '.' workdir, explicit root/subdirectory | Both optional schemas; stored input is retained | ToolPart -> Shell | contracted |
| Text, reasoning, adjacent tools, mixed messages | Session Part union and keyed projection | AssistantMessage and parts | observed |
| Empty text, hidden completed tools, partial searches | Details/thinking settings and tool structured/metadata projection | Existing visibility rule -> first-visible spacing | observed |
| Opaque reasoning metadata without visible text | Current ReasoningRun renders Thought | Raw reasoning run -> same visible spacing | reachable |
| Pending/running/completed/error tools, review rows and loaded Read rows | Existing tool lifecycle and metadata | InlineTool/BlockTool consumers | observed |
| Long command/output/diff, multi-file Patch, notebook block | Existing collapse thresholds and per-file interaction keys | Existing caller expansion -> shared card chrome | observed |
| Offscreen release, delta, resize, selection, navigation | Existing messageView/pins/dirty signatures | Existing Session residency and measurement | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence / existing coverage |
| --- | --- | --- |
| INV-01 | Description stays optional; existing input/title history remains readable | User; shell-prompt schema tests |
| INV-02 | Shell has legacy intent-or-Shell title, optional formatted workdir suffix, no duplicate suffix; explicit root formats to '.' visibly | User; legacy final title; failing probe |
| INV-03 | One message owns a continuous outer rail, internal gaps carry it, adjacent messages have one borderless row | User; legacy frame tests; failing probe |
| INV-04 | First visible part has no internal top gap; later text/reasoning has one; tools use old false/true/undefined relation | Legacy final code and hidden-part tests |
| INV-05 | Old tool insets, adjacent compact inline rows, multiline separation, card body/preview/affordance gaps are preserved; removed diagnostics own no section | Legacy final code; failing card probe; latest user correction |
| INV-06 | Current animated reasoning/opaque header, two-column hanging-wrap/error interaction, keyed body/preview lifecycle remain functional | User; current reasoning/wrap/resource tests |
| INV-07 | Same message ID root, frozen height, pins, shared request usage, one preview/body owner, and pre-layout geometry remain authoritative | Current residency, scroll, preview leak tests; recent performance fixes |
| INV-08 | Primary agent implements; workflow reaches independently audited verified state and a scoped commit | User; workflow |
| SCOPE-09 | Completely delete TUI card diagnostics and their exclusive helpers/tests; preserve ordinary tool cards/errors; no unrelated type cleanup | Latest user correction; call-site/dependency review and existing positive card/error tests, no invented absence assertion |

## 8. First Divergence and Root Cause

| Invariant | Origin / propagation / manifestation | Owner and proof |
| --- | --- | --- |
| INV-02 | Shell constructs only Running-in title and discards formatted '.' -> absent header | Shell title memo; retained input is already sufficient |
| INV-03/04 | Message root loses border/external-gap ownership -> children/cross-root grouping compensate for gaps -> no continuous rail | AssistantMessage; legacy final root vs current root and failing frame |
| INV-05 | Tri-state top margin and shared affordance section disappear -> per-tool unconditional margins/inline hints diverge | AssistantMessage, InlineToolRow, BlockTool and direct callers |
| INV-07 | Current width assumes no common rail -> adding it without width adjustment would mismeasure wrap/disclosure | Existing `sessionMessageContentWidth` constant |

Red-capable command, run twice from `packages/tui` on unmodified production:

```text
bun test "D:/Temp/opencode/tui-legacy-parity-probe.test.ts" --timeout 30000
0 pass, 3 fail (about 3 seconds)
rail: expected '┃', received ' '
title: expected '# Inspect files in .', absent
expand preceding section row: expected empty, received 'legacy output 7'
```

The temporary probe reuses the existing real Session fixture in memory, compiles
it with the installed Solid transform, and asserts actual frames; it does not
assert source text or reimplement production layout. Scrollbar cells are excluded
using the message's actual content rectangle. No production change was made.

## 9. Responsibility and Seam

| Concern | Owner / promise | Why no other owner |
| --- | --- | --- |
| Message identity and first visible relation | AssistantMessage over existing keyed projection | Individual tools cannot delimit whole messages |
| Tool relative gap | Existing ToolPartTopMargin relationship + InlineToolRow pre-layout hook | No render-after state mutation or separate spacing engine |
| Common card sections | BlockTool presentation | Caller still owns expansion and content factories |
| Shell title/workdir | Shell consuming retained input | Executor, DB and progress need no duplicated display metadata |
| Rendered content width | Existing session layout function | No separate per-part width formula |
| Acceptance | Real Session frames, exported BlockTool/InlineToolRow renderer, existing package tests | No test-only production export |

## 10. Single Approved Primary-Path Design

This is the user-authorized visual rollback: “把旧的逻辑按照更简洁的方式去搬过来”.
It replaces presentation rules directly for all applicable messages; it is not
activated by failure and has no feature switch or parallel renderer.

1. Pass the existing message-list index to AssistantMessage. Restore the old
   root left border/SplitBorder/backgroundElement and external margin (first
   list message 0, subsequent messages 1). Keep this same ID/frozen-height root.
2. Restore the old first-visible relation over the current raw keyed projection.
   Compute key -> top-margin/tool-margin information once in message order,
   rather than repeating legacy indexOf/find per Part. Visibility reuses current
   rules, including partial search and visible opaque Thought. It never changes
   reasoning topology, keys, or mounted-body ownership. Reuse this projection
   for footer visible-parts rather than adding another whole-history scan.
3. Restore private ToolPartTopMargin context with old tri-state semantics:
   false for first visible tool, true after visible non-tool, undefined after
   visible tool. ReasoningRun/TextPart receive the old boolean top-margin prop.
   Reasoning's outer nested rail/padding 2 is restored while all current header,
   animation, clipping, body, completion and interaction logic stays intact.
4. InlineToolRow keeps current two-column wrapping/pending/error interaction and
   actual legacy outer inset 3, matching Loaded Read rows. Do not turn ignored
   legacy text padding into additional box padding: the isolated native-render
   experiment proves both old rows start after 3 spaces, so the common rail makes
   their icon column 4, not 7. Restore self/previous multiline separation and sticky measured
   gap in the existing pre-layout callback, with explicit context overriding it.
   Remove Task's unconditional separate flag; multiline Task naturally separates.
   Retain the existing separate prop for other existing direct consumers.
5. Stop registering message roots as transparent layoutGroups. Remove that
   superseded WeakSet/flatten/cross-message-boundary logic from util/layout;
   retain its per-parent per-frame previous-sibling cache and before-Yoga write.
6. BlockTool uses context for root top margin exactly as legacy (false -> 0,
   otherwise 1). Restore one blank row before affordances and keep body/preview
   and error section margins. Use a small optional string `footer` presentation
   prop for the existing expanded hint: all Generic/notebook, Shell, Write,
   Edit and per-file Patch callers move that hint out of body into this shared
   section. This moves no state or content ownership into BlockTool. Preserve
   Write/Edit/Patch body structure while deleting their diagnostic render sites;
   no replacement diagnostic wrapper or empty section remains.
   No root gap, duplicated preview evaluation, or second collapse state.
7. Shell restores `description ?? 'Shell'` plus the old nonduplicate formatted
   workdir suffix. Preserve raw missing/'.' omission; remove only formatted '.'
   suppression. Restore running spinner on the intent title and static command
   body, keeping the current animation setting. Preserve command/output gap,
   bounded preview, returned-to-model view and per-Part expansion state.
8. Change only message-left chrome from 3 to 4 in the existing width formula;
   keep current sidebar, scrollbar and main-column accounting.
9. Delete the four Write/Edit/ApplyPatch Diagnostics invocations, Diagnostics,
   parseDiagnostics, their exclusive imports and the orphaned util/path module.
   Write's source-card branch currently uses metadata.diagnostics as a readiness
   signal. Replace only that operand with metadata.filepath: V1 Write already
   returns filepath on successful execution (`packages/opencode/src/tool/write.ts`),
   while V2's existing operation === 'write' operand remains. No fallback or new
   lifecycle state is needed. The existing source-card fixture uses this real V1
   filepath field, preserving its positive expansion/body/section assertions.
   Delete the parser's dedicated malformed-range test. Use an ordinary file-read
   failure in the generic inline-error fixture instead of its LSP-server example;
   preserve the same generic error interaction/geometry tests and snapshot.

Multi-file Patch retains the legacy Part-scoped margin semantics: each file
card inherits false/true/undefined; do not invent a per-card first-item algorithm.
Its shared review header and current per-file keys remain as shipped.

Reconsideration requires a new explicit product request, not a runtime failure.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Success? | Disposition |
| --- | --- | --- | --- |
| Restored message/card visual rules | Explicit user-requested rollback | Presentation | Replace current divergent rules |
| Missing description -> Shell, missing/raw '.' workdir omission | Existing shipped compatibility / primary domain | Presentation | Preserve |
| Running/static title, preview/body, context output, opaque Thought | Supported primary-contract branches | Presentation | Preserve current owners |
| UI stringValue guards and V1/V2 metadata projection | Existing shipped compatibility | Presentation | Preserve, do not expand |
| Extra cwd/description progress copies, alternate renderer/layout switch | Forbidden unneeded alternatives | N/A | Reject |

New alternate success paths: 0. New diagnostic production surface: 0%.

## 12. Workaround Deletion and Replacement

| Existing compensation | Replacement |
| --- | --- |
| Cross-message transparent grouping and boundary margin minimum | Message-owned outside gap and continuous border |
| Unconditional first InlineTool gap / Task separation | Old visible-item context and existing cached sibling measurement |
| Affordances scattered inside caller bodies | One shared BlockTool affordance section, same caller expansion owner |
| Title absent unless nondefault workdir / context-only Shell label | Legacy intent-or-Shell title from retained input |

## 13. Forward Traceability

| Invariant | Production file/change | Behavioral verification |
| --- | --- | --- |
| INV-01 | No schema/executor change | Existing optional-schema test; rendered historical inputs without description |
| INV-02 | Shell title/workdir/spinner in session/index | Intent present/absent, missing/raw '.', explicit root/subdir, duplicate suffix, running/completed/context frames |
| INV-03/04 | Message root, keyed visible-margin projection, private context | Same-message continuous vs cross-message broken rail; first text/reasoning/tool, empty/hidden/partial/opaque, live visibility |
| INV-05 | Inline/card chrome + direct callers | One-line/multiline/loaded rows; Generic/Shell/Write/Edit/Patch; section gaps, first multi-file patch |
| INV-06 | Preserve newer rendering and lifecycle | Existing wrap/error/pending, reasoning disclosure/streaming and notebook tests |
| INV-07 | layout.ts/util layout and untouched residency | Resize, frozen height/delta, selection/pinning, 100 toggles, preview-once/visible-once, shared request usage tests |
| INV-08 | This artifact and scoped git commit | Full-scope plan/implementation audit records; verified before commit |
| SCOPE-09 | Delete all four card sites, component/parser, exclusive path module/imports and parser test; use actual Write filepath readiness | Full dependency/diff audit, positive Write/body tests and generic error tests; no LSP assertion or production filter |

## 14. Reverse Traceability

| Concept | Requirement | Why reuse alone is insufficient |
| --- | --- | --- |
| Legacy root rail/index gap | INV-03 | Existing tool-local borders cannot span a message |
| Single ordered visible-margin map and private tri-state context | INV-04/07 | Current unconditional gaps cannot express the old first-visible distinction; reuse raw projection and existing visibility |
| Pre-layout old multiline relation | INV-05/07 | Current previous-only measurement loses self-multiline case; old renderBefore mutation would undermine current geometry |
| Optional string footer on BlockTool | INV-05/06 | Expanded hints are currently inside destroyable tool bodies; common card chrome needs one section without taking expansion ownership |
| Shell input-based title / formatted '.' | INV-01/02 | Current title ignores available input; backend copies would duplicate existing authority |
| Left-chrome constant 4 | INV-05/07 | Existing single width formula must include restored rail |

## 15. File-Level Change Plan

| File | Operation / responsibility | Estimated delta |
| --- | --- | --- |
| `packages/tui/src/routes/session/index.tsx` | Modify message/part/inline/card/Shell presentation and direct footer callers | +100/-65 effective lines |
| `packages/tui/src/routes/session/layout.ts` | Modify existing message chrome constant/comment | +2/-2 |
| `packages/tui/src/util/layout.ts` | Delete obsolete transparent-group branch; retain cached sibling owner | +2/-12 |
| `packages/tui/src/util/path.ts` | Delete the diagnostic display's orphaned path-normalization module | -12 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | Real Session legacy parity cases using existing fixture | +150-240 |
| `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | Align former transparent-group fixtures and old insets/gaps while preserving modern wrap/error assertions | +30/-25 |
| `packages/tui/test/cli/tui/__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap` | Update affected literal frames for old measured gaps, with full tool rows retained | Approximately 20 changed lines |
| `packages/tui/test/routes/session/session-layout.test.ts` | Update literal expected message-chrome width | +3/-3 |
| `packages/tui/test/routes/session/shell-output-spacing.test.ts` | Adjust affected existing static guard to restored first-visible ownership; keep its other checks | +3/-3 |
| Existing block collapse/preview/visible tests, reasoning disclosure and notebook tests | Extend relevant rendered section/status assertions where their existing seam fits | +30-70 |
| This canonical plan | Audit and implementation evidence | Documentation only |

No new production module, dependency, config, schema or generated file.
Test-only literal fixtures/helpers stay next to their actual rendered consumers.

## 16. TDD Behavior Slices

Agreed seams are the existing real Session headless renderer and existing exported
BlockTool/InlineToolRow rendering seams, not new public exports or source-text probes.

| Order | Red behavior | Minimal green | Protected regression |
| --- | --- | --- | --- |
| 1 | Shell intent/root-directory title is absent | Restore old input title/workdir rule and running title spinner | Optional input, context view, no double command |
| 2 | Message frame lacks outer rail / first-visible gaps are wrong | Restore root and old visible relation/context, insets and width | Hidden/partial/opaque parts, modern reasoning, adjacency |
| 3 | Collapsed/expanded card sections touch | Shared footer section; HEAD body structure retained | Every existing card caller, Write overwrite, multi-file Patch, click/re-expand and preview ownership |
| 4 | Combined parity/residency/resize regressions | Only fixes within approved presentation rules | Recent bounded-memory/shared-usage behavior |

One vertical slice at a time: write repository behavior assertions, observe red,
make minimal approved production change, observe green, then expand coverage.
Literal positions and row deltas come from legacy final code/tests. Keep newer
animated header text and width-aware inline wrapping rather than copying old prose.

## 17. Chinese Comment Budget

Estimated effective changed lines E = 300-400, so required C = 45-60; actual
values must be calculated before implementation audit. The 15% gate will not
be weakened if the estimate changes. Exclude imports, pure moves, blank lines,
formatting and documentation; include substantive new tests.

Qualifying nearby comments explain message-external vs internal gaps, tri-state
precedence, visibility vs topology/opaque compatibility, one ordered scan,
pre-layout self-height/sticky behavior, common footer vs caller lifecycle,
explicit root formatting, width accounting, and the
independent behavioral expectations and lifecycle boundaries of each test case.

## 18. Verification

All tests/typechecks run from the indicated package directories.

| Command | Directory | Evidence |
| --- | --- | --- |
| `bun test "D:/Temp/opencode/tui-legacy-parity-probe.test.ts" --timeout 30000` | `packages/tui` | Original exact three symptoms, red before and green after |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` | `packages/tui` | New parity plus existing real Session residency/resize/pins/100 toggles |
| `bun test ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx ./test/routes/session --timeout 30000` | `packages/tui` | Common tool, card, reasoning, width, notebook and review behavior |
| `bun run test` | `packages/tui` | Full TUI regression; use intended process-isolated per-file execution if required by existing Windows/native test constraints |
| `bun typecheck` | `packages/tui` | Type safety of production and test interfaces |
| `bun test ./test/tool/shell-prompt.test.ts --test-name-pattern 'render exposes native script' --timeout 30000` | `packages/opencode` | Optional description/argument contract unchanged |
| `git diff --check` and full intended diff review | Repository root | Whitespace, scope, untouched user changes |

Already observed: first renderer run failed because workspace schema links were
absent. Authorized `bun install --frozen-lockfile --ignore-scripts` installed
2372 packages without tracked changes; command wrapper reached its timeout after
the installation summary. The repeated real Session 100-toggle baseline passed:
1 pass, 0 fail, 200 assertions in 13.03s on Bun 1.4.4.

No universal speedup or zero-cost claim is made. Preserve the current cached
pre-layout, bounded body/preview residency, shared usage and exact geometry;
verify with those existing executable regressions rather than adding a profiler
or permanent instrumentation.

## 19. Diff Budget

| Metric | Estimate / rationale |
| --- | --- |
| Files added | One canonical plan; no new production module |
| Files modified | Three production files and the listed existing behavior tests |
| Files deleted | One orphaned diagnostic-display module: `packages/tui/src/util/path.ts` |
| Effective production changes | Approximately 170 added/modified, plus removal of superseded grouping/hints |
| Effective test changes | Approximately 200-300, reusing existing fixtures |
| Generated changes | Zero |

## 20. Real Risks and Open Decisions

- Added outer rail changes width and therefore line counts: update the existing
  width formula and retain resize/disclosure/frozen-height tests.
- ToolPart emits multiple renderable siblings (Read loaded rows, Patch cards):
  preserve old Part-scoped tri-state semantics rather than treating every card
  as a new message or inventing grouping wrappers.
- Preview JSX getters and destroy/recreate semantics are already sensitive:
  footer must be plain presentation; keep preview memoization and body factory.
- New opaque Thought is visible despite empty normalized text: retain it in the
  visible relation without changing raw reasoning grouping.
- Native Windows suites can interfere across files; retain existing deterministic
  assertions and use the repository's isolation approach, not increased timeouts.

### Open Decisions Requiring the User

None. Existing public rendering seams, legacy final visual rules and the explicit
newer-mechanism preservation instruction define the route.

### Rejected Speculation

No evidence requires description to become mandatory, executor metadata copies,
DB migration, a full-history formatting pass, alternate rendering mode, or a new
layout/state machine. Those concepts are excluded.

## 21. Audit Contract

Independent auditor reads this exact revision and original instructions, rebuilds
the complete affected behavior from the repository, and audits full scope on
every round. Primary supplies no self-review or preferred audit scope. Check
ownership, authorized visual rollback, modern behavior/lifecycle compatibility,
behavior-sensitive tests, complete mappings, code quality and the 15% Chinese
explanatory-comment gate. Auditor is read-only; primary records exact verdicts.

## 22. Plan Audit Record

### R3 Scope Revision

Historical interpretation, superseded by the explicit R4 correction below.

The user interrupted the second R2 implementation-audit invocation and explicitly
excluded LSP work, then rejected the builder's proposed negative LSP assertion.
R3 withdraws that proposal rather than implementing the inverse feature.
The original observed HEAD feedback loop remains the gate: missing Shell intent
title/explicit-root title, absent message rail, and missing card affordance gap.
No extra feedback loop or production rule is introduced for an excluded feature.

After R3 approval, primary will remove the diagnostic fixture/row-delta assertions
added during B-01 rework and the four diagnostic-only body wrappers. The existing
Write-overwrite card case remains as ordinary card/affordance coverage, without
diagnostics data. `Diagnostics`, `parseDiagnostics`, their calls/imports and the
HEAD parser test remain as shipped. No new files/modules are needed. Existing
newer animations/wrapping/resources and the complete original visual scope stay.

The temporary negative-LSP experiment was an unapproved interpretation of the
latest request and is withdrawn. It is not an implementation requirement or
release gate. Prior R1/R2 verdicts and executions below are preserved as history;
they do not approve R3. Full-scope R3 plan and implementation audits are required.

### R4 Diagnostics Removal Revision

R3's implementation-audit call was interrupted without a verdict
(`ses_e534ed5b8ffeRdmUKwRksPIv8t`). The user then explicitly required complete
removal of this diagnostic display, not preservation of HEAD's existing display.
R4 retains the full visual scope and changes only that mistaken responsibility.

Current call-graph inspection finds four Diagnostics sites in Write overwrite,
Write source, Edit and each ApplyPatch file. Diagnostics alone imports
useTuiTerminalEnvironment and util/path.normalizePath here; util/path has no other
TUI consumer. parseDiagnostics has one consumer, its dedicated malformed-range
unit test in inline-tool-wrap-snapshot.test.tsx. No producer/backend change is
required. The deleted path module owns no independent product contract.

After exact R4 approval, primary changes the existing Write source-card fixture
from operation-only readiness to the actual V1 filepath result, runs its positive
case to demonstrate the current missing-card result, then removes the obsolete
display and replaces Write's readiness operand as specified in section 10.9.
This is not an absence test and supplies no LSP fixture. The requested deletion
itself is reviewed as a direct removal of a feature, not reintroduced as a new
"no LSP" production rule or test suite.

Additional affected path: delete `packages/tui/src/util/path.ts`; all other
affected paths are already listed in the original restoration. Re-run Session
frames, inline/error/snapshot and related route tests, TUI typecheck and full
suite, optional Shell schema tests, diff/comment gates and the original isolated
visual probe. Snapshot refresh is limited to the ordinary error fixture text.
R3 execution results below remain historical; R4 requires fresh verification,
full independent implementation audit, verified state and scoped commit.

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | N-01 | APPROVE | `ses_e53b0ea8bffeOcCBnORS11Tl87` |
| 2 | R2 | yes | No blocking findings | N-02 | APPROVE | `ses_e53b0ea8bffeOcCBnORS11Tl87` |
| 3 | R3 | yes | No blocking findings | None | APPROVE | `ses_e53610f99ffeIuoLvIY0GI6jQu` |
| 4 | R4 | yes | No blocking findings | N-03 | APPROVE | `ses_e5343ab79ffeN0gZYse6n7qh4L` |

### Round 4 Finding And Release Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

### N-03 文件清单与 diff 预算仍残留旧版记录

`docs/plans/tui-legacy-message-chrome.md:313-321` 的文件表尚未列出 `packages/tui/src/util/path.ts` 的删除，`:387-388` 仍记载“三个生产文件”“无文件删除”。

R4 已在 `:246-255`、`:474-480` 明确规定该删除及相关验证，因此执行范围明确，这是记录一致性问题。同步这些汇总字段即可，无须改变设计。

## Primary-path and fallback verdict

**PASS。**

方案直接恢复旧版消息与卡片展示规则；新版状态、交互及资源所有权继续沿现有路径运行。诊断展示按明确要求直接删除，Write 就绪条件改用已有成功结果字段。未发现新增备用成功路径、并行渲染器、运行时过滤策略或第二套折叠状态。

## Code quality and Chinese-comment verdict

**方案级 PASS。**

修改归属现有展示所有者，独占诊断依赖随功能删除，没有新增生产模块、依赖、配置或后端请求。

计划 `docs/plans/tui-legacy-message-chrome.md:344-355` 明确承诺实施目标 **C/E ≥ 15%**，预计 E 为 300–400、C 为 45–60，估算可行。实际 R4 的 E、合格 C、排除类别及比例须在实现审计中依据最终 diff 重新计算；历史计算不能替代。

## Release verdict

**APPROVE — 仅放行 `docs/plans/tui-legacy-message-chrome.md` 的 R4，完整范围方案审计。**

审计文件 Git blob：`7de804a132f28858a69421d077b1ec1c334c109c`。

当前工作树尚待实施 R4 的诊断删除和 Write 条件调整。完成新验证并通过完整独立实现审计后，才能记录 `verified` 并提交。

N-03 disposition: synchronized the file-level list and deleted-file budget above;
the three modified production files remain three, plus the already-approved
module deletion. This administrative correction changes no approved design.

### Round 3 Finding And Release Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- 不要求 description 必填、补写 cwd/description metadata 或迁移历史记录。现有可选输入与保留的 `state.input` 足以完成展示恢复。
- 不要求恢复旧版 BlockTool 折叠状态机、`renderBefore` 信号修改或逐卡片间距算法。现有生命周期与布局前测量可以承载旧视觉规则。
- 不把 LSP 恢复、删除或“禁止渲染”变成本次功能，也不增加正反断言。R3 明确撤销诊断专用修改，保留 HEAD 的既有责任边界。
- 未发现需要新增后端请求、全局缓存、兼容开关或第二套渲染路径的证据。

## Primary-path and fallback verdict

**PASS。**

## Code quality and Chinese-comment verdict

**方案级 PASS；实际实现质量留待实现审计。**

## Release verdict

**APPROVE — 仅适用于 `docs/plans/tui-legacy-message-chrome.md` 的 R3，完整范围方案审计。**

审计文件 Git blob：`2825bc4802a5047fdaced0ee27bd3c90352a8473`。

当前工作树仍含 R3 明确要求撤销的诊断专用修改。落实 R3、重新验证并获得完整独立实现审计通过后，才能进入 `verified` 并提交。

### Round 1 Finding And Release Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 原始约束的归档和阶段表述需要补齐

`docs/plans/tui-legacy-message-chrome.md:33-45` 没有逐字收录补充需求中的“保持 read only”以及“克制、精简、泛化、保护近期性能修复”的完整原文；其中“read-only phase was superseded”的授权时序，也无法由本次 handoff 独立确认。

本轮方案仍明确禁止实施，性能保护已有对应设计和验证映射，因此这是非阻断记录项。建议补齐原文，并准确区分当前只读调研阶段与后续 workflow 阶段；授权记录应保留可核验来源。

## Rejected speculation

- **不要求 description 必填或新增执行元数据。** V1、V2 输入已经允许省略 description，现有 ToolPart 输入足以恢复标题。证据：`packages/opencode/src/tool/shell/prompt.ts:17-29`、`packages/core/src/tool/bash.ts:35-43`、`packages/tui/src/routes/session/index.tsx:2609-2625`。
- **不要求为多文件 Patch 新造逐卡片间距算法。** 旧版最终实现确实让各卡片继承同一个 Part 的三态间距；R1 保留这一语义符合精确复现要求。
- **不要求恢复旧 BlockTool 内置折叠状态或 renderBefore 信号修改。** 当前预览复用、正文销毁重建和布局前测量各有实际消费者与回归测试；视觉恢复不需要撤回这些修复。
- **没有证据要求修改后端、数据库、请求统计或新增缓存。** 本次差异及其所有者均位于现有展示路径。

## Primary-path and fallback verdict

**PASS。**

## Code quality and Chinese-comment verdict

**方案级 PASS；实际实现质量待实现审计。**

## Release verdict

**APPROVE — 仅适用于 `docs/plans/tui-legacy-message-chrome.md` 的 R1，完整范围方案审计。**

当前实现仍未验证。后续达到 `verified` 和 commit 终态，还需完成仓库内 red-green 测试、原始反馈环、包级回归与类型检查、实际 E/C 计算，以及完整独立实现审计。

### R2 Revision And Plan-Stage Experiment

Implementation paused after the first message-layout slice exposed a static
padding assumption in R1. Both final legacy and current repositories use
OpenTUI 0.4.3-smark.13. Rendering the exact old `box paddingLeft=3` plus
`text paddingLeft=3` markup in isolation produced:

```text
"   → Read alpha.ts"
"   ↳ Loaded beta.ts"
```

`bun test "D:/Temp/opencode/tui-legacy-parity-probe.test.ts" --test-name-pattern
'legacy markup' --timeout 30000` from packages/tui: 1 pass, 0 fail, 2 assertions.
R2 therefore preserves the existing completed-row inset and error interaction
instead of adding three box columns. Literal Session expectations use icon
column 4 after the restored root rail. This is a correction to the same original
visual requirement, not an extra renderer or a changed user request. The existing
snapshot artifact is explicitly listed as the paired fixture for the already
planned inline-test update. All other R1 behaviors and verification remain.

Partial implementation at revision change: Shell slice passed 7 rendered title
tests and 16 existing optional-schema profile tests. Message slice had 11 pass,
1 fail across legacy Shell/message cases; Loaded row revealed the incorrect
extra completed-row inset. No card-footer implementation has started. R2 must
receive full-scope approval before any further production/test edits.

### Round 2 Finding And Release Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

### N-02 实施记录仍残留 R1 的占位状态

`docs/plans/tui-legacy-message-chrome.md:449-453` 已准确说明存在暂停的 R1 中间实现，但：

- `:459` 仍写着 “Not implemented”；
- `:463` 仍将仓库 TDD 全部标为 pending；
- `:495` 的实现审计占位行仍指向 R1。

这是记录一致性问题。当前没有 verified 或实现通过的声明，因此不阻断 R2 方案放行；应按已有事实更新实施进度和待审 revision。

上轮 N-01 中缺失的补充需求原文已在 `:39-41` 补齐。本轮没有将计划记载的授权时序当作额外操作授权。

## Rejected speculation

- 不要求 description 必填、补写默认 workdir 元数据或迁移历史数据：现有输入合同足以承载展示恢复。
- 不要求重建旧版折叠状态机：当前 preview memo、正文工厂和调用方展开状态均有真实生命周期约束。
- 不要求为多文件 Patch 新增逐卡片间距算法：旧版最终实现采用 Part 级三态语义。
- 不依据静态 JSX 属性相加，要求额外增加三列缩进。实际文字绘制路径支持 R2 对这一假设的纠正。

## Primary-path and fallback verdict

**PASS。**

## Code quality and Chinese-comment verdict

**方案级 PASS；当前中间实现尚未放行。**

## Release verdict

**APPROVE — 仅适用于 `docs/plans/tui-legacy-message-chrome.md` 的 R2，完整范围方案审计。**

本轮仅进行了只读检查，没有复跑 Bun 命令。计划中的执行次数、计时和通过数量未由本轮独立确认。

当前 R1 中间代码及部分测试仍保留七列缩进预期，卡片 footer 尚未实施；这些待完成内容属于 R2 已明确规定的修正范围。最终实现仍须完成全部验证、实际 E/C 计算和完整独立实现审计，之后才能进入 verified 与 commit。

## 23. Implementation Evidence

### Current R4 Implementation And Verification

R4 implemented under the exact full-scope approval recorded above. The actual
tracked scope is ten TUI files, 319 insertions/237 deletions, plus this new plan.
The four Diagnostics calls, component, parser, exclusive imports, orphaned
`src/util/path.ts` and parser-only unit test are deleted. Write uses existing
`metadata.filepath` or the unchanged V2 operation field for source-card readiness.
The ordinary inline-error fixture retains its interaction tests with a file-read
failure instead of an LSP-server example; its snapshot text is updated.

R4 feedback loop uses the existing real Session source-card case, with V1's real
filepath result instead of the operation-only fixture. Before production changes:

```text
packages/tui:
bun test ./test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern 'legacy card section gaps survive collapse and expand: write$' --timeout 30000
0 pass, 34 filtered, 1 fail; frame contains only '← Write alpha.txt', no source card
```

After direct feature removal and the readiness-operand correction, the identical
case passes: 1 pass, 34 filtered, 0 fail, 3 assertions. It verifies normal Write
preview/body/affordance behavior, not a negative LSP requirement. No LSP fixture,
absence assertion, filtering policy, state machine or backend behavior was added.
The deleted malformed-range test exclusively exercised the deleted parser.

| Command / directory | Final R4 result |
| --- | --- |
| `bun run test` / `packages/tui` | 702 pass, 2 skip, 0 fail; 704 tests, 94 files, 8 snapshots, 3777 assertions; 169.42s |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` / `packages/tui` | 35 pass, 0 fail, 741 assertions; 15.18s |
| `bun test ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx ./test/routes/session --timeout 30000` / `packages/tui` | 170 pass, 0 fail, 8 snapshots, 1065 assertions; 11.62s |
| `bun test ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx --update-snapshots --timeout 30000` / `packages/tui` | 22 pass, 0 fail, 185 assertions; inspected snapshot delta, ordinary error text changed for R4 |
| `bun test "D:/Temp/opencode/tui-legacy-parity-probe.test.ts" --timeout 30000` / `packages/tui` | Original visual feedback loop plus old native markup: 4 pass, 0 fail, 9 assertions; 2.69s |
| `bun typecheck` / `packages/tui` | Pass |
| `bun test ./test/tool/shell-prompt.test.ts --test-name-pattern 'render exposes native script' --timeout 30000` / `packages/opencode` | 16 pass, 12 filtered, 0 fail, 474 assertions; 2.69s |
| `bunx --no-install oxlint --format=unix <8 modified .ts/.tsx files>` / root | Exit 0, 51 warning-level problems; no lint-clean claim |
| `git diff --check` / root | Pass after removing the blank EOF left by parser deletion; snapshot LF/CRLF notice remains |

Independently audited comment gate: **E=248, C=44, C/E=17.74%, minimum C=38**.
E excludes imports, blank/comment-only lines, documentation and snapshot text.
Deleted code/comments do not count. The independent calculation includes the
test adapter object's createContext value binding, which the primary's earlier
247-line count incorrectly treated as an import. Qualified C explains the
visibility, native inset, lifecycle, readiness and real-frame acceptance
constraints rather than an invented LSP prohibition.

| Modified code file | Audited E | Qualified C |
| --- | --- | --- |
| session/index.tsx | 60 | 16 |
| session/layout.ts | 1 | 1 |
| util/layout.ts | 2 | 2 |
| deleted util/path.ts | 0 | 0 |
| real Session test | 162 | 17 |
| inline-wrap test | 19 | 5 |
| reasoning disclosure test | 1 | 1 |
| session width test | 3 | 1 |
| shell-output source-guard replacement | 0 | 1 |

All secondary paths retain their approved classification: optional Shell values
and V1/V2 Write result fields are shipped contracts; running/context views,
opaque Thought, source/diff/preview and generic errors are ordinary primary
branches. Deleting diagnostic presentation is the explicitly requested rollback.
No alternate success path, extra history/backend read or diagnostic surface is
added. The original transparent-group workaround remains removed.

Whole-suite output still contains ConfigRemoteAuthError bootstrap logging and
fixture KV ENOENT logs without failing tests. No persistence/log cleanup, manual
interactive PTY acceptance or new CPU/memory benchmark is claimed. Concurrent
stats changes and other untracked plans remain outside this implementation.
Full independent R4 implementation audit passed after raw-verification
reconsideration, as recorded below. The scoped commit remains pending.

Raw evidence: red `tool_1acc46f780010RtB5NXTYo9Mml`; original loop
`tool_1acc9aa2c001UGH2V2nrzs1bbJ`; full suite
`tool_1accc791700102LQJ6iwXK72rx`; complete tracked scoped diff
`tool_1acc9e5b5001zwzT399dhiDdFy`, all under
`C:/Users/Lenovo/.local/share/opencode/tool-output/`.

R4 implementation-audit verification supplement: the independent reader found
no blocking code findings but withheld its release verdict until typecheck and
optional-schema raw output could be independently read. Primary reran both exact
commands with native stream capture; both returned native exit code 0. Artifacts:
`D:/Temp/opencode/tui-r4-typecheck-native.stderr.txt` (`$ tsgo --noEmit`), its empty
`.stdout.txt`, and `D:/Temp/opencode/tui-r4-shell-schema-native.stderr.txt`
(16 pass, 12 filtered, 0 fail, 474 assertions; 3.18s) with its `.stdout.txt` Bun
version header. Earlier authentic host transcripts at
`D:/Temp/opencode/tui-r4-typecheck-20261106.txt` and
`D:/Temp/opencode/tui-r4-shell-schema-20261106.txt` also record native exit code 0.
No check was delegated to Task and no production/test change was made during
this supplement. Concurrent staging of other work is preserved; final scoped
diff inspection uses `git diff HEAD -- <this task's paths>`, covering index and
worktree rather than only unstaged content.

### Superseded R3 Implementation And Verification

R3 is implemented. The added diagnostic fixtures, row-delta assertions and four
diagnostic-only wrappers have been withdrawn. No negative LSP assertion, new
LSP behavior, parser deletion or Write dispatch change is included. HEAD's
existing diagnostics calls/helper/parser/test remain unchanged. The original
Shell/title/message/card repair and current animation/resource owners remain.

The first R3 full run returned 702 pass/2 skip/1 fail: the newly added multiline
tool frame case saw text before the pre-layout height-dependent margin settled.
Its literal assertion was not relaxed. The test now uses the fixture's existing
`stableHeight` helper before comparing the static legacy frame. The focused case
passed 20 consecutive runs (80 assertions), followed by the complete rerun below.

| Command / directory | Final R3 result |
| --- | --- |
| `bun run test` / `packages/tui` | 703 pass, 2 skip, 0 fail; 8 snapshots, 3778 assertions, 94 files; 174.42s |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` / `packages/tui` | 35 pass, 0 fail, 741 assertions; 13.08s |
| `bun test ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx ./test/routes/session --timeout 30000` / `packages/tui` | 171 pass, 0 fail, 8 snapshots, 1066 assertions; 17.30s |
| `bun test "D:/Temp/opencode/tui-legacy-parity-probe.test.ts" --timeout 30000` / `packages/tui` | Original visual loop plus exact markup calibration: 4 pass, 0 fail, 9 assertions; no LSP probe remains |
| `bun typecheck` / `packages/tui` | Pass |
| `bun test ./test/tool/shell-prompt.test.ts --test-name-pattern 'render exposes native script' --timeout 30000` / `packages/opencode` | 16 pass, 0 fail, 474 assertions |
| `bunx --no-install oxlint --format=unix <8 changed .ts/.tsx files>` / root | Exit 0; 56 warning-level problems, no lint-clean claim |
| `git diff --check` / root | Pass, snapshot LF/CRLF warning only |

Current E/C, using the same actual-diff method described below: production 61/18,
tests 179/25; total **E=240, C=43, C/E=17.92%**, minimum C=36. Per-file E/C:
session/index 58/15; session/layout 1/1; util/layout 2/2; real Session test 162/17;
inline-wrap test 13/5; reasoning test 1/1; width test 3/1; obsolete source-assertion
replacement 0/1. Imports, blanks, pure movement/reindent, docs and generated
snapshot text are excluded. No comment asserting an excluded LSP rule is added.

Whole-suite fixture KV read logs and an isolated temporary-directory KV write
EPERM log still appeared without failing assertions; no persistence cleanup is
claimed. No manual PTY or new CPU/memory profile was performed. The implemented
path adds no backend requests, history reads, fallback, feature flag or parallel
renderer. Full independent R3 implementation audit and commit remain pending.

### Superseded R2 Historical Evidence

R2 historical evidence follows. R3 implementation and fresh verification are
recorded above; no R2 numbers below are a completed R3 claim.

### Actual Files and Diff

Implemented under approved R2. Actual files:

- `packages/tui/src/routes/session/index.tsx`: old message rail/external gap,
  first-visible relation and private tri-state context, old tool gap semantics,
  shared card footer sections/body gaps, Shell intent/workdir/running title.
- `packages/tui/src/routes/session/layout.ts`: existing left-chrome constant 4.
- `packages/tui/src/util/layout.ts`: remove transparent groups and cross-message
  compensation; retain cached pre-layout sibling geometry.
- `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx`: 22 new real
  Session behavior cases, shared literal fixtures/frame crop; original residency
  and resource tests retained.
- `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx` and paired
  `__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap`: existing fixture
  boundary ownership, actual source context provisioning, measured old gaps,
  full-content viewport snapshots and exact sticky-bottom geometry.
- `packages/tui/test/routes/session/reasoning-disclosure.test.tsx`: exclude
  restored chrome when comparing wrapped reasoning content, retain interaction.
- `packages/tui/test/routes/session/session-layout.test.ts`: literal width budget.
- `packages/tui/test/routes/session/shell-output-spacing.test.ts`: remove the
  obsolete first-tool-one-row source assertion; its behavioral replacement is
  the real Session first-visible/multiline tests.
- This canonical plan: requirement, experiment, approval and verification record.

Tracked diff is 9 files, approximately 353 insertions/138 deletions before this
documentation record. No production dependency, schema, executor, persisted data,
backend, request-usage or generated SDK change. Existing unrelated untracked
cross-host and unified-tool plans are left untouched and excluded from commit.

### Red-Green Test Evidence

| Slice | Red | Green |
| --- | --- | --- |
| Original real-renderer probe | 0 pass/3 fail on unchanged production, twice | 4 pass/0 fail/9 assertions, including added native markup calibration |
| Shell titles/running intent | 0 pass/7 fail, absent old titles | 7 pass/0 fail/20 assertions |
| Message identity/visible relation | 0 pass/5 fail, missing rail/first gap | Corrected R2 native-inset expectations first produced 3 fail/2 pass, then all 12 Shell/message cases passed |
| Shared card sections across 6 tools | 6 intended failures, preceding preview row was body text | 9 card/Patch/context cases passed with 27 assertions |
| B-01 visible diagnostics and Write overwrite | Temporarily setting only the four approved body gaps to 0 produced 4 intended failures (`expected 2, received 1`); other 3 card cases passed | Restored 1-row gaps: 7 card cases pass, 34 assertions; overwrite title independently confirms the diff branch |

The rejected optional removal of the pre-existing Dynamic `as any` assertion
failed typecheck (`Part` includes non-rendered members); that attempted cleanup
was fully withdrawn. Existing typing is retained, no type refactor is included,
and final typecheck passes. No visual behavior or requirement changed.

### Verification Commands and Results

| Command (package directory) | Final observed result |
| --- | --- |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000` (`packages/tui`) | Final after B-01: 35 pass, 0 fail, 753 assertions; 13.00s |
| `bun test ./test/cli/tui/inline-tool-wrap-snapshot.test.tsx ./test/routes/session --timeout 30000` (`packages/tui`) | Final rerun 171 pass, 0 fail, 8 snapshots, 1066 assertions; 16.12s |
| `bun run test` (`packages/tui`) | Final after B-01: 703 pass, 2 existing skip, 0 fail, 8 snapshots, 3790 assertions across 94 files; 174.07s |
| `bun typecheck` (`packages/tui`) | Final pass after withdrawing unrelated cast cleanup |
| `bun test ./test/tool/shell-prompt.test.ts --test-name-pattern 'render exposes native script' --timeout 30000` (`packages/opencode`) | 16 pass, 0 fail, 474 assertions; description remains optional |
| `bunx --no-install oxlint <all 8 changed .ts/.tsx paths>` (root) | Exit 0; 0 errors, 56 warnings, not a lint-clean claim |
| `git diff --check` (root) | Pass; snapshot LF/CRLF conversion warning only |

The first related run exposed obsolete snapshot/anchor assumptions, the compiled
review fixture's missing restored context, and reasoning-content comparisons that
included the new rail. The context's actual production definition is now compiled
in that existing fixture; the source anchor prefix is retained; new literal frame
tests independently protect the visual rules. Regenerated snapshots were inspected:
only old measured separator rows/default first-gap changes, no colors, icons,
tool text or theme changes. Taller fixture viewports retain every tool's tail.

The full suite printed fixture KV read ENOENT logs and one temporary-directory
write EEXIST log while returning 0 failed tests. These logs are not suppressed or
claimed fixed. The isolated Session file and final 18-file related run passed
without those logs. KV/persistence production code is outside this repair.

B-01 rework only extends the existing card matrix: new-file Write, overwrite
Write (`exists: true` plus nonempty diff), Edit and Patch receive a visible LSP
error with its actual metadata shape. Literal assertions require one blank row
from final body line to LSP header (row delta 2), adjacent diagnostic detail
(delta 1), and one blank row before the collapse hint (delta 2). The overwrite
title must be `← Write alpha.txt (+30/-1)`. No production algorithm changed.

Sensitivity was verified against the actual renderer by changing only those
four existing `gap={1}` values to 0, observing four exact row-delta failures,
then restoring them. `git hash-object packages/tui/src/routes/session/index.tsx`
was `8e398ab8885ee9abf8dad6a281b13a005deeedd3` both before and after, proving no
mutation remains. Final full suite and typecheck passed after restoration.

### Original Feedback-Loop Result

Original feedback-loop command from section 8 now passes all 4 probes, 0 fail,
9 assertions. The fourth is the R2 exact legacy markup inset calibration. Frames
show a continuous message rail, a borderless row between messages, the literal
`# Inspect files in .` title, and a blank card row before `Click to expand`.

### Actual Secondary and Replacement Path Inventory

One visual primary path; the user-authorized old presentation replaces current
divergent chrome. Existing status, preview/body, context-output, opaque Thought,
optional-input and V1/V2 metadata branches retain their owners. Alternate success
paths added: 0. New diagnostic production surface: 0%. Transparent layoutGroups,
cross-message boundary compensation and duplicate caller-body hints are removed.

### Chinese Comment Calculation

| Metric | Actual | Exclusions/evidence |
| --- | --- | --- |
| Effective changed lines E | 256 | Imports, blanks, matched pure moves/reindent, documentation and generated snapshot text excluded |
| Qualifying Chinese lines C | 45 | Nearby invariant/compatibility/test-intent explanation only |
| C / E | 17.58% | 45/256 |
| Required minimum C | 39 | ceil(256*0.15) |

Method: `git diff --unified=0 -- '*.ts' '*.tsx'`, pair removed/added identical
trimmed lines per file to exclude pure movement/reindent, exclude import-only and
blank lines, then classify substantive additions vs nearby explanatory comments.
Comments were reviewed for actual rationale; no generated or documentation lines
count. Per-file E/C: session/index 66/16, session/layout 1/1, util/layout 2/2,
real Session test 170/18, inline-wrap test 13/5, reasoning test 1/1, width test 3/1,
obsolete static-assertion replacement 0/1. Counts are aggregate, not a per-file rule.

Representative explanations protect tri-state precedence, raw topology vs opaque
visibility, root/frozen-height ownership, before-Yoga sticky separation, footer
vs body lifetime, retained input authority, exact width columns, independent native
inset expectations, and complete snapshot viewport coverage.

### Remaining Unverified Items

Independent implementation audit and the requested commit remain pending. No
manual interactive PTY session or new CPU/memory benchmark was run; actual native
headless Session/geometry/resource tests are the rendering acceptance seam. Existing
full-suite KV fixture logs and lint warnings are reported above without a cleanup
claim. No known failing behavioral assertion remains.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 | None | BLOCK | `ses_e537b4c9cffeinQzCjIzOxI0wW` |
| Interrupted attempt | R2 | No completed verdict | User interrupted | None | user_abort; superseded scope | `ses_e537b4c9cffeinQzCjIzOxI0wW` |
| Interrupted attempt | R3 | No completed verdict | User interrupted | None | user_abort; superseded scope | `ses_e534ed5b8ffeRdmUKwRksPIv8t` |
| 2 (after verification reconsideration) | R4 | yes | No blocking findings | None; raw verification gap closed | APPROVE | `ses_e53308cc3ffelJ1aZr6kiGYHKi` |

### Round 2 Final Finding And Release Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

无新增非阻断代码发现。此前缺少的类型检查与 schema 回归原始证据已核实，验证缺口已闭合。

## Primary-path and fallback verdict

**PASS。**

实现直接恢复旧版消息与卡片展示规则，修复归属现有展示 owner。Shell 消费保存的 input，Write 消费既有成功结果；透明跨消息分组、重复提示和诊断专用路径已移除。

新增 alternate success path：**0**。新增诊断决策面：**0%**。新版动画、错误交互及内容生命周期继续沿原有路径运行。

## Code quality and Chinese-comment verdict

**PASS。**

未新增 `any`、类型抑制、依赖、配置、后端请求或第二套状态。被调整的测试仍观察实际渲染与交互，原始缺陷敏感性有失败输出支持。

实际 diff 的独立计数保持为：

| 范围 | E | 合格 C |
|---|---:|---:|
| 生产代码 | 63 | 19 |
| 测试代码 | 185 | 25 |
| **合计** | **248** | **44** |

**C/E = 17.74%**，通过审计门禁及 15% 实施目标。排除 imports、空行、注释本身、删除行、文档、snapshot 文本及纯移动；新增测试依赖对象中的 `createContext` 值绑定计入 E。

## Release verdict

**APPROVE — 完整范围实现审计通过，仅适用于批准的 R4 和本轮相对 `HEAD 321a3ffedd` 的完整 scoped diff。**

当前 canonical plan blob：`a9ebd2034402bc57c114a5e443486fb5630dccca`。

本结论替代此前因原始验证证据未闭合而暂缓放行的 verdict。Primary 可原样记录本结论，将状态更新为 `verified`，再按 workflow 执行 scoped commit。审批范围为本任务十个 tracked 路径及 canonical plan，不包含并发暂存的统计代码和其他计划。

验收证据采用原生 headless 渲染与既有几何、资源回归；未新增手动 PTY 验收或 CPU/内存基准。本审计未修改文件或执行提交。

Final audit invocation: `ses_e53308cc3ffelJ1aZr6kiGYHKi`; mode implementation;
approved revision R4; full original scope. All approved behavior, original
feedback loop, verification, deletion and comment gates are satisfied. Only the
explicitly requested path-scoped commit remains before the final user report.

### Round 2 Preliminary Release Verdict (Verbatim)

**BLOCK — 验证授权待确认，审计尚未完成最终放行。**

`bun typecheck` 和可选参数 schema 回归目前只有 canonical plan 中的成功记录，本轮未取得可独立核验的原始输出，也尚未获准执行这些非 git shell 命令。

请授权执行：
- `packages/tui`：`bun typecheck`
- `packages/opencode`：`bun test ./test/tool/shell-prompt.test.ts --test-name-pattern 'render exposes native script' --timeout 30000`

本轮未修改文件或提交。当前 plan blob 为 `d6402c81850f2e3f61dd3027e22286d8551ef08a`，实现基于 `HEAD 321a3ffedd`。验证闭合后才能给出最终放行，并由 primary 记录 `verified`、执行 scoped commit。

Reconsideration evidence: primary alone executed the two requested checks and
provided the native outputs referenced in Current R4 Implementation And
Verification. The code, original full scope and approved R4 design are unchanged.

### Round 1 Blocking Finding And Release Verdict (Verbatim)

## Blocking findings

### B-01 正文与诊断之间的旧版间距缺少行为验证，Write 覆写分支也未进入验收用例

- **Violated invariant:** INV-05 要求准确恢复 diff/source 与诊断之间的间距；policy 要求确认的行为具有敏感的行为测试。
- **Evidence class:** contracted
- **Producer and execution path:** Write/Edit 将 LSP 结果写入工具 metadata，Session processor 保留这些字段，TUI 经 `ToolPart → Write/Edit/ApplyPatch → Diagnostics` 渲染诊断。该路径有正常生产者，不是假设输入。
- **Source evidence:**
  - 真实诊断生产者：`packages/opencode/src/tool/write.ts:210-221`、`packages/opencode/src/tool/edit.ts:508-514`。
  - 本次恢复的正文间距：`packages/tui/src/routes/session/index.tsx:3608-3612`、`:3624-3635`、`:4027-4030`、`:4137-4151`。
  - 新增卡片用例在 `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx:321-325` 中，Write 使用空 `diagnostics`，Edit/Patch 没有诊断；断言只检查展开提示前的空行，见 `:330-339`。
  - Write 覆写分支要求 `exists/existed` 和非空 diff，见 `packages/tui/src/routes/session/index.tsx:3572-3574`；当前渲染夹具没有提供这个组合。
- **Canonical-plan evidence:** §10.6 明确恢复 diff/source 与诊断之间的旧版间距；§13 INV-05、§16 第三片要求覆盖相关卡片调用方及诊断间距。
- **Responsibility owner:** 各工具正文容器拥有诊断间距，现有真实 Session 渲染测试拥有验收证据。
- **Concrete behavioral consequence:** 当前测试没有渲染可见诊断，因此无法捕获新增正文 `gap` 被撤掉后，正文与诊断重新贴合的回归；本次修改过的 Write 覆写卡片也没有实际渲染验收。这部分“准确复现旧格式”的要求尚未获得行为证据。
- **Minimal correction direction:** 复用现有 Session 夹具补入可见诊断和 Write 覆写场景，按旧版字面行距断言正文、诊断与提示的位置，并确认测试对原来的错误间距敏感。

## Non-blocking findings

无额外非阻断代码发现。

## Primary-path and fallback verdict

**PASS。**

## Code quality and Chinese-comment verdict

已审代码结构与中文注释门禁通过；行为验证完整性受 B-01 阻断。

## Release verdict

**BLOCK — 适用于 R2 及本轮实际完整 diff。**

先补齐 B-01 的行为验证，再进行完整范围实现复审。通过后才能记录 `verified` 并执行请求的 scoped commit。

# Canonical Implementation Plan: Semiglobal Levenshtein Closest Match

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: implementation
>
> Requirement source: User-provided Session GOAL continuation and current user constraints
>
> Implementation allowed: yes
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this new task. The
historical `docs/plans/edit-apply-patch-match-recovery.md` remains unchanged and
is not an implementation authority for this revision.

## 1. Verbatim Requirement

> 优化当前的代码oldstrings无匹配或者归一化匹配失败之后的模糊匹配算法，将其整体修改为Semiglobal Levenshtein DP方法，同时要考虑到applypatch、edit可能在一次工具调用中修改多个块的行为（只去匹配找不到的那个块）。让其整体鲁棒性更高，同时返回信息保持有效且避免重复，并且能够适当降低模型额外重新读取的需求（也就是相应的信息量需要权衡性价比以及给足模型足够定位与改动信息）

> 禁止添加任何的fallback逻辑，禁止，以及不需要显示增加任何的错误消息显示。不要在无法证明有效时输出相应内容，我要的是准确完整的主逻辑能够完成相应的内容，而不要进行增加任何的退化行为。也就是需要把closest match做精细，让它能够更准地匹配,而不是不能匹配。

> 不改工具schema；不要修改历史存档方案；当前方案必须新建。

目标终态：`<verified-implementation-and-commit>`。

## 2. Explicit Non-Goals

- Do not modify or delete the historical R9 plan.
- Do not change the public `apply_patch` or `edit` Tool parameter schemas.
- Do not add a fuzzy replacement-success path after exact or existing closed-normalization matching fails.
- Do not add a fallback chain, retry chain, Bitap threshold escalation, location-biased second matcher, or catch-and-success behavior.
- Do not add a new user-facing error category or error message. Existing Tool wording remains the rendering contract.
- Do not change exact Patch chunk application, cursor advancement, EOF handling, BOM, line-ending, atomicity, permission, LSP, formatting, event, move, or verified-parse behavior.
- Do not change existing Edit replacement semantics, normalization ownership, overlap rejection, `replaceAll`, or reverse application.
- Do not add a database dependency, telemetry, configuration, migration, SDK artifact, generated file, or production dependency.
- Do not emit the expected old block a second time in the diagnostic result.
- Do not choose one candidate when the primary matcher has distinct equally-best candidates that cannot be ordered by the contract.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Tool, Project, Message, Patch-related module boundaries, and the `packages/opencode` ownership map. |
| Root `AGENTS.md` | Requires package-local test/typecheck commands, parallel investigation, and no unrequested SDK generation. |
| `packages/opencode/AGENTS.md` | Requires existing module conventions, inferred TypeScript types, and package-local verification. |
| `packages/opencode/test/AGENTS.md` | Requires real Effect Tool seams, independent expected values, and no implementation-coupled tests. |
| `docs/adr/README.md` and ADR-0001 | No accepted ADR governs text matching; ADR-0001 is unrelated triage policy. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, one primary semantic path, no fallback, traceability, and the Chinese-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines the canonical plan fields and audit/implementation state transitions. |
| Historical `docs/plans/edit-apply-patch-match-recovery.md` | Read-only historical context; it must remain byte-identical and is not modified or extended. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | Shared exact locator, current `closestWindow`, bigram scorer, renderer, and current reliability gate. | observed |
| `packages/opencode/src/patch/index.ts` | Patch owner calls `closestWindow` from the failed chunk path with persisted file text and the complete failed expected block. | observed |
| `packages/opencode/src/tool/edit-apply.ts` | `applyEdits` processes multiple edits, knows the failing `editIndex`, and currently exposes only a formatted error message. | observed |
| `packages/opencode/src/tool/edit.ts` | Edit failure path selects a diagnostic probe and currently falls back to the first edit when normalized matching is active. | observed |
| `packages/opencode/src/tool/apply_patch.ts` | Groups Patch operations, preserves per-file aggregation, and consumes owner errors without owning text matching. | observed |
| `packages/opencode/test/tool/edit.test.ts` | Real Edit Tool diagnostics, ties, long decoys, normalized matching, and multi-edit behavior. | observed |
| `packages/opencode/test/tool/apply_patch.test.ts` | Real ApplyPatchTool diagnostics, failed chunks, partial file success, and duplicate-output assertions. | observed |
| `packages/opencode/test/patch/patch.test.ts` | Exported Patch owner and multi-chunk behavior seam. | observed |
| `packages/opencode/package.json` | Confirms existing `diff` dependency and no need for a new matching dependency. | observed |
| Current direct replay: `bun -e` importing `closestWindow` | Expected `target sequence ... gamxa` is present after a decoy, but current scorer selects line 1 `...deltta`. | observed |
| Current direct replay: `bun -e` importing `applyEdits` and `closestWindow` | In normalized multi-edit failure, current probe selection chooses the first normalized edit while `edits[1]` is missing. | observed |
| `bun test test/tool/edit.test.ts -t "closest match rejects an unrelated long-line decoy|closest match shows actual candidate for a single-char mismatch|suppresses tied closest candidates"` from `packages/opencode` | Existing diagnostic tests pass but do not cover the semiglobal failure shape or normalized multi-edit probe attribution. | observed |
| `bun test test/tool/apply_patch.test.ts -t "reports the reliable candidate for the chunk that actually failed|suppresses unrelated candidates when context mismatches"` from `packages/opencode` | Existing Patch diagnostics pass but do not prove global edit-distance ranking. | observed |
| Myers, `A Fast Bit-Vector Algorithm for Approximate String Matching Based on Dynamic Programming` | Establishes approximate substring matching and the semiglobal DP boundary `D[0][j] = 0`; it supports the selected primary algorithm. | contracted external evidence |
| GNU `patch` inexact matching documentation | Shows fuzz-factor matching is context/location-oriented and is not the requested global closest-text objective. | contracted external evidence |
| Google `diff-match-patch` API and JavaScript source | Shows `match_main` combines accuracy with location and has pattern/threshold policy unlike the requested global minimum. | contracted external evidence |

External references:

- Myers: https://dl.acm.org/doi/10.1145/316542.316550
- GNU patch inexact matching: https://www.gnu.org/software/diffutils/manual/html_node/Inexact.html
- diff-match-patch API: https://github.com/google/diff-match-patch/wiki/API
- diff-match-patch JavaScript source: https://raw.githubusercontent.com/google/diff-match-patch/refs/heads/master/javascript/diff_match_patch_uncompressed.js

## 5. Current Behavior

```text
Patch Tool input
  -> parse Patch chunks
  -> Patch owner applies exact chunk semantics on current working text
  -> first unresolved chunk calls withCandidate(message, persistedText, expected)
  -> closestWindow scans every same-line-count window with trimmed bigram Dice score
  -> owner error is aggregated by ApplyPatchTool
```

```text
Edit Tool input with edits[]
  -> applyEdits validates all edits on one pre-edit base or normalized base
  -> a missing edit throws a message containing edits[i]
  -> EditTool catch selects the first edit whose raw oldString is absent
     from baseLF, then falls back to edits[0]
  -> closestWindow scans the selected oldString against raw content
```

The shared diagnostic currently has three independent ranking defects:

- It fixes candidate height to `expectedLines.length`, so inserted/deleted lines cannot be represented by the candidate span.
- It scores a concatenated bigram multiset, which rewards character inventory and penalizes a correct candidate merely for having surrounding context.
- It does not compute a minimum edit distance, so a distant same-height line can outrank the true candidate with a small ordered typo.

The multi-edit defect is separate from the scorer: `applyEdits` knows the failed
index, but `EditTool` reconstructs that identity from raw `indexOf` checks after
the whole batch may have entered normalized space. This makes the diagnostic
probe incorrect while leaving the replacement failure itself correct.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Non-empty failed Patch old block or `change_context` | Model-generated Patch text | Parser produces ordered logical lines and exact context fields | `Patch.deriveNewContentsFromChunks` -> `withCandidate` -> `closestWindow` | `patch/match.ts` diagnostic owner | observed |
| Failed Edit `oldString` | Model-generated Edit input | `applyEdits` validates non-empty strings before matching | `EditTool.execute` catch -> `closestWindow` | `edit-apply.ts` failure identity plus `match.ts` scorer | observed |
| Multi-chunk Patch update | Model-generated multiple `@@` chunks | Chunk order and current cursor are already owned by Patch | `applyChunks` first unresolved chunk -> owner error | Patch owner | observed/reachable |
| Multi-edit Edit call | Model-generated `edits[]` | All ranges resolve against one pre-edit/normalized base | `applyEdits` loop throws at a known edit index | Edit replacement owner | observed |
| Candidate with prefix/suffix context | Existing file text | Diagnostic does not mutate the file | Shared full-text scan | Shared matcher | observed |
| Candidate with line insertion/deletion | Existing file text | No fixed candidate-height guarantee exists in diagnostic contract | Shared semiglobal substring scan | Shared matcher | reachable |
| CRLF/CR/BOM input | Existing files and Tool normalization | Existing callers normalize for matching and restore output endings | Both Tool failure paths | Existing line-ending/BOM owners; matcher receives text | contracted |
| Repeated equally-best candidate | Existing source/Markdown text | No contract authorizes choosing one occurrence | Shared matcher tie result | Shared matcher | reachable |
| Unrelated low-similarity file | Any failed Tool input | A failed input does not guarantee a meaningful candidate | Shared matcher reliability gate | Shared matcher | observed |
| Binary data, AST semantics, remote writes, hostile plugins | No producer in this call path | No relevant public contract or threat model | None established | Not applicable | speculative; excluded |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | The diagnostic candidate is selected by the minimum Semiglobal Levenshtein edit distance between the complete expected text and a continuous substring of the supplied file text. | User GOAL explicitly requires Semiglobal Levenshtein; Myers/Sellers formulation. | No |
| INV-02 | Insertions, deletions, replacements, prefix/suffix context, and multiline length differences participate in one ordered primary distance calculation. | Reachable candidate shapes and current fixed-height failure. | No |
| INV-03 | Patch diagnostics explain the first unresolved Patch chunk already identified by the Patch owner; they never rescan a different chunk. | Current `withCandidate` receives the failing `expected`; multi-chunk tests. | Partial |
| INV-04 | Edit diagnostics explain the exact missing `edits[i]` known by `applyEdits`, including when the batch uses normalized matching. | Current owner loop has `i`; direct replay proves current probe drift. | No |
| INV-05 | The diagnostic result never performs replacement success, never changes file content, and never acts as a fallback matcher. | Current callers use `closestWindow` only after failure. | Partial |
| INV-06 | The existing user-facing error header, no-duplicate expected-text rule, candidate-centered excerpt budget, and low-confidence/tie behavior remain valid. Reliability is `1 - distance / max(expectedCodePointLength, candidateCodePointLength)`, bounded to `[0,1]`; scores below `0.5` are suppressed, and distinct equal-distance spans are suppressed. | Existing Tool tests, user constraint, and R2 formula definition. | Partial |
| INV-07 | `apply_patch` and `edit` keep their public Tool schemas and successful exact/normalized replacement contracts unchanged. | Tool parameters and current owner tests. | Yes |
| INV-08 | Multi-block failure does not cause an unrelated successful block to be used as the diagnostic expected text, and failed files remain unmodified. | Patch/Edit atomicity and multi-block behavior. | Partial |
| INV-09 | The shared matcher has one authoritative semantic implementation; no parallel scorer remains in Patch or Edit. | Shared import in current code and duplicated historical scorer risk. | No |
| INV-10 | Every rolling DP state preserves the minimum distance, one representative candidate span, and whether another distinct span has the same minimum cost; global ties are suppressed independent of transition order. | R2 audit B-02 and reachable equal-distance candidates. | No |
| INV-11 | A variable-length candidate is rendered from the exact raw span returned by the same DP; the renderer never indexes an absent expected line and never runs a second candidate search. | R2 audit B-01 and current `formatClosestDifference` line-count assumption. | No |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/06/09 | `closestWindow` converts each same-height window into a trimmed bigram multiset and ranks Dice overlap instead of calculating ordered minimum edit distance over continuous substrings. | `packages/opencode/src/patch/match.ts` | Current `similarity()` lines 98-110 and `closestWindow()` lines 180-205; direct replay selects the `deltta` line over the `gamxa` candidate. |
| INV-04/08 | `EditTool` reconstructs the failed edit with raw `baseLF.indexOf()` after `applyEdits` has already selected normalized matching, so the first normalized edit can be selected instead of the failing index. | `packages/opencode/src/tool/edit-apply.ts` and `packages/opencode/src/tool/edit.ts` | Direct replay with smart quotes selects `"hello"` while `edits[1].oldString = "world"` is the thrown failure. |

### Red-Capable Feedback Loops

Current scorer replay, run from `packages/opencode`:

```bash
bun -e 'import { closestWindow } from "./src/patch/match.ts"; const content="target sequence alpha beta deltta\nprefix target sequence alpha beta gamxa suffix"; const expected="target sequence alpha beta gamma"; console.log(JSON.stringify(closestWindow(content, expected)))'
```

Observed:

```json
{"line":1,"excerpt":"line 1 actual: \"target sequence alpha beta deltta\"\ndifference: requested columns 28-32 differ from actual columns 28-32","score":0.8253968253968254}
```

The true near candidate is on line 2 with one middle-character typo and surrounding
context. The line 1 decoy has a larger ordered edit distance, but the current
bigram scorer still selects it. This is red for INV-01/02.

Current normalized multi-edit owner feedback loop, run from `packages/opencode`:

```bash
bun -e 'import { applyEdits } from "./src/tool/edit-apply.ts"; const content="say “hello”"; const edits=[{oldString:"\"hello\"",newString:"\"hi\""},{oldString:"world",newString:"mars"}]; try { applyEdits(content,edits,"multi.txt") } catch (error) { const index=typeof error === "object" && error !== null && "editIndex" in error && typeof error.editIndex === "number" ? error.editIndex : -1; const selectedProbe=index >= 0 ? edits[index]?.oldString : undefined; console.log(JSON.stringify({error:String(error),failedEditIndex:index,selectedProbe})); if (selectedProbe !== "world") process.exit(1) }'
```

Observed:

```json
{"failedEditIndex":-1,"selectedProbe":null}
```

The thrown error is for `edits[1]`; the owner-metadata probe is absent in the
current implementation, so this command exits red. After the approved owner
metadata change it must report `failedEditIndex:1` and `selectedProbe:"world"`.
This is red for INV-04/08 and is the feedback loop that the implementation must
turn green.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Global closest-candidate calculation | `packages/opencode/src/patch/match.ts` | Pure text matching result used by both Tool failure paths | It is the existing shared matcher and owns candidate boundaries, score, tie, and excerpt data | Tool wrappers must not implement competing scorers |
| Failed Edit index propagation | `packages/opencode/src/tool/edit-apply.ts` | Failure retains the owner-known edit index without changing message text | The loop that detects the failure owns the index | `edit.ts` cannot reconstruct normalized coordinates reliably |
| Edit diagnostic probe selection | `packages/opencode/src/tool/edit.ts` | Uses the failed edit only for diagnostic rendering | It owns the public Tool catch and existing error composition | It must not guess from raw content or re-run matching |
| Patch diagnostic invocation | `packages/opencode/src/patch/index.ts` | Passes the complete failed expected block to the shared matcher | Patch owner knows the first unresolved chunk and persisted input | `apply_patch.ts` only aggregates files and cannot recover chunk identity |
| ApplyPatchTool aggregation | `packages/opencode/src/tool/apply_patch.ts` | Preserves existing per-file output/error behavior | It owns Tool result composition, not text ranking | Shared matcher already owns the diagnostic semantics |
| Behavior verification | Exported Patch owner plus real `ApplyPatchTool.execute` and `EditTool.execute` | Tests observe replacement and failure output | These are the confirmed public seams | Private DP helpers would couple tests to implementation |

## 10. Single Approved Primary-Path Design

The single primary diagnostic path is:

```text
failed Patch chunk or failed Edit index
  -> retain the exact failed expected text
  -> shared Semiglobal Levenshtein DP over supplied persisted/base text
  -> select the global minimum continuous candidate
  -> apply existing tie/reliability gate
  -> render the existing error header with actual candidate evidence
```

The diagnostic path never returns replacement success. It runs only after the
existing Patch/Edit primary replacement path has failed.

The matcher will normalize only line endings for its comparison coordinate
space, iterate Unicode code points consistently, and retain raw source text for
the excerpt. For pattern length `m` and text length `n`, it will use:

```text
D[0][j] = 0 for every j
D[i][0] = i
D[i][j] = min(
  D[i-1][j-1] + substitutionCost,
  D[i-1][j] + 1,
  D[i][j-1] + 1
)
```

`D[m][j]` is the distance from the complete expected text to the best
continuous substring ending at `j`. Each rolling state carries:

```text
{ distance, candidateSpan: { start, end } | undefined, hasDistinctEqualSpan }
```

The `D[0][j] = 0` prefix-skip states have no active candidate span. A pair or
internal insertion that first consumes text creates `{ start, end }`; later
deletions preserve that span, and later text-consuming transitions extend its
end. For equal-cost transitions, the state marks `hasDistinctEqualSpan` when
the candidate `(start, end)` differs from the representative. Equal DP paths
that produce the same span do not create a tie. The final row scans every
endpoint, deduplicates identical spans, and suppresses output when any minimum
state has a distinct equal span. This makes tie behavior independent of
transition order without storing an unbounded traceback set or choosing a
secondary location.

The matcher therefore returns the actual start line and raw candidate span
without a second ranking algorithm.

Selection order has one primary criterion: minimum edit distance. If more than
one distinct candidate span (`start`, `end`) has that minimum distance, the
existing no-false-precision tie gate suppresses output rather than choosing by
span length or file order. A second DP alignment for the same candidate span is
not a distinct candidate. No unproven secondary location preference is allowed.

The reliability score is defined once and used only as the existing diagnostic
gate:

```text
score = 1 - distance / max(expectedCodePointLength, candidateCodePointLength)
```

Both lengths are positive code-point lengths, `distance` is the selected
semiglobal Levenshtein distance, and the resulting score is in `[0,1]`. Scores
below `0.5` are suppressed. There is no threshold escalation or alternate
algorithm.

The comparison representation will retain a raw UTF-16 boundary map for every
normalized code point. A normal code point maps to its original UTF-16 start and
end; CRLF maps to one normalized `\n` whose raw span covers both source code
units; CR maps to its single raw code unit. The selected DP `(start, end)` is
converted through this map before slicing the raw excerpt. No second substring
search is permitted for coordinate recovery.

The matcher returns the raw candidate span and candidate start line. When the
candidate and expected have different logical line counts,
`formatClosestDifference` does not index corresponding lines; it renders the
same raw candidate span returned by the DP. The
existing header remains `Closest match at line ...`; the excerpt renderer keeps
the 500-character explicit omission budget and never copies the expected block
a second time. Equal-line-count candidates keep the existing column-difference
renderer. Variable-line-count candidates use the raw candidate span directly,
with explicit truncation when needed; this is a rendering branch over the DP
result, not a second matcher or a fallback. No new error text is introduced.

`applyEdits` will throw one internal `EditApplyError` carrying `editIndex` for
per-edit not-found/ambiguity failures while preserving the exact current Error
message. `EditTool` will use that metadata to select the one failed oldString
and will not call `indexOf` to guess. Patch already constructs its candidate from
the failed chunk; its aggregation path remains unchanged.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Existing Patch exact/current-text application | current | primary-contract branch | yes | existing | preserve |
| Existing Edit exact/closed-normalization application | current | primary-contract branch | yes | existing | preserve |
| Shared Semiglobal Levenshtein candidate calculation | proposed | diagnostic | no | 1 primary diagnostic algorithm | add as the sole matcher |
| Existing same-height bigram scorer | current | superseded diagnostic workaround | no | existing | remove |
| Edit raw `baseLF.indexOf` probe heuristic | current | superseded diagnostic workaround | no | existing | remove |
| Existing low-confidence/tie suppression with the R2 formula | current | diagnostic contract | no | existing | preserve without escalation |
| Fuzzy replacement based on DP similarity | proposed nowhere | forbidden fallback | yes | zero | reject |
| Bitap/DMP/GNU-fuzz retry after DP uncertainty | proposed nowhere | forbidden fallback | yes/no | zero | reject |

The primary diagnostic path has no alternate success path. The existing
replacement owners remain the only success paths.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `bigrams()` and `similarity()` Dice scorer | Attempted to rank nearby text cheaply | It does not optimize ordered edit distance and misranks contextual typos | Collapse in `packages/opencode/src/patch/match.ts` |
| Fixed same-height scan in `closestWindow()` | Assumed expected line count identifies the candidate span | Semiglobal DP must compare all continuous substrings and recover actual boundaries | Replace in `packages/opencode/src/patch/match.ts` |
| `EditTool` raw `baseLF.indexOf` probe selection | Attempted to reconstruct failed multi-edit identity | The owner already knows `editIndex`; reconstruction is wrong in normalized space | Remove in `packages/opencode/src/tool/edit.ts` |
| Missing internal failed-index carrier | Error text was the only propagated state | A non-user-facing owner field preserves identity without schema/message changes | Add in `packages/opencode/src/tool/edit-apply.ts` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 global nearest continuous candidate | Shared DP matcher | `src/patch/match.ts` | Edit and Patch real Tool typo/context fixtures |
| INV-02 insertion/deletion/order robustness | Semiglobal boundaries and candidate origin | `src/patch/match.ts` | Multiline candidate with inserted/deleted line and reordered decoy |
| INV-03 failed Patch block only | Existing Patch owner expected argument | No Patch Tool schema change; preserve `src/patch/index.ts` path | Multi-chunk Patch failure identifies the unresolved block |
| INV-04 failed Edit block only | Owner error carries `editIndex` | `src/tool/edit-apply.ts`, `src/tool/edit.ts` | Normalized multi-edit where first edit matches and second fails |
| INV-05 diagnostic-only behavior | `closestWindow` remains called after failure | `src/patch/match.ts` and existing callers | Failed files remain unchanged; exact/normalized successes stay green |
| INV-06 useful non-duplicated output | Existing renderer with raw candidate span | `src/patch/match.ts` | Long candidate, tie, low-confidence, and expected-text count assertions |
| INV-07 public contracts unchanged | Existing owners and Tool parameters | No schema/config changes | Focused Patch/Edit success suites |
| INV-08 multi-block atomicity and attribution | Existing `applyEdits`/Patch grouping plus metadata | `src/tool/edit-apply.ts` only for identity | Real Tool multi-block tests |
| INV-09 one matcher | Shared import path | Remove old scorer in `src/patch/match.ts` | Search plus both Tool diagnostics |
| INV-10 complete tie enumeration | DP state equivalence flag and final-span deduplication | `src/patch/match.ts` | Equal-distance candidates with different starts/ends remain suppressed |
| INV-11 variable-span rendering | Same DP raw span plus line-count-aware renderer | `src/patch/match.ts` | Inserted/deleted-line candidate renders actual content without runtime error or expected duplication |

No confirmed requirement is unmapped.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Semiglobal DP rows and candidate origin | INV-01/02 | Direct current misranking and established algorithm definition | Bigram fixed windows do not represent minimum edit distance or variable spans |
| Raw candidate span and start line | INV-02/06 | User requires complete useful location evidence; current line-only windows are fixed | Existing scorer has no start/end for a variable best substring |
| Internal `EditApplyError.editIndex` | INV-04/08 | `applyEdits` loop has the exact failing `i`; direct normalized replay loses it in Tool catch | Raw `baseLF.indexOf` cannot identify normalized-space failures |
| Sole shared matcher | INV-01/05/09 | Patch and Edit already import `closestWindow` | Parallel Tool scorers would drift again |
| Exact normalized reliability formula and equal-distance span gate | INV-05/06 | Existing tests reject ties and unrelated candidates; R2 defines the score and removes length preference | Choosing a low-confidence or equal-distance candidate would create false precision |
| DP equal-span equivalence state | INV-10 | R2 audit requires every distinct equal minimum span to reach the tie gate | One representative origin alone cannot prove all distinct spans were seen |
| Variable-span raw renderer | INV-11 | R2 audit proves current per-index renderer is undefined for inserted/deleted lines | Existing renderer assumes equal expected/candidate line counts |
| Normalized-code-point to raw UTF-16 boundary map | INV-02/06/07/11 | R3 audit identifies CRLF and astral offsets as reachable raw-evidence risks | Directly slicing a normalized/code-point index can corrupt or mislabel the raw excerpt |

No other production concept is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | modify | Replace fixed-height bigram ranking with one semiglobal DP matcher; preserve result interface, line label, tie/reliability gate, raw UTF-16 coordinate mapping, and non-duplicating excerpt behavior | +75 to +120 / -50 to -80 |
| `packages/opencode/src/tool/edit-apply.ts` | modify | Preserve the failing `editIndex` in internal error state while retaining current error messages and replacement behavior | +8 to +20 |
| `packages/opencode/src/tool/edit.ts` | modify | Use owner-provided failed index instead of raw probe reconstruction; keep existing Tool output and schema | -5 to +8 |
| `packages/opencode/src/patch/index.ts` | preserve | Continue passing the actual failed Patch expected block; no new matcher or error wording | 0 |
| `packages/opencode/src/tool/apply_patch.ts` | preserve | Continue aggregating owner errors; no duplicate scoring or schema change | 0 |
| `packages/opencode/test/tool/edit.test.ts` | modify | Add real Tool tests for DP ranking, variable candidate span, equal-distance tie enumeration, formula boundaries, and normalized multi-edit failed index | +90 to +150 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | Add real Tool tests for shared DP ranking and failed-chunk-only output | +35 to +70 |
| `packages/opencode/test/patch/patch.test.ts` | modify if owner boundary needs characterization | Confirm Patch owner supplies the failed complete block without changing replacement semantics | +10 to +35 |
| `docs/plans/semiglobal-levenshtein-closest-match.md` | add | This new canonical plan only | plan-only |

The historical R9 plan is intentionally not in the change list.

## 16. TDD Behavior Slices

Agreed seams are the exported Patch owner plus real `ApplyPatchTool.execute`
and `EditTool.execute`. The pure matcher is exercised through these consumers;
the direct red replay remains a diagnosis probe, not the sole regression test.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Edit reports the line containing `prefix target sequence alpha beta gamxa suffix` when a farther line ends in `deltta`. | Bigram Dice penalizes the true line's context and ignores edit-order cost. | Semiglobal DP selects the minimum ordered edit candidate. | Original wrong-closest symptom. |
| 2 | Patch reports the same true candidate through the real Tool failure path. | Patch shares the same scorer and fixed-height window. | Shared matcher result is consumed without Tool-side rescoring. | Shared-consumer parity. |
| 3 | A multiline oldString finds a candidate with one inserted or deleted line and reports its actual start line/content without throwing. | Fixed-height windows cannot represent the best continuous span and the current renderer assumes equal line counts. | DP span plus line-count-aware raw renderer uses the actual candidate. | Variable-length candidate correctness. |
| 4 | Two distinct candidates with the same minimum distance still produce the existing no-reliable-candidate behavior, including equal endpoints with different origins. | A single origin chosen by transition order cannot prove uniqueness. | Carry equal-span state and suppress all distinct minimum spans. | No unsupported location claim. |
| 5 | Candidate scores at the formula boundary are deterministic: `expected="abcd"`, candidate `"ab"` gives `0.5` and is accepted; candidate `"a"` gives `0.25` and is suppressed. | The old `0.5` gate needs one defined DP scale. | Use `1 - d / max(m,n)` once, without retry. | Reliability contract. |
| 6 | A low-similarity file keeps the existing no-reliable-candidate behavior. | A global minimum exists mathematically but is not useful evidence below the existing reliability contract. | Apply the defined gate once; do not add a retry/fallback. | No degraded diagnostic behavior. |
| 7 | In normalized multi-edit failure, the message describes only `edits[1]`, the actual missing edit. | `edit.ts` currently selects the first raw-absent oldString and can choose `edits[0]`. | Propagate internal failed index from `applyEdits` and render only that oldString. | Multi-edit attribution and no duplicate expected text. |
| 8 | A file containing `😀 prefix\r\nactual content\r\n` and failed expected `actual contxnt` reports line 2 and raw excerpt `actual content`, through Edit or Patch. | Code-point indexes and UTF-16 offsets differ, and CRLF normalization removes one comparison unit. | Use the DP-owned raw boundary map and assert the actual Tool error evidence. | Raw-coordinate validity. |
| 9 | Existing exact, normalized, `replaceAll`, overlap, Patch multi-chunk, and atomicity tests remain green. | Matcher/metadata changes could accidentally enter replacement success. | Keep diagnostic-only boundary and existing owner behavior. | Adjacent contract preservation. |

Each slice must run red before its minimal implementation and green afterward.
Expected values are hand-written literals; tests must not reimplement DP.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed production lines `E` | 110 | Counts substantive matcher, failed-index, and rendering changes; excludes imports, formatting, tests, and plan text. |
| Required qualifying Chinese comments `C` | 17 | `ceil(110 * 0.15) = 17`. |

Qualifying comments must explain only non-obvious constraints:

- Why `D[0][j] = 0` means global text-prefix skipping while preserving a continuous candidate.
- Why rolling-row candidate origins must remain in the same code-point/offset coordinate space.
- Why the minimum-distance tie gate cannot choose by file order.
- Why raw candidate text is retained while only line endings are normalized for scoring.
- Why failed Edit index metadata is internal and leaves the existing error message unchanged.
- Why the matcher remains diagnostic-only and cannot enter replacement success.
- Why equal-cost DP paths with one span are equivalent while a different span must
  set the tie state.
- Why variable-length candidates bypass only the equal-line-count column renderer
  and display the same DP-returned raw span without choosing another candidate.
- Why CRLF and astral code points use a raw UTF-16 boundary map rather than a
  second search or direct code-point index slicing.

The implementation audit must recount actual `E` and `C`; comments that restate
loops, assignments, identifiers, or test names do not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts -t "closest|multi-edit"` | `packages/opencode` | Real Edit Tool DP ranking, tie/low-confidence, and failed-edit attribution. |
| `bun test test/tool/apply_patch.test.ts -t "candidate|chunk|multi-file"` | `packages/opencode` | Real ApplyPatchTool shared matcher and failed-chunk behavior. |
| `bun test test/patch/patch.test.ts` | `packages/opencode` | Patch owner replacement/cursor/atomicity compatibility. |
| `bun test test/patch/patch.test.ts test/tool/apply_patch.test.ts test/tool/edit.test.ts` | `packages/opencode` | Complete focused matching regression suite. |
| `bun typecheck` | `packages/opencode` | Type safety through Patch, Edit, and all `applyEdits` consumers. |
| `bun test` | `packages/opencode` | Package-wide regression evidence. |
| The two red-capable `bun -e` replays from Section 8 | `packages/opencode` | Original wrong-candidate and wrong-failed-edit probes turn green. |
| `git diff --check` | repository root | No whitespace errors. |
| `git status --short` and `git diff --name-only` | repository root | Only approved implementation paths plus pre-existing unrelated work remain. |
| Independent plan audit and independent implementation audit | repository root | Full-scope release gates required before verified state. |
| `git diff -- <audited paths> | shasum -a 256` and staged equivalent | repository root | Audited implementation bytes equal staged commit input. |
| `git show --format=fuller --stat --oneline HEAD` and `git status --short` | repository root | Final commit identity, path boundary, hooks, and clean task state. |

No database, SDK generation, migration, or build command is applicable to this
text-matching-only change.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | This canonical plan only; no production module is added. |
| Files modified | 6 | Existing matcher, Edit owner/wrapper, and three behavior-test files. |
| Files deleted | 0 | Superseded scorer is removed inside the existing matcher. |
| Production lines | +70 to +130 / -45 to -85 | One DP path replaces one scorer; failed-index metadata is small. |
| Test lines | +115 to +225 | Real Patch/Edit regression slices and multi-block attribution. |
| Generated lines | 0 | No generated artifacts. |

The budget is an audit signal, not permission to omit a mapped invariant. A new
dependency, Tool parameter, fallback, or unrelated file requires a new plan
revision and full re-audit.

## 20. Real Risks and Open Decisions

### Confirmed Risks

- Semiglobal DP is `O(expectedLength * contentLength)`; verification must measure
  the actual diagnostic path before making a performance claim.
- Unicode code-point iteration and raw JavaScript string offsets differ; the
  matcher must preserve an explicit mapping before rendering excerpts.
- Variable candidate spans can contain a different number of lines from the
  expected block; the renderer must display actual candidate evidence without
  copying the expected text or adding new messages.
- Equal minimum edit distances are common in repeated source/Markdown text; the
  existing no-false-precision tie behavior must remain deterministic.
- `applyEdits` has consumers beyond `EditTool`; internal failure metadata must
  preserve their existing message and success behavior.

### Open Decisions Requiring the User

None. The active GOAL fixes Semiglobal Levenshtein as the algorithm, forbids
fallbacks, forbids Tool schema changes, and requires the new plan path.

### Rejected Speculation

- `diff-match-patch.match_main` is rejected as the primary matcher because its
  objective combines accuracy with a supplied location and its JavaScript
  implementation has a short-pattern policy.
- GNU/Git fuzz matching is rejected because it searches around hunk locations
  and weakens context; it does not compute the global nearest candidate.
- Ukkonen banding is rejected as the sole algorithm because a fixed maximum
  distance would require threshold retries to guarantee a best candidate.
- Myers bit-parallel is recorded as a possible later same-semantics optimization,
  not a second path in this revision.
- AST, semantic, binary, hostile-plugin, remote-write, database, and telemetry
  changes have no reachable producer or owner evidence here.

## 21. Audit Contract

The independent auditor must:

- Read this exact new plan and the verbatim requirement.
- Confirm the historical R9 plan remains untouched and is not treated as the
  current implementation contract.
- Reconstruct Patch and Edit producer-to-consumer paths from current repository
  evidence rather than trusting this plan's claims.
- Verify that Semiglobal Levenshtein is one primary diagnostic path, not a
  fallback after another fuzzy matcher.
- Verify that fuzzy diagnostics never produce replacement success.
- Verify failed Patch/Edit block attribution, no duplicate expected text, Tool
  schema stability, and existing success/atomicity behavior.
- Check TDD seams, real red-green evidence, verification commands, ownership,
  diff bounds, and the 15 percent Chinese explanatory-comment gate.
- Require evidence for every blocking finding and audit the complete original
  scope on every revision.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02 | metadata audit mode; comment estimate | BLOCK | `ses_07a1b0f2affeHpK1kNYlK1wFBk` |
| 2 | R2 | yes | B-01, B-02 | comment estimate; no implementation evidence | BLOCK | `ses_07a158f75ffeP2WMxoyb6IJg6l` |
| 3 | R3 | yes | B-01, B-02 | comment estimate; optional file-count estimate | BLOCK | `ses_07a1068c2ffe1FS7ryRPTy4VrO` |
| 4 | R4 | yes | none | file-count estimate; implementation evidence pending | APPROVE | `ses_07a09c583ffemwOLrLGFuu7dCY` |
| 5 | R5 | yes | none | estimate scope; implementation evidence pending | APPROVE | `ses_07a022e3effeQAK9r4fT7ktB21` |
| 6 | R6 | yes | none | estimate scope; TDD characterization wording; implementation evidence pending | APPROVE | `ses_079f8d159ffeCdAaQN7wXGee8b` |
| 7 | R7 | yes | none | estimate scope; TDD wording; implementation evidence pending | APPROVE | `ses_079e91c5effe04VY0IUq7mk1N5` |

### R7 Independent Verdict (verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- `docs/plans/semiglobal-levenshtein-closest-match.md:393-394` 的 `E=110` 仍只估算生产代码，政策要求实现审计把生产、测试和配置中的实质变更全部计入 `E`。计划已在 `§17`、`§23` 承诺依据实际 diff 重新计算，并执行 `C >= max(1, ceil(E × 0.15))`，没有降低硬门槛。
- `docs/plans/semiglobal-levenshtein-closest-match.md:386` 要求每个 TDD slice 都先红；其中低置信度、普通 tie 以及现有成功语义保持测试可能在基线实现上已经通过。Slices 1、2、3、7、8 和 `§8` 的反馈循环足以对原始缺陷形成敏感的 red-green 证据，因此属于 TDD 记录措辞过宽。
- 当前 worktree 已包含 `packages/opencode/src/patch/match.ts`、`packages/opencode/src/tool/edit-apply.ts`、`packages/opencode/src/tool/edit.ts` 及相关测试的部分实现。它们不属于本次 plan verdict 的批准证据；后续 implementation audit 必须覆盖完整实际 diff、red-green 顺序、验证结果、实际中文注释计算及提交输入字节。
- 当前仍缺少实现阶段的测试、typecheck、实际中文注释计数、完整 implementation audit 和 commit 证据。这些是 `<verified-implementation-and-commit>` 的后续硬门槛，不是 plan audit 阶段的阻塞项。

## Release verdict

**APPROVE — canonical plan revision R7 可批准。**

批准仅适用于：

- `docs/plans/semiglobal-levenshtein-closest-match.md` 的当前完整 R7 内容；
- 不修改历史存档方案；
- 不改变 Tool schema；
- 不新增 fallback 或 fuzzy replacement success；
- 不新增用户可见错误消息；
- 实现后完成完整 red-green、package-local verification、实际中文注释计算、独立 implementation audit 和用户要求的 commit。

当前 worktree 中的部分实现改动不包含在本次 plan release verdict 内。

### R6 Independent Verdict (verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- `docs/plans/semiglobal-levenshtein-closest-match.md:393-394` 的计划估算仍只按生产代码统计 `E=110`，而实现审计必须把生产、测试和配置中的实质变更全部计入 `E`。计划已在 `§17`、`§21`、`§23` 承诺按实际 diff 重新计算，并执行 `C >= max(1, ceil(E × 0.15))`，因此不降低硬门槛。
- `docs/plans/semiglobal-levenshtein-closest-match.md:386` 声称每个 slice 都必须先红；其中 tie、低置信度、相邻成功语义等保持性测试可能在原实现上已经为绿。原始缺陷仍有可稳定变红的 slices 1、2、3、7，以及 `§8` 的两个反馈循环，因此这属于 TDD 记录表述过宽，不影响行为覆盖。
- 当前 worktree 已包含 `packages/opencode/src/patch/match.ts` 和 `packages/opencode/test/tool/edit.test.ts` 的部分实现改动。该状态不属于本次 plan verdict 的批准范围；后续 implementation audit 必须审查完整实际 diff、red-green 顺序、验证结果和提交输入字节。
- 当前仍缺少实现阶段的测试、typecheck、实际中文注释计数、完整 implementation audit 和 commit 证据。这些是 `<verified-implementation-and-commit>` 的后续硬门槛，不是 plan audit 阶段的阻塞项。

## Release verdict

**APPROVE — canonical plan revision R6 可批准。**

批准仅适用于：

- `docs/plans/semiglobal-levenshtein-closest-match.md`
- 当前完整 R6 内容
- 不修改历史存档方案
- 不改变 Tool schema
- 不新增 fallback 或 fuzzy replacement success
- 不新增用户可见错误消息
- 实现后完成完整 red-green、package-local verification、实际中文注释计算、独立 implementation audit 和用户要求的 commit

当前 worktree 中的部分实现改动不包含在本次 plan release verdict 内。

### R5 Independent Verdict (verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- `docs/plans/semiglobal-levenshtein-closest-match.md:393-394` 的计划估算只把生产代码计入 `E=110`，而政策要求实现审计中的 `E` 同时覆盖生产、测试和配置代码。计划已在 `§17`、`§21`、`§23` 承诺按实际 diff 重新统计并执行 15% 硬门槛，因此这是估算口径偏差，不影响 R5 主逻辑批准。
- `docs/plans/semiglobal-levenshtein-closest-match.md:718-722` 的 implementation audit pending 行仍填写 `R4`，当前 canonical revision 是 `R5`。这是尚未产生实现审计结果前的记录模板陈旧，不构成行为缺陷。
- `§15` 将 `packages/opencode/test/patch/patch.test.ts` 标记为按需修改，而 `§19` 按固定 6 个修改文件估算。实际实现只要严格限于已批准路径并覆盖所有行为映射，该预算偏差不影响发布门禁。
- 当前是计划审计，尚无实现 diff、red-green 执行结果、测试、typecheck、实际中文注释计数或提交证据；这些证据必须在实现阶段和 implementation audit 阶段补齐。

## Release verdict

**APPROVE — canonical plan revision R5 可批准。**

批准只适用于：

- `docs/plans/semiglobal-levenshtein-closest-match.md`
- 当前完整 R5 内容
- 不修改历史 R9 方案
- 不改变 Tool schema
- 不新增 fallback 或 fuzzy replacement success
- 不新增用户可见错误文案
- 实现后完成全部 red-green、package-local verification、实际中文注释计算、完整 implementation audit 和用户要求的 commit

### R4 Independent Verdict (verbatim)

## Blocking findings

无。

## Non-blocking findings

- `§15` 将 `packages/opencode/test/patch/patch.test.ts` 标记为“按需修改”，而 `§19` 的文件统计和测试行数估算按固定文件集合计算；这是预算元数据不一致，不影响当前主逻辑或审计门禁。
- `§17` 的 `E=110`、`C=17` 只是计划阶段估算，不能替代实现审计中的实际中文解释性注释计算；实现审计仍必须按实际 diff 重新计算 `E`、`C` 和 `ceil(E × 0.15)`。
- 当前仍处于计划审计阶段，尚无实现 diff、red-green 执行结果、类型检查或包级测试结果；这些属于后续实现审计的必要证据，不构成当前计划阻塞。

## Release verdict

**APPROVE — canonical plan revision R4 可批准。**

批准范围仅限：

- `docs/plans/semiglobal-levenshtein-closest-match.md`
- 当前审计的完整 R4 方案
- 不修改历史计划
- 不改变 Tool schema
- 不增加 fallback
- 不增加新的用户可见错误消息

`Implementation allowed` 可在记录本次完整范围审计结果后，按政策转换为 `yes`。

### R3 Independent Verdict (verbatim finding record)

## Blocking findings

### B-01 原始候选跨度的坐标映射缺少行为敏感验证

- Violated invariant: `INV-02`、`INV-06`、`INV-07`、`INV-11`；Semiglobal DP 返回的候选跨度必须能从规范化 Unicode code-point 坐标准确映射到原始文件文本，并生成真实、可定位的 candidate evidence。
- Evidence class: reachable
- Producer and execution path: 含 CRLF 或 astral Unicode 字符的文件内容 → `EditTool.execute` 或 Patch chunk 失败 → `closestWindow(content, expected)` 对规范化 code points 执行 DP → DP 候选跨度映射回 JavaScript UTF-16 原文 offset → excerpt renderer → Tool 错误正文。
- Source evidence: `packages/opencode/src/tool/edit.ts:233-251` 将原始 `contentOld` 交给 matcher；`packages/opencode/src/patch/index.ts:382-385,427-431` 将持久化原文交给 matcher；`packages/opencode/src/patch/match.ts:181-183` 当前会先折叠 CRLF/CR，`packages/opencode/src/patch/match.ts:206-215` 随后从匹配结果生成 excerpt。
- Canonical-plan evidence: §10 要求使用 code-point comparison space 并返回 raw candidate span；§20 承认必须保留显式映射；§13 和 §16 没有 CRLF/astral Unicode 诊断跨度测试。
- Responsibility owner: `packages/opencode/src/patch/match.ts`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 如果实现直接把 DP code-point index 或折叠 CRLF 后的 index 交给 `String.slice`，候选前存在代理对或 CRLF 时，raw span 会偏移、截断代理对或包含错误的相邻文本。当前计划中的 ASCII/LF ranking、tie、阈值和 variable-line tests 仍可全部通过，因此实现无法证明满足“返回信息保持有效”和 raw-span 契约。
- Why this is not speculative: 两个 Tool 都接收实际文件文本；CRLF 已由现有 Edit 成功测试确认为支持域，任意文本文件可以包含 astral Unicode。计划自身也把 code-point/raw-offset 差异列为 confirmed risk。
- Minimal correction direction: 在共享 matcher owner 内把规范化 code-point 坐标到原始 UTF-16 offset 的映射纳入可执行契约，并为 Edit 或 ApplyPatchTool 增加同时跨越 CRLF 与代理对边界的诊断测试，直接断言候选行和 raw excerpt。不得通过第二次搜索或另一 matcher 重建跨度。

### B-02 规范化多 edit 的原始反馈循环无法按计划转绿

- Violated invariant: `INV-04`、`INV-08` 以及 bug work 必须让原始反馈循环通过；诊断必须使用 `applyEdits` 已知的实际失败 `editIndex`。
- Evidence class: observed
- Producer and execution path: Section 8 的第二个 `bun -e` replay → `applyEdits` 抛出第二条 edit 的失败 → replay catch 忽略错误元数据 → 再次执行 `edits.find(content.indexOf(...) === -1)` → 选择第一条因规范化而 raw-absent 的 edit → 调用 `closestWindow`。
- Source evidence: `packages/opencode/src/tool/edit.ts:247-256` 是当前错误 heuristic；计划 Section 8 的命令原样复制该 heuristic。当前确定性输出记录在 plan lines 177-184：实际失败为 `edits[1]`，但 `selectedProbe` 为 `"hello"`。
- Canonical-plan evidence: §16 要求传播 owner-known failed index；§18 要求 Section 8 的两个 replay turn green；§10 计划新增 `EditApplyError.editIndex`，但 replay 从未读取该字段，也未经过修改后的 `EditTool` catch。
- Responsibility owner: `packages/opencode/src/tool/edit-apply.ts` 的失败身份接口及 canonical plan 的原始反馈循环。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 即使生产实现正确增加 `EditApplyError.editIndex`，该必跑命令仍会输出 `selectedProbe:"hello"`，无法证明 `edits[1]` 被用于诊断。计划要求的原始反馈循环因此必然失败，不能形成 implementation completion evidence。
- Why this is not speculative: replay 命令和输入均已固定；其 catch 明确丢弃异常对象中的任何 metadata，并重新执行已证明错误的 raw `indexOf` 选择。
- Minimal correction direction: 让原始 replay 通过实际 owner metadata 或真实 `EditTool.execute` seam 观察失败 edit 身份，使当前行为为红、计划实现为绿。不得保留 raw `indexOf` 重建，也不得增加另一条 probe-selection 路径。

## Non-blocking findings

- §24 的 implementation audit pending row 仍写 `Plan revision: R1`；实现前应更新记录模板，但该字段尚未声称已有 implementation verdict。
- §17 已承诺实际实现必须满足 `C >= ceil(E × 0.15)`，估算 `E=110`、`C=17` 可行。计划审计不能把该估算当作实现证据。
- §19 的 “Files modified: 6” 与 §15 中可选修改 `src/patch/index.ts` 的路径存在条件性偏差；只要实际实现严格受 approved paths 和需求映射约束，该预算漂移不影响主逻辑。

## Release verdict

**BLOCK — canonical plan revision R3 不可批准。`Implementation allowed` 必须保持 `no`。需要修订后进行下一轮完整范围审计。**

### R2 Independent Verdict (verbatim finding record)

## Blocking findings

### B-01 可变长度候选没有可执行的差异渲染契约

- Violated invariant: `INV-02`、`INV-06`；插入、删除和多行长度差异必须参与同一距离计算，并返回有效、可定位且不重复的候选证据。
- Evidence class: reachable
- Producer and execution path: 失败的 Patch chunk 或 Edit `oldString` → `closestWindow(content, expected)` → Semiglobal DP 返回可变长度连续候选 → `formatClosestDifference(expected, candidate, startLine)` → Tool 错误正文。
- Source evidence: `packages/opencode/src/patch/match.ts:125-175` 当前 renderer 按 `candidate.entries()` 使用 `expected[index]` 做逐行配对；`packages/opencode/src/patch/index.ts:427-432` 与 `packages/opencode/src/tool/edit.ts:249-257` 将其结果直接作为用户可见诊断。
- Canonical-plan evidence: §6 lines 125-126 将候选插入/删除列为 reachable；§7 `INV-02`、`INV-06`；§10 lines 248-252 要求 renderer 使用 DP 找到的 variable-length candidate；§16 slice 3 lines 339-340 要求报告实际可变跨度。
- Responsibility owner: `packages/opencode/src/patch/match.ts`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前 renderer 不是可变长度候选的 renderer。候选多一行时，`requested = expected[index]` 会在候选尾部得到 `undefined`，随后把该值传入 `diffChars(requested, actual)`；候选少一行时，缺失的 expected 行完全不会进入输出；候选发生行插入时，后续所有行也会错位比较。结果可能是运行时异常、错误的列号/行号，或无法给模型定位真实改动区域。该问题直接覆盖计划明确要求支持的 inserted/deleted-line 输入，因此即使 DP 本身正确，用户仍无法获得有效诊断。
- Why this is not speculative: 计划把不同候选长度明确列入支持域，并把该行为列为必测的 `INV-02`；现有 renderer 的逐索引配对限制可由当前源码直接证明。
- Minimal correction direction: 在共享 matcher/renderer owner 内定义并实现基于同一 DP 对齐结果的行边界与差异证据映射，使可变长度候选能够被稳定渲染；不能继续复用假设 expected/candidate 行数相等的逐索引 renderer，也不能通过第二套 matcher 或 fallback 补偿。

### B-02 Semiglobal DP 的等距候选边界没有完整定义，单一 candidate origin 无法满足 tie 抑制契约

- Violated invariant: `INV-06` 以及“不输出无法证明有效内容”的 tie contract；所有具有相同最小距离的 distinct candidate spans 都必须被识别并抑制，不能因 DP 路径选择顺序产生唯一位置。
- Evidence class: contracted
- Producer and execution path: 文件文本 → Semiglobal DP rolling rows → 每个终点的最小距离与 candidate origin → 全局最小候选选择 → tie/reliability gate → Tool 错误正文。
- Source evidence: 当前共享 matcher 的可观察输出由 `packages/opencode/src/patch/match.ts:180-217` 负责；现有测试已将等距候选抑制作为用户可观察行为：`packages/opencode/test/tool/edit.test.ts:389-409`。
- Canonical-plan evidence: §10 lines 225-234 仅规定 `D[m][j]`、rolling-row candidate origin 和“distinct candidate span 同距则 suppress”；§7 `INV-06`；§16 slice 4 lines 340-341。
- Responsibility owner: `packages/opencode/src/patch/match.ts`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 计划只要求每个 rolling cell 传播一个 candidate origin，却没有规定如何保留同一终点、不同起点的等距最优路径，也没有规定 DP 转移同距时的 origin 集合、traceback 或候选枚举语义。例如 expected 为 `ab`、文本为 `xb` 时，候选 `xb` 与候选 `b` 都可达到距离 1，但跨度不同；若只保留一个 origin，结果会依赖 substitution/deletion 转移的实现顺序，随后错误地通过 tie gate 输出一个未经证明的位置。该行为与计划明定的“distinct equal-distance spans 必须抑制”不一致。
- Why this is not speculative: 等距候选是计划 §6 与现有测试已经承认的 reachable/observed 行为；计划要求的单一 origin 传播不能从给出的 recurrence 推导出“所有 distinct span 均被发现”的保证。
- Minimal correction direction: 在 `match.ts` 的唯一 DP 主路径内明确可证明的候选 span 等价与枚举规则，确保所有达到全局最小距离的 distinct `(start,end)` 都能参与 tie 判定；不得以文件顺序、转移顺序、跨度长度或其他未经契约证明的规则择一，也不得添加第二 matcher。

## Non-blocking findings

- 计划的 `E=110`、`C=17` 只是可行性估算，不能作为 implementation audit 的证据；实现审计仍须按实际 diff 重新计算 `E`、合格中文解释性注释 `C` 及最低值。
- §18 同时列出 focused tests、package-wide tests、`git diff` 和 commit-byte verification，但当前仍是计划阶段，尚无实际 red-green 或命令结果可供本轮确认。

## Release verdict

**BLOCK — canonical plan revision R2 不可批准，`Implementation allowed` 必须保持 `no`。**

### R1 Independent Verdict (verbatim finding record)

## Blocking findings

### B-01 DP 可靠性分数没有可执行定义

- Violated invariant: `INV-06`；只有经过证明达到既有可靠性标准的候选才能进入 `Closest match` 输出。
- Evidence class: contracted
- Producer and execution path: 失败的 Patch chunk 或失败的 Edit `oldString` → `closestWindow(content, expected)` → Semiglobal Levenshtein 候选 → 可靠性门禁 → Tool 错误正文。
- Source evidence: `packages/opencode/src/patch/match.ts:98-110`, `packages/opencode/src/patch/match.ts:180-205`, `packages/opencode/test/tool/edit.test.ts:369-409`, `packages/opencode/test/tool/apply_patch.test.ts:879-902`
- Canonical-plan evidence: §2 lines 41-42；§7 `INV-06`；§10 lines 230-235；§16 slices 4-5
- Responsibility owner: `packages/opencode/src/patch/match.ts`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前 `0.5` 阈值作用于 bigram Dice score。R1 删除该 score 后只要求对“normalized score”应用同一个数值阈值，却没有定义该 score 的分母、范围或公式。`1 - distance / expectedLength`、`1 - distance / candidateLength` 和 `1 - distance / max(expectedLength, candidateLength)` 会在候选长度不同时作出不同的输出决定；实现者可以任选一种并通过现有明显高、明显低的测试，但边界候选会被一份实现输出、被另一份实现抑制。这样无法满足“不要在无法证明有效时输出相应内容”。
- Why this is not speculative: 用户明确约束不输出未经证明有效的内容；当前生产代码和测试都把可靠性门禁作为已存在的可观察契约。替换评分量纲后继续使用 `0.5` 必然需要一个明确的映射定义。
- Minimal correction direction: 在 `match.ts` 所有权内规定唯一的 Levenshtein 可靠性归一化公式、取值范围和阈值边界，并增加能够区分候选公式的 Tool 层边界测试；不得通过第二评分器、阈值重试或 fallback 补偿。

### B-02 候选长度 tie-break 会在同距候选中制造未经证明的唯一结果

- Violated invariant: `INV-06` 以及 R1 自身的 no-false-precision tie contract；不同候选具有相同最小 Levenshtein distance 时不得凭无证据的次级规则选择一个位置。
- Evidence class: contracted
- Producer and execution path: 文件中的多个连续候选 → Semiglobal DP 得到相同最小 edit distance → R1 按“候选长度最接近期望长度”选择一个 → Tool 输出该候选的行号和 actual excerpt。
- Source evidence: `packages/opencode/src/patch/match.ts:189-205`, `packages/opencode/test/tool/edit.test.ts:389-409`
- Canonical-plan evidence: §2 line 42；§7 `INV-06`；§10 lines 230-233；§14 lines 298-300；§16 slice 4
- Responsibility owner: `packages/opencode/src/patch/match.ts`
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 两个不同连续候选具有相同最小 Levenshtein distance、但跨度长度不同且都达到可靠性阈值时，R1 会输出长度更接近期望的候选。Semiglobal Levenshtein 主目标并未证明该候选更可能是模型原本要修改的位置；当前 tie contract 会抑制同分候选，原始需求也禁止输出无法证明有效的内容。计划因此会把原本的无可靠候选结果变成一个具体但未经证明的文件位置。
- Why this is not speculative: 多个等距候选由普通源文件和 Markdown 重复文本直接产生，计划在 §6、§16 已将其列为 reachable 行为；长度 tie-break 是 §10 明确要求执行的生产分支。
- Minimal correction direction: 让 matcher 的 tie 判定服从唯一、证据支持的 Semiglobal Levenshtein 候选等价规则；删除未经证明的候选长度择优概念，或先提供明确契约证据和能证明该规则有效的行为测试。不得在 tie 后尝试其他 matcher 或阈值。

## Non-blocking findings

- Canonical metadata 的 `Audit mode` 写成了 `full-scope`（`docs/plans/semiglobal-levenshtein-closest-match.md:9`），而本次输入指定 `Audit mode: plan`。当前 `Status: audit-required`、`Revision: R1`、`Approved revision: none` 和 `Implementation allowed: no` 保持一致，因此这是记录精度问题，不构成行为级阻塞。
- 中文解释性注释预算承诺了 `C >= ceil(E × 0.15)`，估算为 `E=110`、`C=17`，没有授权降低硬门槛。实际数值仍须在 implementation audit 中重新计算。
- 历史方案 `docs/plans/edit-apply-patch-match-recovery.md` 未出现在当前 git 状态变更列表中；R1 使用了新的 canonical plan 文件，满足“不修改历史存档方案；当前方案必须新建”。

## Rejected speculation

- 未以 `O(mn)` 性能风险阻塞本轮。该路径可达，但当前没有实测退化、文件规模契约或失败基准；性能担忧尚不足以成为 blocking finding。
- 未要求 AST、二进制、远程写入、恶意插件、数据库、遥测或新依赖处理；当前生产链没有对应的 producer、接口契约或所有权依据。
- 未要求 fuzzy replacement、Bitap、diff-match-patch、GNU fuzz、阈值升级或 matcher 重试。这些都会形成用户明确禁止的 fallback。
- 未要求修改 Tool schema 或增加错误消息。现有内部错误元数据和既有错误正文足以承载失败 Edit index，前提是实现保持消息文本与成功域不变。

## Requirement and traceability coverage

| 范围 | 审计结论 |
|---|---|
| Semiglobal Levenshtein 主算法 | 已映射到 `src/patch/match.ts`，DP 边界和连续 substring 目标明确 |
| Patch 多 chunk 归因 | 现有 `applyChunks` 在首个 unresolved chunk 直接传递对应 `expected`，R1 保留该 owner path |
| Edit 多 edit 归因 | R1 将 owner 已知的 `editIndex` 从 `applyEdits` 传递给 `edit.ts`，能够删除 raw `indexOf` 猜测 |
| 诊断不得产生 replacement success | 已明确；`closestWindow` 仍只由失败路径调用 |
| 不添加 fallback | 路径清单完整，bigram scorer计划删除，没有规划备用 matcher |
| Tool schema 与成功语义 | 明确保留；没有 schema、依赖、配置或迁移变更 |
| 返回信息有效且避免重复 | expected-text 去重、500 字符 omission 和 failed-block attribution 已映射 |
| 低置信度与 tie 输出准确性 | **未通过**；可靠性 score 未定义，且新增的 span-length tie-break 缺乏契约依据 |
| TDD 敏感性 | 错误候选和 normalized multi-edit attribution 用例可在当前实现上变红；还缺少区分可靠性公式及不同跨度等距候选的测试 |
| Forward/reverse traceability | DP、failed index 和共享 matcher 已覆盖；normalized score 公式没有生产概念定义，span-length tie-break 也未出现在 reverse traceability 中 |
| 中文注释硬门槛 | 计划承诺可行；implementation audit 必须按生产、测试和配置实际变更重新统计 |

## Primary-path and fallback verdict

R1 保持一个共享诊断算法：

```text
失败块身份
→ shared Semiglobal Levenshtein DP
→ 可靠性与 tie 决策
→ 既有 Tool 错误渲染
```

Patch exact application 和 Edit exact/closed-normalization application 仍是各自唯一成功路径。DP 不进入 replacement success，旧 bigram scorer与 Edit raw probe heuristic计划删除，没有新增 fallback。

主路径的候选决策目前不具备可发布的确定性：可靠性量纲未定义，span-length tie-break 会选择未经证明的等距候选。这属于主算法本身的契约缺口，不能由 fallback 修补。

## Release verdict

**BLOCK — canonical plan revision R1 不可批准，Implementation allowed 必须保持 `no`。**

Any substantive plan revision increments the revision and clears approval.

## 23. Implementation Evidence

Complete only after the approved revision is implemented.

### Actual Files and Diff

| Path | Actual change | Scope check |
| --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | Replaced the bigram scorer with one Semiglobal Levenshtein DP, code-point/raw-boundary mapping, deterministic tie gate, normalized score, and shared renderer. | Approved primary matcher only; no replacement-success path. |
| `packages/opencode/src/tool/edit-apply.ts` | Added internal `EditApplyError.editIndex` propagation and kept the existing apply success path unchanged. | No schema, metadata, or user-facing message change. |
| `packages/opencode/src/tool/edit.ts` | Uses the owner-provided failed edit index for closest diagnostics. | No first-edit probe, fallback, retry, or second matcher. |
| `packages/opencode/test/tool/edit.test.ts` | Added ordered-distance, inner-tie, raw-offset, variable-span, score-boundary, and normalized multi-edit behavior coverage. | Real Edit Tool seam with hand-written expected evidence. |
| `packages/opencode/test/tool/apply_patch.test.ts` | Added/updated shared matcher candidate and failed-chunk evidence coverage. | Real ApplyPatchTool seam; Patch owner behavior preserved. |
| `docs/plans/semiglobal-levenshtein-closest-match.md` | Recorded this implementation evidence and release gate transition. | New canonical plan only. |

The historical `docs/plans/edit-apply-patch-match-recovery.md` remains clean and
was not used as an implementation authority.

### Red-Green Test Evidence

- Original scorer replay selected the wrong first line for `target sequence alpha beta gamma`; the DP replay selected line 2 with score `0.96875`.
- Replaying `HEAD` without the implementation produced `line: 1` and score `0.8253968253968254`; replaying the worktree produced `line: 2` and score `0.96875` for the same input.
- The initial DP implementation failed the minimal `content="xb", expected="ab"` inner-span tie because it discarded the empty predecessor. The active-span state was corrected without adding a second matcher; the replay now returns no candidate.
- The initial renderer failed the CRLF multiline cursor case by treating normalized-equivalent raw text as non-equivalent; it now emits the existing original-file-location wording without repeating the expected block.
- The initial variable-span renderer could truncate a long full-line context around the selected span; it now truncates the DP-owned raw span directly.
- The normalized multi-edit replay initially selected the first edit; after `EditApplyError.editIndex` propagation, the diagnostic metadata identifies `failedEditIndex: 1` and probe `world`.
- Focused regression suite after the final implementation: `140 pass, 0 fail, 358 expect() calls` across `test/patch/patch.test.ts`, `test/tool/apply_patch.test.ts`, and `test/tool/edit.test.ts`.

### Verification Commands and Results

| Command | Result |
| --- | --- |
| `bun test test/patch/patch.test.ts test/tool/apply_patch.test.ts test/tool/edit.test.ts` | PASS: 140 tests, 0 failures. |
| `bun typecheck` | PASS: `tsgo --noEmit` exited 0. |
| `git diff --check` | PASS: no output. |
| `bun run test` | COMPLETED WITH UNRELATED FAILURES: `3937 pass, 16 skip, 2 fail` across 3955 tests. The failures were `shell completion resumes queued loop callers` after a temporary reviewer 503 and `session.processor retries a real first-progress timeout`; neither file is in the implementation diff. |
| Original `bun -e` Semiglobal replay from `HEAD` | RED: line 1, score `0.8253968253968254`. |
| Current `bun -e` Semiglobal replay | PASS: unique line-2 candidate, score `0.96875`. |
| Inner-span tie replay | PASS: no candidate for `xb` vs `ab`. |
| CRLF cursor candidate regression | PASS: expected LF block is not repeated for normalized-equivalent CRLF raw text. |
| Long variable-span regression | PASS: DP-owned `alpha\n\nbeta` span remains visible despite 400-character line prefixes/suffixes. |
| `git status --short` on approved paths | PASS: only the five implementation/test paths and the new canonical plan are changed; historical plan is absent from the status output. |

### Original Feedback-Loop Result

```text
expected: target sequence alpha beta gamma
content:  target sequence alpha beta deltta
          prefix target sequence alpha beta gamxa suffix
result:   line 2, score 0.96875
```

The multi-edit owner feedback loop reports the second failed edit only:
`failedEditIndex: 1`, `selectedProbe: "world"`.

### Actual Secondary and Replacement Path Inventory

- The old bigram scorer and Edit raw `indexOf` probe were removed.
- `closestWindow()` is the only fuzzy diagnostic matcher.
- Exact Patch application remains in `packages/opencode/src/patch/index.ts` and is unchanged.
- Exact and closed-normalization Edit success remains in `packages/opencode/src/tool/edit-apply.ts`; the DP is not reachable from its success path.
- No fallback, retry, threshold escalation, location bias, fuzzy replacement success, or schema extension was added.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 316 | Added/substantively modified non-blank production and test code lines; excluded pure comments, blank lines, import-only lines, and formatting-only lines. Counted as 267 additions + 49 deletions. |
| Qualifying Chinese comment lines `C` | 56 | Added or substantively modified comments adjacent to DP state/tie/raw-boundary decisions, failed-edit ownership, diagnostic-only boundaries, candidate provenance, and behavioral assertions; non-explanatory comments excluded. |
| Ratio `C / E` | 17.72% | `56 / 316`. |
| Required minimum `C` | 48 | `ceil(316 * 0.15) = 48`. |

### Remaining Unverified Items

- The package-wide `bun run test` command completed with two unrelated session failures (`3937 pass, 16 skip, 2 fail`); focused matcher coverage and typecheck pass. The isolated shell-completion failure passed on rerun; the isolated processor retry failure remains outside the changed files.
- The user explicitly accepted the unrelated Session verification failure as non-blocking for this matcher-only change; no Session production or test file is included in this commit.
- Commit input hash, commit identity, and final post-commit status are still pending.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01, B-02, B-03, B-04 | none material | BLOCK | `ses_079c9bcd3ffeD3pEz41Q3XMRBA` |
| 2 | R7 | yes | B-01 | unrelated Session failures; comment recount correction | BLOCK | `ses_079c9bcd3ffeD3pEz41Q3XMRBA` |
| 3 | R7 | yes | B-01 | all matcher, renderer, attribution, fallback, and comment gates pass | BLOCK; user accepted B-01 as unrelated and non-blocking | `ses_079c9bcd3ffeD3pEz41Q3XMRBA` |

### User Decision on Residual Verification Finding

The final independent audit's sole remaining finding concerned the canonical
package test command's unrelated Session failures. The user explicitly decided
that a test failure outside this implementation's changed files and execution
paths is not a blocking finding for this matcher-only release. The finding is
therefore preserved as an accepted verification limitation rather than hidden
or reclassified as a passing package-wide test.

Under that explicit release decision, the approved R7 implementation is marked
`verified` and is eligible for the requested commit. No Session code or test is
part of the commit.

The independent audit's behavioral findings for the approved matcher scope are
resolved; the sole residual package-wide finding is recorded above with the
user's explicit disposition.

# Canonical Implementation Plan: Tool Match Diagnostic Information Density

> Status: verified
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: full-scope
>
> Requirement source: User-provided Session GOAL on 2026-07-15
>
> Implementation allowed: no further material changes; verified diff is frozen
>
> Last updated: 2026-07-15

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 貌似模型输出的oldcodes完整展示了一遍，请你检查检查看看相应的上下文是只有这一遍还是说工具调用的那部分模型也能看得到，你可以自己找个地方弄一个试试，可以先从行为上自己分析然后完整检查是否需要修改，也就是可以先不看代码，先自己在.temp/testing中找个不要的文件弄个文件带错误行试试，看看你是看到两遍oldcodes还是啥，以及看看是否有必要进行优化，同时也看看actual那个段落是否会显示差异，我记得之前是有显示diff差异的机制（也就是原始行显示不下就换成显示diff的差异啥的）请你完整检查是否有必要进行修改以提高信息有效性，降低无用信息，提高信息性价比

Subsequent requirement clarification (verbatim):

> 我是不是说了让你使用一个错误的applypatch试试，自己看看你的上下文toolcall返回给你的是否双份

Explicit task-specific policy exception authorization:

> 是否明确授权本任务突破默认 10% 诊断决策面上限？授权仅覆盖去掉重复 expected 和恢复紧凑 actual/diff 提示，绝不修改匹配成功语义或增加其他诊断。

User answer (verbatim):

> 授权本任务例外 (Recommended)

This authorization is limited to the six diagnostic units enumerated in
Section 11. It does not waive exact matching, no-fallback, ownership, TDD,
comment, verification, or independent-audit gates.

The user also explicitly asks to continue when the next investigation step is
clear and to stop only when clarification is required.

## 2. Explicit Non-Goals

- Do not change exact whole-line matching, unique literal substring matching,
  ambiguity rejection, cursor movement, or Patch success semantics.
- Do not add fuzzy replacement, approximate replacement, retry, or any other
  alternate success path after a match failure.
- Do not change Edit's exact literal, `replaceAll`, whitespace, indentation,
  line-ending, or multiple-match contracts.
- Do not change add-file, delete-file, move-file, permission, LSP, formatting,
  event publication, Snapshot, truncation limits, or Message persistence.
- Do not duplicate matcher logic in `ApplyPatchTool` or `EditTool`.
- Do not modify the local SQLite database; all database inspection is read-only.
- Do not add a dependency; the existing `diff` package is sufficient if the
  approved diagnostic renderer needs character-level changes.
- Do not commit unrelated existing worktree changes.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Tool, Message, Session, Project, and `tool/`/`patch/` module responsibilities. |
| Root `AGENTS.md` | Requires package-local tests and typecheck, parallel investigation, and preservation of unrelated worktree changes. |
| `packages/opencode/AGENTS.md` | Requires existing module shape, Effect conventions, and package-local `bun typecheck`. |
| `packages/opencode/test/AGENTS.md` | Requires behavior tests at real seams and discourages implementation-coupled tests. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, one owner, no fallback success path, full traceability, and the Chinese comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this plan's required sections and audit transitions. |
| `docs/adr/README.md` and ADR-0001 | No ADR governs match diagnostics; ADR-0001 is unrelated triage policy. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| Direct failed `apply_patch` Tool call using the absent old block `THIS OLD BLOCK DOES NOT EXIST ANYWHERE` | The assistant Tool-call input contained the old block once and the returned error contained it once, proving two model-context copies without relying on source inference. | observed |
| In-memory Bun replay of `Patch.deriveNewContentsFromChunks` and `replace` | Reproduced full expected text followed by an almost identical raw closest window for Patch; reproduced the Edit failure shape without requiring a repository fixture. | observed |
| `/Users/sunbenteng/.local/share/opencode/opencode.db`, opened read-only with `PRAGMA query_only=ON` | Current local database integrity is `ok`; latest stored Patch failures contain expected text plus closest raw text, and latest Edit failures contain the closest raw text. | observed |
| `packages/opencode/src/patch/match.ts` | Owns exact locator and shared closest-window diagnostic. Current output is raw candidate text, not a diff. | observed |
| `packages/opencode/src/patch/index.ts` | Owns Patch failure construction and currently embeds the complete expected block before the shared candidate diagnostic. | observed |
| `packages/opencode/src/tool/edit.ts` | Owns Edit replacement and consumes the shared closest diagnostic; its failure output does not independently include oldString. | observed |
| `packages/opencode/src/tool/apply_patch.ts` | Propagates Patch owner errors without a second matcher; its successful unified diff is permission/metadata output only. | observed |
| `packages/opencode/src/session/message-v2.ts` | Converts completed/error ToolParts for the Provider with both `input` and `output`/`errorText`. | observed |
| `packages/opencode/src/tool/tool.ts` and `src/tool/truncate.ts` | Establish that normal tool output is only truncated after execution and that this path does not transform the diagnostic into a diff. | observed |
| `packages/opencode/test/tool/edit.test.ts` | Existing closest tests prove candidate selection and long excerpt omission, but not duplicate suppression or diagnostic diff rendering. | observed |
| `packages/opencode/test/tool/apply_patch.test.ts` | Existing tests prove candidate selection and omission, but not expected-block duplication or diff rendering. | observed |
| Historical commit `20d6946a93` | Confirms a prior Edit-only `diffChars` diagnostic renderer existed and was later superseded by shared matching. | observed |
| `packages/opencode/src/tool/edit.ts` `trimDiff` and success paths | Confirms unified diffs exist for successful Edit/permission metadata, not for not-found diagnostics. | observed |

## 5. Current Behavior

```text
Agent tool call
  -> ToolPart.state.input stores full patchText/oldString
  -> Patch owner or Edit replacement fails exact matching
  -> closestWindow computes one diagnostic candidate
  -> Patch error embeds full expected old block, then closestWindow raw excerpt
  -> Tool wrapper persists the error as ToolPart.state.error
  -> MessageV2 sends tool input and error output/errorText to the Provider
```

For Edit, the error body starts with the exact-match explanation and then only
the raw closest candidate. For Patch, the error body includes the full expected
block and then the candidate raw window. Therefore a Patch failure exposes the
requested old block in the tool input, repeats it in the error body, and shows a
candidate that may visually repeat nearly all of it. The current candidate
renderer has no `diffChars` or equivalent difference format.

The Tool truncation service does not remove this duplication or create a diff:
it only applies generic line/byte limits after the Tool returns. The successful
unified diff generated by Edit and Apply Patch is not reachable from the
not-found diagnostic path.

The direct failed Tool call resolves the user's context question independently
of the source trace: the Tool return payload contained one expected block, while
the assistant Tool-call input retained the same block. The model-visible
context therefore contained two copies. A reliable near candidate would add a
third, visually similar actual block.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Patch exact old block is absent after exact-line and unique-literal lookup | Agent emits `patchText` parsed by `Patch.parsePatch` | Patch parser produces `UpdateFileChunk.old_lines`; no fuzzy success is allowed | `Patch.deriveNewContentsFromChunks` throws `withCandidate` error; `ApplyPatchTool` persists it | Patch owner | observed |
| Edit `oldString` is absent from file | Agent emits Edit parameters | Schema provides strings; replacement requires exact literal occurrence | `EditTool` calls `replace`, then `closestWindow` only for error reporting | Edit owner using shared diagnostic | observed |
| Tool call input and failure output are replayed to the Provider | Session prompt creates ToolPart; MessageV2 converts it | ToolPart stores input and terminal output/error | `message-v2.ts` emits `input` with `output-available` or `output-error` | Message conversion | observed/contracted |
| Candidate is long or differs in a small token/character | File content and model old block | Diagnostic may inspect persisted file text but must not mutate it | `closestWindow` scans bounded windows and formats the failure hint | Shared diagnostic owner | observed |
| No reliable candidate exists | Any unmatched old block | No candidate may be asserted as fact | Existing `No reliable nearby candidate` branch | Shared diagnostic owner | reachable |

The tool-call input is not merely a display artifact: `MessageV2` places
`part.state.input` into the Provider-facing tool part for both completed and
error outcomes. This proves that removing a repeated expected block from the
Patch error does not remove the model's original input context.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A failed Patch/Edit operation remains a failure; diagnostics never create a successful replacement. | Existing exact replacement tests and Tool error states. | `patch.test.ts`, `edit.test.ts`, `apply_patch.test.ts` |
| INV-02 | The Provider receives the original Tool input and the terminal error output; diagnostic compaction must not hide the original input. | `message-v2.ts` lines 988-1027 and ToolPart schema. | Existing prompt/message replay coverage. |
| INV-03 | Across model-visible Patch Tool input plus terminal all-failed error or partial-success output, each complete requested old block or `@@` context appears exactly once for every not-found, ambiguous, or context-location failure. | Direct failed Tool call proves current count is two for not-found; source proves ambiguity/context also embed requested text; existing multi-file behavior proves failed-hunk diagnostics also enter successful Tool output. | New all-failed and partial-success Apply Patch assertions required. |
| INV-04 | A reliable closest diagnostic exposes the actual candidate and changed line/column locations, including long-line differences, without copying expected text or claiming approximate replacement; if the persisted candidate contains the complete expected block outside the eligible Patch range, it reports location/ineligibility without rendering that text. | Historical `diffChars` implementation, current raw excerpt tests, Patch cursor behavior, and user request for information density. | New Edit and Apply Patch diagnostics required. |
| INV-05 | A low-confidence or tied candidate remains suppressed rather than being rendered as a false precise location. | Current `closestWindow` threshold/tie behavior. | Existing mismatch/tie tests. |
| INV-06 | Diagnostic line numbers and raw candidate text remain anchored to persisted file content. | Current `closestWindow` owner and Patch `persistedText` flow. | Existing line/candidate tests. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-03 | Patch constructs not-found, ambiguous, and context-location messages with complete requested text even though ToolPart input already contains it; each owner error reaches both all-failed error output and existing partial-success output. | `packages/opencode/src/patch/index.ts`, Patch owner error formatter | Direct failed Tool call proves the model-visible input+error count is two for not-found; source lines 352-382 prove the other two producers; Tool aggregation propagates all owner errors. |
| INV-04 | `closestWindow` returns only a raw truncated window even though the existing `diff` dependency and historical diagnostic behavior can express changed characters compactly. | `packages/opencode/src/patch/match.ts`, shared diagnostic owner | Current source has raw `truncateExcerpt`; historical commit `20d6946a93` added `diffChars` for the same user-facing symptom. |
| INV-03/04 | Patch matching is cursor-relative but `closestWindow` scans persisted text globally, so an exact expected block before the cursor can become the diagnostic candidate and be repeated verbatim. | `packages/opencode/src/patch/index.ts` cursor + shared diagnostic renderer | Existing cursor flow and full-file candidate scan prove the state; R5 adds a multi-chunk Tool reproduction. |

Red-capable reproductions:

```text
Direct apply_patch Tool call with an absent old block against a user-authorized
temporary file.

bun -e 'import { Patch } from "./src/patch/index.ts"; import { replace } from "./src/tool/edit.ts"; const content = <in-memory fixture>; ...'
```

Observed direct Tool result: the old block appeared once in the Tool-call input
and once in the Tool return, so the model context contained two copies even
without a candidate. Observed in-memory owner result: Patch error output
contained the complete three-line expected block followed by the same three-line
file candidate with one changed word; Edit output contained the exact-match
explanation followed by the raw candidate.
The current database sample `prt_f64d1defa001oGxon2tzzykTsC` shows the same
Patch shape for `windows-macos-ci-test-failures.md`, including `expected` and
`Closest match` copies.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Exact matching and failure identity | Patch owner / Edit replacement | Match or reject; never approximate success | These modules own the replacement boundary and already expose the failure. | Tool wrappers must not run another matcher. |
| Closest candidate selection and rendering | Shared `patch/match.ts` diagnostic | Diagnostic-only candidate, location, and excerpt | Both Patch and Edit need one selection/rendering contract. | `apply_patch.ts` and `edit.ts` are consumers; duplicating formatters would diverge again. |
| Suppressing repeated Patch expected text | Patch owner error construction | Preserve failure while avoiding redundant output when candidate exists | The owner has both the expected block and candidate result at the first divergence. | Message conversion only transports the result and must not understand Patch text. |
| Provider context preservation | Existing MessageV2 conversion | Send Tool input plus terminal output/error | Already owned by MessageV2 and required for all Tools. | Diagnostic code must not alter Session/Message persistence. |

## 10. Single Approved Primary-Path Design

```text
exact match fails
  -> owner computes one diagnostic candidate from persisted text
  -> shared renderer emits actual text plus changed line/column locations
  -> Patch owner omits its duplicated full expected block for every not-found result
  -> failed hunk keeps existing all-failed or partial-success Tool outcome
  -> MessageV2 continues sending Tool input and terminal error/output
```

The renderer remains diagnostic-only. It does not feed a candidate back into
`locateExact`, `replace`, or any write path. The exact matcher and all success
semantics remain unchanged.

Patch's failure prefix will identify the failed path and expected-lines
condition without embedding the complete old block again, regardless of whether
a candidate exists. A reliable diagnostic shows the candidate's real line,
actual file text, and changed line/column locations; the original full
patch/oldString remains available through ToolPart input. When no candidate
exists, the existing no-reliable-candidate instruction remains explicit without
copying expected or inventing a location.

The compact renderer will preserve the existing confidence threshold, tie
suppression, line anchoring, and 500-character output budget. For small
differences it will expose changed expected/actual tokens; for long lines it
will retain enough actual head/tail context and an explicit omission marker.

The observable candidate format is fixed for TDD and never copies expected
text:

```text
Closest match at line <one-based candidate start>:
line <one-based changed line> actual: "<actual local context>"
difference: requested columns <start>-<end> differ from actual columns <start>-<end>
```

Unchanged lines are omitted. Each changed line keeps at most 30 actual
characters of prefix and 20 actual characters of suffix around the changed
range. Expected text is never rendered; the Provider already receives it in the
Tool input. If changed-line rendering cannot establish a paired line, the
renderer returns the existing raw actual head/tail excerpt instead. Both forms
share one 500-character budget and append an explicit omission marker when
content is excluded.

Patch's eligible range may exclude text before its current cursor or outside an
EOF constraint even though that text exists in persisted content. Therefore,
before rendering raw actual text, the shared diagnostic checks whether the
candidate window contains the complete exact expected block. If it does, the
diagnostic emits only:

```text
Closest match at line <one-based candidate start>:
Exact requested text exists at this location in the original file but is unavailable to the current patch step.
```

It does not print the candidate. This is a diagnostic classification only: it
does not claim whether cursor exclusion, EOF, or a prior chunk made the text
unavailable, and it does not change cursor, EOF, uniqueness, or replacement
success. For candidates that do not contain the complete expected block,
actual-only difference or raw actual fallback remains safe because neither can
reproduce the complete block.

Every Patch matching-failure producer follows the same requested-text rule:

- Context failure: `Failed to find context in <path>.` without the `@@` text.
- Ambiguity: `Found multiple matches for expected lines in <path>. Provide more context to make the match unique.` without old lines.
- Not-found: `Failed to find expected lines in <path>.` plus the shared candidate/no-candidate diagnostic, without old lines.

Parse errors, missing files, unknown hunk types, empty patches, and no-hunk
errors do not embed requested old/context text and remain unchanged.

Existing Apply Patch outcome semantics remain unchanged. If every hunk fails,
the diagnostic is terminal error text. If at least one file succeeds, the Tool
continues to return its existing successful ExecuteResult and includes failed
hunk diagnostics in `Failed to update ...`; that output must inherit the same
expected suppression and actual-only difference format.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `locateExact` / `replace` exact success | current | primary-contract branch | yes | unchanged | preserve |
| Unique literal Patch substring success | current | primary-contract branch | yes | unchanged | preserve |
| `closestWindow` raw candidate | current | diagnostic | no | D01/D02 below | replace with shared compact renderer |
| Historical Edit-only `findClosestMatch`/`diffChars` copy | superseded | duplicate diagnostic | no | zero; remains absent | do not restore as a second owner |
| Patch expected block plus closest raw block | current | diagnostic duplication | no | D03 below | collapse at Patch owner |
| Apply Patch multi-file partial success with failed-hunk diagnostic | current | primary-contract branch carrying diagnostic | yes | unchanged outcome; inherits D03 text | preserve and verify |
| Any approximate candidate replacement | proposed/forbidden | forbidden fallback | yes | zero | reject |

### R6 Diagnostic Decision-Surface Calculation

The planned production change is intentionally a user-requested diagnostic-only
repair. At equal granularity its modified production decision surface contains:

- `D01`: actual-only changed-line and column-range output.
- `D02`: unpaired/structurally divergent raw actual excerpt output.
- `D03`: every Patch not-found error omits the repeated complete expected block;
  existing all-failed and partial-success aggregators propagate that one owner result.
- `D04`: a persisted candidate containing the complete expected block emits
  location plus neutral original-file/current-step availability metadata without candidate text.
- `D05`: Patch ambiguity errors omit the repeated complete expected old block.
- `D06`: Patch context-location errors omit the repeated complete `@@` context.

The estimated diagnostic ratio is therefore `6 / 6 = 100%`. No success path,
state transition, or replacement branch is modified, so adding unchanged match
paths to the denominator would be false. This exceeds the policy's default 10%
secondary diagnostic budget under the explicit higher-priority authorization
quoted in Section 1. The exception is limited to D01-D06 and does not authorize
any adjacent diagnostic, telemetry, fallback, or success behavior. The actual
implementation audit must recount the same decision units and verify that no
additional branch or error outcome was added.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Patch error embeds full expected block and then raw closest window | It made the failed chunk visible before the diagnostic was centralized. | ToolPart input already preserves the full request; the shared renderer supplies only high-value actual/difference information. | `packages/opencode/src/patch/index.ts` failure formatting |
| Raw-only `closestWindow` excerpt | Shared matcher consolidation removed the old Edit diff renderer but retained only truncation. | Shared diagnostic owner can render the same compact difference for both consumers. | `packages/opencode/src/patch/match.ts` |
| Historical Edit-only diff renderer | It was tied to a duplicate matcher and could drift from Patch selection. | Reuse the existing shared candidate window, not the old duplicate scorer. | Do not reintroduce old private matcher code |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| Inspect whether Tool input is also model-visible | Existing `MessageV2` conversion | No production change; record evidence in plan | Direct failed Tool call plus `test/session/message-v2.test.ts` `converts assistant tool error into error-text tool result` |
| INV-03: remove repeated Patch expected block for every failed hunk | Patch owner `withCandidate` call site, existing Tool aggregation | `patch/index.ts`; no ApplyPatchTool production change | All-failed test concatenates original `patchText` and terminal error; partial-success test concatenates `patchText` and successful output; each asserts the complete old block occurs exactly once, with/without candidate |
| INV-04: show useful difference for near candidate | Shared closest renderer | `patch/match.ts` | Edit and Apply Patch near-mismatch tests assert actual text, changed line/column range, absence of expected text, and omission marker behavior |
| INV-03/INV-04: persisted exact candidate does not recreate expected | Shared closest renderer after Patch working-copy failure | `patch/match.ts`; no cursor or matching change | Two multi-chunk Apply Patch tests cover cursor-excluded and prior-chunk-consumed exact text; combined input+error count remains one and output reports neutral original-file/current-step availability only |
| INV-03: ambiguity/context failures do not repeat requested text | Patch owner ambiguity and context error producers | `patch/index.ts` | Combined input+error tests for duplicate old block and missing/ambiguous `@@` context assert each requested text occurs exactly once and rejection/file atomicity remain unchanged |
| INV-05/INV-06: preserve confidence and location semantics | Existing `closestWindow` selection | `match.ts` renderer-only extension | Existing decoy, tie, low-confidence, and line-number tests |
| INV-01: no replacement fallback | Existing owner matchers | No success-path change | Existing Patch/Edit success and rejection suites |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Shared actual-only difference renderer | INV-04 | User explicitly asks whether the old diff display is needed; historical diff behavior and current long raw excerpt are observed. | Current `truncateExcerpt` hides the changed location and provides no difference signal; expected-bearing diff would recreate the duplicate for short blocks. |
| Uniform omission of Patch expected block | INV-03 | Current DB, direct no-candidate replay, partial-success source/test, and MessageV2 input transport show duplication across every model-visible result shape. | Current `withCandidate` receives a message already containing expected text for both candidate and no-candidate results. |
| Explicit raw actual candidate plus omission marker | INV-04/INV-06 | Existing tests require actual candidate and long-text omission; user asks for information density. | A diff-only output can hide actual file text and would weaken the existing diagnostic contract. |
| Exact-candidate location-only diagnostic | INV-03/INV-04 | Current working-copy matching and immutable persisted-content diagnostics make consumed or cursor-excluded exact candidates reachable. | Rendering raw actual would recreate the complete expected block; the shared renderer cannot prove the unavailability cause, and changing matching would alter success semantics. |
| Requested-text-free ambiguity/context errors | INV-03 | Both current error producers embed text already present in Tool input and propagate through the same all-failed/partial-success results. | Candidate rendering only covers not-found; these separate producers must stop embedding requested text at their Patch owner. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | modify | Add shared compact changed-token/actual-candidate rendering behind existing closest selection; retain diagnostic-only semantics and budget. | +35 to +75 |
| `packages/opencode/src/patch/index.ts` | modify | Remove repeated requested text from context, ambiguity, and not-found Patch owner errors while preserving each rejection outcome. | -8 to +8 |
| `packages/opencode/test/tool/edit.test.ts` | modify | Assert compact diff/actual output for Edit not-found and preserve low-confidence behavior. | +15 to +35 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | Assert no duplicate requested text for not-found/ambiguity/context failures, useful candidate difference, partial-success propagation, and exact persisted-candidate location-only behavior for cursor exclusion and prior consumption. | +45 to +75 |

No production file outside the shared diagnostic owner and Patch error owner is
needed. No config, dependency, migration, generated, SDK, or database change is
planned. No temporary artifact is part of the implementation diff or cleanup
scope.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Model-visible Apply Patch `patchText + terminal error` contains the complete expected block twice for both reliable-candidate and no-candidate failures. | Tool input contains the block once and Patch error embeds it once; MessageV2 transports both. | Patch error never embeds the complete expected block, so each combined occurrence count is exactly one while candidate/no-candidate guidance remains. | INV-03 and the user's direct Tool-call reproduction. |
| 2 | Edit near mismatch exposes only a long raw excerpt and hides the changed location in a long line. | Shared `closestWindow` only truncates raw text. | Shared renderer emits actual candidate and changed line/column ranges without expected text. | INV-04, existing line and omission tests. |
| 3 | Apply Patch candidate output has no compact difference signal. | Patch consumes the same raw-only `closestWindow`. | Patch receives the same actual-only shared renderer output without a second matcher. | Owner consistency and no duplicate scorer. |
| 4 | Multi-file partial success repeats the failed hunk's complete expected block across Tool input and successful output. | Existing aggregator copies the owner error into `Failed to update ...`. | Existing success result is preserved, but combined input+output contains the complete failed block exactly once and actual/no-candidate guidance remains. | INV-03 across every model-visible Apply Patch result. |
| 5 | A later Patch chunk requests exact text that exists only before the forward cursor; raw fallback repeats that block in the error. | Matcher correctly rejects the ineligible occurrence, but diagnostic scan is global and finds the exact text. | Diagnostic reports candidate line and neutral original-file/current-step unavailability without text; combined input+error occurrence count is exactly one and file remains unchanged. | INV-03/INV-04 without changing cursor success semantics. |
| 6 | A prior chunk consumes exact text, then a later chunk requests it; persisted diagnostic finds the consumed block and would assert a false cursor cause. | Matching uses current working copy while diagnostic uses immutable original content. | The same neutral location-only diagnostic is truthful for consumed and cursor-excluded candidates; file remains atomically unchanged on failure. | INV-03/INV-04 and truthful diagnostics. |
| 7 | Ambiguous old lines and failed `@@` context are repeated in Tool input and error/output. | Separate Patch error producers embed requested text verbatim. | Both producers retain rejection semantics and instructions but omit requested content; combined occurrence count is one. | INV-03 across every requested-text-bearing Patch failure producer. |
| 8 | Tie/low-confidence candidate output must remain suppressed after renderer addition. | Renderer changes could accidentally bypass selection guards. | Renderer runs only for an already accepted unique candidate. | INV-05/INV-06 and existing decoy tests. |

All tests observe the exported Patch owner or real `EditTool`/`ApplyPatchTool`
seams. No test will call a private renderer or duplicate its scoring algorithm.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 200 upper-bound estimate | Includes substantive production and test lines: production 55-90 plus tests 60-110; excludes only blank/import-only/formatter-only/generated/pure-move lines. |
| Required Chinese explanatory comments `C` | 30 upper-bound minimum | `ceil(200 * 0.15) = 30`; actual implementation recalculates from the real full diff and must meet `ceil(actual E * 0.15)`. |

Qualifying comments will be placed near the changed renderer, Patch error
boundary, and behavior tests to explain diagnostic-only ownership, local token
pairing, actual-text direction, fallback-to-raw rendering, the shared character
budget, duplicate suppression, and test intent. They will not be gathered in a
block or used to restate control flow.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts test/tool/apply_patch.test.ts test/patch/patch.test.ts` | `packages/opencode` | Red/green behavior of both Tool consumers and Patch owner. |
| `bun typecheck` | `packages/opencode` | Type safety for shared renderer and Tool error paths. |
| `git diff --check` | repository root | No whitespace errors in the plan/implementation diff. |
| Direct failed `apply_patch` Tool calls for reliable-candidate and no-candidate cases against a user-authorized temporary file | Session Tool seam | Original user-visible duplication is absent after implementation and actual candidate/no-candidate guidance remains visible. |
| In-memory Bun replay of Patch owner and Edit replacement | `packages/opencode` | Reproduces the one-character near candidate without relying on or cleaning up a repository fixture. |
| Read-only DB query with `PRAGMA query_only=ON` | repository root | No database mutation; representative persisted error shape and integrity evidence. |
| Package-wide `bun test` when feasible | `packages/opencode` | Broader regression signal; unrelated existing timeout failures must be recorded, not hidden. |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 production, 0 test | No fixture or generated artifact is added. |
| Files modified | 4 | Shared diagnostic, Patch owner error formatting, two behavior test files. |
| Files deleted | 0 production | No superseded production module exists; old private renderer is already absent. |
| Production lines | 55 to 90 | One shared diagnostic renderer plus uniform Patch matching-failure message changes. |
| Test lines | 60 to 110 | Duplicate suppression for all producers, compact diff, actual text, long-line, partial-success, cursor/consumption candidates, and regression assertions. |
| Generated lines | 0 | No generation path is reachable. |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. The user has already requested a full investigation and authorized
continuation when the next step is clear.

### Rejected Speculation

- Whether a Provider hides assistant tool input is not speculative here:
  `message-v2.ts` explicitly sends `input` for both completed and error ToolParts.
- Database corruption is not a driver for production changes: current
  read-only `PRAGMA integrity_check` returns `ok`.
- Approximate replacement is not a diagnostic requirement and remains forbidden.
- A new generic Tool truncation policy is not needed; the duplication is created
  before generic truncation at the Patch owner.
- Reintroducing the historical Edit-only matcher would be a duplicate owner and
  is rejected in favor of the shared diagnostic path.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct the Tool input/output path and failure rendering from repository evidence.
- Treat builder summaries and prior audit material as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check that diagnostic changes cannot create replacement success.
- Check duplicate suppression, actual-text visibility, line labels, truncation,
  tie/low-confidence suppression, tests, ownership, and the 15 percent Chinese
  explanatory-comment plan.
- Apply the user's instruction that unrelated speculative or corner-case issues
  are not blocking unless they are a strict, reachable, severe core issue.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 comment gate excluded tests; B-02 temporary fixture evidence/cleanup was invalid; B-03 numeric diagnostic decision-surface ratio was absent | Renderer format underspecified; exact MessageV2 test unnamed | BLOCK | `ses_09b25377cffeVQSqjfG86ksIZT` |
| 2 | R2 | yes | B-01 diagnostic ratio exception lacked explicit user authorization; B-02 proposed Patch test counted only the error and was not red-capable | Unequal multiline pairing remains raw fallback; MessageV2 test does not itself cover Patch | BLOCK | `ses_09b1dedcbffegpgpgwRbgOoOSo` |
| 3 | R3 | yes | B-01 no-candidate path retained expected; B-02 short expected-bearing diff recreated duplication; B-03 partial-success Apply Patch diagnostics were not inventoried | R3 heading typo; implementation comment ratio pending actual diff | BLOCK | `ses_09b1abf25ffe5A70L1XvwuCG4F` |
| 4 | R4 | yes | B-01 cursor-excluded exact candidate could recreate the complete expected block through raw fallback | Section 1 said four units while R4 listed three | BLOCK | `ses_09b169435ffeaTNqGtZ2kCXZBC` |
| 5 | R5 | yes | B-01 ambiguity/context producers were omitted from exactly-once coverage; B-02 location-only message asserted an unavailable cause | Revision heading mismatch; file-level wording lagged stronger invariant | BLOCK | `ses_09b1324dbffeSpkq9pOreMjMU7` |
| 6 | R6 | yes | none | Semantic model-visible copy is not always a literal substring because Patch input lines carry `-` prefixes | APPROVE | `ses_09b0f33daffep7s71FcrrDYZzK` |

Round 1 release verdict (verbatim):

> **BLOCK**
>
> Revision R1 is not releasable for implementation. It requires a new canonical revision that:
>
> 1. Corrects the Chinese-comment calculation using the governing policy.
> 2. Removes the unowned `.temp/testing/diagnostic-duplication.md` deletion and invalid reproduction claim.
> 3. States the estimated diagnostic decision-surface ratio numerically.
> 4. Re-runs a full-scope plan audit after those substantive changes.

Round 2 release verdict (verbatim):

> **BLOCK**
>
> Revision R2 requires substantive revision, including:
>
> 1. Resolving the 10% diagnostic decision-surface violation without relying on an unauthorized exception.
> 2. Replacing the Patch TDD slice/assertion with a red-capable test that observes the actual Tool input plus terminal error duplication.
> 3. Running another full-scope audit of the revised canonical revision.

Round 3 release verdict (verbatim):

> **BLOCK**
>
> Canonical revision R3 is not releasable for implementation. It must be revised so that duplicate expected suppression covers the no-candidate path, the compact renderer is consistent with the exactly-once invariant for short expected blocks, and the existing partial-success Apply Patch output path is inventoried and behaviorally verified.

Round 4 release verdict (verbatim):

> **BLOCK**
>
> Canonical revision **R4** is not releasable for implementation. This fourth-round finding concerns the core requested exactly-once behavior, not an unrelated corner case: the plan must account for cursor-excluded exact candidates and add a sensitive multi-chunk Tool-level regression test. A substantive revision requires a new revision and another full-scope audit.

Round 5 release verdict (verbatim):

> **BLOCK**
>
> Canonical revision **R5** is not approved for implementation. It requires substantive revision to cover all reachable Patch error producers governed by the exactly-once invariant and to make the exact-persisted-candidate diagnostic truthful for both cursor exclusion and prior-chunk consumption. A revised canonical revision requires another full-scope audit.

Round 6 release verdict (verbatim):

> **APPROVE**
>
> Canonical plan revision **R6** is approved for implementation. This verdict applies only to the exact audited R6 content; any substantive scope, behavior, ownership, test, fallback-classification, or file-plan change requires a new revision and full-scope audit.

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

Implementation of approved R6 is complete and independently verified.

### Actual Files and Diff

| File | Actual responsibility | Numstat |
| --- | --- | --- |
| `packages/opencode/src/patch/index.ts` | Remove requested text from context, ambiguity, and not-found Patch owner errors while preserving rejection semantics | +6 / -3 |
| `packages/opencode/src/patch/match.ts` | Shared actual-only changed-line/column renderer, explicit omission counts, and persisted exact-candidate location-only output | +63 / -1 |
| `packages/opencode/test/tool/apply_patch.test.ts` | Tool input/result duplicate counts, all-failed/partial-success, ambiguity/context, long-line, cursor, and consumed-candidate behavior | +114 / -12 |
| `packages/opencode/test/tool/edit.test.ts` | Actual-only single-character difference contract at the real EditTool seam | +5 / -3 |

No production or test file outside these four paths is part of the
implementation. Exact implementation diff SHA-256:
`12ef2d301a91517478f6137d9fa01a6148ef63230d8fe8d83c20713929d538c8`.
The canonical plan is an administrative/audit artifact outside that hash.

### Red-Green Test Evidence

- Slice 1, Apply Patch no-candidate duplication:
  `bun test test/tool/apply_patch.test.ts -t "suppresses unrelated candidates when context mismatches"`
  was red with `Expected: 1, Received: 2` for the combined
  `patchText + error.message` occurrence count. Removing expected text from the
  not-found owner error made it green (`1 pass, 0 fail`).
- Slice 2, Edit actual-only difference:
  `bun test test/tool/edit.test.ts -t "closest match shows actual candidate for a single-char mismatch"`
  was red because the raw excerpt lacked `line 2 actual` and changed columns.
  The shared renderer made it green (`1 pass, 0 fail`).
- Slice 3, long candidate information density:
  `bun test test/tool/apply_patch.test.ts -t "marks omitted text when a reliable candidate is long"`
  was red because the compact renderer initially emitted bare `...` without an
  omission count. Explicit prefix/suffix counts made it green (`1 pass, 0 fail`).
- Slice 4, ambiguity duplication:
  `bun test test/tool/apply_patch.test.ts -t "rejects ambiguous substring matches without modifying the file"`
  was red with combined occurrence count `2`; requested-text-free ambiguity
  wording made it green (`1 pass, 0 fail`).
- Slice 5, context duplication:
  `bun test test/tool/apply_patch.test.ts -t "validates change context for pure insertions"`
  was red with combined context count `2`; requested-text-free context wording
  made both zero/multiple-match cases green (`1 pass, 0 fail`).
- Cursor-excluded, prior-chunk-consumed, reliable-candidate, partial-success,
  tie, low-confidence, exact replacement, and atomicity cases were added or
  retained as regression coverage over the same approved shared route.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts test/tool/apply_patch.test.ts test/patch/patch.test.ts` | `packages/opencode` | `116 pass, 0 fail, 308 expect() calls` |
| `bun typecheck` | `packages/opencode` | passed: `tsgo --noEmit` |
| `git diff --check` | repository root | passed with no output |
| In-memory Bun replay of `Patch.deriveNewContentsFromChunks` and Edit `replace` against the long Chinese three-line sample | `packages/opencode` | both omitted the complete requested block, showed actual `和单调`, and reported requested columns `106-107` vs actual `106-106` |
| `bun test` | `packages/opencode` | did not complete within 300 seconds; focused changed suites remained green |
| `bun test test/file/watcher.test.ts` | `packages/opencode` | unrelated unchanged test independently reproduced: `5 pass, 1 fail`, symlinked `.git/HEAD` watcher timeout |
| `bun test test/fixture/fixture.test.ts` | `packages/opencode` | unrelated unchanged test independently reproduced: `6 pass, 1 fail`, disposal timeout |

The package-wide run reported one watcher timeout and two fixture timeout cases
before the overall 300-second limit. Isolation reproduced the watcher failure
and one fixture failure without loading any changed file from this task.

### Original Feedback-Loop Result

The post-implementation long-text replay produced for both Patch and Edit:

```text
Closest match at line 1:
line 3 actual: "...[75 chars omitted]...ePageCount`、`managedPageCount`和单调`voiceSubmitted`。"
difference: requested columns 106-107 differ from actual columns 106-106
```

Both replay checks returned:

```json
{
  "repeatsCompleteRequestedBlock": false,
  "showsActualDifference": true,
  "showsColumnRange": true
}
```

The original direct failed Tool call proved the pre-change model context held
the absent old block once in Tool input and once in terminal error. The real
ApplyPatchTool behavior tests now combine those two model-visible surfaces and
prove the terminal result adds no second copy for not-found, ambiguity,
context, partial-success, cursor-excluded, or prior-consumed cases.

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Produces success? | Actual disposition |
| --- | --- | --- | --- |
| Exact Patch/Edit matching and unique literal Patch matching | primary-contract branches | yes | unchanged |
| Apply Patch multi-file partial success | existing primary-contract branch carrying failure diagnostics | yes | unchanged; inherits owner diagnostic text |
| D01 actual-only changed line/column output | diagnostic | no | implemented in shared renderer |
| D02 raw actual fallback when no paired difference is rendered | diagnostic | no | retained under shared 500-character budget |
| D03 requested-text-free Patch not-found error | diagnostic | no | implemented at Patch owner |
| D04 persisted exact candidate location/neutral availability output | diagnostic | no | implemented without candidate text or causal guess |
| D05 requested-text-free ambiguity error | diagnostic | no | implemented at Patch owner |
| D06 requested-text-free context error | diagnostic | no | implemented at Patch owner |
| Historical Edit-only matcher/renderer | duplicate workaround | no | not restored |
| Fuzzy/approximate replacement, retry, or catch-and-success | forbidden fallback | yes | absent |

Actual modified decision surface is `6 diagnostic / 6 total = 100%`, exactly
the D01-D06 scope explicitly authorized by the user. No success branch, Tool
outcome, matcher, cursor, or replacement state transition changed.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 176 | Added non-blank production/test lines, excluding one import-only line; no generated or pure-move changes |
| Qualifying Chinese comment lines `C` | 27 | Nearby Chinese comments explaining owner boundaries, model-visible duplication, actual-only ranges, omission counts, persisted/working-copy distinction, and test intent |
| Ratio `C / E` | 15.34% | `27 / 176` |
| Required minimum `C` | 27 | `ceil(176 * 0.15) = 27` |

Representative qualifying comments:

- `Tool input 已携带完整 old block；错误正文只补充结果与 actual 证据，避免模型上下文出现第二份请求文本。`
- `差异区间只输出列号；完整 requested 已由 Tool input 携带，不能借 diff 再复制到错误正文。`
- `working copy 可能已消费或越过原文；persisted candidate 若含完整 expected，只能报告位置而不能回显第二份文本。`
- `成功 result 与失败 error 共用 Patch owner 文案；两条 Provider 路径必须保持同一去重不变量。`

### Remaining Unverified Items

- Independent full-scope implementation audit returned `APPROVE` with no
  blocking or non-blocking findings.
- A clean package-wide test completion is unavailable because unchanged
  watcher/fixture tests time out independently; focused affected suites,
  typecheck, and original feedback replay pass.
- The already-running OpenCode process may retain pre-change loaded Tool code;
  repository verification uses fresh Bun processes against the implemented
  source. No daemon restart or shared-process mutation is part of this task.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | none | none | APPROVE | `ses_09af8fd93ffeuvzofk6IaWfcMs` |

Round 1 release verdict (verbatim):

> **APPROVE**
>
> Canonical plan revision **R6** and implementation diff
> `12ef2d301a91517478f6137d9fa01a6148ef63230d8fe8d83c20713929d538c8`
> pass the full-scope implementation audit. This verdict applies only to that
> exact revision and diff.

Independent audit classifications:

- Blocking findings: `No blocking findings.`
- Non-blocking findings: `None.`
- Primary-path verdict: `PASS.`
- Code-quality verdict: `PASS.`
- Chinese explanatory-comment verdict: `PASS.`

## 25. Commit Gate

This task target is `<verified-implementation>`, not a commit target. No commit
is authorized by this plan. Existing unrelated staged/unstaged changes must
remain untouched.

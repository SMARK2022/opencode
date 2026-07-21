# Canonical Implementation Plan: Semiglobal Levenshtein Diagnostic Performance

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: implementation
>
> Requirement source: User-provided Session GOAL continuation and current user request
>
> Implementation allowed: yes
>
> Last updated: 2026-07-22

This file is the sole implementation specification for the performance repair
described below. The earlier
`docs/plans/semiglobal-levenshtein-closest-match.md` remains unchanged and is
historical implementation evidence for the already-verified matcher behavior;
it is not modified by this plan.

Revision R4 resolves the R3 audit blockers by putting raw-length budget checks
before every expected-string preprocessing operation, replacing full-file
renderer prefix scans with normalized line-boundary metadata, and specifying
the exact multi-word Myers state equations and non-empty-span contract.

## 1. Verbatim Requirement

> 当前需要你检查一下我们当前的工具,edit工具,E-D-I-T工具,检查一下这个工具相应的匹配失败时的模糊匹配逻辑,检查检查其逻辑有没有得到编译时的优化。因为理论上来看,我在实测的时候,它编译的,它的匹配的速度可能能达到一到两秒的延迟。与此同时,比如说你也可以对我们项目里面的随便找一个比较长的文件夹,比较长的文件,然后使用这个命令,就是你使用 bun 的 bash 命令去测试一下相应的时长。相应的 benchmark 检测一下,看看其相应的匹配的速度大概是如何。然后提出完整方案，不会退化或者引起较大的退化，整体保持鲁棒性且修改代码文件数量不超过4个，同时代码修改量不超过800行，且测试其性能存在显著提升，且尽量能够在1s以内完成，如果实在不能完成理论上也应该有4s上限（到点搜索不到就不显示相应的actual内容），需要你完成自审确保没问题之后再提交审计，避免滥用或者消耗审计过快。上限调整为最多不超过12次审计。

The implementation target is therefore:

- Preserve the existing Edit and Apply Patch diagnostic semantics, exact and closed-normalization success paths, Tool schemas, failed-block attribution, tie suppression, Unicode/code-point behavior, CRLF mapping, and non-duplicating renderer.
- Replace the current performance-critical diagnostic implementation with one exact primary matching path whose global objective remains the minimum Levenshtein distance to a continuous content substring.
- Make the observed 150KB-class file and 50-to-400-code-point expected-block workload complete in practical millisecond latency and preferably under one second.
- Enforce a four-second diagnostic budget. If the matcher cannot finish before the budget, it must return no candidate so the existing no-reliable-candidate wording is used and no actual content is displayed.
- Keep the change to at most four code files and at most 800 substantive changed code lines.
- Verify a significant performance improvement and complete primary-agent evidence checks before independent audit. Independent audit remains mandatory; primary-agent evidence checks are not an audit substitute.
- Do not add a fuzzy replacement-success path, fallback chain, threshold retry, anchor heuristic, Tool schema change, or unrelated refactor.

## 2. Explicit Non-Goals

- Do not modify or delete `docs/plans/semiglobal-levenshtein-closest-match.md`.
- Do not modify `packages/opencode/src/tool/edit.ts`, `packages/opencode/src/tool/edit-apply.ts`, `packages/opencode/src/tool/apply_patch.ts`, or `packages/opencode/src/patch/index.ts` unless an independently proven interface drift makes the proposed route impossible; the current evidence shows no such need.
- Do not change the public Edit or Apply Patch parameter schemas.
- Do not allow the optimized matcher to perform replacement success. It remains diagnostic-only and is called only after the owning exact/closed-normalization operation fails.
- Do not add a second global matcher after the optimized matcher fails, times out, ties, or falls below the reliability threshold.
- Do not add fixed-distance retries such as `k=20`, `k=40`, `k=80`, or any threshold escalation.
- Do not use q-gram, anchor, suffix, location-biased, or context-length heuristics to discard candidates unless a later plan proves a no-false-negative filter; none is included here.
- Do not add a WASM/native dependency, `bun:ffi` integration, generated artifact, configuration setting, telemetry, migration, SDK artifact, or persistence change.
- Do not change the existing error category or add a new user-facing error message. A timeout uses the existing `No reliable nearby candidate was found...` diagnostic path.
- Do not truncate the input before matching. A timeout may suppress the actual candidate, but it may not fabricate a candidate from a shortened text.
- Do not add wall-clock assertions to the normal unit suite that are inherently flaky across CI machines. Performance acceptance is measured by a dedicated Bun benchmark with cold, warm, p50, and p95 evidence.
- Do not make a 32-bit raw-offset assumption without a repository file-size contract. The current Tool schema is `Schema.String` without an oldString length bound.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Tool, Project, Session, Patch, and diagnostic vocabulary; the affected module is `packages/opencode/src/patch` and its Edit/Apply Patch consumers. |
| `.opencode/policy/first-principles-engineering.md` | Requires repair of the first divergence, one authoritative primary path, no invented fallback, reachability evidence, and complete forward/reverse traceability. |
| `.opencode/templates/canonical-plan.md` | Defines the required plan fields, status transitions, audit contract, and 15 percent Chinese explanatory-comment gate. |
| `AGENTS.md` | Requires package-local verification, parallel investigation, and no unrequested SDK generation. |
| `packages/opencode/AGENTS.md` | Requires existing module conventions, inferred TypeScript, and package-local `bun typecheck`. |
| `packages/opencode/test/AGENTS.md` | Requires real Tool seams, independent expected values, and no implementation-coupled tests. |
| `docs/adr/README.md` and `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | No accepted ADR governs text matching; ADR-0001 is unrelated and imposes no matcher design choice. |
| `docs/plans/semiglobal-levenshtein-closest-match.md` | Records the current semantic contract and the already-verified Semiglobal Levenshtein behavior. It is read-only evidence for this performance revision. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/patch/match.ts:101-119` | Current normalization creates a string point array and raw start/end maps; code-point and CRLF mapping is part of the observable renderer contract. | observed |
| `packages/opencode/src/patch/match.ts:207-315` | Current `closestWindow` runs a full semiglobal DP, stores `MatchState` and span objects for each cell, then applies tie and score gates after the scan. | observed |
| `packages/opencode/src/patch/match.ts:148-200` | Existing actual-difference renderer must remain the output owner after a candidate span is proven. | observed |
| `packages/opencode/src/tool/edit.ts:243-265` | Failed Edit calls the shared diagnostic matcher only after `applyEdits` fails and passes the owner-selected failed edit. | observed |
| `packages/opencode/src/patch/index.ts:427-431` | Failed Patch calls the same shared diagnostic matcher with immutable persisted file content and the failed expected block. | observed |
| `packages/opencode/src/tool/edit-apply.ts:167-203,421-500` | Exact and closed-normalization matching is the Edit success owner; closest matching is forbidden from its success domain. | observed |
| `packages/opencode/src/tool/edit.ts:29-46` | `oldString` is `Schema.String` with no maximum length; an implementation must not silently assume a public length cap. | observed |
| `packages/opencode/test/tool/edit.test.ts:302-529` | Real Edit seam covers ordered distance, variable spans, CRLF/astral offsets, score threshold, no-reliable candidates, and same-distance ties. | observed |
| `packages/opencode/test/tool/apply_patch.test.ts:300-399,513-537` | Real Apply Patch seam covers failed chunk provenance, duplicate suppression, immutable original evidence, and long candidate rendering. | observed |
| R1 independent plan audit, invocation `ses_07954a8baffewXVVuSWREOtywR` | Found two blockers: the plan did not specify safe allocation/stop semantics for unbounded `Schema.String`, and its core benchmark/oracle/deadline commands were placeholders. | observed |
| R2 independent plan audit, invocation `ses_0794db061ffeMP4eGcJ71VCOC6` | Found two blockers: the benchmark did not execute the 120-point/fresh-process/full-fixture protocol, and before/after deadline checks did not bound the synchronous renderer. | observed |
| R3 independent plan audit, invocation `ses_07943244affeyI2CftvxXiw7op` | Found three blockers: expected preprocessing was before all gates, full-file renderer prefix work remained unbounded, and the Myers state/non-empty-span equations were not uniquely specified. | observed |
| `packages/opencode/package.json:9-17,131-135` | Verification uses `bun typecheck` and `bun test`; existing `diff` dependency is available and no new matching dependency is required. | observed |
| Current direct `bun -e` benchmark importing `closestWindow` | `prompt.ts` 152,543 chars with expected lengths about 39, 118, and 393 took 966ms, 2,977ms, and 8,613ms. | observed |
| Current direct `bun -e` comparison | `locateExact` took about 1.6ms, `applyEdits` failure alone about 6ms, and failure plus `closestWindow` about 2.5s on the same 152KB file. | observed |
| Current direct benchmark on `cold.ts` and `session/index.tsx` | 120-code-point expected blocks took about 2.7s and 2.2s respectively; 400-code-point blocks took about 8.3s and 7.2s. | observed |
| Optimized throwaway Bun prototype, not production code | Numeric normalization plus 32-bit multi-word Myers and bounded reverse recovery took about 11-35ms warm for the three 132-156KB files and 50-400-code-point patterns; cold samples were about 13-147ms. | observed |
| Prototype differential fuzz | 1,680 random multi-word cases across pattern word boundaries produced zero distance mismatches against scalar semiglobal DP. | observed |
| Prototype exhaustive span oracle | 32,004 binary-text/pattern cases produced zero distance or tie-decision mismatches for forward Myers plus bounded reverse start recovery. | observed |
| Bun 1.3.14, Windows x64, Ryzen 7 5800H, 8 cores/16 logical processors | Defines the machine and runtime for the observed benchmark numbers; results are not a universal latency guarantee. | observed |
| Myers, `A Fast Bit-Vector Algorithm for Approximate String Matching Based on Dynamic Programming` | Establishes the exact bit-vector compression of the Levenshtein DP and the `D[0,j]=0` semiglobal boundary. | contracted external evidence |
| Edlib HW/SHW implementation and documentation | Provides an independent engineering reference for infix matching, block carry propagation, and reverse prefix start recovery; its arbitrary start-selection policy must not be copied because this repository suppresses ties. | contracted external evidence |
| ECMAScript bitwise operation semantics | Confirms JavaScript bitwise operators operate on 32-bit integer values; multi-word carry must be explicit. | contracted external evidence |

External references used for design research:

- Myers: https://www.gersteinlab.org/courses/452/09-spring/pdf/Myers.pdf
- Edlib: https://github.com/Martinsos/edlib
- Edlib implementation: https://raw.githubusercontent.com/Martinsos/edlib/master/edlib/src/edlib.cpp
- ECMAScript numeric types: https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html
- Ukkonen: https://www.cs.helsinki.fi/u/ukkonen/InfCont85.PDF
- Bun FFI limitations: https://bun.com/docs/runtime/ffi

## 5. Current Behavior

```text
Edit Tool input
  -> read immutable file content
  -> applyEdits exact/closed-normalization primary success path
  -> failed EditApplyError identifies the failed edit
  -> EditTool calls closestWindow(contentOld, failedOldString)
  -> full semiglobal object-state DP over normalized content
  -> global tie and reliability gate
  -> existing actual-difference renderer or existing no-reliable message
```

```text
Apply Patch input
  -> Patch owner applies exact chunks against working text
  -> unresolved chunk calls withCandidate(message, persistedText, expected)
  -> closestWindow(persistedText, expected)
  -> full semiglobal object-state DP
  -> existing Patch error renderer
```

The current exact paths are not the latency source. The measured direct exact
locator and failed `applyEdits` path remain in the millisecond range. The first
slow transition is the failed-diagnostic call into `closestWindow`.

The current matcher is mathematically more expensive than necessary for its
short-pattern/long-content geometry:

- It performs `m*n` scalar cell updates.
- It creates or propagates `MatchState`, `CandidateSpan`, and tie metadata in the hot loop.
- It materializes strings for normalized code points instead of numeric code points.
- It only applies the reliability threshold after completing the full scan.
- TypeScript checking/transpilation and Bun/JSC runtime JIT do not transform this algorithm into a bit-parallel implementation.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Non-empty failed Edit `oldString` | Model Tool input | `Schema.String`; Edit validation rejects empty strings except the single create/overwrite case | `EditTool.execute` catch -> `closestWindow` | `packages/opencode/src/patch/match.ts` for diagnostic candidate | observed / contracted |
| Non-empty failed Patch expected block | Patch parser and model patch text | Parser supplies logical lines and Patch owner identifies the failed chunk | `Patch.deriveNewContentsFromChunks` -> `withCandidate` -> `closestWindow` | `packages/opencode/src/patch/match.ts` | observed / reachable |
| 132-156KB source files | File read producer | File content is supplied as a string; no matcher-specific file-size cap | Edit or Patch failure path | `match.ts` diagnostic owner | observed |
| CR, LF, and CRLF | File system and model-generated text | Existing matcher folds CR/CRLF to one normalized newline point while preserving raw boundaries | Both Tool failure paths | `match.ts` | observed / contracted |
| Astral Unicode and unpaired surrogate code points | File and model text | Existing `codePointAt` normalization compares code points and retains raw UTF-16 offsets | Both Tool failure paths | `match.ts` | observed / reachable |
| Variable candidate length | File text and expected block | Semiglobal Levenshtein permits insertion/deletion/substitution and current tests require DP-owned variable spans | Both Tool failure paths | `match.ts` | observed / contracted |
| Multiple equally-best spans | Repeated or structurally similar source text | Existing contract suppresses false precision when distinct spans tie | Both Tool failure paths | `match.ts` | observed / contracted |
| Expected block with no reliable candidate | Arbitrary model input | Existing reliability gate suppresses low-confidence output | Both Tool failure paths | `match.ts` | observed / contracted |
| Matcher exceeds four-second diagnostic budget | Large or adversarial reachable strings; no oldString schema maximum exists | User explicitly requires no actual content after the budget | Both Tool failure paths | `match.ts` diagnostic budget owner | contracted / reachable |
| Matcher working-set preflight exceeds the fixed diagnostic budget | Unbounded model/file strings at the public Tool seam | The matcher must not begin unsafe large allocations; it returns no candidate through the same existing message | Both Tool failure paths | `match.ts` diagnostic budget owner | contracted / reachable |
| Exact or closed-normalization Edit match | Model Tool input | `edit-apply.ts` owns exact success and normalization semantics | Edit primary success path does not call closest matcher | `edit-apply.ts` | observed / contracted |

The plan does not add a public length limit. The four-second budget is the
owner's diagnostic-output limit, not an input truncation or replacement rule.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| OPT-01 | The diagnostic candidate is selected by the minimum Levenshtein distance between the complete normalized expected sequence and a non-empty continuous normalized content span. | Existing Semiglobal contract, current DP, Myers formulation | Partial: ordered-distance and variable-span Edit tests |
| OPT-02 | The optimized matcher preserves insertion, deletion, substitution, variable span length, and normalized code-point semantics. | Current DP recurrence and existing renderer tests | Partial: variable span and Unicode tests |
| OPT-03 | Every distinct globally equally-best span suppresses the candidate, regardless of file order, span length, or score. | Existing tie contract and current `spans`/`tied` logic | Partial: inner tie and repeated-candidate tests; add same-end explicit case |
| OPT-04 | CRLF/CR folding and astral code points map the chosen normalized span back to the exact raw UTF-16 slice used by the existing renderer. | Existing `normalizeText` mapping and raw-offset tests | Yes for current implementation; optimized path needs revalidation |
| OPT-05 | The reliability score remains `1 - distance / max(expectedPointLength, candidatePointLength)` and the `0.5` threshold is applied only after global distance and tie decisions. | Current implementation and score-boundary tests | Yes for current implementation; optimized path needs revalidation |
| OPT-06 | The matcher remains diagnostic-only. It never performs replacement success, never mutates content, and never changes Edit/Apply Patch success semantics or failed-block attribution. | Callers and `edit-apply.ts` ownership rules | Partial: existing Tool regression suites |
| OPT-07 | If the diagnostic budget or bounded-rendering preflight expires before the candidate and rendering evidence are complete, the matcher returns no candidate; callers therefore display the existing no-reliable-candidate wording and no actual content. | Explicit user requirement and existing caller wording | Planned: deterministic oversized-workspace and oversized-renderer Tool slices plus elapsed-time harness |
| OPT-08 | The optimized primary path has no failure-triggered alternate matcher, retry, threshold escalation, location bias, or heuristic candidate filter. | User requirement, first-principles policy, current caller boundary | Partial: source path search and existing diagnostic-only tests |
| OPT-09 | The observed 132-156KB / 50-400-point workload has a significant latency improvement, preferably under one second, while the diagnostic path has a four-second hard budget. | Direct benchmark and user requirement | Planned: fresh-process benchmark command with real, random, repetitive, Unicode/line-ending, and no-reliable fixtures |
| OPT-10 | The implementation changes at most four code files and at most 800 substantive code lines. | User requirement / Session GOAL | No implementation evidence yet |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| OPT-01/OPT-09 | After exact and closed-normalization matching fail, `closestWindow` chooses an object-rich `O(mn)` DP representation for a short-pattern/long-content diagnostic scan. | `packages/opencode/src/patch/match.ts`, `closestWindow` interface | 152,543 characters × 118 points produced about 18 million cells and 2.98 seconds; direct exact matching was about 1.6ms. |
| OPT-04 | The current normalized point representation stores strings and separately tracks raw starts/ends, creating unnecessary hot-loop comparisons and allocation. | `match.ts` normalization implementation | Current lines 101-119 and prototype numeric normalization measurements. |
| OPT-07 | The matcher has no concrete deadline or working-set gate, so an arbitrarily large reachable `Schema.String` can allocate or continue diagnostic work beyond the user's requested upper bound. | `match.ts` diagnostic owner | `edit.ts:29-38` has no oldString length limit; current `closestWindow` has no budget or allocation preflight. |
| OPT-03 | The current DP carries span identity and ties through every cell, which is semantically correct but unnecessarily expensive. | `match.ts` matcher implementation | Per-cell `MatchState`/span allocation is visible at lines 215-279; an independent two-phase oracle preserves the same tie set without cell objects. |

Red-capable feedback loop already run:

```powershell
# Working directory: packages/opencode
bun -e "import { readFileSync } from 'fs'; import { closestWindow } from './src/patch/match.ts'; const content = readFileSync('./src/session/prompt.ts', 'utf8'); for (const size of [40, 120, 400]) { const block = content.slice(50000, 50000 + size); const index = Math.max(0, block.search(/[A-Za-z0-9_]/)); const expected = block.slice(0, index) + 'X' + block.slice(index + 1); const started = performance.now(); closestWindow(content, expected); console.log(JSON.stringify({ size, ms: performance.now() - started })); }"
```

Observed: 152543-character `prompt.ts` required approximately 966ms, 2977ms,
and 8613ms respectively in the 40/120/400-point runs.

The loop is red-capable for the reported symptom because it directly invokes
the actual exported matcher used by Edit and Patch and observes the measured
failure-diagnostic latency. A future implementation benchmark will retain the
same inputs and add an explicit four-second timeout assertion outside the unit
suite.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Global closest continuous-span distance | `match.ts` | `closestWindow(content, expected)` returns one reliable diagnostic candidate or `undefined` | This module already owns normalized coordinates, span identity, tie, score, and excerpt inputs. | Edit and Patch callers only know failure provenance and message context; duplicating matching would recreate the current drift. |
| Unicode/code-point normalization and raw offset mapping | `match.ts` | Candidate coordinates remain valid for the existing renderer | The matcher compares normalized points and owns the candidate span. | File readers and Tool owners must preserve raw content and must not reinterpret matcher coordinates. |
| Edit failed-block identity | `edit-apply.ts` + `edit.ts` | The diagnostic receives the actually failed edit | Already implemented and outside the performance divergence. | `match.ts` must not guess which multi-edit failed. |
| Patch failed-chunk identity and immutable evidence | `patch/index.ts` | The diagnostic receives the failed expected block and persisted content | Already implemented and outside the performance divergence. | `match.ts` must not inspect working-copy mutation history. |
| Existing user-visible error wording | Edit/Patch callers | Candidate text or existing no-reliable wording | Callers own message composition; matcher only returns `ClosestWindow | undefined`. | Changing wording in the matcher would leak presentation responsibility and violate no-new-message scope. |
| Four-second diagnostic budget | `match.ts` | Timeout produces `undefined`, never actual content | The owner can stop before renderer output and keep the public result type unchanged. | Callers do not own candidate computation timing and should not catch/synthesize alternate success. |

## 10. Single Approved Primary-Path Design

The proposed primary route is one exact diagnostic pipeline with an internal distance
phase and an internal span-recovery phase:

```text
raw content/expected
  -> raw UTF-16 length/working-set preflight before any expected preprocessing
  -> deadline-aware numeric code-point normalization + rawBoundary/line-boundary maps
  -> 32-bit multi-word Myers semiglobal forward scan
       D[0,j] = 0; scan all content; retain minimum distance and saturated end-tie count
  -> if multiple best ends, suppress candidate
  -> if one best end, bounded reverse prefix recovery of every best start length
  -> if multiple best starts, suppress candidate
  -> apply existing score formula and threshold
  -> map normalized [start,end) through rawBoundary
  -> existing line/excerpt renderer
  -> return ClosestWindow or undefined
```

The first executable operations in `closestWindow` are:

```text
deadline = performance.now() + MATCH_DIAGNOSTIC_BUDGET_MS
if (!rawBudgetAllows(content.length, expected.length, deadline)) return undefined
expectedLines = expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
if (deadlineExpired()) return undefined
if (expectedLines.length === 0 || expectedLines.every((line) => line.trim() === "")) return undefined
normalize content and expected with checkpointed passes
```

`rawBudgetAllows` reads only the already-available JavaScript string lengths,
uses `content.length` and `expected.length` as conservative upper bounds for
normalized point counts and line counts, computes
`blocksUpper = ceil(expected.length / 32)`, and applies the conservative 64MiB
estimate before `replaceAll`, `split`, `Array.from`, `String.fromCodePoint`,
typed-array allocation, profile construction, or any other input-size-dependent
intermediate. If the arithmetic is not a safe integer, it returns `false`.
Therefore an unbounded expected string cannot enter the current line-array
preprocessing before the diagnostic budget gate.

The forward pass is the primary semantic matcher. It compresses the vertical
Levenshtein state into 32-bit words and propagates addition and shift carries
across blocks. It uses the semiglobal/free-text-prefix boundary, which in the
chosen bit-vector representation means that the shifted positive vector's low
bit is zero. Copying a global Myers implementation with `| 1` at this point
would incorrectly charge skipped file prefixes and is explicitly forbidden.

The forward state equations are fixed as follows. Let `B = ceil(m / 32)`, let
`valid = m - 32 * (B - 1)`, let
`lastMask = valid === 32 ? 0xffffffff : (2 ** valid - 1) >>> 0`, and let
`topMask = 1 << (valid - 1)`. `Peq[codePoint][b]` contains bit `i % 32` in
block `b = floor(i / 32)` exactly when expected point `P[i]` equals that code
point. All block values are normalized with `>>> 0`; a bitwise signed result
must not be used as an array index or as an unnormalized mask.

```text
VP[b] = 0xffffffff for every block; VP[B - 1] &= lastMask
VN[b] = 0 for every block
score = m
bestDistance = m
bestEnd = -1
bestEndCount = 0

for each normalized text point T[j]:
  Eq[b] = Peq[T[j]][b] or 0
  carry = 0
  for b = 0 .. B - 1:
    X[b] = Eq[b] | VN[b]
    sum = (X[b] & VP[b]) + VP[b] + carry
    carry = sum >= 2^32 ? 1 : 0
    D0[b] = ((((sum >>> 0) ^ VP[b]) | X[b]) >>> 0)
  HN[b] = (VP[b] & D0[b]) >>> 0
  HP[b] = (VN[b] | ~(VP[b] | D0[b])) >>> 0
  if (HP[B - 1] & topMask) score++
  else if (HN[B - 1] & topMask) score--
  record score at text endpoint j + 1
  hpCarry = 0; hnCarry = 0
  for b = 0 .. B - 1:
    shiftedHP[b] = (((HP[b] << 1) >>> 0) | hpCarry) >>> 0
    shiftedHN[b] = (((HN[b] << 1) >>> 0) | hnCarry) >>> 0
    hpCarry = HP[b] >>> 31; hnCarry = HN[b] >>> 31
  for b = 0 .. B - 1:
    VN[b] = (shiftedHP[b] & D0[b]) >>> 0
    VP[b] = (shiftedHN[b] | ~(shiftedHP[b] | D0[b])) >>> 0
  VP[B - 1] &= lastMask
  VN[B - 1] &= lastMask
```

The addition is performed from low block to high block with JavaScript Number
arithmetic; its largest intermediate is below `2^33`, therefore it is exactly
representable. The left shift is performed from low block to high block and
propagates each source word's bit 31 into the next word's bit 0. The forward
low-bit is deliberately zero because `D[0,j] = 0` is the free content-prefix
boundary.

The endpoint counter is saturated at two. When `score < bestDistance`, it
stores the new endpoint and resets the counter to one. When `score ===
bestDistance`, it records another endpoint; the first equality also initializes
`bestEnd` when no earlier endpoint reached the initial distance `m`. A best
endpoint cannot create a false non-empty tie through the semiglobal empty
boundary: if `d < m`, an empty span has distance `m` and is not optimal; if
`d === m`, every non-empty one-point span has distance at most `m`, so each
best endpoint has a non-empty span attaining the same distance. The reverse
phase still excludes length zero explicitly.

The reverse phase is not a fallback or a second candidate search. It only
reconstructs the span identity for the already-proven global distance at the
unique best end. For each possible candidate length `L`, it computes the same
Levenshtein recurrence against the reversed expected sequence and the reversed
content prefix. The length bound is proven by
`|expectedLength - L| <= bestDistance`, so it reads at most `m + d` points and,
for non-empty content, `d <= m`, at most `2m` points. A scalar rolling row is
preferred for the first implementation because at `m <= 400` it is below one
millisecond in the prototype and avoids partial-block boundary risk in a
second bit-vector implementation. It remains the same distance recurrence,
not an alternate semantic matcher.

The reverse recovery contract is also fixed. Let `R` be the normalized content
read backward from `bestEnd`, and let `P'` be expected read backward. Initialize
one scalar row with `row[i] = i` for `i = 0..m`. For each reverse content point,
update `row` using the ordinary pairwise Levenshtein recurrence against the
prefix of `P'`; the resulting `row[m]` is the distance for that exact candidate
length. Only lengths
`L = max(1, m - d) .. min(bestEnd, m + d)` are accepted, and every accepted
length with `row[m] === d` increments the distinct-start counter. A counter of
two suppresses the candidate. A counter of one yields normalized span
`[bestEnd - L, bestEnd)`; length zero is never accepted. No second global scan
or score-based candidate selection is permitted.

The tie order is fixed:

```text
global minimum distance
  -> distinct best end detection
  -> distinct best start/length detection at the unique end
  -> unique normalized span
  -> reliability score
  -> renderer
```

The reliability score must not filter spans before tie detection. A lower-score
candidate cannot erase a globally equally-best tie.

The diagnostic budget has one owner and explicit working-set, renderer, and
deadline guards:

```text
MATCH_DIAGNOSTIC_BUDGET_MS = 4000
MATCH_WORKING_SET_BYTES    = 64 * 1024 * 1024
MATCH_RENDER_DIFF_POINTS   = 4096
MATCH_RENDER_SOURCE_UTF16  = 1024 * 1024
```

Before allocating normalized arrays, profile rows, or DP state, the matcher
performs a conservative upper-bound preflight using the raw UTF-16 lengths. It
uses two passes over each input to count normalized points, then allocates
exact-sized `Uint32Array` point storage and `Float64Array` raw boundaries only
after the estimate is safe. The estimate includes:

```text
contentPoints * 4
+ (contentPoints + 1) * 8       // raw UTF-16 boundaries
+ 2 * (contentPoints + 1) * 8   // line starts/ends upper bound
+ expectedPoints * 4
+ expectedRawLength * (blocks * 4 + 256)  // profile and expected-line overhead
+ (blocks * 7 + expectedPoints + 1) * 4  // Myers/recovery state
```

Any non-safe arithmetic or estimate above 64MiB returns `undefined` before the
large allocation. The profile is then built only for the actual distinct pattern code points.
Normalization also records exact raw line starts and line content ends in
`Float64Array` metadata. This avoids an unbounded dense allocation for the
public unlimited `Schema.String` seam while preserving the observed 50-400-point
workload well below the budget.

Before the existing renderer calls `diffChars`, the matcher applies two
rendering guards:

- The raw candidate span and the containing rendered line must each be at most `MATCH_RENDER_SOURCE_UTF16` UTF-16 units.
- The total UTF-16 upper bound of the expected/candidate inputs that could reach `diffChars` must be at most `MATCH_RENDER_DIFF_POINTS`.

These are conservative upper bounds, so astral text is never undercounted. A
guard failure returns `undefined` before actual rendering rather than falling
back to a shortened excerpt. `formatClosestDifference` receives the same
deadline and checks it before and after each bounded `diffChars` invocation;
the caller checks again before committing the resulting `ClosestWindow`. This
keeps the uninterruptible external diff call bounded by a fixed input size and
ensures an expired call cannot submit actual evidence.

The renderer must not calculate the one-based line by copying and splitting the
complete file prefix. Normalization records `lineStarts` and `lineContentEnds`
as raw UTF-16 offsets while it already scans the content. The renderer uses a
binary search over `lineStarts` for `rawStart` and `rawEnd`, selects the
containing line span from those arrays, and slices only the bounded line range.
It never calls `content.slice(0, renderStart).split(...)`, `lastIndexOf` over an
unbounded prefix, or `indexOf` across an unbounded suffix. The raw line metadata
is included in the working-set estimate and is built with the same deadline
checkpoints as normalized points.

The four-second deadline starts before preflight and is checked every 4096 raw
input code units during normalization, every 64 Myers block updates, every 256
reverse-recovery cells, immediately before and after renderer work, and after
each potentially large allocation. A deadline result is `undefined`; it does
not retry, return a partial span, or display actual content. The existing caller
wording then remains unchanged. The checkpoint frequency is part of the
implementation contract so no unbounded block loop can run between checks.

The implementation must preserve the exported `ClosestWindow` shape and all
caller signatures. No Tool schema or caller change is part of this route.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Exact Patch/Edit matching | Current | primary-contract branch | yes | Existing success domain | preserve unchanged |
| Closed normalization Edit matching | Current | primary-contract branch | yes | Existing success domain | preserve unchanged |
| Object-state semiglobal DP | Current | superseded diagnostic implementation | no replacement success | 100% current diagnostic matcher | collapse into optimized primary implementation |
| Multi-word Myers forward plus bounded reverse span recovery | Proposed | primary-contract branch | diagnostic candidate only | 100% optimized diagnostic matcher | add as the sole diagnostic implementation |
| Existing line/excerpt renderer | Current | diagnostic | no | Existing output rendering | preserve and feed only the DP-owned raw span |
| Four-second timeout returning `undefined` | Proposed | diagnostic budget/pass-through | no | only when diagnostic work cannot finish | add; no actual content and no new message |
| Typed-array scalar DP as production alternate | Proposed nowhere | forbidden fallback | no | zero | reject; retain only as test/benchmark oracle if needed outside production |
| BigInt Myers | Proposed nowhere | benchmark alternative | no | zero | reject as production path; prototype measurements were slower and it allocates BigInt temporaries |
| Ukkonen fixed band or threshold retry | Proposed nowhere | forbidden fallback | no | zero | reject; an unknown safe threshold can miss the global optimum |
| Anchor/q-gram/suffix candidate filter | Proposed nowhere | forbidden heuristic | no | zero | reject; no no-false-negative proof exists for the current unknown distance |
| WASM/native/FFI matcher | Proposed nowhere | unrelated replacement implementation | no | zero | reject for this revision; deployment cost is not justified by the measured TypeScript prototype |

The timeout is not an alternate success path. It is an explicit diagnostic
budget whose only output is the existing failure wording.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the proposed route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Per-cell `MatchState` object, `CandidateSpan`, `chooseState`, and equal-span propagation | Needed the earlier DP to carry distance, span, and tie evidence through every cell | Myers computes distance/end evidence with fixed typed arrays; bounded reverse recovery reconstructs all start lengths without retaining per-cell objects | Collapse inside `packages/opencode/src/patch/match.ts` |
| String-valued normalized point array | Made code-point and CRLF behavior explicit but adds per-point string allocation/comparison in the hot loop | Numeric code points preserve the same metric and a separate raw boundary map preserves renderer coordinates | Replace normalization internals in `match.ts` |
| Full-file scalar scan after a candidate could already be proven unreliable | Existing reliability gate was applied only after the full DP | The exact Myers pass still proves the global minimum; the budget gate prevents unbounded diagnostic output without lowering the reliability standard | Replace only the diagnostic implementation, not the success paths |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| OPT-01 global semiglobal minimum | Myers forward `D[0,j]=0` scan | `src/patch/match.ts` | Edit and Patch ordered-distance fixtures plus independent small-string oracle |
| OPT-02 variable-length edit operations | Forward distance plus bounded reverse lengths | `src/patch/match.ts` | Edit variable-span and insertion/deletion/mixed fixtures |
| OPT-03 all-span tie suppression | Saturated best-end count plus reverse length count | `src/patch/match.ts` | Same-end `expected="aa"`, `content="ba"`; multi-end `expected="a"`, `content="aa"`; existing tie fixtures |
| OPT-04 code point/CRLF/raw offset validity | Numeric normalization, `rawBoundary`, `lineStarts`, and `lineContentEnds` | `src/patch/match.ts` | Edit CRLF/astral actual-line fixture and Patch CRLF fixture |
| OPT-05 score and threshold order | Existing score formula after unique span | `src/patch/match.ts` | Existing score-boundary and low-confidence fixtures |
| OPT-06 diagnostic-only and attribution | Keep callers unchanged; only shared matcher implementation changes | `src/patch/match.ts`, existing Tool paths | Existing Edit multi-edit and Apply Patch failed-chunk tests |
| OPT-07 four-second no-actual budget | Deadline checks return `undefined` | `src/patch/match.ts` | Dedicated Bun timeout harness and Tool error assertion without actual candidate |
| OPT-07 renderer hard bound | Source/diff size guards, normalized line metadata, and deadline checks surround existing renderer | `src/patch/match.ts` | Edit large-line diagnostic suppresses actual before `diffChars`; candidate near a large-file EOF avoids full-prefix copying; elapsed-time harness remains below four seconds |
| OPT-08 no fallback/retry | One matcher path and no caller changes | `src/patch/match.ts` | Focused path search plus existing exact-success regression suite |
| OPT-09 significant performance improvement | `O(n ceil(m/32))` forward path and benchmark stages | `src/patch/match.ts` | Cold/warm Bun benchmark on real and adversarial fixtures |
| OPT-10 file/line budget | Three code files and bounded diff | `match.ts`, `edit.test.ts`, `apply_patch.test.ts` | `git diff --stat`, substantive line count, implementation audit |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Numeric code-point `Uint32Array` | OPT-01, OPT-04, OPT-09 | Current normalization and prototype timings | Current string point array preserves semantics but adds hot-loop string allocation/comparison cost. |
| `rawBoundary`, `lineStarts`, and `lineContentEnds` mapping | OPT-04, OPT-07 | Existing astral/CRLF tests and current full-prefix renderer cost | Numeric matcher indexes need raw offsets, and current line-number calculation copies an unbounded file prefix. |
| Multi-word 32-bit Myers state and carry | OPT-01, OPT-02, OPT-03, OPT-09 | Myers formulation, prototype differential, exact equations in §10 | Scalar DP cannot reduce the `m*n` cell count to `n ceil(m/32)`, and an underspecified bit-vector state could change span/tie semantics. |
| Saturated best-end counter | OPT-03 | Forward Myers exposes one score per content endpoint | Current per-cell span metadata is expensive; only zero/one/multiple is needed at the global decision. |
| Bounded reverse start recovery | OPT-03, OPT-05 | Reversal invariance and `|m-L| <= d` proof | Forward end scores alone miss same-end different-start ties such as `aa` versus `ba`. |
| Deadline-aware checks and 64MiB preflight | OPT-07 | Explicit user four-second requirement and unbounded `Schema.String` | Existing matcher has no budget or safe allocation boundary; callers cannot safely synthesize a partial diagnostic. |
| Bounded renderer gate around existing `diffChars` | OPT-07, OPT-06 | Existing renderer performs synchronous unbounded diff/array/slice work before its caller can observe a deadline | A before/after deadline check alone cannot bound an uninterruptible renderer; the owner must reject oversized diagnostic evidence before the call. |
| Existing renderer reuse | OPT-04, OPT-05, OPT-06 | `match.ts:148-200` and current Tool output tests | A new renderer would duplicate output policy and risk expected-text repetition or coordinate drift. |

No proposed production concept is justified only by general best practice or
future-proofing. The scalar DP and BigInt implementations remain test or
benchmark references only; they are not production concepts in this plan.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | modify | Replace the object-state diagnostic scan with numeric normalization, multi-word Myers forward distance, bounded reverse span/tie recovery, deadline checks, and the existing renderer handoff. Keep `ClosestWindow`, score, line, excerpt, and caller semantics stable. | +170 to +280 / -120 to -220 |
| `packages/opencode/test/tool/edit.test.ts` | modify | Add real Edit seam coverage for word boundaries, same-end tie, timeout suppression, and optimized raw-coordinate behavior; preserve existing multi-edit attribution assertions. | +60 to +130 |
| `packages/opencode/test/tool/apply_patch.test.ts` | modify | Add real Apply Patch seam coverage for multi-end tie, timeout/no-actual behavior, and shared matcher variable-span behavior. | +40 to +100 |
| All other repository files | no change | No caller, Tool schema, exact-success, parser, persistence, configuration, or generated artifact change is required by the current evidence. | 0 |

The code-file count is three, below the four-file limit. The expected
substantive code delta is below 800 lines even at the upper estimates. The
canonical plan file itself is documentation, not a code file; no other file is
authorized by this revision.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | A small independent oracle compares optimized distance and tie result for `expected="aa"`, `content="ba"`; it must identify the same-end two-span tie. | A forward-only Myers implementation would expose one best end and incorrectly claim uniqueness. | Add bounded reverse start recovery and suppress the candidate. | Same-end tie contract and no false precision. |
| 2 | Pattern lengths 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 399, and 400 are compared with an independent scalar oracle. | Incorrect block carry or final partial-block masking changes distance at word boundaries. | Implement explicit carry propagation and partial-block mask. | Multi-word arithmetic correctness. |
| 3 | A late exact or one-character-mutated candidate after a long unrelated prefix must have the same minimum distance as the scalar oracle. | Using global Myers low-bit `| 1` charges the free semiglobal prefix and can miss the actual candidate. | Use semiglobal forward boundary with zero inserted low bit. | Global search objective and late candidate discovery. |
| 4 | Variable spans shorter than, equal to, and longer than expected must produce the existing actual excerpt or the existing no-reliable result. | Fixed-length recovery would lose insertion/deletion candidates or render the wrong span. | Enumerate only lengths in the proven `[m-d, m+d]` range at the unique end. | Variable-span renderer provenance. |
| 5 | CRLF/CR plus astral text must report the existing one-based line and raw actual text. | Treating normalized point indexes as UTF-16 offsets shifts or truncates the excerpt. | Map normalized half-open span through raw boundaries before existing rendering. | Unicode and line-ending compatibility. |
| 6 | A second equally-best end and a second equally-best start both suppress output before score evaluation. | Selecting the first candidate or applying score before tie detection creates false precision. | Saturate end count and recover all start lengths before the score gate. | Tie and reliability ordering. |
| 7 | A deliberately oversized failed Edit is rejected by the deterministic working-set preflight; the Tool error contains no actual candidate text. A separate elapsed-time harness confirms the same path stays below four seconds. | Current implementation has no diagnostic deadline or allocation preflight and may continue for seconds. | Check the fixed working-set estimate before allocation, then check the deadline through normalization, scan, recovery, and rendering; return `undefined` on either budget breach. | Four-second upper bound and no actual after timeout or unsafe allocation. |
| 8 | A candidate whose raw span or diff input would exceed the renderer budget produces no actual instead of entering an uninterruptible large `diffChars` call. | Current renderer accepts unbounded line/candidate inputs and only has checks outside the renderer. | Apply conservative source/diff bounds before rendering and deadline checks around each bounded diff invocation. | Four-second upper bound includes renderer work. |
| 9 | Existing exact Edit success, closed-normalization success, Patch success, multi-edit failed-index attribution, and failed-chunk provenance remain green. | A matcher rewrite could leak into success or caller ownership. | Keep caller and `edit-apply` interfaces unchanged. | No semantic or attribution regression. |

The independent oracle is test-only and must enumerate non-empty spans on tiny
inputs with ordinary pairwise Levenshtein. It must not call optimized private
helpers or derive expected values from the implementation. Performance timing
is a separate Bun harness, not a flaky unit assertion.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 360 to 520 | Production and test substantive changes; exclude imports, blank lines, formatting-only changes, generated files, and pure moves. |
| Required qualifying Chinese explanatory comments `C` | 54 to 78 | `C >= max(1, ceil(E * 0.15))`; actual implementation audit must recount the final diff. |

Qualifying comments must explain only non-obvious decisions near their code:

- Why forward Myers uses the semiglobal zero low-bit boundary.
- How block addition and shift carries preserve the scalar recurrence.
- Why unused bits in the final block are masked.
- Why best-end and reverse-length counts are saturated at two.
- Why reverse recovery is bounded by `|m-L| <= d` and is not a fallback.
- How CRLF, astral code points, and raw UTF-16 boundaries map.
- Why timeout returns `undefined` before actual rendering.
- Why score evaluation is after global tie detection.

Comments that restate assignments, loop mechanics, identifier translations, or
test names do not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/edit.test.ts -t "closest|multi-edit|timeout"` | `packages/opencode` | Real Edit seam for candidate selection, tie, raw mapping, timeout, and failed-edit attribution. |
| `bun test test/tool/apply_patch.test.ts -t "closest|candidate|timeout|chunk"` | `packages/opencode` | Real Apply Patch seam for shared matcher output, immutable evidence, ties, timeout, and failed chunk provenance. |
| `bun test test/tool/edit.test.ts test/tool/apply_patch.test.ts test/patch/patch.test.ts` | `packages/opencode` | Focused success, atomicity, renderer, and caller regression suite. |
| `bun typecheck` | `packages/opencode` | Type safety through `match.ts` and all existing consumers. |
| `bun test test/tool/edit.test.ts -t "Myers word boundary|same-end tie|multi-end tie|variable span|CRLF"` | `packages/opencode` | Independent expected-value behavior slices for word boundaries, both tie shapes, variable spans, and raw coordinates. The test-local oracle must be scalar and independent of the production bit-vector implementation. |
| PowerShell here-string benchmark command in §18 | `packages/opencode` | Directly measures first call, warm p50/p95, and four-second upper bound on the three real long files and 50/100/120/400-point cases. |
| `bun test test/tool/edit.test.ts -t "diagnostic workspace budget|diagnostic rendering budget"` | `packages/opencode` | Real Edit Tool seam confirms deterministic oversized input or oversized renderer evidence returns the existing no-reliable message without actual content. |
| PowerShell here-string deadline command in §18 | `packages/opencode` | Directly confirms an oversized diagnostic returns `undefined` under four seconds without constructing a partial candidate. |
| `bun test` | `packages/opencode` | Package-wide regression evidence; unrelated failures must be isolated and recorded, not hidden. |
| `git diff --check` | repository root | Whitespace safety. |
| `git diff --stat` and substantive line count | repository root | Three code files and fewer than 800 substantive changed lines. |
| `git status --short` | repository root | Only the approved canonical plan and later approved implementation paths are present. |

Benchmark protocol:

- Release measurement is total end-to-end latency. Stage timings for normalization, profile construction, forward scan, reverse recovery, and renderer are optional diagnostic measurements and must not replace the total-latency result.
- Report cold first-call latency in fresh Bun processes and warm p50/p95 latency; diagnostic-only latency must not rely solely on throughput after hundreds of calls.
- Use expected lengths 50, 100, and 400 on actual 132-156KB files, with candidates at approximately 5%, 50%, and 95% positions.
- Include random source-like ASCII, repetitive tie-heavy text, CRLF/CR, astral Unicode, and no-reliable-candidate cases.
- Treat under-one-second total latency as the preferred target and four seconds as the hard no-actual budget. Do not claim a universal fixed millisecond guarantee for arbitrary unbounded `Schema.String` inputs.
- Release evidence must show at least a 4x median speedup against the recorded R1 baseline for the 120- and 400-point real-file cases, and every measured cold/p95 case must remain below four seconds. The preferred result is p95 below one second for all 50/100/400-point real-file cases; failure to reach one second is recorded as a residual performance limitation, not hidden.

### Executable Benchmark Commands

Run the following PowerShell here-string command from `packages/opencode` after
the approved implementation. It has no file writes. Every fixture/size/position
case runs in a fresh child Bun process, so each emitted `coldMs` is a real cold
sample. The child also emits 20 warm samples. The recorded R1 baseline in §4 is
the comparison baseline for the three real files.

```powershell
bun -e @'
import { readFileSync } from "fs"

const child = String.raw`
import { readFileSync } from "fs"
import { closestWindow } from "./src/patch/match.ts"

const fixture = process.env.MATCH_FIXTURE
const file = process.env.MATCH_FILE
const size = Number(process.env.MATCH_SIZE)
const position = Number(process.env.MATCH_POSITION)

function makeContent() {
  if (fixture === "random-ascii") {
    let seed = 0x12345678
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _{}();\\n"
    return Array.from({ length: 160000 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return alphabet[seed % alphabet.length]
    }).join("")
  }
  if (fixture === "repetitive") return "a".repeat(160000)
  if (fixture === "unicode-crlf") return ("😀 alpha\r\nbeta\rgamma\n").repeat(10000)
  if (fixture === "no-reliable") return readFileSync("./src/session/prompt.ts", "utf8")
  return readFileSync(file, "utf8")
}

const content = makeContent()
const points = Array.from(content)
const maximumStart = Math.max(0, points.length - size)
const offset = Math.min(maximumStart, Math.floor(maximumStart * position))
const block = points.slice(offset, offset + size)
const mutationIndex = Math.max(0, block.findIndex((point) => /^[A-Za-z0-9_]$/u.test(point)))
const replacement = block[mutationIndex] === "X" ? "Y" : "X"
const expected = block.slice(0, mutationIndex).concat(replacement, block.slice(mutationIndex + 1)).join("")
const measure = () => {
  const started = performance.now()
  const result = closestWindow(content, fixture === "no-reliable" ? "z".repeat(size) : expected)
  return { found: result !== undefined, ms: performance.now() - started }
}
const cold = measure()
const samples = Array.from({ length: 20 }, measure).map((item) => item.ms).sort((a, b) => a - b)
const p50 = samples[Math.floor(samples.length * 0.5)]
const p95 = samples[Math.floor(samples.length * 0.95)]
console.log(JSON.stringify({ fixture, file, size, position, coldMs: +cold.ms.toFixed(2), p50Ms: +p50.toFixed(2), p95Ms: +p95.toFixed(2), found: cold.found }))
`

const cases = [
  ["prompt", "./src/session/prompt.ts"],
  ["cold", "./src/storage/cold.ts"],
  ["session-index", "./src/cli/cmd/tui/routes/session/index.tsx"],
  ["random-ascii", ""],
  ["repetitive", ""],
  ["unicode-crlf", ""],
  ["no-reliable", "./src/session/prompt.ts"],
]
const sizes = [50, 100, 120, 400]
const positions = [0.05, 0.5, 0.95]
const baseline = new Map([
  ["prompt:120", 2977.1], ["prompt:400", 8612.58],
  ["cold:120", 2699.72], ["cold:400", 8296.81],
  ["session-index:120", 2176.28], ["session-index:400", 7206.66],
])

for (const [fixture, file] of cases) {
  for (const size of sizes) {
    for (const position of positions) {
      const result = Bun.spawnSync(["bun", "-e", child], {
        env: { ...process.env, MATCH_FIXTURE: fixture, MATCH_FILE: file, MATCH_SIZE: String(size), MATCH_POSITION: String(position) },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
      const row = JSON.parse(new TextDecoder().decode(result.stdout).trim())
      const old = baseline.get(`${fixture}:${size}`)
      if (old !== undefined) row.speedup = +(old / row.p50Ms).toFixed(2)
      if (row.coldMs >= 4000 || row.p95Ms >= 4000) throw new Error(`${fixture} m=${size} position=${position} exceeded 4s`)
      if (old !== undefined && row.p50Ms > old / 4) throw new Error(`${fixture} m=${size} position=${position} did not reach 4x median speedup`)
      console.log(JSON.stringify(row))
    }
  }
}
'@
```

Run this separate PowerShell here-string from `packages/opencode` to exercise
the preflight guard without allocating an unsafe matcher working set:

```powershell
bun -e @'
import { closestWindow } from "./src/patch/match.ts"

const content = "actual content\n"
const expected = "x".repeat(20_000_000)
const started = performance.now()
const result = closestWindow(content, expected)
const elapsed = performance.now() - started
if (result !== undefined) throw new Error("oversized diagnostic returned actual content")
if (elapsed >= 4000) throw new Error(`oversized diagnostic exceeded 4s: ${elapsed}ms`)
console.log(JSON.stringify({ elapsedMs: +elapsed.toFixed(2), result: null }))
'@
```

The real Tool tests named `diagnostic workspace budget` and `diagnostic
rendering budget` must use the reachable Edit failure seam and assert both the
existing no-reliable wording and the absence of the file's actual candidate
text. They must not inspect private budget constants or assert a caller count.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | This canonical plan only; no production module or generated file is added. |
| Code files modified | 3 | Shared matcher and two existing real Tool test files. |
| Code files deleted | 0 | Superseded logic is collapsed inside `match.ts`. |
| Production lines | +50 to +160 net | Numeric normalization, word-profile state, forward Myers, reverse recovery, and deadline checks replace the object-state hot path. |
| Test lines | +100 to +230 | Word-boundary, span/tie, timeout, raw-coordinate, and Tool seam behavior. |
| Total substantive code lines | <= 800 hard limit | User requirement; the implementation must stop and revise the plan if the proposed design cannot fit. |
| Generated lines | 0 | No SDK, WASM, migration, or generated artifact. |

The line budget is an audit signal and a user constraint, not permission to
omit a mapped invariant. Any required fourth code file or line-budget breach
requires a plan revision and full-scope re-audit before implementation.

## 20. Real Risks and Open Decisions

### Confirmed Risks

- Multi-word bit-vector carry and partial final-block masking can produce silent distance errors at 31/32/33 and larger word boundaries; independent oracle coverage is mandatory.
- A global Myers implementation copied without the semiglobal zero low-bit boundary charges file prefixes and violates the current objective.
- Forward best-end evidence does not detect same-end different-start ties; bounded reverse recovery is mandatory.
- `Schema.String` has no oldString maximum. The implementation must use the fixed `MATCH_WORKING_SET_BYTES = 64 * 1024 * 1024` raw-length preflight before `expected.replaceAll`, `split`, normalized arrays, profile rows, or DP state; any non-safe estimate or over-budget estimate returns `undefined` before the allocation. The profile/line-array estimate uses `expectedRawLength * (blocks * 4 + 256)` and two raw line-array upper bounds, so no unbounded dense matrix or expected-line array is attempted.
- The implementation must check `MATCH_DIAGNOSTIC_BUDGET_MS = 4000` at the specified normalization, 64-block, 256-cell, allocation, and rendering checkpoints. A timeout returns `undefined` through the existing no-reliable path, not a partial candidate.
- The existing `diffChars` call cannot be interrupted from outside, so the implementation must enforce `MATCH_RENDER_DIFF_POINTS = 4096` and `MATCH_RENDER_SOURCE_UTF16 = 1024 * 1024` before entering it, and must check the deadline before and after each bounded call. Oversized actual evidence is suppressed, not shortened and displayed.
- `Float64Array` or a normal numeric boundary array is required unless a repository file-size contract proves raw UTF-16 offsets fit in 32 bits. Silent `Uint32` wraparound is not acceptable.
- Bun/JSC is tiered; cold and warm latency can differ substantially. A warm-only benchmark cannot prove the user-visible diagnostic latency.
- The four-second budget is diagnostic-only. It must never return partial actual text, convert failure into success, or retry with a weaker matcher. The deterministic oversized-input Tool test and the executable elapsed-time harness both prove the no-actual behavior.
- Existing renderer behavior depends on the DP-owned raw span. A renderer that searches again or copies a full file prefix can drift to a different candidate, duplicate expected text, or exceed the diagnostic budget. Normalized line metadata is therefore part of the primary path.

### Open Decisions Requiring the User

None. The user has already fixed the relevant choices: diagnostic-only
behavior, no fallback, no large regression, at most four code files, at most
800 lines, preferred one-second latency, and a four-second no-actual upper
bound.

### Rejected Speculation

- A fixed exact millisecond guarantee for arbitrary file and expected-string lengths is not claimed; at least the full content must be inspected to prove a global minimum when no prebuilt index exists.
- WASM/native SIMD is not needed for the observed workload; a TypeScript multi-word prototype already reduced seconds to tens of milliseconds. It remains a possible later performance project, not this primary repair.
- BigInt is not selected because the fixed-width prototype was slower than the multi-word Number prototype and creates BigInt temporaries in the hot loop.
- Adaptive Ukkonen banding is not selected for this revision. A safe `k=m` band gives little benefit, while retrying unknown thresholds violates the single-path rule.
- Anchor and q-gram filtering are not selected because no reachable contract proves a no-false-negative filter for unknown global distance.
- Prebuilding a repository-wide text index is not selected because the current producer supplies one immutable file string per failed diagnostic and no index lifecycle/owner exists.
- AST or semantic matching is not selected because the Tool contract is text-based and the current tests/consumers require raw text evidence.

## 21. Audit Contract

The independent plan auditor must:

- Read this exact R4 file, the original user requirement, current repository state, and all affected interfaces from first principles.
- Verify the complete affected scope: `match.ts`, Edit failure path, Patch failure path, exact/closed-normalization success path, renderer, Unicode/raw mapping, ties, timeout, tests, and file/line budgets.
- Confirm that the multi-word Myers plus bounded reverse recovery is one primary diagnostic path and not a failure-triggered fallback chain.
- Confirm that the four-second budget returns no candidate and no actual content without adding a new user-facing error category.
- Check the mathematical boundary, block carry, partial final block, candidate length bound, tie order, score order, and raw UTF-16 mapping.
- Check that no Tool schema, caller ownership, success semantics, atomicity, failed-block attribution, or existing message contract is changed.
- Check forward and reverse traceability, TDD seams, benchmark evidence, actual diff budget, and the 15 percent Chinese explanatory-comment plan.
- Require evidence for every blocking finding and audit the full original scope on every revision.

The primary agent must not load the adversarial-audit skill or provide an audit
opinion. The next phase handoff contains only the original requirement, this
canonical plan path, repository root, and `Audit mode: plan`.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02 | terminology and estimate corrections | BLOCK | `ses_07954a8baffewXVVuSWREOtywR` |
| 2 | R2 | yes | B-01, B-02 | timeout test naming and plan estimate corrections | BLOCK | `ses_0794db061ffeMP4eGcJ71VCOC6` |
| 3 | R3 | yes | B-01, B-02, B-03 | benchmark baseline wording | BLOCK | `ses_07943244affeyI2CftvxXiw7op` |
| 4 | R4 | yes | none | benchmark comparability; renderer boundary specificity; fixture mutation guard | APPROVE | `ses_0793b2e92ffeTXigxLtW2I08ye` |

Any substantive revision invalidates earlier approval and requires a new
full-scope plan audit.

### R4 Independent Verdict (verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- **Benchmark baseline comparability:** The release gate compares the new warm `p50` against previously recorded single-run timings (`docs/plans/semiglobal-levenshtein-performance.md:87-90`, `:556-561`, `:630-650`). Those samples do not use the same cold/warm protocol as the proposed benchmark, so the reported `4x` speedup is directionally useful but not a fully controlled comparative measurement. A future implementation audit should report both:
  - fresh-process old-versus-new cold measurements; and
  - same-process old-versus-new warm measurements, if the old implementation remains reproducibly available.
- **Renderer boundary contract could be more explicit:** The plan requires `lineStarts` and `lineContentEnds` plus binary-search mapping (`:402-410`), but does not spell out exact handling when `rawStart` or `rawEnd` lands on a folded CRLF/CR boundary or exactly at a line terminator. Existing CRLF and astral tests provide a concrete behavioral oracle, so this is implementable and not a plan-approval blocker; the implementation audit must verify those boundary cases directly.
- **Benchmark fixture mutation guard:** The executable benchmark uses `findIndex` to select a mutation point (`:604-606`). If a generated block contains no matching ASCII identifier, `mutationIndex` becomes `-1`, producing an unintended pattern shape rather than a deliberate one-character mutation. The fixture set is likely to contain suitable characters, but the benchmark should make that assumption explicit or reject the case deterministically.

## Rejected speculation

- No blocking concern is raised about arbitrary unbounded input beyond the documented public `Schema.String` seam. The plan provides a reachable producer, raw-length preflight, working-set cap, deadline checkpoints, and existing no-reliable-candidate behavior (`:142-159`, `:356-418`).
- No fallback violation is present. The forward Myers pass and reverse recovery are specified as one diagnostic pipeline, with reverse recovery reconstructing span identity rather than launching a second candidate search (`:212-230`, `:318-340`).
- No concern is raised about preserving exact Edit/Patch success semantics. The plan keeps the matcher behind the existing failure paths and explicitly excludes caller, schema, and exact-success changes (`:42-55`, `:201-210`, `:420-421`).
- No concern is raised that the timeout itself is a success fallback. It returns `undefined` and preserves the existing no-reliable-candidate wording (`:356-418`, `:423-440`).

## Requirement and traceability coverage

- The original requirement is quoted without narrowing at `:28-30`.
- Performance investigation and the observed slow transition are identified at `:129-140`, with the diagnostic matcher isolated as the first latency divergence at `:176-183`.
- The affected producer-to-consumer paths are covered for both Edit and Apply Patch at `:107-127`, `:142-159`, and `:201-210`.
- Exact and closed-normalization success ownership is preserved and excluded from the diagnostic replacement at `:156`, `:201-210`, and `:420-421`.
- Semiglobal minimum, variable-length spans, tie suppression, score ordering, Unicode/code-point behavior, CRLF mapping, diagnostic-only semantics, timeout behavior, no-fallback behavior, performance, and file/line limits are assigned stable invariants `OPT-01` through `OPT-10` at `:161-174`.
- The Myers equations, multi-word carry, partial-block masking, semiglobal boundary, endpoint tie counting, reverse recovery, non-empty-span rule, score order, and renderer ownership are specified at `:253-417`.
- Forward traceability is present at `:450-464`; reverse traceability is present at `:466-481`.
- The file-level change set is restrained to three code files, with no caller/schema/configuration/generated-file changes at `:483-495`.
- TDD slices include independent scalar-oracle coverage for word boundaries, semiglobal behavior, variable spans, Unicode/raw coordinates, ties, timeout, renderer bounds, and success-path regressions at `:497-514`.
- Verification commands use the required package working directory and include focused tests, package tests, typecheck, benchmark, deadline harness, diff checks, and status checks at `:537-552`.
- The plan commits to the requested implementation limits and Chinese-comment gate at `:516-535` and `:680-694`.

## Primary-path and fallback verdict

- **Primary path:** One authoritative diagnostic pipeline:
  raw-length preflight → numeric normalization and raw mapping → multi-word semiglobal Myers scan → bounded reverse span recovery → tie/reliability decisions → existing renderer.
- **Success paths:** Existing exact Edit/Patch and closed-normalization success paths remain authoritative and are not replaced.
- **Fallback paths:** None proposed. The plan explicitly rejects a second matcher, retries, threshold escalation, anchors, q-grams, BigInt production matching, and native/WASM alternatives at `:423-440`.
- **Diagnostic path:** Timeout and renderer-budget rejection return `undefined`; they do not synthesize candidate text, mutate content, or hide a successful operation.
- **Ownership:** Matching, normalization, raw-coordinate mapping, deadline enforcement, and renderer admission remain in `packages/opencode/src/patch/match.ts`; Edit and Patch callers retain failure attribution and message composition.

## Release verdict

**APPROVE** — Canonical plan revision **R4** has no blocking findings and is suitable for implementation under the stated scope. This approval applies only to the exact audited R4 plan. Implementation remains disallowed until the canonical metadata records approval for R4, and the resulting implementation requires a separate full-scope implementation audit.

## 23. Implementation Evidence

Complete only after an approved revision is implemented.

### Actual Files and Diff

The implementation changed exactly three code files plus this canonical plan:

| File | Diff | Responsibility |
| --- | --- | --- |
| `packages/opencode/src/patch/match.ts` | `+352/-124` | Raw budget preflight, Unicode/CRLF normalization, numeric multi-word Myers scan, bounded reverse span recovery, tie/score gates, raw-boundary renderer admission, and deadline checks. |
| `packages/opencode/test/tool/edit.test.ts` | `+163/-0` | Real Edit seams for renderer/workspace budgets, word boundaries, raw offsets, large prefixes, ties, and an independent exhaustive scalar oracle over 3,844 tiny cases. |
| `packages/opencode/test/tool/apply_patch.test.ts` | `+31/-0` | Real Apply Patch multi-end tie and immutable failed-file evidence. |

The code diff is `+546/-124` lines (`670` changed lines by diff stat), below the requested 4-file and 800-line limits. No caller, Tool schema, exact/closed-normalization path, fallback matcher, success path, dependency, generated file, or migration was changed.

### Red-Green Test Evidence

The renderer-budget test first produced the intended red signal with a deterministic 2,200-character single-mismatch fixture: the old behavior emitted `Closest match at line 1`, while the test required the existing no-reliable message. After the bounded renderer admission/deadline path was implemented, it passed and no actual text was exposed.

The independent scalar oracle is test-local, enumerates every non-empty span, uses ordinary pairwise Levenshtein, and does not import private matcher helpers. It compares public `closestWindow` candidate existence, line, and score for every binary content/expected input of lengths 1 through 5: `3,844` cases and `3,844` expectations passed.

### Verification Commands and Results

| Command | Result |
| --- | --- |
| `bun test test/tool/edit.test.ts -t "exhaustive scalar span oracle"` | `1 pass`, `0 fail`, `3,844 expect()` calls, `3.97s`. |
| `bun test test/patch/patch.test.ts test/tool/apply_patch.test.ts test/tool/edit.test.ts` | `147 pass`, `0 fail`, `4,244 expect()` calls. |
| `bun typecheck` | Exit `0` (`tsgo --noEmit`). |
| `git diff --check` | Exit `0`. |
| Fresh-process benchmark from §18 | `84` child-process cases across three real long files plus random ASCII, repetitive, Unicode/CRLF, and no-reliable fixtures; every cold and p95 sample was below 4 seconds. Real-file 120-point p50 speedups were `9.87x-117.30x`; 400-point p50 speedups were `9.29x-183.00x`. The largest observed p95 was `1,391.89ms`, so some 400-point cases exceed the preferred 1-second p95 but remain below the 4-second hard bound. |
| Oversized deadline/working-set harness | A 20,000,000-character expected input returned `undefined` in `0.69ms`; no candidate text was constructed. |
| Package-wide `bun test` | The direct package command was allowed to run for 900 seconds but did not complete. It reported unrelated Project/Worktree/Reference/Server/control-plane failures and 5-second test timeouts, including a bare-repository cache assertion, worktree name mismatch, reference refresh timeout, CORS timeout, and a foreign-key constraint failure. No failure referenced the three changed matcher/test files; the focused matcher suite above remains green. |

### Original Feedback-Loop Result

The original direct `closestWindow` loop on the 152KB `prompt.ts` fixture took approximately `966ms`, `2,977ms`, and `8,613ms` for expected lengths about `39`, `118`, and `393`. The optimized loop measured approximately `181.52ms`, `41.44ms`, and `427.42ms` on the corresponding `40`, `120`, and `400` cases. The full fresh-process benchmark confirms the improvement across cold, warm p50, and p95 samples without changing the diagnostic-only ownership.

### Actual Secondary and Replacement Path Inventory

No secondary success or fallback path was added. `closestWindow` remains called only after the owning exact/closed-normalization operation fails. Its sole diagnostic primary path is raw O(1) preflight, normalization, multi-word Myers, bounded reverse recovery, tie/score gating, and the existing renderer; any budget, tie, score, or renderer rejection returns `undefined`. `packages/opencode/src/tool/edit.ts`, `packages/opencode/src/tool/edit-apply.ts`, `packages/opencode/src/tool/apply_patch.ts`, and `packages/opencode/src/patch/index.ts` were not modified, so caller failure attribution and failed-chunk provenance remain owned by their existing paths.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | `532` | Added and deleted substantive lines across the three code files; imports, blank lines, comments, and pure formatting/moves excluded. |
| Qualifying Chinese comment lines `C` | `80` | Added comments counted only when they explain a non-obvious invariant, boundary, budget, tie, compatibility, or test intent near the changed code. |
| Ratio `C / E` | `15.04%` | `80 / 532`. |
| Required minimum `C` | `80` | `ceil(532 * 0.15)`. |

### Remaining Unverified Items

- The package-wide direct `bun test` command did not complete within 900 seconds and has the unrelated failures listed above; no matcher-specific failure was observed.
- Some 400-point benchmark p95 samples are above the preferred 1-second target, but all measured cold/p95 samples stayed below the required 4-second upper bound.
- Historical baseline values use a different measurement protocol from the fresh-process/warm-p50 benchmark, so the speedup evidence is directional rather than a fully controlled old-versus-new experiment.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | Yes | None | Baseline protocol is not fully identical; some 400-point p95 samples exceed 1 second while staying below 4 seconds; package-wide suite is environmentally incomplete. | `No blocking findings`; `APPROVE` | `ses_0790a1abaffedjwlDmvdXR2ozn` |

### Verbatim Implementation Audit Verdict

> **APPROVE** — The exact audited R4 implementation diff has no blocking findings and satisfies the original behavioral, primary-path, scope, performance, budget, Unicode/CRLF, tie, attribution, renderer, test-independence, typecheck, and comment-gate requirements. The package-wide test command remains environmentally incomplete with unrelated failures, but the changed matcher and Tool surfaces pass the complete focused verification suite.

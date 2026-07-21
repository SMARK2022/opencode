# Canonical Implementation Plan: Read tool post-window I/O policy

> Status: verified
>
> Revision: R12
>
> Approved revision: R12
>
> Audit mode: full-scope
>
> Requirement source: 请检查检查这是不是有这个现象存在,也就是即使相应的流是,方面,它仍然遍历整个文件。请检查检查这种问题如果在大文件上是否存在,或者严重。比如说一个20兆的文件,它是否会直接全部遍历到最后一行?请检查检查。以及请你看看当前的返回的行为信息的内容,它对于当前的内容而言,是否有办法或者有可能进行优化。也就是理论上有的时候,可能后半部分或者后一大半的内容并不影响整个read工具的返回,请检查检查。请注意不要进行具体的代码修改,但是请你进行完整的调研,以及给出完整的修改方案。
>
> User refinements: 细化 R3（非推倒）；成本感知操作而非无脑停读；克制 schema/零迁移；审计更严；正常内容预算用完后允许额外读取 256KiB 辅助内容；用户额外授权 6 轮方案审计。
>
> Implementation allowed: yes
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

请检查检查这是不是有这个现象存在,也就是即使相应的流是,方面,它仍然遍历整个文件。请检查检查这种问题如果在大文件上是否存在,或者严重。比如说一个20兆的文件,它是否会直接全部遍历到最后一行?请检查检查。以及请你看看当前的返回的行为信息的内容,它对于当前的内容而言,是否有办法或者有可能进行优化。也就是理论上有的时候,可能后半部分或者后一大半的内容并不影响整个read工具的返回,请检查检查。请注意不要进行具体的代码修改,但是请你进行完整的调研,以及给出完整的修改方案。

Follow-on refinements retained:

1. Refine prior approved direction; do not treat it as fundamentally wrong.
2. Cost/need-aware post-window policy (not blunt always-break-only).
3. Minimize schema: **zero new `ReadMetadata` fields**, no migrations.
4. Plan-only until R12 is independently re-approved.
5. After the normal `MAX_BYTES` content budget is consumed, allow up to an additional `256 KiB` of post-window input for count-only auxiliary work; this auxiliary input must never be appended to returned content.

## 2. Explicit Non-Goals

- No production edits in this plan-only phase.
- No new `ReadMetadata` fields; no message/DB/SDK migration.
- No dual readers, background totals, line indexes, size→line oracles as authoritative total.
- No free high-offset; no binary/image/PDF/directory/permission redesign.
- No mandatory stub skip of `lines()`.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | Tool results → message metadata → stubs / compaction display |
| `read.txt` | 200 lines / 16KB / `<range>` / `<more>` |
| `read.ts` | `lines()`, render, stubs; `more` means **content remainder** today; `MAX_BYTES=16 KiB` is the returned-content budget |
| Current worktree `ReadMetadata.fp?` | Existing optional head-sample identity field; preserve it and its legacy-compatibility behavior; R8 adds no further metadata field |
| `read.test.ts` | Truncation keeps `<more>` **and** can expose exact total on small files |
| R1–R4 audits | Stub ownership; R4 BLOCK on `more` cleared after cheap count |

## 4. Evidence

| Evidence | Class |
| --- | --- |
| `lines()` post-window `continue` to EOF for exact `count` | observed |
| execute: `truncated = more \|\| cut`; `<more>` when truncated | observed |
| tests: limit truncation requires more **and** exact total on 100-line file | observed |
| 20MB harness: full I/O after window fill | observed |
| R4 B-01: plan wrongly set `more=false` on stream EOF after count-only | reachable |

### Red signal

20MB head read: `returned=200`, `more=true`, full `bytesRead`, exact `count`.

### Revision posture

| Rev | Result | Material note |
| --- | --- | --- |
| R1–R2 | BLOCK | stub EOF / covering total ownership |
| R3 | APPROVE | closed stubs with new metadata field |
| R4 | BLOCK | Option C good; **`more` conflated with stream EOF** |
| R5 | BLOCK | sticky `more` closed; medium ~100KiB fixture wrongly mapped to lower-bound |
| R6 | BLOCK | fixture branch split fixed; missing **lower-bound covering** stub red fixture |
| R7 | APPROVE | add large-remainder covering + nested covered stub lock (INV-06/10) |
| R8 | BLOCK | 256KiB budget escaped through an arbitrary complete `readline` line; outline gate created an unbudgeted second scan |
| R9 | BLOCK | monitor starts after the first oversized post-window line; threshold allows two read-ahead chunks; lower-bound totals suppress existing large-source outline |
| R10 | BLOCK | cumulative content admission, unterminated auxiliary-line lower bound, and lone-CR compatibility remain incomplete |
| R11 | BLOCK | full Read Tool auxiliary budget, physical I/O observation, and CR/CRLF boundary state remained incomplete |
| R12 | this | share one bounded line parser and one auxiliary budget across page counting and outline; add an internal physical-I/O seam |

## 5. Current Behavior

```text
lines: after window fill → more=true; continue count to EOF (unbounded I/O)
total = count always exact
truncated/more track content remainder (stay true if page incomplete even while counting)
```

## 6. Domain / Reachability

Head/mid/high-offset text pages; cheap small-file truncation; expensive multi‑MB head; covered/same stubs; outline first page; compaction display of `total`.

## 7. Invariants

| ID | Invariant |
| --- | --- |
| INV-01 | Do not pay unbounded post-window I/O only to refine exact line totals; after the content window fills, the single chunk parser consumes at most `256 KiB` post-window bytes plus one configured `highWaterMark` read-ahead chunk, including oversized-line input. Required prefix and normal-window bytes remain outside this post-window budget. |
| INV-02 | Returned content admission remains cumulative: `contentBytes + separatorBytes + candidateEncodedBytes <= MAX_BYTES`; auxiliary bytes never increase `raw` or the returned content budget. |
| INV-03 | **`more` / top-level `truncated` mean returned content is incomplete relative to the file**, not “stream not fully scanned”. If the content window filled (limit or byte cut) and unread content remains, keep `more=true`, emit `<more>`, `metadata.truncated=true` **even if** a cheap count-only tail later reaches physical EOF and makes `total` exact. |
| INV-04 | `more=false` only when the **returned page includes the last line of the file** (content-complete). Stream EOF during count-only must **not** clear `more`. |
| INV-05 | Offset past EOF fails. |
| INV-06 | Stubs: no false EOF; no offset past true EOF when coverage finished the file. |
| INV-07 | The outline owner keeps its existing `MIN_LINES=600` gate; `more` alone does not authorize a new outline scan when the bounded count is below that gate. |
| INV-08 | Non-total contracts compatible. |
| INV-09 | Schema-free exactness for EOF: content reached file end ⇔ **`returned > 0 && end === total`** (empty file: `total===0`). Lower-bound early-stop pages use **`total >= end + 1`**. Cheap count-only with content remainder: **`end < total`** with exact `total` and `more=true`. |
| INV-10 | Covered stubs: published `total` + next offset owned by **covering** `end`/`total`. |
| INV-11 | No new `ReadMetadata` fields; no migration. |
| INV-12 | The normal returned-content budget remains `16 KiB`; the additional `256 KiB` is count-only/auxiliary input and cannot increase `raw`, output content, or the public metadata shape. |
| INV-13 | The outline scanner keeps its existing `MIN_LINES=600` eligibility and `MAX_SCAN_LINES=3000` cap; the optimized path may conservatively omit outline when the bounded lower-bound count has not reached 600. |
| INV-14 | When the auxiliary boundary interrupts an unterminated logical line, the parser records one observed unread line (`total >= end + 1`) before stopping; stub EOF logic must treat it as lower-bound, never exact EOF. |
| INV-15 | Text line boundaries preserve current `readline` behavior for LF, CRLF, lone CR, empty lines, and a terminal unterminated line. |
| INV-16 | The single `256 KiB` auxiliary budget is shared by post-window page accounting and any outline scan performed during the same `ReadTool.execute`; no auxiliary consumer can bypass it. |
| INV-17 | Physical post-window bytes are observable at an internal parser seam for deterministic tests, but no byte counters enter `ReadMetadata`, Tool output, Message schema, or persistence. |

## 8. Root Cause

First divergence: `lines()` continues past the content window to EOF solely for exact `count` (unbounded on large files).

Co-repairs (same contract, not fallbacks): stub covering ownership under non-exact-or-exact totals; keep `more` as content-remainder signal under cost-aware counting.

## 9. Ownership

| Concern | Owner |
| --- | --- |
| Post-window I/O + `more`/`total` | `lines()` / execute |
| Stub navigation | `findReadStub` + `renderReadStub` + execute stub wiring |
| Outline eligibility | call site / `readOutline` gate (runtime only) |

## 10. Primary Design

### Operations analysis (unchanged preference)

| Option | Verdict |
| --- | --- |
| A always full-count | reject (20MB cost) |
| B always hard-break | coarser; loses free exact totals on small files |
| **C bounded post-window auxiliary scan** | **primary** |
| D dual APIs / new exactness field | reject |

### Primary algorithm

```text
const AUXILIARY_SCAN_BYTES = 256 * 1024
const AUXILIARY_READ_AHEAD_BYTES = 16 * 1024

type AuxiliaryBudget = { remaining: number }

type ReadPage = {
  raw: string[]
  count: number
  cut: boolean
  more: boolean
  offset: number
  physicalBytesRead: number
  postWindowBytes: number
}

readTextPage(filepath, { limit, offset }, budget):
  stream = createReadStream(filepath, { highWaterMark: AUXILIARY_READ_AHEAD_BYTES })
  decode UTF-8 incrementally and recognize LF, CRLF, and lone CR in this one parser
  raw=[], contentBytes=0, count=0, cut=false, more=false
  mode="content"
  lineState = { sourceStart, sourceEnd, hasBytes, counted, pendingCR }
  for each source chunk while mode === "content" || budget.remaining > 0:
    content-mode prefix and accepted page bytes do not consume auxiliary budget
    auxiliary-mode bytes consume the shared budget; at most one configured
      read-ahead chunk may cross the 256KiB boundary
    split bytes at LF / CRLF / lone CR, carrying a CR-at-chunk-end state
    for each complete line or observed partial line:
      count the line once; the first byte of an unterminated auxiliary line
        counts as one observed unread line before the budget stop
      skip until offset
      candidateBytes = Buffer.byteLength(decodedLine, "utf8")
      separatorBytes = raw.length > 0 ? 1 : 0
      if raw.length >= limit || cut:
        more = true
        mode="auxiliary" starting at the first rejected source byte
        discard line text; decrement budget by this line's source interval
      else if contentBytes + separatorBytes + candidateBytes <= MAX_BYTES:
        push line; contentBytes += separatorBytes + candidateBytes
      else:
        cut = true; more = true
        mode="auxiliary" starting at the first rejected source byte
        discard line text; decrement budget by this line's source interval
      after either rejected-line branch, stop before requesting another source
        chunk once the shared budget is exhausted
    while a content-mode candidate line is partial, switch to auxiliary
      immediately when cumulative candidateEncodedBytes would exceed MAX_BYTES;
      do not wait for its delimiter or assemble the whole oversized line
  if a terminal unterminated line exists at EOF, count it once like `readline`
  if a partial auxiliary line exists at the budget boundary, retain its count
    as a lower bound and do not append its text to raw
  return ReadPage including physicalBytesRead and postWindowBytes for internal tests

```

This replaces `readline` as the one authoritative text-line path; it is not a
second success reader or a fallback. `readTextPage` and `readOutline` consume
the same `AuxiliaryBudget` object during one `ReadTool.execute`. The outline
consumer performs no stream read when the shared budget is exhausted. The
parser preserves current UTF-8, LF, CRLF, lone-CR, empty-line, offset,
terminal-unterminated-line, and cumulative content-byte-cap behavior. It never
assembles an entire oversized auxiliary line. `ReadPage` is an internal test
seam; `physicalBytesRead` and `postWindowBytes` never enter Tool metadata.

### Delimiter and budget state table

| Boundary | Required transition |
| --- | --- |
| LF | End the current logical line and count it once. |
| CR followed by LF | Treat the pair as one delimiter and count one line. A CR at a chunk/budget edge may consume the next byte from the single read-ahead chunk. |
| CR followed by non-LF | Treat CR as a lone delimiter; the non-LF byte starts the next line and, if auxiliary, establishes its lower-bound count. |
| CR at physical EOF | Treat CR as a lone delimiter; do not synthesize an extra trailing empty line. |
| UTF-8 sequence split at chunk edge | Carry decoder state. If the auxiliary boundary stops before completion, discard the partial character/text but keep the observed-line lower bound. |
| Empty line | A delimiter with no preceding content counts one empty line; a final delimiter does not create another line after EOF. |
| Unterminated line at EOF | Count the line once, matching current `readline` behavior. |
| Unterminated line at auxiliary stop | Count the line once as observed unread content; publish lower-bound `total`, keep `more=true`, and prohibit EOF stub prose. |

### Semantic split (R4 B-01 fix)

| Flag / field | Meaning after policy |
| --- | --- |
| `more` / `cut` | Content window incomplete (unread file content beyond returned page) |
| `total` | Exact whole-file line count if the bounded auxiliary scan reaches EOF; otherwise a lower bound (`>= end+1`) when the 256KiB auxiliary budget or its read-ahead boundary is exhausted |
| top-level `truncated` | `more \|\| cut` (existing) |
| `<more>` | emitted when `truncated` (existing) |

**Never** clear `more` merely because count-only reached physical EOF.

### Schema-free EOF for stubs

```text
totalExact(m) :=
  (m.total === 0 && m.end === 0) ||
  (m.returned > 0 && m.end === m.total)

// cheap count-only truncated: end < total → totalExact false → no false EOF
// complete page: end === total → true
// early-stop lower bound: total >= end+1 → false
// legacy full-scan truncated: end < total → false
```

### Stub ownership

```text
same_range:  publishedTotal=current.total; visibleEnd=current.end
             reachedEof = totalExact(current) && visibleEnd >= publishedTotal
covered:     publishedTotal=covering.total; visibleEnd=covering.end
             reachedEof = totalExact(covering) && covering.end >= covering.total
             nextOffset = covering.end + 1 if !reachedEof
metadata.read.total = publishedTotal  // no new fields
```

### Outline

Preserve the existing outline owner contract: `offset <= 1`, source extension,
and `total >= MIN_LINES` are still required before the outline scan. Do not
replace `MIN_LINES` with `more`; `more` only proves one unread line. The
production call passes the same `AuxiliaryBudget` used by `readTextPage` into
`readOutlineCached`. A cache hit consumes no budget; a cache miss with no
remaining budget returns no outline without opening a stream; a budget-limited
outline result is not cached as a complete result. The outline parser uses the
same chunk line-framing path and retains `MAX_SCAN_LINES=3000`, so the entire
Read Tool auxiliary surface shares the 256KiB allowance.

### Docs (`read.txt`)

- `<more>` means more **content** remains; use `offset` to page.
- `total` is exact when the tool finished line accounting; when the tool early-stops on a large remainder, `total` is a lower bound (`≥ end+1`). Presence of `<more>` alone does not imply `total` is inexact (cheap count-only may yield exact `total` with `<more>`).

### Examples

1. **20MB head, limit 200:** window fills → consume at most 256KiB auxiliary input → break; `more=true`; `total>=end+1`; content OK.  
2. **100-line file, limit 10, file ≪ budget:** window fills → count-only to EOF → `more=true`; `total=100` exact; `<more offset=11>`.  
3. **50-line file, limit 50:** content hits EOF → `more=false`; `total=50`; no `<more>`.  
4. **Covering 1–10 of 100 with cheap exact total 100 + nested covered stub:** published total 100; next offset 11; not EOF.  
5. **Covering complete 1–50 of 50:** nested covered stub → EOF prose.  
6. **Large-remainder covering (required red lock):** multi‑MB covering page consumes the 256KiB auxiliary budget and stops, e.g. limit 100 → `end=100`, lower-bound `total>=101`, `more=true`; nested covered re-read inside 1–100 → stub publishes the **covering** `total` (not nested weaker bound), next offset **101**, **no** “end of file reached”.

## 11. Secondary Paths

| Path | Class | Disposition |
| --- | --- | --- |
| Count-only within 256KiB vs bounded break | primary domain branches | implement |
| Always full-count | superseded | remove as default |
| Always hard-break only | rejected as sole policy | — |
| New metadata exactness field | over-design | reject |

## 12. Workarounds Removed

Unbounded post-window full-count; R3 extra `ReadMetadata.truncated`; R4 `more=false` on stream EOF after count-only; R7 remaining-tail decision band.

## 13. Forward Traceability

| ID | Path | Test |
| --- | --- | --- |
| INV-01 large remainder | bounded chunk scan, then stop at the first chunk boundary after the auxiliary budget | **Large** fixture: multi‑MB: `more` + `total>=end+1` + `total < trueN`; verify no post-window physical input beyond `256KiB + 16KiB` |
| INV-01/03/04 small | count-only until EOF when EOF arrives within 256KiB | (a) short 100-line limit 10: **more true**, exact total 100, `<more>`; (b) existing ~100×1KiB byte-truncation: exact total 100 + sticky `more`/`truncated`/`<more>` |
| INV-02/05/08/15 | cumulative content admission + offset/error/line semantics | existing suite plus CR-only and terminal-unterminated fixtures |
| INV-06/09 complete EOF | totalExact end===total | complete-file same/covered EOF stubs (small full-file fixtures) |
| INV-06/10 lower-bound covered | covering-owned total under bounded early-stop | **Large-remainder covering** page that exhausts the 256KiB auxiliary budget + nested covered stub: published `total === covering.total` (lower bound), `nextOffset === covering.end+1`, **no** EOF prose; must not use nested `total` for `reachedEof` |
| INV-07/13 | existing `MIN_LINES` + `MAX_SCAN_LINES` gate | outline regression: a `<600`-line source with `more=true` does not gain a new outline scan; bounded count reaching 600 keeps existing eligibility |
| INV-11 | no new fields | type/shape unchanged |
| INV-12/14 | 16KiB cumulative content + 256KiB auxiliary cap | multiline 1KiB candidates remain within 16KiB; oversized and unterminated-line fixtures assert bounded stream input and `total>=end+1` |
| INV-16 | shared execute-level budget | source fixture where page accounting consumes part/all of budget: outline consumes only the remainder or skips without opening another stream |
| INV-17 | internal physical-I/O seam | direct real-file `readTextPage` test asserts `postWindowBytes`/`physicalBytesRead`; Tool-level test separately asserts unchanged public metadata shape |

**Budget rule (locks R12):** lower-bound tests use files materially larger than `MAX_BYTES + 256KiB`; cheap exact-total+more tests use files that reach EOF within the 256KiB post-window logical budget (including the current ~100×1KiB byte fixture). Oversized and unterminated-line tests use a single line larger than 256KiB and assert physical stream bytes stay within `256KiB + 16KiB`, `total>=end+1`, and no complete arbitrary line is assembled. Page accounting and outline tests use one shared budget object.

## 14. Reverse Traceability

| Concept | IDs |
| --- | --- |
| bounded auxiliary scan + budget constant | INV-01/12 |
| more sticky after count-only EOF | INV-03/04 |
| total lower bound vs exact | INV-09 |
| covering-owned stub total | INV-10 |
| existing outline MIN_LINES/MAX_SCAN_LINES gate | INV-07/13 |
| zero new metadata fields | INV-11 |
| bounded chunk line parser + read-ahead allowance | INV-01/12 |
| cumulative candidate admission + partial-line count | INV-02/14 |
| LF/CRLF/lone-CR parser state | INV-15 |
| shared mutable auxiliary budget | INV-16 |
| internal ReadPage physical counters | INV-17 |
| exported module-local `readTextPage` test seam | INV-17; no existing Tool path exposes physical input | required to make the original full-scan regression red without adding Tool metadata |

## 15. File Plan

| File | Change | Δ |
| --- | --- | --- |
| `read-lines.ts` | add one shared chunk line-framing parser, auxiliary budget, `ReadPage` diagnostics seam | ~140-240 |
| `read.ts` | delegate page read; create/pass shared budget; sticky more; covering stub total; comments | ~50-100 |
| `read-outline.ts` | consume shared remaining budget/cache rules while preserving MIN/MAX line gates | ~30-70 |
| `read.txt` | total/more wording | ~4-10 |
| `read.test.ts` | real-I/O seam; shared page/outline budget; oversized boundaries; UTF-8/CR/LF; cheap exact+more; stubs; outline gate regression | ~170-300 |

## 16. TDD Slices

| # | Red → Green |
| --- | --- |
| 1 | **Large remainder** (multi‑MB): consume bounded auxiliary scan; more + lower-bound `total>=end+1` + `total < trueN` + stop |
| 2 | **Cheap limit truncation** (e.g. 100 short lines, limit 10): more+truncated+`<more>` + **exact** total |
| 3 | **Cheap byte truncation** (~100×1KiB existing fixture): more+truncated+`<more reason=byte_limit>` + **exact** total 100 (not lower-bound) |
| 4 | Full file → !more + exact total |
| 5 | Complete-file EOF stubs (small full file) |
| 6 | Covered **cheap** truncated navigation (exact covering total + next offset; no EOF) |
| 7 | Covered **large-remainder / lower-bound** covering + nested covered: published total = covering total; offset = covering.end+1; **no EOF prose** (INV-06/10 red lock under R12) |
| 8 | Oversized **unterminated** post-window line cannot consume beyond `256KiB + 16KiB`; parser publishes `total>=end+1`, no arbitrary complete line is assembled, and a subsequent stub cannot claim EOF |
| 9 | UTF-8, LF/CRLF/**lone-CR**, empty lines, terminal unterminated lines, offsets, and byte/line caps preserve existing behavior |
| 10 | Outline `<600` lines with `more=true` stays suppressed; bounded observed count reaching 600 keeps existing eligibility |
| 11 | Page accounting and outline share one 256KiB budget; cache hit costs zero, exhausted budget opens no outline stream, budget-limited outline is not cached complete |
| 12 | Real-file parser seam reports physical/post-window bytes and current full-scan implementation fails the bound before implementation |

## 17. Chinese Comment Budget

E≈220–380; C≥ceil(0.15E). Comment: sticky more vs stream EOF; cumulative 16KiB admission; shared 256KiB budget; partial-line lower bound; LF/CRLF/lone-CR state; physical test seam; outline cache/budget ownership; covering stub total; no Tool schema field.

## 18. Verification

`bun test test/tool/read.test.ts` and `bun typecheck` in `packages/opencode`.

## 19. Diff Budget

4–5 files; ~220–380 prod / ~170–300 test; **0 Tool metadata/schema fields; 0 migrations**.

## 20. Risks

| Risk | Mitigation |
| --- | --- |
| Auxiliary budget | Fixed 256KiB after the returned-content window plus one explicitly configured 16KiB read-ahead chunk |
| Oversized line | Chunk parser never assembles post-window line text; partial-line observation publishes a lower bound before stopping |
| Mis-mapping medium fixtures to lower-bound | ~100KiB stays cheap exact+more; only files larger than content+256KiB assert lower-bound |
| High-overlap nested total | non-blocking (no EOF-from-total) |
| Outline eligibility | existing `MIN_LINES=600` and `MAX_SCAN_LINES=3000` remain unchanged |
| Outline cache | budget-exhausted/partial scans do not poison the version cache; existing complete cache hits consume no budget |

### Open user decisions

None for defaults.

### Rejected speculation

Indexes; dual APIs; migrations; free high-offset; mandatory stub I/O skip; treating auxiliary bytes as returned content; broadening outline eligibility from `MIN_LINES` to `more`.

## 21. Audit Contract

Harsh on: schema growth, dual success paths, `more` semantics, stub ownership, cumulative 16KiB admission, exact 256KiB auxiliary boundary, partial-line lower bounds, LF/CRLF/lone-CR compatibility, read-ahead accounting, outline ownership, physical-I/O observation, and budget-unbounded regressions. Full original scope each round. Re-verify R4 B-01 and INV-12–17.

The user explicitly authorizes six additional plan-audit rounds beyond the
repository default for this task. The effective plan-audit allowance is 12
rounds; the extra allowance does not weaken full-scope evidence or approval
requirements. Before each auditor handoff, the primary agent performs a
separate consistency/readiness QA pass. That QA is not an approval substitute
and is not included in the auditor handoff.

## 22. Plan Audit Record

| Round | Rev | Blocking | Result | Ref |
| --- | --- | --- | --- | --- |
| 1 | R1 | false EOF | BLOCK | ses_07e42dec6ffePKZKeWQkO527Na |
| 2 | R2 | nested total vs covering offset | BLOCK | ses_07e3e7a5effe4IKG7HhqOkv9ly |
| 3 | R3 | none | APPROVE | ses_07e3a0646ffeamyZJFoajbqpQF |
| 4 | R4 | more cleared after cheap count-only EOF | BLOCK | ses_07e2f70dbffe1nHTf59qsszJbF |
| 5 | R5 | ~100KiB byte fixture wrongly retargeted to lower-bound under 64KiB budget+HWM | BLOCK | ses_07e2a518affeTRdP1T8h1wRH3S |
| 6 | R6 | lower-bound covering stub not locked by large-remainder fixture | BLOCK | ses_07e21d2e0ffeqrMCD9iGEsP2By |
| 7 | R7 | No blocking findings. | N-01 plan audit round count 7; N-02 remainderProven optional default false; N-03 outline gate slightly wider; N-04 slice 7 red only after early-stop | APPROVE | ses_07e16d5c5ffeqrHJ5dCfTgtgmt |
| 8 | R8 | 256KiB escaped through arbitrary readline line; outline gate introduced unbudgeted second scan | BLOCK | ses_07de775a2ffeYTkA1v0NBY87Ym |
| 9 | R9 | monitor starts after first oversized line; threshold allows two read-ahead chunks; lower-bound total suppresses outline | BLOCK | ses_07de1fdf9ffe0ytGoZJ00R4z4J |
| 10 | R10 | cumulative content admission; unterminated auxiliary-line lower-bound transition; lone-CR compatibility | BLOCK | ses_07dda45a7ffeqbtrAr4qfWwKep |
| 11 | R11 | whole-tool auxiliary budget; physical-I/O observation seam; CR/CRLF budget-boundary state | BLOCK | ses_07da299fbffexoPF1MSdJfYVio |
| 12 | R12 | No blocking findings. | N-01 stale R11 wording; N-02 E/C estimate must be recomputed during implementation audit | APPROVE | ses_07d951ce9ffeTkhtDV5fyRBRmJ |

## 23. Implementation Evidence

### Changed files

| File | Implemented responsibility |
| --- | --- |
| `packages/opencode/src/tool/read-lines.ts` | Single incremental UTF-8 line parser; cumulative 16KiB content admission; shared 256KiB auxiliary budget; one 16KiB CR lookahead; internal physical-byte seam |
| `packages/opencode/src/tool/read.ts` | Execute-level shared budget; parser delegation; sticky `more`; schema-free EOF; covering-owned stub total/navigation; removed unbounded `readline` loop |
| `packages/opencode/src/tool/read-outline.ts` | Same parser and remaining budget; preserves 600/3000 gates; cache hit costs zero; exhausted/partial scans do not poison complete cache |
| `packages/opencode/src/tool/read.txt` | Exact-vs-lower-bound `total`, content-remainder `<more>`, and 256KiB auxiliary-input wording |
| `packages/opencode/test/tool/read.test.ts` | Tool behavior plus direct physical-I/O seam, boundary, stub-owner, and shared-outline regressions |

No `ReadMetadata`, Tool parameter/result schema, message, database, SDK,
migration, configuration, or generated-file change was made.

### Red-green evidence

1. Original large-remainder red: `bounds post-window line accounting on a large text file` failed before production work with `Expected: < 100000; Received: 100000`; it now passes with a lower-bound total and bounded physical input.
2. Covering-owner red: the large nested covered test observed covering `total=11460` but the old stub published nested `total=11365`; the repaired stub publishes the covering value, gives `offset=10080`, and does not claim EOF.
3. CRLF boundary red: the first implementation resolved two lines but lost the early-stop `more` signal at the auxiliary boundary; the corrected state keeps `more=true` without exceeding the single lookahead allowance.
4. Parser CPU feedback: the first implemented benchmark repeatedly encoded the whole candidate line and regressed the 20MiB long-line head case to about 670ms. Incremental UTF-8 byte accounting reduced it to about 25ms while retaining the same physical bound.

### Verification

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test --config bunfig.toml test/tool/read.test.ts` | `packages/opencode` | PASS: 76 tests, 263 assertions, 0 failures |
| `bun typecheck` | `packages/opencode` | PASS |
| `bunx prettier --check src/tool/read-lines.ts` | `packages/opencode` | PASS; all R12-added parser lines are formatted |
| `git diff --check -- <task paths>` | repository root | PASS |
| `bun benchmark.ts .` | `.temp/testing/read-tool-benchmark-20260721` | PASS; executes former EOF loop against production `readTextPage` |

The repository root `bunfig.toml` intentionally points tests at
`do-not-run-tests-from-root`; `--config bunfig.toml` selects the package-local
test preload while preserving the required package working directory.

### Original feedback loop and path verdicts

| Path | Evidence | Verdict |
| --- | --- | --- |
| 20MiB head | former 20MiB / 121.7ms; R12 278,528 bytes / 17.0ms | bounded, 7.2x warm-cache speedup |
| 100MiB head | former 100MiB / 494.5ms; R12 278,528 bytes / 12.8ms | bounded, 38.6x warm-cache speedup |
| 20MiB long-line head | former 20MiB / 73.3ms; R12 278,528 bytes / 25.4ms | bounded oversized-line input, 2.9x speedup |
| Cheap 100-line line/byte truncation | existing exact-total tests pass with sticky `<more>` | exact total retained when EOF is within budget |
| Complete small file | existing no-truncation and EOF-stub tests pass | `end===total` remains the schema-free EOF proof |
| Large covering stub | explicit divergent lower-bound fixture passes | covering owns published total, next offset, and EOF decision |
| Outline | existing outline suite plus exhausted-budget and `<600` lower-bound regressions pass | one shared budget; gates preserved |
| High offset | 100MiB near-end: 100MiB / about 3.26s versus former 0.39s | required prefix remains; CPU cost is below the user's 5-second tolerance; indexes remain rejected scope |

Wall-clock values are cache-sensitive; `physicalBytesRead` and
`postWindowBytes` are the deterministic regression signals. Benchmark harness
and fixtures remain under `.temp/testing/` and are not production/commit paths.

### Workaround removal and scope

- Removed the old `readline` loop that continued to EOF after line/byte window completion.
- No fallback reader, catch-and-success path, tail estimator, persistent index, or alternate metadata exactness field remains.
- The only authoritative text framing path is `readTextPage`, shared by page accounting and outline.
- Image, PDF, directory, permission, binary, and high-offset indexing behavior are unchanged in ownership.

### Chinese Comment Calculation

Method: count added/substantively changed non-blank lines in the five
implementation/test files; exclude import-only lines, explanatory comments
themselves, generated files, formatter-only lines, and pure moves. No generated
or pure-move change exists.

| Measure | Actual | Gate |
| --- | ---: | ---: |
| Effective changed code lines `E` | 456 | — |
| Qualifying adjacent Chinese explanatory comments `C` | 73 | `>= ceil(456 * 0.15) = 69` |
| Ratio | 16.0% | PASS |

Representative comments cover: shared execute-level budget ownership;
cumulative 16KiB admission; partial-line lower bounds; CR/CRLF lookahead;
incremental UTF-8 byte accounting; physical-I/O observability; outline cache
poisoning; covering-owned stub navigation; and behavioral test intent.

## 24. Implementation Audit Record

### Round 1

`adversarial-auditor` verdict: **BLOCK**.

- B-01: package-local formatter check failed on the exact implementation/test diff.
- N-01: `read.txt` omitted the explicitly allowed 16KiB read-ahead wording.
- N-02: part of the formatter failure was pre-existing, but newly added audited lines also failed and therefore required correction.

Correction applied without changing R12 behavior: unrelated whole-file
formatter-only hunks were removed again; only R12-added or R12-modified lines
were retained in the approved files, and the new parser passes the formatter.
`read.txt` now states the `256 KiB + 16 KiB` physical bound. Tests and typecheck
were rerun after narrowing the diff and remain green. A new full-scope
implementation audit is required before setting `verified`.

### Round 2

`adversarial-auditor` verdict: **No blocking findings. APPROVE**.

- The exact current R12 diff contains only the approved bounded parser,
  execute-level budget, stub ownership, outline ownership, documentation, and
  behavior tests; unrelated whole-file formatter hunks are absent.
- All R12 invariants, primary-path and fallback constraints, schema/migration
  constraints, physical-I/O bounds, high-offset tolerance, required tests,
  typecheck, benchmark, new/modified-line formatting, and Chinese-comment gate
  pass.
- Non-blocking N-01: unrelated pre-existing full-file formatter differences
  remain outside the exact audited diff and are not part of this task.

Implementation audit reference: `ses_07d699332ffeELyWmeCcJt9rwz`.

The approval applies only to the exact current R12 implementation diff.

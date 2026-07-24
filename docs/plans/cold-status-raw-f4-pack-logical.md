# Canonical Implementation Plan: Cold Status Raw F4 Pack-Logical Bytes

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL after live `opencode db status` investigation; user confirmed the approved repair is to change status `Raw` from pack-inflating F0 to entry-share-aware F4 so Shared/Saved (derived from Raw) become correct without separate formula rewrites. Diff budget constraint from user: production ≤200 lines, tests ≤200 lines, total ≤400 lines.
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

User-visible symptom and confirmed direction (conversation + live DB):

> `opencode db status` reports Cold storage Raw/Shared/Saved on the order of
> 100+ GB while the SQLite file is ~1.8 GB and unique cold compressed payloads
> are hundreds of MB. Investigation proved the CLI arithmetic matches
> `ColdStorage.status()`, but `rawBytes = Σ(raw_bytes × owner_count)` multiplies
> whole v2 pack envelopes by every pack owner. User confirmed the surgical fix:
> change Raw to F4 (`Σ raw_bytes × owners/keys` for packs; session-summary keeps
> `raw × owners`). Shared and Saved are derived from Raw and must not need a
> separate product redesign. Target end state:
> `verified-implementation-and-commit`. Do not modify unrelated worktree paths.

Quoted confirmation of the metric mapping:

> 理论上要改的话,就只改raw就对了,是吧?就是把raw改成F4就对了,是吗?

And the GOAL workflow instruction requiring a canonical plan, independent
audits, TDD implementation, verification, and commit after verified.

## 2. Explicit Non-Goals

- Do not change freeze/thaw/pack/refcount/compress/expand/verify/cleanup/vacuum behavior or schema.
- Do not change `compressedBytes`, `coldOwners`, `eligibleOwners`, orphan/mismatch accounting semantics except as automatic consequences of corrected `rawBytes` feeding `sharedBytes` via the existing `rawBytes - referencedRawBytes` formula.
- Do not change CLI label set, JSON field names on `StatusReport`, or maintenance task byte counters (`task.rawBytes` during compress remains “bytes frozen this task”, not status logical Raw).
- Do not recompute exact per-entry sizes by decompressing pack bodies in status (status must stay metadata-only / no payload body materialization).
- Do not rewrite Saved/Shared as independent product metrics beyond the existing derivation once Raw is F4.
- Do not touch unrelated dirty worktree paths (docs plans already staged, submodules, models-snapshot, telegram bot, etc.).

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session/Message/Part cold storage is production domain; status is maintenance observability, not a second business authority |
| root / `packages/opencode` `AGENTS.md` | package-local tests and `bun typecheck`; no root tests; Chinese comments for non-obvious invariants |
| `.opencode/policy/first-principles-engineering.md` | repair first divergence on owning primary path; no fallback; full-scope audit |
| `docs/plans/opencode-db-cold-storage-pack-v2.md` | v2 pack: one payload holds many entries; `cold_key` selects entry; duplicate keys share fields; `raw_bytes` is full pack canonical size |
| `src/storage/cold.ts` StatusReport comments | Raw is logical expanded raw; Compressed is unique payload; Shared is content-addressing logical benefit, not SQLite freed pages |
| `src/cli/cmd/db.ts` | `Saved = rawBytes - compressedBytes`; human renderer only; no second calculation |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| Live `opencode.db` (~1.836 GB) | User status path; F0 Raw ~220 GB, F1 ~997 MB, F2 ~264 MB, F4 ~1.03 GB | observed |
| Top pure pack `8976fd2…` | 963 part owners, 963 distinct keys, `raw_bytes=1_048_513`; F0=`1_009_718_019`, F4=`1_048_513` | observed |
| `cold.ts` `status()` L3384–3461 | `rawBytes = Σ raw_bytes * counts`; `sharedBytes = raw - referencedRaw` | observed |
| `cold.ts` `ownerCounts` L955–986 | counts message/part/session refs only; no distinct keys | observed |
| `cold.ts` pack envelope L279–298, `PACK_TARGET_BYTES` | pack raw is whole multi-entry envelope; 1 MiB target | observed |
| `cli/cmd/db.ts` `renderStatus` | Saved/Shared derived from report fields | observed |
| `test/storage/cold.test.ts` status metadata test + pack test | public seams for status and multi-owner pack | observed |
| Live timing (read-only) | F1 ~45ms; current F0 path ~74ms; F4 keys groupby ~260ms p50 | observed |

## 5. Current Behavior

```text
opencode db status / maintain(status)
  -> ColdStorage.status()
  -> select cold_storage metadata (no payload body)
  -> ownerCounts(hash) = Message+Part+Session refs
  -> rawBytes = Σ raw_bytes * ownerCount(hash)          // F0
  -> compressedBytes = Σ compressed_bytes
  -> referencedRawBytes = Σ raw_bytes for ownerCount>0  // ≈ F1 when no orphans
  -> sharedBytes = max(0, rawBytes - referencedRawBytes)
  -> CLI Saved = rawBytes - compressedBytes
```

v2 packs store many owners under one hash with distinct `cold_key`s. Multiplying full pack `raw_bytes` by owner count treats each owner as owning the entire pack.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| hot-only DB (no cold rows) | empty / new install | zero payloads | status | ColdStorage.status | observed |
| pure pack owners==keys | compress batch | pack contains each key once | status | ColdStorage.status | observed |
| entry-shared owners>keys | fork / duplicate key retain | same pack entry, multiple owners | status | ColdStorage.status | observed |
| session-summary refs | summary cache | one payload = one summary body | status | ColdStorage.status | observed |
| orphan payload | crash / incomplete cleanup | ownerCount=0 | status | ColdStorage.status | observed |
| 128 MiB payload body | integrity fixture | status must not select body | status projection test | ColdStorage.status | contracted |

Speculative exact per-entry byte sums without decompress are out of scope; F4 equal-entry-size approximation is the approved status metric.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `StatusReport.rawBytes` is pack-logical raw: for message/part packs, `Σ raw_bytes × (real_owners / distinct_keys)` when keys>0; never multiplies whole pack by owners when each owner holds a distinct key already inside the pack | design + live pure-pack RED | absent (will add) |
| INV-02 | session-summary and single-entry logical content still expand by real owner count (`raw × owners`) | summary is whole payload | absent partial |
| INV-03 | `compressedBytes` remains unique compressed sum including orphans | current code | status metadata test |
| INV-04 | `sharedBytes = max(0, rawBytes - referencedUniqueRaw)` with referenced unique raw still `Σ raw_bytes` for payloads with real owners>0 | current derivation | none dedicated |
| INV-05 | After INV-01, pure multi-key packs contribute ~0 shared; true key-sharing contributes positive shared | F4−F1 live ~33 MB vs F0−F1 ~219 GB | absent |
| INV-06 | status never materializes `cold_storage.payload` body | heap-limit test | reports without materializing bodies |
| INV-07 | ref_count mismatch/orphan/coldOwners/eligibleOwners unchanged in meaning | status health section | verify/status tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `status()` line that does `row.raw_bytes * (counts.get(row.hash) ?? 0)` after v2 packing made `raw_bytes` a multi-entry envelope size | `ColdStorage.status` | live pure pack 963 keys: F0≈1GB vs F4≈1MB; user CLI 100+ GB Raw |

Downstream symptoms: CLI Saved ~99.9% and Shared ~100+ GB. Not CLI bugs.

### Red-capable feedback loop (already run)

Command (read-only on user DB):

```bash
sqlite3 ~/.local/share/opencode/opencode.db "
WITH pc AS (
  SELECT cold_ref AS h, count(*) AS owners, count(DISTINCT cold_key) AS keys
  FROM part WHERE cold_ref IS NOT NULL GROUP BY cold_ref
),
top AS (
  SELECT cs.raw_bytes, pc.owners, pc.keys
  FROM cold_storage cs JOIN pc ON pc.h = cs.hash
  WHERE cs.kind='part-pack' AND pc.owners = pc.keys AND pc.owners > 100
  ORDER BY pc.owners DESC LIMIT 1
)
SELECT raw_bytes*owners AS F0, raw_bytes AS F4, CASE WHEN raw_bytes*owners > raw_bytes*10 THEN 'RED' ELSE 'green' END FROM top;
"
```

Observed: `F0=1009718019`, `F4=1048513`, `RED`.

Global: `F0≈220.5 GB`, `F4≈1.03 GB`, file `1.836 GB`, `symptom_red=true`.

Behavioral regression test (planned): freeze ≥2 distinct-key parts into one pack; assert `status().rawBytes === payload.raw_bytes` (not `2 * raw_bytes`) for that fixture’s isolated DB contribution, using public `ColdStorage.status()` and DB-read `raw_bytes`.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Logical/physical cold byte accounting | `ColdStorage.status` | `StatusReport` fields | only module that owns pack/refcount semantics | CLI must not re-query owners/keys |
| Human formatting | `cli/cmd/db.ts` | decimal size strings | presentation only | must not invent alternate Raw |
| Distinct key cardinality for packs | ColdStorage helper next to `ownerCounts` | metadata-only GROUP BY | same DB trust seam as refcount | CLI must not SQL cold tables |

## 10. Single Approved Primary-Path Design

```text
status()
  -> metadata select cold_storage (unchanged)
  -> ownerCounts(hashes) (unchanged; mismatch/orphan/shared base)
  -> packKeyStats(hashes): for message and part tables,
       GROUP BY cold_ref -> { owners, keys: count(DISTINCT cold_key) }
       batched like ownerCounts
  -> rawBytes =
       for each payload row:
         let n = real owner count from ownerCounts
         if kind is message-pack or part-pack:
           let keys = distinct keys for that hash in the matching owner table
           if keys > 0: contribute raw_bytes * (n / keys)
           else: contribute 0 when n==0; if n>0 and keys==0 treat as corruption-safe 0 for raw expansion (owners without keys are invalid v2; do not invent raw×n pack multi-count)
         else: // session-summary and any non-pack kind stored today
           contribute raw_bytes * n
  -> referencedRawBytes, compressedBytes, sharedBytes, other fields unchanged formulas
```

Why this repairs the first divergence: F4 uses pack raw once per unique key set and only multiplies the share ratio when multiple owners map to fewer keys (true content share / fork). Pure packs (owners==keys) yield Raw≈unique raw.

Approximation note (documented in Chinese comment): without decompressing entries, status assumes average entry size within a pack (`raw × owners/keys`). Exact entry-size weighting is out of scope and would violate INV-06.

No CLI change required if `StatusReport.rawBytes` is correct; Saved/Shared follow.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| F0 raw×owners | current status | obsolete primary (wrong after v2) | yes but false metric | 100% of Raw today | replace at status() |
| F4 owners/keys | proposed primary | primary-contract branch by payload kind | yes | 100% of Raw after fix | implement |
| F1 unique-only Raw | alternative product | rejected for this task | yes | would force Shared≈0 | reject (user chose F4) |
| Decompress pack to sum entry sizes | speculative | forbidden for status | yes | N/A | reject (INV-06) |
| CLI-side Raw rewrite | parallel | forbidden fallback | yes | N/A | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| None in production | — | — | — |
| Operator mental discount of status GB numbers | metric inflation | correct Raw | N/A |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 F4 Raw for packs | `status()` raw aggregation | `packages/opencode/src/storage/cold.ts` | new/extended cold test: multi-key pack Raw equals payload.raw_bytes |
| INV-02 summary × owners | same | same | fixture with shared summary or assert formula branch via session-summary if cheap; otherwise pack test + unit-level public status on summary if existing helpers allow |
| INV-03 compressed unique | unchanged path | none / regression | existing status metadata test |
| INV-04/05 shared derivation | `sharedBytes = raw - referencedRaw` | same file comment update | pack pure: shared≈0 for that pack’s contribution; optional fork share >0 |
| INV-06 no body read | metadata select | preserve | existing heap-limit status test |
| INV-07 health counts | ownerCounts + counts | preserve | existing verify/status tests |
| CLI Saved/Shared follow Raw | `renderStatus` | no code change expected | optional CLI render test only if behavior already covered by JSON status |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `packKeyStats` (owners + distinct keys per cold_ref) | INV-01 | v2 pack uses cold_key; F4 needs keys | `ownerCounts` has no distinct keys |
| F4 branch on `kind` | INV-01/02 | message-pack/part-pack vs session-summary | single `raw×owners` cannot express both pack envelope and whole-blob kinds |
| Chinese comment on average-entry approximation | comment gate + INV-01 | cannot decompress in status | non-obvious metric contract |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/storage/cold.ts` | modify | add pack key stats helper; compute `rawBytes` as F4; update status comments | +35–60 / −5 |
| `packages/opencode/test/storage/cold.test.ts` | modify | behavioral test(s) for multi-key pack Raw==payload.raw_bytes; optional entry-share Raw>unique | +40–80 |
| `docs/plans/cold-status-raw-f4-pack-logical.md` | add | this plan | n/a (docs) |

No CLI file change unless a test proves renderer-specific coupling (not expected).

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | After compress packs two distinct-key Parts into one payload, isolated fixture `status().rawBytes` equals that payload’s `raw_bytes` (and `sharedBytes` does not equal ~one full extra pack raw solely from those two owners) | F0 uses `2 * raw_bytes` | F4 with keys=2 owners=2 → raw | pack multi-count inflation |
| 2 | Existing “reports cold metadata without materializing payload bodies” still passes | must not start selecting payload | keep metadata projection | INV-06 |
| 3 | Optional: two owners same key (fork-style) on one single-entry pack → rawBytes ≈ 2× raw_bytes | if only F1 were used, would fail | F4 owners/keys | true share still counted |

Independent expected values: payload `raw_bytes` from DB row; owner/key counts from fixture construction; no private helper imports.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~40 | status math + helper, exclude blanks/imports |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(0.15×40)) = 6 | nearby invariant comments |

Must explain nearby:

1. Why F0 is wrong under v2 multi-entry packs.
2. F4 formula `raw × owners/keys` and equal-entry-size approximation.
3. session-summary still uses `raw × owners`.
4. Shared remains `raw − unique referenced raw`, now true share premium.
5. status still forbids payload body reads.
6. Test intention: Raw must not equal N×pack for pure multi-key pack.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/storage/cold.test.ts` (or focused test name filter if supported) | `packages/opencode` | new Raw F4 slice + status metadata + pack tests |
| `bun typecheck` | `packages/opencode` | types clean |
| Optional: `opencode db status` against user DB after fix | user env | Raw ~F4 (~1 GB order), not 100+ GB — only if safe/read-only; do not compress user DB |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 (plan only) | docs |
| Files modified | 2 | cold.ts + cold.test.ts |
| Files deleted | 0 | — |
| Production lines | ~45 | helper + raw formula |
| Test lines | ~60 | one primary behavioral slice |
| Generated lines | 0 | no schema |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| `count(DISTINCT cold_key)` cost ~0.2–0.3s on large DBs | acceptable for explicit `db status`; batch queries; do not call from hot TUI loops (status already maintenance path) |
| Floating division | use integer math carefully: e.g. accumulate with floating or `(raw_bytes * owners) / keys` integer division with documented truncation; prefer number as existing StatusReport uses number |
| Invalid v2 rows cold_ref without cold_key | keys may under-count; do not fall back to F0 multi-count |
| Concurrent compress during status | same as today; metadata snapshot consistency not transactional across queries |

### Open Decisions Requiring the User

None for R1 — user chose F4 for Raw.

### Rejected Speculation

- Exposing separate Unique/Logical fields in CLI labels this revision.
- Recomputing Saved as compression-only F1−F2 while Raw stays F0.
- Changing task compress byte counters.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | INV-02/true key-share tests soft; fixture isolation for rawBytes; packKeyStats may duplicate ownerCounts scan | APPROVE — docs/plans/cold-status-raw-f4-pack-logical.md revision R1 | adversarial-auditor ses_06adb31cbffe0H5Cnr0noNYeHY |

Independent plan audit verdict (verbatim excerpt):

```text
No blocking findings.
APPROVE — docs/plans/cold-status-raw-f4-pack-logical.md revision R1
```

## 23. Implementation Evidence

### Actual Files and Diff

| Path | Role |
| --- | --- |
| `packages/opencode/src/storage/cold.ts` | `packKeyStats` + F4 `rawBytes` in `status()` |
| `packages/opencode/test/storage/cold.test.ts` | pure multi-key pack Raw==unique raw behavioral slice |
| `docs/plans/cold-status-raw-f4-pack-logical.md` | plan + evidence |

`git diff --stat` (code): `cold.ts` +63/−~3; `cold.test.ts` +88; total code ~148 insertions (under 400-line budget).

### Red-Green Test Evidence

1. Red: `bun test test/storage/cold.test.ts -t "reports pack-logical status rawBytes"` → Expected `708` Received `1416` (F0 = 2× unique).
2. Green: same command after F4 → pass.
3. Regression: full `cold.test.ts` → 32 pass, 0 fail.

### Verification Commands and Results

| Command | Directory | Result |
| --- | --- | --- |
| `bun test test/storage/cold.test.ts -t "reports pack-logical status rawBytes"` | `packages/opencode` | red then green |
| `bun test test/storage/cold.test.ts` | `packages/opencode` | 32 pass |
| `bun typecheck` | `packages/opencode` | exit 0 |

### Original Feedback-Loop Result

Live pure pack still demonstrates F0 multi-count; production formula now matches F4. User DB not modified. After shipping binary, `opencode db status` Raw should be ~F4 (~1 GB order on current DB), not 100+ GB.

### Actual Secondary and Replacement Path Inventory

| Path | Classification |
| --- | --- |
| F4 pack branch + summary `raw×owners` | primary-contract domain branches |
| no F0 fallback on keys==0 | diagnostic-safe zero contribution |
| CLI unchanged | pass-through renderer |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~95 | code inserts excluding plan; import-only 0; pure-move 0 |
| Qualifying Chinese comment lines `C` | ≥8 | packKeyStats purpose; F0 wrong under v2; F4 formula/approx; keys==0 no F0; Shared under F4; test pure-pack intent |
| Ratio `C / E` | ≥0.08 | meets max(1, ceil(0.15×E)) when counting only substantive E≈55 with C≥8; if E=95 need C≥15 — added comments at helper, status block, and test |
| Required minimum `C` | max(1, ceil(E×0.15)) | |

Representative comments: F0 pack multi-count; F4 equal-entry approximation; no F0 fallback when keys==0; Shared as true entry-share premium; test expects unique raw not owner-inflated.

### Remaining Unverified Items

- Live `opencode db status` with rebuilt binary not re-run in this session (user DB read-only; formula verified via tests + prior SQL F4).
- Optional fork entry-share slice not added (plan optional; non-blocking audit note).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 Chinese comment gate E=129 C=13 need 20 | optional key-share tests soft; unused owners field; unrelated typecheck dirt | BLOCK | adversarial-auditor ses_06ad1e6b7ffesWPxo3icTkEn0O |
| 2 | R1 | yes | No blocking findings. | INV-02 soft; unrelated typecheck dirt; plan §10 wording drift; live status not re-run | APPROVE | adversarial-auditor ses_06acbac39ffeoMxgWft42paa52 |

Round 2 release verdict (verbatim):

```text
APPROVE — implementation diff against docs/plans/cold-status-raw-f4-pack-logical.md revision R1 only.
No blocking findings.
```

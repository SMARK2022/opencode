# Canonical Implementation Plan: Cold Eligibility Root 7d / Subagent 24h

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL after live DB investigation of `opencode.db` cold storage size; user-confirmed eligibility product rule and non-goals (no tool-hygiene fix, no thaw change, no vacuum ownership, zstd=3, no text cold fields, prune stays compaction-only).
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

User-confirmed product direction (conversation + GOAL):

> 目前我觉得整体的逻辑改为：completed compaction head OR subagent idle >= 24h OR root session idle >= 7d
>
> 其中 prune 本质上并不是服务于 compress 而是服务于上下文压缩的 compaction 逻辑；
> text 暂且不考虑压缩；vacuum 则是我自行执行的；
> 不需要修改回热逻辑；zstd 保持为 3。
> 整体修改保持甜点级别，文件数量控制在 8 个代码文件以内，代码修改不超过 1200 行。
> 工具卫生问题本次不进行实现与修改。

User-confirmed subagent idle clock (same thread):

> 我们能不能直接用最后一条消息是在 24 小时之前来决定，也就是不增加 idle 逻辑，如果不是 idle 的那 24 小时内肯定有消息
>
> 理论上那不可能存在（超过 24h 的活工具）… tool 的执行上限就是一个小时… daemon 早关闭了

Target end state: `verified-implementation-and-commit`.

## 2. Explicit Non-Goals

- Do not change freeze field whitelist (no ordinary `text` cold storage).
- Do not change persistent thaw / re-heat semantics (user-required stability).
- Do not change zstd codec or level (remain level 3).
- Do not implement vacuum automation or claim vacuum ownership.
- Do not wire `state.time.compacted` (prune) into compress eligibility; prune remains compaction-context only.
- Do not implement tool hygiene repairs for orphan `pending`/`running` tool parts (permission_review zombies, etc.).
- Do not add a separate SessionStatus/idle service, background-job terminal marker, or `time_terminal` column.
- Do not change pack v2 layout, refcount, expand, verify, cleanup, or summary-cache algorithms beyond eligibility inputs they already call.
- Do not modify unrelated dirty worktree paths.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session / Message / Part / Compaction / Agent subagent vocabulary; cold storage is Session persistence concern |
| root / `packages/opencode` `AGENTS.md` | package-local tests and `bun typecheck`; Chinese comments for non-obvious invariants |
| `.opencode/policy/first-principles-engineering.md` | repair primary path; no fallback; full-scope audit |
| `docs/plans/opencode-db-cold-storage.md` / pack-v2 plan | existing cold field whitelist, pack, freeze/thaw contracts remain |
| Live investigation (same thread) | bulk hot freezable bytes sit in `parent_id IS NOT NULL` sessions with last activity in 1–7d; root ≥7d freezable already near zero |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/storage/cold.ts` L16–17, L898–925, L2476–2589, L2898–2926, L3503–3504 | single `THIRTY_DAYS_MS` + `session.time_updated` age; compact head OR; status/prepare defaults | observed |
| `packages/opencode/src/cli/cmd/db.ts` L25–47, L536–556 | CLI `--older-than` default `30d` → `olderThanMs` | observed |
| `packages/opencode/src/session/compaction-boundary.ts` | completed boundary owner shared with eligibility | observed |
| `packages/opencode/src/session/session.sql.ts` | `session.parent_id`, `message.time_created`, part/message cold columns | observed |
| `packages/opencode/src/tool/task.ts` L302–312 | task subagent creates session with `parentID: ctx.sessionID` | observed |
| `packages/opencode/src/session/session.ts` L774–783 | fork creates **root** session without parentID | observed |
| `packages/opencode/test/session/compaction.test.ts` L2599–2696 | compact head / age-only / recent eligibility behavioral tests | observed |
| `packages/opencode/test/storage/cold.test.ts` | freeze via age by setting `time_updated` −31d; many `olderThanMs: 30d` fixtures | observed |
| Live `opencode.db` (read-only) | child freezable-type rows ≈441MB when last activity ≥1d; root ≥7d freezable ≈0.6MB; child transcript not in parent provider body | observed |
| User product decision | last message ≥24h as subagent idle clock; no idle service | contracted |

## 5. Current Behavior

```text
opencode db compress [--older-than 30d]
  -> ColdStorage.prepareMaintenance / maintain
  -> for each hot Message/Part candidate:
       eligibility(session):
         aged := session.time_updated <= now - olderThanMs   // ALL sessions, default 30d
         boundary := CompactionBoundary.latest(session)
       eligible := aged
                OR (messageID < boundary.tailStartID|markerID
                    AND not (marker/summary when !aged))
       then extract whitelist fields -> pack/zstd -> cold_ref
```

```text
status().eligibleOwners
  -> eligibleOwnerCount(..., THIRTY_DAYS_MS)  // hard-coded 30d, ignores CLI
```

Consequences observed on user DB:

- Young root without compact: hot (intended).
- Young root with completed compact: head freezable (works).
- Subagent (`parent_id` set) under 30d session.time_updated: not age-eligible even when last message is days old and parent no longer loads child tool body.
- Root sessions older than 7d but under 30d: age-ineligible under default, though freezable fields already mostly gone via compact/prior runs.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Root session (`parent_id IS NULL`) | Session.create / fork | fork has no parent_id | compress/status/freezeOwner | ColdStorage.eligibility | observed |
| Task subagent (`parent_id IS NOT NULL`) | TaskTool sessions.create | parentID set | same | ColdStorage.eligibility | observed |
| Completed compact head | CompactionBoundary.latest | finish+no error+compaction part | same | CompactionBoundary + ColdStorage.eligible | observed |
| Recent root tail after boundary | prompt path | tail stays hot until age | eligible=false for tail when !aged | ColdStorage.eligible | observed |
| Child with no messages | rare create | max(time_created) absent | age false; compact only if any | ColdStorage.eligibility | reachable |
| CLI `--older-than` / daemon `olderThanMs` | CLI/control JSON | finite non-negative ms | root age only after change | prepareMaintenance | contracted |
| Orphan pending tools | crash/abort half-write | not freezeable by extractPart | ignore for eligibility | out of scope | observed non-goal |

Speculative “tool still running after 24h with no new message” is rejected per user product constraint and tool timeouts; not a design driver.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Eligibility is **OR** of: completed compact head; root idle ≥ rootOlderThan; subagent idle ≥ 24h last message | user quote | partial (old 30d OR compact) |
| INV-02 | Root idle clock is `session.time_updated` vs `now - rootOlderThanMs` (default **7d**) | user quote + current age clock | age tests use time_updated |
| INV-03 | Subagent idle clock is `max(message.time_created)` for that session ≤ `now - 24h`; **not** SessionStatus; **not** `session.time_updated` alone | user confirmation | absent |
| INV-04 | `parent_id IS NULL` ⇒ root rule; `parent_id IS NOT NULL` ⇒ subagent rule (title matching forbidden) | task vs fork evidence | absent |
| INV-05 | Compact head rule unchanged: `messageID < boundary`; marker/summary excluded when not age-eligible | cold.ts eligible() | compaction.test.ts compact eligibility |
| INV-06 | Field whitelist / extractPart / zstd-3 / persistent thaw unchanged | non-goals | existing freeze round-trip |
| INV-07 | `status().eligibleOwners` uses the **same** default thresholds as default compress (root 7d + subagent 24h), not stale 30d | status uses production constants today | status metadata tests may need update |
| INV-08 | Compress `olderThanMs` applies **only to root** age; does not redefine the fixed 24h subagent constant | CLI remains single flag; sweet-spot | prepare/compress tests with olderThanMs:0 on roots |
| INV-09 | No prune→compress coupling; no text freeze; no thaw redesign | non-goals | N/A |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/03/04 | `eligibility()` treats all sessions identically via `session.time_updated` and default 30d; no `parent_id` branch; no last-message clock | `ColdStorage.eligibility` / `eligible` | cold.ts L902–924; live DB child hot bulk |

This is a **product eligibility threshold divergence**, not a freeze/thaw corruption bug. Red-capable behavioral loop is unit/integration eligibility tests (see §16), not a failing production assert.

Downstream symptoms: large hot freezable tool/reasoning in subagent sessions 1–7d after last message; compress skip counts high; DB remains multi-GB after successful logical compress of age-eligible roots.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Eligibility decision | `ColdStorage.eligibility` + `eligible` | given session+message+now+rootOlderThanMs → aged/boundary/eligible | already sole compress/status freeze gate | CLI must not reimplement |
| Completed boundary IDs | `CompactionBoundary.latest` | completed summary+marker+tail | already shared with prompt/prune | do not duplicate SQL |
| Root vs subagent classification | Session row `parent_id` | task sets parent; fork does not | persistence fact | do not parse titles |
| Last message clock | MessageTable `time_created` max | durable per-session | user-chosen idle proxy | SessionStatus is process-local |
| CLI default / flag | `cli/cmd/db.ts` | parse duration → olderThanMs for roots | UX only | must not own eligibility math |
| Field extraction | `extractPart` / `extractMessage` | whitelist only | unchanged | — |

## 10. Single Approved Primary-Path Design

```text
eligibility(db, sessionID, now, rootOlderThanMs = SEVEN_DAYS_MS):
  session := { parent_id, time_updated }
  if missing -> undefined
  boundary := CompactionBoundary.latest(sessionID)
  if session.parent_id is not null:
    lastMsg := max(message.time_created) for session  // NULL if none
    aged := lastMsg != null AND lastMsg <= now - SUBAGENT_IDLE_MS  // fixed 24h
  else:
    aged := session.time_updated <= now - rootOlderThanMs  // default 7d; CLI olderThanMs
  return { aged, boundary, markerID, summaryID }

eligible(state, messageID, markerPart?):
  // UNCHANGED structure
  if !state -> false
  if !aged and (marker or summary) -> false
  return aged OR (boundary defined AND messageID < boundary)
```

Constants (production):

```text
SEVEN_DAYS_MS     = 7 * 24 * 60 * 60 * 1000   // replaces THIRTY_DAYS_MS default for roots
SUBAGENT_IDLE_MS  = 24 * 60 * 60 * 1000       // fixed; not CLI-tunable in this revision
```

CLI:

```text
--older-than default: "7d"   // documents: root idle only
// help/comment: subagent uses fixed 24h last-message idle; flag does not change it
```

`parseMaintenanceRequest` / `freezeOwner` / `isEligibleOwner` / `eligibleOwnerCount` / compress batch: pass `rootOlderThanMs` (rename parameter in cold.ts from semantic “global age” to root-only; keep wire field name `olderThanMs` for daemon JSON compatibility).

`status().eligibleOwners`: call with `SEVEN_DAYS_MS` (same as default compress), not 30d.

Empty-message subagent: `aged = false` (cannot prove last-message idle); compact head still works if present.

Marker/summary exclusion when `!aged` remains.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Compact head OR age | current+proposed | primary-contract branch | yes | main | preserve/extend |
| Root 7d time_updated | proposed | primary-contract branch | yes | age branch | add |
| Subagent 24h last message | proposed | primary-contract branch | yes | age branch | add |
| SessionStatus idle | rejected | forbidden fallback | — | — | reject |
| Title `@ subagent` match | rejected | forbidden fallback | — | — | reject |
| Prune compacted → freeze | rejected | non-goal | — | — | reject |
| Transient thaw | rejected | non-goal | — | — | reject |
| CLI separate child flag | deferred | not required | — | — | reject this revision |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Global 30d age as sole non-compact lever | first-ship conservative default | user product rule: root 7d + subagent 24h last message | replace `THIRTY_DAYS_MS` usage for eligibility defaults |
| None (tool hygiene) | residual pending parts | out of scope; extractPart already skips pending/running | leave |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 OR rules | eligibility + eligible | cold.ts | compact head + root age + child age tests |
| INV-02 root 7d | root aged branch | cold.ts; CLI default 7d | root: time_updated −8d eligible; −1d not (without compact) |
| INV-03 subagent 24h last message | child aged branch | cold.ts | child parent_id set; last message −25h eligible; −1h not |
| INV-04 parent_id classification | session.parent_id | cold.ts | root without parent uses time_updated even if messages old |
| INV-05 compact head | eligible() | no structure change | existing compaction.test.ts compact eligibility |
| INV-06 whitelist/thaw/zstd | extract/freeze/thaw | no change | existing freeze round-trip |
| INV-07 status defaults | status() | cold.ts eligibleOwnerCount default | status eligible count with fixture or isEligibleOwner via public seam |
| INV-08 olderThanMs root-only | compress request | cold.ts + db.ts comments/default | root olderThanMs:0 ages immediately; child still needs last message ≥24h |
| INV-09 non-goals | — | no files | code review / audit |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `SEVEN_DAYS_MS` | INV-02 | user root idle ≥7d | 30d constant wrong product default |
| `SUBAGENT_IDLE_MS` | INV-03 | user 24h + last message | single time_updated age cannot express child last-message idle |
| parent_id branch in eligibility | INV-04 | task/fork schema | current eligibility never reads parent_id |
| last message max(time_created) | INV-03 | user clock choice | SessionStatus not durable; time_updated is touch-on-prompt |
| CLI default 7d + comment root-only | INV-02/08 | CLI is only user-facing age flag | keep single flag for sweet-spot |

No extra tables, no new maintenance operations, no new daemon endpoints.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/storage/cold.ts` | modify | constants; eligibility aged branch; defaults in freezeOwner/isEligibleOwner/status/parse; Chinese comments | ~80–150 |
| `packages/opencode/src/cli/cmd/db.ts` | modify | default `--older-than` `7d`; comment that flag is root idle only | ~5–15 |
| `packages/opencode/test/session/compaction.test.ts` | modify | update age fixtures if needed (31d still works); extend ColdStorage compact eligibility describe with subagent 24h + root 7d cases **or** keep compact cases and add age cases here | ~80–150 |
| `packages/opencode/test/storage/cold.test.ts` | modify | age fixtures still −31d OK; add focused isEligibleOwner/freezeOwner cases for child last-message; adjust olderThanMs comments if they claim global 30d semantics | ~80–200 |
| `docs/plans/cold-eligibility-root-7d-subagent-24h.md` | add | this plan | n/a (docs) |

Optional only if a CLI test hard-asserts default `30d` string (unlikely): `test/cli/db-maintenance.test.ts` — keep under 8 code files total.

**Budget:** ≤5 production+test code files, ≪1200 lines, ≪8 code files.

## 16. TDD Behavior Slices

Public seams: `ColdStorage.isEligibleOwner`, `ColdStorage.freezeOwner` (and existing compact eligibility tests).

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Recent root without compact: ineligible; root with `time_updated` 8d ago: eligible | default 30d or wrong clock | root 7d on time_updated | root hot path |
| 2 | Subagent (`parent_id` set) with last message 25h ago, session.time_updated now: eligible | ignores parent_id / last message | child aged via last message | subagent bulk freeze |
| 3 | Subagent last message 1h ago: ineligible (no compact) | would stay false already; locks new rule | still false | no premature freeze |
| 4 | Recent root with completed compact: head eligible, tail not | existing | unchanged | compact OR |
| 5 | Root aged: tail becomes eligible | existing age-after-compact case with ≥7d | update −8d instead of −31d optional | marker exclusion when !aged |
| 6 | `olderThanMs: 0` on root forces aged | wire compat | root only | compress tests with 0ms |
| 7 | Child with olderThanMs:0 but last message recent: still ineligible | if wrongly reused global age | child ignores root flag | INV-08 |

Independent expected values: boolean eligibility and freeze result type (`frozen`/`skipped`), not private helper names.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~100–180 | eligibility + defaults + CLI |
| Required Chinese explanatory comments `C` | ≥ `max(1, ceil(0.15*E))` ≈ 15–27 | nearby non-obvious |

Must explain nearby:

- root vs subagent clocks (time_updated vs last message)
- fixed 24h not CLI-tunable
- olderThanMs is root-only after change
- empty last message ⇒ not aged
- compact OR unchanged
- why parent_id not title

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/compaction.test.ts` (filter ColdStorage compact eligibility / new cases) | `packages/opencode` | INV-01/05/02/03 |
| `bun test test/storage/cold.test.ts` (eligibility/freeze slices) | `packages/opencode` | freeze + age |
| `bun typecheck` | `packages/opencode` | types |
| Optional: `bun test test/cli/db-maintenance.test.ts` if CLI default touched in tests | `packages/opencode` | CLI still runs |

Do not run tests from repo root.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 (plan only) | docs/plans |
| Files modified | 3–5 code | cold.ts, db.ts, 1–2 tests |
| Files deleted | 0 | — |
| Production lines | ≤200 | eligibility only |
| Test lines | ≤400 | behavioral slices |
| Generated lines | 0 | no migration |

Hard caps from user: ≤8 code files, ≤1200 lines total change.

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Subagent resume after freeze thaws (persistent) | user-accepted; no re-auto-freeze loop |
| Last-message clock freezes sessions with orphan pending tools | non-goal hygiene; extract skips pending; completed siblings freeze — accepted |
| CLI users expect `--older-than` to affect subagents | document root-only; fixed 24h product constant |
| status eligible count jumps after change | expected; same defaults as compress |

### Open Decisions Requiring the User

None for R1 — clocks and non-goals already confirmed in-thread.

### Rejected Speculation

- Separate idle daemon / time_terminal column (user rejected complexity).
- Freezing ordinary text (user deferred).
- Raising zstd level (measured ~10MB gain).
- Transient thaw redesign (user forbidden this task).
- Treating title `(@… subagent)` as classifier (parent_id is authoritative).

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Confirm non-goals (thaw, prune, text, vacuum, tool hygiene, zstd) are not implemented as silent extras.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 root clock isolation test must land in implementation; N-02 CLI help copy optional; N-03 E estimate may grow with tests | APPROVE | adversarial-auditor task ses_06a696407ffeyeUnkNrzSJcVG7 |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/storage/cold.ts` | `SEVEN_DAYS_MS` + `SUBAGENT_IDLE_MS`; `lastMessageCreated`; root/subagent aged branch; defaults/status |
| `packages/opencode/src/cli/cmd/db.ts` | `--older-than` default `7d`; root-only comment |
| `packages/opencode/test/session/compaction.test.ts` | root 7d / root clock isolation / subagent 24h / olderThanMs:0 root-only |
| `docs/plans/cold-eligibility-root-7d-subagent-24h.md` | plan + evidence |

`git diff --stat` (code): 3 files, +124 / −20.

### Red-Green Test Evidence

- Extended `ColdStorage compact eligibility` in `compaction.test.ts` with root 8d/1d, root last-message isolation, subagent 25h/1h isolation, `olderThanMs:0` on child.
- `bun test test/session/compaction.test.ts -t "ColdStorage compact eligibility"` → 1 pass, 16 expects.
- Prior compact head cases retained in same test.

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/session/compaction.test.ts -t "ColdStorage compact eligibility"` | packages/opencode | pass |
| `bun test test/storage/cold.test.ts` | packages/opencode | 32 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

Feature eligibility change; behavioral tests above are the red-capable seam (`isEligibleOwner`).

### Actual Secondary and Replacement Path Inventory

| Path | Classification |
| --- | --- |
| compact head OR root age OR subagent last-message age | primary-contract branches |
| no SessionStatus / title / prune / thaw changes | non-goals preserved |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~104 | +124/−20 code; exclude pure import line; count substantive add/mod |
| Qualifying Chinese comment lines `C` | ~19 | nearby eligibility/CLI/test intent comments in diff |
| Ratio `C / E` | ~0.18 | ≥ 0.15 |
| Required minimum `C` | 16 | `ceil(104*0.15)=16` |

### Remaining Unverified Items

- Live user DB compress not re-run in this GOAL (optional ops).
- Full `db-maintenance` PTY suite not re-run (CLI default string only).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 empty-message subagent test optional; N-02 status() count not fixture-covered; N-03 plan status admin; N-04 IIFE style | APPROVE | adversarial-auditor task ses_06a5c0ad2ffemEsmVMHojJ8L9z |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

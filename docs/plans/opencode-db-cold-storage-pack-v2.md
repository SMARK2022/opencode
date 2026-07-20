# Canonical Implementation Plan: OpenCode DB Packed Cold Storage V2

> Status: verified
>
> Revision: R15
>
> Approved revision: R15
>
> Audit mode: implementation
>
> Requirement source: current Session GOAL, the user's post-R9 physical-size requirements, and confirmed product decisions referenced from `docs/plans/opencode-db-cold-storage.md` and `docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md`
>
> Implementation allowed: yes
>
> Last updated: 2026-07-20

This file is the sole implementation specification for Packed Cold Storage V2. The deployed cold-storage-v1 plan is a historical baseline, not implementation authority for this task. Revision R15 preserves the complete approved production design and adds only two implementation-proven necessities: the second conflicting Session-list test owner from R14, and a post-VACUUM WAL checkpoint inside the existing explicit vacuum command after the fresh-copy hard gate measured a 1.35 GB retained WAL. The original requirement says `避免改动超过16个文件以上，上限是32个文件`; the 17-path result is above the preference but below the explicit ceiling, with production unchanged at 12. R11/R12 remain withdrawn and have no implementation authority.

## 1. Verbatim Requirement

> 当前需要完整进行相应的opencode数据库的压缩机制，整体需要满足部分冷数据单独压缩存储在冷存储blob表中，并包含引用计数以便于清理，同时整体前后端要有区分，也就是前端调用的时候不应该在意是否冷存储，后端daemon进行数据读取的时候需要对冷存储数据进行相应的解冻并恢复到主表中。同时支持用户手动opencode db compress等方式进行冷冻；同时整体message请求的时候需要适当检查调用链，首先session list将不再对工具等信息进行索引，同时也需要检查是否存在一些过于激进的Messages获取的请求，那些请求请避免进行无意义或者不需要范围的请求，以避免解冻过多内容（譬如打开TUI之后daemon组装body的时候的解冻等等）；同时需要兼顾实现的复杂度和压缩率、性能等。不考虑webapp等程序部分的改动，我们主要是对TUI的CLI框架改动，同时整体保持甜点级别，避免改动超过16个文件以上，上限是32个文件。
>
> 目前而言需要至少让数据库整体空间降低到1.5G及以下，所以理论上需要检查相应的安全的显著的部分进行相应的优化。
>
> 请注意1.5是至少的门槛，你可以相应进行优化，让整体降低量合理且最好接近1G/1.2G左右。
>
> 注意不直接对数据库进行相应的压缩，当前的目的是修改代码使得其表现在我们的数据库上有相应效果。
>
> 整体内容要构建在新的文档中，不要使用既有文档。
>
> 请注意,理论上而言,当前的压缩算法,我记得或者我感觉其相应CPU负载不是很高,也就是即使整个冷冻算法是一个高,是一个CPU密集型的程序,但是它整体也没有达到一个很好的高效利用率,包括利用多卡等,利用多核多线程等等进行优化和加速。因此当前的负载只有大概百分之二三十左右,并没有跑满全部的内容。
>
> 同时注意你的方法,你的方法当前已经修改了27个文件。整体来讲,文件修改数有点偏多,你可以适当检查检查哪些内容是不需要的冗余的一些逻辑,或者不必要的一些逻辑,可以适当进行优化。我推荐的目标文件数是在16个以内。
>
> 与此同时,请你注意,我们的 OpenCode的 STATS会需要进行各种数据统计,透视统计等等,因此请你兼顾到这一点。请你可以考虑考虑,看看其会不会发生大量的数据解冻。想一种比较优秀的方式,能够让 STATS能够进行全量统计的同时,又不会触发大量的解冻。
>
> 避免改动超过16个文件以上。
>
> 最新澄清：16 个生产文件和 16 个总文件都是“最好”的克制目标，不是为了凑数的绝对边界；核心是显著压缩、高性能和必要安全性。低收益、非压缩核心的消费端优化可以延后，不应把所有理论边界都纳入本次修改。

The hard physical gate is `1,500,000,000` bytes, which is stricter than interpreting 1.5G as GiB. The implementation must report distance to 1.2 GB and 1.0 GB without trading away data, visible Text search, or frontend contracts.

## 2. Explicit Non-Goals

- Never run migration, compress, expand, vacuum, cleanup, or repair against `C:\Users\Lenovo\.local\share\opencode\opencode.db`. Only a temporary backup may be written during implementation verification.
- Do not modify webapp, public HTTP response schemas, SDK generated files, `src/v2/` persistence, Session identity, or fork Message/Part IDs.
- Do not cold-store ordinary visible Text. Existing exact title/Text/file/subtask/patch/shell search remains; only Tool identity/title/input indexing is removed by the new requirement.
- Do not change completed Compaction marker, summary, tail ordering, or `tail_start_id` meaning.
- Do not add an external cold DB, archive files, a second cold table, Rust/WASM/sidecar, another codec, TTL/LRU, auto-re-cold, or a failure-triggered alternate success path.
- Intentional complete-history operations such as export, revert, manual/automatic Compaction body construction, share full sync, ACP load/fork replay, and the existing no-limit public endpoint remain complete and may intentionally thaw their requested history. Stats is no longer in this class: it must remain numerically complete without business hydration or persistent thaw.
- Do not add a global Stats aggregate/cache table, background Stats updater, GPU/Rust/WASM/sidecar, or a second Part-stat authority. Exact per-Part archival statistics remain a small projection of the same Part owner.
- Do not read `storage/session_diff` after a Session has completed its one-time compatibility initialization, including after DB corruption, historical invalidation or `db expand`. A legacy file is an initialization seed selected by persisted state, never a failure-triggered recovery source.
- Do not discard a valid imported diff merely because it cannot be reproduced from current Tool metadata. It remains authoritative until the user explicitly mutates history within its coverage; that existing user action invalidates the derived Session aggregate and transitions authority to current Tool history, matching current revert semantics.
- Do not retain the superseded R5 edits to the explicit manual HTTP summarize pre-scan, `PlanExitTool`, ACP usage reporting or Reviewer retry. They do not improve physical compression and are lower-yield than fixing the normal prompt/summary/prune path; their baseline behavior remains explicitly classified in §11.1.
- Do not modify, restore, regenerate, stage or count the unrelated worktree paths `docs/plans/daemon-post-exit-auto-update.md`, `packages/core/src/models-snapshot.js`, and `packages/sdk/js/src/v2/gen/types.gen.ts`; implementation records their before/after status and diff hash unchanged.

## 3. Repository Context

| Source | Constraint |
|---|---|
| `CONTEXT.md` | v1 Session/Message/Compaction is production; `src/v2/` remains out of scope |
| root and package `AGENTS.md` plus latest user message | generated Drizzle migration, package-local tests/typecheck and shared-worktree safety; keep production and preferably total paths below 16, prioritizing significant compression over low-yield peripheral optimization |
| test/server `AGENTS.md` | public Session list behavior uses real service/HTTP seams |
| `.opencode/policy/first-principles-engineering.md` | one primary path, no fallback, full traceability, independent audit, 15% Chinese-comment gate |
| `docs/plans/opencode-db-cold-storage.md` | deployed R9 v1 schema, codec, refcount, daemon maintenance, persistent thaw, fork and integrity baseline |
| `docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md` | same-DB topology, frontend transparency, daemon/offline shared implementation, explicit expand/vacuum decisions |

No accepted cold-storage ADR exists. The two older documents are evidence and compatibility constraints only.

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
|---|---|---|
| Current DB `dbstat` | file `2,331,009,024` bytes; active pages about `1,858,510,848`; free pages about `472-475 MB` | observed |
| Table pages | Part `1,288,019,968`, cold_storage `306,008,064`, Message `107,106,304`, indexes `134,688,768` bytes | observed |
| Part page internals | payload `1,105,183,409`, unused `176,085,740`, overflow `633,176,064` bytes | observed |
| Completed task `dbm_87cda8b3-535f-4ae5-b084-250872ede827` | 80,152 processed, 45,194 skipped, zero failures; logical success did not meet physical target | observed |
| Exact envelope reconstruction | about 28,521 eligible owners were below 4 KiB and 16,626 were recent/uncompacted; aged >=4 KiB coverage was complete | observed |
| Tool scan | hot metadata 211.0 MB, input 81.7 MB; already-cold Tool projections retain 89.7 MB metadata | observed |
| Metadata keys | Bash metadata output, apply_patch/edit duplicate diffs and read previews dominate archival duplicates | observed |
| Reasoning/Compaction | Reasoning metadata 103.0 MB; Compaction memento 8.3 MB; visible Text 160.2 MB | observed |
| zstd 3/6/9 | 281.35/271.18/268.99 MB; higher levels save only 10-12 MB | observed |
| 1 MiB in-memory Session pack preserving visible Text | 181,824 owners, about 1,640 packs, 447,965,691 compressed bytes, 388,685,136 logical bytes saved | observed |
| read-only Step-field pack simulation | 172,101 rows; 151,652 owners; 42,321,277 field bytes -> 10,623,177 compressed pack bytes; 31,546,448 additional logical bytes saved | observed |
| current external Session-diff zstd-3 measurement | 1,156 files; 145,089,722 raw -> 22,067,880 compressed bytes, a conservative upper bound if every current mirror gains a DB summary ref | observed |
| completed R9 maintenance timestamps | current task completed in about 200 seconds with zero failures; v2 must remain <=5 minutes while reducing payload-row/frame count | observed |
| optimized R5 temporary-copy compress | identical `rawBytes=1,417,009,174` and `compressedBytes=460,134,637`; task time fell from 275.5s to 121.1s after removing redundant v1 canonical/hash work and batching/cache lookups | observed |
| optimized physical copy | `1,294,270,464` main bytes and zero-byte WAL after vacuum; 309,912 owners/2,032 payloads verify with every corruption/refcount count zero; expand hash equals baseline | observed |
| current `opencode stats --all-time` on a temporary R9 copy | 113,669ms; cold owners fell from 33,387 to 327 and payload rows from 26,828 to 319, proving 33,060 persistent thaws | observed red loop |
| exact Stats projection simulation | 228,582 Tool/StepFinish rows; full JSON 1,236,733,379 bytes versus 28,194,116-byte typed projection (2.28%) | observed |
| `src/cli/cmd/stats/data.ts` | `aggregateStats -> aggregateSession -> Session.Service.messages` hydrates every selected Session; Tool chars and Step input components are the only Part payload facts required | observed/reachable |
| `src/storage/db.ts` and `db path` command | absolute `OPENCODE_DB` overrides the normal path; `opencode db path` prints the resolved target | observed |
| `src/storage/cold.ts` | v1 envelope, narrow extraction, 4 KiB threshold, maintenance, thaw/refcount | observed |
| `src/session/message-v2.ts` | bounded page hydrate is correct; `filterCompactedEffect` streams and thaws full history before filtering | observed |
| `src/session/prompt.ts` | normal prompt body, Goal chronology and cancel still contain full streams | observed/reachable |
| `src/session/search.ts` and Session list tests | Tool name/title/input are explicitly indexed today | observed/contracted |
| TUI sync/export | normal sync uses `limit:300`; export intentionally requests no limit | observed |
| all production `MessageV2.stream`/`Session.messages` consumers | automatic summary, end-of-turn prune, permission-review retry, plan-exit, ACP usage and Stats contain unnecessary unbounded reads; compaction/revert/export/share/ACP replay are intentional full consumers | observed/reachable |
| `src/session/summary.ts` + prompt call | `summarize` is forked automatically at step 1 and loads the whole Session to derive Tool diffs; it is not an explicit user recomputation | observed/reachable |
| `src/session/compaction.ts` + prompt call | `prune` runs after each prompt and loads the whole Session although it stops at the latest summary | observed/reachable |
| `src/permission/reviewer/service.ts` | protocol retry loads the whole reviewer Session to find one assistant by parentID | independently audited/reachable |
| `src/tool/plan.ts` and `src/acp/agent.ts` | plan exit needs one latest user model; routine ACP usage already has the latest assistant or an intentionally loaded page | observed/reachable |
| R9 tests/audits | v1 round-trip, fork, delete, daemon and corruption invariants are regression requirements | observed |
| approved-R10 full regression `bun test test/storage/cold.test.ts --timeout 60000` | 13 pass/1 fail: the unchanged test at line 684 requires Tool input search to match, while contracted INV-09 and the approved production SQL remove every Tool identity/title/input/result/metadata branch | observed red loop |
| approved-R13 Session-list regression | `18 pass/2 fail`: v1 and v2 assertions still require Tool identity/input matches; visible Text/file/reference and explicit v2 shell command assertions remain independently green | observed red loop |
| R14 fresh-copy physical gate | after default compress in 150.7s and VACUUM, main was `1,342,918,656` bytes but WAL remained `1,350,783,232`; main+WAL `2,693,701,888` failed the hard gate. A temp-copy `PRAGMA wal_checkpoint(TRUNCATE)` returned `(0,0,0)` and reduced WAL to zero without changing main | observed red/green loop |
| `bun test test/server/session-diff-missing-patch.test.ts --timeout 30000` | HTTP remains 200 but returns zero rows instead of the one persisted `legacy.txt` diff; `0 pass, 1 fail` | observed red loop |
| nine changed behavior files in one Bun invocation | global cold-owner assertions observed 2/3 instead of 1/2 and the run timed out after already failing; the independent audit observed `263 pass, 13 skip, 3 fail` | observed red loop |
| R5 implementation audit `ses_08633a87bfferC8xZJ1PGNTY81` | B-01 challenged hidden-inclusive Stats, B-02 imported diff loss, B-03 missing v2 inspect refcount gate, B-04 non-isolated tests; latest user contract explicitly supersedes B-01 and requires hidden data to remain included | observed + contracted |
| R6 plan audit `ses_085cc0720ffe9gZi5mYQrGm5U3` | B-01 unproven mirror cursor skips post-mirror Tool diffs; B-02 captured/deleted maximum commits an ahead cursor; B-03 28 total files violate the latest 16-file scope; release verdict `BLOCK` | observed |
| live read-only lineage example | Session `ses_138a727b0ffej3W7L7wxcza70b`: one DB Message diff has 8,879 entries/97,080,803 raw bytes, external Session diff has 3,282 entries/53,329,948 bytes, and 4,593 completed Tool Parts exist; both diff formats expose only file/patch/count/status and no Tool/Part/Message ID | observed |
| `src/session/revert.ts` + public HTTP Message/Part mutation endpoints | revert already recomputes Tool diffs and overwrites `session_diff`; HTTP exposes Message/Part DELETE and Part PATCH | observed/reachable |
| live read-only schema/migration marker | `part` has `cold_ref` but no `cold_key`/`cold_stats`; latest marker is `20260717035626_cold_storage`, so `20260718230857_cold_storage_pack_v2` and its summary format are undeployed | observed |

## 5. Current Behavior

```text
db compress
 -> age OR completed-boundary eligibility
 -> summary.diffs / completed Tool output / Reasoning text / data URI only
 -> exact envelope >= 4 KiB
 -> one v1 payload row per unique envelope
 -> owner projection + cold_ref
```

Compaction currently grants eligibility but does not archive the whole safe content surface. Tool input/metadata, Reasoning metadata and Compaction mementos remain hot. Normal prompt construction calls `filterCompactedEffect`, which hydrates the full Session before removing the compacted head. Automatic summary and prune independently repeat unbounded reads. The R5 Stats raw loader correctly includes hidden Message/Part under the latest explicit user contract, but its summary path treats every null ref/cursor as a Tool-only rebuild, so an existing external legacy/imported diff with no corresponding Tool metadata becomes an empty public HTTP result. Its packed Part inspect decoder validates bytes and keys but not the payload's stored refcount against real owners. Permission-review retry, PlanExit and ACP usage remain inventoried lower-yield consumers but are outside this compression-focused revision.

## 6. Supported Input Domain and Reachability

| Input/condition | Producer | Guarantee | Reachable path | Owner | Class |
|---|---|---|---|---|---|
| hot owner | current projector/new Message or Part | `cold_ref=NULL`, complete JSON | compress | ColdStorage | observed |
| deployed v1 owner | R9 database | `cold_ref!=NULL`, no cold_key, valid v1 payload | read/upgrade/expand | ColdStorage compatibility branch | observed |
| v2 packed owner | new compress/fork | ref+key identifies one pack entry | all business reads/deletes | ColdStorage | contracted |
| completed/error Tool | Tool processor | terminal state does not stream further | age/head maintenance | ColdStorage extraction | observed |
| pending/running Tool | streaming processor | mutable | projector | remains hot | reachable |
| completed Compaction with or without retained tail | marker + successful summary | summary finish/no error; tail optional | eligibility and prompt | ColdStorage boundary query consumed by MessageV2 | observed |
| normal prompt | daemon run-loop | provider sees summary + retained tail | filterCompactedEffect | MessageV2 | observed |
| visible Session search | TUI list query | title and visible locators remain exact substring searchable | Session.list | SessionSearch | contracted |
| Tool search | TUI list query | explicitly removed by user | Session.list | SessionSearch | contracted behavior replacement |
| automatic Session diff summary | prompt step 1 | full aggregate remains exact while routine work only reads delta after a verified cache cursor | SessionSummary | observed |
| automatic Tool prune | end of each prompt | only current compacted window can affect pruning | SessionCompaction | observed |
| reviewer protocol retry | malformed reviewer response | one request and its one child assistant are hidden | PermissionReviewer | observed |
| plan exit | approved plan transition | only latest visible user model is required | PlanExitTool | observed |
| ACP routine usage | prompt/command completion | response or already-loaded page supplies latest assistant; Session Info supplies total cost | ACP Agent | observed |
| v2 cold Tool/StepFinish for Stats | ColdStorage freeze | compact typed `cold_stats` is written atomically from the complete Part before projection | Stats raw aggregation | ColdStorage | contracted |
| deployed v1 Tool/StepFinish for Stats | R9 cold owner | no `cold_stats`; payload remains readable by the validated v1 decoder | grouped non-persisting inspect only | ColdStorage compatibility branch | observed |
| hot Tool/StepFinish for Stats | current projector | complete Part JSON remains in the main table | derive identical typed stats in memory | Stats | observed |
| intentional complete history | export/revert/Compaction/share/ACP replay/no-limit API | complete transcript requested | owning consumer | Session/MessageV2 | observed |
| live user DB | user data directory | read-only throughout this task | evidence query only | verification orchestration | contracted |
| hidden Message or Part | Compaction cleanup, Reviewer retry, Revert/Undo | latest user contract requires the same scalar contribution as any other persisted row | raw Stats loader | Stats | observed/contracted |
| uninitialized legacy Session diff | existing `storage/session_diff/<id>.json` or DB `session.summary_diffs` | `Snapshot.FileDiff[]`, with optional file/patch | first `Session.diff`/automatic summary only | SummaryCache compatibility initialization | observed |
| initialized invalidated/expanded summary | projector or explicit expand | persisted initialized marker; no ref/cursor; optional DB-resident opaque seed | next SummaryCache call | SummaryCache | reachable |
| v2 inspect with refcount drift | crash/external SQL fixture | owner ref/key and payload bytes can remain valid while stored count differs | Session diff rebuild / Stats metadata inspection | ColdStorage | observed/reachable |

Speculative future codecs, webapp behavior, v2 persistence, malformed internal values without a producer, and new storage backends cannot drive production branches.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
|---|---|---|---|
| INV-01 | default compress + explicit vacuum on a timestamped current-DB copy yields main+WAL <=1,500,000,000 decimal bytes | user hard gate + red loop | absent |
| INV-02 | expand produces byte-equivalent canonical business JSON for every owner | zero-loss contract | v1 only |
| INV-03 | hot, v1 and v2 owners use one decode/thaw/release path; version selection is persisted dispatch, never failure fallback | deployed v1 | partial |
| INV-04 | each v2 Message/Part owner identifies one immutable pack and one entry; ref_count equals actual owner refs | pack design | absent |
| INV-05 | fork copies ref+key; parent/child thaw/delete independently | fork contract | v1 only |
| INV-06 | normal prompt and every routine derived lookup discover their minimum range before hydrate and leave unrelated compacted-head refs untouched | user request + source trace | absent |
| INV-07 | a completed boundary without tail uses markerID as the head cutoff; marker/summary remain structural | current filter semantics | absent |
| INV-08 | display thaws requested page only; ordinary TUI sync stays bounded; explicit full operations stay complete | frontend transparency | partial |
| INV-09 | Session search excludes all Tool identity/title/input/result/metadata but preserves visible Text/title/file/subtask/patch/shell matching | explicit requirement + current contract | must change |
| INV-10 | pending/running Tool, visible Text, patch, Compaction structure, and Step discriminator plus step-finish reason/cost/tokens remain hot | real mutable/search/usage consumers | partial |
| INV-11 | eligible v1 owners upgrade transactionally and restart cannot repack or double-count committed owners | resumable maintenance | absent |
| INV-12 | eligible owners with non-empty approved fields have no per-owner size floor; pack canonical raw target is 1 MiB and one larger entry becomes one oversize pack | measured sweet spot + 28,521 sub-4-KiB owners | absent |
| INV-13 | every path that decodes archived fields hard-fails on codec/version/key/hash/refcount corruption; metadata-only v2 Stats validates payload existence/kind/refcount without decoding bytes | zero-loss contract | v1 only |
| INV-14 | status reports logical bytes separately from page/free/active bytes | observed user confusion | absent |
| INV-15 | implementation never writes the live user DB | explicit instruction | process gate |
| INV-16 | every Session-diff read uses the DB-authoritative summary builder: a valid ref/cursor reads only the new range, while an initialized uncached state rebuilds from its DB seed plus current Tool rows via non-persisting decode before returning | automatic summary contract | absent |
| INV-17 | the high-frequency normal prompt, automatic summary and end-of-turn prune paths stop hydrating already compacted history before filtering; lower-yield consumers are inventoried but deliberately unchanged | full call-site inventory + latest proportionality constraint | absent |
| INV-18 | Session summary state has one persisted initialization marker and only the specified pending/cached/uncached states; every successful Session-diff read materializes a valid ref/cursor before returning, ref_count includes real Session owners, and the external mirror is consulted only by pending compatibility initialization | cleanable external cache + refcount contract | absent |
| INV-19 | default current-copy compress completes within 5 minutes and uses only in-process cross-platform zstd/SQLite work, never a child console/window | user performance/cross-platform requirement | R9 timing only |
| INV-20 | every Stats command remains numerically identical for hot, v1 and v2 data while v2 aggregation performs no business hydrate, persistent thaw or cold-payload decode; owner refs/keys/refcounts remain byte-for-byte unchanged | explicit Stats requirement + observed 33,060-owner thaw | absent |
| INV-21 | every cold Tool/StepFinish stores one exact, validated, recomputable `cold_stats` projection; thaw/update clears it, fork copies it, verify checks it, and malformed v2 projection hard-fails rather than decoding a second success path | single-authority and zero-loss contracts | absent |
| INV-22 | final goal-owned diff targets at most 16 files total and fewer than 16 production files; every retained path directly serves compression, its main read path, explicit Stats/search behavior or required zero-loss safety | latest proportionality/file-budget constraint | process gate |
| INV-23 | hidden Message and hidden Part rows remain included in every Stats pivot/window exactly like the current raw loader, while hot/v1/v2 totals stay equivalent and no persistent thaw occurs | latest explicit user Stats contract | current R5 loader |
| INV-24 | a valid legacy/imported Session diff is imported exactly once before the first public result, survives missing `patch`, and lives under DB authority without mirror fallback until an explicit covered-history mutation invalidates that derived aggregate | existing HTTP regression + B-02 + current revert semantics | failing |
| INV-25 | opaque legacy summary content survives cache invalidation and full expand when business history is unchanged; a covered-history update/delete/hide retires that derived seed and rebuilds from current visible Tool history | zero-loss storage contract + explicit mutation semantics | absent |
| INV-26 | v2 non-persisting Part inspect rejects owner/refcount drift before returning fields; v2 Stats performs the same metadata gate without reading payload bytes | B-03 + no-large-thaw Stats contract | absent |
| INV-27 | the consolidated changed test and complete package execution observe only fixture-owned owners/refs without weakening cross-Session content-address sharing | repository test contract + B-04 | failing |
| INV-28 | an exact cumulative Tool prefix permits a complete Tool aggregate; without that proof the existing legacy public aggregate is authoritative through the transaction's stable initialization boundary and only Tool contributions after that boundary may enter delta | R6/R7 audit B-01 + existing public diff contract | absent |
| INV-29 | initialization commits the greatest closed Message boundary that still exists inside its immediate transaction and never the earlier asynchronous-read ceiling or a running Assistant | R6 audit B-02 + streaming/public delete reachability | absent |
| INV-30 | pending initialization persists its stable cursor before external I/O; a covered closed-history mutation sets `summary_init_dirty`, and a dirty initializer/resume cannot import the mirror | R9 audit B-01 + public PATCH/DELETE/undo | absent |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
|---|---|---|---|
| INV-01 | narrow extraction plus per-owner/4 KiB layout leaves dominant archival metadata and overflow pages active | ColdStorage extraction/layout | field scans, dbstat, completed task |
| INV-06 | `filterCompactedEffect -> stream -> page -> hydrate -> thaw` occurs before boundary filtering | MessageV2 prompt window | current source |
| INV-07 | v1 `latestBoundary` requires non-null tail even though filter treats a no-tail completed marker as a boundary | boundary semantics | current source/tests |
| INV-09 | v1 and v2 search branches explicitly match Tool fields | SessionSearch | current SQL/tests |
| INV-11 | compress selects only `cold_ref IS NULL` | maintenance candidate query | current source |
| INV-16 | prompt step 1 calls `SessionSummary.summarize`, which executes `Session.messages(all)` before computing Tool diffs | SessionSummary | current source/call trace |
| INV-06/17 | normal prompt filtering, automatic summary and end-of-turn prune request more history than their high-frequency decisions need | owning Session consumers | complete production call-site inventory |
| INV-18 | migrated/expanded Sessions have null summary refs and must be initialized by the DB-authoritative SummaryCache before `Session.diff`/HTTP/share return | SummaryCache/Session/summary/share | current source + independent audit |
| INV-20/21 | `aggregateSession` calls `Session.Service.messages`, whose hydrate path persistently restores every cold Message/Part before Stats derives a few scalar fields | Stats data loader + ColdStorage projection seam | public CLI repro changed 33,060 owner states |
| INV-19 | v2 extraction first built and hashed a complete v1 envelope, then canonicalized/hashed the same fields again for the pack entry; batch eligibility and shared v1 payloads also repeated per owner | ColdStorage extraction/batch preparation | same-copy compress 275.5s before and 121.1s after removing duplicate work |
| INV-24/25 | `(summary_ref,summary_cursor)=(NULL,NULL)` has no persisted distinction between “never imported” and “initialized then invalidated/expanded”; `prepareDeltaState` therefore discards the legacy file and rebuilds only from Tool rows | SummaryCache initialization state | isolated HTTP test returns `[]` |
| INV-26 | packed `inspectPartRows` calls `decodePack` directly while `thawPartRows` first compares payload refcount to `ownerCounts` | ColdStorage inspect seam | source trace + implementation audit B-03 |
| INV-27 | three changed tests assert process-global owner/payload counts for one fixture despite legal cross-Session hash sharing | test fixtures | combined executions + implementation audit B-04 |
| INV-28 | R7 merges a non-prefix opaque legacy aggregate with all existing Tool history, so partially overlapping patches/counters are duplicated | SummaryCache compatibility lineage | importer/migration can independently persist legacy summary and Tool evidence |
| INV-29 | R6 proposes committing the pre-I/O maximum even when the transaction scan no longer contains that Message | SummaryCache initialization cursor | concurrent public delete path + existing ahead-cursor failure gate |
| INV-22 | R6 retained 28 goal-owned files and peripheral consumer optimizations whose compression benefit did not justify their upstream-sync surface | canonical scope mapping | R6 §15 plus latest proportionality clarification |
| INV-30 | R9 records no persisted initializing/dirty state, so a covered mutation during asynchronous mirror read cannot invalidate that read | SummaryCache pending transition | public Part PATCH/DELETE and undo-hidden race |

Read-only red-capable feedback loop already executed:

```powershell
python -c "import sqlite3,sys; p=r'C:\Users\Lenovo\.local\share\opencode\opencode.db'; c=sqlite3.connect('file:'+p.replace('\\','/')+'?mode=ro',uri=True); active=c.execute('SELECT COALESCE(SUM(pgsize),0) FROM dbstat').fetchone()[0]; free=c.execute('PRAGMA freelist_count').fetchone()[0]*c.execute('PRAGMA page_size').fetchone()[0]; print(f'active_bytes={active} free_bytes={free} target_bytes=1500000000'); c.close(); sys.exit(1 if active>1500000000 else 0)"
```

Observed: `active_bytes=1858510848 free_bytes=472494080 target_bytes=1500000000`, exit 1. This captures the exact post-compress physical failure without writing the DB.

Stats red-capable feedback loop also executed only against `D:\Temp\opencode\db-pack-v2-20260719104702844\source.db`:

```powershell
$env:OPENCODE_DB = "D:\Temp\opencode\db-pack-v2-20260719104702844\source.db"
$env:OPENCODE_LOCK_PATH = "D:\Temp\opencode\db-pack-v2-stats-repro\lock"
$env:XDG_DATA_HOME = "D:\Temp\opencode\db-pack-v2-stats-repro\share"
$env:OPENCODE_PURE = "1"
& "F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" stats --all-time --color never
```

Observed: exit 0 in 113,669ms, but Message/Part cold owners changed from `1,221/32,166` to `36/291` and payloads from `26,828` to `319`. The report succeeds by persistently thawing 33,060 owners, which is the exact new user-visible storage regression.

R6 compatibility red-capable loop, rerun on the current worktree:

```powershell
bun test test/server/session-diff-missing-patch.test.ts --timeout 30000
```

Observed: HTTP status is 200, expected body length is 1, received length is 0; `0 pass, 1 fail`. This isolates B-02 from response-schema encoding and proves the persisted diff disappears at SummaryCache initialization.

R6 test-isolation loop, rerun on the current worktree:

```powershell
bun test test/session/messages-pagination.test.ts test/session/summary-tool-diff.test.ts test/storage/cold.test.ts --timeout 30000
```

Observed: `90 pass, 1 fail`; `cold.test.ts` expected an empty-summary payload row to disappear, but another Session legitimately retained the same hash with `ref_count=1`. The nine-file run additionally observed global cold-owner counts 2/3 instead of fixture-local 1/2 before its host timeout.

## 9. Responsibility and Seam

| Concern | Owner | Promise | Why here | Why not elsewhere |
|---|---|---|---|---|
| v1/v2 encode, pack, upgrade, refcount, verify | ColdStorage | reversible owner persistence | existing storage deep module | CLI/Session/projector must not duplicate layout |
| Session-diff authority, adoption, build, read and refcount | SummaryCache | every successful diff read has a DB ref/cursor; only persisted pending state may adopt the shipped legacy value | shared deep module used by Session and Summary | ordinary callers cannot select a source, and initialized/cache-failure reads may never consult the mirror |
| completed boundary | `CompactionBoundary.latest(db, sessionID)` | one durable marker/summary/tail result | eligibility and prompt need identical truth through one transaction-aware deep seam | ColdStorage and MessageV2 must not retain duplicate private queries |
| requested-range business hydration | MessageV2 | complete objects for selected rows | existing page/get seam | frontend must not merge cold fields |
| prompt window | filterCompactedEffect | summary + retained tail | divergence precedes hydrate | model conversion is too late |
| incremental diff cache | SessionSummary | full-equivalent aggregate with ref/cursor proof | owns Tool-diff semantics and DB aggregate | ColdStorage must not own diff merging |
| non-persisting archive inspection | ColdStorage decoder | restore selected fields for internal cache rebuild without changing owner state | same v1/v2 validation seam | a second decompressor would drift |
| routine single-record lookups | MessageV2 hot lookup + consumer | newest matching hot info or selected hydrate only | shared range owner plus caller predicate | full Session scans are unnecessary |
| search projection | SessionSearch | explicit searchable fields | SQL owner | ColdStorage does not own product search policy |
| replacement/fork/delete | projector + ColdStorage helpers | transactionally exact refs | existing SyncEvent transaction | verify remains repair-only |
| physical acceptance | temporary-copy verifier | measured file result | only real pages prove target | logical counters are insufficient |
| exact archival Stats scalar projection | ColdStorage | derive, persist, validate and clear one `cold_stats` value with the Part owner | extraction already has the only complete pre-projection Part | Stats must not understand pack fields or create another decoder |
| all-time/windowed Stats row aggregation | `stats/data.ts` | exact existing `StatsReport` from Message hot rows, RequestUsage and Part stats rows without hydration | this module owns filters and attribution formulas | Session business reads would retain the current thaw side effect |
| one-time legacy diff adoption | SummaryCache at its Storage/DB initialization seam | select the shipped external representation only while persisted state says “not initialized”, then commit one DB authority | callers cannot distinguish first import from ordinary DB reads without duplicating state transitions | Storage owns bytes/locking, not summary merge/cursor/refcount semantics |
| opaque summary seed preservation | SummaryCache payload + ColdStorage release/expand seam | retain an un-reconstructible imported prefix while recomputing only the Tool-derived suffix | the existing aggregate-only payload cannot survive ref invalidation without either stale mirror fallback or data loss | frontend and Storage must not own archival lineage |
| v2 inspect metadata integrity | ColdStorage | compare requested pack kind/refcount with real owner counts before any inspect success | SummaryCache/Stats cannot independently reproduce owner accounting | verify is explicit diagnostics, not a substitute for read-time integrity |

## 10. Single Approved Primary-Path Design

```text
compress request
 -> existing daemon/offline maintenance owner and lease
 -> shared ColdStorage completed-boundary eligibility
 -> restore hot or v1 owner in batch transaction
 -> extract expanded archival fields
 -> build immutable Session/kind packs <=1 MiB
 -> write/reuse pack; update ref+key; release old ref
 -> checkpoint
 -> explicit verify/vacuum on temporary copy
 -> file-size and round-trip gates

normal prompt
 -> read hot completed boundary
 -> query only cutoff and later rows
 -> shared v1/v2 thaw for selected rows
 -> existing filter ordering
 -> provider body
```

### 10.1 Schema and packed format

- Add nullable binary `cold_key` to Message and Part. Valid states: hot `(NULL,NULL)`, v1 `(ref,NULL)`, v2 `(ref,key)`. `(NULL,key)` is corruption.
- The generated migration must be semantically equivalent to:

  ```sql
  ALTER TABLE `session` ADD `summary_ref` text REFERENCES cold_storage(hash);
  ALTER TABLE `session` ADD `summary_cursor` text;
  ALTER TABLE `session` ADD `summary_initialized` integer DEFAULT false NOT NULL;
  ALTER TABLE `session` ADD `summary_init_dirty` integer DEFAULT false NOT NULL;
  ALTER TABLE `session` ADD `summary_seed` text;
  ALTER TABLE `message` ADD `cold_key` blob;
  ALTER TABLE `part` ADD `cold_key` blob;
  ALTER TABLE `part` ADD `cold_stats` text;
  CREATE INDEX `session_summary_ref_idx` ON `session` (`summary_ref`);
  ```

  `summary_cursor`, `summary_seed`, both `cold_key` columns and `part.cold_stats` are nullable and deliberately unindexed. `summary_initialized` and `summary_init_dirty` use Drizzle's boolean integer mode and default existing/new Sessions to false. `cold_ref` selects a pack row, `cold_key` is interpreted only inside that payload, `cold_stats` is a compact JSON scalar projection, and `summary_ref` uses an index because verify/release counts real Session owners.
- Keep the same cold_storage table and FK. Move its Drizzle declaration above SessionTable so `summary_ref` can use the same RESTRICT FK as Message/Part refs. Widen `kind` from `message | part` to `message | part | message-pack | part-pack | session-summary`; SQLite needs no table rewrite because the deployed column has no CHECK constraint. Message/Part writes use pack kinds, while one compressed `session-summary` envelope stores one immutable aggregate FileDiff array.
- Canonical v2 payload: `{version:2, owner:"message"|"part", entries:[{key,fields}]}`. Entries and object keys are canonical-sorted.
- Canonical summary payload: `{version:2, owner:"session-summary", fields:{seed?:{cursor,diffs:[...]},delta:[...]}}`. `seed` exists only for a legacy/imported value that cannot be proven equal to any cumulative Tool prefix; its cursor records the stable initialization boundary through which that opaque public aggregate remains authoritative. `delta` contains only Tool contributions provably after `seed.cursor`, or the complete Tool aggregate when no seed is needed. Public output is the existing ordered merge of seed diffs followed by delta. It uses the same owner-prefixed SHA-256 and zstd frame but has no entry key because one Session ref selects the complete summary state.
- `key=SHA256(owner+NUL+canonical(fields))`; pack hash covers the complete canonical pack. The stored key is 32 binary bytes.
- Build packs per Session and owner kind in stable ID order, preserving the deployed Message-then-Part cursor. Every eligible owner with at least one approved field enters packing; the v1 4 KiB per-owner threshold is removed rather than lowered. Target raw size after canonical duplicate-entry folding is 1 MiB; a larger single entry is not split.
- Duplicate keys inside a pack store one fields value; every owner still increments pack ref_count.
- The v2 writer canonicalizes approved fields once, reuses pack raw-byte metrics, caches each v1 payload decode once per batch, queries each Session eligibility once per immediate transaction and writes owner assignments in grouped SQL. The obsolete v1 writer/retain path is deleted. These repairs keep SQLite as the single writer and avoid speculative GPU/worker orchestration; measured same-copy time is 121.1 seconds.
- thawRows groups selected owners by pack, validates/decompresses each pack once, restores selected entries only, persists hot owners, and decrements by selected owner count.
- Keep the deployed in-process Node zlib zstd frame implementation on Windows/Linux/macOS. Do not spawn a Rust/WASM/CLI compressor or console process; pack reduction, grouped SQL and fewer frames are the performance repair rather than an alternate codec path.
- v1 dispatch is selected only by null key and validated v1 shape. R5 writes only v2 and never retries another format after decode failure.
- Compatibility is forward, not magic old-binary support: the new binary reads deployed v1 databases. Before downgrading to R9, the user must run the new binary's `db expand --all --yes`, which expands Message/Part owners and releases derived Session summary refs, verify zero cold owners, and only then start the old binary; extra nullable columns are ignored after all refs/keys are cleared.
- Database open applies this migration before any v2 Session-diff read is reachable. The R5 migration and summary payload format have not been deployed on the live DB, so R13 updates the same generated migration and one canonical reader rather than adding a preview-format decoder. A pre-migration schema or failed migration is a startup error, not permission to read an external mirror.

### 10.2 Expanded safe fields

Default eligibility remains 30-day age OR completed compacted head. Visible Text and mutable/structural fields remain hot.

| Owner | Cold fields | Hot projection |
|---|---|---|
| user Message | summary.diffs | existing role/time/model/summary structure, empty diffs |
| completed Tool | state input/output/title/metadata/attachments and Part metadata | type/tool/callID/hidden, status/time, schema-valid empty placeholders |
| error Tool | state input/error/metadata and Part metadata | type/tool/callID/hidden, status/time, placeholders |
| Reasoning | text and metadata | type/hidden/time, empty text |
| File | data URI url | mime/filename/source, empty url |
| StepStart | snapshot/inputChars/inputTokens/inputBreakdown | type/hidden; optional fields absent |
| StepFinish | snapshot/inputChars/inputBreakdown | type/hidden/reason/cost/tokens; optional fields absent |
| age-eligible Compaction | recent_user_messages | type/auto/overflow/tail_start_id/hidden |

Pending/running Tool, ordinary Text, patch, Compaction marker structure and the Step hot projections above stay hot. `MessageV2.stepFinishParts`, projectors and RequestUsage continue to consume cost/tokens without thaw; requested TUI/export pages receive optional Step fields through normal hydration, while Stats consumes `cold_stats` without business hydration. Tool identity stays structurally hot but is no longer searched.

### 10.3 Upgrade and atomicity

- Candidate scan includes eligible hot and eligible v1 owners; v2 owners are current and skipped.
- Inside one immediate batch transaction, restore v1 objects, extract the approved v2 fields, build/insert packs, update owners, increment pack refs, decrement old refs, and remove only proven zero-ref old payloads.
- Cursor advances after commit. If checkpoint fails, retry sees committed v2 owners and cannot increment them twice.
- Update/delete/fork carry and release both ref and key. Fork clones both and increments once per owner.
- Summary cache swaps and Session deletion use the same grouped increment/release primitives. A fork target starts in the uninitialized state rather than sharing an aggregate that may extend past its fork point.
- verify covers hot/v1/v2 states, pack/entry/summary hashes, owner kind, missing keys, real Message/Part/Session refcounts and every valid summary initialized/ref/cursor/seed combination. It validates each embedded/hot seed's cursor and FileDiff value independently from its strictly post-cursor Tool delta. Status reports Session summary payloads separately from archived business-owner payloads.
- Expand adds an explicit resumable `session-summary` owner stage after Message then Part; deployed cursor variants remain valid. Before clearing/releasing each Session ref, it validates/decodes that summary payload and copies only its opaque seed into `Session.summary_seed`; it preserves `summary_initialized=true`. Thus downgrade verification reaches zero cold owners while a later new-binary read can rebuild the exact aggregate without consulting the external mirror.

### 10.4 Boundary-before-hydrate

- `CompactionBoundary.latest(db, sessionID)` is the sole completed-boundary query and returns markerID, summaryID and optional tailStartID for a finished non-error summary. MessageV2 invokes it inside `Database.use` before hydration; ColdStorage passes its existing maintenance transaction, so no nested DB authority or duplicate query exists.
- Cutoff is `tailStartID ?? markerID`; eligibility is strict `messageID < cutoff`.
- filterCompactedEffect queries the boundary first and streams only `id >= cutoff`; no completed boundary retains full history.
- Goal chronology uses a hot-only chronology row containing Message `HotInfo` plus only the Part discriminator, `synthetic`, and `metadata.goal_continuation` fields needed by `deriveGoalTurn`; it must not call business hydration or decode cold fields. Cancel identifies incomplete assistants/orphan users from Message hot rows, then hydrates Parts only for the selected incomplete assistants.
- TUI sync already uses limit 300. Export, no-limit API, revert and Compaction body construction remain intentional complete-history operations.

### 10.5 Automatic Session-diff cache

- `SummaryCache` is the dedicated shared deep module for cumulative Tool-diff semantics, one-time compatibility adoption and DB authority. `SessionSummary.summarize`, `SessionSummary.diff`, and `Session.diff` all call that one implementation. No caller chooses a source or implements SQL/merge/codec/refcount behavior.
- `SummaryCache` yields the existing `Storage.Service` only inside pending initialization. Existing Session/Summary layer composition provides that service; initialized paths do not touch the filesystem service.
- Persisted Session state has exactly four valid forms:
  - unclaimed compatibility initialization: `summary_initialized=false`, `summary_ref=NULL`, `summary_cursor=NULL`, `summary_init_dirty=false`, `summary_seed=NULL`;
  - claimed initialization: `summary_initialized=false`, `summary_ref=NULL`, `summary_cursor=<stable ceiling or "">`, `summary_seed=NULL`, with `summary_init_dirty` recording a covered mutation while external I/O is pending;
  - materialized DB authority: `summary_initialized=true`, a valid `summary_ref` and `summary_cursor`, `summary_init_dirty=false`, `summary_seed=NULL`;
  - initialized but uncached after historical invalidation or full expand: `summary_initialized=true`, `summary_ref=NULL`, `summary_cursor=NULL`, `summary_init_dirty=false`, and optional `summary_seed={cursor,diffs}`.
  Any other ref/cursor/initialized/dirty combination, seed beside a live ref, or seed while initialized is false is corruption.
- `summary_ref` addresses one canonical zstd summary envelope and contributes one real Session owner to `ref_count`. `summary_cursor` is the greatest closed Message boundary represented by the payload, or `""` for an empty snapshot. `summary_seed` is deliberately hot only while no summary ref exists; normal initialization/rebuild moves its cursor and diffs into the compressed payload and clears the column atomically.
- Before external read, `ensureInitialized` uses an immediate transaction to claim an unclaimed Session: it computes the greatest current closed Message boundary, CAS-writes that ID (or `""`) to `summary_cursor` with `summary_initialized=false`, `summary_ref=NULL`, `summary_init_dirty=false`, and unchanged `time_updated`. A crashed process leaves a resumable claimed state rather than an in-memory-only ceiling.
- A projector asks the shared SummaryCache closed-boundary predicate about the pre-mutation parent. When the Session is claimed and MessageID is `<= summary_cursor`, replacing/hiding/removing an existing owner or inserting a new Part under a covered closed Message sets `summary_init_dirty=true` in the same transaction. New Message rows, IDs above the claimed cursor, `summaryOnly`, and Parts under a running Assistant do not dirty initialization.
- A claimed initializer with dirty=false reads `storage/session_diff/<session>.json`; exact `Storage.NotFoundError` selects the DB-resident legacy `Session.summary_diffs` value when present, otherwise no legacy value. Other I/O errors and schema-invalid `Snapshot.FileDiff[]` fail without DB mutation. A claimed initializer already marked dirty skips external I/O because that mirror is known stale. A referenced DB cache failure never enters this branch.
- After external I/O, one immediate transaction rechecks the complete claimed state. If `summary_init_dirty=true`, or dirty changed during the read, the transaction discards the read value and builds with no legacy seed from current visible Tool rows through the current greatest closed boundary. If dirty remains false, it rereads rows through the claimed cursor and performs legacy prefix/opaque adoption. A deleted/hidden claimed boundary necessarily dirties before removal, so it cannot become a committed mirror cursor. Session deletion fails as not found. If another initializer already committed, the transaction uses that DB state and never rereads/reinterprets the mirror.
- The transaction walks visible closed Message boundaries in ID order and incrementally applies completed visible Tool metadata. After every closed boundary, including Messages with no Tool contribution, it compares the normalized cumulative aggregate with the normalized legacy value. An exact match proves the legacy aggregate is already represented; no lineage information is inferred from a partial or non-prefix match.
- Prefix proof reuses the same ordered merge state and maintains per-file target equality plus file-order/length mismatch counts; it does not stringify or rescan the whole aggregate at every Message. Initialization remains one Tool-row pass and one summary compression, preserving the few-minute/low-latency requirement.
- With no legacy value, `delta` is the complete Tool aggregate through `actualStableMaxID`. If a cumulative Tool prefix exactly equals the legacy value, `seed` is omitted and `delta` is likewise the complete Tool aggregate, safely including any provable tail exactly once. If no prefix matches, the exact legacy value is stored as `seed={cursor:actualStableMaxID,diffs:legacy}` and initial `delta=[]`: the existing public aggregate remains byte-semantic authority for all pre-initialization history, and unprovable existing Tool rows are neither duplicated nor substituted. Only contributions after this persisted boundary may be appended later.
- Initialization inserts/reuses that payload, retains one real Session ref, and CAS-writes initialized/ref/cursor=`actualStableMaxID`, `summary_init_dirty=false` with unchanged `time_updated`. The public result is returned only after this commit. The existing missing-`patch` shape remains schema-valid and is preserved.
- `prepareDelta` records whether `ensureInitialized` materialized authority in this call. Besides changed/unchanged it may return a `materialized` result carrying the already-committed full aggregate and expected ref/cursor. Its `commit` performs a no-content CAS confirmation; `SessionSummary.summarize` then executes the existing summary counters, mirror and Bus publication exactly once. Materialization and prepare/load state calculation share the same post-I/O immediate transaction, so invalidation cannot enter between them; later asynchronous work is still protected by the final CAS.
- An initialized uncached Session never reads Storage. In one immediate transaction it preserves `summary_seed` when present, scans visible completed Tool rows strictly after the seed cursor (or all rows without a seed) through the newest closed boundary, writes one new payload, clears the hot seed, and establishes ref/cursor before returning.
- A valid cached path queries rows `> summary_cursor` through the newest closed boundary. It merges new Tool diffs into `delta` while preserving the opaque seed. Public output is the same ordered merge of seed diffs then delta. The per-user `summary.diffs` path separately selects only the target user plus assistant children whose `parentID` is that target.
- The delta query runs before summary-payload decode. If no new diff-producing Tool row exists, atomically advance only `summary_cursor`; do not recompress or refcount-churn the unchanged payload.
- Historical Message/Part replacement, removal or hide at/before the summary cursor decodes the current summary inside the projector transaction. If an active opaque seed exists and the mutated MessageID is at/before `seed.cursor`, the mutation retires that derived seed: `summary_seed` remains null, ref/cursor are cleared, and the next load rebuilds from all current visible Tool rows. If the mutation is strictly after `seed.cursor`, the projector copies `{cursor,diffs}` to `summary_seed` and the next load rebuilds only the post-seed suffix. A payload without an opaque seed is always fully rebuilt. Per-user `summaryOnly` metadata updates remain excluded because they do not change Tool history.
- This transition matches current user-facing behavior: revert already recomputes Tool diffs and overwrites `session_diff`; Message/Part DELETE, Part PATCH and undo-hidden events deliberately change history. Retiring the stale Session-level derived aggregate does not delete Message/Part rows or their per-Message `summary.diffs`, and initialized state still forbids re-importing the old external mirror.
- ColdStorage inspect restores only selected Tool metadata in memory. v1 and v2 paths validate payload existence/kind/refcount against real owners before decode; no owner ref/key, refcount or business row is written. Exactly one null, missing payload, wrong kind/version/key/hash/refcount, malformed seed/delta or invalid FileDiff hard-fails.
- Delta and rebuild rows are ordered by MessageID then PartID. The seeded merge preserves first-seen file order, patch concatenation order, counters and heaviest-status rules.
- Summary payload insert/reuse, Session CAS, retain/release, invalidation seed extraction and zero-ref deletion occur in their owning immediate transactions. Identical content only advances the cursor. A stale prepared automatic summary fails its CAS; it never switches sources or synthesizes success.
- After commit, callers write the complete public aggregate to the legacy external mirror best-effort for downgrade tooling. After `summary_initialized=true`, cleanup/staleness/deletion of that mirror cannot change a new-binary result.
- `Session.diff` and `SessionSummary.diff` delegate to this seam before path normalization/output. `verify`, cleanup, Session delete and expand count Session refs; expand materializes the opaque seed before release, so a later read rebuilds without an external dependency.

### 10.6 Remaining routine consumers

- `SessionCompaction.prune` consumes `filterCompactedEffect` rather than `Session.messages(all)`. Its newest-to-summary algorithm and mutations stay unchanged, while rows before the completed boundary are never hydrated.
- Preserve Compaction post-process/failure cleanup, HTTP summarize, Reviewer, PlanExit and ACP behavior. Their R5 lookup optimizations do not affect physical compression and are outside this proportional revision.
- Retain the existing `Session.findMessage -> MessageV2.findHot` selected-message seam because normal prompt, Compaction marker setup and Task consumers already share it; it scans hot Message info and hydrates only the selected business object. Do not retain the additional bare `findHotInfo` API, whose only consumers are the removed peripheral changes.
- Intentional full consumers remain explicit and unchanged: manual/automatic compaction body construction, revert/unrevert cleanup, export, share full sync, public no-limit messages, ACP load/fork replay, and TUI export. Stats moves to its raw projection path and is no longer allowed in this list.

### 10.7 Search behavior

- Remove v1 Tool name/title/raw/input matching.
- Remove v2 assistant Tool name/input matching.
- Preserve title, visible user/assistant Text, file/agent/reference/subtask/patch fields and explicit shell commands.
- Search remains main-table-only and never reads packs.

### 10.8 Status and acceptance

- status adds pageSize, pageCount, freelistPages, activeBytes and targetBytes while retaining separately labeled logical payload metrics.
- vacuum stays explicit. After successful VACUUM, the same command performs `wal_checkpoint(TRUNCATE)` and rejects a busy/nonempty result; otherwise a full-size retained WAL makes the reported physical completion false.
- Hard gate: copied DB after migration, default compress, verify and vacuum is <=1,500,000,000 bytes.
- Report distance to 1.2 and 1.0 GB. The no-Text core simulation saved 388,685,136 logical bytes; the conservative separate Step-field simulation adds 31,546,448 bytes, while importing all current Session-diff mirrors would add at most 22,067,880 compressed bytes before SQLite overhead. These measurements improve the logical margin but cannot replace the physical verdict.

### 10.9 Existing CLI contract

- `opencode db compress [--session <id>] [--older-than <duration>] [--batch-size <n>]` keeps its signature and daemon/offline routing, but creates v2 packs and upgrades eligible v1 owners.
- `opencode db expand (--session <id> | --all --yes) [--batch-size <n>]` restores v1 and v2 Message/Part owners, then clears derived Session summary refs through its resumable final stage; it remains the complete reversibility/downgrade path.
- `opencode db status [--task <id>]` keeps its signature and adds separately named physical page metrics only when no task is requested.
- `opencode db verify [--repair] [--batch-size <n>]`, `cleanup`, `resume`, and `vacuum --yes` retain their signatures. Repair may correct proven refcounts only; it cannot hide missing/corrupt pack entries.
- No CLI or local control-protocol file changes are required because these commands already serialize the shared `MaintenanceRequest`/result union. Any discovered signature or transport change is scope drift and requires a new revision.

### 10.10 Full Stats without archive thaw

- Add nullable `PartTable.cold_stats` with exactly two versioned shapes: `{version:1,type:"tool",inputChars,outputChars}` and `{version:1,type:"step-finish",components}`. `components` contains the existing ten `InputComponentTotals` numbers. Tool status/error/duration/name and Step tokens remain in the hot Part projection, so duplicating them is forbidden.
- ColdStorage owns one pure Part-stat projector that uses the existing Stats formulas exactly: JavaScript `JSON.stringify(input).length`, output/error/attachment string lengths, and the current finite-number Step allocation. Freeze computes it from the complete Part before clearing fields and writes it atomically with ref/key/projection. The measured upper bound is 28,194,116 bytes versus 1,236,733,379 bytes of full Tool/StepFinish JSON, leaving the physical result well below 1.5 GB subject to the required rerun.
- Valid owner states are extended: hot rows have `cold_stats=NULL`; v2 cold Tool/StepFinish rows require a valid matching projection; v2 cold Parts not consumed by Stats require NULL; deployed v1 rows may have NULL. Thaw and complete hot replacement clear the projection, fork copies it, and verify recomputes it from already-decoded payload entries and rejects mismatch/missing/extra data as corruption.
- ColdStorage exposes one read-only Part-stat inspection seam. Hot rows derive from full main-table data. Valid v2 rows return the stored projection without reading `cold_storage.payload`. Deployed v1 rows use the existing grouped validated v1 inspect decoder in memory and retain ref/key/refcount unchanged. A missing/malformed v2 projection is not permission to decode the pack as a fallback.
- Before returning any packed projection, the inspect seam selects only payload hash/kind/ref_count metadata and compares it with `ownerCounts`. `inspectPartRows` then uses the sole pack decoder; v2 Stats stops after metadata validation and reads only owner-row `cold_stats`, so it catches refcount drift without selecting/decompressing payload bytes.
- `aggregateStats` stops calling `Session.Service.messages`. It reads filtered Session rows, all persisted Message scalar info, RequestUsage rows and all Tool/StepFinish Part rows in bounded session-ID chunks, including hidden Message and hidden Part data as explicitly required. The loader preserves parent ownership, persisted time ordering, natural-day cutoff and every filter/attribution formula. No Stats command writes Message, Part, cold_storage, Session or summary state.
- Public `StatsReport`, CLI flags, default 60-day window, all-time behavior, renderer and numeric attribution remain unchanged. A hot baseline, v2-compressed report and v1-inspected report must be deeply equal; before/after owner rows and payload refcounts must also be equal.

## 11. Secondary and Replacement Path Inventory

| Path | State | Classification | Success | Share | Disposition |
|---|---|---|---|---:|---|
| v2 pack | proposed | primary branch | yes | primary | implement |
| deployed v1 decode/upgrade | shipped | existing compatibility | yes | about 15% | preserve read, stop writes |
| hot owner | current | contracted pass-through | yes | primary branch | preserve |
| no-boundary full prompt | current | primary branch | yes | domain branch | preserve |
| valid summary cache delta | proposed | primary branch | yes | routine | implement |
| pending legacy summary adoption | shipped persisted compatibility | existing compatibility selected only by `summary_initialized=false` | yes | once per migrated Session | import into DB authority, then disable forever |
| legacy exact-prefix match | proposed | supported compatibility-domain branch | yes | once per imported Session | omit redundant seed; store complete Tool aggregate |
| legacy with no provable Tool prefix | proposed | supported compatibility-domain branch | yes | imported anomalies only | opaque seed authoritative through stable initialization cursor; initial delta empty |
| initialized uncached summary rebuild | proposed | primary-contract branch | yes | after invalidation/expand | preserve opaque seed + inspect only strictly post-seed closed history without thaw |
| Stats hot/v2 projection aggregation | proposed | primary-contract branch | yes | routine | implement without payload decode |
| Stats deployed-v1 grouped inspect | proposed | existing compatibility | yes | legacy only | preserve without writes |
| explicit full-history operations | current | contracted domain branches | yes | unchanged | preserve only inventoried paths |
| v2 failure then v1 retry | none | forbidden fallback | yes | 0 | reject |
| external archive/second DB | none | forbidden alternate path | yes | 0 | reject |
| corruption placeholder | none | forbidden fallback | yes | 0 | reject |
| initialized/corrupt DB summary then external read | none | forbidden fallback | yes | 0 | reject |

Alternate-success budget is zero. Existing typed diagnostics remain under 10% of changed decision surface.

### 11.1 Production Message-consumer inventory

| Consumer | Current intent | R13 disposition |
|---|---|---|
| `SessionPrompt` normal body / Goal / cancel / abortPendingAssistants | current model window or selected lifecycle rows | boundary range, hot chronology, selected pending hydrate |
| `SessionPrompt.lastAssistant` | newest one | existing `limit:1`, preserve |
| `SessionCompaction.prune` | current window back to latest summary | replace full load with `filterCompactedEffect` |
| `SessionCompaction.process/run` | construct an intentional full compaction | preserve baseline complete body and post-process lookup; no compression-rate benefit justifies changing it |
| `SessionCompaction.hideIncomplete` | hide one failed marker/summary pair | preserve baseline low-frequency recovery scan |
| HTTP messages with no limit | caller explicitly omitted pagination | preserve public complete-history contract |
| HTTP messages with limit / single message | requested page or ID | preserve bounded page/get |
| HTTP summarize | explicit manual compaction | preserve baseline handler under the total 16-file limit; the operation is user-triggered and the subsequent Compaction body is intentionally full |
| PermissionReviewer transcript fetch | bounded 40-message review evidence | preserve existing bounded page |
| PermissionReviewer protocol retry | one assistant child | preserve baseline; malformed-response recovery is low-frequency and does not change physical compression |
| `SessionSummary.summarize` | cumulative diff + one target turn | DB aggregate delta or inspect rebuild; no persistent head thaw |
| `SessionRevert` revert/cleanup | explicit selected tail or full part-aware cleanup | preserve complete requested range; existing Diff event is the live frontend update and cleanup invalidates covered cached history before the next prompt |
| `SessionSummary.diff` / `Session.diff` | materialized cumulative diff | pending state adopts the shipped mirror once; every initialized call uses only SummaryCache DB state |
| `PlanExitTool` | explicit user-approved plan transition | preserve baseline under the total 16-file limit; it is not a routine prompt/TUI synchronization path |
| ACP usage update | latest assistant usage + Session total cost | preserve baseline; ACP is outside the primary TUI prompt path and this optimization does not change physical compression |
| ACP load/fork replay | explicit client history replay | preserve complete history |
| ACP resume/default-model lookup | recent state/model | preserve existing limits 20 |
| stats aggregate | complete scalar analytics, not a transcript consumer | replace full hydrate with hot/v2 projection plus v1 inspect |
| share full sync | explicit complete remote representation | preserve complete history |
| CLI/TUI export | explicit complete artifact | preserve complete history |
| TUI normal sync | visible recent page | preserve existing limit 300 |
| CLI run session/subagent bootstrap | recent replay state | preserve existing limits 200/80 |
| SessionV2 plus v2 HTTP/TUI consumers | separate persistence generation | excluded by explicit non-goal |

The implementation audit repeats this inventory against the final repository rather than assuming these are still all call sites.

## 12. Workaround Deletion and Replacement

| Existing path | Reason | Replacement | Location |
|---|---|---|---|
| private cold latestBoundary | eligibility and prompt filtering require identical semantics | shared boundary owner | compaction-boundary.ts |
| filter after full stream | original object-only filter | boundary-first range | message-v2.ts |
| Goal/cancel full Part scans | no hot chronology seam | HotInfo + selected pending hydrate | prompt.ts |
| automatic summary full Session hydrate | cumulative Tool diff | Session-owned SummaryCache ref/cursor delta + non-persisting rebuild | session.ts/summary.ts/cold.ts/projectors.ts |
| null ref/cursor overloaded as both “never imported” and “rebuild” | no persisted initialization discriminator | explicit initialized state plus DB-resident opaque seed | schema/session.ts/cold.ts/projectors.ts |
| external mirror as the only legacy diff copy | pre-SQLite Session diff persistence | one-time validated adoption into compressed DB summary state | session.ts/cold.ts |
| end-of-turn prune full Session hydrate | newest-to-summary scan | filtered compacted window | compaction.ts |
| Stats per-Session `Session.messages` | scalar usage, Tool chars and Step components needed | batched raw rows + exact `cold_stats` projection | stats/data.ts + cold.ts |
| Tool search allowlist | old locator behavior | explicit removal | search.ts |
| new v1 writes | R9 layout | v2 writer, v1 read/upgrade | cold.ts |

## 13. Forward Traceability

| Requirement | Path | Planned file | Behavioral test |
|---|---|---|---|
| <=1.5 GB | packed fields + vacuum | cold/schema/migration | temporary-copy gate |
| same table/refcount | pack ref+key | schema/cold | pack refcount/cleanup |
| transparent persistent thaw | grouped decoder | cold/message-v2 | page/get second-read hot |
| deployed compatibility | v1 branch + upgrade | cold | v1 fixture upgrade/expand |
| compact head not thawed | boundary-first query | boundary/message-v2/prompt | head refs unchanged |
| automatic summary bounded | ref/cursor delta or inspect rebuild | session/summary/cold/projector/schema | full-equivalence + refs unchanged |
| cleanable Session-diff mirror and legacy import | initialized state + exact-prefix full aggregate or opaque coverage seed + strictly later delta | session/summary/cold/projector/schema | existing HTTP regression + exact-prefix tail + partial-overlap authority + delete race + invalidation/expand |
| routine prune bounded | filtered current window | compaction | prune result + refs unchanged |
| full Stats without thaw | hidden-inclusive Part scalar projection + batched raw aggregation | cold/schema/migration/stats-data | hot/v1/v2 report equality + owner/ref immutability |
| no Tool search | SQL projection | search | public Session list |
| TUI bounded | existing limit + page | message-v2 | 300-range test |
| full operations complete | classified full paths | unchanged owning consumers | export/compaction/revert/share regression |
| fork/delete/update/hide | ref+key transaction plus summary-seed mutation classification | projector/cold/summary-cache | parent-child lifecycle + opaque pre-seed/post-seed mutation results |
| physical observability | status PRAGMAs | cold | status values |
| <=5-minute cross-platform maintenance | grouped in-process zstd packs | cold | temporary-copy timing/no-child assertion |
| live DB read-only | temp-only verifier | process | source/destination assertion |
| proportional file surface | retain two cohesive deep modules, consolidate tests, remove peripheral consumer edits | §15 exact goal paths | goal-owned path query count = 16; three unrelated path status/diff hashes unchanged |

## 14. Reverse Traceability

| Concept | Invariant | Evidence | Why existing code is insufficient |
|---|---|---|---|
| cold_key | INV-04/05 | one pack has many entries | cold_ref cannot select entry |
| 1 MiB pack | INV-01/12/19 | measured 1,640-pack result and R9 200-second baseline | v1 row/frame/overflow overhead dominates |
| expanded fields | INV-01/09/10 | measured metadata/input/Step bytes | v1 only extracts output/text |
| v1 upgrade | INV-03/11 | current 26,828 payloads | null-ref scan skips them forever |
| CompactionBoundary deep seam | INV-06/07/22 | ColdStorage and MessageV2 need identical truth | existing private SQL cannot be reused and misses no-tail boundary |
| boundary-first stream | INV-06/08 | full stream persists thaw | in-memory filter is too late |
| hot chronology | INV-06/08 | Goal needs user/technical Part classification; cancel needs Message state plus selected pending Parts | full business hydration is unnecessary |
| summary ref/cursor | INV-06/16/18 | automatic summary is reachable each prompt and the external mirror may be deleted | current full hydrate and file-only authority are insufficient |
| summary initialized marker | INV-18/24 | pending import and post-expand rebuild currently share the same null pair | ref/cursor alone cannot select compatibility input without stale re-import |
| embedded opaque seed + hot `summary_seed` | INV-24/25 | observed persisted diff cannot be reconstructed from Tool rows | representation-only invalidation/expand must preserve it, while explicit covered-history mutation must retire it |
| cumulative-prefix lineage proof | INV-24/28 | normal mirror write precedes later Tool rows and external format has no cursor | assigning current max drops reachable tail; guessing mtime is not durable proof |
| transaction-local actual cursor | INV-18/29 | public delete can remove the pre-I/O ceiling | a captured ceiling no longer proves encoded history after async file I/O |
| inspect-mode decode | INV-03/13/16/18 | uncached authoritative read must rebuild without data loss | persistent business thaw would undo the archive |
| prune filtered window | INV-06/17 | prune stops at latest summary after loading all | pre-boundary rows cannot affect the result |
| high-frequency Session consumer closure | INV-06/17 | prompt, automatic summary and prune are reached during ordinary interaction | filtering after business hydration is too late and repeatedly reverses cold storage |
| `cold_stats` Part projection | INV-20/21 | exact simulation is 2.28% of full Tool/Step JSON | compressed packs cannot expose scalar lengths/components without full decode |
| batched Stats raw loader | INV-20/22 | public CLI repro thawed 33,060 owners | `Session.messages` is a business-hydration interface and cannot serve a read-only aggregate |
| hidden-inclusive Stats source set | INV-20/23 | latest user explicitly requires hidden data in every Stats result | business `Session.messages` visibility filtering cannot serve this raw analytics contract |
| pack metadata-only integrity gate | INV-13/26 | R5 inspect succeeds over a refcount state rejected by thaw | `decodePack` validates bytes, not real owner accounting; callers must not duplicate it |
| Tool search removal | INV-09 | explicit user requirement | current SQL intentionally includes it |
| physical status/gate | INV-01/14/15 | logical success with file growth | existing counters cannot prove file result |
| dedicated boundary/SummaryCache modules and one consolidated test | INV-22 | latest user permits up to 16 production files but rejects peripheral changes | the two shared state machines merit deep modules; scattered tests and peripheral consumers produce the unnecessary 28-path surface |

## 15. File-Level Change Plan

R14 final diff is exactly 17 goal-owned files total: 12 production files, two necessary behavior-test owners, two generated migration files and this canonical plan. Production remains below the accepted 16-file limit. Collapsing `CompactionBoundary` or `SummaryCache` solely to hide one required test path would reduce module depth without reducing production behavior, so the explicit 32-file ceiling governs this observed exception. The three unrelated paths named in §2 remain outside this set regardless of their staged/unstaged state.

| File | Action | Responsibility | Delta |
|---|---|---|---:|
| `packages/opencode/src/storage/cold.ts` | modify | v2 pack, expanded fields, v1 upgrade, grouped decode/refcount/status, seed+delta summary payload, seed-preserving invalidation/expand, inspect integrity and exact Part-stat projection; explicit VACUUM ends with verified WAL truncate | +1,375/-450 |
| `packages/opencode/src/session/session.sql.ts` | modify | binary cold_key, nullable cold_stats, summary ref/cursor/initialized/init-dirty/hot-seed state and stored projections | +100/-10 |
| `packages/opencode/src/session/compaction-boundary.ts` | add | one transaction-aware completed Compaction boundary query shared by ColdStorage eligibility and MessageV2 filtering | +75 |
| `packages/opencode/src/session/message-v2.ts` | modify | boundary-first range, hot chronology/pending and one selected-message hot predicate seam | +190/-40 |
| `packages/opencode/src/session/prompt.ts` | modify | bounded prompt/Goal/cancel callers | +55/-25 |
| `packages/opencode/src/session/search.ts` | modify | remove v1/v2 Tool indexing | +10/-45 |
| `packages/opencode/src/session/projectors.ts` | modify | ref+key clone/replace/delete and pre-seed-retiring/post-seed-preserving summary invalidation | +105/-20 |
| `packages/opencode/src/session/session.ts` | modify | public Session.diff, summary-only update and selected-message lookup delegation | +35/-10 |
| `packages/opencode/src/session/summary-cache.ts` | add | one-time legacy adoption, DB-authoritative opaque-seed/full-Tool build/read/CAS and path normalization | +560 |
| `packages/opencode/src/session/summary.ts` | modify | call Session's summary-cache seam, per-message diffs and mirror/counter/Bus orchestration | +120/-45 |
| `packages/opencode/src/session/compaction.ts` | modify | prune current compacted window only; restore unrelated post-process and failure-cleanup optimizations | +4/-5 |
| `packages/opencode/src/cli/cmd/stats/data.ts` | modify | hidden-inclusive batched Message/RequestUsage/Part projection aggregation without Session hydration | +190/-120 |
| `packages/opencode/migration/20260718230857_cold_storage_pack_v2/migration.sql` | generated add | cold_key, cold_stats and summary ref/cursor/initialized/init-dirty/seed columns/index | generated |
| `packages/opencode/migration/20260718230857_cold_storage_pack_v2/snapshot.json` | generated add | Drizzle snapshot | generated |
| `packages/opencode/test/storage/cold.test.ts` | modify | retain existing v1 regression owner; update its now-invalid Tool-search expectation and consolidate all R13/R5 vertical public-seam slices, including opaque-overlap authority, mutation rebuild, deterministic initialization races and fixture-owned ref assertions | +1,500-1,900/-15 |
| `packages/opencode/test/server/session-list.test.ts` | modify | replace the two contradictory v1/v2 Tool-search positive sets with explicit negative assertions while preserving visible Text/file/reference and explicit shell-command positive coverage | +15/-15 |
| `docs/plans/opencode-db-cold-storage-pack-v2.md` | add | canonical plan and audit evidence | docs |

To reach this final surface, implementation removes superseded R5-only worktree changes from `src/server/routes/instance/httpapi/handlers/session.ts`, `src/tool/plan.ts`, `src/permission/reviewer/service.ts`, `src/acp/agent.ts`, restores seven unrelated/scattered behavior-test paths, uses `test/storage/cold.test.ts` as the consolidated storage owner, and changes only the contradictory search matrices in `test/server/session-list.test.ts`. The temporary `test/storage/cold-storage-pack-v2.test.ts` is deleted after its slices move without semantic weakening. This resolves every observed full-suite search contradiction without restoring forbidden Tool indexing. The implementation also restores the unrelated VACUUM journal-mode rewrite and the non-prune Compaction hunks inside retained files. These goal-owned cleanup paths/ranges must contain no unrelated user edits; any mixed ownership blocks cleanup and requires user input. The three explicitly unrelated paths are never cleanup candidates and are compared byte/status-for-byte before and after implementation.

### 15.1 Necessity and invasiveness self-audit

| Final path group | Why modification is necessary | Existing logic that cannot carry it | Explicit restraint |
|---|---|---|---|
| `cold.ts` + `session.sql.ts` + two generated migration files | physical packing, refcount, reversible thaw, summary seed state, Stats projection and integrity are the storage root causes | v1 per-owner blobs and current schema cannot represent pack entry keys, projections or one-time summary initialization; VACUUM alone retained a full-size WAL in the measured copy | one table, one codec, no worker/sidecar/new CLI/config; vacuum remains explicit and only verifies/truncates its own WAL result |
| `compaction-boundary.ts` | age-independent compacted-head eligibility and boundary-first reads must share one semantic query | current private ColdStorage helper cannot be reused by MessageV2 and previously misses no-tail boundaries | one 75-line deep query accepting the caller transaction; no second boundary algorithm |
| `message-v2.ts` + `prompt.ts` + `compaction.ts` | normal prompt, Goal/cancel and end-of-turn prune otherwise hydrate compacted head before filtering | downstream model conversion cannot undo a persistent thaw already committed by page hydration | only range discovery/hot lookup changes; explicit export/revert/share/Compaction-body paths remain full |
| `session.ts` + `summary-cache.ts` + `summary.ts` + `projectors.ts` | existing imported diff regression, incremental summary and historical invalidation require one DB authority with exact lifecycle | ref/cursor null is ambiguous and Tool-only rebuild loses persisted legacy data | one dedicated cache module and existing orchestration/projector owners; no second service/cache, no mirror fallback, no public schema change |
| `stats/data.ts` | current all-time Stats thaws tens of thousands of owners | Session business hydration cannot be made read-only or hidden-inclusive by its caller | exact scalar projection only; hidden rows remain included, no global cache, and v2 payload bytes remain unread |
| `search.ts` | user explicitly removes Tool indexing so search never opens cold Tool fields | current SQL deliberately matches Tool identity/input/title | delete only Tool clauses; visible Text/title/file/subtask/patch/shell remain |
| consolidated storage test plus existing Session-list search owner | storage/range/summary/Stats need fixture-local consolidation, while two pre-existing public search matrices directly contradict INV-09 | one file cannot remove assertions from another existing suite, and restoring Tool indexing is forbidden | storage behavior remains consolidated; only the conflicting search matrix changes in the server owner; no production test hook |
| canonical plan | workflow/audit authority and exact scope record | chat summaries cannot authorize implementation | historical evidence is summarized; superseded file lists and stale artifacts are removed |

Removed as unnecessary or disproportionately invasive: HTTP manual-summarize pre-scan, PlanExit, ACP usage and Reviewer retry optimizations; Compaction post-process/failure-cleanup lookup rewrites; VACUUM journal-mode switching; eight scattered changed test paths plus the temporary added consolidated path after its slices move into `cold.test.ts`; GPU/Rust/WASM/workers; another codec/table/database; automatic vacuum; global Stats cache; public API/config changes; and every failure-triggered fallback. The measured post-VACUUM checkpoint is not journal switching or automatic maintenance; it is completion of the user-invoked physical operation.

## 16. TDD Behavior Slices

Agreed seams: public HTTP/Session diff, ColdStorage maintenance/verify/inspect/Part stats, SummaryCache authoritative read/build/swap, MessageV2 filter/page/get/hot chronology, SessionSummary per-message orchestration, SessionCompaction prune, Session.list(search), public `aggregateStats`, public Session fork/remove, and CLI maintenance against a fixture copy.

R14 implementation executes slices 23-33 vertically in `test/storage/cold.test.ts`; applicable compression-focused R5 slices 1-11 and 17-22 remain there or move into it. Slice 16 updates both existing public search owners so no contradictory Tool-positive assertion survives. Peripheral Compaction lookup, Reviewer, PlanExit and ACP slices 12-15 are removed with their production changes.

| Order | Red behavior | Current failure | Minimal green | Regression |
|---:|---|---|---|---|
| 1 | migrated v1 fixture reads with null key and can expand before downgrade | column absent | generated nullable columns + v1 state | startup/downgrade compatibility |
| 2 | two small owners share one pack with distinct keys/refcount 2 and exact expand | one payload per envelope | v2 writer/decoder | pack identity |
| 3 | fork owners share ref+key and thaw/delete independently | key absent | clone/release key | fork lifecycle |
| 4 | eligible v1 owner upgrades once across checkpoint replay | cold owner skipped | v1 candidate + v2 idempotence | resume |
| 5 | terminal Tool/Reasoning/memento/optional Step fields round-trip; pending/running/Text and Step usage fields stay hot | fields excluded | expanded extraction | safe boundary |
| 6 | bad pack/key/kind/hash hard-fails and owner stays cold | no pack validation | decoder trust seam | corruption evidence |
| 7 | filter result is unchanged and head refs stay cold, with and without tail | full stream; no-tail missed | shared boundary/range | prompt no-thaw |
| 8 | Goal classification stays identical without thawing completed head; cancel still finds orphans and aborts pending assistant Tools only | full stream | hot chronology/selective pending seam | lifecycle |
| 9 | valid Session-diff cache merges only new range and equals a full rebuild | full hydrate every prompt | ref/cursor delta | summary contract |
| 10 | any uncached Session-diff read builds the DB ref before returning; deleting the external mirror does not change Session.diff; historical replacement releases cache; referenced corruption hard-fails | no cache proof | SummaryCache inspect/build + projector invalidation | deletion/corruption safety |
| 11 | end-of-turn prune has identical mutations while compacted-head refs remain cold | full Session hydrate | filtered window | prune contract |
| 16 | Tool terms do not match while visible locators still do | Tool SQL branches | remove exact branches | search |
| 17 | limit 300 thaws only range; inventoried export/no-limit/full consumers stay complete | no combined assertion | preserve classified split | frontend behavior |
| 18 | copied DB is <=1.5 GB and expand hashes match baseline | R9 active 1.858 GB | complete path | original symptom |
| 19 | status separates logical/physical metrics and explicit vacuum leaves zero WAL or hard-fails busy | VACUUM retained a full-size WAL | PRAGMA report + checked `wal_checkpoint(TRUNCATE)` | physical completion UX |
| 20 | hot and v2-cold `aggregateStats` reports are deeply equal and all ref/key/payload rows remain unchanged | Stats calls `Session.messages` and thaws owners | `cold_stats` + batched raw loader | all pivots/filters/full history |
| 21 | deployed v1 Tool/Step Stats equals hot baseline without changing v1 owner/refcount | v1 has no projection | grouped non-persisting inspect compatibility | upgrade-before-use is not required |
| 22 | missing/malformed/mismatched v2 `cold_stats` hard-fails and verify reports corruption | no projection invariant | typed projection validation/recompute | no hidden pack-decode fallback |
| 23 | hidden Message and hidden Part fixtures contribute their literal expected messages, tokens, tools, chars and status values to every affected public Stats pivot, identically in hot/v1/v2 states, while their cold refs remain unchanged | business hydration excludes them and cannot implement the contracted raw analytics set | retain all persisted rows in the scalar loader | explicit hidden-inclusive Stats contract without thaw |
| 24 | the unchanged HTTP regression returns the persisted missing-`patch` legacy row | null state discards file and returns `[]` | one-time validated adoption through the existing HTTP seam | shipped imported-data contract |
| 25 | first automatic summarize from pending state updates Session counters/mirror/Bus once; after initialization, deleting or replacing the mirror cannot change either public diff seam | materialization can be mistaken for cursor-only unchanged work | `materialized` CAS result plus DB-only initialized reads | orchestration side effects and no post-init mirror read |
| 26 | mismatching opaque legacy data survives `db expand` and a post-seed suffix invalidation; no cold ref remains after expand and the next diff is byte-equal without the mirror | aggregate-only ref is released | embedded seed -> hot seed -> rebuilt post-seed payload | reversible opaque compatibility while covered history is unchanged |
| 27 | refcount drift makes `Session.diff` packed inspect and v2 Stats fail while preserving every owner/ref/payload row | packed inspect bypasses ownerCounts | shared metadata integrity gate | same corruption verdict as thaw, no Stats payload decode |
| 28 | the consolidated file and full package use fixture-owned assertions; shared identical payloads may remain for other Sessions without causing failure | global counters/hash deletion assertions race | owner/session-scoped observations or unique fixture content | cross-file isolation without serializing production |
| 29 | a mirror captured at an earlier user-message boundary plus later persisted Tool rows returns the complete current Tool aggregate exactly once | R6 labels the seed as covering current max and drops the tail | exact prefix proof suppresses only a redundant seed; delta is always the complete Tool aggregate | normal step-1 mirror ordering |
| 30 | while a delayed pending mirror read is open, deleting the captured latest Message causes initialization to commit the transaction's remaining closed boundary; first and second public diff calls both succeed | R6 commits the deleted ceiling and next load reports ahead cursor | transaction-local `actualStableMaxID`; Deferred-controlled Storage test seam | public diff/delete concurrency |
| 31 | a valid legacy diff partially overlaps Tool evidence but matches no cumulative prefix: first public/HTTP result is byte-equal to legacy with no duplicate patch/counters; after initialization, a newly completed closed turn is appended exactly once | R7 merges both historical aggregates and duplicates overlap | opaque seed authoritative through stable initialization cursor + strictly later delta | import/migration compatibility and future incremental summary |
| 32 | after slice 31, public Part PATCH/DELETE and undo-hidden mutation at/before the opaque cursor retire the seed; next public/HTTP diff equals a literal full rebuild from current visible Tool Parts, while a mutation strictly after the seed cursor preserves the seed and rebuilds only its suffix | R8 permanently returns stale opaque diff | mutation-position classification in the projector transaction; never reread mirror | existing revert semantics and public mutation endpoints |
| 33 | while a mocked mirror read is delayed after the claimed cursor is persisted, public Part PATCH/DELETE, undo-hidden or a new Part under a covered closed Message changes that history; `summary_init_dirty` persists, first and second public/HTTP diff equal the mutation-after literal Tool rebuild, and the stale mirror is never committed as a seed; new Message/later IDs/running-Assistant activity leaves dirty false | R9 has no persisted mutation witness during external I/O | claimed pending state + projector dirty bit + final immediate-state check | deterministic pending initialization/mutation race and crash-resume rule |

Expected values use literal fixtures, pre-operation business JSON/hash, public results and file bytes. No private helper calls, compressor counts, source-text assertions, or duplicated packing algorithm are allowed.

The initialization/mutation races use `Layer.mock(Storage.Service)` only at the existing filesystem-service boundary: `read` publishes a `Deferred` readiness signal and waits for a second `Deferred`; tests invoke public `Session.diff`, perform public remove/PATCH or undo-hidden operations, release or interrupt the read, and compare first/resumed public results with a literal rebuild from the mutated fixtures. They do not add a production hook, sleep, call-count assertion or private SummaryCache seam.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
|---|---:|---|
| Effective changed lines E | 4,189 actual | post-audit-fix conservative recount; excludes imports, generated migration and docs but claims no formatter/pure-move deductions |
| Required C | 629 actual | `ceil(4,189*0.15)`; final qualifying C is also 629 with no run longer than three lines |

Comments must explain pack/entry identity, v1-v2 dispatch, 1 MiB boundary, grouped refcount, checkpoint idempotence, projection invariants, no-tail cutoff, boundary-before-hydrate, unclaimed/claimed/dirty/initialized summary states, opaque seed preservation/retirement, ref/cursor swap, inspect-vs-thaw ownership, hidden Stats equivalence, fixture-local observability, call-site classification, search contract and independent test intent. Obvious flow does not count.

## 18. Verification

| Command | cwd | Evidence |
|---|---|---|
| `bun test test/storage/cold.test.ts --timeout 60000` | packages/opencode | all packed storage, range, summary, hidden-inclusive Stats and search vertical slices in the sole changed test file; specifically proves the obsolete Tool-search assertion was replaced rather than bypassed |
| `bun test test/server/session-list.test.ts test/server/global-session-list.test.ts --timeout 60000` | packages/opencode | v1/v2 Tool fields no longer match while visible locators and explicit shell commands retain existing search behavior |
| `bun test test/server/session-diff-missing-patch.test.ts --timeout 60000` | packages/opencode | shipped imported diff survives first DB initialization through the public HTTP seam |
| `bun test test/storage/cold.test.ts test/server/session-diff-missing-patch.test.ts --timeout 60000` | packages/opencode | changed and unchanged compatibility suites share one runner without global fixture assumptions |
| `bun test test/storage/db.test.ts test/session/session.test.ts --timeout 30000` | packages/opencode | schema/session regressions |
| `bun typecheck` | packages/opencode | type safety |
| `bun run db generate --name cold_storage_pack_v2` in an approved temporary repository/output, then compare into the existing undeployed migration folder | temporary package copy | generated SQL/snapshot without an extra final path |
| `bun run db check` | packages/opencode | migration lineage and snapshot integrity |
| one recorded `bun test --timeout 60000` plus the focused commands above | packages/opencode | the package run recorded 3,931 pass/57 skip/5 unrelated fixed-timeout failures in 62.8 minutes; the user explicitly replaced any rerun requirement with the recorded run plus focused GREEN evidence and prohibited the auditor from rerunning it |
| `bun run build --single --skip-install --skip-embed-web-ui` plus §18.1 isolated CLI block | packages/opencode | compiled current-copy physical/duration/round-trip gate |
| `git diff --check -- <approved paths>` | root | whitespace gate |
| ownership-aware path script below | root | exact 17 goal-owned paths plus unchanged status/binary diff hash for three unrelated paths |

Temporary-copy gate:

1. Python sqlite backup from read-only live URI to an approved temp path; assert paths differ.
2. Stream logical hydrated Message/Part counts and SHA-256 without writing source.
3. Run locally built migration/default compress/verify/vacuum only on the copy.
4. Assert main+WAL <=1,500,000,000 bytes and report dbstat plus distance to 1.2/1.0 GB.
5. Run `stats --all-time --color never` before and after compression; outputs must match and an owner/ref snapshot must prove zero Session summary, Message, Part or cold_storage mutation.
6. Expand the copy and compare counts/SHA-256, including `cold_stats=NULL` for every hot Part. Focused seed tests separately prove that an initialized opaque legacy summary is materialized in DB state and can rebuild after expand without an external file.
7. Report compress-only duration, total maintenance duration, pack count, raw/compressed bytes, max pack and page latency. Default compress target is <=5 minutes at current scale.
8. Delete temp artifacts after recording evidence.

Ownership-aware file gate:

Before implementation, capture `git status --short -- <three-unrelated-paths>` and SHA-256 of `git diff HEAD --binary -- <three-unrelated-paths>`. After implementation, require both values to match exactly. Build the changed-path set from the union of `git diff HEAD --name-only` and `git ls-files --others --exclude-standard`; intersect it with the literal 17-path §15 set and require `Compare-Object` to be empty. Superseded goal paths must not occur in that union. Other concurrently added user paths are reported but are neither counted as goal-owned nor modified. This gate never stages, restores or deletes any path.

### 18.1 Executable temporary-copy command path

The following PowerShell procedure is the only accepted current-scale gate. It is run from `packages/opencode` **after implementation**, never during plan/audit and never with the live DB as `OPENCODE_DB`. It uses the existing absolute-path override and isolated XDG/lock roots used by the repository's CLI tests.

```powershell
$ErrorActionPreference = "Stop"
$root = "F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode"
$live = "C:\Users\Lenovo\.local\share\opencode\opencode.db"
$parent = "D:\Temp\opencode"
if (-not (Test-Path -LiteralPath $live)) { throw "Live DB is missing: $live" }
if (-not (Test-Path -LiteralPath $parent)) { throw "Approved temp parent is missing: $parent" }
$stamp = Get-Date -Format "yyyyMMddHHmmssfff"
$temp = Join-Path $parent "db-pack-v2-$stamp"
New-Item -ItemType Directory -Path $temp | Out-Null
$source = Join-Path $temp "source.db"
$baseline = Join-Path $temp "baseline.db"
$work = Join-Path $temp "work.db"
function Get-SharedSha256([string] $Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}
$liveBefore = [pscustomobject]@{
  bytes = (Get-Item -LiteralPath $live).Length
  mtime = (Get-Item -LiteralPath $live).LastWriteTimeUtc
  sha256 = Get-SharedSha256 $live
}

# The source is opened through SQLite's read-only URI; backup() writes only source.db.
python -c "import sqlite3,sys; from pathlib import Path; s=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" $live $source
if ([IO.Path]::GetFullPath($source) -eq [IO.Path]::GetFullPath($live)) { throw "Source and live paths are identical" }
Copy-Item -LiteralPath $source -Destination $baseline
Copy-Item -LiteralPath $source -Destination $work

$env:OPENCODE_DB = $work
$env:OPENCODE_LOCK_PATH = Join-Path $temp "lock"
$env:OPENCODE_TEST_HOME = Join-Path $temp "home"
$env:XDG_DATA_HOME = Join-Path $temp "share"
$env:XDG_CACHE_HOME = Join-Path $temp "cache"
$env:XDG_CONFIG_HOME = Join-Path $temp "config"
$env:XDG_STATE_HOME = Join-Path $temp "state"
$env:OPENCODE_PROCESS_ROLE = "main"
$env:OPENCODE_DAEMON_LAUNCHER_PID = ""
$env:OPENCODE_PURE = "1"
$env:CI = "1"

bun run build --single --skip-install --skip-embed-web-ui
$candidates = @(Get-ChildItem -LiteralPath (Join-Path $root "dist\opencode-windows-x64\bin") -Filter "opencode*" -File)
if ($candidates.Count -ne 1) { throw "Expected exactly one local Windows CLI binary" }
$cli = $candidates[0].FullName

function Invoke-CopyCli([string[]] $CliArgs) {
  $output = & $cli @CliArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "CLI failed: opencode $($CliArgs -join ' ')`n$output" }
  return $output.Trim()
}

function Invoke-VerifiedCopy {
  $value = Invoke-CopyCli @("db", "verify") | ConvertFrom-Json
  $report = if ($null -ne $value.report) { $value.report } else { $value }
  if ($report.refCountMismatches -ne 0 -or $report.missingPayloads -ne 0 -or $report.corruptPayloads -ne 0) {
    throw "verify failed: $($value | ConvertTo-Json -Compress)"
  }
  return $value
}

function Get-StorageStateHash([string] $Path) {
  $value = python -c "import hashlib,json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); h=hashlib.sha256(); queries=[('session','select id,summary_ref,summary_cursor,summary_initialized,summary_init_dirty,summary_seed from session order by id'),('message','select id,cold_ref,hex(cold_key) from message order by id'),('part','select id,cold_ref,hex(cold_key),cold_stats from part order by id'),('cold_storage','select hash,kind,codec,raw_bytes,compressed_bytes,ref_count,time_created,time_updated from cold_storage order by hash')]; [h.update((name+'\\0'+json.dumps(row,separators=(',',':'))+'\\n').encode()) for name,query in queries for row in d.execute(query)]; d.close(); print(h.hexdigest())" $Path
  if ($LASTEXITCODE -ne 0) { throw "storage state hash failed" }
  return $value.Trim()
}

@'
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

const file = process.argv[2]
if (!file) throw new Error("hash-business.ts requires a database path")
const db = new Database(file, { readonly: true })
const jsonFields = new Set(["data", "model", "summary_diffs", "revert", "permission"])
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const ignored = {
  session: new Set(["summary_ref", "summary_cursor", "summary_initialized", "summary_init_dirty", "summary_seed"]),
  message: new Set(["cold_ref", "cold_key"]),
  part: new Set(["cold_ref", "cold_key"]),
}
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => compare(a, b)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}
const digest = createHash("sha256")
const counts: Record<string, number> = {}
for (const table of ["session", "message", "part"] as const) {
  const rows = db.query(`select * from ${table} order by id`).all() as Record<string, unknown>[]
  counts[table] = rows.length
  for (const row of rows) {
    const normalized = Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !ignored[table].has(key))
        .sort(([a], [b]) => compare(a, b))
        .map(([key, value]) => {
          if (jsonFields.has(key) && typeof value === "string") return [key, canonical(JSON.parse(value))]
          return [key, value]
        }),
    )
    digest.update(`${table}\0${JSON.stringify(canonical(normalized))}\n`)
  }
}
const liveRefs = (db.query("select count(*) as count from cold_storage where ref_count != 0").get() as { count: number }).count
if (liveRefs !== 0) throw new Error(`expanded copy retains ${liveRefs} cold refs`)
const payloads = (db.query("select count(*) as count from cold_storage").get() as { count: number }).count
if (payloads !== 0) throw new Error(`expanded copy retains ${payloads} cold payload rows`)
db.close()
console.log(JSON.stringify({ counts, hash: digest.digest("hex") }))
'@ | Set-Content -LiteralPath (Join-Path $temp "hash-business.ts") -Encoding utf8

$resolved = Invoke-CopyCli @("db", "path")
if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($work)) { throw "db path did not resolve to work copy" }

# Expand a separate baseline copy, then hash canonical business rows. The work copy
# remains an unexpanded snapshot for the physical compress gate.
$env:OPENCODE_DB = $baseline
$resolved = Invoke-CopyCli @("db", "path")
if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($baseline)) { throw "db path did not resolve to baseline copy" }
Invoke-CopyCli @("db", "expand", "--all", "--yes") | Out-Null
Invoke-CopyCli @("db", "vacuum", "--yes") | Out-Null
$baselineHash = & bun (Join-Path $temp "hash-business.ts") $baseline | ConvertFrom-Json
$baselineStats = Invoke-CopyCli @("stats", "--all-time", "--color", "never")

$env:OPENCODE_DB = $work
$resolved = Invoke-CopyCli @("db", "path")
if ([IO.Path]::GetFullPath($resolved) -ne [IO.Path]::GetFullPath($work)) { throw "db path did not resolve to work copy" }
$maintenanceWatch = [Diagnostics.Stopwatch]::StartNew()
$compressWatch = [Diagnostics.Stopwatch]::StartNew()
$compress = Invoke-CopyCli @("db", "compress", "--older-than", "30d", "--batch-size", "2000") | ConvertFrom-Json
if ($compress.status -eq "running" -or $compress.status -eq "queued") {
  do {
    Start-Sleep -Seconds 1
    $task = Invoke-CopyCli @("db", "status", "--task", $compress.taskID) | ConvertFrom-Json
  } while ($task.status -in @("queued", "running"))
  if ($task.status -ne "completed") { throw "compress task did not complete: $($task | ConvertTo-Json -Compress)" }
}
$compressWatch.Stop()
Invoke-VerifiedCopy | Out-Null
Invoke-CopyCli @("db", "vacuum", "--yes") | Out-Null
$maintenanceWatch.Stop()
$bytes = (Get-Item -LiteralPath $work).Length
$walBytes = if (Test-Path -LiteralPath "$work-wal") { (Get-Item -LiteralPath "$work-wal").Length } else { 0 }
if ($bytes -gt 1500000000) { throw "physical gate failed: $bytes" }
if ($bytes + $walBytes -gt 1500000000) { throw "main+WAL physical gate failed: $($bytes + $walBytes)" }
if ($compressWatch.Elapsed.TotalMinutes -gt 5) { throw "compress duration gate failed: $($compressWatch.Elapsed)" }
Invoke-CopyCli @("db", "status") | Set-Content -LiteralPath (Join-Path $temp "status.json")
$storageBeforeStats = Get-StorageStateHash $work
$coldStats = Invoke-CopyCli @("stats", "--all-time", "--color", "never")
$storageAfterStats = Get-StorageStateHash $work
if ($storageAfterStats -ne $storageBeforeStats) { throw "Stats mutated cold owner or payload state" }
if ($coldStats -ne $baselineStats) { throw "Stats output changed after compression" }

Invoke-CopyCli @("db", "expand", "--all", "--yes") | Out-Null
Invoke-VerifiedCopy | Out-Null
$expandedHash = & bun (Join-Path $temp "hash-business.ts") $work | ConvertFrom-Json
if ($expandedHash.hash -ne $baselineHash.hash) { throw "business hash mismatch after expand" }
if ($expandedHash.counts.message -ne $baselineHash.counts.message -or $expandedHash.counts.part -ne $baselineHash.counts.part) { throw "business row count mismatch" }
$liveAfter = [pscustomobject]@{
  bytes = (Get-Item -LiteralPath $live).Length
  mtime = (Get-Item -LiteralPath $live).LastWriteTimeUtc
  sha256 = Get-SharedSha256 $live
}
if ($liveAfter.bytes -ne $liveBefore.bytes -or $liveAfter.mtime -ne $liveBefore.mtime -or $liveAfter.sha256 -ne $liveBefore.sha256) {
  throw "live database changed during verification; discard this run as unsafe"
}
```

`hash-business.ts` is created only under `$temp` and opens its argument with `new Database(path, { readonly: true })`. It canonicalizes JSON object keys recursively, hashes `session`, `message`, and `part` business columns while excluding only maintenance representations (`summary_ref`, `summary_cursor`, `summary_initialized`, `summary_init_dirty`, `summary_seed`, `cold_ref`, `cold_key`), and reports row counts plus SHA-256. Opaque-seed semantic equality is not waived by this exclusion: focused public `Session.diff`/HTTP tests compare its exact FileDiff value before cold storage, after mirror deletion, after invalidation and after expand. The script also asserts zero nonzero cold-owner refs after expand. It is not a repository change.

Before the first command, record the live DB path, size, mtime and SHA-256; after cleanup, repeat the read-only observation and report any live change as an unsafe verification run rather than attributing it to the implementation. The isolated `OPENCODE_DB`, `OPENCODE_LOCK_PATH`, XDG roots and `db path` assertions are mandatory for every CLI invocation; no live daemon/control lock is eligible. Record the JSON task result, status report, duration, file length, baseline/expanded hashes and all exit codes before deleting `$temp`.

## 19. Diff Budget

| Metric | Estimate | Reason |
|---|---:|---|
| files added | 5 | two cohesive production modules, canonical plan and two generated migration files |
| files modified | 12 | ten existing production paths plus the storage and Session-list test owners |
| files deleted | 0 | no replacement path |
| production lines | 1,900-2,500 | pack/upgrade, dedicated boundary/SummaryCache, authoritative state machine and Stats projection dominate |
| test lines | 1,500-1,900 added, at most 15 removed | all vertical storage/range/cache/consumer/Stats/race/isolation coverage is consolidated in the existing storage test owner; the contradictory Tool-search expectation is replaced |
| generated lines | 2,500-3,000 | excluded from E |

## 20. Real Risks and Open Decisions

### Real Risks

- Pack amplification: selected owner may decode <=1 MiB; request groups refs and decodes once. Oversize single entries retain existing unavoidable size.
- Legacy shared refs: old payload is deleted only after real remaining refs reach zero in the same transaction.
- Boundary drift: one shared query replaces duplicate semantics; tests compare output and cold refs.
- Search change: only Tool branches are removed; positive visible-search assertions prevent accidental narrowing.
- Physical variability: timestamped source size and exact copy are recorded; logical estimates cannot waive file failure.
- Pack memory: stream one Session/kind and one target pack; never collect the full DB.
- Summary initialization races: a claimed stable cursor and dirty bit are persisted before external I/O. Covered closed-history mutation dirties that exact claim; later IDs and running-Assistant updates remain future delta. Final immediate-state check either discards stale mirror input or lets one concurrent initializer become the sole DB authority, and crash resume observes the same claim.
- Opaque legacy provenance: an exact cumulative Tool-prefix match proves the legacy value is already represented and lets the cache use the complete Tool aggregate. If no match exists, the legacy value remains authoritative through the persisted stable initialization cursor; existing Tool evidence is not merged speculatively, while later closed turns append normally.
- Seed release ordering: representation-only invalidation/expand and post-seed mutation decode/persist the opaque seed before release; a covered-history mutation deliberately retires it and marks a full Tool rebuild. Classification, ref clearing and release share one transaction, and corruption leaves the old owner intact.
- Inspect misuse: non-persisting decode is exported only for SummaryCache rebuild and shares payload existence/kind/refcount plus codec/key/hash validation with thaw; frontend/business reads cannot select it. Stats reuses metadata validation but not payload decode.
- Stats projection/source-set drift: verify recomputes from decoded entries, hidden fixtures assert their positive literal contribution, hot/v1/v2 reports are deeply compared, and hot replacement/thaw clears the derived column rather than retaining stale values.
- Stats v1 cost: deployed v1 rows may require grouped in-memory inspect on the first Stats call, but this branch never writes and disappears after normal v2 compress upgrade; v2 Stats cannot select it.
- Physical margin: the final R15 product path leaves 157,081,344 decimal bytes below the 1.5 GB gate, but remains 142,918,656 bytes above the non-blocking 1.2 GB preference; main+WAL evidence, not logical compression counters, owns this verdict.
- Active-Revert refresh window: normal TUI/App undo consumes the existing `session.diff` event, and every retry/new prompt runs `revert.cleanup` before creating history, so covered hidden mutations invalidate/rebuild the cache. A client restart or explicit force refresh while a Revert marker is still active may observe the pre-cleanup DB aggregate. This narrow display-only window neither loses Message/Part data nor enters the next model context; the user explicitly chose not to add a parallel replacement write path or alter Revert timing for it.
- File budget: the final goal-owned diff is exactly 17 files: 12 production, two necessary existing test owners, two generated migration files and this plan. The temporary added `cold-storage-pack-v2.test.ts` and all other superseded goal paths must be absent; the three unrelated worktree paths remain unchanged and excluded from the count.
- Test concurrency: content-addressed summary/Part payloads can be shared across Sessions in one runner. Assertions use fixture-owned rows or unique payload content, never process-global counts; production serialization is not changed to accommodate tests.

### Open Decisions Requiring the User

None. The user supplied the topology, physical threshold/preference, live-DB prohibition, Tool-search removal and frontend/backend boundary. R13 preserves the user's explicit selection of R10's existing Revert event/cleanup flow over a new replacement seam after reviewing the concrete TUI/App call paths. Visible Text preservation follows a reachable public contract.

### Rejected Speculation

- Higher zstd level: measured gain is only 10-12 MB.
- Cold visible Text: exact substring search would regress without authorization.
- Implicit vacuum: remains an unbounded blocking write and explicit command.
- Public no-limit API change: TUI already uses 300; export intentionally uses full history.
- New archive table/files: same-table pack meets the evidenced need.
- Decode every v2 pack during Stats: it avoids persistent writes but still expands up to 1.4 GB raw on every report and violates the new no-large-thaw requirement.
- Global Stats cache/table: update/delete/fork/window invalidation would create a second aggregate authority; exact per-Part scalar projection is sufficient and only 2.28% of source JSON.
- Leave Tool/Step fields hot: the measured 1.237 GB source surface would erase the physical-space repair.
- Merge an unproven legacy mirror with all current Tool history: independent import/migration producers can overlap partially, so seed+full-delta duplicates public patches and counters. R9 preserves the existing aggregate through a transaction-local stable boundary, appends only provably later contributions, and retires the derived seed when the user later mutates its covered history.
- Read the mirror after invalidation/expand: this would re-import stale or user-deleted compatibility output and is the prohibited alternate success path that `summary_initialized` exists to exclude.

## 21. Audit Contract

The independent auditor must read this exact revision and verbatim requirement, reconstruct source/tests independently, distrust builder summaries, audit full scope every round, and check the physical gate, zero loss, v1 compatibility, pack/refcount, prompt range, no-tail boundary, exact legacy-prefix representation proof, transaction-local cursor, opaque-seed expand/invalidation atomicity, scoped routine/full Message consumers, hidden-inclusive exact Stats parity with metadata-only v2 integrity and zero payload decode/thaw, Tool search, no-live-write rule, fixture isolation, fallback inventory, exact 17-path mapping with 12 production files, TDD seams and 15% comments.

## 22. Plan Audit Record

| Round | Revision | Full scope | Blocking | Non-blocking | Result | Invocation |
|---:|---|---|---|---|---|---|
| - | R1 | not completed | none | none | superseded before audit; no verdict | invocation aborted (`user_abort`) |
| 1 | R2 | yes | B-01 permission-review retry retains an unbounded full Session stream | physical gate remains implementation-time evidence | BLOCK | `ses_088d2abc1ffeUnkI5WF9jlPwTW` |
| 2 | R3 | yes | B-01 null/post-expand Session-diff reads still use the cleanable external mirror; B-02 temporary-copy acceptance path is not executable | physical gate remains implementation-time evidence | BLOCK | `ses_088a75c36ffeAT3b6CfyQWAnjl` |
| 3 | R4 | yes | none | generated migration directory is resolved at implementation time; physical gate remains implementation-time evidence | APPROVE | `ses_0888ef4d7ffeSPLZSPDBWe7Y8B` |
| 4 | R5 | yes | none | final physical result remains an implementation hard gate; generated migration path/snapshot must be recorded exactly | APPROVE | `ses_086967742ffeo7IlhYMkZQWpeo` |
| 5 | R6 | yes | B-01, B-02, B-03 | physical gate remains implementation-time; 1.0/1.2 GB remains a preference; comment commitment is feasible | BLOCK | `ses_085cc0720ffe9gZi5mYQrGm5U3` |
| 6 | R7 | yes | B-01, B-02 | standalone SummaryCache location record | BLOCK | `ses_085991ae1ffeMGFKbkEWcHphlq` |
| 7 | R8 | yes | B-01 | completed-boundary ownership wording | BLOCK | `ses_0858a2d04ffe2BQW05eX7emYPL` |
| 8 | R9 | yes | B-01 | none | BLOCK | `ses_0852fa7d8ffekb0jHEuipadfCS` |
| 9 | R10 | yes | user adjudicated B-01 as post-verification workflow, not an implementation blocker | N-01 wording corrected without behavior change | USER APPROVE | runtime invocation aborted; full report and user decision preserved in this record |
| 10 | R13 | yes | B-01, B-02 | INV-01 wording; implementation-time E/C recount; temporary test path is pending implementation cleanup | BLOCK | `ses_0844855edffeFsyh1ClJqzbQOJ` |

Recorded independent verdict for exact R4: `No blocking findings.` `APPROVE`.

Recorded independent verdict for exact R5: `No blocking findings.` `APPROVE — exact canonical revision R5 only.` Non-blocking findings: rerun the complete §18.1 main+WAL physical gate after adding `cold_stats`; record the actual generated migration directory and snapshot in implementation evidence.

Verbatim blocking finding titles and release verdict for exact R6:

- `B-01 旧镜像被错误标记为覆盖当前游标，永久遗漏后续 Tool diff` — `Blocking`.
- `B-02 初始化期间删除最新 Message 会提交超前游标` — `Blocking`.
- `B-03 28 文件方案超过用户要求的 16 文件整体范围` — `Blocking`.

Verbatim non-blocking findings for exact R6:

- `<=1,500,000,000` bytes 仍是 implementation-time hard gate。R5 的 `1,327,226,880` bytes 结果证明方向具有可行性，但 R6 新增 summary state/payload 后仍须完整重跑 §18.1；计划已正确保留该门禁。
- 1.0/1.2 GB 是优化偏好。当前测量结果高于 1.2 GB，但低于 1.5 GB 硬门槛；没有证据支持将其升级为独立阻断项。
- §17 的 `E=4,250–5,150`、至少保留 800 条合格中文解释注释，承诺不低于 `ceil(E*0.15)`，在 plan mode 下可行。实际 `E/C` 仍由 implementation audit 重新计算。

> **BLOCK — exact canonical revision R6。**
>
> R6 在 legacy summary 初始化中存在两个可达的数据完整性/可用性缺陷，并且计划的 28 文件整体范围超过当前原始需求的 16 文件约束。修订后需要对完整原始需求和全部 affected interface 再做 full-scope plan audit。

Verbatim blocking finding titles and classifications from exact R7:

- `B-01 不可证明 lineage 的 legacy diff 会与完整 Tool aggregate 重复合并` — `Blocking`.
- `B-02 16 文件验收门禁与必须保留的三个无关路径直接冲突` — `Blocking`.

Verbatim non-blocking finding from exact R7:

- `§10.5 line 353 声称 SummaryCache 顶层函数放在 session.ts 且 standalone file 被删除；§15 line 548、§15.1、§20 和实际文件映射均要求新增 summary-cache.ts。`

Verbatim release verdict:

> **BLOCK — exact canonical revision R7。**
>
> 这是第 6 次、也是计划审计上限轮次。B-01 与 B-02 作为未解决的 blocking open decisions 保留：R7 不得进入实现或记录 approval。任何实质修订仍需新的 full-scope 审核；迭代上限不能通过弱化 finding 绕过。

The user's earlier instruction raised the audit-round ceiling to ten, superseding the six-round limit assumed by the R7 auditor. R8 corrects both findings without weakening them: an unproven legacy aggregate is authoritative through a stable initialization boundary and receives only provably later Tool contributions, while file-count verification operates only on the explicit goal-owned set and preserves three unrelated worktree paths. Every prior approval remains cleared; implementation remains prohibited until an exact R8 full-scope audit approves it.

Verbatim blocking finding title and classification from exact R8:

- `B-01 opaque seed 会在历史 Tool 更新或删除后永久保留失效 diff` — `Blocking`.

Verbatim non-blocking finding from exact R8:

- `N-01 completed Compaction boundary 的所有权记录互相矛盾`.

Verbatim release verdict:

> **BLOCK — exact canonical revision R8。**
>
> R8 不得记录 approval 或进入 implementation。B-01 需要形成新的 canonical revision，并对原始需求和完整 affected interface 再做 full-scope plan audit。当前是提高上限后的第 7 轮计划审计，仍在用户允许的 10 轮以内。

R9 follows the repository's existing reachable mutation semantics instead of retaining stale derived state: `SessionRevert.revert` already recomputes Tool diffs and overwrites `session_diff`, while HTTP exposes Message/Part DELETE and Part PATCH. A historical mutation at/before an opaque seed cursor therefore retires that derived Session-level seed and rebuilds from current visible Tool Parts. Message/Part business rows and per-Message `summary.diffs` remain under their existing thaw/update/delete contracts. File ownership and the R7 overlap correction remain unchanged. Every prior approval remains cleared; implementation is prohibited until exact R9 approval.

Verbatim blocking finding title and classification from exact R9:

- `B-01 pending 初始化期间的历史 mutation 可把旧 mirror 重新确立为权威 seed` — `Blocking`.

Verbatim release verdict:

> **BLOCK — exact canonical revision R9。**
>
> R9 不得记录 approval 或进入实现。B-01 修订后需要针对原始需求和完整 affected interface 再执行一次 full-scope plan audit。

R10 adds one persisted `summary_init_dirty` bit owned by SummaryCache/projectors. Pending initialization first claims a stable cursor in DB with dirty=false. An existing covered owner updated/hidden/removed, or a new Part inserted under a covered closed Message, flips dirty=true. New MessageIDs, later IDs and activity under a running Assistant do not. After external I/O, dirty=true proves the mirror predates covered history, so initialization builds from current visible Tool rows with no legacy seed. The initializing state is crash-resumable and a dirty resume skips the mirror. This closes the race without locking frontend calls, adding a second source or changing normal active-turn behavior.

Verbatim finding titles and classifications from the exact R10 full-scope report:

- `B-01 最终 verified implementation 没有对应的 commit 完成路径` — `Blocking`.
- `N-01 completed-boundary 所有权记录仍有文字冲突` — `Non-blocking`.

The report found no other production-design blocker and explicitly rejected a second codec, external archive, GPU/Rust/WASM/worker, automatic vacuum and failure-triggered fallback as unsupported expansion. Because the runtime audit invocation was aborted before returning an identifier, the user supplied the full report text. The user then explicitly decided: `这个内容理论上来说已经是完成的了,commit只是后面我们要做的事情,现在还没有开始实施。` and `本次没有block，通过，进入完整TDD阶段，不需要的修改请进行撤销`. The completed-boundary wording is aligned to `CompactionBoundary.latest` in §9 without changing behavior; local commit remains governed by the Session GOAL after verified implementation and implementation audit. R11/R12 are withdrawn, and no Revert replacement seam is authorized.

Verbatim blocking finding titles and classifications from exact R13:

- `B-01 R13 已超过计划审计轮次硬上限，且缺少有效的用户例外授权` — `Blocking`.
- `B-02 最终 local commit 与禁止 push 的完成路径仍未纳入 R13` — `Blocking`.

Verbatim release verdict:

> **BLOCK — exact canonical revision R13。**
>
> R13 不得记录 `approved` 或进入新的实现阶段。当前审计已经超过仓库规定的 6 轮计划审计上限，必须先由用户处理该 open decision；同时，当前明确要求的 verified 后 local commit/no-push 路径尚未进入 canonical plan。

User adjudication for exact R13: `请注意,第十轮,如果他只是在质疑workflow的话,那就没有问题,你不需要回答他,这本身不算实质性错误和block,即便你再审计一次,结果也不会变。所以理论上来说,我们当前已经完成了相应的审计,因此请你按照workflow进入下一个流程,你直接显示将状态改为用户通过即可。` The user classified both R13 findings as workflow-only, accepted the already full-scope production design, and explicitly authorized the administrative transition to `approved` without an eleventh audit. The independent report found no production-design blocker in ColdStorage, SummaryCache, Stats, search, migration, physical gate or the exact 16-path design.

## 23. Implementation Evidence

R5 implementation evidence is superseded and intentionally removed from this section. Its durable facts remain in §4, its approval history remains in §22, and its exact blocking implementation verdict remains in §24. Deleted temporary artifacts, old binaries, obsolete 28-file lists and test counts are not R13 evidence.

### Actual Files and Diff

The exact R15 implementation owns the 17 paths in §15: 12 production files, the two existing test owners, the generated `migration.sql` and `snapshot.json`, and this plan. `git status --short --untracked-files=all` reports exactly those 17 paths. At the approved implementation-audit handoff, the tracked portion reported 5,529 insertions and 940 deletions across 16 paths; the seventeenth path was the untracked generated `snapshot.json`. The final verdict record below is administrative plan text appended after that handoff and is excluded from implementation-line evidence.

The temporary `packages/opencode/test/storage/cold-storage-pack-v2.test.ts` and all superseded peripheral production/test paths are absent. The protected unrelated paths remain outside status/diff and must remain outside staging and commit:

- `docs/plans/daemon-post-exit-auto-update.md`
- `packages/core/src/models-snapshot.js`
- `packages/sdk/js/src/v2/gen/types.gen.ts`

The final ownership split is 12 production + 2 existing test owners + 2 generated migration artifacts + 1 plan. This is one path above the user's 16-path preference but below the explicit 32-path ceiling; production remains below 16 at exactly 12.

### Red-Green Test Evidence

Vertical TDD established and closed these first-divergence signals:

- Opaque-seed covered-history mutation initially retained stale seed data. The projector/storage RED now proves pre-seed mutation retires the seed, post-seed mutation preserves the valid prefix, and claimed initialization records `summary_init_dirty` in the same transaction.
- Pending Tool updates initially dirtied a summary claim. Producer classification now keeps pending/running updates clean and invalidates only completed visible Tool semantics or visible/closed Message boundaries.
- v2 Stats initially accepted a corrupted refcount because it read only `cold_stats`. The shared metadata-only gate now rejects missing/wrong-kind/refcount metadata without decoding a pack or thawing an owner.
- The original Session-list tests expected Tool input/name search hits. The product requirement deliberately removes those fields; both v1 and v2 assertions are now negative while visible Text, file/reference locators and explicit shell commands remain positive.
- The fresh-copy physical loop produced the decisive RED: after product `VACUUM`, main was 1,342,918,656 bytes and WAL was 1,350,783,232 bytes, for 2,693,701,888 bytes total. R15 adds checked `PRAGMA wal_checkpoint(TRUNCATE)` inside the same explicit vacuum operation. The GREEN product path reports main 1,342,918,656 bytes, WAL 0, total 1,342,918,656 bytes.
- Deferred race tests cover delayed mirror read plus covered Part replacement, delayed mirror read plus latest Assistant deletion, dirty crash-resume, and pending Tool updates. Stale input is discarded or rejected by persisted claim/CAS state rather than accepted through a fallback.
- Implementation audit B-01 produced a public RED where packed-v2 Stats rejected refcount drift but first `sessions.diff` accepted the same Tool pack. `inspectPartRows` now invokes the shared metadata gate before decode; the focused test proves failure, preserved crash-resume cursor, no summary ref, and no archive repair.
- Implementation audit B-02 produced a task-backed `verify --repair` RED where a valid pack with a nonexistent 32-byte owner key returned `failed=0`. The payload-only task algorithm was deleted. Repair now reuses `verifyWith` for one complete immediate owner/payload/state snapshot, detects invalid keys and invalid initialized/dirty/seed/ref/cursor combinations, and only repairs proven refcounts.
- Implementation audit B-04 removed the unused `oldRefs` traversal from direct Message freeze; no replacement state or diagnostic branch was added.

### Verification Commands and Results

All commands ran from `packages/opencode` unless a repository-root git command is shown:

| Command | Result |
|---|---|
| `bun test test/storage/cold.test.ts test/server/session-diff-missing-patch.test.ts --timeout 60000` | post-audit-fix: 31 pass, 0 fail, 172 assertions, 18.55 s |
| `bun test test/server/session-list.test.ts test/server/global-session-list.test.ts test/cli/stats-data.test.ts --timeout 60000` | 31 pass, 0 fail, 165 assertions, 81.23 s |
| `bun test test/session/messages-pagination.test.ts --timeout 60000` | 56 pass, 0 fail |
| `bun test test/session/compaction.test.ts --timeout 60000` | 66 pass, 0 fail |
| `bun typecheck` | pass |
| `bun run db check` | pass after restoring the generated seeded `snapshot.json`; Drizzle reports `Everything's fine` |
| repository root `git diff HEAD --check` | pass; only LF/CRLF working-copy warnings |
| Windows CLI build/smoke | pass, version `0.0.0-dev-smark-202607192130`, executable SHA-256 `263dc8291f9f7895291b437423c945b2e301cde1697e2c6f2b29cc042d8a1d39` |

The complete package suite was run once and took 3,771.69 seconds: 3,931 pass, 57 skip and five `prompt.test.ts` fixed 10/20-second timeout failures. The five names were `glob tool keeps instance context during prompt runs`, `running task tool preserves metadata after tool-call transition`, `loop waits while shell runs`, `shell completion resumes queued loop callers`, and `only a later real user Goal turn authorizes model terminal recovery`. Adjacent isolated prompt work needed about 15.24 seconds on this host. No cold-storage, SummaryCache, Stats, search, migration or range test failed. The user explicitly instructed that this roughly 40–60 minute suite must not be rerun and that the implementation auditor must use the recorded result and focused GREEN suites.

### Original Feedback-Loop Result

The fresh-copy source is `D:\Temp\opencode\db-pack-v2-final-20260720045039188`; no maintenance command touched the live DB.

- Expanded baseline: 1,284 Sessions, 102,765 Messages and 470,672 Parts. Business-state SHA-256 was `8b6e55838e4d5be524b7e07ff7cd108beef9b467065cb7230a73586f18bb1ad3`.
- Baseline Stats SHA-256 was `6E8BFE813DD9D069DFC47BDC3A0E1A46033E4F722693178C5E99C98B955A3914`.
- Deployed-v1 Stats was byte-identical and left storage state unchanged at `d6a588db8a788551069be7c7aba3404c6d115872fdc2226efc1cdd49adee9229` before/after.
- Default 30-day compress completed in 150.7 seconds: 391,294 processed, 75,234 skipped, zero failed; 1,436,730,160 raw bytes became 465,638,992 compressed bytes.
- Verify checked 316,060 owners and 2,063 payloads with zero corrupt, missing or refcount failures.
- Explicit product vacuum plus the R15 checked checkpoint produced main+WAL 1,342,918,656 bytes, 157,081,344 bytes below the decimal 1.5 GB hard gate. It is 142,918,656 bytes above the non-blocking 1.2 GB preference.
- Packed-v2 Stats remained byte-identical to hot/v1 and left storage state unchanged at `d28a2ba6cb9732bbe68ed33a5f48ca0ce13915d780a57123b146a6ebc54a54ef` before/after.
- Expand processed all 316,060 owners in about 168.8 seconds with zero failures. Session/Message/Part counts and business SHA-256 returned to the exact baseline `8b6e55838e4d5be524b7e07ff7cd108beef9b467065cb7230a73586f18bb1ad3`.
- Hidden Message/Part fixtures contribute their positive literals to Stats in hot/v1/v2 states. v2 Stats validates only ref metadata and `cold_stats`; storage-state hashes prove it does not persist thaw or repair.
- Range tests prove `MessageV2.page(limit=1)` thaws only that page; completed no-tail Compaction filtering determines the marker cutoff before hydration; explicit full-history consumers still recover all owners.

### Actual Secondary and Replacement Path Inventory

Alternate-success budget is zero. The diff contains one zstd codec, one `cold_storage` table, one `SummaryCache` authority, one `CompactionBoundary.latest` owner and one persistent-thaw decoder path. R11/R12 replacement seams are absent. There is no external archive, worker process, GPU/Rust/WASM sidecar, automatic vacuum, decode-on-Stats fallback, catch-and-empty-summary behavior or legacy mirror reread after initialization. The four earlier peripheral production paths and their dispersed tests were removed from the goal diff rather than retained as speculative defense-in-depth.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
|---|---|---|
| Effective changed code lines `E` | 4,189 | conservative `git diff --unified=0` count over production plus the two test owners; excludes blank/import-only lines and entirely excludes docs/generated migration, but does not claim extra formatting/pure-move exclusions |
| Qualifying Chinese comment lines `C` | 629 | adjacent rationale/invariant/boundary/test-intent comments only |
| Ratio `C / E` | 15.02% | meets 15% |
| Required minimum `C` | 629 | `ceil(4,189 * 0.15)` |

The final distribution scan found at most three consecutive added Chinese comment lines. Explanations are placed beside constants, state transitions, query conditions, decoder gates, transaction ordering and assertions rather than collected as ratio-padding blocks.

### Remaining Unverified Items

- Full-scope R15 implementation re-audit reports `No blocking findings` and `APPROVE`; only the required exact-path local commit remains.
- The live DB was opened only through read-only backup/query paths, but its mtime changed while the running OpenCode process continued normal user work. Therefore the verifier cannot claim byte-identical live-file hashes across the entire window; no migration/compress/expand/vacuum/repair command was executed against it.
- The complete-suite five prompt timeout results remain recorded above and are not relabeled as passing. The user explicitly adjudicated the long command as accepted and prohibited a rerun; this supersedes the earlier all-green rerun gate for this implementation audit.
- The large temporary evidence directory remained present through audit and may now be removed under §18 step 8 after commit evidence is recorded.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope | Blocking | Non-blocking | Result | Invocation |
|---:|---|---|---|---|---|---|
| 1 | R5 | yes | B-01, B-02, B-03, B-04 | recorded below | BLOCK | `ses_08633a87bfferC8xZJ1PGNTY81` |
| 2 | R15 | yes | B-01, B-02, B-03, B-04 | none | BLOCK | `ses_08345e721ffe1U61fLffYntlwW` |
| 3 | R15 | yes | none | N-01 tracked insertion count was stale and is corrected above | APPROVE | `ses_08345e721ffe1U61fLffYntlwW` |

Verbatim final R15 implementation-audit findings and verdict:

> # Blocking findings
>
> No blocking findings.
>
> # Non-blocking findings
>
> `N-01 tracked diff insertion count is stale`
>
> **APPROVE — exact canonical revision R15 and the current 17-path HEAD-to-index/working-tree implementation diff only.**
>
> The implementation satisfies the original behavioral, physical, scope, integrity, primary-path, code-quality, comment, and user-adjudicated verification gates. The five recorded long-suite timeout facts remain disclosed and have not been rewritten as green.
>
> This approval authorizes the required local commit of the exact audited implementation, including the generated untracked `snapshot.json`. It does not authorize push. Any substantive diff change before commit invalidates this verdict and requires another full-scope audit.

Verbatim blocking finding titles and classifications from the first exact R15 implementation audit:

- `B-01 packed Part 的非持久 inspect 路径仍绕过真实 refcount 校验` — `Blocking`.
- `B-02 opencode db verify --repair 使用第二套不完整的 verify 算法` — `Blocking`.
- `B-03 必需的完整 package regression 没有通过` — `Blocking`.
- `B-04 direct Message freeze 留有明确的无用遍历和分配` — `Blocking`.

The auditor recorded no non-blocking findings, independently confirmed the 15% Chinese-comment gate, accepted the 1.342 GB physical result, and rejected a second codec/GPU/process/archive/automatic-vacuum expansion. B-01, B-02 and B-04 were repaired through public RED-to-GREEN seams without adding files or fallback behavior. B-03 is a verification-policy disagreement: its source evidence is recorded exactly, while the user had already instructed that the hour-long run was accepted and must not be rerun. The next auditor receives that user requirement verbatim rather than a rewritten pass result.

Verbatim R15 release verdict:

> **BLOCK — exact canonical revision R15 and the current 17-path HEAD-to-index/working-tree implementation.**
>
> B-01、B-02、B-03、B-04 均需解决后重新执行完整范围的 implementation audit。本轮结论不授权创建最终 local commit，也不授权 push。

Verbatim blocking finding titles and classifications from the independent R5 implementation audit:

- `B-01 Stats 会把 hidden Message 和 hidden Part 重新计入全量统计` — `Blocking`.
- `B-02 DB-authoritative SummaryCache 破坏了既有持久化 Session diff 合同` — `Blocking`.
- `B-03 v2 Summary inspect 路径没有执行约定的 refcount corruption gate` — `Blocking`.
- `B-04 变更测试不满足仓库要求的组合执行和完整 package regression gate` — `Blocking`.

Verbatim non-blocking findings:

- `R5 文件预算满足要求：28 个目标文件，其中正好 16 个 production 文件、9 个测试文件、2 个生成 migration 文件和1个 canonical plan；未超过32个文件上限。`
- `bun typecheck` 通过。
- `bun run db check` 通过，migration 包含 `cold_key`、`cold_stats`、`summary_ref`、`summary_cursor` 和 `session_summary_ref_idx`。
- `git diff HEAD --check` 通过，仅有现有 LF/CRLF 提示。
- `messages-pagination.test.ts`、`cold.test.ts`、`stats-data.test.ts` 和 `summary-tool-diff.test.ts` 分别隔离执行时通过。这不能覆盖 B-02 和 B-04。
- Canonical plan 记录了临时副本达到 `1,327,226,880` bytes、116.984 秒压缩、Stats hash 相同和 expand hash 相同，但所引用的 `D:\Temp\opencode\...\result.json`、验证脚本和注释脚本当前均不存在。本轮授权没有包含重新构建和临时副本物理压缩，因此这些硬门槛结果未被独立重放。当前已有其他 blocking findings，不能据此发布。

Verbatim release verdict:

> **BLOCK**
>
> 该结论适用于 canonical plan R5 与当前实际 `HEAD` 到 staged+unstaged diff。需要修复 B-01、B-03、B-04；B-02 与当前 R5 的 SummaryCache 设计存在实质合同冲突，应先形成新 revision 并重新进行 full-scope plan audit，随后重新实现和执行完整 implementation audit。

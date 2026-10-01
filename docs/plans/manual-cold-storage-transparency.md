# Canonical Implementation Plan: Manual Cold Storage Transparency

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: implementation
>
> Requirement source: user requests and clarifications quoted in section 1; `docs/workflow.md`
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-10-01

This is the sole implementation specification for this task. The cache research
report `D:/Temp/opencode/db-space-optimization-study-20260930.md` and the earlier
R1/R2 experimental databases are capacity research, not implementation authority.
R4 selects the existing-table v3 encoding route. Implementation remains gated on
independent approval of this exact revision.

## 1. Verbatim Requirement

> 请你再次详细完整地过去检查一下，看一下这个相应的 OpenCode 我们目前的数据库，看一下它的这个可以去优化的一些点等等内容。因为当前我们看，我们的这个 OpenCode 的数据库能到四个G左右，但是本质上而言，我认为它仍然是具有很大一部分内容是可以被进行优化的压缩的，或者说这个数据本身就是冗余的等等内容。请你全面完整地去检查分析，并且给出按照优先级，P0到P几的，然后同时不会去丧失真正有效的这种，或者有用的这种数据，然后同时能获得较大的收益，比如说能最终将相应的这个数据库大小压到接近两G的一个水平。请你完整检查，全面检查，你给出相应的一些全面完整的一些内容。与此同时，如果你需要去测试，你当然可以在我们地盘的一个全局缓存工作区里面进行测试，但请注意，最好你的测试要保持高效，就是因为当前这个区域可能就几十个G，所以你不要去过度浪费空间。

> 注意最终你的内容应该保持一个优秀高效且可实施的一个方法。比如说你到底应该在哪些内容上进行相应的一个调整啊，或者等等内容。就比如说你应该去对哪些，我们应该对哪些内容进行相应的一个压缩啊，然后与此同时它是压缩这个收益大概有多大的内容。然后与此同时又能够保证现有的这种搜索啊，这么的一些逻辑，就是让这些内容可以被搜索，仍然可以被索引等等内容。

> 按理来说甚至reasoningpart都可以进行压缩，因为本身reasoning不需要进行索引

> 换言之，所有的内容，我们只需要去让主会话的审计标签等等内容保持可审，就是保持重放的性能不会大幅度，或者说有这种比较奇怪的这种影响。那本身而言，这些什么子agent呀等等内容，那本身而言它都可以去进行一些冷冻。但是我记得好像有一个东西是这个token的技术。如果token的技术这一块的话，是能够正常就是进行计数的话，就是比如说它其实冷冻了也能正常计数的话，那这一块我认为其他的这种无关的任何内容都可以直接去纳入冷冻。

> token计数

> 那针对P1呢，有一个问题，就是理论上而言，我之前的模型就是所有的压缩等等机制，是不在前台能够看得到的。换言之，所有的压缩机制本质上都是有一个共同的一个处理器。那这个处理器呢，它本身呢，这个我们应该是已经有实现的，就是所有的这个前端或者说顶层应用层，它是看不到这个东西到底是被压缩了还是不压缩的。那唯一呢，正常进行冷冻解冻的都是后面存储端进行的，就是如果某些内容去请求一些所需要被解冻的内容，那这个相应的模块会自动进行解冻。所以请注意这种机制，本质上而言，比如说这个 reviewer 等等这种东西，那不得去让它直接触碰到这个冷冻解冻这种逻辑。然后与此同时呢，那关于你这个P2我有点不太懂，按你的意思，P2中首先什么历史记录成批批量保存，那有问题。那比如说成批批量保存，那现在不就是成批批量的吗？也就是说现在不就是本来就是一个 message 压缩一个东西，一个 message 压缩一个东西吗？那按你的理解，那你的意思是多个 message 去进行压缩吗？那多个 message 压缩之后，那如果它只要读一条 message，本质上这不就会带来很大的一个问题。然后与此同时，你说相应同的整条冷内容保存一份，之前就是这样的。那本质上而言，它不可能现在，或者说那本质上而言之前我就是这样的。那与此同时相应的是什么统计和查找小字段，检测保存，我不懂你这是什么意思。按理来说，按照我的理解，你这个 schema 等等内容，或者说这种字段等等内容，你也最好不要做过大调整。就是换言之，比如说它以前有什么字段等等内容，那理论上说可能每个字段都有不同的消费内容。如果你要改的话，那可能大批量内容都要改。所以按照我的理解，本身字段你可以去……我的当时的意思就是说，你看有哪些字段是冗余的啊，或者说什么，就比如说两个字段相应的内容是完全一致的，或者说历史中的某一些 part，本质上而言现在它是不再会进行一些消费啊或者什么这样的情况。那反正这个是我是这个意思。那我不懂你这是什么意思。然后与此同时请注意这一点。然后呢，同时按照逻辑呢，整体的这个相应的一个修改的一个生产代码的修改数量呢，不超过8个文件。那与此同时呢，相应生产代码的修改的这个行数呢，也不得超过1,600行。所以请注意这一点。那按理来说你请继续完整检查，并且按照相应的 workflow 去进行相应的一个构建并进入到相应的实施阶段。

> 与此同时，其余相应的一些配置呢，整体要设计风格要符合现有的仓库的一些逻辑，或者说之前我们也有一个相应的一个 plane，去专门进行相应的这个冷冻的内容。按理来说，我们仍然是不纳入，就是说不考虑进行自动化的一个冷冻的，仍然是用户显示进行冷冻的指令之后才去进行冷冻的，同时要具备完整的冷冻解冻机制。那同时关于冷冻的内容呢，也不轻易地进行解冻，或者换言之，本质上而言，很多内容它其实是不需要被解冻的。然后有时候可能会有极个别的消费端，可能读取到了，或者说直接全量读取了一些本身它不需要那些内容，那本身这个东西可以去进行适当的一个调整。

Capacity clarification: when asked whether the capacity goal could be deferred,
the user selected **“本阶段达到约 2 GB”**. When asked for the numerical limit, the
user selected **“2.5 GB”**, described in the question as **2,500,000,000 bytes**.
The file and line ceilings remain in force simultaneously.

> 你自己看，按理来说不得因为压缩而大幅度修改现有的调用schema导致后期与上游过大兼容性问题

> 譬如 属于哪个 Session、哪条 Message 工具名称、完成状态、开始结束时间  这种我觉得就 本质上该热表啊

The target end state is `verified-implementation`, with independent plan and
implementation audits under `docs/workflow.md`. No commit or push is requested.

Latest instructions supersede the earlier numerical capacity gate:

> 所有的修改测试都由你来执行，不要让agent负责修改实验，可以审计；不然太慢了，我希望你能保持高效，

> 譬如理论上你不应该每次都进行大批量的测试

> 我希望整体在一个小时以内执行完

> 当前的主要要求以及内容呢是完整全面检查OpenCode的数据库，也就是 OpenCode 的 .DB 数据库，将其冗余度等等进行检查，并最终要求限制最终的压缩大小，大概在 2.8 GB 以下，同时相应修改代码的文件数量不得超过8个文件，1600行生产代码。整体而言需要专注于任务本身与此无关的任何内容，包括但不限于，譬如需要用户进行授权的等等内容，都不得成为阻塞项。本质上，如果用户没授权，那他之后大概率也不会授权，请你按照相应既定流程进行。同时如果需要进行修改以及测试，请自行进行完成，不要每次都跑大批量的测试和压缩测试，本身这会导致大量的无效时间浪费。请确保最终内容不会发生任何红测,请保持任务的修改和测试是一点一点等完整进行之后再进行相应的测试，等等内容，避免最开始就全量测试，从而导致不必要的任务冗余度。请保持任务的conscious以及efficient，避免进行无关操作。或者理论上和最终收益优先度相关性较低的一些无关操作。同时用户要求尽量降低相应的 schema 调整的一个复杂度。譬如，同时也尽量避免降低相应的用户的实际体验，譬如不得让相应的主 agent 的回话的正文搜索能力丢失，token 技术能力发生不准确等等。也就是不得让已有的一些其他功能的表现啊等等内容发生相应的飘移。

Final physical acceptance is **<2,800,000,000 bytes**. The primary agent owns all
subsequent edits and experiments; delegation is restricted to independent audit.
The time preference governs scope and test efficiency, not weakening final gates.

> 同时请注意整体代码适当保持可读性，因为本身是用户来进行维护的，不要为了去进行压缩代码过度地简化，或者说内嵌内联部分本该准确展开或者等等的一些逻辑，请保持代码可编辑可检查可审计，不要过度地进行硬编码，而是让整体代码具有适当的逻辑可扩展性等等情况。

## 2. Explicit Non-Goals

- Production database writes, daemon shutdown, external attachment storage, and business-data deletion.
- Automatic, periodic, task-completion, or reviewer-completion freeze hooks.
- Hot streaming text interning, line splitting, or per-write database-wide duplicate scans.
- Moving Session/Message identity, tool name/status/start/end time out of hot storage.
- Broad public Message/Part/HTTP/SDK schema changes or replacing the owner tables with the earlier R2 schema.
- Treating search, provider replay, token accounting, or data integrity as adjustable capacity tradeoffs.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | Production implementation is `packages/opencode`; `parent_id` identifies subagents, while fork creates a root Session. |
| Root and package `AGENTS.md` | Shared worktree safety, package-local tests/typecheck, generated migrations if eventually justified. |
| `docs/workflow.md` and engineering policy | One canonical plan, primary-path repair, exact-revision independent approval, TDD, Chinese comments. |
| `docs/adr/README.md` | Existing ADR index contains no cold-storage decision replacing the current shipped contract. |
| `docs/plans/cold-eligibility-root-7d-subagent-24h.md` | Existing explicit-maintenance eligibility clocks and completed Compaction boundary. |
| `docs/plans/opencode-db-cold-storage-pack-v2.md` | Existing same-DB packs, content identities, refcounts, statistics and restore compatibility. |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `src/storage/cold.ts` | Extraction whitelist, eligibility, batching, inspect/thaw, fork, replacement, maintenance, integrity. | observed |
| `src/session/session.sql.ts` | Existing persisted field types, IDs, indexes, references and statistics. | contracted |
| `src/session/message-v2.ts` | Complete reads, viewer reads, hot predicates, execution-window selection and model conversion. | observed |
| `src/session/search.ts`, `src/session/session.ts`, `src/v2/session.ts` | Search field whitelist and root scope before pagination. | reachable |
| `src/permission/reviewer/service.ts` | Reused reviewer Session, request metadata, outer review completion and parent audit result. | observed |
| `src/tool/task.ts`, `src/background/job.ts` | Parent replay result, child reuse, background-launch versus execution completion. | reachable |
| `src/session/projectors.ts`, `src/storage/db.ts` | Atomic replacement, deletion, statistics and transaction boundary. | contracted |
| `src/cli/cmd/stats/data.ts`, `src/token/accounting.ts` | Hot scalar statistics and detailed input breakdown consumers. | observed |
| HTTP Session group/handler; TUI Session route, sync and subagent footer | Bounded viewer reads, audit navigation and shared permission/question aggregation. | reachable |
| `test/storage/cold.test.ts`, `test/session/message-v2.test.ts` | Existing public persistence and replay test seams. | observed |
| `D:/Temp/opencode/cold-storage-feedback.test.ts` | Real persistence red feedback, isolated from production. | observed |
| `D:/Temp/opencode/manual-cold-same-table-20261002.mjs` and `.sqlite` | Same-schema capacity and reversible-data experiment. | observed |

Paths in the source/test rows are relative to `packages/opencode`.

## 5. Current Behavior

`explicit db compress -> ColdStorage eligibility -> whitelisted fields -> v2
pack -> owner hot JSON + cold_ref/cold_key/cold_stats`.

The implementation already batches and shares identical complete packs. Entry
deduplication inside one pack is existing behavior. Pack boundaries can retain
duplicate entries and entries whose individual owners have disappeared.

Ordinary Text is excluded from extraction, including large reviewer request
Text. Complete ordinary reads can persistently thaw requested owners. Viewer
Part reads use inspect; assistant viewer reads assume assistant data stays hot.
Stats use hot scalars and `inspectPartStats` rather than decoding all tool output.

## 6. Supported Input Domain and Reachability

| Condition | Producer / guarantee | Owner | Class |
| --- | --- | --- | --- |
| Reused reviewer Session containing many requests | Reviewer persists `reviewID` on request Text; attempts and outer review completion differ. | Reviewer for business scope; storage for bytes. | observed |
| Existing cold v1/v2 owners | Shipped ColdStorage format and refcount invariants. | ColdStorage | contracted |
| Shared cold prefix and subsequent independent history edits | Fork and projector replacement paths. | ColdStorage/projectors | reachable |
| Child copied into a root Session | Fork creates root identity; root Text must be searchable. | ColdStorage clone path | reachable |
| Background task launch response | Completed parent tool can coexist with running child execution. | Background job lifecycle | observed |

## 7. Required Invariants

| ID | Invariant | Evidence / verification seam |
| --- | --- | --- |
| INV-01 | Explicit user command is the only freeze trigger. | CLI maintenance and command tests. |
| INV-02 | Public business objects roundtrip exactly, including provider metadata. | Complete Message/Part reads and independent digests. |
| INV-03 | Root Text search and active prompt reads retain hot access. | Search SQL and model conversion. |
| INV-04 | Session/Message identity, tool name/status/start/end time remain hot. | Latest user clarification; raw row checks. |
| INV-05 | Token/cost/character statistics are identical before and after maintenance. | Stats, request ledgers, context accounting. |
| INV-06 | Viewer/metadata-only consumers preserve cold state as appropriate. | Real persistence feedback and API tests. |
| INV-07 | Fork/edit/delete/expand preserve independent owners and valid references. | ColdStorage public seams. |
| INV-08 | Reclaimed complete-schema main file <2,800,000,000 bytes. | Cache-copy physical size, integrity and full index accounting. |
| INV-09 | Production diff <=8 files and <=1,600 gross added/deleted lines. | Actual scoped diff; no unrelated formatting. |
| INV-10 | Storage complexity stays behind the existing handler; public schema remains compatible. | Producer/consumer map and package typecheck. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Evidence |
| --- | --- | --- | --- |
| INV-06 | Default complete hydration calls persistent thaw during ordinary reads. | MessageV2 hydration / ColdStorage | Reasoning body restored correctly, but cold_ref became null. |
| INV-08 | Eligible child Text never enters extraction. | ColdStorage whitelist | Old reviewer Text freeze returned skipped. |
| INV-08 | Existing v2 owners are skipped by the hot/v1 compression enumeration. | ColdStorage maintenance | Existing pack-level duplication and encoding are left intact. |

Original feedback command, cwd `packages/opencode`, TEMP/TMP in the cache:

```powershell
bun test "D:\Temp\opencode\cold-storage-feedback.test.ts" --timeout 30000
```

Observed result: 0 pass, 2 fail, 4 assertions. The two failures are old reviewer
Text skipped by explicit freeze and ordinary get clearing a previously cold
reasoning reference. This detects real storage behavior, not source text.

## 9. Responsibility and Seam

ColdStorage owns encoding, extraction, reference accounting, transparent
restoration and explicit maintenance. MessageV2 owns the business read scope.
Reviewer/task/frontends keep their ordinary Message/Part contracts. Search and
Stats keep directly usable fields. Cold Text search restoration belongs to the
same storage decoder, never to a tool or frontend.

## 10. Single Approved Primary-Path Design

Explicit compress -> existing eligibility plus completed reviewer attempts ->
existing field extraction -> bounded immutable v3 packs -> atomic owner pointer
assignment -> explicit physical reclaim. Normal writes never freeze.

### P0: Existing Pack Encoding And Shared Entries

Use the existing tables and columns. Version 3 pack JSON stores a canonical
array of complete field maps in full SHA-256 entry-key order. Entry hashes are
recomputed from the fields rather than serialized a second time. Pack identity
retains every SHA-256 bit, encoded as base64url instead of hexadecimal. Owner
`cold_key` is a four-byte little-endian array slot. Version 1 and 2 remain explicit
shipped decoder branches; a failed v3 decode never retries an older decoder.
New pack writes use zstd level 12. Preserve current empty field placeholders.

All decode, verify, inspect, thaw, direct freeze, clone, and repack paths select
the locator by the actual pack version, validate range/order/canonical bytes and
full digest, and preserve owner-count reference semantics. Repacking recalculates
slots after final ordering. A slot belongs only to its immutable pack hash.

Compact `cold_stats` inside its existing JSON column as versioned tuples:
`[2,0,inputChars,outputChars]` or `[2,1,...tenComponents]`. The storage parser
returns the existing named public statistics shape and checks exact length and
safe integers. Keep legacy object decoding. Actual provider tokens/cost remain
hot in their existing Message/Part JSON fields; no token formula changes.

Explicit compress additionally processes existing packs, not only hot/v1 owners.
Enumerate a finite ordered input-hash set, process bounded batches under existing
immediate transactions and maintenance lease, preserve source timestamps, and
checkpoint after commit. Newly produced hashes do not re-enter the same pass.
Restore existing owner fields in memory, merge newly eligible fields through the
same extractor, and globally reuse identical complete entry identities during
this pass. The transient identity map stores keys/locators, not all raw payloads;
validate that cached destinations still exist before reuse because ordinary
owner removal can occur between batches. The map is rebuilt on resume from
committed output packs; it is an optimization, not persistent authority.

New payloads are retained before assigning owners, and old payloads released
after all affected owners switch in the same transaction. Shared packs outside
a requested Session scope keep their owners valid. Live fields alone enter the
new pack; preserve every referenced logical object. Existing cleanup/verify
contracts remain separate from encoding migration.

### P1: Manual Cold Eligibility And Fields

Retain root seven-day, child 24-hour and completed-Compaction eligibility. Add
completed reviewer request/assistant attempts selected by same-Session linkage,
reviewer identity, completed assistant timestamps and absence of pending/running
tools across that request and its replies. The parent review result is not the
trigger: the command is. Retry creates a fresh attempt; later hide/replacement
of a completed attempt uses the existing complete-object replacement path.
Compute admission inside the same immediate transaction as extraction.

For eligible child Text, move only `text`; preserve metadata including reviewID,
visibility flags and all mandatory identity/lifecycle fields. Root Text stays
entirely hot. For eligible assistant Messages move `inputBreakdown`, `inputChars`,
`inputTokens` and `path`; restore them in complete and viewer reads. Narrow the
internal HotInfo type accordingly; its current consumers use lifecycle/model
fields. Public Info/Part schemas and provider objects retain their exact fields.
Existing Tool/Reasoning/Step/summary extraction remains authoritative.

### P2: Transparent Reads And Search

Ordinary get/page/stream reads inspect complete selected objects in memory while
preserving references. Execution-window hydration explicitly performs persistent
thaw internally, so repeated active prompt assembly reads hot JSON. Explicit
expand remains persistent. Viewer user summary.diffs remains omitted under its
existing contract; viewer assistant fields are fully restored. Single-row and
batch paths share these choices.

Preserve shipped child search as well as root search. Bun's actual SQLite
connection has no JavaScript scalar-function registration API, confirmed by a
focused in-memory execution (`TypeError: db.function is not a function`). R3 uses
the existing application/SQL boundary instead of a new database capability.

`searchCondition` receives the caller's existing Session universe condition and
roots flag. For roots-only or title-only searches, retain today's pure SQL path.
For searches including children, ColdStorage selects visible cold Text locators
inside that same universe (join Message/Session, preserve hidden-field presence,
synthetic/ignored filters), groups by pack, and decodes each selected pack once.
Return per-token Session-ID match sets. Compare text using SQLite's ASCII-only
lowercase semantics and literal substring matching; query token normalization
stays in search.ts. Add each set as an OR term inside that token's existing
title/hot-content expression, then AND the tokens as today. Final scope, ordering,
limit and cursor remain in the existing SQL. Bound ID lists within SQLite's
parameter limit. This is one complete search path, not a retry after SQL fails.
No persistent cache/index, user function or new table.

For progressive scan, pass only the already-selected candidate-page IDs into
the cold match step, so its work stays bounded by the existing scan contract.
`listByProject`, `listGlobal` and v2 list pass their already-built universe;
session list title GET and scan POST both request the existing `roots:true` flag.
Permission/question aggregation and child navigation remain unchanged. Public
HTTP/SDK query and response schemas remain unchanged.

Child-to-root fork materializes copied Text in the target while leaving the
source cold. Existing mutation/refcount ownership remains in ColdStorage.

### Capacity Evidence And Final Gate

The completed cache artifact `manual-cold-v3-combined.sqlite` records stage A
3,043,700,736 bytes and stage B 2,783,752,192 bytes, preserving original tables,
indexes and mandatory hot fields. Stage A saves 410,521,600 bytes from the
3,454,222,336-byte same-table baseline; stage B saves 259,948,544 more. The
prototype's optional pack-local aliases saved only 978,634 compressed bytes and
are excluded from production to reduce complexity. R4 includes level-12 encoding;
placeholder removal stays excluded. The completed artifact is 2,734,632,960 bytes,
but that final number is not claimed for this smaller selected route.

The prototype used a stricter parent-result witness for reviewer eligibility;
the production attempt rule requires behavioral tests of post-completion hiding
and replacement. The final production implementation must independently meet
the physical gate on the retained complete snapshot. Encoding-stage arithmetic
and this experimental report do not replace that one final capacity run.

R3's actual production-path run on the retained snapshot completed compression
in 603 seconds and verified 1,910,259 owners / 5,718 payloads with zero corruption,
missing payloads or refcount mismatches. After reclaim the file measured
2,807,848,960 bytes. R4 changes only the codec level from 9 to 12, whose earlier
same-snapshot incremental experiment saved 9,079,658 payload bytes. Reuse the
already verified resulting copy and re-encode its immutable payloads with the
same canonical bytes; compare every decompressed frame before/after, retain all
hashes/locators/rows, reclaim once and measure. This isolates the necessary change
without repeating the full owner transformation. Actual incremental physical
size remains a gate, not an extrapolated acceptance claim.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| Existing v1/v2 decode | Shipped compatibility | Preserve until an explicitly validated migration handles it. |
| Inspect versus persistent thaw | Distinct read/write contracts in the same storage owner | Preserve and correctly select at the internal read seam. |
| Explicit expand | Primary user-requested operation | Preserve. |
| Automatic freeze worker or per-tool freeze hook | Outside requested behavior | Exclude. |
| Alternate application schemas for cold messages | Responsibility leak | Exclude. |

## 12. Workaround Deletion and Replacement

Remove ordinary-read persistent-thaw selection in MessageV2's single-row and
batch hydration, while retaining explicit expand and execution-window warming.
Replace duplicate serialized entry hashes in new packs, retaining the legacy
decoder solely for persisted compatibility. No new workaround or alternate
failure-success path is introduced.

## 13. Forward Traceability

| Requirement | Candidate path | Behavioral evidence needed |
| --- | --- | --- |
| INV-01/02/07 | ColdStorage maintenance/restore/clone/replacement | Manual freeze, complete roundtrip, expand, fork, mutation, failure atomicity. |
| INV-03/04/05 | Existing hot fields, search, model conversion and Stats | Root results, provider payload, raw identity/time fields and exact counts. |
| INV-06/10 | MessageV2 internal hydration scope | Ordinary view stays cold; execution reads complete objects; same DTO schemas. |
| INV-08 | Final approved route on a complete cache copy | Full main-file size after reclaim; per-priority non-overlapping gains. |
| INV-09 | Final file plan and diff | <=8 production files, <=1,600 gross changed lines. |

Exact source ownership: ColdStorage covers INV-01/02/04/05/07/08; MessageV2 covers
INV-02/03/06/10; search.ts plus the Session-list caller cover INV-03/10; persisted
TypeScript types in session.sql.ts cover INV-02/05/10. Tests below map these seams.

## 14. Reverse Traceability

| Candidate concept | Requirement | Why current behavior is insufficient |
| --- | --- | --- |
| Child Text extraction | INV-08 | Whitelist leaves large eligible reviewer request bodies inline. |
| Inspect for ordinary complete reads | INV-06 | Current hydration can clear cold references. |
| Existing-pack maintenance | INV-08 | Current compress enumeration leaves v2 packs unchanged. |
| Additional historical diagnostic extraction | INV-02/05/08 | Optional detailed fields remain hot; actual consumers need transparent restore. |

Implicit entry hashes, slots, lossless base64url identities and compact statistics
map to INV-08, with measured stage-A savings; the existing verbose encoding cannot
provide those savings. Completed-attempt eligibility maps to INV-08 and the
reviewer producer's separate immutable attempt lifetime. Scoped cold match sets
map to INV-03/10: SQL JSON text cannot read extracted bytes and
one decode per owner would repeat the same pack work. These concepts stay inside
the storage owner and preserve the public schemas.

## 15. File-Level Change Plan

| Production file (packages/opencode) | Responsibility | Gross line allowance |
| --- | --- | --- |
| `src/storage/cold.ts` | v3 codec/locators/stats, bounded maintenance, eligibility, extraction/restoration, scoped cold matches, fork | 1,180 |
| `src/session/session.sql.ts` | Internal stored assistant/tuple types; no SQL DDL change | 45 |
| `src/session/message-v2.ts` | Complete inspect versus execution warming, HotInfo/viewer typing | 170 |
| `src/session/search.ts` | Merge per-token storage-owned match sets into existing SQL | 40 |
| `src/session/session.ts` | Pass existing list universe / progressive candidate IDs and root scope | 25 |
| `src/v2/session.ts` | Pass existing list universe and root scope | 10 |
| `src/cli/cmd/tui/component/dialog-session-list.tsx` | Existing root scope before search pagination | 20 |

Seven production files, estimated 1,490 gross changed lines with 110 lines reserve.
No migration, generated SDK, new public endpoint, config or reviewer/tool hook.
Tests: extend existing cold storage, message pagination and Session search seams;
new tests may use a focused `test/storage/cold-v3.test.ts` fixture file. Tests and
this plan do not consume the production-code line budget.

## 16. TDD Behavior Slices

1. Explicit maintenance includes an eligible reviewer request while preserving ordinary writes.
2. Complete read restores content and retains cold storage; explicit expand restores hot storage.
3. Statistics and parent provider replay remain equal before/after freezing children.
4. Root search and child-to-root fork preserve hot searchable Text.
5. Existing pack rewrite preserves all shared owners through edit/delete and restart.
6. Full-copy maintenance reaches the physical gate with complete schema and indexes.

Seams are `ColdStorage.freezeOwner/maintain/verify/thawOwner/inspectPartStats`,
`Session.Service` replacement/fork/list and `MessageV2.get/page/filterCompacted`.
Each slice starts with one failing behavior, then minimal implementation and the
related regression set. Add explicit legacy-pack upgrade, corrupted slot/hash,
interrupted/resumed maintenance, completed-attempt hide/update, child search and
child-to-root fork cases. Expectations use complete independently seeded objects
and exact numeric totals. Storage-state checks observe the requested persistence
behavior; they do not assert private helper calls or source text.

## 17. Chinese Comment Budget

Planning estimate was E=1,150 including focused tests,
requiring at least 173 qualifying Chinese explanatory comment lines. Actual E/C
must satisfy `C >= max(1, ceil(E * 0.15))` for E>0. Explanations will be adjacent to
the manual-trigger boundary, mandatory hot fields, exact statistics, immutable
shared entries, restore fidelity, and transaction/checkpoint ownership.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/storage/cold.test.ts --test-name-pattern "Stats" --timeout 30000` | `packages/opencode` | Prior run: 2 pass, 14 assertions. |
| `bun test test/session/message-v2.test.ts --test-name-pattern "task" --timeout 30000` | `packages/opencode` | Prior run: 6 pass, 18 assertions. |
| Cache feedback command in section 8 | `packages/opencode` | Two real persistence failures. |
| `bun run manual-cold-same-table-20261002.mjs --measure` | `D:/Temp/opencode` | Complete same-schema physical breakdown and integrity. |
| `bun typecheck` | `packages/opencode` | Required after approved implementation. |

Run slice-specific `bun test <test-file> --test-name-pattern <slice> --timeout
30000` first. After all slices, run `bun test test/storage/cold.test.ts
test/storage/cold-v3.test.ts test/session/messages-pagination.test.ts
test/server/session-messages.test.ts --timeout 30000`, then package typecheck.
Use the existing search test file discovered by symbol rather than inventing a
new consumer seam. Run the original cache feedback again after fixing its paths.
Finally execute one cache-copy production maintain/verify/reclaim run, compare
complete owner and statistics hashes, check FK/integrity, and measure main file.
No repeated full-database codec sweeps during individual implementation slices.

The same-table experiment reports exact DDL for 20 tables and 21 explicit indexes;
377,456 Messages and 1,760,759 Parts passed independent restored-JSON comparison.
128,181 root Text rows stayed hot, totaling 126,967,199 JSON bytes. Source
677,267 cold statistics and final 825,668 projections were checked; aggregate
statistics matched. FK check and quick_check passed.

## 19. Diff Budget

| Metric | Current / ceiling |
| --- | --- |
| Production files changed | 7 actual / 8 ceiling |
| Production gross changed lines | 819 actual / 1,600 ceiling |
| Repository tests changed | 3 existing test files plus focused `cold-v3.test.ts` |
| New canonical plan | This file only |
| Experiment storage | One 3.454 GB same-table copy, plus retained earlier research artifacts; cache free space was checked before construction. |

## 20. Real Risks and Open Decisions

- Capacity: selected experimental stage B is 2,783,752,192 bytes against the updated 2.8 GB limit; production packing order, final metadata and scope require the final capacity run.
- Preserving existing eligibility left 6,169 child Text rows hot with about
  230.4 MB of text; eligibility changes require actual lifecycle evidence.
- Ordinary API child search currently exists, even when the TUI shows roots;
  extending child Text extraction requires an explicit supported search scope.
- Assistant viewer/hot predicates currently assume all assistant fields are hot.
- Background launch and reviewer attempt completion differ from completed work;
  neither can be substituted for durable lifecycle evidence.
- Single historical entries can be oversized: the experiment retained one
  97,080,890-byte raw entry. Batching must preserve complete-entry semantics.

### Open Decisions Requiring the User

The user has fixed 2.8 GB, eight files, 1,600 production lines and mandatory hot
identity/time fields. There is no pending user authorization for this route.
Any implementation drift affecting interfaces, fields or file budget requires a
new exact-revision audit rather than expanding scope during coding.

### Rejected Speculation

Per-write global string interning, automatic freezing, deleting valid payloads,
and externally storing attachments are outside this task. Existing batch packing
and identical-pack sharing are not new savings. Compression-body estimates do
not count as physical database acceptance.

## 21. Audit Contract

Independent `adversarial-auditor` plan and implementation audits must cover the
original requirements, complete affected paths, exact revision, code quality and
Chinese-comment gate. Primary will provide only the prescribed handoff. Audit
limits and blocker reconsideration follow `docs/workflow.md` and current policy.

## 22. Plan Audit Record

Round 1, R2, full scope, `ses_f09a21e29ffe0CkkMBuMM1m7PT`:

> **BLOCK — `docs/plans/manual-cold-storage-transparency.md` R2。**
>
> 保留 B-01。修订 canonical plan 并递增 revision 后，需要重新进行全范围方案审计；本轮不授权实施。

B-01 concerns the selected search interface and is in scope: the primary's
in-memory Bun test independently reproduced the missing registration method.
R3 replaces that design with scoped storage match sets at the current SQL seam.
Search regressions are `test/server/session-list.test.ts` (multi-token and keyset
cases); run this file after the focused cold-search slice.

Round 2, R3, full scope, `ses_f09a21e29ffe0CkkMBuMM1m7PT`:

> No blocking findings.
>
> **APPROVE — `docs/plans/manual-cold-storage-transparency.md` R3，完整范围方案审计通过。**
>
> R2 的 B-01 已解决。本批准仅适用于 R3；实际容量、行为回归、生产 diff 预算和中文注释比例仍须通过实现验证与独立实现审计。

Round 3, R4, full scope, `ses_f09a21e29ffe0CkkMBuMM1m7PT`:

> No blocking findings.
>
> **APPROVE — `docs/plans/manual-cold-storage-transparency.md` R4，完整范围方案审计通过。**
>
> 批准仅适用于 R4。统一 level 12 的实际物理尺寸、剩余恢复逻辑、相关回归、可读性、实际 E/C 和最终 diff 预算，仍须完成验证并通过独立实现审计。

Non-blocking record: the earlier 9,079,658-byte estimate used smaller-frame
selection. Final R4 measurement will use unconditional level 12, matching the
approved production codec. Actual diff and E/C will replace the earlier zero
placeholders at implementation-audit handoff.

## 23. Implementation Evidence

### Actual Files And Diff

| Production file | Added | Deleted |
| --- | ---: | ---: |
| `src/storage/cold.ts` | 614 | 67 |
| `src/session/message-v2.ts` | 57 | 24 |
| `src/session/search.ts` | 16 | 3 |
| `src/session/session.sql.ts` | 5 | 2 |
| `src/session/session.ts` | 12 | 6 |
| `src/v2/session.ts` | 5 | 4 |
| `src/cli/cmd/tui/component/dialog-session-list.tsx` | 4 | 0 |

Seven production files, 713 added + 106 deleted = **819 gross lines**.
Tests: `test/storage/cold-v3.test.ts`, `test/storage/cold.test.ts`,
`test/session/messages-pagination.test.ts`, `test/server/session-messages.test.ts`.
No DDL migration, generated files, public SDK schema or dependency changes.

### Red-Green And Verification

All commands below use `packages/opencode` unless an absolute cache script is
specified. TEMP/TMP for tests were `D:/Temp/opencode`.

- `bun test test/storage/cold-v3.test.ts --timeout 30000`: original Text freeze
  failed (skipped), compact locator failed (32 bytes), completed-attempt freeze
  failed, assistant freeze failed, cold child search failed, and old pack upgrade
  failed before their respective changes. Final focused result: **3 pass, 30
  assertions**. Covers read-only restoration, root Text, exact stats, old-format
  upgrade, payload checkpoint resume, open-tool exclusion, viewer and fork search.
- `bun test test/storage/cold.test.ts test/storage/cold-v3.test.ts
  test/session/messages-pagination.test.ts --timeout 30000`: **103 pass, 378
  assertions**. Earlier failures were old persistent-thaw expectations; complete
  values remain asserted, with explicit thaw tested separately. Two pack fixtures
  now explicitly scope maintenance and retain their independent pure-pack checks.
- `bun test test/server/session-messages.test.ts test/server/session-list.test.ts
  --timeout 30000`: **31 pass, 159 assertions**.
- After final resume/viewer adjustments, `bun test test/storage/cold-v3.test.ts
  test/storage/cold.test.ts --timeout 30000`: **45 pass, 232 assertions**.
- `bun test test/session/messages-pagination.test.ts test/server/session-messages.test.ts
  --test-name-pattern "cold|compacted|window|HotInfo" --timeout 30000`: **2 pass,
  18 assertions**, with 64 filtered tests; this supplements rather than replaces
  the earlier complete related runs.
- `bun test "D:/Temp/opencode/cold-storage-feedback.test.ts" --timeout 30000`:
  original feedback now **2 pass, 5 assertions**.
- `bun typecheck`: passed after implementation and again after final readability
  changes. An intermediate `yield*` on a synchronous array and the broadened pack
  metadata type were corrected at their owning functions.

### Capacity And Complete-Data Evidence

`D:/Temp/opencode/manual-cold-production-check.mjs` uses the real ColdStorage
maintenance dispatcher on one isolated copy of the complete retained same-table
snapshot. Source is `manual-cold-same-table-20261002.sqlite` (3,454,222,336 bytes).
The initial harness import failed before any maintenance, and the same untouched
copy was reused with dynamic imports and an explicit resolved-path guard.

The R3 maintenance completed in **603 seconds**. Production verify checked
**1,910,259 owners / 5,718 payloads**, with zero corrupt owners, corrupt payloads,
missing payloads and reference mismatches. The shell timed out after verify;
only physical reclaim was completed separately. The resulting 2,807,848,960-byte
file supplied the measured reason for R4.

`D:/Temp/opencode/manual-cold-level12-check.mjs` re-encoded all 5,718 immutable
frames unconditionally at level 12, matching production. Every decompressed byte
matched. Payload changed from 1,231,640,582 to 1,222,692,537 bytes. Combined raw
identity digest before/after:
`c25ad7568ee31e8f651f0962a1e9208ff707a352053810b5da32c582bf656dff`.
After VACUUM and checkpoint: **2,799,042,560 bytes**, below 2,800,000,000; elapsed
209 seconds. `quick_check=ok`, FK violations empty, WAL checkpoint `(0,0,0)`.

`D:/Temp/opencode/manual-cold-business-compare.mjs` independently compared all
**2,138,215 Message/Part owners** in the source and target. It restores field
maps without calling the production restore functions, normalizes payload
placement into field digests, and compares every logical business object plus
IDs, relationships and timestamps. Result: **ALL_BUSINESS_OBJECTS_EQUAL**, zero
unmatched owners, 227 seconds. Hot token/cost values are included in those
objects; production verify separately checked every cold statistical projection.
These are fixed-snapshot results; the running production database remains read-only.

### Path And Comment Evidence

Legacy v1/v2 are explicit persisted compatibility paths. V3 decode errors fail;
there is no fallback codec or placeholder-success path. Scoped cold search and
hot SQL are parts of the same query. Ordinary inspect, execution warming and
explicit expand preserve their separate contracts. Removed behavior: ordinary
reads automatically writing selected cold content back to hot tables.

Conservative line counter: inspect added lines of the scoped diff, exclude blank,
import-only and comment lines; include the new untracked test. This gives an
**E upper bound of 1,004**, deliberately retaining any formatter-only additions
rather than understating the denominator. Added/modified Chinese explanatory
comment lines counted: **C=163**, against the stricter minimum **151** (16.24%).
Implementation audit round 2 independently refined this to **E=992, qualifying
C=161, C/E=16.23%**: 1,201 added lines less 19 imports, 15 blanks, 163 comments
and 12 formatting/move/equivalent-renaming lines. Two flow-repetition comments
were excluded from C. Required minimum for this audited E is 149.
Representative explanations cover immutable slot identity, exact tuple numbers,
completed-attempt/open-tool ordering, query scope before decode, and transactional
retain/assign/release. No generated or pure-move files are included. Independent
audit qualifies comments and may reduce the conservative code-line denominator.

### Remaining Verification

Independent full-scope implementation audit is complete. Snapshot size has
957,440 bytes headroom to the requested bound; ongoing production writes will
change future sizes. No production DB operation or daemon restart was performed.

### Implementation Audit Rework

Round-1 B-01 is within the changed maintenance owner. A deterministic legal
fixture reproduced `Cold pack reference points to an invalid payload`: resumed
deduplication selected a pack containing an unreferenced entry as a destination,
then another group released its final old owner before the destination retain.
The repair collects the complete batch assignment schedule, aggregates every
destination retain before any assignment, performs all owner assignments, then
releases old references. This implements the already-approved atomic ordering.
The final regression obtains a real interrupted payload checkpoint, removes its
prior owner through Session.Service, and resumes across the P/Q/R shared-entry
layout. No new format, field, eligibility rule or packing policy was introduced.

Round-1 B-02 is the approved lifecycle-test requirement. The reviewer regression
now freezes an attempt, hides request/reply via complete `MessageV2.get` plus
`Session.updateMessage`, checks all assistant diagnostic/token fields and default
visibility, then replaces the cold Text and verifies content, reviewID and refs.
Final related storage run: **46 pass, 244 assertions**; package typecheck passed.

`D:/Temp/opencode/manual-cold-capacity-receipt.mjs` produced
`D:/Temp/opencode/manual-cold-capacity-receipt.json` through read-only queries and
filesystem stat, independently of the plan text. It records **2,799,042,560
bytes**, 683,360 pages, zero free pages, 377,456 Messages, 1,760,759 Parts, 5,718
packs and **128,181 root Text rows, zero cold root Text rows**. This lightweight
receipt does not rerun compression. Content encoding is unchanged by B-01 rework;
the new regression exercises its changed transaction ordering.

## 24. Implementation Audit Record

Round 1, approved R4, full scope, `ses_f094e3cc9ffeT9i1Ahm5Gf2PDS`:

> **BLOCK — approved R4 对应的当前 implementation diff 不可发布。**
>
> 保留 B-01、B-02。修复后需要全范围重新审计，并完成实际 E/C 与执行证据核验。没有修改任何文件。

Both findings were checked against the affected owner and approved requirements;
rework evidence is recorded above.

Round 2, approved R4, full scope, same invocation:

> No blocking findings.
>
> **BLOCK — 发布验证仍待完成；B-01、B-02 均已关闭。**
>
> 这里保留的是执行证据门禁，没有新增代码返工项。请提供已完成测试、`bun typecheck`、完整对象比较和完整性检查的**原始工具输出或可读取的记录路径**，无需重跑全库压缩。核验这些证据后才能对 approved R4 的当前 diff 给出最终 APPROVE。

The requested raw output excerpts are retained verbatim at
`D:/Temp/opencode/manual-cold-raw-verification.log`, with exact commands and
working directories. The log identifies the maintenance timeout separately from
its completed verify and the later successful reclaim/level-12 run. No code or
design change accompanies this evidence-only completion of round 2.

Round 2 evidence completion, approved R4, full original scope, same invocation:

> No blocking findings.
>
> **APPROVE — `docs/plans/manual-cold-storage-transparency.md` approved R4 对应的当前 implementation diff，完整范围实现审计通过。**
>
> 批准仅适用于本次审阅的七个生产文件及四个测试文件变更，不涵盖工作树中的其他修改，也不授权生产数据库操作、commit 或 push。

The auditor checked the retained raw execution outputs against the reviewed
scripts, tests and receipt. Independent E=992, qualifying C=161 (16.23%) and
7 production files / 819 gross lines pass. Remaining non-blocking observations
are the fixed-snapshot capacity margin and minor wording of group-level comments;
neither changes the verified batch-wide retain/assign/release behavior.

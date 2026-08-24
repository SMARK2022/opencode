# Canonical Implementation Plan: ID Rollover Consumer Repair

> Status: verified
>
> Revision: R14
>
> Approved revision: R14
>
> Audit mode: full-scope
>
> Requirement source: 用户在当前 Session 中提出的 ID 回绕修复、OpenCode/TUI 范围澄清与 App/Web 必须无兼容性测试错误的补充要求
>
> Implementation allowed: yes
>
> Last updated: 2026-08-24

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

Initial requirement:

> 是的,因此请你进行相应的ID回绕问题修复,适当按照上游内容,同时保持相应修改鲁棒稳定,不会引入新的问题。同时保持相对较小的机制调整面,以及保持相对兼容性的调整面,也就是不改ID编码、系统性改消费者等内容。

Authoritative scope clarification:

> 注意有问题，整体而言，修改的覆盖面应当是以 Open Code 也就是 TOI 部分为主要核心，其中 APP 以及 Web 端我们从来都没有使用过。

`TOI` is treated as the user's reference to the OpenCode TUI package path,
consistent with the repository paths and the supplied TUI test output.

Direct scope confirmation after the R3 audit blocker:

> 明确排除 App/Web

Accepted scope meaning: this task repairs only `packages/opencode` and the TUI
core path. The confirmed App/Web rollover defects are intentionally deferred to
a separate task even though those source paths remain reachable.

Compatibility gate clarification:

> 但相应的APP以及Web中也不能存在相应的Test的错误。也就是说任何兼容性或者错误Test错误等等都不应该保留。

Accepted scope meaning: App/Web rollover consumer production changes remain
deferred, but their existing compatibility gates must finish with zero failures.
An observed package-runner compatibility defect may be repaired at its owning
configuration; it cannot be dismissed merely because the UI clients are not the
primary product surface.

Additional implementation-scope authorization after the R7 implementation audit:

> 授权额外 R9 审计

Accepted meaning: one additional full-scope plan-audit round is authorized to
repair the evidenced OpenCode/TUI raw Message-ID chronology consumers found by
the R8 inventory. This does not authorize App/Web rollover consumer repair or
unrelated test cleanup.

R13 additionally covers the independently evidenced semantic Compaction
boundary consumer in `ColdStorage.eligibility`; physical maintenance
enumeration and checkpoints remain excluded.

Final user decisions on 2026-08-24 (after lifetime plan-audit round 11 and
implementation-audit round 2 both returned BLOCK):

> 你需要完整处理这些问题，自行完整进行相应解决，必须保证最终以approve的审计结果退出

Accepted meaning:

1. The maintenance timeout adjustment (former INV-V02 / former §10.8) is
   removed from this plan's scope as an unrelated pre-existing test-budget
   defect. `db-maintenance.test.ts` is restored to its original timeouts and
   the budget issue is deferred to its own task. Historical audit text that
   mentions it remains record-only.
2. As the final decision maker, the user explicitly authorizes continued
   full-scope audits beyond the six-round plan-audit limit for this canonical
   plan (lifetime rounds 12+) and requires the task to conclude with an
   APPROVE release verdict.
3. The App/Web compatibility gates (REQ-03 / INV-A01) remain in scope per the
   verbatim compatibility requirement already quoted in this section.

## 2. Explicit Non-Goals

- 不修改 `packages/opencode/src/id/id.ts`、`packages/core/src/util/identifier.ts` 或 ID 长度、前缀、counter、随机尾部和 6-byte 编码。
- 不修改 App/Web 的 ID chronology、projection、revert 或 session consumer 源码。R2 中尚未提交的 rollover implementation 已全部撤回。
- 不修改 `packages/web` production/config/test files；其现有 build 作为必过兼容性门禁。
- `packages/app/package.json` 只允许修复已复现的 Windows Bun/Vite package-runner 入口；不借此改变 App 行为、依赖版本或测试断言。
- 不新增 schema、migration、配置、feature flag、generated SDK、兼容协议、wrap detector、epoch 或旧路径 fallback。
- 不重复修改已由 `d4d2396aa9` 修复并有行为测试保护的 TUI Message create/update/hidden/remove chronology 投影。
- 不修改 Part、Permission、Question、Project、Workspace 或 App Session display 排序。
- 不修改 ID identity（`parentID ===`、Map key、primary-key lookup）或 PartID 顺序。
- 不把 Message chronology consumer 与物理 ID enumeration/checkpoint 混为一谈：`ColdStorage.maintain` 的 `lastID`、PartID 扫描、SessionID summary-owner 扫描保持原合同。
- 不修改 `MessageV2.page` 的已正确 tuple pagination、`latest`、Prompt completion control flow 或 Revert 的已正确 service comparator；只修复仍存在的 raw-ID boundary consumer。
- 不把完整 `test:ci` 中偶发的 daemon lifecycle failure 混入 ID 修复。该 case 当前单独运行通过，且没有从本 GOAL diff 到 daemon/db-compress 的调用路径。
- maintenance 集成测试的既有 30s case budget 缺陷不属于本计划：R14 已将 `db-maintenance.test.ts` 恢复原状，相关问题另行处理。
- 不修改 App/Web rollover consumer 源码；App/Web 只保留兼容性 gate 与已实施的 Vite 入口修复。
- 不修改其他脏工作区 plan、models snapshot、thirdparty 或未列入 R14 owner 的 Session 文件。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | OpenCode core owner 位于 `packages/opencode`；TUI 位于 `src/cli/cmd/tui`，Message 使用 MessageV2。 |
| `docs/adr/README.md` | 本任务修复既有 owner，不形成新的长期架构决策，不创建 ADR。 |
| `AGENTS.md` | 测试/typecheck 必须在 package 目录运行；修改保持最小并避开无关工作树内容。 |
| `packages/opencode/AGENTS.md` | 复用现有 Effect/AppFileSystem 和 MessageV2 owner，不新增 service/barrel/schema。 |
| `packages/opencode/test/AGENTS.md` | filesystem mtime 测试使用 live fixture；partial service failure 使用 `Layer.mock` 并断言可观察行为。 |
| `packages/app/AGENTS.md` | 不重启现有 App/server；验证优先使用 package scripts 和 Playwright 自有 lifecycle。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复 first divergence、零 fallback、TDD、完整映射、中文注释与独立审计。 |
| User scope clarification | App/Web 未被使用，生产范围必须收敛到 OpenCode/TUI core。 |
| User compatibility clarification | App/Web 虽不做 rollover production repair，但不能遗留 test/compatibility failures。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/id/id.ts:51-77` | ascending ID 只保留 6-byte `timestamp*0x1000+counter`，每 `2^36 ms` 回绕。 | observed |
| `packages/opencode/src/tool/truncate.ts:50-61` baseline | cleanup 从 filename ID 解码时间，导致 2026-08 边界后错误判龄。 | observed |
| `packages/opencode/test/tool/truncation.test.ts:282-304` baseline | 原 wall-clock fixture 在当前边界稳定失败；用户完整 run 也报告该 core failure。 | observed |
| `packages/opencode/src/session/message-v2.ts:788-795` baseline | chronology 以 persisted time 为主，但同时间 tie-break 使用 `localeCompare`。 | observed |
| `packages/opencode/src/session/message-v2.ts:1419-1512` | Message page 按 SQLite `(time_created, id)` BINARY 顺序返回 chronology。 | contracted |
| `packages/opencode/src/session/schema.ts:10-17` | MessageID 只限制 `msg` 前缀，caller-supplied Unicode suffix 可到达。 | reachable |
| `packages/opencode/src/session/revert.ts:99-103,171-196` | Revert 使用 `MessageV2.compareChronology` 解释 persisted boundary。 | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:56-69` | TUI 已按 persisted time + UTF-8 bytes 做 chronology lower-bound。 | observed |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx:1418-1555` | 已覆盖 ID rollover lifecycle、arbitrary remove、SQLite BINARY tie-break。 | observed |
| `docs/plans/tui-message-id-rollover-ordering-repair.md` | verified TUI repair 是本任务必须保留的主要用户路径。 | contracted |
| Upstream `d468201952` / #40987 | upstream 将 truncation retention 改为 mtime。 | observed |
| Upstream `db581e47a3` and `a54a693af2` | upstream 将 server latest/Revert chronology 从 ID 改为 persisted time。 | observed |
| Current fork `MessageV2.latest`, Prompt and Revert | rollover 主序已使用 persisted time，不需要重复移植上游控制流。 | observed |
| Equal-time probe | `msg_\uE000` vs `msg_𐀀` at the same time: locale result `1`, UTF-8/BINARY result `-1`. | observed |
| User full `test:ci` output | pre-fix core: 3489 pass, 19 skip, truncation failure; TUI: 652 pass, 7 skip, one daemon failure. | observed |
| Isolated daemon rerun | exact daemon case passed: `1 pass`, 44 filtered, 0 fail, 18 expects, 70.08s. | observed |
| `packages/app/package.json:11-24` | unit/typecheck/build/dev/E2E owners；Vite scripts currently rely on Bun package-local bin resolution. | observed |
| `packages/app/playwright.config.ts:3-37` | E2E uses explicit root Playwright CLI in CI but starts the App through `bun run dev`. | observed |
| `.github/workflows/test.yml:554-575` | Windows CI already bypasses Bun `.bin` metadata remap with an explicit root Playwright CLI. | observed |
| App compatibility baseline | unit `336 pass / 0 fail`; typecheck pass; official `bun run build` fails because package-local Vite target is absent. | observed |
| App root-CLI probe | `node ../../node_modules/vite/bin/vite.js build` succeeds against the same source and installed Vite version. | observed |
| Web compatibility baseline | `bun run build` succeeds, including 613 generated pages and Pagefind indexing. | observed |
| `packages/opencode/test/AGENTS.md:146-159` | `Layer.mock` is the required narrow seam when only one or two service methods need deterministic failure. | contracted |
| R7 implementation audit `ses_fdef4fde0ffe3bUPVINxtJSoZQ` | observed blocking omission: `deriveGoalTurn` still uses `localeCompare` after `MessageV2.compareChronology` was repaired. | observed |
| `packages/opencode/src/session/prompt.ts:144-166` | Goal current/previous turn selection sorts eligible user Messages independently from the shared comparator. | observed |
| `packages/opencode/src/session/prompt.ts:2654-2659` | `MessageV2.goalChronology(sessionID)` enters `deriveGoalTurn` during real Goal Tool loading. | observed |
| `packages/opencode/test/session/prompt.test.ts:852-897,4923-4986` | Existing public persistence helper accepts caller-selected IDs/timestamps and existing GoalTool test exercises blocked continuity through Prompt. | observed |
| `packages/opencode/src/session/prompt.ts:2320-2335,2465-2492` | Public prompt coalescing begins usage for each user Message and completes the older running request only when a shared assistant proves supersession; the current branch uses raw MessageID order. | observed |
| `packages/opencode/test/session/prompt.test.ts:3032-3116` | Existing public coalescing behavior asserts the older request reaches a terminal zero-cost state; this is the behavior seam for a rollover regression. | observed |
| `packages/opencode/src/session/prompt.ts:2320-2335,2465-2492` | Public prompt coalescing begins usage for each user Message and completes the older running request only when a shared assistant proves supersession; the current branch uses raw MessageID order. | observed |
| `packages/opencode/test/session/prompt.test.ts:3032-3116` | Existing public coalescing behavior asserts the older request reaches a terminal zero-cost state; this is the behavior seam for a rollover regression. | observed |
| Unicode chronology probe | `msg_\uE000` vs `msg_\u{10000}` has opposite locale and UTF-8/BINARY ordering. | observed |
| Full post-change `test:ci` | outer 30-minute run reached two `db-maintenance.test.ts` case-level 30s timeouts before completion.（R14 起仅为历史证据：maintenance budget 缺陷已拆出本计划） | observed |
| Isolated maintenance red | `skips SQL vacuum...` independently times out at 30s during its fourth CLI process; runner kill causes truncated JSON.（历史证据，R14 拆出） | observed |
| Diagnostic maintenance probe | changing only the two affected case budgets to 90s yields `2 pass / 0 fail` in 75.56s total.（历史证据，R14 拆出） | observed |
| R8 plan audit `ses_fddf232e8ffecq1vEJCs2Qt7fs` | full-scope inventory found raw-ID chronology consumers beyond Prompt; exact verdict was `BLOCK`. | observed |
| `packages/opencode/src/session/message-v2.ts:1565-1624` | automatic per-user summary and Fork prefix still gate Message/Part rows with raw MessageID ranges. | observed |
| `packages/opencode/src/session/session.ts:805-833` | public `Session.fork` currently creates the target before reading `rawForkRows`, so a missing explicit boundary can leave an orphan target; the repair must admit source rows first. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-fork-from-timeline.tsx:22-72` | TUI exposes caller-selected user MessageID as the exclusive Fork boundary. | reachable |
| `packages/opencode/src/session/summary-cache.ts:159-227,351-378,518-588` | persisted `summary_cursor` drives raw-ID incremental scans, snapshot maxima and CAS commits; `greatestClosedMessageID` deliberately returns the empty-string sentinel for a valid empty Session. | observed |
| `packages/opencode/src/storage/cold.ts:1837-1897` | Message/Part projectors invalidate SummaryCache by comparing changed MessageID with the persisted cursor. | observed |
| `packages/opencode/src/session/projectors.ts:155-248` | Message/Part replacement/removal routes call the summary invalidation owner in the same transaction. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:780-833,1036-1075,1242-1415,1562-1595` | Undo/Redo/Copy/Revert-hidden/queued route behavior still interprets ID magnitude as chronology. | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:3503-3653` | existing real OpenTUI Session harness mounts commands/rendering over an authoritative chronology fixture. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1168-1210` | TUI session sync intentionally replaces the local Message projection with a bounded 300-row chronology snapshot; route commands cannot infer chronology for an identity outside that snapshot. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1168-1210` | TUI session sync intentionally replaces the local Message projection with a bounded 300-row chronology snapshot; route commands cannot infer chronology for an identity outside that snapshot. | observed |
| `packages/opencode/src/session/projectors-next.ts:29-60` | experimental v2 compaction adapter orders historical rows only by Event ID; assistant and shell selectors have producer-specific identity/active-state guards that must not be changed without a reachable chronology failure. | observed |
| `packages/opencode/src/v2/session.ts:221-292` | public v2 messages/context already use `(time_created,id)` and provide the matching behavior seam. | observed |
| `packages/opencode/test/session/prompt.test.ts:1370-1408` and `packages/opencode/test/session/compaction.test.ts:693-729` | Existing public tests exercise the real EventV2 bridge/projector and V2 Session reads; this is the correct integration seam for the SQLite adapter regression, not the core-only memory updater test. | observed |
| `packages/opencode/src/storage/cold.ts:3164-3226` | maintenance `lastID` is a resumable physical owner-enumeration checkpoint, not Message chronology. | contracted |
| `packages/opencode/src/storage/cold.ts:1240-1419` | packed Message/Part ID sorts only make deterministic payload chunks; they do not select chronology prefixes. | contracted |

## 5. Current Behavior

### 5.1 Truncation retention

```text
Truncate.write -> ToolID filename + filesystem mtime
  -> cleanup decodes wrapped filename timestamp
  -> recent and old files are compared in a truncated epoch
  -> retention removes or preserves the wrong file
```

### 5.2 OpenCode/TUI Message chronology

```text
Message row persists time.created + id
  -> MessageV2.page orders by SQLite BINARY
  -> TUI searchMessage already uses time + UTF-8 bytes
  -> MessageV2.compareChronology uses time + UTF-8/BINARY bytes
  -> Prompt deriveGoalTurn still uses time + localeCompare
  -> Fork raw prefix, SummaryCache cursor/invalidation, TUI route boundaries and v2 compaction lookup still use raw ID order
  -> equal-time boundary and post-wrap suffix can be interpreted differently by Goal, coalescing, Fork, summary, TUI and v2 consumers
```

The TUI SyncProvider projection is already fixed: insert/update/hidden/remove use
one chronology projection plus ID index and pass their targeted tests. R13 keeps
that owner, but repairs the remaining TUI Session route comparisons and the
OpenCode Prompt/coalescing/Fork/SummaryCache/v2 consumers whose raw-ID boundaries are still
reachable after rollover.

### 5.3 Reported daemon failure

The daemon test exercises interactive DB compression, daemon ownership,
shutdown choice and election locking. Neither `Truncate.cleanup` nor
`MessageV2.compareChronology` is reachable from that path. The exact case passes
in isolation; it remains a full-shard verification risk, not an ID repair owner.

### 5.4 App/Web compatibility gates

```text
packages/app bun run build
  -> Bun package-local vite shim
  -> packages/app/node_modules/vite/bin/vite.js (absent)
  -> MODULE_NOT_FOUND

same source + installed dependency
  -> node ../../node_modules/vite/bin/vite.js build
  -> successful production build
```

The App unit suite and typecheck already pass. The Web package has no test files
or test script; its production build passes and is its applicable compatibility
gate. App Playwright currently contains one `fixme` case, but the runner still
owns App dev-server startup through `bun run dev`, which shares the broken Vite
entrypoint.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Tool file on either side of ID wrap | ToolID producer | Unique filename, no full wall-clock epoch after wrap | write -> cleanup | Truncate retention | observed |
| Old/recent Tool file mtime | Filesystem | mtime records age independently of filename | cleanup stat -> cutoff | Truncate retention | observed |
| Entry disappears or stat fails | Filesystem race/permission | scan does not guarantee later stat | cleanup scan | Truncate retention | reachable |
| TUI Message lifecycle crossing wrap | MessageV2 events/page | persisted creation time; TUI maintains ID index for remove | SSE/HTTP -> TUI sync | TUI SyncProvider | observed |
| Same-time caller Unicode Message IDs | public MessageID schema | prefix only; SQL uses BINARY | page/TUI/service Revert | Message chronology | reachable |
| App scripts on Windows Bun hoisted install | workspace package runner | dependency exists at repository root; package-local Vite target absent | build/dev -> Bun shim | App package scripts | observed |
| App/Web compatibility verification | package scripts and CI | App unit/typecheck/build/E2E; Web build | package gates | App/Web package owners | observed |
| ID without persisted Message time | no accepted producer | Message contains time.created | none | none | speculative |
| Same-session MessageID after wrap used as a Fork exclusive boundary | public `Session.fork(messageID)` | Message rows carry persisted time; current `rawForkRows` filters only `id < messageID` | TUI timeline/fork dialog -> HTTP -> Session.fork -> rawForkRows | Fork prefix owner | reachable |
| Summary cursor/invalidation at or before a MessageID | automatic summarize/projector Message or Part update | cursor is persisted as a MessageID but current scans compare raw ID | Prompt/summary -> SummaryCache and Message/Part projectors | SummaryCache/ColdStorage summary owner | reachable |
| Completed Compaction boundary used for semantic cold eligibility | `SessionCompaction` writes `tail_start_id`; `CompactionBoundary.latest` exposes it | `ColdStorage.eligibility` currently compares owner Message IDs with raw `<` | Compaction Part -> boundary -> `isEligibleOwner`/freeze batch | ColdStorage semantic eligibility owner | reachable |
| Experimental SessionMessage compaction event ID after wrap | EventV2 producer under `experimentalEventSystem` | SessionMessage rows persist `time_created`; current compaction lookup orders raw IDs while repeated compaction rows remain reachable | compaction event -> next projector -> V2 Session context | v2 compaction projector and V2 Session | reachable |
| Missing public Fork boundary or missing persisted summary cursor row | caller-supplied MessageID or external database damage | a chronology tuple cannot be reconstructed without the persisted Message row; normal projector deletion invalidates covered summaries before deleting the row | HTTP/TUI fork or SummaryCache load/invalidation | Fork/summary owner | reachable corruption/error boundary |
| Coalesced Assistant parent identity | real `loop` result | `parentID` identifies a same-Session persisted user Message but does not carry `time.created` | prompt -> loop -> MessageV2.get(parentID) -> supersession check | SessionPrompt coalescing owner | reachable |
| Present Compaction `tail_start_id` whose Message was removed | Compaction Part plus public Message removal/projector | JSON ID has no foreign key; the boundary target can disappear while marker/summary remain | CompactionBoundary.latest -> ColdStorage eligibility | ColdStorage semantic eligibility owner | reachable |
| Revert boundary outside the TUI's bounded 300-message snapshot | TUI session sync | the route has an ordered but intentionally bounded array and no chronology key in an ID-only command; an absent exact boundary must not be guessed from ID magnitude | Session route Undo/Redo/hidden/Copy/queued | TUI Session route | reachable |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| REQ-01 | 修复 OpenCode/TUI 核心 ID 回绕问题，不改 ID 编码。 | initial requirement + clarification | partial |
| REQ-02 | App/Web rollover consumer 源码不进入本次 diff；其已知 ID 缺陷明确留待其他任务。 | direct user confirmation | scoped diff |
| REQ-03 | App/Web applicable unit/type/build/E2E gates 不得遗留失败。 | compatibility clarification | baseline partly green; App build red |
| INV-T01 | Truncation retention 只由 mtime 和 7-day cutoff 决定。 | failing full/narrow test; upstream | baseline test fails |
| INV-T02 | stat 失败或缺失 mtime 的 entry 本轮保留。 | reachable race; best-effort cleanup | deterministic mocked-stat test planned |
| INV-M01 | Message chronology 以 time.created 为主，同时间 ID 使用 SQLite BINARY-compatible UTF-8 order。 | page SQL, TUI, public ID | TUI test; service gap baseline |
| INV-M02 | TUI create/update/hidden/remove 在回绕边界保持 chronology 与精确 identity。 | user focus; prior repair | three TUI tests |
| INV-C01 | 不新增 fallback、parallel ordering、cache、schema 或 public interface。 | user + policy | audit/diff |
| INV-V01 | full `test:ci` 不再出现 Truncate failure；daemon 若再失败须单独报告。 | user supplied run | pending rerun |
| INV-A01 | App official Vite scripts use the installed root CLI and preserve their existing subcommands/arguments. | reproduced shim failure + root probe | App build red; E2E pending |
| INV-A02 | App unit/typecheck/build/E2E and Web build complete with zero failures. | direct user requirement | pending final run |
| INV-M03 | Goal current/previous eligible turns use the same `(time.created, UTF-8/BINARY id)` chronology contract as MessageV2/page/Revert. | R7 implementation audit B-01 | new Prompt Goal behavior test |
| INV-M04 | Fork with an exclusive Message boundary retains every Message/Part chronologically before that boundary, including lexical-low post-wrap rows. | rawForkRows source path + public fork API | new fork public behavior test |
| INV-M05 | Summary incremental scan and invalidation retire or advance the persisted cursor by Message chronology, not raw ID order; a non-empty cursor must resolve to a current Message row, while the existing empty-string cursor is the legal no-Message sentinel. | SummaryCache cursor contract + projectors | new public Session.diff/summarize behavior test |
| INV-M06 | TUI Session route uses transcript chronology/identity for Undo, Redo, Revert-hidden, Copy-last-assistant and queued display. | direct route comparisons | new OpenTUI command/render behavior test |
| INV-M07 | Experimental v2 Session context selects the newest persisted compaction by `time_created` plus SQLite BINARY ID tie-break. Assistant selection remains active-state based and shell selection remains callID identity based unless a producer makes a chronology failure reachable. | v2 table and query path | real EventV2/projector integration test through existing OpenCode session seam |
| INV-M08 | Prompt coalescing resolves the returned Assistant's parent Message in the same Session, then completes an older running request only when the request Message precedes that parent by shared chronology; existing status, zero-cost and error mapping remain unchanged. | public coalescing path + `MessageV2.get` + SessionRequestUsage contract | public coalescing rollover regression |
| INV-M09 | Semantic Compaction eligibility freezes only owners chronologically before a resolvable completed boundary. A present-but-unresolvable tail boundary authorizes no recent-session owner; aged-session eligibility remains its independent existing rule. Physical maintenance enumeration/checkpoints retain their existing ID cursor contract. | CompactionBoundary producer + public removal + ColdStorage eligibility path | public `isEligibleOwner` regression for rollover and removed tail |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-T01 | cleanup 把 wrapped ID timestamp 当完整 wall-clock timestamp。 | `Truncate.cleanup` | deterministic baseline and full run fail. |
| INV-M01 | equal-time branch 使用 locale collation，而 page/TUI 使用 BINARY bytes。 | `MessageV2.compareChronology` | probe locale `1` vs UTF-8 `-1`; Revert consumes comparator. |
| INV-M02 | No current divergence; prior TUI defect was repaired in `d4d2396aa9`. | TUI SyncProvider | targeted TUI tests pass `3/3`. |
| INV-V01 daemon | No proven divergence from this GOAL. | daemon/db-compress | exact case passes isolated; no changed-module call path. |
| INV-A01 | Bun resolves `vite` to an absent package-local module although the hoisted root dependency is installed. | `packages/app/package.json` scripts | official build fails; explicit root CLI succeeds. |
| INV-M03 | `deriveGoalTurn` performs a second equal-time locale collation after `goalChronology` has produced persisted Message candidates. | implementation audit B-01 | current source `prompt.ts:166`; Goal continuity test planned |
| INV-M08 | Prompt coalescing uses raw `message.info.id < result.info.parentID` and never resolves the parent Message's time, so a valid post-wrap ID can leave the older request running. | R11 inventory + R12 audit | `prompt.ts:2465-2492`, existing `MessageV2.get`; public coalescing test required |
| INV-M09 | `ColdStorage.eligibility` uses raw owner ID `< boundary`; when a present `tail_start_id` no longer resolves, no tuple or fail-closed semantic boundary exists. | R11 inventory + R12 audit | `cold.ts:917-947,2593-2612`; CompactionBoundary -> removal -> eligibility behavior test required |
| INV-M04 | `rawForkRows` uses raw MessageID `<` for an exclusive prefix, so a lexical-low post-wrap Message is omitted despite being chronologically earlier; it also currently filters Parts by the same raw range instead of exact selected-Message membership. | R11 inventory | `message-v2.ts:1601-1624`; fork behavior test required |
| INV-M05 | SummaryCache load, greatest-closed selection and projectors use raw MessageID cursor comparisons, so post-wrap rows can be skipped or invalidated against the wrong side of the cache boundary; the persisted cursor is also currently used without resolving its Message row. | R11 inventory | `summary-cache.ts`, `cold.ts`, `projectors.ts`; public diff/summarize test required |
| INV-M06 | TUI Session route directly compares Message IDs for undo/redo/revert-hidden/copy-last/queued decisions although Sync data is chronology ordered. | R11 inventory | `routes/session/index.tsx`; OpenTUI route behavior test required |
| INV-M07 | Experimental v2 compaction adapter selects the lexical-high row rather than the newest persisted compaction when repeated compaction events cross the ID rollover. | R11 inventory | `projectors-next.ts:41-49`; real v2 context behavior test required |

Red-capable commands already run before provisional core implementation:

```powershell
# packages/opencode
bun test --timeout 30000 ./test/tool/truncation.test.ts
# baseline: 20 pass, 1 fail

bun test --timeout 30000 ./test/session/message-v2.test.ts --test-name-pattern "compareChronology"
# baseline: Expected < 0, Received 1

# packages/app
bun run build
# baseline: MODULE_NOT_FOUND packages/app/node_modules/vite/bin/vite.js

node ../../node_modules/vite/bin/vite.js build
# diagnosis probe: succeeds; proves source/build graph is healthy
```

Current green results do not self-authorize R13; exact R13 requires independent
approval before implementation may resume.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Why not elsewhere |
| --- | --- | --- | --- | --- |
| Tool file age | `Truncate.cleanup` + AppFileSystem stat | delete files older than retention | cleanup scans/removes; mtime is authoritative | ID producer only names files |
| Persisted Message chronology | `MessageV2.compareChronology` plus `Prompt.deriveGoalTurn` consumer | same order as page for service consumers and Goal current/previous turns | Revert/latest/Prompt share it | TUI adapter mirrors the same contract |
| Fork exclusive prefix | `MessageV2.rawForkRows` | clone all rows chronologically before the selected Message | it owns source row admission before ID remap | `ColdStorage.clonePrefix` only clones the supplied exact maps |
| Summary aggregate cursor | `SummaryCache` plus `ColdStorage.invalidateSessionSummaryBefore` | scan, advance and invalidate one persisted Message chronology prefix | cache/ref/cursor lifecycle already lives here | projectors only report the changed Message identity |
| Semantic Compaction eligibility | `ColdStorage.eligibility` plus `CompactionBoundary.latest` | compare owner chronology against a resolvable completed boundary; fail closed for a missing persisted tail while preserving independent age eligibility and physical cursors | semantic cold eligibility owns the freeze decision | maintenance enumeration owns only physical scan/checkpoint order |
| TUI lifecycle projection | existing `searchMessage` + index | bounded chronology and exact remove | already fixed at event owner | R13 route repair must consume its ordered array, not duplicate projection state |
| TUI Session route boundary | `routes/session/index.tsx` | Undo/Redo/Revert/Copy/queued decisions follow transcript chronology | route owns commands and rendering | SyncProvider must not learn UI command policy |
| Prompt coalescing completion boundary | `SessionPrompt.prompt` plus existing `MessageV2.get` | resolve Assistant parent identity to its persisted tuple before supersession comparison | Prompt owns coalescing orchestration and MessageV2 owns persisted lookup | SessionRequestUsage owns accounting state, not Message ordering |
| Experimental v2 current Compaction | `projectors-next` SQL adapter | match the persisted v2 context chronology for repeated compactions | SQL adapter owns persisted selection | assistant active-state and shell callID identity are separate contracts |
| daemon failure | daemon/db-compress lifecycle | independent interaction/election contract | isolated test diagnoses it | ID modules do not own it |
| App Vite command resolution | `packages/app/package.json` scripts | invoke the workspace-installed Vite CLI on every supported OS | package script is the failing transition | no App source or dependency change needed |
| Web compatibility | existing Web build script | production build must remain green | package owns its build | no R13 Web change needed |
| Goal current/previous turn chronology | `deriveGoalTurn` | same-time ordering must match persisted Message contract | Prompt owns Goal turn context | Goal state machine owns transitions, not ordering |

## 10. Single Approved Primary-Path Design

```text
filesystem mtime / persisted Message time
  -> existing OpenCode owner comparator
  -> existing cleanup or TUI/service lifecycle
  -> unchanged IDs, schemas and interfaces
```

### 10.1 Truncate

- Compute numeric wall-clock cutoff once.
- Stat each full `tool_` path and read optional mtime.
- Preserve entries with unavailable metadata or recent mtime.
- Remove only entries older than cutoff.
- Remove filename timestamp decoding from cleanup.

### 10.2 MessageV2 and Prompt chronology

- Keep numeric `time.created` as primary key.
- Replace only equal-time `localeCompare` with UTF-8 byte order matching
  SQLite BINARY and existing TUI lower-bound.
- Make `deriveGoalTurn` call the same `MessageV2.compareChronology` contract;
  do not duplicate byte comparison logic in Prompt.
- Make the coalesced-request supersession check use the same
  `MessageV2.compareChronology` contract. Resolve `result.info.parentID` with
  existing `MessageV2.get({ sessionID, messageID })` before comparison; this
  supplies the parent user Message's persisted `time.created` without a new
  interface. A missing parent preserves the existing `MessageV2.get` error
  instead of guessing chronology; preserve the existing
  `SessionRequestUsage.get/complete` status, zero-cost and error mapping.
- Do not change page, Revert flow, latest, Goal state transitions or event
  shape.

### 10.3 Semantic Cold Eligibility

- Resolve `CompactionBoundary.latest`'s `tail_start_id` or marker fallback to
  the current Session's persisted Message tuple before evaluating a semantic
  owner boundary.
- The marker fallback applies only when `tail_start_id` is absent, matching the
  shipped compatibility contract. If `tail_start_id` is present but its Message
  no longer resolves, semantic boundary eligibility is unavailable: a recent
  Session freezes no owner through that boundary, while an aged Session remains
  eligible only through the pre-existing age branch. Do not substitute marker
  or a nearby Message.
- Compare Message owners and the completed boundary with the existing
  `MessageV2.compareChronology` contract; preserve aged-session eligibility,
  marker/summary exclusions and extraction rules.
- Keep `ColdStorage.maintain` physical Message/Part/summary-owner enumeration
  and checkpoint cursors unchanged; this repair applies only to the semantic
  freeze eligibility decision.

### 10.4 Fork and SummaryCache

- Resolve every public MessageID boundary to the Message row's persisted
  `(time_created,id)` tuple before selecting a prefix/suffix. A missing explicit
  Fork boundary fails with the existing storage not-found error before the new
  target Session is created; it must not silently fork an ID-shaped subset.
- `Session.fork` obtains the raw source rows before `createNext`, then creates the
  target only after source admission succeeds. `rawForkRows` selects Message
  rows chronologically before the exclusive fork Message and selects Parts by
  exact membership in that Message set; it does not compare `PartTable.message_id`
  to the boundary. Part order within each selected Message remains the existing
  PartID order.
- SummaryCache keeps its existing ref/cursor/CAS owner and persisted MessageID
  representation. Its SQL scans, greatest-closed selection and cursor guards
  compare Message rows by `(time_created,id)`; Part rows are selected through the
  exact Message membership returned by the Message scan, not by raw MessageID
  predicates. Projectors resolve the changed Message and the persisted cursor,
  then compare the same tuple when deciding whether to invalidate.
- A non-empty persisted `summary_cursor` or `summary_seed.cursor` must resolve
  to a Message in the same Session. The existing empty string is a legal
  no-Message sentinel produced by an empty Session and is excluded from row
  resolution. If normal projector invalidation did not retire a non-empty
  cache cursor before that row disappeared, SummaryCache/ColdStorage raises
  its existing corruption error rather than selecting a nearby row or
  re-importing the external mirror. The initialization claim path remains
  allowed to recompute its final cursor after a Message is deleted during
  external I/O.
- `targetWithAssistantChildren` resolves `throughMessageID` to the same snapshot
  tuple, admits the target and its structural assistant children, then constrains
  them with that tuple. A missing snapshot boundary is an error, not an unbounded
  or raw-ID fallback. No second cache, schema field, epoch or fallback is
  introduced.

### 10.5 TUI

- Preserve the existing `searchMessage` chronology/index implementation.
- In Session route, resolve each Revert or pending identity to its exact array
  index once and express Undo/Redo/hidden-range/copy-last/queued decisions by
  ordered array position. Exact boundary equality remains identity.
- The route consumes the existing bounded 300-message snapshot; it does not add
  a fetch, a second sort, or a chronology cache. If a Revert or pending boundary
  is absent from that snapshot, commands and range rendering fail closed rather
  than infer a position from raw ID magnitude. With no Revert boundary, Undo
  retains its existing last-user behavior.
- Keep child Session ID sort, Part sort, permission/question sort and Sync store
  identity indexes unchanged because they are not Message chronology consumers.
- Test real registered commands and rendered rows through the existing OpenTUI
  Session harness; do not add a production export solely for tests.

### 10.6 Experimental v2 SessionMessage

- Change the persisted current-compaction lookup to order by
  `time_created DESC, id DESC`, matching v2 Session context and the persisted
  chronology contract.
- Keep current-assistant selection based on the existing unfinished predicate:
  producer paths complete the old assistant before creating the next one, and
  no reachable rollover failure has been found in that owner. Keep current-shell
  selection based on exact `callID`: direct shell producers generate a unique
  call ID and the lookup is an identity query, not a chronology cursor.
- Keep the Event ID, SessionMessage schema, EventV2Bridge and public v2 cursor
  unchanged.
- Verify this owner through a real OpenCode `SyncEvent`/EventV2 projector path
  and `V2Session.context` read, not only `SessionMessageUpdater.memory`; the
  latter is a separate in-memory adapter and cannot observe the SQLite
  `getCurrentCompaction` order defect.

### 10.7 App/Web compatibility

- Replace only the four App Vite script executables (`start`, `dev`, `build`,
  `serve`) with `node ../../node_modules/vite/bin/vite.js`.
- Preserve the existing default command and `build`/`preview` subcommands so
  callers and appended CLI arguments are unchanged.
- Use the repository's established explicit-root-CLI pattern that already
  protects Playwright on Windows from Bun `.bin` metadata remapping.
- Do not change App source, App assertions, Web files, dependency versions or
  rollover behavior.
- Verify App unit/typecheck/build/E2E and Web build with zero failures.

No wrap detector, retry, second ordering mode or alternate success path is
introduced.

## 11. Secondary and Replacement Path Inventory

| Path | Current/proposed | Classification | Success? | Share | Disposition |
| --- | --- | --- | --- | --- | --- |
| mtime older/recent | proposed | primary branches | yes | 45% | implement |
| stat unavailable | proposed | supported no-op | yes | 10% | preserve |
| Message times differ | current | primary branch | yes | 25% | preserve |
| Message times equal | proposed | primary tie branch | yes | 20% | UTF-8 bytes |
| Goal turn equal-time consumer | current broken / proposed repair | existing primary chronology contract | yes | 0 new | reuse `compareChronology` |
| Fork boundary before/after wrap | current broken / proposed repair | primary chronology boundary | yes | 0 new | resolve boundary tuple and select exact prefix |
| Summary cursor scan/invalidation | current broken / proposed repair | durable aggregate prefix | yes | 0 new | retain one SummaryCache owner and tuple predicates |
| TUI route boundary decisions | current broken / proposed repair | existing ordered transcript | yes | 0 new | use array position plus exact identity |
| v2 current compaction lookup | current broken / proposed repair | existing v2 chronology contract | yes | 0 new | order SQL by time plus BINARY ID |
| Semantic Compaction cold eligibility | current broken / proposed repair | existing Compaction boundary chronology contract | yes | 0 new | resolve boundary tuple, fail closed when a present tail is missing, and compare semantic owners by chronology |
| TUI chronology/index | current verified path | existing primary | yes | 0 new | preserve |
| App/Web repair | removed | explicit user scope exclusion | no | 0% | defer to separate task |
| App root Vite CLI scripts | proposed | compatibility primary path | yes | config-only | implement |
| Bun package-local Vite shim | current broken path | replaced path | no | 0% | remove from App scripts |
| wrap/legacy fallback | rejected | forbidden fallback | yes | 0% | reject |

New alternate success paths: `0`. New diagnostic surface: `0%`.

## 12. Workaround Deletion and Replacement

| Existing workaround/duplicate | Why it existed | Why R13 supersedes it | Location |
| --- | --- | --- | --- |
| Filename ID decoded as retention time | pre-wrap IDs appeared monotonic | mtime survives epochs | `truncate.ts` |
| locale equal-time tie-break | deterministic text order | persisted DB/TUI contract is UTF-8 BINARY | `message-v2.ts` |
| Prompt-local locale equal-time tie-break | Goal turn code predated shared comparator alignment | Goal current/previous selection must use the same persisted contract | `prompt.ts` |
| Prompt coalescing raw parent-ID comparison | parent identity appeared chronological | existing `MessageV2.get` supplies the parent tuple required by the shared comparator | `prompt.ts` |
| Fork raw ID prefix filter | ascending IDs appeared to be a chronology cursor | public fork boundary is a persisted Message tuple | `message-v2.ts` |
| Summary raw ID cursor/invalidation comparisons | aggregate rows were historically monotonic | wrapped Message IDs can cross a durable cache boundary | `summary-cache.ts`, `cold.ts` |
| TUI route raw ID comparisons | Sync array used to be ID ordered | array position is the existing chronology projection | `routes/session/index.tsx` |
| v2 adapter raw ID compaction lookup | Event IDs appeared append-monotonic | persisted v2 rows already have time and tuple pagination | `projectors-next.ts` |
| Cold eligibility raw ID boundary comparison | Message IDs appeared append-monotonic | completed Compaction boundary and semantic owners require persisted tuple chronology | `cold.ts` |
| App/Web R2 implementation | R2 interpreted consumers broadly | user directly confirmed exclusion and separate deferral | already removed |
| implicit `vite` package-script resolution | conventional package runner path | Windows Bun remaps to an absent package-local target | `packages/app/package.json` |

## 13. Forward Traceability

| Requirement/invariant | Production path | Planned change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-T01 | cleanup -> stat -> remove | `src/tool/truncate.ts` | wrap IDs + `utimes` test |
| INV-T02 | scan entry -> mocked stat failure -> preserve | same cleanup | `Layer.mock` returns one entry, fails `stat`, records `remove`; assert no removal |
| INV-M01 | compareChronology -> service/Prompt consumers | `src/session/message-v2.ts`, `src/session/prompt.ts` | Unicode comparator test + Goal continuity behavior |
| INV-M02 | HTTP/SSE -> TUI | no production change | existing three TUI tests |
| REQ-02 | scoped diff | no App/Web rollover source; App package entrypoint only | scoped name-only diff |
| REQ-03 / INV-A01 | App scripts -> root Vite CLI | `packages/app/package.json` only | official build + Playwright runner |
| INV-A02 | App/Web package gates | no source/test assertion changes | App unit/typecheck/build/E2E + Web build |
| INV-M03 | goalChronology -> deriveGoalTurn -> GoalTool transition | `src/session/prompt.ts` | same-time Unicode Goal-turn behavior test |
| INV-M08 | prompt user -> loop -> coalesced assistant -> MessageV2.get(parentID) -> SessionRequestUsage.complete | `src/session/prompt.ts` | public coalescing test with an older post-wrap/lexical-high request and newer lexical-low parent asserts terminal zero-cost completion and distinguishes parent usage |
| INV-M04 | TUI/HTTP fork boundary -> rawForkRows -> clonePrefix | `src/session/message-v2.ts`, `src/session/session.ts`, `test/session/messages-pagination.test.ts` or `test/storage/cold.test.ts` | public fork with lexical-low post-wrap boundary retains the expected prefix; missing valid-prefix boundary fails and creates no child |
| INV-M05 | Message/Part projector -> invalidateSessionSummaryBefore -> SummaryCache scan/CAS | `src/session/summary-cache.ts`, `src/storage/cold.ts`, `test/storage/cold.test.ts`（tuple 解析全部在 SummaryCache/ColdStorage owner 内完成，`src/session/projectors.ts` 无需修改） | public Session.diff/summarize retains post-wrap closed Tool rows, preserves empty-session initialization, invalidates covered history, and rejects an unresolvable non-empty cursor |
| INV-M06 | TUI Sync ordered transcript -> Session route commands/render | `src/cli/cmd/tui/routes/session/index.tsx`, `test/cli/cmd/tui/session-message-render.test.tsx` | real command registration and rendered revert/queued behavior with crossed IDs plus an out-of-window boundary that fails closed |
| INV-M07 | EventV2 -> projectors-next -> V2 Session context | `src/session/projectors-next.ts`, `test/session/prompt.test.ts` or `test/session/compaction.test.ts` | newest persisted v2 compaction wins despite lexical-low Event ID through the SQLite projector |
| INV-M09 | Compaction Part -> CompactionBoundary.latest -> ColdStorage eligibility/freeze/status | `src/storage/cold.ts`, `test/session/compaction.test.ts` | semantic owner eligibility follows persisted Message tuple across wrap; public removal of a present tail makes recent owners ineligible without marker substitution; aged branch and physical cursor remain unchanged |
| INV-C01 | all changes | all R13-listed code/config/test files | diff + audit |
| INV-V01 | package orchestration | no extra change | full `test:ci` + isolated daemon diagnostic |

## 14. Reverse Traceability

| Production concept | Requirement | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| mtime retention | INV-T01 | failing test + upstream | wrapped filename lost epoch bits |
| UTF-8 tie-break | INV-M01 | SQL/TUI + probe | locale disagrees for reachable IDs |
| Prompt comparator and parent lookup reuse | INV-M03 / INV-M08 | reachable Goal locale consumer, coalescing raw parent ID, existing `MessageV2.get` | Prompt currently owns two incorrect chronology comparisons; parent identity alone lacks time |
| Fork tuple-boundary selection | INV-M04 | public fork producer plus raw SQL prefix | raw ID cannot represent chronology after wrap; clonePrefix cannot recover omitted rows |
| Summary tuple cursor predicates | INV-M05 | persisted cursor, public diff and projector invalidation paths | raw ID scan can skip later rows and preserve stale aggregate owners |
| Semantic Compaction eligibility tuple | INV-M09 | completed Compaction boundary -> public Message removal -> ColdStorage eligibility/freeze/status | raw owner ID comparison can freeze or retain the wrong semantic head, and a deleted present tail cannot authorize marker substitution; physical maintenance cursors are separate |
| TUI array-position boundary partition | INV-M06 | SyncProvider already guarantees chronology arrays | raw comparisons repeat the removed ID-as-time assumption; no new index is needed |
| v2 persisted compaction order | INV-M07 | EventV2 time producer and v2 tuple page/context | raw ID DESC disagrees with the persisted context order after rollover |
| explicit root Vite CLI | REQ-03 / INV-A01 | official build red + equivalent root probe green + CI precedent | implicit Bun shim targets a missing package-local module |

No new module, state, cache, retry, config, migration or public API is proposed.
The tuple predicates remain private to the owning SQL modules; TUI consumes its
already ordered array instead of importing server code.

## 15. File-Level Change Plan

| File | Action | Exact responsibility | Expected delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/truncate.ts` | modify | mtime retention; remove Identifier dependency. | +9 / -6 |
| `packages/opencode/test/tool/truncation.test.ts` | modify | deterministic wrap IDs/mtimes plus mocked stat-failure preservation. | about +28 / -5 |
| `packages/opencode/src/session/message-v2.ts` | modify | UTF-8 equal-time tie-break plus private tuple resolution for fork/snapshot boundaries. | about +30 / -12 |
| `packages/opencode/src/session/session.ts` | modify | Read Fork source rows before creating the target Session so an invalid explicit boundary cannot leave an orphan target. | about +2 / -2 |
| `packages/opencode/test/session/message-v2.test.ts` | modify | direct persisted-order regression. | +12 |
| `packages/opencode/src/session/prompt.ts` | modify | reuse `MessageV2.compareChronology` in Goal selection and resolve coalesced Assistant parent with existing `MessageV2.get` before supersession; no Goal state-machine or usage semantics change. | about +6 / -2 |
| `packages/opencode/test/session/prompt.test.ts` | modify | same-time Unicode eligible Goal turns and public coalescing rollover behavior with distinct old/latest usage records. | about +60 / +2 |
| `packages/opencode/src/session/summary-cache.ts` | modify | make scan/max/cursor guards use persisted Message tuples while retaining existing CAS/ref lifecycle. | about +45 / -20 |
| `packages/opencode/src/storage/cold.ts` | modify | resolve changed Message against persisted summary cursor and semantic Compaction boundary before eligibility; physical maintenance cursor remains unchanged. | about +40 / -12 |
| `packages/opencode/test/session/compaction.test.ts` | modify | public semantic Compaction eligibility rollover and removed-present-tail regressions through `ColdStorage.isEligibleOwner` and Session removal. | about +55 |
| `packages/opencode/src/session/projectors-next.ts` | modify | order current persisted compaction lookup by time then ID; leave assistant/shell identity selectors unchanged. | +1 / -1 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | replace Message raw-ID route decisions with ordered-array position/identity. | about +25 / -12 |
| `packages/opencode/test/storage/cold.test.ts` | modify | public Fork, SummaryCache, empty-sentinel, missing-boundary and semantic Compaction eligibility rollover regressions. | about +180 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | real OpenTUI command/render regressions for crossed and out-of-window route boundaries, plus command-level undo/redo/copy rollover coverage. | about +320 |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` | modify | widen FetchHandler to allow async request-interception hooks used by command tests. | +6 |
| `packages/app/package.json` | modify | make existing Vite scripts use the installed root CLI on Windows and preserve commands. | +4 / -4 |

No App/Web rollover consumer source is changed by R13. TUI changes are limited to
the OpenCode Session route and its existing behavior harness; Web remains clean.

## 16. TDD Behavior Slices

| Order | Red behavior | Baseline cause | Minimal green | Protected behavior |
| --- | --- | --- | --- | --- |
| 1 | old/recent wrap files follow wrong retention | truncated filename time | stat mtime | core failure |
| 2 | scanned entry loses stat metadata | filesystem race/permission | preserve unknown entry | cleanup safety |
| 3 | Unicode equal-time order differs from DB | locale collation | byte tie-break | service/TUI consistency |
| 4 | Goal current/previous turn diverges on same-time Unicode IDs | Prompt-local locale collation | shared comparator reuse | Goal blocked continuity |
| 5 | coalesced older request remains running across ID wrap | raw parent ID supersession check without parent time | resolve parent with existing MessageV2.get and reuse shared comparator | zero-cost old request completion without changing latest usage |
| 6 | Fork with a post-wrap exclusive boundary omits a chronological prefix row | raw MessageID `<` | resolve boundary tuple and select exact Message set | forked public Session prefix |
| 7 | missing Fork boundary lacks error/orphan guarantee | target created before source admission | source admission before target creation | HTTP/Session failure contract |
| 8 | SummaryCache skips or fails to invalidate post-wrap closed history | raw MessageID cursor predicates | tuple scan/invalidation with same ref/CAS path | Session.diff/summarize aggregate |
| 9 | empty Session summary initialization is rejected | empty sentinel treated as missing row | preserve `""` no-Message sentinel | first public Session.diff |
| 10 | TUI route hides/copies/queues the wrong Message around a wrap | raw route comparisons | array index plus exact ID identity | OpenTUI command/render behavior |
| 11 | TUI boundary outside 300-row snapshot is guessed | bounded snapshot has no boundary tuple | fail closed without new fetch/cache | OpenTUI missing-boundary behavior |
| 12 | semantic Compaction eligibility chooses the wrong cold owners across wrap | raw owner ID `< boundary` | persisted Message tuple comparison in eligibility | public `isEligibleOwner` behavior |
| 13 | removed present `tail_start_id` leaves eligibility undefined | JSON boundary ID has no Message foreign key | recent Session fails closed; aged branch remains independent; no marker substitution | public removal -> `isEligibleOwner` behavior |
| 14 | v2 context chooses lexical-low old compaction row | raw Event ID DESC | time plus BINARY ID SQL order | real EventV2/projector plus V2 Session context behavior |
| 15 | official App build cannot locate Vite | broken Bun package-local shim | explicit root Vite CLI | App build and E2E startup |
| 16 | App/Web package gates could regress | cross-package compatibility | no additional edit | zero-failure release gate |

Expected values use literal times/order, not production helpers.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective lines `E` | about 830 | carried R7 implementation plus R13/R14 production/tests, excluding imports/blank/format/plan |
| Required comments `C` | at least 125 | `ceil(830 * 0.15)` |

Comments explain filename-vs-mtime ownership, unknown-stat preservation,
mock failure intent and remove-spy observable, `2^36 ms` fixture intent,
SQLite/TUI/Prompt/Fork/Summary/Compaction/v2 byte order, Unicode Goal-turn and
fork-prefix fixtures, parent-tuple lookup, cursor invalidation ownership,
missing-tail fail-closed semantic cold eligibility,
TUI array-position semantics, command-level undo/redo/copy crossed-ID intent,
request-hook/clipboard-mock test seams, App
explicit-root CLI ownership and why maintenance checkpoints remain physical ID
enumeration rather than chronology.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test --timeout 30000 ./test/tool/truncation.test.ts ./test/session/message-v2.test.ts` | `packages/opencode` | R13 base chronology owners |
| `bun test --timeout 60000 ./test/session/prompt.test.ts --test-name-pattern "same-time Unicode Goal turns|coalesced.*rollover|zero-cost.*terminal"` | `packages/opencode` | Prompt Goal and coalescing parent-tuple chronology regressions, including separate latest-parent usage |
| `bun test --timeout 60000 ./test/storage/cold.test.ts --test-name-pattern "fork.*wrap|fork.*missing|summary.*wrap|post-wrap|cursor|empty.*Session"` | `packages/opencode` | Fork and SummaryCache public rollover, sentinel and missing-boundary paths |
| `bun test --timeout 60000 ./test/session/compaction.test.ts --test-name-pattern "uses persisted Message chronology"` | `packages/opencode` | semantic Compaction boundary eligibility across rollover and public deletion of a present tail |
| `bun test --timeout 30000 ./test/v2/session-message-updater.test.ts` | `packages/opencode` | core memory adapter regression remains green |
| `bun test --timeout 60000 ./test/session/prompt.test.ts --test-name-pattern "v2.*rollover|lexical-low.*Event|persisted.*compaction"` | `packages/opencode` | real SQLite projectors-next compaction/context contract |
| `bun test --timeout 30000 ./test/cli/cmd/tui/sync.test.tsx --test-name-pattern "ID rollover\|arbitrary Message IDs\|SQLite BINARY"` | `packages/opencode` | TUI Sync projection remains green |
| `bun test --timeout 60000 ./test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "revert range hides|revert boundary outside|queued badge follows|session.undo command|session.redo command|messages.copy command"` | `packages/opencode` | TUI Session crossed/out-of-window render plus command-level undo/redo/copy rollover boundaries |
| `bun typecheck` | `packages/opencode` | package typing |
| `bun run test:ci` | `packages/opencode` | full core + TUI shards; any unrelated failure remains separately diagnosed |
| `bun run test:unit` | `packages/app` | all App unit tests, zero failures |
| `bun run typecheck` | `packages/app` | App source compatibility |
| `bun run build` | `packages/app` | official App production build through repaired script |
| `node ../../node_modules/playwright/cli.js test` | `packages/app` | official App E2E runner and dev-server startup, zero failures |
| `bun run build` | `packages/web` | applicable Web production compatibility gate |
| `bun test --timeout 30000 ./test/cli/tui/daemon.test.ts --test-name-pattern "db compress variants keep the daemon"` | `packages/opencode` | isolate daemon if full shard repeats |
| `git diff --name-only -- packages/app packages/web` | root | only `packages/app/package.json`; no Web diff |
| `git diff --check -- docs/plans/id-rollover-consumer-repair.md packages/opencode/src/tool/truncate.ts packages/opencode/test/tool/truncation.test.ts packages/opencode/src/session/message-v2.ts packages/opencode/src/session/session.ts packages/opencode/test/session/message-v2.test.ts packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts packages/opencode/src/session/summary-cache.ts packages/opencode/src/storage/cold.ts packages/opencode/src/session/projectors-next.ts packages/opencode/src/cli/cmd/tui/routes/session/index.tsx packages/opencode/test/storage/cold.test.ts packages/opencode/test/session/compaction.test.ts packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx packages/opencode/test/cli/cmd/tui/sync-fixture.tsx packages/app/package.json` | root | scoped integrity including every R14 owner |

A repeated daemon failure is investigated/reported separately; R13 cannot modify
daemon code without a new evidenced revision.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | canonical plan |
| Files modified | about 16 | R7 six files plus R13/R14 Prompt/coalescing/Fork/Summary/Compaction/TUI/v2 owners and tests（含 sync-fixture 类型放宽；db-maintenance 已拆出） |
| Files deleted | 0 | none |
| Production/config lines | about 155 | R7 changes plus coalescing, tuple-boundary, semantic eligibility and route consumer repairs |
| Test lines | about 560 | R7 regressions plus Goal/coalescing/Fork/Summary/Compaction/TUI/v2/command behavior slices |
| Generated lines | 0 | none |

## 20. Real Risks and Open Decisions

### Real Risks

- daemon case passed isolated but failed once under full TUI shard load;
- optional stat metadata must never trigger deletion;
- service byte order must remain identical to existing TUI lower-bound;
- explicit root Vite CLI assumes the repository's declared hoisted workspace install, matching current CI setup;
- App Playwright has only one `fixme` test, so E2E proves runner/dev-server compatibility rather than product behavior;
- Goal/coalescing tests must use public Session persistence and real Prompt/GoalTool execution; they must not export or call `deriveGoalTurn` directly;
- unrelated worktree changes must stay outside audit/commit paths.

### Open Decisions Requiring the User

None remain. Beyond the earlier `明确排除 App/Web` and zero-failure compatibility
requirements, the user issued the final 2026-08-24 decisions recorded in §1:
maintenance budget work is split out of this plan, continued full-scope audits
beyond the six-round limit are authorized, and the task must conclude with an
APPROVE release verdict.

### Rejected Speculation

- App/Web rollover correctness: real upstream concern but explicitly deferred; package compatibility is still mandatory.
- ID epoch/schema migration: forbidden and ineffective for persisted references.
- daemon or maintenance production changes from test timeouts: no production divergence is evidenced; the maintenance budget defect is split out of this plan per the 2026-08-24 user decision.
- new TUI state/index: existing verified code already covers the requirement.
- generic Binary/shared utility: owner-local repairs are sufficient.
- Goal state-machine changes: the blocker is only ordering input; `SessionGoal.modelTransition` remains the existing owner of blocked continuity.

## 21. Audit Contract

The auditor must read exact R14 and all user quotes, audit full OpenCode/TUI repair
plus App/Web compatibility gates, preserve the explicit exclusion of App/Web
rollover source changes, reconstruct current source, ignore prior approvals,
require evidence for expansion, and check root cause, fallback, TDD,
verification, quality and Chinese comments.

## 22. Plan Audit Record

| Round | Revision | Full scope? | Blocking | Non-blocking | Result | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01/B-02/B-03 | estimate/stat/Web | BLOCK | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |
| 2 | R2 | yes | none | estimate/stat/Web/compat | APPROVE | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |
| scope correction | R2 invalidated | yes | user excluded App/Web | App/Web diff removed | REVISION REQUIRED | current Session |
| 3 | R3 | yes | B-01: scope exclusion not accepted as stable | core plan otherwise valid | BLOCK | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |
| 3 reconsideration | R3 | yes | B-01 retained | App/Web worktree confirmed clean | BLOCK | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |
| direct scope decision | R3 invalidated | yes | user selected `明确排除 App/Web` | known client defects deferred | REVISION REQUIRED | current Session |
| compatibility correction | R4 invalidated before audit | yes | user requires zero App/Web test/compat failures | App build first divergence reproduced | REVISION REQUIRED | current Session |
| 4 | R5 | yes | B-01: stat failure preservation lacked behavior test | scope/App runner otherwise valid | BLOCK | `ses_fdf9989a6ffeyki5vA9GoYi2Nh` |
| 5 | R6 | yes | none | E/C actual must be recalculated; App E2E retains existing fixme | APPROVE | `ses_fdf9989a6ffeyki5vA9GoYi2Nh` |
| full-suite drift | R6 invalidated | yes | two maintenance cases exceed aggregate 30s test budget | timeout-only 90s probe passes `2/2` | REVISION REQUIRED | current Session |
| 6 | R7 | yes | none | four findings copied below | APPROVE | `ses_fdf9989a6ffeyki5vA9GoYi2Nh` |
| implementation audit | R7 | yes | B-01 `deriveGoalTurn` locale tie-break | full-suite evidence not independently rerun; App/Web gates only recorded; E=58/C=11 passes | BLOCK | `ses_fdef4fde0ffe3bUPVINxtJSoZQ` |
| user authorization | R7 invalidated | yes | extra R8 audit authorized | Prompt omission remains in scope | REVISION REQUIRED | current Session |
| 7 | R8 | yes | raw-ID consumers in Fork, SummaryCache and TUI Session route were omitted | Prompt repair direction remained valid | BLOCK | `ses_fddf232e8ffecq1vEJCs2Qt7fs` |
| user authorization | R8 invalidated | yes | `授权 R9 完整修复` | full evidenced OpenCode/TUI consumer inventory required | REVISION REQUIRED | current Session |
| consistency correction | R9 invalidated before audit | yes | Fork/Summary missing-boundary, bounded TUI and SQLite v2 test seams were underspecified | v2 scope narrowed to the reachable compaction owner | REVISION REQUIRED | current Session |
| 8 | R10 | yes | B-01 Prompt coalescing omitted; B-02 empty cursor sentinel contradicted; B-03 Fork missing-boundary test absent; B-04 TUI out-of-window test absent | v2 red fixture needs a controllable Event ID seam | BLOCK | `ses_fdb95e8fbffeCshTWzZxY5obG3` |
| 9 | R11 | yes | B-01 semantic ColdStorage eligibility omitted | Prompt parent tuple path needed clarification | BLOCK | `ses_fdb17917affeOosNRzxw7ztLhx` |
| 10 | R12 | yes | B-01 coalescing parent tuple path undefined; B-02 present-but-missing tail contract undefined | stats tie-break and existing fixme remain non-blocking | BLOCK | `ses_fdabde015ffe9DqQ0X6HWaKbo1` |

| 11 | R13 | yes | none | historical records, full-suite unrelated failures, E/C and App fixme require implementation verification | APPROVE | `ses_fdabde015ffe9DqQ0X6HWaKbo1` |
| post-approval plan audit | R13 working-tree plan re-audit | yes | canonical state conflict (stale R7 BLOCK text), maintenance scope authorization, six-round lifetime limit | App package-runner authorization upheld on reconsideration | BLOCK | `ses_fcea9ed52ffejsrUyWSoVWyV3i` |
| 12 | R14 | yes | none | §15 sync-fixture 行已补；App/Web 门禁与完整 test:ci 需实现审计复跑；Error/CorruptionError 类型偏差；轮次引用共享 | APPROVE | `ses_fce5a555effeArNu6r1es1dJX6` |

第 12 轮 exact verdict：`No blocking findings` / `APPROVE`（reference
`ses_fce5a555effeArNu6r1es1dJX6`）。R14 获准实施；App/Web 门禁的独立复跑由
R14 实现审计承担。

Round-count note: rounds 1-11 are the lifetime record of this single canonical
plan. The six-round policy limit has been exceeded; per the policy the
remaining release decision belongs to the final user, and the user's
2026-08-24 instruction (§1) explicitly authorizes continued full-scope audits
(lifetime rounds 12+) and requires an APPROVE conclusion. This note and the
user quote are the recorded authorization; no further plan-audit rounds may be
self-initiated beyond what that instruction covers.

Non-blocking findings:

- R7 新增的 `db-maintenance.test.ts` timeout 调整已由 observed 30 秒失败和 isolated 90 秒通过结果支持，属于测试 owner 的兼容性修复，不改变 production 行为。
- `git diff --check` 的文件列表仍遗漏计划新增的 `packages/opencode/test/cli/db-maintenance.test.ts`。这不会削弱行为测试或生产路径，但该完整性命令应在实施阶段补入该文件。
- R7 的 `E ≈ 57`、`C >= 9` 满足 `ceil(57 * 0.15) = 9`。实现审计仍需按最终 diff 重新计算实际 `E/C`。
- App Playwright 报告的 `0 fail / 1 existing fixme skip` 与当前已有测试状态一致，不构成新的兼容性错误。

## 23. Implementation Evidence

R7 implementation is carried forward as the existing six-file implementation.
R14 covers the full evidenced Prompt/coalescing/Fork/Summary/Compaction/TUI/v2
owner and behavior-test scope. Implementation for R14 is complete in the
working tree (R13 implementation plus the R14 rework: maintenance timeouts
restored, three command-level TUI rollover tests added, sync-fixture handler
type widened) and awaits the round-12 full-scope plan audit and a new
implementation audit.

### Actual Files and Diff

R14 实际变更（含沿用 R7：共 8 个生产文件 + 1 个配置 + 7 个测试文件）：

生产（8）：

- `packages/opencode/src/tool/truncate.ts`（R7）
- `packages/opencode/src/session/message-v2.ts`（R7 comparator + R13 rawForkRows tuple/Part membership）
- `packages/opencode/src/session/session.ts`（R13 fork source admission）
- `packages/opencode/src/session/prompt.ts`（R13 Goal 共享 comparator + coalescing parent tuple）
- `packages/opencode/src/session/summary-cache.ts`（R13 tuple cursor 扫描/Part 归属/greatest-closed/ahead 判定）
- `packages/opencode/src/storage/cold.ts`（R13 semantic eligibility tuple + summary invalidation tuple）
- `packages/opencode/src/session/projectors-next.ts`（R13 compaction time+id 排序）
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`（R13 数组位置 revert/undo/redo/copy/queued）

配置（1）：`packages/app/package.json`（R7 root Vite CLI）。

测试（7）：truncation、message-v2（R7）；compaction、cold、prompt、TUI session-message-render（R13 新增回绕回归）；TUI sync-fixture（R14：FetchHandler 类型放宽以支持异步请求拦截钩子）。`db-maintenance.test.ts` 已于 R14 恢复原状（拆出本计划）。

No `packages/web` file and no App/Web rollover consumer source or test file was
changed. Unrelated worktree files remain outside this implementation.

### Red-Green Test Evidence

- Truncate baseline `20 pass / 1 fail`; provisional edit `21 pass / 0 fail`.
- compareChronology baseline received `1` instead of `<0`; provisional focused
  test `1 pass / 0 fail`.
- existing TUI rollover tests `3 pass / 0 fail`.
- R13 coalescing：改入 caller-supplied `msg_z-middle`/`msg_a-latest` 后 red（`middleUsage.status === "running"`），修复后 green。
- R13 Goal 同毫秒 U+E000/U+10000：locale 探针证明顺序相反；测试改入后经修复 green。
- R13 ColdStorage eligibility：red（head owner `false`），tuple 修复后 green，含删除 present tail 后 fail-closed 断言。
- R13 Fork：red（前缀丢失），tuple admission 修复后 green。
- R13 SummaryCache：red（第二轮 diff 顺序错误），tuple 扫描修复后 green。
- R13 v2 compaction：desc(id) 旧行为会把 delta/ended 合入旧纪元行；修复后两行各自完整（green）。
- R13 TUI：三条新回归（crossed revert、窗口外 fail-closed、QUEUED 徽标）在修复后实现上 green。
- R13 返工（审计 1 轮 blocker）：snapshot tuple 封界 + 缺失报错、fork missing-boundary、
  空 sentinel、悬挂 cursor、covered-history 回绕失效，共 5 条新公开回归 green。
- R14 命令级回归：`session.undo`/`session.redo`/`messages.copy` 通过真实注册命令 +
  请求/剪贴板捕获验证 crossed-ID 选择；三条在旧 raw-ID 比较下分别退化为
  no-op / unrevert / no-copy，均为 rollover-sensitive。

### Verification Commands and Results

- focused OpenCode two-file run: `79 pass / 0 fail`;
- Truncate full file: `22 pass / 0 fail`; mocked stat-failure slice: `1 pass / 0 fail`;
- TUI rollover tests: `3 pass / 0 fail`;
- OpenCode typecheck: pass;
- exact daemon case: `1 pass / 0 fail`, 44 filtered;
- App unit: `336 pass / 0 fail`; App typecheck: pass;
- App official build baseline: fail at missing package-local Vite target;
  repaired official build: pass;
- App Playwright: `0 fail / 1 existing fixme skip` through repaired dev script;
- Web build: pass;
- deterministic stat-failure behavior test: green;
- exact maintenance cases after approved timeout change: `2 pass / 0 fail` in 72.97s;
- full maintenance test file: `15 pass / 0 fail` in 241.60s;
- full `test:ci`: not green; clean 60-minute run timed out after unrelated
  `session.llm`/`session.prompt` failures. The isolated SSE case passed; three
  prompt cases also fail in isolation and are outside the changed call paths.
- Earlier full `test:ci` exposed two maintenance case-level 30s budget failures;
  their timeout-only 90s probe passed and the approved two literals are now changed.

R13 final verification（packages/opencode 除非注明）：

- `bun typecheck`：pass。
- focused：coalescing+Goal+v2 3/3；eligibility+tail+fork 6/6；TUI 三回归 3/3。
- 全文件：cold.test 42/0；compaction.test 72/0；message-v2+truncation 79/0；
  TUI render+sync 合跳 111 pass/1 既有波动（见 Remaining Unverified）。
- prompt.test.ts 全文件：95 pass / 14 skip / 1 fail；唯一失败
  `refreshes queued Permission, Tool definition and MCP in one continuation`
  为修改前已记录的同名既有失败，与本 diff 调用路径无关。
- App：typecheck + test:unit + build 全部 pass（R7 修复后的官方脚本）。
- Web：build pass（613 页 + Pagefind 完整）。
- App Playwright E2E：沿用 R7 `0 fail / 1 existing fixme skip` 证据；R13 未触碰任何 App 文件。
- 完整 `test:ci` 未整体重跑；上述分片等价覆盖本 diff 全部 owner。

R14 final verification（packages/opencode 除非注明）：

- `bun typecheck`：pass。
- 命令级回归：`session.undo command`/`session.redo command`/`messages.copy command` 3/3。
- sync-fixture 全部 8 个消费文件合跑：144 pass / 0 fail（另一次运行中 1 例
  既有 reasoning-resize 负载波动，重跑全绿；与本 diff 无关）。
- `db-maintenance.test.ts` 已恢复原状，不再属本 diff。

### Original Feedback-Loop Result

The user full run's Truncate failure is the same baseline defect now caught by
the deterministic focused fixture.

### Actual Secondary and Replacement Path Inventory

Actual paths remain single primary paths: filesystem mtime, persisted time
plus UTF-8/BINARY ID tie-break, existing TUI projection, and root Vite CLI.
R14 proposes no alternate production success path; its owners reuse the same
persisted tuple contract.

### Chinese Comment Calculation

| Metric | Actual | Evidence |
| --- | --- | --- |
| `E` | 约 830 | 生产+配置约 163、测试约 667（排除 import/空行/注释行/纯格式；含 R7、R13 返工与 R14 命令级回归） |
| `C` | 约 128 | R7 11 条 + R13 生产约 48 行、测试约 53 行 + R14 命令/hook/fixture 注释约 16 行 |
| `C/E` | 约 15.4% | 满足 15% 目标 |
| minimum | 125 | `ceil(830*0.15)`；实现审计需按最终 diff 复算 |

### Remaining Unverified Items

- full post-fix `bun run test:ci` 未整体重跑；prompt 全文件的唯一失败为修改前已存在的同名用例。
- TUI `session keeps latest streamed content reachable via session.last after scrolling away`
  为负载波动：TUI route 修改前的全量运行已同签名失败，单独运行通过。
- App Playwright 保留一个既有 `fixme` skip，零失败；R13/R14 沿用 R7 证据未重跑。
- R14 第 12 轮 plan audit 与第 1 轮 implementation audit 均已 `APPROVE`；计划状态 verified。

## 24. Implementation Audit Record

| Round | Revision | Full scope? | Blocking | Non-blocking | Result | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R13 | yes | B-01 targetWithAssistantChildren 仍用 raw-ID lte；B-02 fork missing-boundary 无测试；B-03 cursor sentinel/损坏/失效合同无测试 | 过时注释 2 处；性能面扩大（批准设计）；命令体直接测试缺失 | BLOCK | `ses_fd02a947affeeQymluzyAC4pQE` |
| 2 | R13 | yes | none | Error vs CorruptionError 类型不一致；完整 test:ci 未整跑（无关失败）；App E2E/Web build 沿用记录 | APPROVE | `ses_fd02a947affeeQymluzyAC4pQE` |
| post-approval implementation audit | R13 working tree | yes | B-01 undo/redo/copy 缺命令级回绕测试；B-02 App 脚本范围；B-03 maintenance timeout 范围 | 既有无关失败；App 范围在 plan 复议中获认可 | BLOCK | `ses_fcea9ec2dffenq7UYTZ3xDemuM` |
| 1 | R14 | yes | none | N-01 完整 test:ci 未端到端重跑（分片等价覆盖）；N-02 性能面（批准设计）；N-03 E/C 记录算术漂移（复算 E=809/C=136/16.8%）；N-04 stats locale tie 非时序边界；N-05 窗口外全隐藏为批准 fail-closed | APPROVE | `ses_fce4d07d5ffeWihaEyzDRimFeK` |

R14 返工已完成：maintenance timeout 恢复原状并拆出计划；补齐 undo/redo/copy
三条命令级回绕回归（rollover-sensitive）；canonical 文档清除 R7 过时 BLOCK
文案并记录用户 2026-08-24 两项最终决定。

R14 实现审计 exact verdict：`No blocking findings` / `APPROVE`（reference
`ses_fce4d07d5ffeWihaEyzDRimFeK`）。审计独立复跑 App unit/typecheck/build/
Playwright 与 Web build 全部通过；E=809、C=136（16.8%）满足门禁。

第 2 轮 exact verdict：`No blocking findings` / `APPROVE`（reference `ses_fd02a947affeeQymluzyAC4pQE`）。
B-01/B-02/B-03 返工均落在批准版既定范围内；全部 8 个生产 owner 共享同一
`(time_created, SQLite BINARY id)` 持久 chronology 合同，无备用成功路径。

Round 1 返工已完成：B-01 在 owner 处改为 tuple 封界（缺失即报错）并新增公开行为测试；
B-02/B-03 补齐 fork missing-boundary、空 sentinel、悬挂 cursor、covered-history 回绕失效四条
公开回归；两条过时注释已改写。待第 2 轮全范围实现审计。

历史 R7 轮（superseded：其 blocker 已由 R13 实现修复，verdict 仅作历史记录）：

| Round | Revision | Full scope? | Blocking | Non-blocking | Result | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01 `deriveGoalTurn` 未采用修复后的持久 chronology comparator | full-suite evidence not independently rerun; App/Web gates only recorded; E=58/C=11 passes | BLOCK | `ses_fdef4fde0ffe3bUPVINxtJSoZQ` |

Historical R7 open decision (resolved by R13/R14 implementation):
`deriveGoalTurn` now reuses `MessageV2.compareChronology`; Goal, coalescing,
Fork, SummaryCache, semantic ColdStorage eligibility, TUI route and v2 owners
are implemented with behavior regressions in the current working tree.

<details>
<summary>Superseded R1/R2 history (non-authoritative)</summary>

### Historical 1. Verbatim Requirement

> 是的,因此请你进行相应的ID回绕问题修复,适当按照上游内容,同时保持相应修改鲁棒稳定,不会引入新的问题。同时保持相对较小的机制调整面,以及保持相对兼容性的调整面,也就是不改ID编码、系统性改消费者等内容。

### Historical 2. Explicit Non-Goals

- 不修改 `packages/opencode/src/id/id.ts`、`packages/core/src/util/identifier.ts` 或 `packages/app/src/utils/id.ts` 的 6-byte 时间编码、ID 长度、前缀、随机尾部或 counter 规则。已经持久化的回绕前后 ID 无法由编码迁移补救，用户也明确要求不改 ID 编码。
- 不新增数据库 schema、migration、索引、配置、feature flag、generated SDK 字段或兼容协议。
- 不修改 Message/Session HTTP schema、SSE event shape、Share WebSocket shape、Revert API shape 或 Tool output path shape。
- 不修改 Part、Permission、Question、Project 或 Workspace 数组的 ID 排序。Part 没有统一的 `time.created` 排序合同；其现有数组与 `Binary.search` 仍使用同一个 ID key。
- 不把 App 的 Session store 改成时间排序。该 store 仍由多个 `Binary.search(..., session.id)` 消费；本任务只把“选择哪些 Session 保留”和“如何展示”改为持久时间，然后继续按 ID 存放。
- 不再次修改已经完成回绕修复的 TUI Message 投影、服务端 `MessageV2.page` 查询/分页、`MessageV2.latest` 或 Prompt completion。服务端只把共享 `MessageV2.compareChronology` 的同时间 ID tie-break 对齐到持久 SQLite BINARY；Revert 控制流、文件范围算法和 API 保持不变。
- 不扩展 cold-storage cursor、Session search cursor、后台 Job ID、ProjectID 路径字符串或其他未进入反馈信号的 ID consumer。
- 不创建当前 fork 中不存在的上游新架构文件，例如 `packages/app/src/context/server-session.ts` 或 `packages/app/src/pages/home/home-sessions-controller.tsx`；把上游语义适配到当前 owner，不机械移植文件结构。
- 不加入回绕检测、双排序模式、旧 ID fallback、失败后线性重试、缓存索引或第二套成功路径。
- 不修改工作区现有的其他 plan、models snapshot、thirdparty 内容或未跟踪 Session 文件。

### Historical 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session/Message 是当前域术语；`packages/opencode` 是生产 owner，App/Web 是 consumer；Message 使用当前 MessageV2 形状。 |
| `docs/adr/README.md` | 本任务修复既有排序责任，不形成新的长期架构决策，不创建 ADR。 |
| `AGENTS.md` | 修改保持最小；测试和 typecheck 从 package 目录运行；不得干扰用户工作树。 |
| `packages/opencode/AGENTS.md` | `truncate.ts` 使用既有 Effect/AppFileSystem owner，不新增 service、barrel 或迁移。 |
| `packages/opencode/test/AGENTS.md` | mtime 行为使用 live filesystem test；不以固定 sleep 模拟文件年龄。 |
| `packages/app/AGENTS.md` | 保持 Solid store 现有模型；不得重启 App/Server；UI 测试使用现有环境，不改运行架构。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、零 fallback、正反向映射、TDD、独立审计与 15% 中文解释性注释。 |
| `.opencode/templates/canonical-plan.md` | 本文件必须完整记录 evidence、owner、route、tests、verification、diff、risk 和 audit record。 |
| 上游 1.18.15 修复组 | `d468201952`、`20750c332e`、`28bcc0e4f4`、`9113255114`、`5aa5cb3523` 分别修复 truncate、Web Share、App Session、App Message、App Revert consumer；当前 fork 结构较旧，采用其行为合同而非文件级 cherry-pick。 |

### Historical 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/id/id.ts:51-77` | `timestamp * 0x1000 + counter` 仅写入 6 bytes；ascending 时间区域每 `2^36 ms` 回绕。 | observed |
| `packages/core/src/util/identifier.ts:28-46` | Core 有同型 ID producer；本任务保持不变。 | observed |
| `packages/app/src/utils/id.ts:25-58` | Browser 侧有同型 ID producer；乐观 Message 会生成回绕后 lexical-low ID。 | observed |
| `packages/opencode/src/tool/truncate.ts:50-61` | cleanup 从文件名 ID 解码时间并比较 cutoff，是文件误删的 first divergence。 | observed |
| `packages/opencode/test/tool/truncation.test.ts:282-302` | 当前测试使用真实 wall-clock ID，已在 2026-08 回绕后稳定失败。 | observed |
| `packages/opencode/src/session/message-v2.ts:1416-1512` | Message page 按 `(time_created DESC, id DESC)` 查询后 reverse，公开给 App 的数组是持久 chronology 升序。 | contracted |
| `packages/opencode/src/session/message-v2.ts:788-795` | 服务端以持久 `time.created` 为主排序，但当前 ID tie-break 使用 locale collation，与 SQL BINARY 不一致。 | observed |
| `packages/opencode/src/session/schema.ts:10-17` | MessageID 只要求 `msg` 前缀，caller-supplied ID 可到达；App lower-bound 的同时间 tie-break 必须与持久顺序一致。 | reachable |
| `packages/opencode/src/session/revert.ts:99-103,171-196` | 服务端 Revert 已把 boundary ID 解析成 Message，再按 chronology 解释范围。 | observed |
| `packages/opencode/src/session/session.ts:1190-1229` | Session list 按 `time_updated DESC, id DESC` 返回，App 不应在 limit 前改用 ID 选择。 | contracted |
| `packages/app/src/context/sync.tsx:39-43,92-167` | HTTP/optimistic Message merge、insert、remove 均假设 Message 数组全局按 ID 升序。 | observed |
| `packages/app/src/context/sync.tsx:295-353` | Message page 被重新按 ID 排序；history prepend 也按 ID merge，覆盖服务端 chronology。 | observed |
| `packages/app/src/context/sync.tsx:411-433` | 乐观 Message 携带 `Date.now()` 创建时间，consumer 可直接维护 chronology。 | observed |
| `packages/app/src/components/prompt-input/submit.ts:106-139` | 正常 prompt producer 生成 ascending MessageID 并携带创建时间，然后进入 optimistic add/remove。 | reachable |
| `packages/app/src/context/global-sync/event-reducer.ts:186-238` | SSE normal/hidden update 和 ID-only remove 均对 chronology 数组执行 ID 二分。 | observed |
| `packages/app/src/pages/layout.tsx:747-821` | Session 预取用同一 `mergeByID` 处理 Message 与 Part；Message 需要 chronology，Part 仍需 ID。 | observed |
| `packages/app/src/context/global-sync/session-trim.ts:33-55` | root base 在按 ID 排序后 `slice(0, limit)`，会在回绕后裁掉更近的 Session；最终 ID 排序本身是 store 合同。 | observed |
| `packages/app/src/context/global-sync/session-trim.ts:5-14` | 已有 `sessionUpdatedAt` 与 `compareSessionRecent` 完整表达持久 Session recency，是应复用的现有 owner。 | observed |
| `packages/app/src/pages/layout/helpers.ts:10-33` | 一分钟内的 recent Session 以 ID 排序，回绕后侧栏和 latest 选择错序。 | observed |
| `packages/app/src/context/global-sync.tsx:249-280` | Session list 最终经过 `trimSessions`；输入预排序不应决定 keep-set。 | reachable |
| `packages/app/src/context/sync.tsx:591-603` | `session.fetch` 在 `slice(0, store.limit)` 前按 ID 排序，可能从服务端最近 100 条中选错 keep-set。 | observed |
| `packages/app/src/pages/session.tsx:465-480,1642-1702` | visible、restore-next、rolled 范围用 ID 大小解释 Revert boundary。 | observed |
| `packages/app/src/pages/session/use-session-commands.tsx:78-88,287-329` | visible、undo、redo、viewport previous/next 用 ID 大小解释用户 Message 顺序。 | observed |
| `packages/app/src/components/session/session-context-tab.tsx:101-125` | Context tab 的 visible Message 范围同样依赖 `id < revert`。 | observed |
| `packages/app/src/pages/session/message-timeline.tsx:280-287` | pending parent lookup 先对 chronology 数组做无效 ID binary search，再线性 fallback。 | observed |
| `packages/app/src/pages/session/session-model-helpers.ts:1-16` | 已有 Session 页面纯 helper seam，可承载复用的 Revert boundary partition。 | observed |
| `packages/web/src/components/Share.tsx:60-79,118-137,253-295` | Share 按 ID 展示 WebSocket Message；每条 V2/V1-normalized Message 都有持久创建时间。 | observed |
| `packages/core/src/util/binary.ts:1-41` | `Binary.search` 只接受单个 string key，不能直接表达 numeric time + persisted ID collation。 | contracted |
| `docs/plans/tui-message-id-rollover-ordering-repair.md` | 已验证 TUI 的同类 first divergence 及 SQLite BINARY lower-bound 要求；不授权复制其状态索引到 App。 | observed |
| `git show d468201952` | 上游把 truncate retention owner 改为文件 mtime，并以跨边界 ID + `utimes` 测试。 | observed |
| `git show 20750c332e` | 上游 Share 使用 `time.created` 为主序。 | observed |
| `git show 28bcc0e4f4` | 上游 App Session display 使用持久更新时间，不再使用 recent-ID bucket。 | observed |
| `git show 9113255114` | 上游 App Message insert 使用 chronology key，ID-only remove 使用 exact identity scan。 | observed |
| `git show 5aa5cb3523` | 上游 App Revert consumers 使用数组位置而非 ID 大小。 | observed |
| `bun -e` chronology tie probe | 同时间 `msg_\uE000` 与 `msg_𐀀`：当前 locale comparator 返回 `1`，UTF-8/BINARY 返回 `-1`。 | observed |

### Historical 5. Current Behavior

### 5.1 Truncation cleanup

```text
Truncate.write
  -> filename = ToolID.ascending()
  -> filesystem stores authoritative mtime
  -> Truncate.cleanup decodes wrapped filename timestamp
  -> recent post-wrap file appears older than cutoff
  -> cleanup removes a file only three days old
```

### 5.2 App Message lifecycle

```text
MessageV2.page / optimistic submit / message.updated
  -> complete Message contains persisted time.created
  -> App stores chronology array
  -> sync/reducer/prefetch applies ID-only sort or Binary.search
  -> lexical-low post-wrap Message moves to array head or is missed
  -> timeline, confirmation, update, hidden removal, explicit removal diverge
```

`message.removed` only carries `{ sessionID, messageID }`; it cannot reconstruct a chronology key. Exact identity scan is therefore the owning behavior, not a fallback. Part arrays remain ID-sorted and keep `Binary.search`.

For equal persisted timestamps, SQLite orders IDs by BINARY bytes while current
`MessageV2.compareChronology` uses locale collation. App cannot establish one
authoritative chronology if server-side Revert interprets the same boundary by
a different tie-break.

### 5.3 App Session selection and display

```text
Session.list (updated DESC)
  -> App sorts candidates by Session ID
  -> slice/base keep-set is chosen from lexical order
  -> post-wrap recent Session can be trimmed or omitted
  -> sidebar/latest selection repeats ID-as-time assumption
```

The final Session store remains ID-sorted because event/bootstrap/archive consumers binary-search it by ID. Only recency selection and display order change.

### 5.4 App Revert boundary

```text
server persists revert.messageID
  -> App already holds userMessages in chronology order
  -> UI compares every ID with <, > or >=
  -> wrapped IDs are interpreted as earlier than pre-wrap boundary
  -> visible, rolled, undo, redo and restore ranges select wrong Messages
```

The boundary ID is identity, not a sortable cursor. Its index in the authoritative chronology array defines before/current/after.

### 5.5 Web Share

```text
Share WebSocket message event
  -> record keyed by Message ID contains time.created
  -> createMemo sorts Object.values by ID
  -> post-wrap Message renders before older pre-wrap Message
```

### Historical 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Ascending ID on either side of one `2^36 ms` boundary | opencode/core/App ID producer | Unique prefixed string; no global lexical-time guarantee after wrap | Tool filename, Session, Message consumers | Each consumer that interprets time | observed |
| Truncation file with recent mtime but lexical-low wrapped filename | `Truncate.write`; filesystem | File mtime records actual write/update age | startup cleanup | `Truncate.cleanup` | observed |
| Directory entry disappears or cannot be statted during cleanup | Filesystem race/permission | `readDirectory` does not guarantee later stat succeeds | cleanup scan -> stat | `Truncate.cleanup` | reachable |
| HTTP Message page crossing wrap | `MessageV2.page` | Chronology ASC by persisted time and ID tie-break | `fetchMessages` -> merge/store | App Sync | observed |
| Optimistic post-wrap Message | prompt submit / addOptimisticMessage | Full Message with `time.created` | optimistic add/page confirmation/remove | App Sync | reachable |
| SSE normal Message update | Message event producer | Full Message with stable persisted creation time | event reducer | App global sync reducer | reachable |
| SSE hidden Message update | Message event producer | Full hidden Message with identity and creation time | hidden reducer branch | App global sync reducer | reachable |
| SSE explicit Message removal | Message event producer | Only Session ID and Message ID | remove reducer branch | App global sync reducer | contracted |
| Same-time caller-supplied Message IDs | public MessageID schema | Prefix only; persisted SQL order is BINARY | page -> App lower-bound/merge | App message-order helper | reachable |
| Session list crossing wrap | `Session.list` | Recent-first by persisted update time | trim/fetch/sidebar/latest | App Session consumers | observed |
| Session child, permission-pinned child or recent child | App store + events | Existing keep rules remain valid | `trimSessions` | App trim owner | contracted |
| Valid Revert boundary present in loaded userMessages | server Session info | Boundary identifies a user Message | Session page/commands/context | App Revert consumers | reachable |
| Revert boundary missing from the loaded array | pagination/event timing | App may temporarily lack target | visible/rolled/command calculation | App Revert consumers | reachable |
| Share Message received out of arrival order or across wrap | Share poll/WebSocket | Content contains Message ID and creation time | Share memo -> render | Web Share | reachable |
| ID without time metadata | No accepted Message/Session producer in current schemas | Message and Session schemas contain persisted time | none | none | speculative |

Speculative rows cannot justify production logic or blocking findings.

### Historical 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| REQ-01 | 修复 ID 回绕导致的消费者错误，同时保持 ID 编码和持久格式不变。 | 用户原始要求 | 无系统级覆盖 |
| REQ-02 | 修改面保持在现有 owner，不新增 schema、配置、fallback 或平行状态机。 | 用户原始要求；policy | diff/audit gate |
| INV-T01 | Truncation retention 由文件 mtime 与 7-day cutoff 决定，不由文件名 ID 解码决定。 | 文件系统 owner；上游 #40987 | 当前 cleanup test 反向失败 |
| INV-T02 | stat 缺失/失败的 entry 本轮保留；cleanup 不把不确定状态当成过期成功删除。 | reachable filesystem race；既有 best-effort cleanup | 无 |
| INV-M01 | App 每个 Session 的 Message 数组按 `(time.created ASC, persisted ID tie-break ASC)` 排列。 | `MessageV2.page` producer | 现有测试只覆盖 ID 与时间同向 |
| INV-M02 | 带完整 Message 的 insert/update/confirmation 使用同一 chronology lower-bound；同 ID update 不产生重复。 | optimistic + SSE contracts | 部分非回绕测试 |
| INV-M03 | ID-only remove/rollback 删除精确 ID，与数组排序 key 无关；不存在 ID 保持 no-op。 | remove event/optimistic contract | 部分非回绕测试 |
| INV-M04 | HTTP replace、history prepend 和 layout prefetch 都保留 chronology；Part merge 继续按 Part ID。 | 三个现实写入 owner | 无跨回绕覆盖 |
| INV-M05 | 服务端 chronology、App projection 与持久 snapshot 对同时间 Message 使用同一 UTF-8 byte order，不依赖 locale；App lower-bound 保持 `O(log n)`。 | public MessageID + SQL BINARY + tie probe | TUI 有先例，App/服务端共享 comparator 无覆盖 |
| INV-S01 | Session keep-set 和展示顺序以 `time.updated ?? time.created` 为主，ID 只作同时间稳定 tie-break。 | Session list contract；上游 #41000 | 部分时间排序测试 |
| INV-S02 | Session store 的最终数组仍按 ID 排列，现有 ID binary lookup 不受影响。 | bootstrap/event/archive consumers | 既有 App tests |
| INV-S03 | root base limit 选择最新 Session；child、permission、recent-window keep 规则保持不变。 | 当前 trim contract | 现有 trim tests |
| INV-R01 | Revert boundary 先按 ID 在 chronology userMessages 中定位，再以数组 index 定义 before/current/after。 | server Revert precedent；上游 #41006 | 无回绕覆盖 |
| INV-R02 | visible 排除 boundary，rolled 包含 boundary；restore/redo 取 boundary 的下一个 Message，undo 取 boundary 前一个 Message。 | 当前 UI行为；上游修复 | 无 |
| INV-R03 | 缺失 boundary 时 visible 保持当前已加载 Messages；rolled 为空；mutation command 不猜测邻居。 | reachable partial load；上游 behavior | 无 |
| INV-W01 | Share 按 `time.created` 展示 Message，ID 只作同时间稳定 tie-break。 | WebSocket Message shape；上游 #40995 | 无 |
| INV-C01 | 所有修改都使用一条时间主序语义；不得加入 wrap detector、旧路径 fallback 或失败重试。 | policy；用户兼容要求 | audit/diff inspection |

### Historical 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-T01 | `Truncate.cleanup` 对 filename 调用 `Identifier.timestamp`，把 36-bit wrapped value 当 wall-clock time。 | Tool truncation retention owner | `truncation.test.ts` 在当前日期稳定误删 recent file。 |
| INV-M01 / INV-M02 | `fetchMessages`、optimistic helpers、event reducer 把 chronology Message 数组交给 ID-only sort/`Binary.search`。 | App Sync + global reducer | 四个临时 probe 共 5 个 Message assertions 稳定失败。 |
| INV-M05 | `MessageV2.compareChronology` 使用 `localeCompare`，而 persisted page 和 TUI lower-bound 使用 SQLite BINARY/UTF-8 byte order。 | 服务端 chronology owner | 同时间 caller ID probe 得到 locale `1`、UTF-8 `-1`；Revert 直接消费该 comparator。 |
| INV-M03 | remove event 只有 ID，却对非 ID-sorted数组做二分。 | App Sync + global reducer | optimistic remove 和 reducer remove 临时测试均漏删 post-wrap Message。 |
| INV-M04 | `layout.tsx` 用一个 `mergeByID` 同时处理 Message 与 Part。 | App layout prefetch owner | Message producer有 time，Part producer没有统一 Message chronology；同一 comparator 不能同时满足两者。 |
| INV-S01 / INV-S03 | trim/fetch 在 limit 选择前按 Session ID 排序；layout recent bucket 也以 ID 代表时间。 | App Session trim/fetch/display owners | trim 与 helpers 临时 probe 稳定保留旧 Session、丢弃或后置新 Session。 |
| INV-R01 / INV-R02 | 页面和命令直接比较 boundary ID 大小，而数组本身已是 chronology。 | App Session Revert consumers | 所有 `<`, `>`, `>=` 分支在 post-wrap ID 上反转；上游 #41006 对同一消费者改用 index。 |
| INV-W01 | Share memo 只调用 `id.localeCompare`。 | Web Share projection | 源码路径与上游 #40995 相同；Message shape已携带 time。 |

Red-capable feedback loops already run against the current repository:

```powershell
# packages/opencode
bun test --timeout 30000 ./test/tool/truncation.test.ts
# observed: 20 pass, 1 fail

# packages/app
bun test "D:/Temp/opencode/id-wrap-trim-red.test.ts"
# observed: 0 pass, 1 fail

bun test "D:/Temp/opencode/id-wrap-optimistic-red.test.ts"
# observed: 0 pass, 3 fail

bun test "D:/Temp/opencode/id-wrap-reducer-red.test.ts"
# observed: 0 pass, 2 fail

bun test "D:/Temp/opencode/id-wrap-helpers-red.test.ts"
# observed: 0 pass, 1 fail

# packages/opencode
bun -e "import { MessageV2 } from './src/session/message-v2.ts'; const left={id:'msg_\uE000',time:{created:1}}; const right={id:'msg_\u{10000}',time:{created:1}}; console.log(JSON.stringify({locale:MessageV2.compareChronology(left as never,right as never),utf8:Buffer.compare(Buffer.from(left.id),Buffer.from(right.id))}))"
# observed: {"locale":1,"utf8":-1}
```

The minimized fixtures use three independently worked literals: two pre-wrap
IDs whose lexical order agrees with time, and one post-wrap ID whose lexical
order resets low while `time.created` remains greatest. The probes assert the
observable kept IDs/order/removal result, not an internal helper call. The
temporary Revert prototype was not accepted as a red signal because it tested
its own proposed helper rather than the current production path; the approved
TDD slice below must establish that regression in the repository seam before
implementation.

### Historical 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Truncation file age | `Truncate.cleanup` + filesystem metadata | Delete files older than retention | cleanup already owns scan/remove and mtime is authoritative | ID producer only names files and must remain unchanged |
| Persisted Message chronology tie-break | `MessageV2.compareChronology` | Time first, SQLite BINARY-compatible ID tie-break for service consumers | Revert/latest/prompt already consume this owner | App cannot change server interpretation; SQL page cannot use locale |
| App Message comparator/lower-bound/merge | App `utils/message-order.ts` mirroring persisted chronology | One browser-safe chronology contract reused by all App Message writers | Multiple App writers currently duplicate the same false assumption | Core `Binary.search` is generic string-key infrastructure and should not absorb Message semantics |
| Optimistic/page Message mutation | App Sync | Keep optimistic and fetched Message projection coherent | It owns HTTP page and optimistic store updates | Reducer only owns SSE events |
| SSE Message mutation | App global reducer | Apply normal/hidden/remove events to the same projection | It is the event seam and has full Message or ID-only payload as appropriate | Sync should not intercept or replay events |
| Prefetched Message merge | App layout prefetch | Merge HTTP snapshot into cached Message projection | This owner currently performs the merge | Part merge remains local and ID-based |
| Session recency comparison | Existing `context/global-sync/session-trim.ts` helpers | Derive recency from persisted Session time | `sessionUpdatedAt` and `compareSessionRecent` already own this exact contract | A new utility would duplicate the existing owner |
| Session keep-set | `trimSessions` / Sync fetch | Choose latest roots while retaining current child/recent rules | These modules own bounded caching | Layout display cannot restore a Session already trimmed |
| Revert boundary partition | `session-model-helpers.ts` | Interpret an identity boundary within ordered userMessages | Reused by Page, commands and Context tab | Server owns persisted Revert; App owns local projection/navigation |
| Share display order | Web `Share.tsx` | Render shared Messages chronologically | It owns the WebSocket projection and render memo | App utilities are not a Web package dependency |

### Historical 10. Single Approved Primary-Path Design

```text
authoritative persisted time / filesystem mtime
  -> owner-specific chronology/age comparator
  -> existing bounded projection or retention operation
  -> exact identity handling where payload contains only ID
  -> unchanged public schemas and ID encoding
```

### 10.1 Truncation

`cleanup` computes a numeric wall-clock cutoff once. For each `tool_` entry it
stats the full path, extracts mtime, skips entries whose metadata is unavailable
or recent, and removes only entries whose mtime is older than the cutoff. The
`Identifier` import and all filename timestamp decoding leave this path.

### 10.2 Persisted and App Message chronology

First, change only the ID tie-break inside
`MessageV2.compareChronology`: retain numeric `time.created` as the primary key
and replace locale collation with UTF-8 byte comparison matching SQLite BINARY.
All current service consumers, including Revert, then share one persisted
chronology interpretation without changing their control flow.

Add `packages/app/src/utils/message-order.ts` as the single App Message ordering
owner:

- `compareMessages(a, b)` compares numeric `time.created`, then compares ID by
  UTF-8 byte order so a browser lower-bound matches persisted SQLite BINARY
  order even for reachable caller-supplied IDs.
- `searchMessage(messages, target)` performs one chronology lower-bound and
  reports `found` only when the ID at that position equals the target ID.
- `mergeMessages(current, incoming)` reconciles by exact ID and sorts once with
  `compareMessages`.

The App helper mirrors the persisted comparator because browser code cannot
import the opencode server module. One cross-contract fixture with the same
timestamp and Unicode IDs locks both sides to the same byte order; these are
separate runtime adapters for one contract, not alternate success paths.

No cache, Map index state or fallback is retained between calls. The helper is
used by HTTP page sorting/prepend, optimistic add/confirmation, SSE update and
layout prefetch. Hidden updates carry full Message and use the same lower-bound.
ID-only optimistic/SSE removal uses `findIndex(message.id === target)` because
the payload cannot supply a chronology key. Missing targets remain no-op.

`layout.tsx` keeps its existing `mergeByID` only for Parts. Message snapshots
switch to `mergeMessages`; this removes the false shared comparator without
changing Part behavior.

### 10.3 App Session recency

Keep the existing `sessionUpdatedAt` and `compareSessionRecent` exports in
`context/global-sync/session-trim.ts` as the single Session recency owner. Do
not add a parallel utility or duplicate comparator. Sync fetch and layout
helpers import this existing comparator.

`trimSessions` sorts root candidates by recency before `slice(0, limit)` and
recent-window selection, then preserves its existing final ID sort. Sync
`session.fetch` selects by recency before slicing, then restores ID order before
writing the store. Layout sidebar/latest helpers use the same comparator and
retain their current function signatures; the `now` parameter becomes unused
compatibility input rather than triggering a one-minute ID-order bucket.

### 10.4 App Revert boundaries

Extend the existing `session-model-helpers.ts` with one reusable partition of
ordered `UserMessage[]` by exact boundary ID. The result exposes `before`,
`current`, and `after` without comparing IDs.

- Page/Context/command visible ranges use `before` and exclude boundary.
- Page rolled range uses `[current, ...after]` and includes boundary.
- restore/redo uses `after[0]`.
- undo uses the last Message before current boundary, or the final Message when
  no Revert exists; viewport previous uses the same partition around the newly
  selected Message.
- Missing boundary returns no partition: visible keeps loaded Messages, rolled
  is empty, and mutation commands return without guessing.

`message-timeline.tsx` removes the invalid ID binary-search attempt and performs
one exact parent-ID lookup. This collapses the existing binary-plus-linear
workaround into the only semantically valid identity path.

### 10.5 Web Share

The existing memo sorts `Object.values(store.messages)` by numeric
`time.created`, then ID for equal-time stability. WebSocket parsing, V1
normalization, object storage and rendering remain unchanged.

This route repairs each first divergence at its consumer owner. It does not
detect wrap, reinterpret malformed IDs, retry a failed primary algorithm or
maintain alternate old/new ordering modes.

### Historical 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| mtime available and older/recent | proposed | primary-contract branches | yes | 12% | preserve as the only retention path |
| stat missing/fails during best-effort cleanup | proposed | supported-domain no-op branch | yes | 3% | preserve file; do not infer age |
| Message insert/update with full chronology tuple | proposed | primary-contract branch | yes | 30% | use shared lower-bound |
| Service chronology equal-time tie-break | proposed | primary-contract branch | yes | 2% | replace locale with persisted byte order |
| ID-only Message remove | proposed | primary-contract branch | yes | 12% | exact identity scan |
| Part merge/order | current | contracted pass-through | yes | 8% | preserve ID path unchanged |
| Session keep-set vs final store order | proposed | primary-contract branches | yes | 15% | time selection, ID storage |
| Revert boundary found/missing | proposed | primary-contract branches | yes/no-op | 17% | partition or defined no-op |
| Share chronology projection | proposed | primary-contract branch | yes | 3% | use time comparator |
| Wrap detection followed by legacy ordering | rejected | forbidden fallback | yes | 0% | do not add |
| Retry ID search with linear search after miss | current timeline workaround | forbidden duplicate after repair | yes | 0% | collapse to exact lookup |

New alternate success paths: `0`.

Diagnostic decision-surface ratio: `0%`; no new logging, warning, telemetry or
diagnostic state is proposed.

### Historical 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Decode Tool filename ID as wall-clock retention time | Pre-wrap IDs appeared monotonic | Filesystem mtime is the actual retention owner and survives wrap | `truncate.ts` cleanup |
| App Message ID sort and ID `Binary.search` | Generated IDs appeared chronological before boundary | Full Message carries persisted time; ID-only ordering is false after wrap | `sync.tsx`, `event-reducer.ts`, `layout.tsx` |
| One generic `mergeByID` for Message and Part | Both IDs appeared monotonic | Message and Part now have different proven ordering contracts | `layout.tsx` Message call sites |
| Session one-minute ID bucket | ID acted as a proxy for recent update time | Persisted Session time is directly available | `layout/helpers.ts` |
| Revert `<`, `>`, `>=` comparisons | Revert ID appeared to be a chronological cursor | Revert ID is identity; ordered array position is authoritative | Page, commands, Context tab |
| Timeline binary search followed by linear fallback | ID binary search could miss chronology array | Exact parent identity lookup is sufficient | `message-timeline.tsx` |
| Share ID-only sort | IDs appeared chronological | Message carries persisted creation time | `Share.tsx` |

### Historical 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01 / INV-T01 | cleanup -> stat -> cutoff -> remove | `truncate.ts` | `truncation.test.ts` wrapped filenames + controlled mtimes |
| INV-T02 | cleanup stat failure -> preserve | `truncate.ts` | cleanup test includes non-stattable/disappeared entry only if deterministic fixture can expose it; otherwise existing catch path + typecheck, no speculative platform hook |
| INV-M05 | persisted chronology -> service Revert/latest/prompt | `message-v2.ts` tie-break only | `message-v2.test.ts` same-time Unicode IDs independently assert UTF-8/BINARY order |
| INV-M01 / INV-M02 | optimistic/page Message -> shared comparator/search | `sync.tsx`, new `message-order.ts` | first red is existing `sync-optimistic.test.ts` consumer behavior; `message-order.test.ts` supplements wrap, byte tie and fractional-time contract |
| INV-M02 | optimistic/page confirmation | `sync.tsx` | `sync-optimistic.test.ts` wrap insert and confirmation |
| INV-M03 | optimistic remove | `sync.tsx` | `sync-optimistic.test.ts` exact post-wrap removal |
| INV-M02 / INV-M03 | normal/hidden/update/remove SSE | `event-reducer.ts` | `event-reducer.test.ts` wrap lifecycle with real Solid store |
| INV-M04 | HTTP sort/prepend and layout prefetch merge | `sync.tsx`, `layout.tsx` | `message-order.test.ts` merge behavior + optimistic/page tests; direct prefetch function has no exported seam and is verified through helper use plus full App suite |
| INV-S01 / INV-S03 | root keep-set | existing `session-trim.ts` recency owner | `session-trim.test.ts` pre/post-wrap old-vs-new fixture |
| INV-S01 / INV-S02 | session fetch selection then ID store | `sync.tsx` importing existing `compareSessionRecent` | comparator/selection expectations in `session-trim.test.ts` and `helpers.test.ts`; provider closure has no isolated public seam |
| INV-S01 | sidebar/latest order | `layout/helpers.ts` | `helpers.test.ts` wrapped IDs with persisted update times and equal-time tie |
| INV-R01 / INV-R02 / INV-R03 | Revert ID -> userMessages partition -> consumers | `session-model-helpers.ts`, `session.tsx`, `use-session-commands.tsx`, `session-context-tab.tsx` | `session-model-helpers.test.ts` before/current/after and missing boundary |
| INV-R01 | pending parent ID -> exact lookup | `message-timeline.tsx` | Existing timeline behavior already falls back to exact lookup; change removes invalid first attempt, full App test/typecheck verifies integration |
| INV-W01 | WebSocket Messages -> Share render memo | `Share.tsx` | new `Share.test.tsx` sends reversed-arrival wrapped Messages and asserts rendered text order |
| REQ-02 / INV-C01 | all paths | all changed files | diff inspection, typecheck, builds, independent implementation audit |

No confirmed requirement remains unmapped. Where a closure/component has no
existing isolated export, the plan tests the shared behavioral owner and runs
the package integration suite; it does not add a public API solely for tests.

### Historical 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| mtime-based retention | INV-T01 | failing cleanup test; upstream #40987 | wrapped filename timestamp has lost high wall-clock bits |
| persisted UTF-8/BINARY ID tie-break | INV-M05 | SQL page order, public MessageID and red tie probe | locale collation disagrees for reachable equal-time caller IDs |
| App Message chronology comparator | INV-M01 / INV-M05 | SQL page order, complete Message schema, TUI proven boundary | generic ID comparator has no numeric time or persisted collation |
| App Message lower-bound | INV-M02 | normal/optimistic update producers | `Binary.search` only accepts one string key and current ID key is false |
| exact ID-only removal | INV-M03 | event payload has no time | chronology search cannot be formed from ID-only payload |
| Message merge separate from Part merge | INV-M04 | `layout.tsx` shared call sites | one ID comparator cannot satisfy both proven domains |
| reuse existing Session recency comparator | INV-S01 | Session list SQL plus existing `sessionUpdatedAt`/`compareSessionRecent` | raw ID selection cannot carry recency; a new comparator would duplicate the current owner |
| recency selection followed by ID storage | INV-S01 / INV-S02 | trim/fetch consumers and binary lookup callers | time-only store would break existing lookups; ID-only selection loses recent Sessions |
| Revert boundary partition | INV-R01 / INV-R02 / INV-R03 | repeated Page/command/context comparisons | ID is identity, so each raw comparison fails at the same boundary |
| exact timeline parent lookup | INV-R01 | pending payload has parent ID only | binary search requires an ID-sorted array that no longer exists |
| Share time sort | INV-W01 | Message content has time; upstream #40995 | object key/ID order resets at wrap |

No proposed production concept depends on best practice, future-proofing or a
speculative malformed input.

### Historical 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/truncate.ts` | modify | Replace filename timestamp retention with best-effort stat/mtime retention; remove `Identifier` import. | +9 / -6 |
| `packages/opencode/test/tool/truncation.test.ts` | modify | Use IDs immediately around wrap and `utimes` to prove age is mtime-owned. | +12 / -5 |
| `packages/opencode/src/session/message-v2.ts` | modify | Align `compareChronology` equal-time ID tie-break with SQLite BINARY; no other service behavior changes. | +3 / -1 |
| `packages/opencode/test/session/message-v2.test.ts` | modify | Prove equal-time Unicode caller IDs use UTF-8/BINARY order rather than locale order. | +22 |
| `packages/app/src/utils/message-order.ts` | add | Browser-safe Message comparator, lower-bound and exact-ID merge. | +45 |
| `packages/app/src/utils/message-order.test.ts` | add | Independent wrap, equal-time byte-order, fractional-time and merge expectations. | +55 |
| `packages/app/src/context/sync.tsx` | modify | Use chronology for page/optimistic/prepend; exact ID removal; select Session fetch by persisted recency before ID store sort. | +24 / -22 |
| `packages/app/src/context/sync-optimistic.test.ts` | modify | Add wrapped optimistic insert, confirmation and removal regression cases. | +45 / -8 |
| `packages/app/src/context/global-sync/event-reducer.ts` | modify | Use chronology lower-bound for full updates/hidden updates and exact ID scan for ID-only remove. | +12 / -11 |
| `packages/app/src/context/global-sync/event-reducer.test.ts` | modify | Exercise real Solid store across wrapped normal, hidden and remove events. | +48 / -4 |
| `packages/app/src/pages/layout.tsx` | modify | Use Message merge helper for prefetch while preserving Part `mergeByID`. | +8 / -6 |
| `packages/app/src/context/global-sync/session-trim.ts` | modify | Reuse its existing recency comparator to select root base/recent and retain final ID store order. | +6 / -5 |
| `packages/app/src/context/global-sync/session-trim.test.ts` | modify | Add wrap fixture proving newest roots survive base limit and existing child rules remain. | +28 / -3 |
| `packages/app/src/pages/layout/helpers.ts` | modify | Replace one-minute ID bucket with shared persisted recency comparator while keeping signatures. | +5 / -14 |
| `packages/app/src/pages/layout/helpers.test.ts` | modify | Cover wrapped display/latest order and equal-time ID tie. | +30 |
| `packages/app/src/pages/session/session-model-helpers.ts` | modify | Add exact Revert boundary partition/visible helpers next to existing Session model helpers. | +28 |
| `packages/app/src/pages/session/session-model-helpers.test.ts` | modify | Prove before/current/after semantics across wrap and missing boundary behavior. | +45 |
| `packages/app/src/pages/session.tsx` | modify | Consume partition for visible, restore-next and rolled ranges. | +17 / -8 |
| `packages/app/src/pages/session/use-session-commands.tsx` | modify | Consume partition for visible, undo, redo and viewport neighbor selection; remove `findLast` use if unused. | +25 / -12 |
| `packages/app/src/components/session/session-context-tab.tsx` | modify | Reuse visible-before-boundary helper. | +3 / -2 |
| `packages/app/src/pages/session/message-timeline.tsx` | modify | Collapse invalid binary-plus-fallback parent lookup to exact identity lookup. | +1 / -3 |
| `packages/web/src/components/Share.tsx` | modify | Sort rendered Messages by persisted creation time plus stable ID tie. | +4 / -1 |
| `packages/web/src/components/Share.test.tsx` | add | Drive Share WebSocket under existing happy-dom preload and assert chronological DOM text. | +65 |

No file is deleted. No generated artifact, package manifest, schema, migration or
configuration is changed.

### Historical 16. TDD Behavior Slices

Agreed test seams are the existing public service/helper/reducer exports and the
rendered Share component. Implementation proceeds one vertical slice at a time.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Recent post-wrap truncation file is deleted while old pre-wrap file remains eligible | filename timestamp wrapped | stat mtime before remove | 7-day retention across all ID epochs |
| 2 | service comparator orders equal-time Unicode IDs differently from persisted BINARY | `localeCompare` disagrees with UTF-8 bytes | change only `MessageV2.compareChronology` tie-break | App/server Revert contract cannot diverge |
| 3 | existing optimistic add/page confirmation/remove consumer tests place or retain post-wrap Message incorrectly | Sync uses ID binary search | after observing those existing exports red, add chronology helper and switch Sync | prompt submission and HTTP echo; helper-only module absence is not the red signal |
| 4 | SSE normal/hidden/remove misses wrapped target | reducer uses ID binary search | chronology lower-bound for full Message; exact scan for ID-only event | live projection lifecycle |
| 5 | shared Message comparator/search/merge preserves wrap, byte tie and fractional time | pure contract test supplements already-red Sync/reducer consumers | complete helper behavior without changing the seam | every later Message writer uses the same tested contract |
| 6 | prefetched/history page reorders wrapped Messages while Parts remain valid | generic ID merge is shared | Message merge helper at Message calls only | recovery/prefetch without Part regression |
| 7 | trim/fetch keeps older pre-wrap root instead of newer post-wrap root | ID sort occurs before limit selection | reuse existing recency owner before unchanged ID store sort | bounded Session cache without duplicate comparator |
| 8 | sidebar/latest places recent post-wrap Session behind pre-wrap Session | recent bucket sorts by ID | import existing recency comparator | Session navigation/display |
| 9 | visible/rolled/restore ranges reverse around wrapped Revert ID | raw ID comparisons treat identity as cursor | partition ordered userMessages by exact ID | Page, Context tab and mutation commands |
| 10 | Share renders lexical-low post-wrap Message before older content | memo sorts only by ID | sort by creation time then ID | public shared Session display |

Each test uses literal expected order/identity derived from explicit timestamps,
not the production comparator. The temporary probes are converted into the
listed repository tests, then removed from `D:\Temp\opencode` during cleanup.

### Historical 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 405 | Added/substantively modified production and tests; excludes imports, blank lines, formatter-only changes and plan text |
| Required Chinese explanatory comments `C` | at least 61 | `ceil(405 * 0.15) = 61`; actual implementation recalculates from final diff |

Planned qualifying comment topics, distributed next to the decisions they
explain:

- 文件 mtime 是 retention 权威；ID 只命名文件，回绕后不能恢复 wall-clock age。
- stat 缺失时为何必须保留而不能猜测过期。
- Message chronology 使用持久时间，ID 只处理同时间冲突。
- App lower-bound 为何复刻 SQLite BINARY 的 UTF-8 byte order，而不能使用 locale/UTF-16。
- 服务端 `compareChronology` 与 App projection 必须解释同一个 persisted tie-break，Revert 不能例外。
- ID-only remove 为何必须按 identity 扫描，不是性能 fallback。
- HTTP、optimistic、SSE、prefetch 必须共用一个 Message order owner。
- Part 继续按 ID 的原因以及为何不能被 Message 修复带走。
- Session keep-set 按时间、store 按 ID 的双责任边界。
- recent-window/child/permission 保持既有合同的测试意图。
- Revert ID 是 identity boundary，不是 sortable cursor。
- visible/rolled 对 boundary 的包含差异与 missing-boundary no-op 语义。
- Share 测试为何用反向到达顺序和跨回绕文字标记。
- 每个 wrap fixture 的 pre/post 时间与 ID 关系，以及断言对应的用户可观察行为。

Comments that merely translate identifiers, repeat assignments or restate test
names do not count. If final `E` increases, implementation must increase `C` to
the actual 15% minimum before audit.

### Historical 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 ./test/tool/truncation.test.ts ./test/session/message-v2.test.ts` | `packages/opencode` | mtime retention plus persisted chronology tie-break red-green |
| `bun typecheck` | `packages/opencode` | Effect/AppFileSystem stat typing and unchanged package contracts |
| `bun test src/utils/message-order.test.ts src/context/sync-optimistic.test.ts src/context/global-sync/event-reducer.test.ts src/context/global-sync/session-trim.test.ts src/pages/layout/helpers.test.ts src/pages/session/session-model-helpers.test.ts` | `packages/app` | all focused Message, Session and Revert slices |
| `bun run test:unit` | `packages/app` | complete App regression suite under existing happy-dom preload |
| `bun run typecheck` | `packages/app` | browser/Solid/SDK types and all changed consumers |
| `bun test --preload ../app/happydom.ts ./src/components/Share.test.tsx` | `packages/web` | rendered Share chronology under WebSocket events |
| `bun run build` | `packages/web` | Astro/Solid production integration and bundle build |
| `bun test "D:/Temp/opencode/id-wrap-trim-red.test.ts"` plus optimistic/reducer/helpers probes | `packages/app` | original minimized feedback loops become green before temporary cleanup |
| `git diff --check -- docs/plans/id-rollover-consumer-repair.md packages/opencode/src/tool/truncate.ts packages/opencode/test/tool/truncation.test.ts packages/opencode/src/session/message-v2.ts packages/opencode/test/session/message-v2.test.ts packages/app/src/utils/message-order.ts packages/app/src/utils/message-order.test.ts packages/app/src/context/sync.tsx packages/app/src/context/sync-optimistic.test.ts packages/app/src/context/global-sync/event-reducer.ts packages/app/src/context/global-sync/event-reducer.test.ts packages/app/src/pages/layout.tsx packages/app/src/context/global-sync/session-trim.ts packages/app/src/context/global-sync/session-trim.test.ts packages/app/src/pages/layout/helpers.ts packages/app/src/pages/layout/helpers.test.ts packages/app/src/pages/session/session-model-helpers.ts packages/app/src/pages/session/session-model-helpers.test.ts packages/app/src/pages/session.tsx packages/app/src/pages/session/use-session-commands.tsx packages/app/src/components/session/session-context-tab.tsx packages/app/src/pages/session/message-timeline.tsx packages/web/src/components/Share.tsx packages/web/src/components/Share.test.tsx` | repository root | GOAL patch whitespace and integrity without judging unrelated dirty files |
| `git status --short` | repository root | identify all dirty paths before scoped audit/commit and prove unrelated paths remain untouched |

If the planned Web component test cannot execute because the existing package
runtime cannot mount Share under the App preload, implementation stops as plan
drift and returns to a new revision; it must not replace the test with a
source-text assertion or export production code solely for testing.

### Historical 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 3 implementation files (4 including this canonical plan) | `message-order.ts`, `message-order.test.ts` and `Share.test.tsx`; the plan already exists before implementation |
| Files modified | 20 | Existing owner and test files listed above, including service chronology owner/test |
| Files deleted | 0 | No production or compatibility path requires file deletion |
| Production lines | about 150 effective lines | One App Message helper, existing Session owner reuse and focused call-site replacement; no new state/cache/schema |
| Test lines | about 255 effective lines | Cross-wrap lifecycle, persisted tie-break, Revert and rendered Share behavior |
| Generated lines | 0 | No SDK or schema change |

The budget is an audit signal, not permission to omit a confirmed consumer. If
current repository drift adds or removes an affected owner before
implementation, the plan must be revised and re-audited rather than silently
changing scope.

### Historical 20. Real Risks and Open Decisions

### Real Risks

- App Message lower-bound must use exactly the same comparator as every writer.
  Leaving one ID-sorted HTTP/optimistic/SSE/prefetch path would corrupt the
  shared array and make later binary searches unsound.
- UTF-8 byte comparison allocates short encodings during sort/search. Message
  IDs are short and insertion paths are already bounded by array splice; no
  persistent cache is justified without a measured performance regression.
- Session recency selection and Session store ordering are different
  responsibilities. Accidentally returning a time-sorted store would regress
  existing ID binary lookups.
- Revert missing-boundary semantics differ by consumer. A generic “return all”
  fallback would make rolled/mutation behavior unsafe; the partition result
  must remain explicit.
- Share test setup touches browser lifecycle, WebSocket and observers. The test
  must assert rendered behavior and clean up mounted state without changing
  production exports.
- The worktree contains unrelated modified/untracked files. Implementation and
  commit must scope exact GOAL paths and stop if a GOAL file receives unrelated
  concurrent edits.

### Open Decisions Requiring the User

None. The user already selected consumer-side repair with unchanged ID encoding
and requested an upstream-aligned, small compatibility surface.

### Rejected Speculation

- Changing ID bytes, adding an epoch bit or migrating persisted IDs: explicitly
  rejected by the user and does not repair existing references.
- Genericizing `packages/core/src/util/binary.ts`: no other domain requires a
  tuple comparator, and changing a shared primitive widens blast radius.
- Adding an ID-to-index Map to App: no measured performance need; it creates
  another state invariant across HTTP, optimistic and SSE writers.
- Detecting the current wrap epoch and rotating arrays: persisted/caller IDs do
  not guarantee one rotation and the model becomes a fallback algorithm.
- Modifying Part order: no `time.created` Message chronology contract and no
  failing signal.
- Modifying `session.tsx:707` Project insertion, bootstrap Project sort or
  ProjectID schema: those IDs are identity/path-derived values, not this time
  encoding consumer.
- Modifying service-side Message pagination/latest/Revert control flow beyond
  the proven equal-time tie-break: current code already uses persisted time for
  the rollover behavior under this requirement.
- Fixing unrelated EOL/edit/apply-patch behavior: no execution path from those
  tools to this ID ordering defect.
- Porting upstream files absent from this fork: behavior maps to current Sync,
  global reducer, layout and Session page owners instead.

### Historical 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from current repository evidence and not trust the
  builder summary or temporary probe descriptions.
- Audit the complete original scope on every round, including truncate,
  persisted service chronology, App Message/Session/Revert and Web Share
  consumers.
- Require observed, contracted or reachable evidence for every blocking
  finding and reject speculative expansion.
- Verify that ID encoding, schemas, Part order, TUI and unrelated worktree paths
  remain outside implementation.
- Check that one chronology/identity primary path replaces every affected ID-as-
  time assumption without fallback or duplicate success behavior.
- Check forward/reverse traceability, behaviorally sensitive TDD seams,
  package-local verification, code quality and the 15% Chinese explanatory-
  comment plan.

### Historical 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01; B-02; B-03 | E/C final calculation; INV-T02 fixture evidence; Web harness feasibility | BLOCK | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |
| 2 | R2 | yes | No blocking findings. | E/C actual calculation; INV-T02 deterministic coverage; Web harness feasibility; unused `now` compatibility input | APPROVE | `ses_fdfed22f6ffeP8bmD83fGaNZqV` |

### Round 1 Independent Verdict

Finding IDs, classifications and release verdict copied without
reclassification:

- `Blocking finding B-01`: `App 与服务端 Revert 的同时间 ID tie-break 不一致`
- `Blocking finding B-02`: `Message chronology 的关键 TDD slice 没有对当前缺陷形成行为级红灯`
- `Blocking finding B-03`: `计划新增的 Session recency owner 与现有 owner 重复，违反 reverse traceability`
- `Non-blocking finding`: `计划的 E=390、C>=59 仅是实现承诺，计划审计无法验证最终实际 diff；实现审计仍需按实际 diff 重新计算。`
- `Non-blocking finding`: `INV-T02 的 stat 失败分支给出了“无法构造确定 fixture 时不增加测试 hook”的理由，当前可接受，但实现阶段必须证明现有 catch 路径确实保留 entry 而不是静默删除。`
- `Non-blocking finding`: `计划中的 Web Share 测试 harness 风险已被记录为实现前置条件，若无法通过真实组件 seam 执行，应按计划提升 revision，而不能改成 source-text assertion。`
- Release verdict: `BLOCK`

### R2 Resolution Mapping

| Finding | R2 correction |
| --- | --- |
| B-01 | Scope now includes the owning `MessageV2.compareChronology` equal-time tie-break and a service regression test; App mirrors the same UTF-8/BINARY contract while Revert control flow remains unchanged. |
| B-02 | TDD now starts with existing `sync-optimistic.test.ts` and reducer consumer behavior going red; the new helper test is explicitly supplementary. |
| B-03 | The planned `session-order.ts` was removed; existing `sessionUpdatedAt`/`compareSessionRecent` remain the only Session recency owner and are reused by fetch/layout. |

### Round 2 Independent Verdict

- `Blocking findings`: `No blocking findings.`
- `Non-blocking finding`: `计划的 E=405、C>=61 仅是实现阶段承诺。最终 implementation audit 仍需根据实际 diff 重新计算 E、合格中文解释性注释 C、排除项和比例。`
- `Non-blocking finding`: `INV-T02 的 stat 失败分支仍没有确定性行为测试；计划已明确只有在 live filesystem fixture 可稳定复现时才增加该测试，否则依靠现有 catch 路径和 typecheck。实现阶段需要确认该路径确实保留不确定 entry。`
- `Non-blocking finding`: `Web Share 测试 harness 仍是实现前置条件。若无法通过真实组件和 WebSocket seam 执行，必须递增 plan revision，不得改成 source-text assertion 或为测试扩大生产导出。`
- `Non-blocking finding`: `layout/helpers.ts 保留 now 参数作为兼容输入，即使新的 recency comparator 不再使用 ID-based recent bucket；实现时应保持无额外分支和无新的排序语义。`
- Release verdict: `APPROVE`
- Approval scope: `This approval applies only to the exact audited canonical plan revision R2.`

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

### Historical 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

Not implemented.

### Red-Green Test Evidence

Not implemented.

### Verification Commands and Results

Not implemented.

### Original Feedback-Loop Result

Current red results are recorded in section 8. Green reruns are pending an
approved implementation.

### Actual Secondary and Replacement Path Inventory

Not implemented.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | pending |  |
| Qualifying Chinese comment lines `C` | pending |  |
| Ratio `C / E` | pending | `N/A` when `E = 0` |
| Required minimum `C` | pending | `if E = 0: C = 0`; `if E > 0: C >= max(1, ceil(E * 0.15))` |

### Remaining Unverified Items

- Web Share component-test harness feasibility is verified during its first TDD
  red slice; inability to run that seam requires a plan revision.
- The prior repository run had one failure in the opencode truncation suite,
  while the focused App baseline was green; the cleanup slice must turn that
  owner failure green before broader verification.

### Historical 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes |  |  |  |  |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the actual implementation of the exact approved plan
revision.

</details>

# Canonical Implementation Plan: TUI/Daemon Disconnect Session Exit ID Repair

> Status: verified
>
> Revision: R10
>
> Approved revision: R10
>
> Audit mode: implementation (full-scope)
>
> Requirement source: Verbatim Session GOAL requirement retained in this file, plus the explicit six-round extension for R9+
>
> Implementation allowed: completed R10; no further material changes without revision
>
> Last updated: 2026-08-11

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## Current Revision R10

R10 supersedes R1-R9 in full and is the only current authority in this file.
The user rejected the R7/R8 Provider-protocol and five-state client projection
direction because it modified several downstream mechanisms without first
proving that the original Session-list producer remained wrong. Independent
reconstruction now proves one shared first divergence for all reported
symptoms.

### Proven Root Cause

```text
9209c04370 introduces path-scoped Session lists
  -> directoryMatchesPath assumes one Project ID has one persisted worktree

1c4298bfc6 removes per-clone cached identity and gives same-history clones the
same root-commit Project ID
  -> A and B now correctly share Project ID
  -> ProjectTable still stores only one worktree A
  -> a list request from current Instance B re-reads A from ProjectTable
  -> relative(A, B) does not match B's request path
  -> existing directory compatibility is incorrectly disabled
  -> an ancestor/historical Session that is directly retrievable is omitted

ordinary refresh or existing Provider global.disposed -> full bootstrap
  -> TUI applies that incorrect list snapshot
  -> active Session metadata disappears
  -> Session list is incomplete, TUI becomes blank/gray, exit prints
     opencode -s undefined
```

`ddc5e00c60` is only a deterministic trigger: it reuses the existing full
bootstrap after Provider auth. Direct `-s` startup and ordinary list refresh
reproduce without Provider changes, so changing Provider events, Dialogs,
Session-route errors, or client projection state is not a root repair.

### Single Minimal Repair

- Modify only `packages/opencode/src/session/session.ts`.
- Pass `InstanceState.context.worktree` through the existing private list and
  searchScan inputs into their shared `listUniverseConditions` predicate.
- Make `directoryMatchesPath` compare the request directory/path against that
  current Instance worktree instead of re-reading `ProjectTable.worktree` by
  the shared Project ID.
- Do not change SQL schema, migration, Project ID, Session ID, list scope,
  Provider notification, full bootstrap, TUI store replacement, route error
  handling, renderer, daemon, SSE, SDK, or formatter.

This does not turn sibling Sessions into browse matches. It restores only the
already-contracted ancestor/descendant and historical-directory compatibility
for the current request Instance. Existing Session-list behavior remains the
authority; once the producer includes the valid target, the unchanged full
bootstrap no longer deletes it from the TUI projection.

### Required Invariants and Traceability

| ID | Invariant | Owner | Behavioral evidence |
| --- | --- | --- | --- |
| INV-R10-01 | Path compatibility uses the current request Instance worktree, not one persisted worktree selected by shared Project ID. | Session service | Shared-ID A/B fixture fails with `[]` under the old lookup and passes under current context. |
| INV-R10-02 | `list` and progressive `searchScan` use the same current-worktree universe. | `listUniverseConditions` | The same fixture asserts target visibility through both public service methods; `searchScan` has its own observed red. |
| INV-R10-03 | Correct list output keeps the unchanged ordinary/Provider full bootstrap from deleting the active related Session. | Session producer feeding existing SyncProvider | Compiled A/B clone scenario executes real auth/global event/full bootstrap and remains rendered. |
| INV-R10-04 | Sibling scope, Project identity, historical rows, schema, and no-migration behavior remain unchanged. | Existing list predicates and persisted contracts | Complete 23-test Session-list matrix and legacy fixture remain green. |

Forward traceability:

| User-visible requirement | First owner/path | File | Test or runtime proof |
| --- | --- | --- | --- |
| Historical/related Sessions appear in Switch Session | `Session.list -> listUniverseConditions -> directoryMatchesPath` | `session.ts` | Public `list` assertion in shared-ID fixture. |
| Search input finds the same Session | `Session.searchScan -> listUniverseConditions -> directoryMatchesPath` | `session.ts` | Public `searchScan` assertion in the same fixture. |
| Provider refresh no longer blanks the TUI or loses exit identity | Correct producer list enters unchanged full bootstrap | No TUI production change | Compiled cross-clone/auth/full-bootstrap scenario. |

Reverse traceability:

| Production concept | Required by | Why existing value cannot be reused |
| --- | --- | --- |
| Carry `InstanceState.context.worktree` through private list/search inputs | INV-R10-01/02 and same-ID live evidence | `ProjectTable.worktree` stores one row and cannot identify which active request Instance produced directory/path. |
| Remove ProjectTable lookup from `directoryMatchesPath` | Same first divergence | Keeping it would discard the exact request context before comparison and reproduce both red assertions. |

### Candidate Diff and TDD

| File | Change |
| --- | --- |
| `packages/opencode/src/session/session.ts` | One production file, raw +16/-8; remove the persisted Project lookup and carry current `worktree` through existing private list/search inputs. |
| `packages/opencode/test/server/session-list.test.ts` | One test file, final raw +103; create A/B request worktrees sharing one Project ID while ProjectTable retains A, then require both B's public `list` and `searchScan` seams to include the ancestor historical Session. |

The new service test was observed red before the production change:

```text
Expected to contain: <target Session ID>
Received: []
```

The user granted six additional audit rounds and required a fresh red
reproduction. R9 re-ran the exact public-Service seam on 2026-08-11 by
temporarily restoring the persisted `ProjectTable.worktree` lookup. It failed
in 3.4 seconds with `Expected to contain: ses_...; Received: []`. Restoring the
two current-Instance-worktree lines made the identical command pass `1/1`.

After the one-file repair:

```text
bun test test/server/session-list.test.ts --test-name-pattern "current Instance worktree|legacy Session"
2 pass, 0 fail

bun test --timeout 30000 test/server/session-list.test.ts
23 pass, 0 fail, 121 assertions

bun typecheck
exit 0
```

Final minimal-diff gate: `E=85`, `C=13`, required
`ceil(85 * 0.15)=13`; all counted comments explain request/persisted-worktree
ownership or the multi-Instance test boundary.

### End-to-End Big-Problem Verification

A final Windows artifact containing only this Session producer repair was built
as `0.0.0-dev-smark-202608111539`, executable SHA-256
`c1cedd4985bfb128444d2d4be3e6e302448bc60c007731985e1659b908e55436`.
An isolated compiled scenario used the unchanged production TUI refresh flow:

1. Create Git repository A and same-root-commit clone B.
2. Start the daemon/TUI in A and create an A Session.
3. Start `-s <A Session>` from B against the same daemon.
4. Call real `auth.set`, which emits the existing empty-properties
   `global.disposed` and makes B execute the unchanged full bootstrap.
5. Verify the Session/Goal remains rendered, resize/restore remains rendered,
   two model requests complete, 14 target events reach the TUI, and Ctrl+C exits
   normally.

Observed success:

```json
{"crossPath":true,"sessionProject":"...\\project-clone","sessionID":"ses_00e813167ffetHkPaMF50yi3e9","sourceCount":2,"renderedCount":2,"modelRequests":2,"targetEventCount":14}
```

The temporary smoke-harness extension was fully reverted. `git diff --exit-code`
confirms `sync.tsx`, Session route, Provider Dialog, their tests, and the smoke
script all match HEAD. The final candidate scope is one production file and one
regression-test file.

### Audit Status

R8 full-scope audit `ses_00eaa4fe9ffeMU6p1FxgH9T86b` correctly blocked the
discarded Provider-only design because empty `global.disposed` also represents
full Instance disposal, and identified the corrected feedback command's
`/messages` typo. The typo was corrected to the SDK's `/message` path and rerun
green, but that Provider feedback loop is no longer part of R9's production
design.

R3-R8 consumed the original six full plan-audit rounds. On the next
user-initiated continuation, the user explicitly granted six additional rounds
and required the root cause plus red reproduction to be rechecked. R9 used
round 1 and was blocked because its test covered `list` but not the reachable
progressive `searchScan` seam. R10 adds that public assertion in the same
fixture; restoring the old persisted-worktree lookup produced `Received: []`
at the `scanIDs` assertion, and restoring the current-worktree repair made the
identical test pass. R10 uses round 2 of the additional allowance and remains
approved in additional round 2 by independent full-scope audit
`ses_00e75f90bffeZ8VlRK5nkNbBGZ`.

#### R10 Plan Audit Verdict (Copied)

- Full scope: yes.
- Blocking findings: **No blocking findings.**
- Non-blocking findings:
  - **NB-01:** 历史区标题仍写着“not implementation authority for R9”，应更新为 R10。
  - **NB-02:** R10 记录测试文件 raw `+85`，审计员报告候选 diff 为 `+91`；本地 `git diff --numstat` 在裁决后重新返回 `+85 / -0`，该计数分歧不影响硬门槛。
  - **NB-03:** `Requirement source` 使用可变描述；现已替换为稳定的GOAL与轮次扩展来源。
- Release verdict: **APPROVE — exact canonical plan revision R10.**
- Invocation reference: `ses_00e75f90bffeZ8VlRK5nkNbBGZ`.

### R10 Implementation Evidence

#### Actual Diff

| File | Raw diff | Necessity |
| --- | --- | --- |
| `packages/opencode/src/session/session.ts` | +16 / -8 | Removes the first divergent persisted-worktree reconstruction and carries current request worktree through the already-shared list/search universe. |
| `packages/opencode/test/server/session-list.test.ts` | +103 / -0 | Locks both public `list` and progressive `searchScan` seams under the exact shared-ID/different-worktree condition; persisted/runtime mismatch setup and cleanup live in one narrowly named fixture helper. |

No other production, test, smoke, Provider, SyncProvider, route, daemon, SDK,
schema, migration, configuration, generated, or dependency file belongs to the
R10 implementation. `git diff --exit-code` confirms all discarded downstream
files match HEAD.

#### Red-Green Results

| Slice | Red | Green |
| --- | --- | --- |
| Public `Session.list` | Temporarily restoring `ProjectTable.worktree` lookup produced `Expected to contain: ses_...; Received: []`. | Restoring current request worktree made the identical test pass. |
| Public `Session.searchScan` | With the old lookup restored and `scanIDs` asserted first, the test failed in 2.97s with `Expected to contain: ses_...; Received: []`. | Restoring the same two production lines made `list` and `searchScan` pass together: 1 test, 3 assertions. |

Both red runs altered only the first divergence and were immediately restored;
the final diff contains only the approved green implementation.

#### Final Verification

| Command or scenario | Result |
| --- | --- |
| `bun test test/server/session-list.test.ts --test-name-pattern "uses the current Instance worktree"` | 1 pass, 0 fail, 3 assertions. |
| `bun test --timeout 30000 test/server/session-list.test.ts` | 23 pass, 0 fail, 121 assertions. The command-level timeout only gives existing Windows InstanceStore cleanup headroom. |
| `bun typecheck` from `packages/opencode` | Exit 0. |
| `git diff --check` for R10 files and Plan | Exit 0. |
| Minimal Windows artifact build | `0.0.0-dev-smark-202608111539`, executable SHA-256 `c1cedd4985bfb128444d2d4be3e6e302448bc60c007731985e1659b908e55436`; version, voice Worker, and OpenTUI DLL smokes passed. |
| Final unchanged `target-liveness` artifact smoke | Passed with `sessionID=ses_00e679a41ffe15QEEYXvNjBT7A`, 2 model requests, 14 target events, and matching source/rendered glyph counts. |
| Isolated compiled A/B clone plus real auth/global event/full bootstrap | Passed with the unchanged TUI consumer path, 2 model requests, 14 target events, continuing rendering, and normal Ctrl+C. Temporary smoke extension was reverted. |

The user's running daemon was deliberately not stopped and still contains the
old loaded binary; it cannot be current-code evidence. The isolated rebuilt
daemon/TUI scenario exercises the same cross-clone and Provider-triggered path.

#### Path and Fallback Inventory

- Primary path only: `InstanceState.context.worktree -> list/search private
  input -> listUniverseConditions -> directoryMatchesPath`.
- Existing ancestor/descendant, historical null-path, home, sibling, Project ID,
  and full-bootstrap behavior remains unchanged.
- No alternate query, second data source, retry, state machine, event reason,
  schema compatibility branch, catch-and-success, formatter fallback, or
  downstream compensation exists.

#### Chinese Comment Gate

```text
E = 85
C = 13
required C = ceil(85 * 0.15) = 13
C / E = 15.29%
```

Excluded lines: imports, blank/comment-only lines, pure delimiter formatting,
generated files, and pure moves. Qualifying comments explain shared-ID request
ownership, persisted-row limitations, fixture cleanup/isolation, shared
list/search behavior, and why `batch=50` excludes keyset pagination as the red
cause.

### R10 Implementation Audit Record

| Round | Full scope | Blocking findings | Non-blocking findings | Verdict | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | yes | B-01 inline persisted/runtime mismatch bypassed required fixture helper | NB-01 audit-mode metadata | BLOCK | `ses_00e66470cffejfsNpV30mFHKj3` |
| 2 | yes | None | NB-01 stale early evidence counts | APPROVE — exact R10 implementation diff | `ses_00e66470cffejfsNpV30mFHKj3` |

Round 1 B-01 resolution: direct Project/Session database setup and reverse
cleanup moved into the narrowly named
`persistSessionWithMismatchedProjectWorktree` fixture helper. Public list and
searchScan assertions, production behavior, files, and approved primary path
remain unchanged. Focused test, full 23-test matrix, typecheck, diff check, and
Chinese-comment gate were rerun.

#### R10 Implementation Audit Round 2 Verdict (Copied)

- Full scope: yes.
- Blocking findings: **No blocking findings.**
- Non-blocking findings:
  - **NB-01:** `Candidate Diff and TDD` retained stale `23 pass / 120 assertions` and `E=72, C=11` records; these administrative values are now corrected to 121 assertions and `E=85, C=13`.
- Chinese explanatory-comment gate: **PASS** (`E=85`, `C=13`, 15.29%).
- Release verdict: **APPROVE — exact R10 implementation diff.**
- Invocation reference: `ses_00e66470cffejfsNpV30mFHKj3`.

## Superseded R1-R9 Historical Record

Everything below this heading is retained only as audit history. It is not
implementation authority for R10.

R8 supersedes R1, the unaudited R2 draft, blocked R3/R4/R5/R6, and R7 in full. R1 repaired only the
downstream Continue-command identity. R2 located the TUI projection deletion
but treated the live ancestor Session as an expected browse omission. Public
Project/path evidence proves an earlier producer defect: two worktrees sharing
one root-commit Project ID have distinct request Instance worktrees, while the
Session path compatibility predicate consults the single persisted
`ProjectTable.worktree`. R8 retains the earlier production direction and closes
R6 plan-audit B-01 by limiting stale projection continuity to pending validation
and confirmed `ConnectionError`. Versioned direct-sync validation records
pending, valid, connection-error, not-found, or failed; NotFound and other
failures keep their existing route error semantics. The
complete R1 text is retained at the
end only as a commented historical record; it is not implementation authority.

R8 retains R7's production ownership and four-file repair unchanged. It closes
two implementation-time verification facts without adding behavior: a delivered
delete/404 terminal state must reject a late browse row even after the route has
navigated home, and the old red-capable source loop cannot use disappearance as
its completion signal after disappearance is fixed. The corrected loop waits
for the Provider projection to change from old to new, then requires both the
ordinary-list and Provider-event Session-loss flags to remain false.

## 1. Verbatim Requirement

> 准确完整识别当前daemon在F:\ML\PythonAIProject\Claude-Code\opencode\thirdparty\opencode-11720路径下启动后，任何pwd在F:\ML\PythonAIProject\Claude-Code\opencode的启动的TUI都会在打开会话后按下任意操作之后变成空屏且不进行任何渲染，同时ctrlc之后会显示 opencode -s undefined这种复用命令（然而事实上该session是存在且有sessionID的，怀疑是相应的TUI和daemon的通信有问题导致TUI失去数据源）；与此同时，在opencode下打开的TUI也无法在命令面板的switch session里面找到该路径之前的会话；而若在opencode文件夹下启动相应的daemon会话，则opencode路径下上述的空屏、不显示既往session列表等等问题不再发生，但是其thirdparty\opencode-11720、.temp\API等路径下启动的的TUI或者opencode -s 复用的该路径历史会话则复现如上问题；请准确识别如上问题的根因，理论上该问题是最近20次commits才出现的情况，理论上我们的仓库没进行任何重建，请准确识别检查相应的问题并进行修复，修复方式需要找到根本或者因代码逻辑触碰引发的历史问题；同时如果审计员给你了blocker，请你首先分析是否是用户原始要求范围内的bug，如果与现在问题大概无关，请进行rebuttal，禁止直接进行对blocker的方案修改；从根源上问题，避免进行额外的数据库schema添加以及迁移，禁止以“遇到问题报错”为解决目标，解决方式应该是解决实质性错误的生产路径，而非修改错误的消费路径，即后续不再会产生该种错误，且整体修改保持克制，即仅精准修改现有的会产生该种错误schema的代码路径，同时在不破坏现有功能和性能的前提下，修复该问题。整体修改文件数不超过四个生产文件，不超过200行代码

> 当前存在问题,我目前发现我的TUI在进行相应,我的整体OpenCode已经进行了完整的二进制编译以及重新更新,当前是最新版的代码库内容。但与此同时,我目前仍然发现其TUI在进行不同位置启动的TUI,它可以进行正常的消息更新。但目前而言,当我进行connect provider的时候,当我输入相应的API key并且触发了模型列表的选择的时候,它整体的背景全部都失去了渲染,也就是全部变成了空白。与此同时选下模型之后,按回车,它整个背景都不再进行任何渲染,也就是全部变成空白。也就是发生了TUI和daemon的一种消息断连,或者TUI不再进行渲染的一个问题,请检查到底有什么情况

> 请注意,如果是TUI启动的DAEMON,那个连接DAEMON的那个,就是主的那个TUI,它是不会进行相应的空屏的,也就是正常情况下,理论来说我之前的所有路径都是不会触发相应的空屏。但是最近这一段时间,它就会在我启动一个新的TUI的时候,它就会在进行相应的provider更新的时候触发相应的空屏。所以这很奇怪,理论来说我是不应该进行空屏的。而且现在来说,也有一部分情况是不会触发相应的空屏。同时我不希望当前的修复内容或者说更新检查得非常复杂。我希望检查的是真正是那个根因的内容,同时修改保持最小最小的修改。

> 我不希望大批量改相应的schema以及相应的机制,我只希望你检查到底什么原因,最近的修改什么导致了它发生如此的情况,因为之前来说我的即便是工作在不同的目录,它理论来说也是不会有任何问题的,但就是最近的情况,导致了它会发生相应的问题,所以理论来说问题出现在最近几次。因此你需要进行检查,同时我们不能让其整体的修改非常复杂。 与此同时目前而言还是存在相应的在目录启动daemon时，其他路径下的session TUI会发生灰屏

> 同时需要启动新的goalplan文件

The user selected `仅刷新Provider数据` for the Provider credential refresh
contract and approved both behavioral seams: the real `SyncProvider` active
Session projection and the real Session route through `ExitProvider` stdout.

## 2. Explicit Non-Goals

- Do not add or change a database schema, migration, Project/Session key, or
  persisted value.
- Do not change Project ID derivation or the ancestor/descendant browse-list
  contract. Repair the existing compatibility predicate to use its actual
  request Instance worktree rather than a different persisted worktree.
- Do not make a sibling Session appear in another directory's browse snapshot.
  A route-owned active Session is not reclassified as a browse match.
- Do not add a second Session query, alternate Session lookup, retry, synthetic
  Session ID, last-Session selection, or error-shaped success.
- Do not change daemon ownership, SSE reconnect, heartbeat, worker shutdown,
  Session run state, OpenTUI rendering, or plugin loading.
- Do not modify `formatSessionExitMessage` or teach it to conceal a missing
  Session. R8 prevents the valid active Session from becoming missing.
- Do not add a new provider event schema or regenerate the SDK. The existing
  non-`DaemonStop` `global.disposed` event remains the notification seam.
- Do not preserve every Session omitted by a browse snapshot. Only the current
  route-owned Session already loaded by ID remains in the active projection.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md:9-23,63-83,101-110,127-181` | Defines Session, Provider, Project, Session path, InstanceState, and the v1 production boundary. |
| `AGENTS.md:21-141` | Requires minimal changes, package-local tests/typecheck, and no speculative abstraction. |
| `packages/opencode/AGENTS.md:19-135` | Constrains module shape and InstanceState ownership; no new service is required. |
| `packages/opencode/test/AGENTS.md:161-204` | Concurrent tests must use published readiness rather than fixed sleeps. |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | Session list/get handlers remain at their existing HttpApi boundary. |
| `packages/opencode/test/server/AGENTS.md` | Existing Session list behavior is verified at the Effect/HTTP owner; no server test change is planned. |
| `docs/adr/README.md` and ADR-0001 | No accepted ADR governs TUI Session projection; this local repair does not warrant a new ADR. |
| `.opencode/policy/first-principles-engineering.md` | Requires repair at the first divergence, no fallback, full traceability, and the Chinese-comment gate. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:62-180,447-464,609-637,932-1136` | One store currently carries browse and route-owned Session metadata; three list paths replace it wholesale; Provider and reconnect events call bootstrap. | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:212-245,338-401,479-494` | Explicit route fetches by ID, applies non-connection failure navigation on initial load, force-syncs on reconnect without the same handler, renders through `sync.session.get`, and derives exit identity from that metadata. | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/app.tsx:280-344,438-535,1089-1096` | `-s` navigates to a Session route while bootstrap runs; missing route metadata changes title/render consumers. | reachable |
| `packages/opencode/src/session/session.ts:56-139,152-215,630-693,997-1177` | `session.get` is ID-global; path-scoped list/search share `directoryMatchesPath`, which currently re-reads one persisted Project worktree instead of using the request Instance worktree. | observed/contracted |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:56-116` | Public list and get endpoints intentionally have different selection contracts. | contracted |
| `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx:235-405` | API, code, and auto auth success all call full `sync.bootstrap()` before opening models. | observed/reachable |
| `packages/opencode/src/server/global-lifecycle.ts:38-50` and control/provider handlers | Auth changes invalidate Provider caches and broadcast non-stop `global.disposed` without disposing Sessions. | observed/reachable |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` and `sync.test.tsx` | Real `SyncProvider` with public route, SDK transport, and event seam supports a deterministic regression. | observed |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | Real Session route and ExitProvider stdout seam already exists. | observed |
| `packages/opencode/test/server/session-list.test.ts:546-641` | Historical Project ID plus matching directory is already visible without migration. | observed |
| Live daemon `127.0.0.1:4096` query for `ses_01be48e73ffeQJJlE10m5u4q6J` | Direct get returned 200; Session directory was the repository root and therefore an ancestor of the thirdparty launch path; thirdparty browse list incorrectly omitted it while root browse list contained it. | observed |
| Live `/project/current`, `/path`, and `/project` comparison for root and thirdparty | Both Instances resolve Project ID `4b0...` but expose distinct request worktrees; the single stored Project row exposes only the root worktree. | observed |
| `Get-NetTCPConnection -OwningProcess 26356` | Affected `-s` TUI retained multiple Established connections to daemon port 4096. | observed |
| `2026-08-11T120834.log` and `2026-08-11T120505.log` | Exact `-s` launches show no bootstrap, renderer, panic, or connection failure; duplicate test-plugin ID is adjacent but not causal. | observed |
| `git blame` and `git show` for `9209c04370`, `ddc5e00c60`, `1c4298bfc6` | Path filtering exposed the latent projection conflict; Provider refresh made it deterministic; the latest repair did not change list replacement. | observed |

## 5. Current Behavior

```text
TUI starts in nested clone/worktree B whose root commit matches A
  -> Project identity is shared by contract
  -> request Instance path reports worktree B and session-list path ""
  -> Session.directoryMatchesPath re-reads ProjectTable.worktree A
  -> relative(A, B) does not equal request path ""
  -> directory fallback is incorrectly disabled
  -> ancestor Session A is omitted from list(B)

TUI opens Session A explicitly
  -> SyncProvider starts path-scoped session.list(B)
  -> `-s A` Session route performs session.get(A) and session.sync(A)
  -> direct sync inserts A into the shared Session store
  -> list(B) resolves without A (correct browse result)
  -> setStore("session", reconcile(listB)) removes A (incorrect active projection)
  -> route remains `{ type: "session", sessionID: A }`
  -> Session metadata consumers become undefined
  -> gray/blank Session background and `opencode -s undefined`
```

Provider auth adds a deterministic second producer of the same transition:

```text
auth set/callback
  -> refreshProviderCaches
  -> non-stop global.disposed
  -> every TUI calls full bootstrap
  -> path-scoped list replacement removes any cross-path active Session
```

The main TUI is normally unaffected because its request worktree matches the
single persisted Project worktree and its browse list contains the active
Session. The second clone/worktree loses an ancestor that should be in-domain;
an unrelated sibling path may legitimately omit the Session but an explicit
`-s` route must still remain usable. Outcome also varies with the initial
direct-sync/list-response ordering. The daemon start directory is correlated
with which TUI is the main TUI; each TUI still sends its own directory.

The live target has a historical `projectID` different from the current root
commit, and the owning root list already finds it through directory
compatibility. The defect is not that compatibility is absent; it is that the
second request Instance incorrectly disables it by consulting another
worktree. No migration or Project identity change is required.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Two clone/worktree Instances with the same root-commit Project ID but different worktrees | Current Project identity contract and InstanceStore | Each request has its own resolved `InstanceState.context.worktree`; one Project row cannot represent both simultaneously | Session list/search path compatibility | Session service | observed |
| Explicit valid `-s <SessionID>` whose Session directory is outside the launch-directory browse domain | CLI args and RouteProvider | ID passes the Session schema; public get returns the persisted Session | app navigation -> Session route -> direct sync -> list refresh | SyncProvider active projection | observed |
| Same-directory or related-path active Session | Main TUI or related launch path | Browse list includes target | list replacement contains active ID | Existing list contract | observed |
| Successful API/code/auto Provider auth | Provider dialog and server handlers | Provider cache is invalidated before notification | global.disposed plus direct dialog refresh | SyncProvider Provider projection | observed/reachable |
| Historical Session with old Project ID and matching directory/path | Existing SQLite rows | Current Session list compatibility finds it without migration | Session.list directory/path predicates | Session service | observed |
| Reconnect or explicit Session-list refresh while a cross-path route is active | SSE reconnect, switch dialog, tool/dialog workflows | Browse snapshot is authoritative only for its query domain | bootstrap/session.refresh -> store replacement | SyncProvider | reachable |
| Session deletion or failed direct get | Server Session lifecycle | Deleted/not-found Session is not valid active metadata | delete event/direct sync failure -> route handling | Existing Session route/event paths | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Session path compatibility is evaluated against the current request Instance worktree, including when another worktree shares the same Project ID. | Live Project/path split and ancestor-list red command. | None; existing legacy test uses one worktree. |
| INV-02 | A valid Session selected by the current route remains available to TUI consumers after any browse snapshot that legitimately omits it, including while reconnect validation is pending or has a confirmed ConnectionError. | Live direct-get/list split, independent list/direct requests, and deterministic SyncProvider red loop. | None. |
| INV-03 | Browse snapshots remain authoritative for non-active entries: omitted stale Sessions are removed, and unrelated non-active sibling Sessions do not become browse matches. | Existing path-filter contract and dialog list behavior. | Session list tests cover server scope, not active TUI composition. |
| INV-04 | Provider credential changes refresh Provider/model/auth/console projections only; they do not refresh Session, Config, Agent, Message, Part, Project, or route state. | User-selected contract and `ddc5e00c60` regression. | None. |
| INV-05 | A valid cross-path Session route exits with its concrete original Session ID after startup, list refresh, reconnect, or Provider refresh. | User output and real ExitProvider seam. | Existing exit tests never omit the active Session from list. |
| INV-06 | Same-path list behavior, daemon/SSE lifecycle, Project identity, and historical no-migration visibility remain unchanged; NotFound revokes a deleted Session even after route navigation, ConnectionError retains it, and every other latest direct-sync failure keeps the existing error/toast/home contract. | SSE no-replay path, SDK 404 cause, ConnectionError classifier, and initial route error boundary. | Existing tests cover delivered delete events and initial errors, not missed deletion plus reconnect or a late browse after route navigation. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `directoryMatchesPath` resolves `ProjectTable.worktree` by shared Project ID and compares that unrelated persisted worktree to the current request's directory/path, disabling the existing directory fallback for the second Instance. | Session service list/search universe predicate | Public APIs show same Project ID, request worktrees A/B, one stored worktree A, and an omitted ancestor Session from B. |
| INV-02, INV-03 | Each list completion calls `setStore("session", reconcile(snapshot))`, treating a path-scoped browse snapshot as the complete shared Session projection and deleting the route-owned direct Session. | `SyncProvider` Session projection replacement | Production lines 994, 1002, 1064; the red harness leaves the route unchanged while both ordinary and Provider refresh remove the Session. |
| INV-04 | `ddc5e00c60` maps Provider-only `global.disposed` and all three Provider dialogs to full `bootstrap()`. | `SyncProvider` refresh interface and Provider dialog caller | Commit diff and current lines 612-621 / 270 / 321 / 394. |
| INV-05 | Session route reads the already-corrupted projection for title and exit ID. | Downstream Session route consumer | `session()?.id` becomes undefined only after the owning projection removed the row; changing the formatter would not restore rendering. |

### Red-Capable Feedback Loop

The producer-level red command, run from `packages/opencode`, uses the live
public API and asserts that the target is an ancestor of the request directory:

```powershell
bun -e 'import path from "node:path"; const base="http://127.0.0.1:4096"; const id="ses_01be48e73ffeQJJlE10m5u4q6J"; const directory="F:/ML/PythonAIProject/Claude-Code/opencode/thirdparty/opencode-11720"; const headers={"x-opencode-directory":directory}; const direct=await fetch(`${base}/session/${id}?directory=${encodeURIComponent(directory)}`,{headers}); const info=await direct.json(); const url=new URL(`${base}/session`); url.searchParams.set("directory",directory); url.searchParams.set("path",""); url.searchParams.set("start",String(Date.now()-180*24*60*60*1000)); url.searchParams.set("limit","1600"); const response=await fetch(url,{headers}); const sessions=await response.json(); const relative=path.relative(info.directory,directory); const targetIsAncestor=relative!==""&&!relative.startsWith("..")&&!path.isAbsolute(relative); const missing=!sessions.some((session)=>session.id===id); console.error(JSON.stringify({directStatus:direct.status,targetDirectory:info.directory,requestDirectory:directory,targetIsAncestor,listStatus:response.status,listContainsTarget:!missing},null,2)); if(direct.ok&&targetIsAncestor&&missing) process.exitCode=1;'
```

Observed exit 1: direct status 200, `targetIsAncestor: true`, and
`listContainsTarget: false`.

The projection/Provider red command, also run from `packages/opencode`, is:

```powershell
bun -e 'import { Global } from "@opencode-ai/core/global"; import { tmpdir } from "./test/fixture/fixture"; import { mount, json, wait, directory } from "./test/cli/cmd/tui/sync-fixture.tsx"; const previous=Global.Path.state; await using tmp=await tmpdir(); Global.Path.state=tmp.path; await Bun.write(`${tmp.path}/kv.json`,"{}"); const id="ses_cross_path_repro"; const info={id,projectID:"proj_owner",directory:"/workspace/owner",title:"Cross path",time:{created:1,updated:1}}; const fixture=await mount((url)=>{if(url.pathname===`/session/${id}`) return json(info); if(url.pathname===`/session/${id}/messages`) return json([]); if(url.pathname===`/session/${id}/todo`) return json([]); if(url.pathname===`/session/${id}/diff`) return json([])}, {type:"session",sessionID:id}); try {await fixture.sync.session.sync(id,{force:true}); await fixture.sync.session.refresh(); const first=!fixture.sync.session.get(id); await fixture.sync.session.sync(id,{force:true}); fixture.emit({directory,payload:{id:"evt_provider_refresh",type:"global.disposed",properties:{}}}); await wait(()=>!fixture.sync.session.get(id)); const second=!fixture.sync.session.get(id); console.error(JSON.stringify({first,second},null,2)); if(first&&second) process.exitCode=1;} finally {fixture.app.renderer.destroy(); Global.Path.state=previous;}'
```

It was run twice after minimization. Both runs exited 1 with:

```json
{"first":true,"second":true}
```

`first` is ordinary path-scoped list erasure; `second` is the recent Provider
notification trigger. The loop is deterministic, takes about 6-10 seconds, and
uses the production SyncProvider through its public route/SDK event seams.

R8 records that the command above is intentionally red-only: its Provider
readiness condition is `!fixture.sync.session.get(id)`, so a successful repair
must make that wait time out. Post-repair verification instead makes the fake
Provider change from `provider_old` to `provider_new`, waits for the public
`provider_next.connected` projection, and requires both loss flags to be false:

```powershell
bun -e 'import { Global } from "@opencode-ai/core/global"; import { tmpdir } from "./test/fixture/fixture"; import { mount, json, wait, directory } from "./test/cli/cmd/tui/sync-fixture.tsx"; const previous=Global.Path.state; await using tmp=await tmpdir(); Global.Path.state=tmp.path; await Bun.write(`${tmp.path}/kv.json`,"{}"); const id="ses_cross_path_repro"; const info={id,projectID:"proj_owner",directory:"/workspace/owner",title:"Cross path",time:{created:1,updated:1}}; const provider=(id)=>({id,name:id,source:"api",env:[],options:{},models:{}}); let refreshed=false; const fixture=await mount((url)=>{if(url.pathname==="/session") return json([]); if(url.pathname===`/session/${id}`) return json(info); if(url.pathname===`/session/${id}/message`) return json([]); if(url.pathname===`/session/${id}/todo`) return json([]); if(url.pathname===`/session/${id}/diff`) return json([]); if(url.pathname==="/config/providers") return json({providers:[provider(refreshed?"provider_new":"provider_old")],default:{}}); if(url.pathname==="/provider") return json({all:[provider(refreshed?"provider_new":"provider_old")],default:{},connected:[refreshed?"provider_new":"provider_old"]}); if(url.pathname==="/provider/auth") return json({}); if(url.pathname==="/experimental/console") return json({consoleManagedProviders:[],switchableOrgCount:0})}, {type:"session",sessionID:id}); try {await fixture.sync.session.sync(id,{force:true}); await fixture.sync.session.refresh(); const first=!fixture.sync.session.get(id); refreshed=true; fixture.emit({directory,payload:{id:"evt_provider_refresh",type:"global.disposed",properties:{reason:"provider-refresh"}}}); await wait(()=>fixture.sync.data.provider_next.connected.includes("provider_new")); const second=!fixture.sync.session.get(id); console.error(JSON.stringify({first,second},null,2)); if(first||second) process.exitCode=1;} finally {fixture.app.renderer.destroy(); Global.Path.state=previous;}'
```

Observed post-repair output: `{"first":false,"second":false}` with exit 0.

### Recent-Change Attribution

- `9209c04370` introduced path-scoped Session lists while retaining wholesale
  list replacement. This created the latent projection conflict.
- `ddc5e00c60` is the recent direct Provider regression: non-stop
  `global.disposed` changed from ignored to full bootstrap, and all auth dialogs
  retained a second full bootstrap.
- `1c4298bfc6` correctly repaired Project identity and active Session event
  admission, but the root-commit identity now makes same-history worktrees share
  a Project ID. The pre-existing list predicate assumes one Project ID implies
  one authoritative persisted worktree, and the commit did not repair that
  assumption or any of the three list-replacement sites. Its own implementation
  evidence recorded `before=ses_target after=undefined`; its tests covered
  Message/Part admission rather than route metadata retention.
- `1440697121` changed the browse window and limit only. It changes how often a
  Session is omitted but is not the projection-owner defect.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Evaluate Session path compatibility for the current request Instance | Session service | List/search use the caller's resolved directory/path universe | The service already receives InstanceState context and owns the shared predicate | ProjectTable is persisted Project metadata and cannot identify one of multiple active worktrees. |
| Compose a browse snapshot with the current route-owned Session | SyncProvider | Supplies the TUI's Session projection to all route and dialog consumers | It owns both direct Session insertion and list replacement and already has RouteProvider access | Session.list correctly owns only browse selection; the Session route must not compensate after deletion. |
| Refresh Provider-derived TUI state after credentials change | SyncProvider | Supplies Provider/model/auth/console projections | It already fetches and stores every Provider field | Server owns cache invalidation, not each TUI's local projection; Dialog should not know endpoint composition. |
| Initiate auth and wait for Provider projection readiness | Provider dialog | Opens Model selection only after successful credential refresh | It owns API/code/auto interaction completion | Session and daemon lifecycle do not own dialog sequencing. |
| Stable Continue output and invalid-route navigation | Session route/ExitProvider | Reflects a valid Session and returns home only after authoritative NotFound | Reconnect reads SyncProvider's direct-sync validation result; formatter remains unchanged | SyncProvider cannot own route navigation, and transport/unrelated failures must not revoke a valid route. |

## 10. Single Approved Primary-Path Design

R8 establishes one ownership rule: **each operation uses its current Instance
and may replace only the projection it owns; the current Session route remains
authoritative for its already-loaded Session metadata.**

```text
Session list/search request
  -> Session.Service reads current InstanceState.context.worktree
  -> shared list/search universe compares request directory/path to that worktree
  -> existing directory compatibility includes valid ancestors/descendants
```

The private list/search input carries the current request worktree from
`Session.Service.list` and `searchScan` into their existing shared universe
predicate. `directoryMatchesPath` uses that value directly and no longer reads
`ProjectTable` to rediscover request context. Project identity, SQL schema, and
all existing path conditions remain unchanged.

The TUI portion retains the same projection-ownership rule: **a refresh may replace only the
projection it owns; the current Session route remains authoritative for its
already-loaded Session metadata.**

```text
path-scoped Session list snapshot
  -> SyncProvider replaces non-active browse entries
  -> if the current route Session is already loaded and omitted, insert that
     exact existing Session into the sorted replacement
  -> all route consumers continue reading one coherent Session store

Provider auth/callback
  -> server invalidates Provider caches and emits existing global.disposed
  -> SyncProvider fetches config.providers + provider.list + provider.auth + console state
  -> one batch replaces only Provider-derived fields
  -> initiating dialog awaits the same Provider refresh before Model selection
```

The Session replacement must be centralized and used by all three existing
list completion sites. It reads the current route at application time, not at
request start, so a late snapshot preserves only the route that is actually
active when it lands. A local per-Session validation map records a monotonically increasing request
version and the result of the existing ID-global direct sync: `pending` when
recovery starts, `valid` after the complete Session snapshot succeeds,
`connection-error` only when the existing `ConnectionError` classifier matches,
`not-found` only when the SDK error cause has status 404, and `failed` for every
other error. No new request is introduced.

The replacement keeps the exact existing active object for `pending`, `valid`,
and `connection-error`; this prevents list-first and transport gray windows.
For `not-found`, it excludes that known terminal ID from every late stale list
snapshot even if the route has already navigated home, and removes existing
metadata. Delivered `session.deleted` records the same terminal validation
state before removing the row. A later successful direct
sync changes the state back to `valid`. Every completion first compares its
captured version with the current map entry; an older success/error cannot
overwrite a newer direct-sync fact or reinsert metadata after newer NotFound.
The current active Session may therefore remain as the one route-owned known
entry beside the browse snapshot; it is not a server-side browse match and no
other sibling Session is retained.

When there is no Session route, the route Session is not loaded, or the snapshot
already contains a non-revoked copy, replacement remains the exact browse
snapshot except for IDs already known deleted/not-found. Therefore unrelated
non-active stale entries still disappear. The Session route's reconnect force-sync catches its result:
`connection-error` retains the route and old metadata for the next existing
reconnect; `not-found` and `failed` preserve the existing error toast/home
behavior. A stale request whose version lost to a newer request returns without
raising to the route, because its result no longer owns any state. Initial-load
behavior remains unchanged.

Provider refresh resolves all required responses before one batch update. On
failure, the old Provider projection remains intact. The background event path
logs the failure as diagnostic failure; the initiating dialog reports it by
toast and does not advance to Model selection. Neither path fabricates success.
No single-flight cache, retry, timer, event schema, or compatibility branch is
added.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Current Instance worktree path comparison | proposed | primary-contract path | yes | about 25% | replace persisted-worktree lookup |
| Exact browse replacement with no loaded active route Session | current, centralized | supported-domain branch | yes | about 25% | preserve |
| Sorted browse replacement plus active Session in pending/valid/connection-error state | proposed | supported-domain branch of the same projection contract | yes | about 30% | add |
| Provider-derived fields-only refresh | proposed | primary-contract branch | yes | about 20% | replace full bootstrap for Provider auth |
| Provider refresh failure logging/toast without Model transition | proposed | diagnostic failure path | no | below 10% of changed decision surface | add |
| Reconnect direct-sync NotFound -> existing home navigation | proposed reuse | diagnostic failure path | no | below 10% of changed decision surface | add |
| Reconnect latest non-connection/non-404 failure -> existing toast/home | proposed reuse | diagnostic failure path | no | below 10% of changed decision surface | add |
| Alternate Session get/list query | not proposed | forbidden fallback | yes | 0% | reject |
| Preserve every omitted Session | not proposed | forbidden stale compatibility path | yes | 0% | reject |
| Schema migration or Project ID rollback | not proposed | unrelated replacement path | yes | 0% | reject |
| Exit formatter route-ID fallback | R1 proposal, superseded | downstream workaround for R8 scope | yes | 0% | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why R8 supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `directoryMatchesPath` ProjectTable lookup | Attempted to reconstruct the worktree from Project ID | Same-history worktrees prove Project ID does not select the current request Instance; context already owns the exact worktree | `session/session.ts`. |
| Three direct `setStore("session", reconcile(...))` list replacements | Each caller independently treated list as total state | One owner must compose browse and active route semantics identically | Collapse in `context/sync.tsx`. |
| Non-stop `global.disposed -> bootstrap()` | `ddc5e00c60` needed Provider UI refresh without disposing Session runners | Full bootstrap crosses unrelated projection ownership | Replace with Provider-only refresh in `context/sync.tsx`. |
| Three Provider dialog `sync.bootstrap()` calls | Sender wanted fresh models immediately | They duplicate the broadcast consumer and refresh unrelated state | Replace with the same SyncProvider Provider refresh method. |
| Boolean `fullSyncedSessions` as retention authority | It only deduplicates complete snapshots | Absence conflates pending, ConnectionError, NotFound, and other failure; the validation map owns retention while the Set keeps deduplication only | `context/sync.tsx`. |
| Reconnect fire-and-forget `session.sync` without NotFound handling | Reconnect recovery assumed the Session still existed | SSE has no replay, so direct sync 404 is the deletion authority after a missed event | Add one route-local catch in `routes/session/index.tsx`. |
| R1 formatter/route-ID repair proposal | R1 saw only the downstream `undefined` output | R8 reproduces the earlier Session projection deletion | Do not implement; retain existing formatter. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01, ancestor/descendant list works for shared-ID worktrees | Instance context -> shared list/search universe | `session/session.ts` | Real Session service fixture with two worktrees/one Project ID includes the ancestor legacy Session. |
| INV-02, cross-path `-s` must not gray | Session list completion -> validation-aware active replacement | `context/sync.tsx` | Real Session route remains renderable when list wins before delayed direct success and when direct sync has a ConnectionError. |
| INV-03, browse scope remains exact for non-active Sessions | Same replacement drops omitted non-active entries | `context/sync.tsx` | SyncProvider test keeps active target while removing an omitted non-active fixture. |
| INV-04, Provider refresh touches Provider state only | global event/direct dialog -> Provider refresh | `context/sync.tsx`, `component/dialog-provider.tsx` | SyncProvider event test changes Provider state while Config/Agent/Session remain unchanged; Dialog integration reaches fresh Model selection. |
| INV-05, no valid route exits as undefined | Preserved active Session -> existing Session exit producer | No exit production change | Real Session route/ExitProvider stdout contains the concrete ID after browse omission. |
| INV-06, deletion/error and no schema/migration/lifecycle change | Reconnect marks pending -> result classifies ConnectionError, 404, or failed -> route applies existing branch | `context/sync.tsx`, `routes/session/index.tsx`; no Project, SDK, schema, migration, or renderer files | ConnectionError retains; NotFound removes/home; generic latest failure shows error/home; stale failures no-op. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Current Instance worktree propagation inside Session list/search | INV-01 | Public same-ID/different-worktree evidence | ProjectTable exposes only one row per ID and cannot recover the current request context. |
| Versioned five-state direct-sync validation and active replacement | INV-02, INV-03, INV-05, INV-06 | Deterministic red, concurrent callers, SDK error cause, existing ConnectionError classifier, and raw replacements | Boolean membership cannot distinguish pending/ConnectionError from NotFound/failed or reject stale completion; the existing result and request order supply the state without another query. |
| Provider-only projection refresh | INV-04 | Explicit user choice and `ddc5e00c60` diff | Full bootstrap updates unrelated projections and re-enters the defect. |
| Provider dialog use of the shared refresh | INV-04 | Three current auth success call sites | Leaving sender bootstrap would violate the same Provider-only contract even if broadcast consumers are fixed. |
| Provider refresh failure diagnostic | INV-04 | Provider HTTP requests are reachable and dialogs must not advance on failure | Fire-and-forget rejection or catch-and-success would either leak failure or open stale Model selection. |
| Reconnect error route handler | INV-06 | Initial load retains only ConnectionError and navigates home for other current errors | SyncProvider cannot navigate; route must preserve that existing distinction while reading latest validation state. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/session.ts` | modify | Carry the current Instance worktree into list/search shared universe evaluation and remove the ProjectTable lookup from `directoryMatchesPath`. | raw +16 / -8 |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | modify | Track versioned five-state direct-sync validation, centralize validation-aware list replacement, add Provider-only atomic refresh, route Provider event through it, and expose validation/refresh through the existing Sync context. | raw +156 / -47 |
| `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` | modify | Replace API/code/auto full bootstrap with the shared Provider refresh and stop Model transition on refresh failure. | raw +19 / -7 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Catch reconnect force-sync; retain only ConnectionError, and reuse existing toast/home behavior for latest NotFound or failed validation. | raw +16 / -11 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | modify | Add public SyncProvider behavior for active/browse composition and Provider-only event refresh. | actual diff recorded in Section 23 |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | modify | Cover list-first delayed success, ConnectionError continuity, reconnect NotFound, and generic 500 toast/home behavior through the real route. | actual diff recorded in Section 23 |
| `packages/opencode/test/cli/cmd/tui/dialog-provider.test.tsx` | add | Drive public API/code/auto auth success and Provider-refresh failure paths; assert fresh Model selection only after success, active Session retention, and toast/no-transition on failure. | actual diff recorded in Section 23 |
| `packages/opencode/test/server/session-list.test.ts` | modify | Reproduce one Project ID with two request worktrees and an ancestor historical Session through the real Session service. | actual diff recorded in Section 23 |

No production file is added. Four production files and 140 effective production
code lines remain below the user's four-file/200-code-line limits; the 207 raw
added lines include 34 Chinese explanatory comments and structural formatting.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Session list from worktree B must include an ancestor historical Session while Project row worktree remains A and A/B share one Project ID. | `directoryMatchesPath` compares B against persisted A and disables directory fallback. | Shared list/search universe receives and uses the current Instance worktree B. | Current root/thirdparty Session list omission without migration. |
| 2 | Real Session route starts reconnect with direct sync delayed; let an empty list land first, then complete direct sync. Metadata/route must remain continuously present and exit must print `opencode -s ses_exit`. | Raw list reconcile creates an observable blank interval before direct sync reinserts. | Pending validation preserves the exact old active object; success changes state to valid and updates it. | List-first reconnect cannot flicker gray or lose exit ID. |
| 3 | Real Session route reconnects while direct get throws a ConnectionError and list omits it; metadata, route, and exit ID must remain continuously present. | Boolean sync-membership absence deletes metadata while route intentionally remains. | Unavailable validation preserves the old active object and route. | Daemon transport interruption cannot recreate the reported gray screen. |
| 4 | After a valid active Session is loaded, omit its delete event, switch direct get to a 404 NotFound, and emit reconnect; stale metadata must disappear and the real route must return home. | A retention rule based only on old store presence revives the Session; reconnect sync currently drops its rejection. | NotFound validation removes/excludes the active ID and the route applies home navigation. | Session deleted while disconnected cannot remain a stale route. |
| 5 | Make the latest reconnect direct sync return a non-404, non-ConnectionError server failure; the route must show the error and return home instead of treating stale metadata as success. | Collapsing every non-404 into transport-unavailable hides existing failures. | `failed` validation follows the current generic error branch; only ConnectionError retains. | No catch-and-stale-success error expansion. |
| 6 | Start two direct force-syncs for one Session; let the newer request reach NotFound, then release the older successful snapshot. Metadata must stay absent and validation must stay not-found. | Unversioned async completion can restore a deleted Session after newer authority. | Per-Session request version ignores every stale completion before store/validation mutation and does not reject to the route. | Initial connection and repeated reconnect concurrency cannot reverse authority. |
| 7 | SyncProvider receives Provider `global.disposed`; Provider list changes, while active Session, Config, and Agent values remain unchanged. | Current handler runs full bootstrap, replacing all fields and removing the cross-path Session. | Atomic Provider-only refresh updates only Provider-derived fields. | Other TUI Provider update trigger. |
| 8 | Parameterized public Provider dialog tests complete API-key, OAuth code, and OAuth auto auth; each must reach Model selection with refreshed Provider data while the active Session remains present. | Each sender path independently calls full bootstrap; testing only API allows code/auto to retain the defect. | Each auth success path awaits the same Provider refresh before Model selection. | Initiating/main and secondary TUI direct Provider paths for all shipped auth methods. |
| 9 | For API-key, OAuth code, and OAuth auto, make the post-auth Provider refresh reject; each dialog must show an error and must not enter Model selection or remove the active Session. | The three async callers have separate completion code; an omitted rejection branch can advance stale UI or leak an unhandled rejection. | Each caller maps refresh rejection to its existing toast/dialog boundary and returns without a success transition. | Provider refresh failure is diagnostic failure, never stale success, for every reachable caller. |
| 10 | Deliver `session.deleted`, navigate the route home, then apply an older browse snapshot containing that ID; metadata must remain absent. | Filtering revoked IDs only while they are the active route lets route navigation turn a known terminal row back into an ordinary browse entry. | Every replacement filters IDs whose latest validation is `not-found`, independent of the current route. | A delivered delete remains authoritative over HTTP ordering and route lifecycle. |

Each slice is written and observed red before its minimal production change.
Tests use the real providers/components and replace only the external HTTP/SSE
transport. Expected IDs and unchanged fields are independent literals; no test
asserts private helper names, source text, or request counts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 700 actual | Production and test executable lines; excludes imports, blank/comment-only lines, pure delimiter-only formatting, generated files, and pure moves. |
| Required Chinese explanatory comments `C` | 105 required; 112 actual | `C >= max(1, ceil(E * 0.15))`; actual ratio is 16.00%. |

Qualifying comments will explain: request Instance worktree versus persisted
Project metadata; shared list/search universe ownership; browse snapshot versus active route ownership;
why only the already-loaded current Session is retained; why non-active entries
must still be removed; why Provider auth cannot call full bootstrap; atomic
Provider update/failure behavior; why every auth method has an independent
public completion path; pending/ConnectionError versus NotFound/failed; the
route error owner; stale direct-sync completion ordering; and the delayed-list test topology. Comments
must be adjacent to those decisions and may not restate calls or assertions.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` | `packages/opencode` | Real route-to-stdout cross-path Session identity. |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | Active/browse composition, Provider-only refresh, reconnect regressions. |
| `bun test test/cli/cmd/tui/dialog-provider.test.tsx` | `packages/opencode` | API/code/auto initiating dialogs use refreshed models; refresh rejection shows toast and blocks Model transition without Session loss. |
| `bun test test/server/session-list.test.ts --test-name-pattern "shared Project ID|legacy Session|directory|path"` | `packages/opencode` | Current Instance worktree, no-migration, and path browse producer behavior. |
| `bun test test/cli/tui/use-event.test.tsx test/cli/cmd/tui/sdk.test.tsx` | `packages/opencode` | Existing active Session event admission and SSE reconnect remain green. |
| `bun typecheck` | `packages/opencode` | Sync context and dialog contracts are type-safe. |
| Live ancestor red loop plus the corrected R8 source loop from section 8 | `packages/opencode` | The old running daemon remains a read-only red control; current source returns `first=false, second=false`, and the compiled isolated cross-clone scenario verifies the producer and TUI together. |
| `bun run build --single --skip-install --skip-embed-web-ui` | `packages/opencode` | Current Windows artifact compiles from the repaired source. |
| `bun run script/smoke-opentui-artifact.ts --binary F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe --scenario target-liveness` | `packages/opencode` | Existing compiled renderer/event/exit lifecycle remains green. |
| Isolated compiled shared-daemon scenario: launch daemon in A, launch `-s` for A Session from sibling B, connect a fake Provider, then Ctrl+C | `packages/opencode` | No gray frame; Provider/model data updates; prompt remains live; Continue uses concrete Session ID. |
| `git diff --check` | repository root | No whitespace errors. |

The live host daemon and current TUI processes remain read-only evidence and
must not be stopped. Compiled verification uses an isolated temporary daemon,
database/config root, and fake Provider transport.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Production files modified | 4 | Session list producer, TUI projection owner, Provider auth caller, and existing Session route failure owner. |
| Production files added/deleted | 0 | No new module or replacement path. |
| Production changed lines | 120-150 | Instance-worktree predicate, versioned five-state active replacement, Provider refresh/callers, and existing route error handling. |
| Test files modified | 3 | Session list, SyncProvider, and Session/Exit seams. |
| Test files added | 1 | Focused public Provider dialog seam. |
| Test changed lines | 375-425 | Nine vertical observed behaviors, with auth paths table-driven inside the dialog seam. |
| Schema/migration/generated lines | 0 | Explicitly prohibited and unnecessary. |

## 20. Real Risks and Open Decisions

### Real Risks

- A list response can land after route navigation. Reading the route at
  replacement time is required so a late A snapshot cannot preserve obsolete A
  after the user moved to B.
- Reconnect list and direct sync race. Marking validation pending before both
  recoveries keeps old metadata for list-first order; success updates it,
  ConnectionError leaves it for the next existing reconnect, NotFound revokes
  it, and failed follows the existing generic error path.
- Multiple direct syncs can overlap on initial connection and repeated
  reconnect. Per-Session request versions prevent an older snapshot or error
  from mutating state after the latest authority.
- A Provider auth response and its global notification can produce duplicate
  Provider reads in the initiating TUI. The reads are idempotent snapshots;
  no single-flight state is justified without an observed ordering defect.
- The live Session has a historical Project ID. Existing root-list evidence
  proves directory compatibility works; changing that server path would expand
  scope and risk browse behavior.
- List and progressive search share one universe predicate. Both service entry
  points must pass the same current Instance worktree or browse/search semantics
  would diverge.
- The duplicate `tui-smoke` plugin ID is observed in nested config roots, but
  the same Session deletion reproduces without plugins or a production
  renderer. It is not a blocking cause for R8.

### Open Decisions Requiring the User

None. The user selected Provider-only refresh and approved both TDD seams.

### Rejected Speculation

- Physical daemon/SSE disconnect: the affected PID retains Established daemon
  connections and direct HTTP remains healthy.
- Database corruption or missing Session: direct ID lookup returns 200.
- Project-ID migration: current directory compatibility already returns the
  historical row from its owning root.
- Renderer crash: no renderer/panic error exists, and the headless
  SyncProvider loop reproduces metadata deletion without OpenTUI stress.
- Preserving every list omission: this would retain stale browse entries and is
  neither required nor owned by the active-route invariant.

## 21. Audit Contract

The independent auditor must read R8 and the complete verbatim requirement,
reconstruct direct Session load, path-scoped list, list replacement, Provider
auth notification, Session rendering, and exit output from current repository
evidence, and audit the complete original scope on every round. It must check:

- the list producer uses the current request Instance worktree and the active
  projection is repaired at SyncProvider rather than hidden in the Session
  route or formatter;
- the Provider refresh contract is narrow for both broadcast and initiating
  API/code/auto dialog paths, including refresh rejection with no success
  transition;
- no schema, migration, new event, second query, fallback, retry, or unrelated
  lifecycle behavior is introduced;
- non-active browse entries and deletion semantics remain authoritative;
- current-epoch direct sync distinguishes a valid omission from a Session
  validating/ConnectionError Session, a deleted Session, and other current
  failures without a second query, and rejects stale completions;
- tests are behavior-sensitive at the two user-approved seams;
- production file/line limits and the 15 percent Chinese-comment plan remain
  feasible.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| Historical | R1 | yes | None | NB-01, NB-02, NB-03 | APPROVE, superseded by newly observed gray-screen scope | `ses_022f7d2aaffee7yATIY9DPvHBM` |
| Draft | R2 | no | Not audited; superseded after public worktree evidence | None | superseded | local planning |
| 1 | R3 | yes | B-01 | None | BLOCK | `ses_00f280be3ffeYRBC5QGvKvt2To` |
| 2 | R4 | yes | B-01 | None | BLOCK | `ses_00f280be3ffeYRBC5QGvKvt2To` |
| 3 | R5 | yes | B-01 | None | BLOCK | `ses_00f280be3ffeYRBC5QGvKvt2To` |
| 4 | R6 | yes | B-01 | None | BLOCK | `ses_00f280be3ffeYRBC5QGvKvt2To` |
| 5 | R7 | yes | None | None | APPROVE — exact plan revision R7 | `ses_00f280be3ffeYRBC5QGvKvt2To` |
| 6 | R8 | pending | pending | pending | pending | pending |

R1 and R7 approvals are invalid for R8 and grant no implementation permission.
R2 was never audited; R3, R4, R5, and R6 were blocked.

### R7 Independent Audit Verdict (Copied)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

None.

#### Rejected speculation

- 不要求为 ConnectionError 增加重试或第二查询；保留旧活动投影并等待现有 reconnect 足够。
- 不要求为 generic failure 增加恢复路径；R7 已恢复既有 toast/home 行为。
- 不要求保留非活动 browse omission、修改 Project ID、迁移数据库或更改 daemon/SSE 生命周期。
- Provider 双重刷新尚无语义分叉证据，不需要 single-flight。

#### Requirement and traceability coverage

R7 完整覆盖原始需求：

- `directoryMatchesPath` 改用当前 Instance worktree，修复共享 Project ID 下的历史 Session 列表遗漏。
- 三个 Session snapshot 入口统一保留当前 route-owned Session。
- pending 和 ConnectionError 持续保留有效 metadata；NotFound 撤销；generic failure 沿用既有错误行为。
- 请求版本阻止旧结果覆盖新 NotFound。
- Provider 事件及 API/code/auto 发起方仅刷新 Provider 投影。
- 真实 Session route/ExitProvider 验证具体 Session ID。
- 未规划 schema、迁移、第二查询、重试或 renderer/daemon 修改。

所有生产概念均有证据、owner、变更位置和行为敏感测试。

#### Primary-path and fallback verdict

每项责任均只有一条权威路径：

- Session 服务拥有路径兼容判断；
- SyncProvider 拥有 browse 与活动投影组合；
- direct ID sync 提供 Session 有效性事实；
- Session route 拥有错误导航；
- SyncProvider 拥有 Provider-only refresh。

没有备用查询、合成数据、catch-and-success、重试或兼容 fallback。五态验证属于同一 direct-sync 合同的结果分类。

#### Code quality and Chinese-comment verdict

- 修改 4 个生产文件、预计 120–150 行，满足最多 4 个生产文件和 200 行限制。
- 未新增生产模块、依赖、配置、schema、迁移或生成文件。
- TDD slices 覆盖竞态顺序、错误分类、Provider 三种认证和真实退出 seam。
- `E=450–510`、`C=68–77`，计划明确承诺实际实现满足 `C >= ceil(E × 15%)`。
- 本轮为 plan audit，实际 `E/C` 留待 implementation audit 重新计算。

#### Release verdict

**APPROVE — exact plan revision R7.**

该结论仅适用于当前 R7。任何生产路径、接口、测试范围或错误分类的实质修改都必须递增 revision 并重新进行完整审计。

### R3 Independent Audit Verdict (Copied)

#### Blocking findings

##### B-01 Provider 对话框的完整刷新合同缺少行为敏感验证

- Violated invariant: INV-04；API、code、auto 三条 Provider 凭据成功路径都只能刷新 Provider 投影，刷新失败时必须停留在当前流程并显示 toast。
- Evidence class: reachable
- Producer and execution path: `auth.set` 或 OAuth callback → 服务端 `refreshProviderCaches()` → `global.disposed`；同时发起操作的 `ApiMethod`、`CodeMethod`、`AutoMethod` 分别调用刷新方法 → 当前代码中的 `bootstrap()` 替换 Session 列表 → 活动 Session 被删除 → Session route 空屏。
- Source evidence: `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx:259-271,313-323,383-404`; `packages/opencode/src/cli/cmd/tui/context/sync.tsx:612-621,932-1033`; `packages/opencode/src/server/routes/instance/httpapi/handlers/control.ts:14-28`; `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts:93-106`
- Canonical-plan evidence: Sections 6, 7 INV-04, 13, 15, 16 slices 3-4
- Responsibility owner: Provider dialog completion paths及其公共组件测试 seam。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 计划只让新增 `dialog-provider.test.tsx` 驱动 API-key 成功路径。实现可以继续在 code/auto 路径调用 `sync.bootstrap()`，也可以遗漏 refresh rejection 的 toast/停止跳转逻辑，同时全部计划测试仍然通过。OAuth code/auto 成功后仍可触发相同的活动 Session 删除和空屏；刷新失败时仍可能进入陈旧的 Model 列表或产生未处理 rejection。
- Why this is not speculative: 三条当前生产调用点都真实存在，三条服务端凭据写入路径都会发送同一事件；R3 明确把 API/code/auto 和失败处理纳入支持域及计划修改范围。
- Minimal correction direction: 在 Provider dialog 的公共交互 seam 上，为 code、auto 成功完成路径补充可在当前 `bootstrap()` 行为下失败的断言，并覆盖 refresh rejection 后“不进入 Model 选择且显示错误”的合同。测试应观察对话框和活动 Session 行为，不断言 helper 或请求次数。

#### Non-blocking findings

None.

#### Release verdict

**BLOCK — R3 必须补齐 Provider code/auto 与刷新失败合同的行为敏感测试计划，然后进行完整范围复审。**

### R4 Independent Audit Verdict (Copied)

#### Blocking findings

##### B-01 活动 Session 保留规则会复活断线期间已删除的 Session

- Violated invariant: INV-06；Session 删除行为必须保持不变，活动投影只能保留仍由 ID-global `session.get` 确认存在的 Session。
- Evidence class: reachable
- Producer and execution path: TUI 断线 → Session 在断线期间被删除，`session.deleted` 因 SSE 无 replay 而未送达 → 重连触发 `SyncProvider.bootstrap()` 和 Session route 的强制 `session.sync()` → path-scoped list 不包含已删除 Session，直接 `session.get` 返回 NotFound → R4 的 active-aware replacement 从旧 store 读取当前 route Session，并重新插入 browse snapshot。
- Source evidence: `packages/opencode/src/cli/cmd/tui/context/sync.tsx:623-632,735-747,932-1003,1076-1114`; `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-377,399-401`; `packages/opencode/src/cli/cmd/tui/app.tsx:991-999`
- Canonical-plan evidence: Section 6 “Session deletion or failed direct get”; INV-06；Section 10 lines 273-284；Section 13 deletion-semantics preservation claim
- Responsibility owner: `SyncProvider` 的活动 Session 投影组合，以及现有 ID-global direct Session sync 结果。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: `session.deleted` 未送达时，失败的强制 direct sync 不会清除旧 store；计划中的 replacement 又会把该旧对象保留下来。已删除 Session 因此继续通过 `Show when={session()}` 渲染，route 也不会执行现有的 home 导航，后续操作仍会发送到已删除的 Session ID。R4 当前测试只覆盖“有效但被 browse 省略”的 Session，没有区分“有效省略”和“已删除省略”。
- Why this is not speculative: 源码明确说明 SSE 没有 replay，并在重连时刷新持久化状态；删除事件是唯一现有 home 导航生产者。断线期间删除无需异常输入，现有 direct `session.get` 已提供权威 NotFound 信号。
- Minimal correction direction: 活动投影保留规则必须服从现有 ID-global direct sync 的删除/NotFound 事实，仅保留仍确认有效的 route Session。增加“断线期间删除、重连未收到 delete event”的行为测试，验证旧 metadata 不被重新保留，并保持现有删除导航合同；不得增加第二次查询或替代数据源。

#### Non-blocking findings

None.

#### Release verdict

**BLOCK — R4 必须处理并验证断线期间删除的活动 Session，之后进行完整范围复审。**

### R5 Independent Audit Verdict (Copied)

#### Blocking findings

##### B-01 当前 epoch 的布尔同步标记会把“验证中/连接失败”误判为 Session 无效

- Violated invariant: INV-02、INV-05、INV-06；有效 route Session 在重连恢复期间必须持续可渲染，只有权威 NotFound 才能撤销其活动投影。
- Evidence class: reachable
- Producer and execution path: `server.connected` → 清空 `fullSyncedSessions` → 并发启动 path-scoped list 和 route `session.sync(force)` → list 先返回空 snapshot，或 direct sync 遇到 ConnectionError → active-aware replacement 因 Set 中没有 Session ID 而删除旧 metadata → ConnectionError 分支保留 route → `Show when={session()}` 变空，退出文本重新得到 `undefined`。若 direct sync 随后成功，界面也会在 list 与成功插入之间出现空白窗口。
- Source evidence: `packages/opencode/src/cli/cmd/tui/context/sync.tsx:623-632,932-1003,1053-1124`; `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-377,399-401,1272-1294,1479-1494`
- Canonical-plan evidence: INV-02、INV-05、INV-06；Section 10 lines 274-293；Section 16 slices 2-3；Section 20 reconnect race
- Responsibility owner: `SyncProvider` 的活动 Session 投影生命周期与现有 route direct-sync 结果。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: `fullSyncedSessions` 的 absence 同时表示“尚未完成本 epoch 验证”“ConnectionError”“NotFound”。R5 将三者都当作不可保留，因而在 list-first 顺序下短暂删除有效 Session；在 ConnectionError 下会永久删除 metadata，同时保留 Session route。用户仍可看到灰屏，并在下一次恢复前得到 `opencode -s undefined`。现有 TDD slice 只验证 direct sync 已成功后的 list omission，以及 NotFound 最终导航，没有锁定 list-first 成功顺序或 ConnectionError 保留行为。
- Why this is not speculative: list 和 direct sync 是独立异步请求；direct sync 还需等待 Session、Message、Todo、Diff、Status 多个请求，单独的 list 可以先完成。计划自身明确承认两者并发，并明确规定 ConnectionError 保留 route。
- Minimal correction direction: 当前连接 epoch 的权威状态必须区分 validation pending、成功、ConnectionError 和 NotFound。browse snapshot 在验证 pending 或 ConnectionError 时不得撤销旧活动 metadata；只有权威 NotFound 才能撤销并导航 home。增加 list-first 延迟成功和 ConnectionError 两条行为测试，观察整个期间 Session metadata/route 持续性，不得增加第二次查询、重试或替代数据源。

#### Non-blocking findings

None.

#### Release verdict

**BLOCK — R5 必须区分重连验证中、ConnectionError 和 NotFound，并验证 list-first 顺序不会产生灰屏，然后进行完整范围复审。**

### R6 Independent Audit Verdict (Copied)

#### Blocking findings

##### B-01 `unavailable` 吞并所有非 404 错误，形成无证据的 stale-success 路径

- Violated invariant: INV-06；只有已确认的传输不可用可以保留旧活动投影，其他非 404 失败必须沿用其既有错误语义，不能统一转换为可继续渲染的成功形态。
- Evidence class: reachable
- Producer and execution path: reconnect → `session.sync(force)` 中的 `session.get/messages/todo/diff/status` 请求发生非 ConnectionError、非 404 失败 → R6 将其统一记录为 `unavailable` → browse replacement 保留旧 Session metadata → route 保持活动且不执行既有错误导航 → 用户继续看到旧 Session 和可复用 ID。
- Source evidence: `packages/opencode/src/cli/cmd/tui/context/sync.tsx:1076-1114`; `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:338-377,399-401`
- Canonical-plan evidence: Section 10 lines 278-302；Section 11 `pending/valid/unavailable` success branch；Section 14 four-state validation；Section 16 slices 3-4
- Responsibility owner: Session route 的 direct-sync 错误边界；SyncProvider 只拥有投影保留事实。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前初始加载仅对 `ConnectionError` 保留 route，其他错误会显示错误并返回 home。R6 把任意非 404 错误都降级成 `unavailable`，保留旧 metadata 和 route，形成 catch-and-stale-success。服务端 500、SDK 解码失败或其他应用错误会被隐藏，用户仍可向未经当前同步确认的 Session 操作。计划没有为这项语义扩张提供需求或行为测试。
- Why this is not speculative: direct sync 跨越多个公共 SDK 请求，接口允许除 404 和 ConnectionError 外的失败；当前 route 已明确区分 ConnectionError 与其他错误。R6 主动改变了该既有错误边界。
- Minimal correction direction: 将 `unavailable` 限定为已有证据支持的传输/`ConnectionError` 状态。NotFound 继续撤销；其他错误保持现有 route 错误传播和导航合同，不得转换为 stale-success。无需为假想错误增加恢复、重试或兼容分支。

#### Non-blocking findings

None.

#### Release verdict

**BLOCK — R6 必须把 `unavailable` 收窄到证据支持的 ConnectionError，并保持其他错误的既有语义，然后进行完整范围复审。**

## 23. Implementation Evidence

### Actual Changed-File Inventory

| File | Raw diff | Actual responsibility |
| --- | --- | --- |
| `packages/opencode/src/session/session.ts` | +16 / -8 | Current Instance worktree reaches the shared list/search compatibility predicate. |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | +156 / -47 | Central Session replacement, versioned five-state validation, route-independent not-found filtering, and atomic Provider-only refresh. |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | +16 / -11 | Initial/reconnect sync share ConnectionError versus error/toast/home handling. |
| `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` | +19 / -7 | API/code/auto use the shared refresh and stop on toast-visible failure. |
| `packages/opencode/test/server/session-list.test.ts` | +65 / -0 | Shared Project ID with two request worktrees and historical ancestor Session. |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | +308 / -23 | Real Session route/ExitProvider list ordering and reconnect result classes. |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | +179 / -0 | Provider ownership, deletion/list ordering, and direct-sync request versions. |
| `packages/opencode/test/cli/cmd/tui/dialog-provider.test.tsx` | +239 / -0 | Public API/code/auto success and refresh-rejection Dialog behavior. |

No production module, schema, migration, generated SDK, dependency, setting,
feature flag, or event schema was added. The final repair touches exactly four
production files. Heuristic production executable code is 140 lines; the raw
production additions are 207 because they include 34 Chinese explanatory
comment lines and structural formatting. `formatSessionExitMessage`, daemon,
SSE, renderer, Project identity, and database ownership remain unchanged.

### Red-Green Evidence

| Behavior | Red evidence | Green evidence |
| --- | --- | --- |
| Current worktree path compatibility | New service test received `[]` instead of the ancestor Session. | Focused worktree/legacy command: 2 pass. |
| Direct Session versus late browse | Real route expected `ses_exit`, received `undefined`. | `session-exit.test.tsx`: 8 pass. |
| List-first reconnect | Removing pending retention made `First connected` become `undefined`. | Pending case remains continuously renderable. |
| ConnectionError | Reconnect rejected with `Unable to connect to reconnect fixture`. | Route/metadata/concrete exit ID remain present. |
| NotFound | Mutating 404 classification to 410 timed out before `not-found`. | 404 removes metadata and navigates home. |
| Generic failure | Reconnect rejection escaped the route error owner. | 500 error is toast-visible and route becomes home. |
| Direct-sync version race | Removing both version guards produced `valid` after newer `not-found`. | Older success cannot restore metadata. |
| Delivered delete versus late browse | Initial implementation remained `valid`; strengthened route-home test reinserted the deleted object. | Event records `not-found`; late browse stays filtered after home navigation. |
| Provider broadcast ownership | Expected old Config, received `new-config` after `global.disposed`. | Provider becomes new while Config/Agent/Session remain old. |
| Provider initiating Dialog | API success reached fresh Model but active Session became `undefined`; refresh failure leaked an unhandled rejection. | API/code/auto success and failure matrix: 6 pass, 15 assertions. |

Every production branch above has a behavior-sensitive test through a public
service, route/context, SDK transport, rendered Dialog, or ExitProvider seam.
Mutation checks were restored immediately after proving test sensitivity.

### Verification Results

| Command or scenario | Result |
| --- | --- |
| `bun test test/cli/cmd/tui/session-exit.test.tsx test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/dialog-provider.test.tsx test/cli/tui/use-event.test.tsx test/cli/cmd/tui/sdk.test.tsx` | 44 pass, 0 fail, 116 assertions. A non-fatal existing KV first-read ENOENT diagnostic was logged. |
| `bun test --timeout 30000 test/server/session-list.test.ts` | 23 pass, 0 fail, 120 assertions. The default five-second Windows fixture disposal limit timed out under load; the command-only 30-second limit changed no test or product behavior. |
| `bun typecheck` | Exit 0. |
| Corrected R8 source feedback loop from Section 8 | Exit 0 with `{"first":false,"second":false}`. |
| `bun run build --single --skip-install --skip-embed-web-ui` with Windows system proxy `127.0.0.1:7897` | Built `0.0.0-dev-smark-202608111438`; version, voice Worker, and OpenTUI DLL smokes passed; executable SHA-256 `777ec6f83e1c4331c8a7aebb3791de2de89e03c8421503bcc5f5dfc9f01b1b03`. |
| Compiled `target-liveness` artifact smoke | Passed with 2 source/rendered target glyphs, 2 model requests, and 14 target events. |
| Temporary isolated compiled cross-clone run using the existing smoke harness | Passed: daemon/TUI A, same-root-commit clone B, explicit A Session from B, real `auth.set/global.disposed`, 2 model requests, 14 target events, concrete `sessionID=ses_00eb4ef6bffeJUGVM9lZuWOkGJ`, and normal Ctrl+C. The temporary harness extension was fully reverted; `git diff --exit-code -- packages/opencode/script/smoke-opentui-artifact.ts` passed. |
| `git diff --check` | Exit 0; only line-ending warnings from unrelated dirty files. |

The first build attempt failed only because direct access to
`https://models.dev/api.json` was refused; using the already-enabled Windows
system proxy produced the successful final build. The full Session-list command
first hit the existing five-second `InstanceStore` disposal timeout; running the
same 23 tests without parallel load and with command-level 30-second headroom
passed completely.

### Original Feedback and Runtime Boundary

The exact live ancestor command still exits 1 against the user's already
running pre-build daemon on port 4096 with direct 200 and
`listContainsTarget=false`. The process was intentionally not stopped or
replaced and cannot hot-load current source. This is retained as the old-runtime
red control, not claimed as repaired live-process evidence. Current-source
service tests and the rebuilt isolated same-commit cross-clone daemon/TUI run
both pass. The original source projection command now times out only because
its readiness predicate waits for the bug (`!session`); the corrected R8 loop
uses Provider projection readiness and exits 0.

### Replacement and Failure Inventory

- The persisted Project-worktree lookup is removed from the compatibility
  predicate; no alternate Project identity or migration replaces it.
- Three raw Session-list writes collapse into one replacement owner. It retains
  only the exact loaded active object in pending/valid/ConnectionError and
  filters IDs with a known not-found terminal state.
- Existing ID-global direct sync remains the sole validity query. There is no
  retry, second lookup, timer, synthetic Session, or stale-success path.
- Provider broadcast and all three initiating Dialogs use one atomic
  Provider-only refresh. Background failure logs; initiating failure toasts and
  stops. Neither partially commits nor opens Model selection as success.
- `fullSyncedSessions` remains only a deduplication set; versioned validation is
  the authority for ordering and result classification.

### Chinese Explanatory-Comment Gate

The final diff calculation includes four production files, three modified test
files, and the new Dialog test. It excludes imports, blank/comment-only lines,
pure delimiter-only formatting, generated files, and pure moves:

```text
E = 700
C = 112
required C = ceil(700 * 0.15) = 105
C / E = 16.00%
```

All counted comments are adjacent to worktree ownership, projection authority,
request-version ordering, error classification, Provider atomicity, real UI
context topology, or published readiness; no filler comments are counted.

## 24. Implementation Audit Record

Pending full-scope R8 plan approval, then independent implementation audit.

<!-- SUPERSEDED R1 HISTORICAL RECORD; NOT IMPLEMENTATION AUTHORITY

## 1. Verbatim Requirement

> 为什么我的这个session好像是TUI和DAEMON断连了,然后它就会显示相应的undefined的,请检查这到底是什么路径造成的,什么原因造成的,你可以自行检查相应的日志。请注意其问题不是我调用undefined不给结果,而是它为什么会出现undefined的这么一个操作。以及如果要解决的话,如何进行相应的修复操作和解决,并且保持精准修改,克制修改,能够解决它这个问题。请注意当前只是方案的检查。

## 2. Explicit Non-Goals

- Do not change daemon ownership, SQLite single-owner behavior, or daemon idle/shutdown policy.
- Do not change the SDK SSE reconnect loop, heartbeat timeout, provider request timeout, or Session runner lifecycle.
- Do not force the current Session back into the filtered browse list; `sync.data.session` remains a browse projection.
- Do not add a retry, alternate Session lookup, last-session selection, or synthetic `ses_` ID.
- Do not make `opencode -s undefined` a supported command or alter its validation error.
- Do not change Session title, token accounting, Stats formatting, or existing exit ordering when Session metadata is available.
- Do not modify production code, tests, configuration, generated files, or migrations in this planning revision.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md:9-18,33-69,127-175` | Session identity, Session lifecycle, shared daemon, and TUI ownership vocabulary. |
| `docs/adr/README.md:1-50` and `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | ADR conventions; no daemon/TUI exit ADR changes this scope. |
| `AGENTS.md:21-141` | Minimal changes, package-local tests, and `bun typecheck` directory rules. |
| `packages/opencode/AGENTS.md:76-135` | Module shape and Effect/InstanceState ownership rules. |
| `packages/opencode/test/AGENTS.md:161-204` | Use published readiness signals for concurrent tests; avoid fixed sleeps except for timing contracts. |
| `.opencode/policy/first-principles-engineering.md:218-231,275-322,476-546` | Repair the first divergence, preserve one primary path, require traceability, and enforce the Chinese-comment gate. |
| `.opencode/templates/canonical-plan.md` | Canonical plan structure and audit metadata. |
| `docs/plans/daemon-ctrl-c-shutdown-lifecycle.md` | Existing daemon shutdown plan is adjacent but its observed root cause is a stuck daemon teardown, not this normal TUI exit/session-ID projection defect. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:212-232,338-376,399-401,479-493` | Defines `session()` from the local Session list, async Session sync, reconnect force-sync, and exit message producer. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:447-464,749-799,924-1014,1047-1118` | Shows browse-scoped `session.list`, independent Message event updates, reconnect bootstrap, list replacement, and direct Session sync insertion. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:122-211` | Shows SSE stream teardown/reconnect and intentionally swallowed connection errors. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/exit.tsx:19-78` | Shows stored exit text survives renderer destruction and is written to stdout. | reachable |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts:32-53` | Shows the literal `"undefined"` fallback in the Continue command. | observed/reachable |
| `packages/opencode/src/cli/cmd/tui/app.tsx:294-299,487-506` | Shows the `--continue` temporary `dummy` Session route and later real-route navigation. | reachable |
| `packages/opencode/src/session/schema.ts:1-8` and `packages/core/src/session.ts:1-12` | Defines Session IDs as strings starting with `ses`. | contracted |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx:50-124,191-203` | Existing real ExitProvider stdout seam and readiness helper; current assertions do not validate the Continue ID. | observed |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx:281-557,559-574,700-818` | Existing reconnect, session-list scope, and forced Session sync test patterns. | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T153301.log:1-19` | Plain `opencode` TUI exited normally at 15:42:21. | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T152701.log:9132-9184` | At the same time, daemon SSE count went 6 to 5 with `global event disconnected`, then returned to 6 with `global event connected` five seconds later; active Session/provider work continued. | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T152701.log:9891-9906` | A later normal TUI exit/disconnect was followed by another client connection while Session activity continued. | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T154225.log:1-19` | Explicit Session TUI also exited through the normal ExitProvider path. | observed |
| Read-only formatter probe from `packages/opencode` | With `sessionID: undefined` and non-zero usage, output contains `Stats` plus `opencode -s undefined`. | observed |
| Read-only Solid store probe from `packages/opencode` | `setStore("session", reconcile(filteredList))` removes an active Session absent from the filtered list. | observed |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` from `packages/opencode` | Existing exit tests pass but do not catch this symptom. | observed |

## 5. Current Behavior

```text
TUI process -> shared daemon HTTP/SSE -> SyncProvider bootstrap/session sync
  -> server.connected after reconnect
  -> filtered session.list replaces sync.data.session
  -> Session route still owns route.sessionID
  -> session() reads the mutable browse projection and may be undefined
  -> exit effect passes session()?.id as optional
  -> formatter converts missing ID into literal "undefined"
  -> ExitProvider destroys renderer and writes the stored text to stdout
```

The logs do not show the daemon changing a Session ID. They show normal TUI
exit and the corresponding SSE disconnect. The daemon remains alive because its
shared status still has other TUI clients or active Session runners. The
disconnect is therefore the trigger window, not the producer of the string
`undefined`.

The reconnect path has two concurrent consumers of `server.connected`:

- `SyncProvider` starts `bootstrap({ fatal: false })`, whose `session.list` is filtered by directory/path, lookback, and browse limit, then replaces `store.session` with `reconcile(sessions)`.
- The Session route calls `sync.session.sync(route.sessionID, { force: true })`, which can insert the current Session into the same store before or after the list replacement.

The Message event reducer can populate `store.message[sessionID]` independently
of `store.session`. This permits Stats to remain non-empty while the metadata
lookup used by the exit summary returns `undefined`.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Valid Session route with temporary metadata absence | `RouteProvider` plus reconnect/list refresh | `route.sessionID` remains the navigation identity; browse list is filtered | `server.connected` -> bootstrap/session sync -> Session exit effect | Session route / exit formatter | observed/reachable |
| Message/Part data present while Session metadata is absent | daemon SSE `message.updated`/part events | event carries its own Session ID | SyncProvider message reducer -> tokenAccounting | SyncProvider | reachable |
| Normal TUI exit after SSE disconnect | OpenTUI exit command or signal | ExitProvider serializes one stored message | renderer destroy -> stdout write | ExitProvider | observed |
| `--continue` temporary `dummy` route | `app.tsx` initial route | real Session navigation happens only after session list matching | initial TUI mount before continuation effect | App route setup | reachable |
| Invalid or non-Session route identity at exit-summary seam | internal route construction | Session IDs contractually start with `ses` | formatter boundary | Session route | reachable |
| Shared daemon remains alive after one TUI exits | worker SSE/activity counters | daemon is shared and active work prevents idle shutdown | TUI exit -> status hint | daemon/worker | observed |

The plan does not treat arbitrary malformed environment routes, provider
failures, or database corruption as production inputs because no evidence in the
current incident connects them to this output.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A resolved Session route's Continue command uses that route's stable `ses...` identity even when the browse metadata projection is temporarily absent. | Route type, reconnect path, logs, and user output | None; current exit tests only assert `Continue`. |
| INV-02 | Exit formatting never emits a success-shaped `opencode -s undefined` command. | User-visible output and formatter probe | None. |
| INV-03 | A temporary `dummy`/invalid route does not produce a fake continuation command. | `app.tsx` reachable temporary route and SessionID schema | None. |
| INV-04 | Existing title, Stats, normal Session exit text, and daemon status behavior remain unchanged when metadata is available. | Existing exit contract and passing focused tests | `session-exit.test.tsx` existing cases. |
| INV-05 | TUI/daemon disconnect and reconnect behavior remains unchanged; only the exit identity projection changes. | Log sequence and SDK/worker contracts | Existing `sdk.test.tsx` and `sync.test.tsx` reconnect cases. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | Session route derives its identity for exit output from `sync.session.get(route.sessionID)`, which reads a filtered browse projection rather than the route identity. | `Session` route exit-message producer | `index.tsx:222`, `sync.tsx:1047-1052`, `index.tsx:490`; reconnect list replacement can evict the current metadata record. |
| INV-02 | `formatSessionExitMessage` accepts an optional `sessionID` and turns absence into the literal string `"undefined"`. | `exit-summary.ts` formatter contract | `exit-summary.ts:32,51`; read-only probe reproduced Stats plus `opencode -s undefined`. |
| INV-03 | The initial `--continue` route is a literal `dummy` Session route before a real Session is selected. | `app.tsx` route initialization / Session exit seam | `app.tsx:294-299,487-506`; SessionID schema requires the `ses` prefix. |

### Red-capable feedback loop

The minimum current red signal, already run without file writes, is:

```text
cd packages/opencode
bun -e 'formatSessionExitMessage({ title: "", sessionID: undefined, usage: { input: 477400, output: 17900, cost: 0 } })'
```

Observed result:

```json
{"symptom":true,"sessionLineEmpty":true,"statsPresent":true}
```

The planned regression must exercise the real `Session` route plus
`ExitProvider` stdout seam and force reconnect list replacement after current
Session sync. Before the repair it must emit `opencode -s undefined`; after the
repair it must emit the stable `ses...` route ID.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Session identity used by exit output | Session route | Route owns the selected Session ID for the current view | The route remains stable while browse metadata is refreshed | Daemon owns transport/activity, not TUI presentation identity. |
| Valid continuation command formatting | `exit-summary.ts` | Formatter receives a concrete Session ID | A formatter must not synthesize a success command from missing input | `ExitProvider` only owns lifecycle/stdout emission. |
| Temporary invalid route handling | Session route at the SessionID schema seam | Invalid/non-Session route is not a continuation target | The route consumer knows whether the view can emit Session output | SyncProvider cannot decide user-visible exit semantics. |
| TUI/daemon liveness counters | `worker.ts`/`daemon.ts` | Existing shared daemon status contract | No change is required for this bug | Exit summary must not alter daemon lifecycle. |

## 10. Single Approved Primary-Path Design

```text
Session route
  -> decode route.sessionID with the existing SessionID schema
  -> if valid, use that ID as the exit-summary identity
  -> use session() only for title and existing usage projection
  -> formatSessionExitMessage({ sessionID: concreteID, ... })
  -> ExitProvider writes the valid stored text after renderer destruction
```

The exact production changes are:

1. Change the Session route exit producer to decode/use `route.sessionID`, not
   `session()?.id`. This repairs the first divergence at the identity owner.
2. Keep the existing `session()?.title` and tokenAccounting projections for
   their current responsibilities. A missing metadata title remains an empty
   title rather than causing a second lookup or network fallback.
3. Make `formatSessionExitMessage` require a concrete Session ID and remove the
   `?? "undefined"` success-shaped fallback.
4. If the route ID is the current `dummy` sentinel or fails the existing
   `SessionID` schema, clear/omit the Session-specific exit message. This is a
   diagnostic absence, not an alternate success path.

This preserves the normal path byte-for-byte when Session metadata is present,
while making reconnect metadata loss unable to manufacture a bad command.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Route ID as exit identity | proposed | primary-contract branch | yes | 100% of corrected identity path | add |
| Session metadata for title and usage | current, preserved | primary-contract pass-through | yes | existing | preserve |
| `session()?.id` for Continue | current | broken primary projection | yes, incorrectly | existing | remove |
| `input.sessionID ?? "undefined"` | current workaround | forbidden fallback | yes, invalidly | existing | remove |
| Last Session / alternate Session lookup | not proposed | forbidden fallback | yes | 0% | reject |
| Daemon stop/restart or TUI reconnect retry | not proposed | unrelated lifecycle path | yes | 0% | preserve existing behavior |

No new alternate success path is authorized. Missing route identity produces no
Session-specific continuation command rather than a fabricated command.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `sessionID?: string` in the exit formatter | Allowed the caller to pass metadata lookup absence through formatting | Exit output needs a concrete identity; absence is handled before formatting | `routes/session/exit-summary.ts` |
| `?? "undefined"` in Continue command | Preserved a fixed line shape after missing metadata | It creates invalid user-visible success text and hides the first divergence | `routes/session/exit-summary.ts` |
| `session()?.id` as exit identity | Reused the metadata object already used for title | Metadata is a filtered/reconciled browse projection, not route identity | `routes/session/index.tsx` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Route ID decode -> exit formatter | `routes/session/index.tsx` | Real Session route + reconnect list race + stdout assertion |
| INV-02 | Required formatter ID; no literal fallback | `routes/session/exit-summary.ts` | Output contains `opencode -s ses_exit` and not `undefined` |
| INV-03 | Invalid route ID clears Session exit message | `routes/session/index.tsx` | Session exit harness with non-Session sentinel route |
| INV-04 | Existing title/Stats path remains unchanged | Same two production files | Existing `session-exit.test.tsx` cases plus new regression |
| INV-05 | No daemon/SSE production change | No worker/daemon/SDK file change | Existing `sdk.test.tsx`, `sync.test.tsx`, and log contract review |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Decode `route.sessionID` at Session exit boundary | INV-01, INV-03 | Route remains stable; SessionID schema exists; current dummy route is reachable | Current lookup reads mutable browse metadata. |
| Required `sessionID` formatter input | INV-02 | Current formatter emits a literal invalid command | Optional input permits a success-shaped invalid result. |
| Clear on invalid route | INV-02, INV-03 | `dummy` is a reachable pre-resolution route | Current fallback prints a command instead of a diagnostic absence. |
| Real reconnect exit regression | INV-01, INV-04 | Logs and concurrent bootstrap/session sync path | Existing tests do not combine reconnect list replacement with exit stdout. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Decode/use route Session ID for exit output; clear summary for invalid temporary route; retain title/usage projections. | +8 / -3 |
| `packages/opencode/src/cli/cmd/tui/routes/session/exit-summary.ts` | modify | Require concrete Session ID and remove the literal undefined fallback. | +1 / -2 |
| `packages/opencode/test/cli/cmd/tui/session-exit.test.tsx` | modify | Add real ExitProvider regression for reconnect metadata absence and invalid route behavior. | +55 / -5 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | modify | Add a focused reconnect/list-refresh fixture only if the existing session-exit harness cannot expose the ordering deterministically. | +30 / 0 |

The fourth row is conditional at implementation time: prefer keeping the
regression in `session-exit.test.tsx` if its existing fixture can observe the
public stdout seam without duplicating SyncProvider internals. Do not modify
`sync.test.tsx` solely to assert private store shape.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Mount the real Session route with a valid route ID, delay/omit the Session metadata list during reconnect, emit Message/Part usage, then exit; stdout must contain `opencode -s ses_exit` and not `undefined`. | Current exit producer reads `session()?.id`, which is absent after the filtered list replacement. | Route ID is decoded and passed to a formatter that requires it. | Original user-visible undefined output after TUI/daemon reconnect. |
| 2 | Exercise the temporary `dummy` route boundary and assert no Session-specific Continue command is emitted. | Current formatter accepts any optional value and prints a success-shaped command. | Invalid route identity clears/omits the Session exit message. | `--continue` startup race cannot create `opencode -s dummy` or `undefined`. |
| 3 | Run existing normal exit cases and assert unchanged title, Stats, Continue, and empty-Stats behavior. | Guards can accidentally remove the normal message or alter token projection. | Existing formatter output remains unchanged for concrete Session IDs. | Non-regression for normal TUI exits. |

The first slice is the required red test. It must use the existing
`ExitProvider`/stdout seam and published readiness signals, not a source-text
assertion or private helper call.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 55-75 | Production and behavioral test lines only; exclude imports and formatting. |
| Required Chinese explanatory comments `C` | 9-12 | `max(1, ceil(E * 0.15))`; comments explain route identity versus browse metadata, invalid sentinel handling, and reconnect regression intent. |

Qualifying comments must be placed next to the route-ID decision and the
reconnect regression. They must explain why `route.sessionID` is authoritative
and why missing identity produces no command; comments must not restate code.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-exit.test.tsx` | `packages/opencode` | Red/green public ExitProvider stdout behavior, including reconnect metadata absence. |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | Existing SyncProvider reconnect and list-scope regression coverage. |
| `bun test test/cli/cmd/tui/sdk.test.tsx` | `packages/opencode` | Existing SDK URL/SSE reconnect behavior remains green. |
| `bun typecheck` | `packages/opencode` | SessionID/formatter contract and TUI route typing. |
| `git diff --check` | repository root | No whitespace errors in the implementation diff. |

The original read-only formatter probe must be rerun after implementation and
must no longer report `symptom: true`; the real TUI regression is the required
behavioral signal.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Existing test seam is sufficient; this plan itself is documentation only. |
| Files modified | 3, with one conditional fourth test file | Two production owners and the existing TUI exit test seam. |
| Files deleted | 0 | No compatibility artifact is being removed. |
| Production lines | 6-12 net | Route identity and formatter contract only. |
| Test lines | 50-85 | One reconnect/exit vertical slice plus invalid-route and normal-output assertions. |
| Generated lines | 0 | No protocol, SDK, migration, or generated output change. |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None for the requested `undefined` repair. The plan deliberately does not
guarantee a non-empty Session title when the browse metadata projection is
absent; the stable Continue identity is the confirmed failure contract.

### Rejected Speculation

- The daemon is not proven to crash or alter Session IDs. Logs show normal TUI exits, matching SSE disconnects, and later connections.
- The provider `sse.timeout` entries are provider-to-daemon requests and do not prove TUI SSE failure.
- Increasing `tuiClients` is not by itself a leak: the worker intentionally keeps the shared daemon alive while any SSE client or Session activity exists.
- Changing worker shutdown deadlines or forcing daemon termination would repair a different previously planned lifecycle issue, not this exit-summary identity defect.
- Preserving every filtered-out Session in `sync.data.session` would change browse semantics and is not required for the Continue ID invariant.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct the complete TUI/SSE/SyncProvider/ExitProvider path from repository evidence.
- Treat this investigation summary and logs as evidence to verify, not as implementation authority.
- Audit the route-identity repair, invalid-route handling, reconnect race test, no-fallback rule, ownership, and non-goal boundary.
- Check that no daemon lifecycle behavior is changed accidentally.
- Check under-design and over-design, including the conditional fourth test file.
- Check the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | None | NB-01, NB-02, NB-03 | APPROVE — plan revision R1 | independent adversarial-auditor task `ses_022f7d2aaffee7yATIY9DPvHBM` |

### Independent Audit Verdict (Copied)

No blocking findings.

Non-blocking findings:

- NB-01: Audit-mode metadata wording is broader than the handoff. The handoff specifies `Audit mode: plan`, while the canonical plan records `Audit mode: full-scope`. This does not weaken the audit; the requested review is explicitly full-scope, and the plan itself requires reconstruction of the complete TUI/SSE/SyncProvider/ExitProvider path.
- NB-02: The invalid-route clearing operation should be made mechanically explicit. Because `ExitProvider` retains the last stored message until explicitly replaced or cleared, implementation must explicitly clear or set `undefined`; merely skipping `formatSessionExitMessage` would leave a previously stored message alive. The plan's intended behavior is clearing.
- NB-03: The plan's evidence class for the exact reconnect-induced exit output is correctly marked reachable, not observed. The logs prove SSE disconnect/reconnect and normal ExitProvider completion, while the formatter probe separately observes the literal `undefined`; the route-level regression remains necessary.

Release verdict:

**APPROVE — plan revision R1.**

The plan is releasable for implementation planning approval only. It identifies
the observed `undefined` formatter operation, reconstructs the reachable
TUI/daemon reconnect projection race, repairs the owning Session-route identity
boundary, preserves daemon/SSE lifecycle behavior, forbids alternate success
paths, and defines behavior-sensitive verification.

This clean audit does not authorize implementation in the current turn. The
verbatim user requirement limits this turn to plan inspection.

Any substantive revision invalidates this revision and requires a new full-scope
audit.

## 23. Implementation Evidence

Not applicable. Implementation is prohibited for this revision.

## 24. Implementation Audit Record

Not applicable. No implementation is authorized.
-->

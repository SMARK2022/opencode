# Canonical Implementation Plan: Session-Scoped LSP Client Lifecycle

> Status: verified
>
> Revision: R16
>
> Approved revision: R16
>
> Audit mode: implementation (full-scope)
>
> Requirement source: Current Session GOAL and later verbatim scope decisions in section 1
>
> Implementation allowed: yes
>
> Last updated: 2026-07-20

This is the sole implementation authority. The adjacent
`lsp-client-lifecycle-session-isolation.audit-history.md` is a non-authoritative
record of superseded revisions and cannot authorize code.

## 1. Verbatim Requirement

> 当前需要解决右侧LSP列表过时等等问题。也就是理论上来说,已经过时或不可能再使用的,或者重复的TypeScript或者等等的LSP,应该自动有一个清理机制,也就是它不能只入库而不进行消费处理,销毁掉。同时修改内容仅限于此,不需要进行相应的诊断不可用等等的完整处理,当前已有相应的处理机制。同时确实由 read 启动,没有问题,这些内容都没有问题。我真正担心的是 LSP 显示的内容过于冗余,最大的问题是,其 LSP 相关服务显示跨越了各个的 session,理论上而言,不同 session 应该有着不同的相应内容,而不应该共享一套 LSP 列表。当前我看不同的 session 内容,它都共享了同一个 LSP 列表,导致最终结果极为混乱。譬如说,TUI或者 session A 工作在 A 项目工作区,B 工作在 B 项目工作区, B 所启动的 LSP 会在 A 的 session 中也显示,这是极其错误的行为。理论上来说,A只应该显示其工作目录或者工作的发起源在本项目内的 LSP,或者由本 session 启动的 LSP,而不应该显示其他的 LSP。请你注意这一点。与此同时,理论上而言,我觉得相应的LSP服务对于其销毁和处理机制,譬如说过时机制,应该有一定的相应逻辑流程。譬如说,整个项目在用户每发起一次,或者用户每发起一个prompt之后,它的LSP就应该适当进行处理。譬如说,用户的第一个任务已经完成了,它LSP列表里面当前存在着六个LSP服务。但第二次用户启动一个新的prompt,譬如说下面解决任务B,那么理论上来说LSP的相关内容就应该适当进行更新。譬如说,将LSP完整的内容进行刷新掉,这样就不会过于干扰或者让过时的一些文件的TypeScript等等命令过于占用相应的列表内容。。解决这两个问题，保持甜点级别的修复修正，尽量保持在整体生产代码修改不超过4个文件，测试不超过4个文件，且尽量修改已有而不是创建新的，同时修改量在600行以内，不计算报告在内。

> 请注意,修复范围不包括APP,即APP的所有内容不进行相应处理。我们的整体问题发生在TOI,也就是packages open_code里面,而不是packages app里面。因此,不要包含,或者不要对APP相应内容进行相应修改。这不是我们所必要和需要的内容。

> 请注意,四个生产文件,四个测试代码,这是最高上限,最好的是比这低,同时总修改量在六百行以内,不包含报告。请严格准确按照相应逻辑完整检查,找到精准修改链路,保持精准完美。优秀的修改,而不是大批量的冗余逻辑,和各种鲁棒性fallback全部往上堆。

> verified-implementation-and-commit

> 本次排除独立 CLI（推荐）

> 授权 R8 审计（推荐）

> 请你先报告。报告完之后,请你启动两个审计员充当R9进行审。

> 允许第五个生成文件

> 这不是blocker，请你继续下一个流程

> 不用审计了，审计已经通过了！！

> 以后都只有一个审计

The last statement explicitly answers the audit-limit exception prompt: for
this task only, exceeding six plan-audit rounds is not a blocker. All technical,
independence, scope, verification and implementation-audit gates remain intact.

## 2. Explicit Non-Goals

- Do not modify `packages/app`.
- Do not change Read lazy activation, LSP root/provider selection, diagnostics,
  Bash behavior, bridge failure policy, or patch-state retention.
- Do not add TTL/LRU/timers, persistence, migrations, dependencies, config,
  per-Session processes, a second registry, or a new HTTP endpoint.
- Do not synchronize standalone `opencode session delete` into another live
  daemon. Same-process daemon/TUI HTTP, Workspace, and recursive deletion remain
  covered.
- Do not exceed four handwritten production files plus the explicitly authorized
  fifth generated SDK file, four test files, or 600 changed lines excluding
  reports. Stop rather than adding a fallback or another file.
- Do not push. Commit only the verified task paths after implementation audit.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | Session has identity; InstanceState is directory-scoped, not Session-scoped. |
| root and package `AGENTS.md` | Minimal edits, package-local tests/typecheck, Effect/InstanceState rules, no fixed-sleep concurrency tests. |
| `.opencode/policy/first-principles-engineering.md` | First-divergence repair, no fallback, full mappings, independent audit, 15% Chinese comments. |
| `.opencode/templates/canonical-plan.md` | Required evidence, TDD, budgets, audit and implementation records. |
| `docs/plans/lsp-diagnostics-reliability.md` | Diagnostics are separate history and remain out of scope. |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `src/lsp/lsp.ts` | Directory State stores bare clients; no Session ownership or normal removal. | observed |
| `src/lsp/client.ts` | One client owns connection/diagnostics and idempotent shutdown. | observed |
| `src/lsp/server.ts`, `src/lsp/launch.ts` | Handle exposes typed child `exit`; no server file change is needed. | observed |
| `src/tool/read.ts` | Read forks LSP warmup into a long-lived Scope after successful reads. | observed |
| `src/session/prompt.ts`, `run-state.ts`, `effect/runner.ts` | Runner index is directory-scoped today; only globally admitted Idle work distinguishes a new run from a cross-State Running join. | observed |
| `src/session/session.ts` | Deletion emits existing typed event; Session stores directory/workspace. | observed |
| `src/control-plane/workspace.ts` | Warp can preserve persisted directory D while assigning Workspace W. | observed |
| Workspace routing middleware | Workspace target T overrides raw directory for Session Tool execution. | observed |
| `src/bus/index.ts`, `bus/global.ts`, `sync/index.ts` | Typed events reach module-local GlobalBus across daemon directory states. | observed |
| `src/effect/instance-state.ts` | Client state remains cache-isolated by directory and has scoped finalizers. | contracted |
| `src/cli/cmd/tui/context/event.ts` | Project filtering currently drops cross-Project LSP invalidation before SyncProvider. | observed |
| `src/cli/cmd/tui/context/sync.tsx` | One Project-level `lsp[]`; bootstrap and event each write unfiltered status. | observed |
| TUI sidebar/footer/status | All consume the same `sync.data.lsp`. | observed |
| TUI route/SDK/project contexts | Session Info has route ID, directory and workspace; SDK defaults to launch directory. | observed |
| existing LSP/prompt/sync/Workspace tests | Public seams and deterministic Deferred/process/transport fixtures exist. | observed |
| live `/lsp` A/B comparison | Different Session IDs receive the same directory-global row. | observed |
| fake-server stale-root harness | Deleted task A remains and accumulates with task B. | observed |

## 5. Current Behavior

```text
Session A Read(root A)
  -> directory State appends client(root A)
  -> /lsp returns every directory client
  -> TUI stores one unscoped array
Session B sees A; later root B yields A+B
root/process/Session end does not normally detach A
```

The list is runtime memory, not a database table. Workspace routing can place a
Session's Tool/LSP work in target T even when persisted Session directory is D.

The dirty worktree also contains a partial implementation produced after the
superseded R4 approval: numeric per-State generations, single-directory deletion
routing, owner rows and an initial TUI projection. It is not R13 evidence and
does not satisfy opaque tokens, all-State D/T retirement, closed-State admission,
cross-Project event routing, deletion/admission ordering or cross-State Running
join. R14 implementation
must replace and trim those hunks rather than stack a parallel path. The final
diff is still measured against `HEAD` and must be at most 600 lines.

## 6. Supported Domain and Reachability

| Condition | Reachable producer | Owner / disposition |
| --- | --- | --- |
| Two Sessions use same/different roots in one or different materialized states | concurrent/sequential daemon runs | LSP registry claims |
| New prompt from Idle; prompt while Running | SessionPrompt/Runner | new token / join pass-through |
| Read warmup outlives its run | detached Tool fiber | immutable run-token validation |
| Root disappears, child exits, or State disposes during init | filesystem/process/cache | registry cleanup and closed-State validation |
| Same-process HTTP/Workspace/recursive deletion | Session deletion event | materialized-state claim retirement |
| deletion races a run admission | DB removal + GlobalBus while Runner work starts | one lifecycle transition semaphore |
| Workspace routes persisted D to target T | sessionWarp + middleware | actual materialized owner state |
| D is Running when first warp routes another prompt to T | directory-local Runner maps | daemon-wide Runner identity with State-owned lifetime |
| D shell queues a Prompt submitted in T | Runner starts stored bare Effect from D shell fiber | bind queued work to caller's InstanceRef/WorkspaceRef |
| TUI route changes or owner changes while route stays active/cross-Project | route and routed `lsp.updated` invalidation | EventProvider + SyncProvider projection |
| VS Code Bridge selected | bridge touch/status | lightweight Session claim; no shutdown |
| Unscoped debug caller | no Session context | preserved aggregate branch |
| Standalone CLI deletes into another daemon | separate process | explicitly excluded |

## 7. Required Invariants

| ID | Invariant |
| --- | --- |
| INV-01 | TUI Session view contains only rows owned by that Session and requested through its directory/workspace. |
| INV-02 | One `(server, root)` client may be shared, with independent Session claims. |
| INV-03 | Daemon-wide Runner identity is authoritative for admission, join, ShellThenRun, busy checks and cancellation. Running joins do not reset LSP; queued or Idle work executes in its submitting Instance/Workspace, and genuine new work retires that Session across all materialized LSP states before installing one current-state token. |
| INV-04 | Final owner release shuts down; one owner cannot kill another's client. |
| INV-05 | Missing root, child exit, covered Session deletion, or state disposal removes impossible resources; disposed State cannot accept a late entry. |
| INV-06 | Detached/initializing old work cannot claim a newer generation, including after the Session moves from state D to T. |
| INV-07 | Client lookup/status remains directory InstanceState-isolated. |
| INV-08 | Read activation and server/root selection remain unchanged. |
| INV-09 | Sidebar/footer/status consume one route-owned snapshot: route identity change clears it synchronously, stale responses cannot overwrite it, and cross-Project LSP invalidation reaches the same refresh path. |
| INV-10 | Bridge visibility is Session-scoped without owning the external process. |
| INV-11 | Diagnostics behavior is unchanged. |
| INV-12 | Covered deletion retires the Session in every materialized state that actually holds a claim, including Workspace target T. |
| INV-13 | Public status emits at most one row per underlying client, with deduplicated owner IDs. |
| INV-14 | New-run admission and covered deletion are linearized: deletion before admission prevents install; deletion after admission retires the installed token. Slow shutdown is outside the transition lock. |

## 8. First Divergence and Feedback Signals

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| 01/02/04/13 | Bare `State.clients` has no owner identity. | LSP registry | no Session field or release transition |
| 03/06 | Session run provenance is absent; old warmup can observe later state. | LSP context + Prompt work boundary | detached Read + async bridge/spawn |
| 05 | Root/exit/deletion do not detach entries; disposal does not close a State before in-flight init resumes. | LSP lifecycle | stale-root and paused-init disposal reproductions |
| 09 | SyncProvider stores rows without route identity; Project-filtered events can drop cross-Project LSP invalidation. | LSP invalidation + TUI SyncProvider | A snapshot during blocked B request; B event behind old Project filter |
| 10 | Synthetic bridge row bypasses ownership. | LSP bridge projection | current status branch |
| 12 | Persisted D and Workspace target T can diverge; selecting one address misses claims. | LSP deletion handoff | warp + routing evidence |
| 14 | Retirement and later token install are separated by async shutdown, so deletion can miss the future token. | LSP lifecycle transition | controlled shutdown + concurrent deletion |
| 03/04 | Runner map is directory-local, so T can treat D-Running as Idle and retire an active D claim. | SessionRunState admission | first warp D Running -> prompt in T |
| 03 | Cross-State join without global cancel/busy lookup leaves control operations reading a second local identity. | SessionRunState control | D Running -> T cancel/assertNotBusy |
| 03/06 | Runner stores a bare T work Effect, then D shell fiber starts it with D context. | SessionRunState ShellThenRun handoff | D shell -> warp T -> queued Prompt executes in T |

Executed baseline red signals before the partial R4 implementation:

```text
session-a=[typescript]
session-b=[typescript]
FAIL: sessionID does not scope LSP status

afterTaskADeleted=[task-a]
afterTaskB=[task-a,task-b]
FAIL: stale task-a client remained
```

## 9. Responsibility and Seams

| Concern | Owner | Promise |
| --- | --- | --- |
| client identity/claims/shutdown | LSP registry | shared process, exact owner set, final-owner cleanup |
| run admission + new-run token | daemon-wide index in SessionRunState | cross-State join; only newly executed work performs LSP admission and inherits token |
| covered deletion | singleton LSP layer + daemon GlobalBus | retire Session in existing materialized states only |
| admission/deletion order | singleton lifecycle semaphore | DB existence check plus atomic in-memory transition; shutdown outside lock |
| LSP invalidation | existing LSP Bus publication -> TUI EventProvider | preserve typed/directory event and route this invalidation before Project filtering |
| active view | TUI SyncProvider | synchronous route invalidation plus request/filter/token for all renderers |
| public metadata | Status schema/generated type | one row with optional `sessionIDs` |

## 10. Single Primary-Path Design

```text
daemon-wide Session runner index admits work in current state T
  -> existing D Runner means join only, with no LSP transition
  -> genuinely Idle work creates opaque LSP token
  -> zero-arg lsp.init under owner context materializes T
  -> under lifecycle semaphore verify Session still exists
  -> atomically retire prior claims everywhere and install token only in T
  -> release semaphore, then shutdown detached final-owner clients
  -> supplied Prompt work and detached Tool fibers inherit token
  -> Read resolves existing server/root and claims shared entry only if token current
  -> changed owner metadata publishes existing directory-scoped lsp.updated
  -> status emits one row + sessionIDs
  -> SyncProvider requests active Session directory/workspace
  -> filter owner rows and reject stale response token
```

Registry entries hold `client`, `Map<SessionID, token>`, and existing unscoped
ownership. The current-generation map also stores tokens, not counters. Claim
validation happens after bridge resolution, root resolution, spawn/initialize,
and in-flight joins. A stale caller receives no client; an orphan entry follows
the same detach/shutdown path.

The singleton layer holds a private `Set<State>` only as a lifecycle address book.
Each successful InstanceState initialization adds its State and its finalizer
removes it. Client lookup/status never traverse this set. On a new executed run,
`withSession` retires that Session in every materialized state before installing
the token in the current state. On validated same-process
`Session.Event.Deleted`, the listener uses EffectBridge and retires it everywhere
without installing a replacement. Both transitions create no cache state, guess
no directory, handle D/T drift and prior multi-directory claims, and do not form
a process-global client registry.

Admission and covered deletion share one short lifecycle semaphore. Admission
checks the authoritative Session store while holding it, then performs all
in-memory retirement and current-State token installation as one transition.
Deletion performs all-State retirement under the same semaphore. Both return
detached clients and await their potentially slow shutdown only after releasing
the semaphore. Therefore a deletion whose DB removal wins makes later admission
fail, while a deletion event that follows admission necessarily retires its
already-installed token. No retry, tombstone registry or cancellation fallback
is introduced.

SessionRunState keeps one daemon-wide `Map<SessionID, Runner>` in its service
layer, while each InstanceState retains its own Scope and an identity-checked set
of Runners it created. Runner creation checks and installs the daemon map without
an intervening yield. D-State disposal cancels only entries it still owns and
removes them by exact identity. Consequently a prompt routed to T joins a D
Runner, while a genuinely idle Session creates work in T. `ensureRunning` wraps
only that executed work in LSP admission/token context; `prompt.ts` needs no task
diff and cannot accidentally refresh a Running join. `runner()`, `cancel`,
Runner-busy evaluation in `assertNotBusy`, `ensureRunning`, `startExclusive` and
`startShell` all consult this same daemon map. State-owned sets are lifecycle
handles only and never form a lookup fallback; local revert/exclusive markers
retain their existing purpose. Before passing work to Runner, `ensureRunning`
captures the caller's `InstanceRef` and `WorkspaceRef` and explicitly provides
both to the stored Effect. Therefore `ShellThenRun` may be started by D's shell
fiber but LSP admission, Prompt work and Tools resolve T. Idle work uses the same
binding; Running join never executes the submitted Effect.

State has a permanent closed transition. Its finalizer closes it before retiring
owners and shutting clients down. Every post-root/spawn/initialize/in-flight
validation checks both token and open State; a late entry follows unified detach
instead of reattaching. Root pruning runs before status/client selection.

The public Node child process supports `once("exit")`, `exitCode`, and
`signalCode`; use those typed signals instead of the erased launch-local
`exited` promise. Install the listener, then inspect the codes so both a process
that already exited and one that exits later detach the exact entry once. Detach
precedes shutdown so a late exit cannot remove a replacement. Bridge owner
changes publish the same existing Bus event but release never stops the bridge.

Keep the existing typed/local and directory/project GlobalBus publication intact
for App and other consumers. In TUI `useEvent`, route only `lsp.updated` to its
existing handler before the generic Project filter because it is an invalidation:
the handler still fetches and filters the active route. This is the same SDK
subscription and same event, not a parallel channel or alternate success path.

SyncProvider has one `refreshLsp`: non-Session routes clear; Session routes find
Session Info, synchronously clear only when the route identity differs from the
committed snapshot owner, request with directory/workspace, filter `sessionIDs`,
and commit only the latest monotonic request. A same-route event keeps the prior
snapshot while refreshing. Bootstrap, route reactivity and the globally routed
`lsp.updated` all use this function.

## 11. Secondary and Replacement Paths

| Path | Class | Disposition |
| --- | --- | --- |
| direct shared client | primary | implement |
| Bridge claim | supported branch | implement same token/notification semantics |
| unscoped debug | shipped compatibility | preserve; omitted from Session view |
| different InstanceStates | pass-through | preserve client isolation |
| same-process deletion fan-out | lifecycle branch | exact Session retirement only |
| standalone CLI cross-process delete | explicit non-goal | exclude |
| TTL, Project clear, per-Session process, second endpoint/registry | forbidden fallback | reject |

Alternate-success-path ratio: `0%`. Diagnostic decision change: `0%`.

## 12. Workaround Deletion

| Existing duplicate | Replacement |
| --- | --- |
| bootstrap direct `/lsp` writer | one `refreshLsp` |
| `lsp.updated` direct `/lsp` writer | same `refreshLsp` |
| renderer interpretation of global array | SyncProvider guarantees active view |

## 13. Forward Traceability

| Requirement | Production path | File | Test |
| --- | --- | --- | --- |
| Session isolation/dedup | token claims -> one status row | `lsp.ts`, generated type | shared A/B row |
| prompt refresh/join | globally admitted work -> all-state retire -> current-state token | `run-state.ts`, `lsp.ts` | D old claim/warmup -> T next run; concurrent join retains T |
| cross-State Runner control/context | daemon index + bound Instance/Workspace -> join/queue/cancel/busy | `run-state.ts` | D Running and D-shell/T-queued Prompt preserve one Runner and execute new work in T |
| stale warmup/init | inherited token -> all-state invalidation -> post-async validation | `lsp.ts` | old D warmup resumes after T token and cannot claim |
| final-owner cleanup | retire -> detach -> shutdown | `lsp.ts` | A release preserves B; B release removes |
| root/exit/disposal | prune/typed Node exit/closed State -> detach | `lsp.ts` | root delete, pre/post-listener exit, paused init disposal |
| Workspace D/T deletion | materialized states -> matching Session retire | `lsp.ts` | claim in T, persisted D event, T cleaned |
| deletion/admission race | shared transition semaphore -> existence/retire/install | `lsp.ts` | deletion before/after admission leaves no claim |
| owner change refresh | claim -> `lsp.updated` | `lsp.ts`, `sync.tsx` | current route empty then event refresh |
| cross-Project refresh | existing event -> LSP invalidation exception -> one refresh | `event.ts`, `sync.tsx` | B event carries another project but refreshes active B; non-LSP remains filtered |
| TUI route/race | route identity invalidation -> request/filter/token | `sync.tsx`, generated type | committed A clears while B blocked; late A rejection |
| Bridge | token claim/update, no process stop | `lsp.ts` | shared bridge row and reset |
| diagnostics/Read | unchanged | no behavioral edit | existing regressions |

## 14. Reverse Traceability

| Concept | Invariants | Why existing logic is insufficient |
| --- | --- | --- |
| owner map | 01/02/04/13 | bare clients cannot isolate or identify final owner |
| opaque run token/context | 03/06/08 | Session ID alone lets old work impersonate new run |
| daemon Runner index + State ownership | 03/04/05 | directory-local lookup admits/misses D/T work; process-global lifetime would break State disposal |
| bound queued-work context | 03/06/07 | a bare Effect stored by Runner inherits the later D shell fiber rather than submitting T |
| unified detach | 04/05 | ad hoc shutdown races replacement/other owners |
| closed State + post-async validation | 05/06 | cache disposal otherwise permits late orphan reattachment |
| materialized-state lifecycle address book | 03/05/06/07/12 | New run and deletion must invalidate prior claims across D/T; unmaterialized state cannot own a client |
| lifecycle transition semaphore | 05/06/12/14 | async shutdown otherwise leaves a deletion gap before token installation |
| owner-change publication | 01/09/10 | reuse/Bridge changes metadata without new process |
| `sessionIDs` metadata | 01/10/13 | TUI cannot infer owner from root/directory |
| LSP event routing exception | 01/09 | generic Project filtering drops active-route invalidation before SyncProvider |
| route snapshot owner/token | 01/09 | launch directory, committed old rows and async response order are insufficient |

## 15. File-Level Plan

### Production / Generated: authorized maximum 5

| File | Change | Estimate |
| --- | --- | ---: |
| `packages/opencode/src/lsp/lsp.ts` | claims, tokens, materialized-state deletion, cleanup, bridge/status/update | +155/-25 |
| `packages/opencode/src/session/run-state.ts` | daemon Runner index with State ownership; wrap only admitted work in LSP token | +30/-10 |
| `packages/opencode/src/cli/cmd/tui/context/event.ts` | route existing LSP invalidation before generic Project filter | +5/-1 |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | one active-route refresh/filter/token | +35/-8 |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | generator-owned optional `sessionIDs` | +1/-0 |

The fifth path is permitted only because it is the generated SDK type. If SDK
generation changes another generated file, stop; do not hand-trim output.

### Tests: hard maximum 4

| File | Change | Estimate |
| --- | --- | ---: |
| `packages/opencode/test/lsp/index.test.ts` | consolidated claims, notifications, D/T/deletion/disposal/root/exit/Bridge | +195/-5 |
| `packages/opencode/test/session/prompt.test.ts` | completed refresh and cross-State Running join | +32/-3 |
| `packages/opencode/test/cli/cmd/tui/sync-fixture.tsx` | real RouteProvider/navigation | +12/-2 |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | routing/filter/event/late response | +55/-2 |

No file is added. `prompt.ts`, `server.ts`, Workspace tests, App, and unrelated
complete LSP mocks must have zero final diff.

## 16. TDD Slices

1. Shared direct client: one row, two owners, one process.
2. Release A preserves B; release B shuts final client.
3. D owns old claim and paused warmup; next run in T removes D claim, installs
   only T token, and old warmup cannot reclaim.
4. Persisted D / materialized target T deletion removes T claim and preserves
   another owner; delayed work cannot restore it.
5. Block old-client shutdown while run admission races deletion in both orders;
   after release there is no token, row or live final-owner process.
6. Root removal and child exit remove public row/client; initialization paused
   during State disposal cannot attach after resume and leaves no live process.
7. New direct/Bridge claim publishes once; repeated same-token touch does not.
8. Completed prompt runs each initialize a scope; same-State and D-Running/T
   callers share one work and preserve D's active client. T-side cancel and busy
   checks hit D's Runner; D disposal cancels a D-owned Runner by exact identity.
   With a D shell active, a Prompt submitted after warp to T queues once and its
   admission/Read claims resolve only T, not D.
9. A first commits rows; switching to B clears A synchronously while B response
   is blocked, then B uses its directory/workspace and late A loses.
10. Cross-Project B starts empty and refreshes when B's Project-tagged underlying
   owner change reaches the existing LSP routing exception; no navigation or
   second subscription is used.

Tests observe public status, process lifetime, prompt results and `sync.data.lsp`.
They use Deferred/process/event/HTTP signals, not private maps, source text, or
fixed sleeps.

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | ---: |
| Effective changed lines `E` | 400 |
| Minimum qualifying Chinese comments `C` | 60 |

Comments must explain immutable run provenance, shared owner/process identity,
claim-change notification, detach-before-shutdown, materialized-state address
book versus client registry, same-process deletion boundary, Bridge ownership,
and TUI response token. Narrative comments do not count. Recalculate actual E/C.

## 18. Verification

All commands run from the named package directory.

| Command | CWD | Evidence |
| --- | --- | --- |
| `bun test --timeout 30000 test/lsp/index.test.ts` | `packages/opencode` | registry/lifecycle/token/deletion/Bridge |
| `bun test --timeout 30000 test/session/prompt.test.ts --test-name-pattern 'LSP ownership|concurrent loop callers'` | `packages/opencode` | Idle refresh and Running join |
| `bun test --timeout 30000 test/server/httpapi-session.test.ts --test-name-pattern 'abort|busy'` | `packages/opencode` | existing HTTP Runner control regression |
| `bun test --timeout 30000 test/cli/cmd/tui/sync.test.tsx --test-name-pattern 'LSP status'` | `packages/opencode` | active route/event/race |
| `bun test --timeout 30000 test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/lsp/client.test.ts` | `packages/opencode` | related LSP regression |
| `bun test --timeout 30000 test/session/prompt.test.ts test/session/snapshot-tool-race.test.ts test/tool/lsp.test.ts` | `packages/opencode` | prompt and unchanged fixture compatibility |
| `bun test --timeout 30000 test/cli/cmd/tui/sync.test.tsx test/cli/tui/use-event.test.tsx` | `packages/opencode` | TUI regression |
| `bun typecheck` | `packages/opencode` | package type safety |
| `./script/build.ts` | `packages/sdk/js` | generated SDK |
| `bun typecheck` | `packages/sdk/js` | generated type safety |
| rerun stale-root harness | `packages/opencode` | original accumulation fixed |

## 19. Diff Budget

| Metric | Limit / estimate |
| --- | --- |
| handwritten production files | 4 / exactly 4 |
| generated files | 1 / exactly 1 |
| test files | 4 / exactly 4 |
| files added | 0 |
| production/generated lines | about 270 |
| test lines | about 304 |
| generated lines | about 1 |
| total changed lines excluding reports | about 574 / hard maximum 600 |

Any sixth production/generated file, fifth test file, generator spread, or >600
result requires a new user decision.

## 20. Real Risks and Open Decisions

- Detached Read and spawn can cross run boundaries; immutable token is mandatory.
- Shared owners require final-owner, not current-owner, shutdown.
- Exit/reset/disposal can race; exact-entry detach precedes shutdown.
- D, envelope directory, and Workspace target T may differ; deletion must not
  guess one address.
- Materialized-state set must be finalizer-maintained, serve only run/deletion
  lifecycle retirement, and never serve client lookup/status.
- Owner changes without spawn require update publication.
- Project-filtered SSE requires an LSP invalidation routing exception in the
  existing TUI subscription while preserving typed Bus and App directory events.
- TUI route transition requires synchronous snapshot invalidation plus monotonic token.
- State disposal must close before shutdown and late async validation.
- Admission/deletion must linearize only in-memory transitions; never hold the
  semaphore across client shutdown.
- Runner identity is daemon-wide, but lifetime remains with the creating State;
  a global index must not create process-lifetime Runner leaks.
- ShellThenRun stores an explicitly bound Instance/Workspace Effect; it must not
  inherit the old shell fiber's directory when eventually started.
- Generated SDK has unrelated staged content; preserve it and stop if inseparable.

Open user decisions: none. App and standalone cross-process CLI are explicitly
excluded; commit and extra R9 audit are explicitly authorized by conversation.

Rejected: TTL, polling, persisted claims, one process per Session, Project-wide
clear, diagnostics expansion, new endpoint, second deletion event, directory
guessing, and test-only production exports.

## 21. Audit Contract

One independent auditor inspects the full revision and repository evidence.
Its blocking findings remain blocking. Audit must check all producers/consumers,
D/T routing, detached warmup,
claim notifications, authorized 5/4/600, App/CLI exclusions, no fallback, and Chinese
comment feasibility. The user explicitly removed only the six-round limit as a
blocker for this task; auditors must not relax any substantive finding.

## 22. Plan Audit Record

Superseded full text is in the non-authoritative audit-history report.

| Round | Revision | Result | Primary finding | Reference |
| ---: | --- | --- | --- | --- |
| 1 | R1 | BLOCK | Session deletion and then-current App scope missing | `ses_0860246afffeCxdKCdxZd34ct0` |
| 2 | R2 | BLOCK | duplicate deletion event; insensitive App test | `ses_085f2673dffe0Gwun19xx2MFNc` |
| 3 | R3 | BLOCK | Workspace deletion wrong InstanceState | `ses_085e54f26ffeHD6kLXdQMC4OeZ` |
| 4 | R4 | APPROVE | old App-inclusive soft-cap scope | `ses_085d38e6cffehSr05oadm19e0b` |
| 5 | R5 | BLOCK | owner attachment did not refresh TUI | `ses_0858fccf4ffeKTmxu9qSPi9on1` |
| 6 | R6 | BLOCK | detached warmup provenance; commit handoff omission | `ses_08587fe34ffeSX5CKl7TysRsUV` |
| 7 | R7 | BLOCK | standalone CLI cross-process delete; later excluded | `ses_08545a82bffeGbcuJpRFLgO2ud` |
| 8 | R8 | BLOCK | persisted D differs from Workspace target T | `ses_08525dd0effetbZ802Jr4P1TKM` |
| 9A | R9 | APPROVE | no blockers; noted final diff must be under 600 | `ses_0850a0ae9ffeCgj757ojXj6TIf` |
| 9B | R9 | BLOCK | next run in T did not retire old D claims/warmup | `ses_0850a0a77ffeal9U4sKGjdaJv6` |
| 10A | R10 | APPROVE | no blocker; recorded estimate arithmetic correction | `ses_085008ce6ffeOmxNIHnqFiSDlF` |
| 10B | R10 | BLOCK | cross-Project event filtered; old A visible while B request waits | `ses_085008c2bffeXgdekmXDivagYr` |
| 11A | R11 | BLOCK | global event breaks typed Bus and excluded App refresh | `ses_084f6a434ffeQuqJQhK9fzvnzV` |
| 11B | R11 | BLOCK | erased exit promise; disposal allows late reattachment | `ses_084f6a3e0ffeP6pSrnkWMdgXtK` |
| 12A | R12 | BLOCK | partial superseded implementation omitted from audit baseline | `ses_084e9f921ffehsrS4TvYuuthqp` |
| 12B | R12 | BLOCK | deletion can land between retirement and token install | `ses_084e9f8ebffeoiHwDFcXpxqTD7` |
| 13A | R13 | BLOCK | directory-local Runner admits D-Running/T duplicate work | `ses_084df5ddeffe2L2tCpJOk5VeYT` |
| 13B | R13 | APPROVE | no blocking findings | `ses_084df5dbdffeGX7NOD9IFarb8b` |
| 14A | R14 | BLOCK | daemon Runner admission omitted cancel/busy consumers | `ses_084d56977ffeQRRniQ6StOPHU0` |
| 14B | R14 | APPROVE | no blocking findings | `ses_084d568d2ffeHWOxigNzUtTKls` |
| 15A | R15 | BLOCK | ShellThenRun starts T work in D shell fiber context | `ses_084cd9c85ffetT9IGW0vgDK9MD` |
| 15B | R15 | BLOCK | ShellThenRun loses submitting Instance/Workspace | `ses_084cd9c42ffeAzuSm9lQWRfWwI` |
| 16A | R16 | BLOCK | no technical blocker; six-round limit lacked user exception | `ses_084c73cd0ffedg0COaZ5hTSIR9` |
| 16B | R16 | BLOCK | no technical blocker; six-round limit lacked user exception | `ses_084c73c90ffetUrlYWJjhAGgto` |
| 16C | R16 | APPROVE | no blocking findings; exact full-scope R16 | `ses_084bb9cb1ffey0SWRV71TJFkEX` |
| 16D | R16 | stopped | user stopped further plan audit and accepted approval | `ses_084bb9c71ffeWlIVkgKJ3JOqTH` |

## 23. Implementation Evidence

Exact approved R16 was implemented without changing its interface, owner, route,
fallback, file or behavior plan.

Files:

- handwritten production: `src/lsp/lsp.ts`, `src/session/run-state.ts`,
  `src/cli/cmd/tui/context/event.ts`, `src/cli/cmd/tui/context/sync.tsx`;
- generated: `packages/sdk/js/src/v2/gen/types.gen.ts` (`LspStatus.sessionIDs`);
- tests: `test/lsp/index.test.ts`, `test/session/prompt.test.ts`,
  `test/cli/cmd/tui/sync-fixture.tsx`, `test/cli/cmd/tui/sync.test.tsx`.

Red-capable evidence executed before repair:

- cross-State control expected target T to observe D's active Runner, but received
  idle (`Expected true`, `Received false`);
- D/T ownership retirement expected only Session B but received A and B;
- TUI route B expected an empty snapshot while B was blocked but still rendered
  A's TypeScript row;
- implementation audit B-01 reproduced an old and current generation waiting on
  one spawn: the stale claimant shut down the shared entry, emitted
  `Connection is disposed`, and left current status empty;
- implementation audit B-02 removed a root while its child was already started
  but before startup completed; the client was still registered and consumed,
  leaving `rootExists=false` and `processAlive=true`;
- implementation audit B-03 wrapped the exact child-exit client and observed an
  empty public row but `shutdowns=0`, proving detach-only cleanup leaked its
  JSON-RPC connection lifecycle;
- implementation audit B-04 proved the repository child-exit regression only
  observed row detach and therefore stayed green against B-03.

Green verification:

- LSP lifecycle/event suite: 17 pass, including shared/final ownership,
  D/T retirement, deletion/admission ordering, Bridge ownership, root removal,
  child exit, stale/current in-flight handoff, startup-time missing root and
  disposed-State orphan cleanup;
- full Prompt suite: 84 pass; Prompt plus unchanged snapshot/tool fixtures:
  89 pass; focused cross-State cancel, concurrent admission and ShellThenRun
  target-context tests each pass;
- full TUI sync suite: 17 pass; TUI plus use-event: 21 pass;
- HTTP abort/busy regression: 1 pass; related three-file LSP group: 58 pass;
- `bun typecheck` passes in both `packages/opencode` and `packages/sdk/js`;
- `OPENCODE_PROCESS_ROLE=main ./script/build.ts` completed in
  `packages/sdk/js`; no temporary `openapi.json` remains.

The original stale-root symptom is now covered by the real fake-server root
disappearance/child-exit test and the D/T retirement test; no separate harness
file exists in the repository. R16 concurrency checks use Deferred, process,
event and HTTP request signals rather than adding wall-clock waits.

Diff gates:

- exact shape: 4 handwritten production, 1 generated and 4 test files;
- physical selected-path diff: 640 lines; 40 generated `session.forked` lines
  pre-existed this task, so the exact task diff is 600 lines;
- effective changed lines `E = 400`; qualifying adjacent Chinese explanatory
  comments `C = 60`; required `ceil(400 * 0.15) = 60`;
- `src/session/prompt.ts`, `src/lsp/server.ts`, unchanged compatibility tests,
  `packages/app/**`, and standalone CLI have zero task diff;
- no TTL, polling, second registry/endpoint/event, Project-wide clear or
  diagnostics fallback was added.

Remaining gates: full-scope re-audit by the same single independent auditor and
the final commit. The generated file still contains pre-existing unrelated
`session.forked` hunks on the same path, so commit isolation must be resolved
without dropping or silently including another task's work.

## 24. Implementation Audit Record

| Round | Revision | Result | Primary finding | Reference |
| ---: | --- | --- | --- | --- |
| 1 | R16 implementation | BLOCK | B-01 stale claimant shut down a current waiter sharing one in-flight client | `ses_0845e50d0ffe58e3Ug2y7EcJvY` |
| 2 | R16 implementation | BLOCK | B-02 root vanished during startup but client was still registered and consumed | `ses_0845e50d0ffe58e3Ug2y7EcJvY` |
| 3 | R16 implementation | BLOCK | B-03 child exit detached the entry without client shutdown | `ses_0845e50d0ffe58e3Ug2y7EcJvY` |
| 4 | R16 implementation | BLOCK | B-04 child-exit test could not detect missing client shutdown | `ses_0845e50d0ffe58e3Ug2y7EcJvY` |
| 5 | R16 implementation | APPROVE | No blocking findings; full-scope R16 implementation verified | `ses_0845e50d0ffe58e3Ug2y7EcJvY` |

B-01 was repaired in the existing `State.spawning` owner path by retaining the
tokens waiting on each shared Promise and allowing orphan detach only when no
current waiter can claim the entry. The fake-server regression now drives a new
generation and the stale generation through the same blocked spawn, then proves
the current owner remains visible; the disposed-State branch still proves a
true orphan is shut down. All R16 verification and diff/comment gates were
re-run. Full-scope re-audit must continue in the same auditor session.

B-02 was repaired at the existing startup-to-registry boundary: after
`LSPClient.create` completes, the resolved root is revalidated before the entry
can enter `State.clients`; a missing root shuts down the still-unregistered
client. The fake-server test starts the child first, renames the root while the
startup handle is blocked, and proves the child exits before any `status()`
prune can hide the defect. The full verification matrix and all hard gates were
re-run after this repair.

B-04 was repaired inside the existing real-process lifecycle test. The test now
wraps the exact client returned by `LSPClient.create`, counts its shutdown, and
keeps polling until both the public row is absent and the root/process terminal
cases have each shut down their exact client. It therefore fails against the
detach-only B-03 implementation without adding a test-only production seam.
The complete verification matrix and hard gates were re-run.

Final independent verdict, recorded verbatim: `No blocking findings` and
`APPROVE`. The implementation is verified. Only the user-authorized commit
remains, subject to preserving unrelated same-path generated work.

B-03 was repaired by restoring the same exact-entry
`shutdown(detach(s, [entry]))` lifecycle used before the temporary diagnostic
change. The earlier `ERR_STREAM_DESTROYED` was traced to the test creating a
child only after its cwd had disappeared; the corrected test starts the child
before the controlled startup boundary. With that faithful ordering, child exit
and startup missing-root cleanup both pass through their intended terminal
paths. The full verification matrix and hard gates were re-run again.

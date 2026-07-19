# Canonical Implementation Plan: Session Runner Ownership and Tool Closure

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: implementation
>
> Requirement source: 当前 Session 中用户关于 Tool/sub-agent 无法闭合、TUI 持续转圈及 sub-agent 阻塞/所有权异常的原始要求
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-19

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

REQ-01:

> 当前它最后主agent好像在sub-agent的启动之后,主agent没有进行正常阻塞,导致主agent一直以为sub-agent被中断了,但实际上没有被中断。然后它就在那里一直运行,一直运行,一直运行,没有任何的结果,同时也让流程极其混乱。请你检查检查这到底是什么情况,为什么会发生这样的问题。

REQ-02:

> 也就是你现在需要调研的是上面的那个工具,还有subagent,不会正常闭合,并且它在TUI中状态显示仍然是在转圈的状态。第二个就是这个阻塞不正常,所有权转换奇怪的问题。

REQ-03:

> 解决这两个问题，保持甜点级别的修复修正，尽量保持在整体生产代码修改不超过4个文件，测试不超过4个文件，且尽量修改已有而不是创建新的，同时修改量在600行以内，不计算报告在内。

The requested outcome is one root-cause repair for each confirmed producer:

- Session-specific HTTP execution must retain one authoritative per-directory Run state owner, so sub-agent Tool execution blocks and cancellation act on the same Runner.
- A persisted reviewer Tool Part must reach a terminal state when its stream attempt is interrupted or otherwise exits before a completed decision Tool call.
- The TUI must stop spinning by consuming those authoritative terminal Part states, not through a new display-only inference.

## 2. Explicit Non-Goals

- Do not modify `Runner.ensureRunning`; it already provides single-flight behavior inside one Runner.
- Do not create a process-wide Run state singleton. Run state remains `InstanceState` scoped by Project/directory.
- Do not change synchronous `task` Tool blocking semantics, add `task_id` resume automatically, or convert foreground sub-agents into background jobs.
- Do not delete or weaken `MessageV2`'s compatibility projection of historical `pending`/`running` Tool Parts to an interrupted `tool_result` for Provider replay.
- Do not make the TUI inspect child Session Status or child Messages as a second source of truth for a parent `task` Tool Part.
- Do not alter remote Workspace proxying, local Workspace target selection, Workspace control-plane routing, or `/session/status`'s instance-scoped response semantics.
- Do not repair historical SQLite rows or add a migration. The implementation prevents new residue; historical maintenance is a separate explicit operation.
- Do not change `request_usage.status` accounting in this task. The observed orphan rows do not drive the Tool/sub-agent spinner.
- Do not broaden closure work to text/reasoning Part presentation; the confirmed persistence defect is an open reviewer Tool Part.
- Do not modify `src/v2`; `CONTEXT.md` identifies the current `session/` implementation as production while v2 parity is incomplete.
- Do not add dependencies, public SDK surface, configuration, generated files, or an ADR.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | A Session belongs to exactly one Project and working directory; Run state is a per-Session Runner map; `InstanceState` is keyed by Project/directory; canonical implementation is under `packages/opencode/src/session/`. |
| `AGENTS.md` | Tests and typecheck must run from `packages/opencode`; use `bun typecheck`, never root-level tests or direct `tsc`. |
| `packages/opencode/AGENTS.md` | Per-directory state belongs in `InstanceState`; do not replace it with ambient/global state; preserve Effect module and service conventions. |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | Request-derived directory ownership belongs in middleware-provided context; middleware may provide `WorkspaceRouteContext`/`InstanceRef`, not stable services. |
| `packages/opencode/test/AGENTS.md` | Public middleware tests should expose request context through tiny probe routes; concurrent tests must use readiness signals, not fixed sleeps. |
| `packages/opencode/test/server/AGENTS.md` | Compose middleware in production order and use focused Effect HTTP probe routes for routing/context policy. |
| `.opencode/policy/first-principles-engineering.md` | Repair the first divergence, forbid fallback paths, require a red-capable loop, traceability, and Chinese explanatory comments at `C >= ceil(E * 0.15)`. |
| `docs/adr/README.md` | This is a local repair preserving existing ownership architecture, not a new load-bearing architectural decision; no ADR is required. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `~/.local/share/opencode/opencode.db` queried read-only with `PRAGMA query_only=ON` | Proved two historical reviewer decision Tool Parts remained `pending` after their assistant Messages were aborted and completed; proved database integrity was `ok`. | observed |
| Incident Session `ses_08f3137e0ffeDS8uXy4fJtjjvn` in the same database | Proved one parent Session alternated between `/Users/sunbenteng/Project/opencode` and `/Users/sunbenteng/Project/opencode/thirdparty`, creating two independent execution waves, 16 new child Sessions, no `task_id` resumes, and up to four concurrent parent `task` Parts. | observed |
| Live `/session/status` requests against both directory scopes during investigation | Proved cancellation removed the parent from one Instance scope while the foreign directory scope still reported the parent/child as busy. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:145-199` | Session lookup currently contributes only `session.workspaceID`; the local plan still chooses query/header/cwd instead of `session.directory`. | reachable |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:23-42` | `WorkspaceRouteContext.directory` selects the loaded Instance context. | contracted |
| `packages/opencode/src/effect/instance-state.ts:27-53` | All instance-local services, including Run state, are cached by the provided directory. | contracted |
| `packages/opencode/src/session/run-state.ts:41-88` | Each InstanceState value owns a separate `Map<SessionID, Runner>`; the same Session ID in two directory contexts therefore gets two Runners. | reachable |
| `packages/opencode/src/effect/runner.ts:88-134` | One Runner joins subsequent `ensureRunning` calls to its existing work. | contracted |
| `packages/opencode/test/effect/runner.test.ts:89-113` | Existing test independently proves a second `ensureRunning` does not execute new work in the same Runner. | observed |
| `packages/opencode/src/tool/task.ts` | Foreground Task execution waits for the child result; no evidence of an internal non-blocking Task path was found. | reachable |
| `packages/opencode/src/session/prompt.ts:512-560` | Ordinary Session cancellation recursively closes open Tool Parts before completing assistant Messages. | contracted |
| `packages/opencode/src/session/processor.ts:930-981` | Ordinary stream cleanup terminalizes every remaining `pending`/`running` Tool Part. | contracted |
| `packages/opencode/src/session/message-v2.ts:1100-1144` | Historical open Tool Parts are projected as interrupted Provider tool results; this exposed the competing Runner but is not its source. | existing compatibility |
| `packages/opencode/src/permission/reviewer/service.ts:400-457` | Reviewer interruption completes only the assistant Message. | reachable |
| `packages/opencode/src/permission/reviewer/service.ts:610-742` | Reviewer stream attempts own an in-memory `toolParts` map and persist `pending` before adding the returned Part to that map; no attempt-exit cleanup exists. | reachable |
| `packages/opencode/src/session/session.ts:703-742` | `updatePart` may durably commit before returning; `getPart` provides the authoritative persisted Part by stable identity. | contracted |
| `packages/opencode/src/sync/index.ts:148-190,361-397` | Part projection commits in a synchronous transaction, then crosses interruptible event-conversion/publication Effects before `updatePart` returns. | reachable |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:3043-3121` | Parent Task spinner is exactly `props.part.state.status === "running"`; it does not infer state from the child Session. | contracted |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:303-328,534-543,983-1030` | TUI merge is terminal-monotonic and reconnect/full-sync can reload SQLite; the incident is not explained by a missing display event alone. | contracted |
| `packages/opencode/test/server/httpapi-session.test.ts` | Existing full production HttpApi fixture is the natural seam for replaying prompt, foreground Task, a second caller, and abort through conflicting directory hints. | reachable |
| `packages/opencode/test/server/httpapi-workspace-routing.test.ts` | Existing focused routing suite protects remote/local Workspace, control-plane, and no-Session behavior without requiring a new probe-only assertion. | contracted |
| `packages/opencode/test/server/httpapi-promptasync-context.test.ts` | Confirms request `InstanceRef` is inherited by detached prompt work and documents readiness-signal requirements. | contracted |
| `packages/opencode/test/permission/reviewer-service.test.ts` | Existing Provider-backed reviewer fixture captures persisted Parts and is the natural public seam for attempt-exit closure. | reachable |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-owner-red.test.ts` | Fresh public HttpApi tracer reproduced request-directory ownership drift. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/reviewer-closure-red.test.ts` | Fresh `PermissionReviewer.review` tracer models durable commit followed by a blocked `updatePart` return; interruption reproduced a persisted pending Tool outside the current map. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/foreground-task-owner-red.test.ts` | Fresh full production HttpApi tracer started a real foreground Task/child, submitted a second conflicting-hint prompt, and proved authoritative-directory abort could not stop the two wrong-directory owners. | observed |

## 5. Current Behavior

### Session ownership and sub-agent blocking

```text
Session-specific HTTP request
  -> WorkspaceRoutingMiddleware resolves Session
  -> only session.workspaceID enters planRequest
  -> no selected Workspace: query/header/process.cwd chooses directory
  -> InstanceContextMiddleware loads that directory's InstanceRef
  -> SessionRunState gets that directory's InstanceState Runner map
  -> same Session ID can execute in another directory's independent Runner
```

Within one Runner, a foreground `task` Tool blocks correctly. The incident used two different InstanceState values: while Runner A was blocked on its child, Runner B saw A's open parent Tool Part through persistence. `MessageV2` projected that historical open Part as interrupted to Runner B's Provider context, so the primary Agent emitted “The audit tasks were interrupted. Let me retry them” and started another wave. Cancellation routed through only one directory interrupted only one Runner; the other Runner and child fibers continued after their database Parts had already been marked aborted.

### Reviewer Tool closure

```text
PermissionReviewer.review
  -> runReviewerAgent persists assistant Message
  -> runReviewerStream receives tool-input-start
  -> persists permission_review_decision Tool Part as pending
  -> stream attempt is interrupted or exits before tool-call completion
  -> runReviewerAgent.onInterrupt completes assistant Message only
  -> pending Tool Part remains non-terminal in SQLite
```

### TUI consumption

```text
persisted parent Tool Part
  -> sync event / full Session sync
  -> sync.data.part
  -> Task.isRunning = parent part status === running
  -> InlineTool spinner
```

The TUI spinner is a faithful consumer of the parent Part it receives. The repair must make the producer state authoritative and terminal rather than teach the TUI to guess from child Session data.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Session-specific local request, Session exists, no Workspace, request directory differs from `Session.directory` | SDK/TUI HTTP client | Path contains a branded Session ID; request directory is only caller context | Session lookup succeeds, then current local plan uses request hint | `WorkspaceRoutingMiddleware` | observed |
| Two requests for that Session arrive with different directory hints | TUI/daemon clients | No middleware guarantee currently canonicalizes the hints | Each hint loads a different InstanceState and Runner map | `WorkspaceRoutingMiddleware` | observed |
| Prompt/Task execution and abort for one Session | Session HttpApi handlers | Both consume `InstanceRef` established by middleware | Correct only if both requests resolve the same authoritative directory | `WorkspaceRoutingMiddleware` | observed |
| Session has a selected local Workspace | persisted Session/Workspace | Workspace target owns forwarded local execution | Existing `planWorkspaceRequest` selects target directory | Workspace routing | reachable |
| Session has a selected remote Workspace | persisted Session/Workspace | Non-control requests proxy to the remote target | Existing `RequestPlan.Remote` branch | Workspace routing/proxy | contracted |
| Session-specific control-plane route | HTTP route policy | Must stay local rather than proxy | `shouldStayOnControlPlane` branch | Workspace routing | contracted |
| Request has no Session ID (`/session`, `/session/status`, `/session/preview`) | HTTP client | No persisted Session can supply directory ownership | Existing query/header/cwd or Workspace selection remains | Workspace routing | contracted |
| Session ID is absent from persistence | HTTP client | Handler owns eventual not-found response | Middleware catches `NotFoundError` and retains request fallback | Workspace routing | reachable |
| Reviewer emits `tool-input-start`, durable commit completes, then `updatePart` is interrupted before return | Provider stream + Session cancellation/timeout | `SyncEvent.run` commits before interruptible publication; current map registration follows return | Pending Tool Part exists in SQLite but not in the current attempt map | `PermissionReviewer` stream attempt | observed/reachable |
| Reviewer emits `tool-input-start`, then stream fails or drains without a valid decision call | Provider stream | Partial/incomplete tool streams are valid failure inputs; reviewer retry may start another attempt | Existing attempt exits without closing its pending map entry | `PermissionReviewer` stream attempt | reachable |
| Reviewer emits a valid decision Tool call | Provider stream | `tool-call` validates Assessment and writes `completed` | Existing completed state is already terminal | `PermissionReviewer` stream attempt | contracted |
| Historical open Tool Part is replayed to a Provider | Message persistence | Provider requires a matching tool result | `MessageV2` emits interrupted output-error compatibility result | `MessageV2` | existing compatibility |
| TUI renders a parent Task Tool Part | persisted Part/event sync | Parent Part status is authoritative | Spinner is true only for `running` | TUI Task component | contracted |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | For a resolved local Session-specific request, persisted `Session.directory` is authoritative over request query/header/cwd hints unless an existing Workspace forwarding branch owns execution. | `CONTEXT.md`; incident trace; fresh red tracers | Missing; planned full Session HttpApi test |
| INV-02 | One in-process Session execution resolves to one InstanceState Run state owner; concurrent starts join one Runner rather than execute a second work item. | `run-state.ts`; `runner.ts`; full foreground Task tracer | `runner.test.ts:89-113` proves the within-owner half; planned Session HttpApi test proves the composed behavior |
| INV-03 | Session abort resolves the same owner as Session prompt/Task execution, stops parent and child fibers, and terminalizes the parent Task Part. | Incident status split; prompt cancellation path; full foreground Task tracer | Planned Session HttpApi test plus existing prompt/Runner cancel tests |
| INV-04 | Every reviewer stream attempt terminalizes each Tool Part it created if that Part is still `pending` or `running` when the attempt exits; an already terminal decision remains the winner. | Ordinary processor/prompt cleanup; two database residues; fresh reviewer red tracer | Missing; planned reviewer tests |
| INV-05 | A user interruption records an aborted Tool error; a non-interrupted incomplete attempt records an incomplete-stream Tool error. Neither exit leaves a non-terminal reviewer Tool Part. | Existing processor error semantics | Missing; planned reviewer tests |
| INV-06 | Remote Workspace proxying, local Workspace target routing, control-plane locality, and no-Session request fallback remain unchanged. | Existing workspace routing contracts/tests | `httpapi-workspace-routing.test.ts` existing suite |
| INV-07 | TUI spinner state remains derived from the authoritative parent Tool Part and does not become a second lifecycle owner. | `index.tsx:3066,3101-3107` | Source contract; no production TUI change planned |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02, INV-03 | After resolving the Session, `routeHttpApiWorkspace` passes only `session.workspaceID` into `planRequest`; the local plan calls `defaultDirectory(request, url)` and discards `session.directory`. | `WorkspaceRoutingMiddleware` in `workspace-routing.ts:145-199` | Directory tracer received the request directory. Full production tracer then started a real foreground Task and child under one wrong hint, started a second Session prompt under another hint, and timed out after abort from the persisted Session directory could not reach either owner. |
| INV-04, INV-05 | Reviewer registers a Tool only after `updatePart` returns, although that call commits before interruptible publication. Interruption can therefore leave a durable unregistered `pending`; a completed commit can likewise leave a stale pending map value. Attempt exit also has no Tool cleanup. | `PermissionReviewer.runReviewerStream`; `Session.updatePart/getPart`; `SyncEvent.run` | Durable-return-barrier tracer expected stored `error` but received `pending`; two historical rows have the same assistant-completed/Tool-pending shape. |
| INV-07 | No divergence in TUI: it renders the non-terminal parent Part produced upstream. | TUI Task component | `spinner={isRunning()}`, where `isRunning` checks only parent Part status. |

Red-capable feedback loops were run against the current implementation from `packages/opencode`:

```text
$ bun test /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-owner-red.test.ts
Expected: "/tmp/authoritative-session-directory"
Received: "/tmp/request-cwd-directory"
0 pass, 1 fail

$ bun test /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/reviewer-closure-red.test.ts
Fixture durably stored the pending Part, then held updatePart before its return/map registration.
Expected: "error"
Received: "pending"
0 pass, 1 fail

$ bun test /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/foreground-task-owner-red.test.ts
Foreground Task and child reached their running readiness barrier.
Authoritative-directory abort returned HTTP 200, but both conflicting-hint prompt fibers failed to finish within 10 seconds.
TimeoutError
0 pass, 1 fail
```

Existing baselines were also run before planning:

```text
$ bun test test/server/httpapi-workspace-routing.test.ts
9 pass, 0 fail

$ bun test test/permission/reviewer-service.test.ts
11 pass, 0 fail
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Authoritative directory for a resolved Session request | `WorkspaceRoutingMiddleware` | Provide one correct `WorkspaceRouteContext` before any handler/Instance service runs | It already resolves Session and Workspace routing policy | Handlers, Run state, and TUI are downstream and cannot recover discarded ownership without duplicating routing logic |
| Single Runner and effective cancellation | Existing `SessionRunState` through the corrected `InstanceRef` | One Runner per Session in one InstanceState | Existing design is correct once requests reach one directory | A global Runner map would violate InstanceState boundaries and hide routing drift |
| Reviewer Tool attempt terminalization | `PermissionReviewer.runReviewerStream` attempt scope | No attempt exits while one of its own Tool Parts remains open | That scope owns the map, Provider events, and exact attempt exit | Outer Session prompt cleanup cannot see reviewer-local Parts reliably; TUI must not synthesize terminal state |
| Spinner rendering | Existing TUI Task component | Render parent Tool Part truth | It is a consumer, not lifecycle owner | Child Status inference would create a competing state machine |

Confirmed test seams:

- Full Session HttpApi behavior: use `Server.Default().app` with a persisted Session directory and two conflicting request-directory headers; start a real foreground Task/child, issue a second synchronous prompt, and abort through the persisted directory. Both prompt responses must complete with the same assistant ID, the LLM server must receive only the parent call plus one child call, the parent Task Part must be terminal, and the child assistant must be terminal.
- `PermissionReviewer.review` public behavior: after an observable persisted `pending` Tool Part, interruption or incomplete attempt exit must leave only terminal Tool Parts.

## 10. Single Approved Primary-Path Design

### Authoritative Session routing

```text
request -> resolve Session ID and Session -> resolve existing Workspace branch
        -> if local/control-plane and Session exists, use Session.directory
        -> otherwise preserve existing no-Session request fallback
        -> provide WorkspaceRouteContext -> load one InstanceRef -> use one Run state owner
```

Modify `planRequest` to receive the resolved Session information rather than only its Workspace ID. Preserve current Workspace selection and proxy decisions. At the final local/control-plane directory decision, prefer `session.directory` when Session resolution succeeded; call the current query/header/cwd fallback only when no Session exists. `workspaceRouterMiddleware`, which has no Session lookup, continues calling the same planner without a Session and therefore retains current behavior.

This repairs the first divergence before `InstanceContextMiddleware` loads any directory-keyed service. Prompt, foreground Task, Status within that Instance, and abort then share the existing Run state owner. No Runner or handler changes are needed.

### Reviewer attempt closure

```text
Provider attempt -> persist/open Tool Part -> Provider events may complete it
                 -> attempt exit cleanup examines that attempt's map
                 -> terminal Parts stay unchanged
                 -> remaining open Parts become one explicit error terminal
                 -> outer reviewer retry/fallback/interrupt continues normally
```

Replace the attempt map's mutable Part snapshots with stable `callID -> PartID` ownership. Allocate and register the Part ID before the first `updatePart`; if interruption occurs before commit, an authoritative lookup simply finds nothing, while interruption after commit can always find the durable Part. For input-end and completed decision transitions, resolve the current Part through `Session.Service.getPart` rather than trusting an in-memory pending snapshot. If a Provider emits a complete Tool call without a preceding input-start event, allocate/register its Part ID before that first durable write as well.

Attach one closure operation to the Provider stream attempt itself, inside the scope retried by `SessionRetry`, so every retry owns and closes only the stable identities it created. On attempt exit, call `getPart` for each registered ID and terminalize it only when the authoritative stored state is still `pending` or `running`. A durable `completed`/`error` winner is skipped even if its writing call was interrupted before returning. Use the existing Session interruption semantics for interrupted attempts (`TOOL_ABORTED_ERROR` and interrupted metadata/elapsed time), and the existing processor incomplete-stream semantic for a non-interrupted attempt that exits before Tool completion.

The cleanup is lifecycle finalization, not a fallback success path: it never manufactures an Assessment, never converts reviewer failure into allow/deny, and does not alter retry/fallback policy.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Resolved Session with no forwarding Workspace uses `Session.directory` | proposed | primary-contract branch | yes | Directory ownership only | add as primary local decision |
| Selected local Workspace target | current | primary-contract branch | yes | Workspace execution target | preserve |
| Selected remote Workspace proxy | current | primary-contract branch | yes | Remote forwarding | preserve |
| No Session / missing Session query-header-cwd directory | current | pass-through | yes | Requests with no resolved Session | preserve; do not use for resolved Session |
| Historical open Tool replay as interrupted Provider result | current | existing compatibility | yes | Provider message conversion only | preserve |
| Reviewer valid Tool decision | current | primary-contract branch | yes | Assessment production | preserve |
| Reviewer JSON text decision compatibility | current | existing compatibility | yes | Schema-valid Provider response compatibility | preserve; closure does not promote it |
| Reviewer retry/fallback to user/deny | current | primary-contract branch | conditional | Existing failure policy | preserve |
| Reviewer attempt-exit Tool terminalization | proposed | diagnostic/lifecycle finalization | no | Persistence terminal state only | add |
| TUI infers parent completion from child Session | proposed nowhere | forbidden fallback | yes | Would override lifecycle truth | reject |
| Process-global Session Runner registry | proposed nowhere | forbidden fallback | yes | Would bypass directory ownership defect | reject |

New alternate success paths are forbidden. No rollback was requested.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| None in production. `MessageV2` historical interruption projection is Provider compatibility, not a workaround. | Provider APIs require every historical tool call to have a result. | Correct owner routing prevents a live foreign Runner from being mistaken for historical interruption; compatibility remains necessary for genuinely old rows. | Preserve `message-v2.ts:1133-1144`. |
| None in TUI. The spinner directly reflects parent Part status. | Parent Part is the lifecycle contract. | Producer terminalization makes the existing consumer correct. | No TUI change. |
| Reviewer outer `onInterrupt` currently completes only the Message. | It repaired dangling assistant Messages after timeout. | Extend closure at the attempt owner; do not remove Message finalization. | Preserve `runReviewerAgent` Message closure; centralize Tool closure in `runReviewerStream`. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01; INV-01 | Session lookup -> route plan -> `WorkspaceRouteContext.directory` | `workspace-routing.ts`: carry resolved Session into the local directory decision | Full production Session HttpApi test starts through conflicting directory hints and aborts through persisted Session directory |
| REQ-01; INV-02 | Correct route context -> one InstanceRef -> existing one Runner -> foreground Task waits for child | Same routing change; no Run state/Task change | Two synchronous prompts return the same assistant ID and LLM call count proves the second caller did not execute new work; existing `runner.test.ts` retains unit coverage |
| REQ-01; INV-03 | Prompt/Task and abort route through the same Session directory -> recursive cancel | Same routing change | Authoritative-directory abort releases both prompt callers, terminalizes parent Task Part, and leaves no incomplete child assistant |
| REQ-02; INV-04 | Register stable Part identity before durable write -> attempt-exit authoritative lookup -> terminal Part | `permission/reviewer/service.ts`: stable identity registry plus `getPart`-based closure | Interrupt after durable pending commit but before creating `updatePart` returns; stored state becomes `error` |
| REQ-02; INV-05 | Authoritative current Part -> completed winner or incomplete/interrupted terminal error -> existing retry/fallback | Same reviewer change | Incomplete attempt leaves no open Part; interruption after durable completed commit does not overwrite `completed` from a stale pending snapshot |
| REQ-02; INV-07 | Persisted terminal parent Part -> sync -> current spinner predicate | No TUI production change | Reviewer/route producer tests and related typecheck; source predicate remains unchanged |
| REQ-03 | Minimal changes at two owners and two existing tests | Four-file plan | Diff/stat and E/C verification |
| INV-06 | Existing Workspace/no-Session branches | Preserve current planner ordering outside resolved local Session precedence | Existing full workspace-routing test file remains green |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Resolved Session object reaches route planning | REQ-01 | Current code resolves it but drops `directory`; red tracer | Passing only Workspace ID cannot recover Session directory at the local decision |
| Session directory precedence at the current local plan | REQ-01 | Session belongs to one working directory; duplicate Runner incident | Downstream InstanceContext can only load the directory it receives and must not repeat Session lookup |
| Stable attempt-owned Part ID registry before first durable write | REQ-02 | Durable commit precedes interruptible publication and current post-return map registration | Mutable snapshots registered after return cannot represent every durably created Part or the latest winner |
| Authoritative `Session.getPart` reads for attempt transitions/closure | REQ-02 | Public Session service already owns durable Part lookup | An in-memory pending snapshot can be stale after a completed write commits but is interrupted before returning |
| Distinct interrupted vs incomplete-stream terminal error metadata | REQ-02 | Existing prompt/processor semantics | A generic completed result would misrepresent failure; leaving open status is the reported defect |

No other production concept is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` | modify | Carry resolved Session into `planRequest`; prefer `Session.directory` only at the existing local/control-plane decision while preserving Workspace/no-Session branches. | +10 / -3 |
| `packages/opencode/src/permission/reviewer/service.ts` | modify | Register stable Part IDs before first persistence, read authoritative Parts for later transitions/exit cleanup, terminalize only stored open Parts on interruption/failure/incomplete drain, and preserve durable terminal winners. | +45 / -8 |
| `packages/opencode/test/server/httpapi-session.test.ts` | modify | Extend the existing production server fixture with `TestLLMServer`; run two conflicting-hint synchronous prompts through a real foreground Task/child, abort through the persisted directory, and assert same assistant, one work owner, parent terminal Part, and child terminal Message. | +125 / -0 |
| `packages/opencode/test/permission/reviewer-service.test.ts` | modify | Extend Provider-backed fixtures with a durable store and commit-before-return barriers; assert pending-commit interruption closes, completed-commit interruption preserves the winner, and incomplete attempts leave no open Parts. | +115 / -0 |

Implementation scope: 2 production files, 2 existing test files, no new implementation files, no generated files, no migration.

## 16. TDD Behavior Slices

Use one confirmed seam and one vertical behavior slice at a time.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Real foreground Task starts under hint B; a second synchronous prompt under hint C starts another owner; abort through persisted directory A returns 200 but both requests time out | Session lookup discards `session.directory`, so prompt B, prompt C, and abort A use three InstanceState values | Carry Session into current planner and choose A in the local branch | Both prompts join one parent/child execution, abort reaches it, both callers receive the same assistant, parent Task closes, and child stops |
| 2 | Fixture durably commits `pending` then blocks the creating `updatePart` before return; interruption leaves stored state `pending` | Identity is added to the current map only after the blocked call returns, and outer interrupt finalizes Message only | Register Part ID before write; attempt cleanup uses `getPart` and writes aborted `error` | Commit/publication interruption cannot orphan a durable Tool Part |
| 3 | Fixture durably commits `completed` then blocks that `updatePart` before return | A future map-snapshot cleanup could overwrite the winner with stale `pending` | Authoritative exit lookup observes `completed` and performs no write | Terminal winner survives return-time interruption |
| 4 | Reviewer attempt drains/fails after `tool-input-start` without a valid call; one or more retry-attempt Parts remain open | No attempt-exit finalizer exists | Every attempt closes its own authoritative open Part before retry/fallback proceeds | Partial Provider streams cannot accumulate dangling Tool Parts |
| 5 | Run the complete existing Workspace, Session prompt, Runner, reviewer, and Message replay suites | Repair touches shared routing/closure boundaries | No further production behavior; fix only discovered regressions within approved semantics | Remote/local Workspace, HTTP context inheritance, single-flight, cancellation, valid reviewer decisions, and Provider replay compatibility |

Tests observe public HttpApi and service behavior. The foreground Task test uses Provider-request count only as an observable proof that two public prompt callers shared one execution; its primary assertions are same response identity and terminal parent/child persistence after public abort. It waits for the real parent Task Part and second persisted user Message as readiness barriers, not fixed sleeps. Reviewer tests model the production `updatePart` contract with an independently owned durable store: each barrier opens only after storage mutation and before the Effect returns, and assertions read that store through the same public `getPart` seam. They do not inspect private helpers or assert internal call counts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 255 | Estimated added/substantively modified production and test code; excludes imports, blank lines, formatting, and this plan |
| Required Chinese explanatory comments `C` | 39 | `ceil(255 * 0.15) = 39`; recalculate against the actual diff before implementation audit |

Planned nearby qualifying explanations:

- In routing production code, explain why persisted Session directory outranks caller directory hints only after Session resolution, and why Workspace forwarding keeps precedence.
- In reviewer production code, explain why identity registration precedes the first durable write, why every transition/cleanup re-reads authoritative storage, why cleanup lives inside each Provider attempt/retry scope, and why interruption metadata differs from incomplete-stream failure.
- In the Session HttpApi test, explain the three-directory topology, why same assistant identity proves join, why two Provider calls mean only the parent and its child executed, and why terminal parent/child persistence proves abort reached the real owner.
- In reviewer tests, explain the commit-before-return barrier, why pending and completed barriers cover opposite sides of the race, and why assertions use the durable store rather than callback completion.
- Distribute at least 39 substantive Chinese comment lines beside those decisions. Do not count translated identifiers, obvious control flow, repeated test names, or split filler.

If actual `E` differs, implementation must satisfy `C >= max(1, ceil(E * 0.15))`; scope drift cannot be hidden by comment arithmetic.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/server/httpapi-session.test.ts` | `packages/opencode` | New full production HttpApi foreground Task/single-owner/abort/closure regression passes with existing Session API contracts. |
| `bun test test/server/httpapi-workspace-routing.test.ts` | `packages/opencode` | Existing local/remote/control-plane/no-Session routing contracts remain unchanged. |
| `bun test test/permission/reviewer-service.test.ts` | `packages/opencode` | New interruption/incomplete-attempt closure slices and valid reviewer behavior pass. |
| `bun test test/effect/runner.test.ts` | `packages/opencode` | Existing one-Runner single-flight and cancel semantics remain correct. |
| `bun test test/session/message-v2.test.ts` | `packages/opencode` | Existing historical open Tool replay compatibility remains intact. |
| `bun test test/server/httpapi-promptasync-context.test.ts` | `packages/opencode` | Request context still reaches detached prompt work. |
| `bun test test/server/httpapi-session.test.ts test/server/httpapi-workspace-routing.test.ts test/server/httpapi-promptasync-context.test.ts test/effect/runner.test.ts test/permission/reviewer-service.test.ts test/session/message-v2.test.ts` | `packages/opencode` | Combined regression run detects cross-fixture/global-state interference. |
| `bun typecheck` | `packages/opencode` | Package TypeScript/Effect contracts pass. |
| `bun run build` | `packages/opencode` | Package build passes after shared middleware/service changes. |
| `git diff --check -- packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts packages/opencode/src/permission/reviewer/service.ts packages/opencode/test/server/httpapi-session.test.ts packages/opencode/test/permission/reviewer-service.test.ts` | repository root | No whitespace errors in approved implementation files. |

No lint script exists in `packages/opencode/package.json`. No SDK generation, database generation, migration, or config validation is applicable because those surfaces do not change.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 implementation files | Plan/report excluded; modify existing owner and test files only |
| Files modified | 4 | 2 production + 2 tests, within the user's 4/4 preference |
| Files deleted | 0 | No obsolete implementation path is introduced or removed |
| Production lines | about 60 gross lines | One routing precedence change and one stable-identity/authoritative reviewer closure operation |
| Test lines | about 240 gross lines | Full foreground Task HttpApi topology plus three deterministic Provider-stream/race cases |
| Generated lines | 0 | No generated surface changes |
| Total gross implementation delta | about 300 lines | Below the requested 600-line preference with contingency for formatting/comments |

The budget is an audit signal, not permission to omit confirmed behavior. Any need to modify a fifth production/test file or exceed 600 gross changed lines is plan drift and requires a revised, re-audited revision before implementation.

## 20. Real Risks and Open Decisions

### Real Risks

- `WorkspaceRoutingMiddleware` also handles remote and local Workspace targets. Changing precedence too early could bypass proxying; the design therefore changes only the final local/control-plane directory decision and reruns the complete routing suite.
- `workspaceRouterMiddleware` is used by raw routes and does not resolve Session. The planner signature must preserve its no-Session behavior rather than requiring a Session service everywhere.
- The full foreground Task regression uses the production lazy server and directory-scoped InstanceStore. It must reset database/instances and use published Message/Part readiness barriers so a passing result cannot depend on request timing or leaked global state.
- Provider streams are retried. Cleanup outside the retried attempt would miss Parts from earlier attempts; the stable identity registry and closure must live inside each attempt.
- `Session.updatePart` commits before interruptible publication and return. Identity must be registered before the first write, and all cleanup must query `Session.getPart`; otherwise pending writes can be invisible or completed writes can be overwritten from stale snapshots.
- Test fixtures use global database/runtime services. The combined regression command is required to detect cleanup leakage or order dependence.

### Open Decisions Requiring the User

None. The persisted Session directory and existing reviewer terminal semantics provide authoritative behavior without a product-policy choice.

### Rejected Speculation

- A broken `Runner.ensureRunning` was rejected: source and an existing behavior test prove same-Runner calls join.
- Foreground `task` being intentionally non-blocking was rejected: the task path awaits the child; observed overlap came from separate Runner owners.
- TUI event loss as the primary cause was rejected: terminal-monotonic merge, reconnect full sync, and SQLite reload exist, while the incident showed genuinely live foreign fibers and non-terminal persistence.
- Child Session Status as a better spinner source was rejected: it would create a second lifecycle truth and cannot repair cancellation ownership.
- `request_usage.status='running'` as the Tool spinner source was rejected: those rows had no assistant records and the TUI Task spinner reads Tool Part state directly.
- A database migration/automatic historical repair was rejected: the request concerns runtime closure and ownership; mutating old user data requires separate authorization and policy.
- A global Session Runner registry was rejected: it would violate the established per-Project/directory InstanceState model and mask incorrect request routing.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: original foreground Task blocking/cancel path lacked composed behavioral verification | Audit-mode metadata; ambiguous red wording | BLOCK | `ses_0860f4e62ffeOmEJkm96f5vG2u` |
| 2 | R2 | yes | B-01: durable Part commit could precede attempt registration and escape map-based cleanup | Temporary tracer stability | BLOCK | `ses_08603b7deffe0XlWE3kVJyECI7` |
| 3 | R3 | yes | none | none | APPROVE | `ses_085fae1ebffeJoQ3T9ihoRinRJ` |

### Round 1 Independent Verdict (Verbatim)

## Blocking findings

### B-01 原始 foreground Task 阻塞与取消场景缺少行为验证

- Violated invariant: `INV-02`、`INV-03`，以及 first-principles policy 要求同时验证最小根因和原始用户可见场景。
- Evidence class: contracted
- Producer and execution path: 两个携带不同 directory hint 的 Session HTTP 请求 → `WorkspaceRoutingMiddleware` → `WorkspaceRouteContext` → `InstanceContextMiddleware` → directory-scoped `SessionRunState` → foreground `TaskTool` 等待子 Session；随后 abort 请求必须命中同一 Runner 并使父 Task Part 进入终态。
- Source evidence:
  - `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:190-198`
  - `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:27-33`
  - `packages/opencode/src/session/run-state.ts:47-88`
  - `packages/opencode/src/tool/task.ts:456-485`
  - `packages/opencode/src/session/prompt.ts:450-482`
  - `.opencode/policy/first-principles-engineering.md:220-231`
- Canonical-plan evidence: Sections 13、16、18。计划中的新增路由测试只检查 `WorkspaceRouteContext.directory`；已有 Runner 测试只检查一个既定 Runner 内的 single-flight。Section 18 的两个临时 tracer 同样分别止于 directory context 和 reviewer Part 状态，没有重放 foreground Task、第二次启动及跨 hint abort 的完整反馈环。
- Responsibility owner: `WorkspaceRoutingMiddleware` 建立 Session directory 所有权；完整回归验证应穿过 `InstanceContextMiddleware`、`SessionRunState` 和 foreground `TaskTool`/abort 的实际组合边界。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当前计划允许实现只让探针看到正确 directory，并依靠彼此独立的 Runner 单元测试推断最终行为。它没有证明真实 HTTP prompt/Task 与 abort 在冲突 directory hint 下共享同一 Runner，也没有证明第二次启动会 join、父 Task Part 会闭合、子 fiber 会停止。原始“主 Agent 持续运行、误判 sub-agent 中断、TUI 一直转圈”的回归可以在计划要求的测试全部通过时仍未经过验证。
- Why this is not speculative: 这是用户明确报告的生产行为，也是计划在 `INV-02`、`INV-03` 中承诺修复的执行链；当前源码证明 foreground Task 会阻塞等待子 Session，取消则依赖当前 InstanceState 中的 Runner。
- Minimal correction direction: 在现有测试文件内补充一个穿过生产 middleware 组合和真实 Run state 控制面的回归场景：使用冲突的 Session directory hints 启动同一 Session 的阻塞执行，证明后续启动不会产生第二个 work owner，并证明另一个 hint 发出的 abort 能终止同一执行且父 Task Part 达到终态。该验证必须覆盖原始阻塞/闭合结果，不能只断言 route context 或内部调用次数。

## Non-blocking findings

- Canonical metadata 的 `Audit mode` 写为 `full-scope`，而本次输入明确指定 `Audit mode: plan`。当前状态、Revision 和 implementation gate 仍然一致，因此这是记录准确性问题，不单独阻塞。
- Section 16 第一个 “Red behavior” 写成“exposes B”，容易被读成预期断言；同节后文和 Section 14 已明确独立期望值为 persisted directory A，执行方向仍可判定。

## Rejected speculation

- 没有证据支持修改 `Runner.ensureRunning`。同一 Runner 的 join 行为由 `runner.ts:120-143` 和已有 Runner 测试覆盖。
- 没有证据支持在 TUI 中从 child Session 推断父 Task 完成。`index.tsx:3066-3107` 明确以父 Tool Part 为 spinner 真值。
- 没有证据支持全局 Runner registry。`InstanceState` 和仓库领域契约要求 Run state 保持 Project/directory scoped。
- 没有证据要求迁移或自动修复历史 SQLite 行；本需求可以通过阻止新残留完成。
- 没有证据要求改变 foreground `TaskTool` 的同步等待语义；`task.ts:462-485` 已直接等待 `runTask()`。

## Requirement and traceability coverage

- `REQ-01` 的根因和 owner 已定位：resolved Session 的 `directory` 在 `workspace-routing.ts:197` 被丢弃，随后 directory-keyed InstanceState 可产生两个 Runner。
- `REQ-02` 的 reviewer Tool Part 闭合路径具备 reachable evidence：`service.ts:680-690` 创建 pending Part，而 `service.ts:783-805` 的 attempt exit 当前未终态化该 map。计划把清理放在每次 Provider attempt 内，能够覆盖 interruption、failure、drain 和 retry。
- `REQ-03` 的范围预算满足要求：2 个生产文件、2 个现有测试文件，预计约 200 行，未新增依赖、迁移、SDK 或 TUI 生产改动。
- Forward/reverse traceability 对 routing precedence 和 reviewer attempt closure 基本完整；阻塞缺口是 `INV-02`、`INV-03` 到原始 foreground Task/abort 行为反馈环的映射。
- Chinese-comment 计划承诺 `E≈150`、`C≥23`，算术为 `ceil(150 × 0.15)=23`，并承诺按实际 diff 重算。计划阶段具备可行性；实际数量留待 implementation audit。
- 计划提出的代码形状符合仓库 locality 和 Effect 约束：修复现有 middleware owner 与 attempt owner，没有新增模块、公共接口、配置或依赖。

## Primary-path and fallback verdict

Session ownership修复位于第一个错误转换处：resolved Session 信息进入既有 planner，Workspace forwarding 保持优先，最终 local/control-plane directory 使用 `Session.directory`。这是一个 authoritative routing path。

Reviewer closure属于 attempt lifecycle finalization，不产生 Assessment，也不把失败转换成成功。现有 JSON decision compatibility、Provider retry 和 fallback-to-user/deny 没有被扩展。

未发现新增 fallback、第二套 Runner、TUI 状态推断或 catch-and-default success。主路径设计可接受；原始执行链验证尚未满足硬门。

## Release verdict

**BLOCK**

R1 需要补齐 foreground Task 在冲突 directory hints 下的实际 single-owner、阻塞、abort 和父 Tool Part 闭合反馈环，然后进行下一轮完整范围 plan audit。

### Round 2 Independent Verdict (Verbatim)

## Blocking findings

### B-01 Reviewer Tool Part 的持久化早于 attempt-local 登记，计划中的清理仍可遗漏已落库的 `pending` Part

- Violated invariant: `INV-04`、`INV-05`、`REQ-02`；每个 reviewer stream attempt 创建的 Tool Part 都必须在 attempt 退出时进入终态，已经持久化的 Part 不能脱离 attempt cleanup 的所有权。
- Evidence class: reachable
- Producer and execution path: Provider 发出 `tool-input-start` → `runReviewerStream` 调用 `sessions.updatePart` 写入 `pending` → `SyncEvent.run` 在事务中提交 SQLite → 随后等待事件转换和 Bus 发布 → 外部取消或 per-attempt timeout 可在该等待期间中断 fiber → `toolParts.set(event.id, part)` 尚未执行 → 计划中的 map-based attempt cleanup 看不到已经落库的 `pending` Part。
- Source evidence:
  - `packages/opencode/src/permission/reviewer/service.ts:680-690`
  - `packages/opencode/src/session/session.ts:703-711`
  - `packages/opencode/src/sync/index.ts:168-190`
  - `packages/opencode/src/sync/index.ts:361-397`
  - `packages/opencode/src/permission/reviewer/service.ts:707-734`
- Canonical-plan evidence: Sections 7、10、16、20。Section 10 要求 cleanup “Re-read/check each map value's current state”；Section 20 同样只要求检查 “latest map value”。计划没有关闭 durable write 与 `toolParts.set` 之间的所有权窗口。计划中的 interruption 测试在观察到 mock `updatePart` 写入后再中断；当前 mock 是同步返回，也无法覆盖生产 `SyncEvent.run` 的事务提交后异步发布窗口。
- Responsibility owner: `PermissionReviewer.runReviewerStream` 的 attempt lifecycle。该作用域同时拥有 Provider event、attempt-local Tool identity 和退出清理。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 实现按当前计划完成后，用户取消或 reviewer timeout 仍可能在 SQLite 留下新的 `pending` `permission_review_decision` Part，继续形成不会闭合的 Tool 状态和 TUI 转圈。相同窗口也存在于 valid `tool-call` 的 completed 写入与 `toolParts.set` 之间，清理可能依据 stale `pending` map value 覆盖已经持久化的 completed winner。
- Why this is not speculative: `SyncEvent.run` 明确先在 `Database.transaction` 中提交 projector 结果，再通过两个可中断的 Effect 边界等待 `convertEvent` 和 Project Bus 发布。外部 Session cancellation 和计划采用的 per-attempt timeout 都能在这些边界中断 reviewer fiber。该路径不依赖异常输入或未来调用者。
- Minimal correction direction: 在 reviewer attempt owner 内关闭“durable Part 已创建、attempt registry 尚不可见”的窗口，并让 cleanup 根据权威的最新 Part 状态判断是否终态化。补充一个可红测试，在 `pending` 已经 durable commit、但创建调用尚未完成登记时触发 interruption；同时锁定 completed winner 不被 stale attempt 状态覆盖。不得通过 TUI 推断或额外成功路径补偿。

## Non-blocking findings

- Section 18 把三个 `/var/folders/...` 临时 tracer 列为实现后的必跑命令。它们目前存在，但临时目录不属于仓库稳定验证面。计划中的两个仓库内回归文件已经能够承载相同行为；实施记录应以仓库测试作为可重复的发布证据。该记录问题不改变当前行为设计，因此不单独阻塞。
- `E≈225`、`C≥34` 的计算满足 `ceil(225 × 0.15)=34`。计划明确要求按实际 diff 重算，并把中文解释性注释分布在 routing、reviewer lifecycle 和并发测试决策附近；计划阶段可行。

## Rejected speculation

- 没有证据支持修改 `Runner.ensureRunning`。同一 Runner 的 join 行为由 `packages/opencode/src/effect/runner.ts:120-143` 实现，问题来自同一 Session 被路由到多个 directory-scoped `InstanceState`。
- 没有证据支持 process-wide Runner registry。`InstanceState` 和领域契约要求 Run state 保持 Project/directory scoped。
- 没有证据支持让 TUI 从 child Session Status 推断父 Task 完成。`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:3066-3107` 明确以父 Tool Part 为 spinner 真值。
- 没有证据支持改变 foreground `TaskTool` 的同步阻塞语义。`packages/opencode/src/tool/task.ts:456-485` 直接等待 child Session 的 `runTask()`。
- 没有证据要求迁移或自动修复历史 SQLite 行；本需求可以通过正确终态化新运行产生的 Part 完成。
- 没有证据要求修改 `request_usage.status`、`MessageV2` 历史 replay compatibility 或 `src/v2`。

## Requirement and traceability coverage

- `REQ-01` 的第一处偏离和 owner 已正确定位：`workspace-routing.ts:190-198` 解析 Session 后只传递 `workspaceID`，`session.directory` 被丢弃；随后 `instance-context.ts:28-33` 按错误 directory 加载 `InstanceRef`，`run-state.ts:47-88` 因此可为同一 Session 建立多个 Runner。
- `REQ-01` 的原始反馈环已经规划为真实 HttpApi foreground Task 场景：冲突 directory hints、第二个同步 prompt、authoritative-directory abort、相同 assistant ID、Provider call count、父 Task 终态和 child assistant 终态。该测试能够对当前 ownership defect 变红。
- `REQ-02` 的 owner 选择正确：reviewer Tool Part 由 `runReviewerStream` 的 attempt-local event path 创建，普通 `SessionProcessor` cleanup 无法自动拥有这些 Part。
- `REQ-02` 的 forward traceability 仍有上述阻塞缺口：计划覆盖“map 中已登记的 open Part”，没有覆盖“已经 durable commit、尚未进入 map”的 reachable Part，也没有对 completed winner 与 stale map 状态的竞争提供行为敏感测试。
- `REQ-03` 的文件预算满足要求：2 个生产文件、2 个现有测试文件、无新增实现文件，预计约 260 行，低于 600 行偏好。
- Reverse traceability 对 Session directory precedence、reviewer attempt closure、interrupted/incomplete terminal metadata 均有现实依据；没有提出配置、依赖、迁移、公共接口或 TUI 第二状态源。
- 计划的仓库风格方向可接受：修改现有 owner，不新增浅层模块，不改变 Effect service shape。实际 code-quality 与中文注释硬门仍须在 implementation audit 按真实 diff 重新计算。

## Primary-path and fallback verdict

Session ownership方案修复了第一处错误转换：resolved Session 进入现有 routing planner，已有 local/remote Workspace forwarding 保持优先，最终 local/control-plane execution 使用持久化 `Session.directory`。该责任只有一个 authoritative routing path。

Reviewer closure 放在 attempt lifecycle owner 内，方向正确，也不制造 Assessment 或成功结果。当前 R2 对 durable write 与 attempt registry 之间的窗口定义不完整，因此尚不能保证这一主路径覆盖所有可达退出点。

未发现新增 fallback、catch-and-default success、第二套 Runner、TUI lifecycle 推断或隐藏的 feature disabling。现有 reviewer JSON compatibility、retry/fallback policy 和历史 Message replay 没有被扩张。

## Release verdict

**BLOCK**

R2 必须关闭 reviewer Tool Part 在 durable commit 与 attempt-local 登记之间的中断窗口，并增加能够捕获该窗口及 completed-winner 竞争的行为测试。修订后需要对完整原始需求和全部受影响接口重新进行 full-scope plan audit。

### Round 3 Independent Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- 无。R3 已将发布验证限定为仓库内稳定测试，临时 red tracer 只保留为规划阶段的复现证据。
- 本次为 plan audit；实际测试结果、代码质量和中文注释比例仍由 implementation audit 重新核验。

## Rejected speculation

- 没有证据支持修改 `Runner.ensureRunning`。`packages/opencode/src/effect/runner.ts:120-143` 与 `packages/opencode/test/effect/runner.test.ts:89-113` 已证明同一 Runner 内的后续调用会 join 当前执行。
- 没有证据支持 process-wide Runner registry。`packages/opencode/src/effect/instance-state.ts:27-53` 和 `packages/opencode/src/session/run-state.ts:47-88` 明确要求 Run state 保持 Project/directory scoped。
- 没有证据支持改变 foreground `TaskTool` 的同步阻塞语义。`packages/opencode/src/tool/task.ts:462-485` 会等待 child Session 执行完成。
- 没有证据支持让 TUI 从 child Session Status 推断父 Task 完成。`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:3062-3107` 以父 Tool Part 的 `running` 状态直接控制 spinner。
- 没有证据要求迁移历史 SQLite 数据、修改 `request_usage.status`、删除 `MessageV2` replay compatibility，或修改 `src/v2`。
- Session lookup defect 后回退到请求 directory 的异常场景缺少当前可达故障证据，不应扩展本次修复为额外容错路径。

## Requirement and traceability coverage

- **REQ-01 / INV-01—INV-03：覆盖完整。**  
  实际链路为 Session HTTP 请求 → `WorkspaceRoutingMiddleware` → `WorkspaceRouteContext.directory` → `InstanceContextMiddleware` → directory-keyed `InstanceState` → `SessionRunState`。当前第一处偏离位于 `workspace-routing.ts:190-198`：Session 已解析，但只有 `workspaceID` 进入 planner，`Session.directory` 被丢弃。R3 在该 owner 修复，不触碰 Runner、Task 或 handler。
- **原始 foreground Task 反馈环：覆盖完整。**  
  `httpapi-session.test.ts` 的计划场景包含三个冲突 directory、真实 foreground Task/child、第二个同步 prompt、authoritative-directory abort、相同 assistant ID、仅两次 Provider 请求、父 Task Part 终态和 child assistant 终态。该场景可在当前 ownership defect 下变红，并能检测仅修 route probe、未修实际 Run state 组合行为的伪修复。
- **REQ-02 / INV-04—INV-05：覆盖完整。**  
  R3 已关闭 durable commit 与 attempt registry 之间的窗口：Part ID 在首次 `updatePart` 前登记，所有后续转换和退出清理通过 `Session.getPart` 读取权威状态。`service.ts:680-734`、`session.ts:703-743`、`sync/index.ts:168-190,361-397` 共同证明该窗口真实可达。
- **Reviewer 竞争验证：覆盖完整。**  
  计划分别锁定 pending commit 后、创建调用返回前的 interruption；completed commit 后、返回前的 interruption；以及 stream drain/failure。测试从独立 durable store 和公共 `getPart` seam 观察结果，能够区分遗留 `pending`、正确 `error` 和不得覆盖的 `completed` winner。
- **TUI 闭合：覆盖完整。**  
  TUI 已按父 Tool Part 状态单调消费，`sync.tsx:303-328` 阻止终态回退，`index.tsx:3066,3101-3107` 只在父 Part 为 `running` 时旋转。生产者终态测试足以验证 spinner 输入，计划没有引入第二套 UI lifecycle。
- **Workspace 兼容面：覆盖完整。**  
  local/remote Workspace forwarding 保持现有优先级；control-plane 仍留在本地；无 Session、Session 缺失及 raw router 路径继续使用 query/header/cwd 选择。完整 `httpapi-workspace-routing.test.ts` 被列入独立和组合验证。
- **REQ-03：满足范围约束。**  
  计划修改 2 个生产文件和 2 个已有测试文件，不新增实现文件、依赖、配置、SDK、迁移或 ADR；预计总增量约 300 行，低于 600 行偏好。
- **Forward/reverse traceability：完整。**  
  每项生产概念均映射到 REQ-01 或 REQ-02、现有可达证据、明确 owner 和行为测试；未发现无需求支撑的 guard、adapter、cache、retry、配置或兼容层。
- **验证合同：可执行。**  
  测试和 `bun typecheck`、`bun run build` 均指定从 `packages/opencode` 执行；组合测试覆盖共享数据库、InstanceStore 和 runtime 隔离。
- **中文注释计划：可行。**  
  R3 估算 `E=255`、最低 `C=ceil(255×0.15)=39`，并要求按实际 diff 重算、将解释分布到 routing ownership、reviewer durable boundary 和并发测试拓扑附近。该承诺满足 plan 阶段硬门。

## Primary-path and fallback verdict

Session ownership只有一条权威路径：解析 Session 和既有 Workspace routing 后，在最终 local/control-plane directory 决策使用持久化 `Session.directory`；无 Session 时保留现有请求目录合同。修复发生在错误 InstanceRef 被加载之前。

Reviewer closure只有一条 attempt lifecycle 路径：先登记稳定 Part identity，再执行持久化；attempt 退出时重读权威 Part，只终态化仍为 `pending` 或 `running` 的记录。该清理不产生 Assessment，也不把失败转换成成功。

现有 remote/local Workspace routing、JSON decision compatibility、Provider retry/fallback-to-user-or-deny 和历史 Message replay 均保持原合同。未发现新增 fallback、catch-and-default success、替代 Runner、TUI lifecycle 推断或隐藏 feature disabling。

## Release verdict

**APPROVE**

该结论仅适用于 canonical plan `docs/plans/session-runner-ownership-tool-closure.md` 的 **R3** 完整修订。实施前应将独立 verdict 记录到计划并仅执行行政状态转换；任何行为、范围、接口、测试或文件计划变更都需要递增 revision 并重新进行 full-scope plan audit。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

R3 implementation is complete and frozen pending independent implementation audit.

### Actual Files and Diff

| File | Actual change | Diff |
| --- | --- | --- |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` | Pass the resolved Session into the existing planner and use `Session.directory` at the final local/control-plane directory decision. | +9 / -4 |
| `packages/opencode/src/permission/reviewer/service.ts` | Register stable Part IDs before first persistence, re-read authoritative Parts for transitions/finalization, and close open Parts on drain, failure, or interruption without overwriting terminal winners. | +101 / -20 |
| `packages/opencode/test/server/httpapi-session.test.ts` | Add the real three-directory foreground Task, second prompt join, authoritative abort, parent Part closure, and child termination regression. | +156 / -4 |
| `packages/opencode/test/permission/reviewer-service.test.ts` | Add durable commit/return barriers for pending and completed states, incomplete-drain closure, and durable Part stores for existing reviewer fixtures. | +197 / -9 |

Actual implementation total: 4 approved files, 463 additions, 37 deletions, 500 gross changed lines. No production/test/config/generated file outside the approved list is part of the implementation diff. `bun run build` refreshed `packages/core/src/models-snapshot.js` as an unrelated generated worktree side effect; it is excluded from this task and commit.

### Red-Green Test Evidence

| Slice | Red | Green |
| --- | --- | --- |
| Foreground Task ownership | Repository test reached a real parent Task/child, authoritative-directory abort returned success, then the test timed out at 30 seconds because both conflicting-hint prompt fibers remained live. | The same test passes: both prompts return one assistant ID, Provider calls remain parent+child only, parent Task is `error`, and child assistant is terminal. |
| Durable pending return window | Expected stored state `error`, received `pending` after interruption between durable write and `updatePart` return. | Stored state becomes `error` with `Tool execution aborted` and `metadata.interrupted=true`. |
| Durable completed winner | Added after the pending slice was green to lock the opposite race edge. | Interruption after completed commit preserves `completed`, review ID, and decision output. |
| Incomplete stream drain | Expected no open decision Parts, received one durable `pending` Part. | All attempt-owned decision Parts are terminal `error` before protocol failure escapes. |

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/server/httpapi-session.test.ts -t "keeps foreground Task execution and abort on the persisted Session owner"` | `packages/opencode` | 1 pass, 0 fail after the intended timeout red. |
| `bun test test/permission/reviewer-service.test.ts` | `packages/opencode` | 14 pass, 0 fail, 84 assertions. |
| `bun test test/server/httpapi-session.test.ts` | `packages/opencode` | 12 pass, 0 fail, 60 assertions. |
| `bun test test/server/httpapi-session.test.ts test/server/httpapi-workspace-routing.test.ts test/server/httpapi-promptasync-context.test.ts test/effect/runner.test.ts test/permission/reviewer-service.test.ts test/session/message-v2.test.ts` | `packages/opencode` | 115 pass, 0 fail, 339 assertions. |
| `bun typecheck` | `packages/opencode` | Passed. |
| `bun run build` | `packages/opencode` | Passed all target builds; darwin-arm64 smoke test passed. |
| `git diff --check -- <four approved files>` | repository root | Passed with no output. |

### Original Feedback-Loop Result

- `/var/.../session-owner-red.test.ts`: 1 pass, authoritative Session directory now wins over caller hint.
- `/var/.../reviewer-closure-red.test.ts`: 1 pass, durable pending return-window interruption now closes to `error`.
- `/var/.../foreground-task-owner-red.test.ts`: 1 pass after replacing the planning tracer's premature abort with the same `llm.wait(2)` readiness barrier used by the repository regression; both prompt callers close on authoritative abort.

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Verdict |
| --- | --- | --- |
| Resolved local/control-plane Session directory | primary-contract branch | Implemented at routing owner. |
| Local/remote Workspace forwarding | existing primary-contract branch | Preserved; full routing tests pass. |
| No-Session/missing-Session request directory | contracted pass-through | Preserved. |
| Reviewer attempt finalization | lifecycle diagnostic, no success result | Implemented; it only writes terminal error state. |
| Reviewer JSON decision, retry, and fallback policy | existing compatibility/primary branches | Preserved. |
| Historical open Tool replay | existing compatibility | Preserved; MessageV2 tests pass. |
| TUI child-Status inference or global Runner | forbidden fallback | Not added. |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 378 | Added/substantively modified nonblank code lines; excludes import-only lines, blank lines, comments, formatter-only changes, generated snapshot, and plan text. |
| Qualifying Chinese comment lines `C` | 59 | Added adjacent Chinese comments explaining routing ownership, durable commit/return boundaries, stable identity, terminal winner, readiness topology, and test intent. |
| Ratio `C / E` | 15.61% | `59 / 378`. |
| Required minimum `C` | 57 | `ceil(378 * 0.15)`. Gate passes by 2 lines. |

Representative qualifying comments include:

- `Session.directory` must override caller hints only after Workspace forwarding has retained its existing priority.
- The attempt registry owns stable Part identity while `Session.Service` remains the sole durable state truth.
- The pending and completed barriers exercise opposite sides of the commit-before-return race.
- The second persisted user Message and second Provider HTTP hit are readiness signals, avoiding fixed sleeps in the foreground Task test.

### Remaining Unverified Items

- Independent full-scope implementation audit is pending.
- The build-generated `packages/core/src/models-snapshot.js` side effect remains outside the approved diff and will not be included in the task commit.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | none | Audit mode metadata; build-generated snapshot side effect excluded | APPROVE | `ses_085d46b23ffePip1DjOhilWh9a` |

### Round 1 Independent Implementation Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- Canonical plan 元数据仍写着 `Audit mode: plan`（`docs/plans/session-runner-ownership-tool-closure.md:9`），而当前阶段是 implementation audit。Revision、approved revision、状态和实际审计范围仍然一致，因此这是行政记录问题，不影响本次实现发布。
- `bun run build` 会通过 `script/generate.ts:10-21` 联网并重写 `packages/core/src/models-snapshot.*`，本次只读审计没有再次触发该副作用。已直接检查原始构建输出 `/Users/sunbenteng/.local/share/opencode/tool-output/tool_f7a224cc9001cnh2kOJMISyo7v:1-31,600-626`：全部目标完成，`darwin-arm64` smoke test 通过。构建后对受审生产逻辑没有实质代码修改，后续差异只补充了解释性注释。

## Rejected speculation

- 没有证据支持修改 `Runner.ensureRunning`。`packages/opencode/src/effect/runner.ts:120-143` 已实现同一 Runner 的 join，组合回归也证明第二个 prompt 没有启动第二份 work。
- 没有证据支持 process-wide Runner registry。`InstanceState` 和 `SessionRunState` 的 per-directory 所有权保持不变。
- 没有证据支持让 TUI 查询 child Session 并推断父 Tool 状态。父 Tool Part 仍是唯一 lifecycle 真值。
- 没有证据要求迁移历史 `pending` Part、修改 `request_usage.status`、删除 `MessageV2` replay compatibility，或修改 `src/v2`。
- 没有可达证据表明应为数据库自身写入失败增加另一套 Tool closure/fallback。当前实现保留原始 Provider failure shape，没有把 cleanup failure 转换成成功。
- Provider 同一 reviewer attempt 产生任意多个并发 decision Tools 缺少当前生产者证据；不能据此扩展本次修复。

## Requirement and traceability coverage

- **REQ-01 / Session Runner ownership：覆盖完整。**  
  `workspace-routing.ts:145-168,193-203` 将已解析的 `Session.Info` 传入现有 planner。Workspace forwarding 保持优先；最终留在本地的 Session 请求使用 `Session.directory`，prompt、foreground Task 和 abort 因而加载同一个 directory-keyed `InstanceState` 和 Runner。

- **REQ-01 / 阻塞与取消反馈环：覆盖完整。**  
  `httpapi-session.test.ts:415-554` 通过三个目录、真实 foreground Task/child、第二个同步 prompt 和 authoritative-directory abort 验证完整生产链。相同 assistant ID 与恰好两次 Provider 请求证明第二个调用 join 既有 Runner；父 Task 进入 `error` 且 child assistant 全部完成，证明 abort 到达真实 owner 和 child fiber。

- **REQ-02 / reviewer Tool closure：覆盖完整。**  
  `reviewer/service.ts:614-653,718-795` 在首次 durable write 前登记稳定 `PartID`，后续 input/completed 转换和退出 cleanup 都经 `Session.getPart` 读取权威状态。`completed`/`error` winner 不会被 stale snapshot 覆盖。

- **REQ-02 / 全部 attempt 退出方式：覆盖完整。**  
  `reviewer/service.ts:843-862` 覆盖 interruption、Provider failure 和正常 drain。cleanup 只把仍为 `pending`/`running` 的 Part 写为 `error`，不会制造 Assessment，也不会改变既有 retry/fallback-to-user-or-deny 语义。

- **竞态测试敏感性：满足。**  
  `reviewer-service.test.ts:298-344,367-440` 的 pending 和 completed barriers 位于 durable commit 与 `updatePart` 返回之间，并从独立持久化副本观察结果。原实现会让 pending 用例保留 `pending`；completed 用例锁定 terminal winner。`346-364` 证明 incomplete attempts 不再累积开放 Part。

- **TUI closure：覆盖完整。**  
  生产者现在写入权威 terminal Part；TUI 继续只消费父 Tool Part 状态。没有新增 display-only inference 或第二套 lifecycle owner。

- **Workspace 兼容面：保持。**  
  remote/local Workspace、control-plane locality、无 Session、Session 缺失及 raw router 的既有分支均未改变。完整 workspace routing suite 已通过。

- **范围约束：满足。**  
  实现仅修改 2 个生产文件和 2 个现有测试文件，无新增实现文件、依赖、配置、迁移、SDK 或 TUI 改动。实际 diff 为 `463 additions / 37 deletions`，共 500 gross changed lines，低于用户要求的 600 行偏好。

- **独立验证结果：**
  - 组合回归：`115 pass / 0 fail / 339 assertions`
  - `bun typecheck`：通过
  - `git diff --check -- <四个受审文件>`：通过
  - 原始构建输出：全部平台构建完成，darwin-arm64 smoke test 通过
  - 仓库没有适用于该 package 的 lint 命令；无生成、迁移或 SDK 验证需求

## Primary-path and fallback verdict

Session ownership只有一条权威路径：Session lookup 和既有 Workspace 决策完成后，本地执行使用持久化 `Session.directory`；无 Session 时继续使用 query/header/cwd 合同。修复发生在错误 `InstanceRef` 被加载之前。

Reviewer Tool closure只有一条 attempt lifecycle 路径：先登记稳定 identity，再持久化；退出时重读 durable Part，并只关闭仍开放的状态。该路径不产生 allow/deny 成功结果。

未发现新增 fallback、catch-and-default success、替代 Runner、TUI 状态推断、隐藏 feature disabling 或重复 lifecycle owner。既有 JSON decision compatibility、Provider retry/fallback 和历史 Message replay 均保持原合同。

## Code quality and Chinese-comment verdict

- 修改位于两个实际 owner：`WorkspaceRoutingMiddleware` 和 `PermissionReviewer.runReviewerStream`。
- 没有新增公共接口、依赖、配置、类型抑制、`any`、unchecked cast、非空断言或浅层 wrapper。
- `finalizeOpenToolParts` 命名并封装一个真实的 attempt lifecycle boundary；不是仅为测试创建的 helper。
- Effect 组合、early return、持久化读取和测试 fixture 形状符合仓库约定。
- 没有无关重构、弱化断言或删除安全检查。

独立按当前四文件 diff 重算：

| 项目 | 实际值 |
|---|---:|
| Gross additions | 463 |
| 空白行排除 | 20 |
| import-only 排除 | 6 |
| 中文解释性注释排除出 `E` | 59 |
| 有效代码行 `E` | 378 |
| 合格中文解释性注释行 `C` | 59 |
| 最低要求 | `ceil(378 × 0.15) = 57` |
| 实际比例 | `59 / 378 = 15.61%` |

59 行注释均邻近 routing ownership、durable commit/return boundary、stable identity、terminal winner、并发 readiness 或测试观察边界；未计入计划文本、生成文件、空白、import-only 或 formatter-only 行。中文解释性注释硬门通过。

## Release verdict

**APPROVE**

该结论仅适用于 canonical plan `docs/plans/session-runner-ownership-tool-closure.md` 的 **R3** 和当前所列四个文件的完整 implementation diff。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

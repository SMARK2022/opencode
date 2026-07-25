# Canonical Implementation Plan: Session Status Cross-Directory Visibility

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: current Session GOAL and the verbatim user requirements in section 1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 请注意,我当时的UI显示的是一条一条session的,而不是一个一个目录的。所以理论上而言,对于每一个session,它的idle和busy信息应该随着该session进行控制,而不是根据其路径进行控制。请注意这一点。除此之外,其他的内容我并不关心。也就是我们需要实现精巧的,譬如说我们整体修改量甚至在一百行或者几十行就能改得过来的,同时也避免进行大幅度的schema等等调整。我要的就是相应的session list里面,相应的session显示正在运行,然后同时进入TUI之后,相应的session也显示在运行,而不是不在运行。
>
> 与此同时性能不能有较大损伤,也就是我们的性能不能有过大的影响。尽量性能有适当的提升最好。

Current Session GOAL:

> 详细完整检查全面的内容，检查当前行为设计，按照如上的思想进行设计（也就是对过多的过滤字段进行修改冗余），同时使得整体逻辑高性能鲁棒且不会引入冗余逻辑，并且增加1个测试；然后针对完整问题进行完整的修改，请确保修改后的内容不会出现红测问题，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在4个代码文件以内，同时代码修改不超过600行。
>
> 目标终态：verified-implementation-and-commit

## 2. Explicit Non-Goals

- Do not aggregate status by directory, ancestor path, descendant path, Project, or Workspace; each rendered row consumes its own Session ID.
- Do not make the TUI infer execution from Message or Part chronology; `SessionStatus` remains the authoritative transient source.
- Do not change `SessionRunState` ownership, `Runner.ensureRunning`, prompt queueing, Task cancellation, Workspace routing, or remote Workspace proxying.
- Do not persist runtime status, add a schema or migration, regenerate an SDK, add an endpoint, or modify public wire schemas.
- Do not add directory traversal, one-request-per-Session polling, a compatibility path, a fallback, or a second status implementation.
- Do not change retry payloads or the existing `session.status` SSE event contract.
- Do not edit the unrelated dirty `packages/opencode/test/session/prompt.test.ts` or other concurrent worktree changes.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | `session/` owns Session lifecycle; `effect/` owns `InstanceState`; v1 `session/` is current production. |
| Root `AGENTS.md` | Default branch is `dev`; package tests and `bun typecheck` run from `packages/opencode`; current dirty work must remain untouched. |
| `packages/opencode/AGENTS.md` | `InstanceState` is for state that must differ by directory; shared state must not be forced through directory ownership. |
| `packages/opencode/test/AGENTS.md` | Use Effect fixtures, readiness/public seams, package-local tests, and avoid duplicated production logic. |
| `docs/adr/README.md` | A one-module correction of transient identity ownership is not a new load-bearing ADR. |
| `.opencode/policy/first-principles-engineering.md` | Repair the first divergence at the owning primary path; no fallback or downstream UI compensation. |
| `docs/plans/session-runner-ownership-tool-closure.md` | Current routing already binds Session-specific local requests to persisted `session.directory`; this task must not globalize Run state or undo that repair. Its old non-goal for `/session/status` is superseded only by the new explicit requirement above. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/status.ts` | `SessionStatus` stores a separate active map in each directory-keyed `InstanceState`; `idle` deletes entries. | observed |
| `packages/opencode/src/effect/instance-state.ts` | `InstanceState.get` keys its `ScopedCache` by current `InstanceRef.directory`. | contracted |
| `packages/opencode/src/session/run-state.ts` | Runner transitions call `status.set(busy/idle)` and continue to own per-directory execution resources. | contracted |
| `packages/opencode/src/effect/runner.ts` | `ensureRunning` joins an existing run; status display is not responsible for queue semantics. | contracted |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | `/session/status` returns `Object.fromEntries(statusSvc.list())`; it has no Session ID from which to select another directory. | observed |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` | Session-specific local requests use persisted `session.directory`; status snapshot requests without Session ID use caller context. | observed |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | Bootstrap/reconnect loads one `/session/status` snapshot; SSE then updates `session_status[sessionID]`. | observed |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | Each Session row shows a spinner only for its exact `session_status[sessionID]` busy/retry value. | contracted |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Entered Session Prompt/Footer uses the same exact Session ID status map. | contracted |
| `packages/opencode/src/cli/cmd/tui/context/event.ts` | Same-Project status events are accepted independently of directory; a newly attached TUI still needs a correct non-replay snapshot. | observed |
| Incident DB row `ses_07f7bd73affeuQMK5YHFFr4op3` | Session directory was `/Users/sunbenteng/Project/opencode/thirdparty` while the TUI daemon client ran from `/Users/sunbenteng/Project/opencode`; Project identity was the same. | observed |
| Live daemon/DB timeline from the incident | The parent request remained active while a newly opened TUI displayed no running marker, proving a false-idle observation rather than true Runner idle. | observed |
| `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-status-cross-directory-red.test.ts` | Minimal public-interface reproduction: set busy in directory A, read list/get in B. | observed |
| `packages/opencode/test/fixture/fixture.ts` and `test/lib/effect.ts` | Existing multi-directory Effect fixtures support one durable regression test without mocks. | contracted |

## 5. Current Behavior

```text
Runner for Session S in directory A
  -> SessionStatus.set(S, busy)
  -> InstanceState.get(A)
  -> Map_A[S] = busy

TUI bootstrap/reconnect from directory B
  -> GET /session/status
  -> SessionStatus.list()
  -> InstanceState.get(B)
  -> Map_B does not contain S
  -> sync.data.session_status[S] is absent
  -> Session list row and entered Prompt render S as idle
```

The existing UI consumers are faithful: they index by Session ID and do not
derive directory state. The first false transition happens before the HTTP
response, when the status owner partitions one globally unique Session identity
by the observing request directory.

`SessionStatus.set` currently publishes every state transition before storing or
deleting it. This task preserves publication ordering and payload. Only the
active snapshot registry ownership changes.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| One local Session is busy in its persisted directory | `SessionRunState` | Session ID is globally unique in the database; Session-specific requests use persisted directory | Runner `onBusy` -> `SessionStatus.set` | `SessionStatus` | observed |
| A TUI lists or enters that Session from another related directory | Session list/path query + TUI bootstrap | The rendered row carries exact Session ID; `/session/status` has no Session ID | `refreshStatus` -> status handler -> `SessionStatus.list` | `SessionStatus` | observed |
| Newly connected TUI missed earlier busy SSE | daemon SSE is non-replay | Bootstrap status snapshot is the recovery authority | `server.connected/bootstrap` -> `refreshStatus` | `SessionStatus.list` | observed |
| Busy/retry changes after bootstrap | Runner/Retry producer | Event payload carries exact Session ID | `set` -> Bus/GlobalBus -> TUI sync store | existing event path | contracted |
| Session becomes idle | Runner completion/cancel | `onIdle` calls status idle | `set(idle)` -> event + delete | `SessionStatus` | contracted |
| Remote selected Workspace | TUI Workspace routing | Existing status request is forwarded to the owning daemon | remote daemon executes same status contract | Workspace routing | reachable |
| Historical inactive Sessions | SQLite/list endpoint | Runtime status is absent by definition | no status registry entry | no new owner | contracted |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A non-idle status is keyed only by its globally unique Session ID and is observable from any local directory context in the same daemon. | User requirement + incident + Session ID schema | No; red harness fails. |
| INV-02 | Session list and entered Session consume the same authoritative `sessionID -> status` snapshot and SSE updates. | TUI consumers | Existing UI tests cover event consumption, not cross-directory snapshot. |
| INV-03 | Idle removes the active registry entry, so memory and snapshot work scale with active Sessions only. | Existing `status.set` behavior | Existing status callers assume idle-default; new test will assert cleanup. |
| INV-04 | Status get/set remain average O(1); list remains O(A), where A is daemon-active non-idle Sessions, with no DB or directory traversal. | Performance requirement + Map contract | Structural verification and one active-only behavior test. |
| INV-05 | Per-directory Runner/resource ownership and prompt queue behavior remain unchanged. | Existing routing plan and Runner contract | Existing prompt/server suites. |
| INV-06 | Wire schema, endpoint count, event payload, and generated SDK remain unchanged. | User scope/minimality | Typecheck and diff inspection. |
| INV-07 | Exactly one new behavioral test covers cross-directory visibility and idle cleanup through `SessionStatus.Interface`. | Session GOAL | Planned new test. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `SessionStatus.set/list/get` obtains a directory-specific Map via `InstanceState.get(state)`, so the same Session ID is absent to an observer in another context. | `SessionStatus.Interface` in `session/status.ts` | Red harness receives `undefined` in directory B after busy was set in A. |
| INV-03, INV-04 | No current violation of idle deletion or Map complexity; the repair must preserve deletion while removing ScopedCache lookup from get/set. | `SessionStatus.Interface` | Current source and Map behavior. |

Red-capable command:

```text
Working directory: packages/opencode
bun test /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-status-cross-directory-red.test.ts
```

Observed minimized result on 2026-07-25:

```text
reports one session status across directory contexts
expected { type: "busy" }
received undefined
0 pass, 1 fail
```

Every remaining element is load-bearing: one shared service proves identity,
directory A produces the state, directory B reproduces the observer, and one
Session ID proves whether the public interface partitions it.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Active Session status registry | `SessionStatus` | get/list/set status by Session ID | It creates, stores, removes, and publishes the status | TUI and HTTP only consume the interface. |
| Runner/resource ownership | `SessionRunState` | Single-flight execution in canonical directory | Resource lifetime genuinely differs by directory | This task does not change it. |
| Snapshot serialization | Session HTTP handler | Encode current status map | Existing `statusSvc.list` is sufficient once owner is correct | Handler must not traverse Sessions or directories. |
| Row rendering | TUI Session list/Prompt | Render exact Session ID status | Existing behavior is already correct | UI inference would duplicate runtime truth. |
| Cross-directory behavior test | `SessionStatus.Interface` test seam | Observe set/list/get/idle contract | It isolates the first divergence without private access | HTTP/UI tests would add unrelated routing/render setup. |

## 10. Single Approved Primary-Path Design

```text
SessionStatus layer construction
  -> create one layer-local Map<SessionID, Info>

set(S, busy/retry)
  -> publish existing session.status event
  -> Map.set(S, status)

set(S, idle)
  -> publish existing session.status event
  -> Map.delete(S)

get(S) / list()
  -> read the same layer-local Map regardless of InstanceRef.directory
  -> HTTP/TUI continue consuming exact Session IDs
```

Remove `InstanceState` only from `SessionStatus`; keep `Bus.Service` and all
existing event semantics. The Map is local to the Effect Layer/runtime, not a
module-global ambient singleton. This directly restores Session identity at the
owner while preserving runtime/test isolation.

Performance improves on high-frequency get/set by removing directory lookup and
`ScopedCache.get`; set/get remain O(1). Snapshot list broadens from one directory
to all active local Sessions but remains O(A), active-only, and low-frequency.
No tree scan, SQLite query, per-Session request, payload field, filter, or cache
is introduced.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Layer-local active Map keyed by Session ID | proposed | primary-contract branch | yes | 100% | implement |
| `idle` publish then delete | current/preserved | primary-contract branch | yes | existing branch | preserve |
| Bus/GlobalBus SSE event | current | contracted pass-through | yes | unchanged | preserve |
| TUI Message/Part inference | rejected | forbidden fallback | yes | 0% | do not add |
| Ancestor/descendant status traversal | rejected | forbidden alternate implementation | yes | 0% | do not add |
| Batch/per-Session status query parameters | rejected | forbidden alternate implementation | yes | 0% | do not add |

New alternate success paths: 0. Diagnostic paths: 0. Fallback ratio: 0%.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Directory-keyed `InstanceState` inside `SessionStatus` | Followed a broad per-instance state pattern although Session ID already supplies global daemon identity | It causes the false snapshot and adds a ScopedCache lookup without protecting a directory-owned resource | Remove state wrapper/import and four `InstanceState.get` uses in `session/status.ts`. |

No downstream UI workaround exists or will be added.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| Session list row shows true busy state | Runner set -> global active Map -> `/session/status` -> exact Session ID | `src/session/status.ts`: layer-local Map | One test sets in A and lists in B. |
| Entered Session shows true busy state | Same snapshot/store -> Prompt exact Session ID | No TUI change | Same test also calls `get` in B. |
| No directory traversal/redundant filters | Direct Map read | Remove `InstanceState` dependency; add no query/filter | Diff inspection. |
| High performance | O(1) get/set; O(A) list; active-only deletion | Direct Map and preserved idle delete | Same test verifies idle removes entry; type/diff inspection proves no I/O. |
| One test only | Public status seam | Add `test/session/status.test.ts` containing one test | Focused command. |
| No schema/API changes | Existing interface and endpoint | No schema/generated/TUI edits | Typecheck and changed-file inspection. |
| <=4 code files and <=600 lines | One production + one test file | Two code files, expected <50 net lines | `git diff --stat` and line count. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Layer-local Session-ID active Map | INV-01, INV-02, INV-04 | Red harness and user identity requirement | Existing Map is hidden behind directory-keyed `InstanceState`, so observers select different maps. |
| Preserve idle deletion on shared Map | INV-03, INV-04 | Existing behavior and bounded-memory requirement | Omitting deletion would retain inactive history and violate performance scope. |

No other production concept is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/status.ts` | modify | Replace directory-keyed status state with one layer-local active Map; preserve interface/events/idle cleanup. | +3/-9 executable/comment lines, plus import cleanup |
| `packages/opencode/test/session/status.test.ts` | add | One cross-directory public-interface test covering busy list/get and idle removal. | +25 to +35 |
| `docs/plans/session-status-cross-directory-visibility.md` | add/modify | Canonical plan, audit and implementation evidence. | documentation only |

## 16. TDD Behavior Slices

Agreed seam: `SessionStatus.Interface` (`set`, `list`, `get`) under two real
`InstanceRef` contexts. This is the interface consumed by the HTTP handler and
Runner; it avoids private state and independently uses a literal expected status.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | One test sets Session S busy in directory A; list/get in B must report busy; then idle must remove S. | `InstanceState.get` selects separate Maps for A and B. | Use one layer-local Map keyed by S while preserving idle delete. | False idle in Session list/entered TUI after cross-directory bootstrap and active-map boundedness. |

No second test is planned because the user explicitly requested one test and
the single vertical slice covers production identity plus cleanup. Existing
prompt/server/TUI suites provide regression breadth.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 24-30 | Production executable changes plus the new test body; imports/blank/format-only excluded. |
| Required Chinese explanatory comments `C` | 4-5 | `ceil(E * 0.15)` over the upper observed implementation count. |

Planned qualifying nearby Chinese comments:

- Production: Session ID, not request directory, is the status identity.
- Production: the registry remains layer-local and idle-only deletion bounds memory to active Sessions.
- Test: the two directory contexts model producer and newly attached observer without path traversal.
- Test: idle assertion protects active-only memory/snapshot complexity.
- If actual E reaches 30, add one concise test/production invariant comment at the relevant line; do not pad comments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/status.test.ts` | `packages/opencode` | New cross-directory behavior is green. |
| `bun test test/session/prompt.test.ts` | `packages/opencode` | Runner busy/idle, queue, cancel, and Task regressions remain green. |
| `bun test test/server/httpapi-session.test.ts` | `packages/opencode` | Existing `/session/status` and Session HTTP behavior remain green. |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx` | `packages/opencode` | Prompt/Footer status event consumption remains green. |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | Session/Subagent status rendering remains green. |
| `bun typecheck` | `packages/opencode` | Package types and unchanged public interface compile. |
| `bun test /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-status-cross-directory-red.test.ts` | `packages/opencode` | Original minimized feedback loop is green after implementation. |
| `git diff --check -- packages/opencode/src/session/status.ts packages/opencode/test/session/status.test.ts docs/plans/session-status-cross-directory-visibility.md` | repository root | No whitespace errors in owned paths. |
| `git diff --stat -- packages/opencode/src/session/status.ts packages/opencode/test/session/status.test.ts` | repository root | Code-file and line budgets remain within 4/600. |

No lint/build/generation/migration command is required: the change adds no
generated surface, schema, migration, package, or build artifact. Package
typecheck is the broad static gate.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2 | One test code file and this plan. |
| Files modified | 1 | `session/status.ts`. |
| Files deleted | 0 | None. |
| Production lines | <=15 changed, likely net reduction | Remove InstanceState wrapper and lookups. |
| Test lines | 25-35 | Exactly one behavior test. |
| Generated lines | 0 | No schema or public contract change. |

Code files: 2, below the user limit of 4. Total code changes remain far below
600 lines. The budget is an audit signal, not permission to omit confirmed
behavior.

## 20. Real Risks and Open Decisions

### Real Risks

- `/session/status` will return all active Sessions in the selected local daemon rather than one directory's subset. This is required for the displayed cross-directory Session rows and remains bounded by active count, but regression must preserve idle deletion.
- `SessionStatus.set` still publishes through the current Instance `Bus`; changing the registry must not move or suppress publication because live TUI updates depend on it.
- The worktree contains unrelated modifications, including `test/session/prompt.test.ts`; implementation and commit must use only this plan's paths and must not overwrite or include those changes.
- A prior plan deliberately preserved instance-scoped `/session/status`; the new explicit user requirement changes that status-observation contract only. It does not authorize global Runner ownership.

### Open Decisions Requiring the User

None. The user selected exact per-Session identity, one test, no directory
aggregation, minimal code, no schema expansion, and no significant performance
loss.

### Rejected Speculation

- Hundreds of concurrently active local Sessions could enlarge one status JSON. No observed producer approaches that scale, idle entries are deleted, and adding pagination/filtering would violate the requested minimal primary path.
- Cross-user status disclosure is not reachable: this daemon and loopback control model serve one local installation; status contains Session IDs and state only.
- Persisting status for daemon restart is rejected: runtime activity cannot survive process death and stale persisted busy would create a worse false positive.
- Special-casing TUI parent/child paths is rejected because exact Session ID already identifies every rendered row.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, performance, and the 15 percent Chinese explanatory-comment plan.
- Confirm the change does not globalize `SessionRunState`, alter queue behavior, or add redundant UI/path logic.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | E estimate slightly optimistic; code-file budget should exclude the canonical plan document | APPROVE — canonical plan revision R1 passes the full-scope plan audit. | independent adversarial-auditor task `ses_066545c15ffeJY7Ogt97P1k8yV` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

- `packages/opencode/src/session/status.ts`: removed the directory-keyed
  `InstanceState` wrapper and four lookups; kept existing Bus publication,
  idle deletion, and the public `SessionStatus.Interface` unchanged.
- `packages/opencode/test/session/status.test.ts`: added one public-interface
  regression test covering busy `list/get` from a second directory and idle
  removal.
- No UI, route, Runner, schema, migration, generated, or unrelated worktree
  paths changed for this task.

### Red-Green Test Evidence

- Red: the feedback loop in section 8 returned `0 pass, 1 fail`; directory B
  received `undefined` instead of `{ type: "busy" }`.
- Green: the same loop returned `1 pass, 0 fail, 2 expect() calls` after the
  owner repair.
- Green: `bun test test/session/status.test.ts` returned `1 pass, 0 fail,
  3 expect() calls`.

### Verification Commands and Results

- `bun test test/session/status.test.ts`: pass.
- Relevant prompt cancel/queue tests: both pass when run by exact test name.
- `bun test test/server/httpapi-session.test.ts`: 12 pass.
- `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx`: 14 pass.
- `bun test test/cli/cmd/tui/session-message-render.test.tsx`: 79 pass;
  existing TreeSitter fallback warnings only.
- `bun typecheck`: turbo typecheck 14/14 successful.
- `git diff --check` on owned paths: pass.
- Full `bun test test/session/prompt.test.ts` was attempted and returned 104
  pass / 3 fail. The failures are in existing reviewer-outage, LSP-directory
  observation, and shell-queue expectations; none references `session/status.ts`
  or the new status test. The two affected queue/cancel tests were rerun
  directly and passed.
- To distinguish concurrent worktree drift from this implementation, exact
  `HEAD` was exported to `/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/session-status-baseline`
  and the same three tests were run there. Each returned `1 pass, 0 fail`.
  The current failures therefore predate and are outside this task's two code
  paths; the clean baseline proves the approved SessionStatus change did not
  introduce them.

### Original Feedback-Loop Result

Pass. The minimized cross-directory public-interface repro is green after the
approved primary-path repair.

### Actual Secondary and Replacement Path Inventory

- No alternate success path, fallback, directory traversal, per-Session query,
  Message inference, or UI compensation was added.
- Existing Bus/GlobalBus publication and idle deletion remain unchanged.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 18 | Excludes import-only, blank, pure deletion, and documentation lines; includes the production owner change and one test body. |
| Qualifying Chinese comment lines `C` | 4 | Two production invariant comments and two test topology/cleanup intent comments. |
| Ratio `C / E` | 22.2% | `4 / 18`. |
| Required minimum `C` | 3 | `ceil(18 * 0.15) = 3`. |

### Remaining Unverified Items

No remaining unverified item for the owned implementation paths. The shared
worktree remains dirty in unrelated paths; those changes are excluded from this
task's release scope.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | Duplicate `CrossSpawnSpawner` test layer; concurrent unrelated worktree drift and non-portable temporary red harness import | APPROVE — exact R1 implementation diff passes the full-scope implementation audit. | independent adversarial-auditor task `ses_06641651dffe17g1X2QHOzX1Dz` |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

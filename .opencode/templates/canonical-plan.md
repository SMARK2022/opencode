# Canonical Implementation Plan: <Task Name>

> Status: draft
>
> Revision: R1
>
> Approved revision: none
>
> Audit mode: full-scope
>
> Requirement source: <verbatim user request or stable issue reference>
>
> Implementation allowed: no
>
> Last updated: <YYYY-MM-DD>

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

Quote the user's requirement without rewriting its meaning.

## 2. Explicit Non-Goals

List behavior that this task does not change. Do not use this section to hide a
confirmed requirement.

## 3. Repository Context

Record the relevant `CONTEXT.md`, ADRs, `AGENTS.md` files, package instructions,
and existing design conventions.

| Source | Why it constrains this task |
| --- | --- |
|  |  |

## 4. Files and Evidence Read

List every source file, test, configuration file, generated artifact, trace, or
document used to establish the plan.

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
|  |  | observed / contracted / reachable |

## 5. Current Behavior

Describe the current producer-to-consumer path. Include only relevant and
proven concurrency, exit, cleanup, compatibility, persistence, permission, and
security behavior.

```text
producer -> seam -> module -> adapter -> observable result
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | observed / contracted / reachable / speculative |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

Assign stable IDs.

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 |  |  |  |

## 8. First Divergence and Root Cause

State where each violated invariant first becomes false. Distinguish the root
cause from downstream symptoms and workarounds.

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
|  |  |  |  |

For bug work, record the red-capable feedback-loop command and observed output.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 10. Single Approved Primary-Path Design

Describe one authoritative semantic path. The default route repairs the first
divergence. An explicit user-requested rollback may replace current primary
behavior, but it must not coexist as a failure-triggered recovery path. Private
helpers may decompose the implementation but must not create competing success
behavior.

```text
input -> validation at owning seam -> primary operation -> observable result
```

Explain why the route repairs the first divergence. For an explicit rollback,
quote the request and record the exact target behavior, transition condition,
semantic difference, observability, tests, owner, and removal or reconsideration
condition.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
|  |  | primary-contract branch / pass-through / diagnostic / existing compatibility / explicit user-requested rollback / forbidden fallback | yes/no |  | remove / preserve / reject |

New alternate success paths are forbidden. An explicit user-requested rollback
may replace the primary path only when its quoted, path-specific authorization
appears here.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
|  |  |  |  |

## 13. Forward Traceability

This table prevents under-design.

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
|  |  |  |  |

No confirmed requirement may remain unmapped.

## 14. Reverse Traceability

This table prevents over-design.

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
|  |  |  |  |

No production concept may remain unjustified.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
|  |  |  |  |

## 16. TDD Behavior Slices

Use one confirmed seam and one vertical behavior slice at a time.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |

Tests must observe public behavior and use an independent expected value.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` |  | Exclude imports, formatting, generated files, and pure moves |
| Required Chinese explanatory comments `C` |  | `if E = 0: C = 0`; `if E > 0: C >= max(1, ceil(E * 0.15))` |

List the invariants, non-obvious constraints, constants, compatibility reasons,
test intentions, and safety decisions that require nearby Chinese explanation.

## 18. Verification

List exact commands and the behavior each command proves. Respect package-local
test and typecheck instructions.

| Command | Working directory | Evidence produced |
| --- | --- | --- |
|  |  |  |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added |  |  |
| Files modified |  |  |
| Files deleted |  |  |
| Production lines |  |  |
| Test lines |  |  |
| Generated lines |  |  |

The budget is an audit signal, not permission to omit confirmed behavior.

## 20. Real Risks and Open Decisions

Include only observed, contracted, or reachable risks. Put speculative concerns
in a separate non-blocking subsection.

### Open Decisions Requiring the User

Use this section only for irreducible product or policy choices.

### Rejected Speculation

Record plausible-sounding concerns that were investigated and rejected for lack
of reachability, ownership, or contract evidence.

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
|  |  | yes |  |  |  |  |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

### Red-Green Test Evidence

### Verification Commands and Results

### Original Feedback-Loop Result

### Actual Secondary and Replacement Path Inventory

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` |  |  |
| Qualifying Chinese comment lines `C` |  |  |
| Ratio `C / E` |  | `N/A` when `E = 0` |
| Required minimum `C` |  | `if E = 0: C = 0`; `if E > 0: C >= max(1, ceil(E * 0.15))` |

### Remaining Unverified Items

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes |  |  |  |  |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

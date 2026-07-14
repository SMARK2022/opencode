# First-Principles Engineering Policy

This document is the single source of truth for first-principles planning,
adversarial audit, and approved-plan implementation in this repository. The
workflow skills under `.opencode/skills/` must reference this file. They may
restate a gate where a phase executes it. This policy controls any conflict,
and no restatement may weaken or change its meaning.

## Purpose

The policy prevents a recurring failure pattern in automated engineering:

1. The intended primary behavior `A` is incomplete or incorrect.
2. Instead of repairing `A`, an agent disables or bypasses it.
3. The agent introduces a second behavior `B` as a fallback.
4. Audits discover that `B` does not preserve all of `A`.
5. The agent adds `B1`, `B2`, `B3`, and later `C1`, `B12`, or more guards.
6. The original defect remains while the implementation accumulates competing
   semantics, responsibility leaks, and unverified edge handling.

The required alternative is to establish the intended invariant, find the
first point where reality diverges from it, repair that point in the module
that owns the behavior, remove superseded workarounds, and verify the original
behavior through the correct interface.

## Precedence

Apply instructions in this order:

1. Explicit user requirements.
2. Repository and package-local `AGENTS.md` instructions.
3. Accepted ADRs and the repository domain model.
4. This policy.
5. The canonical plan for the current task.
6. General engineering preferences.

A canonical plan may specialize this policy, but it may not silently weaken a
hard gate. A user-authorized exception must quote the user's instruction in the
plan.

## Non-Negotiable Gates

> **No evidence, no edge case.**

> **No reachability proof, no blocking finding.**

> **Without root-cause repair or an explicit user-requested rollback, no plan approval.**

> **Never invent a fallback. Only an explicit user-requested rollback may replace the primary path.**

> **One responsibility, one authoritative semantic path.**

> **If the interface does not own it, the implementation must not absorb it.**

> **No confirmed requirement left unmapped.**

> **No proposed production concept left unjustified.**

> **No canonical revision, no audit.**

> **No approved revision, no implementation.**

> **Any substantive plan change invalidates prior approval.**

> **Any blocking finding triggers a full-scope re-audit.**

> **Builder transcript is not evidence.**

> **No full-scope clean implementation audit, no completion.**

## Vocabulary

### Primary path

The one authoritative semantic path that implements a supported production
behavior. A primary path may use private helpers and may branch over distinct
members of the supported input domain. Those branches must implement one
coherent contract; they must not compete as alternative ways to obtain
success.

"One primary path" does not mean one giant function. It means one source of
behavioral truth.

### Root cause

The first point in the real execution chain where an intended invariant stops
holding. A downstream symptom, exception wrapper, missing guard, or UI artifact
is not automatically the root cause.

### Workaround

Logic that compensates for an earlier incorrect transition without restoring
the violated invariant at its owner. A workaround may be useful during an
incident, but it is not a root-cause repair and must not silently become the
new architecture.

### Alternate success path

Any path that runs after the primary path fails, rejects, or appears uncertain
and still attempts to produce a result that callers treat as successful.

Examples include:

- Trying parser B after parser A fails.
- Reading data source B after data source A fails without an explicit product
  contract.
- Catching an error and synthesizing a success-shaped default.
- Disabling feature A and routing callers through replacement B because A is
  harder to repair.
- Trying multiple quoting, decoding, or serialization strategies until one
  appears to work.

### Fallback

A fallback is an alternate success path activated by primary-path failure or
uncertainty. New fallbacks are forbidden by default.

An explicit user-requested behavior rollback is not a fallback. It deliberately
replaces current primary behavior instead of activating after primary-path
failure. The canonical plan must quote the request and define the exact target
behavior, transition condition, semantic difference, observability, tests,
owner, and removal or reconsideration condition. Authorization is specific to
that path and revision and does not permit adjacent recovery behavior.

An existing shipped compatibility path may be preserved when concrete external
consumers or persisted data require it. Preservation does not authorize
expansion or the creation of a second implementation.

### Diagnostic path

A path that records, marks, measures, or exposes abnormal behavior without
pretending that the primary operation succeeded. It may return a typed
`unsupported`, `unavailable`, or diagnostic state when that state belongs to
the interface.

A diagnostic path must not:

- Produce success-equivalent output.
- Hide primary-path failure.
- Become a second production algorithm.
- Accumulate compatibility transformations.
- Exceed the diagnostic budget defined below.

### Pass-through

Behavior explicitly promised by an interface whose contract is to transform a
recognized subset and preserve non-matching input. Pass-through is part of the
primary contract when non-applicability is an expected result.

Returning the original input is a hidden fallback when the interface instead
promises successful transformation of every accepted input. Classification
depends on the real interface, not on whether source code uses the word
`fallback`.

### Guard

Validation or rejection performed at the module that owns the relevant trust
seam. A guard is justified only by an actual reachable input, an interface
contract, an explicit threat model, or a repository rule.

Duplicating an upstream guarantee in every downstream module is not defense in
depth by default. It is duplicated responsibility unless the downstream seam
is independently public or untrusted.

### Responsibility leak

Implementation that makes a module own behavior not promised by its interface.
Common leaks include adding parsing, compatibility, retries, temporary storage,
fallback policy, permission decisions, or observability to a module whose
actual responsibility is narrower.

## Evidence Model

Classify every important claim using exactly one evidence class.

### Observed

The behavior appears in a reproducible test, trace, production artifact,
captured payload, benchmark, or other directly inspected result.

### Contracted

The behavior is required by an explicit user instruction, public interface,
accepted ADR, schema, protocol, repository rule, or established external
compatibility contract.

### Reachable

The behavior is not yet observed, but the current producer-to-consumer chain
proves that it can occur. A public untrusted interface can establish
reachability without a historical incident.

### Speculative

The behavior is merely conceivable. It lacks a current producer, interface
contract, threat model, persisted consumer, or demonstrated execution path.

Speculative concerns may be recorded as non-blocking notes. They must not drive
production guards, abstractions, configuration, compatibility paths, or
blocking findings.

## Reachability Proof

Before treating an input or edge condition as blocking, establish:

1. The producer of the value.
2. The type or representation at each seam.
3. Existing parsing, validation, or normalization upstream.
4. The exact call path by which the value reaches the target module.
5. Whether callers can bypass upstream guarantees.
6. Whether the target module is independently public or untrusted.
7. Which interface owns rejection, recovery, or compatibility.

For example, a module receiving an already-decoded object does not own malformed
JSON handling merely because JSON existed upstream. A module accepting raw
untrusted text at its public interface does own parsing or rejection.

## Root-Cause Analysis and Approved-Route Protocol

Every plan and implementation must perform these steps in order:

1. State the intended invariant in behavioral language.
2. Reconstruct the real producer-to-consumer execution chain.
3. Capture the current failure with a red-capable feedback loop when the task is
   a bug or regression.
4. Find the first transition where the invariant becomes false.
5. Identify the module and interface that own that transition.
6. Repair that transition instead of compensating downstream, unless the plan
   implements an exact user-requested behavior rollback.
7. Delete or collapse workarounds made obsolete by the approved route.
8. Verify both the minimized behavior and the original user-visible scenario.

A plan is blocked when it cannot identify the invariant, the first divergence,
or the owner and nevertheless proposes production changes.

## Primary-Path Rules

The following are blocking by default:

- Disabling primary behavior A and introducing behavior B.
- Keeping broken A while compensating in a caller, adapter, or UI.
- Sequentially trying independent implementations until one succeeds.
- Adding a configuration switch to avoid correcting the default behavior.
- Swallowing an error and returning a success-shaped value.
- Creating a temporary compatibility layer without a real persisted or external
  consumer.
- Adding a production path solely to make a test easy to write.
- Retaining dead or superseded helpers after the primary repair.

Private helpers are allowed when they decompose one algorithm or hide a real
seam. They are not allowed to encode competing semantics.

## Secondary-Path Budget

The default budget for a new alternate success path is zero, regardless of
line count.

Diagnostic behavior may occupy at most 10 percent of the changed production
decision surface. For this policy, the decision surface includes new or
modified executable branches, helper paths, state transitions, and error
outcomes. Tests, documentation, generated files, formatting, imports, and
comments do not increase the budget.

The 10 percent limit is a maximum, not an entitlement. A three-line fallback
that creates alternate success is still forbidden. A diagnostic path within
the budget is still blocked if it hides failure or belongs to another module.

The canonical plan and implementation audit must state:

- The primary path.
- Every secondary or replacement path.
- Whether each such path is a primary-contract branch, pass-through, diagnostic,
  existing compatibility, explicit user-requested rollback, or forbidden
  fallback.
- The estimated and actual decision-surface ratio.

## Responsibility Ownership

Use these default owners unless repository evidence establishes another seam.

| Concern | Default owner |
| --- | --- |
| Raw input validation | First trust seam |
| Domain invariants | Domain module |
| External wire-format compatibility | Adapter |
| Retry and timeout policy | Orchestration module |
| Temporary files and transport buffering | Transport or storage implementation |
| Fallback product policy | Explicit product orchestration, only when requested |
| Logging, metrics, and alerts | Observability seam |
| Persisted schema migration | Persistence owner |
| Output compatibility | Public interface or adapter that promises it |
| Permission and approval | Permission/workflow module |

For every added behavior, answer:

1. Does the module's interface promise it?
2. Is this module the first owner after the relevant seam?
3. Does an upstream or dedicated module already own it?
4. Would deleting the behavior violate a confirmed requirement?
5. Is the behavior duplicated elsewhere?

If the interface does not own the behavior, move it to the owner or remove it.

## Complexity Calibration

"Minimal" and "complete" are symmetric obligations.

Prevent under-design with forward traceability:

| Confirmed requirement or invariant | Production path | Change location | Behavioral test |
| --- | --- | --- | --- |

Every observed, contracted, or reachable requirement in scope must map to an
implementation path and a behavioral test or an explicit reason why automated
verification is impossible.

Prevent over-design with reverse traceability:

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |

Every new module, interface method, adapter, helper, branch, state, setting,
cache, retry, guard, compatibility rule, migration, or dependency must map back
to evidence. Unmapped production concepts are blocking and must be removed.

Do not judge complexity by line count alone. A small change is incomplete when
it omits confirmed behavior. A large change is excessive when concepts lack
evidence or locality.

## Canonical Specification

Every planned change must have one canonical plan file. Use a user-provided
path when present. Otherwise prefer the repository's established plan location;
if no convention exists, use `docs/plans/<task-slug>.md`.

The canonical plan, not chat, is the implementation contract.

Required metadata:

- `Status`
- `Revision`
- `Approved revision`
- `Audit mode`
- `Requirement source`
- `Implementation allowed`

Allowed statuses:

- `draft`
- `research-complete`
- `audit-required`
- `approved`
- `implementing`
- `implementation-audit-required`
- `verified`
- `complete`
- `blocked`

Any substantive change to behavior, scope, interface, tests, ownership,
fallback classification, or file plan must increment the revision and clear
approval. A chat explanation does not revise the plan.

Implementation is allowed only when the current revision exactly equals the
approved revision and the audit record states that the same revision received
a full-scope result of `No blocking findings`.

### Recording an independent verdict

The independent auditor is read-only. The orchestrating primary agent records
the verdict in the canonical plan after the auditor returns.

The recorder must:

- Copy the auditor's finding IDs, classifications, and release verdict without
  paraphrasing or omission.
- Record the audited revision and whether the audit covered full scope.
- Preserve blocking and non-blocking classifications exactly.
- Link the verdict to the corresponding audit invocation when the runtime
  exposes an invocation or message identifier.
- Avoid changing any substantive plan content in the same administrative edit.

A clean plan verdict for revision `Rn` permits only this transition:

```text
Status: approved
Revision: Rn
Approved revision: Rn
Implementation allowed: yes
```

Recording that clean verdict does not increment the revision because it does
not change the design. Any other substantive edit increments the revision,
clears approval, and requires another full-scope audit.

A blocking verdict leaves implementation disallowed. The builder must revise
the plan, increment the revision, copy the resolved finding references into the
audit record, and request a new full-scope audit.

A clean implementation verdict is copied verbatim into the implementation
audit record before the status changes to `verified`. Chat-only audit results
never satisfy a state transition.

## Adversarial Independence

The builder and auditor have different roles.

The auditor must receive only:

- The original user requirement.
- The canonical plan path.
- The repository root.
- The audit mode.
- For implementation audit, the actual changed-file list and diff.

Do not send the builder's self-review, suspected issue list, design defense,
preferred audit scope, or claims about what has already been ruled out.

The auditor must treat builder summaries and transcript as untrusted. It must
reconstruct relevant behavior from source, tests, contracts, and the canonical
artifact.

After any blocking finding and revision, the next audit covers the original
requirement and the complete affected interface again. It must not shrink to
the recently edited section.

## Finding Standard

A blocking finding must contain:

- The violated invariant.
- Evidence class: `observed`, `contracted`, or `reachable`.
- The producer and execution path.
- Source references with paths and lines.
- Canonical-plan references.
- Ownership reasoning.
- The behavior-level consequence.
- A minimal correction direction that does not introduce fallback.

Unsupported concerns must be marked `Rejected speculation`, not left as vague
risk.

Finding classes:

- `Blocking`
- `Non-blocking`
- `Rejected speculation`
- `Open decision`
- `No blocking findings`

## Blocking Standards

The following block plan approval or implementation completion:

- Root cause is bypassed without an exact user-requested rollback.
- Primary behavior is disabled without explicit user rollback.
- A new alternate success path exists.
- A responsibility is assigned outside its owning interface.
- Speculative input drives production code.
- A confirmed requirement lacks an implementation or test mapping.
- A production concept lacks requirement and evidence mapping.
- Current and approved plan revisions differ.
- The plan, code, tests, and reported behavior have drifted.
- Audit scope was narrowed after a revision.
- A regression test cannot fail on the original defect.
- Tests assert implementation details rather than behavior.
- Existing tests or safeguards were weakened to make the change pass.
- Errors are swallowed or converted into success without an explicit contract.
- Code-quality or Chinese-comment gates below fail.

The following do not block unless a repository rule makes them mandatory:

- Personal naming preferences.
- Formatting preferences.
- Hypothetical future extensibility.
- Inputs without a reachable producer or public untrusted seam.
- Performance concerns without measurement or a demonstrated hot path.
- Security concerns without a threat model, reachability, and ownership proof.
- A different but behaviorally equivalent design preference.

## Code-Quality Gate

Implementation audit must block when the changed code:

- Violates repository or package-local style.
- Introduces `any`, unchecked casts, non-null assertions, or type suppression
  contrary to local rules.
- Adds unused helpers, dead branches, duplicate abstractions, or pass-through
  modules.
- Adds production code solely for tests.
- Expands a public interface, configuration surface, or dependency set without
  a confirmed requirement.
- Performs unrelated refactoring or formatting.
- Duplicates an existing implementation instead of repairing or reusing it.
- Swallows errors, weakens permissions, or reduces existing safety.
- Leaves superseded workarounds or compatibility branches behind.
- Uses a shallow interface that exposes complexity callers should not own.
- Fails the repository's required tests, typecheck, lint, build, generation, or
  migration verification.

## Chinese Explanatory Comment Gate

The 15 percent Chinese explanatory-comment requirement is a hard implementation
and audit gate.

Define:

- `E`: added or substantively modified non-blank code lines in production,
  tests, and configuration. Exclude import-only changes, formatter-only changes,
  generated files, and pure file movement.
- `C`: added or substantively modified Chinese explanatory comment lines that
  are adjacent to the relevant change and explain rationale, an invariant, a
  real boundary, a constant's meaning, a test's behavioral intent, a
  compatibility contract, or a safety constraint.

Required count:

```text
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

Comments do not count merely because they contain Chinese. The following do not
qualify:

- Restating an assignment, call, condition, or return.
- Translating an identifier into Chinese.
- Repeating the test name.
- Describing obvious control flow.
- Concentrating unrelated comments at a file or function header.
- Adding comments to generated files.
- Splitting one explanation into many short lines to game the ratio.

Qualifying comments explain why the code exists or what future changes must not
break. Examples:

```ts
// 保持原始命令参与权限判断，避免规范化结果降低已有 deny 风险。
```

```ts
// 该断言锁定用户可观察行为，不依赖内部 helper 的调用次数。
```

Comments must be distributed near the changed decisions they explain. A change
with insufficient qualifying comments is blocked even when all tests pass.

The canonical plan must estimate `E` and the minimum `C`. The implementation
report and auditor must state the actual values, calculation method, and any
excluded lines.

## Iteration Limits

- Plan audit: at most 6 full rounds.
- Implementation audit: at most 3 full rounds.
- Independent auditor invocation failure: at most 3 consecutive retries.

At the round limit, unresolved blocking findings remain blocking and become
explicit open decisions for the user. Approval and completion remain
prohibited. An unavailable auditor must be reported as
`independent-audit-unavailable`; it must not silently degrade into self-review.

## Completion

Planning is complete only when a canonical revision is marked
`audit-required` and contains all required evidence and mappings.

Plan approval is complete only when an independent full-scope audit records
`No blocking findings` for the exact current revision.

Implementation is complete only when:

- The approved primary-path repair or exact user-requested rollback is
  implemented.
- Required red-green behavioral tests pass.
- The original feedback loop passes for bug work.
- Required repository verification passes.
- Superseded workarounds are removed.
- No unauthorized fallback or responsibility leak exists.
- The Chinese explanatory-comment gate passes.
- An independent full-scope implementation audit records
  `No blocking findings`.
- Remaining unverifiable items are reported explicitly.

Completion never implies permission to create a commit or push. Those actions
require an explicit user request.

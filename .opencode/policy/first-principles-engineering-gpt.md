# First-Principles Engineering Policy GPT

This is the independent GPT variant of `first-principles-engineering.md`.
The strict policy remains unchanged. GPT workflow skills reference this file;
explicit user requirements and user-authorized review rules take precedence
over its defaults. Use evidence to find material defects without turning a
migration into a general hardening or redesign project.

## Purpose

The policy prevents a recurring failure pattern in automated engineering:

1. The intended primary behavior `A` is incomplete or incorrect.
2. Instead of repairing `A`, an agent disables or bypasses it.
3. The agent introduces a second behavior `B` as a fallback.
4. Audits demand additional guarantees or exact preservation of every edge case.
5. The agent adds `B1`, `B2`, `B3`, and later more guards and abstractions.
6. The original defect remains while the implementation accumulates competing
   semantics, responsibility leaks and downstream replay conflicts.

Establish the intended main behavior, find the first material divergence in
the real execution chain, repair that point at its owner and verify the
user-visible scenario. Retain working source behavior by default. The existence
of an inherited general risk does not authorize a new engineering project.

## Precedence

Apply instructions in this order:

1. Explicit user requirements, including accepted risks and semantic tradeoffs.
2. Repository and package-local `AGENTS.md` instructions.
3. The user-authorized task-specific GPT review contract.
4. Accepted ADRs and the repository domain model within the task's scope.
5. This policy and the current canonical plan, when a plan is part of the task.
6. General engineering preferences.

User authorization applies when given; document synchronization is not a
prerequisite. For SMARK post-replay review, the Admission Gate section of
`.temp/patches/AUDIT_CONTRACT_GPT.md` governs the review standard. Read
`.temp/workflow-gpt.md` and use the `adversarial-audit-gpt` skill and
`adversarial-patch-auditor-gpt` agent. Do not import strict counterparts as
additional gates. Patch records and the manifest are the canonical artifacts
for this review; do not require a separate implementation plan.

## Non-Negotiable Gates

> **No evidence, no speculative production change.**

> **Reachability plus a material consequence, not reachability alone.**

> **Repair the owning primary path with the smallest necessary change.**

> **Do not invent fallback, compatibility or safety responsibilities.**

> **Preserve the user's accepted scope and risk tolerance.**

> **Builder explanations are investigation leads, not proof.**

> **Material repairs require independent full-scope re-audit.**

> **Do not claim unperformed validation or uninspected entries as passed.**

## Vocabulary

### Primary path

The authoritative semantic path implementing a supported production behavior.
A primary path may use private helpers and branch over supported inputs.
These branches implement one coherent contract; one primary path does not
mean one giant function. Distinct live V1/V2 implementations are judged by
their real responsibilities, not by the mere presence of two versions.

### Root cause

The first point in the real execution chain where the required behavior stops
holding. A downstream symptom, missing guard or UI artifact is not automatically
the root cause. For replay, identify whether the divergence was inherited,
introduced or materially amplified by target adaptation.

### Workaround

Logic compensating for an earlier incorrect transition without restoring the
behavior at its owner. Do not add workarounds to avoid a necessary primary-path
repair. Existing source workarounds do not require removal merely to satisfy a
preferred architecture when the main behavior still works.

### Alternate success path

A path that runs after primary-path failure or uncertainty and produces a
result callers treat as successful. Examples include trying another parser,
reading a semantically different source, or returning a success-shaped default.
Classification depends on the actual contract and consequence, not a keyword.

### Fallback

A fallback activates after primary-path failure or uncertainty. Do not introduce
a new fallback solely to make a migrated implementation pass. An explicit
user-requested behavior change may replace the primary path; it does not imply
permission for adjacent recovery mechanisms. Preserving an existing source
fallback is not automatically a replay defect or a reason to redesign it.

### Diagnostic path

A path recording or exposing abnormal behavior without pretending the primary
operation succeeded. Diagnostics should remain small and local, without hiding
failure or becoming a second production algorithm. Judge their behavior and
ownership; do not calculate a diagnostic-ratio release gate.

### Pass-through

Behavior promised by an interface that transforms recognized input and preserves
non-matching input. Determine whether non-applicability is an expected result
from actual producers and consumers before treating pass-through as a defect.

### Guard

Validation or rejection at the module owning a real trust seam. A reachable input
and owning interface can justify a necessary repair; they do not require adding
every conceivable protection. Duplicating upstream guarantees is not required
defense in depth. Do not add guards for inherited general risks outside the task.

### Responsibility leak

Implementation making a module own behavior outside its interface, such as
parsing, retries, temporary storage, permissions or fallback policy. Report the
actual consequence and smallest correction; do not turn every imperfect boundary
in existing code into a migration blocker.

## Evidence Model

Classify material concerns as `observed`, `contracted`, `reachable`, or
`speculative`.

### Observed

The behavior appears in an inspected test, trace, captured payload, benchmark
or other concrete result. The auditor reads existing evidence; it does not
run commands during patch review.

### Contracted

The behavior is required by the user's current instructions, a relevant public
interface, schema, protocol, accepted ADR or actual compatibility consumer.
An older stricter document does not override a later accepted tradeoff.

### Reachable

The current producer-to-consumer chain shows how the condition can occur.
Reachability supports a finding but does not establish its severity or require
that every existing risk be fixed.

### Speculative

The condition is merely conceivable, without a current producer, relevant
contract, threat model, persisted consumer or demonstrated execution path.
Mark it `Rejected speculation`; do not use it to demand production guards,
abstractions, configuration, compatibility or a blocker.

## Reachability Proof

For a proposed blocker, establish only the evidence needed to understand:

1. The producer and actual path to the affected owner.
2. Existing parsing, validation or normalization relevant to the concern.
3. The original behavior and the target's material divergence.
4. The concrete main-function, data, permission or common-user consequence.
5. Why the consequence exceeds the user's accepted risk or semantic loss.

Security concerns still require a real threat model and ownership. "Defense
in depth" alone is not sufficient. Avoid unrelated reading and duplicate proofs.

## Root-Cause Analysis and Approved-Route Protocol

For a confirmed material defect:

1. State the expected behavior in product terms.
2. Reconstruct the relevant producer-to-consumer chain.
3. Use existing tests or the narrowest appropriate feedback loop.
4. Locate the first incorrect transition and its owner.
5. Repair that transition with minimal divergence from the existing patch.
6. Remove only workarounds directly made obsolete by that repair.
7. Verify the original user-visible scenario.

Do not make a new plan, red-test transcript or complete traceability matrix an
admission requirement for an already-replayed patch. The absence of these
documents is not a product defect.

## Primary-Path Rules

Inspect these patterns for real behavior consequences:

- Disabling a main feature to avoid implementing it on the target.
- Compensating in a caller while a material owning-path defect remains.
- Trying independent implementations until one reports success.
- Adding a configuration switch to conceal a broken default.
- Swallowing failure and returning an incorrect success result.
- Adding compatibility without a real consumer or persisted-data requirement.
- Adding production paths solely to make tests easier.

They are not unconditional blockers merely because a pattern already appears
in source. During replay, require material regression, amplification or loss
of the main capability. Keep low-impact inherited behavior as N. Private helpers
may decompose one algorithm or hide a real seam without creating a new owner.

## Secondary-Path Budget

Keep new diagnostic and recovery logic minimal and within the requested feature.
Do not introduce alternate success paths as a substitute for necessary repair.
There is no percentage-based diagnostic gate in this GPT policy. A small change
can cause a material defect; a larger inherited branch can remain unchanged.

## Responsibility Ownership

Use these default owners unless repository evidence establishes another seam:

| Concern | Default owner |
| --- | --- |
| Raw input validation | First trust seam |
| Domain invariants | Domain module |
| External wire-format compatibility | Adapter |
| Retry and timeout policy | Orchestration module |
| Temporary files and transport buffering | Transport or storage implementation |
| Product fallback policy | Explicit product orchestration |
| Logging, metrics and alerts | Observability seam |
| Persisted schema migration | Persistence owner |
| Output compatibility | Public interface or adapter promising it |
| Permission and approval | Permission/workflow module |

For a new behavior, check whether the interface owns it, another module already
provides it, and a required main feature actually fails without it. Prefer
existing logic over a new abstraction. Do not require a general ownership cleanup
of the source design as part of an otherwise faithful replay.

## Complexity Calibration

Default to preserving the pre-review current patch's variables, interfaces,
structure and order. For this review, compare new changes with current in HEAD,
not original. Original defines source intent. About 25 percent is a suggested
edit-size guide, not a hard threshold or reason to calculate more metrics.

An alternative implementation is appropriate when it carries the intended
function with fewer files, less code and simpler dependencies. This is optional;
do not require a rewrite to improve theoretical extensibility or robustness.

For completeness, trace the main feature to its executable owner. For added
complexity, identify the concrete task need. Use existing evidence rather than
requiring a new table or requirement ID for every helper. Low-impact omitted or
consolidated hunks and boundary differences may be N under the user's acceptance.

## Canonical Specification

Use the existing canonical artifact appropriate to the task. For SMARK review,
this is the supplied original/current batch, manifest and associated records.
Do not create a separate plan solely to make review admissible. For a task that
explicitly requests a plan, use its approved scope and revision.

Do not falsely claim a changed implementation matches an old verified result.
At the same time, revision labels, record timing and documentation placement do
not independently block when the actual behavior and current evidence can be
inspected. The latest user authorization is effective before records are updated.

### Recording an independent verdict

The auditor is read-only. The primary agent preserves the returned finding
classifications, scope and verdict in the existing record when an update is
needed. Keep old evidence as history, do not backfill PASS, and do not rewrite
every record to satisfy a new format or word count.

A disputed classification is resolved through independent reconsideration of
the actual source, consequence and user authorization. Record a corrected verdict
as a new result rather than silently rewriting the old one. N does not require
code changes or another full review round.

## Adversarial Independence

The builder and auditor have different roles. Initial handoff contains the user
requirement, canonical artifact paths, repository root, full scope and matching
verification evidence. Do not seed the initial review with the builder's preferred
findings or defense. Auditors in the same paired round do not read each other's
conclusions.

The builder may rebut a finding using user instructions, source and validation
evidence. The auditor independently checks these leads and corrects unsupported
or out-of-scope findings. Repeating a desired PASS is not evidence. Neither
defending a prior verdict nor deferring to the builder replaces investigation.

After confirmed material repairs, review the original complete batch again.
Do not narrow the next audit to only the edited hunk. Do not demand production
changes before reconsidering a finding that was never a material blocker.

## Finding Standard

A blocker needs observed, contracted or reachable evidence, a relevant owner,
the source-to-target divergence and a concrete material consequence. Cite the
actual paths and give the smallest correction direction. Distinguish original
risk, replay regression and amplification by the target architecture.

SHA-256, bytes, E/C, comment counts, word counts, record timing, metadata and
diagnostic ratios never become standalone blockers. Do not compute checksums.
Read existing source proof and reports without regenerating source Git or
requiring every historical state and verdict.

Finding classes:

- `B`: material behavior blocker.
- `G`: actual applicable validation failure or essential evidence gap.
- `N`: non-blocking risk, accepted difference or record observation.
- `Rejected speculation`: concern without sufficient evidence.
- `No blocking findings`: no confirmed B/G after complete review.

## Blocking Standards

B applies when replay introduces or materially amplifies a defect, or the
original main capability cannot work in the target. Concrete examples include
wrong primary results, major feature loss, material data or permission regression,
and reachable concurrency or cleanup defects with substantial consequences.

G applies to cumulative application failure, actual failure of an applicable
mandatory check, or missing essential verification that prevents judgment of a
specific main behavior. Explain that gap and continue the remaining investigation.
A missing field, intermediate state or old report is not an executed-check failure.

Inherited general risks, small behavior differences, nonessential missing hunks,
style preferences and documentation defects are N. Do not manufacture a production
consequence for them. False claims of successful verification cannot substitute
for actual evidence; identify the unsupported material conclusion precisely.

## Code-Quality Gate

Follow the target's naming, types, error handling and module structure when
editing. Review unchecked casts, duplicate abstractions, interface expansion,
swallowed errors and test weakening for actual consequences within the scope.
Use B/G only under the materiality standards above; style alone does not justify
rewriting a working patch or removing an inherited implementation.

Prefer adapting existing tests. Required validation is selected by the real
change and current CI expectations, not a mandate to run every workspace suite.
Compatibility-only failures are reported with their impact rather than silently
promoted to mandatory product gates. The primary agent executes checks; the
auditor remains read-only.

## Chinese Explanatory Comment Gate

Use the GPT contract's shared thresholds: the builder targets about 15 percent
meaningful Chinese explanatory comments; review accepts about 10 percent or more.
These are quality guides, not exact arithmetic release gates. Slight shortfalls,
counting differences and comment-quality observations are N.

Define:

- `E`: substantively added or modified production, test and configuration lines,
  excluding import-only, formatting-only, generated and pure-move changes.
- `C`: nearby Chinese explanations of rationale, real boundaries, invariants,
  constants or behavioral test intent.

Use reasonable per-patch estimates and representative locations, not repeated
recomputation or cross-patch aggregation. When E is zero, do not add comments for
a ratio. New or revised explanatory comments are Chinese. Leave unrelated
existing material alone instead of creating broad comment-only churn.

Do not reward restated code, translated identifiers, repeated test names, obvious
control-flow narration, duplicated explanations, function-header comment walls
or split lines used to inflate counts. Place explanations by the decisions they
explain, normally at most two consecutive lines; line width is not constrained.

## Iteration Limits

- Resolve unsupported or out-of-scope findings through evidence-backed rebuttal.
- Re-audit the original scope after confirmed material repairs.
- Do not repeat code changes or full audits for N alone.
- Retry independent auditor invocation failures at most three consecutive times.

If an actual independent review remains unavailable, report
`independent-audit-unavailable`; do not invent PASS or substitute self-review.
If a material issue genuinely requires a product decision, state that specific
decision instead of extending the implementation beyond the authorized scope.

## Completion

Review is complete when the full supplied scope has been investigated, the
required paired verdicts agree, actual applicable validation is accounted for,
and no confirmed B/G remains. PASS may include N for accepted risks, low-impact
losses and record or comment observations.

Keep unresolved material evidence gaps explicit. Completion does not require
exact preservation of every source hunk, elimination of inherited general risk,
hash calculations or documentation backfill. It never grants permission to
commit, push, rewrite Git history or modify another worker's files.

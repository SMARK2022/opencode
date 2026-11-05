---
name: first-principles-planning
description: Use ONLY when the user asks for an implementation plan, design proposal, root-cause repair plan, or when the approved-plan workflow requires a fresh canonical plan. Research the current repository from scratch, write or revise the versioned canonical plan, and do not modify production code.
---

# First-Principles Planning

Produce an evidence-bounded, independently auditable implementation plan. The
default route must repair the owning primary path. Only an exact, quoted
user-requested rollback may replace that path, and it must never become a
failure-triggered fallback implementation.

## Required References

Before planning, read:

1. `.opencode/policy/first-principles-engineering.md`
2. `.opencode/templates/canonical-plan.md`
3. The repository's `CONTEXT.md`, relevant ADRs, and every applicable
   `AGENTS.md`

The shared policy is authoritative. Do not copy a weaker interpretation into
the plan.

## Scope

This skill may inspect the repository and create or revise the canonical plan.
It must not modify repository production code, tests, configuration, migrations,
generated files, or live business data. Within the user's permissions, use
temporary scripts or in-memory copies to reproduce problems and compare
candidate routes before approval.

This skill does not audit its own plan. It prepares the artifact for an
independent adversarial audit.

## Hard Gates

> **Start from current repository evidence for every new task.**

> **Without root-cause repair or an explicit user-requested rollback, no audit handoff.**

> **Repair the origin of the bad state or cost. Downstream containment only supplements that repair.**

> **Never invent a fallback. Only an explicit user-requested rollback may replace the primary path.**

> **No evidence, no edge case.**

> **No canonical document, no final plan.**

Do not claim that prior conversation, an old audit, or a nearby implementation
has already established the current task. Re-read the current files and verify
the current call path.

## Phase 0: Establish the Canonical Artifact

1. Identify the stable source of the user requirement.
2. Select exactly one canonical plan path.
3. Use the repository's existing plan location when one exists; otherwise use
   `docs/plans/<task-slug>.md`.
4. Copy the structure from `.opencode/templates/canonical-plan.md`.
5. Set `Status: draft`, `Revision: R1`, `Approved revision: none`, and
   `Implementation allowed: no` for a new plan.
6. Quote the user requirement without narrowing or embellishing it.

If a plan already exists, read its complete current revision and audit record.
Never maintain a second plan in chat.

## Phase 1: Rebuild Repository Context

Read enough of the actual repository to reconstruct the relevant behavior, not
just the entry point. Start from the failing or requested path and follow it.
Take the full inventory below for the responsibility you will change, not for
everything nearby.

Inspect all relevant instances of:

- Domain vocabulary and ADRs.
- Public and internal interfaces.
- Producers and consumers.
- Callers and references.
- Existing tests and fixtures.
- Configuration and feature selection.
- Error propagation.
- Concurrency, cancellation, shutdown, and cleanup when reachable.
- Persistence and generated-code chains when reachable.
- Permission and security seams when reachable.
- Existing compatibility and fallback behavior.

Search for every call site and every duplicate implementation of the affected
responsibility. Record what was read and why it matters in the plan.

Completeness is bounded by evidence. Do not invent malformed inputs, hostile
callers, compatibility consumers, or future extension points without proving a
producer, public untrusted interface, contract, or repository rule.

## Phase 2: Establish the Feedback Signal

If the task is a bug, failure, or performance regression, load and follow the
`diagnosing-bugs` skill before designing the repair.

The plan must record:

- The red-capable command or harness.
- The exact user-visible symptom it catches.
- The observed result.
- The minimized reproduction.
- For a failure, instability, or cost symptom, a measurement taken where the
  cost or bad state is generated (duration, work count, allocation,
  contention), not only where the symptom is observed.

Do not replace diagnosis with source inspection. No red-capable feedback signal
means no root-cause repair plan, unless the inability to reproduce is itself
explicitly documented and returned to the user as a blocker under the
`diagnosing-bugs` rules.

For a new feature, identify the behavioral capability and the public seam at
which a failing TDD slice will express its absence.

## Phase 3: State Invariants and Find the First Divergence

Assign stable IDs to every confirmed requirement and invariant.

For each violated invariant:

1. State the expected behavior without referring to a proposed implementation.
2. Trace the real execution path.
3. Identify the first transition where the invariant becomes false.
4. Identify the module and interface that own that transition.
5. Separate downstream symptoms from the root cause.
6. Record the evidence class and source reference.

The first divergence is often only where the problem becomes visible. Continue
backward along a single causal chain, one "why" at a time, with one probe per
step (profile, count, log, bisect), until you reach the origin: the logic, data
model, schema, interface, or amount of work that makes the bad state or cost
exist. At each step ask whether that state or work is required by a confirmed
requirement. Stop when the answer is definitely yes, or when the cause lies
outside code this task owns. But do not stop when you are not sure. Go broad
only afterwards, over the callers of the change point you chose.

Label each link on the chain as origin, propagation, or manifestation. A change
that leaves the origin producing the same bad state or work is containment,
wherever it sits in the stack.

- A test that times out: ask why the operation takes that long and whether that
  work is needed, not how long to wait.
- Memory growth: ask what is loaded or retained that no requirement uses, not
  when to collect it.
- A bad value: ask where it was formed wrongly, or why the representation
  admits it, not where to catch it.

A plan is blocked if it proposes changes before locating the first divergence
and the origin behind it.

## Phase 4: Design One Approved Primary Path

Design one authoritative semantic path that repairs the first divergence. If
the user explicitly requests behavior rollback, design only the exact quoted
replacement behavior and retain the invariant, divergence, and owner analysis.

Before finalizing this route, verify its key assumptions and the user's
plan-stage acceptance criteria. Use isolated experiments where execution is
needed, and record results and tested scope in the plan's verification section.
Do not propose an unverified plan and leave verification to the builder.

The design may use private helpers, but every helper must support the same
contract. Do not introduce competing parsers, serializers, data sources,
recovery implementations, or feature switches.

Repair the origin by eliminating the bad state or unneeded work, reducing what
the origin produces or loads, or correcting its model and interface so callers
stop compensating. Downstream containment (guards, retries, waits, timeout
increases, forced cleanup, or limit tuning) is only a supplement; use it alone
only when the origin lies outside this task's ownership or measured evidence
shows origin repair cannot meet the requirement, and record that reason in the
plan.

For a new capability, check that the owner's existing interface fits it. If the
consumer would have to stitch together several owner calls, rebuild or filter
data the owner already holds, or reach past the interface, extend the owner with
one small general operation instead, so the owner stays coherent and the
consumer stays thin. Keep a need that only one caller has in that caller rather
than adding a flag or mode to the owner. An interface extension needs the same
reverse-traceability entry as any other production concept.

Explicitly audit the proposed design for this prohibited pattern:

```text
primary A is wrong -> disable A -> add B -> add B1/B2/B3 to recover A's cases
```

If the proposal matches that pattern outside an exact user-requested rollback,
discard it and return to the first divergence. A rollback replaces the current
primary behavior directly. It does not authorize B1/B2/B3 recovery branches.

Also reject this pattern: the origin at A produces the bad state or cost, and
the plan only makes downstream B tolerate it. Return to the origin.

Inventory every current and proposed secondary or replacement path. Classify it
as:

- Supported-domain branch within the primary contract.
- Contracted pass-through.
- Diagnostic path.
- Existing shipped compatibility.
- Explicit user-requested rollback.
- Forbidden fallback.

Reject every forbidden fallback. The default allowance for a new alternate
success path is zero. For an explicit rollback, record the exact user quote,
target behavior, transition condition, semantic difference, observability,
tests, owner, and removal or reconsideration condition. The authorization is
specific to one path and one revision.

## Phase 5: Enforce Responsibility

For every proposed guard, compatibility branch, retry, temporary file, cache,
setting, adapter, error conversion, and diagnostic behavior, establish:

- The interface that promises it.
- The seam that makes the input reachable.
- Why this module owns it.
- Why no existing module already owns it.
- Which confirmed requirement would fail without it.
- Why repairing the origin does not already remove the need for it.

If those facts cannot be established, remove the behavior from the plan.

Do not place a full safety envelope around every internal helper. Put validation
at the real trust seam, compatibility in the owning adapter, retry in
orchestration, and observability in its own seam. These seams hold containment
that stays necessary after the origin is repaired.

## Phase 6: Balance Completeness and Restraint

Complete both traceability tables from the canonical template.

Forward traceability blocks under-design:

```text
confirmed requirement -> production path -> file change -> behavioral test
```

Reverse traceability blocks over-design:

```text
proposed concept -> requirement ID -> evidence -> why reuse is insufficient
```

Every confirmed requirement must map forward. Every proposed production concept
must map backward. Do not approve a plan with an empty cell justified only by
"best practice", "defense in depth", "future-proofing", or "safer fallback".

## Phase 7: Plan TDD and Verification

Load the `tdd` skill when defining test seams and behavior slices.

The test plan must:

- Name the agreed public seam.
- Proceed one vertical behavior slice at a time.
- State why each test fails before implementation.
- Use independent expected values.
- Avoid private methods, source-text checks, call-count assertions, and tests
  that reproduce implementation logic.
- Cover only observed, contracted, or reachable normal, boundary, error,
  concurrency, cleanup, compatibility, permission, and security behavior.

List exact verification commands and their working directories. Respect the
repository rule that tests and typechecks run from package directories when
required.

## Phase 8: Plan Code Quality and Chinese Comments

Estimate effective changed code lines `E` and the required qualifying Chinese
explanatory comments:

```text
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

Identify the exact non-obvious invariants, test intentions, constants, real
boundaries, compatibility reasons, and safety decisions that require nearby
Chinese explanation.

Do not plan comments that restate assignments or control flow. The ratio is a
hard gate, but meaningless Chinese text does not count.

## Phase 9: Write the Full Plan

Complete every applicable section of the canonical template, including:

- Current behavior and evidence.
- Supported input domain and reachability.
- Invariants and first divergence.
- Responsibility ownership.
- Single approved primary path or exact user-requested rollback.
- Secondary and replacement path inventory and ratio.
- Workaround deletion.
- Forward and reverse traceability.
- File-level changes.
- TDD slices.
- Chinese comment budget.
- Verification commands.
- Diff budget.
- Real risks, open decisions, and rejected speculation.
- Audit contract.

Use `Not applicable` with a concrete reason when a template section genuinely
does not apply. Do not silently omit sections.

Set the plan to:

```text
Status: audit-required
Approved revision: none
Implementation allowed: no
```

## Audit Handoff

Provide the independent auditor only:

- The verbatim user requirement.
- The canonical plan path.
- The repository root.
- `Audit mode: plan`.

Do not send a self-review, suspected issue list, defense of the design, or
preferred audit scope.

Any blocking finding requires:

1. A plan revision.
2. A revision increment.
3. Cleared approval.
4. A new audit of the complete original scope.

If the auditor returns `No blocking findings` for the exact current revision,
the orchestrating primary agent must copy the verdict and audit metadata into
the canonical plan without paraphrasing. That administrative edit may set:

```text
Status: approved
Approved revision: <current revision>
Implementation allowed: yes
```

Do not combine verdict recording with a design change. Any substantive change
increments the revision, clears approval, and requires another full-scope
audit.

Plan audit is limited to 6 full rounds. Independent auditor invocation may be
retried at most 3 consecutive times. Never substitute self-review for an
unavailable independent auditor.

## Completion Output

Do not paste a second complete plan into chat. Report:

- Canonical plan path.
- Current revision.
- Current status.
- The proven root cause or feature seam.
- The one-sentence primary-repair or rollback direction.
- Whether real open decisions remain.
- Whether independent audit is pending, approved, or unavailable.

Do not modify implementation code and do not claim implementation permission
until the exact revision receives a full-scope `No blocking findings` result.

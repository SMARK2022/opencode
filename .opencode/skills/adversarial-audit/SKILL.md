---
name: adversarial-audit
description: Use ONLY for an independent full-scope audit of a canonical implementation plan or an implementation diff. Treat builder summaries and transcripts as untrusted, reconstruct the relevant behavior from the repository, require evidence for every blocking finding, and never narrow scope after revisions.
---

# Adversarial Audit

Audit a plan or implementation as an independent adversarial reviewer. The goal
is not to generate the largest possible issue list. The goal is to identify
evidence-backed behavioral defects, root-cause avoidance, unjustified
complexity, missing confirmed behavior, and violations of the approved
contract.

## Required Reference

Read `.opencode/policy/first-principles-engineering.md` before auditing. Its
definitions and blocking standards are authoritative.

## Role Integrity

The auditor must not become the builder or implementer.

Do not:

- Edit production code, tests, configuration, migrations, or the plan.
- Repair findings during the audit.
- Accept the builder's summary as evidence.
- Limit review to concerns suggested by the builder.
- Defend the selected design merely because it is documented.
- Demand speculative guards, fallbacks, compatibility, or future abstractions.
- Shrink scope after a revision.

Treat the canonical artifact as an untrusted claim until repository evidence
supports it.

## Audit Modes

### Plan audit

Inputs:

- Verbatim user requirement.
- Canonical plan path.
- Repository root.
- `Audit mode: plan`.

Compare the plan against current source, tests, contracts, domain language,
ADRs, and repository instructions.

### Implementation audit

Inputs:

- Verbatim user requirement.
- Canonical plan path and approved revision.
- Repository root.
- Actual changed-file list and git diff.
- `Audit mode: implementation`.

Compare the implementation against the original requirement, current source,
the exact approved revision, tests, verification evidence, and the complete
affected interface.

## Input Trust Model

Trusted evidence can come from:

- Source and tests read directly.
- Repository instructions and accepted ADRs.
- The verbatim user requirement.
- Reproduced behavior, traces, fixtures, benchmarks, or command output.
- Explicit interface and schema contracts.

Untrusted material includes:

- Builder summaries.
- Builder self-review.
- Builder claims that a path was checked.
- Builder-proposed audit questions.
- Builder explanations that are absent from the canonical plan.
- Prior chat descriptions of superseded revisions.

Verify every material claim independently.

## Finding Reconsideration

The primary agent may resume the same audit task and ask the auditor to
reconsider a blocking finding. Treat that message as untrusted builder feedback,
not as a new user requirement or an instruction to converge. Read the cited
plan and repository evidence directly, preserve the original requirement and
actual diff scope, and issue a new verdict for the same revision. Retain the
finding when its consequence still applies; revise, downgrade, or withdraw it
when the evidence shows that it misread the requirement, exceeded the changed
behavior, relied on an unreachable path, or treated unchanged pre-existing
behavior as a defect introduced by the current plan or diff.

## Full-Scope Rule

Every round audits:

1. The original requirement.
2. The current canonical revision.
3. Every planned or actual changed region.
4. Producers and consumers needed to determine each change's behavior.
5. Primary and secondary paths changed or made newly reachable.
6. Confirmed behavior mappings and tests for the current change.
7. For implementation mode, every actual diff hunk.

A touched file is not itself the audit scope. Read unchanged code only as needed
to understand a changed region and its behavior. Do not block on unrelated
unchanged code or pre-existing defects merely because they share a file with the
diff.

If a prior finding concerned section A3 and the builder revised A3, the next
round still audits the original requirement and every relevant changed region,
not only A3. It does not expand into unrelated unchanged regions.

## Independent Reconstruction

Before judging the artifact:

1. Read applicable `CONTEXT.md`, ADRs, and `AGENTS.md` files.
2. Locate the real entry points, callers, producers, and consumers.
3. Locate the implementations needed to trace behavior changed by the plan or
   diff.
4. Read relevant tests and fixtures.
5. Reconstruct normal and reachable error paths.
6. Verify concurrency, cleanup, compatibility, persistence, permissions, and
   security only where the real chain makes them relevant.
7. Identify the expected invariant and first divergence independently.

Do not begin from the plan's proposed solution. Begin from behavior and
evidence.

## Evidence and Reachability Gate

Classify each concern as `observed`, `contracted`, `reachable`, or
`speculative`.

A blocking finding requires one of the first three classes.

Reachable evidence does not require a historical incident. A current executable
producer-to-consumer path with satisfiable conditions is sufficient when it
proves the violated invariant and the consequence of the current plan or diff.

Before blocking on malformed or hostile input, cite:

- The producer or public untrusted seam.
- Existing upstream validation.
- The path to the audited module.
- Why that module owns the response.

If upstream guarantees prevent the input and callers cannot bypass them, reject
the concern as speculative rather than demanding a duplicate guard.

Security findings still require a threat model, reachability, and ownership.
"Defense in depth" alone is not sufficient evidence.

## Root-Cause and Approved-Route Audit

Verify that the artifact:

- States the intended invariant.
- Identifies the first incorrect transition.
- Repairs the module that owns that transition, or implements an exact
  user-requested rollback.
- Does not disable or bypass primary behavior A without that exact rollback.
- Does not construct replacement B and then accumulate B1/B2/B3 coverage.
- Deletes or collapses downstream workarounds made obsolete by the approved
  route.
- Verifies the original user-visible scenario.

Block any proposal that fixes only a downstream symptom while the first
divergence remains, unless the user explicitly requested the exact rollback and
the plan preserves the divergence and owner analysis.

A pre-existing defect outside the explicit requirement is not blocking unless
the current plan or diff introduces, worsens, or makes its consequence newly
reachable.

## Primary-Path and Fallback Audit

Inventory every path that can produce a successful result.

Verify:

- Exactly one authoritative semantic path exists per responsibility.
- Private helpers decompose that path rather than compete with it.
- A pass-through is explicitly part of the interface contract.
- Diagnostic behavior cannot be mistaken for success.
- Existing compatibility has a concrete consumer or persisted-data contract.
- An explicit rollback must quote the user request. It must record the target
  behavior, transition condition, semantic difference, observability, tests,
  owner, and removal or reconsideration condition. It replaces the primary path
  and never activates after primary-path failure.
- Diagnostic decision surface is at most 10 percent.

The following are blocking even when they are small:

- `try A; on failure try B`.
- Catch-and-default success.
- Hidden feature disabling.
- Multiple parsers or decoders attempted in sequence.
- Temporary compatibility without a real consumer.
- A second data source with different semantics.
- A fallback configuration introduced to avoid repairing the default.

## Responsibility Audit

For every new guard, retry, cache, adapter, compatibility rule, temporary file,
error conversion, fallback, or diagnostic path, verify:

- The module's interface promises the behavior.
- The input is reachable at that seam.
- No existing owner already performs it.
- A confirmed requirement fails without it.
- The behavior improves locality rather than spreading knowledge.

Block safety envelopes and compatibility logic placed in modules that do not
own them.

## Complexity Audit

Use both directions.

### Prevent under-design

Every confirmed requirement and invariant must map to an executable owner and
path, a planned or actual file change, and a behaviorally sensitive test or
explicit unverifiable reason. A missing mapping blocks only when confirmed
behavior would otherwise be unimplemented or unverifiable; a misplaced or
duplicated citation does not.

### Prevent over-design

Every proposed or implemented module, interface method, adapter, helper, branch,
state, setting, cache, retry, guard, compatibility path, migration, and
dependency must map to:

- A requirement ID.
- Observed, contracted, or reachable evidence.
- A reason existing logic cannot carry the behavior.

Unjustified concepts are blocking and should be removed, not documented as
future-proofing.

Do not judge completeness by size. A short plan can be complete; a long plan
can still omit the root cause. A small diff can be insufficient; a large diff
can be justified by confirmed behavior.

## Plan-Specific Checks

In plan mode, verify:

- The requirement is quoted without narrowing.
- Relevant files and call sites were actually inspected.
- The supported input domain and reachability are explicit.
- Invariants have stable IDs.
- The first divergence and owner are proven.
- The design contains one approved primary path or exact user-requested
  rollback.
- Secondary and replacement paths are completely inventoried and classified.
- Workarounds have explicit deletion or preservation decisions.
- Forward and reverse traceability are complete.
- File changes are exact and restrained.
- TDD slices can fail on current behavior.
- Verification commands are concrete and use correct working directories.
- The `E`/`C` estimate is feasible and commits implementation to the actual hard
  minimum; arithmetic or line-scope drift that preserves that minimum is
  non-blocking.
- Real risks are separated from rejected speculation.
- Revision metadata and status are internally consistent.

## Implementation-Specific Checks

In implementation mode, verify:

- Current plan revision equals approved revision.
- Every diff hunk maps to the approved plan.
- No material implementation decision exists only in chat.
- Tests went red for the intended behavior before the fix.
- Tests observe behavior through the agreed seam.
- Expected values are independent of implementation logic.
- No test, assertion, permission, or safety check was weakened.
- The original bug feedback loop passes when applicable.
- Superseded workarounds and dead helpers are removed.
- No unauthorized fallback or responsibility leak was introduced.
- Repository style, types, error handling, and module shape are preserved.
- Required test, typecheck, lint, build, generation, and migration commands pass.
- The changed code satisfies the Chinese explanatory-comment gate.

## Chinese Comment Audit

In plan mode, evaluate whether the implementation commits to the 15 percent
implementation target. In implementation mode, independently recompute `E`
and `C` from the actual diff. Do not trust the builder's estimate or the
canonical plan's recorded arithmetic.

- `E`: substantively added or modified non-blank production, test, and
  configuration code lines, excluding import-only, formatter-only, generated,
  and pure-move changes.
- `C`: nearby Chinese explanatory comment lines that explain rationale,
  invariants, real boundaries, constant meaning, behavioral test intent,
  compatibility contracts, or safety constraints.

The audit blocking floor is:

```text
if E = 0: no E/C blocker
if E > 0 and C / E < 0.10: blocking
otherwise: no E/C blocker
```

A ratio from 10 percent up to but below the 15 percent implementation target
is a non-blocking quality note. Stale estimates, mismatched plan records,
rounding differences, and arithmetic discrepancies are non-blocking when the
auditor has recomputed the actual diff.

Do not count comments that:

- Restate code.
- Translate identifiers.
- Repeat test names.
- Describe obvious control flow.
- Are concentrated away from the decisions they claim to explain.
- Split one idea across lines to manipulate the ratio.

Report actual `E`, actual qualifying `C`, excluded-line categories, and the
calculated ratio. Evaluate the E/C floor after behavioral, regression,
ownership, test, and verification checks rather than using line arithmetic as
a substitute for them.

## Finding Format

List findings first, ordered by severity.

Every blocking finding must use:

```markdown
### B-01 <Concise title>

- Violated invariant:
- Evidence class: observed | contracted | reachable
- Producer and execution path:
- Source evidence: path:line
- Canonical-plan evidence: section
- Responsibility owner:
- Concrete production, test, or contract consequence, not estimate, wording,
  metadata, or evidence-placement discrepancy:
- Why this is not speculative:
- Minimal correction direction:
```

The correction direction must identify the constraint or owning path. Do not
design a family of fallback implementations for the builder.

Use separate sections in this exact order:

1. `Blocking findings`
2. `Non-blocking findings`
3. `Rejected speculation`
4. `Requirement and traceability coverage`
5. `Primary-path and fallback verdict`
6. `Code quality and Chinese-comment verdict` for implementation mode
7. `Release verdict`

If no blocking findings exist, write the exact sentence:

```text
No blocking findings.
```

## Release Rules

Plan audit may release only the exact audited revision.

Implementation audit may release only the actual diff against the exact
approved revision. In either mode, the release verdict is `APPROVE` only when no
blocking finding remains and every phase-applicable hard gate passes.
Non-blocking record corrections do not prevent approval. In every other case,
the verdict is `BLOCK`.

Any blocking finding requires revision or rework followed by another full-scope
audit. Plan audit is limited to 6 rounds; implementation audit is limited to 3
rounds.

At the round limit, preserve unresolved blocking findings as blocking open
decisions for the user. The release verdict remains `BLOCK`. Do not weaken a
finding merely to finish.

If the independent audit mechanism fails, retry at most 3 consecutive times.
Then report `independent-audit-unavailable`. Never replace independent audit
with self-review.

---
name: approved-plan-implementation
description: Use ONLY when the user asks to implement a canonical plan whose current revision has a recorded full-scope approval. Execute only the approved revision, load the TDD skill, implement the approved primary-path repair or exact user-requested rollback without adding fallback behavior, verify the complete requirement, and require a full independent implementation audit before declaring completion.
---

# Approved-Plan Implementation

Implement exactly one independently approved canonical-plan revision through
behavioral TDD. Execute the approved primary-path repair or exact user-requested
rollback, preserve confirmed behavior, remove superseded workarounds, and stop
whenever implementation requires a material plan deviation.

## Required References

Before editing, read:

1. `.opencode/policy/first-principles-engineering.md`
2. The complete canonical plan and audit record
3. The repository's `CONTEXT.md`, relevant ADRs, and applicable `AGENTS.md`
4. The `tdd` skill

For a bug, failure, or performance regression, also load and continue the
`diagnosing-bugs` skill. Do not rebuild or replace its feedback loop with a
weaker signal.

## Hard Gates

> **No approved revision, no implementation.**

> **No red behavior, no green implementation.**

> **Never invent a fallback. Without an explicit rollback request, do not replace the primary path.**

> **No plan update and full re-audit, no material deviation.**

> **No full-scope clean implementation audit, no completion.**

## Phase 0: Validate Authorization and Plan State

Implementation may begin only when all are true:

- The user explicitly asked to implement.
- The canonical plan exists.
- The plan status is `approved`.
- The current revision exactly equals the approved revision.
- The audit record states `No blocking findings` for that exact revision.
- The audit covered the complete original scope.
- `Implementation allowed: yes` is recorded.

If any condition fails, stop. Do not silently create a plan, self-approve it, or
continue from a chat summary.

## Phase 1: Detect Repository Drift

Re-read the planned source files, tests, and constraints before editing.

Compare current repository state with the evidence and assumptions in the
approved revision. If concurrent changes alter the relevant interface,
producer, consumer, invariant, responsibility, or file plan:

1. Do not overwrite the concurrent change.
2. Stop implementation.
3. Update the canonical plan with the new fact.
4. Increment the revision.
5. Clear approval and set `audit-required`.
6. Require a new full-scope plan audit.

Unrelated dirty-worktree changes do not block implementation and must not be
reverted or included.

## Phase 2: Confirm the Behavioral Seam

Use the seam agreed in the approved plan and the `tdd` skill.

Before writing a test, confirm that it:

- Exercises the public behavior used by real callers.
- Can reproduce the missing capability or bug pattern.
- Does not assert private helpers, call counts, source text, or internal state.
- Uses an independent expected value.
- Preserves project domain vocabulary.

If the planned seam cannot reproduce the real behavior, this is a plan defect.
Return to planning and audit rather than inventing a test-only production
interface.

## Phase 3: Execute Vertical Red-Green Slices

For each approved behavior slice:

1. Write one behavior-level test.
2. Run it and capture the intended red result.
3. Confirm it fails for the missing behavior, not setup noise or a nearby bug.
4. Implement only enough approved behavior to make it pass.
5. Run the narrow test.
6. Run related regression tests.
7. Continue to the next approved slice.

Do not write all tests first and all implementation second. Do not anticipate
future slices or add speculative branches.

## Phase 4: Execute the Approved Route at the Owner

At every edit, verify that it changes the first divergence identified in the
plan or implements the exact approved rollback.

Block and return to planning if implementation starts to:

- Disable primary behavior A without an exact approved rollback.
- Route callers to replacement B without an exact approved rollback.
- Add B1/B2/B3 coverage after B proves incomplete.
- Catch an A failure and synthesize success.
- Add a second parser, decoder, serializer, or data source.
- Add a feature switch to avoid the default repair.
- Compensate in a downstream caller instead of the owning module.

Delete or collapse every workaround the approved route makes obsolete.

## Phase 5: Preserve One Semantic Path

Private helpers are allowed only when they decompose the approved route,
hide a real internal seam, or express a reusable concept. Do not extract
single-use wrappers or create parallel algorithms.

For every secondary or replacement path in the implementation, record its approved
classification:

- Supported-domain branch or contracted pass-through within the primary
  contract.
- Diagnostic.
- Existing shipped compatibility.
- Explicit user-requested rollback.

Any unplanned alternate success path is a material deviation and requires a new
plan revision. Diagnostic behavior must stay within the 10 percent decision-
surface budget and must not report success-equivalent output.

## Phase 6: Enforce Responsibility and Locality

Do not absorb unrelated input processing, output compatibility, safety guards,
retry policy, fallback policy, temporary storage, observability, or permission
logic into the edited module.

Before adding such behavior, verify that:

- The approved plan assigns it to this interface.
- The real input reaches this seam.
- No existing owner already performs it.
- A confirmed requirement fails without it.

Otherwise remove it or return to planning.

## Phase 7: Maintain Code Quality

Follow all repository and package-local rules.

The implementation must remain surgical:

- Reuse or repair existing logic before adding abstractions.
- Keep the file count and diff within the approved budget unless confirmed
  behavior requires a revision.
- Do not add unrelated refactors or formatting.
- Do not add dependencies, public interfaces, settings, migrations, or feature
  flags unless approved.
- Do not introduce `any`, unchecked casts, non-null assertions, type
  suppression, dead code, unused helpers, or test-only production paths.
- Do not weaken tests, permissions, validation, or safety to obtain green.
- Do not swallow errors or convert failure into success.
- Keep dependency provisioning and cleanup explicit.

## Phase 8: Satisfy the Chinese Comment Gate During Implementation

Do not postpone comments until the end and then add filler. Add each explanation
beside the non-obvious decision it protects.

Track:

- `E`: substantively added or modified non-blank production, test, and
  configuration code lines, excluding import-only, formatter-only, generated,
  and pure-move changes.
- `C`: nearby qualifying Chinese explanatory comment lines.

Require:

```text
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

Qualifying comments explain:

- Why a non-obvious branch exists.
- Which invariant must remain true.
- Why a constant has its exact value or semantic meaning.
- Which real seam or compatibility contract is protected.
- Why a behavioral test proves the required capability.
- Why a safety or permission decision cannot be relaxed.

Do not count comments that restate code, translate names, repeat test titles,
describe obvious flow, or split one explanation to game the ratio.

## Phase 9: Handle New Facts Without Improvisation

Any newly discovered fact that changes behavior, scope, interface, ownership,
fallback classification, tests, or files is a material deviation.

When one appears:

1. Stop editing.
2. Write the fact and evidence into the canonical plan.
3. Increment the revision.
4. Clear prior approval.
5. Set status to `audit-required`.
6. Require a complete plan audit under the original scope.
7. Resume only after the new revision is approved.

Do not explain the deviation only in chat. Do not ask the implementation
auditor to approve an unplanned design after the fact.

## Phase 10: Verify

Run the narrowest relevant check first, then broaden according to the approved
verification plan.

Verification must include, when applicable:

- Each new red-green behavioral test.
- Related regression tests.
- The original unminimized feedback loop for bug work.
- Package-local typecheck.
- Lint or formatting checks required by the repository.
- Build, generation, migration, or integration checks required by the changed
  surface.

Do not run package tests or typecheck from a prohibited working directory. Do
not bypass checks, skip hooks, weaken assertions, or hide failures.

Record exact commands, working directories, results, and how failures were
corrected in the canonical plan's implementation-evidence section.

## Phase 11: Prepare Independent Implementation Audit

Set:

```text
Status: implementation-audit-required
Implementation allowed: no further material changes without revision or rework
```

Complete the plan's implementation evidence, including:

- Actual changed files and diff summary.
- Red-green evidence.
- Verification commands and results.
- Original feedback-loop result.
- Actual secondary and replacement path inventory.
- Actual `E`, qualifying `C`, excluded lines, required count, and ratio.
- Remaining unverifiable items.

Invoke the configured independent `adversarial-auditor` with only:

- The verbatim user requirement.
- The canonical plan path and approved revision.
- `Audit mode: implementation`.
- Repository root.
- Actual changed-file list and git diff.

Do not send implementation rationale, self-review, suspected problems, or a
reduced audit scope.

## Phase 12: Rework and Re-Audit

Every blocking implementation finding requires rework followed by another
audit of the complete original requirement and affected interface.

Do not ask the auditor to inspect only the corrected hunk. Do not reduce a
finding to non-blocking merely to finish.

Implementation audit is limited to 3 full rounds. Independent auditor
invocation may be retried at most 3 consecutive times. If unavailable, report
`independent-audit-unavailable`; do not replace it with self-review.

At the round limit, preserve unresolved blocking findings as open decisions for
the user and mark the task `blocked` rather than `complete`.

## Completion

Mark the plan `verified` only when:

- The approved root-cause repair, feature implementation, or exact
  user-requested rollback is complete.
- All approved behavior mappings are implemented.
- Red-green tests pass.
- Original feedback loop passes for bug work.
- Required repository checks pass.
- Superseded workarounds are removed.
- No unapproved fallback or responsibility leak exists.
- The Chinese explanatory-comment gate passes.
- An independent full-scope implementation audit states
  `No blocking findings`.

Before changing the status, copy the auditor's exact finding classifications,
release verdict, audited revision, full-scope marker, and invocation reference
into the canonical implementation audit record. Do not paraphrase away
non-blocking findings. A chat-only clean verdict does not satisfy completion.

Final reporting must include:

- Canonical plan path and approved revision.
- Core files changed.
- Behavioral tests added or changed.
- Verification commands and results.
- Root-cause and approved-route evidence.
- Removed workarounds.
- Secondary and replacement path verdict.
- Actual `E`, `C`, ratio, and representative Chinese comments.
- Independent audit rounds, findings, and resolutions.
- Remaining risks or unverifiable items.
- Why every changed file and production concept was necessary.

Do not create a commit or push unless the user explicitly requests that action.

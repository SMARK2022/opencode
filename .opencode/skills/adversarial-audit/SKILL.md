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

## Trust Model

Treat these as untrusted:

- Builder summaries.
- Builder rationale.
- Builder self-review.
- Builder-selected issue lists.
- Claims that a call path or edge case was already checked.
- Chat descriptions that are absent from the current canonical revision.
- Patch status claims that are not backed by the current record and dry-run report.
- Prior audit conclusions that are not independently rechecked against current files.

Build your own understanding from:

- The verbatim user requirement.
- The current canonical plan or patch record.
- Source and tests read directly.
- Repository instructions and accepted ADRs.
- Reproduced commands, traces, fixtures, benchmarks, and command output.
- Explicit interface, schema, migration, and generation contracts.
- The complete upstream and SMARK implementations being compared.

Verify every material claim independently. A builder statement that a file is
missing, a behavior is already upstream, a patch has been applied, or a prior
batch passed is only a search instruction until the corresponding implementation,
record, and executable evidence have been read.

## Full-Scope Rule

Every round audits:

1. The original requirement.
2. The complete affected interface.
3. All relevant producers and consumers.
4. The current canonical revision.
5. Existing and proposed primary and secondary paths.
6. All confirmed behavior mappings.
7. For implementation mode, the complete relevant diff and tests.

If a prior finding concerned section A3 and the builder revised A3, the next
round still audits A1, A2, A3, their shared interface, and all original
requirements. A delta-only recheck is not a valid audit.

## Independent Reconstruction

Before judging the artifact:

1. Read applicable `CONTEXT.md`, ADRs, and `AGENTS.md` files.
2. Locate the real entry points, callers, producers, and consumers.
3. Locate every implementation of the affected responsibility.
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

An actual implementation failure of the 15 percent gate is blocking. Plan mode
audits feasibility and commitment to the minimum, not estimate exactness.

In implementation mode, recompute rather than trust the implementer's number:

- `E`: substantively added or modified non-blank production, test, and
  configuration code lines, excluding import-only, formatter-only, generated,
  and pure-move changes.
- `C`: nearby Chinese explanatory comment lines that explain rationale,
  invariants, real boundaries, constant meaning, behavioral test intent,
  compatibility contracts, or safety constraints.

Require:

```text
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

Do not count comments that:

- Restate code.
- Translate identifiers.
- Repeat test names.
- Describe obvious control flow.
- Are concentrated away from the decisions they claim to explain.
- Split one idea across lines to manipulate the ratio.

Report actual `E`, actual qualifying `C`, excluded-line categories, and the
calculated ratio. Passing tests do not override a failed comment gate.

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

## Finding Materiality

Use three finding classes. `B` is a behavior blocker and requires observed,
contracted, or reachable evidence of a violated invariant, incorrect success,
regression, security or compatibility failure, concurrency or cleanup defect,
responsibility leak, or loss of test sensitivity. `G` is a hard-gate blocker and
requires a demonstrated failure of an applicable release condition, such as an
actual E/C ratio below the required minimum, an actual diagnostic decision
surface above its limit, revision drift, or an explicitly required verification
that was not run. `N` is a record correction for estimates, word counts,
metadata, stale wording, table placement, or duplicated evidence.

An `N` finding does not block when the behavior remains executable, no hard
threshold is shown to fail, and no release claim is false. A missing mapping is
blocking only when confirmed behavior would otherwise have no executable owner,
path, or behaviorally sensitive verification. A missing citation, stale estimate,
or misplaced table cell is not enough. Concerns without producer, owner,
contract, or reachability evidence are `Rejected speculation`.

## Patch Migration Audit

Patch migration audits have a serial precondition. Before examining the current
five commits, read every preceding record and cumulative dry-run report up to the
previous index. Confirm that every preceding item has an independently recorded
`PASS`, that its five-item audit gate passed when applicable, and that the last
successful cumulative state actually reached the previous index. If any earlier
item lacks that evidence, the migration is not serially valid. Stop immediately
and return `BLOCK`; do not audit the current five as an isolated island.

For each current commit, independently perform all of the following checks:

1. Read the complete source commit and every hunk, including tests, schema,
   migration, generated files, configuration, documentation, and deletion or
   rename semantics.
2. Read the complete `original` and `current` patch and verify that every current
   hunk has a source-to-target explanation in the independent
   `.temp/patches/records/NNNN-<sha12>.md` record. The record must be created
   before the first current edit and updated after every edit, materialization,
   test, and audit result; missing, delayed, merged, empty, or incomplete
   records are `BLOCK`.
3. Reconstruct the v1.17.20 owner through the actual producer, consumer, callers,
   error paths, concurrency, exit, cleanup, permission, and persistence chains.
4. Compare the SMARK behavior with the upstream behavior one responsibility at a
   time. State which implementation is stronger for each behavior, preserve the
   stronger upstream path, and add the missing SMARK semantics without replacing
   unrelated upstream behavior wholesale.
5. Execute the current cumulative patch validation before release of the item.
   A check or apply failure is a blocker and must stop the serial chain.
6. Audit the target implementation for real logic defects, regressions, wrong
   owner, hidden success, unsafe error conversion, race, cleanup leak, schema
   mismatch, and test gaps. A patch that applies cleanly but implements the wrong
   behavior is still `BLOCK`.
7. Compare the patch, record, target diff, tests, and final decision. Any material
   mismatch means the patch was not honestly documented and is `BLOCK`.

The auditor must also verify that the main agent did not jump forward. A later
patch, later repair, or later record cannot retroactively complete an earlier
item. The first missing serial proof blocks the current batch and all subsequent
work until the earlier item is repaired and re-audited.

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

## SMARK Patch Migration Overlay

When the target is a SMARK patch migration, read `.temp/workflow.md` and
`.temp/patches/AUDIT_CONTRACT.md` before evaluating any patch. The migration
contract has precedence over builder summaries, chat explanations, and stale
reports.

Normal audit input is exactly five consecutive manifest entries. The only
terminal exception is exactly `451-452`, because the source range contains 452
entries. Reject fewer, more, duplicate, non-contiguous, range-only, or summary-
only input without auditing a subset:

```text
CONTRACT VIOLATION: audit input is not exactly five consecutive commits, or the terminal commits 451-452. STOP. Verdict: BLOCK.
```

Before the current batch, independently inspect all prior records and cumulative
reports. Confirm prior independent `PASS` results, prior completed batch gates,
and a successful materialized state at the preceding index. Verify the immutable
manifest by independently enumerating the first-parent non-merge source range
through its pinned `sourceTip`; the moving `sourceRef` is only a label. Compare
every index, SHA, manifest parent, actual first parent, patch path, and fresh
source-generated original identity.
Do not require adjacent non-merge entries to be direct parents when excluded
merge commits occur.

Read `states/.source-proof.json` and verify its manifest and TSV hashes, source
tip, entry count, and original patch hashes. The proof accelerates the replay
hot path; it does not replace independent reading of the supplied source
commits. Read `reusedPrefix`, `baseState`, and `appliedThisRun` from each report
and reject any prefix whose cumulative patch provenance is not current.

For every commit in a valid batch, read the complete source commit, original
patch, current patch, materialized target state, target owner, upstream owner,
callers, consumers, tests, schema, migration, generation path, and dry-run
evidence. A missing source path requires symbol, interface, event, producer,
consumer, and behavior-owner tracing. It never permits behavior omission.

Compare SMARK and upstream behavior hunk by hunk. When upstream is stronger,
preserve its complete implementation as a non-removable baseline and require
every still-valid SMARK behavior, boundary, test, and constraint on top of it.
When upstream lacks the capability, require the complete SMARK behavior at the
correct owner. Determine whether the affected target responsibility remains
live in V1, V2, or both. Preserve valid V1 behavior where V1 remains live. When
V2 serves the same product responsibility, require the same defect or semantic
gap to be addressed without replacing stronger V2 design. When V2 already
removes the defect at its root or fully carries the same intent, preserve that
implementation and reject a mechanical copy of the V1 structure, owner, or
workaround. If upstream removed the complete product capability and no
replacement path exists, verify that the main agent asked the user before
restoring or dropping it. The final target must contain upstream strengths plus
the full still-valid SMARK content across every applicable live path. Preserve
the upstream design language as well: when it uses Effect,
Schema, Layer, or an established state/error model, apply SMARK behavior within
that model. Require the smallest semantic adaptation that fully carries both
sides. Reject unnecessary owner or path relocation, initialization or
static-evaluation reordering, call-order changes, interface expansion, semantic
loss, and location or sequence conflicts. Audit the
result for real bugs, wrong state transitions, hidden success, swallowed errors,
second parsers or data sources, fallback, wrong ownership, races, cleanup leaks,
schema or permission regressions, compatibility regressions, and tests that pass
while user-visible behavior is wrong. A clean apply is not a behavior pass.

Compare source diff, current patch, target result, independent record, tests,
materialized metadata, dry-run output, and verdict. The record must explain what
changed, what was inconsistent between source, upstream, and target, how the
adaptation preserved behavior, and which evidence supports the result. Any
material mismatch is `BLOCK`. The
current item cannot pass until cumulative application reaches its exact index;
a later patch or repair cannot complete it retroactively.

Require the current item or exact batch end to have a successful
`--typecheck <index>` report. Independently verify the install-input SHA-256,
Bun version, frozen install result or same-fingerprint reuse, affected workspace
selection, and each actual `bun typecheck` result. Missing install evidence,
stale dependency reuse, lockfile mutation, failed typecheck, an omitted affected
workspace, or a test workspace that differs from the materialized state is `G`.

For patch migration, recompute `E` and qualifying `C` independently for each
current patch. Never aggregate comments across a batch or count comments inherited
from another patch. Qualifying comments must be distributed beside the current
patch's important changed decisions. An actual per-patch result below
`C >= max(1, ceil(E * 0.15))` is `G`.

Use `B` for observed, contracted, or reachable behavior, compatibility,
security, concurrency, cleanup, ownership, semantic-loss, location/order conflict,
or test-sensitivity defects. Use `G` only for an actual applicable hard-gate
failure, such as the current patch's independently calculated E/C below
15 percent, demonstrated diagnostic decision surface above 10 percent, approved
revision drift, invalid materialized provenance, or explicitly required
verification that did not run. Estimates, word counts, metadata, table
placement, evidence relocation, and stale wording are `N` unless they make
behavior unimplementable, prove a hard threshold failure, or make a release
claim false. Unsupported concerns are `Rejected speculation`.

The only per-commit verdicts are `PASS` and `BLOCK`. A normal batch releases only
after five independent `PASS` results with no open `B/G`; the terminal batch
releases only after both entries pass. Any blocker keeps the whole batch blocked
and requires repair, cumulative re-materialization from the earliest affected
index, and full-scope re-audit of the same batch.

> 请保持严格准确，且一旦有降级特征时时请你严格准确且提高警惕！最终审计报告不仅要包含如上的全部内容，同时完整全面包含相对较为严格的完整审计建议，如：#xxxx缺失了很多有效信息，请**全量**完整兼顾上下游以及目标合并分支后进行有效的融合，最好结合相应的V1->V2的迁移的大方向背景思想，避免让feat/fix重新将主路径回退到可能已经删去的V1架构上！同时也警惕current patch相较于origin patch出现较大文件长度变化且无合理有效原因和证据说明的改动。整体文档长度必须至少满足50行、3000字符以上，并包含完整全量的有效信息，同时凑字数无效，否则视为`BLOCK`！！！

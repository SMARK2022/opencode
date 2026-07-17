# Patch Record NNNN

## 1. Identity

- Index:
- Source SHA:
- Parent SHA:
- Subject:
- Original patch:
- Current patch:
- Target baseline:
- Pinned source tip:
- Previous materialized state:
- Current materialized state:

## 2. Source Diff Evidence

- Exact command:
- Complete diff read:
- Changed paths:
- Every hunk and behavior intent:
- Tests/config/schema/migration/generated changes:

## 3. SMARK Intent

- User-visible behavior:
- Protected invariant:
- Normal path:
- Boundary and error paths:
- Concurrency/exit/cleanup/security paths:

## 4. Upstream Reconstruction

- Same-path target implementation:
- Symbol/concept search when same path is absent:
- Actual owner:
- Producer and consumer chain:
- Upstream tests and fixtures:
- Upstream schema/migration/generation behavior:
- Upstream strengths that must remain:
- Behavior where SMARK is stronger:
- Behavior where upstream is stronger:
- Behavior that requires a deliberate merge:
- Behavior proved fully equivalent upstream:

## 5. Three-Way Mapping

| Source behavior | Upstream behavior | Final target owner | Required action | Evidence |
|---|---|---|---|---|
| | | | | |

## 6. Current Patch Edit

- Current patch SHA-256 before edit:
- Current patch SHA-256 after edit:
- Exact edited hunks:
- Why each edit is required:
- Source behavior preserved:
- Upstream behavior preserved:
- No hunk/test/schema/migration removed without evidence:
- Target implementation has no discovered bug:
- Target error, concurrency, cleanup, permission and schema behavior:
- Patch and target behavior match this record:
- Materialized state remains clean and provenance-valid:

## 7. Verification

- `git apply --check` command and result:
- Cumulative apply command and result:
- Materialize command and result:
- Materialized state directory:
- State metadata and cumulative patch fingerprint:
- Rollback result if apply failed:
- Behavior tests:
- Regression tests:
- Typecheck/lint/build:
- Generation/migration checks:
- Complete stdout/stderr report:
- Cumulative apply reached this exact index before audit:

## 8. Contract Check

- One commit only:
- Full source diff read:
- Full upstream implementation read:
- Full target implementation read:
- File absence followed by owner tracing:
- No grep-only or existence-only evidence:
- No architecture-based omission:
- No deleted or delayed behavior:
- No later补救替代当前实现:
- No unrequested alternate success path or fallback:
- Every reachable safety or compatibility path has an owner and evidence:
- No behavior bug remains in the target implementation:
- Patch, record, tests and target result are materially consistent:

## 9. Independent Audit

- Five-item batch:
- Terminal two-item batch exception, if applicable:
- Manifest index/SHA/parent continuity independently verified:
- Auditor agent:
- Contract file supplied:
- Auditor input exact and contiguous:
- All preceding records independently passed:
- All preceding five-item audit gates passed:
- Previous cumulative apply reached the preceding index:
- Current batch cumulative apply reached its final index:
- Auditor verdict:
- `B` behavior findings:
- `G` hard-gate findings:
- `N` record-only findings:
- Rejected speculation:
- Repairs:
- Full-scope re-audit result:

## 10. Final Verdict

`PASS` or `BLOCK`

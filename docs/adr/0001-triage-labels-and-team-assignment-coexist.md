# ADR-0001: Triage lifecycle labels and team-assignment coexist

Date: 2026-07-05
Status: accepted

## Context

This repo has two triage concerns that look superficially similar but operate on different axes:

1. A pre-existing automation agent at `.opencode/agent/triage.md` runs on incoming GitHub issues and **assigns an owner** by team (`tui`, `desktop_web`, `core`, `inference`, `windows`). It explicitly does **not** add labels — it only assigns.
2. The mattpocock `triage` skill uses a **5-label lifecycle state machine** (`needs-triage` → `needs-info` → `ready-for-agent` → `ready-for-human` → `wontfix`) to track issue state.

A future explorer could reasonably assume one system replaces the other — e.g. that adding lifecycle labels makes the team-assignment agent redundant, or that the team-assignment agent's "do not add labels" rule forbids the mattpocock skill entirely.

## Decision

The two systems **coexist** and operate on orthogonal axes:

| System                    | Axis            | Mechanism            | Owner                              |
| ------------------------- | --------------- | -------------------- | ---------------------------------- |
| Team-assignment agent     | Who works on it | Issue **assignee**   | `.opencode/agent/triage.md` (auto) |
| mattpocock `triage` skill | Lifecycle state | Issue **labels**     | Invoked on demand by a skill       |

- The team-assignment agent owns **assignment**. The mattpocock `triage` skill owns **lifecycle labels**.
- When the mattpocock `triage` skill runs, it adds/removes the five lifecycle labels and **leaves assignment untouched**.
- The team-assignment agent continues to not add labels; it is not modified to set lifecycle state.

The lifecycle labels use their default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), mapped in `docs/agents/triage-labels.md`.

## Consequences

- **Positive**: each system stays focused; no re-engineering of the existing agent is required to adopt lifecycle tracking.
- **Positive**: a human (or the mattpocock skill) can see lifecycle state independently of who is assigned.
- **Negative**: two triage concepts to keep straight. Mitigated by documenting the split in `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`, and by this ADR.
- **Neutral**: if the labels do not yet exist on `SMARK2022/opencode`, they must be created (`gh label create ...`) before first use.

## Conflates / relates

- `docs/agents/issue-tracker.md` — issue tracker is GitHub on the SMARK fork (`origin`).
- `docs/agents/triage-labels.md` — the label mapping table.
- `.opencode/agent/triage.md` — the team-assignment agent definition.

# Triage Labels

The mattpocock skills speak in terms of five canonical triage **lifecycle** roles. This file maps those roles to the actual label strings used in this repo's issue tracker (GitHub, `SMARK2022/opencode`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. If these labels do not yet exist on `SMARK2022/opencode`, create them via `gh label create <name> --description "..." --color "..."` before first use.

## Coexistence with the team-assignment triage agent

This repo already has a separate automation agent at `.opencode/agent/triage.md` that triages incoming issues by **assigning an owner** from one of five teams (`tui`, `desktop_web`, `core`, `inference`, `windows`). That agent explicitly **does not add labels** — it only assigns.

The two triage systems operate on orthogonal axes and must not be conflated:

| System                         | Axis            | Mechanism                  | Owner                              |
| ------------------------------ | --------------- | -------------------------- | ---------------------------------- |
| Team-assignment agent          | Who works on it | Issue assignee             | `.opencode/agent/triage.md` (auto) |
| mattpocock `triage` skill      | Lifecycle state | Labels (the 5 above)       | Invoked on demand by a skill       |

When the mattpocock `triage` skill runs, it should add/remove the lifecycle labels above and **leave assignment untouched** (the team-assignment agent owns that). See ADR-0001 in `docs/adr/` for the rationale.

# Architectural Decision Records

ADRs record decisions that future architecture reviews should not re-litigate — load-bearing choices where the *why* matters and the reasoning is non-obvious. They are not a changelog and not a place for ephemeral "not worth it right now" notes.

## When to write an ADR

Write one when a decision is:

- **Load-bearing** — it shapes how future work is done, not just one file.
- **Non-obvious** — a future explorer would reasonably re-suggest the alternative.
- **Rejectable** — there was a real alternative that someone might want to reopen.

Do not write one for self-evident conventions (those go in `AGENTS.md`) or single-file choices (those go in code comments).

## Format

```
# ADR-NNNN: <imperative title>

Date: YYYY-MM-DD
Status: proposed | accepted | deprecated | superseded by ADR-MMMM

## Context
Why this decision came up. What alternatives were considered.

## Decision
What we decided.

## Consequences
What follows from this — positive, negative, neutral.

## Conflates / relates
Links to related ADRs, issues, or PRs.
```

## Numbering

- Zero-padded four digits: `0001`, `0002`, …
- One decision per file. Atomic.
- Never renumber; supersede instead (`Status: superseded by ADR-MMMM`).

## How to create

Skills (`improve-codebase-architecture`, `/grill-with-docs`) offer to create an ADR when a user rejects a candidate with a load-bearing reason. You can also create one manually by copying the format above into `docs/adr/NNNN-<slug>.md` and adding it to the index below.

## Index

| ADR      | Title                                                         | Status   |
| -------- | ------------------------------------------------------------- | -------- |
| [0001](./0001-triage-labels-and-team-assignment-coexist.md) | Triage lifecycle labels and team-assignment coexist | accepted |

# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

This repo uses a **single-context** layout. One `CONTEXT.md` and one `docs/adr/` live at the repo root and cover the whole opencode domain. Although this is a Bun monorepo (`packages/*`), the domain language (session, provider, tool, agent, message, snapshot, …) is shared across the product, and `packages/opencode` is the core that holds it. There is no `CONTEXT-MAP.md`.

```
/
├── CONTEXT.md            ← domain glossary (the canonical vocabulary)
├── AGENTS.md             ← repo-wide style + agent-skills index
├── docs/
│   ├── agents/           ← this file + issue-tracker + triage-labels
│   └── adr/              ← architectural decision records
└── packages/
    └── opencode/
        ├── AGENTS.md     ← package-local rules (DB, module shape, Effect)
        ├── specs/effect/ ← Effect migration patterns (guide.md, migration.md, …)
        └── src/          ← core implementation
```

## Before exploring, read these

1. **`CONTEXT.md`** at the repo root — the domain glossary. Use its vocabulary verbatim in any output (issue titles, refactor proposals, hypotheses, test names). Do not drift to synonyms the glossary avoids.
2. **`docs/adr/`** — read ADRs that touch the area you're about to work in. Start with `docs/adr/README.md` for the index.
3. **`packages/opencode/AGENTS.md`** — package-local conventions (database schema, module shape, Effect rules) that constrain any change to `packages/opencode`.
4. **`packages/opencode/specs/effect/`** — when touching Effect code, read `migration.md` and `guide.md` first; they are the compact pattern reference cited by the project-local `effect` skill.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`. For example, say "the Session compaction module" — not "the chat shortener," and not "the SessionService." If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (triage labels and team-assignment coexist) — but worth reopening because…_

## Monorepo orientation

When you need a map of modules and callers (e.g. during `improve-codebase-architecture` or `diagnosing-bugs`), use the **Module map** in `CONTEXT.md` and its glossary vocabulary. The map is a descriptive index of current structure and responsibilities, not a design spec. Other packages (`app`, `desktop`, `desktop-electron`, `web`, `console`, `sdk`, `plugin`, `core`, `ui`, `shared`) are consumers/facades of the core domain; canonical definitions live in `packages/opencode`.

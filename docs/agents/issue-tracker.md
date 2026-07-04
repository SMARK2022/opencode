# Issue tracker: GitHub (SMARK fork)

Issues and PRDs for this repo live as GitHub issues on the **SMARK fork**, `SMARK2022/opencode` — the `origin` remote. Use the `gh` CLI for all operations.

## Repo selection

This repo has two remotes:

| Remote  | Repo                       | Role                                           |
| ------- | -------------------------- | ---------------------------------------------- |
| `origin`    | `SMARK2022/opencode`   | **SMARK fork — track issues here**             |
| `upstream`  | `anomalyco/opencode`   | Upstream; do NOT open SMARK-specific issues here |

`gh` infers the repo from `git remote -v`. Because `origin` is the SMARK fork, plain `gh issue ...` commands target `SMARK2022/opencode` by default. If a command ever resolves to the wrong repo, be explicit: `gh issue create --repo SMARK2022/opencode ...`.

Open SMARK-specific issues (TUI, session management, token stats, Windows/PowerShell, VSCode Notebook, network proxy, daemon) on the fork. Upstream-shared issues may be cross-referenced, but the canonical tracker for this branch is the fork.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`. All `gh pr ...` commands target `SMARK2022/opencode` by default (see Repo selection above); be explicit with `--repo` if needed.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `SMARK2022/opencode`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo SMARK2022/opencode --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/SMARK2022/opencode/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/SMARK2022/opencode/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Coexistence with the team-assignment triage agent

A separate automation agent (`.opencode/agent/triage.md`) runs on incoming issues and **assigns an owner** by team (`tui`, `desktop_web`, `core`, `inference`, `windows`). It explicitly does not add labels. The mattpocock `triage` skill operates on a **different axis** — lifecycle labels (see `docs/agents/triage-labels.md`). The two are orthogonal and must not be confused: one routes ownership, the other tracks issue state.

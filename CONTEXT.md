# opencode (SMARK fork)

The domain language of opencode — an open-source AI coding agent. This is the SMARK enhanced fork (`dev-smark`, v1.15.12-smark), based on upstream `anomalyco/opencode`; core logic lives in `packages/opencode`. Use these terms verbatim in any output (issue titles, refactor proposals, hypotheses, test names) and do not drift to the synonyms in _Avoid_.

## Language

### Core run loop

**Session**:
A conversation unit scoped to a Project and a working directory, persisted in SQLite; the container an Agent runs against.
_Avoid_: conversation, chat, thread

**Agent**:
A config-driven persona that drives a Session — a name, mode (`primary` | `subagent` | `all`), a Permission ruleset, an optional model, a prompt, and options.
_Avoid_: assistant, persona, bot

**Tool**:
A capability an Agent invokes during a Session, defined by an id, a parameter schema, and an execute function; executes against a tool Context and returns an ExecuteResult.
_Avoid_: function, action, capability

**Provider**:
An LLM backend (Anthropic, OpenAI, Google, Bedrock, …) unified behind branded ProviderID/ModelID via `@ai-sdk`, with alias, auth, transform, and model-status.
_Avoid_: backend, vendor, model-source

**Message**:
The current part-based conversation record (MessageV2), composed of typed Parts (text, reasoning, file, patch, snapshot); `message.ts` holds the tool-call state schemas (ToolCall/ToolPartialCall/ToolResult), not a legacy shape.
_Avoid_: entry, turn, chat-message

**Permission**:
The ruleset governing what an Agent/Tool may do without asking; tools escalate via an `ask(Permission.Request)` call.
_Avoid_: access-control, authz

### Session lifecycle

**Status**:
A Session's high-level busyness — `idle` | `retry` | `busy` — emitted as `session.status` bus events.
_Avoid_: state, run-state

**Run state**:
The in-flight LLM/shell run lifecycle within a Session — `assertNotBusy`, `cancel`, `ensureRunning`, `startShell` — backed by a per-Session Runner map.
_Avoid_: status, execution-state

**Compaction**:
Summarizing/truncating a Session's context to keep it within the model window.
_Avoid_: summarization, truncation, context-window-management

**Snapshot**:
A git-patch checkpoint of the working tree — `track()` records a patch hash; `restore`/`revert`/`diff` operate on file state (7-day prune, 2MB cap); not a Session-state checkpoint.
_Avoid_: checkpoint, savepoint, session-snapshot

**Revert**:
Returning the working tree to a prior Snapshot via its git patches.
_Avoid_: undo, rollback

**Goal**:
A structured objective tracked within a Session (own SQL table).
_Avoid_: objective, target

**Todo**:
A checklist tracked within a Session.
_Avoid_: checklist, task-list

**Session path**:
Path-based grouping/filtering of Sessions (SMARK-local).
_Avoid_: session-folder, session-group

**Session search**:
Title+message search over Sessions (SMARK-local).
_Avoid_: session-filter

### Runtime

**Project**:
A working directory opened with opencode; has a branded ProjectID (with a `global` sentinel) and bootstraps every service `init()` fire-and-forget.
_Avoid_: workspace, repo, directory

**Workspace**:
A control-plane grouping (`wrk`-prefixed WorkspaceID) that can scope Sessions across Projects.
_Avoid_: org, tenant

**InstanceState**:
Per-Project/directory state backed by `ScopedCache` keyed by directory, so each open Project gets its own service copy; use this, not a singleton, when two directories must not share state.
_Avoid_: per-dir-state, singleton, instance

**AppRuntime**:
The shared app-layer Effect runtime — the preferred boundary for crossing non-Effect code into the wired app layer (FileSystem, Bus, Provider, Agent, Session, …).
_Avoid_: app-layer, main-runtime

**makeRuntime**:
An Effect runtime factory (`{ runPromise, runFork, runCallback }` + shared memoMap) for intentional service-local boundaries and legacy facades; discouraged for new code in favor of AppRuntime.
_Avoid_: service-runtime

**EffectBridge**:
The boundary for native/external callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, plugin callbacks) that must re-enter Effect services with instance/workspace context.
_Avoid_: callback-shim, adapter

**NetworkProxy**:
Unified handling of `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for providers, plugins, and fetch (SMARK-local).
_Avoid_: proxy-config, http-proxy

## Relationships

- A **Project** contains many **Sessions**. A **Session** belongs to exactly one **Project** + one working directory.
- A **Session** is driven by one **Agent**. An **Agent** references one **Provider**/Model.
- A **Session** has many **Messages**. A **Message** has many Parts.
- An **Agent** invokes **Tools**. A **Tool** executes against its **Session**'s context.
- **Compaction** manages the context window; **Snapshot** checkpoints the working tree for **Revert**. They keep a long **Session** viable on different axes (tokens vs files).
- **Status** (`idle` | `retry` | `busy`) and **Run state** (in-flight run lifecycle) are distinct: a Session is `busy` while a run is in flight, but **Status** is the emitted label and **Run state** is the control surface (`cancel` / `ensureRunning` / `startShell`).
- **InstanceState** is per-**Project**/directory; **AppRuntime** is process-wide.
- A **Workspace** (control-plane) may scope **Sessions** across **Projects**.

## Example dialogue

> **Dev:** "When an Agent invokes the `write` Tool, does that create a Snapshot automatically?"
> **Domain expert:** "No — Snapshot tracks working-tree patches on demand via `track()`. The `write` Tool shows a diff preview, but a Snapshot is only taken when the Session explicitly checkpoints, so Revert can restore files to that patch hash."
>
> **Dev:** "If a Session is `busy`, is that the same as its Run state?"
> **Domain expert:** "Related but not the same. Status is the label we emit on the bus (`idle` | `retry` | `busy`); Run state is the control surface — `cancel`, `ensureRunning`, `startShell` — over the in-flight Runner."

## Flagged ambiguities

- "status" was used loosely to mean both the Session's busyness and the in-flight run — resolved: **Status** = `idle` | `retry` | `busy` (emitted label); **Run state** = the in-flight run control surface. Different modules (`status.ts` vs `run-state.ts`).
- "message" was used to mean both the part-based shape and a putative legacy shape — resolved: **Message** = the MessageV2 part-based shape; `message.ts` holds tool-call state schemas that are part of the current shape, not a separate v1.
- "instance" was used to mean both per-directory state and a server process — resolved: **Instance** = the per-**Project** **InstanceState**; a server process is the Server (see Module map below).
- "snapshot" was used to mean a Session-state checkpoint — resolved: **Snapshot** = a git-patch working-tree checkpoint, the basis for file **Revert**, not Session state.

## Module map

A descriptive index of current structure and each area's responsibility — **not** a design spec and **not** a statement of future direction. It indexes what exists now so skills (e.g. `improve-codebase-architecture`, `diagnosing-bugs`) can navigate; the glossary above is the canonical vocabulary.

### `packages/opencode/src/`

| Directory          | Role                                                  |
| ------------------ | ----------------------------------------------------- |
| `agent/`           | Agent definition, generation, subagent permissions    |
| `session/`         | Session, Message (v2 + tool-call states), run loop, lifecycle, search, path |
| `tool/`            | Tool definitions + registry (incl. `shell/`, `bash-compress.ts`) |
| `provider/`        | LLM providers, alias, auth, transform, model status   |
| `permission/`      | Permission rulesets + requests                        |
| `server/`          | Headless HTTP API server (`opencode serve`, port 4096)|
| `cli/`             | yargs CLI + `cmd/tui/` terminal UI + `cmd/daemon.ts`   |
| `config/`          | Configuration system (self-export modules)            |
| `storage/`         | SQLite/Drizzle persistence (`#db` import map)         |
| `effect/`          | AppRuntime, makeRuntime, InstanceState, EffectBridge, runtime flags |
| `project/`         | Project bootstrap + instance context                  |
| `control-plane/`   | Workspaces (`wrk`-prefixed WorkspaceID)               |
| `bus/`             | Event bus                                             |
| `snapshot/`        | git-patch working-tree snapshots (`index.ts`)         |
| `mcp/`             | Model Context Protocol                                |
| `acp/`             | Agent Client Protocol                                 |
| `lsp/`             | Language server protocol                              |
| `pty/`             | Pseudo-terminal (`#pty` import map)                   |
| `plugin/`          | External plugins (`--pure` disables)                  |
| `skill/`           | Skill system                                          |
| `token/`           | Token accounting + estimate                           |
| `auth/`, `account/`| Authentication + identity                             |
| `share/`, `sync/`  | Session sharing + synchronization                     |
| `worktree/`, `git/`| Git worktree + git operations                         |
| `image/`, `file/`  | Image processing + file handling                      |
| `v2/`              | In-flight v2 migration (see below)                    |

Other packages (`app`, `desktop`, `desktop-electron`, `web`, `console`, `sdk`, `plugin`, `core`, `ui`, `shared`) are consumers/facades of the core domain; canonical definitions live in `packages/opencode`.

## SMARK fork delta (`[local-smark]`)

Fork-specific enhancements are marked in source with `[local-smark]` comments. The load-bearing ones (see the glossary above for the corresponding domain terms):

- **Provider alias** — provider aliases + explicit OpenAI-OAuth provider handling; client version override. (`src/provider/alias.ts`)
- **Explicit primary agent list** — `auto` is a primary Agent enabled only when explicitly chosen as `default_agent`, to avoid accidentally routing shell permissions through `auto`. (`src/agent/agent.ts`)
- **Session path + search** — path-based grouping and title+message search over Sessions. (`src/session/path.ts`, `src/session/search.ts`)
- **NetworkProxy** — unified `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` handling.
- **Windows/PowerShell** — CLIXML decode, UTF-8 fixes, path normalization, CRLF preservation.
- **VSCode Notebook** — cell overview/read/edit/run/output/kernel tools.
- **Daemon** — Server Lock, health checks, HttpApi, PTY WebSocket tickets (`src/cli/cmd/daemon.ts`).
- **Token statistics** — granular input/output/tool/attachment/request-overhead breakdown (`src/token/`).

When merging from upstream, `[local-smark]` markers identify conflicts to preserve. See `docs/merge-upstream-log.md`.

## v2 transition (in-flight)

A v2 refactor is in progress under `src/v2/` and the shared `@opencode-ai/core` package, moving Session/Message/Event/Model/Provider toward a shared schema (`@opencode-ai/core/session-message`, `-session-prompt`, `-session-event`, `-v2-schema`, `event`, `model`, `provider`) with an `EventV2`/`EventV2Bridge` and a `Delivery` concept (`immediate` | `deferred`). `src/v2/session.ts` is the v2 Session; `src/v2/provider-parity-checklist.md` tracks provider parity. v1 (`session/`) is current production and v2 is the in-progress migration target — do not assume parity. (Descriptive of current migration state, not a future design plan.)

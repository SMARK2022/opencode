# LSP Clean-Room Diagnostics Experiment Design

> Status: approved for experiment
>
> Date: 2026-07-16
>
> Implementation authority: none; `docs/plans/lsp-diagnostics-reliability.md` remains the sole canonical implementation plan.

## Purpose

Determine whether the repository's VS Code development extension can obtain
useful TypeScript and Python diagnostics for a previously unopened file without
creating or activating any editor tab. Eliminate old-window bridge routing,
workspace configuration, and stale bundle ambiguity before changing the
canonical implementation design.

## Hard Constraints

- Use `~/Project/Testing/lsp-audit` as a new isolated Project.
- Never call `showTextDocument` in the zero-tab experiment.
- Never add the target URI to any visible tab group.
- Never change the active editor or steal focus.
- Load only the freshly built repository development bridge; exclude installed OpenCode bridge extensions.
- Test both TypeScript and Python, including Ruff/Pylance multi-provider waves.
- Use event assertions and a hard safety deadline, not a fixed settle sleep as proof of completion.
- Treat empty events, provider-command success, and document version changes as non-completion signals.
- Keep all experiment state outside production source except existing test-only observer/probe files.

## Isolation Topology

```text
~/Project/Testing/lsp-audit
├── ts/
│   ├── tsconfig.json
│   ├── clean.ts
│   └── error.ts
├── python/
│   ├── pyrightconfig.json
│   ├── clean.py
│   └── error.py
└── .vscode/
```

Runtime profiles, language-extension links, registries, and artifacts live
outside the workspace under the approved temporary root
`/var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/lsp-audit-runtime`.
Keeping them outside the workspace prevents Pylance and Ruff from treating
their own bundled Python sources or generated profile files as Project input.

The VS Code process receives:

- A unique `--user-data-dir` under the runtime root.
- A unique `--extensions-dir` containing only required Python language extensions; TypeScript remains built-in.
- `--extensionDevelopmentPath=/Users/sunbenteng/Project/opencode/sdks/vscode`.
- `--extensionDevelopmentPath=/Users/sunbenteng/Project/opencode/.temp/testing/vscode-observer`.
- A unique `OPENCODE_IDE_REGISTRY_DIR` under the runtime root.
- The exact workspace `~/Project/Testing/lsp-audit`.

Before launch, run `bun run compile` from `sdks/vscode`. The resulting ignored
bundle is a verification artifact, not a tracked implementation file.

## Isolation Proof

The run is invalid unless all assertions pass:

1. The experiment registry contains exactly one live bridge manifest.
2. Manifest workspace root equals the experiment root exactly.
3. Manifest PID belongs to the newly launched isolated process tree.
4. The bridge endpoint and observer endpoint belong to that process tree.
5. No pre-existing OpenCode bridge extension is present in the isolated extension directory.
6. A per-run nonce appears in observer output and bridge-side evidence.
7. Bridge port, PID, registry path, and workspace differ from existing windows.

## Diagnostic Matrix

Each matrix cell starts with a fresh fixture or restarted provider state. A
fixed control editor is active before the target request.

| Stage | Trigger | Assertion |
| --- | --- | --- |
| A | `openTextDocument` only | Record document, diagnostics, active editor, and tab groups. |
| B | `vscode.executeDocumentSymbolProvider` | Provider result cannot count as diagnostic readiness. |
| C | hover and definition provider commands | Same zero-tab and exact-error assertions. |
| D | code action, inlay hint, and completion provider commands | Same zero-tab and exact-error assertions. |
| E | freshly built bridge diagnostic endpoint | Verify endpoint identity, typed result, and request-local events. |
| F | external clean-to-error edit | Correlate document synchronization and later diagnostic waves without equating them. |

For every stage:

- Capture `window.tabGroups.all`, `visibleTextEditors`, and `activeTextEditor` before and after.
- Register diagnostic observation before the trigger.
- Reject request-external events as evidence.
- Assert expected TypeScript diagnostic codes and Python Ruff/Pylance messages, not merely event count.
- Preserve every provider wave and timestamp in NDJSON.
- Return a non-zero process exit code when any invariant fails.

## Result Interpretation

### Zero-Tab Activation Proven

Adopt only the one stable public trigger that passes all fresh-file, external-
edit, TypeScript, Python, tab-state, and repeatability assertions. Re-run the
same trigger through OpenCode Write/Edit in a second-stage dual-channel test.

### Zero-Tab Activation Not Proven

Record the stable API boundary as a product fact:

- VS Code bridge diagnostics are observed-only for providers already active.
- OpenCode direct pull diagnostics own unopened-file authoritative auditing.
- No global clean claim is allowed.
- Bridge-only unopened files remain neutral pending/observed, not unavailable.
- No tab creation, fixed settle delay, provider-private hook, or hidden fallback is introduced.

## Dual-Channel Follow-Up

Only after the clean-room matrix is valid, test the product coordinator:

```text
Write/Edit audit request
  -> capture actual-existence baseline before mutation
  -> start direct pull audit and VS Code observation concurrently
  -> retain source scope identity
  -> collect scoped results
  -> report authoritative pull delta separately from observed VS Code/push diagnostics
```

The authoritative scope identity includes provider ID plus every applicable
dynamic diagnostic registration identifier and document selector. Baseline and
current scope must match exactly before new/existing classification.

## Cleanup

- Stop only the isolated process tree identified by the experiment profile.
- Retain experiment artifacts under the approved temporary runtime root; never delete existing `~/Project/Testing` content.
- Leave existing VS Code windows, profiles, registries, and tabs untouched.
- Do not commit generated bundles or experiment output.

## Success Criteria

- Isolation proof passes.
- Both language matrices produce deterministic pass/fail results.
- No target tab is created or activated.
- Every conclusion identifies its provider/source scope.
- The canonical plan is revised only from clean-room evidence, not assumptions.

## Clean-Room Findings

The corrected matrix used workspace-external runtime state so language servers
did not analyze their own bundled sources. Every run proved the same isolated
Extension Host PID for the bridge and observer, one private registry manifest,
the expected nonce, and an unchanged `control.txt` active editor with no target
tab or visible target editor.

### TypeScript

- The built-in `vscode.typescript-language-features` extension activated and
  used VS Code's bundled TypeScript 6.0.3 `tsserver.js`.
- `openTextDocument`, document symbols, hover, definition, code actions,
  inlay hints, completion, and external file changes did not publish target
  diagnostics through `languages.onDidChangeDiagnostics`.
- The public `typescript.tsserverRequest` command accepts the read-only
  `semanticDiagnosticsSync` request. With `{ file: vscode.Uri }`, it first
  synchronized the hidden document, found `ts/tsconfig.json`, and returned
  `2322` in under one second without displaying the file.
- That direct result is not mirrored into the aggregate diagnostics collection.
  It remains provider-specific benchmark evidence and is not a production
  diagnostic source under the later R25/R28 provider-neutral contract.
- After a clean hidden document was externally changed, the document version
  became `2`, but tsserver retained the old `fileContent` in `updateOpen` and
  `semanticDiagnosticsSync` returned an empty body. `typescript.reloadProjects`
  reused that stale buffer and also returned an empty body. This is a real
  hidden-buffer synchronization boundary, not a missing parser.
- The current `/lsp/touch` bridge path called `showTextDocument` and changed
  the active editor to the target in both TypeScript bridge runs.

### Python

- Pylance 2026.2.1, Python, Python Environments, and Ruff were all loaded from
  the isolated extension directory and became active for the Python fixture.
- With Ruff's legacy `ruff-lsp` backend, the observer captured Pylance's
  assignment/type diagnostics and Ruff F401 as separate events, then returned
  a four-item aggregate in 1.3–2.6 seconds.
- A clean-to-error external edit produced document version `2`, then Ruff and
  Pylance waves, while the active editor and all tab groups stayed unchanged.
- Ruff native server mode was also tested for 60 seconds. It logged only
  `ruff server` and `Server: Start requested`, never a ready event or target
  diagnostic. This is a provider readiness failure with a bounded deadline,
  not evidence that the Python parser is absent.
- The current `/lsp/touch` bridge path changed the active editor to the Python
  target as well.

### Design Consequence

The stable zero-tab seam is a scoped direct provider result when a provider
offers one, plus event-driven observed diagnostics for providers that publish
through VS Code. A direct result must not be expected to reappear as an
aggregate event. For hidden external edits, VS Code's provider buffer may be
stale even when `TextDocument.version` changes; the coordinator must not
classify an empty response as clean. The production plan therefore needs an
explicit source scope, generation, and pending state rather than a single
aggregate snapshot or a fixed delay.

## R15 Synchronous Completion Findings

The follow-up protocol benchmarks changed the implementation boundary. The
production edit path must not return `pending`, `observed-pending`, or an empty
diagnostic array when the provider has not completed. The current file result is
terminal only when the provider's own request or versioned publication proves it.

| Provider | Completion signal | Fresh/warm evidence | Decision |
| --- | --- | --- | --- |
| Pyright 1.1.408 | `textDocument/diagnostic` full report, including explicit empty `items` | 20,001-file Project: initialization 1,088 ms, first report 665 ms, then 2-10 ms; 12/12 under 1 s | Direct pull is authoritative after readiness and current-document sync. |
| Ruff 0.15.21 | `textDocument/diagnostic` full report | 20,001-file Project: initialization 6 ms, max 22 ms, 12/12 under 1 s | Add Ruff as a direct provider; empty full report is a real clean result. |
| TypeScript 5.3.0 server | Three advertised `workspace/executeCommand` requests: `semanticDiagnosticsSync`, `syntacticDiagnosticsSync`, `suggestionDiagnosticsSync` | 20,002-file Project: readiness warm-up 3,862 ms; after warm-up max 84 ms, 12/12 exact | Historical benchmark only; R25/R28 forbid this provider-specific production branch. |
| ESLint 3.0.24 server | `textDocument/diagnostic` full report | 20,001-file Project: max 216 ms, 12/12 exact | Direct pull is authoritative when ESLint is applicable and configured. |
| clangd 17 | `textDocument/publishDiagnostics` full replacement with `version` equal to the sent `didChange` version | 12 alternating error/clean reports, max 64 ms, 12/12 same-version | Versioned push is authoritative for the request-local change. |
| JDT LS 1.59 | `java.project.refreshDiagnostics` command plus request-local `publishDiagnostics` for the normalized target URI | 12 alternating error/clean reports, max 76 ms, 12/12 exact | Explicit refresh plus matching publication is authoritative; no fixed delay. |
| rust-analyzer 0.3.2971 | `experimental/serverStatus` with `health: "ok", quiescent: true`, then `textDocument/diagnostic` full report | Readiness 4,706-10,934 ms; after readiness max 12 ms, 12/12 exact | Warm readiness outside the edit budget; early empty reports are not clean. |
| Pylance/Ruff through VS Code aggregate API | URI-only aggregate event, no provider identity or all-provider completion | Zero-tab experiment produced separate waves but no stable completion hook | Keep as observed information only; never use it for strict clean/baseline. |

The large Project benchmarks deliberately included 20,000 files in the Project
tree. The Python and TypeScript results show the required split: starting and
loading the Project graph can exceed one second, while current-file checks after
readiness remain within the edit budget. No benchmark opened every file in an
editor tab or used a workspace diagnostic request.

## R15 Primary Chain

```text
read or first file contact
  -> start only the applicable provider processes
  -> send current-file didOpen and provider readiness work in the background

write/edit/apply_patch
  -> capture actual-existence baseline before mutation
  -> require a completed baseline with matching provider/source identity
  -> mutate using the existing Tool filesystem contract
  -> send didChange for the new file contents
  -> run the one coordinator with a one-second deadline
  -> await every required provider's explicit terminal in parallel
  -> return one typed complete result immediately when all terminals finish
  -> fail hard on timeout, provider failure, stale version, or identity change
```

The deadline is a safety limit, not a quiet-period sleep. A 40 ms result returns
in about 40 ms. A cold provider that cannot become ready within the budget does
not return a false clean result. The current filesystem mutation contract is
preserved; a failed audit returns a hard Tool error rather than a successful
output or an incomplete diagnostic claim.

The bridge remains useful for hidden document warm-up and navigation. Its
aggregate diagnostics event is not an authoritative completion source. The
bridge diagnostic route must use `openTextDocument` only, preserve active editor,
and either return a provider-specific complete result or a hard incomplete
result. It must not wait a fixed four seconds and it must not turn timeout into
success.

## R15 Provider Readiness

Read warm-up starts only providers applicable to the touched file. It does not
enumerate or open the Project's files. Read's existing detached warm-up remains
non-blocking; the first edit shares the same client/process and waits for its
published readiness signal within the edit deadline.

Readiness signals are provider-owned:

- Rust waits for `experimental/serverStatus` `ok/quiescent`.
- Pyright, Ruff, ESLint, and TypeScript use initialized client plus current-file
  synchronization; their first diagnostic request is the readiness boundary.
- JDT waits for its ready/service lifecycle signal before strict refresh.
- Clangd uses the matching `didChange` version as the current-file boundary.

An initialized process without readiness is not an applicable clean provider.
Provider configuration errors, including the observed Ruff configuration path
error, are hard failures and never become an empty result.

## R15 Zero-Tab Boundary

`showTextDocument` is removed from diagnostics. Hidden `openTextDocument` may be
used to load a document, but no target URI may enter a tab group, visible editor,
or active editor. VS Code's `onDidChangeDiagnostics` remains a request-local
observation hook for logging and user-visible non-authoritative evidence; it is
not a provider completion hook because the stable event exposes only URIs.

The TypeScript command experiment records a reachable single-extension
behavior, but R25/R28 supersede it as an implementation direction. Production
and release verification invoke no contributed diagnostic command and select no
behavior from language or extension identity.

## R15 Rejected Paths

- First diagnostic event plus a delay: rejected because the first event may be
  empty or may precede another provider's error.
- Fixed one-second or four-second sleep: rejected because it cannot distinguish
  fast completion from incomplete analysis.
- VS Code `languages.getDiagnostics`: rejected as aggregate, URI-only, and
  provider/version-unaware.
- Generic `pending` success output: rejected by the user requirement.
- Automatic retry through another provider after failure: rejected by the
  repository's one-primary-path policy.
- Full Project prewarm: rejected by the 20,000-file benchmark and user latency
  constraint.

## R17 Completion Corrections

The R16 audit found that TypeScript preparation must wait for a completed warm
terminal, the one-second budget must cover the whole Tool diagnostic chain, and
clangd version matching alone is not a completion signal. The corrections are:

- The historical TypeScript command-readiness proposal was rejected by the
  later provider-neutral contract. No contributed command defines production
  readiness; cold or silent sources use the shared edit-first incomplete path.
- One deadline starts at the public mutation Tool entry and is passed through
  preparation check, baseline acquisition, mutation coordination, and current
  diagnostics. The coordinator never starts a second independent one-second
  timer after mutation.
- clangd `didChange` carries `wantDiagnostics: true` and the client enables
  `clangdFileStatus`. Completion requires both a request-local
  `textDocument/clangd.fileStatus` `state: "idle"` and a full
  `publishDiagnostics` whose version equals the sent version.

The corrected clangd benchmark (`result-1784202551830.json`) completed 12
alternating error/clean rounds, all under one second, with a maximum of 24 ms.

## R18 Edit-First Timeout Contract

The latest user clarification changes the mutation boundary: a cold or
not-yet-ready provider must not hold the file edit hostage. The primary chain is
now:

```text
start provider warm-up
  -> apply the file edit without waiting for readiness
  -> wait at most one shared second for complete provider terminals
  -> return complete diagnostics if all terminals finish
  -> otherwise return edit-applied with diagnosticState=incomplete
```

`incomplete` is a synchronous terminal status, not an async continuation. It
never carries a clean claim, empty-success diagnostic array, delta, or
diagnostic summary. It names the timeout/readiness/provider reason and tells
the consumer that this edit was applied without a complete LSP conclusion.
The provider may continue warming for a later edit, but the current Tool output
does not change later.

An exact cached baseline may be used immediately. If no exact baseline exists,
the coordinator marks the baseline incomplete rather than delaying the edit to
manufacture one. Delta classification is omitted unless baseline and current
results are both complete and have equal provider/source identity.

## R19 Baseline Generation Invalidation

The baseline cache cannot rely only on the target hash. The LSP service therefore
keeps a per-Project diagnostic generation. It increments on any
`FileWatcher.Event.Updated` create/change/delete under the Project and on
provider configuration/readiness/registration changes. Every cached baseline
stores that generation, a provider epoch, the target hash, and the complete
source identity.

If a sibling dependency or configuration file changes while the target hash is
unchanged, the generation differs and the old baseline is rejected. The edit is
still applied under the edit-first contract, but delta/new-existing/clean
classification is omitted unless a fresh complete baseline and current result
are obtained within the shared one-second budget. This is conservative
invalidation, not a Project-wide analysis or dependency graph scan.

## R20 Causal Generation and Independent Result States

R19 generation invalidation is insufficient unless the coordinator can
distinguish the audited mutation from an unrelated Project mutation. R20 adds
one mutation-attempt boundary around Write, Edit, and Apply Patch.

Before mutation, the coordinator records an attempt ID, expected normalized
paths, expected operations, expected post-mutation hashes where applicable,
and the pre-attempt external generation. Tool-originated
`FileWatcher.Event.Updated` events carry that attempt ID. Native watcher events
are marked `origin=external`.

The coordinator does not invalidate the attempt baseline for a matching
tool-originated event. A native event for an expected path is treated as a
duplicate only when its current content hash matches the expected post hash.
Unexpected paths, operations, attempt IDs, or hashes are intervening external
changes and invalidate baseline qualification without blocking the edit.
After the mutation completes, the coordinator advances the Project generation
once for the expected mutation set. Duplicate native events do not advance it a
second time.

The default LSP runtime must have an external change signal. The existing
Project watcher is currently guarded by `OPENCODE_EXPERIMENTAL_FILEWATCHER`,
which defaults to false. When `cfg.lsp !== false`, the watcher owner subscribes
to the Project using the existing native backend and ignore rules even without
that experimental flag. This only observes filesystem events; it does not
prewarm, open, or analyze all files. If the native watcher cannot be created,
baseline qualification is incomplete and cached cross-operation baselines are
not used, while the edit-first contract remains active.

Current diagnostics, baseline qualification, and delta classification are
independent states:

```text
currentState: complete | incomplete
baselineState: complete | incomplete | absent
deltaState: complete | incomplete | not-applicable
```

Complete current diagnostics are returned whenever all required current
provider terminals finish, even if the baseline is absent or stale. In that
case the result does not classify diagnostics as new or existing and does not
claim that the edit introduced no new errors. An incomplete current result
contains no diagnostics array, clean claim, delta, or asynchronous continuation.

## R21 Compactness and Causal Boundary

R21 keeps the same single coordinator and does not add a second provider path.
The implementation target is twelve existing files or fewer and fewer than
2,000 substantive production/test/comment lines.

Known target absence is an authoritative empty baseline. Unknown cache absence
is incomplete. Therefore a newly created file can classify complete current
diagnostics as introduced, while an unavailable cached baseline cannot be
treated as empty.

The FileWatcher owner exposes `ready|unavailable`, an observation epoch, and a
monotonic event sequence. The Project subscription is awaited before a
baseline can be qualified. LSP-enabled projects subscribe without requiring
`OPENCODE_EXPERIMENTAL_FILEWATCHER`; this is event observation only and does
not scan or prewarm the Project.

The mutation attempt starts before the first Tool write and ends after
formatting, BOM synchronization, final hashing, and Tool event publication.
Native events for expected paths are held during this complete Tool-owned
boundary. The final content signature determines ownership. The coordinator
retains the current mutation signature so a delayed matching native event is
deduplicated without a timer; a differing signature advances Project
generation.

The public result keeps independent `currentState`, `baselineState`,
`baselineAuthority`, and `deltaState`. Complete current diagnostics remain
visible when baseline qualification is unavailable, but new/existing/delta
classification and “no new errors” wording remain suppressed.

## R22 Shared One-Second Result

The mutation coordinator owns one absolute deadline at mutation-attempt start:
`startedAt + 1,000 ms`. Baseline acquisition, provider startup, direct provider
terminals, bridge transport, SDK observation, and current diagnostics all use
only the remaining budget. The previous four-second SDK and five-second bridge
waits are historical experiment behavior and are not part of mutation Tools.

Direct and bridge work remains concurrent, but no scope can extend the returned
Tool result beyond the shared deadline. A named provider terminal returns as
soon as it finishes. At the deadline, request-local waits and listeners are
disposed and unresolved scopes are incomplete. Incomplete scopes carry no
partial diagnostic array, clean claim, delta, or later continuation.

The authoritative current result names the completed applicable direct
provider/source scope. Generic VS Code aggregate observation cannot upgrade or
downgrade that scope and is incomplete when no contracted terminal exists. An
observed 2.453-second Python wave explains why that bridge scope cannot be
certified inside the edit; it does not justify waiting longer.

R22 uses the real Write, Edit, and Apply Patch test files for the mutation
boundary. Their existing public Tool paths exercise formatter rewrites, BOM
synchronization, known-empty/existing baselines, move and multi-file identity,
Tool-origin events, delayed native duplicates, external sibling invalidation,
and deadline output. The implementation target is fourteen existing files and
an estimated 1,670 production/test/comment lines, with no new helper subsystem,
fallback, retry, timer-based completion, or Project scan.

## R23 Direct Ruff Ownership

The authoritative Python direct scope includes both Pyright and Ruff when their
existing server discovery returns handles. `packages/opencode/src/lsp/server.ts`
owns Ruff discovery and starts `ruff server` from PATH, `VIRTUAL_ENV`, or the
Project `.venv`/`venv`; absence is optional and does not trigger an installer or
VS Code fallback. A returned or explicitly configured Ruff provider remains
applicable until its full `textDocument/diagnostic` terminal completes or the
shared deadline makes the scope incomplete.

Ruff uses normal Project configuration discovery and never receives the Project
directory as a configuration-file path. `test/lsp/index.test.ts` verifies
registry selection, optional absence, explicit/applicable failure, disabling,
and Project root/flags. The exact implementation plan is sixteen existing files
and approximately 1,728 production/test/comment lines, below the user limits.

## R24 Open Capability Model

The redistributed product cannot define diagnostic completeness by LSP server
name, extension ID, installed version, executable path, or environment
variable. Benchmarked LSP servers are examples, not mandatory installations or
identity branches.

Every direct LSP source is classified at runtime from standard static/dynamic
`textDocument/diagnostic` registrations and other explicitly advertised public
completion capabilities. An unknown source with full pull diagnostics can
complete through the same path. An unknown push-only source remains incomplete
because versioned pushes prove content ownership but not finality.

VS Code-only sources remain owned by their extensions. The bridge uses hidden
`openTextDocument`, public commands/capabilities, and request-local diagnostics
events only. It never scans extension directories, reads PATH/VIRTUAL_ENV to
find LSP executables, launches copied servers, or switches behavior by extension
identity/version. Without a public completion capability, its result is
incomplete at the shared deadline and contains no partial diagnostic array.

The observed matrix supports generic concurrency, one absolute deadline,
current-file analysis, exact target identity, and immediate return on a real
terminal. It does not support a same-wave prior: Ruff and Pylance events arrived
separately and same-version pushes can replace each other. First event,
event-loop idleness, aggregate snapshot, and quiet delays therefore remain
non-terminals.

R24 uses fourteen existing files and an estimated 1,590
production/test/comment lines. `lsp/server.ts` is unchanged; existing direct
client discovery is reused and completion is capability-based after the client
exists.

## R25 Majority-Case Standard Messages

R25 removes provider identity branches, undefined public-command terminals, and
the Project-wide watcher generation subsystem. It uses only standard LSP
diagnostic messages plus VS Code's public aggregate event.

For direct clients, only every captured `textDocument/diagnostic` registration
returning a full report can complete a source. Versioned and unversioned
`publishDiagnostics` replacements are observed evidence only: a matching
version correlates content but does not mark the final publication for that
version, so no push authorizes clean, baseline, or delta.
Pull, push, dynamic registration, and `workspace/diagnostic/refresh` update one
source generation used to qualify the existing client cache as a baseline.

For VS Code-only sources, the SDK registers listeners before hidden
`openTextDocument`, waits until the hidden document hash matches the edited
file, and reacts to the first target `onDidChangeDiagnostics` event. VS Code
already debounces collection changes inside its Extension Host; the SDK adds no
quiet timer. A non-empty snapshot returns real `observed-errors`. An empty
snapshot returns `observed-empty-not-certified`, never clean. No event before
the shared one-second deadline is incomplete.

The result model is limited to complete, observed-errors,
observed-empty-not-certified, and incomplete current states; complete,
known-empty, and unavailable baselines; and a delta derived only from a complete
current/baseline pair. The edit is never rolled back, output never changes
later, and no provider name, version, extension ID, executable path, PATH,
VIRTUAL_ENV, shell fallback, or environment probe selects behavior.

R25 changes twelve existing files and estimates 1,255
production/test/comment lines. `file/watcher.ts`, `sdks/vscode/src/bridge.ts`,
`lsp/server.ts`, and the clean-room harness stay unchanged.

## R26 Final Source Barrier and Mutation Revision

R26 closes the complete-result barrier across all applicable direct sources. At
the request boundary, matching built-in/custom candidates settle concurrently
as not-applicable, applicable, or unresolved. `current.complete` requires every
candidate decision and every applicable source terminal to complete for every
non-deleted target. A fast source may yield observed-errors but cannot produce a
partial complete result.

Baseline invalidation uses one source revision per active LSP client, not a
Project watcher subsystem. `beginMutation` captures qualified cached baselines
and increments every active client revision once before the Tool writes. The
Tool's own didChange binds to that revision. A second Tool mutation, changed
warm sync, dynamic registration, or advertised `workspace/diagnostic/refresh`
increments it again and suppresses delta while preserving complete current
diagnostics. This invalidates sibling/configuration mutations even when their
own diagnostic audit times out.

The real Extension Host harness becomes a changed verification owner. It must
reject current `{ok:true}` timeout behavior and assert exact observed-errors,
observed-empty-not-certified, and incomplete payloads, zero-tab invariants,
document hash freshness, request-local history, and no post-response
continuation.

An empty aggregate event is recorded but does not finish the request. The
coordinator continues until a later non-empty event, a complete direct-source
join, or the shared deadline. Only the deadline produces
`observed-empty-not-certified`; this keeps the event path responsive without
turning a first empty wave into clean.

The public LSP Tool explicitly uses warm-only behavior; its existing test fails
if diagnostics are entered. Severity is part of diagnostic identity and the
existing lifecycle suite proves Warning to Error is a new error.

R26 modifies eighteen existing files and estimates 1,545
production/test/harness/comment lines. It adds no watcher protocol, provider
identity/version branch, environment lookup, fixed quiet delay, retry family,
or fallback.

## R27 Workspace-Diagnostic Boundary

The standard `workspace/diagnostic` request is intentionally outside the
current-file one-second audit SLA because it has workspace scope and may trigger
a Project-wide computation. The client must recognize workspace registrations,
but must not issue that request from the Tool mutation path.

Workspace-only sources return an explicit
`workspace-scope-out-of-current-file-sla` incomplete reason. A source with both
document and workspace registrations may complete a named document-only current
scope through `textDocument/diagnostic`; it never claims workspace/global clean
and never uses the unqueried workspace source for delta. Public client tests
assert both the explicit exclusion and the absence of a workspace request.

R27 is a plan correction only. It is not independently approved because the
allowed audit opportunities have been exhausted.

## R28 Provider-Neutral Command Removal

R28 removes every provider-specific command terminal from implementation
authority. The standard production inputs are limited to full
`textDocument/diagnostic` reports, matching-version `publishDiagnostics`
replacements, unversioned push observation, and request-local VS Code aggregate
diagnostic events. Provider names, language IDs, extension IDs, contributed
commands, and server-specific readiness/status messages never select behavior.

The existing TypeScript command code in the clean-room observer is deleted from
the release route. TypeScript and Python remain real zero-tab compatibility
fixtures only; they receive the same observed-errors,
observed-empty-not-certified, or incomplete contract. Historical command
benchmarks above remain experiment evidence and carry no implementation or test
authority.

## R29 Authoritative Completion Correction

Matching-version `publishDiagnostics` is no longer a completion terminal. The
protocol permits multiple replacement publications for one document version;
version proves content correlation, not finality. Non-empty pushes may return
truthful observed errors, while empty pushes remain non-certified until the
shared deadline. Only full reports from every captured
`textDocument/diagnostic` registration can complete a direct source or qualify a
baseline.

The all-source join also requires evidence: each non-deleted target must have at
least one applicable direct source and every applicable source must complete its
captured document-pull registrations. A settled empty applicable-source set is
never vacuously complete. The coordinator keeps the VS Code observer active for
the remaining deadline and returns observed errors, observed-empty-not-certified,
or `incomplete(no-applicable-diagnostic-source)` according to the actual event.

## R30 VS Code-Only Product Contract

The product diagnostic path uses only the VS Code extension bridge. OpenCode's
built-in direct LSP clients are not a diagnostic source and are not a fallback
when the bridge fails. The bridge opens the document hidden, listens for
request-local diagnostic changes, reads the latest `languages.getDiagnostics`
snapshot, and stops at the shared one-second deadline.

The accepted user-facing result is intentionally simple:

```text
diagnostics contain entries -> 发现错误
latest snapshot is empty at the deadline -> 未发现错误
bridge cannot provide a snapshot -> VS Code bridge unavailable
```

`未发现错误` means “no error was observed in the latest snapshot within the
window”; it does not claim that every internal LSP service has finished or that
no later update is possible. This is an accepted existing behavior, not a
blocking finding. An error-bearing event returns immediately; empty/unchanged
data uses the deadline and no fixed quiet delay. No visible tab or active-editor
change is permitted.

## R31 Existing Timeout Ceiling

The VS Code diagnostic observation window keeps the current SDK maximum of
`2,000ms`. It is not changed to one second and is not extended beyond the
existing `awaitDiagnosticsRefresh` default. Errors still return as soon as
observed; empty or unchanged snapshots use the existing ceiling and return
`未发现错误`.

## R32 One-Second Ceiling

The final product timeout is explicitly `1,000ms`. The implementation does not
restore the previous `2,000ms` wait, add a second timer, add a quiet period, or
continue after the bridge response. Errors return immediately; an empty latest
snapshot at the one-second ceiling returns `未发现错误`.

The SDK uses `800ms` of that single budget and leaves the remaining time for
hidden open and the local HTTP response; OpenCode enforces the `1,000ms`
end-to-end ceiling.
